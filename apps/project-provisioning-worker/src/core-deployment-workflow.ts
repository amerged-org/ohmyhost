import {
  PROVIDER_RECONCILIATION_METHODS,
  type ProviderReconciliationRuntimeBinding,
} from "./provider-reconciliation-data-port.js";
import {
  readDeploymentWorkflowServices,
  type DeploymentWorkflowServiceBindings,
} from "./bindings.js";
import { createDeploymentWorkflowPorts } from "./product-workflow-composition.js";
import { createCoreDeploymentReaderPort } from "./core-deployment-reader.js";
import { createCoreDeploymentTerminalPort } from "./core-deployment-terminal.js";
import { createCoreDeploymentSourcePort } from "./core-deployment-source.js";
import { createCoreSourceCompletionPort } from "./core-source-completion.js";
import { createCoreDeploymentAuthorizationPort } from "./core-deployment-authorization.js";
import { createCoreDeploymentFinalizationPort } from "./core-deployment-finalization.js";
import { createCoreDeploymentCleanupPort } from "./core-deployment-cleanup.js";
import { createCoreDeploymentCandidatePort } from "./core-deployment-candidate.js";
import { createCoreDeploymentReconciliationPort } from "./core-deployment-reconciliation.js";
import { createCoreDeploymentHandlePort } from "./core-deployment-handle.js";
import { createCoreDeploymentRollbackDataPort } from "./core-deployment-rollback-data.js";
import { createCoreDeploymentLifecyclePort } from "./core-deployment-lifecycle.js";
import {
  createCoreDeploymentInventory,
  type DeploymentInventoryRuntimeBinding,
} from "./core-deployment-inventory.js";
import type { DeploymentWorkflowRuntimeBinding } from "./deployment-persistence-port.js";
import type { DeploymentTerminalRuntimeBinding } from "./deployment-terminal-port.js";
import type { DeploymentSourceRuntimeBinding } from "./deployment-source-port.js";
import type { SourceCompletionRuntimeBinding } from "./source-completion-port.js";
import type { DeploymentAuthorizationRuntimeBinding } from "./deployment-authorization-port.js";
import type { DeploymentFinalizationRuntimeBinding } from "./deployment-finalization-port.js";
import type { DeploymentCleanupRuntimeBinding } from "./deployment-cleanup-port.js";
import type { DeploymentCandidateRuntimeBinding } from "./deployment-candidate-port.js";
import type { DeploymentReconciliationRuntimeBinding } from "./deployment-reconciliation-port.js";
import type { DeploymentHandleRuntimeBinding } from "./deployment-handle-port.js";
import type { DeploymentRollbackDataRuntimeBinding } from "./deployment-rollback-data-port.js";
import type { DeploymentAttemptRuntimeBinding } from "./deployment-attempt-port.js";
import type { DeploymentLeaseRuntimeBinding } from "./deployment-lease-port.js";
import type { DeploymentLifecycleRuntimeBinding } from "./deployment-lifecycle-port.js";
import { createCoreDeploymentAttemptPort } from "./core-deployment-attempt.js";
import {
  activateDeploymentReconciliationAttempt,
  activateDeploymentReplayAttempt,
} from "./product-workflow-composition.js";
import { runDeploymentWorkflowEntrypoint, withOperationLease } from "./product-workflow-runtime.js";
import {
  deterministicProductCommandWorkflowId,
  parseProductCommandMessageV1,
  type ProductWorkflowStepPort,
} from "@ohmyhost/orchestrator";
import type { WorkflowEvent } from "cloudflare:workers";

export type FullDeploymentRuntimeBinding = ProviderReconciliationRuntimeBinding &
  DeploymentWorkflowRuntimeBinding &
  DeploymentTerminalRuntimeBinding &
  DeploymentSourceRuntimeBinding &
  SourceCompletionRuntimeBinding &
  DeploymentAuthorizationRuntimeBinding &
  DeploymentFinalizationRuntimeBinding &
  DeploymentCleanupRuntimeBinding &
  DeploymentCandidateRuntimeBinding &
  DeploymentReconciliationRuntimeBinding &
  DeploymentHandleRuntimeBinding &
  DeploymentRollbackDataRuntimeBinding &
  DeploymentAttemptRuntimeBinding &
  DeploymentLeaseRuntimeBinding &
  DeploymentLifecycleRuntimeBinding &
  DeploymentInventoryRuntimeBinding;
export interface CoreDeploymentWorkflowBindings extends DeploymentWorkflowServiceBindings {
  readonly RUNTIME_CONFIGURATION_STATE: "configured";
  readonly DEPLOYMENT_WORKFLOW_RUNTIME: FullDeploymentRuntimeBinding;
}
const SERVICES = [
  "PROJECT_PROVISIONING_WORKFLOW",
  "DEPLOYMENT_WORKFLOW",
  "PROVIDER_RECONCILIATION_WORKFLOW",
  "SOURCE_FETCHER",
  "BUILD_RUNNER",
  "RECOVERY_INVOKER",
  "RUNTIME_SECRET_DELIVERY",
  "NEXT_CACHE_RETIREMENT",
  "NEON_MANAGEMENT",
  "NATIVE_AUTH_RESOURCE_RUNTIME",
  "NATIVE_AUTH_ADMIN_US",
  "NATIVE_AUTH_ADMIN_EU",
  "R2_MANAGEMENT",
  "STORAGE_DATA_MANAGEMENT",
  "SES_MANAGEMENT",
  "CLOUDFLARE_DOMAIN_MANAGEMENT",
  "WFP_MANAGEMENT",
];
const METHODS = [
  "readProductWorkflowContext",
  "readProductWorkflowDatabaseTarget",
  "claimProductProviderMutation",
  "failProductDeployment",
  "recordRuntimeHealthDiagnostic",
  "recordProductSourceArchiveEvidence",
  "observeSourceArchiveReceipt",
  "completeSourceLink",
  "assertProductOperationExecution",
  "authorizeProductActivation",
  "assertProductBindingRefresh",
  "finishProductBindingRefresh",
  "finalizeProductCandidate",
  "finalizeProductRollback",
  "prepareProductCandidateCleanup",
  "claimProductCandidateCleanup",
  "recordProductCandidateCleanup",
  "markProductCandidateSuperseded",
  "recordProductDeploymentCandidate",
  "recordAbandonedGatewayPredecessor",
  "readProductDataEnvironment",
  "resolveProductRollbackCandidate",
  "reconcileProductWorkflow",
  "finalizeProductHandleChange",
  "readProductRollbackDataTarget",
  "activateProductProviderReconciliationAttempt",
  "activateProductWorkflowReplayAttempt",
  "renewProductOperationLease",
  "completeProductLifecycleCommand",
  "retainProductDeletionTombstone",
  "readWfpProjectDeletionEvidence",
  "readCandidateCleanupResources",
  "recordCleanupAttempt",
  "startProjectDataChangeCleanup",
  "appendAuditedProjectDataChangeAssignments",
  "deleteProjectFunctionSchedules",
  "readManagedSourceDeletionInventory",
  "listNextCacheRetirementScopes",
  "recordNextCacheRetired",
];

/** The complete private protocol: the exact binding inventory and every method of the Core capability. */
export function readCoreDeploymentWorkflowBindings(raw: unknown): CoreDeploymentWorkflowBindings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new TypeError("Deployment Core bindings are missing");
  const r = raw as Record<string, unknown>,
    expected = new Set(["RUNTIME_CONFIGURATION_STATE", "DEPLOYMENT_WORKFLOW_RUNTIME", ...SERVICES]);
  if (
    r["RUNTIME_CONFIGURATION_STATE"] !== "configured" ||
    Object.keys(r).length !== expected.size ||
    Object.keys(r).some((k) => !expected.has(k))
  )
    throw new TypeError("Deployment Core persistence configuration differs");
  const binding = r["DEPLOYMENT_WORKFLOW_RUNTIME"];
  if (
    typeof binding !== "object" ||
    binding === null ||
    [...METHODS, ...PROVIDER_RECONCILIATION_METHODS].some(
      (m) => typeof Reflect.get(binding, m) !== "function",
    )
  )
    throw new TypeError("Deployment Core capability is incomplete");
  return Object.freeze({
    RUNTIME_CONFIGURATION_STATE: "configured",
    DEPLOYMENT_WORKFLOW_RUNTIME: binding as FullDeploymentRuntimeBinding,
    ...readDeploymentWorkflowServices(r),
  });
}

/** Every persistence group of the Deployment Workflow is supplied explicitly by the Core binding. */
function createCoreDeploymentWorkflowPorts(
  bindings: CoreDeploymentWorkflowBindings,
  now: () => Date,
) {
  const binding = bindings.DEPLOYMENT_WORKFLOW_RUNTIME,
    readers = createCoreDeploymentReaderPort(binding);
  return createDeploymentWorkflowPorts(
    bindings,
    {
      readers,
      terminals: createCoreDeploymentTerminalPort(binding, now),
      custody: createCoreDeploymentSourcePort(binding),
      sourceCompletion: createCoreSourceCompletionPort(binding, now),
      authorization: createCoreDeploymentAuthorizationPort(binding),
      finalization: createCoreDeploymentFinalizationPort(binding),
      cleanup: createCoreDeploymentCleanupPort(binding),
      candidate: createCoreDeploymentCandidatePort(binding),
      reconciliation: createCoreDeploymentReconciliationPort(binding, readers, now),
      handle: createCoreDeploymentHandlePort(binding, now),
      rollbackData: createCoreDeploymentRollbackDataPort(binding),
      lifecycle: createCoreDeploymentLifecyclePort(binding, readers, now),
      inventory: createCoreDeploymentInventory(binding),
    },
    now,
  );
}

/** The full Core execution: every persistence call crosses the private Core binding. */
export function runCoreDeploymentWorkflow(
  bindings: CoreDeploymentWorkflowBindings,
  event: Pick<WorkflowEvent<unknown>, "payload" | "instanceId">,
  step: ProductWorkflowStepPort,
  now: () => Date = () => new Date(),
) {
  const envelope = event.payload as { command?: unknown },
    command = parseProductCommandMessageV1(envelope?.command ?? event.payload),
    binding = bindings.DEPLOYMENT_WORKFLOW_RUNTIME,
    attempts = createCoreDeploymentAttemptPort(binding),
    leased = withOperationLease(step, (durationMilliseconds) =>
      binding.renewProductOperationLease({
        organizationId: command.organizationId,
        operationId: command.operationId,
        workflowId: deterministicProductCommandWorkflowId(command),
        physicalWorkflowId: event.instanceId,
        now: now().toISOString(),
        durationMilliseconds,
      }),
    );
  return runDeploymentWorkflowEntrypoint(
    event,
    leased,
    createCoreDeploymentWorkflowPorts(bindings, now),
    (input) => activateDeploymentReconciliationAttempt(attempts, input),
    (input) => activateDeploymentReplayAttempt(attempts, input),
  );
}
