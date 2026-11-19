import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, StoreBusyError, type Command, type Plan } from "../../run-command.js";
import {
  auditStatement,
  conflict,
  hexBytes,
  instant,
  rowsOf,
  routeOrganization,
  runMapped,
  ulid,
  type CatalogContext,
} from "../common.js";
import { acknowledgeInboxSql } from "../operations/inbox.js";
import {
  OPEN_DATABASE_ACCESS_SELECT,
  revokeOpenDatabaseAccessStatements,
  type OpenDatabaseAccessRow,
} from "./database-access-revocation.js";
import { revokeAllGrantsStatement } from "./local-grants.js";
import {
  applyWorkosSnapshot,
  applyWorkosSnapshotInput,
  type ApplyWorkosSnapshotResult,
} from "./membership-state.js";
import {
  IDENTITY_FINGERPRINT_EXPR,
  boundedId,
  derivedUlid,
  directoryOrganizationByWorkosId,
  hex256,
  identityConflict,
  workosOrganizationId,
} from "./shared.js";

/**
 * The commands of the WorkOS snapshot poller (`apps/workos-management`), one per original authoritative operation
 * of `createPostgresWorkosManagementDatabase`. The WorkOS inbox was one global table in PostgreSQL; in the shared
 * core every new event lives in the global `webhook_inbox`, with optional organization routing metadata. The
 * poller names no organization, so the claim here is the global WorkOS claim of the original (provider fixed, no
 * caller-chosen provider, shard, event type or payload filter). Retained legacy-buffer events are adopted in the
 * same batch that leases them. Every other command names the exact claim it concerns.
 */

const MAX_CLAIM_ROUNDS = 8;
/** The database clock is evaluated by the final write, not sampled before a queued batch. */
const DB_NOW = "(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')";
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u);

/** A claimed global WorkOS event. Nullable `organizationId` is only a retained routing hint. */
export interface WorkosInboxClaim {
  readonly organizationId: string | null;
  readonly inboxEventId: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly claimId: string;
  readonly attemptNumber: number;
}

interface ClaimRow {
  readonly organization_id: string | null;
  readonly inbox_event_id: string;
  readonly external_event_id: string;
  readonly event_type: string;
  readonly payload: string;
  readonly claim_id: string;
  readonly attempt_count: number;
}

const CLAIM_COLUMNS =
  "organization_id, inbox_event_id, external_event_id, event_type, payload, claim_id, attempt_count";

function toClaim(row: ClaimRow): WorkosInboxClaim {
  return {
    organizationId: row.organization_id,
    inboxEventId: row.inbox_event_id,
    externalEventId: row.external_event_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    claimId: row.claim_id,
    attemptNumber: row.attempt_count,
  };
}

/**
 * The stable internal id of a WorkOS organization that has no mapping yet: derived from its WorkOS id, so every
 * event of that organization, claimed by any poller at any time, proposes the same id and none can create a second.
 */
export function derivedOrganizationId(workosOrganization: string): Promise<string> {
  return derivedUlid(`workos-organization|${workosOrganization}`);
}

/** Routing metadata is derived only for an actual normalized organization trigger, never for failure/recovery. */
function legacyOrganizationEvent(row: UnroutedCandidate): boolean {
  if (
    !new Set([
      "organization.created",
      "organization.updated",
      "organization.deleted",
      "organization_membership.created",
      "organization_membership.updated",
      "organization_membership.deleted",
    ]).has(row.event_type)
  )
    return false;
  const payload = JSON.parse(row.payload) as unknown;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return (
    Object.keys(record).every((k) => k === "schemaVersion" || k === "workosOrganizationId") &&
    record["schemaVersion"] === "workos.organization-trigger.v1" &&
    workosOrganizationId.safeParse(record["workosOrganizationId"]).success &&
    record["workosOrganizationId"] === row.routing_key
  );
}

/** The provider subject, not the optional inbox routing hint, determines the authority being applied. */
async function pollerOrganization(
  context: CatalogContext,
  workosId: string,
  expected: string | null | undefined,
  phase: "snapshot apply" | "organization deletion",
): Promise<string> {
  const mapped = await directoryOrganizationByWorkosId(context.directory, workosId);
  const organizationId = mapped?.organization_id ?? (await derivedOrganizationId(workosId));
  if (expected !== undefined && expected !== null && expected !== organizationId)
    throw conflict("inbox_claim_stale", `WorkOS inbox claim is stale during ${phase}`);
  return organizationId;
}

// ---------------------------------------------------------------- claim

export const claimWorkosInboxEventInput = z.strictObject({
  claimId: ulid,
  claimedAt: instant,
  leaseExpiresAt: instant,
});

interface UnroutedCandidate {
  readonly inbox_event_id: string;
  readonly routing_key: string;
  readonly event_type: string;
  readonly payload: string;
  readonly digest: string;
  readonly mapped_organization_id: string | null;
  readonly duplicate_digest: string | null;
}

interface ClaimSnapshot {
  readonly held: ClaimRow | null;
  readonly head: "routed" | "unrouted" | null;
  readonly unrouted: UnroutedCandidate | null;
  /** The organization an adopted event belongs to: the mapped one, else the derived id. */
  readonly organizationId: string | null;
}

type ClaimRound = WorkosInboxClaim | null | "again";

/** Retained legacy WorkOS events that can be adopted without inventing their original signature fact. */
const UNROUTED_ELIGIBLE = `u.provider = 'workos' AND u.terminal_code IS NULL AND u.received_at <= ?1
       AND (u.signature_timestamp IS NOT NULL OR EXISTS (SELECT 1 FROM webhook_inbox w
         WHERE w.inbox_event_id=u.inbox_event_id AND w.provider=u.provider AND w.external_event_id=u.external_event_id AND w.body_sha256=u.body_sha256))`;

/** The routed WorkOS events due to be claimed: the original predicate of `claimWorkosInboxEvent`. */
const ROUTED_ELIGIBLE = `inbox.provider = 'workos' AND inbox.acknowledged_at IS NULL AND inbox.attempt_count < inbox.max_attempts
       AND inbox.available_at <= ?1
       AND (inbox.state IN ('pending','retry_wait') OR (inbox.state = 'processing' AND inbox.lease_expires_at <= ?1))`;

/**
 * The events that can end access (a member removed or demoted, an organization deleted) are claimed before every
 * other due event, so a backlog of creations, which only ever add access, can never delay a removal.
 */
const REMOVAL_PRIORITY = (alias: string) =>
  `CASE WHEN ${alias}.event_type IN ('organization.deleted','organization_membership.updated','organization_membership.deleted') THEN 0 ELSE 1 END`;

/** The single global due order, re-evaluated by the final claim statement as well as its snapshot. */
const DUE_HEAD = `SELECT * FROM (
  SELECT 'routed' AS source, inbox.organization_id AS organization_id, inbox.inbox_event_id AS inbox_event_id,
    inbox.available_at AS available_at, inbox.received_at AS received_at, ${REMOVAL_PRIORITY("inbox")} AS priority
    FROM webhook_inbox inbox WHERE ${ROUTED_ELIGIBLE}
  UNION ALL
  SELECT 'unrouted', NULL, u.inbox_event_id, u.received_at, u.received_at, ${REMOVAL_PRIORITY("u")} FROM inbox_unrouted u WHERE ${UNROUTED_ELIGIBLE}
) ORDER BY priority, available_at, received_at, inbox_event_id LIMIT 1`;

/**
 * Adopts one unrouted event of an organization as the claim itself, in one batch: lease it in `webhook_inbox` (the
 * original's first claim, attempt 1) and drop the unrouted copy. The organization is the mapped one (any state, a
 * deleted organization keeps its id) or the derived id of a WorkOS organization that has no mapping yet.
 */
function adoption(
  db: D1Database,
  input: z.output<typeof claimWorkosInboxEventInput>,
  unrouted: UnroutedCandidate,
  organizationId: string | null,
): Plan<ClaimRound> {
  const eventId = unrouted.inbox_event_id;
  return {
    statements: [
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS (SELECT 1 FROM inbox_unrouted WHERE inbox_event_id = ?1 AND terminal_code IS NULL)",
        [eventId],
      ),
      guard(
        db,
        "precondition_changed",
        `NOT EXISTS (SELECT 1 FROM (${DUE_HEAD}) WHERE source = 'unrouted' AND inbox_event_id = ?2)`,
        [input.claimedAt, eventId],
      ),
      // A mapping that appeared under another id after the read: read again and adopt under the mapped one.
      guard(
        db,
        "precondition_changed",
        "EXISTS (SELECT 1 FROM org_directory WHERE workos_organization_id = ?1 AND organization_id <> ?2)",
        [unrouted.routing_key, organizationId],
      ),
      guard(
        db,
        "precondition_changed",
        "EXISTS (SELECT 1 FROM webhook_inbox WHERE provider = 'workos' AND state = 'processing' AND claim_id = ?1)",
        [input.claimId],
      ),
      db
        .prepare(
          `INSERT INTO webhook_inbox(organization_id, inbox_event_id, provider, external_event_id, event_type, payload, body_sha256, received_at, signature_timestamp, state, attempt_count, max_attempts, available_at, claim_id, claimed_at, lease_expires_at)
           SELECT ?2, u.inbox_event_id, u.provider, u.external_event_id, u.event_type, u.payload, u.body_sha256, u.received_at, u.signature_timestamp, 'processing', 1, u.max_attempts, u.received_at, ?3, ?4, ?5
           FROM inbox_unrouted u WHERE u.inbox_event_id = ?1 AND u.terminal_code IS NULL
           RETURNING ${CLAIM_COLUMNS}`,
        )
        .bind(eventId, organizationId, input.claimId, input.claimedAt, input.leaseExpiresAt),
      db
        .prepare("DELETE FROM inbox_unrouted WHERE inbox_event_id = ?1 AND terminal_code IS NULL")
        .bind(eventId),
      guard(db, "precondition_changed", "changes() <> 1"),
      guard(db, "claim_lost", `?1 <= ${DB_NOW}`, [input.leaseExpiresAt]),
    ],
    result: (results) => {
      const row = rowsOf<ClaimRow>(results[4])[0];
      return row === undefined ? "again" : toClaim(row);
    },
  };
}

function claimRound(
  db: D1Database,
  input: z.output<typeof claimWorkosInboxEventInput>,
): Command<ClaimSnapshot, ClaimRound> {
  return {
    name: "identity.claimWorkosInboxEvent",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["webhook_inbox"],
    read: async (reader) => {
      const [held, head, unrouted] = await reader.batch([
        // A claim this caller already holds under its claim id (a lost reply) is answered, never repeated.
        reader
          .prepare(
            `SELECT ${CLAIM_COLUMNS} FROM webhook_inbox WHERE claim_id = ?1 AND provider = 'workos' AND state = 'processing'`,
          )
          .bind(input.claimId),
        reader.prepare(`SELECT source FROM (${DUE_HEAD})`).bind(input.claimedAt),
        reader
          .prepare(
            `SELECT u.inbox_event_id, u.routing_key, u.event_type, u.payload, lower(hex(u.body_sha256)) AS digest,
                    (SELECT d.organization_id FROM org_directory d WHERE d.workos_organization_id = u.routing_key) AS mapped_organization_id,
                    (SELECT lower(hex(w.body_sha256)) FROM webhook_inbox w WHERE w.provider = u.provider AND w.external_event_id = u.external_event_id) AS duplicate_digest
             FROM inbox_unrouted u WHERE ${UNROUTED_ELIGIBLE} ORDER BY ${REMOVAL_PRIORITY("u")}, u.received_at, u.inbox_event_id LIMIT 1`,
          )
          .bind(input.claimedAt),
      ]);
      const candidate = rowsOf<UnroutedCandidate>(unrouted)[0] ?? null;
      return {
        held: rowsOf<ClaimRow>(held)[0] ?? null,
        head: rowsOf<{ source: "routed" | "unrouted" }>(head)[0]?.source ?? null,
        unrouted: candidate,
        organizationId:
          candidate === null || !legacyOrganizationEvent(candidate)
            ? null
            : (candidate.mapped_organization_id ??
              (await derivedOrganizationId(candidate.routing_key))),
      };
    },
    decide: (snapshot): Plan<ClaimRound> => {
      if (snapshot.held !== null) return { replay: toClaim(snapshot.held) };
      if (snapshot.head === null) return { replay: null };
      if (snapshot.head === "routed") {
        return {
          statements: [
            guard(
              db,
              "precondition_changed",
              "EXISTS (SELECT 1 FROM webhook_inbox WHERE provider = 'workos' AND state = 'processing' AND claim_id = ?1)",
              [input.claimId],
            ),
            db
              .prepare(
                `UPDATE webhook_inbox
                 SET state = 'processing', claim_id = ?2, claimed_at = ?1, lease_expires_at = ?3,
                     attempt_count = attempt_count + 1, last_error_code = NULL
                 WHERE inbox_event_id IN (
                   SELECT inbox_event_id FROM (${DUE_HEAD}) WHERE source = 'routed')
                 RETURNING ${CLAIM_COLUMNS}`,
              )
              .bind(input.claimedAt, input.claimId, input.leaseExpiresAt),
            guard(db, "claim_lost", `?1 <= ${DB_NOW}`, [input.leaseExpiresAt]),
          ],
          result: (results) => {
            const row = rowsOf<ClaimRow>(results[1])[0];
            return row === undefined ? "again" : toClaim(row);
          },
        };
      }
      const unrouted = snapshot.unrouted;
      if (unrouted === null) return { replay: "again" };
      if (unrouted.duplicate_digest !== null) {
        // The original's global (provider, external_event_id) key: the event is already held by the core. The same
        // body is a duplicate delivery (its unrouted copy is dropped). The final schema rejects contradictory copies;
        // the refusal branch remains fail-closed for earlier incomplete schemas.
        return {
          statements: [
            guard(
              db,
              "precondition_changed",
              "EXISTS (SELECT 1 FROM webhook_inbox WHERE provider='workos' AND state='processing' AND claim_id=?1)",
              [input.claimId],
            ),
            unrouted.duplicate_digest === unrouted.digest
              ? db
                  .prepare(
                    "DELETE FROM inbox_unrouted WHERE inbox_event_id = ?1 AND terminal_code IS NULL",
                  )
                  .bind(unrouted.inbox_event_id)
              : db
                  .prepare(
                    "UPDATE inbox_unrouted SET terminal_code = 'WEBHOOK_INBOX_CONTENT_CONFLICT', terminal_at = ?2, last_route_attempt_at = ?2 WHERE inbox_event_id = ?1 AND terminal_code IS NULL",
                  )
                  .bind(unrouted.inbox_event_id, input.claimedAt),
          ],
          result: () => "again",
        };
      }
      return adoption(db, input, unrouted, snapshot.organizationId);
    },
  };
}

/** `claimWorkosInboxEvent`: leases the oldest due WorkOS event of the whole core, or null when none is due. */
export async function claimWorkosInboxEvent(
  context: CatalogContext,
  rawInput: unknown,
): Promise<WorkosInboxClaim | null> {
  const input = claimWorkosInboxEventInput.parse(rawInput);
  if (input.leaseExpiresAt <= input.claimedAt) {
    throw new RangeError("WorkOS inbox lease must expire after claim time");
  }
  const core = await context.router.routeShard(0);
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round += 1) {
    const outcome = await runCommand(core.db, claimRound(core.db, input));
    if (outcome !== "again") return outcome;
  }
  throw new StoreBusyError(
    "identity.claimWorkosInboxEvent: the inbox kept changing under the claim",
  );
}

// ---------------------------------------------------------------- expired final claim, failure, recovery

const findExpiredInput = z.strictObject({ observedAt: instant });

/** `findExpiredFinalClaim`: the oldest WorkOS event whose last attempt's lease lapsed without an outcome. */
export async function findExpiredFinalWorkosInboxClaim(
  context: CatalogContext,
  rawInput: unknown,
): Promise<WorkosInboxClaim | null> {
  const input = findExpiredInput.parse(rawInput);
  const core = await context.router.routeShard(0);
  const row = await core.db
    .prepare(
      `SELECT ${CLAIM_COLUMNS} FROM webhook_inbox
       WHERE provider = 'workos' AND state = 'processing' AND acknowledged_at IS NULL AND attempt_count = max_attempts
         AND lease_expires_at <= min(?1, ${DB_NOW})
       ORDER BY lease_expires_at, received_at, inbox_event_id LIMIT 1`,
    )
    .bind(input.observedAt)
    .first<ClaimRow>();
  return row === null ? null : toClaim(row);
}

const claimedEvent = {
  organizationId: ulid.nullable().optional(),
  inboxEventId: ulid,
  claimId: ulid,
};

const recordFailureInput = z.strictObject({
  ...claimedEvent,
  failedAt: instant,
  errorCode,
  nextAvailableAt: instant,
});

/** A WorkOS outage re-drives an event at its attempt limit only while its receipt is this recent. */
const WORKOS_OUTAGE_REDRIVE_MS = 24 * 3_600_000;
/**
 * `recordWorkosInboxFailure`: retry wait, or reconciliation once the attempts are used up; `stale_claim` otherwise.
 * A WorkOS outage (`WORKOS_UNAVAILABLE`) is transient: once its attempts are used up it returns to retry wait with a
 * fresh count of one, so the event is re-driven when WorkOS answers, and each such reset is logged. That reset ends 24
 * hours after the event was received: an older event goes to reconciliation at the limit instead. Every other error,
 * including a permanent transport answer (`WORKOS_TRANSPORT_PERMANENT`), stays terminal at the limit.
 */
export async function recordWorkosInboxFailure(
  context: CatalogContext,
  rawInput: unknown,
): Promise<"retry_scheduled" | "reconciliation_required" | "stale_claim"> {
  const input = recordFailureInput.parse(rawInput);
  if (input.nextAvailableAt <= input.failedAt) {
    throw new RangeError("WorkOS inbox retry must be scheduled after failure time");
  }
  const transient = input.errorCode === "WORKOS_UNAVAILABLE" ? 1 : 0;
  // Receipt times are fixed-width UTC strings with six fractional digits, so the window's start compares as text.
  const redriveSince = new Date(Date.parse(input.failedAt) - WORKOS_OUTAGE_REDRIVE_MS)
    .toISOString()
    .replace(/Z$/u, "000Z");
  const shard = await context.router.routeShard(0);
  // The budget is read before the update in the same batch (one transaction), so the log names only a real reset.
  const [budget, update] = await shard.db.batch([
    shard.db
      .prepare(
        `SELECT attempt_count >= max_attempts AS exhausted, received_at > ?3 AS young FROM webhook_inbox
    WHERE provider = 'workos' AND inbox_event_id = ?1 AND claim_id = ?2 AND state = 'processing'`,
      )
      .bind(input.inboxEventId, input.claimId, redriveSince),
    shard.db
      .prepare(
        `UPDATE webhook_inbox
    SET state = CASE WHEN attempt_count < max_attempts OR (?7 = 1 AND received_at > ?8) THEN 'retry_wait' ELSE 'reconciliation_required' END,
      attempt_count = CASE WHEN attempt_count < max_attempts OR NOT (?7 = 1 AND received_at > ?8) THEN attempt_count ELSE 1 END,
      available_at = CASE WHEN attempt_count < max_attempts OR (?7 = 1 AND received_at > ?8) THEN ?6 ELSE available_at END,
      last_error_code = ?5, claim_id = NULL, claimed_at = NULL, lease_expires_at = NULL
    WHERE provider = 'workos' AND inbox_event_id = ?2 AND claim_id = ?3
      AND state = 'processing' AND acknowledged_at IS NULL AND claimed_at <= min(?4, ${DB_NOW}) AND lease_expires_at > max(?4, ${DB_NOW})
    RETURNING state`,
      )
      .bind(
        input.organizationId ?? null,
        input.inboxEventId,
        input.claimId,
        input.failedAt,
        input.errorCode,
        input.nextAvailableAt,
        transient,
        redriveSince,
      ),
  ]);
  const row = update?.results[0] as { state: string } | undefined;
  if (row === undefined) return "stale_claim";
  if (
    transient === 1 &&
    budget?.results[0]?.["exhausted"] === 1 &&
    budget?.results[0]?.["young"] === 1
  ) {
    console.warn(
      JSON.stringify({ event: "workos_inbox_outage_reset", inboxEventId: input.inboxEventId }),
    );
  }
  return row.state === "retry_wait" ? "retry_scheduled" : "reconciliation_required";
}

const recoverInput = z.strictObject({ ...claimedEvent, recoveredAt: instant, errorCode });

/** `recoverExpiredFinalWorkosInboxLease`: parks the event whose final attempt may have been applied. */
export function recoverExpiredFinalWorkosInboxLease(
  context: CatalogContext,
  rawInput: unknown,
): Promise<boolean> {
  const input = recoverInput.parse(rawInput);
  return recoverFinal(context, input);
}

async function recoverFinal(
  context: CatalogContext,
  input: z.output<typeof recoverInput>,
): Promise<boolean> {
  const shard = await context.router.routeShard(0);
  const result = await shard.db
    .prepare(
      `UPDATE webhook_inbox
    SET state = 'reconciliation_required', last_error_code = ?4, claim_id = NULL, claimed_at = NULL, lease_expires_at = NULL
    WHERE provider = 'workos' AND inbox_event_id = ?2 AND claim_id = ?3
      AND state = 'processing' AND attempt_count = max_attempts AND acknowledged_at IS NULL
      AND lease_expires_at <= min(?5, ${DB_NOW})`,
    )
    .bind(
      input.organizationId ?? null,
      input.inboxEventId,
      input.claimId,
      input.errorCode,
      input.recoveredAt,
    )
    .run();
  return result.meta.changes === 1;
}

// ---------------------------------------------------------------- snapshot with the acknowledgement

const claimReference = z.strictObject({ inboxEventId: ulid, claimId: ulid });

/**
 * The poller's form of the snapshot command: always an `active` snapshot and always with the exact inbox claim,
 * whose acknowledgement commits in the same batch as the organization, the members, the grants and the audit.
 */
export const applyPolledWorkosSnapshotInput = applyWorkosSnapshotInput
  .omit({ state: true, claim: true, organizationId: true })
  .extend({ organizationId: ulid.nullable().optional(), claim: claimReference });

/** `applyWorkosOrganizationSnapshotTransaction` with `acknowledgedAt` fixed to the synchronization time. */
export async function applyPolledWorkosSnapshot(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ApplyWorkosSnapshotResult> {
  const {
    claim,
    organizationId: expectedOrganizationId,
    ...snapshot
  } = applyPolledWorkosSnapshotInput.parse(rawInput);
  const organizationId = await pollerOrganization(
    context,
    snapshot.workosOrganizationId,
    expectedOrganizationId,
    "snapshot apply",
  );
  return applyWorkosSnapshot(
    context,
    {
      ...snapshot,
      organizationId,
      state: "active",
      claim: { ...claim, acknowledgedAt: snapshot.synchronizedAt, clock: "execution" },
    },
    { globalInbox: true },
  );
}

// ---------------------------------------------------------------- organization deletion with the acknowledgement

export const applyWorkosOrganizationDeletionInput = z.strictObject({
  organizationId: ulid.nullable().optional(),
  workosOrganizationId,
  tombstoneDigest: hex256,
  triggerEventId: boundedId,
  deletedAt: instant,
  auditEventId: ulid,
  claim: claimReference,
});

export interface ApplyWorkosOrganizationDeletionResult {
  readonly organizationId: string;
  readonly changed: boolean;
}

interface DeletionState {
  readonly directory: readonly { organization_id: string; workos_organization_id: string }[];
  readonly organization: {
    readonly workos_organization_id: string;
    readonly state: "active" | "suspended" | "deleted";
    readonly mapping_revision: number;
  } | null;
  readonly accesses: readonly OpenDatabaseAccessRow[];
  readonly fingerprint: string;
}

/** The inbox event of the deletion (`?3` organization, `?4` event): its signature time bounds what it supersedes. */
const DELETION_SIGNATURE =
  "(SELECT signature_timestamp FROM webhook_inbox WHERE provider = 'workos' AND inbox_event_id = ?4 AND event_type = 'organization.deleted')";

function deletionCommand(
  db: D1Database,
  bucket: number,
  input: z.output<typeof applyWorkosOrganizationDeletionInput> & {
    readonly organizationId: string;
  },
): Command<DeletionState, ApplyWorkosOrganizationDeletionResult> {
  const organizationId = input.organizationId;
  const tombstone = hexBytes(input.tombstoneDigest);
  return {
    name: "identity.applyWorkosOrganizationDeletion",
    input,
    commandId: `workos-deletion:${input.auditEventId}`,
    now: Date.parse(input.deletedAt),
    retryOn: ["precondition_changed", "row_version_conflict"],
    naturalKeyTables: ["organizations", "org_directory"],
    fromLog: (logged) => logged as ApplyWorkosOrganizationDeletionResult,
    read: async (reader) => {
      const [directory, organization, accesses, fingerprint] = await reader.batch([
        reader
          .prepare(
            "SELECT organization_id, workos_organization_id FROM org_directory WHERE organization_id = ?1 OR workos_organization_id = ?2",
          )
          .bind(organizationId, input.workosOrganizationId),
        reader
          .prepare(
            "SELECT workos_organization_id, state, mapping_revision FROM organizations WHERE organization_id = ?",
          )
          .bind(organizationId),
        reader
          .prepare(`${OPEN_DATABASE_ACCESS_SELECT} AND organization_id = ?1`)
          .bind(organizationId),
        reader.prepare(`SELECT ${IDENTITY_FINGERPRINT_EXPR} AS fingerprint`).bind(organizationId),
      ]);
      return {
        directory: rowsOf<DeletionState["directory"][number]>(directory),
        organization: rowsOf<NonNullable<DeletionState["organization"]>>(organization)[0] ?? null,
        accesses: rowsOf<OpenDatabaseAccessRow>(accesses),
        fingerprint: (rowsOf<{ fingerprint: string }>(fingerprint)[0] as { fingerprint: string })
          .fingerprint,
      };
    },
    decide: (state): Plan<ApplyWorkosOrganizationDeletionResult> => {
      const [mapped] = state.directory;
      if (
        state.directory.length > 1 ||
        (mapped !== undefined &&
          (mapped.organization_id !== organizationId ||
            mapped.workos_organization_id !== input.workosOrganizationId))
      ) {
        return {
          reject: identityConflict(
            "workos_organization_mapped",
            "WorkOS organization is already mapped to a different internal organization",
          ),
        };
      }
      const current = state.organization;
      if (current !== null && current.workos_organization_id !== input.workosOrganizationId) {
        return {
          reject: conflict(
            "workos_organization_mapped",
            "Proposed organization ID is already mapped to another WorkOS organization",
          ),
        };
      }
      const changed = current === null || current.state !== "deleted";
      const statements: D1PreparedStatement[] = [
        guard(db, "precondition_changed", `(${IDENTITY_FINGERPRINT_EXPR}) IS NOT ?2`, [
          organizationId,
          state.fingerprint,
        ]),
        db
          .prepare(
            "INSERT INTO org_directory(organization_id, workos_organization_id, bucket, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'deleted', ?4, ?4) ON CONFLICT (organization_id) DO NOTHING",
          )
          .bind(organizationId, input.workosOrganizationId, bucket, input.deletedAt),
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS (SELECT 1 FROM org_directory WHERE organization_id = ?1 AND workos_organization_id = ?2)",
          [organizationId, input.workosOrganizationId],
        ),
        db
          .prepare(
            "UPDATE org_directory SET state = 'deleted', updated_at = ?2 WHERE organization_id = ?1 AND state <> 'deleted'",
          )
          .bind(organizationId, input.deletedAt),
      ];
      if (current === null) {
        statements.push(
          db
            .prepare(
              "INSERT INTO organizations(organization_id, workos_organization_id, state, mapping_revision, snapshot_sha256, snapshot_fetched_at, synchronized_at, created_at, updated_at, bucket) VALUES (?1, ?2, 'deleted', 1, ?3, ?4, ?4, ?4, ?4, ?5)",
            )
            .bind(organizationId, input.workosOrganizationId, tombstone, input.deletedAt, bucket),
        );
      } else if (current.state !== "deleted") {
        statements.push(
          db
            .prepare(
              "UPDATE organizations SET state = 'deleted', mapping_revision = mapping_revision + 1, snapshot_sha256 = ?3, snapshot_fetched_at = ?4, synchronized_at = ?4, updated_at = ?4 WHERE organization_id = ?1 AND mapping_revision = ?2 AND state <> 'deleted'",
            )
            .bind(organizationId, current.mapping_revision, tombstone, input.deletedAt),
          guard(db, "row_version_conflict", "changes() = 0"),
        );
      }
      statements.push(
        // automatic recharge stops with the organization: nobody can sign in to switch it off
        db
          .prepare(
            "UPDATE stripe_recharge_policies SET enabled = 0, status = 'off', updated_at = ?2 WHERE organization_id = ?1 AND enabled = 1",
          )
          .bind(organizationId, input.deletedAt),
        // memberships and machine bindings of the organization end with it; their rows stay as history
        db
          .prepare(
            "UPDATE organization_memberships SET state = 'revoked', mapping_revision = mapping_revision + 1, snapshot_sha256 = ?2, effective_at = ?3, revoked_at = ?3, trigger_event_id = ?4 WHERE organization_id = ?1 AND state <> 'revoked'",
          )
          .bind(organizationId, tombstone, input.deletedAt, input.triggerEventId),
        db
          .prepare(
            "UPDATE m2m_organization_bindings SET state = 'revoked', mapping_revision = mapping_revision + 1, revoked_at = ?2 WHERE organization_id = ?1 AND state = 'active'",
          )
          .bind(organizationId, input.deletedAt),
        db
          .prepare(
            "UPDATE api_key_metadata SET revoked_at = ?2 WHERE organization_id = ?1 AND revoked_at IS NULL",
          )
          .bind(organizationId, input.deletedAt),
        revokeAllGrantsStatement(db, organizationId, input.deletedAt),
        // Open database access ends with the organization, as it does when the snapshot marks it inactive.
        ...revokeOpenDatabaseAccessStatements(db, state.accesses, input.deletedAt, "organization"),
        auditStatement(db, organizationId, {
          auditEventId: input.auditEventId,
          projectId: null,
          operationId: null,
          billingEpochId: null,
          eventType: "WorkosOrganizationDeleted",
          actorType: "system",
          actorId: "workos-management",
          payload: {
            triggerEventId: input.triggerEventId,
            tombstoneSha256: input.tombstoneDigest,
          },
          occurredAt: input.deletedAt,
        }),
        // The exact claim must still hold at the SQL-executed time; its acknowledgement is part of this batch.
        guard(
          db,
          "claim_lost",
          `NOT EXISTS (SELECT 1 FROM webhook_inbox WHERE json_extract(payload,'$.workosOrganizationId') = ?1 AND event_type='organization.deleted' AND provider = 'workos' AND inbox_event_id = ?2
             AND claim_id = ?3 AND state = 'processing' AND claimed_at <= min(?4, ${DB_NOW}) AND lease_expires_at > max(?4, ${DB_NOW}) AND acknowledged_at IS NULL)`,
          [
            input.workosOrganizationId,
            input.claim.inboxEventId,
            input.claim.claimId,
            input.deletedAt,
          ],
        ),
        db
          .prepare(acknowledgeInboxSql(true, true))
          .bind(
            organizationId,
            "workos",
            input.claim.inboxEventId,
            input.claim.claimId,
            input.deletedAt,
          ),
        guard(db, "claim_lost", "changes() <> 1"),
        // Everything of this WorkOS organization that the deletion's signature covers is superseded: never replayed.
        db
          .prepare(
            `UPDATE webhook_inbox
             SET state = 'acknowledged', attempt_count = max(attempt_count, 1), available_at = ?1, last_error_code = NULL,
                 claim_id = NULL, claimed_at = NULL, lease_expires_at = NULL, acknowledged_at = ?1
             WHERE provider = 'workos' AND inbox_event_id <> ?4 AND acknowledged_at IS NULL
               AND (state IN ('pending','retry_wait','reconciliation_required') OR (state = 'processing' AND lease_expires_at <= ?1))
               AND json_extract(payload, '$.workosOrganizationId') = ?2
               AND signature_timestamp <= ${DELETION_SIGNATURE}`,
          )
          .bind(
            input.deletedAt,
            input.workosOrganizationId,
            organizationId,
            input.claim.inboxEventId,
          ),
        db
          .prepare(
            `UPDATE inbox_unrouted SET terminal_code = 'SUPERSEDED_BY_DELETION', terminal_at = ?1, last_route_attempt_at = ?1
             WHERE provider = 'workos' AND routing_key = ?2 AND terminal_code IS NULL
               AND COALESCE(signature_timestamp, received_at) <= ${DELETION_SIGNATURE}`,
          )
          .bind(
            input.deletedAt,
            input.workosOrganizationId,
            organizationId,
            input.claim.inboxEventId,
          ),
      );
      const result = { organizationId, changed };
      return { statements, result: () => result, logResult: result };
    },
  };
}

/**
 * `applyWorkosOrganizationDeletionTransaction`: the terminal tombstone of an organization (a delete-before-create
 * observation gets it too), the end of its memberships, machine bindings and grants, the audit and the exact inbox
 * acknowledgement as ONE batch. A stale claim aborts all of it (`inbox_claim_stale`). Financial rows, history,
 * projects and the audit trail are untouched.
 */
export async function applyWorkosOrganizationDeletion(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ApplyWorkosOrganizationDeletionResult> {
  const input = applyWorkosOrganizationDeletionInput.parse(rawInput);
  const organizationId = await pollerOrganization(
    context,
    input.workosOrganizationId,
    input.organizationId,
    "organization deletion",
  );
  const shard = await routeOrganization(context, organizationId);
  return runMapped(
    shard.db,
    deletionCommand(shard.db, shard.bucket ?? 0, { ...input, organizationId }),
    {
      claim_lost: () =>
        conflict("inbox_claim_stale", "WorkOS inbox claim is stale during organization deletion"),
    },
  );
}

// ---------------------------------------------------------------- uncertain snapshot

const uncertainSnapshotInput = z.strictObject({
  workosOrganizationId: z.string().max(256),
  revokedAt: instant,
});

/**
 * `revokeLocalAuthorizationForUncertainSnapshot`: an invalid provider snapshot ends every active local grant of the
 * mapped organization (a deleted one included), as the original did; nothing else changes and an unmapped
 * organization is a no-op. One statement keyed by the immutable mapping, so it is atomic.
 */
export async function revokeLocalAuthorizationForUncertainSnapshot(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly revoked: boolean }> {
  const input = uncertainSnapshotInput.parse(rawInput);
  if (input.workosOrganizationId.trim() === "") return { revoked: false };
  const mapped = await directoryOrganizationByWorkosId(
    context.directory,
    input.workosOrganizationId,
  );
  if (mapped === null) return { revoked: false };
  const shard = await routeOrganization(context, mapped.organization_id);
  await shard.db.batch([
    revokeAllGrantsStatement(shard.db, mapped.organization_id, input.revokedAt),
  ]);
  return { revoked: true };
}

/** Bound with the store's bucket fence and route refresh; merged into `store.identity`. */
export type BindPollerCommand = <Result>(
  command: (context: CatalogContext, input: unknown) => Promise<Result>,
) => (input: unknown) => Promise<Result>;

export function createWorkosPollerCommands(bind: BindPollerCommand) {
  return Object.freeze({
    claimWorkosInboxEvent: bind(claimWorkosInboxEvent),
    findExpiredFinalWorkosInboxClaim: bind(findExpiredFinalWorkosInboxClaim),
    recordWorkosInboxFailure: bind(recordWorkosInboxFailure),
    recoverExpiredFinalWorkosInboxLease: bind(recoverExpiredFinalWorkosInboxLease),
    applyPolledWorkosSnapshot: bind(applyPolledWorkosSnapshot),
    applyWorkosOrganizationDeletion: bind(applyWorkosOrganizationDeletion),
    revokeLocalAuthorizationForUncertainSnapshot: bind(
      revokeLocalAuthorizationForUncertainSnapshot,
    ),
  });
}
