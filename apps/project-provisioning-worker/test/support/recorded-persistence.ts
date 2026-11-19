import { parseUlid } from "@ohmyhost/platform";
import { vi } from "vitest";
import {
  activateProductProviderReconciliationAttempt,
  activateProductWorkflowReplayAttempt,
  assertOperationExecutionAuthorized,
  assertProjectBindingRefreshSnapshot,
  authorizeGithubPushActivation,
  authorizeWfpCandidateActivation,
  claimPendingWfpCandidateCleanup,
  claimProductProviderMutation,
  completeProductCommand,
  deleteProjectFunctionSchedules,
  failProductDeploymentCommand,
  finalizeRollbackActivation,
  finalizeWfpCandidateDeployment,
  lockProductCommandOperationTransaction,
  markCandidateSuperseded,
  observeSourceArchiveReceipt,
  prepareCandidateCleanup,
  readCandidateCleanupResources,
  readManagedSourceDeletionInventory,
  readProductWorkflowContext,
  readProductWorkflowDatabaseTarget,
  readProjectDataEnvironment,
  readRollbackPlanTarget,
  readWfpProjectDeletionEvidence,
  recordAbandonedGatewayPredecessor,
  recordCleanupAttempt,
  recordEnvironmentFunctionSchedule,
  recordProductDeploymentEvidence,
  recordProductSourceArchiveEvidence,
  recordRuntimeHealthDiagnostic,
  recordWfpCandidateCleanupReceipt,
  recordWfpCandidateOperationCleanupReceipt,
  recordWfpCandidateReceipt,
  resolveRollbackCandidate,
  settleSharedGatewayCandidateCleanup,
  startProjectDataChangeCleanup,
  appendAuditedProjectDataChangeAssignments,
} from "@ohmyhost/database/provisioning-persistence";

import { createCoreDeploymentAuthorizationPort } from "../../src/core-deployment-authorization.js";
import { createCoreDeploymentFinalizationPort } from "../../src/core-deployment-finalization.js";
import type { DeploymentAttemptPort } from "../../src/deployment-attempt-port.js";
import type { DeploymentAuthorizationScope } from "../../src/deployment-authorization-port.js";
import type { DeploymentWorkflowDataPorts } from "../../src/deployment-workflow-data-ports.js";
import { requireWorkflowCommandContext } from "../../src/workflow-context-reader.js";
import {
  completionCommon,
  reconciliationAttempt,
  canonicalDate,
} from "../../src/workflow-identities.js";
import { deterministicUlid } from "../../src/deterministic-ulid.js";
import { sourceLinkEvidence } from "../../src/source-link-evidence.js";

/**
 * The Core binding accepts only its closed key sets; a wider object reaching a persistence function is a defect
 * of the port that sent it, so the recorder refuses it instead of letting the legacy functions ignore it.
 */
function closedKeys<T extends object>(keys: readonly string[]): (input: T) => T {
  return (input) => {
    for (const key of Object.keys(input))
      if (!keys.includes(key)) throw new TypeError(`Core binding input carries ${key}`);
    return input;
  };
}
type RefreshInput = Parameters<typeof assertProjectBindingRefreshSnapshot>[1];
const closedScope = closedKeys<DeploymentAuthorizationScope>([
  "organizationId",
  "projectId",
  "operationId",
]);
const closedActivation = closedKeys<
  DeploymentAuthorizationScope & {
    candidateReceiptId?: DeploymentAuthorizationScope["operationId"];
  }
>(["organizationId", "projectId", "operationId", "candidateReceiptId"]);
const closedRefresh = closedKeys<RefreshInput>([
  "organizationId",
  "projectId",
  "environmentId",
  "operationId",
  "snapshot",
  "allowPublished",
]);

/**
 * The persistence functions are recorded by the test file's module mock; each port forwards to them
 * with a placeholder client, so the tests observe exactly which persistence calls a port method makes.
 */
const client = {} as never;

/** Recorders for the lifecycle groups, whose persistence is judged by the Core's own tests. */
export const nextCacheRetirementRecorders = {
  list: vi.fn(
    async (): Promise<{
      scopes: { environmentId: string; deploymentId: string }[];
      nextCursor: string | null;
    } | null> => ({ scopes: [], nextCursor: null }),
  ),
  record: vi.fn(async (): Promise<"recorded" | "existing" | null> => "recorded"),
};
export const lifecycleRecorders = {
  complete: vi.fn(async (): Promise<"applied" | "duplicate"> => "applied"),
  retainDeletionTombstone: vi.fn(async (): Promise<"applied" | "duplicate"> => "applied"),
  finalizeHandleChange: vi.fn(
    async (): Promise<
      | "applied"
      | "duplicate"
      | "pending"
      | { readonly status: "conflict"; readonly reason: "taken" }
    > => "applied",
  ),
  requireReconciliation: vi.fn(async (): Promise<"applied" | "duplicate"> => "applied"),
};

async function refusedGroup(): Promise<never> {
  throw new Error("recorded finalization uses its own groups");
}

export function recordedAttempts(): DeploymentAttemptPort {
  return {
    activateReconciliation: (input) => activateProductProviderReconciliationAttempt(client, input),
    activateReplay: (input) => activateProductWorkflowReplayAttempt(client, input),
  };
}

export function createRecordedDataPorts(now: () => Date): DeploymentWorkflowDataPorts {
  return {
    readers: {
      readContext: (input) =>
        readProductWorkflowContext(client, {
          ...input,
          organizationId: parseUlid(input.organizationId),
          projectId: parseUlid(input.projectId),
          environmentId: parseUlid(input.environmentId),
          operationId: parseUlid(input.operationId),
        }),
      readDatabaseTarget: (input) => readProductWorkflowDatabaseTarget(client, input),
      claimProviderMutation: (input) => claimProductProviderMutation(client, input),
    },
    terminals: {
      fail: async ({ workflowId, executionId, command, errorCode, failure, health, migration }) => {
        requireWorkflowCommandContext(
          await readProductWorkflowContext(client, command),
          command,
          true,
        );
        const common = await completionCommon(workflowId, executionId, command, now);
        const result = await failProductDeploymentCommand(client, {
          failure: failure ?? null,
          health: health ?? null,
          migration: migration ?? null,
          workflowId,
          ...reconciliationAttempt(workflowId, executionId),
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
        requireWorkflowCommandContext(await readProductWorkflowContext(client, command), command);
        const result = await recordRuntimeHealthDiagnostic(client, {
          workflowId,
          ...reconciliationAttempt(workflowId, executionId),
          organizationId: command.organizationId,
          projectId: command.projectId,
          environmentId: command.environmentId,
          operationId: command.operationId,
          outboxEventId: command.eventId,
          diagnosticEventId: await deterministicUlid(`${executionId}:runtime-health-diagnostic`),
          health,
          recordedAt: canonicalDate(now),
        });
        return result === "created" ? "applied" : "duplicate";
      },
    },
    custody: {
      recordArchive: (input) => recordProductSourceArchiveEvidence(client, input),
      observeArchive: (input) => observeSourceArchiveReceipt(client, input),
    },
    sourceCompletion: {
      complete: async ({ workflowId, executionId, command, evidence }) => {
        const context = requireWorkflowCommandContext(
            await readProductWorkflowContext(client, command),
            command,
          ),
          common = await completionCommon(workflowId, executionId, command, now),
          link = sourceLinkEvidence(evidence);
        const result = await completeProductCommand(client, {
          ...common,
          terminalEvidence: { externalRepositoryId: link.externalRepositoryId },
          eventType: command.eventType,
          sourceConnectionId: common.operationId,
          sourceId: common.operationId,
          grantId: common.operationId,
          externalRepositoryId: link.externalRepositoryId,
          grantedAt: context.acceptedAt,
        });
        return result === "replayed" ? "duplicate" : "applied";
      },
    },
    // The real adapters narrow the whole command; the recorder sees only what the Core binding receives.
    authorization: createCoreDeploymentAuthorizationPort({
      assertProductOperationExecution: (input) =>
        assertOperationExecutionAuthorized(client, closedScope(input)),
      authorizeProductActivation: async (raw) => {
        const input = closedActivation(raw);
        return input.candidateReceiptId === undefined
          ? (await authorizeGithubPushActivation(client, input))
            ? { allowed: true }
            : { allowed: false, supersededById: input.operationId }
          : authorizeWfpCandidateActivation(client, {
              ...input,
              candidateReceiptId: input.candidateReceiptId,
            });
      },
    }),
    finalization: {
      // Only the refresh assertion is taken from the real adapter; the other groups are recorded below.
      assertBindingRefresh: createCoreDeploymentFinalizationPort({
        assertProductBindingRefresh: (input) =>
          assertProjectBindingRefreshSnapshot(client, closedRefresh(input)),
        finishProductBindingRefresh: refusedGroup,
        finalizeProductCandidate: refusedGroup,
        finalizeProductRollback: refusedGroup,
      }).assertBindingRefresh,
      finishBindingRefresh: (input) => completeProductCommand(client, input),
      finalizeCandidate: async (input) => {
        if (input.eventType === "DeploymentRequestedV1")
          await lockProductCommandOperationTransaction(client, {
            organizationId: input.publication.organizationId,
            operationId: input.publication.operationId,
          });
        if (input.bindingRefreshSnapshot !== null)
          await assertProjectBindingRefreshSnapshot(client, {
            ...input.publication,
            snapshot: input.bindingRefreshSnapshot,
            allowPublished: true,
          });
        await finalizeWfpCandidateDeployment(client, input.publication);
        await recordEnvironmentFunctionSchedule(client, input.schedule);
        if (input.completion !== null) await completeProductCommand(client, input.completion);
      },
      finalizeRollback: async (input) => {
        await finalizeRollbackActivation(client, input.activation);
        await recordEnvironmentFunctionSchedule(client, input.schedule);
        await completeProductCommand(client, input.completion);
      },
    },
    cleanup: {
      prepare: (input) => prepareCandidateCleanup(client, input),
      claim: (input) => claimPendingWfpCandidateCleanup(client, input),
      supersede: (input) => markCandidateSuperseded(client, input),
      record: async (input) => {
        const gateway =
            input.gateway ??
            (await settleSharedGatewayCandidateCleanup(client, {
              organizationId: input.receipt.organizationId,
              projectId: input.receipt.projectId,
              candidateReceiptId: input.receipt.candidateReceiptId,
              claimId: input.receipt.claimId,
            })),
          result = await recordWfpCandidateCleanupReceipt(client, { ...input.receipt, ...gateway });
        for (const resource of input.resources)
          await recordWfpCandidateOperationCleanupReceipt(client, resource);
        return result;
      },
    },
    candidate: {
      recordCandidate: async (input) => {
        if (input.eventType === "DeploymentRequestedV1")
          await lockProductCommandOperationTransaction(client, {
            organizationId: input.candidate.organizationId,
            operationId: input.candidate.operationId,
          });
        if (input.deploymentEvidence !== null)
          await recordProductDeploymentEvidence(client, input.deploymentEvidence);
        return recordWfpCandidateReceipt(client, input.candidate);
      },
      recordAbandonedGateway: (input) => recordAbandonedGatewayPredecessor(client, input),
      readDataEnvironment: (input) => readProjectDataEnvironment(client, input),
      resolveRollback: (input) => resolveRollbackCandidate(client, input),
    },
    inventory: {
      listNextCacheRetirementScopes: nextCacheRetirementRecorders.list,
      recordNextCacheRetired: nextCacheRetirementRecorders.record,
      readManagedSourceInventory: (input) => readManagedSourceDeletionInventory(client, input),
      readDeletionEvidence: (input) => readWfpProjectDeletionEvidence(client, input),
      readCleanupResources: (input) => readCandidateCleanupResources(client, input),
      recordCleanupAttempt: (input) => recordCleanupAttempt(client, input),
      startDataChange: (input) => startProjectDataChangeCleanup(client, input),
      switchAssignments: (input) => appendAuditedProjectDataChangeAssignments(client, input),
      deleteSchedules: (input) => deleteProjectFunctionSchedules(client, input),
    },
    rollbackData: {
      readRollbackDataTarget: (input) => readRollbackPlanTarget(client, input),
    },
    lifecycle: {
      complete: lifecycleRecorders.complete,
      retainDeletionTombstone: lifecycleRecorders.retainDeletionTombstone,
    },
    handle: { finalizeHandleChange: lifecycleRecorders.finalizeHandleChange },
    reconciliation: { requireReconciliation: lifecycleRecorders.requireReconciliation },
  };
}
