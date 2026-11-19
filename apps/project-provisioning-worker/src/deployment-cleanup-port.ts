/* v8 ignore file -- fixed candidate cleanup groups */
import type {
  prepareCandidateCleanup,
  claimPendingWfpCandidateCleanup,
  recordWfpCandidateCleanupReceipt,
  recordWfpCandidateOperationCleanupReceipt,
  markCandidateSuperseded,
} from "@ohmyhost/database/provisioning-persistence";
export interface CandidateCleanupRecord {
  readonly receipt: Omit<
    Parameters<typeof recordWfpCandidateCleanupReceipt>[1],
    "compensatedTargetScriptName" | "sharedGatewayRevision"
  >;
  readonly gateway: {
    readonly compensatedTargetScriptName: string | null;
    readonly sharedGatewayRevision: number | null;
  } | null;
  readonly resources: readonly Parameters<typeof recordWfpCandidateOperationCleanupReceipt>[1][];
}
export interface DeploymentCleanupPort {
  prepare(
    input: Parameters<typeof prepareCandidateCleanup>[1],
  ): ReturnType<typeof prepareCandidateCleanup>;
  claim(
    input: Parameters<typeof claimPendingWfpCandidateCleanup>[1],
  ): ReturnType<typeof claimPendingWfpCandidateCleanup>;
  record(input: CandidateCleanupRecord): ReturnType<typeof recordWfpCandidateCleanupReceipt>;
  supersede(
    input: Parameters<typeof markCandidateSuperseded>[1],
  ): ReturnType<typeof markCandidateSuperseded>;
}
export interface DeploymentCleanupRuntimeBinding {
  prepareProductCandidateCleanup(
    input: Parameters<DeploymentCleanupPort["prepare"]>[0],
  ): ReturnType<DeploymentCleanupPort["prepare"]>;
  claimProductCandidateCleanup(
    input: Parameters<DeploymentCleanupPort["claim"]>[0],
  ): ReturnType<DeploymentCleanupPort["claim"]>;
  recordProductCandidateCleanup(
    input: CandidateCleanupRecord,
  ): ReturnType<DeploymentCleanupPort["record"]>;
  markProductCandidateSuperseded(
    input: Parameters<DeploymentCleanupPort["supersede"]>[0],
  ): ReturnType<DeploymentCleanupPort["supersede"]>;
}
