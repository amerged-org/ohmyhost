import { assertNativeAuthLaunchAllowed } from "./native-auth-launch-policy.js";
import { z } from "zod";
import { readPgcfPostgresTarget } from "@ohmyhost/database/worker-postgres-targets";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { guard } from "../../guards.js";
import type { D1Database } from "../../d1-types.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { nativeAuthEffectGuards } from "./native-auth-resource-operations.js";

const receipt = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  claimId: ulid,
  providerProjectId: z.string().regex(/^prj_[a-z0-9]{20}$/u),
  databaseId: z.string().regex(/^[a-z][a-z0-9]{19}$/u),
  regionId: z.enum(["us-dev", "eu-dev"]),
  originHost: z.string(),
  schema: z.string(),
  role: z.string(),
  targetVersion: z.number().int().positive().max(2_147_483_647),
  registryVersion: z.number().int().positive().max(2_147_483_647),
  registryReference: z.string(),
  status: z.literal("active"),
});
type Receipt = z.output<typeof receipt>;
const scope = z.strictObject({ projectId: ulid, environmentId: ulid });
const fail = () => new Error("native_auth_registration_conflict");
function parse(value: unknown): Receipt {
  const i = receipt.parse(value);
  if (
    i.schema !== `omh_auth_${i.environmentId.toLowerCase()}` ||
    i.role !== `omh_ar_${i.environmentId.toLowerCase()}` ||
    i.registryReference !== `${i.projectId}:${i.environmentId}`
  )
    throw fail();
  readPgcfPostgresTarget({
    provider: "pgcf",
    host: i.originHost,
    databaseId: i.databaseId,
    role: i.role,
  });
  return i;
}
const values = (i: Receipt) => [
  i.organizationId,
  i.projectId,
  i.environmentId,
  i.operationId,
  i.claimId,
  i.providerProjectId,
  i.databaseId,
  i.regionId,
  i.originHost,
  i.schema,
  i.role,
  i.targetVersion,
  i.registryVersion,
  i.registryReference,
];
const exact = `organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND provider_project_id=?6 AND database_id=?7 AND region_id=?8 AND origin_host=?9 AND schema_name=?10 AND role_name=?11 AND target_version=?12 AND registry_version=?13 AND registry_reference=?14`;
const target = `EXISTS(SELECT 1 FROM native_auth_database_targets t WHERE t.organization_id=?1 AND t.project_id=?2 AND t.provider_project_id=?6 AND t.database_id=?7 AND t.region_id=?8 AND t.target_version=?12 AND t.ended_at IS NULL)`;
const readyRoles = `NOT EXISTS(SELECT 1 FROM (SELECT ?11 AS role_name UNION ALL SELECT 'omh_am_'||lower(?3) UNION ALL SELECT 'omh_ab_'||lower(?2)) needed WHERE NOT EXISTS(SELECT 1 FROM native_auth_role_operations r WHERE r.organization_id=?1 AND r.project_id=?2 AND (r.environment_id=?3 OR needed.role_name='omh_ab_'||lower(?2)) AND r.provider_project_id=?6 AND r.database_id=?7 AND r.role_name=needed.role_name AND r.state='succeeded'))`;
const prepared = `EXISTS(SELECT 1 FROM native_auth_preparation_receipts p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.environment_id=?3 AND p.operation_id=?4 AND p.claim_id=?5 AND p.provider_project_id=?6 AND p.database_id=?7 AND p.target_version=?12 AND p.schema_name=?10 AND p.runtime_role=?11 AND p.migrator_role='omh_am_'||lower(?3) AND p.backup_role='omh_ab_'||lower(?2) AND p.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND p.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}')`;

const generationScope = receipt.pick({
  organizationId: true,
  projectId: true,
  environmentId: true,
  operationId: true,
  claimId: true,
  providerProjectId: true,
  databaseId: true,
  regionId: true,
  targetVersion: true,
});

/** Trusted logical realms for checking private database privileges; never supplied by the app. */
export async function readNativeAuthDatabaseEnvironments(context: CatalogContext, raw: unknown) {
  const i = receipt
    .pick({
      organizationId: true,
      projectId: true,
      environmentId: true,
      operationId: true,
      claimId: true,
    })
    .parse(raw);
  const { db } = await routeOrganization(context, i.organizationId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  const result = await db.batch([
    ...guards,
    db
      .prepare(
        `SELECT environment_id FROM environments WHERE organization_id=?1 AND project_id=?2 AND name IN('dev','prod') ORDER BY environment_id`,
      )
      .bind(i.organizationId, i.projectId),
  ]);
  const environmentIds = (result.at(-1)?.results ?? []).map((row) =>
    ulid.parse(row["environment_id"]),
  );
  if (
    environmentIds.length < 1 ||
    environmentIds.length > 2 ||
    !environmentIds.includes(i.environmentId)
  )
    throw fail();
  return { environmentIds };
}

/** Read the original reserved generation on retry, or the next generation before reservation. */
export async function resolveNativeAuthRegistrationGeneration(
  context: CatalogContext,
  raw: unknown,
) {
  const i = generationScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  const v = [
    i.organizationId,
    i.projectId,
    i.environmentId,
    i.operationId,
    i.claimId,
    i.providerProjectId,
    i.databaseId,
    i.regionId,
    i.targetVersion,
  ];
  const result = await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_database_targets WHERE organization_id=?1 AND project_id=?2 AND provider_project_id=?6 AND database_id=?7 AND region_id=?8 AND target_version=?9 AND ended_at IS NULL)`,
      v,
    ),
    db
      .prepare(
        `SELECT registry_version,claim_id,provider_project_id,database_id,region_id,target_version,state FROM native_auth_registrations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 ORDER BY registry_version DESC`,
      )
      .bind(...v.slice(0, 4)),
    db
      .prepare(
        `SELECT 1+COALESCE(MAX(generation),0) AS next FROM (SELECT registry_version AS generation FROM native_auth_registrations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 UNION ALL SELECT next_registry_version AS generation FROM native_auth_registration_revocations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3)`,
      )
      .bind(...v.slice(0, 3)),
  ]);
  const prior = result.at(-2)?.results ?? [];
  if (prior.length > 1) throw fail();
  const row = prior[0];
  if (
    row &&
    (row["claim_id"] !== i.claimId ||
      row["provider_project_id"] !== i.providerProjectId ||
      row["database_id"] !== i.databaseId ||
      row["region_id"] !== i.regionId ||
      row["target_version"] !== i.targetVersion ||
      row["state"] === "revoked")
  )
    throw fail();
  const registryVersion = Number(row?.["registry_version"] ?? result.at(-1)?.results[0]?.["next"]);
  if (
    !Number.isSafeInteger(registryVersion) ||
    registryVersion < 1 ||
    registryVersion > 2_147_483_647
  )
    throw fail();
  return { registryVersion, registryReference: `${i.projectId}:${i.environmentId}` };
}

/** Reserve the exact provider target and original accepted claim before sending credentials. */
export async function reserveNativeAuthRegistration(context: CatalogContext, raw: unknown) {
  const i = parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = values(i);
  assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT (${target}) OR NOT (${readyRoles}) OR NOT (${prepared})`,
      v.slice(0, 12),
    ),
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM native_auth_registrations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND registry_version=?13 AND NOT (${exact})) OR (NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE ${exact}) AND ?13<>1+COALESCE((SELECT MAX(generation) FROM (SELECT registry_version AS generation FROM native_auth_registrations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 UNION ALL SELECT next_registry_version AS generation FROM native_auth_registration_revocations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3)),0))`,
      v,
    ),
    db
      .prepare(
        `INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'reserved') ON CONFLICT DO NOTHING`,
      )
      .bind(...v),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE ${exact} AND state IN ('reserved','active'))`,
      v,
    ),
  ]);
  return i;
}

/** A retry can resolve its reserved or already confirmed receipt, only while the claim is live. */
export async function authorizeNativeAuthRegistration(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = values(i);
  assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT (${target}) OR NOT (${readyRoles}) OR NOT (${prepared}) OR NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE ${exact} AND state IN ('reserved','active'))`,
      v,
    ),
  ]);
  return true;
}

/** Confirm after the registry's exact metadata-only receipt; replay never rewrites an active row. */
export async function confirmNativeAuthRegistration(context: CatalogContext, raw: unknown) {
  const i = parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = values(i);
  assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT (${target}) OR NOT (${readyRoles}) OR NOT (${prepared}) OR NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE ${exact} AND state IN ('reserved','active'))`,
      v,
    ),
    db
      .prepare(
        `UPDATE native_auth_registrations SET state='active' WHERE ${exact} AND state='reserved'`,
      )
      .bind(...v),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE ${exact} AND state='active')`,
      v,
    ),
  ]);
  return i;
}

/** The exact registration query can participate in a caller-owned fenced transaction. */
export function nativeRegistrationStatement(
  db: D1Database,
  projectId: string,
  environmentId: string,
) {
  return db
    .prepare(
      `SELECT r.* FROM native_auth_registrations r JOIN projects p ON p.organization_id=r.organization_id AND p.project_id=r.project_id JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active' JOIN environments e ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND e.environment_id=r.environment_id JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL JOIN native_auth_database_targets t ON t.organization_id=r.organization_id AND t.project_id=r.project_id AND t.target_version=r.target_version AND t.provider_project_id=r.provider_project_id AND t.database_id=r.database_id AND t.region_id=r.region_id AND t.ended_at IS NULL WHERE r.project_id=?1 AND r.environment_id=?2 AND r.state='active' AND p.owner_state='active' AND p.lifecycle_state='active' AND EXISTS(SELECT 1 FROM native_auth_preparation_receipts q WHERE q.organization_id=r.organization_id AND q.project_id=r.project_id AND q.environment_id=r.environment_id AND q.operation_id=r.operation_id AND q.claim_id=r.claim_id AND q.provider_project_id=r.provider_project_id AND q.database_id=r.database_id AND q.target_version=r.target_version AND q.schema_name=r.schema_name AND q.runtime_role=r.role_name AND q.migrator_role='omh_am_'||lower(r.environment_id) AND q.backup_role='omh_ab_'||lower(r.project_id) AND q.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND q.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}')`,
    )
    .bind(projectId, environmentId);
}

export function nativeRegistrationFromRow(r: Record<string, unknown>): Receipt {
  return parse({
    organizationId: r["organization_id"],
    projectId: r["project_id"],
    environmentId: r["environment_id"],
    operationId: r["operation_id"],
    claimId: r["claim_id"],
    providerProjectId: r["provider_project_id"],
    databaseId: r["database_id"],
    regionId: r["region_id"],
    originHost: r["origin_host"],
    schema: r["schema_name"],
    role: r["role_name"],
    targetVersion: r["target_version"],
    registryVersion: r["registry_version"],
    registryReference: r["registry_reference"],
    status: "active",
  });
}

/** Reads the current active registration under the current owner and exact active database target. */
export async function readNativeAuthRegistration(
  context: CatalogContext,
  raw: unknown,
): Promise<Receipt | null> {
  const i = scope.parse(raw);
  const query = () =>
    nativeRegistrationStatement(context.directory, i.projectId, i.environmentId).all<
      Record<string, unknown>
    >();
  const rows = (await query()).results;
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) throw fail();
  const r = rows[0];
  await context.router.routeOrganization(String(r["organization_id"]));
  const current = (await query()).results;
  if (current.length !== 1 || JSON.stringify(current[0]) !== JSON.stringify(r)) throw fail();
  return nativeRegistrationFromRow(r);
}

/** Fences the old receipt in Core before the private registry removes its credential. */
const revocation = z.strictObject({
  receipt,
  operationId: ulid,
  claimId: ulid,
  registryVersion: z.number().int().positive().max(2_147_483_647),
});
function revocationInput(raw: unknown) {
  const request = revocation.parse(raw),
    i = parse(request.receipt);
  if (request.registryVersion !== i.registryVersion + 1) throw fail();
  return {
    request,
    i,
    claim: {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: i.environmentId,
      operationId: request.operationId,
      claimId: request.claimId,
    },
  };
}
export async function fenceNativeAuthRegistrationRevocation(context: CatalogContext, raw: unknown) {
  const { request, i, claim } = revocationInput(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = values(i);
  const guards = await nativeAuthEffectGuards(context, db, claim);
  const rev = [
    i.organizationId,
    i.projectId,
    i.environmentId,
    i.registryVersion,
    request.operationId,
    request.claimId,
    request.registryVersion,
  ];
  await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE ${exact} AND state IN ('active','revoked'))`,
      v,
    ),
    db
      .prepare(
        `INSERT INTO native_auth_registration_revocations(organization_id,project_id,environment_id,registry_version,operation_id,claim_id,next_registry_version) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT DO NOTHING`,
      )
      .bind(...rev),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_registration_revocations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND registry_version=?4 AND operation_id=?5 AND claim_id=?6 AND next_registry_version=?7)`,
      rev,
    ),
    db
      .prepare(
        `UPDATE native_auth_registrations SET state='revoked' WHERE ${exact} AND state='active'`,
      )
      .bind(...v),
  ]);
  return { outcome: "fenced" as const };
}

/** The registry rechecks this original revocation receipt before and after deleting its credential. */
export async function authorizeNativeAuthRegistrationRevocation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const { request, i, claim } = revocationInput(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = values(i);
  const guards = await nativeAuthEffectGuards(context, db, claim);
  const rev = [
    i.organizationId,
    i.projectId,
    i.environmentId,
    i.registryVersion,
    request.operationId,
    request.claimId,
    request.registryVersion,
  ];
  await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE ${exact} AND state='revoked')`,
      v,
    ),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_registration_revocations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND registry_version=?4 AND operation_id=?5 AND claim_id=?6 AND next_registry_version=?7)`,
      rev,
    ),
  ]);
  return true;
}
