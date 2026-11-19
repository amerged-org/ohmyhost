/* v8 ignore file -- exact rename parent group */
import type { ProductCommandWorkflowPorts } from "@ohmyhost/orchestrator";
export interface DeploymentHandlePort {
  finalizeHandleChange(
    input: Parameters<ProductCommandWorkflowPorts["persistence"]["finalizeHandleChange"]>[0],
  ): Promise<
    "applied" | "duplicate" | "pending" | { readonly status: "conflict"; readonly reason: "taken" }
  >;
}
export interface DeploymentHandleRuntimeInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly requestedHandle: string;
  readonly moved: readonly { readonly environmentId: string; readonly publicOrigin: string }[];
  readonly workflowId: string;
  readonly outboxEventId: string;
  readonly startedOperationEventId: string;
  readonly operationEventId: string;
  readonly auditEventId: string;
  readonly completedAt: string;
  readonly reconciliationAttemptId?: string;
  readonly replayAttemptId?: string;
}
export interface DeploymentHandleRuntimeBinding {
  finalizeProductHandleChange(
    input: DeploymentHandleRuntimeInput,
  ): Promise<
    "applied" | "duplicate" | "pending" | { readonly status: "conflict"; readonly reason: "taken" }
  >;
}
