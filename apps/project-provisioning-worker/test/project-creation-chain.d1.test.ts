import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class Entrypoint {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  }
  return { WorkerEntrypoint: Entrypoint, WorkflowEntrypoint: Entrypoint };
});

import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  ProjectDispatchRuntime,
  ProjectWorkflowRuntime,
} from "../../control-store/src/worker-main.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { projectInput, seedOrganization } from "../../control-store/test/support/seed.js";
import { createCoreQueueConsumer, createCoreScheduledPublisher } from "../src/core-composition.js";
import { consumeProjectProvisioningQueueBatch } from "../src/queue-consumer.js";
import { runWorkflowEntrypoint } from "../src/worker-runtime.js";
import type { ProjectDispatchRuntimeBinding } from "../src/core-persistence.js";
import { inProcessWorkflow, recordingWorkflow } from "./support/chain-workflows.js";
import { recordingStep } from "./support/deployment-chain-providers.js";

let c: TestControl;
beforeEach(async () => {
  c = await createTestControl();
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await c.dispose();
});

/**
 * The Core's dispatch capability as the publisher and consumer call it. Its delegated type widens failProductDispatch
 * with the provisioning-only reconciliation shape; product failures always return the delivery failure outcome.
 */
function projectDispatch(control: TestControl) {
  return new ProjectDispatchRuntime(
    {} as never,
    control.bindings,
  ) as unknown as ProjectDispatchRuntimeBinding;
}

const first = async <T>(sql: string, ...values: unknown[]) =>
  (await c.core
    .prepare(sql)
    .bind(...values)
    .first<T>()) as T;

it("provisions an accepted project from the publisher through the Queue and the Workflow on the real D1 Core", async () => {
  // The project's creation is accepted with its provisioning outbox event, as the control API accepts it.
  const store = createControlStore(c.bindings),
    org = await seedOrganization(store, 2, 0),
    p = projectInput(org, "chain-project-creation");
  p.outbox.eventType = "ProjectProvisioningRequested";
  p.outbox.payload = { projectId: p.projectId, operationId: p.operation.operationId };
  await store.projects.createInitialProject({
    ...p,
    includeDevelopmentEnvironment: false,
    productionDataEnvironmentId: p.productionEnvironmentId,
  });

  // The scheduled publisher sends the accepted event to the Queue; the Queue is a recording binding.
  const sent: string[] = [],
    dispatch = projectDispatch(c);
  const published = await createCoreScheduledPublisher(
    {
      RUNTIME_CONFIGURATION_STATE: "configured",
      PROJECT_DISPATCH_RUNTIME: dispatch,
      PROJECT_PROVISIONING_QUEUE: {
        send: async (body: string) => {
          sent.push(body);
        },
      },
    },
    1,
  ).publishOne();
  expect(published.provisioning).toMatchObject({ status: "published" });
  expect(sent).toHaveLength(1);

  // The Queue delivers the message to the consumer, whose Workflow runs the real provisioning entrypoint in-process.
  const core = new ProjectWorkflowRuntime({} as never, c.bindings),
    instances: string[] = [];
  const provisioning = inProcessWorkflow((event) => {
    instances.push(event.instanceId);
    return runWorkflowEntrypoint(event, recordingStep().step as never, {
      RUNTIME_CONFIGURATION_STATE: "configured",
      PROJECT_WORKFLOW_RUNTIME: core,
    });
  });
  const consumer = createCoreQueueConsumer({
    RUNTIME_CONFIGURATION_STATE: "configured",
    PROJECT_WORKFLOW_RUNTIME: core,
    PROJECT_DISPATCH_RUNTIME: dispatch,
    PROJECT_PROVISIONING_WORKFLOW: provisioning,
    DEPLOYMENT_WORKFLOW: recordingWorkflow().binding,
  } as never);
  const acked: string[] = [];
  const message = (body: string) => ({
    body,
    ack: () => acked.push(body),
    retry: () => {
      throw new Error("The provisioning message must not be retried");
    },
  });
  await consumeProjectProvisioningQueueBatch({ messages: [message(sent[0] ?? "")] }, consumer);
  expect(acked).toEqual([sent[0]]);
  expect(instances).toHaveLength(1);

  expect(
    await first<{ state: string }>(
      "SELECT state FROM operations WHERE operation_id=?1",
      p.operation.operationId,
    ),
  ).toEqual({ state: "succeeded" });
  expect(
    await first<{ status: string }>(
      "SELECT status FROM delivery_attempts WHERE event_id=?1",
      p.outbox.eventId,
    ),
  ).toEqual({ status: "acknowledged" });
  // A redelivered message is a duplicate of the completed provisioning: it starts no second operation history.
  expect(await consumer.consume(sent[0] ?? "")).toMatchObject({
    status: "completed",
    completion: "duplicate",
  });
  expect(instances).toHaveLength(2);
  // Adding Dev later queues a second operation on the same real publisher and Workflow path.
  const addOperation = newUlid();
  const addEvent = newUlid();
  const added = await store.projects.addDevelopmentEnvironment({
    organizationId: org,
    projectId: p.projectId,
    environmentId: newUlid(),
    operationId: addOperation,
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    outboxEventId: addEvent,
    principalId: "service:fixture",
    requestId: "add-dev-chain",
    idempotencyKey: "add-dev-chain",
    canonicalRequestDigest: "b".repeat(64),
    occurredAt: "2026-10-28T10:02:00.000Z",
  });
  expect(added.body.id).toBe(addOperation);
  expect(
    await createCoreScheduledPublisher(
      {
        RUNTIME_CONFIGURATION_STATE: "configured",
        PROJECT_DISPATCH_RUNTIME: dispatch,
        PROJECT_PROVISIONING_QUEUE: {
          send: async (body: string) => {
            sent.push(body);
          },
        },
      },
      1,
    ).publishOne(),
  ).toMatchObject({ provisioning: { status: "published" } });
  await consumeProjectProvisioningQueueBatch({ messages: [message(sent[1] ?? "")] }, consumer);
  expect(
    await first<{ state: string }>(
      "SELECT state FROM operations WHERE operation_id=?1",
      addOperation,
    ),
  ).toEqual({ state: "succeeded" });
  expect(await consumer.consume(sent[1] ?? "")).toMatchObject({
    status: "completed",
    completion: "duplicate",
  });
  expect(
    await first<{ n: number }>(
      "SELECT count(*) AS n FROM environments WHERE project_id=?1",
      p.projectId,
    ),
  ).toEqual({ n: 2 });
  expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}, 60_000);
