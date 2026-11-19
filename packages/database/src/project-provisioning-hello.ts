import { type Operation, type OperationFailure, type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export interface ProjectProvisioningHelloStepInput {
  readonly eventId: Ulid;
  readonly auditEventId: Ulid;
  readonly occurredAt: string;
}

export interface ProjectProvisioningHelloInput {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly requestEventId: Ulid;
  readonly workflowId: string;
  readonly serviceActorId: string;
  readonly started: ProjectProvisioningHelloStepInput;
  readonly succeeded: ProjectProvisioningHelloStepInput;
}

export interface ProjectProvisioningHelloFailureInput {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly requestEventId: Ulid;
  readonly workflowId: string;
  readonly serviceActorId: string;
  readonly started: ProjectProvisioningHelloStepInput;
  readonly failed: ProjectProvisioningHelloStepInput;
  readonly failure: OperationFailure;
}

export interface ProjectProvisioningHelloResult {
  readonly outcome: "applied" | "duplicate";
  readonly operation: Operation;
}
export declare const PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN: "PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN";

interface ProjectProvisioningQueueDeliveryRecoveryIdentityInput {
  readonly organizationId: Ulid;
  readonly operationId: Ulid;
  readonly reconciliationId: Ulid;
  readonly preparedAuditEventId: Ulid;
  readonly finalAuditEventId: Ulid;
  readonly actorId: string;
  readonly idempotencySha256: `sha256:${string}`;
}

export interface PrepareProjectProvisioningQueueDeliveryRecoveryInput
  extends ProjectProvisioningQueueDeliveryRecoveryIdentityInput {
  readonly preparedAt: string;
}

export interface FinalizeProjectProvisioningQueueDeliveryRecoveryInput
  extends ProjectProvisioningQueueDeliveryRecoveryIdentityInput {
  readonly projectId: Ulid;
  readonly requestEventId: Ulid;
  readonly deliveryAttemptId: Ulid;
  readonly workflowId: string;
  readonly recoveredAt: string;
  readonly workflowOutcome: ProjectProvisioningQueueDeliveryRecoveryWorkflowOutcome;
}

export type ProjectProvisioningQueueDeliveryRecoveryWorkflowOutcome =
  | "pending"
  | "complete"
  | "errored"
  | "terminated";

export type ProjectProvisioningQueueDeliveryRecoveryPreparation =
  | Readonly<{ outcome: "not_applicable" }>
  | Readonly<{
      outcome: "prepared";
      reconciliationId: Ulid;
      organizationId: Ulid;
      projectId: Ulid;
      operationId: Ulid;
      requestEventId: Ulid;
      deliveryAttemptId: Ulid;
      workflowId: string;
      /** Advisory snapshot only; finalization reloads the operation under lock. */
      operationState: "queued" | "succeeded" | "failed";
    }>
  | Readonly<{
      outcome: "recovered";
      reconciliationId: Ulid;
      operationId: Ulid;
      state: "pending" | "completed";
    }>;

export type FinalizeProjectProvisioningQueueDeliveryRecoveryResult = Readonly<{
  outcome: "recovered" | "duplicate" | "uncertain";
  reconciliationId: Ulid;
  operationId: Ulid;
  state: "pending" | "completed" | "uncertain";
}>;

export declare function completeProjectProvisioningHello(
  client: TransactionClient,
  input: ProjectProvisioningHelloInput,
): Promise<ProjectProvisioningHelloResult>;

export declare function failProjectProvisioningHello(
  client: TransactionClient,
  input: ProjectProvisioningHelloFailureInput,
): Promise<ProjectProvisioningHelloResult>;

/**
 * Records an operator's durable intent to recover only the observed final Queue-send uncertainty.
 * The caller must ensure the deterministic Workflow after this transaction commits.
 */
export declare function prepareProjectProvisioningQueueDeliveryRecovery(
  client: TransactionClient,
  input: PrepareProjectProvisioningQueueDeliveryRecoveryInput,
): Promise<ProjectProvisioningQueueDeliveryRecoveryPreparation>;

/**
 * Closes only the recovered Outbox flags after a deterministic Workflow is definitively observable.
 * The final audit and Outbox close share this transaction so a lost response can replay safely.
 */
export declare function finalizeProjectProvisioningQueueDeliveryRecovery(
  client: TransactionClient,
  input: FinalizeProjectProvisioningQueueDeliveryRecoveryInput,
): Promise<FinalizeProjectProvisioningQueueDeliveryRecoveryResult>;
