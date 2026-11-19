import { z } from "zod";
import type {
  PreviewCapabilityEnvelope,
  PreviewCustomerRecord,
  PreviewRuntimeRecord,
  SourceVersion,
} from "@ohmyhost/contracts/previews";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import { instant, ulid } from "../common.js";
import { handoffAuthorityInput } from "../identity/handoff-effect.js";
import { activeGrantGuard, activeGrantSelect } from "../identity/mcp-sql.js";
import { restrictionAllows } from "../identity/operation-delegations.js";
import { canonicalAuthorizationCondition } from "../projects/customer-projects-access.js";

export const customerScope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environment: z.enum(["dev", "prod"]),
  principalId: z.string().regex(/^user:[A-Za-z0-9_:-]{1,250}$/u),
  delegation: handoffAuthorityInput.optional(),
  now: instant.optional(),
  clock: z.literal("execution").optional(),
});
export const runtimeFence = z.strictObject({
  previewId: ulid,
  runtimeGeneration: z.number().int().positive().safe(),
  tokenGeneration: z.number().int().positive().safe(),
  now: instant.optional(),
  clock: z.literal("execution").optional(),
});
export const sourceVersion = z.strictObject({
  sourceConnectionId: ulid,
  sourceGeneration: z.number().int().positive().safe(),
  sequence: z.number().int().positive().safe(),
  commitSha: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
});
export const envelope = z.strictObject({
  lookupSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
  keyVersion: z.number().int().positive().safe(),
  tokenGeneration: z.number().int().positive().safe(),
});
export const backup = z.strictObject({
  handle: z.string().min(1).max(4096),
  source: sourceVersion,
  expiresAt: instant,
});
export type CustomerScope = z.output<typeof customerScope>;
export type RuntimeFence = z.output<typeof runtimeFence>;
export type PreviewRow = Record<string, unknown>;
export function nowOf(i: { now?: string | undefined; clock?: "execution" | undefined }): string {
  return storedTimestamp(
    i.clock === "execution" || i.now === undefined ? new Date().toISOString() : i.now,
  );
}
export function fail(code: string): never {
  throw new Error(`preview_${code}`);
}
export const SCOPE = `SELECT p.organization_id,p.project_id,p.active_billing_epoch_id billing_epoch_id,
 p.ownership_version,p.lifecycle_version,p.region,e.environment_id,e.name environment_name,
 a.data_environment_id,a.assignment_version,c.paid_until
 FROM projects p JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active' AND o.beta_admitted_at IS NOT NULL
 JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.project_id=p.project_id AND b.ended_at IS NULL
 JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name=?3
 JOIN environment_data_assignments a ON a.organization_id=e.organization_id AND a.project_id=e.project_id AND a.environment_id=e.environment_id
   AND a.assignment_version=(SELECT max(a2.assignment_version) FROM environment_data_assignments a2 WHERE a2.organization_id=e.organization_id AND a2.project_id=e.project_id AND a2.environment_id=e.environment_id)
 LEFT JOIN credit_account c ON c.organization_id=p.organization_id
 WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active'
 AND (e.name='prod' OR (c.paid_until IS NOT NULL AND c.paid_until>?4))`;

const SCOPE_CLEANUP = SCOPE.replace(
  "AND (e.name='prod' OR (c.paid_until IS NOT NULL AND c.paid_until>?4))",
  "AND (?4 IS NOT NULL)",
);
export async function scopeRow(
  db: D1Database,
  i: CustomerScope,
  now: string,
  cleanup = false,
): Promise<PreviewRow> {
  const row = await db
    .prepare(cleanup ? SCOPE_CLEANUP : SCOPE)
    .bind(i.organizationId, i.projectId, i.environment, now)
    .first<PreviewRow>();
  if (!row) fail("scope_unavailable");
  return row;
}
function authorization(
  i: CustomerScope,
  environmentId: string,
  action: "projects:read" | "projects:write",
) {
  const project = canonicalAuthorizationCondition({
    organizationId: i.organizationId,
    projectId: i.projectId,
    principalId: i.principalId,
    action,
  });
  const environment = canonicalAuthorizationCondition({
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId,
    principalId: i.principalId,
    action,
  });
  const shifted = environment.sql.replace(
    /\?(\d+)/gu,
    (_, n: string) => `?${Number(n) + project.params.length}`,
  );
  return {
    sql: `(${project.sql} OR ${shifted})`,
    params: [...project.params, ...environment.params],
  };
}
/** Snapshot authorization plus matching guards to recheck it in the mutation batch. */
export async function customerGuards(
  db: D1Database,
  i: CustomerScope,
  environmentId: string,
  action: "projects:read" | "projects:write",
): Promise<D1PreparedStatement[]> {
  const check = authorization(i, environmentId, action);
  const allowed = await db
    .prepare(`SELECT ${check.sql} allowed`)
    .bind(...check.params)
    .first<{ allowed: number }>();
  const userId = i.principalId.slice(5);
  const revoked = await db
    .prepare(
      "SELECT 1 present FROM revocations r JOIN organizations o ON o.organization_id=?1 WHERE r.kind='user' AND r.resource_id=?2 AND (r.workos_organization_id IS NULL OR r.workos_organization_id=o.workos_organization_id)",
    )
    .bind(i.organizationId, userId)
    .first();
  if (allowed?.allowed !== 1 || revoked) fail("scope_unavailable");
  const guards = [
    guard(db, "consent_changed", `NOT ${check.sql}`, check.params),
    guard(
      db,
      "consent_changed",
      "EXISTS(SELECT 1 FROM revocations r JOIN organizations o ON o.organization_id=?1 WHERE r.kind='user' AND r.resource_id=?2 AND (r.workos_organization_id IS NULL OR r.workos_organization_id=o.workos_organization_id))",
      [i.organizationId, userId],
    ),
  ];
  if (i.delegation) {
    const d = i.delegation;
    if (
      d.action !== action ||
      !restrictionAllows(d.authorizationRestriction, {
        action,
        organizationId: i.organizationId,
        projectId: i.projectId,
      })
    )
      fail("scope_unavailable");
    const identity = {
      organizationId: i.organizationId,
      userId,
      clientId: d.clientId,
      consentHash: d.consentHash,
    };
    const active = await activeGrantSelect(db, identity, i.projectId, false).first<{
      grant_id: string;
    }>();
    if (active?.grant_id !== d.grantId) fail("scope_unavailable");
    guards.push(activeGrantGuard(db, identity, i.projectId, false, d.grantId));
  }
  return guards;
}
export function scopeGuard(
  db: D1Database,
  i: CustomerScope,
  scope: PreviewRow,
  now: string,
  cleanup = false,
): D1PreparedStatement {
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(SELECT 1 FROM (${cleanup ? SCOPE_CLEANUP : SCOPE}) s WHERE s.environment_id=?5 AND s.data_environment_id=?6 AND s.assignment_version=?7 AND s.billing_epoch_id=?8 AND s.ownership_version=?9 AND s.lifecycle_version=?10)`,
    [
      i.organizationId,
      i.projectId,
      i.environment,
      now,
      scope["environment_id"],
      scope["data_environment_id"],
      scope["assignment_version"],
      scope["billing_epoch_id"],
      scope["ownership_version"],
      scope["lifecycle_version"],
    ],
  );
}

export const ROW = `SELECT v.*,lower(hex(v.token_lookup_sha256)) token_hash,p.region,c.paid_until FROM project_previews v
 JOIN projects p ON p.organization_id=v.organization_id AND p.project_id=v.project_id
 LEFT JOIN credit_account c ON c.organization_id=v.organization_id`;
export async function rowById(db: D1Database, id: string): Promise<PreviewRow | null> {
  return db.prepare(`${ROW} WHERE v.preview_id=?1`).bind(id).first<PreviewRow>();
}
export async function rowByScope(
  db: D1Database,
  i: CustomerScope,
  environmentId: string,
): Promise<PreviewRow | null> {
  return db
    .prepare(
      `${ROW} WHERE v.organization_id=?1 AND v.project_id=?2 AND v.environment_id=?3 AND v.retirement<>'retired'`,
    )
    .bind(i.organizationId, i.projectId, environmentId)
    .first<PreviewRow>();
}
function source(r: PreviewRow, prefix: string): SourceVersion | null {
  if (r[`${prefix}_connection_id`] == null) return null;
  return {
    sourceConnectionId: String(r[`${prefix}_connection_id`]),
    sourceGeneration: Number(r[`${prefix}_generation`]),
    sequence: Number(r[`${prefix}_sequence`]),
    commitSha: String(r[`${prefix}_commit`]),
  };
}
export function runtimeRecord(r: PreviewRow): PreviewRuntimeRecord {
  const backupSource = source(r, "backup");
  return {
    previewId: String(r["preview_id"]),
    organizationId: String(r["organization_id"]),
    projectId: String(r["project_id"]),
    environment: r["environment_name"] as "dev" | "prod",
    environmentId: String(r["environment_id"]),
    dataEnvironmentId: String(r["data_environment_id"]),
    assignmentVersion: Number(r["assignment_version"]),
    billingEpochId: String(r["billing_epoch_id"]),
    ownershipVersion: Number(r["ownership_version"]),
    lifecycleVersion: Number(r["lifecycle_version"]),
    region: r["region"] as "eu" | "us",
    rowVersion: Number(r["row_version"]),
    runtimeGeneration: Number(r["runtime_generation"]),
    tokenGeneration: Number(r["token_generation"]),
    authGeneration: Number(r["auth_generation"]),
    state: r["state"] as PreviewRuntimeRecord["state"],
    targetSource: source(r, "target"),
    appliedSource: source(r, "applied"),
    lastActivityAt: String(r["last_activity_at"]),
    paidUntil: r["paid_until"] === null ? null : String(r["paid_until"]),
    retirement: r["retirement"] as PreviewRuntimeRecord["retirement"],
    backup:
      backupSource === null
        ? null
        : {
            handle: String(r["backup_handle"]),
            source: backupSource,
            expiresAt: String(r["backup_expires_at"]),
          },
  };
}
export function customerRecord(r: PreviewRow): PreviewCustomerRecord {
  const runtime = runtimeRecord(r);
  const { backup: _backup, ...preview } = runtime;
  void _backup;
  const capability: PreviewCapabilityEnvelope = {
    lookupSha256: String(r["token_hash"]),
    ciphertext: String(r["token_ciphertext"]),
    nonce: String(r["token_nonce"]),
    keyVersion: Number(r["token_key_version"]),
    tokenGeneration: Number(r["token_generation"]),
  };
  return { preview, capability };
}
/** Exact owner, lifecycle, entitlement and latest physical assignment at execution time. */
export const LIVE_ROW = `EXISTS(SELECT 1 FROM projects p JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active' AND o.beta_admitted_at IS NOT NULL
 JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL
 JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.environment_id=v.environment_id AND e.name=v.environment_name
 JOIN environment_data_assignments a ON a.organization_id=e.organization_id AND a.project_id=e.project_id AND a.environment_id=e.environment_id AND a.assignment_version=v.assignment_version AND a.data_environment_id=v.data_environment_id
 LEFT JOIN credit_account c ON c.organization_id=p.organization_id
 WHERE p.organization_id=v.organization_id AND p.project_id=v.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
 AND p.active_billing_epoch_id=v.billing_epoch_id AND p.ownership_version=v.ownership_version AND p.lifecycle_version=v.lifecycle_version
 AND a.assignment_version=(SELECT max(a2.assignment_version) FROM environment_data_assignments a2 WHERE a2.organization_id=e.organization_id AND a2.project_id=e.project_id AND a2.environment_id=e.environment_id)
 AND (e.name='prod' OR (c.paid_until IS NOT NULL AND c.paid_until>?2)))`;
/** Current selected source connection and unrevoked grant; works for both binding and legacy source. */
export const LIVE_SOURCE = `EXISTS(SELECT 1 FROM repository_grants g JOIN source_connections c ON c.organization_id=g.organization_id AND c.project_id=g.project_id AND c.source_connection_id=g.source_connection_id
 WHERE g.organization_id=v.organization_id AND g.project_id=v.project_id AND g.source_connection_id=v.target_connection_id AND c.billing_epoch_id=v.billing_epoch_id
 AND NOT EXISTS(SELECT 1 FROM repository_grant_revocations r WHERE r.grant_id=g.grant_id)
 AND (EXISTS(SELECT 1 FROM project_source_bindings b WHERE b.organization_id=v.organization_id AND b.project_id=v.project_id AND b.source_connection_id=v.target_connection_id AND b.generation=v.target_generation)
 OR (NOT EXISTS(SELECT 1 FROM project_source_bindings b WHERE b.organization_id=v.organization_id AND b.project_id=v.project_id)
 AND EXISTS(SELECT 1 FROM project_sources s WHERE s.organization_id=v.organization_id AND s.project_id=v.project_id AND s.grant_id=g.grant_id AND s.state='ready' AND s.revision=v.target_generation))))`;
export function runtimeGuard(
  db: D1Database,
  r: PreviewRow,
  now: string,
  sourceRequired: boolean,
): D1PreparedStatement {
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(SELECT 1 FROM project_previews v WHERE v.preview_id=?1 AND ${LIVE_ROW} AND v.retirement='none' AND v.runtime_generation=?3 AND v.token_generation=?4 AND v.row_version=?5${sourceRequired ? ` AND ${LIVE_SOURCE}` : ""})`,
    [r["preview_id"], now, r["runtime_generation"], r["token_generation"], r["row_version"]],
  );
}

/** Security-relevant authority; ordinary activity/expiry updates do not invalidate a read. */
export function previewAuthorityFingerprint(preview: PreviewRuntimeRecord): string {
  return JSON.stringify([
    preview.previewId,
    preview.organizationId,
    preview.projectId,
    preview.environmentId,
    preview.dataEnvironmentId,
    preview.assignmentVersion,
    preview.billingEpochId,
    preview.ownershipVersion,
    preview.lifecycleVersion,
    preview.region,
    preview.runtimeGeneration,
    preview.tokenGeneration,
    preview.authGeneration,
    preview.retirement,
    preview.targetSource,
    preview.appliedSource,
  ]);
}
