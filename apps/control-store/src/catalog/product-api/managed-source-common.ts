import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";
import { restrictionAllows } from "../identity/operation-delegations.js";
import {
  authorizationRestrictionInput,
  delegationActionInput,
} from "../identity/authorization-restriction.js";
import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { BARRIER_FREE_MEMBERSHIP_SQL } from "../identity/membership-barrier-sql.js";
import { instant, ulid } from "../common.js";
import { readContextSnapshot } from "../provisioning/context-queries.js";
import { integer, iso, text, type Row } from "../provisioning/context-values.js";
import {
  activeGrantGuard,
  activeGrantSelect,
  type McpConsentIdentity,
} from "../identity/mcp-sql.js";
export const managedScopeInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  principalId: z.string().regex(/^user:[A-Za-z0-9_:-]{1,250}$/u),
});
export const managedPublicationInput = managedScopeInput.extend({ operationId: ulid });
export const managedWriteInput = managedPublicationInput.extend({
  now: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
    .pipe(instant),
});
export type ManagedScope = z.output<typeof managedScopeInput>;
export type ManagedPublicationScope = z.output<typeof managedPublicationInput>;
export const managedDelegationInput = z.strictObject({
  grantId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  clientId: z.string(),
  consentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  action: delegationActionInput,
  authorizationRestriction: authorizationRestrictionInput.optional(),
});
export type ManagedDelegation = z.output<typeof managedDelegationInput>;
export function managedConflict(kind: string): never {
  throw new Error(`managed_source_${kind}`);
}
export const MANAGED_AUTH = `SELECT g.role,m.role membership_role FROM local_authorization_grants g
 JOIN organization_memberships m ON m.organization_id=g.organization_id AND('user:'||m.workos_user_id)=g.principal_id AND m.state='active'
 JOIN organizations o ON o.organization_id=g.organization_id AND o.state='active' AND o.beta_admitted_at IS NOT NULL
 JOIN projects p ON p.organization_id=g.organization_id AND p.project_id=?2
 JOIN billing_epochs e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.billing_epoch_id=p.active_billing_epoch_id AND e.ended_at IS NULL
 WHERE g.organization_id=?1 AND g.principal_kind='user' AND g.principal_id=?3 AND g.revoked_at IS NULL AND ${BARRIER_FREE_MEMBERSHIP_SQL}
 AND((g.project_id IS NULL AND g.environment_id IS NULL) OR(g.project_id=?2 AND g.environment_id IS NULL AND g.ownership_version=p.ownership_version AND g.billing_epoch_id=p.active_billing_epoch_id))
 ORDER BY g.project_id NULLS LAST,g.created_at DESC,g.grant_id DESC LIMIT 3`;
export const MANAGED_OWNER = `SELECT p.active_billing_epoch_id,p.ownership_version,p.owner_state,p.lifecycle_state,p.region,e.environment_id
 FROM projects p LEFT JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name=CASE WHEN EXISTS(SELECT 1 FROM environments preferred WHERE preferred.organization_id=p.organization_id AND preferred.project_id=p.project_id AND preferred.name='dev') THEN 'dev' ELSE 'prod' END
 WHERE p.organization_id=?1 AND p.project_id=?2`;
export const MANAGED_BINDING = `SELECT binding.provider,binding.source_connection_id,binding.generation,binding.commit_sha,grant_record.repository_owner namespace,grant_record.repository_name,connection.created_at linked_at,binding.updated_at,
 NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id) grant_active
 FROM project_source_bindings binding JOIN source_connections connection USING(organization_id,project_id,source_connection_id)
 JOIN repository_grants grant_record USING(organization_id,project_id,source_connection_id)
 WHERE binding.organization_id=?1 AND binding.project_id=?2 AND connection.billing_epoch_id=(SELECT active_billing_epoch_id FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active')
 UNION ALL SELECT source.provider,grant_record.source_connection_id,source.revision,NULL,source.repository_owner,source.repository_name,source.created_at,source.updated_at,
 NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id)
 FROM project_sources source JOIN repository_grants grant_record USING(organization_id,project_id,grant_id)
 WHERE source.organization_id=?1 AND source.project_id=?2 AND source.state='ready' AND source.billing_epoch_id=(SELECT active_billing_epoch_id FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active')
 AND NOT EXISTS(SELECT 1 FROM project_source_bindings WHERE organization_id=?1 AND project_id=?2) ORDER BY updated_at DESC LIMIT 1`;
export const MANAGED_PUBLICATION = `SELECT publication.*,repository.namespace,repository.repository_name FROM managed_source_publications publication
 JOIN managed_source_repositories repository USING(organization_id,project_id,source_connection_id)
 JOIN projects p ON p.organization_id=publication.organization_id AND p.project_id=publication.project_id
 WHERE publication.organization_id=?1 AND publication.project_id=?2 AND publication.operation_id=?3 AND publication.principal_id=?4 AND publication.billing_epoch_id=p.active_billing_epoch_id`;
export const MANAGED_BLOBS = `SELECT blob.* FROM managed_source_blobs blob JOIN(${MANAGED_PUBLICATION}) publication ON publication.operation_id=blob.operation_id ORDER BY blob.path COLLATE BINARY`;
export const MANAGED_RESERVATIONS = `SELECT reservation.* FROM managed_source_reservations reservation JOIN(${MANAGED_PUBLICATION}) publication ON publication.operation_id=reservation.operation_id ORDER BY reservation.path COLLATE BINARY`;
export const MANAGED_OTHER_OPERATION = `SELECT 1 present FROM operations WHERE organization_id=?1 AND project_id=?2 AND operation_id<>?3 AND state IN('queued','running')
 UNION ALL SELECT 1 FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND operation_id<>?3
 UNION ALL SELECT 1 FROM managed_source_publications WHERE organization_id=?1 AND project_id=?2 AND operation_id<>?3 AND state IN('staging','sealed') LIMIT 1`;
export interface ManagedSnapshot {
  readonly scope: ManagedScope;
  readonly auth: Row[];
  readonly owner: Row | null;
  readonly binding: Row | null;
  readonly publication: Row | null;
  readonly blobs: Row[];
  readonly reservations: Row[];
  readonly busy: boolean;
  readonly revoked: boolean;
}
export function managedAuthorized(s: ManagedSnapshot, write: boolean): boolean {
  const first = s.auth[0];
  return (
    first !== undefined &&
    s.auth.length <= 2 &&
    s.auth.every(
      (r) =>
        r["role"] === first["role"] &&
        (r["role"] === "owner"
          ? ["admin", "owner"].includes(String(r["membership_role"]))
          : r["role"] === "member" && r["membership_role"] === "member"),
    ) &&
    (!write || first["role"] === "owner") &&
    !s.revoked &&
    s.owner?.["owner_state"] === "active" &&
    s.owner["lifecycle_state"] === "active"
  );
}
export async function readManagedSnapshot(
  db: D1Database,
  raw: unknown,
  operationId?: string,
): Promise<ManagedSnapshot> {
  const i = managedScopeInput.parse(raw),
    s = [i.organizationId, i.projectId],
    operation = operationId ?? "00000000000000000000000000";
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await readContextSnapshot(db, [
      { sql: MANAGED_AUTH, parameters: [...s, i.principalId] },
      { sql: MANAGED_OWNER, parameters: s },
      { sql: MANAGED_BINDING, parameters: s },
      { sql: MANAGED_PUBLICATION, parameters: [...s, operation, i.principalId] },
      {
        sql: operationId === undefined ? "SELECT 1 WHERE 0" : MANAGED_BLOBS,
        parameters: operationId === undefined ? [] : [...s, operation, i.principalId],
      },
      {
        sql: operationId === undefined ? "SELECT 1 WHERE 0" : MANAGED_RESERVATIONS,
        parameters: operationId === undefined ? [] : [...s, operation, i.principalId],
      },
      { sql: MANAGED_OTHER_OPERATION, parameters: [...s, operation] },
      {
        sql: "SELECT 1 revoked FROM revocations terminal JOIN organizations o ON o.organization_id=?1 WHERE terminal.kind='user' AND terminal.resource_id=?2 AND(terminal.workos_organization_id IS NULL OR terminal.workos_organization_id=o.workos_organization_id)",
        parameters: [i.organizationId, i.principalId.slice(5)],
      },
    ]);
    if (rows === null) continue;
    if ((rows[1]?.length ?? 0) > 1 || (rows[2]?.length ?? 0) > 1 || (rows[3]?.length ?? 0) > 1)
      throw new TypeError("Managed source snapshot is ambiguous");
    return {
      scope: i,
      auth: rows[0] ?? [],
      owner: rows[1]?.[0] ?? null,
      binding: rows[2]?.[0] ?? null,
      publication: rows[3]?.[0] ?? null,
      blobs: rows[4] ?? [],
      reservations: rows[5] ?? [],
      busy: (rows[6]?.length ?? 0) > 0,
      revoked: (rows[7]?.length ?? 0) > 0,
    };
  }
  throw new Error("Managed source snapshot changed repeatedly");
}
export function managedAuthorityGuards(
  db: D1Database,
  s: ManagedSnapshot,
  write: boolean,
): D1PreparedStatement[] {
  if (!managedAuthorized(s, write)) managedConflict("scope");
  const i = s.scope,
    owner = s.owner;
  if (owner === null) managedConflict("scope");
  const allowed = `SELECT 1 FROM(${MANAGED_AUTH}) GROUP BY 1 HAVING count(*) BETWEEN 1 AND 2 AND min(role)=max(role)
 AND sum(CASE WHEN(role='owner' AND membership_role IN('admin','owner'))OR(role='member' AND membership_role='member')THEN 1 ELSE 0 END)=count(*)${write ? " AND min(role)='owner'" : ""}`;
  return [
    guard(db, "precondition_changed", `NOT EXISTS(${allowed})`, [
      i.organizationId,
      i.projectId,
      i.principalId,
    ]),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND active_billing_epoch_id=?3 AND ownership_version=?4 AND owner_state='active' AND lifecycle_state='active')",
      [i.organizationId, i.projectId, owner["active_billing_epoch_id"], owner["ownership_version"]],
    ),
  ];
}
export function managedBindingOf(r: Row | null) {
  return r === null
    ? null
    : {
        provider: z.enum(["github", "managed"]).parse(r["provider"]),
        sourceConnectionId: text(r, "source_connection_id"),
        generation: integer(r["generation"], 1),
        commitSha: r["commit_sha"] === null ? null : text(r, "commit_sha"),
        namespace: text(r, "namespace"),
        repositoryName: text(r, "repository_name"),
        status: r["grant_active"] === 1 ? ("ready" as const) : ("revoked" as const),
        linkedAt: iso(r["linked_at"]),
        updatedAt: iso(r["updated_at"]),
      };
}
export function managedDelegationOf(
  r: Row | null,
  historicalAction: "projects:create" | "sources:link" = "sources:link",
): ManagedDelegation | null {
  if (r === null || r["delegation_grant_id"] === null) return null;
  return managedDelegationInput.parse({
    grantId: r["delegation_grant_id"],
    clientId: r["delegation_client_id"],
    consentHash: r["delegation_consent_sha256"],
    action: r["delegation_action"] ?? historicalAction,
    ...(r["delegation_restriction"] == null
      ? {}
      : { authorizationRestriction: JSON.parse(String(r["delegation_restriction"])) }),
  });
}
export function managedBlobOf(r: Row) {
  return {
    path: text(r, "path"),
    sha256: text(r, "sha256"),
    byteLength: integer(r["byte_length"]),
    executable: r["executable"] === 1,
    bucket: text(r, "bucket"),
    key: text(r, "object_key"),
    versionId: text(r, "version_id"),
    eTag: text(r, "etag"),
  };
}
export function managedPublicationOf(s: ManagedSnapshot) {
  const r = s.publication;
  if (r === null) return null;
  return {
    operationId: text(r, "operation_id"),
    sourceConnectionId: text(r, "source_connection_id"),
    mode: z.enum(["initialize", "commit", "switch"]).parse(r["mode"]),
    state: z.enum(["staging", "sealed", "committed", "failed"]).parse(r["state"]),
    expectedSourceConnectionId:
      r["expected_source_connection_id"] === null ? null : text(r, "expected_source_connection_id"),
    expectedSourceGeneration: integer(r["expected_source_generation"]),
    expectedManagedCommit:
      r["expected_managed_commit"] === null ? null : text(r, "expected_managed_commit"),
    manifestDigest: r["manifest_sha256"] === null ? null : text(r, "manifest_sha256"),
    commitSha: r["commit_sha"] === null ? null : text(r, "commit_sha"),
    treeSha: r["tree_sha"] === null ? null : text(r, "tree_sha"),
    namespace: text(r, "namespace"),
    repositoryName: text(r, "repository_name"),
    message: text(r, "message"),
    files:
      r["manifest"] === null
        ? []
        : (JSON.parse(text(r, "manifest")) as {
            path: string;
            sha256: string;
            byteLength: number;
            executable: boolean;
          }[]),
    blobs: s.blobs.map(managedBlobOf),
    createdAt: iso(r["created_at"]),
    expiresAt: iso(r["expires_at"]),
    errorCode: r["error_code"] === null ? null : text(r, "error_code"),
    delegation: managedDelegationOf(r),
  };
}
export function managedBindingGuards(db: D1Database, s: ManagedSnapshot): D1PreparedStatement[] {
  const i = s.scope,
    r = s.binding;
  return [
    guard(
      db,
      "precondition_changed",
      r === null
        ? `EXISTS(SELECT 1 FROM(${MANAGED_BINDING}))`
        : `NOT EXISTS(SELECT 1 FROM(${MANAGED_BINDING}) current WHERE provider=?3 AND source_connection_id=?4 AND generation=?5 AND commit_sha IS ?6 AND namespace=?7 AND repository_name=?8 AND grant_active=?9 AND linked_at=?10 AND updated_at=?11)`,
      r === null
        ? [i.organizationId, i.projectId]
        : [
            i.organizationId,
            i.projectId,
            r["provider"],
            r["source_connection_id"],
            r["generation"],
            r["commit_sha"],
            r["namespace"],
            r["repository_name"],
            r["grant_active"],
            r["linked_at"],
            r["updated_at"],
          ],
    ),
  ];
}
export function managedPublicationGuards(
  db: D1Database,
  s: ManagedSnapshot,
): D1PreparedStatement[] {
  const r = s.publication;
  if (r === null) managedConflict("scope");
  const keys = [
    "billing_epoch_id",
    "principal_id",
    "source_connection_id",
    "mode",
    "expected_source_connection_id",
    "expected_source_generation",
    "expected_managed_commit",
    "state",
    "manifest_sha256",
    "commit_sha",
    "tree_sha",
    "error_code",
    "updated_at",
    "delegation_grant_id",
    "delegation_client_id",
    "delegation_consent_sha256",
    "delegation_action",
    "delegation_restriction",
  ];
  return [
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM managed_source_publications WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND ${keys.map((k, n) => `${k} IS ?${n + 4}`).join(" AND ")})`,
      [s.scope.organizationId, s.scope.projectId, r["operation_id"], ...keys.map((k) => r[k])],
    ),
  ];
}
function consent(i: ManagedScope, d: ManagedDelegation): McpConsentIdentity {
  return {
    organizationId: i.organizationId,
    userId: i.principalId.slice(5),
    clientId: d.clientId,
    consentHash: d.consentHash,
  };
}
export async function managedDelegationGuards(
  db: D1Database,
  s: ManagedSnapshot,
  d: ManagedDelegation | null,
  initial?: { mode: string; sourceConnectionId: string },
): Promise<D1PreparedStatement[]> {
  if (d === null) return [];
  const creation = d.action === "projects:create";
  if (s.revoked || (!creation && d.action !== "sources:link")) managedConflict("scope");
  const scope = {
    action: d.action,
    organizationId: s.scope.organizationId,
    ...(creation ? {} : { projectId: s.scope.projectId }),
  };
  if (!restrictionAllows(d.authorizationRestriction, scope)) managedConflict("scope");
  const who = consent(s.scope, d);
  const row = await activeGrantSelect(db, who, s.scope.projectId, false).first<{
    grant_id: string;
  }>();
  if (row?.grant_id !== d.grantId) managedConflict("scope");
  const guards = [
    canonicalAuthorizationGuard(db, {
      organizationId: s.scope.organizationId,
      principalId: s.scope.principalId,
      action: d.action,
      ...(creation ? {} : { projectId: s.scope.projectId }),
    }),
    activeGrantGuard(db, who, s.scope.projectId, false, d.grantId),
  ];
  if (creation) {
    const mode = initial?.mode ?? s.publication?.["mode"];
    const sourceId = initial?.sourceConnectionId ?? s.publication?.["source_connection_id"];
    if (mode !== "initialize" || typeof sourceId !== "string") managedConflict("scope");
    const cap =
      d.authorizationRestriction === undefined ? null : JSON.stringify(d.authorizationRestriction);
    const sql = `SELECT delegation_grant_id FROM managed_source_initializations WHERE organization_id=?1 AND project_id=?2 AND source_connection_id=?3 AND principal_id=?4
      AND delegation_client_id=?5 AND delegation_consent_sha256=?6 AND COALESCE(delegation_action,'projects:create')='projects:create' AND delegation_restriction IS ?7
      AND state IN ('queued','initializing','initialized','failed')`;
    const values = [
      s.scope.organizationId,
      s.scope.projectId,
      sourceId,
      s.scope.principalId,
      d.clientId,
      d.consentHash,
      cap,
    ];
    const recipe = await db
      .prepare(sql)
      .bind(...values)
      .first<{ delegation_grant_id: string }>();
    if (!recipe?.delegation_grant_id) managedConflict("scope");
    guards.push(
      guard(db, "consent_changed", `NOT EXISTS (${sql} AND delegation_grant_id=?8)`, [
        ...values,
        recipe.delegation_grant_id,
      ]),
    );
    guards.push(activeGrantGuard(db, who, null, false, recipe.delegation_grant_id));
  }
  return guards;
}
export function managedNoOtherGuard(db: D1Database, i: ManagedPublicationScope) {
  return guard(db, "precondition_changed", `EXISTS(${MANAGED_OTHER_OPERATION})`, [
    i.organizationId,
    i.projectId,
    i.operationId,
  ]);
}
export function managedWritable(
  s: ManagedSnapshot,
  now: string,
  expected: "staging" | "sealed",
  expiry = true,
): void {
  if (!managedAuthorized(s, true) || s.publication === null) managedConflict("scope");
  if (s.publication["state"] !== expected) managedConflict("state");
  if (expiry && String(s.publication["expires_at"]) <= now) managedConflict("expired");
}

/** Exact whole-set guard split into bounded128-row vectors inside the SAME parent batch. */
export function managedRowsGuards(
  db: D1Database,
  sql: typeof MANAGED_BLOBS | typeof MANAGED_RESERVATIONS,
  i: ManagedPublicationScope,
  rows: readonly Row[],
  keys: readonly string[],
): D1PreparedStatement[] {
  const fixed = [i.organizationId, i.projectId, i.operationId, i.principalId];
  const guards = [
    guard(db, "precondition_changed", `(SELECT count(*) FROM(${sql}))<>?5`, [
      ...fixed,
      rows.length,
    ]),
  ];
  for (let offset = 0; offset < rows.length; offset += 128) {
    guards.push(
      guard(
        db,
        "precondition_changed",
        `EXISTS(SELECT 1 FROM json_each(?5) expected WHERE NOT EXISTS(SELECT 1 FROM(${sql}) current WHERE ${keys.map((k) => `current.${k} IS json_extract(expected.value,'$.${k}')`).join(" AND ")}))`,
        [...fixed, JSON.stringify(rows.slice(offset, offset + 128))],
      ),
    );
  }
  return guards;
}
