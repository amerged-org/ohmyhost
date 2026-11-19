/* v8 ignore file -- exact original candidate persistence contracts only */
import type {
  recordWfpCandidateReceipt,
  recordProductDeploymentEvidence,
  recordAbandonedGatewayPredecessor,
  readProjectDataEnvironment,
  resolveRollbackCandidate,
} from "@ohmyhost/database/provisioning-persistence";
export interface DeploymentCandidateRecord {
  readonly eventType:
    | "DeploymentRequestedV1"
    | "DeploymentPromotionRequestedV1"
    | "DeploymentRollbackRequestedV1";
  readonly candidate: Parameters<typeof recordWfpCandidateReceipt>[1];
  readonly deploymentEvidence: Parameters<typeof recordProductDeploymentEvidence>[1] | null;
}
export interface DeploymentCandidatePort {
  recordCandidate(input: DeploymentCandidateRecord): ReturnType<typeof recordWfpCandidateReceipt>;
  recordAbandonedGateway(
    input: Parameters<typeof recordAbandonedGatewayPredecessor>[1],
  ): ReturnType<typeof recordAbandonedGatewayPredecessor>;
  readDataEnvironment(
    input: Parameters<typeof readProjectDataEnvironment>[1],
  ): ReturnType<typeof readProjectDataEnvironment>;
  resolveRollback(
    input: Parameters<typeof resolveRollbackCandidate>[1],
  ): ReturnType<typeof resolveRollbackCandidate>;
}
/** These methods extend the existing DEPLOYMENT_WORKFLOW_RUNTIME capability; no new SQL or provider binding. */
export interface DeploymentCandidateRuntimeBinding {
  recordProductDeploymentCandidate(
    input: DeploymentCandidateRecord,
  ): ReturnType<DeploymentCandidatePort["recordCandidate"]>;
  recordAbandonedGatewayPredecessor(
    input: Parameters<DeploymentCandidatePort["recordAbandonedGateway"]>[0],
  ): ReturnType<DeploymentCandidatePort["recordAbandonedGateway"]>;
  readProductDataEnvironment(
    input: Parameters<DeploymentCandidatePort["readDataEnvironment"]>[0],
  ): ReturnType<DeploymentCandidatePort["readDataEnvironment"]>;
  resolveProductRollbackCandidate(
    input: Parameters<DeploymentCandidatePort["resolveRollback"]>[0],
  ): ReturnType<DeploymentCandidatePort["resolveRollback"]>;
}
