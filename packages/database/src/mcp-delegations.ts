import type { AuthorizationAction, AuthorizationRestriction } from "@ohmyhost/platform";

export interface McpDelegationIdentity {
  readonly userId: string;
  readonly clientId: string;
  readonly consentHash: string;
  readonly organizationId: string;
}

export interface McpSecretTarget {
  readonly projectId: string;
  readonly environmentId: string;
  readonly environment: "dev" | "prod";
  readonly name: string;
  readonly names?: readonly string[];
  readonly submissionId?: string;
  readonly results?: readonly McpSecretResult[];
  readonly nativeProvider?: {
    readonly provider: "google" | "github";
    readonly configurationRevision: number;
    readonly enabled: boolean;
    readonly clientId?: string;
  };
}

export type McpSecretResult = "saved" | "failed" | "unconfirmed";

export interface McpHandoffAuthority {
  readonly grantId: string;
  readonly clientId: string;
  readonly consentHash: string;
  readonly action: AuthorizationAction;
  readonly authorizationRestriction?: AuthorizationRestriction;
  readonly secretSubmission?: { readonly requestHash: string; readonly id: string };
}

export interface McpPortalHandoff extends McpDelegationIdentity {
  readonly requestHash: string;
  readonly authority?: McpHandoffAuthority;
  readonly kind: "secret" | "github";
  readonly projectIds: readonly string[];
  readonly allowCreate: boolean;
  readonly allowPublish: boolean;
  readonly secretTarget: McpSecretTarget | null;
  readonly githubTarget?: { readonly idempotencyKey: string } | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly outcome:
    | "approved"
    | "declined"
    | "secret_submitted"
    | "secret_failed"
    | "github_started"
    | "github_failed"
    | null;
}

export interface McpDelegationGrant extends McpDelegationIdentity {
  readonly grantId: string;
  readonly projectId: string | null;
  readonly allowPublish: boolean;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

/** Persisted consent; callers also intersect this with current human REST authorization. */
export interface McpDelegationStore {
  insertHandoff(input: McpPortalHandoff): Promise<void>;
  findHandoff(requestHash: string): Promise<McpPortalHandoff | null>;
  consumeHandoff(input: {
    readonly requestHash: string;
    readonly userId: string;
    readonly organizationId: string;
    readonly now: string;
    readonly approve: boolean;
    readonly publish: boolean;
    readonly selectedProjectIds?: readonly string[];
    readonly submissionId?: string;
  }): Promise<McpPortalHandoff | null>;
  completeSecret(
    requestHash: string,
    outcome:
      | boolean
      | { readonly submissionId: string; readonly results: readonly McpSecretResult[] },
  ): Promise<void>;
  readNativeProviderHandoffState(input: {
    organizationId: string;
    userId: string;
    requestHash: string;
  }): Promise<"pending" | "retryable" | "succeeded" | "expired" | "declined" | null>;
  claimNativeProviderHandoff(input: {
    organizationId: string;
    userId: string;
    requestHash: string;
    attemptId: string;
    valueSha256: string;
  }): Promise<McpPortalHandoff | null>;
  completeNativeProviderHandoff(input: {
    organizationId: string;
    requestHash: string;
    attemptId: string;
    succeeded: boolean;
  }): Promise<boolean>;
  completeGithub(requestHash: string, succeeded: boolean): Promise<void>;
  ensureConnectionProof(
    identity: McpDelegationIdentity,
    projectId: string | null,
    now: string,
  ): Promise<McpDelegationGrant | null>;
  revoke(
    identity: Omit<McpDelegationIdentity, "organizationId">,
    now: string,
  ): Promise<{ state: "pending" | "revoked" }>;
}
