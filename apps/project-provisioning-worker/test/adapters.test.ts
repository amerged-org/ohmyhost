import {
  createProjectProvisioningConsumer,
  createProjectProvisioningPublisher,
  parseProductCommandMessageV1,
  serializeProjectProvisioningMessageV1,
} from "@ohmyhost/orchestrator";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCloudflareProjectProvisioningQueue,
  createCloudflareProjectProvisioningWorkflow,
  ensureCloudflareProductCommandWorkflow,
  ensureCloudflareProjectProvisioningWorkflow,
} from "../src/cloudflare-adapters.js";
import { attemptId, message } from "./fixtures.js";

const deploymentMessage = parseProductCommandMessageV1({
  version: 1,
  eventType: "DeploymentRequestedV1",
  eventId: "01M1DKRQ5E4NV39XW38KYETBN4",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  projectId: "01M18XV7CYYNEDQJJ9WVY3GPDR",
  billingEpochId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  environmentId: "01M18XV7CYYNEDQJJ9WVY3GPDX",
  operationId: "01M1DKRQ52Y9KC59W3YC0Q8SGJ",
  planId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
});
const deploymentWorkflowId =
  "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ";

afterEach(() => vi.useRealTimers());

describe("Cloudflare project provisioning adapters", () => {
  it("maps only an awaited Queue send success to sent and propagates errors", async () => {
    const sent = vi.fn(async () => undefined);
    const queue = createCloudflareProjectProvisioningQueue({ send: sent });
    await expect(queue.send("payload", { signal: new AbortController().signal })).resolves.toBe(
      "sent",
    );
    expect(sent).toHaveBeenCalledWith("payload");

    const failure = new Error("queue unavailable");
    const failing = createCloudflareProjectProvisioningQueue({
      send: vi.fn(async () => Promise.reject(failure)),
    });
    await expect(failing.send("payload", { signal: new AbortController().signal })).rejects.toBe(
      failure,
    );
  });

  it.each([
    ["complete", "completed"],
    ["errored", "failed"],
    ["terminated", "failed"],
    ["queued", "pending"],
    ["running", "pending"],
    ["paused", "pending"],
    ["waiting", "pending"],
    ["waitingForPause", "pending"],
    ["unknown", "uncertain"],
    ["future-state", "uncertain"],
  ])("maps Workflow status %s to %s", async (status, expected) => {
    const workflow = createCloudflareProjectProvisioningWorkflow({
      create: vi.fn(async () => ({ status: async () => ({ status }) })),
      get: vi.fn(),
    });
    await expect(workflow.execute({ workflowId: "workflow-1", message })).resolves.toBe(expected);
  });

  it.each([
    ["complete", "complete"],
    ["errored", "errored"],
    ["terminated", "terminated"],
    ["queued", "pending"],
    ["running", "pending"],
    ["paused", "pending"],
    ["waiting", "pending"],
    ["waitingForPause", "pending"],
    ["unknown", "uncertain"],
  ] as const)("preserves exact ensured Workflow outcome %s as %s", async (status, expected) => {
    const create = vi.fn(async () => ({ status: async () => ({ status }) }));
    await expect(
      ensureCloudflareProjectProvisioningWorkflow(
        { create, get: vi.fn() },
        { workflowId: "workflow-1", message },
      ),
    ).resolves.toBe(expected);
    expect(create).toHaveBeenCalledWith({ id: "workflow-1", params: message });
  });

  it("reconciles duplicate or failed create through get and status", async () => {
    const get = vi.fn(async () => ({ status: async () => ({ status: "complete" }) }));
    const workflow = createCloudflareProjectProvisioningWorkflow({
      create: vi.fn(async () => Promise.reject(new Error("instance already exists"))),
      get,
    });
    await expect(workflow.execute({ workflowId: "workflow-1", message })).resolves.toBe(
      "completed",
    );
    expect(get).toHaveBeenCalledWith("workflow-1");
  });

  it.each([
    ["queued", "pending"],
    ["running", "pending"],
    ["complete", "complete"],
    ["errored", "errored"],
    ["terminated", "terminated"],
    ["unknown", "uncertain"],
  ] as const)(
    "ensures the exact original Deployment Workflow by create then same-ID get/status for %s",
    async (status, expected) => {
      const create = vi.fn(async () => ({ status: vi.fn(async () => ({ status })) }));
      const get = vi.fn(async () => ({ status: vi.fn(async () => ({ status })) }));
      await expect(
        ensureCloudflareProductCommandWorkflow(
          { create, get },
          { workflowId: deploymentWorkflowId, message: deploymentMessage },
        ),
      ).resolves.toBe(expected);
      expect(create).toHaveBeenCalledWith({
        id: deploymentWorkflowId,
        params: deploymentMessage,
      });
      expect(get).toHaveBeenCalledWith(deploymentWorkflowId);
    },
  );

  it("keeps a lost original Deployment Workflow create response on the same logical ID", async () => {
    const get = vi.fn(async () => ({ status: vi.fn(async () => ({ status: "queued" })) }));
    await expect(
      ensureCloudflareProductCommandWorkflow(
        { create: vi.fn(async () => Promise.reject(new Error("lost create response"))), get },
        { workflowId: deploymentWorkflowId, message: deploymentMessage },
      ),
    ).resolves.toBe("pending");
    expect(get).toHaveBeenCalledWith(deploymentWorkflowId);
  });

  it("starts the Workflow with the core deterministic ID and strict message", async () => {
    const create = vi.fn(async () => ({ status: async () => ({ status: "running" }) }));
    const consumer = createProjectProvisioningConsumer({
      workflow: createCloudflareProjectProvisioningWorkflow({ create, get: vi.fn() }),
      completion: { completeAtomic: vi.fn() },
      failure: { failAtomic: vi.fn() },
      reconciliation: { requireReconciliationAtomic: vi.fn() },
    });
    await expect(consumer.consume(serializeProjectProvisioningMessageV1(message))).resolves.toEqual(
      {
        status: "pending",
        workflowId: `project-provisioning-v1-${message.eventId}-${message.operationId}`,
      },
    );
    expect(create).toHaveBeenCalledWith({
      id: `project-provisioning-v1-${message.eventId}-${message.operationId}`,
      params: message,
    });
  });

  it("keeps a Workflow whose create and lookup both failed pending for a retry of the same ID", async () => {
    const create = vi.fn(async () => Promise.reject(new Error("create failed")));
    const missing = createCloudflareProjectProvisioningWorkflow({
      create,
      get: vi.fn(async () => Promise.reject(new Error("get failed"))),
    });
    await expect(missing.execute({ workflowId: "workflow-1", message })).resolves.toBe("pending");
    expect(create).toHaveBeenCalledWith({ id: "workflow-1", params: message });
  });

  it("returns uncertain when status inspection is unsafe", async () => {
    const malformed = createCloudflareProjectProvisioningWorkflow({
      create: vi.fn(async () => ({ status: async () => null })),
      get: vi.fn(),
    });
    await expect(malformed.execute({ workflowId: "workflow-1", message })).resolves.toBe(
      "uncertain",
    );

    const inspectionFailure = createCloudflareProjectProvisioningWorkflow({
      create: vi.fn(async () => ({
        status: async () => Promise.reject(new Error("status failed")),
      })),
      get: vi.fn(),
    });
    await expect(inspectionFailure.execute({ workflowId: "workflow-1", message })).resolves.toBe(
      "uncertain",
    );
  });

  it("lets the core timeout a late Queue send without acknowledging the outbox", async () => {
    vi.useFakeTimers();
    let finishSend: (() => void) | undefined;
    const binding = {
      send: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSend = resolve;
          }),
      ),
    };
    const acknowledgeExact = vi.fn(async () => true);
    const recordDeliveryUncertain = vi.fn(async () => ({
      outcome: "retry_scheduled" as const,
      attemptNumber: 1,
    }));
    const publisher = createProjectProvisioningPublisher({
      outbox: {
        recoverExpiredFinalProjectProvisioningClaim: async () => null,
        claimProjectProvisioningRequested: async () => ({
          eventType: message.eventType,
          eventId: message.eventId,
          organizationId: message.organizationId,
          projectId: message.projectId,
          operationId: message.operationId,
          payload: { projectId: message.projectId, operationId: message.operationId },
          attemptId,
          attemptNumber: 1,
          maxAttempts: 3,
        }),
        acknowledgeExact,
        recordDeliveryUncertain,
        recordQueueConfigurationFailureExact: vi.fn(),
        failInvalidExact: vi.fn(),
      },
      queue: createCloudflareProjectProvisioningQueue(binding),
      queueSendTimeoutMilliseconds: 5,
      classifyQueueError: () => "uncertain",
    });

    const publishing = publisher.publishOne();
    await vi.advanceTimersByTimeAsync(5);
    await expect(publishing).resolves.toMatchObject({
      status: "retry_scheduled",
      cause: "timeout",
    });
    finishSend?.();
    await vi.runAllTimersAsync();
    expect(recordDeliveryUncertain).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "timeout" }),
    );
    expect(acknowledgeExact).not.toHaveBeenCalled();
  });
});
