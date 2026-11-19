import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export interface ProductWorkflowReplayCandidate {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly eventId: Ulid;
  readonly billingEpochId: Ulid;
  readonly logicalWorkflowId: string;
  readonly eventType:
    | "SourceLinkRequestedV1"
    | "ProjectDeletionRequestedV1"
    | "ProjectDataChangeRequestedV1"
    | "DeploymentRollbackRequestedV1"
    | "DeploymentPromotionRequestedV1";
  readonly queueHandoffPending?: boolean;
  readonly dataChange?: string | null;
}

export declare function findProductWorkflowReplayCandidate(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<ProductWorkflowReplayCandidate | null>;

/** An event exhausted before its Workflow run row existed; its current attempt is the one to accept. */
export interface RunlessProductDispatch {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly eventId: Ulid;
  readonly attemptId: Ulid;
  readonly billingEpochId: Ulid;
  readonly eventType:
    | "SourceLinkRequestedV1"
    | "DeploymentRollbackRequestedV1"
    | "DeploymentPromotionRequestedV1"
    | "ProjectDeletionRequestedV1"
    | "ProjectDataChangeRequestedV1";
  readonly planId: string | null;
  readonly requestedHandle: string | null;
  readonly dataChange: string | null;
}

export declare function findRunlessProductDispatch(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<RunlessProductDispatch | null>;

/** Accepts the run-less event's current attempt: the Workflow run is inserted queued, and FIND then matches it. */
export declare function acceptRunlessProductDispatch(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly eventId: Ulid;
    readonly attemptId: Ulid;
    readonly workflowId: string;
    readonly acceptedAt: string;
  },
): Promise<unknown>;

export declare function finalizeProjectDeletionQueueHandoff(
  client: TransactionClient,
  input: ProductWorkflowReplayCandidate & {
    readonly auditEventId: Ulid;
    readonly actorId: string;
    readonly acknowledgedAt: string;
  },
): Promise<"acknowledged" | "existing">;

export declare function prepareProductWorkflowReplay(
  client: TransactionClient,
  input: ProductWorkflowReplayCandidate & {
    readonly attemptId: Ulid;
    readonly physicalWorkflowId: string;
    readonly actorId: string;
    readonly idempotencyDigest: Uint8Array;
    readonly preparedAt: string;
  },
): Promise<"prepared" | "existing" | "exhausted">;

export declare function readProductWorkflowReplayAttempt(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly attemptId: Ulid;
    readonly actorId: string;
    readonly idempotencyDigest: Uint8Array;
  },
): Promise<
  | null
  | {
      readonly outcome: "completed";
      readonly attemptId: Ulid;
    }
  | {
      readonly outcome: "prepared";
      readonly attemptId: Ulid;
      readonly physicalWorkflowId: string;
      readonly originalMessage: Readonly<Record<string, unknown>>;
    }
>;

export declare function activateProductWorkflowReplayAttempt(
  client: TransactionClient,
  input: {
    readonly attemptId: Ulid;
    readonly physicalWorkflowId: string;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly eventId: Ulid;
  },
): Promise<"active">;

export declare function recoverTerminalProductWorkflowReplay(
  client: TransactionClient,
  input: {
    readonly failureId: Ulid;
    readonly attemptId: Ulid;
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly actorId: string;
    readonly terminalStatus: "errored" | "terminated";
    readonly evidenceDigest: Uint8Array;
    readonly recoveredAt: string;
  },
): Promise<"recovered" | "existing">;
