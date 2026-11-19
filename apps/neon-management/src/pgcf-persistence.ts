import type {
  reserveDatabaseProviderOperation,
  recordDatabaseProviderOperation,
  readDatabaseProviderOperation,
  reservePgcfDatabaseRegistration,
  reservePgcfDatabaseReauthorization,
  readPgcfDatabaseDeletion,
  DatabaseProviderClaim,
  DatabaseProviderScope,
  DatabaseProviderTarget,
  DatabaseProviderOperation,
  PgcfProjectDatabaseRegistrationMetadata,
  PgcfDatabaseDeletionRequest,
} from "@ohmyhost/database";

type PgcfTarget = Extract<DatabaseProviderTarget, { provider: "pgcf" }>;
interface LogicalDatabaseScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}
interface MigrationReceipt {
  readonly claim: DatabaseProviderClaim;
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly bundleSha256: string;
  readonly appliedPaths: readonly string[];
  readonly replayedPaths: readonly string[];
  readonly completedAt: string;
}
type Reauthorization = Parameters<typeof reservePgcfDatabaseReauthorization>[1];
/** Semantic Control transactions only. Provider calls, app SQL and credentials stay in management. */
export interface PgcfManagementPersistence {
  resolveClaim(
    input: LogicalDatabaseScope & { operationId: string; claimId: string },
  ): Promise<DatabaseProviderClaim & { regionId: "us-dev" | "eu-dev" }>;
  readTarget(scope: DatabaseProviderScope): Promise<DatabaseProviderTarget | null>;
  authorizeClaim(claim: DatabaseProviderClaim & { readonly step?: string }): Promise<void>;
  nextTargetVersion(claim: DatabaseProviderClaim): Promise<number>;
  reserveOperation(
    input: Parameters<typeof reserveDatabaseProviderOperation>[1],
  ): Promise<DatabaseProviderOperation>;
  beginOperation(
    operation: DatabaseProviderOperation,
    now: string,
  ): Promise<"dispatch" | "observe">;
  recordOperation(
    operation: DatabaseProviderOperation,
    observation: Parameters<typeof recordDatabaseProviderOperation>[2],
    now: string,
  ): Promise<void>;
  readOperation(
    input: Parameters<typeof readDatabaseProviderOperation>[1],
  ): Promise<DatabaseProviderOperation | null>;
  activateNewTarget(claim: DatabaseProviderClaim, target: PgcfTarget, now: string): Promise<void>;
  recordMigrationReceipt(input: MigrationReceipt): Promise<void>;
  reserveRegistration(
    claim: DatabaseProviderClaim,
    host: string,
  ): ReturnType<typeof reservePgcfDatabaseRegistration>;
  putRegistration(
    claim: DatabaseProviderClaim,
    registration: PgcfProjectDatabaseRegistrationMetadata,
  ): Promise<void>;
  readRuntimeBinding(
    scope: LogicalDatabaseScope,
  ): Promise<PgcfProjectDatabaseRegistrationMetadata | null>;
  reserveReauthorization(
    input: Reauthorization,
  ): ReturnType<typeof reservePgcfDatabaseReauthorization>;
  putReauthorization(
    input: Reauthorization,
    registration: PgcfProjectDatabaseRegistrationMetadata,
  ): Promise<void>;
  readDeletion(input: PgcfDatabaseDeletionRequest): ReturnType<typeof readPgcfDatabaseDeletion>;
  recordDeletionRevocation(
    input: PgcfDatabaseDeletionRequest,
    registration: PgcfProjectDatabaseRegistrationMetadata,
    at: string,
  ): Promise<void>;
  retireTarget(input: PgcfDatabaseDeletionRequest, at: string): Promise<void>;
}
