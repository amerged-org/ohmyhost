import * as connectionActions from "./catalog/connections/actions.js";
import * as connectionImports from "./catalog/connections/imports.js";
import * as connectionGrants from "./catalog/connections/grants.js";
import * as connectionPortal from "./catalog/connections/portal.js";
import * as connectionAttempts from "./catalog/connections/attempts.js";
import * as previewCustomer from "./catalog/previews/customer.js";
import * as previewCleanup from "./catalog/previews/cleanup.js";
import * as previewGithub from "./catalog/previews/github.js";
import * as previewRuntime from "./catalog/previews/runtime.js";
import * as previewUsage from "./catalog/previews/usage.js";
import * as previewSecrets from "./catalog/previews/secrets.js";
import * as previewNativeAuth from "./catalog/previews/native-auth.js";
import * as previewNativePreparation from "./catalog/previews/native-preparation.js";
import { readGrowthFactPage, resolveGrowthStripeCustomer } from "./catalog/growth/facts.js";
import { proveNativeAuthUnprovisionedPolicy } from "./catalog/identity/native-auth-unprovisioned-policy.js";
import { parseNativeAuthLaunchPolicy } from "./catalog/identity/native-auth-launch-policy.js";
import { admitPaidProjectDomain } from "./catalog/billing/paid-domain-admission.js";
import {
  readMcpAuthorizedMemberships,
  readMcpEnvironmentName,
  readMcpMailDomainOrganization,
  readMcpProjectOrganization,
  readMcpGrantRevision,
  readMcpRecoveryContext,
  authorizeMcpExecution,
  readMcpPlanEnvironmentName,
} from "./catalog/identity/api-mcp-reads.js";
import {
  readProjectNotes,
  writeProjectNotes,
  readProjectStorageJurisdiction,
  readPoweredByFlag,
  setPoweredByFlag,
} from "./catalog/projects/api-metadata.js";
import {
  claimR2Bucket,
  authorizeR2Bucket,
  proveR2BucketAbsence,
  putR2Bucket,
  readR2Bucket,
  supersedeR2BucketReservation,
} from "./catalog/r2-management/buckets.js";
import { readR2Confirmed } from "./catalog/r2-management/confirmed-storage.js";
import { listParkedRows } from "./catalog/maintenance/parked-rows.js";
import * as providerRecovery from "./catalog/provisioning/provider-reconciliation.js";
import * as queueRecovery from "./catalog/provisioning/queue-delivery-recovery.js";
import * as workflowReplay from "./catalog/provisioning/workflow-replay-recovery.js";
import * as lostCommand from "./catalog/provisioning/lost-command-recovery.js";
import { reconcileRecoveredProductWorkflow } from "./catalog/provisioning/recovered-workflow-reconciliation.js";
import * as managedSourceReads from "./catalog/product-api/managed-source-reads.js";
import * as managedSourceBlobs from "./catalog/product-api/managed-source-blobs.js";
import * as managedSourceJournal from "./catalog/product-api/managed-source-journal.js";
import * as managedSourceProcessor from "./catalog/product-api/managed-source-processor.js";
import * as productApiReads from "./catalog/product-api/reads.js";
import * as productApiPlanningReads from "./catalog/product-api/planning-reads.js";
import * as productApiRollback from "./catalog/product-api/rollback-target.js";
import * as productApiPlanning from "./catalog/product-api/planning-commands.js";
import * as productApiAutoDeploy from "./catalog/product-api/auto-deploy.js";
import * as productApiReplay from "./catalog/product-api/replay.js";
import * as productApiOperation from "./catalog/product-api/operation.js";
import * as productApiAcceptance from "./catalog/product-api/accept-product.js";
import * as productApiDataChange from "./catalog/product-api/data-changes.js";
import * as webhookLifecycle from "./catalog/database/webhook-lifecycle.js";
import { createPublicEntryCommands } from "./catalog/public-entry/commands.js";
import { createStorageGatewayCommands } from "./catalog/storage-gateway/commands.js";
import { createPublicCreditCommands } from "./catalog/billing/public-commands.js";
import { createCreditCommands } from "./catalog/credit/runtime.js";
import { readGatewayRuntimeCreditDecision } from "./catalog/billing/gateway-credit-decision.js";
import {
  completeProductLifecycleCommand,
  retainProductDeletionTombstone,
} from "./catalog/provisioning/lifecycle-completion.js";
import {
  readLifecycleDeletionEvidence,
  readLifecycleCleanupResources,
  recordLifecycleCleanupAttempt,
  deleteLifecycleSchedules,
  readLifecycleManagedSourceInventory,
} from "./catalog/provisioning/lifecycle-inventory.js";
import {
  startLifecycleDataChange,
  switchLifecycleDataAssignments,
} from "./catalog/provisioning/project-data-change.js";
import { readProductRollbackDataTarget } from "./catalog/provisioning/rollback-data-target.js";
import { renewProductOperationLease } from "./catalog/provisioning/operation-lease.js";
import { finalizeProductHandleChange } from "./catalog/provisioning/project-handle-completion.js";
import { reconcileProductWorkflow } from "./catalog/provisioning/deployment-reconciliation.js";
import {
  prepareProductCandidateCleanup,
  claimProductCandidateCleanup,
  recordProductCandidateCleanup,
  markProductCandidateSuperseded,
} from "./catalog/provisioning/deployment-cleanup.js";
import {
  recordProductDeploymentCandidate,
  recordAbandonedGatewayPredecessor,
  readProductDataEnvironment,
  resolveProductRollbackCandidate,
} from "./catalog/provisioning/deployment-candidate.js";
import {
  finalizeProductCandidate,
  finalizeProductRollback,
  readPendingNativePolicySync,
  completeNativePolicySync,
  assertProductBindingRefresh,
  finishProductBindingRefresh,
} from "./catalog/provisioning/deployment-finalization.js";
import {
  assertProductOperationExecution,
  authorizeProductActivation,
} from "./catalog/provisioning/deployment-authorization.js";
import { authorizeProductProviderMutation } from "./catalog/provisioning/provider-authorization.js";
import { completeSourceLink } from "./catalog/provisioning/source-completion.js";
import {
  activateProductProviderReconciliationAttempt,
  activateProductWorkflowReplayAttempt,
} from "./catalog/provisioning/attempt-activation.js";
import {
  claimGeneralCloudflareAuthorization,
  consumeGeneralCloudflareAuthorization,
  putGeneralCloudflareGrant,
  readGeneralCloudflareGrant,
  readGeneralCloudflareStatus,
} from "./catalog/cloudflare/authorization.js";
import { configureGeneralCloudflareDomains } from "./catalog/cloudflare/configure.js";
import {
  readGeneralCloudflareDeletion,
  rotateGeneralCloudflareDeletionGrant,
  prepareGeneralCloudflareRevocation,
  restartGeneralCloudflareRevocation,
  finalizeGeneralCloudflareDeletion,
} from "./catalog/cloudflare/deletion.js";
import {
  readGeneralCloudflareReconciliation,
  rotateGeneralCloudflareGrant,
} from "./catalog/cloudflare/reconciliation.js";
import {
  readPaidDomainTarget,
  readPaidDomainRecord,
  readPaidDomainProof,
  ensurePaidDomainProof,
  verifyPaidDomainProof,
  claimPaidDomainApply,
  putPaidDomainActive,
  claimPaidDomainDelete,
  markPaidDomainDeleted,
  claimPaidProjectDeletion,
} from "./catalog/cloudflare/paid.js";
import {
  claimGeneralCloudflareGrantUse,
  renewGeneralCloudflareGrantUse,
  finishGeneralCloudflareGrantUse,
  releaseGeneralCloudflareGrantUse,
} from "./catalog/cloudflare/grant-use.js";
import {
  recordProductSourceArchiveEvidence,
  observeSourceArchiveReceipt,
} from "./catalog/provisioning/source-custody.js";
import {
  recordConsumerDiagnostic,
  purgeConsumerDiagnostics,
} from "./catalog/diagnostics/consumer.js";
import {
  readFunctionSchedules,
  insertFunctionRuns,
  claimScheduledFunctionRuns,
  finishScheduledFunctionRun,
  purgeScheduledFunctionRuns,
} from "./catalog/functions-scheduler.js";
import {
  requireMailOrganizationPaid,
  readMailDomainProjection,
  admitMailReceiving,
  configureMailResource,
} from "./catalog/mail/management.js";
import {
  readCfApplicationIdentity,
  declareCfApplicationIdentity,
  replayCfApplicationIdentityAction,
  readCfApplicationIdentityForVerification,
  completeCfApplicationIdentityAction,
  readAutomaticCfApplicationIdentity,
  completeAutomaticCfApplicationIdentity,
} from "./catalog/mail/cf-identity.js";
import {
  readCfWorkspaceMailDnsRequirements,
  readCfLegacyMailDnsRequirements,
  readCfMailDnsDeletionRequirements,
  saveCfWorkspaceMailDnsReceipt,
  saveCfLegacyMailDnsReceipt,
} from "./catalog/mail/cf-dns.js";
import { failProductDeployment } from "./catalog/provisioning/deployment-failure.js";
import {
  readCfScopedAuthorization,
  issueCfScopedAuthorization,
  readCfScopedStatus,
  consumeCfScopedAuthorization,
  saveCfScopedGrant,
  revokeCfScopedAuthorization,
  listRevokedCfScopedGrants,
  wipeRevokedCfScopedGrantTokens,
  listDisplacedCfScopedTokens,
  completeDisplacedCfScopedToken,
  readCfScopedMailCleanup,
  completeEmptyCfScopedMailCleanup,
  claimCfScopedDnsUse,
  renewCfScopedDnsUse,
  authorizeCfScopedDnsUse,
  finishCfScopedDnsUse,
  releaseCfScopedDnsUse,
} from "./catalog/mail/cf-scoped.js";
import {
  claimWorkspaceMailCapabilities,
  readWorkspaceMailCapabilities,
  confirmWorkspaceMailCapabilities,
  releaseWorkspaceMailCapabilities,
} from "./catalog/mail/capabilities.js";

import {
  readCurrentIdentityMappings,
  readAccountProfileFacts,
  recordAccountSignupSource,
} from "./catalog/identity/account-metadata.js";

import {
  listPendingMailLegacyResources,
  claimMailLegacyReconciliation,
  claimMailIdentityRevalidation,
  suspendExpiredMailBindings,
  listPendingMailWorkspaceResources,
  claimMailWorkspaceReconciliation,
} from "./catalog/mail/jobs.js";
import {
  readMailManagementCommand,
  beginMailManagementCommand,
  resumeMailManagementCommand,
  completeMailManagementCommand,
  readWorkspaceMailManagementCommand,
  claimWorkspaceMailRetirementCommand,
} from "./catalog/mail/commands.js";
import {
  readMailDeletionScope,
  prepareMailProjectDeletion,
  recordMailDeletionFoundResource,
  finishMailProjectDeletionResource,
} from "./catalog/mail/deletion.js";
import {
  readMailWorkspaceResource,
  readMailWorkspaceView,
  listMailWorkspaceViews,
  changeMailWorkspaceResource,
  beginMailWorkspaceRetirement,
  finishMailWorkspaceRetirement,
} from "./catalog/mail/workspace.js";

import {
  readMailResourceCustody,
  readMailLegacyWorkspaceResource,
  readMailResourceWorkspaceStatus,
  isMailReceivingOwner,
  hasLiveMailResourceName,
  changeMailResource,
} from "./catalog/mail/resource.js";
import {
  retireMailLegacyWorkspaceResource,
  retireMailResource,
} from "./catalog/mail/retirement.js";
import { recordRuntimeHealthDiagnostic } from "./catalog/provisioning/health-diagnostic.js";
import { claimProductProviderMutation } from "./catalog/provisioning/provider-claim.js";
import {
  readProductWorkflowDatabaseTarget,
  readProductWorkflowContext,
} from "./catalog/provisioning/context.js";
import {
  readProductEntitlementTargets,
  claimProductEntitlement,
  beginProductEntitlement,
  recordProductEntitlement,
  recordProductEntitlementCheckFailure,
} from "./catalog/database/product-entitlements.js";
import {
  replayProductCompute,
  readProductComputeScope,
  acceptProductCompute,
  readProductComputeJob,
  claimProductCompute,
  completeProductCompute,
  recordProductCompute,
  releaseProductComputeUse,
  readProductComputeContext,
  readDueProductCompute,
  acknowledgeProductComputeOutbox,
} from "./catalog/database/product-compute.js";
import {
  readProductDiagnosticTarget,
  issueProductDatabaseAccess,
  readProductDatabaseAccess,
  mutateProductDatabaseAccess,
  markProductDatabaseAccessSweepAttempts,
  readProductDatabaseAccessSweep,
  readProductAccessCreditAdmission,
  readProductDatabaseAdmission,
  recordProductDatabaseEventAudit,
  readDataChangeProductAccess,
} from "./catalog/database/product-access.js";
import {
  expireProductDatabaseWrites,
  acceptProductDatabaseWrite,
  finishProductDatabaseWrite,
  readExpiredProductDatabaseWrites,
  readProductDatabaseOperation,
} from "./catalog/database/product-writes.js";
import {
  recoverProductDispatchExecution,
  claimProjectDispatch,
  recoverProjectDispatch,
  acknowledgeProjectDispatch,
  failProjectDispatch,
  acceptProductDispatch,
  readProductDispatchIntent,
} from "./catalog/provisioning/dispatch.js";
import { readManagedSourceDispatchState } from "./catalog/provisioning/managed-source.js";
import {
  completeProvisioningHello,
  failProvisioningHello,
  reconcileProvisioningHello,
} from "./catalog/provisioning/hello.js";
import {
  readInfrastructureAlertReceipt,
  claimInfrastructureAlert,
  completeInfrastructureAlert,
} from "./catalog/mail/infrastructure.js";
import { createDatabaseProviderCommands } from "./catalog/database/provider-commands.js";
import { readProjectDatabaseAccessHistory } from "./catalog/database/access-history.js";
import { createDatabaseRegistrationCommands } from "./catalog/database/commands.js";
import {
  resolveDatabaseManagementClaim,
  readDatabasePlacementPaidAccess,
  readDatabaseManagementRuntimeBinding,
} from "./catalog/database/management.js";
import { readControlAuthority } from "./catalog/database/control-authority.js";
import { createStripeBillingCommands } from "./catalog/billing/stripe-runtime.js";

import { createRuntimeSecretCommands } from "./catalog/runtime-secrets/commands.js";
import type { PlatformContext } from "./catalog/platform-support.js";
import {
  createInitialProject,
  resolveProjectReservations,
} from "./catalog/projects/create-initial-project.js";
import {
  admitCustomerProject,
  getCustomerProject,
  listCustomerProjects,
  readTakenProjectHandles,
} from "./catalog/projects/customer-projects.js";
import { addDevelopmentEnvironment } from "./catalog/projects/add-development-environment.js";
import {
  authorizeOrganizationAction,
  resolveM2mOrganization,
  resolveWorkosOrganization,
} from "./catalog/projects/customer-projects-access.js";
import { withRouteRefresh } from "./fence.js";
import { acceptApiOperation } from "./catalog/operations/accept-api-operation.js";
import { readAuditEvents } from "./catalog/operations/audit.js";
import {
  authorizeDevAccessSession,
  authorizeDevCombined,
  authorizeDevPage,
  authorizeDevRuntimeProbe,
  issueDevAccessTicket,
  redeemDevAccess,
} from "./catalog/dev-access/access.js";
import { changeDevAccess, readDevShareState } from "./catalog/dev-access/share.js";
import {
  createSharedMailDomain,
  beginSharedMailRetire,
  listExpiredUnverifiedSharedMailDomains,
  completeSharedMailCommand,
  readSharedMailBinding,
  bindSharedMailProject,
  detachSharedMailProject,
} from "./catalog/mail/shared.js";
import * as githubAuthorizations from "./catalog/github/authorizations.js";
import * as githubAutoDeploy from "./catalog/github/auto-deploy.js";
import { revokeGithubInstallationAccess } from "./catalog/github/installation-access.js";
import {
  readDeploymentDiagnostics,
  readEnvironmentFunctionRuns,
} from "./catalog/customer-reads/runs-and-diagnostics.js";
import {
  claimDoorbells,
  healDoorbells,
  ring,
  settleDoorbell,
} from "./catalog/operations/doorbells.js";
import {
  purgeExpiredIdempotencyRecords,
  readStoredIdempotencyResponse,
} from "./catalog/operations/idempotency.js";
import {
  acknowledgeInboxEvent,
  claimInboxEvent,
  failInboxEvent,
  findExpiredFinalInboxClaim,
  recordInboxEvent,
  recoverExpiredFinalInboxLease,
  renewInboxLease,
  routeUnroutedInboxEvents,
} from "./catalog/operations/inbox.js";
import {
  recoverExpiredOperationLease,
  readBlockingProductOperation,
  renewOperationLease,
} from "./catalog/operations/operation-leases.js";
import { loadOperation, transitionOperation } from "./catalog/operations/operation-store.js";
import {
  acknowledgeOutboxEvent,
  claimOutboxEvent,
  recordOutboxDeliveryFailure,
  recoverExpiredFinalOutboxLease,
  requireOutboxReconciliation,
} from "./catalog/operations/outbox.js";
import { queueOperation } from "./catalog/operations/queue-operation.js";
import {
  advanceRetentionHorizon,
  pageEvidenceRows,
  purgeAcknowledgedInbox,
  purgeAcknowledgedOutbox,
  purgeCommandLog,
  purgeEvidenceBelowHorizon,
  purgeMcpHandoffs,
  purgeMembershipBarriers,
  purgeOnboardingRequests,
  purgeRevocations,
  purgeUnroutedInbox,
  purgeReconciliationInbox,
  purgeUserApiKeyRequests,
  recordEvidenceExport,
} from "./catalog/operations/retention.js";
import { assertOperationDelegationCurrent } from "./catalog/identity/operation-delegations.js";
import { purgeMcpHandoffRoutes } from "./catalog/identity/handoff-routes-retention.js";
import {
  completeMcpGithub,
  completeMcpSecret,
  readNativeProviderHandoffState,
  claimNativeProviderHandoff,
  completeNativeProviderHandoff,
  consumeMcpHandoff,
  ensureMcpConnectionProof,
  findMcpHandoff,
  insertMcpHandoff,
  revokeMcpConsent,
} from "./catalog/identity/mcp-delegations.js";
import {
  listOrganizationMcpConnections,
  revokeOrganizationMcpConnection,
} from "./catalog/identity/mcp-workspace-connections.js";
import {
  applyWorkosSnapshot,
  isSessionEligible,
  recordMembershipBarrier,
  recordTerminalRevocation,
} from "./catalog/identity/membership-state.js";
import { createWorkosCallerCommands } from "./catalog/identity/workos-caller-commands.js";
import { createWorkosAuxiliaryCommands } from "./catalog/identity/workos-onboarding.js";
import { createWebhookIngressCommands } from "./catalog/operations/webhook-ingress.js";
import { authorizeNativeAuthOwner } from "./catalog/identity/native-auth-owner.js";
import { readNativeAuthTarget } from "./catalog/identity/native-auth-target.js";
import * as nativeAuthResourceOperations from "./catalog/identity/native-auth-resource-operations.js";
import * as nativeAuthRegistration from "./catalog/identity/native-auth-registration.js";
import * as nativeAuthUserAcceptance from "./catalog/identity/native-auth-user-acceptance.js";
import { readNativeAuthProvisioningPolicy } from "./catalog/identity/native-auth-provisioning-policy.js";
import * as nativeAuthDomainSync from "./catalog/identity/native-auth-domain-sync.js";
import * as nativeAuthDomainRecovery from "./catalog/identity/native-auth-domain-recovery.js";
import { recordNativeAuthProviderSuccess } from "./catalog/identity/native-auth-provider-success.js";
import * as nativeAuthDeletion from "./catalog/provisioning/native-auth-deletion.js";
import * as nativeAuthRestorePreparation from "./catalog/identity/native-auth-restore-preparation.js";
import * as nativeAuthRestoreJob from "./catalog/identity/native-auth-restore-job.js";
import { observeNativeRestoreJob } from "./catalog/identity/native-auth-restore-observation.js";
import { readNativeRestoreForSanitization } from "./catalog/identity/native-auth-restore.js";
import {
  authorizeNativeMail,
  readNativeAuthReadiness,
} from "./catalog/identity/native-auth-readiness.js";
import {
  resolveNativeAuthAuthority,
  resolveNativeAuthAtomicSnapshot,
  resolveNativeAuthAdminAuthority,
  authorizeNativeAuthOwnerOperation,
  resolveNativeAuthProviderPolicy,
} from "./catalog/identity/native-auth-authority.js";
import {
  readNativeAuthConfig,
  updateNativeAuthConfig,
  readNativeAuthProvider,
  updateNativeAuthProvider,
  readNativeAuthProviderEnvelope,
} from "./catalog/identity/native-auth-config.js";
import { createWorkosPollerCommands } from "./catalog/identity/workos-poller.js";
import {
  authorizeUserApiKeyScope,
  claimUserApiKeyCreation,
  finishUserApiKeyCreation,
  readUserApiKeyNames,
} from "./catalog/identity/user-api-key-requests.js";
import { createPlatformCommands } from "./catalog/platform-commands.js";
import type { D1Database } from "./d1-types.js";
import { resolveCoreDatabase } from "./core.js";
import { SharedCoreRouter } from "./router.js";
import { createRecoveryCommands } from "./catalog/recovery/commands.js";
import { authorizeAiKey, admitAi, settleAi, releaseAi, sweepAi } from "./catalog/ai/index.js";
import {
  authorizeBrowserKey,
  admitBrowser,
  settleBrowser,
  releaseBrowser,
  sweepBrowser,
} from "./catalog/browser/index.js";
import { authorizeMailGatewayKey, readMailSendingKey } from "./catalog/mail/auth.js";
import { claimMailSend } from "./catalog/mail/send-claim.js";
import { listUnbilledReceivedMail, billReceivedMail } from "./catalog/mail/received-billing.js";
import { readResendReceipt, ingestResendEvent } from "./catalog/mail/resend-events.js";
import {
  listReceivingAdmission,
  readReceivingAdmission,
  changeReceivingAdmission,
} from "./catalog/mail/receiving-admission.js";
import { claimCreditWarningPeriods, finishCreditWarningPeriod } from "./catalog/mail/warnings.js";
import {
  claimSignupFeedback,
  beginSignupFeedback,
  finishSignupFeedback,
  isSignupFeedbackClaim,
} from "./catalog/mail/signup-feedback.js";
import {
  readReceivedMail,
  claimReceivedMailAttempt,
  deferReceivedMailAttempt,
  completeReceivedMailAttempt,
  listReceivedMail,
  listDueReceivedMail,
  expireReceivedMail,
} from "./catalog/mail/delivery.js";
import {
  acceptMailDeliveryRetry,
  resumeMailDeliveryRetry,
  completeMailDeliveryRetry,
} from "./catalog/mail/delivery-commands.js";
import {
  authorizeMailSend,
  completeMailSend,
  rejectMailSend,
  settleMailSendAttempt,
} from "./catalog/mail/send-transitions.js";
import {
  claimBuildInput,
  authorizeBuildStart,
  putBuildReceipt,
  putBuildUsage,
} from "./catalog/build/commands.js";

/**
 * The store is configured with exactly ONE authority: the `CONTROL_CORE` D1 database (layout shared-core-v1). Any
 * additional binding is ignored unless it names a legacy Directory or organization shard, which is refused.
 */
export interface ControlStoreBindings {
  readonly CONTROL_CORE: D1Database;
  readonly CONTROL_NATIVE_AUTH_LAUNCH_POLICY?: string;
  readonly CONTROL_CORE_DATABASE_ID?: string;
  readonly CONTROL_PLATFORM_ENVIRONMENT?: "development" | "production";
  readonly [binding: string]: unknown;
}

type Command<Result> = (context: PlatformContext, input: unknown) => Promise<Result>;

function field(input: unknown, name: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[name]
    : undefined;
}

/**
 * The ordinary form of a command that also has a shard-wide drain form (`shardId`): it works on the one
 * organization or event it names. Draining a whole shard is maintenance authority and is refused here, before
 * anything is routed.
 */
function exactScopeOnly<Result>(command: Command<Result>): Command<Result> {
  return (context, input) => {
    if (field(input, "shardId") !== undefined) {
      throw new TypeError(
        "draining a shard is a maintenance command: name the organization or event",
      );
    }
    return command(context, input);
  };
}

/** Lease recovery of the ordinary form recovers one exact captured expired execution, never "any expired one". */
function exactOperationOnly<Result>(command: Command<Result>): Command<Result> {
  return (context, input) => {
    if (field(input, "exactOperation") === undefined) {
      throw new TypeError("recovering any expired operation is a maintenance command");
    }
    return command(context, input);
  };
}

/**
 * The store's typed commands over the directory and the tenant shards; nothing here accepts SQL.
 *
 * `identity`, `projects` and `operations` are the ordinary authority: every command is bound to one
 * organization (or one exact event/operation) the caller names. `maintenance` is the authority of the Control
 * API's scheduled work: shard-wide drains, reapers, doorbells, retention, owner maintenance and GitHub auto-deploy.
 * It is reached only through the separate `MaintenanceRuntime` entrypoint, which the Control API binds as
 * `CONTROL_MAINTENANCE_RUNTIME`, never through `ControlRuntime`.
 */
export function createControlStore(bindings: ControlStoreBindings) {
  const core = resolveCoreDatabase(bindings);
  const context = {
    directory: core,
    router: new SharedCoreRouter(core),
    nativeAuthLaunchPolicy: parseNativeAuthLaunchPolicy(bindings.CONTROL_NATIVE_AUTH_LAUNCH_POLICY),
  };
  /**
   * Every command first proves the core layout (once per isolate), then meets the core's own bucket fence: a command
   * routed to a fenced bucket is refused by the core before anything is applied, the route is refreshed once and the
   * command runs against the fresh route.
   */
  const fenced =
    <Result>(command: Command<Result>) =>
    async (input: unknown) => {
      await context.router.assertLayout();
      return withRouteRefresh(context.router, () => command(context, input));
    };
  const platform = createPlatformCommands(fenced);
  const refreshed =
    <Result>(call: (input: unknown) => Promise<Result>) =>
    async (input: unknown) => {
      await context.router.assertLayout();
      return withRouteRefresh(context.router, () => call(input));
    };
  const ingress = createWebhookIngressCommands(context);
  const publicEntryCapabilities = createPublicEntryCommands(fenced);
  const storageCapabilities = createStorageGatewayCommands(fenced);
  const publicCredits = createPublicCreditCommands(fenced);
  return Object.freeze({
    connections: Object.freeze({
      createConnectionImport: fenced(connectionImports.createConnectionImport),
      createMakeActionBinding: fenced(connectionActions.createMakeActionBinding),
      readMakeActionBinding: fenced(connectionActions.readMakeActionBinding),
      admitMakeActionExecution: fenced(connectionActions.admitMakeActionExecution),
      finishMakeActionExecution: fenced(connectionActions.finishMakeActionExecution),
      claimConnectionRefresh: fenced(connectionGrants.claimConnectionRefresh),
      retainConnectionRefreshOrphan: fenced(connectionGrants.retainConnectionRefreshOrphan),
      readConnectionRefreshOrphan: fenced(connectionGrants.readConnectionRefreshOrphan),
      listConnectionRefreshOrphans: fenced(connectionGrants.listConnectionRefreshOrphans),
      claimConnectionRefreshOrphanRevocation: fenced(
        connectionGrants.claimConnectionRefreshOrphanRevocation,
      ),
      markConnectionRefreshOrphanRevocationDispatched: fenced(
        connectionGrants.markConnectionRefreshOrphanRevocationDispatched,
      ),
      finishConnectionRefreshOrphanRevocation: fenced(
        connectionGrants.finishConnectionRefreshOrphanRevocation,
      ),
      readActiveConnectionGrant: fenced(connectionGrants.readActiveConnectionGrant),
      readConnectionGrantStatus: fenced(connectionGrants.readConnectionGrantStatus),
      listConnectionGrantMetadata: fenced(connectionGrants.listConnectionGrantMetadata),
      markConnectionRefreshDispatched: fenced(connectionGrants.markConnectionRefreshDispatched),
      commitConnectionRefresh: fenced(connectionGrants.commitConnectionRefresh),
      failConnectionRefresh: fenced(connectionGrants.failConnectionRefresh),
      disconnectConnectionGrant: fenced(connectionGrants.disconnectConnectionGrant),
      readConnectionGrantForRevocation: fenced(connectionGrants.readConnectionGrantForRevocation),
      finishConnectionDisconnect: fenced(connectionGrants.finishConnectionDisconnect),
      claimConnectionRevocation: fenced(connectionGrants.claimConnectionRevocation),
      markConnectionRevocationDispatched: fenced(
        connectionGrants.markConnectionRevocationDispatched,
      ),
      listDisconnectingConnectionGrants: fenced(connectionGrants.listDisconnectingConnectionGrants),
      listExpiredConnectionGrants: fenced(connectionGrants.listExpiredConnectionGrants),
      claimExpiredConnectionGrant: fenced(connectionGrants.claimExpiredConnectionGrant),
      createIntegrationPortalHandoff: fenced(connectionPortal.createIntegrationPortalHandoff),
      readIntegrationPortalHandoff: fenced(connectionPortal.readIntegrationPortalHandoff),
      consumeIntegrationPortalHandoff: fenced(connectionPortal.consumeIntegrationPortalHandoff),
      readIntegrationPortalStatus: fenced(connectionPortal.readIntegrationPortalStatus),
      createConnectionHandoff: fenced(connectionAttempts.createConnectionHandoff),
      consumeConnectionHandoff: fenced(connectionAttempts.consumeConnectionHandoff),
      createConnectionAttempt: fenced(connectionAttempts.createConnectionAttempt),
      claimConnectionAttempt: fenced(connectionAttempts.claimConnectionAttempt),
      terminateConnectionAttempt: fenced(connectionAttempts.terminateConnectionAttempt),
      retainConnectionOrphan: fenced(connectionAttempts.retainConnectionOrphan),
      readConnectionOrphan: fenced(connectionAttempts.readConnectionOrphan),
      listConnectionOrphans: fenced(connectionAttempts.listConnectionOrphans),
      finishConnectionOrphanRevocation: fenced(connectionAttempts.finishConnectionOrphanRevocation),
      claimConnectionOrphanRevocation: fenced(connectionAttempts.claimConnectionOrphanRevocation),
      markConnectionOrphanRevocationDispatched: fenced(
        connectionAttempts.markConnectionOrphanRevocationDispatched,
      ),
      readConnectionAttemptOrigin: fenced(connectionAttempts.readConnectionAttemptOrigin),
      persistConnectionPendingGrant: fenced(connectionAttempts.persistConnectionPendingGrant),
      readConnectionConfirmationOrigin: fenced(connectionAttempts.readConnectionConfirmationOrigin),
      activateConnectionGrant: fenced(connectionAttempts.activateConnectionGrant),
    }),
    previews: Object.freeze({
      readInitialGithubCandidate: fenced(previewGithub.readInitialGithubPreviewCandidate),
      acceptInitialGithubSource: fenced(previewGithub.acceptInitialGithubPreviewSource),
      readGithubCandidates: fenced(previewGithub.readGithubPreviewCandidates),
      acceptGithubSource: fenced(previewGithub.acceptGithubPreviewSource),
      listCleanupCandidates: fenced(previewCleanup.listPreviewCleanupCandidates),
      claimScopeCleanup: fenced(previewCleanup.claimPreviewScopeCleanup),
      finishScopeCleanup: fenced(previewCleanup.finishPreviewScopeCleanup),
      resumeSuspended: fenced(previewCleanup.resumeSuspendedPreview),
      getCleanupState: fenced(previewRuntime.getPreviewCleanupState),
      readEnvelopes: fenced(previewSecrets.readPreviewSecretEnvelopes),
      listCustomerSecretNames: fenced(previewSecrets.listPreviewCustomerSecretNames),
      resolveNativeAuth: fenced(previewNativeAuth.resolvePreviewNativeAuth),
      resolveNativeDrain: fenced(previewNativeAuth.resolvePreviewNativeDrain),
      recordNativeDrain: fenced(previewNativeAuth.recordPreviewNativeDrain),
      listPendingNativePreparations: fenced(
        previewNativePreparation.listPendingPreviewNativePreparations,
      ),
      getNativePreparationCursor: fenced(
        previewNativePreparation.getPreviewNativePreparationCursor,
      ),
      setNativePreparationCursor: fenced(
        previewNativePreparation.setPreviewNativePreparationCursor,
      ),
      queueNativePreparation: fenced(previewNativePreparation.queuePreviewNativePreparation),
      readNativePreparation: fenced(previewNativePreparation.readPreviewNativePreparation),
      recordNativePolicy: fenced(previewNativePreparation.recordPreviewNativePolicy),
      claimNativePreparation: fenced(previewNativePreparation.claimPreviewNativePreparation),
      finishNativePreparation: fenced(previewNativePreparation.finishPreviewNativePreparation),
      prepare: fenced(previewCustomer.preparePreview),
      get: fenced(previewCustomer.getPreview),
      ensure: fenced(previewCustomer.ensurePreview),
      rotate: fenced(previewCustomer.rotatePreview),
      confirmRotation: fenced(previewCustomer.confirmPreviewRotation),
      destroy: fenced(previewCustomer.destroyPreview),
      confirmDestroy: fenced(previewCustomer.confirmPreviewDestroy),
      resolveTokenHash: fenced(previewRuntime.resolvePreviewTokenHash),
      authorizeRuntime: fenced(previewRuntime.authorizePreviewRuntime),
      authorizeDatabase: fenced(previewRuntime.authorizePreviewDatabase),
      readSource: fenced(previewRuntime.readPreviewSource),
      recordState: fenced(previewRuntime.recordPreviewState),
      recordStopped: fenced(previewRuntime.recordPreviewStopped),
      recordAppliedSource: fenced(previewRuntime.recordPreviewAppliedSource),
      recordBackup: fenced(previewRuntime.recordPreviewBackup),
      listBackupCleanup: fenced(previewRuntime.listPreviewBackupCleanup),
      acknowledgeBackupCleanup: fenced(previewRuntime.acknowledgePreviewBackupCleanup),
      claimExpiredBackup: fenced(previewRuntime.claimExpiredPreviewBackup),
      renewActivity: fenced(previewRuntime.renewPreviewActivity),
      reserveUsage: fenced(previewUsage.reservePreviewUsage),
      closeUsage: fenced(previewUsage.closePreviewUsage),
      getReconciliationCursor: fenced(previewUsage.getPreviewUsageReconciliationCursor),
      setReconciliationCursor: fenced(previewUsage.setPreviewUsageReconciliationCursor),
      listUsageForReconciliation: fenced(previewUsage.listPreviewUsageForReconciliation),
      observeUsage: fenced(previewUsage.observePreviewUsage),
      listPendingSources: fenced(previewRuntime.listPendingPreviewSources),
      listProjectPendingSources: fenced(previewRuntime.listProjectPendingPreviewSources),
      acknowledgeSource: fenced(previewRuntime.acknowledgePreviewSource),
    }),
    growthFacts: Object.freeze({
      readFactPage: (input: unknown) => readGrowthFactPage(core, input),
      resolveGrowthStripeCustomer: (input: unknown) => resolveGrowthStripeCustomer(core, input),
    }),
    github: Object.freeze({
      readGithubAutoDeployTargets: fenced(githubAutoDeploy.readGithubAutoDeployTargets),
      reserveGithubPushDeployment: fenced(githubAutoDeploy.reserveGithubPushDeployment),
      attachGithubPushOperation: fenced(githubAutoDeploy.attachGithubPushOperation),
      failGithubPushPlanning: fenced(githubAutoDeploy.failGithubPushPlanning),
      readGithubSourceAuthorization: fenced(githubAuthorizations.readGithubSourceAuthorization),
      readGithubSourceAuthorizationByState: fenced(
        githubAuthorizations.readGithubSourceAuthorizationByState,
      ),
      readGithubSourceAuthorizationById: fenced(
        githubAuthorizations.readGithubSourceAuthorizationById,
      ),
      insertGithubSourceAuthorization: fenced(githubAuthorizations.insertGithubSourceAuthorization),
      claimGithubSourceAuthorization: fenced(githubAuthorizations.claimGithubSourceAuthorization),
      releaseGithubSourceAuthorization: fenced(
        githubAuthorizations.releaseGithubSourceAuthorization,
      ),
      completeGithubSourceAuthorization: fenced(
        githubAuthorizations.completeGithubSourceAuthorization,
      ),
      readGithubOrganizationMapping: fenced(githubAuthorizations.readGithubOrganizationMapping),
      readGithubConnection: fenced(githubAuthorizations.readGithubConnection),
      readGithubConnectionById: fenced(githubAuthorizations.readGithubConnectionById),
      hasActiveGithubConnection: fenced(githubAuthorizations.hasActiveGithubConnection),
      readGithubInstallationHints: fenced(githubAuthorizations.readGithubInstallationHints),
      revokeGithubConnection: fenced(githubAuthorizations.revokeGithubConnection),
      revokeGithubInstallationAccess: fenced(revokeGithubInstallationAccess),
      readGithubConnectionAuthorization: fenced(
        githubAuthorizations.readGithubConnectionAuthorization,
      ),
      readGithubConnectionAuthorizationByState: fenced(
        githubAuthorizations.readGithubConnectionAuthorizationByState,
      ),
      readGithubConnectionAuthorizationById: fenced(
        githubAuthorizations.readGithubConnectionAuthorizationById,
      ),
      insertGithubConnectionAuthorization: fenced(
        githubAuthorizations.insertGithubConnectionAuthorization,
      ),
      failGithubConnectionAuthorization: fenced(
        githubAuthorizations.failGithubConnectionAuthorization,
      ),
      advanceGithubConnectionToOauth: fenced(githubAuthorizations.advanceGithubConnectionToOauth),
      claimGithubConnectionAuthorization: fenced(
        githubAuthorizations.claimGithubConnectionAuthorization,
      ),
      renewGithubConnectionProviderUse: fenced(
        githubAuthorizations.renewGithubConnectionProviderUse,
      ),
      releaseGithubConnectionProviderUse: fenced(
        githubAuthorizations.releaseGithubConnectionProviderUse,
      ),
      completeGithubConnection: fenced(githubAuthorizations.completeGithubConnection),
      readGithubRepositoryLinkConsent: fenced(githubAuthorizations.readGithubRepositoryLinkConsent),
      insertGithubRepositoryLinkConsent: fenced(
        githubAuthorizations.insertGithubRepositoryLinkConsent,
      ),
    }),
    sharedMail: Object.freeze({
      listDomains: fenced(listMailWorkspaceViews),
      readDomain: fenced(readMailWorkspaceView),
      createDomain: fenced(createSharedMailDomain),
      beginRetire: fenced(beginSharedMailRetire),
      completeCommand: fenced(completeSharedMailCommand),
      readBinding: fenced(readSharedMailBinding),
      bindProject: fenced(bindSharedMailProject),
      detachProject: fenced(detachSharedMailProject),
    }),
    devAccess: Object.freeze({
      issueDevAccessTicket: fenced(issueDevAccessTicket),
      redeemDevAccess: fenced(redeemDevAccess),
      authorizeDevCombined: fenced(authorizeDevCombined),
      authorizeDevPage: fenced(authorizeDevPage),
      authorizeDevAccessSession: fenced(authorizeDevAccessSession),
      authorizeDevRuntimeProbe: fenced(authorizeDevRuntimeProbe),
      readDevShareState: fenced(readDevShareState),
      changeDevAccess: fenced(changeDevAccess),
    }),
    customerReads: Object.freeze({
      readDeploymentDiagnostics: fenced(readDeploymentDiagnostics),
      readEnvironmentFunctionRuns: fenced(readEnvironmentFunctionRuns),
    }),
    remoteMcp: Object.freeze({
      readMcpAuthorizedMemberships: fenced(readMcpAuthorizedMemberships),
      readMcpEnvironmentName: fenced(readMcpEnvironmentName),
      readMcpMailDomainOrganization: fenced(readMcpMailDomainOrganization),
      readMcpProjectOrganization: fenced(readMcpProjectOrganization),
      readMcpGrantRevision: fenced(readMcpGrantRevision),
      readMcpRecoveryContext: fenced(readMcpRecoveryContext),
      authorizeMcpExecution: fenced(authorizeMcpExecution),
      readMcpPlanEnvironmentName: fenced(readMcpPlanEnvironmentName),
    }),
    apiMetadata: Object.freeze({
      readProjectNotes: fenced(readProjectNotes),
      writeProjectNotes: fenced(writeProjectNotes),
      readProjectStorageJurisdiction: fenced(readProjectStorageJurisdiction),
      readPoweredByFlag: fenced(readPoweredByFlag),
      setPoweredByFlag: fenced(setPoweredByFlag),
    }),
    cloudflareDomain: Object.freeze({
      claimAuthorization: fenced(claimGeneralCloudflareAuthorization),
      consumeAuthorization: fenced(consumeGeneralCloudflareAuthorization),
      putGrant: fenced(putGeneralCloudflareGrant),
      readGrant: fenced(readGeneralCloudflareGrant),
      readStatus: fenced(readGeneralCloudflareStatus),
      configureDomains: fenced(configureGeneralCloudflareDomains),
      readReconciliation: fenced(readGeneralCloudflareReconciliation),
      rotateGrant: fenced(rotateGeneralCloudflareGrant),
      readDeletion: fenced(readGeneralCloudflareDeletion),
      rotateDeletionGrant: fenced(rotateGeneralCloudflareDeletionGrant),
      prepareRevocation: fenced(prepareGeneralCloudflareRevocation),
      restartRevocation: fenced(restartGeneralCloudflareRevocation),
      finalizeDeletion: fenced(finalizeGeneralCloudflareDeletion),
      finalizePlatformDeletion: fenced((context, raw) =>
        finalizeGeneralCloudflareDeletion(context, raw, true),
      ),
      readPaidDomainTarget: fenced(readPaidDomainTarget),
      readPaidDomainRecord: fenced(readPaidDomainRecord),
      readPaidDomainProof: fenced(readPaidDomainProof),
      ensurePaidDomainProof: fenced(ensurePaidDomainProof),
      verifyPaidDomainProof: fenced(verifyPaidDomainProof),
      claimPaidDomainApply: fenced(claimPaidDomainApply),
      putPaidDomainActive: fenced(putPaidDomainActive),
      claimPaidDomainDelete: fenced(claimPaidDomainDelete),
      markPaidDomainDeleted: fenced(markPaidDomainDeleted),
      claimPaidProjectDeletion: fenced(claimPaidProjectDeletion),
      claimGrantUse: fenced(claimGeneralCloudflareGrantUse),
      renewGrantUse: fenced(renewGeneralCloudflareGrantUse),
      finishGrantUse: fenced(finishGeneralCloudflareGrantUse),
      releaseGrantUse: fenced(releaseGeneralCloudflareGrantUse),
    }),
    accountMetadata: Object.freeze({
      readCurrentIdentityMappings: fenced(readCurrentIdentityMappings),
      readAccountProfileFacts: fenced(readAccountProfileFacts),
      recordAccountSignupSource: fenced(recordAccountSignupSource),
    }),
    r2Management: Object.freeze({
      claimBucket: fenced(claimR2Bucket),
      proveBucketAbsence: fenced(proveR2BucketAbsence),
      supersedeBucketReservation: fenced(supersedeR2BucketReservation),
      authorizeBucket: fenced(authorizeR2Bucket),
      putBucket: fenced(putR2Bucket),
      readBucket: fenced(readR2Bucket),
      confirmedStorage: fenced(readR2Confirmed),
    }),
    diagnosticConsumer: Object.freeze({
      recordDiagnostic: fenced(recordConsumerDiagnostic),
      purgeDiagnostics: fenced(purgeConsumerDiagnostics),
    }),
    functionsScheduler: Object.freeze({
      readSchedules: fenced(readFunctionSchedules),
      insertDueRuns: fenced(insertFunctionRuns),
      claimRuns: fenced(claimScheduledFunctionRuns),
      finishRun: fenced(finishScheduledFunctionRun),
      purgeFinishedRuns: fenced(purgeScheduledFunctionRuns),
    }),
    cfScopedDns: Object.freeze({
      readAuthorization: fenced(readCfScopedAuthorization),
      issue: fenced(issueCfScopedAuthorization),
      status: fenced(readCfScopedStatus),
      consume: fenced(consumeCfScopedAuthorization),
      saveGrant: fenced(saveCfScopedGrant),
      revoke: fenced(revokeCfScopedAuthorization),
      listRevokedGrants: fenced(listRevokedCfScopedGrants),
      wipeRevokedGrantTokens: fenced(wipeRevokedCfScopedGrantTokens),
      listDisplacedTokens: fenced(listDisplacedCfScopedTokens),
      completeDisplacedToken: fenced(completeDisplacedCfScopedToken),
      claimUse: fenced(claimCfScopedDnsUse),
      renewUse: fenced(renewCfScopedDnsUse),
      authorizeUse: fenced(authorizeCfScopedDnsUse),
      finishUse: fenced(finishCfScopedDnsUse),
      releaseUse: fenced(releaseCfScopedDnsUse),
      readCleanup: fenced(readCfScopedMailCleanup),
      completeEmptyCleanup: fenced(completeEmptyCfScopedMailCleanup),
    }),
    cfMailDns: Object.freeze({
      workspace: fenced(readCfWorkspaceMailDnsRequirements),
      legacy: fenced(readCfLegacyMailDnsRequirements),
      deletion: fenced(readCfMailDnsDeletionRequirements),
      requirePaid: fenced(requireMailOrganizationPaid),
      saveWorkspace: fenced(saveCfWorkspaceMailDnsReceipt),
      saveLegacy: fenced(saveCfLegacyMailDnsReceipt),
    }),
    cfApplicationIdentity: Object.freeze({
      read: fenced(readCfApplicationIdentity),
      declare: fenced(declareCfApplicationIdentity),
      replay: fenced(replayCfApplicationIdentityAction),
      readForVerification: fenced(readCfApplicationIdentityForVerification),
      completeAction: fenced(completeCfApplicationIdentityAction),
      readAutomatic: fenced(readAutomaticCfApplicationIdentity),
      completeAutomatic: fenced(completeAutomaticCfApplicationIdentity),
    }),
    mailManagementJobs: Object.freeze({
      listPendingLegacy: fenced(listPendingMailLegacyResources),
      claimLegacy: fenced(claimMailLegacyReconciliation),
      claimDueIdentity: fenced(claimMailIdentityRevalidation),
      suspendExpiredBindings: fenced(suspendExpiredMailBindings),
      listPendingWorkspaces: fenced(listPendingMailWorkspaceResources),
      listExpiredUnverifiedWorkspaces: fenced(listExpiredUnverifiedSharedMailDomains),
      claimWorkspace: fenced(claimMailWorkspaceReconciliation),
    }),
    mailCommands: Object.freeze({
      read: fenced(readMailManagementCommand),
      begin: fenced(beginMailManagementCommand),
      resume: fenced(resumeMailManagementCommand),
      complete: fenced(completeMailManagementCommand),
      readWorkspace: fenced(readWorkspaceMailManagementCommand),
      claimWorkspaceRetirement: fenced(claimWorkspaceMailRetirementCommand),
    }),
    mailDeletion: Object.freeze({
      readScope: fenced(readMailDeletionScope),
      prepare: fenced(prepareMailProjectDeletion),
      recordFound: fenced(recordMailDeletionFoundResource),
      finish: fenced(finishMailProjectDeletionResource),
    }),
    mailWorkspace: Object.freeze({
      readResource: fenced(readMailWorkspaceResource),
      readView: fenced(readMailWorkspaceView),
      change: fenced(changeMailWorkspaceResource),
      beginRetirement: fenced(beginMailWorkspaceRetirement),
      finishRetirement: fenced(finishMailWorkspaceRetirement),
    }),
    mailManagement: Object.freeze({
      readDomain: fenced(readMailDomainProjection),
      readCustody: fenced(readMailResourceCustody),
      readLegacy: fenced(readMailLegacyWorkspaceResource),
      readWorkspaceStatus: fenced(readMailResourceWorkspaceStatus),
      isReceivingOwner: fenced(isMailReceivingOwner),
      hasLiveName: fenced(hasLiveMailResourceName),
      change: fenced(changeMailResource),
      requirePaid: fenced(requireMailOrganizationPaid),
      admitReceiving: fenced(admitMailReceiving),
      configure: fenced(configureMailResource),
      retire: fenced(retireMailResource),
      retireLegacy: fenced(retireMailLegacyWorkspaceResource),
    }),
    mailCapabilities: Object.freeze({
      claim: fenced(claimWorkspaceMailCapabilities),
      read: fenced(readWorkspaceMailCapabilities),
      confirm: fenced(confirmWorkspaceMailCapabilities),
      release: fenced(releaseWorkspaceMailCapabilities),
    }),
    productDatabase: Object.freeze({
      beginWebhookActivation: fenced(webhookLifecycle.beginDatabaseWebhookActivation),
      finishWebhookActivation: fenced(webhookLifecycle.finishDatabaseWebhookActivation),
      abortWebhookActivation: fenced(webhookLifecycle.abortDatabaseWebhookActivation),
      beginWebhookDeactivation: fenced(webhookLifecycle.beginDatabaseWebhookDeactivation),
      finishWebhookDeactivation: fenced(webhookLifecycle.finishDatabaseWebhookDeactivation),
      readWebhookSubscription: fenced(webhookLifecycle.readDatabaseWebhookSubscription),
      readAccessHistory: fenced(readProjectDatabaseAccessHistory),
      readDiagnosticTarget: fenced(readProductDiagnosticTarget),
      issueAccess: fenced(issueProductDatabaseAccess),
      readAccess: fenced(readProductDatabaseAccess),
      readAccessForIssuance: fenced((context, input) =>
        readProductDatabaseAccess(context, input, true),
      ),
      revokeAccess: fenced(mutateProductDatabaseAccess),
      recordAccessOperation: fenced((context, input) =>
        mutateProductDatabaseAccess(context, input, true),
      ),
      readAccessSweep: fenced(readProductDatabaseAccessSweep),
      markAccessSweepAttempts: fenced(markProductDatabaseAccessSweepAttempts),
      readAccessCreditAdmission: fenced(readProductAccessCreditAdmission),
      readAdmission: fenced(readProductDatabaseAdmission),
      recordEventAudit: fenced(recordProductDatabaseEventAudit),
      readDataChangeAccess: fenced(readDataChangeProductAccess),
      acceptWrite: fenced(acceptProductDatabaseWrite),
      finishWrite: fenced(finishProductDatabaseWrite),
      readExpiredWrites: fenced(readExpiredProductDatabaseWrites),
      expireWrites: fenced(expireProductDatabaseWrites),
      readEntitlementTargets: fenced(readProductEntitlementTargets),
      claimEntitlement: fenced(claimProductEntitlement),
      beginEntitlement: fenced(beginProductEntitlement),
      recordEntitlement: fenced(recordProductEntitlement),
      recordEntitlementCheckFailure: fenced(recordProductEntitlementCheckFailure),
      readOperation: fenced(readProductDatabaseOperation),
      replayCompute: fenced(replayProductCompute),
      readComputeScope: fenced(readProductComputeScope),
      acceptCompute: fenced(acceptProductCompute),
      readComputeJob: fenced(readProductComputeJob),
      claimCompute: fenced(claimProductCompute),
      completeCompute: fenced(completeProductCompute),
      recordCompute: fenced(recordProductCompute),
      releaseComputeUse: fenced(releaseProductComputeUse),
      readComputeContext: fenced(readProductComputeContext),
      readDueCompute: fenced(readDueProductCompute),
      acknowledgeComputeOutbox: fenced(acknowledgeProductComputeOutbox),
    }),
    managedSource: Object.freeze({
      readApiManagedSourceProjectScope: fenced(managedSourceReads.readApiManagedSourceProjectScope),
      readApiProjectSourceBinding: fenced(managedSourceReads.readApiProjectSourceBinding),
      readApiManagedSourceInitialization: fenced(
        managedSourceReads.readApiManagedSourceInitialization,
      ),
      readApiManagedSourcePublication: fenced(managedSourceReads.readApiManagedSourcePublication),
      readApiManagedSourceOperation: fenced(managedSourceReads.readApiManagedSourceOperation),
      authorizeApiManagedSourcePublication: fenced(
        managedSourceReads.authorizeApiManagedSourcePublication,
      ),
      reserveApiManagedSourceBlob: fenced(managedSourceBlobs.reserveApiManagedSourceBlob),
      recordApiManagedSourceBlob: fenced(managedSourceBlobs.recordApiManagedSourceBlob),
      sealApiManagedSourceManifest: fenced(managedSourceBlobs.sealApiManagedSourceManifest),
      recordApiManagedSourcePreparedCommit: fenced(
        managedSourceBlobs.recordApiManagedSourcePreparedCommit,
      ),
      beginApiManagedSourcePublication: fenced(
        managedSourceJournal.beginApiManagedSourcePublication,
      ),
      recordApiManagedSourceRequest: fenced(managedSourceJournal.recordApiManagedSourceRequest),
      completeApiManagedSourcePublication: fenced(
        managedSourceJournal.completeApiManagedSourcePublication,
      ),
      failApiManagedSourcePublication: fenced(managedSourceJournal.failApiManagedSourcePublication),
      readProcessorManagedSourceInitialization: fenced(
        managedSourceProcessor.readProcessorManagedSourceInitialization,
      ),
      authorizeProcessorManagedSourceInitialization: fenced(
        managedSourceProcessor.authorizeProcessorManagedSourceInitialization,
      ),
      attachProcessorManagedSourceInitializationChild: fenced(
        managedSourceProcessor.attachProcessorManagedSourceInitializationChild,
      ),
      completeProcessorManagedSourceInitializationChild: fenced(
        managedSourceProcessor.completeProcessorManagedSourceInitializationChild,
      ),
      rejectProcessorManagedSourceInitialization: fenced(
        managedSourceProcessor.rejectProcessorManagedSourceInitialization,
      ),
      readProcessorManagedSourceContext: fenced(
        managedSourceProcessor.readProcessorManagedSourceContext,
      ),
      rejectProcessorManagedSourcePublication: fenced(
        managedSourceProcessor.rejectProcessorManagedSourcePublication,
      ),
    }),
    productApi: Object.freeze({
      readApiProductScope: fenced(productApiReads.readApiProductScope),
      readApiProductDeployment: fenced(productApiReads.readApiProductDeployment),
      readApiProductDeployments: fenced(productApiReads.readApiProductDeployments),
      readApiProductProject: fenced(productApiReads.readApiProductProject),
      readApiProductStatus: fenced(productApiReads.readApiProductStatus),
      readApiPlanningSource: fenced(productApiPlanningReads.readApiPlanningSource),
      readApiDeploymentPlan: fenced(productApiPlanningReads.readApiDeploymentPlan),
      readApiPromotionEnvironments: fenced(productApiPlanningReads.readApiPromotionEnvironments),
      readApiPromotionTarget: fenced(productApiPlanningReads.readApiPromotionTarget),
      readApiDeletionAdmission: fenced(productApiPlanningReads.readApiDeletionAdmission),
      readApiRenameAdmission: fenced(productApiPlanningReads.readApiRenameAdmission),
      readApiDeletePlanTarget: fenced(productApiPlanningReads.readApiDeletePlanTarget),
      readApiRollbackTarget: fenced(productApiRollback.readApiRollbackTarget),
      issueApiActionConfirmation: fenced(productApiPlanning.issueApiActionConfirmation),
      requireApiUsableConfirmation: fenced(productApiPlanning.requireApiUsableConfirmation),
      createApiDeploymentPlan: fenced(productApiPlanning.createApiDeploymentPlan),
      configureApiGithubAutoDeploy: fenced(productApiAutoDeploy.configureApiGithubAutoDeploy),
      readApiGithubAutoDeploy: fenced(productApiAutoDeploy.readApiGithubAutoDeploy),
      readApiProductReplay: fenced(productApiReplay.readApiProductReplay),
      readApiProductOperation: fenced(productApiOperation.readApiProductOperation),
      acceptApiProductOperation: fenced(productApiAcceptance.acceptApiProductOperation),
      readApiProjectDataChangeState: fenced(productApiDataChange.readApiProjectDataChangeState),
      issueApiProjectDataChangePlan: fenced(productApiDataChange.issueApiProjectDataChangePlan),
    }),
    publicEntry: publicEntryCapabilities.entry,
    publicEntryRetention: publicEntryCapabilities.retention,
    customerFeedback: publicEntryCapabilities.feedback,
    feedbackOperator: publicEntryCapabilities.feedbackOperator,
    storageGateway: storageCapabilities.gateway,
    storageData: storageCapabilities.data,
    publicCredits,
    credit: createCreditCommands(fenced),
    gatewayCredit: Object.freeze({ read: fenced(readGatewayRuntimeCreditDecision) }),
    projectDispatch: Object.freeze({
      recoverProductExecutionLease: fenced(recoverProductDispatchExecution),
      provisioning: Object.freeze({
        claim: fenced((c, i) => claimProjectDispatch(c, "provisioning", i)),
        recover: fenced((c, i) => recoverProjectDispatch(c, "provisioning", i)),
        acknowledge: fenced((c, i) => acknowledgeProjectDispatch(c, "provisioning", i)),
        fail: fenced((c, i) => failProjectDispatch(c, "provisioning", i)),
      }),
      product: Object.freeze({
        claim: fenced((c, i) => claimProjectDispatch(c, "product", i)),
        recover: fenced((c, i) => recoverProjectDispatch(c, "product", i)),
        acknowledge: fenced((c, i) => acknowledgeProjectDispatch(c, "product", i)),
        fail: fenced((c, i) => failProjectDispatch(c, "product", i)),
      }),
      managedSource: Object.freeze({
        claim: fenced((c, i) => claimProjectDispatch(c, "managedSource", i)),
        recover: fenced((c, i) => recoverProjectDispatch(c, "managedSource", i)),
        sweep: fenced(managedSourceProcessor.sweepExhaustedManagedSourcePublication),
        acknowledge: fenced((c, i) => acknowledgeProjectDispatch(c, "managedSource", i)),
        fail: fenced((c, i) => failProjectDispatch(c, "managedSource", i)),
      }),
      acceptProductDispatch: fenced(acceptProductDispatch),
      readProductDispatchIntent: fenced(readProductDispatchIntent),
      readManagedSourceDispatchState: fenced(readManagedSourceDispatchState),
    }),
    provisioning: Object.freeze({
      providerRecovery: Object.freeze({
        readProductProviderReconciliationContext: fenced(
          providerRecovery.readProductProviderReconciliationContext,
        ),
        findProductProviderReconciliationClaim: fenced(
          providerRecovery.findProductProviderReconciliationClaim,
        ),
        findClaimlessProductProviderReconciliationCandidate: fenced(
          providerRecovery.findClaimlessProductProviderReconciliationCandidate,
        ),
        readProductProviderReconciliationAttempt: fenced(
          providerRecovery.readProductProviderReconciliationAttempt,
        ),
        prepareProductProviderReconciliation: fenced(
          providerRecovery.prepareProductProviderReconciliation,
        ),
        recoverTerminalProductProviderReconciliationAttempt: fenced(
          providerRecovery.recoverTerminalProductProviderReconciliationAttempt,
        ),
        prepareProjectProvisioningQueueDeliveryRecovery: fenced(
          queueRecovery.prepareProjectProvisioningQueueDeliveryRecovery,
        ),
        finalizeProjectProvisioningQueueDeliveryRecovery: fenced(
          queueRecovery.finalizeProjectProvisioningQueueDeliveryRecovery,
        ),
        prepareSourceLinkQueueDeliveryRecovery: fenced(
          queueRecovery.prepareSourceLinkQueueDeliveryRecovery,
        ),
        finalizeSourceLinkQueueDeliveryRecovery: fenced(
          queueRecovery.finalizeSourceLinkQueueDeliveryRecovery,
        ),
        readClosedSourceLinkQueueDeliveryRecovery: fenced(
          queueRecovery.readClosedSourceLinkQueueDeliveryRecovery,
        ),
        readTerminalSourceLinkWorkflowReplayAttempt: fenced(
          queueRecovery.readTerminalSourceLinkWorkflowReplayAttempt,
        ),
        prepareDeploymentQueueDeliveryRecovery: fenced(
          queueRecovery.prepareDeploymentQueueDeliveryRecovery,
        ),
        finalizeDeploymentQueueDeliveryRecovery: fenced(
          queueRecovery.finalizeDeploymentQueueDeliveryRecovery,
        ),
        findProductWorkflowReplayCandidate: fenced(
          workflowReplay.findProductWorkflowReplayCandidate,
        ),
        findRunlessProductDispatch: fenced(workflowReplay.findRunlessProductDispatch),
        acceptRunlessProductDispatch: fenced(acceptProductDispatch),
        finalizeProjectDeletionQueueHandoff: fenced(
          workflowReplay.finalizeProjectDeletionQueueHandoff,
        ),
        prepareProductWorkflowReplay: fenced(workflowReplay.prepareProductWorkflowReplay),
        readProductWorkflowReplayAttempt: fenced(workflowReplay.readProductWorkflowReplayAttempt),
        recoverTerminalProductWorkflowReplay: fenced(
          workflowReplay.recoverTerminalProductWorkflowReplay,
        ),
        findLostProductCommand: fenced(lostCommand.findLostProductCommand),
        abandonLostProductCommand: fenced(lostCommand.abandonLostProductCommand),
        reconcileProductCommand: fenced(reconcileRecoveredProductWorkflow),
      }),
      completeLifecycleCommand: fenced(completeProductLifecycleCommand),
      retainDeletionTombstone: fenced(retainProductDeletionTombstone),
      readDeletionEvidence: fenced(readLifecycleDeletionEvidence),
      readCleanupResources: fenced(readLifecycleCleanupResources),
      recordCleanupAttempt: fenced(recordLifecycleCleanupAttempt),
      deleteSchedules: fenced(deleteLifecycleSchedules),
      readManagedSourceInventory: fenced(readLifecycleManagedSourceInventory),
      startDataChange: fenced(startLifecycleDataChange),
      switchDataAssignments: fenced(switchLifecycleDataAssignments),
      readRollbackDataTarget: fenced(readProductRollbackDataTarget),
      renewOperationLease: fenced(renewProductOperationLease),
      finalizeHandleChange: fenced(finalizeProductHandleChange),
      reconcileWorkflow: fenced(reconcileProductWorkflow),
      prepareCandidateCleanup: fenced(prepareProductCandidateCleanup),
      claimCandidateCleanup: fenced(claimProductCandidateCleanup),
      recordCandidateCleanup: fenced(recordProductCandidateCleanup),
      markCandidateSuperseded: fenced(markProductCandidateSuperseded),
      recordCandidate: fenced(recordProductDeploymentCandidate),
      recordAbandonedGateway: fenced(recordAbandonedGatewayPredecessor),
      readDataEnvironment: fenced(readProductDataEnvironment),
      resolveRollback: fenced(resolveProductRollbackCandidate),
      assertBindingRefresh: fenced(assertProductBindingRefresh),
      finishBindingRefresh: fenced(finishProductBindingRefresh),
      finalizeCandidate: fenced(finalizeProductCandidate),
      finalizeRollback: fenced(finalizeProductRollback),
      readPendingNativePolicySync: fenced(readPendingNativePolicySync),
      completeNativePolicySync: fenced(completeNativePolicySync),
      assertExecution: fenced(assertProductOperationExecution),
      authorizeActivation: fenced(authorizeProductActivation),
      authorizeProviderMutation: fenced(authorizeProductProviderMutation),
      completeSourceLink: fenced(completeSourceLink),
      activateReconciliationAttempt: fenced(activateProductProviderReconciliationAttempt),
      activateReplayAttempt: fenced(activateProductWorkflowReplayAttempt),
      recordSourceArchive: fenced(recordProductSourceArchiveEvidence),
      observeSourceArchive: fenced(observeSourceArchiveReceipt),
      failDeployment: fenced(failProductDeployment),
      recordHealthDiagnostic: fenced(recordRuntimeHealthDiagnostic),
      claimProviderMutation: fenced(claimProductProviderMutation),
      readDatabaseTarget: fenced(readProductWorkflowDatabaseTarget),
      readContext: fenced(readProductWorkflowContext),
      completeHello: fenced(completeProvisioningHello),
      failHello: fenced(failProvisioningHello),
      reconcileHello: fenced(reconcileProvisioningHello),
    }),
    mailIngress: Object.freeze({
      readReceipt: fenced(readResendReceipt),
      ingest: fenced(ingestResendEvent),
    }),
    mailWarnings: Object.freeze({
      claimPeriods: fenced(claimCreditWarningPeriods),
      finishPeriod: fenced(finishCreditWarningPeriod),
    }),
    signupFeedback: Object.freeze({
      claim: fenced(claimSignupFeedback),
      begin: fenced(beginSignupFeedback),
      finish: fenced(finishSignupFeedback),
    }),
    mailDelivery: Object.freeze({
      listAdmission: fenced(listReceivingAdmission),
      readAdmission: fenced(readReceivingAdmission),
      changeAdmission: fenced(changeReceivingAdmission),
      unbilled: fenced(listUnbilledReceivedMail),
      bill: fenced(billReceivedMail),
      authorizeKey: fenced(authorizeMailGatewayKey),
      read: fenced(readReceivedMail),
      claim: fenced(claimReceivedMailAttempt),
      complete: fenced(completeReceivedMailAttempt),
      list: fenced(listReceivedMail),
      due: fenced(listDueReceivedMail),
      defer: fenced(deferReceivedMailAttempt),
      expire: fenced(expireReceivedMail),
      acceptRetry: fenced(acceptMailDeliveryRetry),
      resumeRetry: fenced(resumeMailDeliveryRetry),
      completeRetry: fenced(completeMailDeliveryRetry),
    }),
    mailInfrastructure: Object.freeze({
      readReceipt: fenced(readInfrastructureAlertReceipt),
      claim: fenced(claimInfrastructureAlert),
      complete: fenced(completeInfrastructureAlert),
    }),
    browserGateway: Object.freeze({
      authorizeKey: fenced(authorizeBrowserKey),
      admit: fenced(admitBrowser),
      settle: fenced(settleBrowser),
      release: fenced(releaseBrowser),
      sweep: fenced(sweepBrowser),
    }),
    aiGateway: Object.freeze({
      authorizeKey: fenced(authorizeAiKey),
      admit: fenced(admitAi),
      settle: fenced(settleAi),
      release: fenced(releaseAi),
      sweep: fenced(sweepAi),
    }),
    mailSend: Object.freeze({
      authorizeKey: fenced(authorizeMailGatewayKey),
      claim: fenced(claimMailSend),
      authorize: fenced(authorizeMailSend),
      readKey: fenced(readMailSendingKey),
      complete: fenced(completeMailSend),
      reject: fenced(rejectMailSend),
      settle: fenced(settleMailSendAttempt),
    }),
    gateway: createGatewayCommands(fenced),
    stripeBilling: createStripeBillingCommands(fenced),

    runtimeSecrets: createRuntimeSecretCommands(fenced),
    recovery: createRecoveryCommands(fenced),
    // Only accepted build scopes and frozen plan prices; no generic financial-write authority.
    build: Object.freeze({
      claimBuildInput: fenced(claimBuildInput),
      authorizeBuildStart: fenced(authorizeBuildStart),
      putBuildReceipt: fenced(putBuildReceipt),
      putBuildUsage: fenced(putBuildUsage),
    }),
    databaseManagement: Object.freeze({
      ...createDatabaseProviderCommands(fenced).runtime,
      ...createDatabaseRegistrationCommands(fenced),
      resolveClaim: fenced(resolveDatabaseManagementClaim),
      readPlacementPaidAccess: fenced(readDatabasePlacementPaidAccess),
      readRuntimeBinding: fenced(readDatabaseManagementRuntimeBinding),
      readControlAuthority: fenced((context) => readControlAuthority(context, bindings)),
    }),
    secrets: platform.secrets,
    domains: platform.domains,
    /** Whether a project may attach a custom domain now, answered from the serving decision of the credit account. */
    billing: Object.freeze({
      admitPaidProjectDomain: fenced(admitPaidProjectDomain),
    }),
    /**
     * `applyOrganizationSnapshot` is the full WorkOS snapshot (organization, every membership, barriers, grants,
     * audit and the inbox acknowledgement in one batch). The other closed identity commands each name the
     * organization or handoff hash whose authoritative scope is resolved here. Their designated private
     * entrypoint surfaces expose only the reviewed identity, Control API and MCP capabilities.
     */
    identity: Object.freeze({
      authorizeNativeAuthOwner: fenced(authorizeNativeAuthOwner),
      proveNativeAuthUnprovisionedPolicy: fenced(proveNativeAuthUnprovisionedPolicy),
      readNativeAuthConfig: fenced(readNativeAuthConfig),
      updateNativeAuthConfig: fenced(updateNativeAuthConfig),
      readNativeAuthProvider: fenced(readNativeAuthProvider),
      updateNativeAuthProvider: fenced(updateNativeAuthProvider),
      readNativeAuthProviderEnvelope: fenced(readNativeAuthProviderEnvelope),
      readNativeAuthTarget: fenced(readNativeAuthTarget),
      authorizeNativeAuthDeletion: fenced(nativeAuthDeletion.authorizeNativeAuthDeletion),
      authorizeNativeAuthDeletionQuiescence: fenced(
        nativeAuthDeletion.authorizeNativeAuthDeletionQuiescence,
      ),
      readNativeAuthProjectDeletion: fenced(nativeAuthDeletion.readNativeAuthProjectDeletion),
      recordNativeAuthDeletionQuiescence: fenced(
        nativeAuthDeletion.recordNativeAuthDeletionQuiescence,
      ),
      beginNativeAuthProjectDeletion: fenced(nativeAuthDeletion.beginNativeAuthProjectDeletion),
      recordNativeAuthProjectDeletionObservation: fenced(
        nativeAuthDeletion.recordNativeAuthProjectDeletionObservation,
      ),
      recordNativeAuthDeletionPurge: fenced(nativeAuthDeletion.recordNativeAuthDeletionPurge),
      finishNativeAuthProjectDeletion: fenced(nativeAuthDeletion.finishNativeAuthProjectDeletion),
      readNativeAuthRestorePreparation: fenced(
        nativeAuthRestorePreparation.readNativeAuthRestorePreparation,
      ),
      recordNativeAuthRestoreVerification: fenced(
        nativeAuthRestorePreparation.recordNativeAuthRestoreVerification,
      ),
      acceptNativeRestoreJob: fenced(nativeAuthRestoreJob.acceptNativeRestoreJob),
      authorizeNativeRestoreAdmission: fenced(nativeAuthRestoreJob.authorizeNativeRestoreAdmission),
      claimNativeRestoreJob: fenced(nativeAuthRestoreJob.claimNativeRestoreJob),
      readNativeRestoreJobClaim: fenced(nativeAuthRestoreJob.readNativeRestoreJobClaim),
      observeNativeRestoreJob: fenced(observeNativeRestoreJob),
      readNativeRestoreJobInput: fenced(nativeAuthRestoreJob.readNativeRestoreJobInput),
      reserveNativeRestorePin: fenced(nativeAuthRestoreJob.reserveNativeRestorePin),
      recordNativeRestorePin: fenced(nativeAuthRestoreJob.recordNativeRestorePin),
      recordNativeRestorePinAbsent: fenced(nativeAuthRestoreJob.recordNativeRestorePinAbsent),
      readNativeRestorePinReconciliation: fenced(
        nativeAuthRestoreJob.readNativeRestorePinReconciliation,
      ),
      completeNativeRestorePinReconciliation: fenced(
        nativeAuthRestoreJob.completeNativeRestorePinReconciliation,
      ),
      assertNativeRestoreImportAllowed: fenced(
        nativeAuthRestoreJob.assertNativeRestoreImportAllowed,
      ),
      beginNativeRestoreJob: fenced(nativeAuthRestoreJob.beginNativeRestoreJob),
      isNativeRestoreRealmImported: fenced(nativeAuthRestoreJob.isNativeRestoreRealmImported),
      markNativeRestoreRealmImported: fenced(nativeAuthRestoreJob.markNativeRestoreRealmImported),
      isNativeRestoreAcknowledged: fenced(nativeAuthRestoreJob.isNativeRestoreAcknowledged),
      acknowledgeNativeRestoreJob: fenced(nativeAuthRestoreJob.acknowledgeNativeRestoreJob),
      consumeNativeRestoreJobInput: fenced(nativeAuthRestoreJob.consumeNativeRestoreJobInput),
      finishNativeRestoreJob: fenced(nativeAuthRestoreJob.finishNativeRestoreJob),
      readNativeRestoreForSanitization: fenced(readNativeRestoreForSanitization),
      readNativeAuthProvisioningPolicy: fenced(readNativeAuthProvisioningPolicy),
      readDomainPolicySync: fenced(nativeAuthDomainSync.readDomainPolicySync),
      ackDomainPolicySync: fenced(nativeAuthDomainSync.ackDomainPolicySync),
      beginHandleDomainRecovery: fenced(nativeAuthDomainRecovery.beginHandleDomainRecovery),
      completeHandleDomainRecovery: fenced(nativeAuthDomainRecovery.completeHandleDomainRecovery),
      beginPaidDomainRecovery: fenced(nativeAuthDomainRecovery.beginPaidDomainRecovery),
      completePaidDomainRecovery: fenced(nativeAuthDomainRecovery.completePaidDomainRecovery),
      readNativeAuthDatabaseReconciliation: fenced(
        nativeAuthResourceOperations.readNativeAuthDatabaseReconciliation,
      ),
      readNativeAuthPreviewReconciliation: fenced(
        nativeAuthResourceOperations.readNativeAuthPreviewReconciliation,
      ),
      resolveNativeAuthDatabaseClaim: fenced(
        nativeAuthResourceOperations.resolveNativeAuthDatabaseClaim,
      ),
      initializeNativeAuthRealm: fenced(nativeAuthResourceOperations.initializeNativeAuthRealm),
      reserveNativeAuthDatabaseOperation: fenced(
        nativeAuthResourceOperations.reserveNativeAuthDatabaseOperation,
      ),
      beginNativeAuthDatabaseOperation: fenced(
        nativeAuthResourceOperations.beginNativeAuthDatabaseOperation,
      ),
      recordNativeAuthDatabaseObservation: fenced(
        nativeAuthResourceOperations.recordNativeAuthDatabaseObservation,
      ),
      reserveNativeAuthRoleOperation: fenced(
        nativeAuthResourceOperations.reserveNativeAuthRoleOperation,
      ),
      beginNativeAuthRoleOperation: fenced(
        nativeAuthResourceOperations.beginNativeAuthRoleOperation,
      ),
      recordNativeAuthRoleObservation: fenced(
        nativeAuthResourceOperations.recordNativeAuthRoleObservation,
      ),
      recordNativeAuthPreparation: fenced(nativeAuthResourceOperations.recordNativeAuthPreparation),
      reserveNativeAuthRegistration: fenced(nativeAuthRegistration.reserveNativeAuthRegistration),
      authorizeNativeAuthRegistration: fenced(
        nativeAuthRegistration.authorizeNativeAuthRegistration,
      ),
      confirmNativeAuthRegistration: fenced(nativeAuthRegistration.confirmNativeAuthRegistration),
      readNativeAuthRegistration: fenced(nativeAuthRegistration.readNativeAuthRegistration),
      fenceNativeAuthRegistrationRevocation: fenced(
        nativeAuthRegistration.fenceNativeAuthRegistrationRevocation,
      ),
      authorizeNativeAuthRegistrationRevocation: fenced(
        nativeAuthRegistration.authorizeNativeAuthRegistrationRevocation,
      ),
      resolveNativeAuthRegistrationGeneration: fenced(
        nativeAuthRegistration.resolveNativeAuthRegistrationGeneration,
      ),
      readNativeAuthDatabaseEnvironments: fenced(
        nativeAuthRegistration.readNativeAuthDatabaseEnvironments,
      ),
      authorizeNativeMail: fenced(authorizeNativeMail),
      readNativeAuthReadiness: fenced(readNativeAuthReadiness),
      resolveNativeAuthAuthority: fenced(resolveNativeAuthAuthority),
      resolveNativeAuthAtomicSnapshot: fenced(resolveNativeAuthAtomicSnapshot),
      recordNativeAuthProviderSuccess: fenced(recordNativeAuthProviderSuccess),
      resolveNativeAuthAdminAuthority: fenced(resolveNativeAuthAdminAuthority),
      resolveNativeAuthProviderPolicy: fenced(resolveNativeAuthProviderPolicy),
      authorizeNativeAuthOwnerOperation: fenced(authorizeNativeAuthOwnerOperation),
      acceptNativeAuthUserMutation: fenced(nativeAuthUserAcceptance.acceptNativeAuthUserMutation),
      authorizeAcceptedNativeAuthUserMutation: fenced(
        nativeAuthUserAcceptance.authorizeAcceptedNativeAuthUserMutation,
      ),
      applyOrganizationSnapshot: fenced(applyWorkosSnapshot),
      assertOperationDelegationCurrent: fenced(assertOperationDelegationCurrent),
      recordMembershipBarrier: fenced(recordMembershipBarrier),
      recordTerminalRevocation: fenced(recordTerminalRevocation),
      isSessionEligible: fenced(isSessionEligible),
      authorizeUserApiKeyScope: fenced(authorizeUserApiKeyScope),
      claimUserApiKeyCreation: fenced(claimUserApiKeyCreation),
      finishUserApiKeyCreation: fenced(finishUserApiKeyCreation),
      readUserApiKeyNames: fenced(readUserApiKeyNames),
      // the WorkOS management Worker's session-revocation read and key-revocation audit
      ...createWorkosCallerCommands(fenced),
      // the WorkOS management Worker's snapshot poller: claim, apply with the exact acknowledgement, failure, recovery
      ...createWorkosPollerCommands(fenced),
      ...createWorkosAuxiliaryCommands(fenced),
      isSignupFeedbackClaim: fenced(isSignupFeedbackClaim),
      insertMcpHandoff: fenced(insertMcpHandoff),
      findMcpHandoff: fenced(findMcpHandoff),
      consumeMcpHandoff: fenced(consumeMcpHandoff),
      completeMcpSecret: fenced(completeMcpSecret),
      readNativeProviderHandoffState: fenced(readNativeProviderHandoffState),
      claimNativeProviderHandoff: fenced(claimNativeProviderHandoff),
      completeNativeProviderHandoff: fenced(completeNativeProviderHandoff),
      completeMcpGithub: fenced(completeMcpGithub),
      ensureMcpConnectionProof: fenced(ensureMcpConnectionProof),
      revokeMcpConsent: fenced(revokeMcpConsent),
      listOrganizationMcpConnections: fenced(listOrganizationMcpConnections),
      revokeOrganizationMcpConnection: fenced(revokeOrganizationMcpConnection),
    }),
    projects: Object.freeze({
      createInitialProject: fenced(createInitialProject),
      /** The Control API's project admission (one batch) and reads, authentication/authorization lookups. */
      admitCustomerProject: fenced(admitCustomerProject),
      addDevelopmentEnvironment: fenced(addDevelopmentEnvironment),
      listCustomerProjects: fenced(listCustomerProjects),
      getCustomerProject: fenced(getCustomerProject),
      readTakenProjectHandles: fenced(readTakenProjectHandles),
      resolveWorkosOrganization: fenced(resolveWorkosOrganization),
      resolveM2mOrganization: fenced(resolveM2mOrganization),
      authorizeOrganizationAction: fenced(authorizeOrganizationAction),
    }),
    ingress: Object.freeze({
      recordWorkosWebhook: refreshed(ingress.recordWorkosWebhook),
      recordGithubWebhook: refreshed(ingress.recordGithubWebhook),
      recordStripeWebhook: refreshed(ingress.recordStripeWebhook),
    }),
    operations: Object.freeze({
      acceptApiOperation: fenced(acceptApiOperation),
      queueOperation: fenced(queueOperation),
      loadOperation: fenced(loadOperation),
      transitionOperation: fenced(transitionOperation),
      readBlockingProductOperation: fenced(readBlockingProductOperation),
      renewOperationLease: fenced(renewOperationLease),
      recoverExpiredOperationLease: fenced(exactOperationOnly(recoverExpiredOperationLease)),
      claimOutboxEvent: fenced(exactScopeOnly(claimOutboxEvent)),
      recordOutboxDeliveryFailure: fenced(recordOutboxDeliveryFailure),
      requireOutboxReconciliation: fenced(requireOutboxReconciliation),
      acknowledgeOutboxEvent: fenced(acknowledgeOutboxEvent),
      recoverExpiredFinalOutboxLease: fenced(exactScopeOnly(recoverExpiredFinalOutboxLease)),
      readAuditEvents: fenced(readAuditEvents),
      readStoredIdempotencyResponse: fenced(readStoredIdempotencyResponse),
      recordInboxEvent: fenced(recordInboxEvent),
      claimInboxEvent: fenced(exactScopeOnly(claimInboxEvent)),
      renewInboxLease: fenced(renewInboxLease),
      acknowledgeInboxEvent: fenced(acknowledgeInboxEvent),
      failInboxEvent: fenced(failInboxEvent),
      findExpiredFinalInboxClaim: fenced(exactScopeOnly(findExpiredFinalInboxClaim)),
      recoverExpiredFinalInboxLease: fenced(recoverExpiredFinalInboxLease),
    }),
    maintenance: Object.freeze({
      expireNativeRestoreInputs: fenced(nativeAuthRestoreJob.expireNativeRestoreInputs),
      // the operator's read of rows that need a person (parked events, exhausted reservations and operations)
      listParkedRows: fenced(listParkedRows),
      // shard-wide drains and reapers
      recoverExpiredOperationLease: fenced(recoverExpiredOperationLease),
      claimOutboxEvent: fenced(claimOutboxEvent),
      recoverExpiredFinalOutboxLease: fenced(recoverExpiredFinalOutboxLease),
      claimInboxEvent: fenced(claimInboxEvent),
      findExpiredFinalInboxClaim: fenced(findExpiredFinalInboxClaim),
      routeUnroutedInboxEvents: fenced(routeUnroutedInboxEvents),
      resolveProjectReservations: fenced(resolveProjectReservations),
      // the global sweep of the domain reservation saga (scans the whole directory)
      settleDomainReservations: platform.maintenance.settleDomainReservations,
      // doorbells, driven by the sweeper
      ringDoorbell: fenced(ring),
      claimDoorbells: fenced(claimDoorbells),
      settleDoorbell: fenced(settleDoorbell),
      healDoorbells: fenced(healDoorbells),
      // retention: implemented and tested, not exposed by any Worker entrypoint until owner and archive qualification
      purgeExpiredIdempotencyRecords: fenced(purgeExpiredIdempotencyRecords),
      purgeAcknowledgedOutbox: fenced(purgeAcknowledgedOutbox),
      purgeAcknowledgedInbox: fenced(purgeAcknowledgedInbox),
      purgeMembershipBarriers: fenced(purgeMembershipBarriers),
      purgeUserApiKeyRequests: fenced(purgeUserApiKeyRequests),
      purgeMcpHandoffs: fenced(purgeMcpHandoffs),
      purgeCommandLog: fenced(purgeCommandLog),
      purgeUnroutedInbox: fenced(purgeUnroutedInbox),
      // the directory's expired handoff routes (global, not tenant-scoped); a scheduled sweeper pages it by chunk
      purgeMcpHandoffRoutes: fenced(purgeMcpHandoffRoutes),
      // deletes reconciliation_required webhook_inbox rows only inside a registered evidence export; no entrypoint
      // until the verified R2 export writer is qualified, because a registered export row is what authorizes it
      purgeReconciliationInbox: fenced(purgeReconciliationInbox),
      purgeRevocations: fenced(purgeRevocations),
      purgeOnboardingRequests: fenced(purgeOnboardingRequests),
      recordEvidenceExport: fenced(recordEvidenceExport),
      advanceRetentionHorizon: fenced(advanceRetentionHorizon),
      purgeEvidenceBelowHorizon: fenced(purgeEvidenceBelowHorizon),
      pageEvidenceRows: fenced(pageEvidenceRows),
    }),
  });
}

export type ControlStore = ReturnType<typeof createControlStore>;
import { createGatewayCommands } from "./catalog/gateway/commands.js";
