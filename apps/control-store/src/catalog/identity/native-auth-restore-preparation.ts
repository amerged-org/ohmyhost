import { z } from "zod";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { guard } from "../../guards.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";
import { handoffAuthorityInput, handoffEffectGuards } from "./handoff-effect.js";
import { readNativeRestoreForSanitization } from "./native-auth-restore.js";

const scope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  restoreId: ulid,
  claimId: z.string().uuid(),
});
const proof = scope.extend({
  targetVersion: z.number().int().positive(),
  registryVersion: z.number().int().positive(),
  schema: z.string(),
  runtimeRole: z.string(),
  migratorRole: z.string(),
  backupRole: z.string(),
  migrationVersion: z.literal(NATIVE_AUTH_SCHEMA_MIGRATION_VERSION),
  migrationDigest: z.literal(NATIVE_AUTH_SCHEMA_MIGRATION_SHA256),
});
const values = (i: z.output<typeof scope>) => [
  i.organizationId,
  i.projectId,
  i.environmentId,
  i.restoreId,
];
const QUERY = `SELECT t.provider_project_id,t.database_id,t.region_id,t.target_version,reg.registry_version,reg.schema_name,reg.role_name,reg.origin_host,restore.principal_id,restore.delegation,rr.revocation_epoch,rr.configuration_revision
 FROM native_auth_restores restore JOIN native_auth_restore_realms rr USING(organization_id,project_id,restore_id)
 JOIN native_auth_realms realm USING(organization_id,project_id,environment_id)
 JOIN projects p ON p.organization_id=restore.organization_id AND p.project_id=restore.project_id
 JOIN native_auth_database_targets t ON t.organization_id=restore.organization_id AND t.project_id=restore.project_id AND t.database_id=restore.database_id AND t.ended_at IS NULL
 JOIN native_auth_registrations reg ON reg.organization_id=rr.organization_id AND reg.project_id=rr.project_id AND reg.environment_id=rr.environment_id AND reg.database_id=t.database_id AND reg.target_version=t.target_version AND reg.state='active'
 WHERE restore.organization_id=?1 AND restore.project_id=?2 AND rr.environment_id=?3 AND restore.restore_id=?4 AND restore.state='restoring' AND p.owner_state='active' AND p.lifecycle_state='active'
 AND realm.enabled=0 AND realm.revocation_epoch=rr.revocation_epoch AND realm.configuration_revision=rr.configuration_revision
 AND EXISTS(SELECT 1 FROM native_auth_restore_imports x WHERE x.organization_id=restore.organization_id AND x.project_id=restore.project_id AND x.restore_id=restore.restore_id)
 AND NOT EXISTS(SELECT 1 FROM native_auth_restore_realms other WHERE other.organization_id=restore.organization_id AND other.project_id=restore.project_id AND other.restore_id=restore.restore_id AND NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements a WHERE a.organization_id=other.organization_id AND a.project_id=other.project_id AND a.restore_id=other.restore_id AND a.environment_id=other.environment_id AND a.kind='offline' AND a.revocation_epoch=other.revocation_epoch AND a.configuration_revision=other.configuration_revision))`;
const conflict = () => new Error("native_restore_preparation_unavailable");

/** Private restore executor reads only the exact offline imported target and role identities. */
export async function readNativeAuthRestorePreparation(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    before = await readNativeRestoreForSanitization(context, i);
  if (!before) return null;
  const { db } = await routeOrganization(context, i.organizationId);
  const [row, environments] = await db.batch([
    db.prepare(QUERY).bind(...values(i)),
    db
      .prepare(
        "SELECT environment_id FROM environments WHERE organization_id=?1 AND project_id=?2 AND name IN('dev','prod') ORDER BY environment_id",
      )
      .bind(i.organizationId, i.projectId),
  ]);
  const r = row?.results[0];
  if (
    !r ||
    row?.results.length !== 1 ||
    !environments ||
    environments.results.length < 1 ||
    environments.results.length > 2 ||
    !(await readNativeRestoreForSanitization(context, i))
  )
    return null;
  const environmentIds = environments.results.map((item) => ulid.parse(item["environment_id"]));
  const schema = `omh_auth_${i.environmentId.toLowerCase()}`,
    runtimeRole = `omh_ar_${i.environmentId.toLowerCase()}`;
  if (
    r["schema_name"] !== schema ||
    r["role_name"] !== runtimeRole ||
    (r["region_id"] !== "us-dev" && r["region_id"] !== "eu-dev")
  )
    throw conflict();
  return {
    ...i,
    providerProjectId: String(r["provider_project_id"]),
    databaseId: String(r["database_id"]),
    regionId: r["region_id"],
    originHost: String(r["origin_host"]),
    targetVersion: Number(r["target_version"]),
    registryVersion: Number(r["registry_version"]),
    schema,
    runtimeRole,
    migratorRole: `omh_am_${i.environmentId.toLowerCase()}`,
    backupRole: `omh_ab_${i.projectId.toLowerCase()}`,
    environmentIds,
    revocationEpoch: Number(r["revocation_epoch"]),
    configurationRevision: Number(r["configuration_revision"]),
  };
}

/** Only the private Neon restore executor may attest after migration and actual PG ACL readback. */
export async function recordNativeAuthRestoreVerification(context: CatalogContext, raw: unknown) {
  const i = proof.parse(raw),
    current = await readNativeAuthRestorePreparation(context, {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: i.environmentId,
      restoreId: i.restoreId,
      claimId: i.claimId,
    });
  if (
    !current ||
    current.targetVersion !== i.targetVersion ||
    current.registryVersion !== i.registryVersion ||
    current.schema !== i.schema ||
    current.runtimeRole !== i.runtimeRole ||
    current.migratorRole !== i.migratorRole ||
    current.backupRole !== i.backupRole
  )
    throw conflict();
  const { db } = await routeOrganization(context, i.organizationId);
  const owner = await db
    .prepare(
      "SELECT principal_id,delegation FROM native_auth_restores WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='restoring'",
    )
    .bind(i.organizationId, i.projectId, i.restoreId)
    .first<{ principal_id: string; delegation: string | null }>();
  if (!owner) throw conflict();
  const authority = {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    principalId: owner.principal_id,
    action: "auth:manage" as const,
  };
  const delegation =
    owner.delegation === null
      ? undefined
      : handoffAuthorityInput.parse(JSON.parse(owner.delegation));
  await db.batch([
    canonicalAuthorizationGuard(db, authority),
    ...(delegation === undefined
      ? []
      : handoffEffectGuards(db, { ...authority, authority: delegation })),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs j JOIN native_auth_restore_claims c USING(organization_id,project_id,restore_id) WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND j.claim_id=?4 AND j.state='consumed' AND c.claim_id=j.claim_id AND c.input_generation=j.input_generation)`,
      [i.organizationId, i.projectId, i.restoreId, i.claimId],
    ),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM (${QUERY}) r WHERE r.target_version=?5 AND r.registry_version=?6 AND r.schema_name=?7 AND r.role_name=?8 AND r.principal_id=?9 AND r.delegation IS ?10 AND r.revocation_epoch=?11 AND r.configuration_revision=?12)`,
      [
        ...values(i),
        i.targetVersion,
        i.registryVersion,
        i.schema,
        i.runtimeRole,
        owner.principal_id,
        owner.delegation,
        current.revocationEpoch,
        current.configurationRevision,
      ],
    ),
    db
      .prepare(
        `INSERT INTO native_auth_restore_verifications(organization_id,project_id,restore_id,environment_id,target_version,registry_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version,verified_at) VALUES(?1,?2,?4,?3,?5,?6,?7,?8,?9,?10,?11,?12,strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') ON CONFLICT DO NOTHING`,
      )
      .bind(
        ...values(i),
        i.targetVersion,
        i.registryVersion,
        i.schema,
        i.runtimeRole,
        i.migratorRole,
        i.backupRole,
        i.migrationDigest,
        i.migrationVersion,
      ),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_restore_verifications WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND restore_id=?4 AND target_version=?5 AND registry_version=?6 AND schema_name=?7 AND runtime_role=?8 AND migrator_role=?9 AND backup_role=?10 AND migration_digest=?11 AND migration_version=?12)`,
      [
        ...values(i),
        i.targetVersion,
        i.registryVersion,
        i.schema,
        i.runtimeRole,
        i.migratorRole,
        i.backupRole,
        i.migrationDigest,
        i.migrationVersion,
      ],
    ),
  ]);
  return { status: "verified" as const };
}
