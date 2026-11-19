export interface NeonPlacementScope {
  readonly organizationId: string;
  readonly projectId: string;
  /** Physical data identity; the mutation claim retains its logical caller environment. */
  readonly environmentId: string;
  readonly operationId: string;
  readonly claimId: string;
}

export interface NeonPlacementInput extends NeonPlacementScope {
  readonly projectName: string;
  readonly regionId: string;
  readonly postgresVersion: 14 | 15 | 16 | 17 | 18;
}

export interface PersistedNeonPlacementReceipt extends NeonPlacementInput {
  readonly providerProjectId: string;
  readonly defaultBranchId: string;
  readonly operationIds: readonly string[];
  readonly state: "ready";
  readonly observedAt: Date;
}
