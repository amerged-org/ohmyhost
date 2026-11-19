export interface ProjectDatabaseRegistrationMetadata {
  readonly operationId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
  readonly registrationVersion: number;
  readonly region: "us" | "eu";
  readonly providerProjectId: string;
  readonly branchId: string;
  readonly originHost: string;
  readonly originDatabase: "neondb";
  readonly originUser: string;
  readonly authorizedEnvironmentIds: readonly string[];
  readonly status: "active" | "revoked";
}

export interface ProjectDatabaseReauthorizationInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly claimId: string;
  readonly physicalEnvironmentId: string;
  readonly authorizedEnvironmentIds: readonly string[];
}
