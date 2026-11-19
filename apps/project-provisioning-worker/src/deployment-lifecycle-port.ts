/* v8 ignore file -- fixed type-only lifecycle persistence contracts */
import type { ProductCommandWorkflowPorts, ProductCommandMessageV1 } from "@ohmyhost/orchestrator";
import type { OperationDataChangeResult, SharedGatewayReceipt } from "@ohmyhost/platform";

export type LifecycleCommand = Extract<
  ProductCommandMessageV1,
  {
    eventType:
      | "ProjectDeletionRequestedV1"
      | "ProjectDataChangeRequestedV1"
      | "ProjectHandleChangeRequestedV1";
  }
>;
type Complete = Parameters<ProductCommandWorkflowPorts["persistence"]["complete"]>[0];
export interface DeploymentLifecyclePort {
  complete(
    input: Omit<Complete, "command"> & { command: LifecycleCommand },
  ): ReturnType<ProductCommandWorkflowPorts["persistence"]["complete"]>;
  retainDeletionTombstone: ProductCommandWorkflowPorts["persistence"]["retainDeletionTombstone"];
}
export interface LifecycleIdentity {
  organizationId: string;
  projectId: string;
  environmentId: string;
  operationId: string;
  workflowId: string;
  outboxEventId: string;
  startedOperationEventId: string;
  operationEventId: string;
  auditEventId: string;
  completedAt: string;
  reconciliationAttemptId?: string;
  replayAttemptId?: string;
}
export type LifecycleGatewayAbsence = Omit<SharedGatewayReceipt, "observedAt"> & {
  observedAt: string;
};
export interface LifecycleDeletionEvidence {
  tombstoneReceiptId: string;
  inventoryClean: true;
  consecutive404s: number;
  gatewayAbsence: readonly (LifecycleGatewayAbsence | null)[];
}
export type LifecycleCompletionInput = LifecycleIdentity &
  (
    | {
        eventType: "ProjectDeletionRequestedV1";
        expectedEnvironmentHeads: readonly { environmentId: string; expectedHeadVersion: number }[];
        deletion: LifecycleDeletionEvidence;
      }
    | { eventType: "ProjectDataChangeRequestedV1"; dataChangeResult: OperationDataChangeResult }
    | { eventType: "ProjectHandleChangeRequestedV1" }
  );
export interface DeletionTombstoneInput {
  organizationId: string;
  projectId: string;
  environmentId: string;
  operationId: string;
  workflowId: string;
  outboxEventId: string;
  startedOperationEventId: string;
  recordedAt: string;
  tombstoneReceiptId: string;
}
/** Two fixed compounds; neither generic terminal JSON nor a caller-supplied mutation plan crosses this binding. */
export interface DeploymentLifecycleRuntimeBinding {
  completeProductLifecycleCommand(
    input: LifecycleCompletionInput,
  ): Promise<"completed" | "replayed">;
  retainProductDeletionTombstone(input: DeletionTombstoneInput): Promise<"created" | "existing">;
}
