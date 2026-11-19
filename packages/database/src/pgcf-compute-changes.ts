import { type AcceptApiOperationInput } from "./api-operation-persistence.js";
import { type DatabaseProviderClaim } from "./database-provider-targets.js";
import type { TransactionClient } from "./transaction.js";

export interface PgcfComputeJob {
  readonly operationId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly physicalEnvironmentId: string;
  readonly billingEpochId: string;
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly targetVersion: number;
  readonly memoryMiB: number;
  readonly sizeClassId: string;
  readonly completedAt: string | null;
  readonly claimId: string | null;
  readonly claimExpiresAt: string | null;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
}
export declare function replayPgcfComputeChange(
  client: TransactionClient,
  input: {
    organizationId: string;
    projectId: string;
    principalId: string;
    idempotencyKey: string;
    canonicalRequestDigest: Uint8Array;
  },
): Promise<string | null>;
export declare function acceptPgcfComputeChange(
  client: TransactionClient,
  input: Omit<AcceptApiOperationInput, "eventType"> & {
    memoryMiB: number;
    currentStorageMiB: number;
    expectedDatabaseId: string;
    expectedTargetVersion: number;
  },
): Promise<{
  readonly outcome: "created" | "replayed";
  readonly operationId: import("@ohmyhost/platform").Ulid;
}>;
export declare function claimPgcfComputeJob(
  client: TransactionClient,
  input: {
    organizationId: string;
    projectId: string;
    operationId: string;
    claimId: string;
    occurredAt: string;
    operationEventId: string;
    auditEventId: string;
  },
): Promise<
  | (PgcfComputeJob & {
      mutationPermitted: boolean;
      providerDispatchStarted: boolean;
    })
  | null
>;
export declare function completePgcfComputeJob(
  client: TransactionClient,
  input: DatabaseProviderClaim & {
    occurredAt: string;
    operationEventId: string;
    auditEventId: string;
    success: boolean;
    failureCode?: "DATABASE_COMPUTE_FAILED" | "DATABASE_COMPUTE_PLAN_CHANGED";
  },
): Promise<void>;
