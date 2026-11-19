/* v8 ignore file -- closed original Source custody types only */
import type {
  recordProductSourceArchiveEvidence,
  observeSourceArchiveReceipt,
} from "@ohmyhost/database/provisioning-persistence";
export interface DeploymentSourceCustodyPort {
  recordArchive(
    input: Parameters<typeof recordProductSourceArchiveEvidence>[1],
  ): ReturnType<typeof recordProductSourceArchiveEvidence>;
  observeArchive(
    input: Parameters<typeof observeSourceArchiveReceipt>[1],
  ): ReturnType<typeof observeSourceArchiveReceipt>;
}
export interface DeploymentSourceRuntimeBinding {
  recordProductSourceArchiveEvidence(
    input: Parameters<DeploymentSourceCustodyPort["recordArchive"]>[0],
  ): ReturnType<DeploymentSourceCustodyPort["recordArchive"]>;
  observeSourceArchiveReceipt(
    input: Parameters<DeploymentSourceCustodyPort["observeArchive"]>[0],
  ): ReturnType<DeploymentSourceCustodyPort["observeArchive"]>;
}
