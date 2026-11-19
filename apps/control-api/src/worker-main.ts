import { handleMakeActionExecution, type MakeActionBroker } from "./make-action-execution.js";
import { redirectToPortalLogin } from "./portal-login-resume.js";
import { createHash } from "node:crypto";
import {
  handleConnectionsPortalRequest,
  type ConnectionConfirmationLookup,
} from "./connections-portal.js";
import { createIntegrationManagement, type IntegrationPortalStore } from "./integrations.js";
import { createIntegrationOriginObserver } from "./integration-origin-observer.js";
import type { UsageLogRecord } from "@ohmyhost/contracts/usage-log";
import { createUsageReporter, type UsageReporter } from "./usage-log.js";
import {
  createGrowthReporter,
  reportBrowserGrowth,
  type GrowthCollector,
  type GrowthHealthCounter,
} from "./growth-events.js";
export { GrowthTelemetryHealth, GrowthHealthReadService } from "./growth-health.js";
import { readD1RuntimeCreditDecision } from "./d1-runtime-credit.js";
import {
  createNativeAuthManagementComposition,
  type NativeAuthAdmin,
  type NativeAuthCatalog,
} from "./native-auth-composition.js";
import { createRegionalNativeAuthAdmin } from "./native-auth-regional.js";
import { createNativeAuthProviderSecretResolver } from "./native-auth-provider-secrets.js";
import { createD1ExtendedPorts, type D1ExtendedBindings } from "./d1-extended-ports.js";
import { notifyPreviewSources, type PreviewExecutionBinding } from "./preview-surface.js";
import type { ProductApiPreviewRuntime } from "@ohmyhost/contracts/previews";
import { purgeD1PublicEntries } from "./d1-public-entry.js";
import { createD1DevAccessSessions, isD1DevAccessRuntime } from "./d1-dev-access.js";
import { createD1GithubPushConsumer } from "./d1-github-auto-deploy.js";
import { drainGithubPushes } from "./github-auto-deploy.js";
import { createD1GithubInstallationEventConsumer } from "./d1-github-installation-events.js";
import {
  createD1ManagedSourceProcessor,
  isD1ManagedSourceProcessorRuntime,
} from "./d1-managed-source-processor.js";
import { createD1RemoteMcpPersistence as createD1McpDelegations } from "./d1-remote-mcp-persistence.js";
import { createD1RemoteMcpPersistence, isD1RemoteMcpRuntime } from "./d1-remote-mcp-persistence.js";
import { createD1ProjectMetadataPorts, isD1ProjectMetadataRuntime } from "./d1-project-metadata.js";
import {
  createD1DatabaseComputePort,
  dispatchD1DatabaseComputeChanges,
  type D1DatabaseComputeReadRuntime,
} from "./database-compute.js";
import { createD1ProjectDatabaseAccessPort } from "./project-database-access.js";
import {
  createProjectDatabaseEventsPort,
  type ProjectDatabaseAdmissionRuntime,
  type ProjectDatabaseEventsBinding,
} from "./project-database-events.js";
import type { ProjectDatabaseAccessPage } from "@ohmyhost/contracts/database-access";
import {
  createD1EnvironmentSecretsPort,
  isD1EnvironmentSecretsRuntime,
} from "./d1-environment-secrets.js";
import { dispatchD1ProjectRecovery } from "./d1-recovery-dispatch.js";
import { createD1AccountMetadataPorts } from "./d1-account-metadata.js";
import { beginD1RuntimeProbe, selectD1GatewayBindings } from "./d1-gateway-routing.js";
import { createD1ProjectExports } from "./d1-project-exports.js";
import {
  createD1ProjectApplication,
  createD1ProjectAuthorization,
  createD1WorkosOrganizationResolver,
  isD1ProjectRuntime,
} from "./d1-project-application.js";
import type { D1ProjectRuntime } from "./d1-project-persistence.js";

import { createD1BuildReceiptPersistence } from "./d1-build-receipts.js";
import type { BuildReceiptPersistencePort } from "./product-surface.js";
import {
  createManagedMailPort,
  type ManagedMailDomainsBinding,
  type ManagedMailDeliveryBinding,
} from "./managed-mail.js";
import {
  createProjectDatabaseWritePort,
  type ProjectDatabaseWriteBinding,
} from "./project-database-write.js";
import type { ProjectDatabaseAccessBinding } from "./project-database-access.js";
import type { DatabaseComputeBinding } from "./database-compute.js";
import { GITHUB_AUTHORIZED_PATH, PORTAL_PATHS, renderPortalPage } from "./portal-page.js";
import { handleBrowserLogin } from "./browser-login.js";
import type { ProjectExportBinding } from "./project-exports.js";
import { createUserApiKeyManagementPort } from "./user-api-key-management.js";
import {
  BuildCapacityReachedError,
  BuildInputConflictError,
  type BuildInputClaimRequest,
  type BuildInputClaimResult,
  type PersistedBuildReceiptEnvelope,
  type BuildUsageInput,
} from "@ohmyhost/database";
import {
  SystemClock,
  SystemEntropy,
  parseUlid,
  createUlidFactory,
  type Clock,
} from "@ohmyhost/platform";
import type { WorkosTokenVerificationPolicy } from "@ohmyhost/workos-token-verifier";
import { WorkerEntrypoint } from "cloudflare:workers";

import { problem } from "./app.js";
import { rateLimitClientKey } from "./rate-limit-client-key.js";
import { isAcceptedWorkosWebhookSearch, parseWorkosJwks } from "@ohmyhost/workos-auth-contracts";
import {
  createBillingManagementPort,
  syncBillingWebhookBatch,
  syncBillingRechargeBatch,
} from "./billing.js";
import type { CloudflareDomainManagementBinding } from "./cloudflare-domain-management.js";
import type { RateLimitPort, SafeErrorReporter } from "./contracts.js";
import { createCurrentSessionRevocationPort } from "./session-revocation.js";
import { createOrganizationOnboardingPort } from "./organization-onboarding.js";
import type { GithubAuthorizationBinding } from "./github-source-authorization.js";
import type { GithubOrganizationBinding } from "./github-organization-connection.js";
import { createEnvironmentSecretCipherKeyring } from "./environment-secret-cipher.js";
import {
  parseDevAccessAuthorizeInput,
  parseDevAccessRedeemInput,
  parseDevRuntimeProbeInput,
} from "./dev-access.js";
import type { WorkspaceMailProviderBinding } from "./shared-mail-persistence.js";
import {
  createSharedMailIdentityPort,
  type SharedMailIdentityBinding,
} from "./shared-mail-identity-port.js";
import type { SourceInspectorBinding } from "./product-surface.js";
import type { ProviderReconciliationBinding } from "./provider-reconciliation.js";
import {
  createProjectDatabaseDiagnosticsPort,
  type ProjectDatabaseDiagnosticsBinding,
} from "./project-database-diagnostics.js";
import { createWorkosBearerAuthenticator } from "./workos-authenticator.js";
import { createWorkosUserApiKeyClient } from "./workos-user-api-keys.js";
import {
  createWorkosSessionStatusClient,
  type WorkosSessionStatusBinding,
} from "./workos-session-status.js";
import type { DevAccessAuthorizeInput, DevAccessRedeemInput } from "./contracts.js";
import {
  closeBrowserSession,
  exchangeWorkosToken,
  openBrowserSession,
  type WorkosTokenExchange,
} from "./browser-session.js";
import {
  createPortalSessionPrincipal,
  createPortalSessionTokenPolicies,
} from "./portal-session-principal.js";
import { createRemoteOhmyhostMcpHandler } from "./remote-mcp.js";
import { handleMcpPortalRequest, type McpPortalRequestDependencies } from "./remote-mcp-access.js";
import { createRemoteMcpComposition, discoverWorkosConnect } from "./remote-mcp-composition.js";
import type { ManagedSourcePrivateBinding } from "./managed-source-composition.js";
import { readBoundedText } from "./workos-session-status.js";

export const CONTROL_API_POC_ORIGIN = "https://dev.app.ohmyho.st";
export const CONTROL_API_PRODUCTION_ORIGIN = "https://app.ohmyho.st";
const MAX_JWKS_BYTES = 64 * 1024;
const JWKS_TIMEOUT_MILLISECONDS = 5_000;

interface CloudflareRateLimitBinding {
  limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

interface CloudflareServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ControlApiWorkerBindings {
  readonly PREVIEW_API_RUNTIME?: ProductApiPreviewRuntime & {
    readGithubCandidates(input: { inboxEventId: string; claimId: string }): Promise<unknown>;
    acceptGithubSource(input: unknown): Promise<unknown>;
  };
  readonly PREVIEW_EXECUTION?: PreviewExecutionBinding;
  readonly NATIVE_AUTH_PROVIDER_RUNTIME?: {
    resolve(input: unknown): Promise<unknown>;
    readNativeAuthProviderEnvelope(input: unknown): Promise<unknown>;
  };
  readonly NATIVE_AUTH_ADMIN_US?: NativeAuthAdmin;
  readonly NATIVE_AUTH_ADMIN_EU?: NativeAuthAdmin;
  readonly CONTROL_MAINTENANCE_RUNTIME?: unknown;
  readonly CONTROL_RUNTIME?: D1ProjectRuntime;
  readonly ACCOUNT_METADATA_RUNTIME?: unknown;
  readonly PUBLIC_ENTRY_RUNTIME?: D1ExtendedBindings["PUBLIC_ENTRY_RUNTIME"];
  readonly PUBLIC_ENTRY_RETENTION_RUNTIME?: D1ExtendedBindings["PUBLIC_ENTRY_RETENTION_RUNTIME"];
  readonly CUSTOMER_FEEDBACK_RUNTIME?: D1ExtendedBindings["CUSTOMER_FEEDBACK_RUNTIME"];
  readonly PUBLIC_CREDIT_RUNTIME?: D1ExtendedBindings["PUBLIC_CREDIT_RUNTIME"];
  readonly CREDIT_SERVICE?: D1ExtendedBindings["CREDIT_SERVICE"];
  readonly PRODUCT_API_RUNTIME?: D1ExtendedBindings["PRODUCT_API_RUNTIME"];
  readonly DEV_ACCESS_RUNTIME?: unknown;
  readonly SHARED_MAIL_RUNTIME?: unknown;
  readonly GITHUB_RUNTIME?: unknown;
  readonly MANAGED_SOURCE_RUNTIME?: unknown;
  readonly DATABASE_PRODUCT_RUNTIME?: {
    acknowledgeProductComputeOutbox(input: unknown): Promise<boolean>;
    readDueProductCompute(
      input: unknown,
    ): Promise<readonly { organizationId: string; projectId: string; operationId: string }[]>;
  };
  readonly OMH_DATABASE_CUTOVER_MAINTENANCE?: string;
  readonly OPERATION_PUBLISHER: { wake(): Promise<void> };
  readonly MAIL_DOMAIN_OBSERVER?: {
    readMailDomain(input: unknown): Promise<unknown>;
  } & Partial<ManagedMailDomainsBinding> &
    Partial<WorkspaceMailProviderBinding>;
  readonly MAIL_DELIVERY?: ManagedMailDeliveryBinding;
  readonly BROWSER_LOGIN_ENABLED?: "true";
  readonly RECOVERY_SERVICE?: ProjectExportBinding;
  readonly RECOVERY_INPUT_KEY_BASE64?: string;
  readonly RECOVERY_R2_ACCOUNT_ID?: string;
  readonly BILLING?: CloudflareServiceBinding;
  readonly AUTH_STATUS: WorkosSessionStatusBinding;
  readonly CONNECTION_CONTROL?: IntegrationPortalStore;
  readonly CONNECTION_BROKER?: ConnectionConfirmationLookup &
    Partial<MakeActionBroker> & {
      providerReadiness(input: { provider: string }): Promise<{ state: string }>;
      catalogReadiness(input: { provider: string }): Promise<{ state: string }>;
      beginBrowser(input: unknown): Promise<{ url: string }>;
      complete(input: { result: string; principalId: string; sessionId: string }): Promise<
        | {
            state: "active";
            grantId: string;
            organizationId: string;
            projectId?: string;
            environmentId?: string;
          }
        | { state: "denied" }
      >;
      listConnectionCatalog(input: unknown): Promise<unknown>;
      disconnectConnectionGrant(
        input: unknown,
      ): Promise<{ state: "disconnected" | "revocation_pending" }>;
    };
  readonly CONTROL_API_RATE_LIMITER: CloudflareRateLimitBinding;
  readonly PUBLIC_ENTRY_RATE_LIMITER?: CloudflareRateLimitBinding;
  readonly CONTROL_API_PUBLIC_ORIGIN: string;
  readonly GITHUB_WEBHOOK_INGRESS: CloudflareServiceBinding;
  readonly WORKOS_WEBHOOK_INGRESS: CloudflareServiceBinding;
  readonly SOURCE_INSPECTOR: SourceInspectorBinding &
    GithubAuthorizationBinding &
    GithubOrganizationBinding &
    Partial<ManagedSourcePrivateBinding> & {
      resolvePreviewGithubHead?(input: {
        installationId: string;
        repositoryId: string;
        repositoryFullName: string;
        ref: string | null;
      }): Promise<unknown>;
    };
  readonly MANAGED_ARTIFACTS_NAMESPACE_US?: string;
  readonly MANAGED_ARTIFACTS_NAMESPACE_EU?: string;
  readonly WORKOS_CONNECT_ISSUER?: string;
  readonly WORKOS_CONNECT_JWKS_URL?: string;
  readonly PROVIDER_RECONCILIATION: ProviderReconciliationBinding;
  readonly NEON_MANAGEMENT: ProjectDatabaseDiagnosticsBinding &
    DatabaseComputeBinding &
    ProjectDatabaseWriteBinding &
    ProjectDatabaseAccessBinding &
    ProjectDatabaseEventsBinding & { maintainDatabaseProducts?(): Promise<unknown> };
  readonly CLOUDFLARE_DOMAIN_MANAGEMENT: CloudflareDomainManagementBinding &
    Partial<SharedMailIdentityBinding>;
  readonly GROWTH_ANALYTICS?: GrowthCollector & {
    collectUsage?(record: UsageLogRecord): Promise<{ accepted: boolean }>;
  };
  readonly CF_VERSION_METADATA?: { id: string };
  readonly GROWTH_HEALTH?: {
    idFromName(name: string): unknown;
    get(id: unknown): GrowthHealthCounter;
  };
  readonly PORTAL_SESSION_PASSWORD?: string;
  readonly ENVIRONMENT_SECRET_KEY_BASE64: string;
  readonly ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON?: string;
  readonly ENVIRONMENT_SECRET_KEY_VERSION: string;
  readonly WORKOS_JWKS_URL: string;
  readonly WORKOS_ISSUER: string;
  readonly WORKOS_CLIENT_ID: string;
  readonly WORKOS_AUDIENCE: string;
}

export interface ControlApiExecutionContext {
  waitUntil(work: Promise<unknown>): void;
}

export function wakeAcceptedOperation(
  request: Request,
  response: Response,
  publisher: ControlApiWorkerBindings["OPERATION_PUBLISHER"],
  context: ControlApiExecutionContext,
): Response {
  const path = new URL(request.url).pathname;
  const acceptedMutation =
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
    path.startsWith("/v1/") &&
    response.status === 202;
  const acceptedSource =
    request.method === "GET" &&
    path === "/v1/github/oauth/callback" &&
    response.status === 303 &&
    response.headers.get("location") === GITHUB_AUTHORIZED_PATH;
  if (acceptedMutation || acceptedSource)
    context.waitUntil(
      Promise.resolve()
        .then(() => publisher.wake())
        .catch(() => {
          throw new Error("Operation publisher wake failed");
        }),
    );
  return response;
}

export interface ControlApiScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

export function createWorkosTokenPolicies(
  bindings: Pick<
    ControlApiWorkerBindings,
    "WORKOS_ISSUER" | "WORKOS_CLIENT_ID" | "WORKOS_AUDIENCE"
  >,
): readonly WorkosTokenVerificationPolicy[] {
  return Object.freeze([
    Object.freeze({
      kind: "session",
      issuer: bindings.WORKOS_ISSUER,
      clientId: bindings.WORKOS_CLIENT_ID,
      maximumTokenAgeSeconds: 365 * 24 * 60 * 60,
    }),
    Object.freeze({
      kind: "m2m",
      issuer: bindings.WORKOS_ISSUER,
      audience: bindings.WORKOS_AUDIENCE,
    }),
  ]);
}

interface WorkerEntrypointDependencies {
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly reporter?: SafeErrorReporter;
  readonly now?: () => number;
}

const CONNECT_DISCOVERY_TTL_MS = 10 * 60_000;
const CONNECT_DISCOVERY_FAILURE_TTL_MS = 15_000;
const CONNECT_DISCOVERY_STALE_MS = 60 * 60_000;
type ConnectDiscoveryInput = Parameters<typeof discoverWorkosConnect>[0];
type ConnectDiscovery = Awaited<ReturnType<typeof discoverWorkosConnect>>;
interface ConnectDiscoveryEntry {
  good?: { readonly value: ConnectDiscovery; readonly at: number };
  inflight?: Promise<ConnectDiscovery>;
  failure?: { readonly error: unknown; readonly until: number };
}
/**
 * Module state is per isolate, so each isolate fills its own copy; the TTLs bound provider calls per isolate.
 * A good result lives for ten minutes, concurrent callers share one fill, and a failed fill is remembered for
 * fifteen seconds. A failed refresh, and a remembered failure, serve the last good result while it is younger than an
 * hour. The times run from the start of a fill, so they are upper bounds.
 */
const connectDiscoveryCache = new Map<string, ConnectDiscoveryEntry>();

function cachedConnectDiscovery(
  input: ConnectDiscoveryInput,
  now: number,
): Promise<ConnectDiscovery> {
  const key = JSON.stringify([input.issuer, input.jwksUrl ?? null]);
  const entry = connectDiscoveryCache.get(key) ?? {};
  connectDiscoveryCache.set(key, entry);
  if (entry.good !== undefined && now - entry.good.at < CONNECT_DISCOVERY_TTL_MS)
    return Promise.resolve(entry.good.value);
  if (entry.inflight !== undefined) return entry.inflight;
  if (entry.failure !== undefined && now < entry.failure.until) {
    if (entry.good !== undefined && now - entry.good.at < CONNECT_DISCOVERY_STALE_MS)
      return Promise.resolve(entry.good.value);
    return Promise.reject(entry.failure.error);
  }
  const attempt = discoverWorkosConnect(input).then(
    (value) => {
      entry.good = { value, at: now };
      entry.failure = undefined;
      entry.inflight = undefined;
      return value;
    },
    (error: unknown) => {
      entry.failure = { error, until: now + CONNECT_DISCOVERY_FAILURE_TTL_MS };
      entry.inflight = undefined;
      if (entry.good !== undefined && now - entry.good.at < CONNECT_DISCOVERY_STALE_MS)
        return entry.good.value;
      throw error;
    },
  );
  entry.inflight = attempt;
  return attempt;
}

export function createCloudflareRateLimitPort(binding: CloudflareRateLimitBinding): RateLimitPort {
  return {
    async consume(input) {
      const decision = await binding.limit({ key: `${input.dimension}:${input.key}` });
      return decision.success ? { allowed: true } : { allowed: false, retryAfterSeconds: 60 };
    },
  };
}

export function createControlApiWorkerEntrypoint(dependencies: WorkerEntrypointDependencies) {
  return {
    async fetch(
      request: Request,
      rawBindings: Partial<ControlApiWorkerBindings>,
      context: ControlApiExecutionContext,
      internalTransport?: "portal",
    ): Promise<Response> {
      const url = new URL(request.url);
      let growthHealth: GrowthHealthCounter | undefined;
      try {
        const namespace = rawBindings.GROWTH_HEALTH;
        if (namespace) growthHealth = namespace.get(namespace.idFromName("control-api"));
      } catch {
        console.warn("growth health counter unavailable");
      }
      const reportGrowth = createGrowthReporter(
        rawBindings.GROWTH_ANALYTICS,
        context,
        url.origin === CONTROL_API_PRODUCTION_ORIGIN ? "production" : "development",
        growthHealth,
        rawBindings.CF_VERSION_METADATA?.id,
        PORTAL_PATHS.includes(url.pathname)
          ? (request as Request & { cf?: { country?: unknown } }).cf?.country
          : undefined,
      );
      const usageReport = createUsageReporter(rawBindings.GROWTH_ANALYTICS, context, growthHealth);
      const usageLog = {
        report: usageReport,
        environment:
          url.origin === CONTROL_API_PRODUCTION_ORIGIN
            ? ("production" as const)
            : ("development" as const),
        version:
          rawBindings.CF_VERSION_METADATA?.id &&
          /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u.test(rawBindings.CF_VERSION_METADATA.id)
            ? rawBindings.CF_VERSION_METADATA.id
            : null,
      };
      const publicOrigin = parseControlApiPublicOrigin(rawBindings.CONTROL_API_PUBLIC_ORIGIN);
      if (publicOrigin === null) return unavailable();
      if (url.origin !== publicOrigin) return notFound();
      if (rawBindings.OMH_DATABASE_CUTOVER_MAINTENANCE === "on")
        return new Response(
          request.method === "HEAD" ? null : "Temporarily unavailable. Please retry shortly.",
          {
            status: 503,
            headers: {
              "retry-after": "60",
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          },
        );
      if (rawBindings.BROWSER_LOGIN_ENABLED === "true" && PORTAL_PATHS.includes(url.pathname)) {
        if (
          !rawBindings.CONTROL_API_RATE_LIMITER ||
          typeof rawBindings.WORKOS_CLIENT_ID !== "string"
        )
          return unavailable();
        const limit = await rawBindings.CONTROL_API_RATE_LIMITER.limit({
          key: `browser-login:${rateLimitClientKey(request.headers.get("cf-connecting-ip") ?? undefined)}`,
        });
        if (!limit.success)
          return new Response("Login request limit reached. Retry in one minute.", {
            status: 429,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
              "retry-after": "60",
            },
          });
        const login = await handleBrowserLogin(request, {
          origin: publicOrigin,
          billingEnabled: isServiceBinding(rawBindings.BILLING),
          sessionPassword: rawBindings.PORTAL_SESSION_PASSWORD ?? "",
          clientId: rawBindings.WORKOS_CLIENT_ID,
          crypto: globalThis.crypto,
          now: () => new Date(),
          providerFetch: dependencies.fetcher,
          reportGrowth: (hint) => reportBrowserGrowth(reportGrowth, hint),
          apiFetch: (apiRequest) => this.fetch(apiRequest, rawBindings, context, "portal"),
        });
        if (login) return login;
      }
      if (
        ["GET", "HEAD"].includes(request.method) &&
        url.search === "" &&
        ["/", "/favicon.svg"].includes(url.pathname)
      ) {
        const logo = url.pathname === "/favicon.svg";
        if (!logo) return renderPortalPage({ request, origin: publicOrigin });
        return new Response(
          request.method === "HEAD"
            ? null
            : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#000"/><path d="M30 87 H14 L27 63 A31 31 0 1 1 73 63 L86 87 H70" fill="none" stroke="#F0F1F2" stroke-width="7" stroke-linejoin="round"/></svg>',
          {
            headers: {
              "Content-Type": logo ? "image/svg+xml" : "text/html; charset=utf-8",
              "Content-Security-Policy":
                "default-src 'none'; img-src 'self'; frame-ancestors 'none'",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
              "Cache-Control": "public, max-age=300",
            },
          },
        );
      }
      if (url.pathname === "/webhooks/resend") {
        if (request.method !== "POST") return new Response(null, { status: 404 });
        return forwardWebhook(request, rawBindings.WORKOS_WEBHOOK_INGRESS);
      }
      if (url.pathname === "/webhooks/workos") {
        if (request.method !== "POST" || !isAcceptedWorkosWebhookSearch(url.search))
          return notFound();
        return forwardWebhook(request, rawBindings.WORKOS_WEBHOOK_INGRESS);
      }
      if (url.pathname === "/webhooks/github") {
        if (request.method !== "POST" || url.search !== "") return notFound();
        return forwardWebhook(request, rawBindings.GITHUB_WEBHOOK_INGRESS);
      }
      if (url.pathname === "/webhooks/stripe") {
        if (
          !isServiceBinding(rawBindings.BILLING) ||
          request.method !== "POST" ||
          url.search !== ""
        )
          return notFound();
        return forwardWebhook(request, rawBindings.WORKOS_WEBHOOK_INGRESS);
      }
      const remotePath = [
        "/mcp",
        "/.well-known/oauth-protected-resource/mcp",
        "/mcp/secrets",
        "/mcp/github",
      ].includes(url.pathname);
      const connectionPortalPath = ["/connections/authorize", "/connections/complete"].includes(
        url.pathname,
      );
      if (
        url.pathname !== "/v1" &&
        !url.pathname.startsWith("/v1/") &&
        !remotePath &&
        !connectionPortalPath
      )
        return notFound();

      if (url.pathname === "/v1/make/actions/run") {
        if (!isRateLimiter(rawBindings.CONTROL_API_RATE_LIMITER)) return unavailable();
        try {
          const limit = await rawBindings.CONTROL_API_RATE_LIMITER.limit({
            key: `make-execute:visitor:${rateLimitClientKey(request.headers.get("cf-connecting-ip") ?? undefined)}`,
          });
          if (!limit.success)
            return Response.json(
              { state: "rate_limited" },
              { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } },
            );
          return await handleMakeActionExecution(request, rawBindings.CONNECTION_BROKER);
        } catch {
          return unavailable();
        }
      }

      if (connectionPortalPath) {
        if (!isRateLimiter(rawBindings.CONTROL_API_RATE_LIMITER)) return unavailable();
        try {
          const limit = await rawBindings.CONTROL_API_RATE_LIMITER.limit({
            key: `connection-portal:visitor:${rateLimitClientKey(request.headers.get("cf-connecting-ip") ?? undefined)}`,
          });
          if (!limit.success)
            return new Response(null, {
              status: 429,
              headers: { "cache-control": "no-store", "retry-after": "60" },
            });
        } catch {
          return unavailable();
        }
      }

      const projectRead = request.method === "GET" || request.method === "HEAD";
      const accountPath =
        ((url.pathname === "/v1/me" || url.pathname === "/v1/me/profile") && projectRead) ||
        (url.pathname === "/v1/me/signup-source" && request.method === "PUT");
      const billingPath = /^\/v1\/organizations\/[^/:]+\/billing\/(?:checkouts|portal)$/u.test(
        url.pathname,
      )
        ? request.method === "POST"
        : /^\/v1\/organizations\/[^/:]+\/billing\/checkouts\/[^/:]+$/u.test(url.pathname)
          ? projectRead
          : /^\/v1\/organizations\/[^/:]+\/billing\/recharge$/u.test(url.pathname) &&
            (projectRead || request.method === "PUT");
      const auditPath = url.pathname === "/v1/audit-events" && projectRead;
      const secretPath = /^\/v1\/projects\/[^/:]+\/environments\/[^/:]+\/secrets$/u.test(
        url.pathname,
      )
        ? projectRead
        : /^\/v1\/projects\/[^/:]+\/environments\/[^/:]+\/secrets\/[^/]+$/u.test(url.pathname) &&
          (request.method === "PUT" || request.method === "DELETE");
      const secretsReady =
        isD1EnvironmentSecretsRuntime(rawBindings.CONTROL_RUNTIME) &&
        typeof rawBindings.ENVIRONMENT_SECRET_KEY_BASE64 === "string" &&
        typeof rawBindings.ENVIRONMENT_SECRET_KEY_VERSION === "string";
      const metadataPath = /^\/v1\/projects\/[^/:]+\/powered-by-flag$/u.test(url.pathname)
        ? projectRead || request.method === "PUT"
        : /^\/v1\/projects\/[^/:]+\/context\/notes$/u.test(url.pathname) &&
          request.method === "PUT";
      const metadataReady = isD1ProjectMetadataRuntime(rawBindings.CONTROL_RUNTIME);
      const exportPath = /^\/v1\/projects\/[^/]+\/exports$/u.test(url.pathname)
        ? request.method === "POST"
        : /^\/v1\/projects\/[^/]+\/exports\/[^/]+$/u.test(url.pathname) && projectRead;
      const recoveryOperationPath = /^\/v1\/operations\/[^/:]+$/u.test(url.pathname) && projectRead;
      const databaseEventsPath =
        /^\/v1\/projects\/[^/:]+\/database\/(?:webhooks|webhook-deliveries|schedules|watches|execution-usage|tables)(?:\/|$)/u.test(
          url.pathname,
        );
      const databasePath = /^\/v1\/projects\/[^/:]+\/database\/(?:compute|access)$/u.test(
        url.pathname,
      )
        ? projectRead || request.method === "POST"
        : /^\/v1\/projects\/[^/:]+\/database\/(?:write|query)$/u.test(url.pathname)
          ? request.method === "POST"
          : /^\/v1\/projects\/[^/:]+\/database\/access\/[^/:]+$/u.test(url.pathname) &&
            request.method === "DELETE";
      const databaseReady =
        isD1DatabaseReadRuntime(rawBindings.CONTROL_RUNTIME) &&
        isProjectDatabaseDiagnosticsBinding(rawBindings.NEON_MANAGEMENT) &&
        typeof rawBindings.NEON_MANAGEMENT.issueDatabaseAccess === "function" &&
        typeof rawBindings.NEON_MANAGEMENT.revokeDatabaseAccess === "function" &&
        typeof rawBindings.NEON_MANAGEMENT.readCompute === "function" &&
        typeof rawBindings.NEON_MANAGEMENT.changeCompute === "function" &&
        typeof rawBindings.NEON_MANAGEMENT.runComputeChange === "function";
      const databaseEventsReady =
        databaseReady &&
        typeof rawBindings.NEON_MANAGEMENT.databaseEvents === "function" &&
        typeof rawBindings.NEON_MANAGEMENT.createDatabaseTable === "function" &&
        isProjectDatabaseAdmissionRuntime(rawBindings.CONTROL_RUNTIME);
      const recoveryConfigured =
        rawBindings.RECOVERY_SERVICE !== undefined ||
        rawBindings.RECOVERY_INPUT_KEY_BASE64 !== undefined ||
        rawBindings.RECOVERY_R2_ACCOUNT_ID !== undefined;
      const recoveryReady =
        typeof rawBindings.RECOVERY_SERVICE?.invokeRecovery === "function" &&
        typeof rawBindings.RECOVERY_R2_ACCOUNT_ID === "string" &&
        /^[a-f0-9]{32}$/u.test(rawBindings.RECOVERY_R2_ACCOUNT_ID) &&
        typeof rawBindings.RECOVERY_INPUT_KEY_BASE64 === "string" &&
        Buffer.from(rawBindings.RECOVERY_INPUT_KEY_BASE64, "base64").length === 32 &&
        Buffer.from(rawBindings.RECOVERY_INPUT_KEY_BASE64, "base64").toString("base64") ===
          rawBindings.RECOVERY_INPUT_KEY_BASE64;
      if (
        (recoveryConfigured && !recoveryReady) ||
        (exportPath && !recoveryReady) ||
        (recoveryOperationPath && !recoveryReady && !databaseReady) ||
        (databasePath && !databaseReady) ||
        (databaseEventsPath && !databaseEventsReady) ||
        (secretPath && !secretsReady) ||
        (metadataPath && !metadataReady) ||
        (billingPath && !isServiceBinding(rawBindings.BILLING)) ||
        (remotePath &&
          (!isD1RemoteMcpRuntime(rawBindings.CONTROL_RUNTIME) ||
            !isSafeHttpsUrl(rawBindings.WORKOS_CONNECT_ISSUER) ||
            (rawBindings.WORKOS_CONNECT_JWKS_URL !== undefined &&
              !isSafeHttpsUrl(rawBindings.WORKOS_CONNECT_JWKS_URL)))) ||
        (auditPath && typeof rawBindings.CONTROL_RUNTIME?.readAuditEvents !== "function")
      )
        return unavailable();
      if (
        Object.getOwnPropertyNames(rawBindings).some((name) =>
          /^CONTROL_(?:CORE|GLOBAL|DIRECTORY|SHARD_.*)$/u.test(name),
        ) ||
        !isD1ProjectRuntime(rawBindings.CONTROL_RUNTIME) ||
        !isServiceBinding(rawBindings.AUTH_STATUS) ||
        !isRateLimiter(rawBindings.CONTROL_API_RATE_LIMITER) ||
        typeof rawBindings.OPERATION_PUBLISHER?.wake !== "function" ||
        !isSafeHttpsUrl(rawBindings.WORKOS_JWKS_URL) ||
        !isSafeHttpsUrl(rawBindings.WORKOS_ISSUER) ||
        !isIdentifier(rawBindings.WORKOS_CLIENT_ID) ||
        !isIdentifier(rawBindings.WORKOS_AUDIENCE)
      )
        return unavailable();
      if (url.pathname.startsWith("/v1/site/") || url.pathname === "/v1/contact-requests") {
        if (!isRateLimiter(rawBindings.PUBLIC_ENTRY_RATE_LIMITER)) return unavailable();
        const limited = await rawBindings.PUBLIC_ENTRY_RATE_LIMITER.limit({
          key: `site-entry:${rateLimitClientKey(request.headers.get("cf-connecting-ip") ?? undefined)}`,
        });
        if (!limited.success) {
          const response = problem(
            `req_${globalThis.crypto.randomUUID()}`,
            429,
            "rate_limited",
            "Retry this request in one minute.",
            true,
          );
          response.headers.set("retry-after", "60");
          return response;
        }
      }
      try {
        const runtime = rawBindings.CONTROL_RUNTIME,
          publisher = rawBindings.OPERATION_PUBLISHER;
        const clock = new SystemClock();
        const ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
        const d1Ports = createD1ExtendedPorts({
          bindings: rawBindings as unknown as D1ExtendedBindings,
          publicOrigin,
          clock,
          ids,
        });
        const verifier = {
          clock,
          jwks: createRemoteWorkosJwksSource(
            rawBindings.WORKOS_JWKS_URL as string,
            dependencies.fetcher,
          ),
        };
        const organizations = createD1WorkosOrganizationResolver(rawBindings.CONTROL_RUNTIME);
        const sessionStatus = createWorkosSessionStatusClient(rawBindings.AUTH_STATUS);
        const authentication = createWorkosBearerAuthenticator({
          apiKeys: createWorkosUserApiKeyClient(rawBindings.AUTH_STATUS),
          policies: createWorkosTokenPolicies(
            rawBindings as Pick<
              ControlApiWorkerBindings,
              "WORKOS_ISSUER" | "WORKOS_CLIENT_ID" | "WORKOS_AUDIENCE"
            >,
          ),
          verifier,
          organizations,
          sessionStatus,
        });
        // Portal callbacks and connection consent share one cookie-only authentication policy.
        const portalAuthentication = createWorkosBearerAuthenticator({
          policies: createPortalSessionTokenPolicies(rawBindings as ControlApiWorkerBindings),
          verifier,
          organizations,
          sessionStatus,
        });
        const portalSessionPrincipal = createPortalSessionPrincipal({
          sessionPassword: rawBindings.PORTAL_SESSION_PASSWORD ?? "",
          origin: publicOrigin,
          clock,
          authentication: portalAuthentication,
        });
        // The visitor bound runs before any provider discovery or account read, so refused traffic costs nothing upstream.
        if (remotePath && isD1RemoteMcpRuntime(runtime)) {
          const visitor = await rawBindings.CONTROL_API_RATE_LIMITER.limit({
            key: `remote-mcp:visitor:${rateLimitClientKey(request.headers.get("cf-connecting-ip") ?? undefined)}`,
          });
          if (!visitor.success)
            return new Response(null, { status: 429, headers: { "retry-after": "60" } });
        }
        const accountMetadata =
          accountPath ||
          remotePath ||
          /^\/v1\/organizations\/[^/]+\/connections(?:\/|$)/u.test(url.pathname)
            ? await createD1AccountMetadataPorts(
                rawBindings.ACCOUNT_METADATA_RUNTIME,
                rawBindings.AUTH_STATUS,
                () => clock.now(),
              )
            : undefined;
        const dispatchApi = async (apiRequest: Request): Promise<Response> =>
          wakeAcceptedOperation(apiRequest, await app.fetch(apiRequest), publisher, context);
        const remoteRuntime = isD1RemoteMcpRuntime(runtime) ? runtime : undefined;
        const remote =
          remotePath && remoteRuntime !== undefined
            ? await (async () => {
                const discovered = await cachedConnectDiscovery(
                  {
                    issuer: rawBindings.WORKOS_CONNECT_ISSUER ?? "",
                    ...(rawBindings.WORKOS_CONNECT_JWKS_URL === undefined
                      ? {}
                      : { jwksUrl: rawBindings.WORKOS_CONNECT_JWKS_URL }),
                    fetcher: dependencies.fetcher,
                  },
                  (dependencies.now ?? (() => Date.now()))(),
                );
                const source = createRemoteWorkosJwksSource(
                  discovered.jwksUrl,
                  dependencies.fetcher,
                );
                let jwks: Promise<unknown> | undefined;
                return createRemoteMcpComposition({
                  persistence: createD1RemoteMcpPersistence(remoteRuntime),
                  clock,
                  origin: publicOrigin,
                  issuer: discovered.issuer,
                  jwks: { load: () => (jwks ??= source.load()) },
                  authentication,
                  authorization: createD1ProjectAuthorization(runtime),
                  resolveOrganization: (id) =>
                    createD1WorkosOrganizationResolver(runtime).resolve(id),
                  dispatch: dispatchApi,
                });
              })()
            : undefined;
        const broker = rawBindings.CONNECTION_BROKER;
        const connectionStore = rawBindings.CONNECTION_CONTROL;
        const connectionReady = async () =>
          !!broker && (await broker.providerReadiness({ provider: "make" })).state === "available";
        const catalogReady = async () =>
          !!broker && (await broker.catalogReadiness({ provider: "make" })).state === "available";
        if (connectionPortalPath) {
          if (!broker || !connectionStore || !rawBindings.PORTAL_SESSION_PASSWORD)
            return unavailable();
          const digest = (token: string) => createHash("sha256").update(token).digest("hex");
          const portal = await handleConnectionsPortalRequest(request, {
            origin: publicOrigin,
            ...(rawBindings.BROWSER_LOGIN_ENABLED === "true"
              ? {
                  resumeAfterLogin: (url: URL) =>
                    redirectToPortalLogin(
                      url,
                      rawBindings.PORTAL_SESSION_PASSWORD ?? "",
                      clock.now().getTime(),
                    ),
                }
              : {}),
            connectOrigin:
              publicOrigin === CONTROL_API_PRODUCTION_ORIGIN
                ? "https://connect.ohmyho.st"
                : "https://dev.connect.ohmyho.st",
            authenticate: async (req) => {
              const session = await openBrowserSession(
                req.headers.get("cookie"),
                rawBindings.PORTAL_SESSION_PASSWORD ?? "",
                publicOrigin,
                clock.now().getTime(),
              );
              if (!session) return null;
              const principal = await portalAuthentication.authenticate(session.accessToken);
              return principal ? { principal, csrf: session.csrf } : null;
            },
            readHandoff: (token, principal) =>
              connectionStore.readIntegrationPortalHandoff({
                handoffHash: digest(token),
                principalId: principal.actorId,
              }),
            consumeHandoff: (token, principal) =>
              connectionStore.consumeIntegrationPortalHandoff({
                handoffHash: digest(token),
                principalId: principal.actorId,
              }),
            readiness: connectionReady,
            confirmation: broker,
            begin: (actor) =>
              broker.beginBrowser({
                organizationId: actor.organizationId,
                ...(actor.projectId === undefined ? {} : { projectId: actor.projectId }),
                ...(actor.environmentId === undefined
                  ? {}
                  : { environmentId: actor.environmentId }),
                principalId: actor.principalId,
                sessionId: actor.sessionId,
                browserSession: actor.browserSession,
                ...(actor.originatingCredential === undefined
                  ? {}
                  : { originatingCredential: actor.originatingCredential }),
                ...(actor.originatingDelegation === undefined
                  ? {}
                  : { originatingDelegation: actor.originatingDelegation }),
              }),
            complete: (value) => broker.complete(value),
          });
          return portal ?? notFound();
        }
        const integrationManagement =
          broker && connectionStore && rawBindings.PORTAL_SESSION_PASSWORD
            ? createIntegrationManagement({
                origin: publicOrigin,
                secret: rawBindings.PORTAL_SESSION_PASSWORD,
                registration:
                  publicOrigin === CONTROL_API_PRODUCTION_ORIGIN
                    ? "make-production-3"
                    : "make-development-3",
                store: connectionStore,
                broker,
                readiness: connectionReady,
                catalogReadiness: catalogReady,
                resolveOrganization: (id) => organizations.resolve(id),
                delegation: async (principal, organizationId) => {
                  const proof = remote
                    ? await remote.remoteIntegrationDelegation(principal, organizationId)
                    : null;
                  return proof
                    ? {
                        grantId: proof.grantId,
                        clientId: proof.clientId,
                        consentHash: proof.consentHash,
                        action: "integrations:manage" as const,
                        ...(proof.authorizationRestriction === undefined
                          ? {}
                          : { authorizationRestriction: proof.authorizationRestriction }),
                      }
                    : null;
                },
              })
            : undefined;
        const app = createD1ProjectApplication({
          ...(remote === undefined
            ? {}
            : {
                remote: {
                  internalAuthentication: remote.internalAuthentication,
                  remoteAuthorization: remote.remoteAuthorization,
                  remoteDelegation: remote.remoteDelegation,
                  remoteMailDomainDelegation: remote.remoteMailDomainDelegation,
                },
              }),
          identity: {
            userApiKeys: createUserApiKeyManagementPort(rawBindings.AUTH_STATUS),
            sessionRevocation: createCurrentSessionRevocationPort(rawBindings.AUTH_STATUS),
            organizationOnboarding: createOrganizationOnboardingPort(rawBindings.AUTH_STATUS),
            ...(isServiceBinding(rawBindings.BILLING)
              ? { billing: createBillingManagementPort(rawBindings.BILLING) }
              : {}),
          },
          ...(metadataReady && isD1ProjectMetadataRuntime(rawBindings.CONTROL_RUNTIME)
            ? {
                metadata: createD1ProjectMetadataPorts({
                  runtime: rawBindings.CONTROL_RUNTIME,
                  clock,
                  ids,
                }),
              }
            : {}),
          ...(secretsReady && isD1EnvironmentSecretsRuntime(rawBindings.CONTROL_RUNTIME)
            ? {
                environmentSecrets: createD1EnvironmentSecretsPort({
                  runtime: rawBindings.CONTROL_RUNTIME,
                  clock,
                  cipher: createEnvironmentSecretCipherKeyring({
                    primaryKeyBase64: rawBindings.ENVIRONMENT_SECRET_KEY_BASE64 as string,
                    ...(rawBindings.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON === undefined
                      ? {}
                      : {
                          additionalKeysJson: rawBindings.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON,
                        }),
                    currentKeyVersion: Number(rawBindings.ENVIRONMENT_SECRET_KEY_VERSION),
                    crypto: globalThis.crypto,
                  }),
                }),
              }
            : {}),
          ...(accountMetadata === undefined ? {} : { accountMetadata }),
          ...(databaseReady &&
          rawBindings.NEON_MANAGEMENT !== undefined &&
          isD1DatabaseReadRuntime(rawBindings.CONTROL_RUNTIME)
            ? {
                database: {
                  databaseCompute: createD1DatabaseComputePort(
                    rawBindings.NEON_MANAGEMENT,
                    rawBindings.CONTROL_RUNTIME,
                  ),
                  projectDatabaseAccess: createD1ProjectDatabaseAccessPort(
                    rawBindings.NEON_MANAGEMENT,
                    rawBindings.CONTROL_RUNTIME,
                    clock,
                  ),
                  projectDatabaseWrite: createProjectDatabaseWritePort(rawBindings.NEON_MANAGEMENT),
                  ...(databaseEventsReady &&
                  isProjectDatabaseAdmissionRuntime(rawBindings.CONTROL_RUNTIME)
                    ? {
                        projectDatabaseEvents: createProjectDatabaseEventsPort(
                          rawBindings.NEON_MANAGEMENT,
                          rawBindings.CONTROL_RUNTIME,
                          clock,
                        ),
                      }
                    : {}),
                  projectDatabaseDiagnostics: createProjectDatabaseDiagnosticsPort(
                    rawBindings.NEON_MANAGEMENT,
                  ),
                },
              }
            : {}),
          ...(recoveryReady &&
          rawBindings.RECOVERY_SERVICE !== undefined &&
          rawBindings.RECOVERY_INPUT_KEY_BASE64 !== undefined &&
          rawBindings.RECOVERY_R2_ACCOUNT_ID !== undefined
            ? {
                projectExports: createD1ProjectExports({
                  runtime: rawBindings.CONTROL_RUNTIME,
                  clock,
                  ids,
                  crypto: globalThis.crypto,
                  key: new Uint8Array(Buffer.from(rawBindings.RECOVERY_INPUT_KEY_BASE64, "base64")),
                  archiveBucket:
                    publicOrigin === CONTROL_API_PRODUCTION_ORIGIN
                      ? "ohmyho-production-backups"
                      : "ohmyho-development-backups",
                  downloadBinding: rawBindings.RECOVERY_SERVICE,
                  r2AccountId: rawBindings.RECOVERY_R2_ACCOUNT_ID,
                }),
              }
            : {}),
          extended: {
            ...(integrationManagement ? { integrations: integrationManagement } : {}),
            usageLog,
            growthProductResult: ({ accountId, organizationId, status }) =>
              reportGrowth({
                event_name: status < 400 ? "product_call_succeeded" : "product_call_failed",
                outcome: status < 400 ? "succeeded" : "failed",
                transport: remotePath ? "remote_mcp" : (internalTransport ?? "rest"),
                account_id: accountId,
                organization_id: organizationId,
                error_class:
                  status < 400
                    ? null
                    : status === 401 || status === 403
                      ? "authorization_denied"
                      : status === 429
                        ? "quota_blocked"
                        : status === 400
                          ? "invalid_input"
                          : "unknown",
              }),
            ...(secretsReady && rawBindings.NATIVE_AUTH_ADMIN_US && rawBindings.NATIVE_AUTH_ADMIN_EU
              ? {
                  nativeAuthManagement: createNativeAuthManagementComposition({
                    catalog: runtime as unknown as NativeAuthCatalog,
                    admin: createRegionalNativeAuthAdmin({
                      runtime,
                      us: rawBindings.NATIVE_AUTH_ADMIN_US,
                      eu: rawBindings.NATIVE_AUTH_ADMIN_EU,
                    }),
                    cipher: createEnvironmentSecretCipherKeyring({
                      primaryKeyBase64: rawBindings.ENVIRONMENT_SECRET_KEY_BASE64 as string,
                      ...(rawBindings.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON === undefined
                        ? {}
                        : {
                            additionalKeysJson: rawBindings.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON,
                          }),
                      currentKeyVersion: Number(rawBindings.ENVIRONMENT_SECRET_KEY_VERSION),
                      crypto: globalThis.crypto,
                    }),
                  }),
                }
              : {}),
            publicEntry: d1Ports.publicEntry,
            credits: d1Ports.credits,
            productSurface: d1Ports.productSurface,
            previews: d1Ports.previews,
            githubSourceAuthorization: d1Ports.githubSourceAuthorization,
            githubOrganizationConnection: d1Ports.githubOrganizationConnection,
            organizationMcpConnections: d1Ports.organizationMcpConnections,
            portalSessionPrincipal,
            projectMailDomains: d1Ports.projectMailDomains,
            devAccessTickets: d1Ports.devAccessTickets,
            devAccessManagement: d1Ports.devAccessManagement,
            functionRuns: d1Ports.functionRuns,
            deploymentDiagnostics: d1Ports.deploymentDiagnostics,
            ...(rawBindings.MANAGED_SOURCE_RUNTIME !== undefined &&
            rawBindings.MANAGED_ARTIFACTS_NAMESPACE_US !== undefined &&
            rawBindings.MANAGED_ARTIFACTS_NAMESPACE_EU !== undefined
              ? { managedSources: d1Ports.managedSources }
              : {}),
            providerReconciliation: d1Ports.providerReconciliation,
            cloudflareDomains: d1Ports.cloudflareDomains,
            ...(rawBindings.MAIL_DELIVERY && rawBindings.MAIL_DOMAIN_OBSERVER?.configureMailDomain
              ? {
                  managedMail: createManagedMailPort(
                    rawBindings.MAIL_DOMAIN_OBSERVER as ManagedMailDomainsBinding,
                    rawBindings.MAIL_DELIVERY,
                  ),
                }
              : {}),
            ...(rawBindings.SHARED_MAIL_RUNTIME !== undefined &&
            typeof rawBindings.MAIL_DOMAIN_OBSERVER?.ensureWorkspaceMailDomain === "function"
              ? { sharedMail: d1Ports.sharedMail }
              : {}),
            ...(typeof rawBindings.CLOUDFLARE_DOMAIN_MANAGEMENT
              ?.declareApplicationDomainIdentity === "function"
              ? {
                  sharedMailIdentity: createSharedMailIdentityPort(
                    rawBindings.CLOUDFLARE_DOMAIN_MANAGEMENT as SharedMailIdentityBinding,
                  ),
                }
              : {}),
          },
          persistenceExtras: d1Ports.persistence,
          runtime: rawBindings.CONTROL_RUNTIME,
          authentication,
          clock,
          ids,
          platform: publicOrigin === CONTROL_API_PRODUCTION_ORIGIN ? "production" : "development",
          applicationId: `control-api-${controlApiNamespace(publicOrigin)}`,
          rateLimits: createCloudflareRateLimitPort(rawBindings.CONTROL_API_RATE_LIMITER),
          reporter: dependencies.reporter ?? createSafeConsoleReporter(),
        });
        if (remote !== undefined)
          return await dispatchRemoteMcpRequest({
            request,
            remote,
            usageLog,
            origin: publicOrigin,
            sessionPassword: rawBindings.PORTAL_SESSION_PASSWORD ?? "",
            browserLoginEnabled: rawBindings.BROWSER_LOGIN_ENABLED === "true",
            clock,
            limiter: rawBindings.CONTROL_API_RATE_LIMITER,
            issuer: rawBindings.WORKOS_CONNECT_ISSUER ?? "",
            workos: {
              origin: publicOrigin,
              clientId: rawBindings.WORKOS_CLIENT_ID,
              crypto: globalThis.crypto,
              providerFetch: dependencies.fetcher,
            },
            ...(runtime === undefined ? {} : { projects: runtime }),
          });
        return await dispatchApi(request);
      } catch (error) {
        // A missing binding or a broken port is an operator problem that must not hide behind a plain 503.
        reportComposeFailure(dependencies.reporter ?? createSafeConsoleReporter(), error);
        return unavailable();
      }
    },
    async scheduled(
      _controller: ControlApiScheduledController,
      rawBindings: Partial<ControlApiWorkerBindings>,
    ): Promise<Readonly<Record<string, unknown>>> {
      if (
        Object.keys(rawBindings).some(
          (name) =>
            ["CONTROL_CORE", "CONTROL_GLOBAL"].includes(name) ||
            /^CONTROL_SHARD_[0-9]+$/u.test(name),
        )
      )
        return { ok: false, error: "unavailable" };
      const clock = new SystemClock(),
        ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
      const [recovery, products] = await Promise.allSettled([
        dispatchD1ProjectRecovery({
          runtime: rawBindings.CONTROL_RUNTIME,
          maintenance: rawBindings.CONTROL_MAINTENANCE_RUNTIME,
          clock,
          ids,
          uuid: () => globalThis.crypto.randomUUID(),
          ...(rawBindings.RECOVERY_SERVICE === undefined
            ? {}
            : { binding: rawBindings.RECOVERY_SERVICE }),
        }),
        (async () => {
          const binding = rawBindings.NEON_MANAGEMENT,
            runtime = rawBindings.DATABASE_PRODUCT_RUNTIME;
          if (
            !binding ||
            typeof binding.maintainDatabaseProducts !== "function" ||
            !runtime ||
            typeof runtime.acknowledgeProductComputeOutbox !== "function" ||
            typeof runtime.readDueProductCompute !== "function"
          )
            throw new Error("Database maintenance unavailable");
          const maintenance = await binding.maintainDatabaseProducts();
          const compute = await dispatchD1DatabaseComputeChanges({
            binding,
            runtime,
            clock,
            ids,
          });
          return { maintenance, compute };
        })(),
      ]);
      // The Billing Worker owns the Stripe settlement batches on the Core; the public-entry purge is its own capability.
      // The pushes of this tick, claimed from the shared inbox in one bounded drain; its ledger and the deployments it accepts live in the Core.
      const pushes = (async () => {
        const origin = parseControlApiPublicOrigin(rawBindings.CONTROL_API_PUBLIC_ORIGIN);
        if (origin === null) throw new Error("GitHub auto-deploy is unavailable");
        const ports = createD1ExtendedPorts({
          bindings: rawBindings as unknown as D1ExtendedBindings,
          publicOrigin: origin,
          clock,
          ids,
        });
        return drainGithubPushes(
          createD1GithubPushConsumer({
            bindings: rawBindings,
            surface: ports.productSurface,
            clock,
            ids,
          }),
          { now: () => clock.now().getTime() },
        );
      })();
      // Withdrawing installation events (uninstall, suspension, removed repositories) revoke grants; one per tick.
      const installations = (async () =>
        createD1GithubInstallationEventConsumer({ bindings: rawBindings, clock, ids }).pollOne())();
      const [webhooks, recharge, retention, push, installation] = await Promise.allSettled([
        syncBillingWebhookBatch(rawBindings.BILLING as never),
        syncBillingRechargeBatch(rawBindings.BILLING as never),
        purgeD1PublicEntries(rawBindings.PUBLIC_ENTRY_RETENTION_RUNTIME as never, clock.now()),
        pushes,
        installations,
      ]);
      const settlement = {
        webhooks: webhooks.status === "fulfilled" ? webhooks.value : { status: "unavailable" },
        recharge: recharge.status === "fulfilled" ? recharge.value : { status: "unavailable" },
        publicEntries:
          retention.status === "fulfilled"
            ? { purged: retention.value }
            : { status: "unavailable" },
        githubAutoDeploy: push.status === "fulfilled" ? push.value : { status: "unavailable" },
        githubInstallations:
          installation.status === "fulfilled" ? installation.value : { status: "unavailable" },
      };
      if (recovery.status === "rejected" && products.status === "rejected")
        return { ok: false, error: "unavailable" };
      return {
        ok:
          recovery.status === "fulfilled" &&
          products.status === "fulfilled" &&
          webhooks.status === "fulfilled" &&
          recharge.status === "fulfilled" &&
          retention.status === "fulfilled" &&
          push.status === "fulfilled" &&
          push.value.status !== "failed" &&
          installation.status === "fulfilled",
        recovery: recovery.status === "fulfilled" ? recovery.value : { status: "unavailable" },
        databaseProducts:
          products.status === "fulfilled" ? products.value : { status: "unavailable" },
        settlement,
      };
    },
  };
}

async function forwardWebhook(request: Request, binding: unknown): Promise<Response> {
  if (!isServiceBinding(binding)) return unavailable();
  try {
    const response = await binding.fetch(request);
    return response instanceof Response ? response : unavailable();
  } catch {
    return unavailable();
  }
}

const WORKOS_JWKS_TTL_MS = 5 * 60_000;
const WORKOS_JWKS_STALE_MS = 60 * 60_000;
// A refetch forced by an unknown kid, or a refresh that keeps failing, runs at most once per cooldown.
const WORKOS_JWKS_COOLDOWN_MS = 30_000;
interface WorkosJwksEntry {
  good?: { readonly value: unknown; readonly kids: ReadonlySet<string>; readonly at: number };
  attemptedAt?: number;
  inflight?: Promise<unknown>;
}
/**
 * Module state is per isolate and per fetcher, so each isolate fills its own copy. Keys live for five minutes, and a
 * token whose kid the cached set lacks refetches once the cooldown has passed, so a rotated key takes effect at once.
 * Concurrent callers share one fill. Only a response that parses as a non-empty JWKS replaces the cache; a failed or
 * invalid refresh serves the last good keys for up to an hour and is never cached itself.
 */
const workosJwksCache = new WeakMap<
  (request: Request) => Promise<Response>,
  Map<string, WorkosJwksEntry>
>();

export function createRemoteWorkosJwksSource(
  jwksUrl: string,
  fetcher: (request: Request) => Promise<Response>,
) {
  let entries = workosJwksCache.get(fetcher);
  if (entries === undefined) {
    entries = new Map<string, WorkosJwksEntry>();
    workosJwksCache.set(fetcher, entries);
  }
  const shared = entries;
  return {
    load(request: { readonly kid?: string } = {}): Promise<unknown> {
      const now = Date.now();
      const entry = shared.get(jwksUrl) ?? {};
      shared.set(jwksUrl, entry);
      if (entry.inflight !== undefined) return entry.inflight;
      const good = entry.good;
      if (good !== undefined) {
        const fresh = now - good.at < WORKOS_JWKS_TTL_MS;
        const unknownKid = request.kid !== undefined && !good.kids.has(request.kid);
        const cooling = now - (entry.attemptedAt ?? 0) < WORKOS_JWKS_COOLDOWN_MS;
        if (fresh && !unknownKid) return Promise.resolve(good.value);
        if (cooling && now - good.at < WORKOS_JWKS_STALE_MS) return Promise.resolve(good.value);
      }
      entry.attemptedAt = now;
      const attempt = fetchWorkosJwks(jwksUrl, fetcher).then(
        ({ value, kids }) => {
          entry.good = { value, kids, at: Date.now() };
          entry.inflight = undefined;
          return value;
        },
        (error: unknown) => {
          entry.inflight = undefined;
          const last = entry.good;
          if (last !== undefined && now - last.at < WORKOS_JWKS_STALE_MS) return last.value;
          throw error;
        },
      );
      entry.inflight = attempt;
      return attempt;
    },
  };
}

async function fetchWorkosJwks(
  jwksUrl: string,
  fetcher: (request: Request) => Promise<Response>,
): Promise<{ readonly value: unknown; readonly kids: ReadonlySet<string> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MILLISECONDS);
  try {
    let response: Response;
    try {
      response = await fetcher(
        new Request(jwksUrl, {
          headers: { Accept: "application/json" },
          redirect: "manual",
          signal: controller.signal,
        }),
      );
    } catch (error) {
      reportWorkosJwksFailure("WORKOS_JWKS_FETCH_UNAVAILABLE");
      throw error;
    }
    if (!response.ok) {
      reportWorkosJwksFailure("WORKOS_JWKS_HTTP_UNAVAILABLE");
      throw new Error("WorkOS JWKS is unavailable");
    }
    let value: unknown;
    try {
      value = await readBoundedJson(response, MAX_JWKS_BYTES);
    } catch (error) {
      reportWorkosJwksFailure("WORKOS_JWKS_BODY_INVALID");
      throw error;
    }
    try {
      const keys = parseWorkosJwks(value);
      return { value, kids: new Set(keys.map((key) => key.kid)) };
    } catch {
      reportWorkosJwksFailure("WORKOS_JWKS_BODY_INVALID");
      throw new Error("WorkOS JWKS is invalid");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function reportWorkosJwksFailure(code: string): void {
  console.error(JSON.stringify({ level: "error", service: "control-api", code }));
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new Error("WorkOS JWKS is too large");
    }
  }
  if (response.body === null) throw new Error("WorkOS JWKS is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maximumBytes) throw new Error("WorkOS JWKS is too large");
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new Error("WorkOS JWKS is invalid");
  }
}

export function parseControlApiPublicOrigin(value: unknown): string | null {
  return value === CONTROL_API_POC_ORIGIN || value === CONTROL_API_PRODUCTION_ORIGIN ? value : null;
}

function controlApiNamespace(origin: string): "poc-private-fullstack" | "production" {
  return origin === CONTROL_API_PRODUCTION_ORIGIN ? "production" : "poc-private-fullstack";
}

function isProjectDatabaseDiagnosticsBinding(
  value: unknown,
): value is ProjectDatabaseDiagnosticsBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "queryProject") === "function" &&
    typeof Reflect.get(value, "writeProject") === "function"
  );
}

function isServiceBinding(value: unknown): value is CloudflareServiceBinding {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "fetch") === "function"
  );
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

function isRateLimiter(value: unknown): value is CloudflareRateLimitBinding {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "limit") === "function"
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,256}$/u.test(value);
}

function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/**
 * Reports why the D1 request path answered 503: the class of the error and, only when it is one, its own code, which in
 * this codebase is a snake_case token such as `public_credit_binding_required`. Any other message can carry data and is
 * never reported.
 */
export function reportComposeFailure(reporter: SafeErrorReporter, error: unknown): void {
  const token = (value: unknown): value is string =>
    typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/u.test(value);
  const kind = error instanceof Error ? error.name : "NonError";
  const own = Reflect.get(Object(error), "code");
  const message = error instanceof Error ? error.message : undefined;
  const detail = token(own) ? own : token(message) ? message : null;
  try {
    void Promise.resolve(
      reporter.report({
        requestId: `req_${globalThis.crypto.randomUUID()}`,
        code: `D1_REQUEST_FAILED:${/^[A-Za-z0-9]{1,64}$/u.test(kind) ? kind : "Error"}${detail === null ? "" : `:${detail}`}`,
        route: "d1-request",
      }),
    ).catch(() => undefined);
  } catch {
    // Reporting cannot change the response.
  }
}

function createSafeConsoleReporter(): SafeErrorReporter {
  return {
    report(input) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "control-api",
          request_id: input.requestId,
          code: input.code,
          route: input.route,
        }),
      );
    },
  };
}

function unavailable(): Response {
  const response = problem(
    `req_${crypto.randomUUID()}`,
    503,
    "service_unavailable",
    "The Control API is temporarily unavailable. Retry later; contact the operator if the problem persists.",
    true,
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

export function fetchGlobally(request: Request): Promise<Response> {
  return globalThis.fetch(request);
}

export interface ManagedSourceProcessorBindings {
  readonly PREVIEW_API_RUNTIME?: ProductApiPreviewRuntime;
  readonly PREVIEW_EXECUTION?: PreviewExecutionBinding;
  readonly MANAGED_SOURCE_RUNTIME?: unknown;
  readonly CONTROL_RUNTIME?: unknown;
  readonly SOURCE_INSPECTOR: ManagedSourcePrivateBinding;
  readonly MANAGED_ARTIFACTS_NAMESPACE_US?: string;
  readonly MANAGED_ARTIFACTS_NAMESPACE_EU?: string;
  readonly OPERATION_PUBLISHER: { wake(): Promise<void> };
}

/** Durable queue consumer for sealed snapshots over the Core capability bindings. */
export class ManagedSourceProcessor extends WorkerEntrypoint<ManagedSourceProcessorBindings> {
  #processor() {
    const runtime = this.env.MANAGED_SOURCE_RUNTIME,
      control = this.env.CONTROL_RUNTIME;
    if (
      !isD1ManagedSourceProcessorRuntime(runtime) ||
      !isD1RemoteMcpRuntime(control) ||
      !this.env.MANAGED_ARTIFACTS_NAMESPACE_US ||
      !this.env.MANAGED_ARTIFACTS_NAMESPACE_EU ||
      typeof this.env.SOURCE_INSPECTOR.managedGit !== "function" ||
      typeof this.env.SOURCE_INSPECTOR.managedBlob !== "function"
    )
      throw new Error("Managed source processor is unavailable");
    const clock = new SystemClock();
    return createD1ManagedSourceProcessor({
      runtime: runtime as never,
      clock,
      ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
      binding: this.env.SOURCE_INSPECTOR,
      namespaces: {
        us: this.env.MANAGED_ARTIFACTS_NAMESPACE_US,
        eu: this.env.MANAGED_ARTIFACTS_NAMESPACE_EU,
      },
      wake: wakePublisher(this.env),
      notifyPreviewSource: (scope) =>
        notifyPreviewSources(this.env.PREVIEW_API_RUNTIME, this.env.PREVIEW_EXECUTION, scope),
      delegations: createD1McpDelegations(control).store,
    });
  }

  public async initialize(raw: unknown) {
    return this.#processor().initialize(raw);
  }

  public async process(raw: unknown) {
    return this.#processor().process(raw);
  }
}

export interface BuildReceiptServiceBindings {
  readonly CONTROL_RUNTIME?: unknown;
}

/** Private Native runtime only; never bind to a customer Worker or expose through HTTP. */
export class NativeAuthProviderSecretService extends WorkerEntrypoint<ControlApiWorkerBindings> {
  public async resolve(input: unknown) {
    try {
      const authority = this.env.NATIVE_AUTH_PROVIDER_RUNTIME;
      if (!authority) throw new Error("native_auth_unavailable");
      const cipher = createEnvironmentSecretCipherKeyring({
        primaryKeyBase64: this.env.ENVIRONMENT_SECRET_KEY_BASE64,
        ...(this.env.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON === undefined
          ? {}
          : { additionalKeysJson: this.env.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON }),
        currentKeyVersion: Number(this.env.ENVIRONMENT_SECRET_KEY_VERSION),
        crypto: globalThis.crypto,
      });
      return await createNativeAuthProviderSecretResolver({ authority, cipher })(input);
    } catch {
      throw new Error("native_auth_unavailable");
    }
  }
}

/** Private broker-to-Control authority; never bound to customer Workers. */
export class ConnectionAuthorityService extends WorkerEntrypoint<ControlApiWorkerBindings> {
  #observer() {
    const runtime = this.env.CONTROL_RUNTIME;
    if (
      !runtime ||
      typeof runtime.resolveWorkosOrganization !== "function" ||
      !this.env.AUTH_STATUS ||
      !isRateLimiter(this.env.CONTROL_API_RATE_LIMITER)
    )
      throw new Error("connection_authority_unavailable");
    return createIntegrationOriginObserver({
      sessionStatus: createWorkosSessionStatusClient(this.env.AUTH_STATUS),
      apiKeyStatus: createWorkosUserApiKeyClient(this.env.AUTH_STATUS),
      resolveOrganization: (id) => createD1WorkosOrganizationResolver(runtime).resolve(id),
      now: () => new Date(),
    });
  }
  async rateLimitConnectionRequest(input: { clientAddress: string | null }) {
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).join(",") !== "clientAddress" ||
      (input.clientAddress !== null &&
        (typeof input.clientAddress !== "string" || input.clientAddress.length > 64)) ||
      !isRateLimiter(this.env.CONTROL_API_RATE_LIMITER)
    )
      throw new Error("connection_authority_unavailable");
    return (
      await this.env.CONTROL_API_RATE_LIMITER.limit({
        key: `connection-oauth:visitor:${rateLimitClientKey(input.clientAddress ?? undefined)}`,
      })
    ).success;
  }
  async integrationAuthorityReadiness(input: Record<string, never>) {
    if (!input || typeof input !== "object" || Object.keys(input).length !== 0)
      return { state: "unavailable" as const };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.#observer();
      const runtime = this.env.CONTROL_RUNTIME;
      if (!runtime) throw new Error("connection_authority_unavailable");
      await Promise.race([
        createD1WorkosOrganizationResolver(runtime).resolve("org_connection_observer_probe"),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("connection_authority_unavailable")), 5000);
        }),
      ]);
      return { state: "ready" as const };
    } catch {
      return { state: "unavailable" as const };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  async observeConnectionOrigin(input: unknown) {
    await this.#observer().observeConnectionOrigin(input);
  }
  async observeIntegrationMutation(input: unknown) {
    await this.#observer().observeIntegrationMutation(input);
  }
}

export class BuildReceiptPersistenceService extends WorkerEntrypoint<BuildReceiptServiceBindings> {
  #persistence(): BuildReceiptPersistencePort {
    return createD1BuildReceiptPersistence(this.env.CONTROL_RUNTIME);
  }

  public async claimBuildInput(claim: BuildInputClaimRequest): Promise<BuildInputClaimResult> {
    try {
      return await this.#persistence().claimBuildInput(claim);
    } catch (error) {
      if (error instanceof BuildInputConflictError || error instanceof BuildCapacityReachedError)
        throw error;
      throw new Error("Build receipt persistence is unavailable");
    }
  }

  public async authorizeBuildStart(
    scope: BuildInputClaimRequest["scope"],
    claimId: string,
  ): Promise<boolean> {
    try {
      return await this.#persistence().authorizeBuildStart(scope, claimId);
    } catch {
      throw new Error("Build receipt persistence is unavailable");
    }
  }

  public async putBuildReceipt(envelope: PersistedBuildReceiptEnvelope): Promise<void> {
    try {
      await this.#persistence().putBuildReceipt(envelope);
    } catch {
      throw new Error("Build receipt persistence is unavailable");
    }
  }

  public async putBuildUsage(input: BuildUsageInput): Promise<void> {
    try {
      await this.#persistence().putBuildUsage(input);
    } catch {
      throw new Error("Build usage persistence is unavailable");
    }
  }
}

interface RuntimeCreditServiceBindings {
  readonly RUNTIME_PROBE_RUNTIME?: unknown;
  readonly GATEWAY_CREDIT_RUNTIME?: unknown;
  readonly CONTROL_API_RATE_LIMITER: CloudflareRateLimitBinding;
}

export class RuntimeCreditService extends WorkerEntrypoint<RuntimeCreditServiceBindings> {
  public async beginProbe(input: unknown) {
    try {
      const d1 = selectD1GatewayBindings(this.env);
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(",") !==
          "deploymentId,environmentId,organizationId,projectId"
      )
        throw new TypeError("Invalid probe scope");
      const value = input as Record<string, unknown>;
      const scope = {
        organizationId: parseUlid(value["organizationId"] as string),
        projectId: parseUlid(value["projectId"] as string),
        environmentId: parseUlid(value["environmentId"] as string),
        deploymentId: parseUlid(value["deploymentId"] as string),
      };
      if (
        !(
          await this.env.CONTROL_API_RATE_LIMITER.limit({ key: `runtime-probe:${scope.projectId}` })
        ).success
      )
        throw new Error("Probe rate limited");
      const clock = new SystemClock(),
        ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
      return await beginD1RuntimeProbe(d1, { ...scope, windowId: ids.next() });
    } catch {
      throw new Error("Runtime probe accounting is unavailable");
    }
  }

  public async read(input: unknown) {
    try {
      const d1 = selectD1GatewayBindings(this.env);
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(",") !==
          "environmentId,includePaidPlan,organizationId,projectId" ||
        Reflect.get(input, "includePaidPlan") !== true
      )
        throw new TypeError("Invalid runtime credit scope");
      const value = input as Record<string, unknown>;
      const scope = {
        organizationId: parseUlid(value["organizationId"] as string),
        projectId: parseUlid(value["projectId"] as string),
        environmentId: parseUlid(value["environmentId"] as string),
      };
      // Served on every customer request: lock-free and read-only, so no per-project throttle.
      return await readD1RuntimeCreditDecision(d1, scope, new SystemClock().now().toISOString());
    } catch {
      throw new Error("Runtime credit admission is unavailable");
    }
  }
}

interface DevAccessServiceBindings {
  readonly DEV_ACCESS_RUNTIME?: unknown;
  readonly CONTROL_API_RATE_LIMITER: CloudflareRateLimitBinding;
  readonly PUBLIC_ENTRY_RATE_LIMITER: CloudflareRateLimitBinding;
  readonly DEV_ACCESS_SESSION_PRIVATE_JWK: string;
  readonly DEV_ACCESS_SESSION_PUBLIC_JWK: string;
}

export class DevAccessService extends WorkerEntrypoint<DevAccessServiceBindings> {
  #sessions() {
    const runtime = this.env.DEV_ACCESS_RUNTIME;
    if (!isD1DevAccessRuntime(runtime)) throw new Error("dev_access_binding_required");
    return createD1DevAccessSessions({
      runtime,
      clock: new SystemClock(),
      crypto: globalThis.crypto,
    });
  }

  public async issueRuntimeProbe(input: unknown) {
    try {
      const request = parseDevRuntimeProbeInput(input);
      // The probe is platform-internal, so it has one constant bound that no redemption spends.
      await enforceDevAccessLimit(this.env.CONTROL_API_RATE_LIMITER, "dev-access:probe");
      const privateJwk = parseJwkSecret(this.env.DEV_ACCESS_SESSION_PRIVATE_JWK);
      const publicJwk = parseJwkSecret(this.env.DEV_ACCESS_SESSION_PUBLIC_JWK);
      return await this.#sessions().probeIssuer({ privateJwk, publicJwk }).issue(request);
    } catch {
      throw new Error("Dev runtime probe issuance is unavailable");
    }
  }

  public async redeem(input: DevAccessRedeemInput) {
    try {
      const request = parseDevAccessRedeemInput(input);
      // A client's own bound is spent first, so one source's flood never spends the project's bound.
      await enforceDevAccessLimit(
        this.env.PUBLIC_ENTRY_RATE_LIMITER,
        `dev-access:redeem-client:${request.projectId}:${rateLimitClientKey(request.clientAddress)}`,
      );
      // Unvalidated tickets spend only their own project's bound, never one shared by all tenants.
      await enforceDevAccessLimit(
        this.env.CONTROL_API_RATE_LIMITER,
        `dev-access:redeem:${request.projectId}`,
      );
      const privateJwk = parseJwkSecret(this.env.DEV_ACCESS_SESSION_PRIVATE_JWK);
      const publicJwk = parseJwkSecret(this.env.DEV_ACCESS_SESSION_PUBLIC_JWK);
      return await this.#sessions().redeemer({ privateJwk, publicJwk }).redeem(request);
    } catch (error) {
      // The gateway answers 503 for a limited redemption instead of treating the ticket as refused.
      if (error instanceof Error && error.message === DEV_ACCESS_RATE_LIMITED) throw error;
      throw new Error("Dev access redemption is unavailable");
    }
  }

  public async authorize(input: DevAccessAuthorizeInput) {
    try {
      const request = parseDevAccessAuthorizeInput(input);
      // Every Dev request authorizes: one with a session spends its own session bound, anonymous
      // traffic its own project key, never the redemption or runtime-probe bounds (D334).
      const key =
        request.sessionToken === null
          ? `dev-access:anonymous:${request.projectId}`
          : `dev-access:session:${Buffer.from(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.sessionToken)),
            ).toString("hex")}`;
      if (!(await this.env.CONTROL_API_RATE_LIMITER.limit({ key })).success)
        throw new Error("Dev access rate limit exceeded");
      const publicJwk = parseJwkSecret(this.env.DEV_ACCESS_SESSION_PUBLIC_JWK);
      return await this.#sessions().authorizer({ publicJwk }).authorize(request);
    } catch {
      throw new Error("Dev access authorization is unavailable");
    }
  }
}

const DEV_ACCESS_RATE_LIMITED = "Dev access rate limit exceeded";

async function enforceDevAccessLimit(
  limiter: CloudflareRateLimitBinding,
  key: string,
): Promise<void> {
  if (!(await limiter.limit({ key })).success) throw new Error(DEV_ACCESS_RATE_LIMITED);
}

function parseJwkSecret(value: string): JsonWebKey {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new TypeError("Dev access signing key is invalid");
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Dev access signing key is invalid");
  }
  return parsed as JsonWebKey;
}

const worker = createControlApiWorkerEntrypoint({
  fetcher: fetchGlobally,
});

export default worker;

export {
  GatewayRoutingService,
  GatewayRoutingManagementService,
} from "./gateway-routing-worker.js";

/** Calls the publisher on its RPC binding; a bound copy would reach it as the method "wake.bind". */
function wakePublisher(env: ManagedSourceProcessorBindings): () => Promise<void> {
  return () => env.OPERATION_PUBLISHER.wake();
}

function isProjectDatabaseAdmissionRuntime(
  value: unknown,
): value is ProjectDatabaseAdmissionRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "readProjectDatabaseAdmission") === "function" &&
    typeof Reflect.get(value, "recordProjectDatabaseEventAudit") === "function"
  );
}

function isD1DatabaseReadRuntime(value: unknown): value is D1ProjectRuntime &
  D1DatabaseComputeReadRuntime & {
    readProjectDatabaseAccessHistory(input: unknown): Promise<ProjectDatabaseAccessPage>;
  } {
  return (
    typeof value === "object" &&
    value !== null &&
    [
      "readProjectDatabaseOperation",
      "readProjectComputeContext",
      "readProjectDatabaseAccessHistory",
    ].every((method) => typeof Reflect.get(value, method) === "function")
  );
}

/** Common existing browser/Connect transport; the caller has already selected its single persistence authority. */
async function dispatchRemoteMcpRequest(input: {
  request: Request;
  remote: ReturnType<typeof createRemoteMcpComposition>;
  usageLog: {
    report: UsageReporter;
    environment: "development" | "production";
    version: string | null;
  };
  origin: string;
  sessionPassword: string;
  browserLoginEnabled: boolean;
  clock: Clock;
  limiter: CloudflareRateLimitBinding;
  issuer: string;
  workos: WorkosTokenExchange;
  projects?: NonNullable<McpPortalRequestDependencies["projects"]>;
}): Promise<Response> {
  const { request, remote, clock } = input;
  const portal = await handleMcpPortalRequest(request, {
    access: remote.access,
    ...(input.browserLoginEnabled
      ? {
          resumeAfterLogin: (url: URL) =>
            redirectToPortalLogin(url, input.sessionPassword, clock.now().getTime()),
        }
      : {}),
    dispatch: remote.dispatch,
    dispatchHandoff: remote.dispatchHandoff,
    ...(input.projects === undefined ? {} : { projects: input.projects }),
    limiter: input.limiter,
    withHandoff: remote.withHandoff,
    authenticateBrowser: async (browserRequest) => {
      const session = await openBrowserSession(
        browserRequest.headers.get("cookie"),
        input.sessionPassword,
        input.origin,
        clock.now().getTime(),
      );
      if (!session) return null;
      const principal = await remote.authenticateBrowser(session.accessToken);
      if (principal) return { principal, csrf: session.csrf };
      // WorkOS access tokens live minutes while the sealed session lives a week, so an expired token is renewed from the
      // refresh token. A rejected refresh ends the session; any other failure is an outage, not a sign-out.
      const renewed = await exchangeWorkosToken(
        input.workos,
        { grant_type: "refresh_token", refresh_token: session.refreshToken },
        session,
      ).catch((error: unknown) => {
        if (error instanceof Error && Reflect.get(error, "status") === 401) return null;
        throw error;
      });
      // A rejected refresh is a signed-out answer that sets no cookie: WorkOS issues each refresh token once, so a parallel
      // request may already have stored the rotated session, and a clear sent now could erase it in the browser.
      if (renewed === null) return null;
      // WorkOS rotates the refresh token on use, so a renewed session is stored even when its access token is refused.
      const headers = new Headers({
        "set-cookie": await closeBrowserSession(renewed, input.sessionPassword),
      });
      const renewedPrincipal = await remote.authenticateBrowser(renewed.accessToken);
      if (!renewedPrincipal) return { headers };
      return { principal: renewedPrincipal, csrf: renewed.csrf, headers };
    },
  });
  if (portal) return portal;
  const limitedPrincipals = new Set<string>();
  const mcp = createRemoteOhmyhostMcpHandler({
    usageLog: input.usageLog,
    endpoint: `${input.origin}/mcp`,
    authorizationServers: [input.issuer],
    access: remote.access,
    authenticate: async (token) => {
      const principal = await remote.authenticate(token);
      if (
        principal &&
        !limitedPrincipals.has(principal.credentialId) &&
        !(
          await input.limiter.limit({
            key: `remote-mcp:principal:${principal.actorId}:${principal.connectUser.clientId}`,
          })
        ).success
      )
        throw new Error("Remote MCP request rate exceeded");
      if (principal) limitedPrincipals.add(principal.credentialId);
      return principal;
    },
    dispatch: remote.dispatch,
  });
  try {
    const response = await mcp.fetch(request);
    if (!response) return notFound();
    // MCP sends a finite SSE response before asynchronous callbacks finish. Drain it before
    // the request ends; durable source mutations run in their processor.
    const body = response.body === null ? null : await readBoundedText(response, 4 * 1024 * 1024);
    return new Response(body, { status: response.status, headers: response.headers });
  } finally {
    await mcp.close();
  }
}
