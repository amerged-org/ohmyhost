import { z } from "zod";

import type { D1Database } from "../../d1-types.js";
import {
  conflict,
  hexBytes,
  instant,
  notFencedOrganization,
  routeOrganization,
  sha256Hex,
  ulid,
  type CatalogContext,
} from "../common.js";

interface PurgeSpec {
  readonly table: string;
  readonly key: readonly string[];
  /** The predicate of rows that may go, with `?1` the cutoff; evaluated against the table itself. */
  readonly where: string;
  readonly order: string;
}

/** One bounded chunk, deleted by primary key. Two sweepers deleting the same chunk delete it once. */
async function deleteChunk(
  db: D1Database,
  spec: PurgeSpec,
  cutoff: string | number,
  limit: number,
): Promise<number> {
  const key = spec.key.join(", ");
  const result = await db
    .prepare(
      `DELETE FROM ${spec.table} WHERE (${key}) IN (SELECT ${key} FROM ${spec.table} WHERE ${spec.where} ORDER BY ${spec.order} LIMIT ?2)`,
    )
    .bind(cutoff, limit)
    .run();
  return result.meta.changes;
}

const shardPurgeInput = z.strictObject({
  shardId: z.number().int().min(0).max(1023),
  before: instant,
  limit: z.number().int().min(1).max(1000),
});

function shardPurge(spec: PurgeSpec) {
  return async (context: CatalogContext, rawInput: unknown): Promise<number> => {
    const input = shardPurgeInput.parse(rawInput);
    const shard = await context.router.routeShard(input.shardId);
    // A shard-wide purge is not routed through an organization's fenced database: it must not delete rows of a
    // bucket that is being moved or has moved (the rows are being copied).
    const fenced = {
      ...spec,
      where: `(${spec.where}) AND ${notFencedOrganization(`${spec.table}.organization_id`)}`,
    };
    return deleteChunk(shard.db, fenced, input.before, input.limit);
  };
}

/** No native acknowledged-outbox retention policy exists. Do not discard original delivery evidence. */
export async function purgeAcknowledgedOutbox(
  context: CatalogContext,
  rawInput: unknown,
): Promise<number> {
  const input = z
    .strictObject({
      shardId: z.number().int().min(0).max(1023),
      before: instant,
      limit: z.number().int().min(1).max(1000),
    })
    .parse(rawInput);
  await context.router.routeShard(input.shardId);
  throw conflict(
    "outbox_history_immutable",
    "Original outbox and delivery history has no authorized retention purge",
  );
}

/** Acknowledged inbox events past the provider redelivery window. */
export const purgeAcknowledgedInbox = shardPurge({
  table: "webhook_inbox",
  key: ["organization_id", "inbox_event_id"],
  where: "acknowledged_at IS NOT NULL AND acknowledged_at <= ?1",
  order: "acknowledged_at",
});

/** Membership barriers reconciled long enough ago. */
export const purgeMembershipBarriers = shardPurge({
  table: "workos_membership_sync_barriers",
  key: ["organization_id", "workos_user_id"],
  where: "reconciled_at IS NOT NULL AND reconciled_at <= ?1",
  order: "reconciled_at",
});

/** User API key creation records finished long enough ago (they recover an uncertain creation until then). */
export const purgeUserApiKeyRequests = shardPurge({
  table: "user_api_key_requests",
  key: ["organization_id", "request_id"],
  where: "finished_at IS NOT NULL AND finished_at <= ?1",
  order: "finished_at",
});

/** Portal handoffs that expired or were consumed before the cutoff. */
export const purgeMcpHandoffs = shardPurge({
  table: "mcp_portal_handoffs",
  key: ["organization_id", "request_hash"],
  where: "expires_at <= ?1 OR (consumed_at IS NOT NULL AND consumed_at <= ?1)",
  order: "expires_at",
});

const commandLogPurgeInput = z.strictObject({
  /** A shard id, or `directory` for the global database's own log. */
  target: z.union([z.number().int().min(0).max(1023), z.literal("directory")]),
  appliedBefore: z.number().int().min(0),
  limit: z.number().int().min(1).max(1000),
});

/** The exactly-once identities of commands, kept for a week and pruned in chunks. */
export async function purgeCommandLog(context: CatalogContext, rawInput: unknown): Promise<number> {
  const input = commandLogPurgeInput.parse(rawInput);
  const db =
    input.target === "directory"
      ? context.directory
      : (await context.router.routeShard(input.target)).db;
  return deleteChunk(
    db,
    { table: "command_log", key: ["command_id"], where: "applied_at < ?1", order: "applied_at" },
    input.appliedBefore,
    input.limit,
  );
}

const directoryPurgeInput = z.strictObject({
  before: instant,
  limit: z.number().int().min(1).max(1000),
});

function directoryPurge(spec: PurgeSpec) {
  return async (context: CatalogContext, rawInput: unknown): Promise<number> => {
    const input = directoryPurgeInput.parse(rawInput);
    return deleteChunk(context.directory, spec, input.before, input.limit);
  };
}

/** The original global inbox has no expiry cutoff for unmapped events. Preserve legacy buffer evidence. */
export async function purgeUnroutedInbox(
  _context: CatalogContext,
  rawInput: unknown,
): Promise<number> {
  directoryPurgeInput.parse(rawInput);
  throw conflict(
    "inbox_retention_unqualified",
    "Legacy inbox evidence has no qualified expiry policy",
  );
}

/** Session revocations past their 35 days; user and organization revocations have no purge time and stay. */
export const purgeRevocations = directoryPurge({
  table: "revocations",
  key: ["kind", "resource_id"],
  where: "purge_after IS NOT NULL AND purge_after <= ?1",
  order: "purge_after",
});

/** Completed onboarding requests past their 7 days. */
export const purgeOnboardingRequests = directoryPurge({
  table: "onboarding_requests",
  key: ["request_id"],
  where: "completed_at IS NOT NULL AND completed_at <= ?1",
  order: "completed_at",
});

const EVIDENCE_TABLES = ["audit_events", "organization_audit_events", "operation_events"] as const;
/** Tables whose exports are registered and whose horizon moves: the evidence tables and the raw inbox of events parked for reconciliation. */
const EXPORTED_TABLES = [...EVIDENCE_TABLES, "webhook_inbox"] as const;

const evidenceTable = z.enum(EVIDENCE_TABLES);
const exportedTable = z.enum(EXPORTED_TABLES);

export const recordEvidenceExportInput = z.strictObject({
  exportId: ulid,
  organizationId: ulid,
  tableName: exportedTable,
  periodStart: instant,
  periodEnd: instant,
  rowCount: z.number().int().min(0),
  sha256: sha256Hex,
  r2Key: z.string().min(1),
  createdAt: instant,
  sourceFormat: z.literal("d1-control-evidence-projection-v1"),
});

/**
 * Registers one verified export (organization, table, month) in the shard that holds the rows. The
 * registry row is the index into R2 and the proof that the object was read back; repeating it is a no-op.
 */
export async function recordEvidenceExport(
  context: CatalogContext,
  rawInput: unknown,
): Promise<"recorded" | "existing"> {
  const input = recordEvidenceExportInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const result = await shard.db
    .prepare(
      `INSERT INTO evidence_exports(export_id, organization_id, table_name, period_start, period_end, row_count, sha256, r2_key, created_at,source_format)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,?10)
       ON CONFLICT (organization_id, table_name, period_start) DO NOTHING`,
    )
    .bind(
      input.exportId,
      input.organizationId,
      input.tableName,
      input.periodStart,
      input.periodEnd,
      input.rowCount,
      hexBytes(input.sha256),
      input.r2Key,
      input.createdAt,
      input.sourceFormat,
    )
    .run();
  if (result.meta.changes === 1) return "recorded";
  const stored = await shard.db
    .prepare(
      "SELECT lower(hex(sha256)) AS digest, row_count,source_format FROM evidence_exports WHERE organization_id = ?1 AND table_name = ?2 AND period_start = ?3",
    )
    .bind(input.organizationId, input.tableName, input.periodStart)
    .first<{ digest: string; row_count: number; source_format: string }>();
  if (stored?.source_format !== input.sourceFormat)
    throw conflict(
      "evidence_export_unqualified",
      "Existing prototype export is not qualified namespace or format evidence",
    );
  if (stored?.digest !== input.sha256 || stored.row_count !== input.rowCount) {
    throw conflict(
      "evidence_export_conflict",
      "The month is already exported with different content",
    );
  }
  return "existing";
}

export const advanceRetentionHorizonInput = z.strictObject({
  shardId: z.number().int().min(0).max(1023),
  tableName: exportedTable,
  exportedThrough: instant,
  now: instant,
});

/**
 * Moves the point below which evidence rows may be deleted. The horizon only moves forward and only after
 * the export job has verified every organization of the shard for the period; the append-only triggers
 * refuse any delete above it.
 */
export async function advanceRetentionHorizon(
  context: CatalogContext,
  rawInput: unknown,
): Promise<string> {
  const input = advanceRetentionHorizonInput.parse(rawInput);
  if (input.tableName !== "webhook_inbox")
    throw conflict(
      "evidence_immutable",
      "Original operation and audit evidence cannot acquire deletion authority",
    );
  const shard = await context.router.routeShard(input.shardId);
  const row = await shard.db
    .prepare(
      `INSERT INTO retention_horizon(table_name, exported_through, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (table_name) DO UPDATE SET exported_through = excluded.exported_through, updated_at = excluded.updated_at
         WHERE excluded.exported_through > retention_horizon.exported_through
       RETURNING exported_through`,
    )
    .bind(input.tableName, input.exportedThrough, input.now)
    .first<{ exported_through: string }>();
  if (row !== null) return row.exported_through;
  const current = await shard.db
    .prepare("SELECT exported_through FROM retention_horizon WHERE table_name = ?")
    .bind(input.tableName)
    .first<{ exported_through: string }>();
  return (current as { exported_through: string }).exported_through;
}

export const purgeEvidenceBelowHorizonInput = z.strictObject({
  organizationId: ulid,
  tableName: evidenceTable,
  limit: z.number().int().min(1).max(1000),
});

/**
 * Original001/002 evidence is unconditionally append-only. Prototype export/horizon metadata cannot authorize deletion.
 */
export async function purgeEvidenceBelowHorizon(
  context: CatalogContext,
  rawInput: unknown,
): Promise<number> {
  const input = purgeEvidenceBelowHorizonInput.parse(rawInput);
  await routeOrganization(context, input.organizationId);
  throw conflict(
    "evidence_immutable",
    "Original operation and audit evidence is append-only even after export",
  );
}

export const purgeReconciliationInboxInput = z.strictObject({
  organizationId: ulid,
  limit: z.number().int().min(1).max(1000),
});

/**
 * Deletes one organization's inbox events that ended in `reconciliation_required`, and only those that lie at or below
 * the `webhook_inbox` retention horizon AND inside a month with a registered, verified export of that organization and
 * table (the same registry and horizon as the evidence tables; no other window exists). An event that a GitHub push
 * deployment still points at stays. The shard trigger refuses the same delete from any other path. The window length
 * is not set here: the horizon only moves when the export job has verified the period.
 */
export async function purgeReconciliationInbox(
  context: CatalogContext,
  rawInput: unknown,
): Promise<number> {
  const input = purgeReconciliationInboxInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const horizon = await shard.db
    .prepare("SELECT exported_through FROM retention_horizon WHERE table_name = 'webhook_inbox'")
    .first<{ exported_through: string }>();
  if (horizon === null) return 0;
  const result = await shard.db
    .prepare(
      `DELETE FROM webhook_inbox WHERE organization_id = ?1 AND inbox_event_id IN (
         SELECT inbox_event_id FROM webhook_inbox inbox WHERE inbox.organization_id = ?1 AND inbox.state = 'reconciliation_required'
           AND inbox.received_at <= ?2
           AND EXISTS (SELECT 1 FROM evidence_exports ex WHERE ex.organization_id = inbox.organization_id
             AND ex.table_name = 'webhook_inbox' AND ex.period_start <= inbox.received_at AND inbox.received_at < ex.period_end)
           AND NOT EXISTS (SELECT 1 FROM github_push_deployments push
             WHERE push.organization_id = inbox.organization_id AND push.inbox_event_id = inbox.inbox_event_id)
         ORDER BY inbox.received_at, inbox.inbox_event_id LIMIT ?3)`,
    )
    .bind(input.organizationId, horizon.exported_through, input.limit)
    .run();
  return result.meta.changes;
}

export const pageEvidenceRowsInput = z.strictObject({
  organizationId: ulid,
  tableName: evidenceTable,
  periodStart: instant,
  periodEnd: instant,
  /** The key of the last row of the previous page. */
  after: z.string().optional(),
  limit: z.number().int().min(1).max(1000),
});

/**
 * One page of an organization's evidence rows of a period, in key order, for the export job that writes
 * them to R2. `next` is the cursor of the following page; null when the period is read completely.
 */
export async function pageEvidenceRows(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly rows: Record<string, unknown>[]; readonly next: string | null }> {
  const input = pageEvidenceRowsInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const audit = input.tableName !== "operation_events";
  const key = audit
    ? "occurred_at || '|' || audit_event_id"
    : "operation_id || '|' || printf('%010d', revision)";
  const result = await shard.db
    .prepare(
      `SELECT *, ${key} AS page_key FROM ${input.tableName}
       WHERE organization_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND (?4 IS NULL OR ${key} > ?4)
       ORDER BY ${audit ? "occurred_at, audit_event_id" : "operation_id, revision"} LIMIT ?5`,
    )
    .bind(
      input.organizationId,
      input.periodStart,
      input.periodEnd,
      input.after ?? null,
      input.limit + 1,
    )
    .all<Record<string, unknown>>();
  const page = result.results.slice(0, input.limit);
  const last = page.at(-1);
  return {
    rows: page.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([name]) => name !== "page_key")),
    ),
    next:
      result.results.length > input.limit && last !== undefined ? String(last["page_key"]) : null,
  };
}
