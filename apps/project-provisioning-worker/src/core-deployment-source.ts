import { forwardCalls } from "./core-binding-call.js";
import type {
  DeploymentSourceCustodyPort,
  DeploymentSourceRuntimeBinding,
} from "./deployment-source-port.js";
/** Only named custody effects/readback cross the service boundary; no provider operation is performed. */
export function createCoreDeploymentSourcePort(
  binding: DeploymentSourceRuntimeBinding,
): DeploymentSourceCustodyPort {
  return Object.freeze<DeploymentSourceCustodyPort>(
    forwardCalls(binding, {
      recordArchive: "recordProductSourceArchiveEvidence",
      observeArchive: "observeSourceArchiveReceipt",
    }),
  );
}
