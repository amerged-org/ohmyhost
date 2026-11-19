import {
  AUTHORIZATION_ACTIONS,
  parseUlid,
  toAuthorizationPrincipal,
  type Ulid,
} from "@ohmyhost/platform";
import { WORKOS_USER_API_KEY_PATTERN } from "@ohmyhost/workos-auth-contracts";
import type { WorkosUserApiKeyValidationPort } from "./workos-user-api-keys.js";
import {
  InvalidWorkosTokenError,
  verifyWorkosToken,
  type WorkosTokenVerificationPolicy,
  type WorkosTokenVerifierDependencies,
  type WorkosConnectUserTokenVerificationPolicy,
} from "@ohmyhost/workos-token-verifier";

import {
  AuthenticationUnavailableError,
  type AuthenticatedPrincipal,
  type BearerAuthenticator,
} from "./contracts.js";
import type { WorkosSessionStatusPort } from "./workos-session-status.js";

export interface WorkosOrganizationResolver {
  resolve(workosOrganizationId: string): Promise<Ulid | null>;
  resolveM2m(input: {
    readonly connectClientId: string;
    readonly workosOrganizationId: string;
    readonly observedAt: string;
  }): Promise<{ readonly organizationId: Ulid; readonly scopes: readonly string[] } | null>;
}

export interface WorkosBearerAuthenticatorDependencies {
  readonly policies: readonly WorkosTokenVerificationPolicy[];
  readonly verifier: WorkosTokenVerifierDependencies;
  readonly organizations: WorkosOrganizationResolver;
  readonly sessionStatus: WorkosSessionStatusPort;
  readonly apiKeys?: WorkosUserApiKeyValidationPort;
}

/** Verified identity only; current memberships, canonical rights and connection state decide access. */
export interface VerifiedWorkosConnectPrincipal extends AuthenticatedPrincipal {
  readonly connectUser: {
    readonly issuer: string;
    readonly audience: readonly string[];
    readonly clientId: string;
    readonly userId: string;
    readonly workosOrganizationId: string | null;
    readonly consentId: string;
    readonly tokenId: string | null;
    readonly tokenExpiresAt: number;
  };
}

export interface WorkosConnectUserAuthenticatorDependencies {
  readonly policy: WorkosConnectUserTokenVerificationPolicy;
  readonly verifier: WorkosTokenVerifierDependencies;
  readonly organizations: Pick<WorkosOrganizationResolver, "resolve">;
}

/** Does not accept login sessions, API keys or service tokens, and never synthesizes permissions. */
export function createWorkosConnectUserAuthenticator({
  policy,
  verifier,
  organizations,
}: WorkosConnectUserAuthenticatorDependencies): {
  authenticate(token: string): Promise<VerifiedWorkosConnectPrincipal | null>;
} {
  return {
    async authenticate(token) {
      try {
        const claims = await verifyWorkosToken(token, policy, verifier);
        const organizationId =
          claims.organizationId === undefined
            ? null
            : await organizations.resolve(claims.organizationId);
        // A retired selected-workspace mapping is not revocation of the verified account.
        // Composition independently resolves every current authorized membership.
        const rawRestriction = claims.authorizationRestriction;
        const actions = rawRestriction?.["actions"];
        if (
          actions?.some((action) => !(AUTHORIZATION_ACTIONS as readonly string[]).includes(action))
        )
          return null;
        const ids = (name: string) =>
          rawRestriction?.[name]?.map((id) => {
            try {
              return parseUlid(id);
            } catch {
              throw new InvalidWorkosTokenError("Invalid authorization restriction");
            }
          });
        const organizationIds = ids("organizationIds");
        const projectIds = ids("projectIds");
        const mailDomainIds = ids("mailDomainIds");
        const authorizationRestriction =
          rawRestriction === undefined
            ? undefined
            : {
                ...(actions === undefined
                  ? {}
                  : { actions: actions as import("@ohmyhost/platform").AuthorizationAction[] }),
                ...(organizationIds === undefined ? {} : { organizationIds }),
                ...(projectIds === undefined ? {} : { projectIds }),
                ...(mailDomainIds === undefined ? {} : { mailDomainIds }),
              };
        const authorizationPrincipal = toAuthorizationPrincipal({
          kind: "workos_user",
          userId: claims.subject,
        });
        return {
          actorId: authorizationPrincipal.subjectId,
          credentialId: `workos_connect:${claims.clientId}:${claims.consentId}`,
          authorizationPrincipal,
          organizationIds: organizationId === null ? [] : [parseUlid(organizationId)],
          ...(authorizationRestriction === undefined ? {} : { authorizationRestriction }),
          connectUser: {
            issuer: claims.issuer,
            audience: claims.audience,
            clientId: claims.clientId,
            userId: claims.subject,
            workosOrganizationId: claims.organizationId ?? null,
            consentId: claims.consentId,
            tokenId: claims.tokenId ?? null,
            tokenExpiresAt: claims.expiresAt,
          },
        };
      } catch (error) {
        if (error instanceof InvalidWorkosTokenError) return null;
        throw new AuthenticationUnavailableError({ cause: error });
      }
    },
  };
}

export function createWorkosBearerAuthenticator({
  policies,
  verifier,
  organizations,
  sessionStatus,
  apiKeys,
}: WorkosBearerAuthenticatorDependencies): BearerAuthenticator {
  if (policies.length === 0) {
    throw new TypeError("At least one WorkOS token policy is required");
  }
  return {
    async authenticate(token): Promise<AuthenticatedPrincipal | null> {
      if (token.startsWith("sk_")) {
        if (!apiKeys || !WORKOS_USER_API_KEY_PATTERN.test(token)) return null;
        try {
          const key = await apiKeys.validate(token);
          if (
            !key ||
            (key.expiresAt !== null && Date.parse(key.expiresAt) <= verifier.clock.now().getTime())
          )
            return null;
          const organizationId = await organizations.resolve(key.organizationId);
          if (organizationId === null) return null;
          const authorizationPrincipal = toAuthorizationPrincipal({
            kind: "workos_user",
            userId: key.userId,
          });
          return {
            userApiKey: key,
            actorId: authorizationPrincipal.subjectId,
            credentialId: `user_api_key:${key.id}`,
            authorizationPrincipal,
            organizationIds: [parseUlid(organizationId)],
            authorizationScopeConstraint: key.permissions.filter((permission) =>
              (AUTHORIZATION_ACTIONS as readonly string[]).includes(permission),
            ),
          };
        } catch (error) {
          throw new AuthenticationUnavailableError({ cause: error });
        }
      }
      for (const policy of policies) {
        let failureStage: "TOKEN" | "SESSION" | "ORGANIZATION" = "TOKEN";
        try {
          const claims = await verifyWorkosToken(token, policy, verifier);
          const authorizationPrincipal = toAuthorizationPrincipal(
            claims.kind === "session"
              ? { kind: "workos_user", userId: claims.subject }
              : { kind: "m2m_service", clientId: claims.clientId },
          );
          if (claims.kind === "session") {
            if (claims.sessionId === undefined) return null;
            failureStage = "SESSION";
            const active = await sessionStatus.isActive({
              sessionId: claims.sessionId,
              userId: claims.subject,
              organizationId: claims.organizationId ?? null,
              tokenExpiresAt: claims.expiresAt,
            });
            if (!active) return null;
          }
          failureStage = "ORGANIZATION";
          const m2mBinding =
            claims.kind === "m2m"
              ? await organizations.resolveM2m({
                  connectClientId: claims.clientId,
                  workosOrganizationId: claims.organizationId,
                  observedAt: verifier.clock.now().toISOString(),
                })
              : null;
          const organizationId =
            claims.kind === "m2m"
              ? (m2mBinding?.organizationId ?? null)
              : claims.organizationId === undefined
                ? null
                : await organizations.resolve(claims.organizationId);
          if (organizationId !== null) parseUlid(organizationId);
          if (claims.kind === "m2m" && m2mBinding === null) return null;
          if (
            claims.kind === "session" &&
            claims.organizationId !== undefined &&
            organizationId === null
          ) {
            return null;
          }
          const m2mScopes =
            claims.kind === "m2m" && m2mBinding !== null
              ? claims.scopes.filter((scope) => m2mBinding.scopes.includes(scope)).sort()
              : [];
          return {
            ...(claims.kind === "session" && claims.sessionId !== undefined
              ? {
                  session: {
                    sessionId: claims.sessionId,
                    userId: claims.subject,
                    organizationId: claims.organizationId ?? null,
                    tokenExpiresAt: claims.expiresAt,
                  },
                }
              : {}),
            actorId: authorizationPrincipal.subjectId,
            credentialId:
              claims.kind === "session"
                ? `workos_session:${claims.sessionId ?? claims.subject}`
                : `workos_token:${claims.tokenId ?? claims.clientId}`,
            authorizationPrincipal,
            organizationIds: organizationId === null ? [] : [organizationId],
            ...(claims.kind === "m2m"
              ? { authorizationScopeConstraint: m2mScopes }
              : claims.organizationId === undefined
                ? { authorizationScopeConstraint: [] }
                : {}),
          };
        } catch (error) {
          // Each configured policy is independently verified; no unverified claim selects a policy.
          if (!(error instanceof InvalidWorkosTokenError)) {
            console.error(
              JSON.stringify({
                level: "error",
                service: "control-api",
                code: `WORKOS_AUTH_${failureStage}_UNAVAILABLE`,
              }),
            );
            throw new AuthenticationUnavailableError({ cause: error });
          }
        }
      }
      return null;
    },
  };
}
