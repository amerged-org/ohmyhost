import { callBinding } from "./core-binding-call.js";
import type { DeploymentPersistenceReaderPort } from "./deployment-persistence-port.js";
import type {
  DeploymentReconciliationPort,
  DeploymentReconciliationRuntimeBinding,
} from "./deployment-reconciliation-port.js";
import { derivedIds, reconciliationAttempt } from "./workflow-identities.js";
import { initialProviderReconciliationEvidence } from "./product-workflow-composition.js";
import { createWorkflowContextReader } from "./workflow-context-reader.js";
import { deterministicUlid } from "./deterministic-ulid.js";
export function createCoreDeploymentReconciliationPort(
  binding: DeploymentReconciliationRuntimeBinding,
  readers: DeploymentPersistenceReaderPort,
  now: () => Date,
): DeploymentReconciliationPort {
  const context = createWorkflowContextReader(readers);
  return Object.freeze<DeploymentReconciliationPort>({
    requireReconciliation: async ({ workflowId, executionId, command, providerHint }) => {
      await context(command, true);
      const ids = await derivedIds(executionId),
        providerReconciliation =
          providerHint === null
            ? null
            : await initialProviderReconciliationEvidence(executionId, providerHint),
        bindingsOutdated = providerHint?.reason === "candidate_bindings_outdated";
      const result = await callBinding(binding, "reconcileProductWorkflow", {
        workflowId,
        ...reconciliationAttempt(workflowId, executionId),
        organizationId: command.organizationId,
        projectId: command.projectId,
        environmentId: command.environmentId,
        operationId: command.operationId,
        outboxEventId: command.eventId,
        auditEventId: ids.reconciliationAuditEventId,
        reconciledAt: now().toISOString(),
        ...(providerReconciliation === null ? {} : { providerReconciliation }),
        bindingsOutdated,
        ...(bindingsOutdated
          ? {
              diagnosticId: await deterministicUlid(
                `${executionId}:candidate-bindings-outdated-diagnostic`,
              ),
            }
          : {}),
      });
      return result === "replayed" ? "duplicate" : "applied";
    },
  });
}
