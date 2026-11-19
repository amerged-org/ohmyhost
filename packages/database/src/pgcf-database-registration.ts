import { type DatabaseProviderClaim } from "./database-provider-targets.js";
import type { TransactionClient } from "./transaction.js";
import type { ProjectDatabaseRegistrationMetadata } from "./project-database-registration.js";
import { type ProjectDatabaseReauthorizationInput } from "./project-database-registration.js";

export interface PgcfProjectDatabaseRegistrationMetadata {
  readonly provider: "pgcf";
  readonly databaseId: string;
  readonly operationId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
  readonly registrationVersion: number;
  readonly region: "us" | "eu";
  readonly providerProjectId: string;
  readonly originHost: string;
  readonly originDatabase: string;
  readonly originUser: string;
  readonly authorizedEnvironmentIds: readonly string[];
  readonly status: "active" | "revoked";
}
export type AnyProjectDatabaseRegistrationMetadata =
  | ProjectDatabaseRegistrationMetadata
  | PgcfProjectDatabaseRegistrationMetadata;
export declare function reservePgcfDatabaseRegistration(
  client: TransactionClient,
  claim: DatabaseProviderClaim,
  originHost: string,
): Promise<{
  registration: PgcfProjectDatabaseRegistrationMetadata;
  completed: boolean;
  previous: AnyProjectDatabaseRegistrationMetadata | null;
}>;
export declare function reservePgcfDatabaseReauthorization(
  client: TransactionClient,
  input: ProjectDatabaseReauthorizationInput,
): Promise<{
  registration: PgcfProjectDatabaseRegistrationMetadata;
  previous: PgcfProjectDatabaseRegistrationMetadata;
  completed: boolean;
} | null>;
