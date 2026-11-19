import { callBinding } from "./core-binding-call.js";
import type {
  DeploymentHandlePort,
  DeploymentHandleRuntimeBinding,
} from "./deployment-handle-port.js";
import { completionCommon } from "./workflow-identities.js";
export function createCoreDeploymentHandlePort(
  binding: DeploymentHandleRuntimeBinding,
  now: () => Date,
): DeploymentHandlePort {
  return Object.freeze<DeploymentHandlePort>({
    finalizeHandleChange: async ({ workflowId, executionId, command, moved }) => {
      const c = await completionCommon(workflowId, executionId, command, now);
      return callBinding(binding, "finalizeProductHandleChange", {
        organizationId: command.organizationId,
        projectId: command.projectId,
        environmentId: command.environmentId,
        operationId: command.operationId,
        requestedHandle: command.requestedHandle,
        moved,
        workflowId,
        outboxEventId: command.eventId,
        startedOperationEventId: c.startedOperationEventId,
        operationEventId: c.operationEventId,
        auditEventId: c.auditEventId,
        completedAt: c.completedAt,
        ...("reconciliationAttemptId" in c
          ? { reconciliationAttemptId: c.reconciliationAttemptId }
          : {}),
        ...("replayAttemptId" in c ? { replayAttemptId: c.replayAttemptId } : {}),
      });
    },
  });
}
