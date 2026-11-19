import { forwardCalls } from "./core-binding-call.js";
import type {
  DeploymentAttemptPort,
  DeploymentAttemptRuntimeBinding,
} from "./deployment-attempt-port.js";
/** Fixed attempt identities cross the binding itself; no SQL/client/callback is sent. */
export function createCoreDeploymentAttemptPort(
  binding: DeploymentAttemptRuntimeBinding,
): DeploymentAttemptPort {
  return Object.freeze<DeploymentAttemptPort>(
    forwardCalls(binding, {
      activateReconciliation: "activateProductProviderReconciliationAttempt",
      activateReplay: "activateProductWorkflowReplayAttempt",
    }),
  );
}
