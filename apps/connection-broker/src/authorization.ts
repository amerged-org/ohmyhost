import { encodeBytes } from "./encoding.js";
import { KnownExchangeRejection, type ProviderAdapter } from "./adapter.js";
import type { BrokerSecrets } from "./config.js";
import { configurationState } from "./config.js";
import { openAttemptSecrets, sealAttemptSecrets, sealGrantTokens } from "./grant-vault.js";
import { parseAttemptCookie, parseCallback } from "./callback.js";
import type {
  ConfirmationMatch,
  ConnectionActor,
  CoreConnectionPort,
  OriginObserver,
} from "./ports.js";
import { validateIssuerCallbackPolicies, type ProviderRegistration } from "./registry.js";

type Environment = "development" | "production";
export interface BrokerDependencies {
  environment: Environment;
  registration: ProviderRegistration;
  registry: readonly ProviderRegistration[];
  secrets: BrokerSecrets;
  core: CoreConnectionPort;
  observer: OriginObserver;
  adapter: ProviderAdapter;
  qualified: boolean;
}
const bytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));
const opaque = () =>
  btoa(String.fromCharCode(...bytes(32)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) => {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new Error("invalid_ciphertext");
  return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
};
const b64tohex = (value: string) =>
  hex(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
const hextob64 = (value: string) => encodeBytes(unhex(value));
const hash = async (value: string) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
export function ulid(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = Date.now();
  let prefix = "";
  for (let index = 0; index < 10; index++) {
    prefix = alphabet.charAt(time % 32) + prefix;
    time = Math.floor(time / 32);
  }
  let suffix = "";
  for (const value of bytes(16)) suffix += alphabet[value & 31];
  return prefix + suffix;
}
function actor(value: ConnectionActor): ConnectionActor {
  return {
    organizationId: value.organizationId,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    ...(value.environmentId === undefined ? {} : { environmentId: value.environmentId }),
    principalId: value.principalId,
    sessionId: value.sessionId,
    browserSession: value.browserSession,
    ...(value.originatingDelegation === undefined
      ? {}
      : { originatingDelegation: value.originatingDelegation }),
    ...(value.originatingCredential === undefined
      ? {}
      : { originatingCredential: value.originatingCredential }),
  };
}
function key(deps: BrokerDependencies): Uint8Array {
  return Uint8Array.from(atob(deps.secrets.vaultKey ?? ""), (character) => character.charCodeAt(0));
}
function ready(deps: BrokerDependencies) {
  const state = configurationState(deps.secrets);
  if (state !== "configured") return state;
  if (
    deps.registration.provider === "make"
      ? deps.registration.noncePolicy !== "not_requested" ||
        deps.registration.registration !== `make-${deps.environment}-3`
      : deps.registration.noncePolicy !== "required"
  )
    return "provider_unavailable";
  try {
    validateIssuerCallbackPolicies(deps.registry);
  } catch {
    return "provider_unavailable";
  }
  return deps.registration.enabled &&
    deps.registry.includes(deps.registration) &&
    deps.qualified &&
    deps.core &&
    deps.observer &&
    deps.adapter
    ? "available"
    : "provider_unavailable";
}
function requireReady(deps: BrokerDependencies): void {
  if (ready(deps) !== "available") throw new Error("connection_provider_unavailable");
}
const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};
function portalOrigin(environment: Environment): string {
  return environment === "production" ? "https://app.ohmyho.st" : "https://dev.app.ohmyho.st";
}
function errorResponse(environment: Environment): Response {
  return new Response(null, {
    status: 303,
    headers: { ...headers, location: `${portalOrigin(environment)}/connections/complete` },
  });
}
function attemptIdentity(
  deps: BrokerDependencies,
  handoff: {
    organizationId: string;
    principalId: string;
    registration: string;
    attemptExpiresAt: string;
  },
  attemptId: string,
  keyVersion: number,
) {
  return {
    environment: deps.environment,
    workspace: handoff.organizationId,
    actor: handoff.principalId,
    attemptId,
    registration: handoff.registration,
    expiresAt: handoff.attemptExpiresAt,
    keyVersion: String(keyVersion),
  };
}
export function createBroker(deps: BrokerDependencies): {
  providerReadiness(input: { provider: string }): Promise<{
    state:
      | "available"
      | "provider_unconfigured"
      | "provider_misconfigured"
      | "provider_unavailable";
  }>;
  beginBrowser(input: ConnectionActor): Promise<{ url: string }>;
  matchesConfirmation(input: ConfirmationMatch): Promise<boolean>;
  complete(input: { result: string; principalId: string; sessionId: string }): Promise<{
    state: "active";
    grantId: string;
    organizationId: string;
    projectId?: string;
    environmentId?: string;
  }>;
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
} {
  const registration = deps.registration;
  const connectOrigin = new URL(registration.redirectUri).origin;
  return {
    async providerReadiness(input) {
      return {
        state: input.provider === registration.provider ? ready(deps) : "provider_unavailable",
      };
    },
    async beginBrowser(input) {
      requireReady(deps);
      if ((input.projectId === undefined) !== (input.environmentId === undefined))
        throw new Error("connection_authority_denied");
      await deps.observer.observeConnectionOrigin(actor(input));
      const handoff = opaque();
      if (
        !(await deps.core.createConnectionHandoff({
          ...actor(input),
          handoffHash: await hash(handoff),
          registration: registration.registration,
        }))
      )
        throw new Error("connection_authority_denied");
      return { url: `${connectOrigin}/oauth/start?handoff=${handoff}` };
    },
    async start(request) {
      try {
        requireReady(deps);
        const url = new URL(request.url);
        if (
          request.method !== "GET" ||
          url.origin !== connectOrigin ||
          url.pathname !== "/oauth/start" ||
          url.searchParams.getAll("handoff").length !== 1 ||
          [...url.searchParams.keys()].some((name) => name !== "handoff")
        )
          throw new Error();
        const handoff = url.searchParams.get("handoff");
        if (!handoff || !/^[A-Za-z0-9_-]{43}$/u.test(handoff)) throw new Error();
        const handoffHash = await hash(handoff),
          captured = await deps.core.consumeConnectionHandoff({ handoffHash });
        if (!captured || captured.registration !== registration.registration) throw new Error();
        const state = opaque(),
          cookie = opaque(),
          verifier = opaque(),
          oidcNonce = opaque(),
          attemptId = ulid();
        const sealed = await sealAttemptSecrets(
          attemptIdentity(deps, captured, attemptId, 1),
          { verifier },
          key(deps),
        );
        if (
          !(await deps.core.createConnectionAttempt({
            handoffHash,
            attemptId,
            stateHash: await hash(state),
            cookieHash: await hash(cookie),
            encryptedVerifier: {
              nonce: b64tohex(sealed.nonce),
              ciphertext: b64tohex(sealed.ciphertext),
              keyVersion: 1,
            },
            oidcNonce,
          }))
        )
          throw new Error();
        const destination = await deps.adapter.authorizationUrl(
          registration,
          deps.secrets.clientId ?? "",
          state,
          verifier,
          registration.noncePolicy === "required" ? oidcNonce : null,
        );
        return new Response(null, {
          status: 302,
          headers: {
            ...headers,
            location: destination,
            "set-cookie": `__Host-omh-connect=${cookie}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
          },
        });
      } catch {
        return errorResponse(deps.environment);
      }
    },
    async callback(request) {
      let attemptId: string | undefined;
      let exchangeInvoked = false;
      try {
        requireReady(deps);
        const url = new URL(request.url);
        if (
          request.method !== "GET" ||
          url.origin !== connectOrigin ||
          url.pathname !== "/oauth/callback"
        )
          throw new Error();
        const callback = parseCallback(url, registration.issuer, registration.issuerDefense),
          cookie = parseAttemptCookie(request.headers.get("cookie"));
        if (!cookie) throw new Error();
        const lookup = {
          stateHash: await hash(callback.state),
          cookieHash: await hash(cookie),
          registration: registration.registration,
        };
        const origin = await deps.core.readConnectionAttemptOrigin(lookup);
        if (!origin) throw new Error();
        await deps.observer.observeConnectionOrigin(actor(origin));
        const attempt = await deps.core.claimConnectionAttempt(lookup);
        if (!attempt) throw new Error();
        attemptId = attempt.attemptId;
        if ("error" in callback) {
          await deps.core.terminateConnectionAttempt({ attemptId, outcome: "denied" });
          return errorResponse(deps.environment);
        }
        const verifier = await openAttemptSecrets(
          attemptIdentity(deps, attempt, attemptId, attempt.encryptedVerifier.keyVersion),
          {
            nonce: hextob64(attempt.encryptedVerifier.nonce),
            ciphertext: hextob64(attempt.encryptedVerifier.ciphertext),
          },
          key(deps),
        );
        exchangeInvoked = true;
        const tokens = await deps.adapter.exchange(
          registration,
          { clientId: deps.secrets.clientId ?? "", clientSecret: deps.secrets.clientSecret ?? "" },
          callback.code,
          verifier.verifier,
        );
        const grantId = ulid(),
          result = opaque();
        const grantIdentity = {
          environment: deps.environment,
          workspace: attempt.organizationId,
          human: attempt.principalId,
          provider: registration.provider,
          registration: registration.registration,
          grantId,
          generation: 1,
          keyVersion: "1",
        };
        let encryptedTokens: { nonce: string; ciphertext: string; keyVersion: number } | undefined;
        let subject: string | null = null;
        try {
          const validExpiry =
            Number.isSafeInteger(tokens.expiresIn) &&
            tokens.expiresIn > 0 &&
            tokens.expiresIn <= 315360000;
          const sealed = await sealGrantTokens(
            grantIdentity,
            {
              accessToken: tokens.accessToken,
              scopes: tokens.scopes ?? registration.allowedScopes,
              ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
              ...(validExpiry
                ? { expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString() }
                : {}),
            },
            key(deps),
          );
          encryptedTokens = {
            nonce: b64tohex(sealed.nonce),
            ciphertext: b64tohex(sealed.ciphertext),
            keyVersion: 1,
          };
          const resultHash = await hash(result);
          if (!tokens.idToken) {
            console.error(
              JSON.stringify({
                event: "connection_broker_failure",
                phase: "callback",
                reason: "missing_id_token",
              }),
            );
            throw new Error();
          }
          if (!validExpiry || !tokens.refreshToken) throw new Error();
          subject = await deps.adapter.verifyIdentity(
            tokens.idToken,
            deps.secrets.clientId ?? "",
            registration.noncePolicy === "required" ? attempt.oidcNonce : null,
          );
          try {
            if (
              !(await deps.core.persistConnectionPendingGrant({
                attemptId,
                grantId,
                subject,
                encryptedTokens,
                resultHash,
              }))
            )
              throw new Error();
          } catch {
            // Recover a committed result without redeeming the authorization code twice.
            const persisted = await deps.core.readConnectionConfirmationOrigin({ resultHash });
            if (
              !persisted ||
              persisted.principalId !== attempt.principalId ||
              persisted.sessionId !== attempt.sessionId ||
              persisted.organizationId !== attempt.organizationId ||
              persisted.projectId !== attempt.projectId ||
              persisted.environmentId !== attempt.environmentId
            )
              throw new Error();
          }
        } catch {
          // Keep issued credentials only for revocation if activation was refused.
          // Even when Core is unavailable, make a single best-effort revoke.
          let retained = false;
          if (encryptedTokens) {
            try {
              retained = await deps.core.retainConnectionOrphan({
                attemptId,
                grantId,
                subject,
                encryptedTokens,
              });
            } catch {
              try {
                retained = await deps.core.retainConnectionOrphan({
                  attemptId,
                  grantId,
                  subject,
                  encryptedTokens,
                });
              } catch {
                /* custody outcome remains unknown */
              }
            }
          }
          // A durable marker prevents replay. Only an encryption failure before
          // any custody write permits revocation without a durable claim.
          let mayRevoke = encryptedTokens === undefined;
          if (!retained && encryptedTokens !== undefined) {
            // Terminating the exchange claim fences a possibly racing grant write.
            // Only then can an unretained token be revoked without invalidating a committed grant.
            try {
              mayRevoke = await deps.core.terminateConnectionAttempt({
                attemptId,
                outcome: "outcome_unknown",
              });
            } catch {
              mayRevoke = false;
            }
          }
          const revocationClaimId = ulid();
          if (retained) {
            try {
              mayRevoke =
                (await deps.core.claimConnectionOrphanRevocation({
                  attemptId,
                  claimId: revocationClaimId,
                })) &&
                (await deps.core.markConnectionOrphanRevocationDispatched({
                  attemptId,
                  claimId: revocationClaimId,
                }));
            } catch {
              mayRevoke = false;
            }
          }
          if (mayRevoke) {
            let outcome: "revoked" | "outcome_unknown" = "outcome_unknown";
            try {
              await deps.adapter.revoke(
                registration,
                {
                  clientId: deps.secrets.clientId ?? "",
                  clientSecret: deps.secrets.clientSecret ?? "",
                },
                tokens.refreshToken ?? tokens.accessToken,
              );
              outcome = "revoked";
            } catch {
              /* retain for reconciliation */
            }
            if (retained) {
              try {
                await deps.core.finishConnectionOrphanRevocation({
                  attemptId,
                  claimId: revocationClaimId,
                  outcome,
                });
              } catch {
                /* retain for reconciliation */
              }
            }
          }
          throw new Error();
        }
        const portal = portalOrigin(deps.environment);
        return new Response(null, {
          status: 302,
          headers: {
            ...headers,
            location: `${portal}/connections/complete?result=${result}`,
            "set-cookie": "__Host-omh-connect=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
          },
        });
      } catch (error) {
        if (attemptId) {
          try {
            await deps.core.terminateConnectionAttempt({
              attemptId,
              outcome:
                !exchangeInvoked || error instanceof KnownExchangeRejection
                  ? "denied"
                  : "outcome_unknown",
            });
          } catch {
            /* claim remains fenced */
          }
        }
        return errorResponse(deps.environment);
      }
    },
    async matchesConfirmation(input) {
      requireReady(deps);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(input.result) || !/^[0-9a-f]{64}$/u.test(input.handoffHash))
        return false;
      const origin = await deps.core.readConnectionConfirmationOrigin({
        resultHash: await hash(input.result),
      });
      return (
        origin?.handoffHash === input.handoffHash &&
        origin.principalId === input.principalId &&
        origin.sessionId === input.sessionId
      );
    },
    async complete(input) {
      requireReady(deps);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(input.result))
        throw new Error("connection_authority_denied");
      const resultHash = await hash(input.result),
        origin = await deps.core.readConnectionConfirmationOrigin({ resultHash });
      if (
        !origin ||
        origin.principalId !== input.principalId ||
        origin.sessionId !== input.sessionId
      )
        throw new Error("connection_authority_denied");
      await deps.observer.observeConnectionOrigin(actor(origin));
      const result = await deps.core.activateConnectionGrant({
        resultHash,
        principalId: input.principalId,
        sessionId: input.sessionId,
      });
      if (!result) throw new Error("connection_authority_denied");
      return {
        state: "active",
        grantId: result.grantId,
        organizationId: origin.organizationId,
        ...(origin.projectId === undefined ? {} : { projectId: origin.projectId }),
        ...(origin.environmentId === undefined ? {} : { environmentId: origin.environmentId }),
      };
    },
  };
}
