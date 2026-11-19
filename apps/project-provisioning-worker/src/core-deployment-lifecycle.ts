import { parseOperationDataChangeResult, parseSharedGatewayReceipt } from "@ohmyhost/platform";
import type {
  ProductWorkflowContext,
  ProductWorkflowDeletionEnvironment,
} from "@ohmyhost/database/provisioning-persistence";
import type { ProductCommandMessageV1 as Command } from "@ohmyhost/orchestrator";
import { callBinding } from "./core-binding-call.js";
import type { DeploymentPersistenceReaderPort } from "./deployment-persistence-port.js";
import type {
  DeploymentLifecyclePort,
  DeploymentLifecycleRuntimeBinding,
  LifecycleIdentity,
  LifecycleDeletionEvidence,
} from "./deployment-lifecycle-port.js";
import { completionCommon, derivedIds, canonicalDate } from "./workflow-identities.js";
import { requireWorkflowCommandContext } from "./workflow-context-reader.js";

function requireDeletionEnvironments(
  context: Pick<ProductWorkflowContext, "deletionEnvironments">,
): readonly ProductWorkflowDeletionEnvironment[] {
  const environments = context.deletionEnvironments;
  if (
    environments.length === 0 ||
    environments.at(-1)?.environmentName !== "prod" ||
    environments.slice(0, -1).some((environment) => environment.environmentName !== "dev") ||
    new Set(environments.map((environment) => environment.environmentId)).size !==
      environments.length
  )
    throw new Error("Deletion Workflow requires unique dev environments followed by prod");
  return environments;
}
/** Exact original parent parser, kept local so no generic terminal object becomes an RPC capability. */
function parseDeletionEvidence(
  value: Readonly<Record<string, unknown>>,
  command: Extract<Command, { eventType: "ProjectDeletionRequestedV1" }>,
  context: ProductWorkflowContext,
): LifecycleDeletionEvidence {
  if (
    typeof value["tombstoneReceiptId"] !== "string" ||
    value["inventoryClean"] !== true ||
    !Number.isSafeInteger(value["consecutive404s"]) ||
    Number(value["consecutive404s"]) < 3
  )
    throw new TypeError("Deletion evidence is invalid");
  const environments = requireDeletionEnvironments(context),
    raw = value["gatewayAbsence"];
  if (!Array.isArray(raw) || raw.length !== environments.length)
    throw new TypeError("Deletion evidence is invalid");
  return {
    tombstoneReceiptId: value["tombstoneReceiptId"],
    inventoryClean: true,
    consecutive404s: Number(value["consecutive404s"]),
    gatewayAbsence: raw.map((absence, index) => {
      if (absence === null) return null;
      const environment = environments[index];
      if (environment === undefined) throw new TypeError("Deletion evidence is invalid");
      const receipt = parseSharedGatewayReceipt(absence);
      if (
        receipt.organizationId !== command.organizationId ||
        receipt.projectId !== command.projectId ||
        receipt.environmentId !== environment.environmentId ||
        receipt.environmentName !== environment.environmentName ||
        receipt.handle !== context.handle ||
        receipt.active
      )
        throw new TypeError("Shared gateway absence receipt is invalid");
      return Object.freeze({ ...receipt, observedAt: receipt.observedAt.toISOString() });
    }),
  };
}
/** Handle-change, data-change and deletion completion: each group crosses one named Core call. */
export function createCoreDeploymentLifecyclePort(
  binding: DeploymentLifecycleRuntimeBinding,
  readers: Pick<DeploymentPersistenceReaderPort, "readContext">,
  now: () => Date,
): DeploymentLifecyclePort {
  const context = async (command: Command) =>
    requireWorkflowCommandContext(
      await readers.readContext({
        organizationId: command.organizationId,
        projectId: command.projectId,
        environmentId: command.environmentId,
        operationId: command.operationId,
      }),
      command,
    );
  return Object.freeze<DeploymentLifecyclePort>({
    complete: async ({ workflowId, executionId, command, evidence }) => {
      const current = await context(command),
        common = await completionCommon(workflowId, executionId, command, now),
        identity: LifecycleIdentity = {
          organizationId: command.organizationId,
          projectId: command.projectId,
          environmentId: command.environmentId,
          operationId: command.operationId,
          workflowId,
          outboxEventId: command.eventId,
          startedOperationEventId: common.startedOperationEventId,
          operationEventId: common.operationEventId,
          auditEventId: common.auditEventId,
          completedAt: common.completedAt,
          ...(common.reconciliationAttemptId === undefined
            ? {}
            : { reconciliationAttemptId: common.reconciliationAttemptId }),
          ...(common.replayAttemptId === undefined
            ? {}
            : { replayAttemptId: common.replayAttemptId }),
        };
      const input =
        command.eventType === "ProjectDeletionRequestedV1"
          ? {
              ...identity,
              eventType: command.eventType,
              expectedEnvironmentHeads: requireDeletionEnvironments(current).map((environment) => ({
                environmentId: environment.environmentId,
                expectedHeadVersion: environment.headVersion,
              })),
              deletion: parseDeletionEvidence(evidence, command, current),
            }
          : command.eventType === "ProjectDataChangeRequestedV1"
            ? {
                ...identity,
                eventType: command.eventType,
                dataChangeResult: parseOperationDataChangeResult(evidence),
              }
            : { ...identity, eventType: command.eventType };
      const result = await callBinding(binding, "completeProductLifecycleCommand", input);
      if (result !== "completed" && result !== "replayed")
        throw new TypeError("Lifecycle completion response is invalid");
      return result === "replayed" ? "duplicate" : "applied";
    },
    retainDeletionTombstone: async ({ workflowId, executionId, command, tombstoneReceiptId }) => {
      await context(command);
      const ids = await derivedIds(executionId),
        result = await callBinding(binding, "retainProductDeletionTombstone", {
          organizationId: command.organizationId,
          projectId: command.projectId,
          environmentId: command.environmentId,
          operationId: command.operationId,
          workflowId,
          outboxEventId: command.eventId,
          startedOperationEventId: ids.startedOperationEventId,
          recordedAt: canonicalDate(now),
          tombstoneReceiptId,
        });
      if (result !== "created" && result !== "existing")
        throw new TypeError("Deletion tombstone response is invalid");
      return result === "existing" ? "duplicate" : "applied";
    },
  });
}
