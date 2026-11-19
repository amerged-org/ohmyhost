import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";

import { runtimeRoleOf } from "../../src/catalog/database/contracts.js";
import type { PlatformContext } from "../../src/catalog/platform-support.js";
import { pgcfBackupRoleName, readRecoveryScope } from "../../src/catalog/recovery/scope.js";
import { coreRouter, createTestControl, type TestControl } from "../support/control-d1.js";
import { seedWfpPublication, sourceFrameworkPlan } from "../support/provider-fixtures.js";
import {
  STORED_NOW,
  freezeOwnership,
  seedProject,
  ulidOf,
  type SeededProject,
} from "../support/platform-fixtures.js";
import { seedProviderClaim } from "../support/accepted-operation.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
});
afterAll(async () => control.dispose());

const context = (): PlatformContext => ({
  directory: control.directory,
  router: coreRouter(control, control.shards),
});
const exec = (project: SeededProject, sql: string, ...values: unknown[]) =>
  project.shard
    .prepare(sql)
    .bind(...values)
    .run();
const scopeOf = (project: SeededProject) =>
  readRecoveryScope(context(), {
    organizationId: project.organizationId,
    projectId: project.projectId,
  });

let sequence = 0;
interface Fixture {
  readonly project: SeededProject;
  readonly physical: string;
}

/** A shared project: dev and prod point at ONE physical environment (assignment version 1). */
async function fixture(shard = 0, prodOnly = false): Promise<Fixture> {
  sequence += 1;
  const project = await seedProject(control, { shard, prodOnly });
  const physical = ulidOf("physical", sequence);
  await exec(
    project,
    "INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
    project.organizationId,
    project.projectId,
    physical,
    STORED_NOW,
  );
  for (const environmentId of prodOnly
    ? [project.prodEnvironmentId]
    : [project.devEnvironmentId, project.prodEnvironmentId])
    await exec(
      project,
      "INSERT INTO environment_data_assignments(organization_id, environment_id, assignment_version, project_id, data_environment_id, assigned_at) VALUES (?1, ?2, 1, ?3, ?4, ?5)",
      project.organizationId,
      environmentId,
      project.projectId,
      physical,
      STORED_NOW,
    );
  return { project, physical };
}

/** The prod environment's active deployment, whose plan is `plan` (raw JSON text or object). */
async function activate(f: Fixture, plan: unknown) {
  const { project } = f;
  const claim = await seedProviderClaim(project, project.prodEnvironmentId);
  const ids = await seedWfpPublication(project, {
    operationId: claim.operationId,
    frameworkPlan: plan,
    headVersion: 2,
  });
  return ids;
}

async function pgcfHead(f: Fixture, state: "active" | "retired" = "active") {
  const { project } = f;
  const suffix = sequence.toString(36).padStart(4, "0");
  await exec(
    project,
    "INSERT INTO database_provider_target_revisions(organization_id, project_id, physical_environment_id, target_version, provider, provider_project_id, database_id, region_id, size_class_id, runtime_role, credential_reference, operation_id, created_at) VALUES (?1, ?2, ?3, 1, 'pgcf', ?4, ?5, 'eu-dev', 'standard', ?6, 'sealed:1', NULL, ?7)",
    project.organizationId,
    project.projectId,
    f.physical,
    `prj_${"a".repeat(16)}${suffix}`,
    `d${"b".repeat(15)}${suffix}`,
    runtimeRoleOf(f.physical),
    STORED_NOW,
  );
  await exec(
    project,
    "INSERT INTO database_provider_target_heads(organization_id, project_id, physical_environment_id, target_version, state, activated_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, NULL, ?5)",
    project.organizationId,
    project.projectId,
    f.physical,
    state,
    STORED_NOW,
  );
  return {
    providerProjectId: `prj_${"a".repeat(16)}${suffix}`,
    databaseId: `d${"b".repeat(15)}${suffix}`,
  };
}

async function neonPlacement(f: Fixture, branch = "br-main-1") {
  const { project } = f;
  await exec(
    project,
    "INSERT INTO neon_project_placement_receipts(organization_id, project_id, environment_id, operation_id, claim_id, project_name, region_id, postgres_version, provider_project_id, default_branch_id, operation_ids, state, observed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'aws-eu-central-1', 17, ?7, ?8, '[]', 'ready', ?9, ?9)",
    project.organizationId,
    project.projectId,
    f.physical,
    ulidOf("neonop", sequence),
    ulidOf("neonclaim", sequence),
    `ohmyho-${project.projectId.toLowerCase()}`,
    `neon-project-${sequence}`,
    branch,
    STORED_NOW,
  );
  return { providerProjectId: `neon-project-${sequence}`, branchId: branch };
}

async function neonRole(
  f: Fixture,
  source: { providerProjectId: string; branchId: string },
  role = `ohmyho_ro_${f.physical.toLowerCase()}`,
) {
  const { project } = f;
  await exec(
    project,
    "INSERT INTO neon_project_role_receipts(organization_id, project_id, environment_id, operation_id, claim_id, provider_project_id, branch_id, role_name, operation_ids, state, observed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]', 'ready', ?9, ?9)",
    project.organizationId,
    project.projectId,
    f.physical,
    ulidOf("roleop", sequence),
    ulidOf("roleclaim", sequence),
    source.providerProjectId,
    source.branchId,
    role,
    STORED_NOW,
  );
}

describe("readRecoveryScope", () => {
  it("reads a canonical Prod-only scope without inventing Dev and refuses an unassigned current environment", async () => {
    const f = await fixture(0, true);
    const database = await pgcfHead(f);
    const scope = await scopeOf(f.project);
    expect(scope?.environments).toEqual([
      expect.objectContaining({
        environmentId: f.project.prodEnvironmentId,
        name: "prod",
        databaseEnvironmentId: f.physical,
        database: expect.objectContaining({ databaseId: database.databaseId }),
      }),
    ]);
    const incomplete = await seedProject(control);
    await exec(
      incomplete,
      "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      incomplete.organizationId,
      incomplete.projectId,
      incomplete.prodEnvironmentId,
      STORED_NOW,
    );
    await exec(
      incomplete,
      "INSERT INTO environment_data_assignments(organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at) VALUES(?1,?2,1,?3,?2,?4)",
      incomplete.organizationId,
      incomplete.prodEnvironmentId,
      incomplete.projectId,
      STORED_NOW,
    );
    await expect(scopeOf(incomplete)).rejects.toThrow("recovery_inventory_invalid");
  });

  it("refuses an incomplete inventory while an Auth database lacks backup readiness", async () => {
    const unknown = await fixture();
    await exec(
      unknown.project,
      `INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state,dispatched_at) VALUES(?1,?2,?3,'operation','claim','provider','name','eu-dev','r256-s500m','pending-key','dispatched','2026-10-30T09:20:00.000000Z')`,
      unknown.project.organizationId,
      unknown.project.projectId,
      unknown.project.devEnvironmentId,
    );
    await expect(scopeOf(unknown.project)).rejects.toThrow("recovery_database_not_ready");
    const f = await fixture();
    await exec(
      f.project,
      `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from)
      VALUES(?1,?2,'prj_12345678901234567890','a1234567890123456789','operation','eu-dev','r256-s500m',1,'2026-10-30T09:20:00.000000Z','2026-10-30T09:00:00.000000Z')`,
      f.project.organizationId,
      f.project.projectId,
    );
    await expect(scopeOf(f.project)).rejects.toThrow("recovery_database_not_ready");
    const e = f.project.devEnvironmentId;
    await exec(
      f.project,
      "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','Test',1,1)",
      f.project.organizationId,
      f.project.projectId,
      e,
    );
    await exec(
      f.project,
      `INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','a1234567890123456789',1,?6,?7,?8,?9,?10,?11)`,
      f.project.organizationId,
      f.project.projectId,
      e,
      ulidOf("operation", 99),
      ulidOf("claim", 99),
      `omh_auth_${e.toLowerCase()}`,
      `omh_ar_${e.toLowerCase()}`,
      `omh_am_${e.toLowerCase()}`,
      `omh_ab_${f.project.projectId.toLowerCase()}`,
      NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
      NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
    );
    expect((await scopeOf(f.project))?.nativeAuthDatabase).toMatchObject({
      kind: "native_auth_database",
      projectId: f.project.projectId,
      databaseId: "a1234567890123456789",
      roleName: `omh_ab_${f.project.projectId.toLowerCase()}`,
    });
  });
  it("returns the empty inventory of a project that never had a database or deployment", async () => {
    const f = await fixture();
    const scope = await scopeOf(f.project);
    expect(scope).toMatchObject({
      dataMode: expect.any(String),
      ownershipVersion: expect.any(Number),
    });
    expect(scope?.environments.map((e) => e.name)).toEqual(["dev", "prod"]);
    for (const environment of scope?.environments ?? [])
      expect(environment).toMatchObject({
        databaseEnvironmentId: f.physical,
        assignmentVersion: 1,
        activeDeploymentId: null,
        head: null,
        database: null,
      });
  });

  it("is not an inventory for another organization, a frozen owner or an unknown project", async () => {
    const f = await fixture();
    const other = await fixture(1);
    expect(
      await readRecoveryScope(context(), {
        organizationId: other.project.organizationId,
        projectId: f.project.projectId,
      }),
    ).toBeNull();
    await freezeOwnership(f.project);
    expect(await scopeOf(f.project)).toBeNull();
    await expect(
      readRecoveryScope(context(), { organizationId: "x", projectId: "y" }),
    ).rejects.toThrow();
  });

  it("reads the active PGCF target and never falls back to historical Neon receipts", async () => {
    const f = await fixture();
    const identity = await pgcfHead(f);
    const source = await neonPlacement(f);
    await neonRole(f, source);
    const scope = await scopeOf(f.project);
    for (const environment of scope?.environments ?? [])
      expect(environment.database).toEqual({
        provider: "pgcf",
        providerProjectId: identity.providerProjectId,
        databaseId: identity.databaseId,
        regionId: "eu-dev",
        postgresVersion: "18",
        databaseName: identity.databaseId,
        roleName: pgcfBackupRoleName(f.physical),
        databaseEnvironmentId: f.physical,
        targetVersion: 1,
      });
    expect(pgcfBackupRoleName("ABC")).toBe("ohmyho_backup_abc");
  });

  it("reads a Neon placement only together with its matching read-only role", async () => {
    const f = await fixture();
    const source = await neonPlacement(f);
    await expect(scopeOf(f.project)).rejects.toThrow("recovery_database_not_ready");
    await neonRole(f, { ...source, branchId: "br-other-9" });
    await expect(scopeOf(f.project)).rejects.toThrow("recovery_database_not_ready");

    const g = await fixture();
    const placed = await neonPlacement(g);
    await neonRole(g, placed, `ohmyho_rw_${g.physical.toLowerCase()}`);
    await expect(scopeOf(g.project)).rejects.toThrow("recovery_database_not_ready");
    await neonRole(g, placed);
    expect((await scopeOf(g.project))?.environments[0]?.database).toEqual({
      provider: "neon",
      providerProjectId: placed.providerProjectId,
      branchId: "br-main-1",
      regionId: "aws-eu-central-1",
      postgresVersion: 17,
      databaseName: "neondb",
      roleName: "neondb_owner",
      databaseEnvironmentId: g.physical,
    });
  });

  it("refuses a recorded but unusable head and a placement next to a retired head", async () => {
    const f = await fixture();
    await pgcfHead(f, "retired");
    await expect(scopeOf(f.project)).rejects.toThrow("recovery_database_not_ready");
    // no Neon placement can rescue a recorded PGCF history: still not ready
    const source = await neonPlacement(f);
    await neonRole(f, source);
    await expect(scopeOf(f.project)).rejects.toThrow("recovery_database_not_ready");
  });

  it("reads the validated framework plan of the active deployment and the assignment versions", async () => {
    const f = await fixture();
    const plan = sourceFrameworkPlan(false);
    const ids = await activate(f, plan);
    const scope = await scopeOf(f.project);
    const [dev, prod] = scope?.environments ?? [];
    expect(dev?.head).toBeNull();
    expect(prod).toMatchObject({
      headVersion: 2,
      activeDeploymentId: ids.deploymentId,
      activeRevisionId: ids.revisionId,
      head: {
        deploymentId: ids.deploymentId,
        revisionId: ids.revisionId,
        frameworkPlan: plan,
        databaseEnabled: false,
      },
    });
    // a newer assignment version wins and is reported
    const next = ulidOf("physical", sequence + 500);
    await exec(
      f.project,
      "INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
      f.project.organizationId,
      f.project.projectId,
      next,
      STORED_NOW,
    );
    await exec(
      f.project,
      "INSERT INTO environment_data_assignments(organization_id, environment_id, assignment_version, project_id, data_environment_id, assigned_at) VALUES (?1, ?2, 2, ?3, ?4, ?5)",
      f.project.organizationId,
      f.project.prodEnvironmentId,
      f.project.projectId,
      next,
      STORED_NOW,
    );
    const after = (await scopeOf(f.project))?.environments[1];
    expect(after).toMatchObject({ assignmentVersion: 2, databaseEnvironmentId: next });
  });

  it("refuses malformed plans and an enabled database that was never placed", async () => {
    for (const bad of [{ database: { enabled: "yes" } }, { database: null }, { other: 1 }]) {
      const f = await fixture();
      // Such a malformed plan cannot pass the real source INSERT guards. Never weaken them to construct an impossible head.
      await expect(activate(f, bad)).rejects.toThrow();
    }
    const legacy = await fixture();
    await activate(legacy, null); // NULL framework_plan remains legal original historical data.
    await expect(scopeOf(legacy.project)).rejects.toThrow("recovery_inventory_invalid");
    const enabled = await fixture();
    await activate(enabled, sourceFrameworkPlan(true));
    await expect(scopeOf(enabled.project)).rejects.toThrow("recovery_database_not_ready");
    // once a PGCF target exists the same plan is usable
    await pgcfHead(enabled);
    expect((await scopeOf(enabled.project))?.environments[1]?.head?.databaseEnabled).toBe(true);
  });

  it("refuses an active pointer without its revision plan and a project without its complete data inventory", async () => {
    const f = await fixture();
    await activate(f, sourceFrameworkPlan(false));
    // Environment pointer authority is checked by the reader: the legacy Core table deliberately has no cyclic head FK.
    await exec(
      f.project,
      "UPDATE environments SET active_revision_id = ?3 WHERE organization_id = ?1 AND environment_id = ?2",
      f.project.organizationId,
      f.project.prodEnvironmentId,
      ulidOf("missing", 1),
    );
    await expect(scopeOf(f.project)).rejects.toThrow("recovery_inventory_invalid");

    const g = await seedProject(control, { shard: 0 });
    await expect(scopeOf(g)).rejects.toThrow("recovery_inventory_invalid");
  });

  it("keeps two organizations on two shards apart", async () => {
    const a = await fixture(0);
    const b = await fixture(1);
    const identity = await pgcfHead(a);
    expect((await scopeOf(a.project))?.environments[0]?.database).toMatchObject({
      provider: "pgcf",
      databaseId: identity.databaseId,
    });
    expect((await scopeOf(b.project))?.environments[0]?.database).toBeNull();
  });
});
