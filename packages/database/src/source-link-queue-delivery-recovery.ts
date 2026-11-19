import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";
type SourceLinkQueueDeliveryRecoveryWorkflowOutcome =
  | "pending"
  | "complete"
  | "errored"
  | "terminated";

interface SourceLinkQueueDeliveryRecoveryIdentityInput {
  readonly organizationId: Ulid;
  readonly operationId: Ulid;
  readonly reconciliationId: Ulid;
  readonly preparedAuditEventId: Ulid;
  readonly finalAuditEventId: Ulid;
  readonly actorId: string;
  readonly idempotencySha256: `sha256:${string}`;
}

export interface PrepareSourceLinkQueueDeliveryRecoveryInput
  extends SourceLinkQueueDeliveryRecoveryIdentityInput {
  readonly preparedAt: string;
}

export interface FinalizeSourceLinkQueueDeliveryRecoveryInput
  extends SourceLinkQueueDeliveryRecoveryIdentityInput {
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly billingEpochId: Ulid;
  readonly requestEventId: Ulid;
  readonly deliveryAttemptId: Ulid;
  readonly workflowId: string;
  readonly recoveredAt: string;
  readonly workflowOutcome: SourceLinkQueueDeliveryRecoveryWorkflowOutcome;
}

export interface SourceLinkQueueDeliveryRecoveryMessage {
  readonly version: 1;
  readonly eventType: "SourceLinkRequestedV1";
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly billingEpochId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
}

export type SourceLinkQueueDeliveryRecoveryPreparation =
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
      workflowId: string;
      originalMessage: SourceLinkQueueDeliveryRecoveryMessage;
    }>
  | Readonly<{
      outcome: "recovered";
      reconciliationId: Ulid;
      operationId: Ulid;
      state: "pending" | "completed";
      readonly continueProductWorkflowReplay?: true;
      readonly continueProductWorkflowReplayWithNewKey?: true;
      readonly continueProductWorkflowReplayAttemptIds?: readonly Ulid[];
      readonly completedProductWorkflowReplayAttemptIds?: readonly Ulid[];
    }>;

export type FinalizeSourceLinkQueueDeliveryRecoveryResult = Readonly<{
  outcome: "recovered" | "duplicate" | "uncertain";
  reconciliationId: Ulid;
  operationId: Ulid;
  state: "pending" | "completed" | "uncertain";
  readonly continueProductWorkflowReplay?: true;
  readonly continueProductWorkflowReplayWithNewKey?: true;
  readonly continueProductWorkflowReplayAttemptIds?: readonly Ulid[];
  readonly completedProductWorkflowReplayAttemptIds?: readonly Ulid[];
}>;

/**
 * Records a bounded owner recovery before the original SourceLink Workflow is touched.
 * This applies only to the observed final Queue lease-expiry loss, never to ordinary retries.
 */
export declare function prepareSourceLinkQueueDeliveryRecovery(
  client: TransactionClient,
  input: PrepareSourceLinkQueueDeliveryRecoveryInput,
): Promise<SourceLinkQueueDeliveryRecoveryPreparation>;

/**
 * Atomically preserves all failed-attempt evidence, closes only the exact Outbox flags, and
 * appends the principal Final audit after the original logical Workflow is observable.
 */
export declare function finalizeSourceLinkQueueDeliveryRecovery(
  client: TransactionClient,
  input: FinalizeSourceLinkQueueDeliveryRecoveryInput,
): Promise<FinalizeSourceLinkQueueDeliveryRecoveryResult>;

/**
 * Reads a closed SourceLink Queue-delivery recovery only after the complete persisted audit chain
 * and immutable Outbox scope prove it. It always returns the original reconciliation identity.
 */
export declare function readClosedSourceLinkQueueDeliveryRecovery(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<Extract<
  SourceLinkQueueDeliveryRecoveryPreparation,
  {
    outcome: "recovered";
  }
> | null>;

/**
 * Reads one exact terminal SourceLink replay attempt without consulting the current run pointer.
 * It is intentionally limited to append-only failure/reconciliation evidence so an older attempt
 * remains readable after a bounded successor has become active.
 */
export declare function readTerminalSourceLinkWorkflowReplayAttempt(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly attemptId: Ulid;
    readonly actorId: string;
    readonly idempotencyDigest: Uint8Array;
  },
): Promise<Readonly<{
  outcome: "completed";
  attemptId: Ulid;
}> | null>;
