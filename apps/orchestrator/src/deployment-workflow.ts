import { parseBrowserPolicy, type BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import {
  deterministicProductCommandWorkflowId,
  type ProductCommandMessageV1,
  type ProjectDataChangeRequestedV1,
} from "./product-command.js";

export const PRODUCT_WORKFLOW_STEP_CONFIG = Object.freeze({
  retries: Object.freeze({
    limit: 3,
    delay: "5 seconds" as const,
    backoff: "exponential" as const,
  }),
  timeout: "2 minutes" as const,
});

export const PRODUCT_BUILD_OBSERVATION_STEP_CONFIG = Object.freeze({
  retries: PRODUCT_WORKFLOW_STEP_CONFIG.retries,
  timeout: "15 minutes" as const,
});

export const PRODUCT_ACTIVATION_STEP_CONFIG = Object.freeze({
  retries: Object.freeze({ ...PRODUCT_WORKFLOW_STEP_CONFIG.retries, limit: 5 }),
  timeout: PRODUCT_WORKFLOW_STEP_CONFIG.timeout,
});

export const PRODUCT_BUILD_POLL_INTERVAL = "10 seconds" as const;
export const PRODUCT_BUILD_POLL_LIMIT = 78;
export const PRODUCT_DATABASE_PROVISIONING_POLL_LIMIT = 18;
export const PRODUCT_TOMBSTONE_PROPAGATION_DELAY = "10 minutes" as const;

export interface ProductWorkflowStepPort {
  do<T>(
    name: string,
    config:
      | typeof PRODUCT_WORKFLOW_STEP_CONFIG
      | typeof PRODUCT_BUILD_OBSERVATION_STEP_CONFIG
      | typeof PRODUCT_ACTIVATION_STEP_CONFIG,
    run: () => Promise<T>,
  ): Promise<T>;
  sleep(
    name: string,
    duration:
      | typeof PRODUCT_BUILD_POLL_INTERVAL
      | typeof PRODUCT_TOMBSTONE_PROPAGATION_DELAY
      | "1 minute"
      | "1 hour",
  ): Promise<void>;
}

type Observation<T extends object> =
  | ({ readonly status: "observed" } & T)
  | {
      readonly status: "uncertain";
      readonly providerHint?: ProductProviderReconciliationHint;
    };

/** Private removal step evidence, retained by Workflow; it never becomes provider-reconciliation authority. */
type RemovalObservation<T extends object> =
  | ({ readonly status: "observed" } & T)
  | { readonly status: "uncertain"; readonly reason?: "stale_edge" | "provider_conflict" };

export interface ProductProviderReconciliationHint {
  readonly phase:
    | "source"
    | "build"
    | "database"
    | "storage"
    | "runtime-secrets"
    | "gateway"
    | "wfp";
  readonly expectedArtifactDigest: string | null;
  readonly currentProviderTag: string | null;
  readonly currentProductDeploymentId: string | null;
  readonly reason?: "candidate_bindings_outdated";
  readonly activationRuntimePolicy?: Readonly<{
    readonly healthCheckPath: string;
    readonly egressAllowedOrigins: readonly string[];
    readonly browser?: BrowserPolicy;
  }>;
}

interface ProductWorkflowPhase {
  current: ProductProviderReconciliationHint["phase"];
  expectedArtifactDigest: string | null;
  activationRuntimePolicy?: ProductProviderReconciliationHint["activationRuntimePolicy"];
  candidate?: ProductWfpCandidate;
  candidateEvidence?: Readonly<Record<string, unknown>>;
  activation?: ProductWfpGatewayActivation;
  activationAttempted?: boolean;
}

export type ProductDeploymentFailureCode =
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

/** The customer-visible tail of a failed build; null when the build runtime uploaded none. */
export interface ProductBuildFailure {
  readonly excerpt: string;
  readonly truncated: boolean;
}

/** What a candidate's health check answered, carried out of an activation that is already removed. */
export interface ProductHealthVerdict {
  readonly status: number;
  readonly path: string;
  readonly excerpt: string | null;
  readonly truncated: boolean;
}

export interface ProductDatabaseMigrationFailure {
  readonly reason: "catalog_changed" | "execution_failed" | "ledger_conflict" | "not_admitted";
  readonly path: string | null;
  readonly statementIndex?: number;
  readonly sqlstate?: string;
}

export interface ProductCommandPersistencePort {
  authorizeActivation(
    command: WfpMutationCommand,
    candidate?: ProductWfpCandidate,
  ): Promise<
    { readonly allowed: true } | { readonly allowed: false; readonly supersededById: string }
  >;
  recordCandidate(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: WfpMutationCommand;
    readonly candidate: ProductWfpCandidate;
    readonly evidence: Readonly<Record<string, unknown>>;
  }): Promise<{
    readonly persistence: "applied" | "duplicate";
    readonly candidateReceiptId: string;
  }>;
  finalizeCandidate(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: WfpMutationCommand;
    readonly evidence: Readonly<Record<string, unknown>>;
  }): Promise<
    | "applied"
    | "duplicate"
    | { readonly status: "conflict"; readonly reason: string }
    | { readonly status: "binding_refresh_pending" }
  >;
  finishBindingRefresh(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: Extract<ProductCommandMessageV1, { eventType: "DeploymentRequestedV1" }>;
    readonly artifact: unknown;
  }): Promise<"applied" | "duplicate" | { readonly status: "uncertain" }>;
  finalizeRollback(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: Extract<
      ProductCommandMessageV1,
      { eventType: "DeploymentRollbackRequestedV1" }
    >;
    readonly evidence: Readonly<Record<string, unknown>>;
  }): Promise<"applied" | "duplicate" | "conflict">;
  /** The environments whose gateways must move, read once so a retry moves the same ones. */
  readGatewayAddressMoves(
    command: Extract<ProductCommandMessageV1, { eventType: "ProjectHandleChangeRequestedV1" }>,
  ): Promise<readonly ProductGatewayAddressMove[]>;
  /**
   * Stores the new address once every gateway serves it. The unique address is the authority: a
   * name taken in between ends the rename instead of leaving two projects on one address.
   */
  finalizeHandleChange(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: Extract<
      ProductCommandMessageV1,
      { eventType: "ProjectHandleChangeRequestedV1" }
    >;
    readonly moved: readonly Readonly<{ environmentId: string; publicOrigin: string }>[];
    readonly evidence: Readonly<Record<string, unknown>>;
  }): Promise<"applied" | "duplicate" | { readonly status: "conflict"; readonly reason: "taken" }>;
  markCandidateSuperseded(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: WfpMutationCommand;
    readonly candidate: ProductWfpCandidate;
    readonly claim: ProductWfpCandidateCleanupClaim;
  }): Promise<"applied" | "duplicate">;
  prepareCandidateCleanup(input: {
    readonly command: WfpMutationCommand;
    readonly candidate: ProductWfpCandidate;
    readonly reason: "superseded" | "failed" | "compensate";
    readonly supersededById: string | null;
  }): Promise<ProductWfpCandidateCleanupClaim>;
  claimCandidateCleanup(
    command: ProductCommandMessageV1,
  ): Promise<ProductWfpCandidateCleanupClaim | null>;
  recordCandidateCleanup(input: {
    readonly command: ProductCommandMessageV1;
    readonly claim: ProductWfpCandidateCleanupClaim;
    readonly cleanup: ProductWfpCandidateCleanupEvidence;
  }): Promise<"applied" | "duplicate">;
  complete(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: ProductCommandMessageV1;
    readonly evidence: Readonly<Record<string, unknown>>;
  }): Promise<"applied" | "duplicate">;
  fail(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: Extract<
      ProductCommandMessageV1,
      {
        eventType:
          | "DeploymentRequestedV1"
          | "DeploymentPromotionRequestedV1"
          | "DeploymentRollbackRequestedV1";
      }
    >;
    readonly errorCode: ProductDeploymentFailureCode;
    /** The build excerpt of a BUILD_FAILED deployment, shown to the customer as its diagnostic. */
    readonly failure?: ProductBuildFailure | null;
    /** The health verdict of a RUNTIME_CANDIDATE_FAILED deployment. */
    readonly health?: ProductHealthVerdict | null;
    readonly migration?: ProductDatabaseMigrationFailure | null;
  }): Promise<"applied" | "duplicate">;
  rejectAuthorization?(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: WfpMutationCommand;
    readonly candidate: ProductWfpCandidate | null;
    readonly candidateEvidence: Readonly<Record<string, unknown>> | null;
    readonly activation: ProductWfpGatewayActivation | null;
    readonly activationAttempted: boolean;
  }): Promise<
    | { readonly status: "failed"; readonly persistence: "applied" | "duplicate" }
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  /**
   * Stores what an unhealthy candidate's health check answered as the deployment's diagnostic
   * before the candidate is compensated, so a compensation that fails cannot erase the verdict.
   */
  recordHealthFailure(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: WfpMutationCommand;
    readonly health: ProductHealthVerdict;
  }): Promise<"applied" | "duplicate">;
  requireReconciliation(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: ProductCommandMessageV1;
    readonly providerHint: ProductProviderReconciliationHint | null;
  }): Promise<"applied" | "duplicate">;
  retainDeletionTombstone(input: {
    readonly workflowId: string;
    readonly executionId: string;
    readonly command: Extract<ProductCommandMessageV1, { eventType: "ProjectDeletionRequestedV1" }>;
    readonly tombstoneReceiptId: string;
  }): Promise<"applied" | "duplicate">;
  /**
   * Which planned head of a promotion has moved since it was accepted: the Dev deployment it
   * copies ("source") or the Prod head it replaces ("target"); null while both are unchanged.
   */
  readPromotionStaleness(
    command: Extract<ProductCommandMessageV1, { eventType: "DeploymentPromotionRequestedV1" }>,
  ): Promise<"source" | "target" | null>;
}

type WfpMutationCommand = Extract<
  ProductCommandMessageV1,
  {
    eventType:
      | "DeploymentRequestedV1"
      | "DeploymentRollbackRequestedV1"
      | "DeploymentPromotionRequestedV1";
  }
>;

export interface ProductWfpCandidate {
  readonly candidateReceiptId: string | null;
  readonly operationId: string;
  readonly receipt: unknown;
  readonly previousGateway: unknown | null;
  readonly runtimePolicy: unknown;
  readonly runtimeSecretDeliveryStage?: unknown;
  readonly scheduledFunctions?: unknown;
  readonly deploymentUrl: string;
  readonly artifactDigest: string;
}

/** One environment of a project whose gateway has to move to a new address. */
export interface ProductGatewayAddressMove {
  readonly environmentId: string;
  readonly environmentName: "dev" | "prod";
  /** The address the project is stored at today, so a lost rename can publish it back. */
  readonly handle: string;
  readonly publicOrigin: string;
}

export interface ProductWfpGatewayActivation {
  readonly candidateReceipt: unknown;
  readonly gateway: unknown;
  readonly deploymentUrl: string;
}

export interface ProductWfpCandidateCleanupClaim {
  readonly claimId: string;
  readonly candidateReceiptId: string;
  readonly cleanupReceiptId: string;
  readonly candidate: ProductWfpCandidate;
  readonly supersededById: string | null;
  readonly expectedResources: readonly ProductWfpCandidateCleanupResource[];
}

export interface ProductWfpCandidateCleanupResource {
  readonly provider: "cloudflare";
  readonly resourceKind: "source-archive" | "build-artifact";
  readonly resourceIdentityDigest: Uint8Array;
}

export interface ProductWfpCandidateRemovalEvidence {
  readonly outcome: "removed" | "not_found";
  readonly candidateAbsence: unknown;
  readonly gateway: unknown | null;
}

export interface ProductWfpCandidateCleanupEvidence extends ProductWfpCandidateRemovalEvidence {
  readonly operationResources: unknown;
}

export interface ProductCandidateResourceCleanupPort {
  removeOperationArtifacts(
    command: ProductCommandMessageV1,
    claim: ProductWfpCandidateCleanupClaim,
  ): Promise<
    | { readonly status: "removed"; readonly evidence: unknown }
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
}

export interface ProductScheduleCleanupPort {
  /** Removes the project's environment schedules so no further cron run is created. */
  remove(
    command: Extract<ProductCommandMessageV1, { eventType: "ProjectDeletionRequestedV1" }>,
  ): Promise<{ readonly removed: number }>;
}

export interface ProductSourcePort {
  observeLink(
    command: Extract<ProductCommandMessageV1, { eventType: "SourceLinkRequestedV1" }>,
  ): Promise<Observation<{ readonly evidence: Readonly<Record<string, unknown>> }>>;
  fetchExactArchive(
    command: Extract<ProductCommandMessageV1, { eventType: "DeploymentRequestedV1" }>,
  ): Promise<Observation<{ readonly archive: unknown }>>;
}

export interface ProductBuildPort {
  /** Only Control's private accepted intent can authorize artifact reuse. */
  readBindingRefresh(
    command: Extract<ProductCommandMessageV1, { eventType: "DeploymentRequestedV1" }>,
  ): Promise<
    | null
    | { readonly completed: true }
    | {
        readonly artifact: unknown;
        readonly artifactDigest: string;
        readonly published: boolean;
      }
  >;
  start(
    command: Extract<ProductCommandMessageV1, { eventType: "DeploymentRequestedV1" }>,
    archive: unknown,
  ): Promise<
    | { readonly status: "started"; readonly receipt: unknown }
    | { readonly status: "uncertain" }
    | { readonly status: "failed"; readonly errorCode: "BUILD_NOT_STARTED" }
  >;
  observe(
    command: Extract<
      ProductCommandMessageV1,
      { eventType: "DeploymentRequestedV1" | "DeploymentRollbackRequestedV1" }
    >,
    receipt: unknown,
  ): Promise<
    | Observation<{
        readonly artifact: unknown;
        readonly artifactDigest: string;
      }>
    | { readonly status: "running" }
    | {
        readonly status: "failed";
        readonly errorCode: "BUILD_FAILED";
        readonly failure: ProductBuildFailure | null;
      }
  >;
}

export interface ProductDatabasePort {
  ensure(
    command: Extract<
      ProductCommandMessageV1,
      { eventType: "DeploymentRequestedV1" | "DeploymentPromotionRequestedV1" }
    >,
    artifact?: unknown,
  ): Promise<
    | { readonly status: "ready"; readonly receipt: unknown | null }
    | { readonly status: "uncertain" }
    | { readonly status: "verification_pending" }
    | { readonly status: "provisioning_pending" }
    | {
        readonly status: "failed";
        readonly errorCode:
          | "DATABASE_MIGRATION_FAILED"
          | "PAID_PLAN_REQUIRED"
          | "INSUFFICIENT_ORGANIZATION_CREDITS"
          | "STORAGE_JURISDICTION_CONFLICT";
        readonly migration?: ProductDatabaseMigrationFailure;
      }
  >;
}

export interface ProductWfpPort {
  prepareRollback(
    command: Extract<ProductCommandMessageV1, { eventType: "DeploymentRollbackRequestedV1" }>,
  ): Promise<
    | ({ readonly status: "replayed" } & ProductWfpCandidate)
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  stage(
    command: WfpMutationCommand,
    artifact?: unknown,
  ): Promise<
    | ({ readonly status: "staged" | "replayed" } & ProductWfpCandidate)
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
    | {
        readonly status: "failed";
        readonly errorCode: "RUNTIME_CANDIDATE_REJECTED" | "STORAGE_JURISDICTION_CONFLICT";
      }
  >;
  recordStagedCandidate(
    command: WfpMutationCommand,
    candidateReceiptId: string,
    candidate: ProductWfpCandidate,
  ): Promise<
    | {
        readonly status: "recorded" | "replayed";
        readonly runtimeSecretDeliveryStage: unknown;
      }
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  recordActivatedCandidate(
    command: WfpMutationCommand,
    candidate: ProductWfpCandidate,
    activation: ProductWfpGatewayActivation,
  ): Promise<
    | { readonly status: "activated" | "existing" }
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  activate(
    command: WfpMutationCommand,
    candidate: ProductWfpCandidate,
  ): Promise<
    | ({ readonly status: "activated" } & ProductWfpGatewayActivation)
    | ({
        readonly status: "unhealthy";
        readonly health?: ProductHealthVerdict | null;
      } & ProductWfpGatewayActivation)
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  observeActivation(
    command: WfpMutationCommand,
    candidate: ProductWfpCandidate,
  ): Promise<
    | ({ readonly status: "activated" } & ProductWfpGatewayActivation)
    | ({
        readonly status: "unhealthy";
        readonly health?: ProductHealthVerdict | null;
      } & ProductWfpGatewayActivation)
    | { readonly status: "absent" }
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  /** Restores the gateway under the operation's claim and removes the claimed candidate. */
  compensate(
    command: WfpMutationCommand,
    claim: ProductWfpCandidateCleanupClaim,
    activation: ProductWfpGatewayActivation,
  ): Promise<
    | ({ readonly status: "compensated" } & ProductWfpCandidateRemovalEvidence)
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  /**
   * Re-publishes one environment's gateway at the requested address. The provider keys a gateway by
   * its configuration digest, so a repeat for an environment that already moved returns the same
   * receipt and the workflow can be retried whole.
   */
  moveGatewayAddress(
    command: Extract<ProductCommandMessageV1, { eventType: "ProjectHandleChangeRequestedV1" }>,
    environment: ProductGatewayAddressMove,
    handle: string,
  ): Promise<
    | { readonly status: "moved"; readonly publicOrigin: string; readonly gateway: unknown }
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  restoreGateway(
    command: Extract<ProductCommandMessageV1, { eventType: "DeploymentRollbackRequestedV1" }>,
    candidate: ProductWfpCandidate,
    activation: ProductWfpGatewayActivation,
  ): Promise<
    | { readonly status: "restored"; readonly gateway: unknown }
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  removeCandidate(
    command: ProductCommandMessageV1,
    claim: ProductWfpCandidateCleanupClaim,
  ): Promise<
    | ({ readonly status: "removed" | "not_found" } & ProductWfpCandidateRemovalEvidence)
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  removeClaimedCandidate(
    command: ProductCommandMessageV1,
    claim: ProductWfpCandidateCleanupClaim,
  ): Promise<
    | ({ readonly status: "removed" | "not_found" } & ProductWfpCandidateRemovalEvidence)
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
  >;
  tombstone(
    command: Extract<ProductCommandMessageV1, { eventType: "ProjectDeletionRequestedV1" }>,
  ): Promise<
    RemovalObservation<{ readonly tombstoneReceiptId: string; readonly consecutive404s: number }>
  >;
  cleanupInventory(
    command: Extract<ProductCommandMessageV1, { eventType: "ProjectDeletionRequestedV1" }>,
  ): Promise<Observation<{ readonly inventoryClean: boolean }>>;
  observeRoute404(
    command: Extract<ProductCommandMessageV1, { eventType: "ProjectDeletionRequestedV1" }>,
    removal: { readonly tombstoneReceiptId: string; readonly consecutive404s: number },
  ): Promise<Observation<{ readonly consecutive404s: number }>>;
  finalizeRemoval(
    command: Extract<ProductCommandMessageV1, { eventType: "ProjectDeletionRequestedV1" }>,
  ): Promise<
    RemovalObservation<{
      readonly consecutive404s: number;
      readonly gatewayAbsence: unknown | null;
    }>
  >;
}

export interface ProductCommandWorkflowPorts {
  readonly persistence: ProductCommandPersistencePort;
  readonly source: ProductSourcePort;
  readonly build: ProductBuildPort;
  readonly database: ProductDatabasePort;
  readonly wfp: ProductWfpPort;
  readonly cleanup: ProductCandidateResourceCleanupPort;
  readonly schedules: ProductScheduleCleanupPort;
  readonly dataChange?: ProductDataChangePort;
}

interface ProductDataChangePlan {
  readonly dataModeAfter: "shared" | "isolated";
  readonly redeployEnvironments: readonly ("dev" | "prod")[];
  readonly removeDevDeployment: boolean;
  readonly retiredDataEnvironmentIds: readonly string[];
  readonly reauthorizations: readonly Readonly<{
    dataEnvironmentId: string;
    direction: "narrow" | "widen";
  }>[];
}

export interface ProductDataChangePort {
  readPlan(command: ProjectDataChangeRequestedV1): Promise<ProductDataChangePlan>;
  revokeDatabaseAccess(
    command: ProjectDataChangeRequestedV1,
  ): Promise<{ readonly status: "ready" | "uncertain" }>;
  reauthorize(
    command: ProjectDataChangeRequestedV1,
    dataEnvironmentId: string,
    direction: "narrow" | "widen",
  ): Promise<{ readonly status: "ready" | "uncertain" }>;
  removeDevDeployment(
    command: ProjectDataChangeRequestedV1,
  ): Promise<{ readonly status: "ready" | "uncertain" }>;
  switchAssignments(command: ProjectDataChangeRequestedV1): Promise<"applied" | "duplicate">;
  purgeFiles(
    command: ProjectDataChangeRequestedV1,
    dataEnvironmentId: string,
  ): Promise<
    | { readonly status: "ready"; readonly deletedFiles: number }
    | {
        readonly status: "pending";
        readonly retryAfterSeconds: number;
        readonly progress?: "page_completed";
      }
    | { readonly status: "uncertain" }
  >;
  retireDatabase(
    command: ProjectDataChangeRequestedV1,
    dataEnvironmentId: string,
  ): Promise<
    | { readonly status: "ready"; readonly deletedDatabase: boolean }
    | { readonly status: "uncertain" }
  >;
}

export type ProductCommandWorkflowResult =
  | { readonly status: "succeeded"; readonly persistence: "applied" | "duplicate" }
  | { readonly status: "failed"; readonly persistence: "applied" | "duplicate" }
  | { readonly status: "superseded"; readonly persistence: "applied" | "duplicate" }
  | { readonly status: "reconciliation_required"; readonly tombstoneRetained?: true };

export async function runProductCommandWorkflow(
  command: ProductCommandMessageV1,
  step: ProductWorkflowStepPort,
  ports: ProductCommandWorkflowPorts,
  instanceId = deterministicProductCommandWorkflowId(command),
  executionId = instanceId,
): Promise<ProductCommandWorkflowResult> {
  const workflowId = deterministicProductCommandWorkflowId(command);
  if (instanceId !== workflowId)
    throw new TypeError("Product command Workflow instance ID does not match its payload");
  const phase: ProductWorkflowPhase = {
    current:
      command.eventType === "DeploymentRollbackRequestedV1" ||
      command.eventType === "DeploymentPromotionRequestedV1"
        ? "wfp"
        : "source",
    expectedArtifactDigest: null,
  };
  try {
    // A promotion accepted while a Dev deployment ran can find its planned heads moved; it then
    // ends typed before it drains, claims or touches a provider.
    if (command.eventType === "DeploymentPromotionRequestedV1") {
      const moved = await step.do("read-promotion-heads", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
        ports.persistence.readPromotionStaleness(command),
      );
      if (moved !== null)
        return await failDeployment(
          command,
          workflowId,
          executionId,
          moved === "source" ? "PROMOTION_SOURCE_STALE" : "PROMOTION_TARGET_STALE",
          "fail-stale-promotion",
          step,
          ports,
        );
    }
    // A deletion never drains: a leftover cleanup claim authorizes a removal only on an active
    // project, and the deletion's tombstone removes every uncleaned candidate under its own run.
    if (
      command.eventType !== "ProjectDeletionRequestedV1" &&
      command.eventType !== "ProjectDataChangeRequestedV1"
    ) {
      const cleanup = await drainPendingCandidateCleanup(
        command,
        workflowId,
        executionId,
        step,
        ports,
      );
      if (cleanup !== null) return cleanup;
    }
    switch (command.eventType) {
      case "SourceLinkRequestedV1":
        return await runSourceLink(command, workflowId, executionId, step, ports);
      case "DeploymentRequestedV1":
        return await runDeployment(command, workflowId, executionId, step, ports, phase);
      case "DeploymentRollbackRequestedV1":
        return await runRollback(command, workflowId, executionId, step, ports, phase);
      case "DeploymentPromotionRequestedV1":
        return await runPromotion(command, workflowId, executionId, step, ports, phase);
      case "ProjectHandleChangeRequestedV1":
        return await runHandleChange(command, workflowId, executionId, step, ports);
      case "ProjectDeletionRequestedV1":
        return await runDeletion(command, workflowId, executionId, step, ports);
      case "ProjectDataChangeRequestedV1":
        return await runDataChange(command, workflowId, executionId, step, ports);
    }
  } catch (error) {
    const cause = error instanceof ProductWorkflowPersistenceError ? error.cause : error;
    if (
      isAuthorizationChanged(cause) &&
      (command.eventType === "DeploymentRequestedV1" ||
        command.eventType === "DeploymentPromotionRequestedV1" ||
        command.eventType === "DeploymentRollbackRequestedV1")
    ) {
      if (ports.persistence.rejectAuthorization === undefined) throw cause;
      const reject = ports.persistence.rejectAuthorization;
      const rejected = await step.do(
        "reject-revoked-deployment-authorization",
        PRODUCT_WORKFLOW_STEP_CONFIG,
        () =>
          reject({
            workflowId,
            executionId,
            command,
            candidate: phase.candidate ?? null,
            candidateEvidence: phase.candidateEvidence ?? null,
            activation: phase.activation ?? null,
            activationAttempted: phase.activationAttempted ?? false,
          }),
      );
      if (rejected.status === "failed") return rejected;
      return reconcile(command, workflowId, executionId, step, ports, rejected.providerHint);
    }
    if (error instanceof ProductWorkflowPersistenceError) throw error.cause;
    return reconcile(
      command,
      workflowId,
      executionId,
      step,
      ports,
      command.eventType === "SourceLinkRequestedV1" ||
        command.eventType === "ProjectDeletionRequestedV1" ||
        command.eventType === "ProjectHandleChangeRequestedV1" ||
        command.eventType === "ProjectDataChangeRequestedV1"
        ? null
        : emptyProviderHint(
            phase.current,
            phase.expectedArtifactDigest,
            phase.activationRuntimePolicy,
          ),
    );
  }
}

function isAuthorizationChanged(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (Reflect.get(error, "code") === "operation_authorization_changed" ||
      Reflect.get(error, "name") === "OperationAuthorizationConflictError" ||
      Reflect.get(error, "message") ===
        "Queued operation authorization or source generation changed" ||
      Reflect.get(error, "message") ===
        "OperationAuthorizationConflictError: Queued operation authorization or source generation changed")
  );
}

async function drainPendingCandidateCleanup(
  command: ProductCommandMessageV1,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "cleanup" | "persistence" | "wfp">,
): Promise<ProductCommandWorkflowResult | null> {
  const claim = await step.do(
    "claim-pending-wfp-candidate-cleanup",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.persistence.claimCandidateCleanup(command),
  );
  if (claim === null) return null;
  const removed = await step.do("remove-pending-wfp-candidate", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.wfp.removeClaimedCandidate(command, claim),
  );
  if (removed.status === "uncertain") {
    return reconcile(command, workflowId, executionId, step, ports, removed.providerHint);
  }
  const operation = await step.do(
    "remove-pending-operation-artifacts",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.cleanup.removeOperationArtifacts(command, claim),
  );
  if (operation.status === "uncertain") {
    return reconcile(command, workflowId, executionId, step, ports, operation.providerHint);
  }
  await step.do("persist-pending-wfp-candidate-cleanup", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.persistence.recordCandidateCleanup({
      command,
      claim,
      cleanup: Object.freeze({ ...removed, operationResources: operation.evidence }),
    }),
  );
  // Only this deployment's own candidate, left behind by a crash, ends it; another operation's
  // candidate was only in the way and this deployment still builds its own.
  if (
    command.eventType === "DeploymentRequestedV1" &&
    claim.candidate.operationId === command.operationId
  ) {
    return failDeployment(
      command,
      workflowId,
      executionId,
      "RUNTIME_CANDIDATE_FAILED",
      "fail-cleaned-runtime-candidate",
      step,
      ports,
    );
  }
  return null;
}

async function runSourceLink(
  command: Extract<ProductCommandMessageV1, { eventType: "SourceLinkRequestedV1" }>,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: ProductCommandWorkflowPorts,
): Promise<ProductCommandWorkflowResult> {
  const source = await step.do("observe-source-link", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.source.observeLink(command),
  );
  if (source.status !== "observed") return reconcile(command, workflowId, executionId, step, ports);
  return complete(command, workflowId, executionId, source.evidence, step, ports);
}

async function runDeployment(
  command: Extract<ProductCommandMessageV1, { eventType: "DeploymentRequestedV1" }>,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: ProductCommandWorkflowPorts,
  phase: ProductWorkflowPhase,
): Promise<ProductCommandWorkflowResult> {
  const refresh = await step.do("read-private-binding-refresh", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.build.readBindingRefresh(command),
  );
  if (refresh !== null) {
    if ("completed" in refresh) return { status: "succeeded", persistence: "duplicate" };
    if (refresh.published)
      return finishBindingRefresh(command, workflowId, executionId, refresh.artifact, step, ports);
    phase.current = "wfp";
    return activateWfpCandidate(
      command,
      workflowId,
      executionId,
      {
        artifact: refresh.artifact,
        artifactDigest: refresh.artifactDigest,
        buildReused: true,
        bindingRefresh: true,
      },
      refresh.artifact,
      step,
      ports,
      phase,
    );
  }
  phase.current = "source";
  const archive = await step.do("fetch-exact-source-archive", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.source.fetchExactArchive(command),
  );
  if (archive.status !== "observed" || archive.archive === undefined)
    return reconcile(command, workflowId, executionId, step, ports, emptyProviderHint("source"));
  phase.current = "build";
  const started = await step.do("start-isolated-build", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.build.start(command, archive.archive),
  );
  if (started.status === "failed") {
    return failDeployment(
      command,
      workflowId,
      executionId,
      started.errorCode,
      "fail-isolated-build-start",
      step,
      ports,
    );
  }
  if (started.status !== "started" || started.receipt === undefined)
    return reconcile(command, workflowId, executionId, step, ports, emptyProviderHint("build"));
  let artifact: Awaited<ReturnType<ProductBuildPort["observe"]>> = { status: "running" };
  for (let attempt = 1; attempt <= PRODUCT_BUILD_POLL_LIMIT; attempt += 1) {
    artifact = await step.do(
      `observe-build-artifact-${attempt}`,
      PRODUCT_BUILD_OBSERVATION_STEP_CONFIG,
      () => ports.build.observe(command, started.receipt),
    );
    if (artifact.status !== "running") break;
    if (attempt < PRODUCT_BUILD_POLL_LIMIT)
      await step.sleep(`wait-for-build-${attempt}`, PRODUCT_BUILD_POLL_INTERVAL);
  }
  if (artifact.status === "failed") {
    return failDeployment(
      command,
      workflowId,
      executionId,
      artifact.errorCode,
      "fail-isolated-build",
      step,
      ports,
      artifact.failure,
    );
  }
  if (
    artifact.status !== "observed" ||
    artifact.artifact === undefined ||
    !nonEmpty(artifact.artifactDigest)
  )
    return reconcile(command, workflowId, executionId, step, ports, emptyProviderHint("build"));
  phase.current = "database";
  let database = await step.do("ensure-project-database", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.database.ensure(command, artifact.artifact),
  );
  let mailAttempts = 0,
    provisioningAttempts = 0;
  while (
    (database.status === "verification_pending" && mailAttempts < 72) ||
    (database.status === "provisioning_pending" &&
      provisioningAttempts < PRODUCT_DATABASE_PROVISIONING_POLL_LIMIT)
  ) {
    if (database.status === "verification_pending") {
      const attempt = ++mailAttempts;
      await step.sleep(
        `wait-for-mail-verification-${attempt}`,
        attempt <= 10 ? "1 minute" : "1 hour",
      );
      database = await step.do(
        `ensure-project-database-after-mail-${attempt}`,
        PRODUCT_WORKFLOW_STEP_CONFIG,
        () => ports.database.ensure(command, artifact.artifact),
      );
    } else {
      const attempt = ++provisioningAttempts;
      await step.sleep(`wait-for-database-provisioning-${attempt}`, "10 seconds");
      database = await step.do(
        `ensure-project-database-after-provisioning-${attempt}`,
        PRODUCT_WORKFLOW_STEP_CONFIG,
        () => ports.database.ensure(command, artifact.artifact),
      );
    }
  }
  if (database.status === "failed") {
    return failDeployment(
      command,
      workflowId,
      executionId,
      database.errorCode,
      "fail-database-migration",
      step,
      ports,
      null,
      null,
      database.migration ?? null,
    );
  }
  if (database.status !== "ready")
    return reconcile(command, workflowId, executionId, step, ports, emptyProviderHint("database"));
  phase.current = "wfp";
  return activateWfpCandidate(
    command,
    workflowId,
    executionId,
    {
      archive: archive.archive,
      build: started.receipt,
      artifact: artifact.artifact,
      artifactDigest: artifact.artifactDigest,
      database: database.receipt,
    },
    artifact.artifact,
    step,
    ports,
    phase,
  );
}

async function failDeployment(
  command: Extract<
    ProductCommandMessageV1,
    {
      eventType:
        | "DeploymentRequestedV1"
        | "DeploymentPromotionRequestedV1"
        | "DeploymentRollbackRequestedV1";
    }
  >,
  workflowId: string,
  executionId: string,
  errorCode: ProductDeploymentFailureCode,
  stepName: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence">,
  failure: ProductBuildFailure | null = null,
  health: ProductHealthVerdict | null = null,
  migration: ProductDatabaseMigrationFailure | null = null,
): Promise<ProductCommandWorkflowResult> {
  const persistence = await step.do(stepName, PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.persistence.fail({
      workflowId,
      executionId,
      command,
      errorCode,
      failure,
      health,
      migration,
    }),
  );
  return Object.freeze({ status: "failed" as const, persistence });
}

async function runRollback(
  command: Extract<ProductCommandMessageV1, { eventType: "DeploymentRollbackRequestedV1" }>,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence" | "wfp">,
  phase: ProductWorkflowPhase,
): Promise<ProductCommandWorkflowResult> {
  const prepared = await step.do(
    "prepare-immutable-rollback-candidate",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.wfp.prepareRollback(command),
  );
  if (prepared.status === "uncertain") {
    return reconcile(command, workflowId, executionId, step, ports, prepared.providerHint);
  }
  let candidate: ProductWfpCandidate = Object.freeze({
    candidateReceiptId: prepared.candidateReceiptId,
    operationId: command.operationId,
    receipt: prepared.receipt,
    previousGateway: prepared.previousGateway,
    runtimePolicy: prepared.runtimePolicy,
    runtimeSecretDeliveryStage: prepared.runtimeSecretDeliveryStage,
    scheduledFunctions: prepared.scheduledFunctions,
    deploymentUrl: prepared.deploymentUrl,
    artifactDigest: prepared.artifactDigest,
  });
  phase.candidate = candidate;
  if (candidate.candidateReceiptId === null)
    throw new TypeError("Rollback candidate has no persisted receipt ID");
  const candidateReceiptId = candidate.candidateReceiptId;
  const recordedStage = await step.do(
    "record-rollback-runtime-secret-candidate-stage",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.wfp.recordStagedCandidate(command, candidateReceiptId, candidate),
  );
  if (recordedStage.status === "uncertain")
    return reconcile(command, workflowId, executionId, step, ports, recordedStage.providerHint);
  candidate = Object.freeze({
    ...candidate,
    runtimeSecretDeliveryStage: recordedStage.runtimeSecretDeliveryStage,
  });
  phase.candidate = candidate;
  phase.activationAttempted = true;
  const activated = await step.do(
    "activate-rollback-project-gateway",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.wfp.activate(command, candidate),
  );
  let observed:
    | ({ readonly status: "activated" } & ProductWfpGatewayActivation)
    | ({
        readonly status: "unhealthy";
        readonly health?: ProductHealthVerdict | null;
      } & ProductWfpGatewayActivation)
    | { readonly status: "absent" }
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint } =
    activated;
  if (observed.status === "uncertain") {
    observed = await step.do("observe-rollback-project-gateway", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
      ports.wfp.observeActivation(command, candidate),
    );
  }
  if (observed.status === "uncertain") {
    return reconcile(command, workflowId, executionId, step, ports, observed.providerHint);
  }
  if (observed.status === "absent") {
    return reconcile(
      command,
      workflowId,
      executionId,
      step,
      ports,
      emptyProviderHint("gateway", candidate.artifactDigest),
    );
  }
  const activation: ProductWfpGatewayActivation = Object.freeze({
    candidateReceipt: observed.candidateReceipt,
    gateway: observed.gateway,
    deploymentUrl: observed.deploymentUrl,
  });
  phase.activation = activation;
  if (observed.status === "unhealthy") {
    if (observed.health !== undefined && observed.health !== null)
      await recordHealthFailure(command, workflowId, executionId, observed.health, step, ports);
    const restored = await step.do(
      "restore-pre-rollback-project-gateway",
      PRODUCT_WORKFLOW_STEP_CONFIG,
      () => ports.wfp.restoreGateway(command, candidate, activation),
    );
    // Same distinction as the deploy path: a candidate that failed its health check is a verdict on
    // the customer's application, and the previous gateway is back, so there is nothing for an
    // operator to observe. Only a restore whose own outcome is unknown is genuinely uncertain.
    if (restored.status === "uncertain") {
      return reconcile(command, workflowId, executionId, step, ports, restored.providerHint);
    }
    return failDeployment(
      command,
      workflowId,
      executionId,
      "RUNTIME_CANDIDATE_FAILED",
      "fail-unhealthy-rollback-candidate",
      step,
      ports,
      null,
      observed.health ?? null,
    );
  }
  const recordedActivation = await step.do(
    "record-rollback-runtime-secret-activation",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.wfp.recordActivatedCandidate(command, candidate, activation),
  );
  if (recordedActivation.status === "uncertain")
    return reconcile(
      command,
      workflowId,
      executionId,
      step,
      ports,
      recordedActivation.providerHint,
    );
  const finalization = await step.do(
    "finalize-immutable-rollback",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () =>
      ports.persistence.finalizeRollback({
        workflowId,
        executionId,
        command,
        evidence: Object.freeze({
          buildReused: true,
          artifactDigest: candidate.artifactDigest,
          wfp: candidate.receipt,
          gateway: activation.gateway,
          deploymentUrl: activation.deploymentUrl,
          runtimePolicy: candidate.runtimePolicy,
          scheduledFunctions: candidate.scheduledFunctions,
        }),
      }),
  );
  if (finalization === "conflict") {
    const restored = await step.do(
      "restore-conflicted-rollback-gateway",
      PRODUCT_WORKFLOW_STEP_CONFIG,
      () => ports.wfp.restoreGateway(command, candidate, activation),
    );
    if (restored.status === "uncertain") {
      return reconcile(command, workflowId, executionId, step, ports, restored.providerHint);
    }
    return reconcile(
      command,
      workflowId,
      executionId,
      step,
      ports,
      emptyProviderHint("wfp", candidate.artifactDigest),
    );
  }
  return Object.freeze({ status: "succeeded" as const, persistence: finalization });
}

async function runPromotion(
  command: Extract<ProductCommandMessageV1, { eventType: "DeploymentPromotionRequestedV1" }>,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "cleanup" | "database" | "persistence" | "wfp">,
  phase: ProductWorkflowPhase,
): Promise<ProductCommandWorkflowResult> {
  let resources = await step.do(
    "ensure-promotion-target-resources",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.database.ensure(command),
  );
  let mailAttempts = 0,
    provisioningAttempts = 0;
  while (
    (resources.status === "verification_pending" && mailAttempts < 72) ||
    (resources.status === "provisioning_pending" &&
      provisioningAttempts < PRODUCT_DATABASE_PROVISIONING_POLL_LIMIT)
  ) {
    if (resources.status === "verification_pending") {
      const attempt = ++mailAttempts;
      await step.sleep(
        `wait-for-promotion-mail-verification-${attempt}`,
        attempt <= 10 ? "1 minute" : "1 hour",
      );
      resources = await step.do(
        `ensure-promotion-resources-after-mail-${attempt}`,
        PRODUCT_WORKFLOW_STEP_CONFIG,
        () => ports.database.ensure(command),
      );
    } else {
      const attempt = ++provisioningAttempts;
      await step.sleep(`wait-for-promotion-database-provisioning-${attempt}`, "10 seconds");
      resources = await step.do(
        `ensure-promotion-resources-after-provisioning-${attempt}`,
        PRODUCT_WORKFLOW_STEP_CONFIG,
        () => ports.database.ensure(command),
      );
    }
  }
  if (resources.status === "failed")
    return failDeployment(
      command,
      workflowId,
      executionId,
      resources.errorCode,
      "fail-promotion-migration",
      step,
      ports,
      null,
      null,
      resources.migration ?? null,
    );
  if (resources.status !== "ready") {
    return reconcile(command, workflowId, executionId, step, ports, emptyProviderHint("database"));
  }
  return activateWfpCandidate(
    command,
    workflowId,
    executionId,
    { buildReused: true },
    undefined,
    step,
    ports,
    phase,
  );
}

async function activateWfpCandidate(
  command: WfpMutationCommand,
  workflowId: string,
  executionId: string,
  baseEvidence: Readonly<Record<string, unknown>>,
  artifact: unknown | undefined,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "cleanup" | "persistence" | "wfp">,
  phase?: ProductWorkflowPhase,
): Promise<ProductCommandWorkflowResult> {
  const staged = await step.do("stage-immutable-wfp-candidate", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.wfp.stage(command, artifact),
  );
  if (staged.status === "uncertain") {
    return reconcile(command, workflowId, executionId, step, ports, staged.providerHint);
  }
  if (staged.status === "failed") {
    // The provider refused the script itself; no retry or reconciliation can change that.
    if (command.eventType === "DeploymentRollbackRequestedV1")
      throw new TypeError("Rollback cannot stage a new immutable candidate");
    return failDeployment(
      command,
      workflowId,
      executionId,
      staged.errorCode,
      "fail-rejected-wfp-candidate",
      step,
      ports,
    );
  }
  let candidate: ProductWfpCandidate = Object.freeze({
    candidateReceiptId: null,
    operationId: command.operationId,
    receipt: staged.receipt,
    previousGateway: staged.previousGateway,
    runtimePolicy: staged.runtimePolicy,
    runtimeSecretDeliveryStage: staged.runtimeSecretDeliveryStage,
    scheduledFunctions: staged.scheduledFunctions,
    deploymentUrl: staged.deploymentUrl,
    artifactDigest: staged.artifactDigest,
  });
  if (phase !== undefined) {
    phase.candidate = candidate;
    phase.candidateEvidence = baseEvidence;
  }
  if (
    !nonEmpty(candidate.artifactDigest) ||
    !nonEmpty(candidate.deploymentUrl) ||
    (typeof baseEvidence["artifactDigest"] === "string" &&
      baseEvidence["artifactDigest"] !== candidate.artifactDigest)
  ) {
    return reconcile(
      command,
      workflowId,
      executionId,
      step,
      ports,
      emptyProviderHint("wfp", candidate.artifactDigest),
    );
  }
  const persisted = await step.do(
    "persist-immutable-wfp-candidate",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () =>
      ports.persistence.recordCandidate({
        workflowId,
        executionId,
        command,
        candidate,
        evidence: baseEvidence,
      }),
  );
  if (phase !== undefined)
    phase.candidate = Object.freeze({
      ...candidate,
      candidateReceiptId: persisted.candidateReceiptId,
    });
  if (phase !== undefined) {
    const activationRuntimePolicy = requireActivationRuntimePolicy(candidate.runtimePolicy);
    phase.current = "wfp";
    phase.expectedArtifactDigest = candidate.artifactDigest;
    phase.activationRuntimePolicy = activationRuntimePolicy;
  }
  if (command.eventType === "DeploymentRollbackRequestedV1")
    throw new TypeError("Rollback cannot stage a new immutable candidate");
  const recordedStage = await step.do(
    "record-runtime-secret-candidate-stage",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.wfp.recordStagedCandidate(command, persisted.candidateReceiptId, candidate),
  );
  if (recordedStage.status === "uncertain")
    return reconcile(command, workflowId, executionId, step, ports, recordedStage.providerHint);
  candidate = Object.freeze({
    ...candidate,
    candidateReceiptId: persisted.candidateReceiptId,
    runtimeSecretDeliveryStage: recordedStage.runtimeSecretDeliveryStage,
  });
  if (phase !== undefined) phase.candidate = candidate;
  const preActivationFence = await step.do(
    "authorize-candidate-activation",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.persistence.authorizeActivation(command, candidate),
  );
  if (!preActivationFence.allowed) {
    return compensateSupersededCandidate(
      command,
      workflowId,
      executionId,
      candidate,
      null,
      preActivationFence.supersededById,
      step,
      ports,
    );
  }
  let activated:
    | ({ readonly status: "activated" } & ProductWfpGatewayActivation)
    | ({
        readonly status: "unhealthy";
        readonly health?: ProductHealthVerdict | null;
      } & ProductWfpGatewayActivation)
    | { readonly status: "absent" }
    | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint };
  let activationAttempted = false;
  if (executionId === workflowId) {
    activationAttempted = true;
    if (phase !== undefined) phase.activationAttempted = true;
    activated = await step.do(
      "activate-project-gateway-candidate",
      PRODUCT_ACTIVATION_STEP_CONFIG,
      () => ports.wfp.activate(command, candidate),
    );
  } else {
    activated = await step.do(
      "observe-replayed-project-gateway-activation",
      PRODUCT_WORKFLOW_STEP_CONFIG,
      () => ports.wfp.observeActivation(command, candidate),
    );
    if (
      activated.status === "absent" ||
      (activated.status === "uncertain" && candidate.previousGateway !== null)
    ) {
      activationAttempted = true;
      if (phase !== undefined) phase.activationAttempted = true;
      activated = await step.do(
        "activate-project-gateway-candidate",
        PRODUCT_ACTIVATION_STEP_CONFIG,
        () => ports.wfp.activate(command, candidate),
      );
    }
  }
  if (activated.status === "uncertain" && activationAttempted) {
    activated = await step.do(
      "observe-project-gateway-activation",
      PRODUCT_WORKFLOW_STEP_CONFIG,
      () => ports.wfp.observeActivation(command, candidate),
    );
  }
  if (activated.status === "uncertain") {
    return reconcile(command, workflowId, executionId, step, ports, activated.providerHint);
  }
  if (activated.status === "absent") {
    return cleanupCandidateForReconciliation(
      command,
      workflowId,
      executionId,
      candidate,
      step,
      ports,
    );
  }
  const activation: ProductWfpGatewayActivation = Object.freeze({
    candidateReceipt: activated.candidateReceipt,
    gateway: activated.gateway,
    deploymentUrl: activated.deploymentUrl,
  });
  if (phase !== undefined) phase.activation = activation;
  if (activated.status === "unhealthy") {
    return cleanupCandidateForReconciliation(
      command,
      workflowId,
      executionId,
      candidate,
      step,
      ports,
      activation,
      activated.health ?? null,
    );
  }
  const postActivationFence = await step.do(
    "authorize-candidate-finalization",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.persistence.authorizeActivation(command, candidate),
  );
  if (!postActivationFence.allowed) {
    return compensateSupersededCandidate(
      command,
      workflowId,
      executionId,
      candidate,
      activation,
      postActivationFence.supersededById,
      step,
      ports,
    );
  }
  const recordedActivation = await step.do(
    "record-runtime-secret-candidate-activation",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.wfp.recordActivatedCandidate(command, candidate, activation),
  );
  if (recordedActivation.status === "uncertain")
    return reconcile(
      command,
      workflowId,
      executionId,
      step,
      ports,
      recordedActivation.providerHint,
    );
  const finalization = await step.do(
    "finalize-immutable-wfp-candidate",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () =>
      ports.persistence.finalizeCandidate({
        workflowId,
        executionId,
        command,
        evidence: Object.freeze({
          ...baseEvidence,
          artifactDigest: candidate.artifactDigest,
          wfp: candidate.receipt,
          gateway: activation.gateway,
          deploymentUrl: activation.deploymentUrl,
          runtimePolicy: candidate.runtimePolicy,
          scheduledFunctions: candidate.scheduledFunctions,
        }),
      }),
  );
  if (typeof finalization !== "string") {
    if (finalization.status === "binding_refresh_pending") {
      if (command.eventType !== "DeploymentRequestedV1" || artifact === undefined)
        throw new TypeError("Binding refresh has no accepted deployment artifact");
      return finishBindingRefresh(command, workflowId, executionId, artifact, step, ports);
    }
    return reconcile(
      command,
      workflowId,
      executionId,
      step,
      ports,
      emptyProviderHint(
        "wfp",
        candidate.artifactDigest,
        requireActivationRuntimePolicy(candidate.runtimePolicy),
      ),
    );
  }
  return Object.freeze({ status: "succeeded" as const, persistence: finalization });
}

async function finishBindingRefresh(
  command: Extract<ProductCommandMessageV1, { eventType: "DeploymentRequestedV1" }>,
  workflowId: string,
  executionId: string,
  artifact: unknown,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence">,
): Promise<ProductCommandWorkflowResult> {
  const completed = await persistenceStep(step, "retire-binding-refresh-source-and-complete", () =>
    ports.persistence.finishBindingRefresh({ command, workflowId, executionId, artifact }),
  );
  if (typeof completed !== "string")
    return reconcile(command, workflowId, executionId, step, ports, emptyProviderHint("wfp"));
  return { status: "succeeded", persistence: parsePersistence(completed) };
}

async function compensateSupersededCandidate(
  command: WfpMutationCommand,
  workflowId: string,
  executionId: string,
  candidate: ProductWfpCandidate,
  activation: ProductWfpGatewayActivation | null,
  supersededById: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "cleanup" | "persistence" | "wfp">,
): Promise<ProductCommandWorkflowResult> {
  const claim = await step.do(
    "prepare-superseded-candidate-cleanup",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () =>
      ports.persistence.prepareCandidateCleanup({
        command,
        candidate,
        reason: "superseded",
        supersededById,
      }),
  );
  const cleanup = await cleanupCandidate(command, claim, activation, step, ports);
  if (cleanup.status === "uncertain") {
    return reconcile(command, workflowId, executionId, step, ports, cleanup.providerHint);
  }
  await step.do("persist-superseded-candidate-cleanup", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.persistence.recordCandidateCleanup({ command, claim, cleanup }),
  );
  const persistence = await step.do(
    "terminalize-superseded-candidate",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () =>
      ports.persistence.markCandidateSuperseded({
        workflowId,
        executionId,
        command,
        candidate,
        claim,
      }),
  );
  return Object.freeze({ status: "superseded" as const, persistence });
}

async function cleanupCandidateForReconciliation(
  command: WfpMutationCommand,
  workflowId: string,
  executionId: string,
  candidate: ProductWfpCandidate,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "cleanup" | "persistence" | "wfp">,
  activation: ProductWfpGatewayActivation | null = null,
  health: ProductHealthVerdict | null = null,
): Promise<ProductCommandWorkflowResult> {
  if (activation !== null && health !== null)
    await recordHealthFailure(command, workflowId, executionId, health, step, ports);
  const claim = await step.do(
    "prepare-failed-candidate-cleanup",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () =>
      ports.persistence.prepareCandidateCleanup({
        command,
        candidate,
        reason: activation === null ? "failed" : "compensate",
        supersededById: null,
      }),
  );
  const cleanup = await cleanupCandidate(command, claim, activation, step, ports);
  if (cleanup.status === "uncertain") {
    return reconcile(command, workflowId, executionId, step, ports, cleanup.providerHint);
  }
  await step.do("persist-failed-candidate-cleanup", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.persistence.recordCandidateCleanup({ command, claim, cleanup }),
  );
  if (
    activation !== null &&
    (command.eventType === "DeploymentRequestedV1" ||
      command.eventType === "DeploymentPromotionRequestedV1")
  ) {
    // An unhealthy candidate is a verdict on the customer's application, not an unknown provider
    // state: it was compensated and removed, so an operator has nothing left to reconcile. Failing
    // the deployment names the cause; requiring reconciliation would leave the operation running.
    return failDeployment(
      command,
      workflowId,
      executionId,
      "RUNTIME_CANDIDATE_FAILED",
      "fail-unhealthy-runtime-candidate",
      step,
      ports,
      null,
      health,
    );
  }
  return reconcile(
    command,
    workflowId,
    executionId,
    step,
    ports,
    emptyProviderHint("wfp", candidate.artifactDigest),
  );
}

async function recordHealthFailure(
  command: WfpMutationCommand,
  workflowId: string,
  executionId: string,
  health: ProductHealthVerdict,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence">,
): Promise<void> {
  await step.do("record-unhealthy-candidate-health", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.persistence.recordHealthFailure({ workflowId, executionId, command, health }),
  );
}

async function cleanupCandidate(
  command: WfpMutationCommand,
  claim: ProductWfpCandidateCleanupClaim,
  activation: ProductWfpGatewayActivation | null,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "cleanup" | "wfp">,
): Promise<
  | ({
      readonly status: "compensated" | "removed" | "not_found";
    } & ProductWfpCandidateCleanupEvidence)
  | { readonly status: "uncertain"; readonly providerHint: ProductProviderReconciliationHint }
> {
  const wfp = await step.do(
    "compensate-project-gateway-candidate",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    async () => {
      if (activation === null) return ports.wfp.removeCandidate(command, claim);
      return ports.wfp.compensate(command, claim, activation);
    },
  );
  if (wfp.status === "uncertain") return wfp;
  const operation = await step.do(
    "remove-superseded-operation-artifacts",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.cleanup.removeOperationArtifacts(command, claim),
  );
  if (operation.status === "uncertain") return operation;
  return Object.freeze({ ...wfp, operationResources: operation.evidence });
}

/**
 * Moves a project to the address its customer chose. Every published gateway is re-published at the
 * new address first; the address is stored only once they all serve it, so a half-applied rename
 * never leaves the project answering on two addresses.
 */
async function runHandleChange(
  command: Extract<ProductCommandMessageV1, { eventType: "ProjectHandleChangeRequestedV1" }>,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence" | "wfp">,
): Promise<ProductCommandWorkflowResult> {
  const environments = await step.do(
    "read-project-gateway-addresses",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => ports.persistence.readGatewayAddressMoves(command),
  );
  const moved: Array<Readonly<{ environmentId: string; publicOrigin: string }>> = [];
  for (const environment of environments) {
    const outcome = await step.do(
      `move-gateway-address-${environment.environmentName}`,
      PRODUCT_WORKFLOW_STEP_CONFIG,
      () => ports.wfp.moveGatewayAddress(command, environment, command.requestedHandle),
    );
    if (outcome.status !== "moved") {
      return reconcile(command, workflowId, executionId, step, ports, outcome.providerHint);
    }
    if (!nonEmpty(outcome.publicOrigin)) {
      return reconcile(command, workflowId, executionId, step, ports, emptyProviderHint("wfp"));
    }
    moved.push(
      Object.freeze({
        environmentId: environment.environmentId,
        publicOrigin: outcome.publicOrigin,
      }),
    );
  }
  const finalized = await persistenceStep(step, "store-chosen-project-address", () =>
    ports.persistence.finalizeHandleChange({
      workflowId,
      executionId,
      command,
      moved,
      evidence: { requestedHandle: command.requestedHandle, environments: moved.length },
    }),
  );
  if (typeof finalized !== "string") {
    // The same Control transaction that refused the chosen handle restored every route.
    return failHandleChange(command, workflowId, executionId, step, ports);
  }
  return { status: "succeeded", persistence: parsePersistence(finalized) };
}

async function failHandleChange(
  command: Extract<ProductCommandMessageV1, { eventType: "ProjectHandleChangeRequestedV1" }>,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence">,
): Promise<ProductCommandWorkflowResult> {
  const persistence = await persistenceStep(step, "fail-taken-project-address", () =>
    ports.persistence.complete({
      workflowId,
      executionId,
      command,
      evidence: { requestedHandle: command.requestedHandle, outcome: "project_handle_taken" },
    }),
  );
  return { status: "failed", persistence: parsePersistence(persistence) };
}

/** The accepted snapshot stays fixed across retries; no phase copies customer records. */
async function runDataChange(
  command: ProjectDataChangeRequestedV1,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence" | "dataChange">,
): Promise<ProductCommandWorkflowResult> {
  const data = ports.dataChange;
  if (data === undefined) throw new TypeError("Data change ports are unavailable");
  const plan = await step.do("read-data-change-snapshot", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    data.readPlan(command),
  );
  const revoked = await step.do(
    "revoke-data-change-database-access",
    PRODUCT_WORKFLOW_STEP_CONFIG,
    () => data.revokeDatabaseAccess(command),
  );
  if (revoked.status !== "ready") return reconcile(command, workflowId, executionId, step, ports);
  for (const target of plan.reauthorizations.filter((target) => target.direction === "narrow")) {
    const outcome = await step.do(
      `narrow-database-${target.dataEnvironmentId}`,
      PRODUCT_WORKFLOW_STEP_CONFIG,
      () => data.reauthorize(command, target.dataEnvironmentId, "narrow"),
    );
    if (outcome.status !== "ready") return reconcile(command, workflowId, executionId, step, ports);
  }
  if (plan.removeDevDeployment) {
    const removed = await step.do(
      "remove-data-change-dev-deployment",
      PRODUCT_WORKFLOW_STEP_CONFIG,
      () => data.removeDevDeployment(command),
    );
    if (removed.status !== "ready") return reconcile(command, workflowId, executionId, step, ports);
  }
  await step.do("switch-data-environment-assignments", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    data.switchAssignments(command),
  );
  for (const target of plan.reauthorizations.filter((target) => target.direction === "widen")) {
    const outcome = await step.do(
      `widen-database-${target.dataEnvironmentId}`,
      PRODUCT_WORKFLOW_STEP_CONFIG,
      () => data.reauthorize(command, target.dataEnvironmentId, "widen"),
    );
    if (outcome.status !== "ready") return reconcile(command, workflowId, executionId, step, ports);
  }
  let deletedFiles = 0;
  let deletedDatabase = false;
  for (const dataEnvironmentId of plan.retiredDataEnvironmentIds) {
    let purged: Awaited<ReturnType<ProductDataChangePort["purgeFiles"]>> = { status: "uncertain" };
    // Upload drain waits and confirmed 1,000-key pages have separate budgets. A large area must
    // not spend its page budget waiting for the old signed PUT capability and SDK timeout.
    let expiryWaits = 0;
    let completedPages = 0;
    for (let attempt = 0; attempt < 1008; attempt += 1) {
      purged = await step.do(
        `purge-data-files-${dataEnvironmentId}-${attempt}`,
        PRODUCT_WORKFLOW_STEP_CONFIG,
        () => data.purgeFiles(command, dataEnvironmentId),
      );
      if (purged.status !== "pending") break;
      if (
        !Number.isSafeInteger(purged.retryAfterSeconds) ||
        purged.retryAfterSeconds < 1 ||
        purged.retryAfterSeconds > 300
      )
        throw new TypeError("Retired upload wait is invalid");
      if (purged.progress === "page_completed") {
        completedPages += 1;
        if (completedPages >= 1000) break;
        continue;
      }
      if (purged.progress !== undefined) throw new TypeError("Retired file progress is invalid");
      if (expiryWaits >= 7) break;
      await step.sleep(`wait-for-old-upload-${dataEnvironmentId}-${expiryWaits}`, "1 minute");
      expiryWaits += 1;
    }
    if (purged.status !== "ready") return reconcile(command, workflowId, executionId, step, ports);
    if (!Number.isSafeInteger(purged.deletedFiles) || purged.deletedFiles < 0)
      throw new TypeError("Deleted file count is invalid");
    deletedFiles += purged.deletedFiles;
    const retired = await step.do(
      `delete-retired-database-${dataEnvironmentId}`,
      PRODUCT_WORKFLOW_STEP_CONFIG,
      () => data.retireDatabase(command, dataEnvironmentId),
    );
    if (retired.status !== "ready") return reconcile(command, workflowId, executionId, step, ports);
    if (typeof retired.deletedDatabase !== "boolean")
      throw new TypeError("Retired database deletion evidence is invalid");
    deletedDatabase ||= retired.deletedDatabase;
  }
  return complete(
    command,
    workflowId,
    executionId,
    {
      schemaVersion: "ohmyhost.operation-data-change-result/v1",
      operationId: command.operationId,
      change: command.dataChange,
      data_mode: plan.dataModeAfter,
      redeploy_environments: plan.redeployEnvironments,
      deleted_database: deletedDatabase,
      deleted_files: deletedFiles,
    },
    step,
    ports,
  );
}

async function runDeletion(
  command: Extract<ProductCommandMessageV1, { eventType: "ProjectDeletionRequestedV1" }>,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence" | "schedules" | "wfp">,
): Promise<ProductCommandWorkflowResult> {
  await step.do("remove-project-function-schedules", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.schedules.remove(command),
  );
  const tombstone = await step.do("publish-deletion-tombstone", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.wfp.tombstone(command),
  );
  if (tombstone.status !== "observed" || !nonEmpty(tombstone.tombstoneReceiptId))
    return reconcile(command, workflowId, executionId, step, ports);
  await persistenceStep(step, "retain-deletion-tombstone", () =>
    ports.persistence.retainDeletionTombstone({
      workflowId,
      executionId,
      command,
      tombstoneReceiptId: tombstone.tombstoneReceiptId,
    }),
  );
  const inventory = await step.do("cleanup-run-inventory", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.wfp.cleanupInventory(command),
  );
  const route = await step.do("observe-sustained-route-404", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.wfp.observeRoute404(command, tombstone),
  );
  if (
    inventory.status !== "observed" ||
    !inventory.inventoryClean ||
    route.status !== "observed" ||
    route.consecutive404s < 3
  ) {
    await reconcile(command, workflowId, executionId, step, ports);
    return { status: "reconciliation_required", tombstoneRetained: true };
  }
  await step.sleep("wait-for-tombstone-propagation", PRODUCT_TOMBSTONE_PROPAGATION_DELAY);
  const finalized = await step.do("finalize-deletion-tombstone", PRODUCT_WORKFLOW_STEP_CONFIG, () =>
    ports.wfp.finalizeRemoval(command),
  );
  if (finalized.status !== "observed" || finalized.consecutive404s < 3) {
    await reconcile(command, workflowId, executionId, step, ports);
    return { status: "reconciliation_required", tombstoneRetained: true };
  }
  return complete(
    command,
    workflowId,
    executionId,
    {
      tombstoneReceiptId: tombstone.tombstoneReceiptId,
      inventoryClean: inventory.inventoryClean,
      consecutive404s: finalized.consecutive404s,
      gatewayAbsence: finalized.gatewayAbsence,
    },
    step,
    ports,
  );
}

async function complete(
  command: ProductCommandMessageV1,
  workflowId: string,
  executionId: string,
  evidence: Readonly<Record<string, unknown>>,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence">,
): Promise<ProductCommandWorkflowResult> {
  const persistence = await persistenceStep(step, "persist-product-command-completion", () =>
    ports.persistence.complete({ workflowId, executionId, command, evidence }),
  );
  return { status: "succeeded", persistence: parsePersistence(persistence) };
}

class ProductWorkflowPersistenceError extends Error {
  public constructor(public override readonly cause: unknown) {
    super("Product Workflow persistence failed", { cause });
  }
}

async function persistenceStep<T>(
  step: ProductWorkflowStepPort,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await step.do(name, PRODUCT_WORKFLOW_STEP_CONFIG, run);
  } catch (error) {
    throw new ProductWorkflowPersistenceError(error);
  }
}

async function reconcile(
  command: ProductCommandMessageV1,
  workflowId: string,
  executionId: string,
  step: ProductWorkflowStepPort,
  ports: Pick<ProductCommandWorkflowPorts, "persistence">,
  providerHint: ProductProviderReconciliationHint | null = null,
): Promise<ProductCommandWorkflowResult> {
  const persistence = await persistenceStep(step, "persist-product-command-reconciliation", () =>
    ports.persistence.requireReconciliation({ workflowId, executionId, command, providerHint }),
  );
  parsePersistence(persistence);
  return { status: "reconciliation_required" };
}

function emptyProviderHint(
  phase: ProductProviderReconciliationHint["phase"],
  expectedArtifactDigest: string | null = null,
  activationRuntimePolicy?: ProductProviderReconciliationHint["activationRuntimePolicy"],
): ProductProviderReconciliationHint {
  return Object.freeze({
    phase,
    expectedArtifactDigest,
    currentProviderTag: null,
    currentProductDeploymentId: null,
    ...(activationRuntimePolicy === undefined ? {} : { activationRuntimePolicy }),
  });
}

function requireActivationRuntimePolicy(
  value: unknown,
): NonNullable<ProductProviderReconciliationHint["activationRuntimePolicy"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("WFP candidate runtime policy is invalid");
  const policy = value as Readonly<Record<string, unknown>>;
  if (
    ![
      "egressAllowedOrigins,healthCheckPath",
      "browser,egressAllowedOrigins,healthCheckPath",
    ].includes(Object.keys(policy).sort().join(",")) ||
    typeof policy["healthCheckPath"] !== "string" ||
    !Array.isArray(policy["egressAllowedOrigins"]) ||
    policy["egressAllowedOrigins"].some((origin) => typeof origin !== "string")
  ) {
    throw new TypeError("WFP candidate runtime policy is invalid");
  }
  return Object.freeze({
    healthCheckPath: policy["healthCheckPath"],
    egressAllowedOrigins: Object.freeze((policy["egressAllowedOrigins"] as string[]).slice()),
    ...(Object.hasOwn(policy, "browser") ? { browser: parseBrowserPolicy(policy["browser"]) } : {}),
  });
}

function parsePersistence(value: unknown): "applied" | "duplicate" {
  if (value !== "applied" && value !== "duplicate")
    throw new TypeError("Product command persistence returned an unsupported outcome");
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
