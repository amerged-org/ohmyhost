import { z } from "zod";
import type {
  PreviewDatabaseRegistration,
  PreviewSourceDescriptor,
} from "@ohmyhost/contracts/previews";
import { readDatabaseManagementRuntimeBinding } from "../database/management.js";
import { guard } from "../../guards.js";
import type { CatalogContext } from "../common.js";
import { hexBytes, newUlid, publicTimestamp, routeOrganization, ulid, instant } from "../common.js";
import { runtimeDecisionFromResults, runtimeDecisionStatements } from "../credit/decision.js";
import {
  ROW,
  LIVE_ROW,
  LIVE_SOURCE,
  backup,
  fail,
  nowOf,
  rowById,
  runtimeFence,
  previewAuthorityFingerprint,
  runtimeGuard,
  runtimeRecord,
  sourceVersion,
  type PreviewRow,
} from "./common.js";

const time = { now: instant.optional(), clock: z.literal("execution").optional() };
const hashInput = z.strictObject({ tokenHash: z.string().regex(/^[0-9a-f]{64}$/u), ...time });
const stateInput = runtimeFence.extend({
  expectedRowVersion: z.number().int().positive().safe(),
  state: z.enum(["cold", "starting", "ready", "sleeping"]),
});
const appliedInput = runtimeFence.extend({
  expectedRowVersion: z.number().int().positive().safe(),
  source: sourceVersion,
});
const backupInput = runtimeFence.extend({
  expectedRowVersion: z.number().int().positive().safe(),
  backup: backup.nullable(),
});
const activityInput = runtimeFence.extend({
  expectedRowVersion: z.number().int().positive().safe(),
  occurredAt: instant,
});
const sourceInput = z.strictObject({
  previewId: ulid,
  runtimeGeneration: z.number().int().positive().safe(),
  tokenGeneration: z.number().int().positive().safe(),
  sequence: z.number().int().positive().safe(),
  ...time,
});

/** Token lookup checks current scope and Paid entitlement; it never reveals custody. */
export async function resolvePreviewTokenHash(context: CatalogContext, raw: unknown) {
  const i = hashInput.parse(raw),
    now = nowOf(i),
    db = context.directory;
  const row = await db
    .prepare(`${ROW} WHERE v.token_lookup_sha256=?1 AND v.retirement='none' AND ${LIVE_ROW}`)
    .bind(Array.from(hexBytes(i.tokenHash)), now)
    .first<PreviewRow>();
  if (!row) return null;
  await routeOrganization(context, String(row["organization_id"]));
  return runtimeRecord(row);
}
/** Current source, funding, assignment and every generation are rechecked on every capability call. */
export async function authorizePreviewRuntime(context: CatalogContext, raw: unknown) {
  const i = runtimeFence.parse(raw),
    now = nowOf(i),
    db = context.directory,
    row = await rowById(db, i.previewId);
  if (!row) return null;
  await routeOrganization(context, String(row["organization_id"]));
  const decision = {
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    environmentId: String(row["environment_id"]),
    now,
  };
  const results = await db.batch([
    db
      .prepare(
        `${ROW} WHERE v.preview_id=?1 AND ${LIVE_ROW} AND v.retirement='none' AND v.runtime_generation=?3 AND v.token_generation=?4 AND ${LIVE_SOURCE}`,
      )
      .bind(i.previewId, now, i.runtimeGeneration, i.tokenGeneration),
    ...runtimeDecisionStatements(db, decision),
  ]);
  const current = results[0]?.results[0] as PreviewRow | undefined;
  if (!current || !runtimeDecisionFromResults(decision, results.slice(1)).allowed) return null;
  return runtimeRecord(current);
}
async function mutable(
  context: CatalogContext,
  i: z.output<typeof runtimeFence>,
  expectedRowVersion: number,
) {
  const row = await rowById(context.directory, i.previewId);
  if (
    !row ||
    Number(row["runtime_generation"]) !== i.runtimeGeneration ||
    Number(row["token_generation"]) !== i.tokenGeneration ||
    Number(row["row_version"]) !== expectedRowVersion
  )
    fail("version_conflict");
  if (
    !(await authorizePreviewRuntime(context, {
      previewId: i.previewId,
      runtimeGeneration: i.runtimeGeneration,
      tokenGeneration: i.tokenGeneration,
      ...(i.now ? { now: i.now } : {}),
      ...(i.clock ? { clock: i.clock } : {}),
    }))
  )
    fail("scope_unavailable");
  return row;
}
async function updated(context: CatalogContext, id: string) {
  const row = await rowById(context.directory, id);
  if (!row) fail("scope_unavailable");
  return runtimeRecord(row);
}

export async function recordPreviewState(context: CatalogContext, raw: unknown) {
  const i = stateInput.parse(raw),
    now = nowOf(i),
    db = context.directory,
    row = await mutable(context, i, i.expectedRowVersion),
    prior = String(row["state"]);
  if (i.state === prior) return runtimeRecord(row);
  if (
    !(
      (prior === "starting" && (i.state === "ready" || i.state === "cold")) ||
      (prior === "ready" && i.state === "sleeping")
    )
  )
    fail("invalid_transition");
  const noOpen =
    i.state === "sleeping" || i.state === "cold"
      ? "AND NOT EXISTS(SELECT 1 FROM project_preview_usage_intervals u WHERE u.preview_id=project_previews.preview_id AND u.state='reserved')"
      : "AND EXISTS(SELECT 1 FROM project_preview_usage_intervals u WHERE u.preview_id=project_previews.preview_id AND u.runtime_generation=project_previews.runtime_generation AND u.state='reserved')";
  const results = await db.batch([
    runtimeGuard(db, row, now, true),
    db
      .prepare(
        `UPDATE project_previews SET state=?2,row_version=row_version+1,updated_at=?3 WHERE preview_id=?1 ${noOpen}`,
      )
      .bind(i.previewId, i.state, now),
  ]);
  if (results[1]?.meta.changes !== 1) fail("usage_fence");
  return updated(context, i.previewId);
}
export async function recordPreviewAppliedSource(context: CatalogContext, raw: unknown) {
  const i = appliedInput.parse(raw),
    now = nowOf(i),
    db = context.directory,
    row = await mutable(context, i, i.expectedRowVersion);
  const old = Number(row["applied_sequence"] ?? 0),
    target = Number(row["target_sequence"] ?? 0);
  if (i.source.sequence < old) fail("source_superseded");
  if (i.source.sequence === old) {
    if (
      row["applied_connection_id"] !== i.source.sourceConnectionId ||
      row["applied_generation"] !== i.source.sourceGeneration ||
      row["applied_commit"] !== i.source.commitSha
    )
      fail("source_conflict");
    return runtimeRecord(row);
  }
  if (
    i.source.sequence > target ||
    row["target_connection_id"] !== i.source.sourceConnectionId ||
    Number(row["target_generation"]) !== i.source.sourceGeneration
  )
    fail("source_superseded");
  const results = await db.batch([
    runtimeGuard(db, row, now, true),
    db
      .prepare(
        `UPDATE project_previews SET applied_connection_id=?2,applied_generation=?3,applied_sequence=?4,applied_commit=?5,row_version=row_version+1,updated_at=?6
 WHERE preview_id=?1 AND EXISTS(SELECT 1 FROM project_preview_source_events e WHERE e.organization_id=project_previews.organization_id AND e.project_id=project_previews.project_id AND e.source_connection_id=?2 AND e.source_generation=?3 AND e.sequence=?4 AND e.commit_sha=?5)`,
      )
      .bind(
        i.previewId,
        i.source.sourceConnectionId,
        i.source.sourceGeneration,
        i.source.sequence,
        i.source.commitSha,
        now,
      ),
  ]);
  if (results[1]?.meta.changes !== 1) fail("source_conflict");
  return updated(context, i.previewId);
}
export async function recordPreviewBackup(context: CatalogContext, raw: unknown) {
  const i = backupInput.parse(raw),
    now = nowOf(i),
    db = context.directory,
    row = await mutable(context, i, i.expectedRowVersion);
  if (i.backup) {
    const s = i.backup.source;
    if (
      row["applied_connection_id"] !== s.sourceConnectionId ||
      Number(row["applied_generation"]) !== s.sourceGeneration ||
      Number(row["applied_sequence"]) !== s.sequence ||
      row["applied_commit"] !== s.commitSha
    )
      fail("backup_source_conflict");
    const expiry = new Date(
      Date.parse(String(row["last_activity_at"])) + 30 * 86400000,
    ).toISOString();
    if (Date.parse(i.backup.expiresAt) !== Date.parse(expiry)) fail("backup_expiry_conflict");
  }
  const b = i.backup;
  await db.batch([
    runtimeGuard(db, row, now, true),
    ...(row["backup_handle"] !== null && row["backup_handle"] !== b?.handle
      ? [
          db
            .prepare(
              "INSERT OR IGNORE INTO project_preview_backup_cleanup(preview_id,cleanup_id,backup_handle,created_at) VALUES(?1,?2,?3,?4)",
            )
            .bind(i.previewId, newUlid(), row["backup_handle"], now),
        ]
      : []),
    db
      .prepare(
        "UPDATE project_previews SET backup_handle=?2,backup_expires_at=?3,backup_connection_id=?4,backup_generation=?5,backup_sequence=?6,backup_commit=?7,row_version=row_version+1,updated_at=?8 WHERE preview_id=?1",
      )
      .bind(
        i.previewId,
        b?.handle ?? null,
        b?.expiresAt ?? null,
        b?.source.sourceConnectionId ?? null,
        b?.source.sourceGeneration ?? null,
        b?.source.sequence ?? null,
        b?.source.commitSha ?? null,
        now,
      ),
  ]);
  return updated(context, i.previewId);
}
export async function renewPreviewActivity(context: CatalogContext, raw: unknown) {
  const i = activityInput.parse(raw),
    now = nowOf(i),
    db = context.directory,
    row = await mutable(context, i, i.expectedRowVersion);
  if (Date.parse(i.occurredAt) > Date.parse(now)) fail("activity_time_invalid");
  if (i.occurredAt <= String(row["last_activity_at"])) return runtimeRecord(row);
  const expires = new Date(Date.parse(i.occurredAt) + 30 * 86400000).toISOString();
  await db.batch([
    runtimeGuard(db, row, now, true),
    db
      .prepare(
        "UPDATE project_previews SET last_activity_at=?2,backup_expires_at=CASE WHEN backup_handle IS NULL THEN NULL ELSE ?3 END,row_version=row_version+1,updated_at=?4 WHERE preview_id=?1",
      )
      .bind(i.previewId, i.occurredAt, expires, now),
  ]);
  return updated(context, i.previewId);
}

/** Reads only the currently selected grant for the exact accepted target. */
export async function readPreviewSource(
  context: CatalogContext,
  raw: unknown,
): Promise<PreviewSourceDescriptor | null> {
  const i = sourceInput.parse(raw),
    now = nowOf(i),
    db = context.directory;
  const row = await db
    .prepare(
      `SELECT v.organization_id,v.project_id,v.environment_id,v.billing_epoch_id,v.token_generation,p.region,g.* FROM project_previews v
 JOIN projects p ON p.organization_id=v.organization_id AND p.project_id=v.project_id
 JOIN repository_grants g ON g.organization_id=v.organization_id AND g.project_id=v.project_id AND g.source_connection_id=v.target_connection_id
 WHERE v.preview_id=?1 AND ${LIVE_ROW} AND v.retirement='none' AND v.runtime_generation=?3 AND v.target_sequence=?4 AND v.token_generation=?5 AND ${LIVE_SOURCE}`,
    )
    .bind(i.previewId, now, i.runtimeGeneration, i.sequence, i.tokenGeneration)
    .first<PreviewRow>();
  if (!row) return null;
  await routeOrganization(context, String(row["organization_id"]));
  const authorityInput = {
    previewId: i.previewId,
    runtimeGeneration: i.runtimeGeneration,
    tokenGeneration: i.tokenGeneration,
    ...(i.now ? { now: i.now } : {}),
    ...(i.clock ? { clock: i.clock } : {}),
  };
  const before = await authorizePreviewRuntime(context, authorityInput);
  if (!before || before.targetSource?.sequence !== i.sequence) return null;
  const after = await authorizePreviewRuntime(context, authorityInput);
  if (!after || previewAuthorityFingerprint(before) !== previewAuthorityFingerprint(after))
    return null;
  const installation =
      row["github_installation_id"] === null ? null : Number(row["github_installation_id"]),
    repo =
      row["provider"] === "github"
        ? Number(row["external_repository_id"])
        : String(row["external_repository_id"]);
  if (
    (installation !== null && !Number.isSafeInteger(installation)) ||
    (typeof repo === "number" && !Number.isSafeInteger(repo))
  )
    fail("source_unavailable");
  const organizationId = String(row["organization_id"]),
    projectId = String(row["project_id"]),
    environmentId = String(row["environment_id"]),
    billingEpochId = String(row["billing_epoch_id"]),
    sourceConnectionId = String(row["source_connection_id"]),
    owner = String(row["repository_owner"]),
    name = String(row["repository_name"]);
  return {
    provider: row["provider"] as "github" | "managed",
    targetSource: before.targetSource,
    organizationId,
    projectId,
    environmentId,
    billingEpochId,
    sourceConnectionId,
    region: row["region"] as "eu" | "us",
    repository: { owner, name, externalRepositoryId: String(row["external_repository_id"]) },
    grant: {
      status: "approved",
      grantId: String(row["grant_id"]),
      organizationId,
      projectId,
      billingEpochId,
      sourceConnectionId,
      installationId: installation,
      repositoryId: repo,
      owner,
      repository: name,
      permission: "contents:read",
      grantedAt: publicTimestamp(String(row["granted_at"])),
      revokedAt: null,
    },
  };
}
export async function listPendingPreviewSources(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ limit: z.number().int().min(1).max(100) }).parse(raw);
  return (
    await context.directory
      .prepare(
        "SELECT preview_id,sequence FROM project_preview_source_pending ORDER BY updated_at,preview_id LIMIT ?1",
      )
      .bind(i.limit)
      .all<{ preview_id: string; sequence: number }>()
  ).results.map((r) => ({ previewId: r.preview_id, sequence: r.sequence }));
}
export async function acknowledgePreviewSource(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({ previewId: ulid, sequence: z.number().int().positive().safe() })
    .parse(raw);
  await context.directory
    .prepare("DELETE FROM project_preview_source_pending WHERE preview_id=?1 AND sequence=?2")
    .bind(i.previewId, i.sequence)
    .run();
}

/** Database target is always resolved server-side from current fenced preview scope. */
export async function authorizePreviewDatabase(context: CatalogContext, raw: unknown) {
  const first = await authorizePreviewRuntime(context, raw);
  if (!first) return null;
  const binding = await readDatabaseManagementRuntimeBinding(context, {
    organizationId: first.organizationId,
    projectId: first.projectId,
    environmentId: first.environmentId,
  });
  const preview = await authorizePreviewRuntime(context, raw);
  if (
    !preview ||
    !binding ||
    !("provider" in binding) ||
    binding.provider !== "pgcf" ||
    binding.organizationId !== preview.organizationId ||
    binding.projectId !== preview.projectId ||
    binding.physicalEnvironmentId !== preview.dataEnvironmentId ||
    binding.region !== preview.region ||
    binding.status !== "active" ||
    !binding.authorizedEnvironmentIds.includes(preview.environmentId) ||
    preview.assignmentVersion !== first.assignmentVersion ||
    preview.runtimeGeneration !== first.runtimeGeneration ||
    preview.tokenGeneration !== first.tokenGeneration
  )
    return null;
  return { preview, binding: binding as PreviewDatabaseRegistration };
}

/** Control API rings only the previews of the project whose source it just accepted. */
export async function listProjectPendingPreviewSources(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ organizationId: ulid, projectId: ulid }).parse(raw);
  const { db } = await routeOrganization(context, i.organizationId);
  const rows = await db
    .prepare(
      `SELECT q.preview_id,q.sequence FROM project_preview_source_pending q
    JOIN project_previews v ON v.preview_id=q.preview_id
    WHERE v.organization_id=?1 AND v.project_id=?2 AND v.retirement='none' ORDER BY v.preview_id`,
    )
    .bind(i.organizationId, i.projectId)
    .all<{ preview_id: string; sequence: number }>();
  return rows.results.map((r) => ({ previewId: r.preview_id, sequence: r.sequence }));
}

async function cleanupFence(context: CatalogContext, i: z.output<typeof runtimeFence>) {
  const row = await rowById(context.directory, i.previewId);
  if (
    !row ||
    Number(row["runtime_generation"]) !== i.runtimeGeneration ||
    Number(row["token_generation"]) !== i.tokenGeneration ||
    row["retirement"] === "retired"
  )
    fail("version_conflict");
  await routeOrganization(context, String(row["organization_id"]));
  return row;
}
export async function listPreviewBackupCleanup(context: CatalogContext, raw: unknown) {
  const i = runtimeFence.parse(raw),
    row = await cleanupFence(context, i),
    db = context.directory;
  const results = await db.batch([
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement<>'retired')",
      [i.previewId, i.runtimeGeneration, i.tokenGeneration],
    ),
    db
      .prepare(
        "SELECT cleanup_id,backup_handle FROM project_preview_backup_cleanup WHERE preview_id=?1 ORDER BY created_at,cleanup_id",
      )
      .bind(i.previewId),
  ]);
  void row;
  return (results[1]?.results ?? []).map((r) => ({
    cleanupId: String(r["cleanup_id"]),
    handle: String(r["backup_handle"]),
  }));
}
export async function acknowledgePreviewBackupCleanup(context: CatalogContext, raw: unknown) {
  const i = runtimeFence
    .extend({ cleanupId: ulid, handle: z.string().min(1).max(4096) })
    .parse(raw);
  await cleanupFence(context, i);
  await context.directory.batch([
    guard(
      context.directory,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement<>'retired')",
      [i.previewId, i.runtimeGeneration, i.tokenGeneration],
    ),
    context.directory
      .prepare(
        "DELETE FROM project_preview_backup_cleanup WHERE preview_id=?1 AND cleanup_id=?2 AND backup_handle=?3",
      )
      .bind(i.previewId, i.cleanupId, i.handle),
  ]);
}
export async function claimExpiredPreviewBackup(context: CatalogContext, raw: unknown) {
  const i = runtimeFence
      .extend({ expectedRowVersion: z.number().int().positive().safe() })
      .parse(raw),
    now = nowOf(i),
    row = await cleanupFence(context, i),
    db = context.directory;
  if (
    row["backup_handle"] === null ||
    Date.parse(String(row["backup_expires_at"])) > Date.parse(now)
  )
    return runtimeRecord(row);
  await db.batch([
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND row_version=?4 AND retirement='none' AND backup_handle IS NOT NULL AND backup_expires_at<=?5)",
      [i.previewId, i.runtimeGeneration, i.tokenGeneration, i.expectedRowVersion, now],
    ),
    db
      .prepare(
        "INSERT OR IGNORE INTO project_preview_backup_cleanup(preview_id,cleanup_id,backup_handle,created_at) SELECT preview_id,?2,backup_handle,?3 FROM project_previews WHERE preview_id=?1",
      )
      .bind(i.previewId, newUlid(), now),
    db
      .prepare(
        "UPDATE project_previews SET backup_handle=NULL,backup_expires_at=NULL,backup_connection_id=NULL,backup_generation=NULL,backup_sequence=NULL,backup_commit=NULL,row_version=row_version+1,updated_at=?2 WHERE preview_id=?1",
      )
      .bind(i.previewId, now),
  ]);
  return updated(context, i.previewId);
}

/** Private cleanup metadata survives expired entitlement, revoked sources and project deletion. */
export async function getPreviewCleanupState(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ previewId: ulid }).parse(raw);
  const row = await rowById(context.directory, i.previewId);
  if (!row || row["retirement"] === "retired") return null;
  await routeOrganization(context, String(row["organization_id"]));
  return {
    previewId: i.previewId,
    region: row["region"] as "eu" | "us",
    rowVersion: Number(row["row_version"]),
    runtimeGeneration: Number(row["runtime_generation"]),
    tokenGeneration: Number(row["token_generation"]),
    authGeneration: Number(row["auth_generation"]),
    state: row["state"] as "cold" | "starting" | "ready" | "sleeping",
    retirement: row["retirement"] as "none" | "rotating" | "destroying" | "suspended",
    hasBackup: row["backup_handle"] !== null,
    backupHandle: row["backup_handle"] === null ? null : String(row["backup_handle"]),
    backupExpiresAt: row["backup_expires_at"] === null ? null : String(row["backup_expires_at"]),
  };
}

/** A stopped actor may settle its state even after source, Paid or credit authority is lost. */
export async function recordPreviewStopped(context: CatalogContext, raw: unknown) {
  const i = runtimeFence.parse(raw),
    now = nowOf(i),
    db = context.directory;
  const row = await rowById(db, i.previewId);
  if (
    !row ||
    Number(row["runtime_generation"]) !== i.runtimeGeneration ||
    Number(row["token_generation"]) !== i.tokenGeneration ||
    row["retirement"] !== "none"
  )
    fail("version_conflict");
  await routeOrganization(context, String(row["organization_id"]));
  if (row["state"] === "cold" || row["state"] === "sleeping") return runtimeRecord(row);
  await db.batch([
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement='none') OR EXISTS(SELECT 1 FROM project_preview_usage_intervals WHERE preview_id=?1 AND state='reserved')",
      [i.previewId, i.runtimeGeneration, i.tokenGeneration],
    ),
    db
      .prepare(
        "UPDATE project_previews SET state=CASE WHEN state='starting' THEN 'cold' ELSE 'sleeping' END,row_version=row_version+1,updated_at=?4 WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement='none' AND state IN ('starting','ready')",
      )
      .bind(i.previewId, i.runtimeGeneration, i.tokenGeneration, now),
  ]);
  return updated(context, i.previewId);
}
