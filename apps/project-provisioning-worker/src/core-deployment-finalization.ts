import { callBinding } from "./core-binding-call.js";
import type {
  CandidateFinalization,
  RollbackFinalization,
  FinalizationCompletionIdentity,
  DeploymentFinalizationPort,
  DeploymentFinalizationRuntimeBinding,
} from "./deployment-finalization-port.js";
function common(
  input: NonNullable<CandidateFinalization["completion"]> | RollbackFinalization["completion"],
): FinalizationCompletionIdentity {
  if (input.workflowId === undefined)
    throw new TypeError("Deployment finalization requires its original Workflow identity");
  return {
    workflowId: input.workflowId,
    outboxEventId: input.outboxEventId,
    startedOperationEventId: input.startedOperationEventId,
    operationEventId: input.operationEventId,
    auditEventId: input.auditEventId,
    acceptedLifecycleVersion: input.acceptedLifecycleVersion,
    ...(input.reconciliationAttemptId === undefined
      ? {}
      : { reconciliationAttemptId: input.reconciliationAttemptId }),
    ...(input.replayAttemptId === undefined ? {} : { replayAttemptId: input.replayAttemptId }),
  };
}
/** Whole original publication/schedule/terminal groups cross ONE named RPC; no SQL or generic terminal JSON. */
export function createCoreDeploymentFinalizationPort(
  binding: DeploymentFinalizationRuntimeBinding,
): DeploymentFinalizationPort {
  return Object.freeze<DeploymentFinalizationPort>({
    assertBindingRefresh: (input) =>
      callBinding(binding, "assertProductBindingRefresh", {
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        operationId: input.operationId,
        snapshot: input.snapshot,
        allowPublished: input.allowPublished,
      }),
    finishBindingRefresh: async (input) =>
      callBinding(binding, "finishProductBindingRefresh", {
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        operationId: input.operationId,
        completedAt: input.completedAt,
        completion: {
          ...common(input),
          runtimePolicy: input.terminalEvidence?.["runtimePolicy"],
          result: input.finalizedWfpResult ?? null,
        },
      }),
    finalizeCandidate: async (input) =>
      callBinding(binding, "finalizeProductCandidate", {
        eventType: input.eventType,
        bindingRefreshSnapshot: input.bindingRefreshSnapshot,
        publication: input.publication,
        schedule: {
          crons: input.schedule.crons,
          egressAllowedOrigins: input.schedule.egressAllowedOrigins,
        },
        completion:
          input.completion === null
            ? null
            : {
                ...common(input.completion),
                runtimePolicy: input.completion.terminalEvidence?.["runtimePolicy"],
                result:
                  input.completion.eventType === "DeploymentRequestedV1"
                    ? (input.completion.finalizedWfpResult ?? null)
                    : null,
              },
      }),
    finalizeRollback: async (input) =>
      callBinding(binding, "finalizeProductRollback", {
        activation: input.activation,
        schedule: {
          crons: input.schedule.crons,
          egressAllowedOrigins: input.schedule.egressAllowedOrigins,
        },
        completion: {
          ...common(input.completion),
          runtimePolicy: input.completion.terminalEvidence?.["runtimePolicy"],
        },
      }),
  });
}
