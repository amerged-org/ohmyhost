/* v8 ignore file -- fixed whole parent finalization groups */
import type {
  completeProductCommand,
  finalizeWfpCandidateDeployment,
  finalizeRollbackActivation,
  recordEnvironmentFunctionSchedule,
  assertProjectBindingRefreshSnapshot,
} from "@ohmyhost/database/provisioning-persistence";
type Completion = Parameters<typeof completeProductCommand>[1];
export type CandidateFinalization = {
  readonly eventType: "DeploymentRequestedV1" | "DeploymentPromotionRequestedV1";
  readonly publication: Parameters<typeof finalizeWfpCandidateDeployment>[1];
  readonly schedule: Parameters<typeof recordEnvironmentFunctionSchedule>[1];
  readonly bindingRefreshSnapshot:
    | Parameters<typeof assertProjectBindingRefreshSnapshot>[1]["snapshot"]
    | null;
  readonly completion: Extract<
    Completion,
    { eventType: "DeploymentRequestedV1" | "DeploymentPromotionRequestedV1" }
  > | null;
};
export type RollbackFinalization = {
  readonly activation: Parameters<typeof finalizeRollbackActivation>[1];
  readonly schedule: Parameters<typeof recordEnvironmentFunctionSchedule>[1];
  readonly completion: Extract<Completion, { eventType: "DeploymentRollbackRequestedV1" }>;
};
export interface DeploymentFinalizationPort {
  assertBindingRefresh(
    input: Parameters<typeof assertProjectBindingRefreshSnapshot>[1],
  ): Promise<void>;
  finishBindingRefresh(
    input: Extract<Completion, { eventType: "DeploymentRequestedV1" }>,
  ): Promise<"completed" | "replayed" | "native_policy_pending">;
  finalizeCandidate(input: CandidateFinalization): Promise<void>;
  finalizeRollback(input: RollbackFinalization): Promise<void>;
}
export interface FinalizationCompletionIdentity {
  readonly workflowId: string;
  readonly outboxEventId: string;
  readonly startedOperationEventId: string;
  readonly operationEventId: string;
  readonly auditEventId: string;
  readonly reconciliationAttemptId?: string;
  readonly replayAttemptId?: string;
  readonly acceptedLifecycleVersion: number;
}
export interface CoreCandidateFinalizationInput {
  readonly bindingRefreshSnapshot: CandidateFinalization["bindingRefreshSnapshot"];
  readonly eventType: CandidateFinalization["eventType"];
  readonly publication: CandidateFinalization["publication"];
  readonly schedule: {
    readonly crons: readonly string[];
    readonly egressAllowedOrigins: readonly string[];
  };
  readonly completion:
    | (FinalizationCompletionIdentity & {
        readonly runtimePolicy: unknown;
        readonly result: unknown;
      })
    | null;
}
export interface CoreRollbackFinalizationInput {
  readonly activation: RollbackFinalization["activation"];
  readonly schedule: {
    readonly crons: readonly string[];
    readonly egressAllowedOrigins: readonly string[];
  };
  readonly completion: FinalizationCompletionIdentity & { readonly runtimePolicy: unknown };
}
export interface DeploymentFinalizationRuntimeBinding {
  assertProductBindingRefresh(
    input: Parameters<typeof assertProjectBindingRefreshSnapshot>[1],
  ): Promise<void>;
  finishProductBindingRefresh(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly operationId: string;
    readonly completedAt: string;
    readonly completion: FinalizationCompletionIdentity & {
      readonly runtimePolicy: unknown;
      readonly result: unknown;
    };
  }): Promise<"completed" | "replayed" | "native_policy_pending">;
  finalizeProductCandidate(input: CoreCandidateFinalizationInput): Promise<void>;
  finalizeProductRollback(input: CoreRollbackFinalizationInput): Promise<void>;
}
