export declare const assertProjectBindingRefreshSnapshot: typeof import("./deployment-binding-refresh.js").assertProjectBindingRefreshSnapshot;
export { DeploymentPersistenceConflictError } from "./deployment-persistence.js";
export declare const recordCleanupAttempt: typeof import("./deployment-persistence.js").recordCleanupAttempt;
export declare const finalizeDeploymentQueueDeliveryRecovery: typeof import("./deployment-queue-delivery-recovery.js").finalizeDeploymentQueueDeliveryRecovery;
export declare const lockProductCommandOperationTransaction: typeof import("./deployment-queue-delivery-recovery.js").lockProductCommandOperationTransaction;
export declare const prepareDeploymentQueueDeliveryRecovery: typeof import("./deployment-queue-delivery-recovery.js").prepareDeploymentQueueDeliveryRecovery;
export declare const recordEnvironmentFunctionSchedule: typeof import("./function-schedules.js").recordEnvironmentFunctionSchedule;
export declare const deleteProjectFunctionSchedules: typeof import("./function-schedules.js").deleteProjectFunctionSchedules;
export declare const authorizeGithubPushActivation: typeof import("./github-auto-deploy.js").authorizeGithubPushActivation;
export declare const abandonLostProductCommand: typeof import("./lost-product-command.js").abandonLostProductCommand;
export declare const findLostProductCommand: typeof import("./lost-product-command.js").findLostProductCommand;
export declare const readManagedSourceDeletionInventory: typeof import("./managed-sources.js").readManagedSourceDeletionInventory;
export declare const assertOperationExecutionAuthorized: typeof import("./operation-delegations.js").assertOperationExecutionAuthorized;
export declare const appendAuditedProjectDataChangeAssignments: typeof import("./product-command-data-change.js").appendAuditedProjectDataChangeAssignments;
export declare const startProjectDataChangeCleanup: typeof import("./product-command-data-change.js").startProjectDataChangeCleanup;
export declare const activateProductProviderReconciliationAttempt: typeof import("./product-command-persistence.js").activateProductProviderReconciliationAttempt;
export declare const claimProductProviderMutation: typeof import("./product-command-persistence.js").claimProductProviderMutation;
export declare const failProductDeploymentCommand: typeof import("./product-command-persistence.js").failProductDeploymentCommand;
export declare const prepareProductProviderReconciliation: typeof import("./product-command-persistence.js").prepareProductProviderReconciliation;
export declare const readProductProviderReconciliationAttempt: typeof import("./product-command-persistence.js").readProductProviderReconciliationAttempt;
export declare const reconcileProductCommand: typeof import("./product-command-persistence.js").reconcileProductCommand;
export declare const recordRuntimeHealthDiagnostic: typeof import("./product-command-persistence.js").recordRuntimeHealthDiagnostic;
export declare const recoverTerminalProductProviderReconciliationAttempt: typeof import("./product-command-persistence.js").recoverTerminalProductProviderReconciliationAttempt;
export declare const completeProductCommand: typeof import("./product-command-persistence.js").completeProductCommand;
export declare const readRollbackPlanTarget: typeof import("./product-surface-queries.js").readRollbackPlanTarget;
export {
  type ProductProviderReconciliationContext,
  type ProductWorkflowContext,
  type ProductWorkflowDeletionDataEnvironment,
  type ProductWorkflowDeletionEnvironment,
  type ProductWorkflowGatewayReceipt,
  type ProductWorkflowWfpReceipt,
} from "./product-workflow-evidence.js";
export declare const findClaimlessProductProviderReconciliationCandidate: typeof import("./product-workflow-evidence.js").findClaimlessProductProviderReconciliationCandidate;
export declare const findProductProviderReconciliationClaim: typeof import("./product-workflow-evidence.js").findProductProviderReconciliationClaim;
export declare const readProductProviderReconciliationContext: typeof import("./product-workflow-evidence.js").readProductProviderReconciliationContext;
export declare const readProductWorkflowContext: typeof import("./product-workflow-evidence.js").readProductWorkflowContext;
export declare const readProductWorkflowDatabaseTarget: typeof import("./product-workflow-evidence.js").readProductWorkflowDatabaseTarget;
export declare const readCandidateCleanupResources: typeof import("./product-workflow-evidence.js").readCandidateCleanupResources;
export declare const recordAbandonedGatewayPredecessor: typeof import("./product-workflow-evidence.js").recordAbandonedGatewayPredecessor;
export declare const recordProductDeploymentEvidence: typeof import("./product-workflow-evidence.js").recordProductDeploymentEvidence;
export declare const recordProductSourceArchiveEvidence: typeof import("./product-workflow-evidence.js").recordProductSourceArchiveEvidence;
export declare const finalizeProjectDeletionQueueHandoff: typeof import("./product-workflow-replay.js").finalizeProjectDeletionQueueHandoff;
export declare const findProductWorkflowReplayCandidate: typeof import("./product-workflow-replay.js").findProductWorkflowReplayCandidate;
export declare const findRunlessProductDispatch: typeof import("./product-workflow-replay.js").findRunlessProductDispatch;
export declare const acceptRunlessProductDispatch: typeof import("./product-workflow-replay.js").acceptRunlessProductDispatch;
export declare const prepareProductWorkflowReplay: typeof import("./product-workflow-replay.js").prepareProductWorkflowReplay;
export declare const readProductWorkflowReplayAttempt: typeof import("./product-workflow-replay.js").readProductWorkflowReplayAttempt;
export declare const recoverTerminalProductWorkflowReplay: typeof import("./product-workflow-replay.js").recoverTerminalProductWorkflowReplay;
export declare const activateProductWorkflowReplayAttempt: typeof import("./product-workflow-replay.js").activateProductWorkflowReplayAttempt;
export declare const completeProjectProvisioningHello: typeof import("./project-provisioning-hello.js").completeProjectProvisioningHello;
export declare const failProjectProvisioningHello: typeof import("./project-provisioning-hello.js").failProjectProvisioningHello;
export declare const finalizeProjectProvisioningQueueDeliveryRecovery: typeof import("./project-provisioning-hello.js").finalizeProjectProvisioningQueueDeliveryRecovery;
export declare const prepareProjectProvisioningQueueDeliveryRecovery: typeof import("./project-provisioning-hello.js").prepareProjectProvisioningQueueDeliveryRecovery;
export declare const readProjectDataEnvironment: typeof import("./projects.js").readProjectDataEnvironment;
export declare const settleSharedGatewayCandidateCleanup: typeof import("./shared-gateway.js").settleSharedGatewayCandidateCleanup;
export { SourceArchiveReconciliationConflictError } from "./source-archives.js";
export declare const observeSourceArchiveReceipt: typeof import("./source-archives.js").observeSourceArchiveReceipt;
export declare const finalizeSourceLinkQueueDeliveryRecovery: typeof import("./source-link-queue-delivery-recovery.js").finalizeSourceLinkQueueDeliveryRecovery;
export declare const readClosedSourceLinkQueueDeliveryRecovery: typeof import("./source-link-queue-delivery-recovery.js").readClosedSourceLinkQueueDeliveryRecovery;
export declare const readTerminalSourceLinkWorkflowReplayAttempt: typeof import("./source-link-queue-delivery-recovery.js").readTerminalSourceLinkWorkflowReplayAttempt;
export declare const prepareSourceLinkQueueDeliveryRecovery: typeof import("./source-link-queue-delivery-recovery.js").prepareSourceLinkQueueDeliveryRecovery;
export {
  type AuditEventInput,
  type ClaimedOutboxEvent,
  type Clock,
  type QueryExecutor,
} from "./types.js";
export declare const authorizeWfpCandidateActivation: typeof import("./wfp-candidate-persistence.js").authorizeWfpCandidateActivation;
export declare const claimPendingWfpCandidateCleanup: typeof import("./wfp-candidate-persistence.js").claimPendingWfpCandidateCleanup;
export declare const finalizeRollbackActivation: typeof import("./wfp-candidate-persistence.js").finalizeRollbackActivation;
export declare const finalizeWfpCandidateDeployment: typeof import("./wfp-candidate-persistence.js").finalizeWfpCandidateDeployment;
export declare const markCandidateSuperseded: typeof import("./wfp-candidate-persistence.js").markCandidateSuperseded;
export declare const prepareCandidateCleanup: typeof import("./wfp-candidate-persistence.js").prepareCandidateCleanup;
export declare const readWfpProjectDeletionEvidence: typeof import("./wfp-candidate-persistence.js").readWfpProjectDeletionEvidence;
export declare const recordWfpCandidateCleanupReceipt: typeof import("./wfp-candidate-persistence.js").recordWfpCandidateCleanupReceipt;
export declare const recordWfpCandidateOperationCleanupReceipt: typeof import("./wfp-candidate-persistence.js").recordWfpCandidateOperationCleanupReceipt;
export declare const recordWfpCandidateReceipt: typeof import("./wfp-candidate-persistence.js").recordWfpCandidateReceipt;
export declare const resolveRollbackCandidate: typeof import("./wfp-candidate-persistence.js").resolveRollbackCandidate;
export { readPgcfPostgresTarget } from "./worker-postgres-targets.js";
