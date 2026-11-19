import {
  deterministicProjectProvisioningWorkflowId,
  parseProjectProvisioningMessageV1,
} from "@ohmyhost/orchestrator";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ProjectProvisioningWorkflowPersistence } from "./runtime-types.js";

const PROJECT_PROVISIONING_STEP_CONFIG = Object.freeze({
  retries: Object.freeze({
    limit: 3,
    delay: "5 seconds" as const,
    backoff: "exponential" as const,
  }),
  timeout: "30 seconds" as const,
});

export async function runProjectProvisioningWorkflow(
  event: Pick<WorkflowEvent<unknown>, "payload" | "instanceId">,
  step: Pick<WorkflowStep, "do">,
  persistence: ProjectProvisioningWorkflowPersistence,
): Promise<Readonly<{ status: "completed"; persistence: "applied" | "duplicate" }>> {
  const message = parseProjectProvisioningMessageV1(event.payload);
  const workflowId = deterministicProjectProvisioningWorkflowId(message);
  if (event.instanceId !== workflowId) {
    throw new TypeError("Project provisioning Workflow instance ID does not match its payload");
  }
  try {
    const outcome = await step.do(
      "persist-project-provisioning-completion",
      PROJECT_PROVISIONING_STEP_CONFIG,
      () => persistence.completion.completeAtomic({ workflowId, message }),
    );
    return Object.freeze({ status: "completed", persistence: parsePersistence(outcome) });
  } catch (error) {
    try {
      await step.do("persist-project-provisioning-failure", PROJECT_PROVISIONING_STEP_CONFIG, () =>
        persistence.failure.failAtomic({ workflowId, message }),
      );
    } catch {
      // The original terminal step error is the authoritative Workflow failure.
    }
    throw error;
  }
}

function parsePersistence(value: unknown): "applied" | "duplicate" {
  if (value !== "applied" && value !== "duplicate") {
    throw new TypeError("Project provisioning persistence returned an unsupported outcome");
  }
  return value;
}
