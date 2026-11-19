import { afterEach, beforeEach, expect, it } from "vitest";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { grantOneTime, reserveBuild } from "../../control-store/test/support/credit-fixtures.js";
import { losingWriteResponses } from "../../control-store/test/support/platform-fixtures.js";
import { projectInput, seedOrganization } from "../../control-store/test/support/seed.js";
import { createCoreScheduledPublisher, createCoreQueueConsumer } from "../src/core-composition.js";
import {
  runWorkflowEntrypoint,
  runScheduledPublisher,
  runQueueConsumer,
} from "../src/worker-runtime.js";
import {
  createCoreProductClaims,
  createCoreProvisioningOutbox,
  type ProjectDispatchRuntimeBinding,
} from "../src/core-persistence.js";
import { createUlidFactory, SystemEntropy } from "@ohmyhost/platform";
import { readCorePublisherBindings, readCoreConsumerBindings } from "../src/core-bindings.js";
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Required native fixture value is absent");
  return value;
}
let c: TestControl;
beforeEach(async () => {
  c = await createTestControl();
});
afterEach(async () => c.dispose());
function binding(store: ReturnType<typeof createControlStore>): ProjectDispatchRuntimeBinding {
  const d = store.projectDispatch;
  return {
    claimProvisioningDispatch: (i) => d.provisioning.claim(i),
    recoverProvisioningDispatch: (i) => d.provisioning.recover(i),
    acknowledgeProvisioningDispatch: (i) => d.provisioning.acknowledge(i),
    failProvisioningDispatch: (i) => d.provisioning.fail(i),
    claimProductDispatch: (i) => d.product.claim(i),
    recoverProductDispatch: (i) => d.product.recover(i),
    acknowledgeProductDispatch: (i) => d.product.acknowledge(i),
    failProductDispatch: async (i) => {
      const r = await d.product.fail(i);
      if (r === null) return null;
      if (
        !("outcome" in r) ||
        (r.outcome !== "retry_scheduled" && r.outcome !== "reconciliation_required")
      )
        throw new Error("wrong failure");
      return { outcome: r.outcome, attemptNumber: r.attemptNumber };
    },
    claimManagedSourceDispatch: (i) => d.managedSource.claim(i),
    recoverManagedSourceDispatch: (i) => d.managedSource.recover(i),
    sweepExhaustedManagedSourceDispatch: (i) => d.managedSource.sweep(i),
    acknowledgeManagedSourceDispatch: (i) => d.managedSource.acknowledge(i),
    failManagedSourceDispatch: async (i) => {
      const r = await d.managedSource.fail(i);
      if (r === null) return null;
      if (
        !("outcome" in r) ||
        (r.outcome !== "retry_scheduled" && r.outcome !== "reconciliation_required")
      )
        throw new Error("wrong failure");
      return { outcome: r.outcome, attemptNumber: r.attemptNumber };
    },
    readProductDispatchIntent: (i) => d.readProductDispatchIntent(i),
    acceptProductDispatch: (i) => d.acceptProductDispatch(i),
    readManagedSourceDispatchState: (i) => d.readManagedSourceDispatchState(i),
    recoverProductExecutionLease: (i) => d.recoverProductExecutionLease(i),
  };
}
async function fixture(handle: string) {
  const store = createControlStore(c.bindings),
    org = await seedOrganization(store, 2, 0),
    p = projectInput(org, handle);
  p.outbox.eventType = "ProjectProvisioningRequested";
  p.outbox.payload = { projectId: p.projectId, operationId: p.operation.operationId };
  await store.projects.createInitialProject(p);
  return { store, p };
}
it("runs actual publisher, Queue consumer and pinned provisioning completion on the same Core", async () => {
  const { store, p } = await fixture("core-actual-publisher"),
    messages: string[] = [],
    runtime = binding(store),
    workflow = {
      completeProjectProvisioningHello: (i) => store.provisioning.completeHello(i),
      failProjectProvisioningHello: (i) => store.provisioning.failHello(i),
      reconcileProjectProvisioningHello: (i) => store.provisioning.reconcileHello(i),
    } satisfies import("../src/core-persistence.js").ProjectWorkflowRuntimeBinding;
  const result = await createCoreScheduledPublisher(
    {
      RUNTIME_CONFIGURATION_STATE: "configured",
      PROJECT_DISPATCH_RUNTIME: runtime,
      PROJECT_PROVISIONING_QUEUE: {
        send: async (message) => {
          messages.push(message);
        },
      },
    },
    1,
  ).publishOne();
  expect(result.provisioning.status).toBe("published");
  expect(messages).toHaveLength(1);
  const msg = JSON.parse(required(messages[0]));
  expect(msg.operationId).toBe(p.operation.operationId);
  const workflowId = `project-provisioning-v1-${msg.eventId}-${msg.operationId}`;
  const env = {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    PROJECT_WORKFLOW_RUNTIME: workflow,
  };
  const event = { instanceId: workflowId, payload: msg };
  expect(
    await runWorkflowEntrypoint(
      event,
      { do: async (_n: string, _c: unknown, run: () => Promise<unknown>) => run() } as never,
      env,
    ),
  ).toEqual({ status: "completed", persistence: "applied" });
  // A lost create reply resolves the exact instance; Queue redelivery applies no new operation history.
  const deterministic = {
    create: async () => {
      throw new Error("create reply lost");
    },
    get: async (id: string) => {
      expect(id).toBe(workflowId);
      return { status: async () => ({ status: "complete" }) };
    },
  };
  const consumer = createCoreQueueConsumer({
    ...env,
    PROJECT_DISPATCH_RUNTIME: runtime,
    PROJECT_PROVISIONING_WORKFLOW: deterministic,
    DEPLOYMENT_WORKFLOW: deterministic,
  } as never);
  expect(await consumer.consume(required(messages[0]))).toMatchObject({
    status: "completed",
    completion: "duplicate",
  });
  const op = await store.operations.loadOperation({
    organizationId: p.organizationId,
    operationId: p.operation.operationId,
  });
  expect(op?.events).toHaveLength(3);
  expect(
    (
      await c.core
        .prepare("SELECT status FROM delivery_attempts WHERE event_id=?")
        .bind(p.outbox.eventId)
        .first()
    )?.["status"],
  ).toBe("acknowledged");
  const lossy = binding(createControlStore({ CONTROL_CORE: losingWriteResponses(c.core, 1) }));
  expect(
    await lossy.acknowledgeProvisioningDispatch({
      eventId: p.outbox.eventId,
      attemptId: required(
        await c.core
          .prepare("SELECT current_attempt_id FROM outbox_events WHERE event_id=?")
          .bind(p.outbox.eventId)
          .first<{ current_attempt_id: string }>(),
      ).current_attempt_id,
      now: new Date().toISOString(),
    }),
  ).toBe(false);
  const publisherEnv = {
    ...env,
    PROJECT_DISPATCH_RUNTIME: runtime,
    PROJECT_PROVISIONING_QUEUE: { send: async () => {} },
  };
  expect(readCorePublisherBindings(publisherEnv).PROJECT_DISPATCH_RUNTIME).toBe(runtime);
  const consumerEnv = {
    ...env,
    PROJECT_DISPATCH_RUNTIME: runtime,
    PROJECT_PROVISIONING_WORKFLOW: deterministic,
    DEPLOYMENT_WORKFLOW: deterministic,
  };
  expect(readCoreConsumerBindings(consumerEnv).PROJECT_WORKFLOW_RUNTIME).toBe(workflow);
  await expect(
    runScheduledPublisher({ ...publisherEnv, RUNTIME_CONFIGURATION_STATE: "disabled" }),
  ).rejects.toThrow("configuration state is disabled");
  let acked = 0;
  await runQueueConsumer(
    {
      messages: [
        {
          body: messages[0],
          ack() {
            acked++;
          },
          retry() {
            throw new Error("unexpected retry");
          },
        },
      ],
    } as never,
    consumerEnv,
  );
  expect(acked).toBe(1);
  for (const status of ["errored", "unknown"]) {
    const x = await fixture(`core-workflow-${status}`);
    const message = {
      version: 1,
      eventType: "ProjectProvisioningRequested",
      eventId: x.p.outbox.eventId,
      organizationId: x.p.organizationId,
      projectId: x.p.projectId,
      operationId: x.p.operation.operationId,
    };
    const service = {
      create: async () => ({ status: async () => ({ status }) }),
      get: async () => ({ status: async () => ({ status }) }),
    };
    expect(
      await createCoreQueueConsumer({
        ...consumerEnv,
        PROJECT_PROVISIONING_WORKFLOW: service,
      }).consume(JSON.stringify(message)),
    ).toMatchObject({ status: status === "errored" ? "failed" : "reconciliation_required" });
  }
  for (let i = 0; i < 10; i++) {
    const claimed = await runtime.claimProvisioningDispatch({
      attemptId: newUlid(),
      now: new Date().toISOString(),
    });
    if (!claimed) break;
    await runtime.acknowledgeProvisioningDispatch({
      eventId: claimed.eventId,
      attemptId: claimed.attemptId,
      now: new Date().toISOString(),
    });
  }
  const managed = await fixture("core-managed-init"),
    source = newUlid(),
    initializationEvent = newUlid(),
    stamp = "2026-10-28T10:00:00.000000Z";
  await c.core
    .prepare(
      `INSERT INTO managed_source_initializations(organization_id,parent_operation_id,project_id,billing_epoch_id,source_connection_id,initialization_event_id,principal_id,template,region,request_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'user:user_seed','empty','eu','managed-fixture','waiting',?,?)`,
    )
    .bind(
      managed.p.organizationId,
      managed.p.operation.operationId,
      managed.p.projectId,
      managed.p.billingEpochId,
      source,
      initializationEvent,
      stamp,
      stamp,
    )
    .run();
  const managedMessage = {
    version: 1,
    eventType: "ProjectProvisioningRequested",
    eventId: managed.p.outbox.eventId,
    organizationId: managed.p.organizationId,
    projectId: managed.p.projectId,
    operationId: managed.p.operation.operationId,
  };
  await runWorkflowEntrypoint(
    {
      payload: managedMessage,
      instanceId: `project-provisioning-v1-${managed.p.outbox.eventId}-${managed.p.operation.operationId}`,
    },
    { do: async (_n: string, _c: unknown, run: () => Promise<unknown>) => run() } as never,
    env,
  );
  // Real initialization handoff from the parent creates an exact queued child event in the same batch.
  const emitted: string[] = [];
  const pubenv = {
    ...publisherEnv,
    PROJECT_PROVISIONING_QUEUE: {
      send: async (body: string) => {
        emitted.push(body);
      },
    },
  };
  await runScheduledPublisher(pubenv, 1);
  const init = emitted
    .map((v) => JSON.parse(v))
    .find((v) => v.eventType === "ManagedSourceInitializationRequestedV1");
  expect(init?.eventId).toBe(initializationEvent);
  const managedConsumer = createCoreQueueConsumer({
    ...consumerEnv,
    MANAGED_SOURCE_PROCESSOR: {
      initialize: async () => ({ state: "pending" as const }),
      process: async () => ({ state: "staging" as const }),
    },
  });
  expect(await managedConsumer.consume(JSON.stringify(init))).toMatchObject({ status: "pending" });
  await c.core
    .prepare(
      "UPDATE managed_source_initializations SET state='failed',error_code='FIXTURE_FAILED' WHERE parent_operation_id=?",
    )
    .bind(managed.p.operation.operationId)
    .run();
  expect(await managedConsumer.consume(JSON.stringify(init))).toMatchObject({
    status: "completed",
    durable: "managed_source_terminal",
  });
  const publication = newUlid(),
    publicationEvent = newUlid();
  await managed.store.operations.queueOperation({
    organizationId: managed.p.organizationId,
    billingEpochId: managed.p.billingEpochId,
    operation: {
      operationId: publication,
      projectId: managed.p.projectId,
      eventId: newUlid(),
      occurredAt: "2026-10-28T10:02:00.000Z",
    },
    audit: {
      auditEventId: newUlid(),
      projectId: managed.p.projectId,
      operationId: publication,
      eventType: "OperationQueued",
      actorType: "service",
      actorId: "fixture",
      payload: {},
      occurredAt: "2026-10-28T10:02:00.000Z",
    },
    outbox: {
      eventId: publicationEvent,
      eventType: "ManagedSourcePublicationRequestedV1",
      payload: { environmentId: managed.p.developmentEnvironmentId },
      createdAt: "2026-10-28T10:02:00.000Z",
      maxAttempts: 5,
    },
  });
  await c.core.batch([
    c.core
      .prepare(
        `INSERT INTO managed_source_repositories(source_connection_id,organization_id,project_id,billing_epoch_id,namespace,repository_name,created_at) VALUES(?,?,?,?,'fixture-ns',?,?)`,
      )
      .bind(
        source,
        managed.p.organizationId,
        managed.p.projectId,
        managed.p.billingEpochId,
        managed.p.projectId,
        stamp,
      ),
    c.core
      .prepare(
        `INSERT INTO managed_source_publications(operation_id,organization_id,project_id,billing_epoch_id,principal_id,source_connection_id,mode,expected_source_generation,state,message,created_at,expires_at,updated_at) VALUES(?,?,?,?,'user:user_seed',?,'initialize',0,'sealed','fixture',?,'2027-01-01T00:00:00.000000Z',?)`,
      )
      .bind(
        publication,
        managed.p.organizationId,
        managed.p.projectId,
        managed.p.billingEpochId,
        source,
        stamp,
        stamp,
      ),
  ]);
  const uncertain = await createCoreScheduledPublisher(
    {
      ...pubenv,
      PROJECT_PROVISIONING_QUEUE: {
        send: async () => {
          throw new Error("Queue reply lost");
        },
      },
    },
    1,
  ).publishOne();
  expect(uncertain.managedSource.status).toBe("retry_scheduled");
  await c.core
    .prepare("UPDATE outbox_events SET available_at=? WHERE event_id=?")
    .bind(stamp, publicationEvent)
    .run();
  emitted.length = 0;
  expect((await createCoreScheduledPublisher(pubenv, 1).publishOne()).managedSource.status).toBe(
    "published",
  );
  const publicationMessage = emitted
    .map((v) => JSON.parse(v))
    .find((v) => v.eventType === "ManagedSourcePublicationRequestedV1");
  expect(publicationMessage?.operationId).toBe(publication);
  expect(await managedConsumer.consume(JSON.stringify(publicationMessage))).toMatchObject({
    status: "pending",
  });
  await expect(
    runtime.readManagedSourceDispatchState({
      ...publicationMessage,
      environmentId: managed.p.productionEnvironmentId,
    }),
  ).rejects.toThrow("provenance");
});
it("retains original attempt history through Queue uncertainty, accepts one immutable product run and rejects changed outbox intent identity", async () => {
  const { store, p } = await fixture("core-product-publish"),
    runtime = binding(store);
  // Provisioning failure is an audited retry; the next attempt keeps the first failure evidence.
  const first = await runtime.claimProvisioningDispatch({
    attemptId: newUlid(),
    now: new Date().toISOString(),
  });
  expect(first?.eventId).toBe(p.outbox.eventId);
  const failed = await runtime.failProvisioningDispatch({
    eventId: p.outbox.eventId,
    attemptId: required(first).attemptId,
    auditEventId: newUlid(),
    failedAt: new Date().toISOString(),
    errorCode: "PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN",
    cause: "uncertain",
  });
  expect(failed).toMatchObject({ outcome: "retry_scheduled", attemptNumber: 1 });
  const retry = await runtime.claimProvisioningDispatch({
    attemptId: newUlid(),
    now: new Date(Date.now() + 6000).toISOString(),
  });
  expect(retry?.attemptNumber).toBe(2);
  expect(
    await c.core
      .prepare("SELECT count(*) n FROM delivery_attempts WHERE event_id=?")
      .bind(p.outbox.eventId)
      .first(),
  ).toEqual({ n: 2 });
  const op = newUlid(),
    event = newUlid(),
    environment = p.developmentEnvironmentId,
    at = "2026-10-28T10:02:00.000Z";
  await store.operations.queueOperation({
    organizationId: p.organizationId,
    billingEpochId: p.billingEpochId,
    operation: { operationId: op, projectId: p.projectId, eventId: newUlid(), occurredAt: at },
    audit: {
      auditEventId: newUlid(),
      projectId: p.projectId,
      operationId: op,
      eventType: "OperationQueued",
      actorType: "service",
      actorId: "fixture",
      payload: {},
      occurredAt: at,
    },
    outbox: {
      eventId: event,
      eventType: "SourceLinkRequestedV1",
      payload: { environmentId: environment },
      createdAt: at,
      maxAttempts: 5,
    },
  });
  await c.core
    .prepare(
      `INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,installation_id,repository_owner,repository_name,created_at) VALUES(?,?,?,?,?,'SourceLinkRequestedV1','7','owner','repo',?)`,
    )
    .bind(
      p.organizationId,
      p.projectId,
      environment,
      op,
      p.billingEpochId,
      at.replace(/Z$/u, "000Z"),
    )
    .run();
  const claim = await runtime.claimProductDispatch({
    attemptId: newUlid(),
    now: new Date().toISOString(),
  });
  expect(claim?.operationId).toBe(op);
  const input = {
    organizationId: p.organizationId,
    projectId: p.projectId,
    environmentId: environment,
    operationId: op,
    eventId: event,
    attemptId: required(claim).attemptId,
    workflowId: `product-command-v1-source-link-${event}-${op}`,
    acceptedAt: required(claim).claimedAt,
  };
  const lossy = binding(createControlStore({ CONTROL_CORE: losingWriteResponses(c.core, 1) }));
  expect(await lossy.acceptProductDispatch(input)).toMatchObject({
    eventType: "SourceLinkRequestedV1",
  });
  expect(await runtime.acceptProductDispatch(input)).toMatchObject({
    eventType: "SourceLinkRequestedV1",
  });
  await expect(
    runtime.acceptProductDispatch({ ...input, workflowId: input.workflowId + "x" }),
  ).rejects.toThrow("identity changed");
  await expect(
    runtime.acceptProductDispatch({ ...input, environmentId: p.productionEnvironmentId }),
  ).rejects.toThrow("immutable intent");
  const clock = { now: () => new Date(Date.now() + 8_000) },
    ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  const claims = createCoreProductClaims(runtime, clock, ids);
  expect(await claims.recordDeliveryFailure({ ...required(claim) })).toBe("retry_scheduled");
  const nextClock = { now: () => new Date(Date.now() + 14_000) },
    nextClaims = createCoreProductClaims(
      runtime,
      nextClock,
      createUlidFactory({ clock: nextClock, entropy: new SystemEntropy() }),
    );
  const next = await nextClaims.claim();
  expect(next?.message.operationId).toBe(op);
  expect(
    await nextClaims.acknowledgeExact({ eventId: event, attemptId: required(next).attemptId }),
  ).toBe(true);
  expect(await claims.recoverExpiredFinalClaim()).toBe(false);
  const outbox = createCoreProvisioningOutbox(runtime, clock, ids);
  expect(
    await outbox.recordDeliveryUncertain({
      ...required(retry),
      eventId: required(retry).eventId as never,
      organizationId: p.organizationId as never,
      projectId: p.projectId as never,
      operationId: p.operation.operationId as never,
      attemptId: required(retry).attemptId as never,
      cause: "timeout",
    }),
  ).toMatchObject({ outcome: "retry_scheduled" });
  expect(
    await outbox.recordQueueConfigurationFailureExact({
      ...required(retry),
      eventId: required(retry).eventId as never,
      organizationId: p.organizationId as never,
      projectId: p.projectId as never,
      operationId: p.operation.operationId as never,
      attemptId: required(retry).attemptId as never,
      errorCode: "PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR",
    }),
  ).toBe(null);
  const invalid = await fixture("core-invalid-dispatch");
  await c.core
    .prepare("UPDATE outbox_events SET payload='{}' WHERE event_id=?")
    .bind(invalid.p.outbox.eventId)
    .run();
  const invalidResult = await createCoreScheduledPublisher(
    {
      RUNTIME_CONFIGURATION_STATE: "configured",
      PROJECT_DISPATCH_RUNTIME: runtime,
      PROJECT_PROVISIONING_QUEUE: {
        send: async () => {
          throw new Error("must not send invalid");
        },
      },
    },
    1,
  ).publishOne();
  expect(invalidResult.provisioning.status).toBe("invalid_message");
  // Recovering an abandoned operation releases only a never-started build hold, atomically with its terminal history.
  await grantOneTime(c.core, p.organizationId, 1_000_000);
  await reserveBuild(c.core, {
    organizationId: p.organizationId,
    projectId: p.projectId,
    operationId: op,
    amountMicros: 300_000,
  });
  await c.core
    .prepare(
      "UPDATE operations SET lease_expires_at='2026-10-28T10:03:00.000000Z' WHERE operation_id=?",
    )
    .bind(op)
    .run();
  await c.core
    .prepare(
      "CREATE TRIGGER release_must_be_atomic BEFORE DELETE ON credit_reservation BEGIN SELECT RAISE(ABORT,'late hold release'); END",
    )
    .run();
  await expect(
    runtime.recoverProductExecutionLease({ now: new Date().toISOString() }),
  ).rejects.toThrow("late hold release");
  expect(
    (await store.operations.loadOperation({ organizationId: p.organizationId, operationId: op }))
      ?.state,
  ).toBe("queued");
  await c.core.prepare("DROP TRIGGER release_must_be_atomic").run();
  expect(await lossy.recoverProductExecutionLease({ now: new Date().toISOString() })).toMatchObject(
    { operationId: op },
  );
  expect(
    await c.core
      .prepare(
        "SELECT (SELECT count(*) FROM credit_reservation WHERE reservation_id=?1) AS open, (SELECT kind FROM credit_log WHERE key='release:' || ?1) AS released",
      )
      .bind(op)
      .first(),
  ).toEqual({ open: 0, released: "release" });
  const ordinaryOp = newUlid(),
    ordinaryEvent = newUlid();
  await store.operations.queueOperation({
    organizationId: p.organizationId,
    billingEpochId: p.billingEpochId,
    operation: {
      operationId: ordinaryOp,
      projectId: p.projectId,
      eventId: newUlid(),
      occurredAt: at,
    },
    audit: {
      auditEventId: newUlid(),
      projectId: p.projectId,
      operationId: ordinaryOp,
      eventType: "OperationQueued",
      actorType: "service",
      actorId: "fixture",
      payload: {},
      occurredAt: at,
    },
    outbox: {
      eventId: ordinaryEvent,
      eventType: "SourceLinkRequestedV1",
      payload: { environmentId: environment },
      createdAt: at,
      maxAttempts: 5,
    },
  });
  await c.core
    .prepare(
      `INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,installation_id,repository_owner,repository_name,created_at) VALUES(?,?,?,?,?,'SourceLinkRequestedV1','7','owner','repo',?)`,
    )
    .bind(
      p.organizationId,
      p.projectId,
      environment,
      ordinaryOp,
      p.billingEpochId,
      at.replace(/Z$/u, "000Z"),
    )
    .run();
  const ordinaryClaim = await runtime.claimProductDispatch({
    attemptId: newUlid(),
    now: new Date().toISOString(),
  });
  expect(
    await runtime.acceptProductDispatch({
      ...input,
      operationId: ordinaryOp,
      eventId: ordinaryEvent,
      attemptId: required(ordinaryClaim).attemptId,
      workflowId: `product-command-v1-source-link-${ordinaryEvent}-${ordinaryOp}`,
      acceptedAt: required(ordinaryClaim).claimedAt,
    }),
  ).toMatchObject({ operationId: ordinaryOp });
  const uncertainProject = await fixture("core-send-uncertain");
  const uncertainPublish = await createCoreScheduledPublisher(
    {
      RUNTIME_CONFIGURATION_STATE: "configured",
      PROJECT_DISPATCH_RUNTIME: runtime,
      PROJECT_PROVISIONING_QUEUE: {
        send: async () => {
          throw new Error("lost reply");
        },
      },
    },
    1,
  ).publishOne();
  expect(uncertainPublish.provisioning.status).toBe("retry_scheduled");
  expect(
    await c.core
      .prepare("SELECT status FROM delivery_attempts WHERE event_id=?")
      .bind(uncertainProject.p.outbox.eventId)
      .first(),
  ).toEqual({ status: "retry_scheduled" });
  expect(await c.core.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
});

it("keeps publishing provisioning, product and managed-source work when one expired-operation recovery fails", async () => {
  const { store, p } = await fixture("core-recovery-isolated"),
    messages: string[] = [],
    runtime = binding(store);
  const result = await createCoreScheduledPublisher(
    {
      RUNTIME_CONFIGURATION_STATE: "configured",
      PROJECT_DISPATCH_RUNTIME: {
        ...runtime,
        recoverProductExecutionLease: async () => {
          throw new Error("native auth create outcome unresolved");
        },
      },
      PROJECT_PROVISIONING_QUEUE: {
        send: async (message) => {
          messages.push(message);
        },
      },
    },
    1,
  ).publishOne();
  expect(result.provisioning.status).toBe("published");
  expect(messages).toHaveLength(1);
  expect(JSON.parse(required(messages[0])).operationId).toBe(p.operation.operationId);
});

it("the minute publisher claims a never-woken product event once across a racing wake and lost acknowledgement", async () => {
  const { store, p } = await fixture("core-never-woken"),
    runtime = binding(store);
  const first = required(
    await runtime.claimProvisioningDispatch({
      attemptId: newUlid(),
      now: new Date().toISOString(),
    }),
  );
  await runtime.acknowledgeProvisioningDispatch({
    eventId: first.eventId,
    attemptId: first.attemptId,
    now: new Date().toISOString(),
  });
  const operationId = newUlid(),
    eventId = newUlid(),
    at = "2026-10-28T11:00:00.000Z";
  await store.operations.queueOperation({
    organizationId: p.organizationId,
    billingEpochId: p.billingEpochId,
    operation: { operationId, projectId: p.projectId, eventId: newUlid(), occurredAt: at },
    audit: {
      auditEventId: newUlid(),
      projectId: p.projectId,
      operationId,
      eventType: "OperationQueued",
      actorType: "service",
      actorId: "fixture",
      payload: {},
      occurredAt: at,
    },
    outbox: {
      eventId,
      eventType: "SourceLinkRequestedV1",
      payload: { environmentId: p.developmentEnvironmentId },
      createdAt: at,
      maxAttempts: 5,
    },
  });
  await c.core
    .prepare(
      `INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,installation_id,repository_owner,repository_name,created_at) VALUES(?,?,?,?,?,'SourceLinkRequestedV1','7','owner','repo',?)`,
    )
    .bind(
      p.organizationId,
      p.projectId,
      p.developmentEnvironmentId,
      operationId,
      p.billingEpochId,
      at.replace(/Z$/u, "000Z"),
    )
    .run();
  expect(
    await c.core
      .prepare("SELECT attempt_count,current_attempt_id FROM outbox_events WHERE event_id=?")
      .bind(eventId)
      .first(),
  ).toEqual({ attempt_count: 0, current_attempt_id: null });
  const sent: string[] = [];
  let loseAck = true;
  const lossy = {
    ...runtime,
    async acknowledgeProductDispatch(
      input: Parameters<typeof runtime.acknowledgeProductDispatch>[0],
    ) {
      const acknowledged = await runtime.acknowledgeProductDispatch(input);
      if (loseAck) {
        loseAck = false;
        throw new Error("ack response lost");
      }
      return acknowledged;
    },
  };
  const publisher = () =>
    createCoreScheduledPublisher(
      {
        RUNTIME_CONFIGURATION_STATE: "configured",
        PROJECT_DISPATCH_RUNTIME: lossy,
        PROJECT_PROVISIONING_QUEUE: {
          send: async (message) => {
            sent.push(message);
          },
        },
      },
      1,
    ).publishOne();
  const outcomes = await Promise.allSettled([publisher(), publisher()]);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  expect(sent).toHaveLength(1);
  expect(JSON.parse(required(sent[0]))).toMatchObject({
    eventId,
    operationId,
    organizationId: p.organizationId,
    projectId: p.projectId,
    billingEpochId: p.billingEpochId,
    environmentId: p.developmentEnvironmentId,
  });
  const row = required(
    await c.core
      .prepare(
        "SELECT organization_id,billing_epoch_id,attempt_count,current_attempt_id,claimed_at,lease_expires_at,acknowledged_at FROM outbox_events WHERE event_id=?",
      )
      .bind(eventId)
      .first<{
        organization_id: string;
        billing_epoch_id: string;
        attempt_count: number;
        current_attempt_id: string;
        claimed_at: string;
        lease_expires_at: string;
        acknowledged_at: string;
      }>(),
  );
  expect(row).toMatchObject({
    organization_id: p.organizationId,
    billing_epoch_id: p.billingEpochId,
    attempt_count: 1,
  });
  expect(Date.parse(row.lease_expires_at) - Date.parse(row.claimed_at)).toBe(30_000);
  expect(row.acknowledged_at).toBeTruthy();
  expect(
    await c.core
      .prepare(
        "SELECT status,attempt_number FROM delivery_attempts WHERE event_id=? AND attempt_id=?",
      )
      .bind(eventId, row.current_attempt_id)
      .first(),
  ).toEqual({ status: "acknowledged", attempt_number: 1 });
  expect((await publisher()).product.status).toBe("idle");
  expect(sent).toHaveLength(1);
  const foreignOrganization = await seedOrganization(store, 2, 0);
  await expect(
    runtime.acceptProductDispatch({
      organizationId: foreignOrganization,
      projectId: p.projectId,
      environmentId: p.developmentEnvironmentId,
      operationId,
      eventId,
      attemptId: row.current_attempt_id,
      workflowId: "foreign-workflow",
      acceptedAt: new Date().toISOString(),
    }),
  ).rejects.toThrow("immutable intent");
  const workflowIds = new Set<string>();
  const workflow = {
    async create({ id }: { id: string }) {
      if (workflowIds.has(id)) throw new Error("already exists");
      workflowIds.add(id);
      return { status: async () => ({ status: "running" }) };
    },
    async get(id: string) {
      if (!workflowIds.has(id)) throw new Error("missing");
      return { status: async () => ({ status: "running" }) };
    },
  };
  const consumer = createCoreQueueConsumer({
    PROJECT_DISPATCH_RUNTIME: runtime,
    PROJECT_WORKFLOW_RUNTIME: {} as never,
    PROJECT_PROVISIONING_WORKFLOW: workflow,
    DEPLOYMENT_WORKFLOW: workflow,
  } as never);
  expect((await consumer.consume(required(sent[0]))).status).toBe("pending");
  expect((await consumer.consume(required(sent[0]))).status).toBe("pending");
  expect(workflowIds.size).toBe(1);
});

it("ends a managed publication whose dispatch exhausted on the publisher tick, before the tick claims more work", async () => {
  const managed = await fixture("core-managed-exhausted"),
    source = newUlid(),
    stamp = "2026-10-28T10:00:00.000000Z";
  const publication = newUlid(),
    publicationEvent = newUlid();
  await managed.store.operations.queueOperation({
    organizationId: managed.p.organizationId,
    billingEpochId: managed.p.billingEpochId,
    operation: {
      operationId: publication,
      projectId: managed.p.projectId,
      eventId: newUlid(),
      occurredAt: "2026-10-28T10:02:00.000Z",
    },
    audit: {
      auditEventId: newUlid(),
      projectId: managed.p.projectId,
      operationId: publication,
      eventType: "OperationQueued",
      actorType: "service",
      actorId: "fixture",
      payload: {},
      occurredAt: "2026-10-28T10:02:00.000Z",
    },
    outbox: {
      eventId: publicationEvent,
      eventType: "ManagedSourcePublicationRequestedV1",
      payload: { environmentId: managed.p.developmentEnvironmentId },
      createdAt: "2026-10-28T10:02:00.000Z",
      maxAttempts: 5,
    },
  });
  await c.core.batch([
    c.core
      .prepare(
        `INSERT INTO managed_source_repositories(source_connection_id,organization_id,project_id,billing_epoch_id,namespace,repository_name,created_at) VALUES(?,?,?,?,'fixture-ns',?,?)`,
      )
      .bind(
        source,
        managed.p.organizationId,
        managed.p.projectId,
        managed.p.billingEpochId,
        managed.p.projectId,
        stamp,
      ),
    c.core
      .prepare(
        `INSERT INTO managed_source_publications(operation_id,organization_id,project_id,billing_epoch_id,principal_id,source_connection_id,mode,expected_source_generation,state,message,created_at,expires_at,updated_at) VALUES(?,?,?,?,'user:user_seed',?,'initialize',0,'sealed','fixture',?,'2027-01-01T00:00:00.000000Z',?)`,
      )
      .bind(
        publication,
        managed.p.organizationId,
        managed.p.projectId,
        managed.p.billingEpochId,
        source,
        stamp,
        stamp,
      ),
  ]);
  // The publication's delivery used every attempt and was never acknowledged: no send can still succeed.
  await c.core
    .prepare(
      "UPDATE outbox_events SET attempt_count=5,max_attempts=5,last_error_code='MANAGED_SOURCE_QUEUE_SEND_UNCERTAIN',reconciliation_required_at=?2 WHERE event_id=?1",
    )
    .bind(publicationEvent, stamp)
    .run();
  const tick = createCoreScheduledPublisher(
    {
      RUNTIME_CONFIGURATION_STATE: "configured",
      PROJECT_DISPATCH_RUNTIME: binding(managed.store),
      PROJECT_PROVISIONING_QUEUE: { send: async () => undefined },
    },
    1,
  );

  expect((await tick.publishOne()).managedSource).toEqual({ status: "reconciliation_required" });
  expect(
    await c.core
      .prepare("SELECT state,error_code FROM managed_source_publications WHERE operation_id=?")
      .bind(publication)
      .first(),
  ).toEqual({ state: "failed", error_code: "MANAGED_SOURCE_DISPATCH_FAILED" });
  expect(
    await c.core
      .prepare("SELECT state FROM operations WHERE operation_id=?")
      .bind(publication)
      .first(),
  ).toEqual({ state: "failed" });
  expect((await tick.publishOne()).managedSource.status).toBe("idle");
});
