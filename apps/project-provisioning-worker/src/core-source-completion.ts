import { callBinding } from "./core-binding-call.js";
import { completionCommon } from "./workflow-identities.js";
import { sourceLinkEvidence } from "./source-link-evidence.js";
import type {
  SourceCompletionPort,
  SourceCompletionRuntimeBinding,
} from "./source-completion-port.js";
/** One named parent completion command; source facts, binding generation and terminal history never split across RPCs. */
export function createCoreSourceCompletionPort(
  binding: SourceCompletionRuntimeBinding,
  now: () => Date,
): SourceCompletionPort {
  return Object.freeze<SourceCompletionPort>({
    complete: async ({ workflowId, executionId, command, evidence }) => {
      const common = await completionCommon(workflowId, executionId, command, now),
        link = sourceLinkEvidence(evidence);
      const result = await callBinding(binding, "completeSourceLink", {
        eventType: command.eventType,
        workflowId,
        ...("reconciliationAttemptId" in common
          ? { reconciliationAttemptId: common.reconciliationAttemptId }
          : {}),
        ...("replayAttemptId" in common ? { replayAttemptId: common.replayAttemptId } : {}),
        organizationId: command.organizationId,
        projectId: command.projectId,
        environmentId: command.environmentId,
        operationId: command.operationId,
        outboxEventId: command.eventId,
        startedOperationEventId: common.startedOperationEventId,
        operationEventId: common.operationEventId,
        auditEventId: common.auditEventId,
        externalRepositoryId: link.externalRepositoryId,
        completedAt: common.completedAt,
      });
      return result === "replayed" ? "duplicate" : "applied";
    },
  });
}
