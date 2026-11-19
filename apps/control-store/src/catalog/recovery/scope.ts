import { z } from "zod";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";

import { routeOrganization, rowsOf, ulid, type CatalogContext } from "../common.js";
import { readSnapshot } from "../platform-support.js";
import { recoveryEnvironmentAllowedSql } from "./shared.js";

export const readRecoveryScopeInput = z.strictObject({ organizationId: ulid, projectId: ulid });

/** Private complete exports only (`pgcfBackupRoleName`): never a runtime or temporary customer role. */
export const pgcfBackupRoleName = (physicalEnvironmentId: string): string =>
  `ohmyho_backup_${physicalEnvironmentId.toLowerCase()}`;

/** `projectSqlRoleName(environment, "readonly")`. */
const readonlyRoleName = (physicalEnvironmentId: string): string =>
  `ohmyho_ro_${physicalEnvironmentId.toLowerCase()}`;

/**
 * The active deployment of an environment. `frameworkPlan` is the stored JSON of the plan; the shard proves it is an
 * object whose `database` requirement has a boolean `enabled`, and the Node consumer (which owns
 * `parseNewProductionFrameworkPlan`) runs the complete validation on it before it is used.
 */
export interface RecoveryScopeHead {
  readonly deploymentId: string;
  readonly revisionId: string;
  readonly frameworkPlan: Readonly<Record<string, unknown>>;
  readonly databaseEnabled: boolean;
}

export type RecoveryScopeDatabase =
  | {
      readonly provider: "pgcf";
      readonly providerProjectId: string;
      readonly databaseId: string;
      readonly regionId: string;
      readonly postgresVersion: "18";
      readonly databaseName: string;
      readonly roleName: string;
      readonly databaseEnvironmentId: string;
      readonly targetVersion: number;
    }
  | {
      readonly provider: "neon";
      readonly providerProjectId: string;
      readonly branchId: string;
      readonly regionId: string;
      readonly postgresVersion: number;
      readonly databaseName: "neondb";
      readonly roleName: "neondb_owner";
      readonly databaseEnvironmentId: string;
    };

export interface RecoveryScopeEnvironment {
  readonly environmentId: string;
  readonly name: "dev" | "prod";
  /** The physical data environment of the newest assignment (`current_data_environment`). */
  readonly databaseEnvironmentId: string;
  readonly assignmentVersion: number;
  readonly headVersion: number;
  readonly activeDeploymentId: string | null;
  readonly activeRevisionId: string | null;
  /** Null: the environment has no active deployment. */
  readonly head: RecoveryScopeHead | null;
  /** Null: no database was ever placed for this physical environment (absent, as opposed to recorded). */
  readonly database: RecoveryScopeDatabase | null;
}

export interface RecoveryScope {
  readonly dataMode: "shared" | "isolated";
  readonly ownershipVersion: number;
  readonly lifecycleVersion: number;
  readonly environments:
    | readonly [RecoveryScopeEnvironment]
    | readonly [RecoveryScopeEnvironment, RecoveryScopeEnvironment];
  readonly nativeAuthDatabase?: {
    readonly kind: "native_auth_database";
    readonly provider: "pgcf";
    readonly providerProjectId: string;
    readonly projectId: string;
    readonly databaseId: string;
    readonly regionId: "us-dev" | "eu-dev";
    readonly roleName: string;
    readonly targetVersion: number;
    readonly realms: readonly {
      readonly environmentId: string;
      readonly schemaName: string;
      readonly revocationEpoch: number;
      readonly configurationRevision: number;
    }[];
  };
}

interface ProjectRow {
  data_mode: "shared" | "isolated";
  ownership_version: number;
  lifecycle_version: number;
}
interface EnvironmentRow {
  environment_id: string;
  name: string;
  head_version: number;
  active_deployment_id: string | null;
  active_revision_id: string | null;
  data_environment_id: string;
  assignment_version: number;
  framework_plan: string | null;
}
interface HeadRow {
  physical_environment_id: string;
  target_version: number;
  state: "active" | "retired";
  provider: "neon" | "pgcf";
  provider_project_id: string;
  database_id: string | null;
  branch_id: string | null;
  region_id: string;
}
interface PlacementRow {
  environment_id: string;
  provider_project_id: string;
  default_branch_id: string;
  region_id: string;
  postgres_version: number;
}
interface RoleRow {
  environment_id: string;
  role_name: string;
  provider_project_id: string;
  branch_id: string;
}

const invalid = () => new Error("recovery_inventory_invalid");
const notReady = () => new Error("recovery_database_not_ready");

function headOf(row: EnvironmentRow): RecoveryScopeHead | null {
  if (row.active_deployment_id === null && row.active_revision_id === null) return null;
  if (
    row.active_deployment_id === null ||
    row.active_revision_id === null ||
    row.framework_plan === null
  )
    throw invalid();
  let plan: unknown;
  try {
    plan = JSON.parse(row.framework_plan);
  } catch {
    throw invalid();
  }
  const database = (plan as { database?: unknown } | null)?.database;
  const enabled = (database as { enabled?: unknown } | null)?.enabled;
  if (
    plan === null ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    database === null ||
    typeof database !== "object" ||
    typeof enabled !== "boolean"
  )
    throw invalid();
  return {
    deploymentId: row.active_deployment_id,
    revisionId: row.active_revision_id,
    frameworkPlan: plan as Record<string, unknown>,
    databaseEnabled: enabled,
  };
}

/**
 * The complete `readProjectRecoveryInventory` of the original, as ONE consistent shard snapshot (one D1 batch): the
 * project is active and owned, canonical Prod and optional Dev have their newest data assignment and active plan,
 * and each physical environment has its provider database: the ACTIVE PGCF target, or the historical Neon placement
 * and read-only role. A PGCF target never falls back to a historical Neon receipt, and a Neon receipt is never
 * accepted without its matching read-only role.
 *
 * `null` is "not an active project of this organization". Errors keep the original names: `recovery_inventory_invalid`
 * (malformed project, environments, assignments or head) and `recovery_database_not_ready` (a recorded but unusable
 * placement, role or head).
 */
export async function readRecoveryScope(
  context: CatalogContext,
  rawInput: unknown,
): Promise<RecoveryScope | null> {
  const input = readRecoveryScopeInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const scope = [input.organizationId, input.projectId] as const;
  const [
    project,
    environments,
    heads,
    placements,
    roles,
    nativeTargets,
    unresolvedNative,
    nativeRealms,
    pendingPolicy,
  ] = await readSnapshot(shard.db, [
    [
      `SELECT data_mode, ownership_version, lifecycle_version FROM projects
       WHERE organization_id = ?1 AND project_id = ?2 AND owner_state = 'active' AND lifecycle_state = 'active'`,
      ...scope,
    ],
    [
      `SELECT environment.environment_id, environment.name, environment.head_version, environment.active_deployment_id, environment.active_revision_id,
              assignment.data_environment_id, assignment.assignment_version, plan.framework_plan
       FROM environments environment
       LEFT JOIN environment_data_assignments assignment ON assignment.organization_id = environment.organization_id AND assignment.environment_id = environment.environment_id
        AND assignment.assignment_version = (SELECT max(newest.assignment_version) FROM environment_data_assignments newest
          WHERE newest.organization_id = environment.organization_id AND newest.environment_id = environment.environment_id)
       LEFT JOIN deployments deployment ON deployment.organization_id = environment.organization_id AND deployment.project_id = environment.project_id
        AND deployment.environment_id = environment.environment_id AND deployment.deployment_id = environment.active_deployment_id
       LEFT JOIN deployment_revisions revision ON revision.organization_id = environment.organization_id AND revision.project_id = environment.project_id
        AND revision.deployment_id = environment.active_deployment_id AND revision.revision_id = environment.active_revision_id
        AND revision.revision_id = deployment.active_revision_id
       LEFT JOIN deployment_plans plan ON plan.organization_id = revision.organization_id AND plan.project_id = revision.project_id AND plan.plan_id = revision.plan_id
       WHERE environment.organization_id = ?1 AND environment.project_id = ?2 AND ${recoveryEnvironmentAllowedSql("environment")} ORDER BY environment.name`,
      ...scope,
    ],
    [
      `SELECT h.physical_environment_id, h.target_version, h.state, r.provider, r.provider_project_id, r.database_id, r.branch_id, r.region_id
         FROM database_provider_target_heads h
         JOIN database_provider_target_revisions r ON r.organization_id = h.organization_id AND r.project_id = h.project_id
          AND r.physical_environment_id = h.physical_environment_id AND r.target_version = h.target_version
        WHERE h.organization_id = ?1 AND h.project_id = ?2`,
      ...scope,
    ],
    [
      `SELECT environment_id, provider_project_id, default_branch_id, region_id, postgres_version
         FROM neon_project_placement_receipts WHERE organization_id = ?1 AND project_id = ?2 AND state = 'ready'`,
      ...scope,
    ],
    [
      `SELECT environment_id, role_name, provider_project_id, branch_id
         FROM neon_project_role_receipts WHERE organization_id = ?1 AND project_id = ?2 AND state = 'ready'`,
      ...scope,
    ],
    [
      `SELECT t.provider_project_id,t.database_id,t.region_id,t.target_version,
        (EXISTS(SELECT 1 FROM native_auth_preparation_receipts r JOIN environments preparation_environment ON preparation_environment.organization_id=r.organization_id AND preparation_environment.project_id=r.project_id AND preparation_environment.environment_id=r.environment_id AND ${recoveryEnvironmentAllowedSql("preparation_environment")} WHERE r.organization_id=?2 AND r.project_id=t.project_id AND r.database_id=t.database_id AND r.target_version=t.target_version AND r.backup_role='omh_ab_'||lower(t.project_id) AND r.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND r.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}') AND NOT EXISTS(SELECT 1 FROM native_auth_registrations g JOIN environments registration_environment ON registration_environment.organization_id=g.organization_id AND registration_environment.project_id=g.project_id AND registration_environment.environment_id=g.environment_id AND ${recoveryEnvironmentAllowedSql("registration_environment")} WHERE g.organization_id=?2 AND g.project_id=t.project_id AND g.database_id=t.database_id AND NOT EXISTS(SELECT 1 FROM native_auth_preparation_receipts r WHERE r.project_id=t.project_id AND r.environment_id=g.environment_id AND r.database_id=t.database_id AND r.target_version=t.target_version AND r.backup_role='omh_ab_'||lower(t.project_id) AND r.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND r.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}'))) AS prepared
       FROM native_auth_database_targets t WHERE t.project_id = ?1 AND t.ended_at IS NULL
         AND (NOT EXISTS(SELECT 1 FROM native_auth_realms any_realm WHERE any_realm.organization_id=?2 AND any_realm.project_id=t.project_id) OR EXISTS(SELECT 1 FROM native_auth_realms selected JOIN environments current ON current.organization_id=selected.organization_id AND current.project_id=selected.project_id AND current.environment_id=selected.environment_id
           WHERE selected.organization_id=?2 AND selected.project_id=t.project_id AND ${recoveryEnvironmentAllowedSql("current")}))`,
      input.projectId,
      input.organizationId,
    ],
    [
      `SELECT 1 FROM native_auth_database_operations operation JOIN environments current ON current.organization_id=operation.organization_id AND current.project_id=operation.project_id AND current.environment_id=operation.environment_id
        WHERE operation.project_id=?1 AND operation.state='dispatched' AND operation.database_id IS NULL AND ${recoveryEnvironmentAllowedSql("current")}`,
      input.projectId,
    ],
    [
      `SELECT DISTINCT r.environment_id,r.revocation_epoch,r.configuration_revision FROM native_auth_realms r JOIN environments current ON current.organization_id=r.organization_id AND current.project_id=r.project_id AND current.environment_id=r.environment_id AND ${recoveryEnvironmentAllowedSql("current")} JOIN native_auth_preparation_receipts p ON p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.environment_id=r.environment_id JOIN native_auth_database_targets t ON t.organization_id=p.organization_id AND t.project_id=p.project_id AND t.database_id=p.database_id AND t.target_version=p.target_version AND t.ended_at IS NULL WHERE r.organization_id=?1 AND r.project_id=?2 AND p.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND p.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}' ORDER BY r.environment_id`,
      ...scope,
    ],
    [
      `SELECT 1 FROM native_auth_policy_syncs policy JOIN environments current ON current.organization_id=policy.organization_id AND current.project_id=policy.project_id AND current.environment_id=policy.environment_id AND ${recoveryEnvironmentAllowedSql("current")} WHERE policy.organization_id=?1 AND policy.project_id=?2 AND policy.state IN('pending','refresh_pending_cleanup') UNION ALL SELECT 1 FROM native_auth_restores WHERE organization_id=?1 AND project_id=?2 AND state='restoring' LIMIT 1`,
      ...scope,
    ],
  ]);
  const head = rowsOf<ProjectRow>({ results: project ?? [] })[0];
  if (head === undefined) return null;
  const native = nativeTargets?.[0];
  if (
    (unresolvedNative?.length ?? 0) > 0 ||
    (nativeTargets?.length ?? 0) > 1 ||
    (pendingPolicy?.length ?? 0) > 0 ||
    (native !== undefined && native["prepared"] !== 1)
  )
    throw notReady();
  const nativeRegion = native?.["region_id"];
  if (native !== undefined && ((nativeRealms?.length ?? 0) < 1 || (nativeRealms?.length ?? 0) > 2))
    throw notReady();
  if (native !== undefined && nativeRegion !== "us-dev" && nativeRegion !== "eu-dev")
    throw notReady();
  const rows = rowsOf<EnvironmentRow>({ results: environments ?? [] });
  const prod = rows.at(-1),
    dev = rows.length === 2 ? rows[0] : undefined;
  if (
    rows.length < 1 ||
    rows.length > 2 ||
    prod?.name !== "prod" ||
    (rows.length === 2 && dev?.name !== "dev")
  )
    throw invalid();
  const targets = rowsOf<HeadRow>({ results: heads ?? [] });
  const placed = rowsOf<PlacementRow>({ results: placements ?? [] });
  const roled = rowsOf<RoleRow>({ results: roles ?? [] });

  const environment = (row: EnvironmentRow, name: "dev" | "prod"): RecoveryScopeEnvironment => {
    if (
      !ulid.safeParse(row.data_environment_id).success ||
      !Number.isSafeInteger(row.assignment_version) ||
      row.assignment_version < 1
    )
      throw invalid();
    const physical = row.data_environment_id;
    const active = targets.find(
      (target) => target.physical_environment_id === physical && target.state === "active",
    );
    // An active Neon head cannot exist (0070 trigger); one that is not a complete PGCF target is malformed.
    if (active !== undefined && (active.provider !== "pgcf" || active.database_id === null))
      throw invalid();
    const placement =
      active === undefined ? placed.find((item) => item.environment_id === physical) : undefined;
    if (
      active === undefined &&
      targets.some((target) => target.physical_environment_id === physical)
    )
      throw notReady();
    const role =
      active === undefined
        ? roled.find(
            (item) =>
              item.environment_id === physical && item.role_name === readonlyRoleName(physical),
          )
        : undefined;
    if (
      placement !== undefined &&
      (role === undefined ||
        role.provider_project_id !== placement.provider_project_id ||
        role.branch_id !== placement.default_branch_id)
    )
      throw notReady();
    const planHead = headOf(row);
    if (
      planHead?.databaseEnabled === true &&
      placement === undefined &&
      active === undefined &&
      row.assignment_version === 1
    )
      throw notReady();
    let database: RecoveryScopeDatabase | null = null;
    if (active !== undefined && active.database_id !== null)
      database = {
        provider: "pgcf",
        providerProjectId: active.provider_project_id,
        databaseId: active.database_id,
        regionId: active.region_id,
        postgresVersion: "18",
        databaseName: active.database_id,
        roleName: pgcfBackupRoleName(physical),
        databaseEnvironmentId: physical,
        targetVersion: active.target_version,
      };
    else if (placement !== undefined)
      database = {
        provider: "neon",
        providerProjectId: placement.provider_project_id,
        branchId: placement.default_branch_id,
        regionId: placement.region_id,
        postgresVersion: placement.postgres_version,
        databaseName: "neondb",
        roleName: "neondb_owner",
        databaseEnvironmentId: physical,
      };
    return {
      environmentId: row.environment_id,
      name,
      databaseEnvironmentId: physical,
      assignmentVersion: row.assignment_version,
      headVersion: row.head_version,
      activeDeploymentId: row.active_deployment_id,
      activeRevisionId: row.active_revision_id,
      head: planHead,
      database,
    };
  };
  return {
    dataMode: head.data_mode,
    ownershipVersion: head.ownership_version,
    lifecycleVersion: head.lifecycle_version,
    environments:
      dev === undefined
        ? [environment(prod, "prod")]
        : [environment(dev, "dev"), environment(prod, "prod")],
    ...(native === undefined
      ? {}
      : {
          nativeAuthDatabase: {
            kind: "native_auth_database" as const,
            provider: "pgcf" as const,
            providerProjectId: String(native["provider_project_id"]),
            projectId: input.projectId,
            databaseId: String(native["database_id"]),
            regionId: nativeRegion as "us-dev" | "eu-dev",
            roleName: `omh_ab_${input.projectId.toLowerCase()}`,
            targetVersion: Number(native["target_version"]),
            realms: (nativeRealms ?? []).map((r) => ({
              environmentId: String(r["environment_id"]),
              schemaName: `omh_auth_${String(r["environment_id"]).toLowerCase()}`,
              revocationEpoch: Number(r["revocation_epoch"]),
              configurationRevision: Number(r["configuration_revision"]),
            })),
          },
        }),
  };
}
