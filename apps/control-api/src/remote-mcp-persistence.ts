import type { McpDelegationStore } from "@ohmyhost/database";
export interface McpRecoveryContext {
  organization_id: string;
  project_id: string;
  state: string;
  event_type: string | null;
  environment_name: string | null;
}
export interface RemoteMcpPersistence {
  readonly store: McpDelegationStore;
  authorizedMemberships(input: {
    userId: string;
    clientId: string;
    consentHash: string;
  }): Promise<{ disconnected: boolean; organizationIds: readonly string[] }>;
  environmentName(scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  }): Promise<string | null>;
  mailDomainOrganization(mailDomainId: string): Promise<string | null>;
  projectOrganization(projectId: string, activeOnly: boolean): Promise<string | null>;
  grantRevision(grantId: string): Promise<string | null>;
  recoveryContext(
    operationId: string,
    organizationIds: readonly string[],
  ): Promise<readonly McpRecoveryContext[]>;
  authorizeExecution(scope: {
    organizationId: string;
    projectId: string;
    operationId: string;
  }): Promise<void>;
  planEnvironmentName(planId: string, projectId: string): Promise<string | null>;
}
