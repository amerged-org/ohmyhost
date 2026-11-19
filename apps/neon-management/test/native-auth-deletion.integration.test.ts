import { expect, it } from "vitest";
import { PgcfProviderError, type PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedProject, STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import {
  leaseOperation,
  seedOperation,
} from "../../control-store/test/support/accepted-operation.js";
import {
  lifecycleContext,
  lifecycleIdentity,
} from "../../control-store/test/provisioning/lifecycle.fixture.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  readDeletionInventoryPlan,
  recordLifecycleCleanupAttempt,
} from "../../control-store/src/catalog/provisioning/lifecycle-inventory.js";
import {
  completeProductLifecycleCommand,
  retainProductDeletionTombstone,
} from "../../control-store/src/catalog/provisioning/lifecycle-completion.js";
import { productAcceptanceStatements } from "../../control-store/src/catalog/product-api/accept-product-effects.js";
import * as nativeCore from "../../control-store/src/catalog/provisioning/native-auth-deletion.js";
import {
  createNativeAuthRegistry,
  type NativeAuthRegistryReceipt,
} from "../../native-auth-runtime/src/registry.js";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { deleteNativeAuthProject } from "../src/native-auth-deletion.js";

it("freezes, reconciles and retires one Native database with active and revoked realm registries", async () => {
  const control = await createTestControl(),
    pg = await startTestPostgres();
  try {
    const p = await seedProject(control),
      db = control.core,
      context = lifecycleContext(db),
      operationId = await seedOperation(p, { state: "queued" }),
      cleanupRunId = newUlid();
    const query = async (sql: string, ...v: unknown[]) =>
      db
        .prepare(sql)
        .bind(...v)
        .run();
    const providerProjectId = "prj_12345678901234567890",
      databaseId = "a1234567890123456789",
      providerOperationId = "op_12345678901234567890";
    await query(
      `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,?3,?4,?5,'eu-dev','r256-s500m',1,?6,?6)`,
      p.organizationId,
      p.projectId,
      providerProjectId,
      databaseId,
      providerOperationId,
      STORED_NOW,
    );
    const registries = new Map<string, ReturnType<typeof createNativeAuthRegistry>>();
    const states = new Map<string, unknown>();
    for (const [environmentId, state] of [
      [p.devEnvironmentId, "active"],
      [p.prodEnvironmentId, "revoked"],
    ] as const) {
      const schema = `omh_auth_${environmentId.toLowerCase()}`,
        role = `omh_ar_${environmentId.toLowerCase()}`,
        reference = `${p.projectId}:${environmentId}`,
        sourceOperation = newUlid(),
        claimId = newUlid();
      await query(
        `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',1,1)`,
        p.organizationId,
        p.projectId,
        environmentId,
      );
      await query(
        `INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,?5,?6,?7,'eu-dev','pgcf.example.com',?8,?9,1,1,?10,?11)`,
        p.organizationId,
        p.projectId,
        environmentId,
        sourceOperation,
        claimId,
        providerProjectId,
        databaseId,
        schema,
        role,
        reference,
        state,
      );
      await pg.pool.query(`CREATE SCHEMA "${schema}"`);
      await pg.pool.query(
        `CREATE TABLE "${schema}".native_realm_policy(singleton boolean primary key,enabled boolean not null,revocation_epoch bigint not null,configuration_revision bigint not null)`,
      );
      await pg.pool.query(`INSERT INTO "${schema}".native_realm_policy VALUES(true,true,1,1)`);
      const receipt: NativeAuthRegistryReceipt = {
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId,
        operationId: sourceOperation,
        claimId,
        providerProjectId,
        databaseId,
        regionId: "eu-dev",
        originHost: "pgcf.example.com",
        schema,
        role,
        targetVersion: 1,
        registryVersion: 1,
        registryReference: reference,
        status: "active",
      };
      const registry = createNativeAuthRegistry({
        regionId: "eu-dev",
        keyBase64: btoa("k".repeat(32)),
        storage: {
          get: async <T>() => states.get(environmentId) as T | undefined,
          put: async (_key, value) => {
            states.set(environmentId, structuredClone(value));
          },
        },
        authority: {
          authorizeRegistration: async () => true,
          readRegistration: async () => receipt,
          authorizeRevocation: async () => true,
          authorizeDeletion: (input) => nativeCore.authorizeNativeAuthDeletion(context, input),
          authorizeDeletionQuiescence: (input) =>
            nativeCore.authorizeNativeAuthDeletionQuiescence(context, input),
        },
        invalidate: async () => {},
      });
      const { status, ...metadata } = receipt;
      expect(status).toBe("active");
      await registry.register({
        ...metadata,
        connectionString: `postgres://${role}:fixture@pgcf.example.com/${databaseId}?sslmode=require`,
      });
      if (state === "revoked")
        await registry.revoke({
          receipt,
          operationId: sourceOperation,
          claimId,
          registryVersion: 2,
        });
      registries.set(environmentId, registry);
    }
    const recordedAt = "2026-10-28T12:00:00.000Z",
      plan = await readDeletionInventoryPlan(db, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId,
        recordedAt,
      });
    const input = {
      eventType: "ProjectDeletionRequestedV1",
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      operationId,
      billingEpochId: p.billingEpochId,
      expectedProjectVersion: 1,
      expectedEtag: `"${"a".repeat(64)}"`,
      cleanupRunId,
    };
    await db.batch(
      productAcceptanceStatements(db, { input, at: STORED_NOW } as never, {
        deletion: plan,
        previousOperationId: null,
        previousAbsences: [],
        confirmedSourceGeneration: null,
        plan: null,
        rollback: null,
        dataChange: null,
      }),
    );
    const eventId = newUlid(),
      workflowId = newUlid();
    await query(
      `INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,billing_epoch_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts,acknowledged_at) VALUES(?1,?2,?3,?4,?5,'ProjectDeletionRequestedV1','{}',?6,?6,?6,3,?6)`,
      p.organizationId,
      eventId,
      p.projectId,
      operationId,
      p.billingEpochId,
      STORED_NOW,
    );
    await query(
      `INSERT INTO product_workflow_runs(organization_id,operation_id,event_type,workflow_id,event_id,project_id,environment_id,billing_epoch_id,state,created_at,updated_at) VALUES(?1,?2,'ProjectDeletionRequestedV1',?3,?4,?5,?6,?7,'queued',?8,?8)`,
      p.organizationId,
      operationId,
      workflowId,
      eventId,
      p.projectId,
      p.devEnvironmentId,
      p.billingEpochId,
      STORED_NOW,
    );
    const identity = lifecycleIdentity(p, p.devEnvironmentId, { operationId, eventId, workflowId });
    await retainProductDeletionTombstone(context, {
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      operationId,
      workflowId,
      outboxEventId: eventId,
      startedOperationEventId: identity.startedOperationEventId,
      recordedAt: "2026-10-28T11:00:00.000Z",
      tombstoneReceiptId: "native-deletion-tombstone",
    });
    const scope = { organizationId: p.organizationId, projectId: p.projectId, operationId };
    const core = {
      readNativeAuthProjectDeletion: (i: unknown) =>
        nativeCore.readNativeAuthProjectDeletion(context, i),
      recordNativeAuthDeletionQuiescence: (i: unknown) =>
        nativeCore.recordNativeAuthDeletionQuiescence(context, i),
      beginNativeAuthProjectDeletion: (i: unknown) =>
        nativeCore.beginNativeAuthProjectDeletion(context, i),
      recordNativeAuthProjectDeletionObservation: (i: unknown) =>
        nativeCore.recordNativeAuthProjectDeletionObservation(context, i),
      recordNativeAuthDeletionPurge: (i: unknown) =>
        nativeCore.recordNativeAuthDeletionPurge(context, i),
      finishNativeAuthProjectDeletion: (i: unknown) =>
        nativeCore.finishNativeAuthProjectDeletion(context, i),
    };
    const deleteKeys: string[] = [];
    let deleteCalls = 0,
      operationReads = 0;
    const operation = (status: string) => ({
      id: providerOperationId,
      projectId: providerProjectId,
      databaseId,
      kind: "database.delete",
      status,
      generation: 2,
    });
    const provider = {
      projectId: providerProjectId,
      readConnection: async () => ({
        host: "pgcf.example.com",
        consume: async <T>(fn: (uri: string) => Promise<T>) => fn("fixture"),
      }),
      changeDatabase: async (_database: string, _action: string, key: string) => {
        deleteCalls++;
        deleteKeys.push(key);
        if (deleteCalls === 1) throw new Error("fixture response lost");
        return { operation: operation("pending") };
      },
      readOperation: async () => {
        operationReads++;
        return operation("succeeded");
      },
      readDatabase: async () => ({ observedState: "deleted", observedGeneration: 2 }),
    } as unknown as PgcfProjectProvider;
    const forRealm = (id: string) => {
      const result = registries.get(id);
      if (!result) throw new Error("fixture realm missing");
      return result;
    };
    const registry = {
      quiesceForDeletion: (i: { environmentId: string }) =>
        forRealm(i.environmentId).quiesceForDeletion(i as never),
      purgeForDeletion: (i: { environmentId: string }) =>
        forRealm(i.environmentId).purgeForDeletion(i as never),
    };
    const run = () =>
      deleteNativeAuthProject({
        scope,
        core: core as never,
        provider,
        registry: () => registry,
        connect: async () => {
          const client = await pg.pool.connect();
          return { client: client as never, close: async () => client.release() };
        },
      });
    await expect(run()).rejects.toThrow("fixture response lost");
    expect(await run()).toEqual({ status: "reconciliation_required" });
    expect(await run()).toEqual({
      status: "absent",
      databaseId,
      registries: [
        `${p.projectId}:${p.devEnvironmentId}`,
        `${p.projectId}:${p.prodEnvironmentId}`,
      ].sort(),
    });
    expect(deleteCalls).toBe(2);
    expect(deleteKeys[0]).toEqual(deleteKeys[1]);
    expect(operationReads).toBe(1);
    for (const environmentId of [p.devEnvironmentId, p.prodEnvironmentId]) {
      expect(states.get(environmentId)).toEqual({
        deleted: {
          ...scope,
          environmentId,
          registryVersion: 1,
          registryReference: `${p.projectId}:${environmentId}`,
        },
      });
      const policy = await pg.pool.query(
        `SELECT enabled,revocation_epoch FROM "omh_auth_${environmentId.toLowerCase()}".native_realm_policy`,
      );
      expect(policy.rows[0]).toEqual({ enabled: false, revocation_epoch: "2" });
    }
    expect(
      (
        await db
          .prepare(`SELECT ended_at FROM native_auth_database_targets WHERE project_id=?1`)
          .bind(p.projectId)
          .first()
      )?.["ended_at"],
    ).toBeTruthy();
    const retryInventory = await readDeletionInventoryPlan(db, {
      organizationId: p.organizationId,
      projectId: p.projectId,
      operationId: newUlid(),
      recordedAt: "2026-10-28T12:00:00.000Z",
    });
    expect(
      retryInventory.targets.some(
        (item) =>
          item.resource_kind === "native-auth-database" ||
          item.resource_kind === "native-auth-registry",
      ),
    ).toBe(false);
    for (const item of plan.records)
      await recordLifecycleCleanupAttempt(context, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId,
        cleanupAttemptId: newUlid(),
        provider: item.provider,
        resourceKind: item.resourceKind,
        externalRefHash: item.externalRefHash,
        outcome: "not_found",
        attemptedAt: "2026-10-28T11:30:00.000Z",
      });
    await leaseOperation(db, operationId);
    const heads = (
      await db
        .prepare(
          `SELECT environment_id,head_version FROM environments WHERE project_id=?1 ORDER BY name`,
        )
        .bind(p.projectId)
        .all<{ environment_id: string; head_version: number }>()
    ).results.map((r) => ({
      environmentId: r.environment_id,
      expectedHeadVersion: r.head_version,
    }));
    expect(
      await completeProductLifecycleCommand(context, {
        ...identity,
        eventType: "ProjectDeletionRequestedV1",
        expectedEnvironmentHeads: heads,
        deletion: {
          tombstoneReceiptId: "native-deletion-tombstone",
          inventoryClean: true,
          consecutive404s: 3,
          gatewayAbsence: [null, null],
        },
      }),
    ).toBe("completed");
    expect(
      (
        await db
          .prepare(`SELECT lifecycle_state FROM projects WHERE project_id=?1`)
          .bind(p.projectId)
          .first()
      )?.["lifecycle_state"],
    ).toBe("deleted");
  } finally {
    await pg.stop();
    await control.dispose();
  }
}, 120_000);

it.each([true, false])(
  "inherits realm quiescence after a failed deletion (absence previously recorded: %s)",
  async (previouslyAbsent) => {
    const control = await createTestControl();
    try {
      const p = await seedProject(control),
        db = control.core,
        context = lifecycleContext(db),
        execute = async (sql: string, ...v: unknown[]) =>
          db
            .prepare(sql)
            .bind(...v)
            .run();
      const databaseId = "a1234567890123456789",
        providerProjectId = "prj_12345678901234567890",
        providerOperationId = "op_12345678901234567890",
        reference = `${p.projectId}:${p.devEnvironmentId}`;
      await execute(
        `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',1,1)`,
        p.organizationId,
        p.projectId,
        p.devEnvironmentId,
      );
      await execute(
        `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,?3,?4,?5,'eu-dev','r256-s500m',1,?6,?6)`,
        p.organizationId,
        p.projectId,
        providerProjectId,
        databaseId,
        providerOperationId,
        STORED_NOW,
      );
      await execute(
        `INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,?5,?6,?7,'eu-dev','pgcf.example.com',?8,?9,1,1,?10,'active')`,
        p.organizationId,
        p.projectId,
        p.devEnvironmentId,
        newUlid(),
        newUlid(),
        providerProjectId,
        databaseId,
        `omh_auth_${p.devEnvironmentId.toLowerCase()}`,
        `omh_ar_${p.devEnvironmentId.toLowerCase()}`,
        reference,
      );
      const accept = async (version: number, previousOperationId: string | null) => {
        const operationId = await seedOperation(p, { state: "queued" }),
          plan = await readDeletionInventoryPlan(db, {
            organizationId: p.organizationId,
            projectId: p.projectId,
            operationId,
            recordedAt: "2026-10-28T12:00:00.000Z",
          }),
          input = {
            eventType: "ProjectDeletionRequestedV1",
            organizationId: p.organizationId,
            projectId: p.projectId,
            environmentId: p.devEnvironmentId,
            operationId,
            billingEpochId: p.billingEpochId,
            principalId: "user:fixture",
            expectedProjectVersion: version,
            expectedEtag: `"${"a".repeat(64)}"`,
            cleanupRunId: newUlid(),
          };
        await db.batch(
          productAcceptanceStatements(db, { input, at: STORED_NOW } as never, {
            deletion: plan,
            previousOperationId,
            previousAbsences: [],
            confirmedSourceGeneration: null,
            plan: null,
            rollback: null,
            dataChange: null,
          }),
        );
        await execute(`UPDATE cleanup_runs SET state='running' WHERE operation_id=?1`, operationId);
        return { organizationId: p.organizationId, projectId: p.projectId, operationId };
      };
      const first = await accept(1, null);
      await nativeCore.recordNativeAuthDeletionQuiescence(context, {
        ...first,
        environmentId: p.devEnvironmentId,
        registryVersion: 1,
      });
      await nativeCore.beginNativeAuthProjectDeletion(context, first);
      await nativeCore.recordNativeAuthProjectDeletionObservation(context, {
        ...first,
        providerOperationId,
        absent: previouslyAbsent,
      });
      await execute(
        `UPDATE operations SET state='failed' WHERE organization_id=?1 AND operation_id=?2`,
        p.organizationId,
        first.operationId,
      );
      const second = await accept(2, first.operationId),
        snapshot = await nativeCore.readNativeAuthProjectDeletion(context, second);
      expect(snapshot).toMatchObject({
        state: previouslyAbsent ? "absent" : "reserved",
        providerOperationId,
        realms: [{ quiesced: true, purged: false }],
      });
      const core = {
        readNativeAuthProjectDeletion: (i: unknown) =>
          nativeCore.readNativeAuthProjectDeletion(context, i),
        recordNativeAuthDeletionQuiescence: (i: unknown) =>
          nativeCore.recordNativeAuthDeletionQuiescence(context, i),
        beginNativeAuthProjectDeletion: (i: unknown) =>
          nativeCore.beginNativeAuthProjectDeletion(context, i),
        recordNativeAuthProjectDeletionObservation: (i: unknown) =>
          nativeCore.recordNativeAuthProjectDeletionObservation(context, i),
        recordNativeAuthDeletionPurge: (i: unknown) =>
          nativeCore.recordNativeAuthDeletionPurge(context, i),
        finishNativeAuthProjectDeletion: (i: unknown) =>
          nativeCore.finishNativeAuthProjectDeletion(context, i),
      };
      const provider = {
        projectId: providerProjectId,
        readOperation: async () => {
          throw new PgcfProviderError("rejected", 404);
        },
        readDatabase: async () => {
          throw new PgcfProviderError("rejected", 404);
        },
      } as unknown as PgcfProjectProvider;
      let purges = 0;
      const result = await deleteNativeAuthProject({
        scope: second,
        core: core as never,
        provider,
        connect: async () => {
          throw new Error("deleted database credentials must not be read");
        },
        registry: () => ({
          quiesceForDeletion: async () => {
            throw new Error("quiescence was already acknowledged");
          },
          purgeForDeletion: async () => {
            purges++;
            return { status: "absent" };
          },
        }),
      });
      expect(result).toEqual({ status: "absent", databaseId, registries: [reference] });
      expect(purges).toBe(1);
    } finally {
      await control.dispose();
    }
  },
  120_000,
);

it("refuses acceptance when a dispatched Native database creation has no observed identity", async () => {
  const control = await createTestControl();
  try {
    const p = await seedProject(control),
      db = control.core;
    const operationId = await seedOperation(p, { state: "queued" });
    await db
      .prepare(
        `INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state,dispatched_at) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','name','eu-dev','r256-s500m','unknown','dispatched',?6)`,
      )
      .bind(p.organizationId, p.projectId, p.devEnvironmentId, newUlid(), newUlid(), STORED_NOW)
      .run();
    const plan = await readDeletionInventoryPlan(db, {
      organizationId: p.organizationId,
      projectId: p.projectId,
      operationId,
      recordedAt: "2026-10-28T12:00:00.000Z",
    });
    const input = {
      eventType: "ProjectDeletionRequestedV1",
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      operationId,
      billingEpochId: p.billingEpochId,
      expectedProjectVersion: 1,
      expectedEtag: `"${"a".repeat(64)}"`,
      cleanupRunId: newUlid(),
    };
    await expect(
      db.batch(
        productAcceptanceStatements(db, { input, at: STORED_NOW } as never, {
          deletion: plan,
          previousOperationId: null,
          previousAbsences: [],
          confirmedSourceGeneration: null,
          plan: null,
          rollback: null,
          dataChange: null,
        }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await db
          .prepare(`SELECT lifecycle_state FROM projects WHERE project_id=?1`)
          .bind(p.projectId)
          .first()
      )?.["lifecycle_state"],
    ).toBe("active");
  } finally {
    await control.dispose();
  }
}, 120_000);

it("adopts a terminal prior delete request and observes its original operation under current ownership", async () => {
  const control = await createTestControl();
  try {
    const p = await seedProject(control),
      db = control.core,
      context = lifecycleContext(db);
    const query = async (sql: string, ...v: unknown[]) =>
      db
        .prepare(sql)
        .bind(...v)
        .run();
    const providerProjectId = "prj_12345678901234567890",
      databaseId = "a1234567890123456789",
      providerOperationId = "op_12345678901234567890";
    await query(
      `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,?3,?4,?5,'eu-dev','r256-s500m',1,?6,?6)`,
      p.organizationId,
      p.projectId,
      providerProjectId,
      databaseId,
      providerOperationId,
      STORED_NOW,
    );
    const accept = async (expectedProjectVersion: number, previousOperationId: string | null) => {
      const operationId = await seedOperation(p, { state: "queued" });
      const plan = await readDeletionInventoryPlan(db, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId,
        recordedAt: "2026-10-28T12:00:00.000Z",
      });
      const input = {
        eventType: "ProjectDeletionRequestedV1",
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.devEnvironmentId,
        operationId,
        billingEpochId: p.billingEpochId,
        principalId: "user:fixture",
        expectedProjectVersion,
        expectedEtag: `"${"a".repeat(64)}"`,
        cleanupRunId: newUlid(),
      };
      await db.batch(
        productAcceptanceStatements(db, { input, at: STORED_NOW } as never, {
          deletion: plan,
          previousOperationId,
          previousAbsences: [],
          confirmedSourceGeneration: null,
          plan: null,
          rollback: null,
          dataChange: null,
        }),
      );
      await query(`UPDATE cleanup_runs SET state='running' WHERE operation_id=?1`, operationId);
      return { organizationId: p.organizationId, projectId: p.projectId, operationId };
    };
    const first = await accept(1, null);
    const original = await nativeCore.readNativeAuthProjectDeletion(context, first);
    const core0 = {
      readNativeAuthProjectDeletion: (i: unknown) =>
        nativeCore.readNativeAuthProjectDeletion(context, i),
      recordNativeAuthDeletionQuiescence: (i: unknown) =>
        nativeCore.recordNativeAuthDeletionQuiescence(context, i),
      beginNativeAuthProjectDeletion: (i: unknown) =>
        nativeCore.beginNativeAuthProjectDeletion(context, i),
      recordNativeAuthProjectDeletionObservation: (i: unknown) =>
        nativeCore.recordNativeAuthProjectDeletionObservation(context, i),
      recordNativeAuthDeletionPurge: (i: unknown) =>
        nativeCore.recordNativeAuthDeletionPurge(context, i),
      finishNativeAuthProjectDeletion: (i: unknown) =>
        nativeCore.finishNativeAuthProjectDeletion(context, i),
    };
    const pendingProvider = {
      projectId: providerProjectId,
      changeDatabase: async () => ({
        operation: {
          id: providerOperationId,
          projectId: providerProjectId,
          databaseId,
          kind: "database.delete",
          status: "pending",
          generation: 2,
        },
      }),
    } as unknown as PgcfProjectProvider;
    expect(
      await deleteNativeAuthProject({
        scope: first,
        core: core0 as never,
        provider: pendingProvider,
        registry: () => ({
          quiesceForDeletion: async () => {
            throw new Error("no realm expected");
          },
          purgeForDeletion: async () => {
            throw new Error("no realm expected");
          },
        }),
        connect: async () => {
          throw new Error("no role credential expected");
        },
      }),
    ).toEqual({ status: "reconciliation_required" });
    await query(
      `UPDATE operations SET state='failed' WHERE organization_id=?1 AND operation_id=?2`,
      p.organizationId,
      first.operationId,
    );
    const second = await accept(2, first.operationId);
    const adopted = await nativeCore.readNativeAuthProjectDeletion(context, second);
    expect(adopted?.idempotencyKey).toBe(original?.idempotencyKey);
    expect(adopted?.providerOperationId).toBe(providerOperationId);
    const another = await seedProject(control);
    await expect(
      nativeCore.readNativeAuthProjectDeletion(context, {
        ...second,
        organizationId: another.organizationId,
      }),
    ).rejects.toThrow();
    await query(
      `UPDATE projects SET owner_state='security_frozen' WHERE organization_id=?1 AND project_id=?2`,
      p.organizationId,
      p.projectId,
    );
    await expect(nativeCore.beginNativeAuthProjectDeletion(context, second)).rejects.toThrow();
    await query(
      `UPDATE projects SET owner_state='active' WHERE organization_id=?1 AND project_id=?2`,
      p.organizationId,
      p.projectId,
    );
    let read = 0,
      mutations = 0;
    const provider = {
      projectId: providerProjectId,
      readOperation: async () => {
        read++;
        throw new PgcfProviderError("rejected", 404);
      },
      changeDatabase: async () => {
        mutations++;
        throw new Error("unexpected new deletion");
      },
      readDatabase: async () => {
        throw new PgcfProviderError("rejected", 404);
      },
    } as unknown as PgcfProjectProvider;
    const core = {
      readNativeAuthProjectDeletion: (i: unknown) =>
        nativeCore.readNativeAuthProjectDeletion(context, i),
      recordNativeAuthDeletionQuiescence: (i: unknown) =>
        nativeCore.recordNativeAuthDeletionQuiescence(context, i),
      beginNativeAuthProjectDeletion: (i: unknown) =>
        nativeCore.beginNativeAuthProjectDeletion(context, i),
      recordNativeAuthProjectDeletionObservation: (i: unknown) =>
        nativeCore.recordNativeAuthProjectDeletionObservation(context, i),
      recordNativeAuthDeletionPurge: (i: unknown) =>
        nativeCore.recordNativeAuthDeletionPurge(context, i),
      finishNativeAuthProjectDeletion: (i: unknown) =>
        nativeCore.finishNativeAuthProjectDeletion(context, i),
    };
    expect(
      await deleteNativeAuthProject({
        scope: second,
        core: core as never,
        provider,
        registry: () => ({
          quiesceForDeletion: async () => {
            throw new Error("no realm expected");
          },
          purgeForDeletion: async () => {
            throw new Error("no realm expected");
          },
        }),
        connect: async () => {
          throw new Error("no credential expected");
        },
      }),
    ).toEqual({ status: "absent", databaseId, registries: [] });
    expect(read).toBe(1);
    expect(mutations).toBe(0);
  } finally {
    await control.dispose();
  }
}, 120_000);
