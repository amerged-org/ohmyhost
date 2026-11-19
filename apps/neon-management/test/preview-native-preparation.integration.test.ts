import {
  parseRateCard,
  planPublish,
  planActivate,
  readState,
  applyPlan,
} from "../../../scripts/credit-prices-model.mjs";
import { expect, it, vi } from "vitest";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { mailFixture, fundMailFixture } from "../../control-store/test/mail/mail-fixture.js";
import { sourceFrameworkPlan } from "../../control-store/test/support/provider-fixtures.js";
import {
  admitConsentingUser,
  STORED_NOW,
} from "../../control-store/test/support/platform-fixtures.js";
import { releaseProviderClaim } from "../../control-store/test/support/accepted-operation.js";
import { acceptedPreviewSourceStatements } from "../../control-store/src/catalog/previews/source.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { databaseId, pgcfFixture } from "./pgcf-runtime-fixture.js";
import { createNativeAuthRegistry } from "../../native-auth-runtime/src/registry.js";
import {
  applyNativePreviewRealmPolicy,
  lockNativeRealmPolicy,
} from "../../native-auth-runtime/src/policy.js";
import { CORE_DATABASE_ID } from "./support/d1-pgcf-scope.js";
import { nativeAuthRoleNames } from "../src/native-auth-roles.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      _context: unknown,
      readonly env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      _context: unknown,
      readonly env: unknown,
    ) {}
  },
}));

it("prepares a preview Native realm with real Core, provider receipts and PostgreSQL without an active deployment", async () => {
  const control = await createTestControl(),
    pgcf = await pgcfFixture(false),
    core = await import("../../control-store/src/worker-main.js"),
    neon = await import("../src/worker-main.js");
  const native = await import("../../native-auth-runtime/src/worker-main.js");
  let adminPool: Awaited<ReturnType<typeof pgcf.native>> | undefined;
  try {
    const f = await mailFixture(control, true, {
      ...sourceFrameworkPlan(false),
      auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
    });
    await fundMailFixture(control, f);
    await releaseProviderClaim(f.fixture.project);
    const p = f.fixture.project,
      db = control.core;
    await admitConsentingUser(control, p.organizationId, "user_nativepreview");
    const selected = await db
      .prepare(
        "SELECT source_connection_id,generation FROM project_source_bindings WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId)
      .first<{ source_connection_id: string; generation: number }>();
    if (!selected) throw new Error("source missing");
    await db.batch([
      db
        .prepare(
          "UPDATE environments SET active_deployment_id=NULL,active_revision_id=NULL WHERE organization_id=?1 AND environment_id=?2",
        )
        .bind(p.organizationId, p.prodEnvironmentId),
      db
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
        )
        .bind(p.organizationId, p.projectId, p.prodEnvironmentId, STORED_NOW),
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?3,1,?4)",
        )
        .bind(p.organizationId, p.projectId, p.prodEnvironmentId, STORED_NOW),
      db
        .prepare(
          "UPDATE project_source_bindings SET commit_sha=?3 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(p.organizationId, p.projectId, "a".repeat(40)),
    ]);
    const coreBindings = {
      ...control.bindings,
      CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
      CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
    };
    const store = (await import("../../control-store/src/store.js")).createControlStore(
      coreBindings,
    );
    const preview = await store.previews.ensure({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environment: "prod",
      environmentId: p.prodEnvironmentId,
      principalId: "user:user_nativepreview",
      previewId: newUlid(),
      capability: {
        lookupSha256: "a".repeat(64),
        ciphertext: "A".repeat(91),
        nonce: "A".repeat(16),
        keyVersion: 1,
        tokenGeneration: 1,
      },
    });
    if (!preview.preview.targetSource) throw new Error("target missing");
    const queued = await store.previews.queueNativePreparation({
      fence: { previewId: preview.preview.previewId, runtimeGeneration: 1, tokenGeneration: 1 },
      source: preview.preview.targetSource,
      buildPlanSha256: "d".repeat(64),
      authProvider: "omh-native",
    });
    const priceAt = Date.parse("2026-11-15T08:00:00.000Z"),
      startsAt = Date.parse("2026-11-15T09:00:00.000Z");
    const card = parseRateCard(
      JSON.stringify({
        id: "cloudflare-preview-standard-3-2026-11-09-v1",
        effective_from: "2026-11-15T09:00:00.000Z",
        rates: [
          {
            meter: "preview.container.standard-3",
            unit: "usd_pico",
            units_per_charge: "7000000",
            provider_cost_micros: "7",
            credit_micros: "2300",
          },
        ],
      }),
    );
    await applyPlan(db, planPublish(await readState(db), card, priceAt));
    await applyPlan(
      db,
      planActivate(
        await readState(db),
        { meter: "preview.container.standard-3", cardId: card.id, startsAtMs: startsAt },
        priceAt,
      ),
    );
    let wake: Awaited<ReturnType<typeof store.previews.reserveUsage>> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await pgcf.providerFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (!wake && method === "POST" && new URL(url).pathname === "/v1/databases")
        wake = await store.previews.reserveUsage({
          previewId: preview.preview.previewId,
          runtimeGeneration: preview.preview.runtimeGeneration,
          tokenGeneration: preview.preview.tokenGeneration,
          expectedRowVersion: preview.preview.rowVersion,
          intervalId: "wake-during-native",
          applicationId: "a".repeat(32),
          seconds: 60,
          holdSequence: 1,
          start: true,
        });
      return response;
    });
    const resources = new core.NativeAuthResourceRuntime({}, coreBindings),
      authority = new core.NativeAuthRegistryAuthorityRuntime({}, coreBindings),
      adminAuthority = new core.NativeAuthAdminAuthorityRuntime({}, coreBindings),
      previewAuthority = new core.PreviewNativeAuthAuthorityRuntime({}, coreBindings),
      prep = new core.PreviewNativePreparationRuntime({}, coreBindings);
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
      applyRealmPolicy: async (
        input: Parameters<InstanceType<typeof native.NativeAdminOperations>["applyRealmPolicy"]>[0],
      ) => {
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
    const previewPolicy = {
      applyPreviewRealmPolicy: async (input: {
        fence: { previewId: string; runtimeGeneration: number; tokenGeneration: number };
        authGeneration: number;
        revocationEpoch: number;
        configurationRevision: number;
      }) => {
        const before = await previewAuthority.resolve(input.fence);
        if (!before?.registration) throw new Error("missing authority");
        const pool = await pgcf.native(before.registration.role);
        try {
          if (
            !(await applyNativePreviewRealmPolicy(pool, {
              previewId: input.fence.previewId,
              authGeneration: input.authGeneration,
              revocationEpoch: input.revocationEpoch,
              configurationRevision: input.configurationRevision,
            }))
          )
            throw new Error("preview policy denied");
        } finally {
          await pool.end();
        }
        const after = await previewAuthority.resolve(input.fence);
        if (!after || after.preview.authGeneration !== before.preview.authGeneration)
          throw new Error("authority changed");
        return { outcome: "applied" as const };
      },
    };
    const bindings = {
      RUNTIME_CONFIGURATION_STATE: "configured" as const,
      PGCF_API_URL: "https://pgcf-api.aixyte.com",
      PGCF_APPS_PROJECT_ID: pgcf.provider.projectId,
      PGCF_APPS_API_KEY: "test-only-integrator-key",
      NATIVE_AUTH_RESOURCE_RUNTIME: resources,
      NATIVE_AUTH_REGISTRY_AUTHORITY: authority,
      PREVIEW_NATIVE_PREPARATION_RUNTIME: prep,
      NATIVE_AUTH_REGISTRY_EU: registry,
      NATIVE_AUTH_ADMIN_EU: admin,
      NATIVE_PREVIEW_POLICY_EU: previewPolicy,
    };
    const service = new neon.PreviewNativePreparationService({}, bindings, pgcf.connect);
    const result = await service.prepare({ operationId: queued.operationId });
    expect(result).toMatchObject({ state: "succeeded", previewId: preview.preview.previewId });
    expect(wake?.preview.runtimeGeneration).toBe(2);
    if (!wake) throw new Error("wake not exercised");
    await store.previews.closeUsage({
      previewId: preview.preview.previewId,
      runtimeGeneration: wake.preview.runtimeGeneration,
      intervalId: "wake-during-native",
      activeMilliseconds: 0,
      containerStartAttempted: false,
    });
    expect(
      await db
        .prepare(
          "SELECT state,active_milliseconds,cpu_milliseconds,charged_micros FROM project_preview_usage_intervals WHERE preview_id=?1 AND interval_id='wake-during-native'",
        )
        .bind(preview.preview.previewId)
        .first(),
    ).toEqual({
      state: "unstarted",
      active_milliseconds: 0,
      cpu_milliseconds: null,
      charged_micros: 0,
    });
    expect(await store.previews.listUsageForReconciliation({ limit: 100 })).toEqual([]);

    expect(await service.prepare({ operationId: queued.operationId })).toMatchObject({
      state: "succeeded",
    });
    expect(pgcf.stats.creates).toBe(1);
    const callsBefore = pgcf.requests.length;
    await db.batch(
      acceptedPreviewSourceStatements(db, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        eventId: "code-save",
        sourceConnectionId: selected.source_connection_id,
        sourceGeneration: selected.generation,
        commitSha: "b".repeat(40),
        now: new Date().toISOString(),
      }),
    );
    const changed = await store.previews.get({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environment: "prod",
      principalId: "user:user_nativepreview",
    });
    if (!changed?.preview.targetSource) throw new Error("updated source missing");
    expect(
      await previewAuthority.resolve({
        previewId: changed.preview.previewId,
        runtimeGeneration: changed.preview.runtimeGeneration,
        tokenGeneration: changed.preview.tokenGeneration,
      }),
    ).toBeNull();
    const reuse = await store.previews.queueNativePreparation({
      fence: {
        previewId: changed.preview.previewId,
        runtimeGeneration: changed.preview.runtimeGeneration,
        tokenGeneration: changed.preview.tokenGeneration,
      },
      source: changed.preview.targetSource,
      buildPlanSha256: "d".repeat(64),
      authProvider: "omh-native",
    });
    expect(reuse.state).toBe("succeeded");
    expect(pgcf.requests.length).toBe(callsBefore);
    await db
      .prepare(
        "UPDATE native_auth_realms SET configuration_revision=configuration_revision+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(p.organizationId, p.projectId, p.prodEnvironmentId)
      .run();
    const policy = await adminAuthority.resolve({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.prodEnvironmentId,
    });
    await admin.applyRealmPolicy({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.prodEnvironmentId,
      configurationRevision: policy.realm.configurationRevision,
      revocationEpoch: policy.revocationEpoch,
      enabled: policy.ownerEnabled,
      canonicalOrigin: policy.realm.canonicalOrigin,
    });
    const refresh = await store.previews.queueNativePreparation({
      fence: {
        previewId: changed.preview.previewId,
        runtimeGeneration: changed.preview.runtimeGeneration,
        tokenGeneration: changed.preview.tokenGeneration,
      },
      source: changed.preview.targetSource,
      buildPlanSha256: "d".repeat(64),
      authProvider: "omh-native",
    });
    expect(refresh.state).toBe("pending");
    expect(await service.prepare({ operationId: refresh.operationId })).toMatchObject({
      state: "succeeded",
    });
    expect(pgcf.stats.creates).toBe(1);
    const current = await store.previews.get({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environment: "prod",
      principalId: "user:user_nativepreview",
    });
    if (!current) throw new Error("preview missing");
    const rotated = await store.previews.rotate({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environment: "prod",
      principalId: "user:user_nativepreview",
      previewId: current.preview.previewId,
      expectedRowVersion: current.preview.rowVersion,
      expectedTokenGeneration: current.preview.tokenGeneration,
      requestId: "rotation-native",
      capability: {
        lookupSha256: "b".repeat(64),
        ciphertext: "B".repeat(91),
        nonce: "B".repeat(16),
        keyVersion: 1,
        tokenGeneration: 2,
      },
    });
    const fence = {
      previewId: rotated.preview.previewId,
      runtimeGeneration: rotated.preview.runtimeGeneration,
      tokenGeneration: rotated.preview.tokenGeneration,
    };
    await expect(store.previews.confirmRotation(fence)).rejects.toThrow();
    const drain = await previewAuthority.resolveDrain(fence);
    if (!drain?.hasRegistration) throw new Error("drain scope missing");
    const drainPool = await pgcf.native(
      (await registry.resolve({ projectId: p.projectId, environmentId: p.prodEnvironmentId }))
        .receipt.role,
    );
    try {
      const client = await drainPool.connect();
      try {
        await client.query("begin");
        await lockNativeRealmPolicy(client, {
          previewId: fence.previewId,
          authGeneration: drain.authGeneration,
        });
        await client.query("commit");
      } finally {
        client.release();
      }
    } finally {
      await drainPool.end();
    }
    await previewAuthority.recordDrain({ ...fence, authGeneration: drain.authGeneration });
    await store.previews.confirmRotation(fence);
    const afterRotation = await store.previews.get({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environment: "prod",
      principalId: "user:user_nativepreview",
    });
    if (!afterRotation?.preview.targetSource) throw new Error("rotated preview missing");
    expect(afterRotation.preview.authGeneration).toBe(2);
    expect(
      await store.previews.readNativePreparation({
        previewId: afterRotation.preview.previewId,
        sourceSequence: afterRotation.preview.targetSource.sequence,
      }),
    ).toBeNull();
    const rotatedJob = await store.previews.queueNativePreparation({
      fence: {
        previewId: afterRotation.preview.previewId,
        runtimeGeneration: afterRotation.preview.runtimeGeneration,
        tokenGeneration: afterRotation.preview.tokenGeneration,
      },
      source: afterRotation.preview.targetSource,
      buildPlanSha256: "d".repeat(64),
      authProvider: "omh-native",
    });
    expect(rotatedJob.state).toBe("pending");
    expect(await service.prepare({ operationId: rotatedJob.operationId })).toMatchObject({
      state: "succeeded",
    });
    expect(pgcf.stats.creates).toBe(1);
    expect(
      await db
        .prepare("SELECT 1 FROM product_command_intents WHERE operation_id=?1")
        .bind(queued.operationId)
        .first(),
    ).toBeNull();
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM project_preview_native_policy_receipts WHERE preview_id=?1",
        )
        .bind(preview.preview.previewId)
        .first(),
    ).toEqual({ n: 3 });
  } finally {
    await adminPool?.end();
    vi.restoreAllMocks();
    await control.dispose();
    await pgcf.control.stop();
  }
}, 120_000);

it("reconciles only known Native effects after a save and leaves an unproven role isolated from new jobs", async () => {
  const core = await import("../../control-store/src/worker-main.js"),
    neon = await import("../src/worker-main.js");
  for (const lostRoleReply of [false, true]) {
    const control = await createTestControl(),
      pgcf = await pgcfFixture(false);
    try {
      const f = await mailFixture(control, true, {
        ...sourceFrameworkPlan(false),
        auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
      });
      await fundMailFixture(control, f);
      await releaseProviderClaim(f.fixture.project);
      const p = f.fixture.project,
        db = control.core;
      await admitConsentingUser(control, p.organizationId, "user_native_reconcile");
      await db.batch([
        db
          .prepare(
            "UPDATE project_source_bindings SET commit_sha=?3 WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(p.organizationId, p.projectId, "a".repeat(40)),
        db
          .prepare(
            "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
          )
          .bind(p.organizationId, p.projectId, p.prodEnvironmentId, STORED_NOW),
        db
          .prepare(
            "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?3,1,?4)",
          )
          .bind(p.organizationId, p.projectId, p.prodEnvironmentId, STORED_NOW),
      ]);
      const coreBindings = {
        ...control.bindings,
        CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
        CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
      };
      const store = (await import("../../control-store/src/store.js")).createControlStore(
        coreBindings,
      );
      const customer = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        environment: "prod" as const,
        principalId: "user:user_native_reconcile",
      };
      const preview = (
        await store.previews.ensure({
          ...customer,
          environmentId: p.prodEnvironmentId,
          previewId: newUlid(),
          capability: {
            lookupSha256: "c".repeat(64),
            ciphertext: "A".repeat(91),
            nonce: "A".repeat(16),
            keyVersion: 1,
            tokenGeneration: 1,
          },
        })
      ).preview;
      if (!preview.targetSource) throw new Error("source missing");
      const fence = {
        previewId: preview.previewId,
        runtimeGeneration: preview.runtimeGeneration,
        tokenGeneration: preview.tokenGeneration,
      };
      const queued = await store.previews.queueNativePreparation({
        fence,
        source: preview.targetSource,
        buildPlanSha256: "d".repeat(64),
        authProvider: "omh-native",
      });
      const resources = new core.NativeAuthResourceRuntime({}, coreBindings),
        authority = new core.NativeAuthRegistryAuthorityRuntime({}, coreBindings),
        prep = new core.PreviewNativePreparationRuntime({}, coreBindings);
      const bindings = {
        RUNTIME_CONFIGURATION_STATE: "configured" as const,
        PGCF_API_URL: "https://pgcf-api.aixyte.com",
        PGCF_APPS_PROJECT_ID: pgcf.provider.projectId,
        PGCF_APPS_API_KEY: "test-only-integrator-key",
        NATIVE_AUTH_RESOURCE_RUNTIME: resources,
        NATIVE_AUTH_REGISTRY_AUTHORITY: authority,
        PREVIEW_NATIVE_PREPARATION_RUNTIME: prep,
        NATIVE_AUTH_REGISTRY_EU: {},
      };
      const roleName = nativeAuthRoleNames(p.projectId, p.prodEnvironmentId).runtime;
      pgcf.state.loseRoleResponseName = roleName;
      const historicalOperationId = "op_" + "r".repeat(20);
      const readHistoricalOperation = vi.fn(() =>
        Response.json({
          id: historicalOperationId,
          project_id: pgcf.provider.projectId,
          database_id: databaseId,
          generation: 1,
          kind: "database.role.create",
          status: "succeeded",
          error: null,
        }),
      );
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "GET" &&
          new URL(request.url).pathname === `/v1/operations/${historicalOperationId}`
        ) {
          return Promise.resolve(readHistoricalOperation());
        }
        return pgcf.providerFetch(input, init);
      });
      const service = new neon.PreviewNativePreparationService({}, bindings, pgcf.connect);
      expect(await service.prepare({ operationId: queued.operationId })).toMatchObject({
        state: "uncertain",
      });
      expect(pgcf.stats.roleCreates).toBe(1);
      if (lostRoleReply)
        // Also model losing the manager's finish acknowledgement before the source advances.
        await db
          .prepare(
            "UPDATE project_preview_native_preparations SET state='running' WHERE operation_id=?1",
          )
          .bind(queued.operationId)
          .run();
      else {
        // Model an older retained operation at the rollout boundary. Current role creates return 201.
        const recorded = await db
          .prepare(
            "UPDATE native_auth_role_operations SET provider_operation_id=?1 WHERE organization_id=?2 AND project_id=?3 AND environment_id=?4 AND operation_id=?5 AND claim_id=?6 AND database_id=?7 AND role_name=?8 AND state='dispatched' AND provider_operation_id IS NULL",
          )
          .bind(
            historicalOperationId,
            p.organizationId,
            p.projectId,
            p.prodEnvironmentId,
            queued.operationId,
            queued.claimId,
            databaseId,
            roleName,
          )
          .run();
        expect(recorded.meta.changes).toBe(1);
      }
      await db.batch(
        acceptedPreviewSourceStatements(db, {
          organizationId: p.organizationId,
          projectId: p.projectId,
          eventId: "save-after-uncertain-role",
          sourceConnectionId: preview.targetSource.sourceConnectionId,
          sourceGeneration: preview.targetSource.sourceGeneration,
          commitSha: "b".repeat(40),
          now: new Date().toISOString(),
        }),
      );
      const current = (await store.previews.get(customer))?.preview;
      if (!current?.targetSource) throw new Error("updated source missing");
      const next = await store.previews.queueNativePreparation({
        fence,
        source: current.targetSource,
        buildPlanSha256: "e".repeat(64),
        authProvider: "omh-native",
      });
      expect(
        await store.previews.claimNativePreparation({ operationId: next.operationId }),
      ).toMatchObject({ state: "running" });
      const before = pgcf.requests.length;
      expect(await service.prepare({ operationId: queued.operationId })).toMatchObject({
        state: lostRoleReply ? "uncertain" : "failed",
      });
      expect(pgcf.requests.slice(before).every((request) => request.method === "GET")).toBe(true);
      expect(pgcf.stats.roleCreates).toBe(1);
      expect(readHistoricalOperation).toHaveBeenCalledTimes(lostRoleReply ? 0 : 1);
      await expect(
        resources.resolveNativeAuthDatabaseClaim({
          organizationId: p.organizationId,
          projectId: p.projectId,
          environmentId: p.prodEnvironmentId,
          operationId: queued.operationId,
          claimId: queued.claimId,
        }),
      ).rejects.toThrow();
      const retained = await db
        .prepare(
          "SELECT state,provider_operation_id FROM native_auth_role_operations WHERE operation_id=?1",
        )
        .bind(queued.operationId)
        .first();
      expect(retained).toMatchObject({ state: lostRoleReply ? "dispatched" : "succeeded" });
    } finally {
      vi.restoreAllMocks();
      await control.dispose();
      await pgcf.control.stop();
    }
  }
}, 120_000);
