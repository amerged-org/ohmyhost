import { type BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { type OperationDeploymentResult, type Ulid } from "@ohmyhost/platform";

import { type AcceptApiOperationInput } from "./api-operation-persistence.js";
import { type DatabaseMigrationFailureReason } from "./deployment-diagnostics.js";
import type { TransactionClient } from "./transaction.js";
import { type ProjectBindingRefreshSnapshot } from "./deployment-binding-refresh.js";
import type { QueryExecutor } from "./types.js";
import type { OperationReconciliationObservation } from "@ohmyhost/contracts/operation-failure";
import { type ProjectDataChangeSnapshot } from "./product-command-data-change.js";
import type {
  ProjectDataChangeKind,
  ProjectDataChangeTransition,
} from "./project-data-environments.js";

export declare function readProductOperationReconciliation(
  client: QueryExecutor,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<OperationReconciliationObservation | null>;

type ProductCommandBase = Omit<AcceptApiOperationInput, "eventType" | "confirmation">;

export type ProductProviderMutationEvent =
  | "DeploymentRequestedV1"
  | "DeploymentRollbackRequestedV1"
  | "DeploymentPromotionRequestedV1"
  | "ProjectHandleChangeRequestedV1"
  | "ProjectDataChangeRequestedV1";

export type AcceptProductApiOperationInput = ProductCommandBase &
  (
    | {
        readonly eventType: "ProjectHandleChangeRequestedV1";
        /** The address the customer chose; the gateways move to it before it is stored. */
        readonly requestedHandle: string;
        readonly expectedEtag: string;
      }
    | {
        readonly eventType: "SourceLinkRequestedV1";
        readonly installationId: string;
        readonly repositoryOwner: string;
        readonly repositoryName: string;
      }
    | {
        readonly eventType: "DeploymentRequestedV1";
        readonly planId: Ulid;
        readonly planDigest: Uint8Array;
        readonly deploymentId: Ulid;
      }
    | {
        readonly eventType: "DeploymentRollbackRequestedV1";
        readonly deploymentId: Ulid;
        readonly targetDeploymentId: Ulid;
        readonly targetRevisionId: Ulid;
        readonly targetArtifactId: Ulid;
        readonly expectedHeadVersion: number;
        readonly expectedDataEnvironmentId: Ulid;
        readonly expectedAssignmentVersion: number;
        readonly expectedRegistrationVersion: number;
        readonly expectedEtag: string;
        readonly confirmation: NonNullable<AcceptApiOperationInput["confirmation"]>;
      }
    | {
        readonly eventType: "DeploymentPromotionRequestedV1";
        readonly deploymentId: Ulid;
        readonly sourceEnvironmentId: Ulid;
        readonly sourceDeploymentId: Ulid;
        readonly sourceRevisionId: Ulid;
        readonly sourceArtifactId: Ulid;
        readonly sourceArtifactDigest: Uint8Array;
        readonly expectedSourceHeadVersion: number;
        readonly expectedHeadVersion: number;
        readonly expectedEtag: string;
        readonly confirmation: NonNullable<AcceptApiOperationInput["confirmation"]>;
      }
    | {
        readonly eventType: "ProjectDataChangeRequestedV1";
        readonly dataChange: ProjectDataChangeKind;
        readonly dataChangeSnapshot: ProjectDataChangeTransition;
        readonly expectedEnvironmentHeads: ProjectDataChangeSnapshot["environmentHeads"];
        readonly expectedRegistrationGenerations: ProjectDataChangeSnapshot["registrationGenerations"];
        readonly cleanupRunId: Ulid;
        readonly expectedProjectVersion: number;
        readonly expectedEtag: string;
        readonly confirmation: NonNullable<AcceptApiOperationInput["confirmation"]>;
      }
    | {
        readonly eventType: "ProjectDeletionRequestedV1";
        readonly cleanupRunId: Ulid;
        readonly expectedProjectVersion: number;
        readonly expectedEtag: string;
        readonly confirmation: NonNullable<AcceptApiOperationInput["confirmation"]>;
      }
  );

export declare function acceptProductApiOperation(
  client: TransactionClient,
  input: AcceptProductApiOperationInput,
): Promise<{
  readonly outcome: "created" | "replayed";
  readonly operationId: Ulid;
}>;

export interface ProductCommandIntent {
  readonly eventType: AcceptProductApiOperationInput["eventType"];
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly billingEpochId: Ulid;
  readonly installationId: string | null;
  readonly repositoryOwner: string | null;
  readonly repositoryName: string | null;
  readonly planId: Ulid | null;
  readonly sourceConnectionId: Ulid | null;
  readonly sourceGeneration?: number | null;
  readonly deploymentId: Ulid | null;
  readonly targetDeploymentId: Ulid | null;
  readonly targetRevisionId: Ulid | null;
  readonly targetArtifactId: Ulid | null;
  readonly expectedEtag: string | null;
  /** The address a rename asks for; null for every other command. */
  readonly requestedHandle: string | null;
  readonly cleanupRunId: Ulid | null;
  readonly sourceEnvironmentId: Ulid | null;
  readonly sourceDeploymentId: Ulid | null;
  readonly sourceRevisionId: Ulid | null;
  readonly sourceArtifactId: Ulid | null;
  readonly sourceArtifactDigest: Buffer | null;
  readonly expectedSourceHeadVersion: number | null;
  readonly expectedTargetHeadVersion: number | null;
  readonly commitSha: string | null;
  readonly sourceDigest: Buffer | null;
  readonly buildPlanDigest: Buffer | null;
  readonly providerVersionId: string | null;
  readonly dataChange?: ProjectDataChangeKind | null;
  readonly dataChangeSnapshot?: ProjectDataChangeSnapshot | null;
  readonly bindingRefreshSnapshot?: ProjectBindingRefreshSnapshot | null;
}

export interface ProductProviderMutationClaimInput {
  readonly claimId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly eventId: Ulid;
  readonly logicalWorkflowId: string;
  readonly eventType: ProductProviderMutationEvent;
  readonly acceptedLifecycleVersion: number;
}

export interface ProductProviderReconciliationHint {
  readonly phase:
    | "source"
    | "build"
    | "database"
    | "runtime-secrets"
    | "storage"
    | "gateway"
    | "wfp";
  readonly expectedArtifactDigest?: `sha256:${string}`;
  readonly currentProviderTag?: string | null;
  readonly currentProductDeploymentId?: Ulid;
  readonly activationRuntimePolicy?: Readonly<{
    readonly healthCheckPath: string;
    readonly egressAllowedOrigins: readonly string[];
    readonly browser?: BrowserPolicy;
  }>;
}

export type ProductProviderResourceState =
  | "unknown"
  | "absent"
  | "ready"
  | "succeeded"
  | "running"
  | "failed"
  | "cleanup_failable";

export interface PrepareProductProviderReconciliationInput {
  readonly attemptId: Ulid;
  readonly observationId: Ulid;
  readonly claimId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly eventId: Ulid;
  readonly logicalWorkflowId: string;
  readonly physicalWorkflowId: string;
  readonly mode: "retry" | "abandon";
  readonly idempotencyDigest: Uint8Array;
  readonly evidenceDigest: Uint8Array;
  readonly gateway: Readonly<{
    state: "unknown" | "absent" | "ready";
    providerTag?: string;
    observedAt?: string;
  }>;
  readonly wfp: Readonly<{
    state: "unknown" | "absent" | "ready";
    providerTag?: string;
    productDeploymentId?: Ulid;
    artifactDigest?: `sha256:${string}`;
    observedAt?: string;
  }>;
  readonly actorId: string;
  readonly startedOperationEventId: Ulid;
  readonly operationEventId: Ulid;
  readonly auditEventId: Ulid;
  readonly preparedAt: string;
}

export type PreparedProductProviderReconciliation =
  | Readonly<{
      outcome: "prepared";
      attemptId: Ulid;
      physicalWorkflowId: string;
      originalMessage: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ outcome: "resolved_absent"; attemptId: Ulid }>
  | Readonly<{ outcome: "unknown"; attemptId: Ulid }>;

export type ProductProviderReconciliationAttemptReplay =
  | Readonly<{ outcome: "completed"; attemptId: Ulid }>
  | Readonly<{
      outcome: "prepared";
      attemptId: Ulid;
      claimId: Ulid;
      physicalWorkflowId: string;
      originalMessage: Readonly<Record<string, unknown>>;
    }>;

export declare function readProductProviderReconciliationAttempt(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly attemptId: Ulid;
    readonly actorId: string;
    readonly idempotencyDigest: Uint8Array;
  },
): Promise<ProductProviderReconciliationAttemptReplay | null>;

export declare function claimProductProviderMutation(
  client: TransactionClient,
  input: ProductProviderMutationClaimInput,
): Promise<"created" | "existing">;

export declare function authorizeProductProviderMutation(
  client: TransactionClient,
  input: Omit<
    ProductProviderMutationClaimInput,
    "claimId" | "eventId" | "eventType" | "logicalWorkflowId"
  >,
): Promise<void>;

export declare function activateProductProviderReconciliationAttempt(
  client: TransactionClient,
  input: {
    readonly attemptId: Ulid;
    readonly physicalWorkflowId: string;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly eventId: Ulid;
    readonly eventType: ProductProviderMutationEvent;
  },
): Promise<"activated" | "existing">;

export declare function recoverTerminalProductProviderReconciliationAttempt(
  client: TransactionClient,
  input: {
    readonly attemptId: Ulid;
    readonly observationId: Ulid;
    readonly auditEventId: Ulid;
    readonly physicalWorkflowId: string;
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly actorId: string;
    readonly terminalStatus: "errored" | "terminated";
    readonly evidenceDigest: Uint8Array;
    readonly recoveredAt: string;
  },
): Promise<"recovered" | "existing">;

export declare function prepareProductProviderReconciliation(
  client: TransactionClient,
  input: PrepareProductProviderReconciliationInput,
): Promise<PreparedProductProviderReconciliation>;

type CompleteProductCommandBase = {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly outboxEventId: Ulid;
  readonly startedOperationEventId: Ulid;
  readonly operationEventId: Ulid;
  readonly auditEventId: Ulid;
  readonly actorId: string;
  readonly completedAt: string;
} & (
  | {
      readonly workflowId: string;
      readonly terminalEvidence: Readonly<Record<string, unknown>>;
      readonly reconciliationAttemptId?: Ulid;
      readonly replayAttemptId?: Ulid;
      readonly attemptId?: never;
    }
  | {
      readonly attemptId: Ulid;
      readonly workflowId?: never;
      readonly terminalEvidence?: never;
      readonly reconciliationAttemptId?: never;
      readonly replayAttemptId?: never;
    }
);

export type CompleteProductCommandInput = CompleteProductCommandBase &
  (
    | {
        readonly eventType: "SourceLinkRequestedV1";
        readonly sourceId: Ulid;
        readonly grantId: Ulid;
        readonly sourceConnectionId?: Ulid;
        readonly externalRepositoryId?: string;
        readonly grantedAt?: string;
      }
    | {
        readonly eventType: "DeploymentRequestedV1";
        readonly revisionId: Ulid;
        readonly acceptedLifecycleVersion: number;
        readonly expectedHeadVersion: number;
        readonly url: string;
        readonly artifactDigest: Uint8Array;
        readonly finalizedWfpResult?: OperationDeploymentResult;
      }
    | {
        readonly eventType: "DeploymentRollbackRequestedV1";
        readonly revisionId: Ulid;
        readonly acceptedLifecycleVersion: number;
        readonly expectedHeadVersion: number;
        readonly url: string;
        readonly artifactDigest: Uint8Array;
        readonly finalizedRollbackResult?: true;
      }
    | {
        readonly eventType: "DeploymentPromotionRequestedV1";
        readonly revisionId: Ulid;
        readonly acceptedLifecycleVersion: number;
        readonly expectedHeadVersion: number;
        readonly url: string;
        readonly artifactDigest: Uint8Array;
      }
    | {
        readonly eventType: "ProjectHandleChangeRequestedV1";
        /** The address stored by the rename, or absent when the name was refused. */
        readonly storedHandle?: string;
      }
    | {
        readonly eventType: "ProjectDataChangeRequestedV1";
      }
    | {
        readonly eventType: "ProjectDeletionRequestedV1";
        readonly expectedHeadVersion?: number;
        readonly expectedEnvironmentHeads?: readonly Readonly<{
          environmentId: Ulid;
          expectedHeadVersion: number;
        }>[];
      }
  );

export declare function completeProductCommand(
  client: TransactionClient,
  input: CompleteProductCommandInput,
): Promise<"completed" | "replayed">;

export declare function reconcileProductCommand(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly outboxEventId: Ulid;
    readonly auditEventId: Ulid;
    readonly actorId: string;
    readonly errorCode: string;
    readonly reconciledAt: string;
    readonly reconciliationAttemptId?: Ulid;
    readonly replayAttemptId?: Ulid;
    readonly providerReconciliation?: Readonly<{
      readonly observationId: Ulid;
      readonly evidenceDigest: Uint8Array;
      readonly hint: ProductProviderReconciliationHint;
    }>;
  } & (
    | {
        readonly workflowId: string;
        readonly attemptId?: never;
      }
    | {
        readonly attemptId: Ulid;
        readonly workflowId?: never;
      }
  ),
): Promise<"reconciliation_required" | "replayed">;

export declare function failProductDeploymentCommand(
  client: TransactionClient,
  input: {
    readonly workflowId: string;
    readonly reconciliationAttemptId?: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly outboxEventId: Ulid;
    readonly startedOperationEventId: Ulid;
    readonly operationEventId: Ulid;
    readonly auditEventId: Ulid;
    readonly actorId: string;
    readonly errorCode:
      | "BUILD_NOT_STARTED"
      | "BUILD_FAILED"
      | "DATABASE_MIGRATION_FAILED"
      | "PAID_PLAN_REQUIRED"
      | "INSUFFICIENT_ORGANIZATION_CREDITS"
      | "RUNTIME_CANDIDATE_FAILED"
      | "RUNTIME_CANDIDATE_REJECTED"
      | "STORAGE_JURISDICTION_CONFLICT"
      | "PROMOTION_SOURCE_STALE"
      | "PROMOTION_TARGET_STALE"
      | "AUTHORIZATION_CHANGED";
    /** The customer-visible build excerpt; only a BUILD_FAILED deployment may carry one. */
    readonly failure?: Readonly<{
      excerpt: string;
      truncated: boolean;
    }> | null;
    /** Why the migrations were refused and which file; only a DATABASE_MIGRATION_FAILED one. */
    readonly migration?: Readonly<{
      reason: DatabaseMigrationFailureReason;
      path: string | null;
    }> | null;
    /** What the health check answered, so a removed candidate can still explain itself. */
    readonly health?: Readonly<{
      status: number;
      path: string;
      excerpt: string | null;
      truncated: boolean;
    }> | null;
    readonly failedAt: string;
  },
): Promise<"failed" | "replayed">;

/** What an unhealthy candidate's health check answered. */
export interface ProductDeploymentHealthVerdict {
  readonly status: number;
  readonly path: string;
  readonly excerpt: string | null;
  readonly truncated: boolean;
}

/**
 * Stores an unhealthy candidate's verdict as its deployment's HEALTH_CHECK_FAILED diagnostic before
 * the candidate is compensated, so a compensation that then fails cannot erase it (Sebmer Dev
 * operation 01M3C5PEP52T5E3YCM26VWPKXW, 2026-09-25). Only the running Workflow of this exact
 * operation may store it; a replay of the same diagnostic stores nothing new.
 */
export declare function recordRuntimeHealthDiagnostic(
  client: TransactionClient,
  input: {
    readonly workflowId: string;
    readonly reconciliationAttemptId?: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly outboxEventId: Ulid;
    readonly diagnosticEventId: Ulid;
    readonly health: ProductDeploymentHealthVerdict;
    readonly recordedAt: string;
  },
): Promise<"created" | "existing">;
