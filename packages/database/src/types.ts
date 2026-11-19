import type { HostingRegion, Operation, Project, Ulid } from "@ohmyhost/platform";
import type { Pool, PoolClient } from "pg";

export type { Clock, Ulid, UlidFactory } from "@ohmyhost/platform";
export type QueuedOperation = Operation & { readonly state: "queued" };

export interface AuditEventInput {
  readonly eventId: Ulid;
  readonly projectId: Ulid;
  readonly operationId?: Ulid;
  readonly eventType: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxEventInput {
  readonly eventId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly availableAt?: string;
  readonly maxAttempts: number;
}

export interface InitialProjectTransaction {
  readonly organizationId: Ulid;
  readonly billingEpochId: Ulid;
  readonly principalId: string;
  readonly projectName: string;
  readonly dataMode?: "shared" | "isolated";
  readonly devAccessMode?: "protected" | "public";
  /** Chosen once at creation; the column's trigger rejects every later change. Defaults to `us`. */
  readonly region?: HostingRegion;
  readonly projectHandle: string;
  readonly projectHandleVersion: string;
  readonly projectHandleAttempt: number;
  readonly developmentEnvironmentId: Ulid;
  readonly productionEnvironmentId: Ulid;
  readonly project: Project;
  readonly operation: QueuedOperation;
  readonly audit: AuditEventInput;
  readonly outbox: OutboxEventInput;
}

export type QueryExecutor = Pool | PoolClient;

export interface ClaimedOutboxEvent {
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly billingEpochId: Ulid;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly attemptId: Ulid;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}
