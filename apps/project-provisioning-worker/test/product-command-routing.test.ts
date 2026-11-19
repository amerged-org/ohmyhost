import {
  createProductCommandConsumer,
  deterministicProductCommandWorkflowId,
  parseProductCommandMessageV1,
  serializeProductCommandMessageV1,
} from "@ohmyhost/orchestrator";
import { describe, expect, it, vi } from "vitest";

import { createCloudflareProductCommandWorkflow } from "../src/cloudflare-adapters.js";
import { createQueueMessageRouter } from "../src/composition.js";
import { consumeProjectProvisioningQueueBatch } from "../src/queue-consumer.js";

const command = parseProductCommandMessageV1({
  version: 1,
  eventType: "DeploymentRequestedV1",
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  billingEpochId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  planId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
});

describe("product command Queue routing", () => {
  it("starts product commands on the separate DeploymentWorkflow binding", async () => {
    const create = vi.fn(async () => ({ status: async () => ({ status: "complete" }) }));
    const product = createProductCommandConsumer(
      createCloudflareProductCommandWorkflow({ create, get: vi.fn() }),
    );
    const provisioning = { consume: vi.fn() };
    const router = createQueueMessageRouter({ provisioning, product });

    await expect(router.consume(serializeProductCommandMessageV1(command))).resolves.toEqual({
      status: "completed",
      workflowId: deterministicProductCommandWorkflowId(command),
      durable: "workflow_terminal",
    });
    expect(create).toHaveBeenCalledWith({
      id: deterministicProductCommandWorkflowId(command),
      params: command,
    });
    expect(provisioning.consume).not.toHaveBeenCalled();
  });

  it("keeps non-terminal and errored product Workflows on Queue retry", async () => {
    const product = createProductCommandConsumer(
      createCloudflareProductCommandWorkflow({
        create: vi.fn(async () => ({ status: async () => ({ status: "errored" }) })),
        get: vi.fn(),
      }),
    );
    const delivery = {
      body: serializeProductCommandMessageV1(command),
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeProjectProvisioningQueueBatch(
      { messages: [delivery] },
      createQueueMessageRouter({ provisioning: { consume: vi.fn() }, product }),
    );
    expect(delivery.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(delivery.ack).not.toHaveBeenCalled();
  });

  it("preserves ProjectProvisioningRequested routing", async () => {
    const provisioning = {
      consume: vi.fn(async () => ({
        status: "completed" as const,
        workflowId: "provisioning-1",
        completion: "applied" as const,
      })),
    };
    const product = { consume: vi.fn() };
    const router = createQueueMessageRouter({ provisioning, product });
    const serialized = JSON.stringify({ version: 1, eventType: "ProjectProvisioningRequested" });
    await expect(router.consume(serialized)).resolves.toMatchObject({ status: "completed" });
    expect(provisioning.consume).toHaveBeenCalledWith(serialized);
    expect(product.consume).not.toHaveBeenCalled();
  });
});
