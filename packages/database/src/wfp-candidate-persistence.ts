import { type Ulid, type SharedGatewayReceipt } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export interface WfpCandidateReceipt {
  readonly candidateReceiptId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly productDeploymentId: Ulid;
  readonly artifactId: Ulid;
  readonly namespace: string;
  readonly immutableScriptName: string;
  readonly artifactDigest: Uint8Array;
  readonly bindingSetDigest?: Uint8Array;
  readonly providerTag: string;
  readonly buildReused: boolean;
  readonly stagedAt: string;
}

export interface WfpCandidateCleanupClaim {
  readonly candidateReceiptId: Ulid;
  readonly claimId: Ulid;
  readonly attemptNumber: number;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
  readonly candidate: WfpCandidateReceipt;
  readonly expectedResources: readonly {
    readonly provider: "cloudflare";
    readonly resourceKind: "source-archive" | "build-artifact";
    readonly resourceIdentityDigest: Uint8Array;
  }[];
}

export type WfpCandidateActivationAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly supersededById: Ulid };

export declare function authorizeWfpCandidateActivation(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly candidateReceiptId: Ulid;
  },
): Promise<WfpCandidateActivationAuthorization>;

export declare function recordWfpCandidateReceipt(
  client: TransactionClient,
  input: WfpCandidateReceipt,
): Promise<"created" | "existing">;

export declare function claimPendingWfpCandidateCleanup(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly candidateReceiptId?: Ulid;
    readonly claimId: Ulid;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  },
): Promise<WfpCandidateCleanupClaim | null>;

export declare function prepareCandidateCleanup(
  client: TransactionClient,
  input: {
    readonly cleanupRequestId: Ulid;
    readonly candidate: WfpCandidateReceipt;
    readonly reason: "superseded" | "failed" | "compensate";
    readonly supersededById?: Ulid;
    readonly requestedAt: string;
    readonly claimId: Ulid;
    readonly leaseExpiresAt: string;
  },
): Promise<WfpCandidateCleanupClaim>;

export declare function recordWfpCandidateCleanupReceipt(
  client: TransactionClient,
  input: {
    readonly cleanupReceiptId: Ulid;
    readonly candidateReceiptId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly claimId: Ulid;
    readonly outcome: "removed" | "not_found";
    readonly compensatedTargetScriptName: string | null;
    readonly sharedGatewayRevision: number | null;
    readonly observedProviderTag: string;
    readonly observedAt: string;
  },
): Promise<"created" | "existing">;

export declare function recordWfpCandidateOperationCleanupReceipt(
  client: TransactionClient,
  input: {
    readonly operationCleanupReceiptId: Ulid;
    readonly candidateReceiptId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly provider: "cloudflare";
    readonly resourceKind: "source-archive" | "build-artifact";
    readonly resourceIdentityDigest: Uint8Array;
    readonly outcome: "removed" | "not_found";
    readonly observedAt: string;
  },
): Promise<"created" | "existing">;

export declare function markCandidateSuperseded(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly candidateReceiptId: Ulid;
    readonly cleanupReceiptId: Ulid;
    readonly supersededById: Ulid;
    readonly terminalAt: string;
  },
): Promise<"superseded" | "existing" | "not_linked">;

export interface ResolvedWfpRollbackCandidate {
  readonly targetDeploymentId: Ulid;
  readonly targetRevisionId: Ulid;
  readonly wfpReceiptId: Ulid;
  readonly deploymentUrl: string;
  readonly gateway: SharedGatewayReceipt;
  readonly candidate: WfpCandidateReceipt;
}

export interface WfpDeletionEvidence {
  readonly candidates: readonly WfpCandidateReceipt[];
  readonly activeGateways: readonly SharedGatewayReceipt[];
}

export declare function readWfpProjectDeletionEvidence(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
  },
): Promise<WfpDeletionEvidence>;

export declare function resolveRollbackCandidate(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly targetDeploymentId: Ulid;
    readonly targetRevisionId: Ulid;
  },
): Promise<ResolvedWfpRollbackCandidate | null>;

export declare function finalizeRollbackActivation(
  client: TransactionClient,
  input: {
    readonly rollbackActivationReceiptId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly rollbackDeploymentId: Ulid;
    readonly targetDeploymentId: Ulid;
    readonly targetRevisionId: Ulid;
    readonly candidateReceiptId: Ulid;
    readonly wfpReceiptId: Ulid;
    readonly gateway: Parameters<typeof finalizeWfpCandidateDeployment>[1]["gateway"];
    readonly expectedHeadVersion: number;
    readonly completedAt: string;
  },
): Promise<{
  readonly headVersion: number;
}>;

export declare function finalizeWfpCandidateDeployment(
  client: TransactionClient,
  input: {
    readonly candidateReceiptId: Ulid;
    readonly wfpReceiptId: Ulid;
    readonly revisionId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly productDeploymentId: Ulid;
    readonly expectedHeadVersion: number;
    readonly deploymentUrl: string;
    readonly publishedAt: string;
    readonly gateway: SharedGatewayReceipt;
  },
): Promise<{
  readonly headVersion: number;
}>;
