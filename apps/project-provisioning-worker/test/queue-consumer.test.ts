import {
  createProjectProvisioningConsumer,
  serializeProjectProvisioningMessageV1,
} from "@ohmyhost/orchestrator";
import { describe, expect, it, vi } from "vitest";

import { consumeProjectProvisioningQueueBatch } from "../src/queue-consumer.js";
import { createCloudflareProjectProvisioningWorkflow } from "../src/cloudflare-adapters.js";
import { message } from "./fixtures.js";

const queueMessage = (body: unknown) => ({
  body,
  ack: vi.fn(),
  retry: vi.fn(),
});

describe("project provisioning Queue consumer", () => {
  it("acknowledges only terminal durable consume results", async () => {
    const completed = queueMessage(serializeProjectProvisioningMessageV1(message));
    const failed = queueMessage(serializeProjectProvisioningMessageV1(message));
    const reconciled = queueMessage(serializeProjectProvisioningMessageV1(message));
    const consume = vi
      .fn()
      .mockResolvedValueOnce({
        status: "completed",
        workflowId: "workflow-1",
        completion: "duplicate",
      })
      .mockResolvedValueOnce({ status: "failed", workflowId: "workflow-1", failure: "applied" })
      .mockResolvedValueOnce({
        status: "reconciliation_required",
        workflowId: "workflow-1",
        reconciliation: "duplicate",
      });
    await consumeProjectProvisioningQueueBatch(
      { messages: [completed, failed, reconciled] },
      { consume },
    );
    for (const item of [completed, failed, reconciled]) {
      expect(item.ack).toHaveBeenCalledOnce();
      expect(item.retry).not.toHaveBeenCalled();
    }
  });

  it("retries pending Workflow observations with an explicit bounded delay", async () => {
    const pending = queueMessage(serializeProjectProvisioningMessageV1(message));
    await consumeProjectProvisioningQueueBatch(
      { messages: [pending] },
      {
        consume: vi.fn(async () => ({ status: "pending" as const, workflowId: "workflow-1" })),
      },
    );
    expect(pending.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(pending.ack).not.toHaveBeenCalled();
  });

  it("retries non-string, thrown, and unsupported consume outcomes without acknowledging", async () => {
    const nonString = queueMessage({ unsafe: true });
    const thrown = queueMessage(serializeProjectProvisioningMessageV1(message));
    const unsupported = queueMessage(serializeProjectProvisioningMessageV1(message));
    const consume = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("invalid message"))
      .mockResolvedValueOnce({ status: "invented", workflowId: "workflow-1" });
    await consumeProjectProvisioningQueueBatch(
      { messages: [nonString, thrown, unsupported] },
      { consume },
    );
    for (const item of [nonString, thrown, unsupported]) {
      expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
      expect(item.ack).not.toHaveBeenCalled();
    }
  });

  it("retries a Workflow whose create and lookup both failed instead of acknowledging it", async () => {
    const workflowId = `project-provisioning-v1-${message.eventId}-${message.operationId}`;
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("workflows temporarily unavailable"))
      .mockResolvedValueOnce({ status: async () => ({ status: "running" }) });
    const get = vi.fn(async () => {
      throw new Error("workflows temporarily unavailable");
    });
    const requireReconciliationAtomic = vi.fn();
    const consumer = createProjectProvisioningConsumer({
      workflow: createCloudflareProjectProvisioningWorkflow({ create, get }),
      completion: { completeAtomic: vi.fn() },
      failure: { failAtomic: vi.fn() },
      reconciliation: { requireReconciliationAtomic },
    });

    const first = queueMessage(serializeProjectProvisioningMessageV1(message));
    await consumeProjectProvisioningQueueBatch({ messages: [first] }, consumer);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(requireReconciliationAtomic).not.toHaveBeenCalled();

    const second = queueMessage(serializeProjectProvisioningMessageV1(message));
    await consumeProjectProvisioningQueueBatch({ messages: [second] }, consumer);
    expect(create).toHaveBeenNthCalledWith(2, { id: workflowId, params: message });
    expect(second.ack).not.toHaveBeenCalled();
    expect(requireReconciliationAtomic).not.toHaveBeenCalled();
  });

  it("re-observes pending and failed Workflows until failure persistence is durable", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ status: async () => ({ status: "running" }) })
      .mockRejectedValue(new Error("instance already exists"));
    const get = vi.fn(async () => ({ status: async () => ({ status: "errored" }) }));
    const failAtomic = vi
      .fn()
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce("applied");
    const consumer = createProjectProvisioningConsumer({
      workflow: createCloudflareProjectProvisioningWorkflow({ create, get }),
      completion: { completeAtomic: vi.fn() },
      failure: { failAtomic },
      reconciliation: { requireReconciliationAtomic: vi.fn() },
    });

    const deliveries = [
      queueMessage(serializeProjectProvisioningMessageV1(message)),
      queueMessage(serializeProjectProvisioningMessageV1(message)),
      queueMessage(serializeProjectProvisioningMessageV1(message)),
    ];
    for (const delivery of deliveries) {
      await consumeProjectProvisioningQueueBatch({ messages: [delivery] }, consumer);
    }

    expect(deliveries[0]?.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(deliveries[1]?.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(deliveries[2]?.ack).toHaveBeenCalledOnce();
    expect(deliveries[2]?.retry).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    expect(failAtomic).toHaveBeenCalledTimes(2);
  });
});
