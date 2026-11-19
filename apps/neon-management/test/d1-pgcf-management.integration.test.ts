const host = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { endPaid, makePaid } from "../../control-store/test/support/credit-fixtures.js";
import { splitStatements } from "../../control-store/test/support/sql.js";
import {
  preProviderScopeCore,
  providerScopeRows,
  PROVIDER_SCOPE_TABLES,
} from "../../control-store/test/management/provider-scope-fixture.js";
import { CORE_DATABASE_ID, seedManagementScope } from "./support/d1-pgcf-scope.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { projectSqlRoleName } from "@ohmyhost/platform";
import { pgcfFixture, id, databaseId } from "./pgcf-runtime-fixture.js";
import {
  MANAGEMENT_CLAIM,
  MANAGEMENT_SCOPE,
  seedManagementReauthorization,
  seedManagementDeletion,
} from "./support/d1-pgcf-scope.js";
import { managementWorkerFixture } from "./support/d1-management-worker.js";
import type { TestControl } from "../../control-store/test/support/control-d1.js";
import { mailFixture, fundMailFixture } from "../../control-store/test/mail/mail-fixture.js";
import { sourceFrameworkPlan } from "../../control-store/test/support/provider-fixtures.js";
import {
  seedAcceptedOperation,
  seedOperation,
  releaseProviderClaim,
} from "../../control-store/test/support/accepted-operation.js";
import { STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { readDeletionInventoryPlan } from "../../control-store/src/catalog/provisioning/lifecycle-inventory.js";
import { productAcceptanceStatements } from "../../control-store/src/catalog/product-api/accept-product-effects.js";

it("places the Native Auth target over the real private workerd RPC with lost-response replay", async () => {
  const provider = await pgcfFixture(false),
    worker = await managementWorkerFixture(provider);
  const control: TestControl = {
    core: worker.core,
    directory: worker.core,
    bindings: { CONTROL_CORE: worker.core },
    shards: { CONTROL_SHARD_0000: worker.core, CONTROL_SHARD_0001: worker.core },
    dispose: async () => undefined,
  };
  try {
    const f = await mailFixture(control, true, {
      ...sourceFrameworkPlan(false),
      auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
    });
    await fundMailFixture(control, f);
    provider.state.loseCreateResponse = true;
    const claim = { ...f.scope, ...f.fixture.accepted };
    expect(await worker.call("placeNativeAuthDatabase", claim)).toMatchObject({ ok: false });
    await worker.core
      .prepare("UPDATE credit_account SET paid_until=NULL WHERE organization_id=?1")
      .bind(claim.organizationId)
      .run();
    expect(await worker.call("placeNativeAuthDatabase", claim)).toMatchObject({
      ok: true,
      result: { status: "reconciliation_required", target: { projectId: claim.projectId } },
    });
    expect(await worker.call("prepareNativeAuthRealm", claim)).toMatchObject({ ok: false });
    await worker.core
      .prepare(
        "UPDATE credit_account SET paid_until='2099-01-01T00:00:00.000000Z' WHERE organization_id=?1",
      )
      .bind(claim.organizationId)
      .run();
    expect(await worker.call("placeNativeAuthDatabase", claim)).toMatchObject({
      ok: true,
      result: {
        status: "ready",
        target: { projectId: f.scope.projectId, sizeClassId: "r256-s500m" },
      },
    });
    expect(provider.stats.creates).toBe(1);
    const requests = provider.requests.filter(
      (request) => request.path === "/v1/databases" && request.method === "POST",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.key).toBe(requests[1]?.key);
    const prepared = await worker.call("prepareNativeAuthRealm", claim);
    expect(
      prepared,
      JSON.stringify({ prepared, errors: worker.appErrors, queries: worker.queries.slice(-5) }),
    ).toMatchObject({
      ok: true,
      result: {
        status: "ready",
        registration: {
          projectId: f.scope.projectId,
          environmentId: f.scope.environmentId,
          status: "active",
          registryVersion: 1,
        },
      },
    });
    expect(await worker.call("prepareNativeAuthRealm", claim)).toMatchObject({
      ok: true,
      result: { status: "ready" },
    });
    expect(
      await worker.core
        .prepare("SELECT count(*) AS n FROM native_auth_preparation_receipts WHERE project_id=?1")
        .bind(f.scope.projectId)
        .first(),
    ).toEqual({ n: 1 });
    const runtimeRole = `omh_ar_${f.scope.environmentId.toLowerCase()}`;
    const runtime = await provider.native(runtimeRole);
    try {
      await runtime.query(
        `INSERT INTO omh_auth_${f.scope.environmentId.toLowerCase()}."user" (name,email) VALUES ('Existing','existing@example.test')`,
      );
    } finally {
      await runtime.end();
    }
    await releaseProviderClaim(f.fixture.project);
    const operationId = await seedOperation(f.fixture.project),
      deploymentId = newUlid();
    await worker.core
      .prepare(
        "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','running',0,?6,?6)",
      )
      .bind(
        f.scope.organizationId,
        deploymentId,
        f.scope.projectId,
        f.scope.environmentId,
        operationId,
        STORED_NOW,
      )
      .run();
    const source = await worker.core
      .prepare("SELECT source_connection_id FROM deployment_plans WHERE plan_id=?1")
      .bind(f.fixture.published.planId)
      .first<{ source_connection_id: string }>();
    if (!source) throw new Error("missing source");
    const redeploy = await seedAcceptedOperation(f.fixture.project, f.scope.environmentId, {
      operationId,
      intent: {
        plan_id: f.fixture.published.planId,
        source_connection_id: source.source_connection_id,
        source_generation: 1,
        deployment_id: deploymentId,
      },
    });
    const nextClaim = { ...f.scope, operationId, claimId: redeploy.claimId };
    expect(await worker.call("placeNativeAuthDatabase", nextClaim)).toMatchObject({
      ok: true,
      result: { status: "ready" },
    });
    expect(await worker.call("prepareNativeAuthRealm", nextClaim)).toMatchObject({
      ok: true,
      result: { status: "ready", registration: { registryVersion: 1 } },
    });
    const verify = await provider.native(runtimeRole);
    try {
      expect(
        (
          await verify.query(
            `SELECT email FROM omh_auth_${f.scope.environmentId.toLowerCase()}."user"`,
          )
        ).rows,
      ).toEqual([{ email: "existing@example.test" }]);
    } finally {
      await verify.end();
    }
    expect(provider.stats.creates).toBe(1);
    const custodyScope = { ...f.scope, region: "eu" };
    expect(await worker.call("nativeCustodyFields", custodyScope)).toEqual({
      ok: true,
      result: ["credential", "engineSecret", "fingerprint", "receipt", "revokedAtVersion"],
    });
    await releaseProviderClaim(f.fixture.project);
    await worker.core
      .prepare(
        "UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND operation_id IN(?2,?3)",
      )
      .bind(f.scope.organizationId, claim.operationId, nextClaim.operationId)
      .run();
    const deletionOperationId = await seedOperation(f.fixture.project, { state: "queued" });
    const deletion = {
      organizationId: f.scope.organizationId,
      projectId: f.scope.projectId,
      operationId: deletionOperationId,
    };
    const deletionPlan = await readDeletionInventoryPlan(worker.core, {
      ...deletion,
      recordedAt: "2026-11-04T12:00:00.000Z",
    });
    await worker.core.batch(
      productAcceptanceStatements(
        worker.core,
        {
          input: {
            ...deletion,
            eventType: "ProjectDeletionRequestedV1",
            environmentId: f.scope.environmentId,
            billingEpochId: f.fixture.project.billingEpochId,
            expectedProjectVersion: 1,
            expectedEtag: `"${"a".repeat(64)}"`,
            cleanupRunId: newUlid(),
          },
          at: STORED_NOW,
        } as never,
        {
          deletion: deletionPlan,
          previousOperationId: null,
          previousAbsences: [],
          confirmedSourceGeneration: null,
          plan: null,
          rollback: null,
          dataChange: null,
        },
      ),
    );
    await worker.core
      .prepare(
        "UPDATE cleanup_runs SET state='running' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
      )
      .bind(deletion.organizationId, deletion.projectId, deletion.operationId)
      .run();
    // The actual Neon Worker reaches the actual Core short-name deletion RPC surface.
    expect(await worker.call("deleteNativeAuthProject", deletion)).toEqual({
      ok: true,
      result: { status: "reconciliation_required" },
    });
    expect(await worker.call("nativeCustodyFields", custodyScope)).toMatchObject({
      ok: true,
      result: expect.arrayContaining(["credential", "engineSecret"]),
    });
    provider.state.deleteSucceedsAfterReads = 1;
    const absent = {
      ok: true,
      result: {
        status: "absent",
        databaseId,
        registries: [`${f.scope.projectId}:${f.scope.environmentId}`],
      },
    };
    expect(await worker.call("deleteNativeAuthProject", deletion)).toEqual(absent);
    expect(await worker.call("deleteNativeAuthProject", deletion)).toEqual(absent);
    expect(provider.stats.deletes).toBe(1);
    expect(await worker.call("nativeCustodyFields", custodyScope)).toEqual({
      ok: true,
      result: ["deleted"],
    });
    expect(
      await worker.core
        .prepare(
          "SELECT ended_at IS NOT NULL closed FROM native_auth_database_targets WHERE project_id=?1",
        )
        .bind(f.scope.projectId)
        .first(),
    ).toEqual({ closed: 1 });
    expect(
      await worker.core
        .prepare(
          "SELECT quiesced_at IS NOT NULL quiesced,purged_at IS NOT NULL purged FROM native_auth_deletion_realms WHERE project_id=?1 AND operation_id=?2",
        )
        .bind(f.scope.projectId, deletion.operationId)
        .first(),
    ).toEqual({ quiesced: 1, purged: 1 });
  } finally {
    await worker.dispose();
    await provider.control.stop();
  }
}, 120_000);
it("provisions and migrates through the actual management/Core RPC and registry Durable Object with app SQL on real PG18 and no Control URI/pool", async () => {
  const provider = await pgcfFixture(false),
    worker = await managementWorkerFixture(provider);
  try {
    provider.state.loseCreateResponse = true;
    expect(await worker.call("placeProject", MANAGEMENT_CLAIM)).toMatchObject({ ok: false });
    expect(
      await worker.core
        .prepare("SELECT state FROM database_provider_operations WHERE step='database.create'")
        .first(),
    ).toEqual({ state: "dispatched" });
    expect(
      await worker.core.prepare("SELECT count(*) n FROM database_provider_target_heads").first(),
    ).toEqual({ n: 0 });
    provider.state.loseRoleResponseName = projectSqlRoleName(id(4), "runtime");
    expect(await worker.call("placeProject", MANAGEMENT_CLAIM)).toMatchObject({ ok: false });
    expect(await worker.call("placeProject", MANAGEMENT_CLAIM)).toMatchObject({
      ok: true,
      result: { status: "ready", provider: "pgcf" },
    });
    expect(provider.stats).toMatchObject({ creates: 1, roleCreates: 4 });
    const sql = "CREATE TABLE public.records(id integer PRIMARY KEY,value text NOT NULL);",
      body = new TextEncoder().encode(sql);
    const input = {
      ...MANAGEMENT_CLAIM,
      migrations: [
        {
          path: "20261029000000_records.sql",
          body: Array.from(body),
          size: body.byteLength,
          digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        },
      ],
      auth: { provider: "none" },
    };
    expect(await worker.call("loseRegistry")).toEqual({ ok: true, result: true });
    expect(await worker.call("migrateProject", input)).toMatchObject({ ok: false });
    expect(
      await worker.core
        .prepare("SELECT count(*) n FROM project_database_registration_receipts")
        .first(),
    ).toEqual({ n: 0 });
    expect(await worker.call("readRuntimeBinding", MANAGEMENT_SCOPE)).toMatchObject({
      ok: true,
      result: { status: "unavailable" },
    });
    expect(
      await worker.call("inspect", {
        organizationId: id(1),
        projectId: id(2),
        physicalEnvironmentId: id(4),
        region: "us",
      }),
    ).toMatchObject({
      ok: true,
      result: { provider: "pgcf", registrationVersion: 1, status: "active" },
    });
    const original = (
      await worker.core.prepare("SELECT * FROM pgcf_database_migration_receipts").all()
    ).results;
    const migrated = await worker.call("migrateProject", input);
    expect(
      migrated,
      JSON.stringify({ migrated, errors: worker.appErrors, queries: worker.queries.slice(-3) }),
    ).toMatchObject({
      ok: true,
      result: {
        status: "ready",
        databaseRegistration: {
          provider: "pgcf",
          registrationVersion: 1,
          authorizedEnvironmentIds: [id(4), id(5)],
        },
      },
    });
    expect(await worker.call("migrateProject", input)).toMatchObject({
      ok: true,
      result: { status: "ready", replayedPaths: ["20261029000000_records.sql"] },
    });
    const failingSql =
        "CREATE TABLE public.extra(id integer); ALTER TABLE public.missing ADD COLUMN secret text;",
      failingBody = new TextEncoder().encode(failingSql);
    const failed = await worker.call("migrateProject", {
      ...input,
      migrations: [
        ...input.migrations,
        {
          path: "20261030000000_extra.sql",
          body: Array.from(failingBody),
          size: failingBody.byteLength,
          digest: `sha256:${createHash("sha256").update(failingBody).digest("hex")}`,
        },
      ],
    });
    expect(failed).toEqual({
      ok: true,
      result: {
        status: "failed",
        errorCode: "DATABASE_MIGRATION_FAILED",
        migration: {
          reason: "execution_failed",
          path: "20261030000000_extra.sql",
          statementIndex: 2,
          sqlstate: "42P01",
        },
      },
    });
    expect(JSON.stringify(failed)).not.toMatch(/ALTER TABLE|secret text/iu);
    const lostSql = "CREATE TABLE public.lost_statement(id integer);",
      lostBody = new TextEncoder().encode(lostSql);
    worker.loseNextStatement(projectSqlRoleName(id(4), "migration"), lostSql);
    expect(
      await worker.call("migrateProject", {
        ...input,
        migrations: [
          ...input.migrations,
          {
            path: "20261030000000_lost.sql",
            body: Array.from(lostBody),
            size: lostBody.byteLength,
            digest: `sha256:${createHash("sha256").update(lostBody).digest("hex")}`,
          },
        ],
      }),
    ).toEqual({ ok: true, result: { status: "reconciliation_required" } });
    const check = await provider.native("app");
    try {
      expect(
        (await check.query("SELECT to_regclass('public.lost_statement') AS found")).rows,
      ).toEqual([{ found: null }]);
    } finally {
      await check.end();
    }
    expect(
      (await worker.core.prepare("SELECT * FROM pgcf_database_migration_receipts").all()).results,
    ).toEqual(original);
    worker.loseNextCommit(projectSqlRoleName(id(4), "migration"));
    expect(await worker.call("migrateProject", input)).toEqual({
      ok: true,
      result: { status: "reconciliation_required" },
    });
    expect(await worker.call("migrateProject", input)).toMatchObject({
      ok: true,
      result: { status: "ready", replayedPaths: ["20261029000000_records.sql"] },
    });
    expect(await worker.call("readRuntimeBinding", MANAGEMENT_SCOPE)).toMatchObject({
      ok: true,
      result: { status: "ready", databaseRegistration: { provider: "pgcf" } },
    });
    expect(await worker.call("pool")).toEqual({ ok: true, result: 0 });
    expect(await worker.call("missing", MANAGEMENT_CLAIM)).toMatchObject({ ok: false });
    expect(
      await worker.call("readCompute", {
        organizationId: id(1),
        projectId: id(2),
        environment: "dev",
      }),
    ).toMatchObject({
      ok: true,
      result: { project_id: id(2), environment: "dev", database: { provider: "pgcf" } },
    });
    expect(await worker.call("pool")).toEqual({ ok: true, result: 0 });
    const reauthorization = await seedManagementReauthorization(worker.core);
    expect(await worker.call("reauthorizeDataEnvironment", reauthorization)).toMatchObject({
      ok: true,
      result: {
        status: "ready",
        databaseRegistration: { registrationVersion: 2, authorizedEnvironmentIds: [id(5)] },
      },
    });
    expect(await worker.call("reauthorizeDataEnvironment", reauthorization)).toMatchObject({
      ok: true,
      result: { status: "ready", databaseRegistration: { registrationVersion: 2 } },
    });
    expect(await worker.call("readRuntimeBinding", MANAGEMENT_SCOPE)).toMatchObject({
      ok: true,
      result: { status: "unavailable" },
    });
    expect(
      await worker.call("readRuntimeBinding", { ...MANAGEMENT_SCOPE, environmentId: id(5) }),
    ).toMatchObject({
      ok: true,
      result: { status: "ready", databaseRegistration: { registrationVersion: 2 } },
    });
    expect(await worker.call("oldQuery", { text: "SELECT 1", values: [] })).toMatchObject({
      ok: false,
    });
    expect(worker.registryRequests()).toBe(0);
    const request = {
      ...(await seedManagementDeletion(worker.core, databaseId)),
      providerProjectId: provider.provider.projectId,
    };
    expect(
      await worker.call("deleteProject", { ...request, databaseId: "x".repeat(20) }),
    ).toMatchObject({ ok: false });
    expect(provider.stats.deletes).toBe(0);
    expect(await worker.call("deleteProject", request)).toMatchObject({
      ok: true,
      result: { status: "reconciliation_required" },
    });
    provider.state.deleteStatus = "succeeded";
    provider.state.observedState = "deleted";
    provider.state.observedGeneration = provider.state.generation;
    expect(await worker.call("deleteProject", request)).toMatchObject({
      ok: true,
      result: { status: "absent", provider: "pgcf" },
    });
    expect(
      await worker.core.prepare("SELECT state FROM database_provider_target_heads").first(),
    ).toEqual({ state: "retired" });
    expect(
      await worker.core.prepare("SELECT count(*) n FROM pgcf_database_claims").first(),
    ).toEqual({ n: 0 });
    expect(
      await worker.core.prepare("SELECT count(*) n FROM pgcf_database_claim_aborts").first(),
    ).toEqual({ n: 1 });
    expect(await worker.call("pool")).toEqual({ ok: true, result: 0 });
    expect((await worker.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await worker.dispose();
    await provider.control.stop();
  }
}, 120000);

it("adds Dev to a Prod-only shared PGCF database without revoking the Prod generation", async () => {
  const control = await createTestControl(),
    provider = await pgcfFixture(false);
  const entry = await import("../../control-store/src/worker-main.js"),
    { NeonManagementService } = await import("../src/worker-main.js");
  const coreBindings = {
    CONTROL_CORE: control.core,
    CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
    CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
  };
  host.env = coreBindings;
  const runtime = new entry.DatabaseManagementRuntime({}, coreBindings);
  const actualAdmin = provider.admin("us");
  let loseRegistrationResponse = false;
  const admin = {
    ...actualAdmin,
    register: async (value: Parameters<typeof actualAdmin.register>[0]) => {
      const receipt = await actualAdmin.register(value);
      if (loseRegistrationResponse) {
        loseRegistrationResponse = false;
        throw new Error("registry response lost after durable registration");
      }
      return receipt;
    },
  };
  const bindings = {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    DATABASE_MANAGEMENT_RUNTIME: runtime,
    PROJECT_DATABASE_ADMIN_US: admin,
    PROJECT_DATABASE_ADMIN_EU: provider.admin("eu"),
    PGCF_API_URL: "https://pgcf-api.aixyte.com",
    PGCF_APPS_PROJECT_ID: provider.provider.projectId,
    PGCF_APPS_API_KEY: "test-only-integrator-key",
  };
  host.env = bindings;
  const service = new NeonManagementService(
    {},
    bindings,
    provider.connect,
    undefined,
    provider.sleep,
  );
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(provider.providerFetch);
  const project = {
    organizationId: id(1),
    projectId: id(2),
    billingEpochId: id(3),
    shard: control.core,
  };
  const at = "2026-09-01T00:00:00.000000Z";
  const addEnvironment = async (environmentId: string, name: "dev" | "prod") => {
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at) VALUES(?1,?2,?3,?4,'{}',0,1,?5,?5)",
        )
        .bind(id(1), id(2), environmentId, name, at),
      control.core
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?4,1,?5)",
        )
        .bind(id(1), id(2), environmentId, id(4), at),
    ]);
  };
  try {
    await seedManagementScope(control.core, { historicalOnly: true });
    await addEnvironment(id(5), "prod");
    const prod = await seedAcceptedOperation(project, id(5));
    const prodClaim = {
      organizationId: id(1),
      projectId: id(2),
      environmentId: id(5),
      operationId: prod.operationId,
      claimId: prod.claimId,
    };
    expect(await service.placeProject(prodClaim)).toMatchObject({ status: "ready" });
    const body = new TextEncoder().encode("CREATE TABLE public.records(id integer PRIMARY KEY);");
    const migration = {
      migrations: [
        {
          path: "20261029000000_records.sql",
          body,
          size: body.byteLength,
          digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        },
      ],
      auth: { provider: "none" },
    };
    expect(await service.migrateProject({ ...prodClaim, ...migration })).toMatchObject({
      status: "ready",
      databaseRegistration: { registrationVersion: 1, authorizedEnvironmentIds: [id(5)] },
    });
    const scope = {
      organizationId: id(1),
      projectId: id(2),
      physicalEnvironmentId: id(4),
      region: "us" as const,
    };
    const prodBinding = { ...scope, environmentId: id(5), registrationVersion: 1 };
    const devBinding = { ...scope, environmentId: id(4), registrationVersion: 1 };
    const originalConnection = await provider.registry.authorize(prodBinding);
    await expect(provider.registry.authorize(devBinding)).rejects.toThrow(
      "project_database_unavailable",
    );

    await releaseProviderClaim(project);
    await addEnvironment(id(4), "dev");
    const dev = await seedAcceptedOperation(project, id(4));
    const devClaim = {
      organizationId: id(1),
      projectId: id(2),
      environmentId: id(4),
      operationId: dev.operationId,
      claimId: dev.claimId,
    };
    expect(await service.placeProject(devClaim)).toMatchObject({ status: "ready" });
    const input = { ...devClaim, ...migration };
    loseRegistrationResponse = true;
    // The registry advances even if management loses the response before recording the Core receipt.
    await expect(service.migrateProject(input)).rejects.toThrow("registry response lost");
    expect(await provider.registry.inspect(scope)).toMatchObject({
      provider: "pgcf",
      registrationVersion: 2,
      authorizedEnvironmentIds: [id(4), id(5)],
    });
    expect(
      await control.core
        .prepare(
          "SELECT registration_version FROM project_database_registration_receipts ORDER BY registration_version",
        )
        .all(),
    ).toMatchObject({ results: [{ registration_version: 1 }] });
    expect(await service.migrateProject(input)).toMatchObject({
      status: "ready",
      databaseRegistration: {
        provider: "pgcf",
        registrationVersion: 2,
        authorizedEnvironmentIds: [id(4), id(5)],
      },
    });
    expect(await service.migrateProject(input)).toMatchObject({
      status: "ready",
      databaseRegistration: { registrationVersion: 2 },
    });
    expect(await provider.registry.authorize(prodBinding)).toBe(originalConnection);
    await expect(provider.registry.authorize(devBinding)).rejects.toThrow(
      "project_database_unavailable",
    );
    expect(await provider.registry.authorize({ ...devBinding, registrationVersion: 2 })).toBe(
      originalConnection,
    );
    const current = await provider.registry.inspect(scope);
    if (!current || current.provider !== "pgcf") throw new Error("expected PGCF registration");
    const { status: _status, ...metadata } = current;
    void _status;
    const otherDatabaseId = "bbcdefghijklmnopqrst";
    const otherConnection = new URL(originalConnection);
    otherConnection.pathname = `/${otherDatabaseId}`;
    await expect(
      provider.registry.register({
        ...metadata,
        registrationVersion: 3,
        databaseId: otherDatabaseId,
        originDatabase: otherDatabaseId,
        connectionString: otherConnection.toString(),
      }),
    ).rejects.toThrow("project_database_unavailable");
    expect(await provider.registry.authorize(prodBinding)).toBe(originalConnection);
    expect(
      await control.core
        .prepare(
          "SELECT registration_version FROM project_database_registration_receipts ORDER BY registration_version",
        )
        .all(),
    ).toMatchObject({ results: [{ registration_version: 1 }, { registration_version: 2 }] });
    expect(provider.stats.creates).toBe(1);
  } finally {
    fetch.mockRestore();
    await control.dispose();
    await provider.control.stop();
  }
}, 120000);

it("executes the same actual classes under instrumentation: Paid persistence, populated FK-forward bytes and stale epoch", async () => {
  const control = await createTestControl(),
    provider = await pgcfFixture(false);
  const entry = await import("../../control-store/src/worker-main.js"),
    { NeonManagementService } = await import("../src/worker-main.js");
  const make = (
    core: typeof control.core,
    f: typeof provider,
    databaseIdValue = CORE_DATABASE_ID,
  ) => {
    const coreBindings = {
      CONTROL_CORE: core,
      CONTROL_CORE_DATABASE_ID: databaseIdValue,
      CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
    };
    host.env = coreBindings;
    const runtime = new entry.DatabaseManagementRuntime({}, coreBindings);
    const bindings = {
      RUNTIME_CONFIGURATION_STATE: "configured" as const,
      DATABASE_MANAGEMENT_RUNTIME: runtime,
      PROJECT_DATABASE_ADMIN_US: f.admin("us"),
      PROJECT_DATABASE_ADMIN_EU: f.admin("eu"),
      PGCF_API_URL: "https://pgcf-api.aixyte.com",
      PGCF_APPS_PROJECT_ID: f.provider.projectId,
      PGCF_APPS_API_KEY: "test-only-integrator-key",
    };
    host.env = bindings;
    return {
      runtime,
      bindings,
      service: new NeonManagementService({}, bindings, f.connect, undefined, f.sleep),
      store: createControlStore(coreBindings),
    };
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(provider.providerFetch);
  try {
    await seedManagementScope(control.core);
    const actual = make(control.core, provider),
      at = new Date().toISOString();
    await makePaid(control.core, id(1), "2099-01-01T00:00:00.000Z", at);
    // A create that the provider has not finished is reported for reconciliation, then resumed.
    provider.state.createStatus = "pending";
    expect(await actual.service.placeProject(MANAGEMENT_CLAIM)).toEqual({
      status: "reconciliation_required",
      reason: "provider_provisioning",
    });
    expect(provider.sleeps).toEqual(Array(30).fill(1000));
    expect(provider.state.createReads).toBe(30);
    // Paid ends while that create is still pending: its replay keeps the smallest class it was placed with.
    await endPaid(control.core, id(1), new Date().toISOString());
    provider.state.createStatus = "succeeded";
    expect(await actual.service.placeProject(MANAGEMENT_CLAIM)).toMatchObject({ status: "ready" });
    expect(provider.state.sizeClassId).toBe("r256-s500m");
    expect(provider.stats.creates).toBe(1);
    // The customer schemas the migration owns are granted to the runtime roles.
    const body = new TextEncoder().encode(
      "CREATE TABLE public.records(id integer PRIMARY KEY); CREATE SCHEMA IF NOT EXISTS private; CREATE TABLE private.audit(id integer PRIMARY KEY);",
    );
    const migrations = [
      {
        path: "20261029000000_records.sql",
        body,
        size: body.byteLength,
        digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      },
    ];
    await actual.service.migrateProject({
      ...MANAGEMENT_CLAIM,
      migrations,
      auth: { provider: "none" },
    });
    expect(await actual.service.readRuntimeBinding(MANAGEMENT_SCOPE)).toMatchObject({
      status: "ready",
    });
    await endPaid(control.core, id(1), new Date().toISOString());
    expect(await actual.service.placeProject(MANAGEMENT_CLAIM)).toMatchObject({ status: "ready" });
    expect(provider.state.sizeClassId).toBe("r256-s500m");
    expect(provider.stats.deletes).toBe(0);
    const request = await seedManagementReauthorization(control.core);
    await actual.runtime.reservePgcfDatabaseReauthorization(request);
    const before = await providerScopeRows(control.core),
      old = await preProviderScopeCore();
    try {
      // Current runtime/financial commands run only on the current schema. The older0352 oracle receives
      // their actual provider facts and real static parents; it never calls a newer runtime helper.
      await seedManagementScope(old.core);
      await old.core
        .prepare(
          "INSERT INTO operations(organization_id,project_id,operation_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
        )
        .bind(id(1), id(2), id(40), id(3), new Date().toISOString().replace("Z", "000Z"))
        .run();
      const statements = PROVIDER_SCOPE_TABLES.flatMap((table, index) =>
        (before[index] ?? []).map((record) => {
          const row = record as Record<string, unknown>,
            columns = Object.keys(row);
          return old.core
            .prepare(
              `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
            )
            .bind(
              ...columns.map((column) =>
                Array.isArray(row[column]) ? Uint8Array.from(row[column] as number[]) : row[column],
              ),
            );
        }),
      );
      await old.core.batch(statements);
      expect(await providerScopeRows(old.core)).toEqual(before);
      await old.core.batch(
        splitStatements(
          readFileSync(
            new URL(
              "../../control-store/migrations/core/0353_provider_operation_scope.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        ).map((sql) => old.core.prepare(sql)),
      );
      expect(await providerScopeRows(old.core)).toEqual(before);
      expect((await old.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally {
      await old.dispose();
    }
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await actual.service.reauthorizeDataEnvironment(request)).toMatchObject({
      status: "ready",
      databaseRegistration: { registrationVersion: 2 },
    });
    const requestsBefore = provider.requests.length,
      newEpoch = id(72),
      clock = new Date().toISOString().slice(0, 23) + "000Z";
    await control.core.batch([
      control.core
        .prepare("UPDATE billing_epochs SET ended_at=? WHERE billing_epoch_id=?")
        .bind(clock, id(3)),
      control.core
        .prepare(
          "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,created_by_principal_id) VALUES(?,?,?,?, 'user:owner')",
        )
        .bind(id(1), newEpoch, id(2), clock),
      control.core
        .prepare(
          "UPDATE projects SET active_billing_epoch_id=? WHERE organization_id=? AND project_id=?",
        )
        .bind(newEpoch, id(1), id(2)),
    ]);
    await expect(actual.service.placeProject(request)).rejects.toThrow();
    expect(provider.requests).toHaveLength(requestsBefore);
    const deletion = {
      ...(await seedManagementDeletion(control.core, databaseId)),
      providerProjectId: provider.provider.projectId,
    };
    expect(await actual.service.deleteProject(deletion)).toMatchObject({
      status: "reconciliation_required",
    });
    provider.state.deleteStatus = "succeeded";
    provider.state.observedState = "deleted";
    provider.state.observedGeneration = provider.state.generation;
    expect(await actual.service.deleteProject(deletion)).toMatchObject({ status: "absent" });
    expect(
      await control.core.prepare("SELECT count(*) n FROM pgcf_database_claims").first(),
    ).toEqual({ n: 0 });
  } finally {
    fetch.mockRestore();
    await control.dispose();
    await provider.control.stop();
  }
}, 120000);
