import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command, type Plan } from "../../run-command.js";
import {
  addMilliseconds,
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
import { ensureAccount } from "../credit/index.js";
import { acknowledgeInboxSql } from "../operations/inbox.js";
import {
  OPEN_DATABASE_ACCESS_SELECT,
  revokeOpenDatabaseAccessStatements,
  type OpenDatabaseAccessRow,
} from "./database-access-revocation.js";
import {
  persistOrganizationGrantsStatement,
  projectRole,
  revokeAllGrantsStatement,
  revokeUserGrantsStatement,
  type OrganizationGrantEntry,
} from "./local-grants.js";
import {
  IDENTITY_FINGERPRINT_EXPR,
  identityConflict,
  boundedId,
  chunked,
  derivedUlid,
  directoryOrganizationByWorkosId,
  exactInstant,
  hex256,
  sessionId,
  workosOrganizationId,
  workosUserId,
} from "./shared.js";

const SESSION_REVOCATION_RETENTION_MILLISECONDS = 35 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- membership barrier

export const recordMembershipBarrierInput = z.strictObject({
  workosOrganizationId,
  workosUserId: boundedId,
  sourceEventId: boundedId,
  eventCreatedAt: exactInstant,
});

export type BarrierOutcome = "opened" | "existing" | "ignored_older";

interface BarrierRow {
  readonly source_event_id: string;
  readonly event_created_at: string;
  readonly reconciled_at: string | null;
}

/** The ordering rule of `openWorkosMembershipSyncBarrier`: only a strictly newer event (re)opens a barrier. */
function barrierDecision(
  existing: BarrierRow | null,
  input: z.output<typeof recordMembershipBarrierInput>,
): "insert" | "advance" | "existing" | "older" | Error {
  if (existing === null) return "insert";
  if (input.eventCreatedAt < existing.event_created_at) return "older";
  if (input.eventCreatedAt === existing.event_created_at) {
    return existing.source_event_id === input.sourceEventId
      ? "existing"
      : conflict(
          "membership_barrier_ambiguous",
          "WorkOS membership barrier event ordering is ambiguous",
        );
  }
  return "advance";
}

export function shardBarrierCommand(
  db: D1Database,
  organizationId: string,
  input: z.output<typeof recordMembershipBarrierInput>,
): Command<
  { organization: boolean; barrier: BarrierRow | null; accesses: readonly OpenDatabaseAccessRow[] },
  BarrierOutcome | "no_organization"
> {
  return {
    name: "identity.recordMembershipBarrier",
    input: { organizationId, ...input },
    retryOn: ["row_version_conflict"],
    naturalKeyTables: ["workos_membership_sync_barriers"],
    read: async (shard) => {
      const [org, barrier, accesses] = await shard.batch([
        shard
          .prepare("SELECT 1 AS present FROM organizations WHERE organization_id = ?")
          .bind(organizationId),
        shard
          .prepare(
            "SELECT source_event_id, event_created_at, reconciled_at FROM workos_membership_sync_barriers WHERE organization_id = ?1 AND workos_user_id = ?2",
          )
          .bind(organizationId, input.workosUserId),
        shard
          .prepare(`${OPEN_DATABASE_ACCESS_SELECT} AND organization_id = ?1 AND principal_id = ?2`)
          .bind(organizationId, `user:${input.workosUserId}`),
      ]);
      return {
        organization: (org?.results.length ?? 0) > 0,
        barrier: ((barrier?.results ?? [])[0] as BarrierRow | undefined) ?? null,
        accesses: rowsOf<OpenDatabaseAccessRow>(accesses),
      };
    },
    decide: (snapshot): Plan<BarrierOutcome | "no_organization"> => {
      if (!snapshot.organization) return { replay: "no_organization" };
      const decision = barrierDecision(snapshot.barrier, input);
      if (decision instanceof Error) return { reject: decision };
      if (decision === "existing") return { replay: "existing" };
      if (decision === "older") return { replay: "ignored_older" };
      const statements: D1PreparedStatement[] =
        decision === "insert"
          ? [
              db
                .prepare(
                  "INSERT INTO workos_membership_sync_barriers(organization_id, workos_user_id, source_event_id, event_created_at, reconciled_at) VALUES (?1, ?2, ?3, ?4, NULL)",
                )
                .bind(
                  organizationId,
                  input.workosUserId,
                  input.sourceEventId,
                  input.eventCreatedAt,
                ),
            ]
          : [
              db
                .prepare(
                  "UPDATE workos_membership_sync_barriers SET source_event_id = ?3, event_created_at = ?4, reconciled_at = NULL WHERE organization_id = ?1 AND workos_user_id = ?2 AND source_event_id = ?5 AND event_created_at = ?6",
                )
                .bind(
                  organizationId,
                  input.workosUserId,
                  input.sourceEventId,
                  input.eventCreatedAt,
                  (snapshot.barrier as BarrierRow).source_event_id,
                  (snapshot.barrier as BarrierRow).event_created_at,
                ),
              guard(db, "row_version_conflict", "changes() = 0"),
            ];
      // A barrier means the member may already be gone: its open database access ends with the barrier.
      statements.push(
        ...revokeOpenDatabaseAccessStatements(
          db,
          snapshot.accesses,
          input.eventCreatedAt,
          "membership-barrier",
        ),
      );
      return { statements, result: () => "opened" };
    },
  };
}

export function pendingBarrierCommand(
  db: D1Database,
  input: z.output<typeof recordMembershipBarrierInput>,
): Command<BarrierRow | null, BarrierOutcome> {
  return {
    name: "identity.recordPendingMembershipBarrier",
    input,
    retryOn: ["row_version_conflict"],
    naturalKeyTables: ["pending_membership_barriers"],
    read: (directory) =>
      directory
        .prepare(
          "SELECT source_event_id, event_created_at, NULL AS reconciled_at FROM pending_membership_barriers WHERE workos_organization_id = ?1 AND workos_user_id = ?2",
        )
        .bind(input.workosOrganizationId, input.workosUserId)
        .first<BarrierRow>(),
    decide: (existing): Plan<BarrierOutcome> => {
      const decision = barrierDecision(existing, input);
      if (decision instanceof Error) return { reject: decision };
      if (decision === "existing") return { replay: "existing" };
      if (decision === "older") return { replay: "ignored_older" };
      return {
        statements:
          decision === "insert"
            ? [
                db
                  .prepare(
                    "INSERT INTO pending_membership_barriers(workos_organization_id, workos_user_id, source_event_id, event_created_at) VALUES (?1, ?2, ?3, ?4)",
                  )
                  .bind(
                    input.workosOrganizationId,
                    input.workosUserId,
                    input.sourceEventId,
                    input.eventCreatedAt,
                  ),
              ]
            : [
                db
                  .prepare(
                    "UPDATE pending_membership_barriers SET source_event_id = ?3, event_created_at = ?4 WHERE workos_organization_id = ?1 AND workos_user_id = ?2 AND source_event_id = ?5 AND event_created_at = ?6",
                  )
                  .bind(
                    input.workosOrganizationId,
                    input.workosUserId,
                    input.sourceEventId,
                    input.eventCreatedAt,
                    (existing as BarrierRow).source_event_id,
                    (existing as BarrierRow).event_created_at,
                  ),
                guard(db, "row_version_conflict", "changes() = 0"),
              ],
        result: () => "opened",
      };
    },
  };
}

/**
 * `openWorkosMembershipSyncBarrier`: opens the fail-closed barrier a membership webhook puts between itself and
 * the snapshot that reconciles it. A WorkOS organization that has no shard row yet keeps the barrier in the
 * directory (`pending_membership_barriers`); the organization's first snapshot moves it into the shard.
 */
export async function recordMembershipBarrier(
  context: CatalogContext,
  rawInput: unknown,
): Promise<BarrierOutcome> {
  const input = recordMembershipBarrierInput.parse(rawInput);
  const mapped = await directoryOrganizationByWorkosId(
    context.directory,
    input.workosOrganizationId,
  );
  if (mapped !== null) {
    const shard = await routeOrganization(context, mapped.organization_id);
    const outcome = await runCommand(
      shard.db,
      shardBarrierCommand(shard.db, mapped.organization_id, input),
    );
    if (outcome !== "no_organization") return outcome;
  }
  const outcome = await runCommand(
    context.directory,
    pendingBarrierCommand(context.directory, input),
  );
  // The first snapshot may have committed between the shard read and the directory write above; the
  // organization's shard row is then the truth and the pending row is adopted now, not at some later snapshot.
  const after = await directoryOrganizationByWorkosId(
    context.directory,
    input.workosOrganizationId,
  );
  if (after !== null) {
    await promotePendingBarriers(context, {
      organizationId: after.organization_id,
      workosOrganizationId: input.workosOrganizationId,
    });
  }
  return outcome;
}

// ---------------------------------------------------------------- terminal revocations

export const recordTerminalRevocationInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("session"),
    sessionId,
    workosUserId: boundedId,
    workosOrganizationId: boundedId.optional(),
    sourceEventId: boundedId,
    effectiveAt: exactInstant,
  }),
  z.strictObject({
    kind: z.literal("user"),
    workosUserId: boundedId,
    workosOrganizationId: boundedId.optional(),
    sourceEventId: boundedId,
    effectiveAt: exactInstant,
  }),
  z.strictObject({
    kind: z.literal("organization"),
    workosOrganizationId: boundedId,
    sourceEventId: boundedId,
    effectiveAt: exactInstant,
  }),
]);

interface RevocationRow {
  readonly kind: string;
  readonly resource_id: string;
  readonly workos_user_id: string | null;
  readonly workos_organization_id: string | null;
  readonly source_event_id: string;
  readonly effective_at: string;
}

function normalizedRevocation(input: z.output<typeof recordTerminalRevocationInput>) {
  if (input.kind === "session") {
    return {
      resourceId: input.sessionId,
      user: input.workosUserId,
      organization: input.workosOrganizationId ?? null,
    };
  }
  if (input.kind === "user") {
    return {
      resourceId: input.workosUserId,
      user: input.workosUserId,
      organization: input.workosOrganizationId ?? null,
    };
  }
  return {
    resourceId: input.workosOrganizationId,
    user: null,
    organization: input.workosOrganizationId,
  };
}

/**
 * `recordWorkosTerminalRevocation`: an irreversible session, user or organization revocation in the global
 * directory. A repeat of the same event is `existing`; the same resource or the same event id with other
 * content is a conflict. Sessions are purged 35 days after they took effect, users and organizations never.
 */
export async function recordTerminalRevocation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<"created" | "existing"> {
  return runCommand(
    context.directory,
    terminalRevocationCommand(context.directory, recordTerminalRevocationInput.parse(rawInput)),
  );
}

interface TerminalRevocationState {
  readonly revocations: RevocationRow[];
  readonly accesses: readonly OpenDatabaseAccessRow[];
}

/** Typed internal builder for the ingress transaction; no SQL or callback crosses the service binding. */
export function terminalRevocationCommand(
  db: D1Database,
  input: z.output<typeof recordTerminalRevocationInput>,
): Command<TerminalRevocationState, "created" | "existing"> {
  const normalized = normalizedRevocation(input);
  const command: Command<TerminalRevocationState, "created" | "existing"> = {
    name: "identity.recordTerminalRevocation",
    input,
    naturalKeyTables: ["revocations"],
    read: async (directory) => {
      // Only a user revocation reaches database access: the user's accesses, in the one organization it names or all.
      const principal = input.kind === "user" ? `user:${input.workosUserId}` : null;
      const scope = input.kind === "user" ? (input.workosOrganizationId ?? null) : null;
      const [revocations, accesses] = await directory.batch([
        directory
          .prepare(
            "SELECT kind, resource_id, workos_user_id, workos_organization_id, source_event_id, effective_at FROM revocations WHERE (kind = ?1 AND resource_id = ?2) OR source_event_id = ?3",
          )
          .bind(input.kind, normalized.resourceId, input.sourceEventId),
        // A user revocation ends the user's open database access in every organization it reaches.
        directory
          .prepare(
            `${OPEN_DATABASE_ACCESS_SELECT} AND ?1 IS NOT NULL AND principal_id = ?1
               AND (?2 IS NULL OR organization_id = (SELECT organization_id FROM org_directory WHERE workos_organization_id = ?2))`,
          )
          .bind(principal, scope),
      ]);
      return {
        revocations: rowsOf<RevocationRow>(revocations),
        accesses: rowsOf<OpenDatabaseAccessRow>(accesses),
      };
    },
    decide: ({ revocations: rows, accesses }): Plan<"created" | "existing"> => {
      if (rows.length === 0) {
        return {
          statements: [
            db
              .prepare(
                "INSERT INTO revocations(kind, resource_id, workos_user_id, workos_organization_id, source_event_id, effective_at, purge_after) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
              )
              .bind(
                input.kind,
                normalized.resourceId,
                normalized.user,
                normalized.organization,
                input.sourceEventId,
                input.effectiveAt,
                input.kind === "session"
                  ? addMilliseconds(input.effectiveAt, SESSION_REVOCATION_RETENTION_MILLISECONDS)
                  : null,
              ),
            ...revokeOpenDatabaseAccessStatements(
              db,
              accesses,
              input.effectiveAt,
              "user-revocation",
            ),
          ],
          result: () => "created",
        };
      }
      const row = rows[0] as RevocationRow;
      if (
        rows.length !== 1 ||
        row.kind !== input.kind ||
        row.resource_id !== normalized.resourceId
      ) {
        return {
          reject: conflict(
            "revocation_identity_conflict",
            "WorkOS terminal revocation identity conflicts with another resource",
          ),
        };
      }
      if (
        row.source_event_id === input.sourceEventId &&
        (row.workos_user_id !== normalized.user ||
          row.workos_organization_id !== normalized.organization ||
          row.effective_at !== input.effectiveAt)
      ) {
        return {
          reject: conflict(
            "revocation_replay_conflict",
            "WorkOS terminal revocation replay conflicts with stored state",
          ),
        };
      }
      return { replay: "existing" };
    },
  };
  return command;
}

// ---------------------------------------------------------------- session eligibility

export const isSessionEligibleInput = z.strictObject({
  sessionId: boundedId,
  workosUserId: boundedId,
  workosOrganizationId: boundedId.nullable(),
  observedAt: exactInstant,
});

/**
 * `isWorkosSessionEligible`: fresh local eligibility. Irreversible revocations and pending barriers are read
 * from the directory first, then the organization's shard answers membership, organization state and barrier.
 * Any database failure stays an error (never "not eligible by accident" and never eligible).
 */
export async function isSessionEligible(
  context: CatalogContext,
  rawInput: unknown,
): Promise<boolean> {
  const input = isSessionEligibleInput.parse(rawInput);
  if (await isRevoked(context.directory, input)) return false;
  if (input.workosOrganizationId === null) return true;
  const mapped = await directoryOrganizationByWorkosId(
    context.directory,
    input.workosOrganizationId,
  );
  if (mapped === null || mapped.state !== "active") return false;
  const pending = await context.directory
    .prepare(
      "SELECT 1 AS pending FROM pending_membership_barriers WHERE workos_organization_id = ?1 AND workos_user_id = ?2",
    )
    .bind(input.workosOrganizationId, input.workosUserId)
    .first();
  if (pending !== null) {
    // A pending row of an organization that has a shard row is adopted (idempotent) and the shard answers;
    // a row that cannot be adopted yet keeps the user fail-closed.
    await promotePendingBarriers(context, {
      organizationId: mapped.organization_id,
      workosOrganizationId: input.workosOrganizationId,
    });
    const stillPending = await context.directory
      .prepare(
        "SELECT 1 AS pending FROM pending_membership_barriers WHERE workos_organization_id = ?1 AND workos_user_id = ?2",
      )
      .bind(input.workosOrganizationId, input.workosUserId)
      .first();
    if (stillPending !== null) return false;
  }
  const shard = await routeOrganization(context, mapped.organization_id);
  const answer = await shard.db
    .prepare(
      `SELECT (EXISTS (SELECT 1 FROM organization_memberships m JOIN organizations o ON o.organization_id = m.organization_id
                       WHERE m.organization_id = ?1 AND m.workos_user_id = ?2 AND m.state = 'active' AND o.state = 'active')
               AND NOT EXISTS (SELECT 1 FROM workos_membership_sync_barriers b
                       WHERE b.organization_id = ?1 AND b.workos_user_id = ?2 AND b.reconciled_at IS NULL)) AS eligible`,
    )
    .bind(mapped.organization_id, input.workosUserId)
    .first<{ eligible: number }>();
  if (answer?.eligible !== 1) return false;
  // The original evaluated revocation, mapping, membership and barrier in ONE statement. Here the shard is read
  // after the directory, so a revocation recorded in between could combine "not revoked" with a membership that
  // became active afterwards, a composite the original never produced. Terminal revocations are monotonic: the
  // final primary directory re-check before any positive answer closes that window without a new protocol. A
  // revocation that commits after this check is the same ordinary race the original had after its final check.
  return !(await isRevoked(context.directory, input));
}

/** The terminal revocation of the session, its user or its organization, effective at or before `observedAt`. */
async function isRevoked(
  directory: D1Database,
  input: z.output<typeof isSessionEligibleInput>,
): Promise<boolean> {
  const revoked = await directory
    .prepare(
      `SELECT 1 AS revoked FROM revocations
       WHERE effective_at <= ?4
         AND ((kind = 'session' AND resource_id = ?1 AND workos_user_id = ?2
               AND (?3 IS NULL OR workos_organization_id IS NULL OR workos_organization_id = ?3))
           OR (kind = 'user' AND resource_id = ?2 AND (?3 IS NULL OR workos_organization_id IS NULL OR workos_organization_id = ?3))
           OR (kind = 'organization' AND resource_id = ?3))
       LIMIT 1`,
    )
    .bind(input.sessionId, input.workosUserId, input.workosOrganizationId, input.observedAt)
    .first();
  return revoked !== null;
}

// ---------------------------------------------------------------- pending barrier adoption

interface PendingEntry {
  readonly workos_user_id: string;
  readonly source_event_id: string;
  readonly event_created_at: string;
}

/** The pending barriers of a WorkOS organization, newest state per user. */
async function readPendingBarriers(
  directory: D1Database,
  workosOrganization: string,
): Promise<PendingEntry[]> {
  return (
    await directory
      .prepare(
        "SELECT workos_user_id, source_event_id, event_created_at FROM pending_membership_barriers WHERE workos_organization_id = ?",
      )
      .bind(workosOrganization)
      .all<PendingEntry>()
  ).results;
}

/**
 * The statements that open or advance, in the shard, the barriers a directory pending list stands for:
 * one INSERT and one UPDATE per chunk, never a statement per user. Only a strictly newer event advances a
 * barrier (the rule of `openWorkosMembershipSyncBarrier`); an equal or older one changes nothing: a snapshot
 * that closes the existing barrier closes an equal-instant event too.
 */
export function adoptPendingBarrierStatements(
  db: D1Database,
  organizationId: string,
  pending: readonly PendingEntry[],
  existing: ReadonlyMap<string, { readonly event_created_at: string }>,
): D1PreparedStatement[] {
  const inserts = pending.filter((entry) => !existing.has(entry.workos_user_id));
  const advances = pending.filter(
    (entry) =>
      existing.has(entry.workos_user_id) &&
      entry.event_created_at > (existing.get(entry.workos_user_id)?.event_created_at ?? ""),
  );
  const rows = (entries: readonly PendingEntry[]) =>
    JSON.stringify(
      entries.map((entry) => [entry.workos_user_id, entry.source_event_id, entry.event_created_at]),
    );
  return [
    ...chunked(inserts).map((chunk) =>
      db
        .prepare(
          `INSERT INTO workos_membership_sync_barriers(organization_id, workos_user_id, source_event_id, event_created_at, reconciled_at)
           SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), NULL FROM json_each(?2)`,
        )
        .bind(organizationId, rows(chunk)),
    ),
    ...chunked(advances).map((chunk) =>
      db
        .prepare(
          `UPDATE workos_membership_sync_barriers SET source_event_id = e.source_event_id, event_created_at = e.event_created_at, reconciled_at = NULL
           FROM (SELECT json_extract(value, '$[0]') AS workos_user_id, json_extract(value, '$[1]') AS source_event_id, json_extract(value, '$[2]') AS event_created_at FROM json_each(?2)) e
           WHERE organization_id = ?1 AND workos_membership_sync_barriers.workos_user_id = e.workos_user_id
             AND workos_membership_sync_barriers.event_created_at < e.event_created_at`,
        )
        .bind(organizationId, rows(chunk)),
    ),
  ];
}

/** Deletes exactly the pending rows adopted (a row advanced meanwhile stays and is adopted by the next pass). */
function deletePendingStatements(
  directory: D1Database,
  workosOrganization: string,
  pending: readonly PendingEntry[],
): D1PreparedStatement[] {
  return chunked(pending).map((chunk) =>
    directory
      .prepare(
        `DELETE FROM pending_membership_barriers WHERE workos_organization_id = ?1
           AND (workos_user_id, source_event_id, event_created_at) IN
               (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?2))`,
      )
      .bind(
        workosOrganization,
        JSON.stringify(
          chunk.map((entry) => [
            entry.workos_user_id,
            entry.source_event_id,
            entry.event_created_at,
          ]),
        ),
      ),
  );
}

interface AdoptState {
  readonly organization: boolean;
  readonly barriers: ReadonlyMap<string, { readonly event_created_at: string }>;
  readonly fingerprint: string;
}

/**
 * Resumable adoption of the directory's pending barriers into the shard, once the organization has a shard
 * row. One fingerprint guarded shard batch opens or advances the barriers; only then the adopted pending
 * rows are deleted from the directory. A crash or lost response between the two leaves rows that the next
 * pass adopts again as no-ops and deletes: nothing is ever dropped before it lives in the shard, and a
 * pending row is not deleted unless it matches exactly what was adopted. Returns the entries handled.
 */
export async function promotePendingBarriers(
  context: CatalogContext,
  rawInput: { readonly organizationId: string; readonly workosOrganizationId: string },
): Promise<number> {
  const pending = await readPendingBarriers(context.directory, rawInput.workosOrganizationId);
  if (pending.length === 0) return 0;
  const shard = await routeOrganization(context, rawInput.organizationId);
  const db = shard.db;
  const command: Command<AdoptState, boolean> = {
    name: "identity.promotePendingBarriers",
    input: { ...rawInput, pending },
    retryOn: ["precondition_changed", "row_version_conflict"],
    read: async (reader) => {
      const [organization, barriers, fingerprint] = await reader.batch([
        reader
          .prepare("SELECT 1 AS present FROM organizations WHERE organization_id = ?")
          .bind(rawInput.organizationId),
        reader
          .prepare(
            "SELECT workos_user_id, event_created_at FROM workos_membership_sync_barriers WHERE organization_id = ?",
          )
          .bind(rawInput.organizationId),
        reader
          .prepare(`SELECT ${IDENTITY_FINGERPRINT_EXPR} AS fingerprint`)
          .bind(rawInput.organizationId),
      ]);
      return {
        organization: (organization?.results.length ?? 0) > 0,
        barriers: new Map(
          rowsOf<{ workos_user_id: string; event_created_at: string }>(barriers).map((row) => [
            row.workos_user_id,
            row,
          ]),
        ),
        fingerprint: ((fingerprint?.results ?? [])[0] as { fingerprint: string }).fingerprint,
      };
    },
    decide: (state): Plan<boolean> => {
      if (!state.organization) return { replay: false };
      const statements = adoptPendingBarrierStatements(
        db,
        rawInput.organizationId,
        pending,
        state.barriers,
      );
      if (statements.length === 0) return { replay: true };
      return {
        statements: [
          guard(db, "precondition_changed", `(${IDENTITY_FINGERPRINT_EXPR}) IS NOT ?2`, [
            rawInput.organizationId,
            state.fingerprint,
          ]),
          ...statements,
        ],
        result: () => true,
      };
    },
  };
  if (!(await runCommand(db, command))) return 0;
  await context.directory.batch(
    deletePendingStatements(context.directory, rawInput.workosOrganizationId, pending),
  );
  return pending.length;
}

// ---------------------------------------------------------------- organization snapshot

const snapshotMembership = z.strictObject({
  workosUserId,
  role: z.string().trim().min(1).max(64),
  status: z.enum(["active", "suspended"]),
  digest: hex256,
});

const inboxClaim = z.strictObject({
  inboxEventId: ulid,
  claimId: ulid,
  acknowledgedAt: instant,
  clock: z.literal("execution").optional(),
});

/** No membership cap: the PostgreSQL transaction had none, and a partial snapshot would never be visible. */
export const applyWorkosSnapshotInput = z.strictObject({
  organizationId: ulid,
  workosOrganizationId,
  state: z.enum(["active", "suspended"]).default("active"),
  snapshotDigest: hex256,
  snapshotFetchedAt: instant,
  synchronizedAt: instant,
  triggerEventId: boundedId,
  memberships: z.array(snapshotMembership),
  auditEventId: ulid,
  claim: inboxClaim.optional(),
});

export interface ApplyWorkosSnapshotResult {
  readonly organizationId: string;
  readonly organizationChanged: boolean;
  readonly changedMemberships: number;
  readonly ignoredAfterDeletion: boolean;
}

interface OrganizationRow {
  readonly workos_organization_id: string;
  readonly state: "active" | "suspended" | "deleted";
  readonly mapping_revision: number;
  readonly snapshot_digest: string;
  readonly snapshot_fetched_at: string;
}

interface MembershipRow {
  readonly workos_user_id: string;
  readonly role: string;
  readonly state: "active" | "suspended" | "revoked";
  readonly mapping_revision: number;
  readonly digest: string;
  readonly effective_at: string;
}

interface GrantRow {
  readonly principal_id: string;
  readonly role: string;
}

interface SnapshotState {
  /** The Directory rows of the organization id or its WorkOS id: read in the same snapshot as the tenant rows. */
  readonly directory: readonly {
    readonly organization_id: string;
    readonly workos_organization_id: string;
  }[];
  readonly organization: OrganizationRow | null;
  readonly memberships: readonly MembershipRow[];
  readonly grants: readonly GrantRow[];
  readonly barriers: readonly (BarrierRow & { readonly workos_user_id: string })[];
  readonly accesses: readonly OpenDatabaseAccessRow[];
  readonly fingerprint: string;
}

const claimGuard = (
  db: D1Database,
  organizationId: string,
  claim: z.output<typeof inboxClaim>,
  globalSubject?: string,
) => {
  const now =
    claim.clock === "execution"
      ? "max(?4, (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'))"
      : "?4";
  return [
    guard(
      db,
      "claim_lost",
      `NOT EXISTS (SELECT 1 FROM webhook_inbox WHERE ${globalSubject === undefined ? "organization_id = ?1" : "json_extract(payload,'$.workosOrganizationId') = ?1"} AND provider = 'workos' AND inbox_event_id = ?2
       AND claim_id = ?3 AND state = 'processing' AND claimed_at <= ${now} AND lease_expires_at > ${now} AND acknowledged_at IS NULL)`,
      [globalSubject ?? organizationId, claim.inboxEventId, claim.claimId, claim.acknowledgedAt],
    ),
    db
      .prepare(acknowledgeInboxSql(claim.clock === "execution", globalSubject !== undefined))
      .bind(organizationId, "workos", claim.inboxEventId, claim.claimId, claim.acknowledgedAt),
    guard(db, "claim_lost", "changes() <> 1"),
  ];
};

type Incoming = z.output<typeof snapshotMembership>;

/** One INSERT per chunk of new memberships; the whole list of a snapshot travels as set-based JSON. */
function insertMembershipStatements(
  db: D1Database,
  organizationId: string,
  fetchedAt: string,
  triggerEventId: string,
  members: readonly Incoming[],
): D1PreparedStatement[] {
  return chunked(members).map((chunk) =>
    db
      .prepare(
        `INSERT INTO organization_memberships(organization_id, workos_user_id, role, state, mapping_revision, snapshot_sha256, effective_at, revoked_at, trigger_event_id)
         SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), 1, unhex(json_extract(value, '$[3]')), ?2, NULL, ?3
         FROM json_each(?4)`,
      )
      .bind(
        organizationId,
        fetchedAt,
        triggerEventId,
        JSON.stringify(chunk.map((m) => [m.workosUserId, m.role, m.status, m.digest])),
      ),
  );
}

/** One UPDATE (plus its row-count guard) per chunk of changed memberships, each pinned to the revision read. */
function updateMembershipStatements(
  db: D1Database,
  organizationId: string,
  fetchedAt: string,
  triggerEventId: string,
  members: readonly { readonly member: Incoming; readonly revision: number }[],
): D1PreparedStatement[] {
  return chunked(members).flatMap((chunk) => [
    db
      .prepare(
        `UPDATE organization_memberships SET role = e.role, state = e.state, mapping_revision = organization_memberships.mapping_revision + 1,
           snapshot_sha256 = unhex(e.digest), effective_at = ?2, revoked_at = NULL, trigger_event_id = ?3
         FROM (SELECT json_extract(value, '$[0]') AS user_id, json_extract(value, '$[1]') AS role, json_extract(value, '$[2]') AS state,
                      json_extract(value, '$[3]') AS digest, json_extract(value, '$[4]') AS revision FROM json_each(?4)) e
         WHERE organization_memberships.organization_id = ?1 AND organization_memberships.workos_user_id = e.user_id
           AND organization_memberships.mapping_revision = e.revision`,
      )
      .bind(
        organizationId,
        fetchedAt,
        triggerEventId,
        JSON.stringify(
          chunk.map(({ member, revision }) => [
            member.workosUserId,
            member.role,
            member.status,
            member.digest,
            revision,
          ]),
        ),
      ),
    guard(db, "row_version_conflict", "changes() <> ?1", [chunk.length]),
  ]);
}

function snapshotCommand(
  db: D1Database,
  bucket: number,
  input: z.output<typeof applyWorkosSnapshotInput>,
  pending: readonly PendingEntry[],
  grantIds: ReadonlyMap<string, string>,
  globalInbox = false,
): Command<SnapshotState, ApplyWorkosSnapshotResult> {
  const organizationId = input.organizationId;
  return {
    name: "identity.applyWorkosSnapshot",
    input,
    commandId: `workos-snapshot:${input.auditEventId}`,
    now: Date.parse(input.synchronizedAt),
    retryOn: ["precondition_changed", "row_version_conflict"],
    naturalKeyTables: ["organizations", "organization_memberships", "org_directory"],
    fromLog: (logged) => logged as ApplyWorkosSnapshotResult,
    read: async (shard) => {
      const [directory, organization, memberships, grants, barriers, accesses, fingerprint] =
        await shard.batch([
          shard
            .prepare(
              "SELECT organization_id, workos_organization_id FROM org_directory WHERE organization_id = ?1 OR workos_organization_id = ?2",
            )
            .bind(organizationId, input.workosOrganizationId),
          shard
            .prepare(
              "SELECT workos_organization_id, state, mapping_revision, lower(hex(snapshot_sha256)) AS snapshot_digest, snapshot_fetched_at FROM organizations WHERE organization_id = ?",
            )
            .bind(organizationId),
          shard
            .prepare(
              "SELECT workos_user_id, role, state, mapping_revision, lower(hex(snapshot_sha256)) AS digest, effective_at FROM organization_memberships WHERE organization_id = ?",
            )
            .bind(organizationId),
          shard
            .prepare(
              "SELECT principal_id, role FROM local_authorization_grants WHERE organization_id = ? AND project_id IS NULL AND environment_id IS NULL AND principal_kind = 'user' AND revoked_at IS NULL",
            )
            .bind(organizationId),
          shard
            .prepare(
              "SELECT workos_user_id, source_event_id, event_created_at, reconciled_at FROM workos_membership_sync_barriers WHERE organization_id = ?",
            )
            .bind(organizationId),
          shard
            .prepare(`${OPEN_DATABASE_ACCESS_SELECT} AND organization_id = ?1`)
            .bind(organizationId),
          shard.prepare(`SELECT ${IDENTITY_FINGERPRINT_EXPR} AS fingerprint`).bind(organizationId),
        ]);
      return {
        directory: rowsOf<SnapshotState["directory"][number]>(directory),
        organization: ((organization?.results ?? [])[0] as OrganizationRow | undefined) ?? null,
        memberships: rowsOf<MembershipRow>(memberships),
        grants: rowsOf<GrantRow>(grants),
        barriers: rowsOf<SnapshotState["barriers"][number]>(barriers),
        accesses: rowsOf<OpenDatabaseAccessRow>(accesses),
        fingerprint: ((fingerprint?.results ?? [])[0] as { fingerprint: string }).fingerprint,
      };
    },
    decide: (state): Plan<ApplyWorkosSnapshotResult> => {
      const base = {
        organizationId,
        organizationChanged: false,
        changedMemberships: 0,
        ignoredAfterDeletion: false,
      };
      const current = state.organization;
      // A WorkOS organization maps to exactly one internal one, in the Directory and in the organization row alike.
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
      const statements: D1PreparedStatement[] = [
        guard(db, "precondition_changed", "(" + IDENTITY_FINGERPRINT_EXPR + ") IS NOT ?2", [
          organizationId,
          state.fingerprint,
        ]),
        // The Directory claim commits with the organization, never before it: a failure of any later statement leaves
        // no claim behind. A concurrent claimant of either identity fails the guard or the UNIQUE key and is re-read.
        db
          .prepare(
            "INSERT INTO org_directory(organization_id, workos_organization_id, bucket, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4) ON CONFLICT (organization_id) DO NOTHING",
          )
          .bind(organizationId, input.workosOrganizationId, bucket, input.synchronizedAt),
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS (SELECT 1 FROM org_directory WHERE organization_id = ?1 AND workos_organization_id = ?2)",
          [organizationId, input.workosOrganizationId],
        ),
      ];
      const audit = (eventType: string, payload: Record<string, unknown>) =>
        auditStatement(db, organizationId, {
          auditEventId: input.auditEventId,
          projectId: null,
          operationId: null,
          billingEpochId: null,
          eventType,
          actorType: "system",
          actorId: eventType.endsWith("AfterDeletion") ? "redacted" : "workos-management",
          payload,
          occurredAt: input.synchronizedAt,
        });
      if (current !== null && current.workos_organization_id !== input.workosOrganizationId) {
        return {
          reject: conflict(
            "workos_organization_mapped",
            "Organization is already mapped to another WorkOS organization",
          ),
        };
      }
      if (current?.state === "deleted") {
        statements.push(
          audit("WorkosOrganizationSnapshotIgnoredAfterDeletion", {
            outcome: "ignored_after_deletion",
          }),
        );
        if (input.claim !== undefined)
          statements.push(
            ...claimGuard(
              db,
              organizationId,
              input.claim,
              globalInbox ? input.workosOrganizationId : undefined,
            ),
          );
        return {
          statements,
          result: () => ({ ...base, ignoredAfterDeletion: true }),
        };
      }
      let mayRevokeAbsent = true;
      let organizationChanged = true;
      if (current === null) {
        statements.push(
          db
            .prepare(
              "INSERT INTO organizations(organization_id, workos_organization_id, state, mapping_revision, snapshot_sha256, snapshot_fetched_at, synchronized_at, created_at, updated_at, bucket) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?6, ?6, ?7)",
            )
            .bind(
              organizationId,
              input.workosOrganizationId,
              input.state,
              hexBytes(input.snapshotDigest),
              input.snapshotFetchedAt,
              input.synchronizedAt,
              bucket,
            ),
          // every organization has its credit account from the batch that creates it
          ...ensureAccount(db, { organizationId, now: input.synchronizedAt }).statements,
        );
      } else if (current.snapshot_digest === input.snapshotDigest) {
        if (current.state !== input.state) {
          return {
            reject: conflict(
              "snapshot_digest_collision",
              "WorkOS organization snapshot digest collides with different state",
            ),
          };
        }
        organizationChanged = false;
        mayRevokeAbsent = input.snapshotFetchedAt > current.snapshot_fetched_at;
        statements.push(
          db
            .prepare(
              "UPDATE organizations SET snapshot_fetched_at = max(snapshot_fetched_at, ?2), synchronized_at = max(synchronized_at, ?3) WHERE organization_id = ?1",
            )
            .bind(organizationId, input.snapshotFetchedAt, input.synchronizedAt),
        );
      } else {
        if (input.snapshotFetchedAt <= current.snapshot_fetched_at) {
          return {
            reject: conflict(
              "snapshot_timestamp_collision",
              "WorkOS organization snapshot timestamp collides with different state",
            ),
          };
        }
        statements.push(
          db
            .prepare(
              "UPDATE organizations SET state = ?3, mapping_revision = mapping_revision + 1, snapshot_sha256 = ?4, snapshot_fetched_at = ?5, synchronized_at = ?6, updated_at = ?6 WHERE organization_id = ?1 AND mapping_revision = ?2",
            )
            .bind(
              organizationId,
              current.mapping_revision,
              input.state,
              hexBytes(input.snapshotDigest),
              input.snapshotFetchedAt,
              input.synchronizedAt,
            ),
          guard(db, "row_version_conflict", "changes() = 0"),
        );
      }

      // memberships: the decision is made here on the rows read, the writes are set-based JSON statements
      const previous = new Map(state.memberships.map((row) => [row.workos_user_id, row]));
      const incoming = new Map(input.memberships.map((member) => [member.workosUserId, member]));
      if (incoming.size !== input.memberships.length) {
        return {
          reject: conflict("duplicate_membership", "A snapshot lists one user twice"),
        };
      }
      const fetchedAt = input.snapshotFetchedAt;
      const inserted: Incoming[] = [];
      const updated: { member: Incoming; revision: number }[] = [];
      for (const member of input.memberships) {
        const prior = previous.get(member.workosUserId);
        if (prior !== undefined && prior.digest === member.digest) {
          if (prior.role !== member.role || prior.state !== member.status) {
            return {
              reject: conflict(
                "membership_digest_collision",
                "WorkOS membership snapshot digest collides with different state",
              ),
            };
          }
          continue;
        }
        if (prior !== undefined && fetchedAt <= prior.effective_at) {
          return {
            reject: conflict(
              "membership_timestamp_collision",
              "WorkOS membership snapshot timestamp collides with different state",
            ),
          };
        }
        if (prior === undefined) inserted.push(member);
        else updated.push({ member, revision: prior.mapping_revision });
      }
      statements.push(
        ...insertMembershipStatements(
          db,
          organizationId,
          fetchedAt,
          input.triggerEventId,
          inserted,
        ),
        ...updateMembershipStatements(db, organizationId, fetchedAt, input.triggerEventId, updated),
      );
      const absent = state.memberships.filter(
        (row) =>
          row.state !== "revoked" &&
          !incoming.has(row.workos_user_id) &&
          row.effective_at < fetchedAt,
      );
      if (mayRevokeAbsent) {
        for (const chunk of chunked(absent)) {
          statements.push(
            db
              .prepare(
                "UPDATE organization_memberships SET state = 'revoked', revoked_at = ?3, effective_at = ?3, mapping_revision = mapping_revision + 1, snapshot_sha256 = unhex(?4), trigger_event_id = ?5 WHERE organization_id = ?1 AND state <> 'revoked' AND effective_at < ?3 AND workos_user_id IN (SELECT value FROM json_each(?2))",
              )
              .bind(
                organizationId,
                JSON.stringify(chunk.map((row) => row.workos_user_id)),
                fetchedAt,
                input.snapshotDigest,
                input.triggerEventId,
              ),
          );
        }
      }
      // Database access ends with the membership. A member removed (when this snapshot may revoke), suspended, or no
      // longer an owner (issuing needs projects:write, which only owners hold) loses its open accesses here; an inactive
      // organization ends all of them. The access sweep then drops the login roles.
      const endedPrincipals = new Set([
        ...(mayRevokeAbsent ? absent.map((row) => `user:${row.workos_user_id}`) : []),
        ...[...inserted, ...updated.map((entry) => entry.member)]
          .filter((member) => projectRole(member.status, member.role) !== "owner")
          .map((member) => `user:${member.workosUserId}`),
      ]);
      const organizationInactive = input.state !== "active";
      statements.push(
        ...revokeOpenDatabaseAccessStatements(
          db,
          organizationInactive
            ? state.accesses
            : state.accesses.filter((access) => endedPrincipals.has(access.principal_id)),
          fetchedAt,
          organizationInactive ? "organization" : "membership",
        ),
      );
      const changedMemberships =
        inserted.length + updated.length + (mayRevokeAbsent ? absent.length : 0);

      // barriers: the directory's pending ones become real, then every barrier an equally new snapshot covers closes
      statements.push(
        ...adoptPendingBarrierStatements(
          db,
          organizationId,
          pending,
          new Map(state.barriers.map((row) => [row.workos_user_id, row])),
        ),
      );
      // The pending rows just adopted leave the Directory in the same batch: nothing is deleted before it lives here.
      statements.push(...deletePendingStatements(db, input.workosOrganizationId, pending));
      // The Directory state mirror follows the organization row of THIS batch (never the command in hand), so a resend
      // of an older snapshot, answered from the command log, cannot move it behind a newer one.
      statements.push(
        db
          .prepare(
            "UPDATE org_directory SET state = (SELECT state FROM organizations WHERE organization_id = ?1), updated_at = (SELECT synchronized_at FROM organizations WHERE organization_id = ?1) WHERE organization_id = ?1 AND (SELECT state FROM organizations WHERE organization_id = ?1) <> 'deleted' AND state NOT IN ('deleted', (SELECT state FROM organizations WHERE organization_id = ?1))",
          )
          .bind(organizationId),
      );
      const observed = [...new Set([...previous.keys(), ...incoming.keys()])];
      for (const chunk of chunked(observed)) {
        statements.push(
          db
            .prepare(
              "UPDATE workos_membership_sync_barriers SET reconciled_at = ?2 WHERE organization_id = ?1 AND reconciled_at IS NULL AND event_created_at <= ?2 AND workos_user_id IN (SELECT value FROM json_each(?3))",
            )
            .bind(organizationId, fetchedAt, JSON.stringify(chunk)),
        );
      }

      // local grants follow the projected role
      const activeGrants = new Map(state.grants.map((row) => [row.principal_id, row]));
      if (input.state !== "active") {
        statements.push(revokeAllGrantsStatement(db, organizationId, input.synchronizedAt));
      } else {
        const revoke: string[] = [];
        const persist: OrganizationGrantEntry[] = [];
        for (const userId of observed) {
          const prior = previous.get(userId);
          const beforeRole = prior === undefined ? null : projectRole(prior.state, prior.role);
          const member = incoming.get(userId);
          const role = member === undefined ? null : projectRole(member.status, member.role);
          const active = activeGrants.get(`user:${userId}`);
          if (role === null) {
            if (active !== undefined) revoke.push(userId);
            continue;
          }
          if (beforeRole === role && active?.role === role) continue;
          if (active !== undefined) revoke.push(userId);
          persist.push({ grantId: grantIds.get(userId) as string, userId, role });
        }
        for (const chunk of chunked(revoke)) {
          statements.push(
            revokeUserGrantsStatement(db, organizationId, chunk, input.synchronizedAt),
          );
        }
        for (const chunk of chunked(persist)) {
          statements.push(
            persistOrganizationGrantsStatement(db, organizationId, chunk, input.synchronizedAt),
            guard(
              db,
              "precondition_changed",
              `(SELECT count(*) FROM local_authorization_grants WHERE organization_id = ?1 AND grant_id IN (SELECT json_extract(value, '$[0]') FROM json_each(?2))) <> ?3`,
              [organizationId, JSON.stringify(chunk.map((entry) => [entry.grantId])), chunk.length],
            ),
          );
        }
      }
      if (input.claim !== undefined)
        statements.push(
          ...claimGuard(
            db,
            organizationId,
            input.claim,
            globalInbox ? input.workosOrganizationId : undefined,
          ),
        );
      // the original records this audit event in the same transaction as the reconciliation
      statements.push(
        audit("WorkosOrganizationSnapshotApplied", {
          triggerEventId: input.triggerEventId,
          snapshotSha256: input.snapshotDigest,
        }),
      );
      const result = { ...base, organizationChanged, changedMemberships };
      return { statements, result: () => result, logResult: result };
    },
  };
}

/** The grant id of each member is derived from the command, so a replay writes the same grant. */
async function memberGrantIds(
  input: z.output<typeof applyWorkosSnapshotInput>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const member of input.memberships) {
    ids.set(
      member.workosUserId,
      await derivedUlid(
        `grant|${input.auditEventId}|${input.organizationId}|${member.workosUserId}|${member.role}|${member.status}|${input.synchronizedAt}|${input.triggerEventId}`,
      ),
    );
  }
  return ids;
}

/**
 * `applyWorkosOrganizationSnapshotTransaction`: one snapshot of a WorkOS organization, of any size, applied
 * atomically in the organization's shard (organization row, every membership, absent-member revocation,
 * barrier closing, local grants, audit and the acknowledgement of the claimed inbox event) as ONE batch of
 * set-based statements; nothing of it is visible unless all of it is. Afterwards the directory side settles
 * idempotently: pending barriers are adopted and deleted, the state mirror follows. Every step after the
 * batch is repeated by a resend of the same command (the command log answers the batch itself).
 */
export async function applyWorkosSnapshot(
  context: CatalogContext,
  rawInput: unknown,
  options: { readonly globalInbox?: boolean } = {},
): Promise<ApplyWorkosSnapshotResult> {
  const input = applyWorkosSnapshotInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const bucket = shard.bucket ?? 0;
  const pending = await readPendingBarriers(context.directory, input.workosOrganizationId);
  const grantIds = await memberGrantIds(input);
  const result = await runMapped(
    shard.db,
    snapshotCommand(shard.db, bucket, input, pending, grantIds, options.globalInbox === true),
    {
      claim_lost: () =>
        conflict("inbox_claim_stale", "WorkOS inbox claim is stale during snapshot apply"),
    },
  );
  // Pending rows written after the batch read them (never rows it adopted: it deleted those itself) live in the
  // organization next. A resend of the same command repeats this step.
  await promotePendingBarriers(context, input);
  return result;
}
