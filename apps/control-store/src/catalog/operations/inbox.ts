import { z } from "zod";

import type { D1Database } from "../../d1-types.js";
import { BucketFencedError, BucketMovingError } from "../../fence.js";
import { runCommand, type Command } from "../../run-command.js";
import { storedTimestamp } from "../../timestamps.js";
import {
  conflict,
  hexBytes,
  instant,
  notFencedOrganization,
  jsonRecord,
  ringDoorbell,
  routeOrganization,
  sha256Hex,
  ulid,
  type CatalogContext,
} from "../common.js";

const provider = z.enum(["workos", "github", "stripe"]);
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u);

/** Where a provider event belongs, known from the event itself and resolved through the directory. */
const routing = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("organization"), organizationId: ulid }),
  z.strictObject({
    kind: z.literal("workos_organization"),
    workosOrganizationId: z.string().min(5).max(128),
  }),
  z.strictObject({
    kind: z.literal("external"),
    externalKind: z.enum([
      "github_installation",
      "github_repository",
      "resend_domain",
      "pgcf_database",
    ]),
    externalId: z.string().min(1).max(256),
  }),
  /** Events without an organization (for example a user's sessions) retain their global identity. */
  z.strictObject({ kind: z.literal("unscoped"), routingKey: z.string().min(1).max(256) }),
]);
type Routing = z.infer<typeof routing>;

async function resolveOrganization(directory: D1Database, target: Routing): Promise<string | null> {
  if (target.kind === "organization") return target.organizationId;
  if (target.kind === "unscoped") return null;
  if (target.kind === "workos_organization") {
    const row = await directory
      .prepare(
        "SELECT organization_id FROM org_directory WHERE workos_organization_id = ? AND state <> 'deleted'",
      )
      .bind(target.workosOrganizationId)
      .first<{ organization_id: string }>();
    return row?.organization_id ?? null;
  }
  const rows = await directory
    .prepare(
      "SELECT DISTINCT organization_id FROM external_route WHERE kind = ?1 AND external_id = ?2 LIMIT 2",
    )
    .bind(target.externalKind, target.externalId)
    .all<{ organization_id: string }>();
  return rows.results.length === 1
    ? (rows.results[0] as { organization_id: string }).organization_id
    : null;
}

export const recordInboxEventInput = z.strictObject({
  provider,
  inboxEventId: ulid,
  externalEventId: z.string().min(1).max(512),
  eventType: z.string().min(1).max(256),
  payload: jsonRecord,
  bodyDigest: sha256Hex,
  receivedAt: instant,
  signatureTimestamp: instant.nullable().default(null),
  maxAttempts: z.number().int().min(1).max(2_147_483_647),
  routing,
  /** Auth-only events are stored as already acknowledged evidence and never claimed. */
  acknowledgedAt: instant.optional(),
});

export interface RecordInboxEventResult {
  readonly outcome: "created" | "existing";
  /** Retained catalog response labels describe the optional hint; storage is always the shared global table. */
  readonly routed: "shard" | "unrouted";
}

interface InboxExistence {
  readonly inbox_event_id: string;
  readonly digest: string;
}

/** Internal closed command builder, also composed with the WorkOS ingress authentication projection. */
export function inboxRecordCommand(
  db: D1Database,
  input: z.output<typeof recordInboxEventInput>,
  organizationId: string | null,
): Command<{ natural: InboxExistence[]; proposed: boolean }, RecordInboxEventResult> {
  const routed = organizationId === null ? "unrouted" : "shard";
  return {
    name: "operations.recordInboxEvent",
    input,
    naturalKeyTables: ["webhook_inbox", "inbox_unrouted"],
    read: async (reader) => {
      const [natural, proposed] = await reader.batch([
        reader
          .prepare(
            `SELECT inbox_event_id, lower(hex(body_sha256)) AS digest FROM webhook_inbox WHERE provider=?1 AND external_event_id=?2
          UNION ALL SELECT inbox_event_id, lower(hex(body_sha256)) AS digest FROM inbox_unrouted WHERE provider=?1 AND external_event_id=?2`,
          )
          .bind(input.provider, input.externalEventId),
        reader
          .prepare(
            "SELECT 1 FROM webhook_inbox WHERE inbox_event_id=?1 UNION ALL SELECT 1 FROM inbox_unrouted WHERE inbox_event_id=?1",
          )
          .bind(input.inboxEventId),
      ]);
      return {
        natural: (natural?.results ?? []) as unknown as InboxExistence[],
        proposed: (proposed?.results.length ?? 0) > 0,
      };
    },
    decide: (state) => {
      // An own natural replay is answered before inspecting a newly proposed id, as PostgreSQL's insert did.
      if (state.natural.length > 0) {
        return state.natural.some((row) => row.digest !== input.bodyDigest)
          ? { reject: conflict("webhook_inbox_content_conflict") }
          : { replay: { outcome: "existing", routed } };
      }
      if (state.proposed) return { reject: conflict("webhook_inbox_identity_conflict") };
      const acknowledged = input.acknowledgedAt !== undefined;
      return {
        statements: [
          db
            .prepare(
              `INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,signature_timestamp,state,attempt_count,max_attempts,available_at,acknowledged_at,organization_id)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0,?10,?7,?11,?12)`,
            )
            .bind(
              input.inboxEventId,
              input.provider,
              input.externalEventId,
              input.eventType,
              JSON.stringify(input.payload),
              hexBytes(input.bodyDigest),
              input.receivedAt,
              input.signatureTimestamp,
              acknowledged ? "acknowledged" : "pending",
              acknowledged ? 1 : input.maxAttempts,
              input.acknowledgedAt ?? null,
              organizationId,
            ),
          ...(acknowledged
            ? []
            : [
                db
                  .prepare(
                    "INSERT INTO work_due(kind,shard_id,due_at) VALUES ('inbox',0,?1) ON CONFLICT(kind,shard_id) DO UPDATE SET due_at=excluded.due_at WHERE excluded.due_at<work_due.due_at",
                  )
                  .bind(input.receivedAt),
              ]),
        ],
        result: () => ({ outcome: "created", routed }),
      };
    },
  };
}

/** Records the original global inbox facts. Organization is optional routing metadata, never an identity. */
export async function recordInboxEvent(
  context: CatalogContext,
  rawInput: unknown,
): Promise<RecordInboxEventResult> {
  const input = recordInboxEventInput.parse(rawInput);
  if (input.acknowledgedAt !== undefined && input.acknowledgedAt < input.receivedAt) {
    throw new RangeError("Inbox acknowledgement predates receipt");
  }
  if ((input.provider === "workos") !== (input.signatureTimestamp !== null)) {
    throw new TypeError("Inbox signature timestamp does not match its provider");
  }
  const organizationId = await resolveOrganization(context.directory, input.routing);
  return runCommand(
    context.directory,
    inboxRecordCommand(context.directory, input, organizationId),
  );
}

export const routeUnroutedInboxEventsInput = z.strictObject({
  limit: z.number().int().min(1).max(100),
  /** The sweep's clock; it stamps route attempts and terminal classifications (the wall clock when omitted). */
  now: instant.optional(),
});

/** Terminal classifications of an unrouted event: never retried again, kept as evidence until its retention ends. */
export const UNROUTED_TERMINAL_CODES = [
  "UNROUTABLE_ROUTING_KEY",
  "WEBHOOK_INBOX_CONTENT_CONFLICT",
  "ROUTE_ATTEMPTS_EXHAUSTED",
] as const;

interface UnroutedRow {
  readonly inbox_event_id: string;
  readonly provider: "workos" | "github" | "stripe";
  readonly external_event_id: string;
  readonly routing_key: string;
  readonly event_type: string;
  readonly payload: string;
  readonly digest: string;
  readonly received_at: string;
  readonly signature_timestamp: string | null;
  readonly max_attempts: number;
}

function unroutedTarget(key: string): Routing | null {
  if (key.startsWith("org_")) return { kind: "workos_organization", workosOrganizationId: key };
  if (/^(github_installation|github_repository|resend_domain|pgcf_database):/u.test(key)) {
    return {
      kind: "external",
      externalKind: key.slice(0, key.indexOf(":")) as "github_installation",
      externalId: key.slice(key.indexOf(":") + 1),
    };
  }
  return null;
}

/**
 * Moves the unrouted events whose owner has appeared into the owner's shard. Each event is a two-step saga
 * of idempotent steps: insert in the shard (a duplicate there is the same event), then delete the global copy.
 *
 * The event keeps its own `max_attempts` in the shard. Nothing is skipped silently: a routing key no route can
 * ever resolve, and an event whose identity the shard already holds with another body, are classified terminal
 * (the global row stays as evidence, never deleted and never replayed); a routing step that keeps failing is
 * counted and becomes terminal when the event's attempts are used up. An owner that has not appeared yet is a
 * wait, not an attempt, and a fenced bucket is a transient wait too. No retention cutoff is introduced.
 */
export async function routeUnroutedInboxEvents(
  context: CatalogContext,
  rawInput: unknown,
): Promise<number> {
  const input = routeUnroutedInboxEventsInput.parse(rawInput);
  const now = input.now ?? storedTimestamp(new Date().toISOString());
  const rows = await context.directory
    .prepare(
      `SELECT inbox_event_id, provider, external_event_id, routing_key, event_type, payload, lower(hex(body_sha256)) AS digest, received_at,
              signature_timestamp, max_attempts
       FROM inbox_unrouted WHERE terminal_code IS NULL ORDER BY received_at, inbox_event_id LIMIT ?`,
    )
    .bind(input.limit)
    .all<UnroutedRow>();
  const classify = (row: UnroutedRow, code: (typeof UNROUTED_TERMINAL_CODES)[number]) =>
    context.directory
      .prepare(
        "UPDATE inbox_unrouted SET terminal_code = ?2, terminal_at = ?3, last_route_attempt_at = ?3 WHERE inbox_event_id = ?1 AND terminal_code IS NULL",
      )
      .bind(row.inbox_event_id, code, now)
      .run();
  let moved = 0;
  for (const row of rows.results) {
    const target = unroutedTarget(row.routing_key);
    if (target === null) {
      await classify(row, "UNROUTABLE_ROUTING_KEY");
      continue;
    }
    const organizationId = await resolveOrganization(context.directory, target);
    if (organizationId === null) continue;
    try {
      const shard = await routeOrganization(context, organizationId);
      await shard.db
        .prepare(
          `INSERT INTO webhook_inbox(organization_id, inbox_event_id, provider, external_event_id, event_type, payload, body_sha256, received_at, signature_timestamp, state, attempt_count, max_attempts, available_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', 0, ?10, ?8)
           ON CONFLICT (provider, external_event_id) DO NOTHING`,
        )
        .bind(
          organizationId,
          row.inbox_event_id,
          row.provider,
          row.external_event_id,
          row.event_type,
          row.payload,
          hexBytes(row.digest),
          row.received_at,
          row.signature_timestamp,
          row.max_attempts,
        )
        .run();
      const held = await shard.db
        .prepare(
          "SELECT lower(hex(body_sha256)) AS digest FROM webhook_inbox WHERE provider = ?1 AND external_event_id = ?2",
        )
        .bind(row.provider, row.external_event_id)
        .first<{ digest: string }>();
      if (held?.digest !== row.digest) {
        await classify(row, "WEBHOOK_INBOX_CONTENT_CONFLICT");
        continue;
      }
      await context.directory
        .prepare("DELETE FROM inbox_unrouted WHERE inbox_event_id = ?")
        .bind(row.inbox_event_id)
        .run();
      await ringDoorbell(context.directory, "inbox", shard.shardId, row.received_at);
      moved += 1;
    } catch (error) {
      if (error instanceof BucketFencedError || error instanceof BucketMovingError) continue;
      await context.directory
        .prepare(
          `UPDATE inbox_unrouted SET route_attempts = route_attempts + 1, last_route_attempt_at = ?2,
             terminal_code = CASE WHEN route_attempts + 1 >= max_attempts THEN 'ROUTE_ATTEMPTS_EXHAUSTED' END,
             terminal_at = CASE WHEN route_attempts + 1 >= max_attempts THEN ?2 END
           WHERE inbox_event_id = ?1 AND terminal_code IS NULL`,
        )
        .bind(row.inbox_event_id, now)
        .run();
    }
  }
  return moved;
}

const target = {
  shardId: z.number().int().min(0).max(1023).optional(),
  organizationId: ulid.optional(),
};
function exactlyOneTarget(value: {
  shardId?: number | undefined;
  organizationId?: string | undefined;
}) {
  return (value.shardId === undefined) !== (value.organizationId === undefined);
}
async function routeTarget(
  context: CatalogContext,
  value: { shardId?: number | undefined; organizationId?: string | undefined },
) {
  return value.organizationId !== undefined
    ? routeOrganization(context, value.organizationId)
    : context.router.routeShard(value.shardId as number);
}

export const claimInboxEventInput = z
  .strictObject({
    ...target,
    provider,
    claimId: ulid,
    claimedAt: instant,
    leaseExpiresAt: instant,
    /** `push` for the GitHub auto-deploy claim. */
    eventType: z.string().min(1).optional(),
    /** Top-level payload fields that must equal these strings (the Stripe account and mode). */
    payloadEquals: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/u), z.string()).optional(),
  })
  .refine(exactlyOneTarget, "name either a shard or an organization");

export interface ClaimedInboxEvent {
  readonly organizationId: string | null;
  readonly inboxEventId: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly claimId: string;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
}

interface InboxClaimRow {
  readonly organization_id: string | null;
  readonly inbox_event_id: string;
  readonly external_event_id: string;
  readonly event_type: string;
  readonly payload: string;
  readonly claim_id: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
}

const INBOX_CLAIM_COLUMNS =
  "organization_id, inbox_event_id, external_event_id, event_type, payload, claim_id, attempt_count, max_attempts";

function inboxClaim(row: InboxClaimRow): ClaimedInboxEvent {
  return {
    organizationId: row.organization_id,
    inboxEventId: row.inbox_event_id,
    externalEventId: row.external_event_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    claimId: row.claim_id,
    attemptNumber: row.attempt_count,
    maxAttempts: row.max_attempts,
  };
}

/**
 * `claimWorkosInboxEvent` and its GitHub and Stripe siblings: one statement leases the oldest due event of
 * the provider (a processing event whose lease lapsed is due again), so concurrent claimers never share a row.
 * A claim the caller already holds under its claim id (a lost response) is answered, not repeated.
 */
export async function claimInboxEvent(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ClaimedInboxEvent | null> {
  const input = claimInboxEventInput.parse(rawInput);
  if (input.leaseExpiresAt <= input.claimedAt) {
    throw new RangeError("Inbox lease must expire after claim time");
  }
  const shard = await routeTarget(context, input);
  const binds: unknown[] = [input.claimId, input.claimedAt, input.leaseExpiresAt, input.provider];
  const filters: string[] = [];
  const next = () => `?${binds.length + 1}`;
  if (input.organizationId !== undefined) {
    filters.push(`AND inbox.organization_id = ${next()}`);
    binds.push(input.organizationId);
  }
  if (input.eventType !== undefined) {
    filters.push(`AND inbox.event_type = ${next()}`);
    binds.push(input.eventType);
  }
  for (const [field, value] of Object.entries(input.payloadEquals ?? {})) {
    filters.push(`AND json_extract(inbox.payload, '$.${field}') = ${next()}`);
    binds.push(value);
  }
  const command: Command<InboxClaimRow | null, ClaimedInboxEvent | null> = {
    name: "operations.claimInboxEvent",
    input,
    read: (reader) =>
      reader
        .prepare(
          `SELECT ${INBOX_CLAIM_COLUMNS} FROM webhook_inbox inbox WHERE claim_id = ?1 AND provider=?4 AND state = 'processing' ${filters.join(" ")}`,
        )
        .bind(...binds)
        .first<InboxClaimRow>(),
    decide: (existing) =>
      existing !== null
        ? { replay: inboxClaim(existing) }
        : {
            statements: [
              shard.db
                .prepare(
                  `UPDATE webhook_inbox
                   SET state = 'processing', claim_id = ?1, claimed_at = ?2, lease_expires_at = ?3,
                       attempt_count = attempt_count + 1, last_error_code = NULL
                   WHERE NOT EXISTS (SELECT 1 FROM webhook_inbox WHERE provider=?4 AND claim_id=?1 AND state='processing') AND inbox_event_id IN (
                     SELECT inbox.inbox_event_id FROM webhook_inbox inbox
                     WHERE inbox.provider = ?4 AND inbox.acknowledged_at IS NULL AND inbox.attempt_count < inbox.max_attempts
                       AND inbox.available_at <= ?2
                       AND (inbox.state IN ('pending','retry_wait') OR (inbox.state = 'processing' AND inbox.lease_expires_at <= ?2))
                       ${input.organizationId === undefined ? "" : `AND ${notFencedOrganization("inbox.organization_id")}`}
                       ${filters.join(" ")}
                     ORDER BY inbox.available_at, inbox.received_at, inbox.inbox_event_id LIMIT 1)
                   RETURNING ${INBOX_CLAIM_COLUMNS}`,
                )
                .bind(...binds),
            ],
            result: (results) => {
              const row = (results[0]?.results as InboxClaimRow[] | undefined)?.[0];
              return row === undefined ? null : inboxClaim(row);
            },
          },
  };
  return runCommand(shard.db, command);
}

/** A null organization is a global identity (a GitHub push): its row lives on the one shared partition. */
const claimedEvent = {
  organizationId: ulid.nullable(),
  provider,
  inboxEventId: ulid,
  claimId: ulid,
};

function routeClaimed(context: CatalogContext, organizationId: string | null) {
  return organizationId === null
    ? context.router.routeShard(0)
    : routeOrganization(context, organizationId);
}

export const renewInboxLeaseInput = z.strictObject({
  ...claimedEvent,
  renewedAt: instant,
  leaseExpiresAt: instant,
});

/** `renewGithubPushInboxClaim`: extends the lease of the claim that still holds the event. */
export async function renewInboxLease(
  context: CatalogContext,
  rawInput: unknown,
): Promise<boolean> {
  const input = renewInboxLeaseInput.parse(rawInput);
  if (input.leaseExpiresAt <= input.renewedAt) {
    throw new RangeError("Renewed inbox lease must expire after renewal");
  }
  const shard = await routeClaimed(context, input.organizationId);
  const result = await shard.db
    .prepare(
      `UPDATE webhook_inbox SET lease_expires_at = ?6
       WHERE organization_id IS ?1 AND provider = ?2 AND inbox_event_id = ?3 AND claim_id = ?4 AND state = 'processing'
         AND acknowledged_at IS NULL AND claimed_at <= ?5 AND lease_expires_at > ?5`,
    )
    .bind(
      input.organizationId,
      input.provider,
      input.inboxEventId,
      input.claimId,
      input.renewedAt,
      input.leaseExpiresAt,
    )
    .run();
  return result.meta.changes === 1;
}

export const acknowledgeInboxEventInput = z.strictObject({
  ...claimedEvent,
  acknowledgedAt: instant,
});

/** `acknowledgeWorkosInboxEvent`: true when the claim was current and unexpired and the event is acknowledged. */
export async function acknowledgeInboxEvent(
  context: CatalogContext,
  rawInput: unknown,
): Promise<boolean> {
  const input = acknowledgeInboxEventInput.parse(rawInput);
  const shard = await routeClaimed(context, input.organizationId);
  const result = await shard.db
    .prepare(acknowledgeInboxSql())
    .bind(
      input.organizationId,
      input.provider,
      input.inboxEventId,
      input.claimId,
      input.acknowledgedAt,
    )
    .run();
  return result.meta.changes === 1;
}

/** The acknowledgement statement, shared with the commands that acknowledge an event in their own batch. */
export function acknowledgeInboxSql(executionClock = false, globalIdentity = false): string {
  const now = executionClock ? "(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')" : "?5";
  return `UPDATE webhook_inbox SET state = 'acknowledged', acknowledged_at = ?5, claim_id = NULL, claimed_at = NULL, lease_expires_at = NULL
          WHERE ${globalIdentity ? "" : "organization_id IS ?1 AND "}provider = ?2 AND inbox_event_id = ?3 AND claim_id = ?4 AND state = 'processing'
            AND acknowledged_at IS NULL AND claimed_at <= ${now} AND lease_expires_at > ${now}`;
}

export const failInboxEventInput = z.strictObject({
  ...claimedEvent,
  failedAt: instant,
  errorCode,
  nextAvailableAt: instant,
});

/**
 * `recordWorkosInboxFailure` and the GitHub and Stripe variants: the failed event waits for a retry, or is
 * parked for reconciliation when its attempts are used up. `stale` means the claim is no longer current.
 */
export async function failInboxEvent(
  context: CatalogContext,
  rawInput: unknown,
): Promise<"retry" | "reconciliation_required" | "stale"> {
  const input = failInboxEventInput.parse(rawInput);
  if (input.nextAvailableAt <= input.failedAt) {
    throw new RangeError("Inbox retry must be scheduled after the failure time");
  }
  const shard = await routeClaimed(context, input.organizationId);
  const result = await shard.db
    .prepare(
      `UPDATE webhook_inbox
       SET state = CASE WHEN attempt_count < max_attempts THEN 'retry_wait' ELSE 'reconciliation_required' END,
           available_at = CASE WHEN attempt_count < max_attempts THEN ?6 ELSE available_at END,
           last_error_code = ?5, claim_id = NULL, claimed_at = NULL, lease_expires_at = NULL
       WHERE organization_id IS ?1 AND provider = ?2 AND inbox_event_id = ?3 AND claim_id = ?4 AND state = 'processing'
         AND acknowledged_at IS NULL AND claimed_at <= ?7 AND lease_expires_at > ?7
       RETURNING state, available_at`,
    )
    .bind(
      input.organizationId,
      input.provider,
      input.inboxEventId,
      input.claimId,
      input.errorCode,
      input.nextAvailableAt,
      input.failedAt,
    )
    .all<{ state: "retry_wait" | "reconciliation_required"; available_at: string }>();
  const row = result.results[0];
  if (row === undefined) return "stale";
  if (row.state === "reconciliation_required") return "reconciliation_required";
  await ringDoorbell(context.directory, "inbox", shard.shardId, row.available_at);
  return "retry";
}

export const findExpiredFinalInboxClaimInput = z
  .strictObject({ ...target, provider, observedAt: instant })
  .refine(exactlyOneTarget, "name either a shard or an organization");

/** `findExpiredFinalClaim`: the oldest processing event whose last attempt's lease lapsed without an outcome. */
export async function findExpiredFinalInboxClaim(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ClaimedInboxEvent | null> {
  const input = findExpiredFinalInboxClaimInput.parse(rawInput);
  const shard = await routeTarget(context, input);
  const row = await shard.db
    .prepare(
      `SELECT ${INBOX_CLAIM_COLUMNS} FROM webhook_inbox
       WHERE provider = ?1 AND state = 'processing' AND acknowledged_at IS NULL AND attempt_count = max_attempts
         AND lease_expires_at <= ?2 AND (?3 IS NULL OR organization_id = ?3)
       ORDER BY lease_expires_at, received_at, inbox_event_id LIMIT 1`,
    )
    .bind(input.provider, input.observedAt, input.organizationId ?? null)
    .first<InboxClaimRow>();
  return row === null ? null : inboxClaim(row);
}

export const recoverExpiredFinalInboxLeaseInput = z.strictObject({
  ...claimedEvent,
  recoveredAt: instant,
  errorCode,
});

/** `recoverExpiredFinalWorkosInboxLease`: parks the event whose last attempt may have been applied. */
export async function recoverExpiredFinalInboxLease(
  context: CatalogContext,
  rawInput: unknown,
): Promise<boolean> {
  const input = recoverExpiredFinalInboxLeaseInput.parse(rawInput);
  const shard = await routeClaimed(context, input.organizationId);
  const result = await shard.db
    .prepare(
      `UPDATE webhook_inbox SET state = 'reconciliation_required', last_error_code = ?5, claim_id = NULL, claimed_at = NULL, lease_expires_at = NULL
       WHERE organization_id IS ?1 AND provider = ?2 AND inbox_event_id = ?3 AND claim_id = ?4 AND state = 'processing'
         AND attempt_count = max_attempts AND lease_expires_at <= ?6 AND acknowledged_at IS NULL`,
    )
    .bind(
      input.organizationId,
      input.provider,
      input.inboxEventId,
      input.claimId,
      input.errorCode,
      input.recoveredAt,
    )
    .run();
  return result.meta.changes === 1;
}
