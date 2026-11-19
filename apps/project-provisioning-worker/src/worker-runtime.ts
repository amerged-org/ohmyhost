import {
  readCorePublisherBindings,
  readCoreConsumerBindings,
  readCoreWorkflowBindings,
} from "./core-bindings.js";
import {
  createCoreScheduledPublisher,
  createCoreQueueConsumer,
  createCoreWorkflowPersistence,
} from "./core-composition.js";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { consumeProjectProvisioningQueueBatch } from "./queue-consumer.js";
import type { CloudflareQueueBatch } from "./runtime-types.js";
import { runProjectProvisioningWorkflow } from "./workflow-runtime.js";

export async function runScheduledPublisher(value: unknown, limit: 1 | 10 = 10): Promise<void> {
  await createCoreScheduledPublisher(readCorePublisherBindings(value), limit).publishOne();
}

export async function runQueueConsumer(
  batch: CloudflareQueueBatch<unknown>,
  value: unknown,
): Promise<void> {
  await consumeProjectProvisioningQueueBatch(
    batch,
    createCoreQueueConsumer(readCoreConsumerBindings(value)),
  );
}

export async function runWorkflowEntrypoint(
  event: Pick<WorkflowEvent<unknown>, "payload" | "instanceId">,
  step: Pick<WorkflowStep, "do">,
  value: unknown,
) {
  const bindings = readCoreWorkflowBindings(value);
  return runProjectProvisioningWorkflow(
    event,
    step,
    createCoreWorkflowPersistence(bindings.PROJECT_WORKFLOW_RUNTIME),
  );
}
