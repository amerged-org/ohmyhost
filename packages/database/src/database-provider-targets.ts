import { parseUlid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export interface DatabaseProviderScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
}
export interface DatabaseProviderClaim extends DatabaseProviderScope {
  readonly operationId: string;
  readonly claimId: string;
}
export interface TargetBase extends DatabaseProviderScope {
  readonly targetVersion: number;
  readonly providerProjectId: string;
  readonly regionId: string;
  readonly runtimeRole: string;
  readonly credentialReference: string;
  readonly activatedAt: string | null;
}
export type DatabaseProviderTarget =
  | (TargetBase & { readonly provider: "neon"; readonly branchId: string })
  | (TargetBase & {
      readonly provider: "pgcf";
      readonly databaseId: string;
      readonly sizeClassId: string;
    });
export interface DatabaseProviderOperation extends DatabaseProviderClaim {
  readonly step: string;
  readonly idempotencyKey: string;
  readonly providerProjectId: string;
  readonly requestBody: Readonly<Record<string, unknown>>;
  readonly providerOperationId: string | null;
  readonly databaseId: string | null;
  readonly state: "reserved" | "dispatched" | "pending" | "succeeded" | "failed";
}
export class DatabaseProviderConflictError extends Error {
  constructor() {
    super("Database provider scope or durable identity conflicts");
    this.name = "DatabaseProviderConflictError";
  }
}
/** Private complete exports only; never exposed as a runtime or temporary customer role. */
export function pgcfBackupRoleName(physicalEnvironmentId: string): string {
  return `ohmyho_backup_${parseUlid(physicalEnvironmentId).toLowerCase()}`;
}

/** Current provider selection is explicit; an old Neon receipt never supplies a fallback. */
export declare function readDatabaseProviderTarget(
  client: TransactionClient,
  scope: DatabaseProviderScope,
): Promise<DatabaseProviderTarget | null>;
/** Persist request identity before I/O. Replays return the SAME key, target and body. */
export declare function reserveDatabaseProviderOperation(
  client: TransactionClient,
  input: DatabaseProviderClaim & {
    readonly step: string;
    readonly providerProjectId: string;
    readonly requestBody: Readonly<Record<string, unknown>>;
  },
): Promise<DatabaseProviderOperation>;

/** Read the original operation identity without inventing a second mutation for an existing role. */
export declare function readDatabaseProviderOperation(
  client: TransactionClient,
  input: DatabaseProviderClaim & {
    readonly step: string;
  },
): Promise<DatabaseProviderOperation | null>;
/** Commit this transaction before dispatch; concurrent callers can never send a fresh mutation. */
export declare function beginDatabaseProviderOperation(
  client: TransactionClient,
  input: DatabaseProviderOperation,
): Promise<"dispatch" | "observe">;
export declare function recordDatabaseProviderOperation(
  client: TransactionClient,
  input: DatabaseProviderOperation,
  observation: {
    readonly databaseId: string;
    readonly providerOperationId: string | null;
    readonly state: "pending" | "succeeded" | "failed";
  },
): Promise<void>;
