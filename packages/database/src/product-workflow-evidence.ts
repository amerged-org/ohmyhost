import {
  type HostingRegion,
  type ProductionFrameworkPlan,
  type Ulid,
  type SharedGatewayReceipt,
} from "@ohmyhost/platform";
import { readActiveSourceGrant } from "./product-surface-queries.js";
import {
  type ProductProviderResourceState,
  type ProductProviderReconciliationHint,
  type ProductProviderMutationEvent,
  type ProductCommandIntent,
} from "./product-command-persistence.js";
import { type ProjectR2BucketReceipt } from "./project-r2-bucket.js";
import { type PersistedNeonPlacementReceipt } from "./neon-project-placement.js";
import { type ProjectDeletionInventoryRecord } from "./project-deletion-inventory.js";
import type { TransactionClient } from "./transaction.js";
import type { AnyProjectDatabaseRegistrationMetadata } from "./pgcf-database-registration.js";

export interface ProductWorkflowProviderScope {
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
}

export interface ProductWorkflowWfpReceipt {
  readonly provider: "cloudflare-wfp";
  readonly namespace: string;
  readonly scriptName: string;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly productDeploymentId: Ulid;
  readonly providerTag: string;
  readonly artifactDigest: string;
  readonly bindingSetDigest?: string;
  readonly buildReused: boolean;
  readonly deployedAt: string;
}

export interface ProductAbandonedWfpTarget {
  readonly candidateReceiptId: Ulid;
  readonly operationId: Ulid;
  readonly candidate: ProductWorkflowWfpReceipt;
  readonly runtimePolicy: ProductionFrameworkPlan["runtimePolicy"];
}

export type ProductWorkflowGatewayReceipt = Omit<SharedGatewayReceipt, "observedAt"> & {
  readonly observedAt: string;
};

export interface ProductWorkflowArtifactExpectation {
  readonly receipt: {
    readonly buildId: string;
    readonly projectName: string;
    readonly scope: ProductWorkflowProviderScope;
  };
  readonly deploymentId: Ulid;
  readonly commitSha: string;
  readonly sourceSha256: string;
  readonly buildPlanSha256: string;
  readonly frameworkPlan: ProductionFrameworkPlan;
  readonly output: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
    readonly scope: ProductWorkflowProviderScope;
  };
}

export interface ProductWorkflowDeletionEnvironment {
  readonly environmentId: Ulid;
  readonly environmentName: "dev" | "prod";
  readonly headVersion: number;
  readonly activeDeploymentId: Ulid | null;
  readonly activeRevisionId: Ulid | null;
  readonly activeDeployment: ProductWorkflowWfpReceipt | null;
  readonly activeGateway: ProductWorkflowGatewayReceipt | null;
  /** The policy the active deployment was activated with; a rename re-publishes with the same one. */
  readonly activeRuntimePolicy: ProductionFrameworkPlan["runtimePolicy"] | null;
  readonly wfpDeployments: readonly ProductWorkflowWfpReceipt[];
  readonly environmentSecretCount: number;
  readonly artifactExpectations: readonly ProductWorkflowArtifactExpectation[];
  readonly sourceArchives: readonly ProductWorkflowSourceArchive[];
  readonly r2Bucket: ProjectR2BucketReceipt | null;
  readonly deletionBuildArtifacts: readonly ProductWorkflowDeletionBuildArtifact[];
}

export interface ProductWorkflowDeletionDataEnvironment {
  readonly dataEnvironmentId: Ulid;
  readonly neonPlacement: PersistedNeonPlacementReceipt | null;
  /** Present on persisted contexts; omitted only by legacy workflow fixtures. */
  readonly providerTarget?: WorkflowDatabaseProviderTarget | null;
  readonly databaseRegistration: WorkflowDatabaseRegistration | null;
}

export type WorkflowDatabaseProviderTarget = Readonly<{
  organizationId: string;
  projectId: string;
  physicalEnvironmentId: string;
  providerProjectId: string;
  targetVersion: number;
  state: "active" | "retired";
}> &
  (
    | Readonly<{ provider: "neon"; branchId: string }>
    | Readonly<{ provider: "pgcf"; databaseId: string }>
  );
export type WorkflowDatabaseRegistration = AnyProjectDatabaseRegistrationMetadata & {
  readonly claimId?: string;
  readonly observedAt?: Date | null;
  readonly pending?: boolean;
};

export interface ProductWorkflowDeletionBuildArtifact {
  readonly artifactId: Ulid;
  readonly buildExecutionId: Ulid;
  readonly artifactDigest: string;
  readonly output: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
    readonly scope: ProductWorkflowProviderScope;
  };
}

export interface ProductWorkflowContext {
  readonly authorizedRepositoryId?: string;
  readonly handle: string;
  readonly environmentName: "dev" | "prod";
  readonly dataMode: "shared" | "isolated";
  /** Routes the build sandbox, the build objects and every placement of this project. */
  readonly region: HostingRegion;
  readonly intent: ProductCommandIntent;
  readonly projectLifecycleVersion: number;
  readonly headVersion: number;
  readonly sourceGrant: Awaited<ReturnType<typeof readActiveSourceGrant>>;
  readonly knownDeployments: readonly ProductWorkflowWfpReceipt[];
  readonly abandonedWfpTargets?: readonly ProductAbandonedWfpTarget[];
  readonly rollbackArtifact: ProductWorkflowArtifactExpectation | null;
  readonly promotionArtifact: ProductWorkflowArtifactExpectation | null;
  readonly bindingRefreshArtifact?: ProductWorkflowArtifactExpectation | null;
  readonly bindingRefreshPublished?: boolean;
  readonly bindingRefreshCompleted?: boolean;
  readonly promotionSourceDeployment: ProductWorkflowWfpReceipt | null;
  readonly artifactExpectations: readonly ProductWorkflowArtifactExpectation[];
  readonly activeDeploymentId: Ulid | null;
  readonly activeDeployment: ProductWorkflowWfpReceipt | null;
  readonly activeGateway: ProductWorkflowGatewayReceipt | null;
  readonly deletionEnvironments: readonly ProductWorkflowDeletionEnvironment[];
  readonly deletionDataEnvironments: readonly ProductWorkflowDeletionDataEnvironment[];
  readonly deletionInventory: readonly ProjectDeletionInventoryRecord[];
  readonly environmentSecretCount: number;
  readonly acceptedAt: string;
  readonly sourceArchives: readonly ProductWorkflowSourceArchive[];
  readonly frameworkPlan: ProductionFrameworkPlan | null;
  readonly mailDomain: string | null;
  /**
   * Present only on a promotion whose planned Dev head ("source") or Prod head ("target") moved
   * after acceptance; such a promotion can only fail, so it carries no source artifact.
   */
  readonly promotionStale?: "source" | "target";
}

export interface ProductWorkflowSourceArchive {
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly eTag: string;
  readonly byteLength: number;
  readonly scope: ProductWorkflowProviderScope;
  readonly sourceSha256: string;
}

export interface ProductProviderReconciliationContext {
  readonly claimId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly handle: string;
  readonly environmentName: "dev" | "prod";
  readonly operationId: Ulid;
  readonly eventId: Ulid;
  readonly billingEpochId: Ulid;
  readonly logicalWorkflowId: string;
  readonly eventType: ProductProviderMutationEvent;
  readonly acceptedLifecycleVersion: number;
  readonly originalMessage: Readonly<Record<string, unknown>>;
  readonly knownDeployments: readonly ProductWorkflowWfpReceipt[];
  readonly abandonedWfpTargets?: readonly ProductAbandonedWfpTarget[];
  readonly hasActiveGateway?: boolean;
  readonly wfpTarget: Readonly<{
    candidate: ProductWorkflowWfpReceipt;
    runtimePolicy: ProductionFrameworkPlan["runtimePolicy"];
    gateway?: ProductWorkflowGatewayReceipt;
  }> | null;
  readonly retainedWfpTarget?: ProductProviderReconciliationContext["wfpTarget"];
  readonly providerHint: ProductProviderReconciliationHint;
  readonly sourceState: ProductProviderResourceState;
  readonly buildState: ProductProviderResourceState;
}

export declare function findProductProviderReconciliationClaim(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<Readonly<{
  organizationId: Ulid;
  projectId: Ulid;
  environmentId: Ulid;
  operationId: Ulid;
  claimId: Ulid;
  eventId: Ulid;
  logicalWorkflowId: string;
  workflowState: "queued" | "reconciliation_required";
  providerPhase: "source" | "build" | "database";
}> | null>;

export declare function findClaimlessProductProviderReconciliationCandidate(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<Readonly<{
  organizationId: Ulid;
  projectId: Ulid;
  environmentId: Ulid;
  operationId: Ulid;
  eventId: Ulid;
  logicalWorkflowId: string;
  eventType: ProductProviderMutationEvent;
  acceptedLifecycleVersion: number;
}> | null>;

export declare function readProductProviderReconciliationContext(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly claimId: Ulid;
  },
): Promise<ProductProviderReconciliationContext | null>;

export declare function recordAbandonedGatewayPredecessor(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly candidateReceiptId: Ulid;
    readonly sharedGatewayRevision: number;
    readonly auditEventId: Ulid;
    readonly observedAt: string;
  },
): Promise<"created" | "existing">;

export declare function readProductWorkflowContext(
  client: TransactionClient,
  scope: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<ProductWorkflowContext | null>;

/** Cleanup retries retain the exact retired head; old provider receipts cannot become targets. */
export declare function readProductWorkflowDatabaseTarget(
  client: TransactionClient,
  scope: Readonly<{
    organizationId: string;
    projectId: string;
    physicalEnvironmentId: string;
  }>,
): Promise<ProductWorkflowDeletionDataEnvironment>;

/**
 * The source archives and build artifacts one operation staged, read in that operation's own
 * environment. A later operation drains a pending candidate from whichever environment it runs in,
 * so reading its own environment found nothing (Sebmer Prod draining a Dev candidate, 2026-09-25).
 * Every read stays within the tenant, project and environment named here.
 */
export declare function readCandidateCleanupResources(
  client: TransactionClient,
  scope: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<{
  readonly sourceArchives: readonly ProductWorkflowSourceArchive[];
  readonly artifactExpectations: readonly ProductWorkflowArtifactExpectation[];
}>;

export interface ProductSourceArchiveEvidenceInput {
  readonly provider?: "github" | "managed";
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly billingEpochId: Ulid;
  readonly sourceConnectionId: Ulid;
  readonly externalRepositoryId: string;
  readonly commitSha: string;
  readonly sourceSha256: string;
  readonly archive: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
    readonly archiveId: string;
    readonly eTag: string;
    readonly byteLength: number;
  };
  readonly recordedAt: string;
}

interface CommonDeploymentEvidenceInput extends ProductSourceArchiveEvidenceInput {
  readonly deploymentId: Ulid;
  readonly planId: Ulid;
  readonly uploadId: Ulid;
  readonly uploadClaimId: Ulid;
  readonly buildExecutionId: Ulid;
  readonly artifactId: Ulid;
  readonly revisionId: Ulid;
  readonly buildPlanSha256: string;
  readonly build: { readonly buildId: string; readonly projectName: string };
  readonly artifact: {
    readonly artifactDigest: string;
    readonly manifestDigest: string;
    readonly sbomDigest: string;
    readonly outputVersionRef: string;
  };
}

export declare function recordProductSourceArchiveEvidence(
  client: TransactionClient,
  input: ProductSourceArchiveEvidenceInput,
): Promise<"created" | "existing">;

export type ProductDeploymentEvidenceInput = CommonDeploymentEvidenceInput;

export declare function recordProductDeploymentEvidence(
  client: TransactionClient,
  input: ProductDeploymentEvidenceInput,
): Promise<"created" | "existing">;
