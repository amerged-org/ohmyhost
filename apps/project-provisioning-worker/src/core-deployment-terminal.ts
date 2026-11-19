import { callBinding } from "./core-binding-call.js";
import type {
  DeploymentTerminalPort,
  DeploymentTerminalRuntimeBinding,
} from "./deployment-terminal-port.js";
import { completionCommon, reconciliationAttempt, canonicalDate } from "./workflow-identities.js";
import { deterministicUlid } from "./deterministic-ulid.js";
function reconciliationScope(workflowId: string, executionId: string) {
  const attempt = reconciliationAttempt(workflowId, executionId);
  return attempt.reconciliationAttemptId !== undefined
    ? { reconciliationAttemptId: attempt.reconciliationAttemptId }
    : {};
}
/** Closed parent failure/health groups. RPC methods are invoked on the actual binding. */
export function createCoreDeploymentTerminalPort(
  binding: DeploymentTerminalRuntimeBinding,
  now: () => Date,
): DeploymentTerminalPort {
  return Object.freeze<DeploymentTerminalPort>({
    fail: async ({ workflowId, executionId, command, errorCode, failure, health, migration }) => {
      const common = await completionCommon(workflowId, executionId, command, now);
      const result = await callBinding(binding, "failProductDeployment", {
        failure: failure ?? null,
        health: health ?? null,
        migration: migration ?? null,
        workflowId,
        ...reconciliationScope(workflowId, executionId),
        organizationId: command.organizationId,
        projectId: command.projectId,
        environmentId: command.environmentId,
        operationId: command.operationId,
        outboxEventId: command.eventId,
        startedOperationEventId: common.startedOperationEventId,
        operationEventId: common.operationEventId,
        auditEventId: common.auditEventId,
        actorId: common.actorId,
        errorCode,
        failedAt: common.completedAt,
      });
      return result === "replayed" ? "duplicate" : "applied";
    },
    recordHealthFailure: async ({ workflowId, executionId, command, health }) => {
      const diagnosticEventId = await deterministicUlid(`${executionId}:runtime-health-diagnostic`);
      const result = await callBinding(binding, "recordRuntimeHealthDiagnostic", {
        workflowId,
        ...reconciliationScope(workflowId, executionId),
        organizationId: command.organizationId,
        projectId: command.projectId,
        environmentId: command.environmentId,
        operationId: command.operationId,
        outboxEventId: command.eventId,
        diagnosticEventId,
        health,
        recordedAt: canonicalDate(now),
      });
      return result === "created" ? "applied" : "duplicate";
    },
  });
}
