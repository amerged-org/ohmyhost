import { forwardCalls } from "./core-binding-call.js";
import type {
  DeploymentCleanupPort,
  DeploymentCleanupRuntimeBinding,
} from "./deployment-cleanup-port.js";
export function createCoreDeploymentCleanupPort(
  binding: DeploymentCleanupRuntimeBinding,
): DeploymentCleanupPort {
  return Object.freeze<DeploymentCleanupPort>(
    forwardCalls(binding, {
      prepare: "prepareProductCandidateCleanup",
      claim: "claimProductCandidateCleanup",
      record: "recordProductCandidateCleanup",
      supersede: "markProductCandidateSuperseded",
    }),
  );
}
