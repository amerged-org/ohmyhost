import type {
  ProductCommandConsumptionResult,
  ProjectProvisioningConsumptionResult,
} from "@ohmyhost/orchestrator";

import {
  MANAGED_SOURCE_PUBLICATION_EVENT_TYPE,
  MANAGED_SOURCE_INITIALIZATION_EVENT_TYPE,
  type ManagedSourceConsumptionResult,
} from "./managed-source-jobs.js";

export function createQueueMessageRouter(dependencies: {
  readonly provisioning: {
    consume(serializedMessage: string): Promise<ProjectProvisioningConsumptionResult>;
  };
  readonly product: {
    consume(serializedMessage: string): Promise<ProductCommandConsumptionResult>;
  };
  readonly managedSource?: {
    consume(serializedMessage: string): Promise<ManagedSourceConsumptionResult>;
  };
}): Readonly<{
  consume(
    serializedMessage: string,
  ): Promise<
    | ProjectProvisioningConsumptionResult
    | ProductCommandConsumptionResult
    | ManagedSourceConsumptionResult
  >;
}> {
  if (typeof dependencies.provisioning.consume !== "function") {
    throw new TypeError("Queue router requires the project provisioning consumer");
  }
  if (typeof dependencies.product.consume !== "function") {
    throw new TypeError("Queue router requires the product command consumer");
  }
  return Object.freeze({
    consume: async (serializedMessage: string) => {
      const eventType = parseEventType(serializedMessage);
      if (
        eventType === MANAGED_SOURCE_PUBLICATION_EVENT_TYPE ||
        eventType === MANAGED_SOURCE_INITIALIZATION_EVENT_TYPE
      ) {
        if (!dependencies.managedSource)
          throw new TypeError("Managed source Queue processor is unavailable");
        return dependencies.managedSource.consume(serializedMessage);
      }
      return eventType === "ProjectProvisioningRequested"
        ? dependencies.provisioning.consume(serializedMessage)
        : dependencies.product.consume(serializedMessage);
    },
  });
}

function parseEventType(serializedMessage: string): string {
  let value: unknown;
  try {
    value = JSON.parse(serializedMessage);
  } catch {
    throw new TypeError("Queue message must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Queue message must be an object");
  }
  const eventType = (value as Readonly<Record<string, unknown>>)["eventType"];
  if (typeof eventType !== "string") throw new TypeError("Queue message event type is missing");
  return eventType;
}
