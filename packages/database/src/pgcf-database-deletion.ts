import { type DatabaseProviderClaim } from "./database-provider-targets.js";
import type { TransactionClient } from "./transaction.js";
import type { PgcfProjectDatabaseRegistrationMetadata } from "./pgcf-database-registration.js";
export interface PgcfDatabaseDeletionRequest {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly physicalEnvironmentId: string;
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly registrationVersion: number | null;
}
export declare function readPgcfDatabaseDeletion(
  client: TransactionClient,
  input: PgcfDatabaseDeletionRequest,
): Promise<{
  claim: DatabaseProviderClaim;
  registration: PgcfProjectDatabaseRegistrationMetadata | null;
  registrationClaimId: string | null;
  region: "us" | "eu";
}>;
