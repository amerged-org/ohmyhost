import type {
  ProductCommandConsumptionResult,
  ProjectProvisioningConsumptionResult,
} from "@ohmyhost/orchestrator";

import type { CloudflareQueueBatch } from "./runtime-types.js";
import type { ManagedSourceConsumptionResult } from "./managed-source-jobs.js";

export interface ProjectProvisioningQueueConsumer {
  consume(
    serializedMessage: string,
  ): Promise<
    | ProjectProvisioningConsumptionResult
    | ProductCommandConsumptionResult
    | ManagedSourceConsumptionResult
  >;
}

const PROJECT_PROVISIONING_RETRY_DELAY_SECONDS = 30;

export async function consumeProjectProvisioningQueueBatch(
  batch: CloudflareQueueBatch<unknown>,
  consumer: ProjectProvisioningQueueConsumer,
): Promise<void> {
  for (const message of batch.messages) {
    if (typeof message.body !== "string") {
      retry(message);
      continue;
    }
    try {
      const result = await consumer.consume(message.body);
      if (!isTerminalDurableConsumeResult(result)) {
        retry(message);
        continue;
      }
      message.ack();
    } catch {
      retry(message);
    }
  }
}

function isTerminalDurableConsumeResult(
  value: unknown,
): value is ProjectProvisioningConsumptionResult | ManagedSourceConsumptionResult {
  if (!isRecord(value)) return false;
  if (
    value["status"] === "completed" &&
    (value["durable"] === "managed_source_terminal" ||
      value["durable"] === "managed_source_handoff")
  )
    return typeof value["jobId"] === "string" && value["jobId"].length > 0;
  if (typeof value["workflowId"] !== "string") return false;
  switch (value["status"]) {
    case "completed":
      if (value["durable"] === "workflow_terminal") return true;
      return value["completion"] === "applied" || value["completion"] === "duplicate";
    case "failed":
      return value["failure"] === "applied" || value["failure"] === "duplicate";
    case "reconciliation_required":
      return value["reconciliation"] === "applied" || value["reconciliation"] === "duplicate";
    default:
      return false;
  }
}

function retry(message: CloudflareQueueBatch<unknown>["messages"][number]): void {
  message.retry({ delaySeconds: PROJECT_PROVISIONING_RETRY_DELAY_SECONDS });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
