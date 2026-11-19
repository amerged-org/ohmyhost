import { expect, it, vi } from "vitest";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { mailFixture, fundMailFixture } from "../../control-store/test/mail/mail-fixture.js";
import { sourceFrameworkPlan } from "../../control-store/test/support/provider-fixtures.js";
import { CORE_DATABASE_ID } from "./support/d1-pgcf-scope.js";
import { pgcfFixture } from "./pgcf-runtime-fixture.js";
import { createNativeAuthRegistry } from "../../native-auth-runtime/src/registry.js";
import {
  releaseProviderClaim,
  seedOperation,
} from "../../control-store/test/support/accepted-operation.js";
import { readDeletionInventoryPlan } from "../../control-store/src/catalog/provisioning/lifecycle-inventory.js";
import { productAcceptanceStatements } from "../../control-store/src/catalog/product-api/accept-product-effects.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      _ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      _ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

it("provisions and replays a scoped Native realm through the Node Worker, real Core D1, registry and PostgreSQL", async () => {
  const control = await createTestControl();
  const pgcf = await pgcfFixture(false);
  const core = await import("../../control-store/src/worker-main.js");
  const neon = await import("../src/worker-main.js");
  type PolicyInput = {
    organizationId: string;
    projectId: string;
    environmentId: string;
    configurationRevision: number;
    revocationEpoch: number;
    enabled: boolean;
    canonicalOrigin: string | null;
  };
  const nativeModulePath = "../../native-auth-runtime/src/worker-main.ts";
  const native = (await import(nativeModulePath)) as {
    NativeAdminOperations: new (
      env: never,
      pool: Awaited<ReturnType<typeof pgcf.native>>,
      config: unknown,
      current: () => Promise<boolean>,
    ) => { applyRealmPolicy(input: PolicyInput): Promise<{ outcome: "applied" }> };
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(pgcf.providerFetch);
  let adminPool: Awaited<ReturnType<typeof pgcf.native>> | undefined;
  try {
    const fixture = await mailFixture(control, true, {
      ...sourceFrameworkPlan(false),
      auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
    });
    await fundMailFixture(control, fixture);
    const coreBindings = {
      ...control.bindings,
      CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
      CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
    };
    const resources = new core.NativeAuthResourceRuntime({}, coreBindings);
    const authority = new core.NativeAuthRegistryAuthorityRuntime({}, coreBindings);
    const adminAuthority = new core.NativeAuthAdminAuthorityRuntime({}, coreBindings);
    let stored: unknown;
    const registry = createNativeAuthRegistry({
      regionId: "eu-dev",
      keyBase64: btoa("k".repeat(32)),
      storage: {
        async get<T>() {
          return stored as T | undefined;
        },
        async put(_key, value) {
          stored = structuredClone(value);
        },
      },
      authority,
      invalidate: async () => {},
    });
    const admin = {
      applyRealmPolicy: async (input: PolicyInput) => {
        const registered = await registry.resolve({
          projectId: input.projectId,
          environmentId: input.environmentId,
        });
        adminPool ??= await pgcf.native(registered.receipt.role);
        const runtime = new native.NativeAdminOperations(
          { NATIVE_AUTH_ADMIN_AUTHORITY: adminAuthority } as never,
          adminPool,
          registered,
          async () =>
            !!(await authority.readRegistration({
              projectId: input.projectId,
              environmentId: input.environmentId,
            })),
        );
        return runtime.applyRealmPolicy(input);
      },
    };
    const bindings = {
      RUNTIME_CONFIGURATION_STATE: "configured" as const,
      PGCF_API_URL: "https://pgcf-api.aixyte.com",
      PGCF_APPS_PROJECT_ID: pgcf.provider.projectId,
      PGCF_APPS_API_KEY: "test-only-integrator-key",
      NATIVE_AUTH_RESOURCE_RUNTIME: resources,
      NATIVE_AUTH_REGISTRY_AUTHORITY: authority,
      NATIVE_AUTH_REGISTRY_EU: registry,
      NATIVE_AUTH_ADMIN_EU: admin,
      NATIVE_AUTH_DELETION_RUNTIME: new core.NativeAuthDeletionRuntime({}, coreBindings),
    };
    const service = new neon.NeonManagementService({}, bindings, pgcf.connect);
    const claim = { ...fixture.scope, ...fixture.fixture.accepted };
    pgcf.state.loseCreateResponse = true;
    await expect(service.placeNativeAuthDatabase(claim)).rejects.toThrow();
    expect(await service.placeNativeAuthDatabase(claim)).toMatchObject({ status: "ready" });
    expect(pgcf.stats.creates).toBe(1);
    const result = await service.prepareNativeAuthRealm(claim);
    expect(result).toMatchObject({
      status: "ready",
      registration: {
        projectId: claim.projectId,
        environmentId: claim.environmentId,
        status: "active",
      },
      policy: { enabled: true },
    });
    expect(await service.prepareNativeAuthRealm(claim)).toMatchObject({ status: "ready" });
    expect(
      (
        await control.core
          .prepare("select count(*) as n from native_auth_preparation_receipts where project_id=?1")
          .bind(claim.projectId)
          .first()
      )?.["n"],
    ).toBe(1);
    const role = `omh_ar_${claim.environmentId.toLowerCase()}`;
    const database = await pgcf.native(role);
    try {
      expect(
        (await database.query("select enabled, revocation_epoch from native_realm_policy")).rows[0],
      ).toMatchObject({ enabled: true, revocation_epoch: "1" });
    } finally {
      await database.end();
    }
    await expect(
      service.prepareNativeAuthRealm({ ...claim, organizationId: "00000000000000000000000001" }),
    ).rejects.toThrow();
    const restoreService = new neon.NativeAuthRestorePreparationService({}, bindings);
    await expect(restoreService.prepare(null)).rejects.toThrow("Invalid Native restore scope");
    await expect(restoreService.prepare({})).rejects.toThrow(
      "Native restore authority unavailable",
    );
    await releaseProviderClaim(fixture.fixture.project);
    await control.core
      .prepare(
        "UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND operation_id=?2",
      )
      .bind(claim.organizationId, claim.operationId)
      .run();
    const deletionOperationId = await seedOperation(fixture.fixture.project, { state: "queued" });
    const deletion = {
      organizationId: claim.organizationId,
      projectId: claim.projectId,
      operationId: deletionOperationId,
    };
    const deletionPlan = await readDeletionInventoryPlan(control.core, {
      ...deletion,
      recordedAt: "2026-11-04T12:00:00.000Z",
    });
    await control.core.batch(
      productAcceptanceStatements(
        control.core,
        {
          input: {
            ...deletion,
            eventType: "ProjectDeletionRequestedV1",
            environmentId: claim.environmentId,
            billingEpochId: fixture.fixture.project.billingEpochId,
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
    await control.core
      .prepare(
        "UPDATE cleanup_runs SET state='running' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
      )
      .bind(deletion.organizationId, deletion.projectId, deletion.operationId)
      .run();
    expect(await service.deleteNativeAuthProject(deletion)).toEqual({
      status: "reconciliation_required",
    });
    pgcf.state.deleteSucceedsAfterReads = 1;
    const absent = await service.deleteNativeAuthProject(deletion);
    expect(absent).toMatchObject({ status: "absent", databaseId: "abcdefghijklmnopqrst" });
    expect(await service.deleteNativeAuthProject(deletion)).toEqual(absent);
    expect(pgcf.stats.deletes).toBe(1);
  } finally {
    await adminPool?.end();
    vi.restoreAllMocks();
    await pgcf.control.stop();
    await control.dispose();
  }
}, 120_000);
