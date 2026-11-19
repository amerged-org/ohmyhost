/** Private service bindings only. None of these types is returned by the public fetch handler. */
export type OriginatingCredential =
  | {
      kind: "api_key";
      keyId: string;
      userId: string;
      workosOrganizationId: string;
      authorizationRestriction?: unknown;
    }
  | {
      kind: "session";
      sessionId: string;
      userId: string;
      workosOrganizationId: string | null;
      tokenExpiresAt: number;
      authorizationRestriction?: unknown;
    };
export interface ConnectionActor {
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  principalId: string;
  sessionId: string;
  browserSession: {
    sessionId: string;
    userId: string;
    organizationId: string | null;
    tokenExpiresAt: number;
  };
  originatingDelegation?: unknown;
  originatingCredential?: OriginatingCredential;
}
export interface ConfirmationMatch {
  result: string;
  principalId: string;
  sessionId: string;
  handoffHash: string;
}
export interface CapturedHandoff extends ConnectionActor {
  handoffHash: string;
  registration: string;
  ownershipVersion?: number;
  billingEpochId?: string;
  attemptExpiresAt: string;
}
export interface CapturedAttempt extends CapturedHandoff {
  attemptId: string;
  encryptedVerifier: { nonce: string; ciphertext: string; keyVersion: number };
  oidcNonce: string;
}
export interface CoreConnectionPort {
  createConnectionHandoff(
    input: ConnectionActor & { handoffHash: string; registration: string },
  ): Promise<boolean>;
  consumeConnectionHandoff(input: { handoffHash: string }): Promise<CapturedHandoff | null>;
  createConnectionAttempt(input: {
    handoffHash: string;
    attemptId: string;
    stateHash: string;
    cookieHash: string;
    encryptedVerifier: { nonce: string; ciphertext: string; keyVersion: number };
    oidcNonce: string;
  }): Promise<boolean>;
  readConnectionAttemptOrigin(input: {
    stateHash: string;
    cookieHash: string;
    registration: string;
  }): Promise<CapturedHandoff | null>;
  claimConnectionAttempt(input: {
    stateHash: string;
    cookieHash: string;
    registration: string;
  }): Promise<CapturedAttempt | null>;
  terminateConnectionAttempt(input: {
    attemptId: string;
    outcome: "denied" | "outcome_unknown";
  }): Promise<boolean>;
  persistConnectionPendingGrant(input: {
    attemptId: string;
    grantId: string;
    subject: string;
    encryptedTokens: { nonce: string; ciphertext: string; keyVersion: number };
    resultHash: string;
  }): Promise<boolean>;
  retainConnectionOrphan(input: {
    attemptId: string;
    grantId: string;
    subject: string | null;
    encryptedTokens: { nonce: string; ciphertext: string; keyVersion: number };
  }): Promise<boolean>;
  claimConnectionOrphanRevocation(input: { attemptId: string; claimId: string }): Promise<boolean>;
  markConnectionOrphanRevocationDispatched(input: {
    attemptId: string;
    claimId: string;
  }): Promise<boolean>;
  finishConnectionOrphanRevocation(input: {
    attemptId: string;
    claimId: string;
    outcome: "revoked" | "outcome_unknown";
  }): Promise<boolean>;
  readConnectionConfirmationOrigin(input: {
    resultHash: string;
  }): Promise<(ConnectionActor & { handoffHash?: string }) | null>;
  activateConnectionGrant(input: {
    resultHash: string;
    principalId: string;
    sessionId: string;
  }): Promise<{ state: "active"; grantId: string } | null>;
}
export type MutationAuthority =
  | {
      kind: "session";
      sessionId: string;
      userId: string;
      workosOrganizationId: string | null;
      tokenExpiresAt: number;
      authorizationRestriction?: unknown;
    }
  | {
      kind: "api_key";
      keyId: string;
      userId: string;
      workosOrganizationId: string;
      authorizationRestriction?: unknown;
    }
  | {
      kind: "mcp";
      grantId: string;
      clientId: string;
      consentHash: string;
      action: "integrations:manage";
      authorizationRestriction?: unknown;
    };
export interface OriginObserver {
  observeConnectionOrigin(input: ConnectionActor): Promise<void>;
  observeIntegrationMutation(
    input:
      | {
          organizationId: string;
          principalId: string;
          resourceKind: "project";
          projectId: string;
          environmentId: string;
          mutationAuthority: MutationAuthority;
        }
      | {
          organizationId: string;
          principalId: string;
          resourceKind: "organization";
          mutationAuthority: MutationAuthority;
        },
  ): Promise<void>;
}
export interface CatalogRequest {
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  principalId: string;
  grantId: string;
  providerOrganizationId?: number;
  teamId?: number;
}
export interface ConnectionBrokerManagement {
  catalogReadiness(input: {
    provider: string;
  }): Promise<{ state: "available" | "provider_unavailable" }>;
  providerReadiness(input: { provider: string }): Promise<{
    state:
      | "available"
      | "provider_unconfigured"
      | "provider_misconfigured"
      | "provider_unavailable";
  }>;
  beginBrowser(input: ConnectionActor): Promise<{ url: string }>;
  listConnectionCatalog(input: CatalogRequest): Promise<unknown>;
  disconnectConnectionGrant(input: {
    organizationId: string;
    principalId: string;
    grantId: string;
    idempotencyKey: string;
    mutationAuthority: MutationAuthority;
  }): Promise<{ state: "disconnected" | "revocation_pending" }>;
  matchesConfirmation(input: ConfirmationMatch): Promise<boolean>;
  complete(input: { result: string; principalId: string; sessionId: string }): Promise<{
    state: "active";
    grantId: string;
    organizationId: string;
    projectId?: string;
    environmentId?: string;
  }>;
}
