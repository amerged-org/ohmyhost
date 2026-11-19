import { expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { Pool } from "pg";
import { applyNativeRealmPolicy } from "../../native-auth-runtime/src/policy.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
vi.mock("cloudflare:workers", () => {
  class Entrypoint {
    readonly env: unknown;
    constructor(context: unknown, env: unknown) {
      void context;
      this.env = env;
    }
  }
  return { WorkerEntrypoint: Entrypoint, WorkflowEntrypoint: Entrypoint };
});
import { createControlApi } from "../../control-api/src/app.js";
import { createNativeAuthManagementComposition } from "../../control-api/src/native-auth-composition.js";
import { createRegionalNativeAuthAdmin } from "../../control-api/src/native-auth-regional.js";
import { routeDependencies } from "../../control-api/test/helpers/app-routes-fixture.js";
import { createControlStore } from "../../control-store/src/store.js";
import { seedDevAccessProject } from "../../control-store/test/support/dev-access-fixture.js";
import { assertNativeAuthUnprovisionedPolicy } from "../../control-store/test/support/native-auth-unprovisioned-policy.js";
import type { TestControl } from "../../control-store/test/support/control-d1.js";
import { pgcfFixture } from "../../neon-management/test/pgcf-runtime-fixture.js";
import { managementWorkerFixture } from "../../neon-management/test/support/d1-management-worker.js";

it("accepts and replays the initial owner config before Native realm registration", async () => {
  const provider = await pgcfFixture(false);
  const worker = await managementWorkerFixture(provider, { nativeIntegrated: true });
  const control: TestControl = {
    core: worker.core,
    directory: worker.core,
    bindings: {
      CONTROL_CORE: worker.core,
      CONTROL_NATIVE_AUTH_LAUNCH_POLICY: '{"mode":"password-general-availability"}',
    },
    shards: { CONTROL_SHARD_0000: worker.core, CONTROL_SHARD_0001: worker.core },
    dispose: async () => undefined,
  };
  try {
    await assertNativeAuthUnprovisionedPolicy(control);
    const { project, principalId } = await seedDevAccessProject(control);
    await control.core
      .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
      .bind(project.organizationId)
      .run();
    const store = createControlStore(control.bindings);
    const scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.devEnvironmentId,
    };
    const policy = {
      ...scope,
      configurationRevision: 1,
      revocationEpoch: 1,
      enabled: true,
      canonicalOrigin: `https://dev-${project.handle}.check.omh.st`,
    };
    // Exercise the real unregistered DO: it cannot apply a SQL policy without a registration.
    expect((await worker.call("nativeAdminPolicyEu", policy)).ok).toBe(false);
    let policyCalls = 0;
    const binding = {
      async applyRealmPolicy(input: unknown) {
        policyCalls++;
        const result = await worker.call("nativeAdminPolicyEu", input);
        if (!result.ok) throw new Error("auth_unavailable");
        return result.result as { outcome: "applied" };
      },
      async applyProviderPolicy() {
        throw new Error("unexpected");
      },
      async listUsers() {
        throw new Error("unexpected");
      },
      async getUser() {
        throw new Error("unexpected");
      },
      async mutateUser() {
        throw new Error("unexpected");
      },
      async deliverInvitation() {
        throw new Error("unexpected");
      },
    };
    const admin = createRegionalNativeAuthAdmin({
      runtime: {
        getCustomerProject: async () => ({
          organizationId: project.organizationId,
          projectId: project.projectId,
          region: "eu",
        }),
      } as never,
      us: binding,
      eu: binding,
    });
    const port = createNativeAuthManagementComposition({
      catalog: {
        ...store.identity,
        acceptNativeUserOperation: store.identity.acceptNativeAuthUserMutation,
      },
      admin,
      cipher: {} as never,
    });
    const fixture = routeDependencies();
    const dependencies = routeDependencies({
      authentication: {
        authenticate: async () => ({
          actorId: principalId,
          credentialId: "workos_session:session_1",
          authorizationPrincipal: { kind: "user", subjectId: principalId as `user:${string}` },
          organizationIds: [parseUlid(project.organizationId)],
        }),
      },
      persistence: {
        ...fixture.persistence,
        getProject: async (organizationId, projectId) =>
          organizationId === project.organizationId && projectId === project.projectId
            ? {
                organizationId,
                projectId,
                name: "Fixture",
                handle: project.handle,
                dataMode: "shared",
                region: "eu",
                createdAt: "2026-10-28T10:00:00.000Z",
              }
            : null,
      },
      nativeAuthManagement: port,
    });
    const app = createControlApi(dependencies);
    const path = `https://api.test/v1/projects/${scope.projectId}/environments/${scope.environmentId}/auth`;
    const body = JSON.stringify({
      configurationRevision: 0,
      enabled: true,
      signupPolicy: "open",
      applicationName: "Canary",
    });
    const put = () =>
      app.request(path, {
        method: "PUT",
        headers: {
          authorization: "Bearer valid",
          "content-type": "application/json",
          "idempotency-key": "first-owner-config",
        },
        body,
      });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await put();
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        configurationRevision: 1,
        revocationEpoch: 1,
        enabled: true,
        readiness: { storage: false },
      });
    }
    expect(policyCalls).toBe(0);
    const get = await app.request(path, { headers: { authorization: "Bearer valid" } });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      configurationRevision: 1,
      enabled: true,
      readiness: { storage: false },
    });
    // A completed Dev registration uses the shared project database, but it does not
    // materialize Prod. This seeds the Core receipts only; no hosted state is implied.
    const operationId = newUlid(),
      claimId = newUlid();
    const devSchema = `omh_auth_${scope.environmentId.toLowerCase()}`,
      devRole = `omh_ar_${scope.environmentId.toLowerCase()}`;
    await control.core.batch([
      control.core
        .prepare(
          `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'prj_12345678901234567890','c1234567890123456789','op_fixture','eu-dev','r256-s500m',1,'2026-10-28T09:20:00.000000Z','2026-10-28T09:00:00.000000Z')`,
        )
        .bind(scope.organizationId, scope.projectId),
      control.core
        .prepare(
          `INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','c1234567890123456789','eu-dev','pgcf.example',?6,?7,1,1,?8,'active')`,
        )
        .bind(
          scope.organizationId,
          scope.projectId,
          scope.environmentId,
          operationId,
          claimId,
          devSchema,
          devRole,
          `${scope.projectId}:${scope.environmentId}`,
        ),
      control.core
        .prepare(
          `INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','c1234567890123456789',1,?6,?7,?8,?9,?10,?11)`,
        )
        .bind(
          scope.organizationId,
          scope.projectId,
          scope.environmentId,
          operationId,
          claimId,
          devSchema,
          devRole,
          `omh_am_${scope.environmentId.toLowerCase()}`,
          `omh_ab_${scope.projectId.toLowerCase()}`,
          NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
          NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
        ),
    ]);
    const prodPath = `https://api.test/v1/projects/${scope.projectId}/environments/${project.prodEnvironmentId}/auth`;
    const prod = await app.request(prodPath, {
      method: "PUT",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
        "idempotency-key": "first-prod-config",
      },
      body,
    });
    expect(prod.status).toBe(200);
    expect(await prod.json()).toMatchObject({
      configurationRevision: 1,
      enabled: true,
      readiness: { storage: false },
    });
    expect(policyCalls).toBe(0);
    // Any exact-realm effect history forces the real fence path. Exercise that path with
    // production SQL against PostgreSQL while another transaction holds the policy row.
    await control.core
      .prepare(
        `INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','b1234567890123456789','realm_role','role.create:realm_role',?4,'reserved')`,
      )
      .bind(scope.organizationId, scope.projectId, scope.environmentId, newUlid(), newUlid())
      .run();
    const schema = `policy_${scope.environmentId.toLowerCase()}`;
    await provider.control.pool.query(`CREATE SCHEMA ${schema}`);
    const sql = new Pool({
      connectionString: provider.control.pool.options.connectionString,
      options: `-c search_path=${schema}`,
    });
    try {
      await sql.query(
        "CREATE TABLE native_realm_policy (singleton boolean primary key, enabled boolean not null, revocation_epoch bigint not null, configuration_revision bigint not null)",
      );
      expect(
        await applyNativeRealmPolicy(sql, {
          configurationRevision: 1,
          revocationEpoch: 1,
          enabled: true,
        }),
      ).toBe(true);
      const lock = await sql.connect();
      try {
        await lock.query("BEGIN");
        await lock.query("SELECT * FROM native_realm_policy WHERE singleton=true FOR UPDATE");
        let entered!: () => void;
        const fencing = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const lockedAdmin = {
          ...admin,
          async applyRealmPolicy(value: unknown) {
            entered();
            const input = value as {
              configurationRevision: number;
              revocationEpoch: number;
              enabled: boolean;
            };
            if (!(await applyNativeRealmPolicy(sql, input))) throw new Error("auth_unavailable");
            return { outcome: "applied" as const };
          },
        };
        const lockedPort = createNativeAuthManagementComposition({
          catalog: {
            ...store.identity,
            acceptNativeUserOperation: store.identity.acceptNativeAuthUserMutation,
          },
          admin: lockedAdmin,
          cipher: {} as never,
        });
        const lockedApp = createControlApi({ ...dependencies, nativeAuthManagement: lockedPort });
        const pending = Promise.resolve(
          lockedApp.request(path, {
            method: "PUT",
            headers: {
              authorization: "Bearer valid",
              "content-type": "application/json",
              "idempotency-key": "pause-after-resource",
            },
            body: JSON.stringify({
              configurationRevision: 1,
              enabled: false,
              signupPolicy: "open",
              applicationName: "Canary",
            }),
          }),
        );
        await fencing;
        expect(
          await Promise.race([
            pending.then(() => "finished"),
            new Promise<string>((resolve) => setTimeout(() => resolve("locked"), 50)),
          ]),
        ).toBe("locked");
        await lock.query("COMMIT");
        const paused = await pending;
        expect(paused.status).toBe(200);
        expect(await paused.json()).toMatchObject({ configurationRevision: 2, enabled: false });
        expect(
          (await sql.query("SELECT enabled FROM native_realm_policy WHERE singleton=true")).rows[0],
        ).toEqual({ enabled: false });
      } finally {
        await lock.query("ROLLBACK").catch(() => undefined);
        lock.release();
      }
    } finally {
      await sql.end();
      await provider.control.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  } finally {
    await worker.dispose();
    await provider.control.stop();
  }
}, 180_000);
