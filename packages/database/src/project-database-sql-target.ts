interface TargetBase {
  readonly dataEnvironmentId: string;
  readonly providerProjectId: string;
  readonly roleName: string;
  readonly originHost: string | null;
}
export type ProjectDatabaseSqlTarget =
  | (TargetBase & { readonly provider: "neon"; readonly defaultBranchId: string })
  | (TargetBase & {
      readonly provider: "pgcf";
      readonly databaseId: string;
      readonly originHost: string;
    });
