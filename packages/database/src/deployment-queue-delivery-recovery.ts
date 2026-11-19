import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";
export declare const FINAL_ATTEMPT_LEASE_EXPIRED: "FINAL_ATTEMPT_LEASE_EXPIRED";
type DeploymentQueueDeliveryRecoveryEventType =
  | "DeploymentRequestedV1"
  | "DeploymentRollbackRequestedV1"
  | "DeploymentPromotionRequestedV1";

export type DeploymentQueueDeliveryRecoveryWorkflowOutcome =
  | "pending"
  | "complete"
  | "errored"
  | "terminated";

interface DeploymentQueueDeliveryRecoveryIdentityInput {
  readonly organizationId: Ulid;
  readonly operationId: Ulid;
  readonly reconciliationId: Ulid;
  readonly preparedAuditEventId: Ulid;
  readonly finalAuditEventId: Ulid;
  readonly actorId: string;
  readonly idempotencySha256: `sha256:${string}`;
}

export interface PrepareDeploymentQueueDeliveryRecoveryInput
  extends DeploymentQueueDeliveryRecoveryIdentityInput {
  readonly preparedAt: string;
}

export interface FinalizeDeploymentQueueDeliveryRecoveryInput
  extends DeploymentQueueDeliveryRecoveryIdentityInput {
  readonly eventType: DeploymentQueueDeliveryRecoveryEventType;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly billingEpochId: Ulid;
  readonly requestEventId: Ulid;
  readonly deliveryAttemptId: Ulid;
  readonly planId: Ulid | null;
  readonly deploymentId: Ulid;
  readonly workflowId: string;
  readonly recoveredAt: string;
  readonly workflowOutcome: DeploymentQueueDeliveryRecoveryWorkflowOutcome;
}

interface DeploymentQueueDeliveryRecoveryMessageBase {
  readonly version: 1;
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly billingEpochId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
}

export type DeploymentQueueDeliveryRecoveryMessage =
  | (DeploymentQueueDeliveryRecoveryMessageBase & {
      readonly eventType: "DeploymentRequestedV1";
      readonly planId: Ulid;
    })
  | (DeploymentQueueDeliveryRecoveryMessageBase & {
      readonly eventType: "DeploymentRollbackRequestedV1" | "DeploymentPromotionRequestedV1";
    });

export type DeploymentQueueDeliveryRecoveryPreparation =
  | Readonly<{ outcome: "not_applicable" }>
  | Readonly<{
      outcome: "prepared";
      reconciliationId: Ulid;
      organizationId: Ulid;
      projectId: Ulid;
      environmentId: Ulid;
      operationId: Ulid;
      billingEpochId: Ulid;
      requestEventId: Ulid;
      deliveryAttemptId: Ulid;
      planId: Ulid | null;
      deploymentId: Ulid;
      workflowId: string;
      originalMessage: DeploymentQueueDeliveryRecoveryMessage;
    }>
  | Readonly<{
      outcome: "recovered";
      reconciliationId: Ulid;
      operationId: Ulid;
      state: "pending" | "completed";
      readonly continueProviderReconciliation?: true;
    }>;

export type FinalizeDeploymentQueueDeliveryRecoveryResult = Readonly<{
  outcome: "recovered" | "duplicate" | "uncertain";
  reconciliationId: Ulid;
  operationId: Ulid;
  state: "pending" | "completed" | "uncertain";
  readonly continueProviderReconciliation?: true;
}>;

/**
 * Serializes all writers of one globally unique product operation before they take row locks.
 */
export declare function lockProductCommandOperationTransaction(
  client: TransactionClient,
  input: Pick<DeploymentQueueDeliveryRecoveryIdentityInput, "organizationId" | "operationId">,
): Promise<void>;

/**
 * Records the owner's recovery intent before the original logical Deployment Workflow is touched.
 * It is deliberately limited to the observed final lease-expiry delivery loss.
 */
export declare function prepareDeploymentQueueDeliveryRecovery(
  client: TransactionClient,
  input: PrepareDeploymentQueueDeliveryRecoveryInput,
): Promise<DeploymentQueueDeliveryRecoveryPreparation>;

/**
 * Atomically records the observed logical Workflow outcome and closes the exact failed Outbox.
 */
export declare function finalizeDeploymentQueueDeliveryRecovery(
  client: TransactionClient,
  input: FinalizeDeploymentQueueDeliveryRecoveryInput,
): Promise<FinalizeDeploymentQueueDeliveryRecoveryResult>;
