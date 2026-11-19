import type {
  ProjectProvisioningQueuePort,
  ProjectProvisioningMessageV1,
  ProjectProvisioningQueueSendOutcome,
  ProjectProvisioningWorkflowExecutionOutcome,
  ProjectProvisioningWorkflowPort,
  ProductCommandMessageV1,
  ProductCommandWorkflowPort,
} from "@ohmyhost/orchestrator";

import type {
  CloudflareQueueBinding,
  CloudflareWorkflowBinding,
  CloudflareWorkflowInstance,
} from "./runtime-types.js";

export function createCloudflareProjectProvisioningQueue(
  binding: CloudflareQueueBinding<string>,
): Readonly<ProjectProvisioningQueuePort> {
  return Object.freeze({
    send: async (serializedMessage: string): Promise<ProjectProvisioningQueueSendOutcome> => {
      await binding.send(serializedMessage);
      return "sent";
    },
  });
}

export function createCloudflareProductCommandWorkflow(
  binding: CloudflareWorkflowBinding<ProductCommandMessageV1>,
): Readonly<ProductCommandWorkflowPort> {
  return Object.freeze({
    execute: async ({
      workflowId,
      message,
    }: {
      readonly workflowId: string;
      readonly message: ProductCommandMessageV1;
    }): Promise<"completed" | "pending" | "uncertain"> => {
      let instance: CloudflareWorkflowInstance;
      try {
        instance = await binding.create({ id: workflowId, params: message });
      } catch {
        try {
          instance = await binding.get(workflowId);
        } catch {
          return "uncertain";
        }
      }
      const outcome = await inspectWorkflowInstance(instance);
      return outcome === "completed"
        ? "completed"
        : outcome === "pending"
          ? "pending"
          : "uncertain";
    },
  });
}

export type ProductCommandWorkflowEnsureOutcome =
  | "pending"
  | "complete"
  | "errored"
  | "terminated"
  | "uncertain";

/**
 * Re-reads the exact logical instance after create so a lost create response cannot mint a replay.
 */
export async function ensureCloudflareProductCommandWorkflow(
  binding: CloudflareWorkflowBinding<unknown>,
  input: {
    readonly workflowId: string;
    readonly message: ProductCommandMessageV1;
  },
): Promise<ProductCommandWorkflowEnsureOutcome> {
  try {
    await binding.create({ id: input.workflowId, params: input.message });
  } catch {
    // A duplicate create may be the exact original instance after a lost response.
  }
  let instance: CloudflareWorkflowInstance;
  try {
    instance = await binding.get(input.workflowId);
  } catch {
    return "uncertain";
  }
  try {
    const details = await instance.status();
    if (!isRecord(details) || typeof details["status"] !== "string") return "uncertain";
    switch (details["status"]) {
      case "complete":
      case "errored":
      case "terminated":
        return details["status"];
      case "queued":
      case "running":
      case "paused":
      case "waiting":
      case "waitingForPause":
        return "pending";
      default:
        return "uncertain";
    }
  } catch {
    return "uncertain";
  }
}

export function createCloudflareProjectProvisioningWorkflow(
  binding: CloudflareWorkflowBinding,
): Readonly<ProjectProvisioningWorkflowPort> {
  return Object.freeze({
    execute: async (input: {
      readonly workflowId: string;
      readonly message: ProjectProvisioningMessageV1;
    }) =>
      legacyProjectProvisioningWorkflowOutcome(
        await ensureProjectProvisioningWorkflowInstance(binding, input),
      ),
  });
}

export type ProjectProvisioningWorkflowEnsureOutcome =
  | "pending"
  | "complete"
  | "errored"
  | "terminated"
  | "uncertain";

/** Neither create nor lookup answered, so no instance is proven to exist. */
type ProjectProvisioningWorkflowLookupOutcome =
  | ProjectProvisioningWorkflowEnsureOutcome
  | "unavailable";

/**
 * The admin recovery ensures the exact Workflow once. Unreachable create and lookup stay "uncertain"
 * here: a recovery recorded for a Workflow that was never proven would finish the operation.
 */
export async function ensureCloudflareProjectProvisioningWorkflow(
  binding: CloudflareWorkflowBinding,
  input: {
    readonly workflowId: string;
    readonly message: ProjectProvisioningMessageV1;
  },
): Promise<ProjectProvisioningWorkflowEnsureOutcome> {
  const outcome = await ensureProjectProvisioningWorkflowInstance(binding, input);
  return outcome === "unavailable" ? "uncertain" : outcome;
}

async function ensureProjectProvisioningWorkflowInstance(
  binding: CloudflareWorkflowBinding,
  input: {
    readonly workflowId: string;
    readonly message: ProjectProvisioningMessageV1;
  },
): Promise<ProjectProvisioningWorkflowLookupOutcome> {
  let instance: CloudflareWorkflowInstance;
  try {
    instance = await binding.create({ id: input.workflowId, params: input.message });
  } catch {
    try {
      instance = await binding.get(input.workflowId);
    } catch {
      return "unavailable";
    }
  }
  return inspectProjectProvisioningWorkflowInstance(instance);
}

async function inspectWorkflowInstance(
  instance: CloudflareWorkflowInstance,
): Promise<ProjectProvisioningWorkflowExecutionOutcome> {
  return legacyProjectProvisioningWorkflowOutcome(
    await inspectProjectProvisioningWorkflowInstance(instance),
  );
}

async function inspectProjectProvisioningWorkflowInstance(
  instance: CloudflareWorkflowInstance,
): Promise<ProjectProvisioningWorkflowEnsureOutcome> {
  try {
    const details = await instance.status();
    if (!isRecord(details) || typeof details["status"] !== "string") return "uncertain";
    switch (details["status"]) {
      case "complete":
      case "errored":
      case "terminated":
        return details["status"];
      case "queued":
      case "running":
      case "paused":
      case "waiting":
      case "waitingForPause":
        return "pending";
      default:
        return "uncertain";
    }
  } catch {
    return "uncertain";
  }
}

function legacyProjectProvisioningWorkflowOutcome(
  outcome: ProjectProvisioningWorkflowLookupOutcome,
): ProjectProvisioningWorkflowExecutionOutcome {
  if (outcome === "complete") return "completed";
  if (outcome === "errored" || outcome === "terminated") return "failed";
  // The Queue message is retried with the same deterministic ID; a later create or lookup finds the
  // Workflow. Reconciling now would acknowledge the message while no instance is proven.
  if (outcome === "unavailable") return "pending";
  return outcome;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
