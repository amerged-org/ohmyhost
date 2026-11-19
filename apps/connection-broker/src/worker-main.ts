import { WorkerEntrypoint } from "cloudflare:workers";
import { createBroker, type BrokerDependencies } from "./authorization.js";
import { configurationState } from "./config.js";
import {
  makeAuthorizationUrl,
  exchangeMakeCode,
  refreshMakeToken,
  revokeMakeToken,
} from "./providers/make-oauth.js";
import { verifyMakeIdToken } from "./oidc.js";
import { makeRegistration } from "./registry.js";
import { disconnectGrant, refreshGrant, type GrantLifecycleCore } from "./grant-lifecycle.js";
import { reconcileConnections, type MaintenanceCore } from "./maintenance.js";
import { listConnectionCatalog, observeMutation } from "./management.js";
import { runMakeAction, type ExecutionCore, type MakeActionRequest } from "./make-action.js";
import type {
  MutationAuthority,
  CatalogRequest,
  ConfirmationMatch,
  ConnectionActor,
  ConnectionBrokerManagement,
  CoreConnectionPort,
  OriginObserver,
} from "./ports.js";

export interface BrokerEnvironment {
  PLATFORM_ENVIRONMENT?: string;
  OMH_DATABASE_CUTOVER_MAINTENANCE?: string;
  MAKE_CLIENT_ID?: string;
  MAKE_CLIENT_SECRET?: string;
  GRANT_KEY?: string;
  MAKE_OAUTH_ENABLED?: string;
  MAKE_DISCOVERY_ENABLED?: string;
  MAKE_EXECUTION_ENABLED?: string;
  CONNECTION_CORE?: CoreConnectionPort &
    GrantLifecycleCore &
    Partial<ExecutionCore> &
    import("./management.js").CatalogCore;
  CONNECTION_AUTHORITY?: OriginObserver & {
    rateLimitConnectionRequest(input: { clientAddress: string | null }): Promise<boolean>;
    integrationAuthorityReadiness(
      input: Record<string, never>,
    ): Promise<{ state: "ready" | "unavailable" }>;
  };
  CONNECTION_MAINTENANCE?: MaintenanceCore;
}
export function broker(env: BrokerEnvironment) {
  if (
    (env.PLATFORM_ENVIRONMENT !== "development" && env.PLATFORM_ENVIRONMENT !== "production") ||
    !env.CONNECTION_CORE ||
    !env.CONNECTION_AUTHORITY
  )
    return null;
  const registration = makeRegistration(env.PLATFORM_ENVIRONMENT);
  const deps: BrokerDependencies = {
    environment: env.PLATFORM_ENVIRONMENT,
    registration,
    registry: [registration],
    secrets: {
      ...(env.MAKE_CLIENT_ID === undefined ? {} : { clientId: env.MAKE_CLIENT_ID }),
      ...(env.MAKE_CLIENT_SECRET === undefined ? {} : { clientSecret: env.MAKE_CLIENT_SECRET }),
      ...(env.GRANT_KEY === undefined ? {} : { vaultKey: env.GRANT_KEY }),
    },
    core: env.CONNECTION_CORE,
    observer: env.CONNECTION_AUTHORITY,
    qualified: env.MAKE_OAUTH_ENABLED === "true",
    adapter: {
      authorizationUrl: makeAuthorizationUrl,
      exchange: exchangeMakeCode,
      refresh: refreshMakeToken,
      revoke: revokeMakeToken,
      verifyIdentity: verifyMakeIdToken,
    },
  };
  return createBroker(deps);
}
function refreshFor(
  env: BrokerEnvironment,
): (grantId: string) => Promise<"refreshed" | "in_progress" | "reconnect_required"> {
  return (grantId) =>
    refreshGrant(grantId, {
      environment: env.PLATFORM_ENVIRONMENT as "development" | "production",
      registration: makeRegistration(env.PLATFORM_ENVIRONMENT as "development" | "production"),
      client: { clientId: env.MAKE_CLIENT_ID ?? "", clientSecret: env.MAKE_CLIENT_SECRET ?? "" },
      key: Uint8Array.from(atob(env.GRANT_KEY ?? ""), (c) => c.charCodeAt(0)),
      core: env.CONNECTION_CORE as NonNullable<BrokerEnvironment["CONNECTION_CORE"]>,
      adapter: {
        authorizationUrl: makeAuthorizationUrl,
        exchange: exchangeMakeCode,
        refresh: refreshMakeToken,
        revoke: revokeMakeToken,
        verifyIdentity: verifyMakeIdToken,
      },
    });
}
export function unavailable(): Response {
  return new Response("connection_provider_unavailable", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

export class ConnectionBrokerManagementService
  extends WorkerEntrypoint<BrokerEnvironment>
  implements ConnectionBrokerManagement
{
  async catalogReadiness(input: {
    provider: string;
  }): Promise<{ state: "available" | "provider_unavailable" }> {
    const instance = broker(this.env),
      core = this.env.CONNECTION_CORE,
      authority = this.env.CONNECTION_AUTHORITY;
    if (
      input.provider !== "make" ||
      !instance ||
      !core ||
      !authority ||
      this.env.MAKE_DISCOVERY_ENABLED !== "true" ||
      (await instance.providerReadiness(input)).state !== "available"
    )
      return { state: "provider_unavailable" };
    try {
      if ((await authority.integrationAuthorityReadiness({})).state !== "ready")
        return { state: "provider_unavailable" };
    } catch {
      return { state: "provider_unavailable" };
    }
    return { state: "available" };
  }
  async providerReadiness(input: { provider: string }) {
    const secrets = {
      ...(this.env.MAKE_CLIENT_ID === undefined ? {} : { clientId: this.env.MAKE_CLIENT_ID }),
      ...(this.env.MAKE_CLIENT_SECRET === undefined
        ? {}
        : { clientSecret: this.env.MAKE_CLIENT_SECRET }),
      ...(this.env.GRANT_KEY === undefined ? {} : { vaultKey: this.env.GRANT_KEY }),
    };
    const state = configurationState(secrets);
    if (state !== "configured") return { state };
    const instance = broker(this.env);
    if (!instance || !this.env.CONNECTION_AUTHORITY)
      return { state: "provider_unavailable" as const };
    try {
      const readiness = await instance.providerReadiness(input);
      if (readiness.state !== "available") return readiness;
      return (await this.env.CONNECTION_AUTHORITY.integrationAuthorityReadiness({})).state ===
        "ready"
        ? readiness
        : { state: "provider_unavailable" as const };
    } catch {
      return { state: "provider_unavailable" as const };
    }
  }
  async beginBrowser(input: ConnectionActor) {
    const instance = broker(this.env);
    if (!instance) throw new Error("connection_provider_unavailable");
    return instance.beginBrowser(input);
  }
  async listConnectionCatalog(input: CatalogRequest) {
    const instance = broker(this.env);
    if (
      !instance ||
      !this.env.CONNECTION_CORE ||
      !this.env.CONNECTION_AUTHORITY ||
      !this.env.GRANT_KEY ||
      this.env.MAKE_DISCOVERY_ENABLED !== "true" ||
      (await instance.providerReadiness({ provider: "make" })).state !== "available"
    )
      throw new Error("connection_provider_unavailable");
    const key = Uint8Array.from(atob(this.env.GRANT_KEY), (c) => c.charCodeAt(0));
    return listConnectionCatalog(input, {
      environment: this.env.PLATFORM_ENVIRONMENT as "development" | "production",
      key,
      registration: makeRegistration(this.env.PLATFORM_ENVIRONMENT as "development" | "production")
        .registration,
      core: this.env.CONNECTION_CORE,
      refresh: refreshFor(this.env),
    });
  }
  async executeMakeAction(input: MakeActionRequest) {
    const environment = this.env.PLATFORM_ENVIRONMENT;
    const core = this.env.CONNECTION_CORE;
    if (
      this.env.MAKE_EXECUTION_ENABLED !== "true" ||
      (environment !== "development" && environment !== "production") ||
      !this.env.GRANT_KEY ||
      !core?.readMakeActionBinding ||
      !core.admitMakeActionExecution ||
      !core.finishMakeActionExecution
    )
      throw new Error("connection_provider_unavailable");
    return runMakeAction(input, {
      environment,
      core: core as ExecutionCore,
      key: Uint8Array.from(atob(this.env.GRANT_KEY), (character) => character.charCodeAt(0)),
      registration: makeRegistration(environment).registration,
      refresh: refreshFor(this.env),
    });
  }
  async disconnectConnectionGrant(input: {
    organizationId: string;
    principalId: string;
    grantId: string;
    idempotencyKey: string;
    mutationAuthority: MutationAuthority;
  }): Promise<{ state: "disconnected" | "revocation_pending" }> {
    if (!this.env.CONNECTION_CORE || !this.env.CONNECTION_AUTHORITY)
      throw new Error("connection_provider_unavailable");
    await observeMutation(this.env.CONNECTION_AUTHORITY, {
      organizationId: input.organizationId,
      principalId: input.principalId,
      resourceKind: "organization",
      mutationAuthority: input.mutationAuthority,
    });
    const secrets = {
      ...(this.env.MAKE_CLIENT_ID === undefined ? {} : { clientId: this.env.MAKE_CLIENT_ID }),
      ...(this.env.MAKE_CLIENT_SECRET === undefined
        ? {}
        : { clientSecret: this.env.MAKE_CLIENT_SECRET }),
      ...(this.env.GRANT_KEY === undefined ? {} : { vaultKey: this.env.GRANT_KEY }),
    };
    if (
      configurationState(secrets) !== "configured" ||
      (this.env.PLATFORM_ENVIRONMENT !== "development" &&
        this.env.PLATFORM_ENVIRONMENT !== "production")
    ) {
      if (!(await this.env.CONNECTION_CORE.disconnectConnectionGrant(input)))
        throw new Error("connection_authority_denied");
      const status = await this.env.CONNECTION_CORE.readConnectionGrantStatus({
        organizationId: input.organizationId,
        principalId: input.principalId,
        grantId: input.grantId,
        mutationAuthority: input.mutationAuthority,
      });
      if (!status) throw new Error("connection_authority_denied");
      return { state: status.state === "disconnected" ? "disconnected" : "revocation_pending" };
    }
    const state = await disconnectGrant(input, {
      environment: this.env.PLATFORM_ENVIRONMENT,
      registration: makeRegistration(this.env.PLATFORM_ENVIRONMENT),
      client: {
        clientId: this.env.MAKE_CLIENT_ID ?? "",
        clientSecret: this.env.MAKE_CLIENT_SECRET ?? "",
      },
      key: Uint8Array.from(atob(this.env.GRANT_KEY ?? ""), (c) => c.charCodeAt(0)),
      core: this.env.CONNECTION_CORE,
      adapter: {
        authorizationUrl: makeAuthorizationUrl,
        exchange: exchangeMakeCode,
        refresh: refreshMakeToken,
        revoke: revokeMakeToken,
        verifyIdentity: verifyMakeIdToken,
      },
    });
    return { state };
  }
  async matchesConfirmation(input: ConfirmationMatch) {
    return broker(this.env)?.matchesConfirmation(input) ?? false;
  }
  async complete(input: { result: string; principalId: string; sessionId: string }) {
    const instance = broker(this.env);
    if (!instance) throw new Error("connection_provider_unavailable");
    return instance.complete(input);
  }
}
async function handleFetch(request: Request, env: BrokerEnvironment): Promise<Response> {
  if (env.OMH_DATABASE_CUTOVER_MAINTENANCE === "on")
    return new Response(null, {
      status: 503,
      headers: { "retry-after": "60", "cache-control": "no-store" },
    });
  const instance = broker(env),
    path = new URL(request.url).pathname;
  if (path === "/oauth/start" || path === "/oauth/callback") {
    if (!env.CONNECTION_AUTHORITY) return unavailable();
    try {
      if (
        !(await env.CONNECTION_AUTHORITY.rateLimitConnectionRequest({
          clientAddress: request.headers.get("cf-connecting-ip"),
        }))
      )
        return new Response(null, {
          status: 429,
          headers: { "cache-control": "no-store", "retry-after": "60" },
        });
    } catch {
      return unavailable();
    }
  }
  if (instance && (path === "/oauth/start" || path === "/oauth/callback")) {
    if ((await instance.providerReadiness({ provider: "make" })).state !== "available")
      return unavailable();
    return path === "/oauth/start" ? instance.start(request) : instance.callback(request);
  }
  return unavailable();
}
export default {
  fetch: handleFetch,
  async scheduled(_event: unknown, env: BrokerEnvironment): Promise<void> {
    if (
      !env.CONNECTION_MAINTENANCE ||
      (env.PLATFORM_ENVIRONMENT !== "development" && env.PLATFORM_ENVIRONMENT !== "production")
    )
      return;
    const secrets = {
      ...(env.MAKE_CLIENT_ID === undefined ? {} : { clientId: env.MAKE_CLIENT_ID }),
      ...(env.MAKE_CLIENT_SECRET === undefined ? {} : { clientSecret: env.MAKE_CLIENT_SECRET }),
      ...(env.GRANT_KEY === undefined ? {} : { vaultKey: env.GRANT_KEY }),
    };
    if (configurationState(secrets) !== "configured") return;
    await reconcileConnections({
      environment: env.PLATFORM_ENVIRONMENT,
      registration: makeRegistration(env.PLATFORM_ENVIRONMENT),
      client: { clientId: env.MAKE_CLIENT_ID ?? "", clientSecret: env.MAKE_CLIENT_SECRET ?? "" },
      key: Uint8Array.from(atob(env.GRANT_KEY ?? ""), (c) => c.charCodeAt(0)),
      core: env.CONNECTION_MAINTENANCE,
      adapter: {
        authorizationUrl: makeAuthorizationUrl,
        exchange: exchangeMakeCode,
        refresh: refreshMakeToken,
        revoke: revokeMakeToken,
        verifyIdentity: verifyMakeIdToken,
      },
    });
  },
};
