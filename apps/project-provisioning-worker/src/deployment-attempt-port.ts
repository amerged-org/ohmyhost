/* v8 ignore file -- original closed attempt activation contracts only */
import type {
  activateProductProviderReconciliationAttempt,
  activateProductWorkflowReplayAttempt,
} from "@ohmyhost/database/provisioning-persistence";
export interface DeploymentAttemptPort {
  activateReconciliation(
    input: Parameters<typeof activateProductProviderReconciliationAttempt>[1],
  ): ReturnType<typeof activateProductProviderReconciliationAttempt>;
  activateReplay(
    input: Parameters<typeof activateProductWorkflowReplayAttempt>[1],
  ): ReturnType<typeof activateProductWorkflowReplayAttempt>;
}
export interface DeploymentAttemptRuntimeBinding {
  activateProductProviderReconciliationAttempt(
    input: Parameters<DeploymentAttemptPort["activateReconciliation"]>[0],
  ): ReturnType<DeploymentAttemptPort["activateReconciliation"]>;
  activateProductWorkflowReplayAttempt(
    input: Parameters<DeploymentAttemptPort["activateReplay"]>[0],
  ): ReturnType<DeploymentAttemptPort["activateReplay"]>;
}
