import {
  parseProjectDataChangeSnapshot,
  planProjectDataChangeTransition,
} from "../../src/catalog/provisioning/context-snapshots.js";
import type { ProjectDataChangeKind } from "../../../../packages/database/src/project-data-environments.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseRegistrationCommands } from "../../src/catalog/database/commands.js";
import { createDatabaseRegistry } from "../../../project-database-runtime/src/registry.js";
import { deletionAcceptanceGuards } from "../../src/catalog/database/deletion-acceptance.js";
import { readProductDatabaseAccessSweep } from "../../src/catalog/database/product-access.js";
import {
  readServingCandidate,
  servingStartStatements,
} from "../../src/catalog/database/serving.js";
import { classifyFailure } from "../../src/guards.js";
import {
  DatabaseProviderConflictError,
  markServingInput,
  ProjectDatabaseRegistrationConflictError,
  canonicalJson,
  cleanupLocatorOf,
  runtimeRoleOf,
} from "../../src/catalog/database/contracts.js";
import type { PlatformContext } from "../../src/catalog/platform-support.js";
import type { D1Database } from "../../src/d1-types.js";
import { coreRouter, createTestControl, type TestControl } from "../support/control-d1.js";
import {
  STORED_NOW,
  beforeFirstWrite,
  bytes,
  losingWriteResponses,
  seedProject,
  ulidOf,
  freezeOwnership,
  type SeededProject,
} from "../support/platform-fixtures.js";
import {
  releaseProviderClaim,
  seedCleanupRun,
  seedOperation,
  seedProviderClaim,
  type IntentColumns,
} from "../support/accepted-operation.js";
import { seedWfpPublication, sourceFrameworkPlan } from "../support/provider-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
});
afterAll(async () => control.dispose());

const contextWith = (shards: Readonly<Record<string, D1Database>>): PlatformContext => ({
  directory: control.directory,
  router: coreRouter(control, shards),
});
const commandsOver = (shards: Readonly<Record<string, D1Database>> = control.shards) => {
  const context = contextWith(shards);
  return createDatabaseRegistrationCommands((command) => (input) => command(context, input));
};
const wrapped = (project: SeededProject, wrap: (db: D1Database) => D1Database) => {
  const shards: Record<string, D1Database> = {};
  for (const [name, db] of Object.entries(control.shards))
    shards[name] = db === project.shard ? wrap(db) : db;
  return commandsOver(shards);
};

let sequence = 0;
const HOST = "ep-fixture.pgcf.example";

interface Fixture {
  readonly project: SeededProject;
  readonly physical: string;
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly claim: { operationId: string; claimId: string };
}

const exec = (project: SeededProject, sql: string, ...values: unknown[]) =>
  project.shard
    .prepare(sql)
    .bind(...values)
    .run();

/** A project whose prod and dev share one physical environment with an ACTIVE PGCF target and a migration receipt. */
async function fixture(
  options: {
    shard?: number;
    activated?: boolean;
    migrated?: boolean;
    neon?: boolean;
    sharing?: Fixture;
    dataChange?: ProjectDataChangeKind;
  } = {},
): Promise<Fixture> {
  sequence += 1;
  const project = await seedProject(control, { shard: options.shard ?? 0 });
  const physical = ulidOf("physical", sequence);
  const tail = sequence.toString(36).padStart(4, "0");
  const providerProjectId = options.sharing?.providerProjectId ?? `prj_${"a".repeat(16)}${tail}`;
  const databaseId = options.sharing?.databaseId ?? `d${"b".repeat(15)}${tail}`;
  const targetVersion = options.neon ? 2 : 1;
  const org = project.organizationId;
  await exec(
    project,
    "INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
    org,
    project.projectId,
    physical,
    STORED_NOW,
  );
  for (const environmentId of [project.devEnvironmentId, project.prodEnvironmentId])
    await exec(
      project,
      "INSERT INTO environment_data_assignments(organization_id, environment_id, assignment_version, project_id, data_environment_id, assigned_at) VALUES (?1, ?2, 1, ?3, ?4, ?5)",
      org,
      environmentId,
      project.projectId,
      physical,
      STORED_NOW,
    );
  const dataChange = options.dataChange;
  const claim =
    dataChange === undefined
      ? await seedProviderClaim(project, project.prodEnvironmentId)
      : await seedProviderClaim(
          project,
          project.prodEnvironmentId,
          "ProjectDataChangeRequestedV1",
          {
            intent: (operationId) =>
              nativeDataChangeIntent(project, physical, dataChange, operationId),
          },
        );
  const insertRevision = (version: number, values: unknown[], sql: string) =>
    exec(project, sql, org, project.projectId, physical, version, ...values);
  if (options.neon)
    await insertRevision(
      1,
      [
        "neon-project-1",
        "br-fixture-1",
        "eu",
        runtimeRoleOf(physical),
        "sealed:neon:1",
        STORED_NOW,
      ],
      "INSERT INTO database_provider_target_revisions(organization_id, project_id, physical_environment_id, target_version, provider, provider_project_id, database_id, branch_id, region_id, size_class_id, runtime_role, credential_reference, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, 'neon', ?5, NULL, ?6, ?7, NULL, ?8, ?9, NULL, ?10)",
    );
  await insertRevision(
    targetVersion,
    [providerProjectId, databaseId, runtimeRoleOf(physical), claim.operationId, STORED_NOW],
    "INSERT INTO database_provider_target_revisions(organization_id, project_id, physical_environment_id, target_version, provider, provider_project_id, database_id, branch_id, region_id, size_class_id, runtime_role, credential_reference, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, 'pgcf', ?5, ?6, NULL, 'eu-dev', 'standard', ?7, 'sealed:credential:1', ?8, ?9)",
  );
  await exec(
    project,
    "INSERT INTO database_provider_target_heads(organization_id, project_id, physical_environment_id, target_version, state, activated_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6)",
    org,
    project.projectId,
    physical,
    targetVersion,
    options.activated ? "2026-10-28T09:20:00.000000Z" : null,
    STORED_NOW,
  );
  if (options.migrated !== false)
    await exec(
      project,
      "INSERT INTO pgcf_database_migration_receipts(organization_id, project_id, physical_environment_id, operation_id, claim_id, provider_project_id, database_id, bundle_sha256, applied_paths, replayed_paths, completed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]', '[]', ?9)",
      org,
      project.projectId,
      physical,
      claim.operationId,
      claim.claimId,
      providerProjectId,
      databaseId,
      bytes(32, 9),
      STORED_NOW,
    );
  if (options.neon)
    await exec(
      project,
      "INSERT INTO project_database_registration_receipts(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, status, metadata, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, 3, 'active', ?6, ?7)",
      org,
      project.projectId,
      physical,
      claim.operationId,
      ulidOf("neonclaim", sequence),
      canonicalJson({
        operationId: claim.operationId,
        organizationId: org,
        projectId: project.projectId,
        physicalEnvironmentId: physical,
        registrationVersion: 3,
        region: "eu",
        providerProjectId: "neon-project-1",
        branchId: "br-fixture-1",
        originHost: "ep-old.neon.example",
        originDatabase: "neondb",
        originUser: runtimeRoleOf(physical),
        authorizedEnvironmentIds: [project.devEnvironmentId, project.prodEnvironmentId].sort(),
        status: "active",
      }),
      STORED_NOW,
    );
  return { project, physical, providerProjectId, databaseId, claim };
}

const scope = (f: Fixture) => ({
  organizationId: f.project.organizationId,
  projectId: f.project.projectId,
  physicalEnvironmentId: f.physical,
});
const claimInput = (f: Fixture) => ({ ...scope(f), ...f.claim });
const reserveInput = (f: Fixture) => ({ ...claimInput(f), originHost: HOST });
const count = async (f: Fixture, table: string) =>
  (
    await f.project.shard
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE organization_id = ?`)
      .bind(f.project.organizationId)
      .first<{ n: number }>()
  )?.n;
const environments = (f: Fixture) =>
  [f.project.devEnvironmentId, f.project.prodEnvironmentId].sort();

describe("PGCF registration reserve and put", () => {
  it("recovers only matching failed reservations with a higher fenced generation", async () => {
    const store = commandsOver();
    const prepare = async (mismatch?: "target" | "environments") => {
      const f = await fixture();
      const isolated = ulidOf("isolated", sequence);
      await exec(
        f.project,
        "INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        f.project.organizationId,
        f.project.projectId,
        isolated,
        STORED_NOW,
      );
      const assignDev = (version: number, physical: string) =>
        exec(
          f.project,
          "INSERT INTO environment_data_assignments(organization_id, project_id, environment_id, assignment_version, data_environment_id, assigned_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
          f.project.organizationId,
          f.project.projectId,
          f.project.devEnvironmentId,
          version,
          physical,
          STORED_NOW,
        );
      await assignDev(2, isolated);
      const first = (await store.reservePgcfDatabaseRegistration(reserveInput(f))).registration;
      await store.putPgcfDatabaseRegistration({
        claim: claimInput(f),
        registration: first,
        observedAt: NOW,
      });
      await assignDev(3, f.physical);
      const wanted = {
        ...first,
        registrationVersion: 2,
        authorizedEnvironmentIds: environments(f),
      };
      const old = mismatch
        ? {
            ...wanted,
            ...(mismatch === "target" ? { originHost: "other.pgcf.example" } : {}),
            ...(mismatch === "environments"
              ? { authorizedEnvironmentIds: [f.project.devEnvironmentId] }
              : {}),
          }
        : (await store.reservePgcfDatabaseRegistration(reserveInput(f))).registration;
      if (mismatch)
        await exec(
          f.project,
          "INSERT INTO project_database_registration_reservations(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, metadata) VALUES (?1, ?2, ?3, ?4, ?5, 2, ?6)",
          ...Object.values(scope(f)),
          f.claim.operationId,
          f.claim.claimId,
          canonicalJson(old),
        );
      expect(old.registrationVersion).toBe(2);
      await exec(
        f.project,
        "UPDATE operations SET state = 'failed' WHERE organization_id = ?1 AND operation_id = ?2",
        f.project.organizationId,
        f.claim.operationId,
      );
      await exec(
        f.project,
        "DELETE FROM product_provider_mutation_claims WHERE organization_id = ?1 AND project_id = ?2",
        f.project.organizationId,
        f.project.projectId,
      );
      const current = {
        ...f,
        claim: await seedProviderClaim(f.project, f.project.devEnvironmentId),
      };
      await exec(
        f.project,
        "INSERT INTO pgcf_database_migration_receipts(organization_id, project_id, physical_environment_id, operation_id, claim_id, provider_project_id, database_id, bundle_sha256, applied_paths, replayed_paths, completed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]', '[]', ?9)",
        ...Object.values(scope(f)),
        current.claim.operationId,
        current.claim.claimId,
        f.providerProjectId,
        f.databaseId,
        bytes(32, 9),
        STORED_NOW,
      );
      return { f: current, first, old, oldClaim: f.claim };
    };

    for (const mismatch of ["target", "environments"] as const) {
      const { f } = await prepare(mismatch);
      await expect(store.reservePgcfDatabaseRegistration(reserveInput(f))).rejects.toBeInstanceOf(
        DatabaseProviderConflictError,
      );
      expect(await count(f, "project_database_registration_reservations")).toBe(2);
    }
    const active = await prepare();
    for (const state of ["queued", "running", "succeeded", "cancelled"] as const) {
      await exec(
        active.f.project,
        "UPDATE operations SET state = ?1 WHERE organization_id = ?2 AND operation_id = ?3",
        state,
        active.f.project.organizationId,
        active.oldClaim.operationId,
      );
      await expect(
        store.reservePgcfDatabaseRegistration(reserveInput(active.f)),
      ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    }
    expect(await count(active.f, "project_database_registration_reservations")).toBe(2);

    const raced = await prepare();
    const raceStore = wrapped(raced.f.project, (db) =>
      beforeFirstWrite(db, () =>
        exec(
          raced.f.project,
          "UPDATE operations SET state = 'running' WHERE organization_id = ?1 AND operation_id = ?2",
          raced.f.project.organizationId,
          raced.oldClaim.operationId,
        ).then(() => undefined),
      ),
    );
    await expect(
      raceStore.reservePgcfDatabaseRegistration(reserveInput(raced.f)),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    expect(await count(raced.f, "project_database_registration_reservations")).toBe(2);

    const later = await prepare();
    const laterOperation = await seedOperation(later.f.project);
    await exec(
      later.f.project,
      "UPDATE operations SET state = 'failed' WHERE organization_id = ?1 AND operation_id = ?2",
      later.f.project.organizationId,
      laterOperation,
    );
    const laterStore = wrapped(later.f.project, (db) =>
      beforeFirstWrite(db, () =>
        exec(
          later.f.project,
          "INSERT INTO project_database_registration_reservations(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, metadata) VALUES (?1, ?2, ?3, ?4, ?5, 4, ?6)",
          ...Object.values(scope(later.f)),
          laterOperation,
          ulidOf("later-claim", sequence),
          canonicalJson({ ...later.old, operationId: laterOperation, registrationVersion: 4 }),
        ).then(() => undefined),
      ),
    );
    const afterRace = await laterStore.reservePgcfDatabaseRegistration(reserveInput(later.f));
    expect(afterRace.registration.registrationVersion).toBe(5);
    expect(await laterStore.reservePgcfDatabaseRegistration(reserveInput(later.f))).toEqual(
      afterRace,
    );
    expect(
      (
        await later.f.project.shard
          .prepare(
            "SELECT registration_version FROM project_database_registration_reservations WHERE organization_id = ?1 ORDER BY registration_version",
          )
          .bind(later.f.project.organizationId)
          .all<{ registration_version: number }>()
      ).results,
    ).toEqual([1, 2, 4, 5].map((registration_version) => ({ registration_version })));

    const neon = await fixture({ neon: true });
    await exec(
      neon.project,
      "INSERT INTO database_provider_legacy_retirements(organization_id, project_id, physical_environment_id, target_version, provider_project_id, branch_id, manifest_sha256, inventory_sha256, retired_at, retired_by) VALUES (?1, ?2, ?3, 1, 'neon-project-1', 'br-fixture-1', ?4, ?4, ?5, 'owner:fixture')",
      ...Object.values(scope(neon)),
      bytes(32, 7),
      STORED_NOW,
    );
    const neonOldOperation = await seedOperation(neon.project);
    await exec(
      neon.project,
      "UPDATE operations SET state = 'failed' WHERE organization_id = ?1 AND operation_id = ?2",
      neon.project.organizationId,
      neonOldOperation,
    );
    await exec(
      neon.project,
      "INSERT INTO project_database_registration_reservations(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, metadata) VALUES (?1, ?2, ?3, ?4, ?5, 4, ?6)",
      ...Object.values(scope(neon)),
      neonOldOperation,
      ulidOf("neon-old-claim", sequence),
      canonicalJson({
        ...scope(neon),
        provider: "pgcf",
        providerProjectId: neon.providerProjectId,
        databaseId: neon.databaseId,
        originDatabase: neon.databaseId,
        originHost: HOST,
        originUser: runtimeRoleOf(neon.physical),
        authorizedEnvironmentIds: environments(neon),
        operationId: neonOldOperation,
        registrationVersion: 4,
        region: "eu",
        status: "active",
      }),
    );
    await expect(store.reservePgcfDatabaseRegistration(reserveInput(neon))).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(await count(neon, "project_database_registration_reservations")).toBe(1);

    const { f, first, old } = await prepare();
    const oldRow = await f.project.shard
      .prepare(
        "SELECT * FROM project_database_registration_reservations WHERE organization_id = ?1 AND registration_version = 2",
      )
      .bind(f.project.organizationId)
      .first();
    const reserved = await store.reservePgcfDatabaseRegistration(reserveInput(f));
    expect(reserved).toMatchObject({ completed: false, previous: first });
    expect(reserved.registration.registrationVersion).toBe(3);
    expect(await store.reservePgcfDatabaseRegistration(reserveInput(f))).toEqual(reserved);
    expect(await count(f, "project_database_registration_reservations")).toBe(3);
    expect(
      await f.project.shard
        .prepare(
          "SELECT * FROM project_database_registration_reservations WHERE organization_id = ?1 AND registration_version = 2",
        )
        .bind(f.project.organizationId)
        .first(),
    ).toEqual(oldRow);
    // An open operation's reservation never leaves; a failed one leaves only through its supersede command (CORE-07).
    await expect(
      exec(
        f.project,
        "DELETE FROM project_database_registration_reservations WHERE organization_id = ?1 AND registration_version = 3",
        f.project.organizationId,
      ),
    ).rejects.toThrow();
    await expect(
      exec(
        f.project,
        "UPDATE project_database_registration_reservations SET metadata = metadata WHERE organization_id = ?1 AND registration_version = 2",
        f.project.organizationId,
      ),
    ).rejects.toThrow();

    for (const oldReplyWasLost of [false, true]) {
      let storedRegistry: unknown;
      const registry = createDatabaseRegistry({
        region: "eu",
        keyRing: { current: { keyVersion: 1, keyBase64: btoa("k".repeat(32)) } },
        storage: {
          async get<T>() {
            return storedRegistry as T | undefined;
          },
          async put(_key, value) {
            storedRegistry = structuredClone(value);
          },
        },
        invalidate: async () => undefined,
      });
      const register = (registration: typeof first) => {
        const { status: _status, ...input } = registration;
        void _status;
        return registry.register({
          ...input,
          connectionString: `postgres://${registration.originUser}:fixture@${HOST}/${f.databaseId}`,
        });
      };
      expect(await register(first)).toEqual(first);
      if (oldReplyWasLost) expect(await register(old)).toEqual(old);
      expect(await register(reserved.registration)).toEqual(reserved.registration);
      await expect(register(old)).rejects.toThrow("project_database_unavailable");
      expect(
        await registry.authorize({
          ...scope(f),
          region: "eu",
          environmentId: f.project.prodEnvironmentId,
          registrationVersion: 1,
        }),
      ).toContain(HOST);
      expect(
        await registry.authorize({
          ...scope(f),
          region: "eu",
          environmentId: f.project.devEnvironmentId,
          registrationVersion: 3,
        }),
      ).toContain(HOST);
      await expect(
        registry.authorize({
          ...scope(f),
          region: "eu",
          environmentId: f.project.devEnvironmentId,
          registrationVersion: 1,
        }),
      ).rejects.toThrow("project_database_unavailable");
    }
    await store.putPgcfDatabaseRegistration({
      claim: claimInput(f),
      registration: reserved.registration,
      observedAt: NOW,
    });
    expect(await store.reservePgcfDatabaseRegistration(reserveInput(f))).toMatchObject({
      completed: true,
      registration: reserved.registration,
    });
  });

  it("supersedes a reservation of a failed operation that never registered once it is seven days older than the claim", async () => {
    const store = commandsOver();
    /** A failed operation's pending reservation at `version`, failed at `failedAt`; its claim is already gone. */
    const orphaned = async (version: number, failedAt: string) => {
      const f = await fixture();
      const operationId = await seedOperation(f.project);
      await exec(
        f.project,
        "UPDATE operations SET state = 'failed', updated_at = ?1 WHERE organization_id = ?2 AND operation_id = ?3",
        failedAt,
        f.project.organizationId,
        operationId,
      );
      await exec(
        f.project,
        "INSERT INTO project_database_registration_reservations(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        ...Object.values(scope(f)),
        operationId,
        ulidOf("orphan-claim", sequence),
        version,
        canonicalJson({
          ...scope(f),
          provider: "pgcf",
          providerProjectId: f.providerProjectId,
          databaseId: f.databaseId,
          originDatabase: f.databaseId,
          originHost: HOST,
          originUser: runtimeRoleOf(f.physical),
          authorizedEnvironmentIds: environments(f),
          operationId,
          registrationVersion: version,
          region: "eu",
          status: "active",
        }),
      );
      return f;
    };

    // The claim's operation opened at STORED_NOW (2026-10-28): this failure is more than seven days older, so it is superseded.
    const aged = await orphaned(1, "2026-10-01T10:00:00.000000Z");
    const reserved = await store.reservePgcfDatabaseRegistration(reserveInput(aged));
    expect(reserved.registration.registrationVersion).toBe(1);
    expect(await count(aged, "project_database_registration_reservations")).toBe(1);

    // Six days is not yet superseded: the pending reservation still refuses the new registration.
    const young = await orphaned(1, "2026-10-22T10:00:00.000000Z");
    await expect(store.reservePgcfDatabaseRegistration(reserveInput(young))).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(await count(young, "project_database_registration_reservations")).toBe(1);
  });

  it("reserves, receipts, reads and replays one registration with its identities", async () => {
    const f = await fixture();
    const store = commandsOver();
    expect(await store.readPgcfDatabaseRegistration(scope(f))).toBeNull();
    const reserved = await store.reservePgcfDatabaseRegistration(reserveInput(f));
    expect(reserved).toMatchObject({ completed: false, previous: null });
    expect(reserved.registration).toEqual({
      provider: "pgcf",
      databaseId: f.databaseId,
      operationId: f.claim.operationId,
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      physicalEnvironmentId: f.physical,
      registrationVersion: 1,
      region: "eu",
      providerProjectId: f.providerProjectId,
      originHost: HOST,
      originDatabase: f.databaseId,
      originUser: runtimeRoleOf(f.physical),
      authorizedEnvironmentIds: environments(f),
      status: "active",
    });
    // a reserved but not yet receipted registration is not served
    expect(await store.readPgcfDatabaseRegistration(scope(f))).toBeNull();
    expect(await store.reservePgcfDatabaseRegistration(reserveInput(f))).toEqual(reserved);
    expect(await count(f, "project_database_registration_reservations")).toBe(1);

    const put = { claim: claimInput(f), registration: reserved.registration, observedAt: NOW };
    await store.putPgcfDatabaseRegistration(put);
    await store.putPgcfDatabaseRegistration(put);
    expect(await count(f, "project_database_registration_receipts")).toBe(1);
    expect(await store.readPgcfDatabaseRegistration(scope(f))).toEqual(reserved.registration);
    expect(await store.reservePgcfDatabaseRegistration(reserveInput(f))).toMatchObject({
      completed: true,
      registration: reserved.registration,
    });
  });

  it("refuses a lost claim, another origin, another tenant and a bad host without writing", async () => {
    const f = await fixture();
    const store = commandsOver();
    await expect(
      store.reservePgcfDatabaseRegistration({ ...reserveInput(f), originHost: "Not A Host" }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.reservePgcfDatabaseRegistration({ ...reserveInput(f), claimId: ulidOf("claim", 9999) }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    const other = await fixture({ shard: 1 });
    await expect(
      store.reservePgcfDatabaseRegistration({
        ...reserveInput(f),
        organizationId: other.project.organizationId,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    expect(
      await store.readPgcfDatabaseRegistration({
        ...scope(f),
        organizationId: other.project.organizationId,
      }),
    ).toBeNull();
    expect(await count(f, "project_database_registration_reservations")).toBe(0);
    expect(await count(other, "project_database_registration_reservations")).toBe(0);
  });

  it("refuses a target without its migration receipt without writing", async () => {
    const f = await fixture({ migrated: false });
    const store = commandsOver();
    await expect(store.reservePgcfDatabaseRegistration(reserveInput(f))).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(await count(f, "project_database_registration_reservations")).toBe(0);
  });

  it("aborts atomically when the claim is released between the read and the write", async () => {
    const f = await fixture();
    const store = wrapped(f.project, (db) =>
      beforeFirstWrite(db, () => releaseProviderClaim(f.project)),
    );
    await expect(store.reservePgcfDatabaseRegistration(reserveInput(f))).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(await count(f, "project_database_registration_reservations")).toBe(0);
  });

  it("resolves a lost write response by the original identity and runs concurrent twins once", async () => {
    const f = await fixture();
    const lost = wrapped(f.project, (db) => losingWriteResponses(db, 1));
    const reserved = await lost.reservePgcfDatabaseRegistration(reserveInput(f));
    expect(reserved.registration.registrationVersion).toBe(1);
    expect(await count(f, "project_database_registration_reservations")).toBe(1);
    const put = { claim: claimInput(f), registration: reserved.registration, observedAt: NOW };
    await wrapped(f.project, (db) => losingWriteResponses(db, 1)).putPgcfDatabaseRegistration(put);
    expect(await count(f, "project_database_registration_receipts")).toBe(1);

    const g = await fixture();
    const store = commandsOver();
    const twins = await Promise.all([
      store.reservePgcfDatabaseRegistration(reserveInput(g)),
      store.reservePgcfDatabaseRegistration(reserveInput(g)),
    ]);
    expect(twins[0].registration).toEqual(twins[1].registration);
    expect(await count(g, "project_database_registration_reservations")).toBe(1);
  });

  it("refuses a put that is not the exact reservation, and a put after the claim is lost", async () => {
    const f = await fixture();
    const store = commandsOver();
    const { registration } = await store.reservePgcfDatabaseRegistration(reserveInput(f));
    await expect(
      store.putPgcfDatabaseRegistration({
        claim: claimInput(f),
        registration: { ...registration, originHost: "other.pgcf.example" },
        observedAt: NOW,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.putPgcfDatabaseRegistration({
        claim: claimInput(f),
        registration: { ...registration, operationId: ulidOf("operation", 4242) },
        observedAt: NOW,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await releaseProviderClaim(f.project);
    await expect(
      store.putPgcfDatabaseRegistration({ claim: claimInput(f), registration, observedAt: NOW }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    expect(await count(f, "project_database_registration_receipts")).toBe(0);
  });
});

const NOW = "2026-10-28T10:00:00.000Z";

describe("historical Neon provenance and provider change", () => {
  it("serves no Neon registration, needs the owner-proven absence, then versions past it", async () => {
    const f = await fixture({ neon: true });
    const store = commandsOver();
    // the Neon receipt is historical provenance: it is never the registration the product reads
    expect(await store.readPgcfDatabaseRegistration(scope(f))).toBeNull();
    // without the owner-proven absence of the Neon branch the provider change is refused
    await expect(store.reservePgcfDatabaseRegistration(reserveInput(f))).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(await count(f, "project_database_registration_reservations")).toBe(0);
    await exec(
      f.project,
      "INSERT INTO database_provider_legacy_retirements(organization_id, project_id, physical_environment_id, target_version, provider_project_id, branch_id, manifest_sha256, inventory_sha256, retired_at, retired_by) VALUES (?1, ?2, ?3, 1, 'neon-project-1', 'br-fixture-1', ?4, ?4, ?5, 'owner:fixture')",
      f.project.organizationId,
      f.project.projectId,
      f.physical,
      bytes(32, 7),
      STORED_NOW,
    );
    const reserved = await store.reservePgcfDatabaseRegistration(reserveInput(f));
    expect(reserved.previous).toMatchObject({ registrationVersion: 3, branchId: "br-fixture-1" });
    // the same region: the next registry version, never a reused one
    expect(reserved.registration.registrationVersion).toBe(4);
  });

  it("never lets a Neon revision be an active head, and refuses a second tenant on one database", async () => {
    const f = await fixture({ neon: true });
    await expect(
      exec(
        f.project,
        "UPDATE database_provider_target_heads SET target_version = 1 WHERE organization_id = ?1 AND project_id = ?2",
        f.project.organizationId,
        f.project.projectId,
      ),
    ).rejects.toThrow(/only a PGCF target/u);
    await expect(
      exec(
        f.project,
        "DELETE FROM database_provider_target_revisions WHERE organization_id = ?1",
        f.project.organizationId,
      ),
    ).rejects.toThrow(/append-only/u);
    await expect(fixture({ sharing: f })).rejects.toThrow(/another physical identity/u);
  });
});

describe("serving intervals follow the head", () => {
  const intervals = async (f: Fixture) =>
    (
      await f.project.shard
        .prepare(
          "SELECT started_at, billable_from, ended_at FROM pgcf_database_serving_intervals WHERE organization_id = ? ORDER BY started_at",
        )
        .bind(f.project.organizationId)
        .all<{ started_at: string; billable_from: string; ended_at: string | null }>()
    ).results;

  it("opens at activation with the first full UTC hour billable and closes on retirement", async () => {
    const f = await fixture({ activated: true });
    expect(await intervals(f)).toEqual([
      {
        started_at: "2026-10-28T09:20:00.000000Z",
        billable_from: "2026-10-28T10:00:00.000000Z",
        ended_at: null,
      },
    ]);
    await exec(
      f.project,
      "UPDATE database_provider_target_heads SET state = 'retired', updated_at = ?3 WHERE organization_id = ?1 AND project_id = ?2",
      f.project.organizationId,
      f.project.projectId,
      "2026-10-28T11:05:00.000000Z",
    );
    expect(await intervals(f)).toEqual([
      expect.objectContaining({ ended_at: "2026-10-28T11:05:00.000000Z" }),
    ]);
    await expect(
      exec(
        f.project,
        "DELETE FROM pgcf_database_serving_intervals WHERE organization_id = ?",
        f.project.organizationId,
      ),
    ).rejects.toThrow(/immutable/u);
  });

  it("starts the interval when an inactive head is activated", async () => {
    const f = await fixture();
    expect(await intervals(f)).toEqual([]);
    await exec(
      f.project,
      "UPDATE database_provider_target_heads SET activated_at = '2026-10-28T10:00:00.000000Z', updated_at = '2026-10-28T10:00:00.000000Z' WHERE organization_id = ?1",
      f.project.organizationId,
    );
    // activating exactly on the hour still bills from the following full hour
    expect(await intervals(f)).toEqual([
      expect.objectContaining({ billable_from: "2026-10-28T11:00:00.000000Z", ended_at: null }),
    ]);
    await expect(fixture({ sharing: f })).rejects.toThrow(/another physical identity/u);
  });
});

describe("data-change reauthorization", () => {
  async function reauthFixture(
    change: ProjectDataChangeKind,
    predecessor: "active" | "revoked" = "active",
  ) {
    const f = await fixture({ dataChange: change });
    const store = commandsOver();
    // a served registration from an earlier operation
    const first = { operationId: await seedOperation(f.project), claimId: ulidOf("claim", 777) };
    const registration = {
      provider: "pgcf" as const,
      databaseId: f.databaseId,
      operationId: first.operationId,
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      physicalEnvironmentId: f.physical,
      registrationVersion: 1,
      region: "eu" as const,
      providerProjectId: f.providerProjectId,
      originHost: HOST,
      originDatabase: f.databaseId,
      originUser: runtimeRoleOf(f.physical),
      authorizedEnvironmentIds: environments(f),
      status: predecessor,
    };
    await exec(
      f.project,
      "INSERT INTO project_database_registration_receipts(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, status, metadata, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8)",
      f.project.organizationId,
      f.project.projectId,
      f.physical,
      first.operationId,
      first.claimId,
      predecessor,
      canonicalJson(registration),
      STORED_NOW,
    );
    const input = {
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      environmentId: f.project.prodEnvironmentId,
      operationId: f.claim.operationId,
      claimId: f.claim.claimId,
      physicalEnvironmentId: f.physical,
      authorizedEnvironmentIds: [f.project.devEnvironmentId],
    };
    return { f, store, registration, input };
  }

  it("reserves, receipts and replays the narrowed authorization of an isolate change", async () => {
    const { f, store, registration, input } = await reauthFixture("isolate_dev_keeps_data");
    const reserved = await store.reservePgcfDatabaseReauthorization(input);
    expect(reserved).toMatchObject({ completed: false, previous: registration });
    expect(reserved?.registration).toMatchObject({
      registrationVersion: 2,
      operationId: f.claim.operationId,
      authorizedEnvironmentIds: [f.project.devEnvironmentId],
      status: "active",
    });
    expect(await store.reservePgcfDatabaseReauthorization(input)).toEqual(reserved);
    const put = { input, registration: reserved?.registration, observedAt: NOW };
    await store.putPgcfDatabaseReauthorization(put);
    await store.putPgcfDatabaseReauthorization(put);
    expect(await store.readPgcfDatabaseRegistration(scope(f))).toEqual(reserved?.registration);
    expect(await store.reservePgcfDatabaseReauthorization(input)).toMatchObject({
      completed: true,
    });
  });

  it("supersedes a failed operation's reservation at the next version before the reauthorization takes it", async () => {
    const { f, store, registration, input } = await reauthFixture("isolate_dev_keeps_data");
    const failed = await seedOperation(f.project);
    await exec(
      f.project,
      "UPDATE operations SET state = 'failed', updated_at = ?1 WHERE organization_id = ?2 AND operation_id = ?3",
      "2026-10-01T10:00:00.000000Z",
      f.project.organizationId,
      failed,
    );
    await exec(
      f.project,
      "INSERT INTO project_database_registration_reservations(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, metadata) VALUES (?1, ?2, ?3, ?4, ?5, 2, ?6)",
      ...Object.values(scope(f)),
      failed,
      ulidOf("failed-claim", sequence),
      canonicalJson({
        ...registration,
        operationId: failed,
        registrationVersion: 2,
        authorizedEnvironmentIds: [f.project.devEnvironmentId],
      }),
    );
    const reserved = await store.reservePgcfDatabaseReauthorization(input);
    expect(reserved?.registration).toMatchObject({
      registrationVersion: 2,
      operationId: f.claim.operationId,
    });
    expect(await count(f, "project_database_registration_reservations")).toBe(1);
  });

  it("refuses a list the change does not authorize, a lost claim and another tenant", async () => {
    const { f, store, input } = await reauthFixture("isolate_dev_keeps_data");
    await expect(
      store.reservePgcfDatabaseReauthorization({
        ...input,
        authorizedEnvironmentIds: [f.project.prodEnvironmentId],
      }),
    ).rejects.toBeInstanceOf(ProjectDatabaseRegistrationConflictError);
    const other = await fixture({ shard: 1 });
    await expect(
      store.reservePgcfDatabaseReauthorization({
        ...input,
        organizationId: other.project.organizationId,
      }),
    ).rejects.toBeInstanceOf(ProjectDatabaseRegistrationConflictError);
    await releaseProviderClaim(f.project);
    await expect(store.reservePgcfDatabaseReauthorization(input)).rejects.toBeInstanceOf(
      ProjectDatabaseRegistrationConflictError,
    );
    expect(await count(f, "project_database_registration_reservations")).toBe(0);
  });

  it("answers null without a PGCF registration and revokes when nothing stays authorized", async () => {
    const { f, store, input } = await reauthFixture("share_prod_keeps_data");
    const revoked = await store
      .reservePgcfDatabaseReauthorization({
        ...input,
        authorizedEnvironmentIds: [],
      })
      .catch((error: unknown) => error);
    expect(revoked).toBeInstanceOf(ProjectDatabaseRegistrationConflictError);
    const bare = await fixture();
    expect(
      await commandsOver()
        .reservePgcfDatabaseReauthorization({
          organizationId: bare.project.organizationId,
          projectId: bare.project.projectId,
          environmentId: bare.project.prodEnvironmentId,
          operationId: bare.claim.operationId,
          claimId: bare.claim.claimId,
          physicalEnvironmentId: bare.physical,
          authorizedEnvironmentIds: [],
        })
        .catch((error: unknown) => error),
    ).toBeInstanceOf(ProjectDatabaseRegistrationConflictError);
    expect(await count(f, "project_database_registration_reservations")).toBe(0);
  });

  it("re-authorizes a revoked registration under a new operation at the next version", async () => {
    const { f, store, registration, input } = await reauthFixture(
      "isolate_dev_keeps_data",
      "revoked",
    );
    const reserved = await store.reservePgcfDatabaseReauthorization(input);
    expect(reserved).toMatchObject({ completed: false, previous: registration });
    expect(reserved?.registration).toMatchObject({
      registrationVersion: 2,
      operationId: f.claim.operationId,
      authorizedEnvironmentIds: [f.project.devEnvironmentId],
      status: "active",
    });
    await store.putPgcfDatabaseReauthorization({
      input,
      registration: reserved?.registration,
      observedAt: NOW,
    });
    expect(await store.readPgcfDatabaseRegistration(scope(f))).toEqual(reserved?.registration);
  });

  it("replays a revoke of an already revoked head under another operation as a completed no-op", async () => {
    const { f, store } = await reauthFixture("share_prod_keeps_data");
    // Development's old physical database: its revoked head was written by an earlier operation
    const physical = ulidOf("reauth-new-physical", sequence);
    const databaseId = `d${"c".repeat(15)}${sequence.toString(36).padStart(4, "0")}`;
    const earlier = await seedOperation(f.project);
    const org = f.project.organizationId;
    await exec(
      f.project,
      "INSERT INTO database_provider_target_revisions(organization_id, project_id, physical_environment_id, target_version, provider, provider_project_id, database_id, branch_id, region_id, size_class_id, runtime_role, credential_reference, operation_id, created_at) VALUES (?1, ?2, ?3, 1, 'pgcf', ?4, ?5, NULL, 'eu-dev', 'standard', ?6, 'sealed:credential:1', ?7, ?8)",
      org,
      f.project.projectId,
      physical,
      f.providerProjectId,
      databaseId,
      runtimeRoleOf(physical),
      earlier,
      STORED_NOW,
    );
    await exec(
      f.project,
      "INSERT INTO database_provider_target_heads(organization_id, project_id, physical_environment_id, target_version, state, activated_at, updated_at) VALUES (?1, ?2, ?3, 1, 'active', NULL, ?4)",
      org,
      f.project.projectId,
      physical,
      STORED_NOW,
    );
    const revoked = {
      provider: "pgcf" as const,
      databaseId,
      operationId: earlier,
      organizationId: org,
      projectId: f.project.projectId,
      physicalEnvironmentId: physical,
      registrationVersion: 1,
      region: "eu" as const,
      providerProjectId: f.providerProjectId,
      originHost: HOST,
      originDatabase: databaseId,
      originUser: runtimeRoleOf(physical),
      authorizedEnvironmentIds: environments(f),
      status: "revoked" as const,
    };
    await exec(
      f.project,
      "INSERT INTO project_database_registration_receipts(organization_id, project_id, physical_environment_id, operation_id, claim_id, registration_version, status, metadata, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 'revoked', ?6, ?7)",
      org,
      f.project.projectId,
      physical,
      earlier,
      ulidOf("claim", 778),
      canonicalJson(revoked),
      STORED_NOW,
    );
    const replay = await store.reservePgcfDatabaseReauthorization({
      organizationId: org,
      projectId: f.project.projectId,
      environmentId: f.project.prodEnvironmentId,
      operationId: f.claim.operationId,
      claimId: f.claim.claimId,
      physicalEnvironmentId: physical,
      authorizedEnvironmentIds: [],
    });
    expect(replay).toMatchObject({ completed: true, previous: revoked, registration: revoked });
    expect(await count(f, "project_database_registration_reservations")).toBe(0);
  });
});

describe("deletion and retirement", () => {
  async function deletionFixture() {
    const f = await fixture({ activated: true });
    const store = commandsOver();
    const reserved = await store.reservePgcfDatabaseRegistration(reserveInput(f));
    await store.putPgcfDatabaseRegistration({
      claim: claimInput(f),
      registration: reserved.registration,
      observedAt: NOW,
    });
    // a deletion operation of its own: running cleanup run, frozen inventory, no data-change claim
    const del = { operationId: await seedOperation(f.project) };
    const cleanupRun = ulidOf("cleanup", sequence);
    await exec(
      f.project,
      "INSERT INTO cleanup_runs(organization_id, cleanup_run_id, project_id, operation_id, state, revision, created_at, updated_at) VALUES (?1, ?3, ?2, ?4, 'running', 1, ?5, ?5)",
      f.project.organizationId,
      f.project.projectId,
      cleanupRun,
      del.operationId,
      STORED_NOW,
    );
    await exec(
      f.project,
      "INSERT INTO product_command_intents(organization_id, operation_id, event_type, project_id, environment_id, billing_epoch_id, cleanup_run_id, expected_etag, created_at) VALUES (?1, ?2, 'ProjectDeletionRequestedV1', ?3, ?4, ?5, ?6, ?7, ?8)",
      f.project.organizationId,
      del.operationId,
      f.project.projectId,
      f.project.prodEnvironmentId,
      f.project.billingEpochId,
      cleanupRun,
      '"' + "a".repeat(64) + '"',
      STORED_NOW,
    );
    await exec(
      f.project,
      "INSERT INTO run_resource_inventory(organization_id, resource_record_id, project_id, operation_id, provider, resource_kind, external_ref_hash, recorded_at, cleanup_locator) VALUES (?1, ?5, ?2, ?3, 'pgcf', 'database', ?6, ?7, ?4)",
      f.project.organizationId,
      f.project.projectId,
      del.operationId,
      cleanupLocatorOf(f.databaseId),
      ulidOf("resource", sequence),
      bytes(32, 5),
      STORED_NOW,
    );
    await exec(
      f.project,
      "UPDATE projects SET lifecycle_state = 'deleting' WHERE organization_id = ?1",
      f.project.organizationId,
    );
    const request = {
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      operationId: del.operationId,
      physicalEnvironmentId: f.physical,
      providerProjectId: f.providerProjectId,
      databaseId: f.databaseId,
      registrationVersion: 1,
    };
    return { f, store, request, registration: reserved.registration, del };
  }

  it("reads the deletion proof, records the revocation once and retires the head after the provider confirmed", async () => {
    const { f, store, request, registration, del } = await deletionFixture();
    const read = await store.readPgcfDatabaseDeletion(request);
    expect(read).toMatchObject({
      region: "eu",
      registration,
      registrationClaimId: f.claim.claimId,
    });
    expect(read.claim.claimId).toBe(del.operationId);

    const revoked = {
      ...registration,
      status: "revoked" as const,
      registrationVersion: 2,
      operationId: del.operationId,
    };
    // retiring before the revocation and the provider confirmation is refused
    await expect(
      store.retirePgcfDatabaseTarget({ request, retiredAt: "2026-10-28T12:00:00.000Z" }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.recordPgcfDeletionRevocation({
        request,
        registration: { ...revoked, originHost: "other.pgcf.example" },
        observedAt: NOW,
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await store.recordPgcfDeletionRevocation({ request, registration: revoked, observedAt: NOW });
    await store.recordPgcfDeletionRevocation({ request, registration: revoked, observedAt: NOW });
    expect(await count(f, "project_database_registration_receipts")).toBe(2);
    expect(await store.readPgcfDatabaseRegistration(scope(f))).toEqual(revoked);
    // the receipt of the revocation keeps the claim of the generation it revokes
    expect(
      (
        await f.project.shard
          .prepare(
            "SELECT claim_id FROM project_database_registration_receipts WHERE organization_id = ? AND registration_version = 2",
          )
          .bind(f.project.organizationId)
          .first<{ claim_id: string }>()
      )?.claim_id,
    ).toBe(f.claim.claimId);
    await expect(
      store.retirePgcfDatabaseTarget({ request, retiredAt: "2026-10-28T12:00:00.000Z" }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);

    await exec(
      f.project,
      "INSERT INTO database_provider_operations(organization_id, project_id, physical_environment_id, operation_id, claim_id, step, idempotency_key, provider_project_id, request_digest, request_body, database_id, state, dispatched_at, observed_at) VALUES (?1, ?2, ?3, ?4, ?4, 'database.delete', ?5, ?6, ?7, '{}', ?8, 'succeeded', ?9, ?9)",
      f.project.organizationId,
      f.project.projectId,
      f.physical,
      del.operationId,
      `omh-${"c".repeat(64)}`,
      f.providerProjectId,
      bytes(32, 5),
      f.databaseId,
      STORED_NOW,
    );
    const retire = { request, retiredAt: "2026-10-28T12:00:00.000Z" };
    await store.retirePgcfDatabaseTarget(retire);
    await store.retirePgcfDatabaseTarget(retire);
    const head = await f.project.shard
      .prepare("SELECT state FROM database_provider_target_heads WHERE organization_id = ?")
      .bind(f.project.organizationId)
      .first<{ state: string }>();
    expect(head?.state).toBe("retired");
    // metadata only: the revision, both receipts and the closed interval remain as history
    expect(await count(f, "database_provider_target_revisions")).toBe(1);
    expect(
      (
        await f.project.shard
          .prepare("SELECT ended_at FROM pgcf_database_serving_intervals WHERE organization_id = ?")
          .bind(f.project.organizationId)
          .first<{ ended_at: string }>()
      )?.ended_at,
    ).toBe("2026-10-28T12:00:00.000000Z");
  });

  it("closes the open credentials of a retired database, so the access sweep never retries them", async () => {
    const { f, store, request, registration, del } = await deletionFixture();
    const other = `d${"f".repeat(15)}${"0".repeat(4)}`;
    const issue = (serial: number, databaseId: string) =>
      exec(
        f.project,
        "INSERT INTO project_database_access(access_id, organization_id, project_id, environment_id, environment, data_environment_id, provider_project_id, role_name, mode, principal_id, origin_host, issued_at, expires_at, provider, database_id) VALUES (?1, ?2, ?3, ?4, 'dev', ?5, ?6, ?7, 'read', 'user:fixture', ?8, '2026-10-28T08:00:00.000000Z', '2026-10-28T20:00:00.000000Z', 'pgcf', ?9)",
        ulidOf("retired-access", serial),
        f.project.organizationId,
        f.project.projectId,
        f.project.devEnvironmentId,
        f.physical,
        f.providerProjectId,
        `ohmyho_da_${f.physical.toLowerCase()}_${serial.toString(36).padStart(8, "0")}`,
        HOST,
        databaseId,
      );
    await issue(1, f.databaseId);
    await issue(2, f.databaseId);
    await issue(3, other);
    const sweepOf = async (databaseId: string) => {
      const sweep = await readProductDatabaseAccessSweep(contextWith(control.shards), {
        now: NOW,
        limit: 50,
      });
      return [...sweep.expired, ...sweep.undropped, ...sweep.active].filter(
        (access) => access.databaseId === databaseId,
      );
    };
    expect(await sweepOf(f.databaseId)).toHaveLength(2);

    const revoked = {
      ...registration,
      status: "revoked" as const,
      registrationVersion: 2,
      operationId: del.operationId,
    };
    await store.recordPgcfDeletionRevocation({ request, registration: revoked, observedAt: NOW });
    await exec(
      f.project,
      "INSERT INTO database_provider_operations(organization_id, project_id, physical_environment_id, operation_id, claim_id, step, idempotency_key, provider_project_id, request_digest, request_body, database_id, state, dispatched_at, observed_at) VALUES (?1, ?2, ?3, ?4, ?4, 'database.delete', ?5, ?6, ?7, '{}', ?8, 'succeeded', ?9, ?9)",
      f.project.organizationId,
      f.project.projectId,
      f.physical,
      del.operationId,
      `omh-${"d".repeat(64)}`,
      f.providerProjectId,
      bytes(32, 6),
      f.databaseId,
      STORED_NOW,
    );
    await store.retirePgcfDatabaseTarget({ request, retiredAt: NOW });

    expect(await sweepOf(f.databaseId)).toEqual([]);
    const closed = await f.project.shard
      .prepare(
        "SELECT revocation_reason, role_dropped_at FROM project_database_access WHERE database_id = ?",
      )
      .bind(f.databaseId)
      .all<{ revocation_reason: string; role_dropped_at: string | null }>();
    expect(closed.results).toEqual([
      { revocation_reason: "data_change", role_dropped_at: STORED_NOW },
      { revocation_reason: "data_change", role_dropped_at: STORED_NOW },
    ]);
    expect(await sweepOf(other)).toHaveLength(1);
  });

  it("composes the deletion acceptance guards into one batch with the capture fence and a complete inventory", async () => {
    const { f, request } = await deletionFixture();
    const db = f.project.shard;
    const scope = { organizationId: request.organizationId, projectId: request.projectId };
    const probe = (id: string) =>
      db
        .prepare(
          "INSERT INTO command_log(command_id, name, digest, result, applied_at) VALUES (?1, 'acceptance-probe', 'd', '{}', 1)",
        )
        .bind(id);
    const probes = async (id: string) =>
      (
        await db
          .prepare("SELECT count(*) AS n FROM command_log WHERE command_id = ?")
          .bind(id)
          .first<{ n: number }>()
      )?.n;
    const refused = (error: unknown) => {
      const failure = classifyFailure(error);
      return failure.kind === "guard" && failure.code === "precondition_changed";
    };
    const guards = (databaseIds: readonly string[], now = NOW) =>
      deletionAcceptanceGuards(db, { ...scope, now, databaseIds }, false);

    await db.batch([probe("accept-ok"), ...guards([f.databaseId, f.databaseId])]);
    expect(await probes("accept-ok")).toBe(1);

    // an incomplete inventory (the active PGCF database missing) and a foreign database are both refused
    await expect(db.batch([probe("accept-missing"), ...guards([])])).rejects.toSatisfy(refused);
    await expect(
      db.batch([probe("accept-foreign"), ...guards([f.databaseId, "dzzzzzzzzzzzzzzzzzzz"])]),
    ).rejects.toSatisfy(refused);
    expect(((await probes("accept-missing")) ?? 0) + ((await probes("accept-foreign")) ?? 0)).toBe(
      0,
    );

    // a capture that holds the project aborts the acceptance atomically, and expires with its lease
    await exec(
      f.project,
      "INSERT INTO project_recovery_fences(organization_id, project_id, epoch, holder_id, operation_id, claim_id, acquired_at, lease_expires_at, released_at, source_ownership_version, source_lifecycle_version) VALUES (?1, ?2, 1, ?3, ?4, ?5, '2026-10-28T09:59:00.000000Z', '2026-10-28T10:30:00.000000Z', NULL, 1, 1)",
      request.organizationId,
      request.projectId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      request.operationId,
      "11111111-1111-4111-8111-111111111111",
    );
    await expect(db.batch([probe("accept-held"), ...guards([f.databaseId])])).rejects.toSatisfy(
      refused,
    );
    expect(await probes("accept-held")).toBe(0);
    await db.batch([probe("accept-after"), ...guards([f.databaseId], "2026-10-28T11:00:00.000Z")]);
    expect(await probes("accept-after")).toBe(1);

    // another tenant's guards never see this project's database
    const other = await fixture({ shard: 1 });
    const otherDb = other.project.shard;
    await expect(
      otherDb.batch([
        ...deletionAcceptanceGuards(otherDb, {
          organizationId: other.project.organizationId,
          projectId: other.project.projectId,
          now: NOW,
          databaseIds: [f.databaseId],
        }),
      ]),
    ).rejects.toSatisfy(refused);
  });

  it("refuses another tenant's proof, a wrong database and a lost operation", async () => {
    const { f, store, request, registration, del } = await deletionFixture();
    const other = await fixture({ shard: 1 });
    await expect(
      store.readPgcfDatabaseDeletion({ ...request, organizationId: other.project.organizationId }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.readPgcfDatabaseDeletion({ ...request, databaseId: "dzzzzzzzzzzzzzzzzzzz" }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await expect(
      store.readPgcfDatabaseDeletion({ ...request, registrationVersion: 7 }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    const revoked = {
      ...registration,
      status: "revoked" as const,
      registrationVersion: 2,
      operationId: del.operationId,
    };
    const raced = wrapped(f.project, (db) =>
      beforeFirstWrite(db, async () => {
        await exec(
          f.project,
          "UPDATE operations SET state = 'failed' WHERE organization_id = ?1 AND operation_id = ?2",
          f.project.organizationId,
          del.operationId,
        );
      }),
    );
    await expect(
      raced.recordPgcfDeletionRevocation({ request, registration: revoked, observedAt: NOW }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    expect(await count(f, "project_database_registration_receipts")).toBe(1);
  });
});

describe("serving start with the accepted publication", () => {
  async function publication(options: { stagedBefore?: boolean } = {}) {
    const f = await fixture();
    const store = commandsOver();
    const { project } = f;
    const org = project.organizationId;
    const reserved = await store.reservePgcfDatabaseRegistration(reserveInput(f));
    await store.putPgcfDatabaseRegistration({
      claim: claimInput(f),
      registration: reserved.registration,
      observedAt: options.stagedBefore ? "2026-10-28T11:00:00.000Z" : "2026-10-28T09:00:00.000Z",
    });
    const ids = await seedWfpPublication(project, {
      operationId: f.claim.operationId,
      frameworkPlan: sourceFrameworkPlan(true),
      stagedAt: STORED_NOW,
    });
    const input = {
      organizationId: org,
      projectId: project.projectId,
      environmentId: project.prodEnvironmentId,
      operationId: f.claim.operationId,
      candidateReceiptId: ids.candidateReceiptId,
      wfpReceiptId: ids.wfpReceiptId,
      revisionId: ids.revisionId,
      activatedAt: "2026-10-28T11:40:00.000Z",
    };
    return { f, store, input, ids };
  }
  const head = async (f: Fixture) =>
    f.project.shard
      .prepare(
        "SELECT h.activated_at, (SELECT count(*) FROM pgcf_database_serving_intervals i WHERE i.organization_id = h.organization_id) AS intervals, (SELECT billable_from FROM pgcf_database_serving_intervals i WHERE i.organization_id = h.organization_id) AS billable_from FROM database_provider_target_heads h WHERE h.organization_id = ?",
      )
      .bind(f.project.organizationId)
      .first<{ activated_at: string | null; intervals: number; billable_from: string | null }>();

  it("starts serving once, opens the interval with the first full UTC hour, and replays", async () => {
    const { f, store, input } = await publication();
    await store.markDatabaseProviderTargetServing(input);
    expect(await head(f)).toEqual({
      activated_at: "2026-10-28T11:40:00.000000Z",
      intervals: 1,
      billable_from: "2026-10-28T12:00:00.000000Z",
    });
    await store.markDatabaseProviderTargetServing(input);
    await wrapped(f.project, (db) => losingWriteResponses(db, 1)).markDatabaseProviderTargetServing(
      input,
    );
    expect((await head(f))?.intervals).toBe(1);
  });

  it("resolves a lost response on the first start by the original identity", async () => {
    const { f, input } = await publication();
    await wrapped(f.project, (db) => losingWriteResponses(db, 1)).markDatabaseProviderTargetServing(
      input,
    );
    expect(await head(f)).toMatchObject({
      activated_at: "2026-10-28T11:40:00.000000Z",
      intervals: 1,
    });
  });

  it("refuses an unproven publication, a registration observed after staging, a lost claim and a cutover", async () => {
    const stale = await publication({ stagedBefore: true });
    await expect(stale.store.markDatabaseProviderTargetServing(stale.input)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    const a = await publication();
    await expect(
      a.store.markDatabaseProviderTargetServing({ ...a.input, wfpReceiptId: ulidOf("wfp", 9999) }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
    await freezeOwnership(a.f.project);
    await expect(a.store.markDatabaseProviderTargetServing(a.input)).rejects.toThrow();
    expect((await head(a.f))?.activated_at).toBeNull();
    const b = await publication();
    await exec(
      b.f.project,
      "INSERT INTO database_provider_cutover_authorizations(organization_id, operation_id, project_id, physical_environment_id, manifest_sha256, expected_lifecycle_version, source_target_version, source_registration, target_provider_project_id, target_region_id, target_size_class_id, approved_at, approved_by) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, '{}', 'prj_abcdefghijklmnopqrst', 'us-dev', 'small', ?6, 'owner')",
      b.f.project.organizationId,
      await seedOperation(b.f.project),
      b.f.project.projectId,
      b.f.physical,
      bytes(32, 1),
      STORED_NOW,
    );
    // a cutover target is not a fresh target: nothing to start here, and nothing is started
    await b.store.markDatabaseProviderTargetServing(b.input);
    expect((await head(b.f))?.activated_at).toBeNull();
  });

  it("composes into one batch with the publication writes: all commit together or none does", async () => {
    const probe = (db: D1Database, id: string) =>
      db
        .prepare(
          "INSERT INTO command_log(command_id, name, digest, result, applied_at) VALUES (?1, 'finalizer-probe', 'd', '{}', 1)",
        )
        .bind(id);
    const probes = async (f: Fixture, id: string) =>
      (
        await f.project.shard
          .prepare("SELECT count(*) AS n FROM command_log WHERE command_id = ?")
          .bind(id)
          .first<{ n: number }>()
      )?.n;
    const good = await publication();
    const db = good.f.project.shard;
    const candidate = await readServingCandidate(db, {
      organizationId: good.input.organizationId,
      projectId: good.input.projectId,
      environmentId: good.input.environmentId,
      planId: good.ids.planId,
    });
    expect(candidate).toMatchObject({ target_version: 1, database_id: good.f.databaseId });
    await db.batch([
      probe(db, "serving-ok"),
      ...servingStartStatements(db, markServingInput.parse(good.input), candidate ?? {}),
    ]);
    expect(await probes(good.f, "serving-ok")).toBe(1);
    expect(await head(good.f)).toMatchObject({
      activated_at: "2026-10-28T11:40:00.000000Z",
      intervals: 1,
    });
    // serving already started: nothing left to start, so the finalizer batch carries no serving statement
    expect(
      await readServingCandidate(db, {
        organizationId: good.input.organizationId,
        projectId: good.input.projectId,
        environmentId: good.input.environmentId,
        planId: good.ids.planId,
      }),
    ).toBeNull();

    // a failing proof rolls the finalizer's own writes back with it
    const bad = await publication({ stagedBefore: true });
    const badDb = bad.f.project.shard;
    const pending = await readServingCandidate(badDb, {
      organizationId: bad.input.organizationId,
      projectId: bad.input.projectId,
      environmentId: bad.input.environmentId,
      planId: bad.ids.planId,
    });
    expect(pending).not.toBeNull();
    await expect(
      badDb.batch([
        probe(badDb, "serving-bad"),
        ...servingStartStatements(badDb, markServingInput.parse(bad.input), pending ?? {}),
      ]),
    ).rejects.toSatisfy((error: unknown) => {
      const failure = classifyFailure(error);
      return failure.kind === "guard" && failure.code === "precondition_changed";
    });
    expect(await probes(bad.f, "serving-bad")).toBe(0);
    expect((await head(bad.f))?.activated_at).toBeNull();
    expect((await head(bad.f))?.intervals).toBe(0);
  });

  it("reads no candidate for another tenant, a frozen owner or a plan without a database", async () => {
    const a = await publication();
    const db = a.f.project.shard;
    const scopeOf = (planId: string, organizationId = a.input.organizationId) => ({
      organizationId,
      projectId: a.input.projectId,
      environmentId: a.input.environmentId,
      planId,
    });
    const other = await fixture({ shard: 1 });
    expect(
      await readServingCandidate(
        other.project.shard,
        scopeOf(a.ids.planId, other.project.organizationId),
      ),
    ).toBeNull();
    expect(await readServingCandidate(db, scopeOf(ulidOf("unknown-plan", 1)))).toBeNull();
    await freezeOwnership(a.f.project);
    await expect(readServingCandidate(db, scopeOf(a.ids.planId))).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
  });

  it("aborts when the claim is lost between the read and the write, and refuses another tenant", async () => {
    const { f, input } = await publication();
    const raced = wrapped(f.project, (db) =>
      beforeFirstWrite(db, () => releaseProviderClaim(f.project)),
    );
    await expect(raced.markDatabaseProviderTargetServing(input)).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect((await head(f))?.activated_at).toBeNull();
    const other = await fixture({ shard: 1 });
    await commandsOver().markDatabaseProviderTargetServing({
      ...input,
      organizationId: other.project.organizationId,
    });
    expect((await head(other))?.activated_at).toBeNull();
  });
});

describe("fences that fire at commit time", () => {
  const deleteOrganization = (project: SeededProject) => () =>
    exec(
      project,
      "UPDATE organizations SET state = 'deleted' WHERE organization_id = ?1",
      project.organizationId,
    ).then(() => undefined);

  it("maps a tenant deleted between the read and the write to the typed conflict and writes nothing", async () => {
    const f = await fixture();
    const raced = wrapped(f.project, (db) => beforeFirstWrite(db, deleteOrganization(f.project)));
    await expect(raced.reservePgcfDatabaseRegistration(reserveInput(f))).rejects.toBeInstanceOf(
      DatabaseProviderConflictError,
    );
    expect(await count(f, "project_database_registration_reservations")).toBe(0);
  });

  it("maps the same race of a reauthorization to its own conflict", async () => {
    const f = await fixture({ dataChange: "isolate_dev_keeps_data" });
    const store = commandsOver();
    const { registration } = await store.reservePgcfDatabaseRegistration(reserveInput(f));
    await store.putPgcfDatabaseRegistration({
      claim: claimInput(f),
      registration,
      observedAt: NOW,
    });
    const input = {
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      environmentId: f.project.prodEnvironmentId,
      operationId: f.claim.operationId,
      claimId: f.claim.claimId,
      physicalEnvironmentId: f.physical,
      authorizedEnvironmentIds: [f.project.devEnvironmentId],
    };
    // the same operation already registered version 1, so this reauthorization is version 2
    const raced = wrapped(f.project, (db) => beforeFirstWrite(db, deleteOrganization(f.project)));
    await expect(raced.reservePgcfDatabaseReauthorization(input)).rejects.toBeInstanceOf(
      ProjectDatabaseRegistrationConflictError,
    );
    const reserved = await store
      .reservePgcfDatabaseReauthorization(input)
      .catch((error: unknown) => error);
    expect(reserved).toBeInstanceOf(Error);
    // a put of a registration nobody reserved is refused by the reauthorization fence too
    await expect(
      store.putPgcfDatabaseReauthorization({
        input,
        registration: {
          ...registration,
          registrationVersion: 2,
          authorizedEnvironmentIds: [f.project.devEnvironmentId],
        },
        observedAt: NOW,
      }),
    ).rejects.toBeInstanceOf(ProjectDatabaseRegistrationConflictError);
  });

  it("refuses a registration of the same target under another origin host", async () => {
    const f = await fixture();
    const store = commandsOver();
    const { registration } = await store.reservePgcfDatabaseRegistration(reserveInput(f));
    await store.putPgcfDatabaseRegistration({
      claim: claimInput(f),
      registration,
      observedAt: NOW,
    });
    await expect(
      store.reservePgcfDatabaseRegistration({
        ...reserveInput(f),
        originHost: "other.pgcf.example",
      }),
    ).rejects.toBeInstanceOf(DatabaseProviderConflictError);
  });
});

/** Full source-produced snapshot and immediate cleanup parent; no native guard is bypassed. */
/**
 * The data-change intent of a claim over `physical`: the real planned transition, its frozen snapshot and the
 * running cleanup run of the claim's operation. `share_prod_keeps_data` first gives Development its own database.
 */
async function nativeDataChangeIntent(
  project: SeededProject,
  physical: string,
  change: ProjectDataChangeKind,
  operationId: string,
): Promise<IntentColumns> {
  const f = { project, physical };
  const newPhysical = ulidOf("reauth-new-physical", sequence);
  if (change === "share_prod_keeps_data") {
    // The retained target is Production's physical database; Development owns the other real pre-change identity.
    await exec(
      f.project,
      "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      f.project.organizationId,
      f.project.projectId,
      newPhysical,
      STORED_NOW,
    );
    await exec(
      f.project,
      "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,assignment_version,data_environment_id,assigned_at) VALUES(?1,?2,?3,2,?4,?5)",
      f.project.organizationId,
      f.project.projectId,
      f.project.devEnvironmentId,
      newPhysical,
      STORED_NOW,
    );
    await exec(
      f.project,
      "UPDATE projects SET data_mode='isolated' WHERE project_id=?",
      f.project.projectId,
    );
  }
  const before = {
    dataMode: change === "share_prod_keeps_data" ? ("isolated" as const) : ("shared" as const),
    dev: {
      environmentId: f.project.devEnvironmentId,
      environment: "dev" as const,
      dataEnvironmentId: change === "share_prod_keeps_data" ? newPhysical : f.physical,
      assignmentVersion: change === "share_prod_keeps_data" ? 2 : 1,
      assignedAt: NOW,
    },
    prod: {
      environmentId: f.project.prodEnvironmentId,
      environment: "prod" as const,
      dataEnvironmentId: f.physical,
      assignmentVersion: 1,
      assignedAt: NOW,
    },
  };
  const snapshot = parseProjectDataChangeSnapshot({
    transition: planProjectDataChangeTransition({
      change,
      assignments: before,
      newDataEnvironmentId: newPhysical,
      prodDatabaseReady: true,
    }),
    environmentHeads: [
      { environmentId: f.project.devEnvironmentId, expectedHeadVersion: 0 },
      { environmentId: f.project.prodEnvironmentId, expectedHeadVersion: 0 },
    ],
    registrationGenerations: [
      { dataEnvironmentId: f.physical, registrationVersion: 1 },
      ...(change === "share_prod_keeps_data"
        ? [{ dataEnvironmentId: newPhysical, registrationVersion: 0 }]
        : []),
    ],
  });
  return {
    data_change: change,
    data_change_snapshot: JSON.stringify(snapshot),
    expected_etag: '"' + "a".repeat(64) + '"',
    cleanup_run_id: await seedCleanupRun(project, operationId),
  };
}
