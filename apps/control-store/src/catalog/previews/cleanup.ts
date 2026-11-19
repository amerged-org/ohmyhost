import { z } from "zod";
import { guard } from "../../guards.js";
import { instant, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { LIVE_SOURCE, fail, nowOf, rowById, runtimeFence, type PreviewRow } from "./common.js";
import { getPreviewCleanupState } from "./runtime.js";
import { previewNativeDrainGuard } from "./native-auth.js";

const time = { now: instant.optional(), clock: z.literal("execution").optional() };
const CANDIDATES = `SELECT v.preview_id,v.row_version,v.runtime_generation,v.token_generation,v.auth_generation,v.state,v.retirement,
 v.backup_handle IS NOT NULL has_backup,v.backup_handle,v.backup_expires_at,v.retirement_request_id,p.region,
 CASE WHEN v.retirement='destroying' AND v.retirement_request_id LIKE 'system:%' THEN substr(v.retirement_request_id,8)
 WHEN p.project_id IS NULL OR p.owner_state<>'active' OR p.lifecycle_state<>'active' OR p.active_billing_epoch_id<>v.billing_epoch_id OR p.ownership_version<>v.ownership_version OR p.lifecycle_version<>v.lifecycle_version OR e.environment_id IS NULL OR o.state<>'active' OR epoch.billing_epoch_id IS NULL THEN 'scope'
 WHEN v.retirement='suspended' AND v.environment_name='dev' AND c.paid_until>?1 THEN CASE WHEN a.assignment_version IS NULL OR a.assignment_version<>v.assignment_version OR a.data_environment_id<>v.data_environment_id THEN 'assignment' ELSE 'resume' END
 WHEN v.retirement='suspended' THEN NULL
 WHEN v.environment_name='dev' AND (c.paid_until IS NULL OR c.paid_until<=?1) THEN 'entitlement'
 WHEN a.assignment_version IS NULL OR a.assignment_version<>v.assignment_version OR a.data_environment_id<>v.data_environment_id THEN 'assignment'
 WHEN v.retirement='rotating' THEN 'rotation'
 WHEN v.retirement='destroying' THEN 'destroy'
 WHEN v.retirement<>'none' THEN NULL
 WHEN EXISTS(SELECT 1 FROM project_preview_backup_cleanup pending WHERE pending.preview_id=v.preview_id) THEN 'backup_cleanup'
 WHEN v.state IN ('starting','ready') AND v.target_connection_id IS NOT NULL AND NOT ${LIVE_SOURCE} THEN 'source'
 WHEN v.backup_handle IS NOT NULL AND v.backup_expires_at<=?1 THEN 'expired'
 ELSE NULL END reason
 FROM project_previews v LEFT JOIN projects p ON p.organization_id=v.organization_id AND p.project_id=v.project_id
 LEFT JOIN organizations o ON o.organization_id=v.organization_id
 LEFT JOIN billing_epochs epoch ON epoch.organization_id=v.organization_id AND epoch.project_id=v.project_id AND epoch.billing_epoch_id=v.billing_epoch_id AND epoch.ended_at IS NULL
 LEFT JOIN environments e ON e.organization_id=v.organization_id AND e.project_id=v.project_id AND e.environment_id=v.environment_id AND e.name=v.environment_name
 LEFT JOIN credit_account c ON c.organization_id=v.organization_id
 LEFT JOIN environment_data_assignments a ON a.organization_id=v.organization_id AND a.project_id=v.project_id AND a.environment_id=v.environment_id AND a.assignment_version=(SELECT MAX(a2.assignment_version) FROM environment_data_assignments a2 WHERE a2.organization_id=v.organization_id AND a2.project_id=v.project_id AND a2.environment_id=v.environment_id)
 WHERE v.retirement<>'retired'`;
function view(row: PreviewRow) {
  return {
    previewId: String(row["preview_id"]),
    region: row["region"] as "eu" | "us",
    rowVersion: Number(row["row_version"]),
    runtimeGeneration: Number(row["runtime_generation"]),
    tokenGeneration: Number(row["token_generation"]),
    authGeneration: Number(row["auth_generation"]),
    state: row["state"] as "cold" | "starting" | "ready" | "sleeping",
    retirement: row["retirement"] as "none" | "rotating" | "destroying" | "suspended",
    hasBackup: row["has_backup"] === 1,
    backupHandle: row["backup_handle"] === null ? null : String(row["backup_handle"]),
    backupExpiresAt: row["backup_expires_at"] === null ? null : String(row["backup_expires_at"]),
    reason: row["reason"] as
      | "scope"
      | "entitlement"
      | "assignment"
      | "source"
      | "expired"
      | "backup_cleanup"
      | "rotation"
      | "destroy"
      | "resume",
  };
}
async function one(context: CatalogContext, previewId: string, now: string) {
  return context.directory
    .prepare(`SELECT * FROM (${CANDIDATES}) candidates WHERE preview_id=?2 AND reason IS NOT NULL`)
    .bind(now, previewId)
    .first<PreviewRow>();
}
/** Durable scan: stale scope, inactivity and in-progress system cleanup remain discoverable after a crash. */
export async function listPreviewCleanupCandidates(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({ limit: z.number().int().min(1).max(100), after: ulid.optional(), ...time })
      .parse(raw),
    now = nowOf(i);
  const rows = await context.directory
    .prepare(
      `SELECT * FROM (${CANDIDATES}) candidates WHERE reason IS NOT NULL AND (?2 IS NULL OR preview_id>?2) ORDER BY preview_id LIMIT ?3`,
    )
    .bind(now, i.after ?? null, i.limit)
    .all<PreviewRow>();
  return rows.results.map(view);
}
/** Fence all old runtime work before asking the actor to close streams, stop and remove backups. */
export async function claimPreviewScopeCleanup(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        previewId: ulid,
        expectedRowVersion: z.number().int().positive().safe(),
        ...time,
      })
      .parse(raw),
    now = nowOf(i),
    row = await one(context, i.previewId, now);
  if (!row) fail("cleanup_not_due");
  const reason = String(row["reason"]);
  if (!["scope", "entitlement", "assignment", "source"].includes(reason)) fail("cleanup_not_due");
  if (
    row["retirement"] === "destroying" &&
    String(row["retirement_request_id"]).startsWith("system:")
  ) {
    const existing = await getPreviewCleanupState(context, { previewId: i.previewId });
    if (!existing) fail("cleanup_not_due");
    return existing;
  }
  const db = context.directory,
    previous = await rowById(db, i.previewId);
  if (!previous) fail("cleanup_not_due");
  await routeOrganization(context, String(previous["organization_id"]));
  await db.batch([
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM (${CANDIDATES}) x WHERE x.preview_id=?2 AND x.row_version=?3 AND x.reason=?4)`,
      [now, i.previewId, i.expectedRowVersion, reason],
    ),
    db
      .prepare(
        "UPDATE project_previews SET retirement='destroying',retirement_request_id=?2,runtime_generation=runtime_generation+1,row_version=row_version+1,updated_at=?3 WHERE preview_id=?1",
      )
      .bind(i.previewId, `system:${reason}`, now),
  ]);
  const result = await getPreviewCleanupState(context, { previewId: i.previewId });
  if (!result) fail("cleanup_not_due");
  return result;
}
function catchUp(db: CatalogContext["directory"], id: string, now: string) {
  return [
    db.prepare("DELETE FROM project_preview_source_pending WHERE preview_id=?1").bind(id),
    db
      .prepare(
        `UPDATE project_previews SET
      target_connection_id=(SELECT h.source_connection_id FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id),
      target_generation=(SELECT h.source_generation FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id),
      target_sequence=(SELECT h.sequence FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id),
      target_commit=(SELECT h.commit_sha FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id),row_version=row_version+1
      WHERE preview_id=?1 AND retirement='none' AND COALESCE(target_sequence,0)<(SELECT h.sequence FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id)`,
      )
      .bind(id),
    db
      .prepare(
        `INSERT INTO project_preview_source_pending(preview_id,sequence,updated_at) SELECT preview_id,target_sequence,?2 FROM project_previews WHERE preview_id=?1 AND retirement='none' AND target_sequence IS NOT NULL ON CONFLICT(preview_id) DO UPDATE SET sequence=excluded.sequence,updated_at=excluded.updated_at WHERE excluded.sequence>project_preview_source_pending.sequence`,
      )
      .bind(id, now),
  ];
}

/** Trusted actor confirms exact backup deletion and stopped/settled compute; lost responses replay by generation. */
export async function finishPreviewScopeCleanup(context: CatalogContext, raw: unknown) {
  const i = runtimeFence
      .extend({ deletedBackupHandle: z.string().min(1).max(4096).nullable() })
      .parse(raw),
    now = nowOf(i),
    db = context.directory,
    row = await rowById(db, i.previewId);
  if (!row) fail("scope_unavailable");
  await routeOrganization(context, String(row["organization_id"]));
  const receipt = await db
    .prepare(
      "SELECT 1 FROM project_preview_cleanup_receipts WHERE preview_id=?1 AND runtime_generation=?2",
    )
    .bind(i.previewId, i.runtimeGeneration)
    .first();
  if (receipt) return;
  const reason = String(row["retirement_request_id"] ?? "").replace(/^system:/u, "");
  if (
    row["retirement"] !== "destroying" ||
    !["scope", "entitlement", "assignment", "source"].includes(reason) ||
    Number(row["runtime_generation"]) !== i.runtimeGeneration ||
    Number(row["token_generation"]) !== i.tokenGeneration ||
    row["backup_handle"] !== i.deletedBackupHandle
  )
    fail("version_conflict");
  const current = await db
    .prepare(
      `SELECT p.owner_state,p.lifecycle_state,p.active_billing_epoch_id,p.ownership_version,p.lifecycle_version,c.paid_until,a.assignment_version,a.data_environment_id
 FROM projects p LEFT JOIN credit_account c ON c.organization_id=p.organization_id
 LEFT JOIN environment_data_assignments a ON a.organization_id=p.organization_id AND a.project_id=p.project_id AND a.environment_id=?3 AND a.assignment_version=(SELECT MAX(a2.assignment_version) FROM environment_data_assignments a2 WHERE a2.organization_id=p.organization_id AND a2.project_id=p.project_id AND a2.environment_id=?3)
 WHERE p.organization_id=?1 AND p.project_id=?2`,
    )
    .bind(row["organization_id"], row["project_id"], row["environment_id"])
    .first<PreviewRow>();
  const terminal =
    reason === "scope" ||
    !current ||
    current["owner_state"] !== "active" ||
    current["lifecycle_state"] !== "active" ||
    current["active_billing_epoch_id"] !== row["billing_epoch_id"] ||
    current["ownership_version"] !== row["ownership_version"] ||
    current["lifecycle_version"] !== row["lifecycle_version"];
  const suspended =
    !terminal &&
    row["environment_name"] === "dev" &&
    (current?.["paid_until"] == null || String(current["paid_until"]) <= now);
  if (!terminal && !current?.["assignment_version"]) fail("assignment_unavailable");
  const update = terminal
    ? `retirement='retired',retirement_request_id='system:scope',token_lookup_sha256=NULL,token_ciphertext=NULL,token_nonce=NULL,token_key_version=NULL`
    : suspended
      ? `retirement='suspended',retirement_request_id='system:entitlement'`
      : `retirement='none',retirement_request_id=NULL,data_environment_id=?5,assignment_version=?6`;
  const statement = db.prepare(
    `UPDATE project_previews SET ${update},state='cold',auth_generation=auth_generation+1,row_version=row_version+1,applied_connection_id=NULL,applied_generation=NULL,applied_sequence=NULL,applied_commit=NULL,backup_handle=NULL,backup_expires_at=NULL,backup_connection_id=NULL,backup_generation=NULL,backup_sequence=NULL,backup_commit=NULL,updated_at=?4 WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3`,
  );
  const updateValues =
    terminal || suspended
      ? [i.previewId, i.runtimeGeneration, i.tokenGeneration, now]
      : [
          i.previewId,
          i.runtimeGeneration,
          i.tokenGeneration,
          now,
          current?.["data_environment_id"],
          current?.["assignment_version"],
        ];
  const checks = [
    previewNativeDrainGuard(db, i.previewId, i.runtimeGeneration, i.tokenGeneration),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement='destroying' AND retirement_request_id=?4 AND backup_handle IS ?5)",
      [
        i.previewId,
        i.runtimeGeneration,
        i.tokenGeneration,
        `system:${reason}`,
        i.deletedBackupHandle,
      ],
    ),
    guard(
      db,
      "precondition_changed",
      "EXISTS(SELECT 1 FROM project_preview_usage_intervals WHERE preview_id=?1 AND state='reserved') OR EXISTS(SELECT 1 FROM project_preview_backup_cleanup WHERE preview_id=?1)",
      [i.previewId],
    ),
  ];
  if (!terminal)
    checks.push(
      guard(
        db,
        "precondition_changed",
        `NOT EXISTS(SELECT 1 FROM projects p JOIN environment_data_assignments a ON a.organization_id=p.organization_id AND a.project_id=p.project_id AND a.environment_id=?3 AND a.assignment_version=?4 AND a.data_environment_id=?5 LEFT JOIN credit_account c ON c.organization_id=p.organization_id WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active' AND p.active_billing_epoch_id=?6 AND p.ownership_version=?7 AND p.lifecycle_version=?8 AND a.assignment_version=(SELECT MAX(a2.assignment_version) FROM environment_data_assignments a2 WHERE a2.organization_id=p.organization_id AND a2.project_id=p.project_id AND a2.environment_id=?3) AND (?9=0 OR c.paid_until>?10))`,
        [
          row["organization_id"],
          row["project_id"],
          row["environment_id"],
          current?.["assignment_version"],
          current?.["data_environment_id"],
          row["billing_epoch_id"],
          row["ownership_version"],
          row["lifecycle_version"],
          suspended ? 0 : row["environment_name"] === "dev" ? 1 : 0,
          now,
        ],
      ),
    );
  await db.batch([
    ...checks,
    statement.bind(...updateValues),
    ...catchUp(db, i.previewId, now),
    db
      .prepare(
        "INSERT INTO project_preview_cleanup_receipts(preview_id,runtime_generation,kind,completed_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(i.previewId, i.runtimeGeneration, reason, now),
  ]);
}
/** After Paid returns, reactivate only the same untouched identity and exact current assignment. */
export async function resumeSuspendedPreview(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        previewId: ulid,
        expectedRowVersion: z.number().int().positive().safe(),
        ...time,
      })
      .parse(raw),
    now = nowOf(i),
    row = await one(context, i.previewId, now),
    db = context.directory;
  if (!row || row["reason"] !== "resume") fail("resume_not_due");
  await db.batch([
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM (${CANDIDATES}) x WHERE x.preview_id=?2 AND x.row_version=?3 AND x.reason='resume' AND x.retirement='suspended')`,
      [now, i.previewId, i.expectedRowVersion],
    ),
    db
      .prepare(
        "UPDATE project_previews SET retirement='none',retirement_request_id=NULL,row_version=row_version+1,updated_at=?2 WHERE preview_id=?1 AND retirement='suspended'",
      )
      .bind(i.previewId, now),
    ...catchUp(db, i.previewId, now),
  ]);
  const state = await getPreviewCleanupState(context, { previewId: i.previewId });
  if (!state) fail("scope_unavailable");
  return state;
}
