import { parseMakeAction } from "./make-action-execution.js";
import { renderStandalonePage, standalonePageCsp } from "./standalone-page.js";
import { integrationSessionMemberships } from "./integrations.js";
import {
  startUsage,
  usageOperation,
  usageParent,
  usageParentContext,
  usageState,
  usageResponse,
  setUsageResponse,
  validUsageOperationId,
  usageAccount,
  type UsageScope,
} from "./usage-log.js";
import { restrictionAllows, intersectAuthorizationRestriction } from "@ohmyhost/platform";
import { isSignupUtm } from "@ohmyhost/contracts/signup-attribution";
import { parsePreviewView } from "@ohmyhost/contracts";
import { parseDatabaseComputeChangeRequest } from "@ohmyhost/contracts/database-sizes";
import {
  isInstalledPlatformKeyName,
  isUserSecretName,
  SECRET_VALUE_MAXIMUM_BYTES,
  USER_SECRET_NAME_PATTERN,
} from "@ohmyhost/contracts/secret-names";
import { PROBLEM_POLICY, type ProblemCode } from "@ohmyhost/contracts/problem-policy";
import { assertSharedMailResponse } from "@ohmyhost/contracts/shared-mail";
import { ManagedMailPortError } from "./managed-mail.js";
import {
  NativeAuthManagementError,
  type NativeAuthRefusal,
  nativeConfigUpdate,
  nativeProviderUpdate,
  nativeInvite,
  nativeConfigResponse,
  nativeProviderResponse,
  nativeUserResponse,
  nativeUserPageResponse,
} from "./native-auth-management.js";
import { registerSharedMailRoutes, type SharedMailRequestOptions } from "./shared-mail-routes.js";
import {
  isProjectDataChangeKind,
  parseProjectDataChangePlan,
} from "@ohmyhost/contracts/project-data-changes";
import {
  frameworkConversionDetail,
  frameworkConversionDiagnosticFromDetail,
} from "@ohmyhost/contracts/framework-admission";
import { projectHandleProblem, suggestProjectHandles } from "@ohmyhost/project-handles";
import {
  parseProjectDatabaseWrite,
  assertProjectDatabaseWriteReceipt,
  assertProjectDatabaseAccess,
  assertProjectDatabaseAccessCredential,
  assertProjectDatabaseAccessPage,
  parseProjectDatabaseAccessRequest,
  type ProjectDatabaseAccessRequest,
} from "@ohmyhost/contracts/database-access";
import { assertOrganizationAccount } from "@ohmyhost/contracts/credit-pricing";
import { handlePublicEntry } from "./public-entry.js";
import {
  createOperationDeploymentProgress,
  type DeploymentProgressPhase,
} from "@ohmyhost/contracts/operation-deployment-result";
import { assertDatabaseCompute } from "@ohmyhost/contracts/database-compute";
import {
  assertDatabaseExecutionUsagePage,
  assertDatabaseSchedule,
  assertDatabaseSchedulePage,
  assertDatabaseScheduleDeleted,
  assertDatabaseScheduleRunAccepted,
  assertDatabaseScheduleRunPage,
  assertDatabaseWebhook,
  assertDatabaseWebhookCreated,
  assertDatabaseWebhookSubscription,
  assertDatabaseWebhookSubscriptionActivation,
  assertDatabaseWebhookDeleted,
  assertDatabaseWebhookDeliveryPage,
  assertDatabaseWebhookPage,
  assertDatabaseWebhookReplayAccepted,
  assertDatabaseWatch,
  assertDatabaseWatchDeleted,
  assertDatabaseWatchPage,
  assertDatabaseWebhookTest,
  isDatabaseWebhookEventTypes,
  parseDatabaseCursor,
  parseDatabaseDeliveryId,
  parseDatabaseWebhookSubscriptionId,
  parseDatabaseWebhookGeneration,
  parseDatabaseEnvironment,
  parseDatabaseListLimit,
  parseDatabaseScheduleName,
  parseDatabaseScheduleSetRequest,
  parseDatabaseUsageWindow,
  parseDatabaseWatchCreateRequest,
  parseDatabaseWatchId,
  parseDatabaseWebhookCreateRequest,
  parseDatabaseWebhookId,
} from "@ohmyhost/contracts/database-events";
import {
  assertProjectContext,
  assertProjectNotesReceipt,
} from "@ohmyhost/contracts/project-context";
import {
  CloudflareDnsAuthorizationClosedError,
  CloudflareZoneNotBoundError,
} from "./cloudflare-domain-management.js";
import { renderProjectContext } from "./project-context.js";
import {
  assertProjectExport,
  assertProjectExportDownloadLink,
  EXPORT_PASSWORD_MIN_CHARACTERS,
  exportPasswordMeetsMinimum,
} from "@ohmyhost/contracts/project-exports";
import { ProjectExportLinkLimitError, ProjectExportNotReadyError } from "./project-exports.js";
import { USER_API_KEY_ID } from "@ohmyhost/contracts/user-api-keys";
import { UserApiKeyServiceError } from "./user-api-key-management.js";
import {
  ProviderReconciliationExhaustedError,
  ProviderReconciliationUnmatchedError,
} from "./provider-reconciliation.js";
import { FeedbackSubmissionError, parseFeedbackSubmission } from "@ohmyhost/contracts/feedback";
import { createHash, randomUUID } from "node:crypto";
import { isSaasCnameTarget } from "@ohmyhost/contracts/platform-origins";
import { assertOrganizationCreditUsage } from "@ohmyhost/contracts/credit-pricing";
import {
  isDeploymentDiagnosticCatalogEntry,
  ProjectDomainDeletionRequiredError,
  OrganizationCreditError,
  ProjectComputeChangeError,
  ProjectDatabaseAccessError,
  ProjectDatabaseWriteError,
  ProjectRecoveryDailyLimitError,
  FeedbackPersistenceError,
  ProjectNotesConflict,
  DevShareRotationConflictError,
  PoweredByFlagIdempotencyConflictError,
  PoweredByFlagRequiredError,
  workspaceReferralSource,
  type DeploymentDiagnosticCode,
} from "@ohmyhost/database";

import {
  DEFAULT_HOSTING_REGION,
  HOSTING_REGIONS,
  normalizeProjectNotes,
  parseUlid,
  rehydrateOperation,
  type AuthorizationAction,
  type AuthorizationResource,
  type HostingRegion,
  type Operation,
  type Ulid,
} from "@ohmyhost/platform";
import canonicalize from "canonicalize";
import { Hono, type Context } from "hono";

import {
  ACTION_CONFIRMATION_TTL_SECONDS,
  DEPLOYMENT_PLAN_TTL_SECONDS,
  IdempotencyKeyReusedError,
  InvalidProjectCursorError,
  ProjectDatabaseEventsError,
  type ProjectDatabaseEventsPort,
  type ProjectDatabaseEventsRejection,
  ProductSurfaceConflictError,
  SourceAdmissionPolicyInconsistentError,
  type AuthenticatedPrincipal,
  type ControlApiDependencies,
  type EnvironmentSecretContext,
  type EnvironmentSecretMetadataView,
  type CloudflareDnsAuthorizationStatusView,
  type CloudflareDomainAuthorizationCompletion,
  type CloudflareDomainAuthorizationView,
  type RuntimeSecretDeliveryMetadataView,
  type ProjectView,
  type OperationView,
  ProjectHandleAllocationExhaustedError,
  ProjectIdentityAllocationExhaustedError,
  type ProductSurfaceContext,
  type ProductSurfaceResult,
  type FunctionRunView,
} from "./contracts.js";
import {
  EnvironmentSecretMutationBlockedError,
  EnvironmentSecretNotInstalledError,
} from "./environment-secrets.js";
import { ProjectDatabaseQueryRejectedError } from "./project-database-diagnostics.js";
import {
  databaseTableBody,
  parseDatabaseEventsQuery,
  parseDatabaseTableCreateBody,
  type DatabaseEventsQuery,
} from "./project-database-events.js";
import {
  parseMigrationFailureDiagnostic,
  publicOperationFailure,
  publicOperationReconciliation,
  type PublicOperationFailure,
} from "@ohmyhost/contracts/operation-failure";
import { OrganizationCreationError } from "./organization-onboarding.js";
import { rateLimitClientKey } from "./rate-limit-client-key.js";
import {
  GithubAuthorizationCodeRejectedError,
  GithubAuthorizationRejectedError,
  GithubRepositoryAccessRequiredError,
  GithubRepositoryNotInstalledError,
} from "./github-source-authorization.js";
import {
  GithubConnectionRequiredError,
  GithubConnectionStateUnknownError,
} from "./github-organization-connection.js";
import {
  GITHUB_AUTHORIZATION_FAILED_PATH,
  GITHUB_AUTHORIZATION_PENDING_PATH,
  GITHUB_AUTHORIZED_PATH,
  STRICT_TRANSPORT_SECURITY,
} from "./portal-page.js";
import { BillingServiceError } from "./billing.js";
import {
  assertManagedSourceResponse,
  assertGithubSourceResponse,
} from "@ohmyhost/contracts/managed-sources";
import {
  ManagedSourceConflictError,
  ManagedSourceInitializationError,
  ManagedSourceReservationError,
} from "@ohmyhost/database";
import {
  registerManagedSourceRoutes,
  ManagedSourceSurfaceError,
} from "./managed-source-surface.js";

const MAX_JSON_BYTES = 65_600;
const SECRET_NAME_PATTERN = USER_SECRET_NAME_PATTERN;
const CLOUDFLARE_OAUTH_COMPLETION_FAILURE_CODES: Readonly<
  Record<Exclude<CloudflareDomainAuthorizationCompletion, "authorized" | "invalid">, string>
> = Object.freeze({
  token_exchange_failed: "CLOUDFLARE_OAUTH_TOKEN_EXCHANGE_FAILED",
  zone_observe_failed: "CLOUDFLARE_OAUTH_ZONE_OBSERVE_FAILED",
  token_encrypt_failed: "CLOUDFLARE_OAUTH_TOKEN_ENCRYPT_FAILED",
  grant_persist_failed: "CLOUDFLARE_OAUTH_GRANT_PERSIST_FAILED",
});

interface RequestAuthentication {
  readonly principal: AuthenticatedPrincipal;
  readonly revalidate: () => Promise<RequestAuthenticationResult>;
}

type RequestAuthenticationResult =
  | { readonly outcome: "authenticated"; readonly authentication: RequestAuthentication }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "unavailable" };

type VisibleProjectResult =
  | { readonly outcome: "found"; readonly project: ProjectView }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable" };

type VisibleOperationResult =
  | {
      readonly outcome: "found";
      readonly operation: OperationView;
      readonly organizationId: Ulid;
      readonly principal: AuthenticatedPrincipal;
      readonly revalidate: () => Promise<RequestAuthenticationResult>;
    }
  | { readonly outcome: "invalid"; readonly detail: string }
  | { readonly outcome: "rejected"; readonly response: Response }
  | { readonly outcome: "unauthenticated" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable" };

type AuthorizationOutcome = "allow" | "deny" | "unavailable";

interface UsageRequestObservation extends UsageScope {
  accountSeen: boolean;
  scopeSeen: boolean;
  ambiguous: boolean;
  start?: () => void;
}
const usageRequests = new WeakMap<Request, UsageRequestObservation>();
const usagePrincipals = new WeakMap<AuthenticatedPrincipal, UsageRequestObservation>();

interface GrowthRequestObservation {
  accountId: string | null;
  organizationId: string;
}
const growthRequests = new WeakMap<Request, { authorized?: GrowthRequestObservation }>();
const growthPrincipals = new WeakMap<
  AuthenticatedPrincipal,
  { authorized?: GrowthRequestObservation }
>();

export function createControlApi(dependencies: ControlApiDependencies): Hono {
  const app = new Hono();
  const createRequestId = dependencies.requestId ?? (() => `req_${randomUUID()}`);

  app.use("*", async (context, next) => {
    const observation: { authorized?: GrowthRequestObservation } = {};
    growthRequests.set(context.req.raw, observation);
    const usageScope: UsageRequestObservation = {
      accountId: null,
      organizationId: null,
      projectId: null,
      accountSeen: false,
      scopeSeen: false,
      ambiguous: false,
    };
    usageRequests.set(context.req.raw, usageScope);
    const startedAt = new Date().toISOString();
    const startedMonotonic = performance.now();
    const operation = usageOperation(context.req.method, context.req.path);
    const usageRef: { current: ReturnType<typeof startUsage> } = { current: null };
    usageScope.start = () => {
      if (!usageRef.current && operation && dependencies.usageLog)
        usageRef.current = startUsage(dependencies.usageLog.report, {
          environment: dependencies.usageLog.environment,
          version: dependencies.usageLog.version,
          transport: "rest",
          operation,
          parent: usageParent(context.req.raw),
          scope: usageScope,
          startedAt,
          startedMonotonic,
        });
    };
    try {
      await next();
    } finally {
      if (usageRef.current && usageScope.accountSeen) {
        const parent = usageParentContext(context.req.raw);
        if (parent && usageScope.ambiguous) {
          parent.scope.organizationId = null;
          parent.scope.projectId = null;
          parent.ambiguous = true;
        }
        if (parent && usageScope.scopeSeen && !usageScope.ambiguous && !parent.ambiguous) {
          if (
            parent.scope.organizationId === null ||
            parent.scope.organizationId === usageScope.organizationId
          ) {
            parent.scope.organizationId = usageScope.organizationId;
            if (
              parent.scope.projectId === null ||
              usageScope.projectId === null ||
              parent.scope.projectId === usageScope.projectId
            )
              parent.scope.projectId ??= usageScope.projectId;
            else {
              parent.scope.organizationId = null;
              parent.scope.projectId = null;
              parent.ambiguous = true;
            }
          } else {
            parent.scope.organizationId = null;
            parent.scope.projectId = null;
            parent.ambiguous = true;
          }
        }
        const response = context.res;
        const meta = usageResponse(response);
        if (parent && response.status === 202) {
          parent.accepted = true;
          parent.operationId = meta?.operationId;
          parent.operationStatus = meta?.operationStatus;
        }
        const cancelled = context.req.raw.signal.aborted;
        usageRef.current.finish(
          usageScope,
          cancelled
            ? "cancelled"
            : response.status === 202
              ? "accepted"
              : response.status < 400
                ? "succeeded"
                : "failed",
          response.status,
          meta?.code,
          meta?.operationId,
          meta?.operationStatus,
        );
      }
    }
    if (observation.authorized && dependencies.growthProductResult) {
      try {
        dependencies.growthProductResult({ ...observation.authorized, status: context.res.status });
      } catch {
        /* Observation is never part of the product result. */
      }
    }
    setSecurityHeaders(context, dependencies.allowedOrigins);
  });

  if (dependencies.managedSources !== undefined) {
    registerManagedSourceRoutes(
      app,
      (context, options) =>
        handleProductSurfaceRequest(context, dependencies, createRequestId, options),
      dependencies.managedSources,
    );
  }

  registerSharedMailRoutes(
    app,
    (context, options) => handleSharedMailRequest(context, dependencies, createRequestId, options),
    dependencies.sharedMail,
    dependencies.sharedMailIdentity,
    (context) =>
      problem(
        requestIdFor(context, createRequestId),
        400,
        "invalid_request",
        "Supply the exact documented JSON resource fields.",
      ),
  );

  app.options("/v1/*", (context) => {
    const origin = context.req.header("origin");
    if (origin === undefined || !dependencies.allowedOrigins.has(origin)) {
      return new Response(null, { status: 204 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, Idempotency-Key, If-Match, X-Confirmation-Token, X-Request-Id",
        "Access-Control-Allow-Methods": "DELETE, GET, POST, PUT, OPTIONS",
        "Access-Control-Max-Age": "600",
      },
    });
  });

  app.all("/v1/site/*", (context) => handlePublicEntry(context.req.raw, dependencies.publicEntry));
  app.all("/v1/contact-requests", (context) =>
    handlePublicEntry(context.req.raw, dependencies.publicEntry),
  );

  app.get("/v1/cloudflare/oauth/callback", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    const url = new URL(context.req.url);
    const keys = [...url.searchParams.keys()].sort();
    const providerError = url.searchParams.get("error");
    if (
      providerError !== null &&
      /^[a-z_]{1,64}$/u.test(providerError) &&
      keys.every(
        (key) =>
          ["error", "error_description", "error_uri", "state"].includes(key) &&
          url.searchParams.getAll(key).length === 1 &&
          (url.searchParams.get(key)?.length ?? 0) <= 2048,
      )
    ) {
      return problem(
        requestId,
        409,
        "confirmation_invalid",
        providerError === "request_forbidden"
          ? "Cloudflare refused authorization. Check that the OAuth application is public and that the selected Cloudflare account permits access, then start a fresh authorization."
          : "Cloudflare authorization was not granted. Start a fresh authorization and review the selected account and permissions.",
      );
    }
    const callbackScope = url.searchParams.get("scope");
    const callbackScopes = callbackScope?.split(" ") ?? [];
    if (
      !["code,state", "code,scope,state"].includes(keys.join(",")) ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.getAll("state").length !== 1 ||
      (callbackScope !== null &&
        (url.searchParams.getAll("scope").length !== 1 ||
          callbackScopes.length !== 3 ||
          new Set(callbackScopes).size !== 3 ||
          [...callbackScopes].sort().join(",") !== "dns.write,offline_access,zone.read"))
    ) {
      return problem(
        requestId,
        400,
        "invalid_request",
        "Cloudflare authorization callback is invalid.",
      );
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!isOpaqueOAuthValue(code, 8, 2048) || !isOpaqueOAuthValue(state, 16, 2048)) {
      return problem(
        requestId,
        400,
        "invalid_request",
        "Cloudflare authorization callback is invalid.",
      );
    }
    const portalSessionPrincipal = dependencies.portalSessionPrincipal;
    if (dependencies.cloudflareDomains === undefined || portalSessionPrincipal === undefined) {
      return problem(
        requestId,
        503,
        "service_unavailable",
        "Cloudflare authorization is unavailable.",
        true,
      );
    }
    try {
      // Only the user who started the authorization completes it, in a browser signed in to the portal as them.
      // Without that session nothing is read or consumed, whatever the state is.
      const principalId = await portalSessionPrincipal(context.req.raw);
      if (principalId === null) {
        return problem(
          requestId,
          409,
          "confirmation_invalid",
          "Sign in to ohmyho.st in this browser as the person who started this Cloudflare authorization, then open the authorization link again.",
        );
      }
      const outcome = await dependencies.cloudflareDomains.completeAuthorization({
        code,
        state,
        principalId,
      });
      if (outcome === "invalid") {
        return problem(
          requestId,
          409,
          "confirmation_invalid",
          "Cloudflare authorization is invalid or already consumed.",
        );
      }
      if (outcome !== "authorized") {
        reportFailure(
          dependencies,
          requestId,
          CLOUDFLARE_OAUTH_COMPLETION_FAILURE_CODES[outcome],
          "/v1/cloudflare/oauth/callback",
        );
        return problem(
          requestId,
          503,
          "service_unavailable",
          "Cloudflare authorization is unavailable.",
          true,
        );
      }
      const response = renderStandalonePage({
        title: "Cloudflare authorized",
        message: "Cloudflare authorization completed. You may close this window.",
        body: "",
        status: 200,
        head: context.req.method === "HEAD",
        referrerPolicy: "no-referrer",
      });
      response.headers.set("X-Request-Id", requestId);
      return response;
    } catch {
      reportFailure(
        dependencies,
        requestId,
        "CLOUDFLARE_OAUTH_CALLBACK_FAILED",
        "/v1/cloudflare/oauth/callback",
      );
      return problem(
        requestId,
        503,
        "service_unavailable",
        "Cloudflare authorization is unavailable.",
        true,
      );
    }
  });

  for (const route of [
    { method: "POST", suffix: "", action: "create" },
    { method: "GET", suffix: "", action: "list" },
    { method: "DELETE", suffix: "/:key_id", action: "revoke" },
  ] as const)
    app.on(
      route.method,
      `/v1/organizations/:organization_id/user-api-keys${route.suffix}`,
      async (context) => {
        const requestId = requestIdFor(context, createRequestId);
        if (!dependencies.userApiKeys)
          return problem(requestId, 404, "resource_not_found", "Resource not found.");
        const baseLimit = await enforceBaseLimits(
          dependencies,
          requestId,
          context.req.header("cf-connecting-ip"),
        );
        if (baseLimit) return baseLimit;
        const authenticated = await authenticate(context, dependencies);
        if (authenticated.outcome !== "authenticated")
          return problem(
            requestId,
            authenticated.outcome === "invalid" ? 401 : 503,
            authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
            "Authentication is required.",
          );
        const principalLimit = await enforcePrincipalLimits(
          dependencies,
          requestId,
          authenticated.authentication.principal,
        );
        if (principalLimit) return principalLimit;
        const organizationId = parseRouteUlid(context.req.param("organization_id"));
        const query = new URL(context.req.url).searchParams;
        const after = query.get("after");
        if (
          !organizationId ||
          validateCallerRequestId(context) ||
          (route.action === "list"
            ? [...query.keys()].some((key) => key !== "after") ||
              query.getAll("after").length > 1 ||
              (after !== null && !USER_API_KEY_ID.test(after))
            : query.size > 0)
        )
          return problem(
            requestId,
            400,
            "invalid_request",
            "Supply the organization and the cursor returned by token list.",
          );
        const fresh = await authenticated.authentication.revalidate();
        if (fresh.outcome !== "authenticated")
          return problem(
            requestId,
            fresh.outcome === "invalid" ? 401 : 503,
            fresh.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
            "Authentication is required.",
          );
        const principal = fresh.authentication.principal;
        if (!principal.organizationIds.includes(organizationId))
          return problem(requestId, 404, "resource_not_found", "Resource not found.");
        const organizationLimit = await enforceLimit(
          dependencies,
          requestId,
          "organization",
          organizationId,
        );
        if (organizationLimit) return organizationLimit;
        if (!principal.session)
          return problem(
            requestId,
            403,
            "interactive_login_required",
            "Token management requires an interactive login. Unset OHMYHOST_TOKEN, run ohmyhost login, then retry.",
          );
        const allowed = await authorize(
          dependencies,
          principal,
          { kind: "organization", organizationId },
          "api-keys:manage",
        );
        if (allowed !== "allow")
          return problem(
            requestId,
            allowed === "deny" ? 404 : 503,
            allowed === "deny" ? "resource_not_found" : "service_unavailable",
            "Resource unavailable.",
          );
        try {
          if (route.action === "list")
            return json(
              await dependencies.userApiKeys.list({ principal, organizationId, after }),
              200,
              requestId,
            );
          if (route.action === "revoke") {
            const keyId = context.req.param("key_id");
            const body = await readBoundedBody(context.req.raw, 0);
            if (!keyId || !USER_API_KEY_ID.test(keyId) || body.outcome !== "ok" || body.text !== "")
              return problem(
                requestId,
                400,
                "invalid_request",
                "Supply the token ID with no request body.",
              );
            await dependencies.userApiKeys.revoke({ principal, organizationId, keyId });
            return new Response(null, {
              status: 204,
              headers: { "cache-control": "no-store", "x-request-id": requestId },
            });
          }
          const parsed = await parseJsonObject(context);
          if (parsed.outcome === "error")
            return problem(requestId, parsed.status, parsed.code, parsed.detail);
          const name = parsed.value["name"],
            key = context.req.header("idempotency-key");
          if (
            !key ||
            !/^[A-Za-z0-9._:-]{1,128}$/u.test(key) ||
            Object.keys(parsed.value).join() !== "name" ||
            typeof name !== "string" ||
            name.trim() !== name ||
            name.length < 1 ||
            name.length > 64 ||
            /\p{Cc}/u.test(name)
          )
            return problem(
              requestId,
              400,
              "invalid_request",
              "Supply a token name (1–64 characters) and an Idempotency-Key. User and permissions are server-selected; new tokens have no expiry until revoked.",
            );
          const result = await dependencies.userApiKeys.create({
            principal,
            organizationId,
            name,
            idempotencyKey: key,
          });
          return json(result, result.replayed ? 200 : 201, requestId);
        } catch (error) {
          const code =
            error instanceof UserApiKeyServiceError
              ? error.code === "forbidden"
                ? "interactive_login_required"
                : error.code
              : "service_unavailable";
          return problem(
            requestId,
            code === "invalid_request"
              ? 400
              : code === "interactive_login_required"
                ? 403
                : code === "resource_not_found"
                  ? 404
                  : code === "idempotency_key_reused"
                    ? 409
                    : 503,
            code,
            code === "api_key_permissions_unavailable"
              ? "The platform's WorkOS user-key permissions are not enabled. Report this configuration issue through feedback; a new login or repeated creation will not fix it."
              : code === "api_key_creation_uncertain"
                ? "Token creation is not confirmed. Retry the same name and Idempotency-Key to observe the original request; do not start another creation blindly."
                : code === "interactive_login_required"
                  ? "A current interactive login is required for token management."
                  : code === "idempotency_key_reused"
                    ? "This Idempotency-Key already identifies a different token name."
                    : "Token management is unavailable.",
            code === "service_unavailable" || code === "api_key_creation_uncertain",
          );
        }
      },
    );

  app.post("/v1/feedback", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit) return baseLimit;
    const authenticated = await authenticate(context, dependencies);
    if (authenticated.outcome !== "authenticated")
      return problem(
        requestId,
        authenticated.outcome === "invalid" ? 401 : 503,
        authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
        "Authentication is required.",
        authenticated.outcome === "unavailable",
      );
    const principalLimit = await enforcePrincipalLimits(
      dependencies,
      requestId,
      authenticated.authentication.principal,
    );
    if (principalLimit) return principalLimit;
    const key = context.req.header("idempotency-key");
    if (
      !key ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(key) ||
      new URL(context.req.url).search ||
      validateCallerRequestId(context)
    )
      return problem(
        requestId,
        400,
        "invalid_request",
        "Supply the original Idempotency-Key without query parameters.",
      );
    const parsed = await parseJsonObject(context);
    if (parsed.outcome === "error")
      return problem(requestId, parsed.status, parsed.code, parsed.detail);
    let report;
    try {
      report = parseFeedbackSubmission(parsed.value);
    } catch (error) {
      if (!(error instanceof FeedbackSubmissionError)) throw error;
      return problem(requestId, 400, "invalid_request", error.message);
    }
    const fresh = await authenticated.authentication.revalidate();
    if (fresh.outcome !== "authenticated")
      return problem(
        requestId,
        fresh.outcome === "invalid" ? 401 : 503,
        fresh.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
        "Authentication is required.",
        fresh.outcome === "unavailable",
      );
    const principal = fresh.authentication.principal;
    const organizationId = parseUlid(report.organization_id);
    if (!principal.organizationIds.includes(organizationId))
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    const orgLimit = await enforceLimit(dependencies, requestId, "organization", organizationId);
    if (orgLimit) return orgLimit;
    const resource: AuthorizationResource =
      report.project_id === undefined
        ? { kind: "organization", organizationId }
        : {
            kind: "project",
            organizationId,
            projectId: parseUlid(report.project_id),
            ...(report.environment_id === undefined
              ? {}
              : { environmentId: parseUlid(report.environment_id) }),
          };
    const allowed = await authorize(dependencies, principal, resource, "feedback:create");
    if (allowed !== "allow")
      return problem(
        requestId,
        allowed === "deny" ? 404 : 503,
        allowed === "deny" ? "resource_not_found" : "service_unavailable",
        "Resource unavailable.",
        allowed !== "deny",
      );
    try {
      const receipt = await dependencies.persistence.submitFeedback({
        report,
        actorId: principal.actorId,
        idempotencyKey: key,
        requestSha256: createHash("sha256")
          .update(
            `v1\nPOST\n/v1/feedback\n${organizationId}\n${principal.actorId}\n${canonicalJson(report)}`,
          )
          .digest(),
      });
      return json(receipt, 201, requestId);
    } catch (error) {
      if (error instanceof FeedbackPersistenceError)
        return problem(
          requestId,
          error.code === "resource_not_found" ? 404 : 409,
          error.code,
          error.code === "resource_not_found"
            ? "Resource not found."
            : "This Idempotency-Key already identifies a different feedback report.",
        );
      reportFailure(dependencies, requestId, "FEEDBACK_PERSISTENCE_UNAVAILABLE", "/v1/feedback");
      return problem(
        requestId,
        503,
        "service_unavailable",
        "Feedback has not been acknowledged. Retry the same report with the same Idempotency-Key to observe its durable result.",
        true,
      );
    }
  });

  app.get("/v1/feedback/:feedback_id", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit) return baseLimit;
    const authenticated = await authenticate(context, dependencies);
    if (authenticated.outcome !== "authenticated")
      return problem(
        requestId,
        authenticated.outcome === "invalid" ? 401 : 503,
        authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
        "Authentication is required.",
        authenticated.outcome === "unavailable",
      );
    const principal = authenticated.authentication.principal;
    const principalLimit = await enforcePrincipalLimits(dependencies, requestId, principal);
    if (principalLimit) return principalLimit;
    const feedbackId = parseRouteUlid(context.req.param("feedback_id"));
    const query = new URL(context.req.url).searchParams;
    const rawCursor = query.get("cursor");
    const cursor = rawCursor === null ? undefined : parseRouteUlid(rawCursor);
    if (
      feedbackId === null ||
      cursor === null ||
      [...query.keys()].some((key) => key !== "cursor") ||
      query.getAll("cursor").length > 1 ||
      validateCallerRequestId(context)
    )
      return problem(
        requestId,
        400,
        "invalid_request",
        "Supply the feedback receipt ID and optionally the next_cursor of the previous page.",
      );
    let found;
    try {
      found = await dependencies.persistence.readFeedbackStatus({
        feedbackId,
        organizationIds: principal.organizationIds,
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch {
      reportFailure(
        dependencies,
        requestId,
        "FEEDBACK_READ_UNAVAILABLE",
        "/v1/feedback/{feedback_id}",
      );
      return problem(
        requestId,
        503,
        "service_unavailable",
        "Feedback status is unavailable.",
        true,
      );
    }
    if (found === null) return problem(requestId, 404, "resource_not_found", "Resource not found.");
    const organizationId = parseUlid(found.organizationId);
    if (
      !principal.organizationIds.includes(organizationId) ||
      (found.status !== null && found.status.id !== feedbackId)
    )
      throw new TypeError("Feedback status escaped its requested scope");
    const orgLimit = await enforceLimit(dependencies, requestId, "organization", organizationId);
    if (orgLimit) return orgLimit;
    // Reading follows the report's stored scope with the permission that allowed submitting it;
    // a new action would be missing from every issued API key.
    const allowed = await authorize(
      dependencies,
      principal,
      found.projectId === null
        ? { kind: "organization", organizationId }
        : {
            kind: "project",
            organizationId,
            projectId: parseUlid(found.projectId),
            ...(found.environmentId === null
              ? {}
              : { environmentId: parseUlid(found.environmentId) }),
          },
      "feedback:create",
    );
    if (allowed !== "allow")
      return problem(
        requestId,
        allowed === "deny" ? 404 : 503,
        allowed === "deny" ? "resource_not_found" : "service_unavailable",
        allowed === "deny" ? "Resource not found." : "Resource unavailable.",
        allowed !== "deny",
      );
    // Checked only after authorization, so a cursor never reveals another report or a note.
    if (found.status === null)
      return problem(
        requestId,
        400,
        "invalid_request",
        "The cursor is not a next_cursor of this feedback receipt.",
      );
    return json(found.status, 200, requestId);
  });

  app.get("/v1/me", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    const authenticationResult = await authenticate(context, dependencies);
    if (authenticationResult.outcome === "invalid") {
      return problem(requestId, 401, "unauthenticated", "Authentication is required.");
    }
    if (authenticationResult.outcome === "unavailable") {
      reportFailure(dependencies, requestId, "AUTHENTICATION_UNAVAILABLE", "/v1/me");
      return problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
    }
    const principalLimit = await enforcePrincipalLimits(
      dependencies,
      requestId,
      authenticationResult.authentication.principal,
    );
    if (principalLimit !== null) return principalLimit;
    const requestIdError = validateCallerRequestId(context);
    if (requestIdError !== null) return problem(requestId, 400, "invalid_request", requestIdError);
    const principal = authenticationResult.authentication.principal;
    if (new URL(context.req.url).search !== "")
      return problem(
        requestId,
        400,
        "invalid_request",
        "Identity query parameters are not accepted.",
      );
    if (
      principal.actorId.length === 0 ||
      principal.actorId.length > 256 ||
      containsControlCharacter(principal.actorId) ||
      new Set(principal.organizationIds).size !== principal.organizationIds.length
    ) {
      reportFailure(dependencies, requestId, "AUTHENTICATION_INVALID", "/v1/me");
      return problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
    }
    try {
      if (!dependencies.currentIdentity) throw new Error("Identity metadata is unavailable");
      const metadata = await dependencies.currentIdentity.read(principal);
      return json(
        {
          actor_id: principal.actorId,
          organization_ids: [...principal.organizationIds].sort(),
          email: metadata.email,
          organizations: metadata.organizations,
        },
        200,
        requestId,
      );
    } catch {
      reportFailure(dependencies, requestId, "IDENTITY_METADATA_UNAVAILABLE", "/v1/me");
      return problem(
        requestId,
        503,
        "service_unavailable",
        "Identity metadata is unavailable.",
        true,
      );
    }
  });

  for (const action of [
    { method: "GET", path: "/v1/me/profile" },
    { method: "PUT", path: "/v1/me/signup-source" },
  ] as const)
    app.on(action.method, action.path, async (context) => {
      const requestId = requestIdFor(context, createRequestId);
      const baseLimit = await enforceBaseLimits(
        dependencies,
        requestId,
        context.req.header("cf-connecting-ip"),
      );
      if (baseLimit) return baseLimit;
      const auth = await authenticate(context, dependencies);
      if (auth.outcome !== "authenticated")
        return problem(
          requestId,
          auth.outcome === "invalid" ? 401 : 503,
          auth.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
          "Authentication is required.",
        );
      const principal = auth.authentication.principal;
      const limit = await enforcePrincipalLimits(dependencies, requestId, principal);
      if (limit) return limit;
      if (
        !principal.actorId.startsWith("user:user_") ||
        !principal.credentialId.startsWith("workos_session:session_")
      )
        return problem(requestId, 403, "forbidden", "Use an interactive user session.");
      if (new URL(context.req.url).search)
        return problem(requestId, 400, "invalid_request", "No query parameters are accepted.");
      if (!dependencies.accountProfile)
        return problem(requestId, 503, "service_unavailable", "Profile is unavailable.");
      try {
        if (action.method === "GET")
          return json(await dependencies.accountProfile.read(principal), 200, requestId);
        const parsed = await parseJsonObject(context);
        if (parsed.outcome === "error")
          return problem(requestId, parsed.status, parsed.code, parsed.detail);
        if (
          !(
            hasExactKeys(parsed.value, ["source"]) || hasExactKeys(parsed.value, ["source", "utm"])
          ) ||
          !(
            parsed.value["source"] === null ||
            (typeof parsed.value["source"] === "string" &&
              /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(parsed.value["source"]))
          ) ||
          ("utm" in parsed.value && !isSignupUtm(parsed.value["utm"]))
        )
          return problem(requestId, 400, "invalid_request", "Supply one bounded source or null.");
        const checked = await auth.authentication.revalidate();
        if (checked.outcome !== "authenticated")
          return problem(requestId, 401, "unauthenticated", "Authentication is required.");
        return json(
          await dependencies.accountProfile.recordSource(
            checked.authentication.principal,
            parsed.value["source"] as string | null,
            parsed.value["utm"] as Record<string, string> | undefined,
          ),
          200,
          requestId,
        );
      } catch {
        return problem(
          requestId,
          503,
          "service_unavailable",
          "Profile is temporarily unavailable.",
          true,
        );
      }
    });

  const sessionRevocation = dependencies.sessionRevocation;
  if (sessionRevocation)
    app.post("/v1/session:revoke", async (context) => {
      const requestId = requestIdFor(context, createRequestId);
      const baseLimit = await enforceBaseLimits(
        dependencies,
        requestId,
        context.req.header("cf-connecting-ip"),
      );
      if (baseLimit) return baseLimit;
      const authenticated = await authenticate(context, dependencies);
      if (authenticated.outcome !== "authenticated")
        return problem(
          requestId,
          authenticated.outcome === "invalid" ? 401 : 503,
          authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
          "A current user session is required.",
          authenticated.outcome === "unavailable",
        );
      const principal = authenticated.authentication.principal;
      const limit = await enforcePrincipalLimits(dependencies, requestId, principal);
      if (limit) return limit;
      if (
        principal.authorizationPrincipal.kind !== "user" ||
        !principal.credentialId.startsWith("workos_session:session_")
      )
        return problem(
          requestId,
          403,
          "forbidden",
          "Only the current user session can be revoked.",
        );
      const key = context.req.header("idempotency-key");
      const body = await readBoundedBody(context.req.raw, 0);
      if (
        validateCallerRequestId(context) !== null ||
        new URL(context.req.url).search !== "" ||
        !key ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(key) ||
        body.outcome !== "ok" ||
        body.text !== ""
      )
        return problem(
          requestId,
          400,
          "invalid_request",
          "Use an empty body and a valid Idempotency-Key; the target is your current session.",
        );
      try {
        await sessionRevocation.revoke(principal);
        return json({ revoked: true }, 200, requestId);
      } catch {
        reportFailure(
          dependencies,
          requestId,
          "SESSION_REVOCATION_UNAVAILABLE",
          "/v1/session:revoke",
        );
        return problem(
          requestId,
          503,
          "service_unavailable",
          "Session revocation could not be confirmed.",
          true,
        );
      }
    });

  const organizationOnboarding = dependencies.organizationOnboarding;
  if (organizationOnboarding)
    app.post("/v1/organizations", async (context) => {
      const requestId = requestIdFor(context, createRequestId);
      const baseLimit = await enforceBaseLimits(
        dependencies,
        requestId,
        context.req.header("cf-connecting-ip"),
      );
      if (baseLimit) return baseLimit;
      const authenticated = await authenticate(context, dependencies);
      if (authenticated.outcome !== "authenticated")
        return problem(
          requestId,
          authenticated.outcome === "invalid" ? 401 : 503,
          authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
          "Authentication is required.",
          authenticated.outcome === "unavailable",
        );
      const principal = authenticated.authentication.principal;
      const limit = await enforcePrincipalLimits(dependencies, requestId, principal);
      if (limit) return limit;
      if (
        principal.authorizationPrincipal.kind !== "user" ||
        !principal.credentialId.startsWith("workos_session:")
      )
        return problem(
          requestId,
          403,
          "forbidden",
          "A signed-in user is required to create an organization.",
        );
      const idempotencyKey = context.req.header("idempotency-key");
      if (
        validateCallerRequestId(context) !== null ||
        !idempotencyKey ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(idempotencyKey) ||
        !/^application\/json(?:\s*;|$)/iu.test(context.req.header("content-type") ?? "") ||
        ![undefined, "identity"].includes(context.req.header("content-encoding"))
      )
        return problem(
          requestId,
          400,
          "invalid_request",
          "JSON and a valid Idempotency-Key are required.",
        );
      const body = await readBoundedBody(context.req.raw, 2048);
      if (body.outcome !== "ok")
        return problem(
          requestId,
          body.outcome === "too_large" ? 413 : 400,
          body.outcome === "too_large" ? "payload_too_large" : "invalid_request",
          "Organization request body is invalid.",
        );
      let name: string;
      let signupSource: string;
      try {
        assertIJsonText(body.text);
        const value: unknown = JSON.parse(body.text);
        assertIJsonValue(value);
        if (
          !isRecord(value) ||
          !(hasExactKeys(value, ["name", "signup_source"]) || hasExactKeys(value, ["name"])) ||
          (value["signup_source"] !== undefined &&
            (typeof value["signup_source"] !== "string" ||
              !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value["signup_source"]))) ||
          typeof value["name"] !== "string" ||
          value["name"] !== value["name"].trim() ||
          value["name"].length < 1 ||
          value["name"].length > 128 ||
          containsControlCharacter(value["name"])
        )
          throw new Error("Invalid name");
        name = value["name"];
        // Signup is open; a customer who arrived without a link is attributed as direct.
        signupSource =
          typeof value["signup_source"] === "string" ? value["signup_source"] : "direct";
      } catch {
        return problem(
          requestId,
          400,
          "invalid_request",
          "Supply an organization name (1–128 characters); signup_source is optional attribution from a link's r parameter.",
        );
      }
      const revalidated = await authenticated.authentication.revalidate();
      if (revalidated.outcome !== "authenticated")
        return revalidated.outcome === "invalid"
          ? problem(requestId, 401, "unauthenticated", "Authentication is required.")
          : problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
      try {
        const result = await organizationOnboarding.create({
          principal: revalidated.authentication.principal,
          name,
          signupSource,
          idempotencyKey,
        });
        return json(result, 201, requestId);
      } catch (error) {
        const code =
          error instanceof OrganizationCreationError ? error.code : "service_unavailable";
        const status =
          code === "forbidden"
            ? 403
            : code === "idempotency_key_reused"
              ? 409
              : code === "invalid_request"
                ? 400
                : 503;
        return problem(
          requestId,
          status,
          code,
          code === "service_unavailable"
            ? "Organization creation is incomplete. Repeat the same request with the same Idempotency-Key to observe its result."
            : code === "forbidden"
              ? "Organization creation requires a valid user session, not an API key. Existing signup attribution cannot be replaced, a deactivated signup source is refused, and one user can start at most five new organizations per hour."
              : "Organization creation was rejected.",
          code === "service_unavailable",
        );
      }
    });

  for (const route of [
    { method: "POST", suffix: "checkouts", action: "create" },
    { method: "GET", suffix: "checkouts/:checkout_id", action: "status" },
    { method: "POST", suffix: "portal", action: "portal" },
    { method: "GET", suffix: "recharge", action: "recharge-read" },
    { method: "PUT", suffix: "recharge", action: "recharge-write" },
  ] as const)
    app.on(
      route.method,
      `/v1/organizations/:organization_id/billing/${route.suffix}`,
      async (context) => {
        const requestId = requestIdFor(context, createRequestId);
        if (!dependencies.billing)
          return problem(requestId, 404, "resource_not_found", "Resource not found.");
        const baseLimit = await enforceBaseLimits(
          dependencies,
          requestId,
          context.req.header("cf-connecting-ip"),
        );
        if (baseLimit) return baseLimit;
        const authenticated = await authenticate(context, dependencies);
        if (authenticated.outcome !== "authenticated")
          return problem(
            requestId,
            authenticated.outcome === "invalid" ? 401 : 503,
            authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
            "Authentication is required.",
          );
        const { principal } = authenticated.authentication;
        const principalLimit = await enforcePrincipalLimits(dependencies, requestId, principal);
        if (principalLimit) return principalLimit;
        const organizationId = parseRouteUlid(context.req.param("organization_id"));
        if (!organizationId || new URL(context.req.url).search || validateCallerRequestId(context))
          return problem(
            requestId,
            400,
            "invalid_request",
            "Supply an organization ID without query parameters.",
          );
        if (!principal.organizationIds.includes(organizationId))
          return problem(requestId, 404, "resource_not_found", "Resource not found.");
        const orgLimit = await enforceLimit(
          dependencies,
          requestId,
          "organization",
          organizationId,
        );
        if (orgLimit) return orgLimit;
        const allowed = await authorize(
          dependencies,
          principal,
          { kind: "organization", organizationId },
          "billing:manage",
        );
        if (allowed !== "allow")
          return problem(
            requestId,
            allowed === "deny" ? 404 : 503,
            allowed === "deny" ? "resource_not_found" : "service_unavailable",
            "Resource unavailable.",
          );
        try {
          if (route.action === "recharge-read")
            return json(await dependencies.billing.getRecharge({ organizationId }), 200, requestId);
          if (route.action === "status") {
            const checkoutId = parseRouteUlid(context.req.param("checkout_id"));
            if (!checkoutId)
              return problem(requestId, 400, "invalid_request", "Supply the original checkout ID.");
            return json(
              await dependencies.billing.getCheckout({ organizationId, checkoutId }),
              200,
              requestId,
            );
          }
          const body = await parseJsonObject(context);
          if (body.outcome === "error")
            return problem(requestId, body.status, body.code, body.detail);
          if (route.action === "recharge-write") {
            const v = body.value,
              key = context.req.header("idempotency-key");
            if (
              !key ||
              !/^[A-Za-z0-9._:-]{1,128}$/u.test(key) ||
              Object.keys(v).sort().join(",") !== "consent,enabled,monthly_limit_minor,revision" ||
              typeof v["enabled"] !== "boolean" ||
              !Number.isSafeInteger(v["monthly_limit_minor"]) ||
              Number(v["monthly_limit_minor"]) < 1000 ||
              Number(v["monthly_limit_minor"]) > 100000 ||
              !Number.isSafeInteger(v["revision"]) ||
              Number(v["revision"]) < 0 ||
              (v["enabled"] ? v["consent"] !== "off_session_v1" : v["consent"] !== null)
            )
              return problem(
                requestId,
                400,
                "invalid_request",
                "Supply enabled, current revision, USD monthly_limit_minor (1000–100000), consent off_session_v1 when enabling or null when disabling, and the original Idempotency-Key. Enable only with explicit Owner approval for recurring off-session payments.",
              );
            return json(
              await dependencies.billing.configureRecharge({
                organizationId,
                actorId: principal.actorId,
                idempotencyKey: key,
                enabled: v["enabled"],
                monthlyLimitMinor: Number(v["monthly_limit_minor"]),
                revision: Number(v["revision"]),
                consent: v["consent"] as string | null,
              }),
              200,
              requestId,
            );
          }
          if (route.action === "portal") {
            if (Object.keys(body.value).length)
              return problem(
                requestId,
                400,
                "invalid_request",
                "Portal accepts an empty JSON object; return URL and customer are server-selected.",
              );
            return json(
              await dependencies.billing.createPortal({ organizationId }),
              200,
              requestId,
            );
          }
          const key = context.req.header("idempotency-key"),
            v = body.value;
          if (
            !key ||
            !/^[A-Za-z0-9._:-]{1,128}$/u.test(key) ||
            Object.keys(v).sort().join(",") !== "offer,packs" ||
            (v["offer"] !== "topup" && v["offer"] !== "paid") ||
            typeof v["packs"] !== "number" ||
            !Number.isInteger(v["packs"]) ||
            v["packs"] < 1 ||
            v["packs"] > 100 ||
            (v["offer"] === "paid" && v["packs"] !== 1)
          )
            return problem(
              requestId,
              400,
              "invalid_request",
              "Supply offer topup/paid, packs 1–100 (Paid: 1), and the original Idempotency-Key.",
            );
          return json(
            await dependencies.billing.createCheckout({
              organizationId,
              actorId: principal.actorId,
              idempotencyKey: key,
              offer: v["offer"],
              packs: v["packs"],
            }),
            201,
            requestId,
          );
        } catch (error) {
          const status = error instanceof BillingServiceError ? error.status : 503;
          if (error instanceof BillingServiceError && error.code === "paid_plan_required")
            return problem(
              requestId,
              402,
              "paid_plan_required",
              "Top-ups and automatic recharge require an active Paid plan. Start or renew Paid before adding credits.",
            );
          return problem(
            requestId,
            status,
            status === 404
              ? "resource_not_found"
              : status === 409
                ? route.action.startsWith("recharge-")
                  ? "billing_recharge_conflict"
                  : "billing_purchase_conflict"
                : status === 400
                  ? "invalid_request"
                  : "service_unavailable",
            route.action.startsWith("recharge-")
              ? "Read the current auto-recharge settings. Preserve the original key and payload after uncertainty; use the latest revision only for an explicitly requested change."
              : status === 409
                ? "Billing purchase conflicts with current state. Resume the original checkout or open the billing portal; do not create a second purchase after uncertainty."
                : status === 503
                  ? "Billing is temporarily unavailable. Retry the original checkout/key to observe its outcome."
                  : "Billing request unavailable.",
            status === 503,
          );
        }
      },
    );

  for (const report of ["credits", "credit-usage", "account"] as const)
    app.get(`/v1/organizations/:organization_id/${report}`, async (context) => {
      const requestId = requestIdFor(context, createRequestId);
      const limit = await enforceBaseLimits(
        dependencies,
        requestId,
        context.req.header("cf-connecting-ip"),
      );
      if (limit) return limit;
      const authenticated = await authenticate(context, dependencies);
      if (authenticated.outcome !== "authenticated")
        return problem(
          requestId,
          authenticated.outcome === "invalid" ? 401 : 503,
          authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
          "Authentication is required.",
        );
      const { principal } = authenticated.authentication;
      const principalLimit = await enforcePrincipalLimits(dependencies, requestId, principal);
      if (principalLimit) return principalLimit;
      const requestIdError = validateCallerRequestId(context);
      if (requestIdError !== null)
        return problem(requestId, 400, "invalid_request", requestIdError);
      const organizationId = parseRouteUlid(context.req.param("organization_id"));
      const query = new URL(context.req.url).searchParams;
      if (!organizationId || query.size !== 0)
        return problem(
          requestId,
          400,
          "invalid_request",
          "Supply one organization ID without query parameters.",
        );
      if (!principal.organizationIds.includes(organizationId))
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      const orgLimit = await enforceLimit(dependencies, requestId, "organization", organizationId);
      if (orgLimit) return orgLimit;
      const allowed = await authorize(
        dependencies,
        principal,
        { kind: "organization", organizationId },
        "credits:read",
      );
      if (allowed !== "allow")
        return problem(
          requestId,
          allowed === "deny" ? 404 : 503,
          allowed === "deny" ? "resource_not_found" : "service_unavailable",
          "Resource unavailable.",
        );
      try {
        if (!dependencies.credits) throw new Error("Credit storage unavailable");
        if (report === "credit-usage") {
          const body = await dependencies.credits.readUsage(organizationId);
          assertOrganizationCreditUsage(body);
          if (body.organization_id !== organizationId) throw new Error("Credit scope mismatch");
          return json(body, 200, requestId);
        }
        if (report === "account") {
          const account = await dependencies.credits.readAccount(organizationId);
          assertOrganizationAccount(account);
          return json(account, 200, requestId);
        }
        const body = await dependencies.credits.readOrganization(organizationId);
        return json(validateCreditBalance(body), 200, requestId);
      } catch {
        return problem(
          requestId,
          503,
          "service_unavailable",
          "Credit report is temporarily unavailable.",
          true,
        );
      }
    });

  // Every member may share the workspace's referral link; its rewards go to the workspace.
  app.get("/v1/organizations/:organization_id/referral", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const limit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (limit) return limit;
    const authenticated = await authenticate(context, dependencies);
    if (authenticated.outcome !== "authenticated")
      return problem(
        requestId,
        authenticated.outcome === "invalid" ? 401 : 503,
        authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
        "Authentication is required.",
      );
    const { principal } = authenticated.authentication;
    const principalLimit = await enforcePrincipalLimits(dependencies, requestId, principal);
    if (principalLimit) return principalLimit;
    const requestIdError = validateCallerRequestId(context);
    if (requestIdError !== null) return problem(requestId, 400, "invalid_request", requestIdError);
    const organizationId = parseRouteUlid(context.req.param("organization_id"));
    if (!organizationId || new URL(context.req.url).search)
      return problem(
        requestId,
        400,
        "invalid_request",
        "Supply one organization ID without query parameters.",
      );
    if (!principal.organizationIds.includes(organizationId))
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    const allowed = await authorize(
      dependencies,
      principal,
      { kind: "organization", organizationId },
      "projects:read",
    );
    if (allowed !== "allow")
      return problem(
        requestId,
        allowed === "deny" ? 404 : 503,
        allowed === "deny" ? "resource_not_found" : "service_unavailable",
        "Resource unavailable.",
      );
    return json(
      {
        organization_id: organizationId,
        referral_url: `https://ohmyho.st/?r=${workspaceReferralSource(organizationId)}`,
      },
      200,
      requestId,
    );
  });

  app.post("/v1/projects", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    if (
      context.req.header("authorization") === undefined &&
      context.req.header("cookie") !== undefined
    ) {
      return problem(
        requestId,
        403,
        "forbidden",
        "Cookie authentication is not accepted by the public API.",
      );
    }
    const authenticationResult = await authenticate(context, dependencies);
    if (authenticationResult.outcome === "invalid") {
      return problem(requestId, 401, "unauthenticated", "Authentication is required.");
    }
    if (authenticationResult.outcome === "unavailable") {
      reportFailure(dependencies, requestId, "AUTHENTICATION_UNAVAILABLE", "/v1/projects");
      return problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
    }
    const authentication = authenticationResult.authentication;
    const principalLimit = await enforcePrincipalLimits(
      dependencies,
      requestId,
      authentication.principal,
    );
    if (principalLimit !== null) return principalLimit;
    const requestIdError = validateCallerRequestId(context);
    if (requestIdError !== null) return problem(requestId, 400, "invalid_request", requestIdError);
    const idempotencyKey = context.req.header("idempotency-key");
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      return problem(requestId, 400, "invalid_request", "Idempotency-Key is required.");
    }
    if (
      idempotencyKey !== idempotencyKey.trim() ||
      idempotencyKey.length > 128 ||
      containsControlCharacter(idempotencyKey)
    ) {
      return problem(requestId, 400, "invalid_request", "Idempotency-Key is invalid.");
    }

    const parsed = await parseCreateProjectRequest(context);
    if (parsed.outcome === "error") {
      return problem(requestId, parsed.status, parsed.code, parsed.detail);
    }
    if (
      parsed.source !== undefined &&
      dependencies.managedSources === undefined &&
      dependencies.managedProjectCreation !== true
    )
      return problem(
        requestId,
        503,
        "service_unavailable",
        "Managed Git source initialization is unavailable.",
        true,
      );
    const authorization = await authorize(
      dependencies,
      authentication.principal,
      { kind: "organization", organizationId: parsed.organizationId },
      "projects:create",
    );
    if (authorization === "unavailable") {
      reportFailure(dependencies, requestId, "AUTHORIZATION_UNAVAILABLE", "/v1/projects");
      return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
    }
    if (
      authorization === "deny" ||
      !authentication.principal.organizationIds.includes(parsed.organizationId)
    ) {
      return problem(requestId, 403, "forbidden", "The requested action is not allowed.");
    }
    const organizationLimit = await enforceLimit(
      dependencies,
      requestId,
      "organization",
      parsed.organizationId,
    );
    if (organizationLimit !== null) return organizationLimit;

    try {
      const serializeCanonicalJson = canonicalize as unknown as (
        input: unknown,
      ) => string | undefined;
      const canonicalRequest = serializeCanonicalJson({
        name: parsed.name,
        organization_id: parsed.organizationId,
        ...(parsed.source === undefined ? {} : { source: parsed.source }),
        ...(parsed.dataMode === "isolated" ? { data_mode: "isolated" } : {}),
        ...(parsed.region === DEFAULT_HOSTING_REGION ? {} : { region: parsed.region }),
        ...(parsed.devAccessMode === "protected" ? {} : { dev_access_mode: parsed.devAccessMode }),
        ...(parsed.includeDevelopmentEnvironment ? {} : { include_development_environment: false }),
      });
      if (canonicalRequest === undefined) throw new TypeError("Request cannot be canonicalized");
      const digest = createHash("sha256")
        .update(
          `v1\nPOST\n/v1/projects\n${parsed.organizationId}\n${authentication.principal.actorId}\n${canonicalRequest}`,
        )
        .digest();
      const result = await dependencies.persistence.createProject({
        organizationId: parsed.organizationId,
        name: parsed.name,
        dataMode: parsed.dataMode,
        devAccessMode: parsed.devAccessMode,
        includeDevelopmentEnvironment: parsed.includeDevelopmentEnvironment,
        region: parsed.region,
        principalId: authentication.principal.actorId,
        idempotencyKey,
        canonicalRequestDigest: digest,
        requestId,
        ...(parsed.source === undefined ? {} : { source: parsed.source }),
        ...(authentication.principal.connectUser === undefined
          ? {}
          : {
              sourceDelegation: {
                clientId: authentication.principal.connectUser.clientId,
                action: "projects:create",
                authorizationRestriction: intersectAuthorizationRestriction(
                  authentication.principal.authorizationRestriction,
                  authentication.principal.authorizationScopeConstraint,
                ),
                consentHash: createHash("sha256")
                  .update(authentication.principal.connectUser.consentId)
                  .digest("hex"),
              },
            }),
      });
      const storedBody = storedProjectCreateBody(result.body);
      if (result.location !== `/v1/operations/${String(storedBody["id"])}`) {
        throw new TypeError("Stored operation Location is invalid");
      }
      return setUsageResponse(
        json(storedBody, result.status, requestId, {
          Location: result.location,
        }),
        {
          operationId: validUsageOperationId(storedBody["id"]),
          operationStatus: usageState(storedBody["state"]),
        },
      );
    } catch (error) {
      if (error instanceof ManagedSourceInitializationError)
        return problem(
          requestId,
          403,
          "forbidden",
          "The project's original creation permission is no longer current.",
        );
      if (error instanceof IdempotencyKeyReusedError) {
        return problem(
          requestId,
          409,
          "idempotency_key_reused",
          "The idempotency key was already used for another request.",
        );
      }
      if (error instanceof ProjectHandleAllocationExhaustedError) {
        return problem(
          requestId,
          503,
          "project_handle_unavailable",
          "A project handle could not be allocated safely.",
          true,
        );
      }
      if (error instanceof ProjectIdentityAllocationExhaustedError) {
        return problem(
          requestId,
          503,
          "project_identity_unavailable",
          "Project identity allocation is temporarily unavailable.",
          true,
        );
      }
      reportFailure(dependencies, requestId, "PROJECT_CREATE_FAILED", "/v1/projects");
      return problem(
        requestId,
        503,
        "service_unavailable",
        "Project creation is temporarily unavailable.",
        true,
      );
    }
  });

  app.post("/v1/projects/:project_id/environments/dev", (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "operation",
      mutation: true,
      body: async (requestContext, requestId) => {
        const parsed = await parseJsonObject(requestContext);
        if (parsed.outcome === "error")
          return {
            outcome: "error",
            response: problem(requestId, parsed.status, parsed.code, parsed.detail),
          };
        if (Object.keys(parsed.value).length !== 0)
          return {
            outcome: "error",
            response: problem(requestId, 400, "invalid_request", "Request fields are invalid."),
          };
        return { outcome: "ok", value: undefined, canonicalValue: {} };
      },
      invoke: async (prepared) => {
        if (dependencies.persistence.addDevelopmentEnvironment === undefined)
          throw new Error("Development environment creation is unavailable");
        try {
          const { delegation, ...scope } = prepared.context;
          const result = await dependencies.persistence.addDevelopmentEnvironment({
            ...scope,
            ...prepared.mutation,
            ...(delegation === undefined
              ? {}
              : {
                  delegation: { ...delegation, action: "projects:write" as const },
                }),
          });
          return { status: result.status, body: result.body, location: result.location };
        } catch (error) {
          if (
            error instanceof Error &&
            ["scope_inactive", "operation_authorization_changed"].includes(error.message)
          )
            return null;
          if (error instanceof Error && error.message === "development_environment_exists")
            throw new ProductSurfaceConflictError("development_environment_exists");
          throw error;
        }
      },
    }),
  );

  app.get("/v1/projects", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    const authenticationResult = await authenticate(context, dependencies);
    if (authenticationResult.outcome === "invalid") {
      return problem(requestId, 401, "unauthenticated", "Authentication is required.");
    }
    if (authenticationResult.outcome === "unavailable") {
      reportFailure(dependencies, requestId, "AUTHENTICATION_UNAVAILABLE", "/v1/projects");
      return problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
    }
    const principal = authenticationResult.authentication.principal;
    const principalLimit = await enforcePrincipalLimits(dependencies, requestId, principal);
    if (principalLimit !== null) return principalLimit;
    const requestIdError = validateCallerRequestId(context);
    if (requestIdError !== null) return problem(requestId, 400, "invalid_request", requestIdError);
    const query = parseProjectListQuery(context, requestId);
    if (query.outcome === "error") return query.response;
    // A session that selected no workspace can see nothing. An empty page would read like an
    // empty account, so name the one state the caller has to leave.
    if (principal.organizationIds.length === 0)
      return problem(
        requestId,
        409,
        "organization_required",
        "This session has selected no workspace, so it can list nothing. Select one with 'ohmyhost organization list --json' and 'ohmyhost organization use --organization ULID --json', or create the first one.",
      );
    const authorizedOrganizationIds: Ulid[] = [];
    for (const organizationId of principal.organizationIds) {
      const organizationLimit = await enforceLimit(
        dependencies,
        requestId,
        "organization",
        organizationId,
      );
      if (organizationLimit !== null) return organizationLimit;
      const decision = await authorize(
        dependencies,
        principal,
        { kind: "organization", organizationId },
        "projects:read",
      );
      if (decision === "unavailable") {
        reportFailure(dependencies, requestId, "AUTHORIZATION_UNAVAILABLE", "/v1/projects");
        return problem(
          requestId,
          503,
          "service_unavailable",
          "Authorization is unavailable.",
          true,
        );
      }
      if (decision === "allow") authorizedOrganizationIds.push(organizationId);
    }
    if (principal.organizationIds.length > 0 && authorizedOrganizationIds.length === 0) {
      return problem(requestId, 403, "forbidden", "The requested action is not allowed.");
    }
    try {
      const projectIds = principal.authorizationRestriction?.projectIds;
      const page = await dependencies.persistence.listProjects({
        organizationIds: authorizedOrganizationIds,
        ...(projectIds === undefined ? {} : { projectIds }),
        ...(query.value.cursor === undefined ? {} : { cursor: parseUlid(query.value.cursor) }),
        limit: query.value.limit,
      });
      return json(
        {
          items: page.projects.map(projectBody),
          ...(page.nextCursor === null ? {} : { next_cursor: page.nextCursor }),
        },
        200,
        requestId,
      );
    } catch (error) {
      if (error instanceof InvalidProjectCursorError) {
        return problem(requestId, 400, "invalid_request", "Project cursor is invalid.");
      }
      reportFailure(dependencies, requestId, "PROJECT_LIST_FAILED", "/v1/projects");
      return problem(
        requestId,
        503,
        "service_unavailable",
        "Project discovery is unavailable.",
        true,
      );
    }
  });

  for (const method of ["GET", "POST", "DELETE"] as const)
    app.on(
      method,
      method === "POST"
        ? "/v1/organizations/:organization_id/github:connect"
        : "/v1/organizations/:organization_id/github",
      async (context) => {
        const requestId = requestIdFor(context, createRequestId);
        const github = dependencies.githubOrganizationConnection;
        if (!github)
          return problem(
            requestId,
            503,
            "service_unavailable",
            "GitHub connection is unavailable.",
            true,
          );
        const limited = await enforceBaseLimits(
          dependencies,
          requestId,
          context.req.header("cf-connecting-ip"),
        );
        if (limited) return limited;
        const authenticated = await authenticate(context, dependencies);
        if (authenticated.outcome !== "authenticated")
          return problem(
            requestId,
            authenticated.outcome === "invalid" ? 401 : 503,
            authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
            "Authentication is required.",
          );
        const principal = authenticated.authentication.principal;
        const principalLimit = await enforcePrincipalLimits(dependencies, requestId, principal);
        if (principalLimit) return principalLimit;
        const organizationId = parseRouteUlid(context.req.param("organization_id"));
        if (!organizationId || new URL(context.req.url).search || validateCallerRequestId(context))
          return problem(
            requestId,
            400,
            "invalid_request",
            "Supply an organization ID without query parameters.",
          );
        if (!principal.organizationIds.includes(organizationId))
          return problem(requestId, 404, "resource_not_found", "Resource not found.");
        const orgLimit = await enforceLimit(
          dependencies,
          requestId,
          "organization",
          organizationId,
        );
        if (orgLimit) return orgLimit;
        const allowed = await authorize(
          dependencies,
          principal,
          { kind: "organization", organizationId },
          method === "GET" ? "sources:read" : "sources:link",
        );
        if (allowed !== "allow")
          return problem(
            requestId,
            allowed === "deny" ? 404 : 503,
            allowed === "deny" ? "resource_not_found" : "service_unavailable",
            "Resource unavailable.",
          );
        try {
          if (method === "GET") return json(await github.status(organizationId), 200, requestId);
          if (method === "DELETE") {
            const current = await authenticated.authentication.revalidate();
            if (current.outcome !== "authenticated")
              return problem(
                requestId,
                current.outcome === "invalid" ? 401 : 503,
                current.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
                "Authentication is required.",
              );
            return json(
              await github.disconnect({
                organizationId,
                principal: current.authentication.principal,
              }),
              200,
              requestId,
            );
          }
          const key = validatedHeader(
            context,
            requestId,
            "idempotency-key",
            "Idempotency-Key",
            1,
            128,
          );
          if (key instanceof Response) return key;
          const body = await parseJsonObject(context);
          if (body.outcome === "error")
            return problem(requestId, body.status, body.code, body.detail);
          if (Object.keys(body.value).length)
            return problem(
              requestId,
              400,
              "invalid_request",
              "GitHub connect accepts an empty JSON object.",
            );
          const current = await authenticated.authentication.revalidate();
          if (current.outcome !== "authenticated")
            return problem(
              requestId,
              current.outcome === "invalid" ? 401 : 503,
              current.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
              "Authentication is required.",
            );
          return json(
            await github.begin({
              organizationId,
              principal: current.authentication.principal,
              idempotencyKey: key,
            }),
            201,
            requestId,
          );
        } catch (error) {
          if (error instanceof IdempotencyKeyReusedError)
            return problem(
              requestId,
              409,
              "idempotency_key_reused",
              "Repeat the same GitHub connection request with its original credential and key.",
            );
          if (error instanceof GithubAuthorizationRejectedError)
            return problem(
              requestId,
              403,
              "forbidden",
              "A current workspace owner session or scoped user key is required.",
            );
          if (error instanceof GithubConnectionRequiredError)
            return problem(
              requestId,
              409,
              error.code,
              "The GitHub connection was revoked. Start github connect again with a new key.",
            );
          reportFailure(
            dependencies,
            requestId,
            "GITHUB_CONNECTION_UNAVAILABLE",
            "/v1/organizations/{organization_id}/github",
          );
          return problem(
            requestId,
            503,
            "service_unavailable",
            "GitHub connection is temporarily unavailable.",
            true,
          );
        }
      },
    );

  app.post("/v1/projects/:project_id/source:link", async (context) => {
    return handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "sources:link",
      responseShape: dependencies.githubOrganizationConnection
        ? "operation"
        : "github-authorization",
      mutation: true,
      body: parseLinkSourceBody,
      invoke: async (prepared, body) => {
        if (dependencies.githubOrganizationConnection)
          return dependencies.githubOrganizationConnection.link({
            ...prepared.context,
            ...prepared.mutation,
            repositoryOwner: body.repositoryOwner,
            repositoryName: body.repositoryName,
          });
        if (!dependencies.githubSourceAuthorization)
          throw new Error("GitHub authorization unavailable");
        if (
          (!prepared.principal.session && !prepared.principal.userApiKey) ||
          (prepared.principal.userApiKey &&
            prepared.principal.credentialId !== `user_api_key:${prepared.principal.userApiKey.id}`)
        )
          throw new GithubAuthorizationRejectedError();
        const result = await dependencies.githubSourceAuthorization.begin({
          ...prepared.context,
          ...prepared.mutation,
          repositoryOwner: body.repositoryOwner,
          repositoryName: body.repositoryName,
          ...(prepared.principal.session ? { session: prepared.principal.session } : {}),
          ...(prepared.principal.userApiKey ? { userApiKey: prepared.principal.userApiKey } : {}),
        });
        return { status: 201, body: { ...result } };
      },
    });
  });

  for (const route of [
    { method: "GET", path: "/v1/organizations/:organization_id/connections", kind: "list" },
    {
      method: "GET",
      path: "/v1/organizations/:organization_id/connections/providers",
      kind: "providers",
    },
    {
      method: "GET",
      path: "/v1/organizations/:organization_id/connections/requests/:request_id",
      kind: "status",
    },
    {
      method: "GET",
      path: "/v1/organizations/:organization_id/connections/:grant_id/catalog",
      kind: "catalog",
    },
    {
      method: "POST",
      path: "/v1/organizations/:organization_id/connections/:grant_id/imports",
      kind: "import",
    },
    {
      method: "POST",
      path: "/v1/organizations/:organization_id/connections/action-bindings",
      kind: "bindAction",
    },
    {
      method: "DELETE",
      path: "/v1/organizations/:organization_id/connections/:grant_id",
      kind: "disconnect",
    },
  ] as const)
    app.on(route.method, route.path, async (context) => {
      const requestId = requestIdFor(context, createRequestId);
      const baseLimit = await enforceBaseLimits(
        dependencies,
        requestId,
        context.req.header("cf-connecting-ip"),
      );
      if (baseLimit) return baseLimit;
      const authenticated = await authenticate(context, dependencies);
      if (authenticated.outcome !== "authenticated")
        return problem(
          requestId,
          authenticated.outcome === "invalid" ? 401 : 503,
          authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
          "Authentication is required.",
        );
      const principalLimit = await enforcePrincipalLimits(
        dependencies,
        requestId,
        authenticated.authentication.principal,
      );
      if (principalLimit) return principalLimit;
      const org = parseRouteUlid(context.req.param("organization_id"));
      if (!org || validateCallerRequestId(context))
        return problem(requestId, 400, "invalid_request", "Supply an organization.");
      const params = new URL(context.req.url).searchParams;
      const workspaceOnly =
        route.kind === "list" && params.size === 1 && params.get("scope") === "workspace";
      if (route.kind !== "catalog" && params.size !== 0 && !workspaceOnly)
        return problem(requestId, 400, "invalid_request", "Unexpected query parameters.");
      const fresh = await authenticated.authentication.revalidate();
      if (fresh.outcome !== "authenticated")
        return problem(
          requestId,
          fresh.outcome === "invalid" ? 401 : 503,
          fresh.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
          "Authentication is required.",
        );
      try {
        const principal = await integrationSessionMemberships(
          fresh.authentication.principal,
          dependencies.accountProfile,
        );
        if (!principal.organizationIds.includes(org))
          return problem(requestId, 404, "resource_not_found", "Resource not found.");
        const limit = await enforceLimit(dependencies, requestId, "organization", org);
        if (limit) return limit;
        const action =
          route.kind === "disconnect" || route.kind === "import" || route.kind === "bindAction"
            ? "integrations:manage"
            : "integrations:read";
        const allowed = await authorize(
          dependencies,
          principal,
          { kind: "organization", organizationId: org },
          action,
        );
        if (allowed !== "allow")
          return problem(
            requestId,
            allowed === "deny" ? 404 : 503,
            allowed === "deny" ? "resource_not_found" : "service_unavailable",
            "Resource unavailable.",
          );
        const port = dependencies.integrations;
        if (!port)
          return problem(
            requestId,
            503,
            "service_unavailable",
            "Connections are unavailable.",
            true,
          );
        if (route.kind === "providers") {
          const availability = await port.availability();
          return json(
            {
              providers: [
                { provider: "make", status: availability.available ? "available" : "unavailable" },
              ],
              catalog_available: availability.catalogAvailable ?? false,
            },
            200,
            requestId,
          );
        }
        if (route.kind === "list") {
          if (!port.list) throw Error();
          return json(
            await port.list({
              organizationId: org,
              principal,
              ...(workspaceOnly ? { workspaceOnly } : {}),
            }),
            200,
            requestId,
          );
        }
        if (route.kind === "status") {
          const result = await port.status({
            organizationId: org,
            requestId: context.req.param("request_id") ?? "",
            principal,
          });
          return result
            ? json(result, 200, requestId)
            : problem(requestId, 404, "resource_not_found", "Resource not found.");
        }
        if (route.kind === "bindAction") {
          const key = context.req.header("idempotency-key");
          if (!key || !/^[A-Za-z0-9._:-]{1,128}$/u.test(key))
            return problem(requestId, 400, "invalid_request", "Supply an Idempotency-Key.");
          const body = await parseJsonObject(context);
          if (body.outcome !== "ok") return problem(requestId, body.status, body.code, body.detail);
          const value = body.value;
          const projectId =
            typeof value["project_id"] === "string" ? parseRouteUlid(value["project_id"]) : null;
          const environmentId =
            typeof value["environment_id"] === "string"
              ? parseRouteUlid(value["environment_id"])
              : null;
          const importId =
            typeof value["import_id"] === "string" ? parseRouteUlid(value["import_id"]) : null;
          const action = parseMakeAction(value["action"]);
          if (
            Object.keys(value).length !== 4 ||
            !projectId ||
            !environmentId ||
            !importId ||
            !action
          )
            return problem(
              requestId,
              400,
              "invalid_request",
              "Supply a Make action and its project import.",
            );
          const projectAllowed = await authorize(
            dependencies,
            principal,
            { kind: "project", organizationId: org, projectId, environmentId },
            "integrations:manage",
          );
          if (projectAllowed !== "allow")
            return problem(
              requestId,
              projectAllowed === "deny" ? 404 : 503,
              projectAllowed === "deny" ? "resource_not_found" : "service_unavailable",
              "Resource unavailable.",
            );
          if (!port.bindMakeAction) throw Error();
          const binding = await port.bindMakeAction({
            organizationId: org,
            principal,
            projectId,
            environmentId,
            importId,
            action,
            idempotencyKey: key,
          });
          return binding
            ? json(binding, 201, requestId, { "cache-control": "no-store" })
            : problem(requestId, 404, "resource_not_found", "Resource unavailable.");
        }
        const grantId = parseRouteUlid(context.req.param("grant_id"));
        if (!grantId) return problem(requestId, 404, "resource_not_found", "Resource not found.");
        if (route.kind === "disconnect") {
          const key = context.req.header("idempotency-key"),
            body = await readBoundedBody(context.req.raw, 0);
          if (
            !key ||
            !/^[A-Za-z0-9._:-]{1,128}$/u.test(key) ||
            body.outcome !== "ok" ||
            body.text !== ""
          )
            return problem(
              requestId,
              400,
              "invalid_request",
              "Supply an Idempotency-Key and empty body.",
            );
          if (!port.disconnect) throw Error();
          return json(
            await port.disconnect({ organizationId: org, principal, grantId, idempotencyKey: key }),
            200,
            requestId,
          );
        }
        if (route.kind === "import") {
          const key = context.req.header("idempotency-key");
          if (!key || !/^[A-Za-z0-9._:-]{1,128}$/u.test(key))
            return problem(requestId, 400, "invalid_request", "Supply an Idempotency-Key.");
          const body = await parseJsonObject(context);
          if (body.outcome !== "ok") return problem(requestId, body.status, body.code, body.detail);
          const value = body.value;
          const projectId =
            typeof value["project_id"] === "string" ? parseRouteUlid(value["project_id"]) : null;
          const environmentId =
            typeof value["environment_id"] === "string"
              ? parseRouteUlid(value["environment_id"])
              : null;
          const providerOrganizationId = value["provider_organization_id"];
          const teamId = value["team_id"];
          const connectionId = value["connection_id"];
          const selector = (candidate: unknown): candidate is number =>
            typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
          if (
            !projectId ||
            !environmentId ||
            !selector(providerOrganizationId) ||
            !selector(teamId) ||
            !selector(connectionId) ||
            Object.keys(value).length !== 5
          )
            return problem(
              requestId,
              400,
              "invalid_request",
              "Supply a destination and Make connection.",
            );
          const projectAllowed = await authorize(
            dependencies,
            principal,
            { kind: "project", organizationId: org, projectId, environmentId },
            "integrations:manage",
          );
          if (projectAllowed !== "allow")
            return problem(
              requestId,
              projectAllowed === "deny" ? 404 : 503,
              projectAllowed === "deny" ? "resource_not_found" : "service_unavailable",
              "Resource unavailable.",
            );
          if (!port.importConnection) throw Error();
          const imported = await port.importConnection({
            organizationId: org,
            principal,
            grantId,
            projectId,
            environmentId,
            providerOrganizationId,
            teamId,
            connectionId,
            idempotencyKey: key,
          });
          return imported
            ? json(imported, 201, requestId)
            : problem(requestId, 404, "resource_not_found", "Resource unavailable.");
        }
        const keys = ["project_id", "environment_id", "provider_organization_id", "team_id"];
        if ([...params.keys()].some((k) => !keys.includes(k) || params.getAll(k).length !== 1))
          return problem(requestId, 400, "invalid_request", "Invalid discovery scope.");
        const projectId = parseRouteUlid(params.get("project_id") ?? ""),
          environmentId = parseRouteUlid(params.get("environment_id") ?? "");
        const number = (key: string) => {
          const v = params.get(key);
          if (v === null) return undefined;
          if (!/^[1-9][0-9]{0,14}$/u.test(v) || !Number.isSafeInteger(Number(v))) return Number.NaN;
          return Number(v);
        };
        if (
          (params.has("project_id") || params.has("environment_id")) &&
          (!projectId || !environmentId)
        )
          return problem(requestId, 400, "invalid_request", "Supply both project and environment.");
        if (projectId && environmentId) {
          const projectAllowed = await authorize(
            dependencies,
            principal,
            { kind: "project", organizationId: org, projectId, environmentId },
            "integrations:read",
          );
          if (projectAllowed !== "allow")
            return problem(
              requestId,
              projectAllowed === "deny" ? 404 : 503,
              projectAllowed === "deny" ? "resource_not_found" : "service_unavailable",
              "Resource unavailable.",
            );
        }
        if (!port.catalog) throw Error();
        const providerOrganizationId = number("provider_organization_id"),
          teamId = number("team_id");
        if (
          Number.isNaN(providerOrganizationId) ||
          Number.isNaN(teamId) ||
          (teamId !== undefined && providerOrganizationId === undefined)
        )
          return problem(
            requestId,
            400,
            "invalid_request",
            "Supply a valid provider organization and team.",
          );
        return json(
          await port.catalog({
            organizationId: org,
            ...(projectId && environmentId ? { projectId, environmentId } : {}),
            principalId: principal.actorId,
            grantId,
            ...(providerOrganizationId === undefined ? {} : { providerOrganizationId }),
            ...(teamId === undefined ? {} : { teamId }),
          }),
          200,
          requestId,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "integration_idempotency_conflict")
          return problem(
            requestId,
            409,
            "idempotency_key_reused",
            "The idempotency key belongs to a different connection request.",
          );
        return problem(requestId, 503, "service_unavailable", "Connections are unavailable.", true);
      }
    });

  app.post("/v1/organizations/:organization_id/connections/begin", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit) return baseLimit;
    const authenticated = await authenticate(context, dependencies);
    if (authenticated.outcome !== "authenticated")
      return problem(
        requestId,
        authenticated.outcome === "invalid" ? 401 : 503,
        authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
        "Authentication is required.",
      );
    const principalLimit = await enforcePrincipalLimits(
      dependencies,
      requestId,
      authenticated.authentication.principal,
    );
    if (principalLimit) return principalLimit;
    const org = parseRouteUlid(context.req.param("organization_id"));
    const key = context.req.header("idempotency-key");
    if (
      !org ||
      !key ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(key) ||
      new URL(context.req.url).search ||
      validateCallerRequestId(context)
    )
      return problem(
        requestId,
        400,
        "invalid_request",
        "Supply an organization and Idempotency-Key.",
      );
    const body = await parseJsonObject(context);
    if (body.outcome !== "ok") return problem(requestId, body.status, body.code, body.detail);
    const value = body.value;
    const projectId =
      typeof value["project_id"] === "string" ? parseRouteUlid(value["project_id"]) : null;
    const environmentId =
      typeof value["environment_id"] === "string" ? parseRouteUlid(value["environment_id"]) : null;
    if (
      (("project_id" in value || "environment_id" in value) && (!projectId || !environmentId)) ||
      value["provider"] !== "make" ||
      Object.keys(value).some((k) => !["provider", "project_id", "environment_id"].includes(k))
    )
      return problem(
        requestId,
        400,
        "invalid_request",
        "Supply Make as the provider. A legacy request needs both project and environment.",
      );
    const fresh = await authenticated.authentication.revalidate();
    if (fresh.outcome !== "authenticated")
      return problem(
        requestId,
        fresh.outcome === "invalid" ? 401 : 503,
        fresh.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
        "Authentication is required.",
      );
    try {
      const principal = await integrationSessionMemberships(
        fresh.authentication.principal,
        dependencies.accountProfile,
      );
      if (!principal.organizationIds.includes(org))
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      const limit = await enforceLimit(dependencies, requestId, "organization", org);
      if (limit) return limit;
      const allowed = await authorize(
        dependencies,
        principal,
        { kind: "organization", organizationId: org },
        "integrations:manage",
      );
      if (allowed !== "allow")
        return problem(
          requestId,
          allowed === "deny" ? 404 : 503,
          allowed === "deny" ? "resource_not_found" : "service_unavailable",
          "Resource unavailable.",
        );
      if (!dependencies.integrations)
        return problem(requestId, 503, "service_unavailable", "Connections are unavailable.", true);
      const result = await dependencies.integrations.begin({
        organizationId: org,
        ...(projectId && environmentId ? { projectId, environmentId } : {}),
        principal,
        idempotencyKey: key,
      });
      return json(result, 201, requestId);
    } catch (error) {
      if (error instanceof Error && error.message === "integration_idempotency_conflict")
        return problem(
          requestId,
          409,
          "idempotency_key_reused",
          "The idempotency key belongs to a different connection request.",
        );
      return problem(requestId, 503, "service_unavailable", "Connections are unavailable.", true);
    }
  });

  // Workspace MCP connections: the Owner lists the connected clients and disconnects one for this workspace only.
  for (const route of [
    { method: "GET", path: "/v1/organizations/:organization_id/mcp-connections" },
    { method: "DELETE", path: "/v1/organizations/:organization_id/mcp-connections/:connection_id" },
  ] as const)
    app.on(route.method, route.path, async (context) => {
      const requestId = requestIdFor(context, createRequestId);
      const connections = dependencies.organizationMcpConnections;
      if (!connections)
        return problem(
          requestId,
          503,
          "service_unavailable",
          "MCP connections are unavailable.",
          true,
        );
      const baseLimit = await enforceBaseLimits(
        dependencies,
        requestId,
        context.req.header("cf-connecting-ip"),
      );
      if (baseLimit) return baseLimit;
      const authenticated = await authenticate(context, dependencies);
      if (authenticated.outcome !== "authenticated")
        return problem(
          requestId,
          authenticated.outcome === "invalid" ? 401 : 503,
          authenticated.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
          "Authentication is required.",
        );
      const principalLimit = await enforcePrincipalLimits(
        dependencies,
        requestId,
        authenticated.authentication.principal,
      );
      if (principalLimit) return principalLimit;
      const organizationId = parseRouteUlid(context.req.param("organization_id"));
      if (!organizationId || new URL(context.req.url).search || validateCallerRequestId(context))
        return problem(
          requestId,
          400,
          "invalid_request",
          "Supply an organization ID without query parameters.",
        );
      const connectionId =
        route.method === "DELETE" ? context.req.param("connection_id") : undefined;
      if (
        connectionId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(connectionId)
      )
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      const fresh = await authenticated.authentication.revalidate();
      if (fresh.outcome !== "authenticated")
        return problem(
          requestId,
          fresh.outcome === "invalid" ? 401 : 503,
          fresh.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
          "Authentication is required.",
        );
      const principal = fresh.authentication.principal;
      if (!principal.organizationIds.includes(organizationId))
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      const orgLimit = await enforceLimit(dependencies, requestId, "organization", organizationId);
      if (orgLimit) return orgLimit;
      const allowed = await authorize(
        dependencies,
        principal,
        { kind: "organization", organizationId },
        "sources:link",
      );
      if (allowed !== "allow")
        return problem(
          requestId,
          allowed === "deny" ? 404 : 503,
          allowed === "deny" ? "resource_not_found" : "service_unavailable",
          "Resource unavailable.",
        );
      try {
        if (connectionId === undefined)
          return json(await connections.list({ organizationId }), 200, requestId);
        const result = await connections.revoke({ organizationId, connectionId });
        if (result === null)
          return problem(requestId, 404, "resource_not_found", "Resource not found.");
        return json(result, 200, requestId);
      } catch {
        reportFailure(
          dependencies,
          requestId,
          "MCP_CONNECTION_UNAVAILABLE",
          "/v1/organizations/{organization_id}/mcp-connections",
        );
        return problem(
          requestId,
          503,
          "service_unavailable",
          "MCP connections are unavailable.",
          true,
        );
      }
    });

  app.get("/v1/github/oauth/callback", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const limited = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (limited) return limited;
    const params = new URL(context.req.url).searchParams;
    if (!dependencies.githubSourceAuthorization && !dependencies.githubOrganizationConnection)
      return problem(
        requestId,
        503,
        "service_unavailable",
        "GitHub authorization is unavailable.",
        true,
      );
    if (
      [...params.keys()].some(
        (key) =>
          ![
            "state",
            "code",
            "error",
            "error_description",
            "iss",
            "installation_id",
            "setup_action",
          ].includes(key),
      ) ||
      [...new Set(params.keys())].some((key) => params.getAll(key).length !== 1) ||
      (params.has("iss") && params.get("iss") !== "https://github.com/login/oauth") ||
      !params.get("state") ||
      (params.has("installation_id") &&
        !/^[1-9][0-9]{0,15}$/u.test(params.get("installation_id") ?? "")) ||
      (params.has("setup_action") &&
        !["install", "update", "request"].includes(params.get("setup_action") ?? "")) ||
      (params.has("code") && params.has("error")) ||
      (!params.has("code") &&
        !params.has("error") &&
        !(params.has("installation_id") && params.has("setup_action")) &&
        params.get("setup_action") !== "request")
    )
      return problem(
        requestId,
        400,
        "invalid_request",
        "GitHub authorization callback is invalid.",
      );
    const portalSessionPrincipal = dependencies.portalSessionPrincipal;
    if (!portalSessionPrincipal)
      return problem(
        requestId,
        503,
        "service_unavailable",
        "GitHub authorization is unavailable.",
        true,
      );
    // Only a person reaches this route, but the contract owes machine clients their problem
    // document, so a browser is answered with a page and everything else with JSON.
    const browser = (context.req.header("accept") ?? "").includes("text/html");
    const seeOther = (location: string) =>
      new Response(null, {
        status: 303,
        headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    const refused = (
      status: 403 | 409 | 503,
      code: ProblemCode,
      detail: string,
      reason: string,
      retryable = false,
    ) =>
      browser
        ? seeOther(`${GITHUB_AUTHORIZATION_FAILED_PATH}?reason=${reason}`)
        : problem(requestId, status, code, detail, retryable);
    try {
      // Whoever follows the link must be signed in to the portal as the user who started it. Without that
      // session the answer is the one an unknown state gets, and nothing is read, claimed or consumed.
      const signedInPrincipalId = await portalSessionPrincipal(context.req.raw);
      if (signedInPrincipalId === null) throw new GithubConnectionStateUnknownError();
      if (dependencies.githubOrganizationConnection) {
        const completed = await dependencies.githubOrganizationConnection.callback({
          state: params.get("state") ?? "",
          signedInPrincipalId,
          ...(params.has("code") ? { code: params.get("code") ?? "" } : {}),
          ...(params.has("error") ? { denied: true } : {}),
          ...(params.has("installation_id")
            ? { installationId: params.get("installation_id") ?? "" }
            : {}),
          ...(params.has("setup_action")
            ? { setupAction: params.get("setup_action") as "install" | "update" | "request" }
            : {}),
        });
        if (completed) {
          if (completed.redirect) return seeOther(completed.redirect);
          if (completed.view.status === "connected") return seeOther(GITHUB_AUTHORIZED_PATH);
          if (completed.view.status === "pending" || completed.view.status === "authorizing")
            return seeOther(GITHUB_AUTHORIZATION_PENDING_PATH);
          return seeOther(
            `${GITHUB_AUTHORIZATION_FAILED_PATH}?reason=${completed.view.last_failure ?? "code_spent"}`,
          );
        }
      }
      if (!dependencies.githubSourceAuthorization)
        return refused(
          403,
          "forbidden",
          "GitHub connection state is unknown. Start github connect again.",
          "state_unknown",
        );
      const result = await dependencies.githubSourceAuthorization.callback({
        state: params.get("state") ?? "",
        signedInPrincipalId,
        ...(params.has("code") ? { code: params.get("code") ?? "" } : { denied: true }),
      });
      if (result.status === "authorized") return seeOther(GITHUB_AUTHORIZED_PATH);
      if (result.status === "pending" || result.status === "authorizing")
        return seeOther(GITHUB_AUTHORIZATION_PENDING_PATH);
      return seeOther(
        `${GITHUB_AUTHORIZATION_FAILED_PATH}?reason=${result.last_failure ?? "code_spent"}`,
      );
    } catch (error) {
      if (error instanceof GithubConnectionStateUnknownError)
        return refused(
          403,
          "forbidden",
          "This GitHub link does not belong to an active request of the signed-in ohmyho.st user. Sign in as the person who started it and open the same link again, or start github connect again.",
          "state_unknown",
        );
      if (error instanceof GithubRepositoryNotInstalledError)
        return refused(
          403,
          "forbidden",
          "The installed GitHub App does not cover this repository. Add it to the installation, then open the same authorization link again.",
          "repository_not_installed",
        );
      if (error instanceof GithubRepositoryAccessRequiredError)
        return refused(
          403,
          "forbidden",
          "The authorizing GitHub account cannot read this repository through the installed app. Give it read access, then open the same authorization link again.",
          "repository_access_required",
        );
      if (error instanceof GithubAuthorizationCodeRejectedError)
        return refused(
          409,
          "confirmation_invalid",
          "GitHub rejected this confirmation. Open the same authorization link again to confirm once more.",
          "authorization_code_rejected",
        );
      if (error instanceof GithubAuthorizationRejectedError)
        // Four different endings used to read as one. The reason travels to the page and to the
        // problem document, so the customer is told which of them happened.
        return refused(
          409,
          "confirmation_invalid",
          {
            expired:
              "This GitHub authorization expired. Ask the agent for a fresh authorization link.",
            session_inactive:
              "The ohmyho.st session behind this authorization ended. Sign in again, then ask the agent for a fresh authorization link.",
            denied:
              "This GitHub authorization was declined. Nothing changed; ask the agent for a fresh authorization link to try again.",
            code_spent:
              "This GitHub authorization was already used. Ask the agent for a fresh authorization link.",
          }[error.reason],
          error.reason,
        );
      // Nothing named this failure, so without this line nothing can explain the next one.
      reportFailure(
        dependencies,
        requestId,
        "GITHUB_OAUTH_CALLBACK_FAILED",
        "/v1/github/oauth/callback",
      );
      return refused(
        503,
        "service_unavailable",
        "GitHub could not confirm this authorization. Open the same authorization link again in a moment; it stays valid.",
        "provider_unavailable",
        true,
      );
    }
  });

  app.put("/v1/projects/:project_id/environments/:environment_id/mail-domain", async (context) => {
    const parsed = await parseStrictJsonBody(
      context,
      requestIdFor(context, createRequestId),
      (value) =>
        hasExactKeys(value, ["domain", "receiving", "sending"]) &&
        typeof value["domain"] === "string" &&
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
          value["domain"],
        ) &&
        // The managed mail domain always sends: receive-only domains are not configured here.
        value["sending"] === true &&
        typeof value["receiving"] === "boolean"
          ? { domain: value["domain"], sending: value["sending"], receiving: value["receiving"] }
          : null,
    );
    if (parsed.outcome === "error") return parsed.response;
    return handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      mutation: true,
      canonicalValue: parsed.value,
      invoke: async (prepared) => {
        if (!dependencies.managedMail) throw new Error("Mail unavailable");
        return json(
          await dependencies.managedMail.configureMailDomain({
            ...prepared.context,
            ...prepared.mutation,
            ...parsed.value,
          }),
          200,
          prepared.context.requestId,
        );
      },
    });
  });
  app.get("/v1/projects/:project_id/environments/:environment_id/mail-domain", (context) =>
    handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "projects:read",
      canonicalValue: null,
      invoke: async (prepared) => {
        if (!dependencies.managedMail) throw new Error("Mail unavailable");
        const value = await dependencies.managedMail.readMailDomain(prepared.context);
        return value === null
          ? problem(prepared.context.requestId, 404, "resource_not_found", "Resource not found.")
          : json(value, 200, prepared.context.requestId);
      },
    }),
  );
  app.delete("/v1/projects/:project_id/environments/:environment_id/mail-domain", (context) =>
    handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      mutation: true,
      canonicalValue: null,
      invoke: async (prepared) => {
        if (!dependencies.managedMail) throw new Error("Mail unavailable");
        return json(
          await dependencies.managedMail.deleteMailDomain({
            ...prepared.context,
            ...prepared.mutation,
          }),
          200,
          prepared.context.requestId,
        );
      },
    }),
  );
  app.put("/v1/projects/:project_id/environments/:environment_id/mail-webhook", async (context) => {
    const parsed = await parseStrictJsonBody(
      context,
      requestIdFor(context, createRequestId),
      (value) =>
        hasExactKeys(value, ["url"]) && typeof value["url"] === "string"
          ? { url: value["url"] }
          : null,
    );
    if (parsed.outcome === "error") return parsed.response;
    return handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "secrets:write",
      mutation: true,
      canonicalValue: parsed.value,
      invoke: async (prepared) => {
        if (!dependencies.managedMail) throw new Error("Mail unavailable");
        return json(
          await dependencies.managedMail.prepareMailWebhook({
            ...prepared.context,
            ...prepared.mutation,
            ...parsed.value,
          }),
          200,
          prepared.context.requestId,
        );
      },
    });
  });
  app.post("/v1/projects/:project_id/environments/:environment_id/mail-webhook/verify", (context) =>
    handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "secrets:write",
      mutation: true,
      canonicalValue: null,
      invoke: async (prepared) => {
        if (!dependencies.managedMail) throw new Error("Mail unavailable");
        return json(
          await dependencies.managedMail.verifyMailWebhook({
            ...prepared.context,
            ...prepared.mutation,
          }),
          200,
          prepared.context.requestId,
        );
      },
    }),
  );
  app.post("/v1/projects/:project_id/environments/:environment_id/mail-webhook:rotate", (context) =>
    handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "secrets:write",
      mutation: true,
      canonicalValue: null,
      invoke: async (prepared) => {
        if (!dependencies.managedMail) throw new Error("Mail unavailable");
        return json(
          await dependencies.managedMail.rotateMailWebhook({
            ...prepared.context,
            ...prepared.mutation,
          }),
          200,
          prepared.context.requestId,
        );
      },
    }),
  );
  app.delete("/v1/projects/:project_id/environments/:environment_id/mail-webhook", (context) =>
    handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "secrets:delete",
      mutation: true,
      canonicalValue: null,
      invoke: async (prepared) => {
        if (!dependencies.managedMail) throw new Error("Mail unavailable");
        return json(
          await dependencies.managedMail.disableMailReceiving({
            ...prepared.context,
            ...prepared.mutation,
          }),
          200,
          prepared.context.requestId,
        );
      },
    }),
  );
  app.get("/v1/projects/:project_id/environments/:environment_id/mail/messages", (context) =>
    handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "secrets:read",
      canonicalValue: null,
      invoke: async (prepared) => {
        if (!dependencies.managedMail) throw new Error("Mail unavailable");
        const after = context.req.query("after");
        if (after && !parseRouteUlid(after))
          return problem(
            prepared.context.requestId,
            400,
            "invalid_request",
            "Invalid mail cursor.",
          );
        return json(
          {
            items: await dependencies.managedMail.listMailMessages({
              ...prepared.context,
              ...(after ? { after } : {}),
            }),
          },
          200,
          prepared.context.requestId,
        );
      },
    }),
  );
  app.get(
    "/v1/projects/:project_id/environments/:environment_id/mail/messages/:message_id",
    (context) =>
      handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
        action: "secrets:read",
        canonicalValue: null,
        invoke: async (prepared) => {
          if (!dependencies.managedMail) throw new Error("Mail unavailable");
          const messageId = parseRouteUlid(context.req.param("message_id"));
          if (!messageId)
            return problem(
              prepared.context.requestId,
              400,
              "invalid_request",
              "Invalid message ID.",
            );
          const value = await dependencies.managedMail.getMailMessage({
            ...prepared.context,
            messageId,
          });
          return value === null
            ? problem(prepared.context.requestId, 404, "resource_not_found", "Resource not found.")
            : json(value, 200, prepared.context.requestId);
        },
      }),
  );
  app.post(
    "/v1/projects/:project_id/environments/:environment_id/mail/messages/:message_id/retry",
    (context) =>
      handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
        action: "secrets:write",
        mutation: true,
        canonicalValue: null,
        invoke: async (prepared) => {
          if (!dependencies.managedMail) throw new Error("Mail unavailable");
          const messageId = parseRouteUlid(context.req.param("message_id"));
          if (!messageId)
            return problem(
              prepared.context.requestId,
              400,
              "invalid_request",
              "Invalid message ID.",
            );
          return json(
            await dependencies.managedMail.retryMailMessage({
              ...prepared.context,
              ...prepared.mutation,
              messageId,
            }),
            200,
            prepared.context.requestId,
          );
        },
      }),
  );
  app.get(
    "/v1/projects/:project_id/environments/:environment_id/mail/messages/:message_id/attachments/:attachment_id",
    (context) =>
      handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
        action: "secrets:read",
        canonicalValue: null,
        invoke: async (prepared) => {
          if (!dependencies.managedMail) throw new Error("Mail unavailable");
          const messageId = parseRouteUlid(context.req.param("message_id")),
            attachmentId = context.req.param("attachment_id");
          if (!messageId || !/^[A-Za-z0-9_-]{1,128}$/u.test(attachmentId))
            return problem(
              prepared.context.requestId,
              400,
              "invalid_request",
              "Invalid attachment ID.",
            );
          const value = await dependencies.managedMail.getMailAttachment({
            ...prepared.context,
            messageId,
            attachmentId,
          });
          if (value instanceof Response) return value;
          return value === null
            ? problem(prepared.context.requestId, 404, "resource_not_found", "Resource not found.")
            : json(value, 200, prepared.context.requestId);
        },
      }),
  );

  app.post("/v1/projects/:project_id/cloudflare-dns/authorization", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "cloudflare-authorization",
      mutation: true,
      body: parseCloudflareAuthorizationBody,
      invoke: async (prepared, body) => {
        if (dependencies.cloudflareDomains === undefined) throw new Error("Unavailable");
        return {
          status: 201,
          body: cloudflareAuthorizationBody(
            await dependencies.cloudflareDomains.beginAuthorization({
              ...prepared.context,
              ...prepared.mutation,
              zone: body.zone,
            }),
          ),
        };
      },
    }),
  );

  app.get("/v1/projects/:project_id/cloudflare-dns", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:read",
      responseShape: "cloudflare-dns-status",
      invoke: async (prepared) => {
        if (dependencies.cloudflareDomains === undefined) throw new Error("Unavailable");
        return {
          status: 200,
          body: cloudflareDnsStatusBody(
            await dependencies.cloudflareDomains.getStatus(prepared.context),
          ),
        };
      },
    }),
  );

  app.put("/v1/projects/:project_id/handle", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "operation",
      mutation: true,
      guarded: true,
      body: parseProjectHandleBody,
      invoke: (prepared, handle) =>
        dependencies.productSurface.changeProjectHandle({
          ...prepared.context,
          ...prepared.mutation,
          handle,
          ifMatch: prepared.ifMatch,
        }),
    }),
  );

  app.put("/v1/projects/:project_id/domains", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "operation",
      mutation: true,
      invoke: async (prepared) => {
        if (dependencies.cloudflareDomains === undefined) throw new Error("Unavailable");
        const projectHandle = prepared.project.handle;
        return dependencies.cloudflareDomains.configureDomains({
          ...prepared.context,
          ...prepared.mutation,
          projectHandle,
        });
      },
    }),
  );

  app.post("/v1/projects/:project_id/paid-domain:plan", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "paid-domain-plan",
      body: parsePaidDomainBody,
      invoke: async (prepared, body) => {
        if (dependencies.cloudflareDomains === undefined) throw new Error("Unavailable");
        return {
          status: 200,
          body: paidDomainPlanBody(
            await dependencies.cloudflareDomains.planPaidDomain({
              ...prepared.context,
              hostname: body.hostname,
            }),
          ),
        };
      },
    }),
  );

  app.put("/v1/projects/:project_id/paid-domain", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "paid-domain",
      mutation: true,
      body: parsePaidDomainBody,
      invoke: async (prepared, body) => {
        if (dependencies.cloudflareDomains === undefined) throw new Error("Unavailable");
        return {
          status: 200,
          body: paidDomainBody(
            await dependencies.cloudflareDomains.applyPaidDomain({
              ...prepared.context,
              ...prepared.mutation,
              hostname: body.hostname,
            }),
          ),
        };
      },
    }),
  );

  app.get("/v1/projects/:project_id/paid-domain", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:read",
      responseShape: "paid-domain",
      invoke: async (prepared) => {
        if (dependencies.cloudflareDomains === undefined) throw new Error("Unavailable");
        return {
          status: 200,
          body: paidDomainBody(
            await dependencies.cloudflareDomains.getPaidDomain(prepared.context),
          ),
        };
      },
    }),
  );

  app.delete("/v1/projects/:project_id/paid-domain", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "paid-domain",
      mutation: true,
      body: parsePaidDomainBody,
      invoke: async (prepared, body) => {
        if (dependencies.cloudflareDomains === undefined) throw new Error("Unavailable");
        return {
          status: 200,
          body: paidDomainBody(
            await dependencies.cloudflareDomains.deletePaidDomain({
              ...prepared.context,
              ...prepared.mutation,
              hostname: body.hostname,
            }),
          ),
        };
      },
    }),
  );

  const nativeBase = "/v1/projects/:project_id/environments/:environment_id/auth";
  const nativeHandler =
    (
      operation:
        | "config-read"
        | "config-update"
        | "provider-read"
        | "provider-update"
        | "users-list"
        | "user-create"
        | "user-read"
        | "user-delete"
        | "user-action",
    ) =>
    async (context: Context) => {
      const requestId = requestIdFor(context, createRequestId);
      const mutation = [
        "config-update",
        "provider-update",
        "user-create",
        "user-delete",
        "user-action",
      ].includes(operation);
      let body: unknown = null;
      if (
        operation === "config-update" ||
        operation === "provider-update" ||
        operation === "user-create"
      ) {
        const raw = await parseJsonObject(context);
        if (raw.outcome === "error") return problem(requestId, raw.status, raw.code, raw.detail);
        const schema =
          operation === "config-update"
            ? nativeConfigUpdate
            : operation === "provider-update"
              ? nativeProviderUpdate
              : nativeInvite;
        const parsed = schema.safeParse(raw.value);
        if (!parsed.success)
          return problem(requestId, 400, "invalid_request", "Request fields are invalid.");
        body = parsed.data;
      }
      const provider = context.req.param("provider");
      if (
        (operation === "provider-read" || operation === "provider-update") &&
        provider !== "google" &&
        provider !== "github"
      )
        return problem(requestId, 400, "invalid_request", "Provider is invalid.");
      const userId = context.req.param("user_id")?.toLowerCase();
      if (
        (operation === "user-read" || operation === "user-delete" || operation === "user-action") &&
        (!userId ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            userId,
          ))
      )
        return problem(requestId, 400, "invalid_request", "User ID is invalid.");
      const action = context.req.param("action");
      if (
        operation === "user-action" &&
        action !== "invite" &&
        action !== "suspend" &&
        action !== "reactivate" &&
        action !== "revoke-sessions"
      )
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      const url = new URL(context.req.url);
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 50 : Number(limitText);
      const cursor = url.searchParams.get("cursor"),
        search = url.searchParams.get("search");
      if (
        (operation !== "users-list" && url.search) ||
        (operation === "users-list" &&
          ([...url.searchParams.keys()].some(
            (key) =>
              !["limit", "cursor", "search"].includes(key) ||
              url.searchParams.getAll(key).length !== 1,
          ) ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100 ||
            (cursor !== null && !nativeUserResponse.shape.id.safeParse(cursor).success) ||
            (search !== null && (search.length < 1 || search.length > 320))))
      )
        return problem(requestId, 400, "invalid_request", "Query is invalid.");
      return handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
        action: mutation ? "auth:manage" : "auth:read",
        mutation,
        canonicalValue: body,
        invoke: async (prepared) => {
          const port = dependencies.nativeAuthManagement;
          if (!port) throw new Error("Native Auth management unavailable");
          const scope = prepared.context;
          const write = { ...scope, ...prepared.mutation };
          let result: unknown;
          if (operation === "config-read") result = await port.getConfiguration(scope);
          else if (operation === "config-update")
            result = await port.updateConfiguration({
              ...write,
              body: nativeConfigUpdate.parse(body),
            });
          else if (operation === "provider-read")
            result = await port.getProvider({
              ...scope,
              provider: provider as "google" | "github",
            });
          else if (operation === "provider-update")
            result = await port.updateProvider({
              ...write,
              provider: provider as "google" | "github",
              body: nativeProviderUpdate.parse(body),
            });
          else if (operation === "users-list")
            result = await port.listUsers({
              ...scope,
              limit,
              ...(cursor === null ? {} : { cursor }),
              ...(search === null ? {} : { search }),
            });
          else if (operation === "user-create")
            result = await port.createUser({ ...write, ...nativeInvite.parse(body) });
          else if (operation === "user-read")
            result = await port.getUser({ ...scope, userId: userId as string });
          else if (operation === "user-delete") {
            await port.deleteUser({ ...write, userId: userId as string });
            return new Response(null, { status: 204, headers: { "X-Request-Id": requestId } });
          } else
            result = await port.userAction({
              ...write,
              userId: userId as string,
              action: action as "invite" | "suspend" | "reactivate" | "revoke-sessions",
            });
          if (result === null)
            return problem(requestId, 404, "resource_not_found", "Resource not found.");
          const responseSchema = operation.startsWith("config-")
            ? nativeConfigResponse
            : operation.startsWith("provider-")
              ? nativeProviderResponse
              : operation === "users-list"
                ? nativeUserPageResponse
                : nativeUserResponse;
          return json(
            responseSchema.parse(result),
            operation === "user-create" ? 201 : 200,
            requestId,
          );
        },
      });
    };
  app.get(nativeBase, nativeHandler("config-read"));
  app.put(nativeBase, nativeHandler("config-update"));
  app.get(`${nativeBase}/providers/:provider`, nativeHandler("provider-read"));
  app.put(`${nativeBase}/providers/:provider`, nativeHandler("provider-update"));
  app.get(`${nativeBase}/users`, nativeHandler("users-list"));
  app.post(`${nativeBase}/users`, nativeHandler("user-create"));
  app.get(`${nativeBase}/users/:user_id`, nativeHandler("user-read"));
  app.delete(`${nativeBase}/users/:user_id`, nativeHandler("user-delete"));
  app.post(`${nativeBase}/users/:user_id/:action`, nativeHandler("user-action"));

  app.get("/v1/projects/:project_id/environments/:environment_id/secrets", async (context) =>
    handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "secrets:read",
      canonicalValue: null,
      invoke: async (prepared) => {
        const page = await dependencies.environmentSecrets.list(prepared.context);
        return json(
          {
            items: page.items.map((item) => environmentSecretBody({ ...item, ...page.delivery })),
            ...runtimeSecretDeliveryBody(page.delivery),
          },
          200,
          prepared.context.requestId,
        );
      },
    }),
  );

  app.get("/v1/projects/:project_id/environments/:environment_id/function-runs", async (context) =>
    handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
      action: "logs:read",
      canonicalValue: null,
      invoke: async (prepared) => {
        const limit = parseFunctionRunLimit(context);
        if (limit === null) {
          return problem(
            prepared.context.requestId,
            400,
            "invalid_request",
            "Function run query is invalid.",
          );
        }
        if (dependencies.functionRuns === undefined) {
          return problem(
            prepared.context.requestId,
            503,
            "service_unavailable",
            "Function runs are unavailable.",
            true,
          );
        }
        const page = await dependencies.functionRuns.list({ ...prepared.context, limit });
        return json({ items: page.items.map(functionRunBody) }, 200, prepared.context.requestId);
      },
    }),
  );

  app.put(
    "/v1/projects/:project_id/environments/:environment_id/secrets/:secret_name",
    async (context) => {
      const requestId = requestIdFor(context, createRequestId);
      const requestedName = context.req.param("secret_name");
      const name = validSecretName(
        requestedName,
        context.req.method === "DELETE" ? "delete" : "set",
      );
      if (name === null)
        return problem(requestId, 400, "invalid_request", secretNameProblem(requestedName));
      const parsed = await parseStrictJsonBody(context, requestId, (value) =>
        hasExactKeys(value, ["value"]) &&
        typeof value["value"] === "string" &&
        value["value"].length >= 1 &&
        new TextEncoder().encode(value["value"]).byteLength <= SECRET_VALUE_MAXIMUM_BYTES
          ? { value: value["value"] }
          : null,
      );
      if (parsed.outcome === "error") return parsed.response;
      return handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
        action: "secrets:write",
        mutation: true,
        canonicalValue: { name, value: parsed.value.value },
        invoke: async (prepared) => {
          const stored = await dependencies.environmentSecrets.put({
            ...prepared.context,
            ...prepared.mutation,
            name,
            value: parsed.value.value,
          });
          return json(environmentSecretBody(stored), 200, prepared.context.requestId);
        },
      });
    },
  );

  app.delete(
    "/v1/projects/:project_id/environments/:environment_id/secrets/:secret_name",
    async (context) => {
      const requestId = requestIdFor(context, createRequestId);
      const requestedName = context.req.param("secret_name");
      const name = validSecretName(
        requestedName,
        context.req.method === "DELETE" ? "delete" : "set",
      );
      if (name === null)
        return problem(requestId, 400, "invalid_request", secretNameProblem(requestedName));
      return handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
        action: "secrets:delete",
        mutation: true,
        canonicalValue: { name },
        invoke: async (prepared) => {
          const result = await dependencies.environmentSecrets.remove({
            ...prepared.context,
            ...prepared.mutation,
            name,
          });
          if (result.name !== name || (result.status !== "deleted" && result.status !== "absent")) {
            throw new TypeError("Environment secret deletion result is invalid");
          }
          return json(
            { name: result.name, status: result.status, ...runtimeSecretDeliveryBody(result) },
            200,
            prepared.context.requestId,
          );
        },
      });
    },
  );

  app.post(
    "/v1/projects/:project_id/environments/:environment_id/secrets/:secret_name/rotate",
    async (context) => {
      const requestId = requestIdFor(context, createRequestId);
      const name = context.req.param("secret_name");
      if (!isInstalledPlatformKeyName(name))
        return problem(requestId, 400, "invalid_request", "Secret name is invalid.");
      return handleEnvironmentSecretRequest(context, dependencies, createRequestId, {
        action: "secrets:write",
        mutation: true,
        canonicalValue: { name },
        invoke: async (prepared) => {
          const rotated = await dependencies.environmentSecrets.rotate({
            ...prepared.context,
            ...prepared.mutation,
            name,
          });
          return json(environmentSecretBody(rotated), 200, prepared.context.requestId);
        },
      });
    },
  );

  app.post("/v1/projects/:project_id/database/compute", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      mutation: true,
      responseShape: "operation",
      body: (context, requestId) =>
        parseStrictJsonBody(context, requestId, (value) => {
          try {
            return parseDatabaseComputeChangeRequest(value);
          } catch {
            return null;
          }
        }),
      invoke: async (prepared, body) => {
        if (!dependencies.databaseCompute) throw new Error("Database compute changes unavailable");
        return dependencies.databaseCompute.set({
          ...prepared.context,
          ...prepared.mutation,
          environment: body.environment,
          ...body.selection,
        });
      },
    }),
  );

  app.get("/v1/projects/:project_id/database/compute", async (context) => {
    const parameters = new URL(context.req.url).searchParams,
      environment = parameters.get("environment") ?? "dev";
    if (
      !["dev", "prod"].includes(environment) ||
      [...parameters.keys()].some((key) => key !== "environment") ||
      parameters.getAll("environment").length > 1
    )
      return problem(
        requestIdFor(context, createRequestId),
        400,
        "invalid_request",
        "Select dev or prod.",
      );
    return handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:read",
      responseShape: "database-compute",
      invoke: async (prepared) => {
        if (!dependencies.databaseCompute)
          throw new Error("Database compute reporting unavailable");
        const value = await dependencies.databaseCompute.get({
          ...prepared.context,
          environment: environment as "dev" | "prod",
        });
        return value ? { status: 200, body: { ...value } } : null;
      },
    });
  });

  app.get("/v1/projects/:project_id/context", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:read",
      responseShape: "project-context",
      invoke: async (prepared) => {
        const notesPort = dependencies.projectNotes;
        if (!notesPort) throw new Error("Project context unavailable");
        if (!(await notesPort.get(prepared.context))) return null;
        const creditAccess = await authorize(
          dependencies,
          prepared.principal,
          { kind: "organization", organizationId: prepared.context.organizationId },
          "credits:read",
        );
        if (creditAccess === "unavailable") throw new Error("Credit authorization unavailable");
        const status = await dependencies.productSurface.getProjectStatus(prepared.context);
        if (!status) return null;
        const body = validateProductResponseBody("project-status", status.body);
        if (body["project_id"] !== prepared.context.projectId)
          throw new Error("Project context scope mismatch");
        const [mail, domain] = await Promise.all([
          dependencies.projectMailDomains.get(prepared.context).catch(() => "unavailable" as const),
          dependencies.cloudflareDomains
            ? dependencies.cloudflareDomains
                .getPaidDomain(prepared.context)
                .then((value) => {
                  validatePaidDomain(paidDomainBody(value));
                  return value;
                })
                .catch(() => "unavailable" as const)
            : Promise.resolve("unavailable" as const),
        ]);
        const now = dependencies.clock.now().toISOString();
        const readComputeContext = (environment: "dev" | "prod") =>
          dependencies.databaseCompute
            ? dependencies.databaseCompute
                .getContext({ ...prepared.context, environment, now })
                .catch(() => "unavailable" as const)
            : Promise.resolve("unavailable" as const);
        const [devCompute, prodCompute, storageJurisdiction] = await Promise.all([
          Array.isArray(body["environments"]) &&
          !body["environments"].some(
            (environment: unknown) => isRecord(environment) && environment["name"] === "dev",
          )
            ? Promise.resolve("unavailable" as const)
            : readComputeContext("dev"),
          readComputeContext("prod"),
          notesPort
            .storageJurisdiction(prepared.context)
            .then((value) => value ?? ("unavailable" as const))
            .catch(() => "unavailable" as const),
        ]);
        let creditData = {};
        if (creditAccess === "allow") {
          if (!dependencies.credits) throw new Error("Credit reporting unavailable");
          // Validate each returned value even if another read failed; availability must never
          // hide a scope/contract error. Wait for all bounded reads before returning the context.
          const [creditRead, usageRead, budgetRead] = await Promise.allSettled([
            dependencies.credits.readOrganization(prepared.context.organizationId),
            dependencies.credits.readUsage(
              prepared.context.organizationId,
              prepared.context.projectId,
            ),
            dependencies.credits.readBudget(prepared.context),
          ]);
          if (creditRead.status === "fulfilled") {
            validateCreditBalance(creditRead.value);
            if (creditRead.value.organization_id !== prepared.context.organizationId)
              throw new Error("Credit scope mismatch");
          }
          if (usageRead.status === "fulfilled") {
            assertOrganizationCreditUsage(usageRead.value);
            if (
              usageRead.value.organization_id !== prepared.context.organizationId ||
              usageRead.value.projects.some(
                (row) => row.project_id !== prepared.context.projectId,
              ) ||
              usageRead.value.days.some((day) =>
                day.projects.some((row) => row.project_id !== prepared.context.projectId),
              )
            )
              throw new Error("Credit scope mismatch");
          }
          if (budgetRead.status === "fulfilled") {
            validateCreditBudget(budgetRead.value.body);
            if (budgetRead.value.body["project_id"] !== prepared.context.projectId)
              throw new Error("Credit scope mismatch");
          }
          if (
            creditRead.status === "rejected" ||
            usageRead.status === "rejected" ||
            budgetRead.status === "rejected"
          ) {
            for (const [result, code] of [
              [creditRead, "CONTEXT_CREDITS_UNAVAILABLE"],
              [usageRead, "CONTEXT_USAGE_UNAVAILABLE"],
              [budgetRead, "CONTEXT_BUDGET_UNAVAILABLE"],
            ] as const) {
              if (result.status === "rejected")
                reportFailure(
                  dependencies,
                  prepared.context.requestId,
                  code,
                  safeRouteLabel(context.req.path),
                );
            }
            creditData = { financialUnavailable: true };
          } else {
            creditData = {
              credits: validateCreditBalance(creditRead.value),
              usage: usageRead.value,
              budget: validateCreditBudget(budgetRead.value.body),
            };
          }
        }
        let billingData: {
          billingIssue?:
            | import("@ohmyhost/contracts/billing").BillingTaxIssue
            | null
            | "unavailable";
        } = {};
        if (dependencies.billing) {
          const billingAccess = await authorize(
            dependencies,
            prepared.principal,
            { kind: "organization", organizationId: prepared.context.organizationId },
            "billing:manage",
          );
          if (billingAccess === "allow") {
            try {
              const billing = await dependencies.billing.getRecharge({
                organizationId: prepared.context.organizationId,
              });
              if (billing.organization_id !== prepared.context.organizationId)
                throw new Error("Billing scope mismatch");
              billingData = { billingIssue: billing.billing_issue };
            } catch {
              billingData = { billingIssue: "unavailable" };
            }
          }
        }
        const notes = await notesPort.get(prepared.context);
        if (!notes) return null;
        return {
          status: 200,
          body: renderProjectContext({
            project: prepared.project,
            generatedAt: now,
            storageJurisdiction,
            status: body,
            notes,
            mail,
            domain,
            compute: { dev: devCompute, prod: prodCompute },
            creditAccess: creditAccess === "allow" ? "included" : "not_authorized",
            ...creditData,
            ...billingData,
          }),
        };
      },
    }),
  );
  app.put("/v1/projects/:project_id/context/notes", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "project-notes",
      mutation: true,
      body: (context, requestId) =>
        parseStrictJsonBody(context, requestId, (value) => {
          if (
            !hasExactKeys(value, ["expected_version", "markdown"]) ||
            !Number.isInteger(value["expected_version"]) ||
            Number(value["expected_version"]) < 0 ||
            Number(value["expected_version"]) >= 2147483647
          )
            return null;
          try {
            return {
              markdown: normalizeProjectNotes(value["markdown"]),
              expectedVersion: Number(value["expected_version"]),
            };
          } catch {
            return null;
          }
        }),
      invoke: async (prepared, body) => {
        if (!dependencies.projectNotes) throw new Error("Project notes unavailable");
        const result = await dependencies.projectNotes.set({
          ...prepared.context,
          ...prepared.mutation,
          ...body,
        });
        return { status: 200, body: { version: result.version, updated_at: result.updatedAt } };
      },
    }),
  );

  app.get("/v1/projects/:project_id/source", async (context) => {
    const fullBinding = new URL(context.req.url).searchParams.get("include_binding") === "true";
    return handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "sources:read",
      responseShape: fullBinding ? "source-binding" : "source",
      body: (ctx, id) => {
        const query = new URL(ctx.req.url).searchParams;
        if (
          [...query.keys()].some((key) => key !== "include_binding") ||
          query.getAll("include_binding").length > 1 ||
          (query.has("include_binding") &&
            !["true", "false"].includes(query.get("include_binding") ?? ""))
        )
          return {
            outcome: "error",
            response: problem(
              id,
              400,
              "invalid_request",
              "Use include_binding=true to read the exact source binding; omit it or use false for the default source view.",
            ),
          };
        return {
          outcome: "ok",
          value: fullBinding,
          canonicalValue: { include_binding: fullBinding },
        };
      },
      invoke: async (prepared) => {
        const result =
          (await dependencies.managedSources?.getSource(prepared.context)) ??
          (await dependencies.productSurface.getSource(prepared.context));
        return result === null || fullBinding
          ? result
          : { ...result, body: defaultProjectSource(result.body) };
      },
    });
  });

  app.put("/v1/projects/:project_id/source/auto-deploy", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "auto-deploy",
      mutation: true,
      body: parseAutoDeployBody,
      invoke: (prepared, body) =>
        dependencies.productSurface.configureAutoDeploy({
          ...prepared.context,
          ...prepared.mutation,
          branchRef: `refs/heads/${body.branch}`,
          enabled: body.enabled,
        }),
    }),
  );

  app.get("/v1/projects/:project_id/source/auto-deploy", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:read",
      responseShape: "auto-deploy",
      invoke: (prepared) => dependencies.productSurface.getAutoDeploy(prepared.context),
    }),
  );

  const previewRoute = (method: "get" | "open" | "stop" | "rotate") => async (context: Context) => {
    const changing = method === "stop" || method === "rotate";
    const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "preview",
      mutation: changing,
      body: parsePreviewEnvironment,
      invoke: async (prepared, environment) => {
        if (!dependencies.previews) throw new Error("Preview is unavailable");
        const scope = {
          organizationId: prepared.context.organizationId,
          projectId: prepared.context.projectId,
          principalId: prepared.context.principalId,
          environment,
          ...(prepared.context.delegation === undefined
            ? {}
            : { delegation: prepared.context.delegation }),
        };
        const result =
          method === "get"
            ? await dependencies.previews.get(scope)
            : method === "open"
              ? await dependencies.previews.open(scope)
              : method === "stop"
                ? await dependencies.previews.stop(scope, prepared.mutation.idempotencyKey)
                : await dependencies.previews.rotate(scope, prepared.mutation.idempotencyKey);
        return result === null ? null : { status: 200, body: { ...result } };
      },
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  app.get("/v1/projects/:project_id/preview", previewRoute("get"));
  app.post("/v1/projects/:project_id/preview", previewRoute("open"));
  app.delete("/v1/projects/:project_id/preview", previewRoute("stop"));
  app.post("/v1/projects/:project_id/preview/token", previewRoute("rotate"));

  app.post("/v1/projects/:project_id/dev-share-link", async (context) => {
    const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:dev-access",
      responseShape: "dev-access-state",
      invoke: async (prepared) => {
        if (!dependencies.devAccessManagement) throw new Error("Dev sharing is unavailable");
        const state = await dependencies.devAccessManagement.ensure(prepared.context);
        return { status: 200, body: devAccessStateBody(prepared.context.projectId, state) };
      },
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  app.put("/v1/projects/:project_id/dev-access-mode", async (context) => {
    const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:dev-access",
      responseShape: "dev-access-state",
      mutation: true,
      body: parseDevAccessModeBody,
      invoke: async (prepared, mode) => {
        if (!dependencies.devAccessManagement) throw new Error("Dev sharing is unavailable");
        const state = await dependencies.devAccessManagement.setMode(
          prepared.context,
          mode,
          prepared.mutation.idempotencyKey,
        );
        return { status: 200, body: devAccessStateBody(prepared.context.projectId, state) };
      },
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  app.get("/v1/projects/:project_id/powered-by-flag", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:read",
      responseShape: "powered-by-flag",
      invoke: async (prepared) => {
        if (!dependencies.poweredByFlag) throw new Error("Powered-by flag is unavailable");
        const state = await dependencies.poweredByFlag.get(prepared.context);
        return state && { status: 200, body: poweredByFlagBody(prepared.context.projectId, state) };
      },
    }),
  );

  app.put("/v1/projects/:project_id/powered-by-flag", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "powered-by-flag",
      mutation: true,
      body: parsePoweredByFlagBody,
      invoke: async (prepared, enabled) => {
        if (!dependencies.poweredByFlag) throw new Error("Powered-by flag is unavailable");
        const state = await dependencies.poweredByFlag.set({
          ...prepared.context,
          ...prepared.mutation,
          enabled,
        });
        return state && { status: 200, body: poweredByFlagBody(prepared.context.projectId, state) };
      },
    }),
  );

  app.post("/v1/projects/:project_id/dev-share-link:rotate", async (context) => {
    const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:dev-access",
      responseShape: "dev-access-state",
      mutation: true,
      invoke: async (prepared) => {
        if (!dependencies.devAccessManagement) throw new Error("Dev sharing is unavailable");
        const state = await dependencies.devAccessManagement.rotate(
          prepared.context,
          prepared.mutation.idempotencyKey,
        );
        return { status: 200, body: devAccessStateBody(prepared.context.projectId, state) };
      },
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  app.delete("/v1/projects/:project_id/dev-share-link", async (context) => {
    const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:dev-access",
      responseShape: "dev-access-state",
      mutation: true,
      invoke: async (prepared) => {
        if (!dependencies.devAccessManagement) throw new Error("Dev sharing is unavailable");
        const state = await dependencies.devAccessManagement.revoke(
          prepared.context,
          prepared.mutation.idempotencyKey,
        );
        return { status: 200, body: devAccessStateBody(prepared.context.projectId, state) };
      },
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  app.post("/v1/projects/:project_id/dev-access-tickets", async (context) => {
    const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:dev-access",
      responseShape: "dev-access-ticket",
      invoke: async (prepared) => {
        const ticket = await dependencies.devAccessTickets.issue(prepared.context);
        if (ticket.projectId !== prepared.context.projectId) {
          throw new TypeError("Dev access ticket project is invalid");
        }
        return {
          status: 201,
          body: {
            ticket_id: ticket.ticketId,
            project_id: ticket.projectId,
            environment_id: ticket.environmentId,
            origin: ticket.origin,
            redeem_url: ticket.redeemUrl,
            expires_at: ticket.expiresAt,
          },
        };
      },
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Pragma", "no-cache");
    return response;
  });

  app.post("/v1/projects/:project_id/deployments:plan", async (context) => {
    return handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "deployments:plan",
      responseShape: "deployment-plan",
      body: parseDeploymentPlanBody,
      invoke: (prepared, body) =>
        dependencies.productSurface.planDeployment({
          ...prepared.context,
          commitSha: body.commitSha,
          environment: body.environment,
        }),
    });
  });

  app.post("/v1/projects/:project_id/deployments", async (context) => {
    return handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "deployments:create",
      responseShape: "operation",
      mutation: true,
      body: parseCreateDeploymentBody,
      invoke: (prepared, body) =>
        dependencies.productSurface.createDeployment({
          ...prepared.context,
          ...prepared.mutation,
          planId: body.planId,
        }),
    });
  });

  app.get("/v1/projects/:project_id/deployments", async (context) => {
    return handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "deployments:read",
      responseShape: "deployment-page",
      body: parseDeploymentListQuery,
      invoke: (prepared, query) =>
        dependencies.productSurface.listDeployments({ ...prepared.context, ...query }),
    });
  });

  app.get("/v1/projects/:project_id/deployments/:deployment_id", async (context) => {
    return handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "deployments:read",
      responseShape: "deployment",
      requireEtag: true,
      body: (requestContext, requestId) =>
        parseUlidParameter(requestContext, "deployment_id", "Deployment ID", requestId),
      invoke: (prepared, deploymentId) =>
        dependencies.productSurface.getDeployment({ ...prepared.context, deploymentId }),
    });
  });
  app.get("/v1/projects/:project_id/deployments/:deployment_id/logs", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "logs:read",
      responseShape: "diagnostic-page",
      body: parseDiagnosticQuery,
      invoke: (prepared, query) =>
        listDeploymentDiagnostics(
          context.req.param("deployment_id"),
          dependencies,
          prepared,
          query,
        ),
    }),
  );
  app.get("/v1/projects/:project_id/deployments/:deployment_id/logs/events", async (context) => {
    const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "logs:read",
      responseShape: "diagnostic-page",
      body: parseDiagnosticQuery,
      invoke: (prepared, query) =>
        listDeploymentDiagnostics(
          context.req.param("deployment_id"),
          dependencies,
          prepared,
          query,
        ),
    });
    if (response.status !== 200) return response;
    const page = (await response.json()) as {
      items: Record<string, unknown>[];
      next_cursor?: string;
    };
    // A truncated page ends with the cursor of the next one, so a stream client can read every page.
    const next =
      page.next_cursor === undefined
        ? ""
        : `event: next\ndata: ${JSON.stringify({ next_cursor: page.next_cursor })}\n\n`;
    return new Response(
      page.items
        .map(
          (item) =>
            `id: ${String(item["id"])}\nevent: diagnostic\ndata: ${JSON.stringify(item)}\n\n`,
        )
        .join("") + next,
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-request-id": response.headers.get("x-request-id") ?? "",
        },
      },
    );
  });

  app.post("/v1/projects/:project_id/deployments/*", async (context) => {
    if (context.req.path.endsWith(":rollback-plan")) {
      return handleProductSurfaceRequest(context, dependencies, createRequestId, {
        action: "projects:rollback-plan",
        responseShape: "rollback-plan",
        body: (requestContext, requestId) =>
          parseUlidParameter(
            requestContext,
            "target_deployment_id",
            "Target deployment ID",
            requestId,
          ),
        invoke: (prepared, targetDeploymentId) =>
          dependencies.productSurface.planRollback({ ...prepared.context, targetDeploymentId }),
      });
    }
    if (context.req.path.endsWith(":rollback")) {
      return handleProductSurfaceRequest(context, dependencies, createRequestId, {
        action: "projects:rollback",
        responseShape: "operation",
        mutation: true,
        destructive: true,
        body: (requestContext, requestId) =>
          parseUlidParameter(
            requestContext,
            "target_deployment_id",
            "Target deployment ID",
            requestId,
          ),
        invoke: (prepared, targetDeploymentId) =>
          dependencies.productSurface.rollback({
            ...prepared.context,
            ...prepared.mutation,
            ...prepared.destructive,
            targetDeploymentId,
          }),
      });
    }
    if (context.req.path.endsWith(":promote-plan")) {
      return handleProductSurfaceRequest(context, dependencies, createRequestId, {
        action: "projects:promote-plan",
        responseShape: "promotion-plan",
        body: (requestContext, requestId) =>
          parseUlidParameter(
            requestContext,
            "source_deployment_id",
            "Source deployment ID",
            requestId,
          ),
        invoke: (prepared, sourceDeploymentId) =>
          dependencies.productSurface.planPromotion({ ...prepared.context, sourceDeploymentId }),
      });
    }
    if (context.req.path.endsWith(":promote")) {
      return handleProductSurfaceRequest(context, dependencies, createRequestId, {
        action: "projects:promote",
        responseShape: "operation",
        mutation: true,
        destructive: true,
        body: (requestContext, requestId) =>
          parseUlidParameter(
            requestContext,
            "source_deployment_id",
            "Source deployment ID",
            requestId,
          ),
        invoke: (prepared, sourceDeploymentId) =>
          dependencies.productSurface.promote({
            ...prepared.context,
            ...prepared.mutation,
            ...prepared.destructive,
            sourceDeploymentId,
          }),
      });
    }
    return problem(
      requestIdFor(context, createRequestId),
      404,
      "resource_not_found",
      "Resource not found.",
    );
  });

  app.post("/v1/projects/:project_id:delete-plan", async (context) => {
    // Hono reads `:project_id:delete-plan` as one segment, so any POST to /v1/projects/{id} reaches this route.
    if (!/^\/v1\/projects\/[^/:]+:delete-plan$/u.test(context.req.path))
      return problem(
        requestIdFor(context, createRequestId),
        404,
        "resource_not_found",
        "Resource not found.",
      );
    return handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:delete-plan",
      responseShape: "delete-plan",
      invoke: (prepared) => dependencies.productSurface.planDelete(prepared.context),
    });
  });

  app.post("/v1/projects/:project_id/data-changes:plan", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:delete-plan",
      responseShape: "data-change-plan",
      body: parseDataChangeBody,
      invoke: async (prepared, body) => {
        if (!dependencies.productSurface.planDataChange)
          throw new Error("Data changes are unavailable");
        return dependencies.productSurface.planDataChange({
          ...prepared.context,
          change: body.change,
        });
      },
    }),
  );
  app.post("/v1/projects/:project_id/data-changes", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:delete",
      responseShape: "operation",
      mutation: true,
      destructive: true,
      body: parseDataChangeBody,
      invoke: async (prepared, body) => {
        if (!dependencies.productSurface.changeData)
          throw new Error("Data changes are unavailable");
        return dependencies.productSurface.changeData({
          ...prepared.context,
          ...prepared.mutation,
          ...prepared.destructive,
          change: body.change,
        });
      },
    }),
  );

  app.delete("/v1/projects/:project_id", async (context) => {
    return handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:delete",
      responseShape: "operation",
      mutation: true,
      destructive: true,
      invoke: (prepared) =>
        dependencies.productSurface.deleteProject({
          ...prepared.context,
          ...prepared.mutation,
          ...prepared.destructive,
        }),
    });
  });

  if (dependencies.projectExports) {
    app.post("/v1/projects/:project_id/exports", (context) =>
      handleProductSurfaceRequest(context, dependencies, createRequestId, {
        action: "projects:write",
        responseShape: "operation",
        mutation: true,
        body: async (context, requestId) => {
          const parsed = await parseStrictJsonBody(context, requestId, (value) => {
            if (
              !hasExactKeys(value, ["password"]) ||
              typeof value["password"] !== "string" ||
              value["password"].trim().length === 0 ||
              new TextEncoder().encode(value["password"]).length > 1024
            )
              return null;
            return { password: value["password"] };
          });
          if (parsed.outcome === "ok" && !exportPasswordMeetsMinimum(parsed.value.password))
            return {
              outcome: "error",
              response: problem(
                requestId,
                400,
                "invalid_request",
                `Export password must be at least ${EXPORT_PASSWORD_MIN_CHARACTERS} characters.`,
              ),
            };
          return parsed;
        },
        invoke: (prepared, body) => {
          if (!dependencies.projectExports) throw new Error("Project exports unavailable");
          return dependencies.projectExports.create({
            ...prepared.context,
            ...prepared.mutation,
            ...body,
          });
        },
      }),
    );
    // A download link is signed on demand, one audited link per request, and is never cached.
    app.post("/v1/projects/:project_id/exports/:export_id/download-links", async (context) => {
      const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
        action: "projects:write",
        responseShape: "project-export-download-link",
        body: (context, requestId) => {
          const operationId = parseRouteUlid(context.req.param("export_id") ?? "");
          return operationId === null
            ? {
                outcome: "error",
                response: problem(requestId, 400, "invalid_request", "Export ID is invalid."),
              }
            : { outcome: "ok", value: operationId, canonicalValue: null };
        },
        invoke: async (prepared, operationId) => {
          if (!dependencies.projectExports) throw new Error("Project exports unavailable");
          const result = await dependencies.projectExports.issueDownloadLink({
            ...prepared.context,
            operationId,
          });
          if (
            result &&
            (result.body["project_id"] !== prepared.context.projectId ||
              result.body["id"] !== operationId)
          )
            throw new Error("Project export scope mismatch");
          return result;
        },
      });
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Pragma", "no-cache");
      return response;
    });
    app.get("/v1/projects/:project_id/exports/:export_id", (context) =>
      handleProductSurfaceRequest(context, dependencies, createRequestId, {
        action: "projects:write",
        responseShape: "project-export",
        body: (context, requestId) => {
          const operationId = parseRouteUlid(context.req.param("export_id") ?? "");
          return operationId === null
            ? {
                outcome: "error",
                response: problem(requestId, 400, "invalid_request", "Export ID is invalid."),
              }
            : { outcome: "ok", value: operationId, canonicalValue: null };
        },
        invoke: async (prepared, operationId) => {
          if (!dependencies.projectExports) throw new Error("Project exports unavailable");
          const result = await dependencies.projectExports.get({
            ...prepared.context,
            operationId,
          });
          if (
            result &&
            (result.body["project_id"] !== prepared.context.projectId ||
              result.body["id"] !== operationId)
          )
            throw new Error("Project export scope mismatch");
          return result;
        },
      }),
    );
  }

  app.get("/v1/projects/:project_id/credit-budget", (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "credit-budget",
      invoke: (prepared) => {
        if (!dependencies.credits) throw new Error("Credit storage unavailable");
        return dependencies.credits.readBudget(prepared.context);
      },
    }),
  );
  app.put("/v1/projects/:project_id/credit-budget", (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "credit-budget",
      mutation: true,
      body: parseCreditBudgetBody,
      invoke: (prepared, body) => {
        if (!dependencies.credits) throw new Error("Credit storage unavailable");
        return dependencies.credits.setBudget({
          ...prepared.context,
          ...prepared.mutation,
          ...body,
        });
      },
    }),
  );

  app.get("/v1/project-handles/:handle", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    const authenticationResult = await authenticate(context, dependencies);
    if (authenticationResult.outcome === "invalid")
      return problem(requestId, 401, "unauthenticated", "Authentication is required.");
    if (authenticationResult.outcome === "unavailable") {
      reportFailure(dependencies, requestId, "AUTHENTICATION_UNAVAILABLE", "/v1/project-handles");
      return problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
    }
    const principalLimit = await enforcePrincipalLimits(
      dependencies,
      requestId,
      authenticationResult.authentication.principal,
    );
    if (principalLimit !== null) return principalLimit;
    const requestIdError = validateCallerRequestId(context);
    if (requestIdError !== null) return problem(requestId, 400, "invalid_request", requestIdError);
    const handle = context.req.param("handle") ?? "";
    if (handle.length === 0 || handle.length > 120 || containsControlCharacter(handle))
      return problem(requestId, 400, "invalid_request", "A handle is required.");
    const problemWithShape = projectHandleProblem(handle);
    let available: boolean;
    let alternatives: string[] = [];
    // Both lookups answer the same question, so a database that cannot answer says so once
    // instead of offering alternatives it could not check.
    try {
      const taken = await dependencies.persistence.takenProjectHandles([handle]);
      available = problemWithShape === null && !taken.has(handle);
      if (!available) {
        // The candidate itself is the one handle we already know cannot be offered; the
        // database decides the rest in one batch below.
        const proposed = suggestProjectHandles(handle, (candidate) => candidate !== handle, 16);
        const proposedTaken = await dependencies.persistence.takenProjectHandles(proposed);
        alternatives = proposed.filter((candidate) => !proposedTaken.has(candidate)).slice(0, 5);
      }
    } catch {
      reportFailure(dependencies, requestId, "PROJECT_HANDLE_LOOKUP_FAILED", "/v1/project-handles");
      return problem(requestId, 503, "service_unavailable", "Handles are unavailable.", true);
    }
    return json(
      {
        handle,
        available,
        ...(available ? {} : { reason: problemWithShape ?? "taken" }),
        alternatives,
      },
      200,
      requestId,
    );
  });

  app.get("/v1/projects/:project_id/status", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:read",
      responseShape: "project-status",
      invoke: (prepared) => dependencies.productSurface.getProjectStatus(prepared.context),
    }),
  );

  app.post("/v1/projects/:project_id/database/write", (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "database-write",
      mutation: true,
      body: (context, requestId) =>
        parseStrictJsonBody(context, requestId, (value) => {
          try {
            return parseProjectDatabaseWrite(value);
          } catch {
            return null;
          }
        }),
      invoke: (prepared, body) => {
        if (!dependencies.projectDatabaseWrite) throw new Error("Database writes unavailable");
        return dependencies.projectDatabaseWrite({
          ...prepared.context,
          ...prepared.mutation,
          ...body,
        });
      },
    }),
  );

  app.post("/v1/projects/:project_id/database/query", async (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "database-query",
      body: parseProjectDatabaseQueryBody,
      invoke: async (prepared, query) => {
        if (dependencies.projectDatabaseDiagnostics === undefined) {
          throw new Error("Project database diagnostics unavailable");
        }
        const result = await dependencies.projectDatabaseDiagnostics.query({
          ...prepared.context,
          ...query,
        });
        if (result === null) return null;
        return {
          status: 200,
          body: {
            environment: result.environment,
            rows: result.rows,
            row_count: result.rowCount,
            truncated: result.truncated,
          },
        };
      },
    }),
  );

  app.post("/v1/projects/:project_id/database/access", async (context) => {
    const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "database-access-credential",
      body: (bodyContext, requestId) =>
        parseStrictJsonBody(bodyContext, requestId, (value) => {
          try {
            return parseProjectDatabaseAccessRequest(value);
          } catch {
            return null;
          }
        }),
      invoke: async (prepared, request: ProjectDatabaseAccessRequest) => {
        if (!dependencies.projectDatabaseAccess) throw new Error("Database access unavailable");
        const credential = await dependencies.projectDatabaseAccess.issue({
          ...prepared.context,
          ...request,
        });
        return credential === null ? null : { status: 201 as const, body: { ...credential } };
      },
    });
    // The connection URI is returned once and must never be cached by a client or proxy.
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Pragma", "no-cache");
    return response;
  });

  app.get("/v1/projects/:project_id/database/access", (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:read",
      responseShape: "database-access-page",
      body: parseDatabaseAccessQuery,
      invoke: async (prepared, query) => {
        if (!dependencies.projectDatabaseAccess) throw new Error("Database access unavailable");
        const page = await dependencies.projectDatabaseAccess.list({
          ...prepared.context,
          ...query,
        });
        return { status: 200 as const, body: { items: page.items.map((item) => ({ ...item })) } };
      },
    }),
  );

  app.delete("/v1/projects/:project_id/database/access/:access_id", (context) =>
    handleProductSurfaceRequest(context, dependencies, createRequestId, {
      action: "projects:write",
      responseShape: "database-access",
      body: (bodyContext, requestId) =>
        parseUlidParameter(bodyContext, "access_id", "Database access ID", requestId),
      invoke: async (prepared, accessId) => {
        if (!dependencies.projectDatabaseAccess) throw new Error("Database access unavailable");
        const revoked = await dependencies.projectDatabaseAccess.revoke({
          ...prepared.context,
          accessId,
        });
        return revoked === null ? null : { status: 200 as const, body: { ...revoked } };
      },
    }),
  );

  registerProjectDatabaseEventsRoutes(app, dependencies, createRequestId);

  app.get("/v1/projects/:project_id", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    const authenticationResult = await authenticate(context, dependencies);
    if (authenticationResult.outcome === "invalid") {
      return problem(requestId, 401, "unauthenticated", "Authentication is required.");
    }
    if (authenticationResult.outcome === "unavailable") {
      reportFailure(
        dependencies,
        requestId,
        "AUTHENTICATION_UNAVAILABLE",
        "/v1/projects/{project_id}",
      );
      return problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
    }
    const authentication = authenticationResult.authentication;
    const principalLimit = await enforcePrincipalLimits(
      dependencies,
      requestId,
      authentication.principal,
    );
    if (principalLimit !== null) return principalLimit;
    const requestIdError = validateCallerRequestId(context);
    if (requestIdError !== null) return problem(requestId, 400, "invalid_request", requestIdError);
    const projectId = parseRouteUlid(context.req.param("project_id"));
    if (projectId === null) {
      return problem(requestId, 400, "invalid_request", "Project ID is invalid.");
    }
    const visible = await findVisibleProject(dependencies, authentication.principal, projectId);
    if (visible.outcome === "unavailable") {
      reportFailure(
        dependencies,
        requestId,
        "AUTHORIZATION_UNAVAILABLE",
        "/v1/projects/{project_id}",
      );
      return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
    }
    if (visible.outcome === "not_found") {
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    }
    const projectLimit = await enforceLimit(dependencies, requestId, "project", projectId);
    if (projectLimit !== null) return projectLimit;
    const organizationLimit = await enforceLimit(
      dependencies,
      requestId,
      "organization",
      visible.project.organizationId,
    );
    if (organizationLimit !== null) return organizationLimit;
    const body = projectBody(visible.project);
    return json(body, 200, requestId, { ETag: strongResourceEtag(body) });
  });

  app.get("/v1/operations/:operation_id", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    const result = await findVisibleOperation(context, dependencies, requestId);
    if (result.outcome === "rejected") return result.response;
    if (result.outcome === "unauthenticated") {
      return problem(requestId, 401, "unauthenticated", "Authentication is required.");
    }
    if (result.outcome === "invalid") {
      return problem(requestId, 400, "invalid_request", result.detail);
    }
    if (result.outcome === "unavailable") {
      reportFailure(
        dependencies,
        requestId,
        "AUTHENTICATION_OR_AUTHORIZATION_UNAVAILABLE",
        "/v1/operations/{operation_id}",
      );
      return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
    }
    if (result.outcome === "not_found") {
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    }
    const operationLimit = await enforceOperationLimits(dependencies, requestId, result);
    if (operationLimit !== null) return operationLimit;
    const body = operationBody(result.operation);
    if (result.operation.blockingOperationId !== undefined)
      body["blocking_operation_id"] = parseUlid(result.operation.blockingOperationId);
    // A failed deployment is diagnosed from its own logs, which this names in every state.
    if (result.operation.deploymentId !== undefined)
      body["deployment_id"] = parseUlid(result.operation.deploymentId);
    const observation = result.operation.deploymentObservation;
    if (
      observation !== undefined &&
      result.operation.reconciliation === undefined &&
      (result.operation.state === "queued" || result.operation.state === "running")
    ) {
      if (observation.projectId !== result.operation.projectId)
        throw new TypeError("Deployment observation escaped operation scope");
      let phase: DeploymentProgressPhase = observation.phase;
      let mailProgress:
        | import("@ohmyhost/contracts/operation-deployment-result").DeploymentMailProgress
        | undefined;
      if (phase === "publishing" && observation.mailRequired) {
        try {
          const mail = await dependencies.projectMailDomains.get({
            organizationId: result.organizationId,
            projectId: result.operation.projectId,
            principalId: result.principal.actorId,
            requestId,
          });
          phase =
            mail === null
              ? "mail_status_unavailable"
              : mail.status === "ready"
                ? "publishing"
                : "waiting_for_mail";
          if (mail !== null && phase === "waiting_for_mail") {
            mailProgress = {
              domain: mail.domain,
              status: mail.status,
              configured_at: mail.configuredAt,
              dns_records: [...(mail.dnsRecords ?? [])],
              ...(mail.observedAt === undefined ? {} : { observed_at: mail.observedAt }),
              ...(mail.verificationIssue === undefined
                ? {}
                : { verification_issue: mail.verificationIssue }),
              ...(mail.nextCheckAfterSeconds === undefined
                ? {}
                : { next_check_after_seconds: mail.nextCheckAfterSeconds }),
              ...(mail.sending === undefined ? {} : { sending: mail.sending }),
              ...(mail.receiving === undefined ? {} : { receiving: mail.receiving }),
            };
          }
        } catch {
          phase = "mail_status_unavailable";
        }
      }
      const progressInput = {
        ...(observation.buildCompletedAt === undefined
          ? {}
          : { build_completed_at: observation.buildCompletedAt }),
        phase,
        project_id: observation.projectId,
        deployment_id: observation.deploymentId,
        observed_at: dependencies.clock.now().toISOString(),
      };
      if (mailProgress === undefined)
        body["progress"] = createOperationDeploymentProgress(progressInput);
      else {
        try {
          body["progress"] = createOperationDeploymentProgress({
            ...progressInput,
            mail: mailProgress,
          });
        } catch {
          body["progress"] = createOperationDeploymentProgress({
            ...progressInput,
            phase: "mail_status_unavailable",
          });
        }
      }
    }
    return setUsageResponse(json(body, 200, requestId), {
      operationId: validUsageOperationId(result.operation.operationId),
      operationStatus: usageState(result.operation.state),
    });
  });

  app.post("/v1/operations/:operation_id:reconcile", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    // Hono reads `:operation_id:reconcile` as one segment, so a plain POST to /v1/operations/{id} would start reconciliation.
    if (!/^\/v1\/operations\/[^/:]+:reconcile$/u.test(context.req.path))
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    const result = await findVisibleOperation(context, dependencies, requestId);
    if (result.outcome === "rejected") return result.response;
    if (result.outcome === "unauthenticated") {
      return problem(requestId, 401, "unauthenticated", "Authentication is required.");
    }
    if (result.outcome === "invalid") {
      return problem(requestId, 400, "invalid_request", result.detail);
    }
    if (result.outcome === "unavailable") {
      reportFailure(
        dependencies,
        requestId,
        "AUTHENTICATION_OR_AUTHORIZATION_UNAVAILABLE",
        "/v1/operations/{operation_id}:reconcile",
      );
      return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
    }
    if (result.outcome === "not_found") {
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    }
    const operationLimit = await enforceOperationLimits(dependencies, requestId, result);
    if (operationLimit !== null) return operationLimit;
    const idempotencyKey = validatedHeader(
      context,
      requestId,
      "idempotency-key",
      "Idempotency-Key",
      1,
      128,
    );
    if (idempotencyKey instanceof Response) return idempotencyKey;
    if (new URL(context.req.url).search !== "") {
      return problem(requestId, 400, "invalid_request", "Query parameters are not accepted.");
    }
    const body = await readBoundedBody(context.req.raw, 1);
    if (body.outcome !== "ok" || body.text !== "") {
      return problem(requestId, 400, "invalid_request", "A request body is not accepted.");
    }
    const decision = await authorize(
      dependencies,
      result.principal,
      {
        kind: "project",
        organizationId: result.organizationId,
        projectId: result.operation.projectId,
      },
      "operations:reconcile",
    );
    if (decision === "unavailable") {
      return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
    }
    if (decision === "deny") {
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    }
    const idempotencySha256 = `sha256:${createHash("sha256")
      .update(
        `v1\nPOST\n/v1/operations/{operation_id}:reconcile\n${result.organizationId}\n${result.principal.actorId}\n${idempotencyKey}`,
      )
      .digest("hex")}` as const;
    try {
      const reconciliation = await dependencies.providerReconciliation.reconcile({
        organizationId: result.organizationId,
        projectId: result.operation.projectId,
        operationId: result.operation.operationId,
        principalId: result.principal.actorId,
        idempotencySha256,
      });
      const responseBody = providerReconciliationBody(reconciliation, result.operation.operationId);
      return json(responseBody, 202, requestId, {
        Location: `/v1/operations/${result.operation.operationId}`,
      });
    } catch (error) {
      if (error instanceof ProviderReconciliationExhaustedError) {
        return problem(
          requestId,
          409,
          "reconciliation_exhausted",
          "The operation has exhausted its bounded recovery attempts.",
        );
      }
      if (error instanceof ProviderReconciliationUnmatchedError) {
        return problem(
          requestId,
          409,
          "reconciliation_not_pending",
          "No uncertain delivery or provider mutation is pending for this operation.",
        );
      }
      reportFailure(
        dependencies,
        requestId,
        "PROVIDER_RECONCILIATION_UNAVAILABLE",
        "/v1/operations/{operation_id}:reconcile",
      );
      return problem(
        requestId,
        503,
        "service_unavailable",
        "Provider reconciliation is temporarily unavailable.",
        true,
      );
    }
  });

  app.get("/v1/operations/:operation_id/events", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    const result = await findVisibleOperation(context, dependencies, requestId);
    if (result.outcome === "rejected") return result.response;
    if (result.outcome === "unauthenticated") {
      return problem(requestId, 401, "unauthenticated", "Authentication is required.");
    }
    if (result.outcome === "invalid") {
      return problem(requestId, 400, "invalid_request", result.detail);
    }
    if (result.outcome === "unavailable") {
      reportFailure(
        dependencies,
        requestId,
        "AUTHENTICATION_OR_AUTHORIZATION_UNAVAILABLE",
        "/v1/operations/{operation_id}/events",
      );
      return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
    }
    if (result.outcome === "not_found") {
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    }
    const operationLimit = await enforceOperationLimits(dependencies, requestId, result);
    if (operationLimit !== null) return operationLimit;
    const lastEventId = context.req.header("last-event-id");
    if (
      lastEventId !== undefined &&
      !result.operation.events.some((event) => event.eventId === lastEventId)
    ) {
      return problem(requestId, 400, "invalid_request", "Last-Event-ID is invalid.");
    }
    return new Response(
      operationEventStream(dependencies, result, context.req.raw.signal, lastEventId, requestId),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Request-Id": requestId,
        },
      },
    );
  });

  app.get("/v1/audit-events", async (context) => {
    const requestId = requestIdFor(context, createRequestId);
    const baseLimit = await enforceBaseLimits(
      dependencies,
      requestId,
      context.req.header("cf-connecting-ip"),
    );
    if (baseLimit !== null) return baseLimit;
    const authenticationResult = await authenticate(context, dependencies);
    if (authenticationResult.outcome === "invalid") {
      return problem(requestId, 401, "unauthenticated", "Authentication is required.");
    }
    if (authenticationResult.outcome === "unavailable") {
      reportFailure(dependencies, requestId, "AUTHENTICATION_UNAVAILABLE", "/v1/audit-events");
      return problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
    }
    const authentication = authenticationResult.authentication;
    const principalLimit = await enforcePrincipalLimits(
      dependencies,
      requestId,
      authentication.principal,
    );
    if (principalLimit !== null) return principalLimit;
    const requestIdError = validateCallerRequestId(context);
    if (requestIdError !== null) return problem(requestId, 400, "invalid_request", requestIdError);
    const requestedOrganization = context.req.query("organization_id");
    const parsedOrganization =
      requestedOrganization === undefined ? undefined : parseRouteUlid(requestedOrganization);
    if (parsedOrganization === null) {
      return problem(requestId, 400, "invalid_request", "Organization is invalid.");
    }
    const organizationId =
      parsedOrganization ??
      authentication.principal.selectedOrganizationId ??
      (authentication.principal.organizationIds.length === 1
        ? authentication.principal.organizationIds[0]
        : undefined);
    if (
      organizationId !== undefined &&
      !authentication.principal.organizationIds.includes(organizationId)
    ) {
      return problem(requestId, 403, "forbidden", "An active organization is required.");
    }
    if (organizationId === undefined) {
      return problem(requestId, 403, "forbidden", "An active organization is required.");
    }
    const organizationLimit = await enforceLimit(
      dependencies,
      requestId,
      "organization",
      organizationId,
    );
    if (organizationLimit !== null) return organizationLimit;
    const authorization = await authorize(
      dependencies,
      authentication.principal,
      { kind: "organization", organizationId },
      "audit:read",
    );
    if (authorization === "unavailable") {
      reportFailure(dependencies, requestId, "AUDIT_AUTHORIZATION_UNAVAILABLE", "/v1/audit-events");
      return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
    }
    if (authorization === "deny") {
      return problem(requestId, 403, "forbidden", "The requested action is not allowed.");
    }
    const filters = parseAuditFilters(context);
    if (filters === null) {
      return problem(requestId, 400, "invalid_request", "Audit query parameters are invalid.");
    }
    if (filters.projectId !== undefined) {
      const decision = await authorize(
        dependencies,
        authentication.principal,
        { kind: "project", organizationId, projectId: filters.projectId },
        "audit:read",
      );
      if (decision === "unavailable") {
        reportFailure(
          dependencies,
          requestId,
          "AUDIT_AUTHORIZATION_UNAVAILABLE",
          "/v1/audit-events",
        );
        return problem(
          requestId,
          503,
          "service_unavailable",
          "Authorization is unavailable.",
          true,
        );
      }
      if (decision === "deny") {
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      }
      const projectLimit = await enforceLimit(
        dependencies,
        requestId,
        "project",
        filters.projectId,
      );
      if (projectLimit !== null) return projectLimit;
    }
    if (filters.operationId !== undefined) {
      const operation = await dependencies.persistence.getOperation(
        organizationId,
        filters.operationId,
      );
      if (
        operation === null ||
        (filters.projectId !== undefined && filters.projectId !== operation.projectId)
      ) {
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      }
      const decision = await authorize(
        dependencies,
        authentication.principal,
        { kind: "project", organizationId, projectId: operation.projectId },
        "audit:read",
      );
      if (decision === "unavailable") {
        reportFailure(
          dependencies,
          requestId,
          "AUDIT_AUTHORIZATION_UNAVAILABLE",
          "/v1/audit-events",
        );
        return problem(
          requestId,
          503,
          "service_unavailable",
          "Authorization is unavailable.",
          true,
        );
      }
      if (decision === "deny") {
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      }
      if (filters.projectId === undefined) {
        const projectLimit = await enforceLimit(
          dependencies,
          requestId,
          "project",
          operation.projectId,
        );
        if (projectLimit !== null) return projectLimit;
      }
    }
    try {
      const projectIds = authentication.principal.authorizationRestriction?.projectIds;
      const page = await dependencies.persistence.readAuditEvents({
        organizationId,
        ...filters,
        ...(projectIds === undefined ? {} : { projectIds }),
      });
      if (
        page.events.some(
          (event) =>
            event.organizationId !== organizationId ||
            (projectIds !== undefined && !projectIds.includes(event.projectId)) ||
            (filters.projectId !== undefined && event.projectId !== filters.projectId) ||
            (filters.operationId !== undefined && event.operationId !== filters.operationId),
        )
      ) {
        throw new TypeError("Audit persistence result escaped its requested scope");
      }
      if (page.nextCursor !== null && !/^[A-Za-z0-9_-]+$/u.test(page.nextCursor)) {
        throw new TypeError("Audit next cursor is invalid");
      }
      return json(
        {
          items: page.events.map(auditEventBody),
          ...(page.nextCursor === null ? {} : { next_cursor: page.nextCursor }),
        },
        200,
        requestId,
      );
    } catch (error) {
      if (error instanceof TypeError && error.message === "Invalid audit cursor") {
        return problem(requestId, 400, "invalid_request", "Audit cursor is invalid.");
      }
      reportFailure(dependencies, requestId, "AUDIT_READ_FAILED", "/v1/audit-events");
      return problem(requestId, 503, "service_unavailable", "Audit data is unavailable.", true);
    }
  });

  app.notFound((context) =>
    problem(
      requestIdFor(context, createRequestId),
      404,
      "resource_not_found",
      "Resource not found.",
    ),
  );
  app.onError((_error, context) => {
    const requestId = requestIdFor(context, createRequestId);
    reportFailure(
      dependencies,
      requestId,
      "UNEXPECTED_APPLICATION_FAILURE",
      safeRouteLabel(context.req.path),
    );
    return problem(
      requestId,
      503,
      "service_unavailable",
      "The service is temporarily unavailable.",
      true,
    );
  });

  return app;
}

interface PreparedProductRequest {
  readonly principal: AuthenticatedPrincipal;
  readonly context: ProductSurfaceContext;
  readonly project: ProjectView;
  readonly mutation: {
    readonly idempotencyKey: string;
    readonly canonicalRequestDigest: Uint8Array;
  };
  readonly destructive: { readonly ifMatch: string; readonly confirmationToken: string };
  /** The If-Match the caller sent; empty unless the route is guarded or destructive. */
  readonly ifMatch: string;
}

/** `limit` is the only accepted query parameter: one to one hundred runs, fifty by default. */
function parseFunctionRunLimit(context: Context): number | null {
  const url = new URL(context.req.url);
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "limit") || url.searchParams.getAll("limit").length > 1) {
    return null;
  }
  const raw = url.searchParams.get("limit");
  if (raw === null) return 50;
  if (!/^[1-9][0-9]{0,2}$/u.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= 100 ? limit : null;
}

/** Re-validates the port output so a malformed run never reaches a customer. */
function functionRunBody(run: FunctionRunView): Record<string, unknown> {
  const timestamp = (value: string | null) =>
    value === null || new Date(value).toISOString() === value;
  if (
    !/^[0-9A-Z]{26}$/u.test(String(run.id)) ||
    !/^[0-9A-Z]{26}$/u.test(String(run.deployment_id)) ||
    typeof run.cron !== "string" ||
    run.cron.length > 64 ||
    !["due", "running", "retry", "succeeded", "failed", "skipped"].includes(run.state) ||
    !Number.isSafeInteger(run.attempt) ||
    run.attempt < 0 ||
    run.attempt > 3 ||
    !(
      run.status_code === null ||
      (Number.isSafeInteger(run.status_code) && run.status_code >= 100 && run.status_code <= 599)
    ) ||
    new Date(run.scheduled_at).toISOString() !== run.scheduled_at ||
    !timestamp(run.started_at) ||
    !timestamp(run.finished_at)
  ) {
    throw new TypeError("Function run view is invalid");
  }
  return {
    id: run.id,
    deployment_id: run.deployment_id,
    cron: run.cron,
    scheduled_at: run.scheduled_at,
    state: run.state,
    attempt: run.attempt,
    status_code: run.status_code,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
}

interface PreparedEnvironmentSecretRequest {
  readonly context: EnvironmentSecretContext;
  readonly mutation: {
    readonly idempotencyKey: string;
    readonly canonicalRequestDigest: Uint8Array;
  };
}

/** Product commands carry the accepted authority, never DNS-only proof metadata. */
function acceptedDelegation(
  proof:
    | NonNullable<ProductSurfaceContext["delegation"]>
    | NonNullable<Awaited<ReturnType<NonNullable<ControlApiDependencies["remoteDelegation"]>>>>,
  action: AuthorizationAction,
): NonNullable<ProductSurfaceContext["delegation"]> {
  return {
    grantId: proof.grantId,
    clientId: proof.clientId,
    consentHash: proof.consentHash,
    action,
    ...(proof.authorizationRestriction === undefined
      ? {}
      : { authorizationRestriction: proof.authorizationRestriction }),
  };
}

async function handleSharedMailRequest(
  context: Context,
  dependencies: ControlApiDependencies,
  createRequestId: () => string,
  options: SharedMailRequestOptions,
): Promise<Response> {
  const requestId = requestIdFor(context, createRequestId);
  const limited = await enforceBaseLimits(
    dependencies,
    requestId,
    context.req.header("cf-connecting-ip"),
  );
  if (limited) return limited;
  const authentication = await authenticate(context, dependencies);
  if (authentication.outcome !== "authenticated")
    return problem(
      requestId,
      authentication.outcome === "invalid" ? 401 : 503,
      authentication.outcome === "invalid" ? "unauthenticated" : "service_unavailable",
      "Authentication is required.",
    );
  const principal = authentication.authentication.principal;
  const principalLimit = await enforcePrincipalLimits(dependencies, requestId, principal);
  if (principalLimit) return principalLimit;
  if (validateCallerRequestId(context) || new URL(context.req.url).search)
    return problem(
      requestId,
      400,
      "invalid_request",
      "Use the documented resource path without query parameters.",
    );
  const projectId =
    options.scope === "project" ? parseRouteUlid(context.req.param("project_id") ?? "") : null;
  const environmentId =
    context.req.param("environment_id") === undefined
      ? undefined
      : parseRouteUlid(context.req.param("environment_id") ?? "");
  const mailDomainId =
    options.scope === "mail_domain"
      ? parseRouteUlid(context.req.param("mail_domain_id") ?? "")
      : null;
  let organizationId =
    options.scope === "project" ? null : parseRouteUlid(context.req.param("organization_id") ?? "");
  if (
    (options.scope === "project" && !projectId) ||
    (options.scope === "mail_domain" && !mailDomainId) ||
    environmentId === null ||
    (options.scope !== "project" && !organizationId)
  )
    return problem(requestId, 400, "invalid_request", "Resource ID is invalid.");
  if (projectId) {
    const visible = await findVisibleProject(dependencies, principal, projectId);
    if (visible.outcome !== "found")
      return problem(
        requestId,
        visible.outcome === "unavailable" ? 503 : 404,
        visible.outcome === "unavailable" ? "service_unavailable" : "resource_not_found",
        "Resource unavailable.",
      );
    organizationId = visible.project.organizationId;
    const projectLimit = await enforceLimit(dependencies, requestId, "project", projectId);
    if (projectLimit) return projectLimit;
  }
  if (!organizationId || !principal.organizationIds.includes(organizationId))
    return problem(requestId, 404, "resource_not_found", "Resource not found.");
  const orgLimit = await enforceLimit(dependencies, requestId, "organization", organizationId);
  if (orgLimit) return orgLimit;
  const resource: AuthorizationResource = projectId
    ? { kind: "project", organizationId, projectId, ...(environmentId ? { environmentId } : {}) }
    : mailDomainId
      ? { kind: "mail_domain", organizationId, mailDomainId }
      : { kind: "organization", organizationId };
  const decision = await authorize(dependencies, principal, resource, options.action);
  if (decision !== "allow")
    return problem(
      requestId,
      decision === "unavailable" ? 503 : 404,
      decision === "unavailable" ? "service_unavailable" : "resource_not_found",
      "Resource unavailable.",
    );
  const idempotencyKey = options.mutation
    ? validatedHeader(context, requestId, "idempotency-key", "Idempotency-Key", 1, 128)
    : undefined;
  if (idempotencyKey instanceof Response) return idempotencyKey;
  // The Core stores shared-mail keys only in this charset; any other key is refused here, before a port call.
  if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/u.test(idempotencyKey))
    return problem(requestId, 400, "invalid_request", "Idempotency-Key is invalid.");
  const canonicalRequestDigest = createHash("sha256")
    .update(
      `v1\n${context.req.method}\n${context.req.path}\n${organizationId}\n${principal.actorId}\n${canonicalJson(options.body)}`,
    )
    .digest();
  try {
    const selectedDomainIds = principal.authorizationRestriction?.mailDomainIds;
    let delegation:
      | {
          readonly grantId: string;
          readonly clientId: string;
          readonly consentHash: string;
          readonly grantRevision?: number;
          readonly action: AuthorizationAction;
          readonly authorizationRestriction?: import("@ohmyhost/platform").AuthorizationRestriction;
        }
      | undefined;
    if (principal.connectUser !== undefined && options.mutation) {
      const current = projectId
        ? await dependencies.remoteDelegation?.(principal, projectId)
        : mailDomainId
          ? await dependencies.remoteMailDomainDelegation?.(principal, organizationId, mailDomainId)
          : undefined;
      if ((projectId || mailDomainId) && !current)
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      delegation = current
        ? {
            grantId: current.grantId,
            clientId: current.clientId,
            consentHash: current.consentHash,
            ...(current.authorizationRestriction === undefined
              ? {}
              : { authorizationRestriction: current.authorizationRestriction }),
            action: options.action,
            ...(current.grantRevision === undefined
              ? {}
              : { grantRevision: current.grantRevision }),
          }
        : undefined;
    }
    const authorizeDomain = async (
      rawId: string,
      action: "mail-domains:read" | "mail-domains:use",
    ) => {
      const domainId = parseRouteUlid(rawId);
      if (!domainId) return false;
      const domainDecision = await authorize(
        dependencies,
        principal,
        { kind: "mail_domain", organizationId, mailDomainId: domainId },
        action,
      );
      if (domainDecision === "unavailable") throw new Error("authorization_unavailable");
      return domainDecision === "allow";
    };
    const result = await options.invoke(
      {
        organizationId,
        principalId: principal.actorId,
        requestId,
        ...(delegation ? { delegation } : {}),
        ...(projectId ? { projectId } : {}),
        ...(environmentId ? { environmentId } : {}),
        ...(mailDomainId ? { mailDomainId } : {}),
        ...(idempotencyKey ? { idempotencyKey, canonicalRequestDigest } : {}),
      },
      authorizeDomain,
      selectedDomainIds,
    );
    if (result === null)
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    assertSharedMailResponse(result, {
      action: options.responseAction,
      organizationId,
      ...(projectId ? { projectId } : {}),
      ...(environmentId ? { environmentId } : {}),
      ...(mailDomainId ? { mailDomainId } : {}),
      ...(typeof options.body["mail_domain_id"] === "string"
        ? { mailDomainId: options.body["mail_domain_id"] }
        : {}),
    });
    return json(result, 200, requestId);
  } catch (error) {
    if (error instanceof ManagedMailPortError)
      return problem(requestId, error.status, error.code, error.message, error.retryable);
    reportFailure(
      dependencies,
      requestId,
      "SHARED_MAIL_UNAVAILABLE",
      safeRouteLabel(context.req.path),
    );
    return problem(
      requestId,
      503,
      "service_unavailable",
      "Mail management is temporarily unavailable.",
      true,
    );
  }
}

async function handleEnvironmentSecretRequest(
  context: Context,
  dependencies: ControlApiDependencies,
  createRequestId: () => string,
  options: {
    readonly action:
      | "auth:read"
      | "auth:manage"
      | "secrets:read"
      | "secrets:write"
      | "secrets:delete"
      | "logs:read"
      | "projects:read"
      | "projects:write";
    readonly mutation?: boolean;
    readonly canonicalValue: unknown;
    readonly invoke: (prepared: PreparedEnvironmentSecretRequest) => Promise<Response>;
  },
): Promise<Response> {
  const requestId = requestIdFor(context, createRequestId);
  const baseLimit = await enforceBaseLimits(
    dependencies,
    requestId,
    context.req.header("cf-connecting-ip"),
  );
  if (baseLimit !== null) return baseLimit;
  const authenticationResult = await authenticate(context, dependencies);
  if (authenticationResult.outcome === "invalid")
    return problem(requestId, 401, "unauthenticated", "Authentication is required.");
  if (authenticationResult.outcome === "unavailable")
    return problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
  const principal = authenticationResult.authentication.principal;
  const principalLimit = await enforcePrincipalLimits(dependencies, requestId, principal);
  if (principalLimit !== null) return principalLimit;
  const requestIdError = validateCallerRequestId(context);
  if (requestIdError !== null) return problem(requestId, 400, "invalid_request", requestIdError);
  const rawProjectId = context.req.param("project_id");
  const rawEnvironmentId = context.req.param("environment_id");
  const projectId = rawProjectId === undefined ? null : parseRouteUlid(rawProjectId);
  const environmentId = rawEnvironmentId === undefined ? null : parseRouteUlid(rawEnvironmentId);
  if (projectId === null || environmentId === null)
    return problem(requestId, 400, "invalid_request", "Project or environment ID is invalid.");
  const idempotencyKey =
    options.mutation === true
      ? validatedHeader(context, requestId, "idempotency-key", "Idempotency-Key", 1, 128)
      : "";
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const visible = await findVisibleProject(dependencies, principal, projectId, {
    action: options.action,
    environmentId,
  });
  if (visible.outcome === "unavailable")
    return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
  if (visible.outcome === "not_found")
    return problem(requestId, 404, "resource_not_found", "Resource not found.");
  const projectLimit = await enforceLimit(dependencies, requestId, "project", projectId);
  if (projectLimit !== null) return projectLimit;
  const organizationLimit = await enforceLimit(
    dependencies,
    requestId,
    "organization",
    visible.project.organizationId,
  );
  if (organizationLimit !== null) return organizationLimit;
  const decision = await authorize(
    dependencies,
    principal,
    {
      kind: "project",
      organizationId: visible.project.organizationId,
      projectId,
      environmentId,
    },
    options.action,
  );
  if (decision === "unavailable")
    return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
  if (decision === "deny")
    return problem(requestId, 404, "resource_not_found", "Resource not found.");
  const canonicalRequestDigest = createHash("sha256")
    .update(
      `v1\n${context.req.method}\n${context.req.path}\n${visible.project.organizationId}\n${principal.actorId}\n${canonicalJson(options.canonicalValue)}`,
    )
    .digest();
  try {
    const handoff = principal.handoffDelegation;
    const proof = options.mutation
      ? (handoff ??
        (principal.connectUser === undefined
          ? undefined
          : await dependencies.remoteDelegation?.(principal, projectId)))
      : undefined;
    if (options.mutation && principal.connectUser !== undefined && !proof)
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    return await options.invoke({
      context: {
        organizationId: visible.project.organizationId,
        projectId,
        environmentId,
        principalId: principal.actorId,
        requestId,
        ...(proof ? { delegation: handoff ?? acceptedDelegation(proof, options.action) } : {}),
      },
      mutation: { idempotencyKey, canonicalRequestDigest },
    });
  } catch (error) {
    if (error instanceof NativeAuthManagementError)
      return nativeAuthRefusalProblem(requestId, error.code);
    if (error instanceof ManagedMailPortError)
      return problem(requestId, error.status, error.code, error.message, error.retryable);
    if (error instanceof IdempotencyKeyReusedError) {
      return problem(
        requestId,
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for another request.",
      );
    }
    if (error instanceof EnvironmentSecretNotInstalledError)
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    if (error instanceof EnvironmentSecretMutationBlockedError) {
      return problem(
        requestId,
        409,
        "environment_secret_mutation_blocked",
        "Environment secrets cannot change while a deployment or rollback is active.",
        true,
      );
    }
    reportFailure(
      dependencies,
      requestId,
      "ENVIRONMENT_SECRET_UNAVAILABLE",
      safeRouteLabel(context.req.path),
    );
    return problem(
      requestId,
      503,
      "service_unavailable",
      "Environment secret storage is temporarily unavailable.",
      true,
    );
  }
}

/** One public problem per typed Native Auth refusal; none of them is retryable and none is a secret-storage failure. */
function nativeAuthRefusalProblem(requestId: string, refusal: NativeAuthRefusal): Response {
  switch (refusal) {
    case "scope":
    case "not_found":
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    case "idempotency":
      return problem(
        requestId,
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for another request.",
      );
    case "revision":
      return problem(
        requestId,
        409,
        "native_auth_revision_conflict",
        "The Native Auth state changed. Read it, then repeat the change with its current configurationRevision and a new idempotency key.",
      );
    case "provider_incomplete":
      return problem(
        requestId,
        409,
        "native_auth_provider_incomplete",
        "This sign-in provider needs its client ID and client secret before it can be enabled.",
      );
    case "conflict":
      return problem(
        requestId,
        409,
        "native_user_conflict",
        "The Native Auth user conflicts with current state.",
      );
    case "launch_unavailable":
      return problem(
        requestId,
        409,
        "native_auth_launch_unavailable",
        "Native Auth cannot launch for this project until its readiness is complete.",
      );
    case "provider_unavailable":
      return problem(
        requestId,
        409,
        "native_auth_provider_unavailable",
        "This sign-in provider cannot be enabled for the project's current Native Auth state.",
      );
    case "epoch_exhausted":
      return problem(
        requestId,
        409,
        "native_auth_epoch_exhausted",
        "This project's Native Auth policy has reached its revision limit.",
      );
    case "origin_unapproved":
      return problem(
        requestId,
        400,
        "invalid_request",
        "The canonical origin is not approved for Native Auth.",
      );
    case "paths_invalid":
      return problem(
        requestId,
        400,
        "invalid_request",
        "The Native Auth redirect paths are invalid.",
      );
  }
}

function validSecretName(value: string | undefined, action: "set" | "delete"): string | null {
  return isUserSecretName(value, action) ? value : null;
}

// A name in the shared pattern that the reserved rules refuse is a reserved name, not a malformed one.
function secretNameProblem(value: string | undefined): string {
  return value !== undefined && USER_SECRET_NAME_PATTERN.test(value)
    ? "Secret name is reserved."
    : "Secret name is invalid.";
}

function environmentSecretBody(
  secret: EnvironmentSecretMetadataView & RuntimeSecretDeliveryMetadataView,
): Record<string, unknown> {
  if (
    !SECRET_NAME_PATTERN.test(secret.name) ||
    !Number.isSafeInteger(secret.revision) ||
    secret.revision < 1 ||
    !Number.isSafeInteger(secret.keyVersion) ||
    secret.keyVersion < 1
  ) {
    throw new TypeError("Environment secret metadata is invalid");
  }
  assertCanonicalTimestamp(secret.createdAt, "Environment secret created_at");
  assertCanonicalTimestamp(secret.updatedAt, "Environment secret updated_at");
  return {
    name: secret.name,
    revision: secret.revision,
    key_version: secret.keyVersion,
    created_at: secret.createdAt,
    updated_at: secret.updatedAt,
    ...runtimeSecretDeliveryBody(secret),
  };
}

function runtimeSecretDeliveryBody(
  secret: RuntimeSecretDeliveryMetadataView,
): Record<string, unknown> {
  if (
    !Number.isSafeInteger(secret.desiredGeneration) ||
    secret.desiredGeneration < 0 ||
    !Number.isSafeInteger(secret.appliedGeneration) ||
    secret.appliedGeneration < 0 ||
    secret.appliedGeneration > secret.desiredGeneration ||
    !["not_deployed", "pending", "ready", "failed"].includes(secret.state) ||
    (secret.runtimeProvider !== null && secret.runtimeProvider !== "wfp") ||
    !Number.isSafeInteger(secret.appliedSecretCount) ||
    secret.appliedSecretCount < 0 ||
    secret.appliedSecretCount > 100 ||
    (secret.lastError !== null && !/^[A-Z][A-Z0-9_]{0,63}$/u.test(secret.lastError))
  ) {
    throw new TypeError("Runtime secret delivery metadata is invalid");
  }
  return {
    desired_generation: secret.desiredGeneration,
    applied_generation: secret.appliedGeneration,
    delivery_state: secret.state,
    runtime_provider: secret.runtimeProvider,
    applied_secret_count: secret.appliedSecretCount,
    last_error: secret.lastError,
  };
}

type ParsedInput<T> =
  | { readonly outcome: "ok"; readonly value: T; readonly canonicalValue: unknown }
  | { readonly outcome: "error"; readonly response: Response };

type ProductResponseShape =
  | "preview"
  | "managed-source-files"
  | "managed-source-versions"
  | "managed-source-diff"
  | "managed-source-upload"
  | "managed-source-blob"
  | "database-compute"
  | "project-context"
  | "project-notes"
  | "project-export"
  | "project-export-download-link"
  | "credit-budget"
  | "operation"
  | "source"
  | "source-binding"
  | "github-authorization"
  | "auto-deploy"
  | "deployment-plan"
  | "deployment-page"
  | "deployment"
  | "rollback-plan"
  | "promotion-plan"
  | "delete-plan"
  | "data-change-plan"
  | "cloudflare-authorization"
  | "cloudflare-dns-status"
  | "project-status"
  | "dev-access-ticket"
  | "dev-access-state"
  | "powered-by-flag"
  | "database-write"
  | "database-table"
  | "database-query"
  | "database-access"
  | "database-access-credential"
  | "database-access-page"
  | DatabaseEventShape
  | "paid-domain-plan"
  | "paid-domain"
  | "diagnostic-page";

async function handleProductSurfaceRequest<T = undefined>(
  context: Context,
  dependencies: ControlApiDependencies,
  createRequestId: () => string,
  options: {
    readonly action: AuthorizationAction;
    readonly responseShape: ProductResponseShape;
    readonly mutation?: boolean;
    readonly destructive?: boolean;
    /** Requires If-Match without a confirmation token: the caller acts on the state it read. */
    readonly guarded?: boolean;
    readonly requireEtag?: boolean;
    readonly body?: (
      context: Context,
      requestId: string,
    ) => Promise<ParsedInput<T>> | ParsedInput<T>;
    readonly invoke: (
      prepared: PreparedProductRequest,
      body: T,
    ) => Promise<ProductSurfaceResult | null>;
  },
): Promise<Response> {
  const requestId = requestIdFor(context, createRequestId);
  const baseLimit = await enforceBaseLimits(
    dependencies,
    requestId,
    context.req.header("cf-connecting-ip"),
  );
  if (baseLimit !== null) return baseLimit;
  const authenticationResult = await authenticate(context, dependencies);
  if (authenticationResult.outcome === "invalid") {
    return problem(requestId, 401, "unauthenticated", "Authentication is required.");
  }
  if (authenticationResult.outcome === "unavailable") {
    return problem(requestId, 503, "service_unavailable", "Authentication is unavailable.", true);
  }
  const principal = authenticationResult.authentication.principal;
  const principalLimit = await enforcePrincipalLimits(dependencies, requestId, principal);
  if (principalLimit !== null) return principalLimit;
  const requestIdError = validateCallerRequestId(context);
  if (requestIdError !== null) return problem(requestId, 400, "invalid_request", requestIdError);
  const rawProjectId = /^\/v1\/projects\/([^/:]+)/u.exec(context.req.path)?.[1];
  const projectId = rawProjectId === undefined ? null : parseRouteUlid(rawProjectId);
  if (projectId === null)
    return problem(requestId, 400, "invalid_request", "Project ID is invalid.");
  const idempotencyKey =
    options.mutation === true
      ? validatedHeader(context, requestId, "idempotency-key", "Idempotency-Key", 1, 128)
      : "";
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const ifMatch =
    options.destructive === true || options.guarded === true
      ? validatedHeader(context, requestId, "if-match", "If-Match", 3, 128)
      : "";
  if (ifMatch instanceof Response) return ifMatch;
  const confirmationToken =
    options.destructive === true ? validatedConfirmationToken(context, requestId) : "";
  if (confirmationToken instanceof Response) return confirmationToken;
  const visible = await findVisibleProject(dependencies, principal, projectId, {
    action: options.action,
  });
  if (visible.outcome === "unavailable") {
    return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
  }
  if (visible.outcome === "not_found") {
    return problem(requestId, 404, "resource_not_found", "Resource not found.");
  }
  const projectLimit = await enforceLimit(dependencies, requestId, "project", projectId);
  if (projectLimit !== null) return projectLimit;
  const organizationLimit = await enforceLimit(
    dependencies,
    requestId,
    "organization",
    visible.project.organizationId,
  );
  if (organizationLimit !== null) return organizationLimit;
  const decision = await authorize(
    dependencies,
    principal,
    { kind: "project", organizationId: visible.project.organizationId, projectId },
    options.action,
  );
  if (decision === "unavailable") {
    return problem(requestId, 503, "service_unavailable", "Authorization is unavailable.", true);
  }
  if (decision === "deny")
    return problem(requestId, 404, "resource_not_found", "Resource not found.");
  // The body is read only now, after project visibility, the limiters and the action were decided for this caller.
  const parsed =
    options.body === undefined
      ? ({ outcome: "ok", value: undefined, canonicalValue: null } as ParsedInput<T>)
      : await options.body(context, requestId);
  if (parsed.outcome === "error") return parsed.response;
  let delegation:
    | Awaited<ReturnType<NonNullable<ControlApiDependencies["remoteDelegation"]>>>
    | undefined;
  try {
    delegation =
      principal.handoffDelegation ??
      (principal.connectUser === undefined
        ? undefined
        : await dependencies.remoteDelegation?.(principal, projectId));
  } catch {
    return problem(
      requestId,
      503,
      "service_unavailable",
      "Client project authorization is unavailable.",
      true,
    );
  }
  if (principal.connectUser !== undefined && (delegation === undefined || delegation === null))
    return problem(requestId, 404, "resource_not_found", "Resource not found.");
  const canonicalRequestDigest = createHash("sha256")
    .update(
      `v1\n${context.req.method}\n${context.req.path}\n${visible.project.organizationId}\n${principal.actorId}\n${canonicalJson(parsed.canonicalValue)}`,
    )
    .digest();
  try {
    const result = await options.invoke(
      {
        principal,
        context: {
          organizationId: visible.project.organizationId,
          projectId,
          principalId: principal.actorId,
          requestId,
          ...(delegation === undefined || delegation === null
            ? {}
            : { delegation: acceptedDelegation(delegation, options.action) }),
        },
        project: visible.project,
        mutation: { idempotencyKey, canonicalRequestDigest },
        destructive: { ifMatch, confirmationToken },
        ifMatch,
      },
      parsed.value,
    );
    if (result === null)
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    return productSurfaceResponse(
      result,
      requestId,
      options.requireEtag === true,
      options.responseShape,
    );
  } catch (error) {
    if (options.responseShape === "preview" && error instanceof Error) {
      if (
        error.message === "preview_scope_unavailable" ||
        error.message === "preview_scope_changed"
      )
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      if (error.message === "preview_version_conflict")
        return problem(
          requestId,
          409,
          "preview_version_conflict",
          "The preview changed. Retry this request with the same idempotency key.",
          true,
        );
      if (error.message === "preview_request_superseded")
        return problem(
          requestId,
          409,
          "idempotency_key_reused",
          "This key belongs to an earlier preview change.",
        );
    }
    if (error instanceof ManagedSourceReservationError) {
      if (error.kind === "scope")
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      if (error.kind === "limit")
        return problem(
          requestId,
          413,
          "source_snapshot_too_large",
          "This upload already reserved its 8 MiB or 2,000 file source budget.",
        );
      if (error.kind === "expired")
        return problem(requestId, 409, "source_upload_expired", "Start a fresh source upload.");
      return problem(
        requestId,
        409,
        error.kind === "commit"
          ? "source_commit_conflict"
          : error.kind === "generation"
            ? "source_generation_conflict"
            : "source_upload_conflict",
        "The upload admission belongs to an earlier source version or different file identity.",
      );
    }
    if (error instanceof ManagedSourceInitializationError) {
      if (error.kind === "scope")
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      return problem(
        requestId,
        409,
        "source_upload_conflict",
        "Read the source initialization and its existing operation before submitting a new request.",
      );
    }
    if (error instanceof ManagedSourceSurfaceError) {
      if (error.status === 404)
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      return problem(requestId, error.status, error.code, error.message);
    }
    if (error instanceof ManagedSourceConflictError) {
      if (error.kind === "scope")
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      if (error.kind === "idempotency")
        return problem(
          requestId,
          409,
          "idempotency_key_reused",
          "This key belongs to a different source request.",
        );
      const sourceConflictCode = {
        generation: "source_generation_conflict",
        commit: "source_commit_conflict",
        expired: "source_upload_expired",
        manifest: "source_snapshot_invalid",
        operation: "source_upload_conflict",
        state: "source_upload_conflict",
        candidate: "source_upload_conflict",
      } as const;
      return problem(
        requestId,
        409,
        sourceConflictCode[error.kind],
        "Read the source and this upload's existing operation before submitting a new request.",
      );
    }
    if (error instanceof DevShareRotationConflictError)
      return problem(
        requestId,
        409,
        "idempotency_key_reused",
        "This rotation key belongs to an older Dev link.",
      );
    if (error instanceof GithubConnectionRequiredError)
      return problem(
        requestId,
        error.code === "repository_not_installed" ? 403 : 409,
        error.code,
        error.code === "repository_not_installed"
          ? `Add the repository to the GitHub installation at ${error.settingsUrl ?? "the installation settings"}, then repeat this link request.`
          : "Connect GitHub once for this workspace with github connect, then repeat this link request.",
      );
    if (error instanceof ProjectDatabaseWriteError) {
      if (error.code === "scope")
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      if (error.code === "paid_plan_required")
        return problem(
          requestId,
          402,
          "paid_plan_required",
          "This database is suspended because its organization has no active Paid plan, so the write was not accepted. Restore Paid coverage, then retry. Existing data was not changed.",
        );
      return problem(
        requestId,
        409,
        error.code === "idempotency" ? "idempotency_key_reused" : "database_write_pending",
        error.code === "idempotency"
          ? "This key belongs to a different database write."
          : "A database write is in progress. Poll its existing operation before transfer or deletion.",
      );
    }
    if (error instanceof ProjectDatabaseEventsError)
      return databaseEventsProblem(requestId, error.code);
    if (error instanceof ProjectDatabaseAccessError) {
      if (error.code === "limit")
        return problem(
          requestId,
          409,
          "database_access_limit",
          "At most three active database credentials per environment.",
        );
      if (error.code === "paid_plan_required")
        return problem(
          requestId,
          402,
          "paid_plan_required",
          "This database is suspended because its organization has no active Paid plan, so no credential is issued. Restore Paid coverage, then retry. Existing data was not changed.",
        );
      return problem(requestId, 404, "resource_not_found", "Resource not found.");
    }
    if (error instanceof ProjectComputeChangeError) {
      if (error.code === "compute_paid_required")
        return problem(
          requestId,
          403,
          error.code,
          "Database sizes above 256 MiB require active Paid access.",
        );
      if (error.code === "compute_storage_shrink_requires_migration")
        return problem(
          requestId,
          409,
          error.code,
          "A smaller total database volume requires an explicit data migration. The current database is preserved.",
        );
      if (error.code === "compute_performance_paid_required")
        return problem(
          requestId,
          403,
          error.code,
          "Performance compute requires an active Paid service period and usable credits or credit grace. Ask your agent to check billing and balance, or choose standard.",
        );
      if (error.code === "compute_performance_unavailable")
        return problem(
          requestId,
          503,
          error.code,
          "Performance compute pricing is not active on this platform. Choose standard or report this through feedback.",
        );
      if (error.code === "compute_change_scope_unavailable")
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      return problem(
        requestId,
        409,
        error.code,
        error.code === "compute_change_pending"
          ? "A database size change is still running. Poll its operation before requesting another change, deletion or transfer."
          : "Database configuration changed. Read current compute and the original operation; preserve the database and report unresolved conflicts through feedback.",
      );
    }
    if (error instanceof ProjectNotesConflict) {
      if (error.kind === "scope")
        return problem(requestId, 404, "resource_not_found", "Resource not found.");
      if (error.kind === "idempotency")
        return problem(
          requestId,
          409,
          "idempotency_key_reused",
          "This key was already used for different notes.",
        );
      return problem(
        requestId,
        409,
        "project_notes_conflict",
        "Read the latest project context, merge the notes and retry with its version and a new idempotency key.",
      );
    }
    if (error instanceof PoweredByFlagRequiredError)
      return problem(
        requestId,
        409,
        "powered_by_flag_required",
        "This Free workspace's custom domain is served because the project shows the flag.",
      );
    if (error instanceof PoweredByFlagIdempotencyConflictError)
      return problem(
        requestId,
        409,
        "idempotency_key_reused",
        "This key was already used for a different flag request.",
      );
    if (error instanceof ProjectExportNotReadyError)
      return problem(
        requestId,
        409,
        "project_export_not_ready",
        "The project needs a ready managed database before a SQL export can be accepted.",
      );
    if (error instanceof ProjectExportLinkLimitError) {
      const response = problem(
        requestId,
        429,
        "rate_limited",
        "Download links are limited to six per minute per organization. Retry in a minute.",
        true,
      );
      response.headers.set("Retry-After", "60");
      return response;
    }
    if (error instanceof ProjectRecoveryDailyLimitError) {
      const response = problem(
        requestId,
        429,
        "rate_limited",
        `One export per project is allowed per rolling 24 hours. Retry at ${error.retryAt}.`,
        true,
      );
      response.headers.set(
        "Retry-After",
        String(
          Math.max(
            1,
            Math.ceil((Date.parse(error.retryAt) - dependencies.clock.now().getTime()) / 1000),
          ),
        ),
      );
      const retryAfter = Number(response.headers.get("Retry-After"));
      return new Response(
        JSON.stringify({ ...(await response.json()), retry_after_seconds: retryAfter }),
        { status: response.status, headers: response.headers },
      );
    }
    if (error instanceof GithubAuthorizationRejectedError)
      return problem(
        requestId,
        403,
        "forbidden",
        "A current owner session and matching GitHub authorization are required.",
      );
    if (error instanceof CloudflareZoneNotBoundError)
      return problem(
        requestId,
        409,
        "cloudflare_zone_not_bound",
        "Configure a project domain in this DNS zone before requesting Cloudflare authorization.",
      );
    if (error instanceof CloudflareDnsAuthorizationClosedError)
      return problem(
        requestId,
        409,
        "cloudflare_authorization_closed",
        "This Cloudflare authorization request expired or was already consumed. Read the current DNS authorization before requesting another link.",
      );
    if (error instanceof OrganizationCreditError && error.code === "paid_plan_required")
      return problem(
        requestId,
        402,
        "paid_plan_required",
        "A currently paid organization plan is required to activate project mail, and a customer domain unless the project shows the powered-by flag. Existing resources were not removed.",
      );
    if (error instanceof IdempotencyKeyReusedError) {
      return problem(
        requestId,
        409,
        "idempotency_key_reused",
        "The idempotency key was already used for another request.",
      );
    }
    if (error instanceof OrganizationCreditError && error.code === "credit_request_conflict")
      return problem(
        requestId,
        409,
        "idempotency_key_reused",
        "The idempotency key belongs to a different budget request.",
      );
    if (error instanceof ProjectDomainDeletionRequiredError)
      return problem(requestId, 409, "project_domain_delete_required", error.message);
    if (error instanceof ProductSurfaceConflictError) {
      return problem(
        requestId,
        409,
        error.reason,
        frameworkConversionDetail(error.diagnostic) ?? conflictDetail(error.reason),
      );
    }
    if (
      error instanceof OrganizationCreditError &&
      (error.code === "insufficient_organization_credits" ||
        error.code === "project_budget_exceeded")
    ) {
      return problem(
        requestId,
        402,
        error.code,
        error.code === "project_budget_exceeded"
          ? "The project's stop budget does not permit this work. Raise the budget or select continue."
          : "The organization's available credits and grace period do not permit this work. No new work was started.",
      );
    }
    if (error instanceof ProjectDatabaseQueryRejectedError) {
      return problem(
        requestId,
        400,
        "invalid_request",
        "The read-only diagnostic query could not be executed.",
      );
    }
    // Disagreeing admission policies are a platform fault: the same answer, its own report.
    reportFailure(
      dependencies,
      requestId,
      error instanceof SourceAdmissionPolicyInconsistentError
        ? "SOURCE_ADMISSION_POLICY_INCONSISTENT"
        : "PRODUCT_SURFACE_UNAVAILABLE",
      safeRouteLabel(context.req.path),
    );
    return problem(
      requestId,
      503,
      "service_unavailable",
      "The requested product operation is temporarily unavailable.",
      true,
    );
  }
}

function conflictDetail(reason: ProductSurfaceConflictError["reason"]): string {
  const details: Record<ProductSurfaceConflictError["reason"], string> = {
    development_environment_exists:
      "This project already has a Dev environment. Read project status and use its environment ID.",
    development_environment_missing:
      "This project has only Prod. Select environment prod, or add Dev with 'ohmyhost project dev add'.",
    auto_deploy_source_unavailable:
      "Auto-deploy follows a linked GitHub repository, and this project has none ready. Connect GitHub and link the repository, then enable auto-deploy again.",
    cutover_pending:
      "A database provider cutover of this project is still pending. Wait for it to finish, then repeat the request.",
    project_operation_in_progress:
      "Another change to this project is still running, such as a database write, a compute change or a data change. Wait for it to finish, then repeat the request.",
    source_commit_not_found:
      "The requested commit is not available in the linked GitHub repository; push that commit or plan an available SHA.",
    domain_hostname_taken:
      "A live project connection already holds this hostname; remove that connection before applying it elsewhere.",
    domain_ownership_required:
      "This hostname is not verified for this project yet. Add the _omh-project TXT record that the Paid domain status shows for it, then apply again.",
    domain_dns_conflict:
      "DNS records conflict with this domain connection; unrelated records and records owned by another project were preserved.",
    domain_already_configured:
      "This project already has one Paid domain connection, for another hostname or one configured by another member. Read it with the domain status. Delete it only to replace it, then apply the new hostname again with a new idempotency key.",
    domain_deleting:
      "The Paid domain connection of this project is still being deleted. Wait until its deletion finishes, then apply the hostname again with a new idempotency key.",
    project_domains_conflict:
      "This project's domains belong to another project handle, so they cannot be configured under the current handle. Read the project's current handle, then configure the domains again with a new idempotency key.",
    data_change_blocked:
      "A project operation is still running; wait for its operation result before planning a data change.",
    data_change_in_progress:
      "A data change is running; repeat this request unchanged after its operation finishes.",
    data_change_not_applicable:
      "This change does not apply to the current mode, or returning to shared has no ready Prod database.",
    rollback_target_data_changed:
      "The selected deployment used a data area this environment no longer has; deploy that commit again.",
    native_domain_sync_pending:
      "A previous domain change still needs its Native Auth policy acknowledgement. For a pending custom-domain removal, retry that removal as a current owner. For a pending project-address change, submit a fresh address change as a current owner. Then create a new deletion plan.",
    deployment_plan_expired: "The deployment plan has expired.",
    deployment_plan_incompatible: "The deployment plan must be regenerated before deployment.",
    confirmation_expired: "The confirmation token has expired.",
    confirmation_invalid: "The confirmation token does not match this action.",
    etag_mismatch: "The resource changed after the action was planned.",
    project_handle_invalid:
      "An address is one to five lowercase words of letters and digits, three to fifty-nine characters, and never a reserved word.",
    project_handle_taken: "Another project already uses this address.",
    project_handle_unchanged: "The project already uses this address.",
    project_rename_blocked:
      "A project operation or Native Auth preparation must finish before this address can change.",
    database_limit_reached:
      "The organization already holds the maximum number of live databases; a database-enabled deployment would create another.",
    promotion_source_stale: "The selected dev deployment is no longer the current dev head.",
    promotion_target_stale: "The production head changed after promotion was planned.",
    promotion_invalid_target: "Only a succeeded current dev deployment can be promoted to prod.",
    mail_domain_conflict: "The project already has a different sender domain.",
    mail_domain_required:
      "This app declares mail, so it needs the project's own verified sender domain before planning.",
    storage_jurisdiction_conflict: publicOperationFailure("storage_jurisdiction_conflict").message,
    shared_data_requires_promotion:
      "This project shares one database between Dev and Prod, so Prod only receives promoted Dev deployments.",
    production_deployment_required:
      "This project has no active Prod deployment, so a customer domain has nothing to serve yet.",
    framework_conversion_required:
      "Complete the declared framework adapter contract before planning this deployment.",
    repository_configuration_missing: "The Git repository root must contain ohmyhost.yaml.",
    migration_filename_noncanonical:
      "Rename every PostgreSQL migration to YYYYMMDDHHMMSS_name.sql before planning this deployment.",
    workers_runtime_incompatible:
      "This application imports a native addon or a Node.js API that does not function on Workers.",
  };
  return details[reason];
}

function cloudflareAuthorizationBody(
  value: CloudflareDomainAuthorizationView,
): Record<string, unknown> {
  return {
    authorization_id: value.authorizationId,
    authorization_url: value.authorizationUrl,
    expires_at: value.expiresAt,
  };
}

function cloudflareDnsStatusBody(
  value: CloudflareDnsAuthorizationStatusView,
): Record<string, unknown> {
  return {
    status: value.status,
    zone: value.zone,
    scopes: value.scopes,
    expires_at: value.expiresAt,
  };
}

function productSurfaceResponse(
  result: ProductSurfaceResult,
  requestId: string,
  requireEtag: boolean,
  responseShape: ProductResponseShape,
): Response {
  const expectsOperation = responseShape === "operation";
  const databaseWrite = responseShape === "database-write";
  // Accepted database events are queued by the platform: they have a status, but no operation to poll.
  const acceptedWithoutOperation =
    responseShape === "database-webhook-replay-accepted" ||
    responseShape === "database-schedule-run-accepted";
  const expectedStatus =
    expectsOperation ||
    (databaseWrite && result.body["state"] === "running") ||
    acceptedWithoutOperation
      ? 202
      : responseShape === "dev-access-ticket" ||
          responseShape === "cloudflare-authorization" ||
          responseShape === "github-authorization" ||
          responseShape === "database-access-credential" ||
          responseShape === "database-webhook-created" ||
          responseShape === "database-watch" ||
          (responseShape === "database-table" && tableCreated(result.body))
        ? 201
        : 200;
  if (result.status !== expectedStatus) {
    throw new TypeError("Invalid product response status");
  }
  const headers: Record<string, string> = {};
  if (expectsOperation || databaseWrite) {
    if (
      result.location === undefined ||
      !/^\/v1\/operations\/[0-9A-HJKMNP-TV-Z]{26}$/u.test(result.location)
    ) {
      throw new TypeError("Invalid product operation location");
    }
    headers["Location"] = result.location;
  } else if (result.location !== undefined) {
    throw new TypeError("Unexpected product response Location");
  }
  if (result.etag !== undefined && !/^"sha256-[0-9a-f]{64}"$/u.test(result.etag)) {
    throw new TypeError("Invalid product response ETag");
  }
  if (requireEtag && result.etag === undefined)
    throw new TypeError("Product response ETag missing");
  if (!requireEtag && result.etag !== undefined)
    throw new TypeError("Unexpected product response ETag");
  if (result.etag !== undefined) headers["ETag"] = result.etag;
  const body = validateProductResponseBody(responseShape, result.body);
  if (databaseWrite && result.location !== `/v1/operations/${String(body["operation_id"])}`)
    throw new TypeError("Database write Location does not match receipt");
  if (expectsOperation && result.location !== `/v1/operations/${String(body["id"])}`) {
    throw new TypeError("Product operation Location does not match its body");
  }
  const response = json(body, result.status, requestId, headers);
  if (expectsOperation)
    return setUsageResponse(response, {
      operationId: validUsageOperationId(body["id"]),
      operationStatus: usageState(body["state"]),
    });
  if (databaseWrite)
    return setUsageResponse(response, {
      operationId: validUsageOperationId(body["operation_id"]),
      operationStatus: usageState(body["state"]),
    });
  return response;
}

function validateProductResponseBody(
  shape: ProductResponseShape,
  body: unknown,
): Record<string, unknown> {
  if (isDatabaseEventShape(shape)) return validateDatabaseEvent(shape, body);
  switch (shape) {
    case "managed-source-files":
    case "managed-source-versions":
    case "managed-source-diff":
    case "managed-source-upload":
    case "managed-source-blob":
      assertManagedSourceResponse(
        shape.slice("managed-source-".length) as "files" | "versions" | "diff" | "upload" | "blob",
        body,
      );
      return body as Record<string, unknown>;
    case "database-compute":
      assertDatabaseCompute(body);
      return body as unknown as Record<string, unknown>;
    case "project-context":
      assertProjectContext(body);
      return body as unknown as Record<string, unknown>;
    case "project-notes":
      assertProjectNotesReceipt(body);
      return body as unknown as Record<string, unknown>;
    case "project-export":
      assertProjectExport(body);
      return body as unknown as Record<string, unknown>;
    case "project-export-download-link":
      assertProjectExportDownloadLink(body);
      return body as unknown as Record<string, unknown>;
    case "credit-budget":
      return validateCreditBudget(body);
    case "github-authorization": {
      if (
        !isRecord(body) ||
        !hasExactKeys(body, [
          "authorization_id",
          "authorization_url",
          "expires_at",
          "installation_id",
          "installation_url",
          "last_failure",
          "operation_id",
          "repository_id",
          "repository_name",
          "repository_owner",
          "status",
        ]) ||
        typeof body["authorization_id"] !== "string" ||
        parseRouteUlid(body["authorization_id"]) === null ||
        !["pending", "authorizing", "authorized", "failed", "expired"].includes(
          String(body["status"]),
        )
      )
        throw new TypeError("Invalid GitHub authorization response");
      return body;
    }
    case "operation":
      return storedOperationBody(body);
    case "source":
      return validateProjectSource(body);
    case "source-binding":
      return validateProjectSource(body, true);
    case "auto-deploy":
      return validateAutoDeploy(body);
    case "deployment-plan":
      return validateDeploymentPlan(body);
    case "deployment-page":
      return validateDeploymentPage(body);
    case "deployment":
      return validateDeployment(body);
    case "rollback-plan":
      return validateGuardedActionPlan(body, "rollback");
    case "promotion-plan":
      return validateGuardedActionPlan(body, "promote");
    case "delete-plan":
      return validateGuardedActionPlan(body, "delete");
    case "data-change-plan":
      return { ...parseProjectDataChangePlan(body) };
    case "cloudflare-authorization":
      return validateCloudflareAuthorization(body);
    case "cloudflare-dns-status":
      return validateCloudflareDnsStatus(body);
    case "project-status": {
      const status = responseRecord(body, "Project status");
      return validateProjectStatus({
        ...status,
        source: status["source"] === null ? null : defaultProjectSource(status["source"]),
      });
    }
    case "dev-access-ticket":
      return validateDevAccessTicket(body);
    case "dev-access-state":
      return validateDevAccessState(body);
    case "powered-by-flag":
      return validatePoweredByFlag(body);
    case "preview":
      return { ...parsePreviewView(body) };
    case "diagnostic-page":
      return validateDiagnosticPage(body);
    case "database-write":
      assertProjectDatabaseWriteReceipt(body);
      return { ...body };
    case "database-table":
      return responseRecord(body, "Database table");
    case "database-query":
      return validateDatabaseQuery(body);
    case "database-access":
      return validateDatabaseAccess(body);
    case "database-access-credential":
      return validateDatabaseAccessCredential(body);
    case "database-access-page":
      return validateDatabaseAccessPage(body);
    case "paid-domain-plan":
      return validatePaidDomainPlan(body);
    case "paid-domain":
      return validatePaidDomain(body);
  }
}

function paidDomainPlanBody(
  value: Awaited<
    ReturnType<NonNullable<ControlApiDependencies["cloudflareDomains"]>["planPaidDomain"]>
  >,
) {
  return {
    status: value.status,
    hostname: value.hostname,
    environment: value.environment,
    cname_target: value.cnameTarget,
    effects: value.effects,
    risks: value.risks,
  };
}

function paidDomainBody(
  value: Awaited<
    ReturnType<NonNullable<ControlApiDependencies["cloudflareDomains"]>["getPaidDomain"]>
  >,
) {
  return {
    status: value.status,
    suspension_reason: value.suspensionReason,
    hostname: value.hostname,
    environment: value.environment,
    cname_target: value.cnameTarget,
    custom_hostname_status: value.customHostnameStatus,
    ssl_status: value.sslStatus,
    validation_records: value.validationRecords,
    url: value.url,
  };
}

function validatePaidDomainPlan(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Paid domain plan");
  responseExactKeys(value, [
    "cname_target",
    "effects",
    "environment",
    "hostname",
    "risks",
    "status",
  ]);
  responseStringArray(value, "effects", 512);
  responseStringArray(value, "risks", 512);
  if (
    value["status"] !== "planned" ||
    value["environment"] !== "prod" ||
    !isSaasCnameTarget(value["cname_target"]) ||
    !validPaidHostname(value["hostname"]) ||
    (value["effects"] as readonly unknown[]).length < 1 ||
    (value["effects"] as readonly unknown[]).length > 8 ||
    (value["risks"] as readonly unknown[]).length < 1 ||
    (value["risks"] as readonly unknown[]).length > 8
  ) {
    throw new TypeError("Paid domain plan is invalid");
  }
  return value;
}

function validatePaidDomain(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Paid domain");
  responseExactKeys(value, [
    "cname_target",
    "custom_hostname_status",
    "environment",
    "hostname",
    "ssl_status",
    "status",
    "suspension_reason",
    "url",
    "validation_records",
  ]);
  if (
    ![
      "not_configured",
      "awaiting_deployment",
      "pending",
      "active",
      "reconciliation_required",
      "deleted",
      "suspended",
    ].includes(String(value["status"])) ||
    ![
      null,
      "paid_plan_required",
      "insufficient_organization_credits",
      "project_budget_exceeded",
    ].includes(value["suspension_reason"] as null | string) ||
    (value["status"] === "suspended") !== (value["suspension_reason"] !== null) ||
    (value["status"] === "suspended" && value["url"] !== null) ||
    value["environment"] !== "prod" ||
    !isSaasCnameTarget(value["cname_target"]) ||
    (value["hostname"] !== null && !validPaidHostname(value["hostname"])) ||
    (value["custom_hostname_status"] !== null &&
      typeof value["custom_hostname_status"] !== "string") ||
    (value["ssl_status"] !== null && typeof value["ssl_status"] !== "string") ||
    !Array.isArray(value["validation_records"]) ||
    value["validation_records"].length > 16 ||
    !value["validation_records"].every(validPaidValidationRecord) ||
    (value["url"] !== null && value["url"] !== `https://${String(value["hostname"])}`) ||
    (value["status"] === "awaiting_deployment" &&
      (value["hostname"] === null ||
        value["custom_hostname_status"] !== null ||
        value["ssl_status"] !== null ||
        value["url"] !== null ||
        value["validation_records"].length !== 0))
  ) {
    throw new TypeError("Paid domain response is invalid");
  }
  return value;
}

function validPaidValidationRecord(value: unknown) {
  if (!isRecord(value) || !hasExactKeys(value, ["content", "name", "purpose", "type"]))
    return false;
  return (
    (value["type"] === "CNAME" || value["type"] === "TXT") &&
    typeof value["name"] === "string" &&
    typeof value["content"] === "string" &&
    ["traffic", "ownership", "ssl", "dcv_delegation"].includes(String(value["purpose"]))
  );
}

function validateDatabaseQuery(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Project database query");
  if (
    (value["environment"] !== "dev" && value["environment"] !== "prod") ||
    !Array.isArray(value["rows"]) ||
    value["rows"].length > 100 ||
    !Number.isSafeInteger(value["row_count"]) ||
    value["row_count"] !== value["rows"].length ||
    typeof value["truncated"] !== "boolean"
  ) {
    throw new TypeError("Project database query response is invalid");
  }
  for (const row of value["rows"]) responseRecord(row, "Project database row");
  assertIJsonValue(value);
  responseExactKeys(value, ["environment", "rows", "row_count", "truncated"]);
  return value;
}
function validateDatabaseAccess(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Database access");
  assertProjectDatabaseAccess(value);
  return value;
}

/** The connection URI leaves the platform only here, and only for this exact role and host. */
function validateDatabaseAccessCredential(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Database access credential");
  assertProjectDatabaseAccessCredential(value);
  if (value["state"] !== "active" || value["revoked_at"] !== null)
    throw new TypeError("Database access credential is invalid");
  return value;
}

function validateDatabaseAccessPage(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Database access page");
  responseExactKeys(value, ["items"]);
  if (!Array.isArray(value["items"]) || value["items"].length > 50)
    throw new TypeError("Database access page is invalid");
  for (const item of value["items"]) validateDatabaseAccess(item);
  assertProjectDatabaseAccessPage(value);
  return value;
}

const DIAGNOSTIC_EXCERPT_FORBIDDEN_PATTERN = /(?![\t\n])\p{Cc}|\p{Cs}/u;

/**
 * One page of a deployment's diagnostics. A running application holds its environment's secrets,
 * so the answer its health check quoted may repeat one: like a query of the project's database,
 * only its owner (`projects:write`) reads that answer; a member sees its route and status.
 */
async function listDeploymentDiagnostics(
  routeDeploymentId: string,
  dependencies: ControlApiDependencies,
  prepared: PreparedProductRequest,
  query: { readonly cursor?: string; readonly limit: number },
): Promise<ProductSurfaceResult | null> {
  if (dependencies.deploymentDiagnostics === undefined) throw new Error("Diagnostics unavailable");
  const deploymentId = parseRouteUlid(routeDeploymentId);
  if (deploymentId === null) return null;
  const page = await dependencies.deploymentDiagnostics.list({
    ...prepared.context,
    deploymentId,
    ...query,
  });
  const owner = await authorize(
    dependencies,
    prepared.principal,
    {
      kind: "project",
      organizationId: prepared.context.organizationId,
      projectId: prepared.context.projectId,
    },
    "projects:write",
  );
  if (owner === "unavailable") throw new Error("Authorization is unavailable");
  const items =
    owner === "allow"
      ? page.items
      : page.items.map((item) =>
          item["code"] === "HEALTH_CHECK_FAILED"
            ? Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith("excerpt")))
            : item,
        );
  return {
    status: 200,
    body: { items, ...(page.nextCursor === null ? {} : { next_cursor: page.nextCursor }) },
  };
}

function validateDiagnosticPage(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Diagnostic page");
  if (!Array.isArray(value["items"]) || value["items"].length > 100)
    throw new TypeError("Diagnostic page invalid");
  for (const item of value["items"]) {
    const row = responseRecord(item, "Diagnostic");
    responseUlid(row, "id");
    responseString(row, "source", /^(?:build|control|runtime|function)$/u, 5, 8);
    responseString(row, "code", /^[A-Z][A-Z0-9_]{1,63}$/u, 2, 64);
    const code = row["code"] as DeploymentDiagnosticCode;
    const message = responseString(row, "message", /^[A-Z][A-Z0-9_]{1,127}$/u, 2, 128);
    if (!isDeploymentDiagnosticCatalogEntry(code, message))
      throw new TypeError("Diagnostic catalog mismatch");
    for (const [key, max] of [
      ["exception_class", 128],
      ["file", 512],
      ["route", 512],
      ["request_id", 128],
      ["trace_id", 128],
    ] as const)
      if (row[key] !== undefined) responseString(row, key, /^.+$/su, 1, max);
    for (const key of ["line", "column", "duration_ms"] as const)
      if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0))
        throw new TypeError("Diagnostic numeric field invalid");
    if (row["excerpt"] !== undefined || row["excerpt_truncated"] !== undefined) {
      // Only the customer's own output may be quoted, sanitized before storage: the tail of a failed
      // build, or the head of what a failed health check was answered.
      const health = code === "HEALTH_CHECK_FAILED";
      const excerpt = responseString(row, "excerpt", /^.+$/su, 1, health ? 4096 : 16384);
      if (
        (code !== "BUILD_FAILED" && !health) ||
        typeof row["excerpt_truncated"] !== "boolean" ||
        excerpt !== excerpt.trimEnd() ||
        DIAGNOSTIC_EXCERPT_FORBIDDEN_PATTERN.test(excerpt)
      )
        throw new TypeError("Diagnostic excerpt invalid");
    }
    if (
      row["status_code"] !== undefined &&
      (code !== "HEALTH_CHECK_FAILED" ||
        !Number.isSafeInteger(row["status_code"]) ||
        Number(row["status_code"]) < 100 ||
        Number(row["status_code"]) > 599)
    )
      throw new TypeError("Diagnostic status code invalid");
    responseTimestamp(row, "occurred_at");
    const allowed = [
      "id",
      "source",
      "code",
      "message",
      "occurred_at",
      "exception_class",
      "file",
      "line",
      "column",
      "route",
      "request_id",
      "trace_id",
      "duration_ms",
      "excerpt",
      "excerpt_truncated",
      "status_code",
    ].filter((key) => row[key] !== undefined);
    responseExactKeys(row, allowed);
  }
  responseExactKeys(
    value,
    value["next_cursor"] === undefined ? ["items"] : ["items", "next_cursor"],
  );
  return value;
}

function validateAutoDeploy(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Source auto-deploy");
  responseString(value, "environment", /^dev$/u, 3, 3);
  if (typeof value["enabled"] !== "boolean") throw new TypeError("Auto-deploy enabled is invalid");
  const neverConfigured =
    value["generation"] === 0 &&
    value["enabled"] === false &&
    value["branch"] === null &&
    value["ref"] === null &&
    value["grant_status"] === null &&
    value["updated_at"] === null;
  if (!neverConfigured) {
    const branch = responseString(value, "branch", /^.{1,1024}$/su, 1, 1024);
    responseString(value, "ref", /^refs\/heads\/.{1,1024}$/su, 12, 1_035);
    if (value["ref"] !== `refs/heads/${branch}`) throw new TypeError("Auto-deploy ref is invalid");
    if (!Number.isSafeInteger(value["generation"]) || Number(value["generation"]) < 1)
      throw new TypeError("Auto-deploy generation is invalid");
    responseString(value, "grant_status", /^(?:active|revoked)$/u, 6, 7);
    responseTimestamp(value, "updated_at");
  }
  responseExactKeys(value, [
    "branch",
    "ref",
    "environment",
    "enabled",
    "generation",
    "grant_status",
    "updated_at",
  ]);
  return value;
}

function devAccessStateBody(
  projectId: string,
  state: import("./dev-access-management.js").DevAccessView,
): Record<string, unknown> {
  return { project_id: projectId, mode: state.mode, share_url: state.shareUrl };
}

function validateDevAccessState(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Dev access state");
  responseUlid(value, "project_id");
  const mode = responseString(value, "mode", /^(?:protected|public)$/u, 6, 9);
  if (value["share_url"] !== null) {
    responseHttpsUrl(value, "share_url");
    const url = new URL(String(value["share_url"]));
    if (
      !/^dev-[a-z0-9]+(?:-[a-z0-9]+){0,4}\.(?:dev\.)?check\.omh\.st$/u.test(url.hostname) ||
      url.pathname !== "/.ohmyhost/dev-access/redeem" ||
      url.hash !== "" ||
      [...url.searchParams.keys()].join(",") !== "stage,ticket" ||
      url.searchParams.get("stage") !== "dev" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("ticket") ?? "")
    )
      throw new TypeError("Dev share URL is invalid");
  }
  if (mode === "public" && value["share_url"] !== null)
    throw new TypeError("Public Dev has no share URL");
  responseExactKeys(value, ["project_id", "mode", "share_url"]);
  return value;
}

function poweredByFlagBody(
  projectId: string,
  state: Readonly<{ enabled: boolean; enabledAt: string | null }>,
): Record<string, unknown> {
  return { project_id: projectId, enabled: state.enabled, enabled_at: state.enabledAt };
}

function validatePoweredByFlag(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Powered-by flag");
  responseUlid(value, "project_id");
  if (typeof value["enabled"] !== "boolean") throw new TypeError("Powered-by flag is invalid");
  if (value["enabled"]) responseTimestamp(value, "enabled_at");
  else if (value["enabled_at"] !== null) throw new TypeError("A hidden flag has no start");
  responseExactKeys(value, ["project_id", "enabled", "enabled_at"]);
  return value;
}

function validateDevAccessTicket(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Dev access ticket");
  responseUlid(value, "ticket_id");
  responseUlid(value, "project_id");
  responseUlid(value, "environment_id");
  responseHttpsUrl(value, "origin");
  responseHttpsUrl(value, "redeem_url");
  responseTimestamp(value, "expires_at");
  const origin = new URL(String(value["origin"]));
  const redeem = new URL(String(value["redeem_url"]));
  if (
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    !/^dev-[a-z0-9]+(?:-[a-z0-9]+){0,4}\.(?:dev\.)?check\.omh\.st$/u.test(origin.hostname) ||
    redeem.origin !== origin.origin ||
    redeem.pathname !== "/.ohmyhost/dev-access/redeem" ||
    redeem.hash !== "" ||
    [...redeem.searchParams.keys()].join(",") !== "stage,ticket" ||
    redeem.searchParams.get("stage") !== "dev" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(redeem.searchParams.get("ticket") ?? "")
  ) {
    throw new TypeError("Dev access ticket response is invalid");
  }
  responseExactKeys(value, [
    "ticket_id",
    "project_id",
    "environment_id",
    "origin",
    "redeem_url",
    "expires_at",
  ]);
  return value;
}

function validateProjectStatus(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Project status");
  responseUlid(value, "project_id");
  responseString(value, "etag", /^"sha256-[a-f0-9]{64}"$/u, 73, 73);
  const handle = responseString(value, "handle", /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u, 3, 59);
  responseString(value, "region", /^(?:us|eu)$/u, 2, 2);
  responseString(value, "dev_access_mode", /^(?:protected|public)$/u, 6, 9);
  responseString(value, "lifecycle", /^(?:active|deleting|deleted)$/u, 6, 8);
  if (value["source"] !== null) validateProjectSource(value["source"]);
  if (value["default_environment"] !== null) {
    const environment = responseRecord(value["default_environment"], "Default environment");
    responseUlid(environment, "id");
    responseString(environment, "name", /^.{1,128}$/su, 1, 128);
    responseExactKeys(environment, ["id", "name"]);
  }
  if (value["environments"] !== undefined) {
    const environments = value["environments"];
    if (!Array.isArray(environments) || environments.length > 2)
      throw new TypeError("Project environments are invalid");
    const ids = new Set<string>(),
      names = new Set<string>();
    for (const raw of environments) {
      const environment = responseRecord(raw, "Project environment");
      responseUlid(environment, "id");
      const id = environment["id"] as string;
      const name = responseString(environment, "name", /^(?:dev|prod)$/u, 3, 4);
      responseExactKeys(environment, ["id", "name"]);
      if (ids.has(id) || names.has(name)) throw new TypeError("Project environments are ambiguous");
      ids.add(id);
      names.add(name);
    }
  }
  if (value["head_deployment"] !== null) validateDeployment(value["head_deployment"]);
  if (value["custom_domains"] !== undefined) {
    if (!Array.isArray(value["custom_domains"]) || value["custom_domains"].length > 64)
      throw new TypeError("Project custom domains are invalid");
    const seen = new Set<string>();
    for (const raw of value["custom_domains"]) {
      const domain = responseRecord(raw, "Project custom domain");
      responseExactKeys(domain, ["hostname", "environment", "state"]);
      const hostname = responseString(
        domain,
        "hostname",
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
        1,
        253,
      );
      responseString(domain, "environment", /^prod$/u, 4, 4);
      responseString(domain, "state", /^(?:awaiting_deployment|pending|active|deleting)$/u, 6, 19);
      if (seen.has(hostname)) throw new TypeError("Project custom domains are ambiguous");
      seen.add(hostname);
    }
  }
  responseProjectGatewayUrl(value, "dev_url", [
    `https://dev-${handle}.dev.check.omh.st`,
    `https://dev-${handle}.check.omh.st`,
  ]);
  responseProjectGatewayUrl(value, "prod_url", [
    `https://${handle}.dev.check.omh.st`,
    `https://${handle}.check.omh.st`,
  ]);
  if (value["latest_operation"] !== null) storedOperationBody(value["latest_operation"]);
  responseString(
    value,
    "cleanup_state",
    /^(?:not_started|pending|completed|reconciliation_required)$/u,
    7,
    23,
  );
  responseExactKeys(value, [
    "project_id",
    "etag",
    "handle",
    "region",
    "dev_access_mode",
    "lifecycle",
    "source",
    "default_environment",
    ...(value["environments"] === undefined ? [] : ["environments"]),
    ...(value["custom_domains"] === undefined ? [] : ["custom_domains"]),
    "head_deployment",
    "dev_url",
    "prod_url",
    "latest_operation",
    "cleanup_state",
  ]);
  return value;
}

function responseProjectGatewayUrl(
  value: Readonly<Record<string, unknown>>,
  key: "dev_url" | "prod_url",
  expected: readonly string[],
): void {
  const item = value[key];
  if (item !== null && (typeof item !== "string" || !expected.includes(item))) {
    throw new TypeError(`Product response ${key} is invalid`);
  }
}

function validateCloudflareAuthorization(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Cloudflare authorization");
  responseUlid(value, "authorization_id");
  const rawUrl = responseString(value, "authorization_url", /^https:\/\/.+$/u, 20, 4096);
  const url = new URL(rawUrl);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hostname !== "dash.cloudflare.com" ||
    url.pathname !== "/oauth2/auth" ||
    url.hash !== "" ||
    !url.searchParams.has("client_id") ||
    !url.searchParams.has("state")
  ) {
    throw new TypeError("Cloudflare authorization URL is invalid");
  }
  responseTimestamp(value, "expires_at");
  responseExactKeys(value, ["authorization_id", "authorization_url", "expires_at"]);
  return value;
}

function validateCloudflareDnsStatus(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Cloudflare DNS authorization status");
  const status = responseString(
    value,
    "status",
    /^(?:not_authorized|pending|authorized|reauthorization_required|expired|revoked)$/u,
    7,
    24,
  );
  if (status === "not_authorized") {
    if (value["zone"] !== null) {
      throw new TypeError("Unauthorised Cloudflare DNS status cannot name a zone");
    }
  } else {
    responseString(
      value,
      "zone",
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u,
      4,
      253,
    );
  }
  const scopes = value["scopes"];
  if (
    !Array.isArray(scopes) ||
    scopes.length > 2 ||
    scopes.some((scope) => scope !== "dns.write" && scope !== "zone.read") ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new TypeError("Cloudflare DNS authorization scopes are invalid");
  }
  if (value["expires_at"] !== null) responseTimestamp(value, "expires_at");
  if (
    (status === "authorized" && [...scopes].sort().join(",") !== "dns.write,zone.read") ||
    (status === "not_authorized" && (scopes.length !== 0 || value["expires_at"] !== null)) ||
    (status === "reauthorization_required" && (scopes.length !== 0 || value["expires_at"] !== null))
  ) {
    throw new TypeError("Cloudflare DNS authorization status is inconsistent");
  }
  responseExactKeys(value, ["status", "zone", "scopes", "expires_at"]);
  return value;
}

function defaultProjectSource(body: unknown): Record<string, unknown> {
  const value = validateProjectSource(body, true);
  if (value["provider"] === "managed") return value;
  const legacy = { ...value };
  delete legacy["source_connection_id"];
  delete legacy["source_generation"];
  return validateProjectSource(legacy);
}

function validateProjectSource(body: unknown, fullBinding = false): Record<string, unknown> {
  const value = responseRecord(body, "Project source");
  if (value["provider"] === "managed") assertManagedSourceResponse("source", value);
  else assertGithubSourceResponse(fullBinding ? "binding" : "legacy", value);
  return value;
}

function validateDeploymentPlan(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Deployment plan");
  responseUlid(value, "id");
  responseUlid(value, "project_id");
  responseString(value, "environment", /^(?:dev|prod)$/u, 3, 4);
  responseString(value, "commit_sha", /^[0-9a-f]{40}$/u, 40, 40);
  responseDigest(value, "source_digest");
  responseDigest(value, "build_plan_digest");
  responseApplicationRoot(value, "application_root");
  responseOptionalDigest(value, "artifact_digest");
  responseString(
    value,
    "runtime",
    /^(?:cloudflare_workers_static_assets|cloudflare_workers_edge_ssr)$/u,
    27,
    32,
  );
  responseHttpsUrl(value, "route");
  responseStringArray(value, "resource_effects", 512);
  responseStringArray(value, "limits", 512);
  validateCostEstimate(value["estimated_cost"]);
  responseStringArray(value, "risks", 512);
  responseStringArray(value, "destructive_effects", 512);
  responseStringArray(value, "required_confirmations", 128);
  responseTimestamp(value, "created_at");
  responseTimestamp(value, "expires_at");
  responseTtl(value, DEPLOYMENT_PLAN_TTL_SECONDS);
  responseExactKeys(
    value,
    [
      "id",
      "project_id",
      "environment",
      "commit_sha",
      "source_digest",
      "build_plan_digest",
      "application_root",
      "runtime",
      "route",
      "resource_effects",
      "limits",
      "estimated_cost",
      "risks",
      "destructive_effects",
      "required_confirmations",
      "created_at",
      "expires_at",
    ],
    ["artifact_digest"],
  );
  return value;
}

function responseApplicationRoot(value: Record<string, unknown>, key: string): void {
  const root = value[key];
  if (
    typeof root !== "string" ||
    !/^(?:\.|[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/u.test(root) ||
    new TextEncoder().encode(root).byteLength > 64 ||
    (root !== "." &&
      (root.split("/").length > 8 ||
        root.split("/").some((segment) => new TextEncoder().encode(segment).byteLength > 63)))
  ) {
    throw new TypeError("Deployment plan application root is invalid");
  }
}

function validateCreditBalance(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Credit balance");
  responseUlid(value, "organization_id");
  if (value["unit"] !== "microcredits") throw new TypeError("Invalid credit units");
  for (const key of ["available_micros", "reserved_micros"])
    responseString(value, key, /^[0-9]+$/u, 1, 32);
  assertCanonicalTimestamp(String(value["as_of"]), "Credit snapshot");
  const graceStart = value["grace_started_at"],
    graceEnd = value["grace_expires_at"];
  if (graceStart !== null || graceEnd !== null) {
    assertCanonicalTimestamp(String(graceStart), "Credit grace start");
    assertCanonicalTimestamp(String(graceEnd), "Credit grace expiry");
    if (Date.parse(String(graceEnd)) - Date.parse(String(graceStart)) !== 604_800_000)
      throw new TypeError("Invalid credit grace duration");
  }
  responseExactKeys(value, [
    "organization_id",
    "unit",
    "as_of",
    "available_micros",
    "reserved_micros",
    "grace_started_at",
    "grace_expires_at",
  ]);
  return value;
}

function validateCreditBudget(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Credit budget");
  responseUlid(value, "project_id");
  if (value["amount_micros"] !== null) responseString(value, "amount_micros", /^[0-9]+$/u, 1, 32);
  for (const key of ["used_micros", "reserved_micros"])
    responseString(value, key, /^[0-9]+$/u, 1, 32);
  for (const key of ["period_start", "period_end", "as_of"])
    assertCanonicalTimestamp(String(value[key]), key);
  if (
    (value["mode"] !== "continue" && value["mode"] !== "stop") ||
    (value["amount_micros"] === null && value["mode"] !== "continue")
  )
    throw new TypeError("Invalid budget mode");
  responseExactKeys(value, [
    "project_id",
    "amount_micros",
    "mode",
    "used_micros",
    "reserved_micros",
    "period_start",
    "period_end",
    "as_of",
  ]);
  return value;
}

function validateCostEstimate(body: unknown): void {
  const value = responseRecord(body, "Cost estimate");
  responseString(value, "amount_micros", /^[0-9]+$/u, 1, Number.MAX_SAFE_INTEGER);
  responseString(value, "currency", /^[A-Z]{3}$/u, 3, 3);
  responseString(value, "rate_card_version", /^.{1,128}$/su, 1, 128);
  responseString(value, "credit_micros", /^[0-9]+$/u, 1, 32);
  responseString(value, "credits", /^[0-9]+(?:\.[0-9]{1,6})?$/u, 1, 40);
  responseString(value, "provider_cost_micros", /^[0-9]+$/u, 1, 32);
  responseString(value, "scope", /^build_compute$/u, 13, 13);
  responseString(value, "reserved_seconds", /^[1-9][0-9]*$/u, 1, 32);
  responseExactKeys(value, [
    "amount_micros",
    "currency",
    "rate_card_version",
    "credit_micros",
    "credits",
    "provider_cost_micros",
    "scope",
    "reserved_seconds",
  ]);
}

function validateDeploymentPage(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Deployment page");
  if (!Array.isArray(value["items"])) throw new TypeError("Deployment page items are invalid");
  value["items"].forEach(validateDeployment);
  if ("next_cursor" in value && value["next_cursor"] !== null) {
    responseString(value, "next_cursor", /^[A-Za-z0-9_-]+$/u, 1, Number.MAX_SAFE_INTEGER);
  }
  responseExactKeys(value, ["items"], ["next_cursor"]);
  return value;
}

function validateDeployment(body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Deployment");
  responseUlid(value, "id");
  responseUlid(value, "project_id");
  responseUlid(value, "operation_id");
  responseString(value, "commit_sha", /^[0-9a-f]{40}$/u, 40, 40);
  responseDigest(value, "source_digest");
  responseDigest(value, "build_plan_digest");
  responseOptionalDigest(value, "artifact_digest");
  responseString(
    value,
    "status",
    /^(?:queued|building|publishing|active|failed|rolled_back|deleting|deleted|reconciliation_required)$/u,
    5,
    23,
  );
  if ("url" in value) responseHttpsUrl(value, "url");
  responseTimestamp(value, "created_at");
  responseTimestamp(value, "updated_at");
  responseExactKeys(
    value,
    [
      "id",
      "project_id",
      "operation_id",
      "commit_sha",
      "source_digest",
      "build_plan_digest",
      "status",
      "created_at",
      "updated_at",
    ],
    ["artifact_digest", "url"],
  );
  return value;
}

function validateGuardedActionPlan(
  body: unknown,
  action: "rollback" | "promote" | "delete",
): Record<string, unknown> {
  const value = responseRecord(body, "Destructive action plan");
  responseString(value, "action", new RegExp(`^${action}$`, "u"), action.length, action.length);
  responseUlid(value, "project_id");
  responseString(value, "resource_etag", /^.{3,128}$/su, 3, 128);
  responseStringArray(value, "effects", 512);
  responseStringArray(value, "risks", 512);
  responseString(value, "confirmation_token", /^[A-Za-z0-9._~-]+$/u, 32, 4096);
  responseTimestamp(value, "created_at");
  responseTimestamp(value, "expires_at");
  responseTtl(value, ACTION_CONFIRMATION_TTL_SECONDS);
  const rollbackFields = ["target_deployment_id", "target_artifact_digest"] as const;
  const promotionFields = [
    "source_deployment_id",
    "source_artifact_digest",
    "source_environment",
    "target_environment",
  ] as const;
  if (action === "rollback") {
    responseUlid(value, "target_deployment_id");
    responseDigest(value, "target_artifact_digest");
  } else if (action === "promote") {
    responseUlid(value, "source_deployment_id");
    responseDigest(value, "source_artifact_digest");
    responseString(value, "source_environment", /^dev$/u, 3, 3);
    responseString(value, "target_environment", /^prod$/u, 4, 4);
  } else if ([...rollbackFields, ...promotionFields].some((key) => value[key] !== undefined)) {
    throw new TypeError("Delete plan contains deployment fields");
  }
  responseExactKeys(value, [
    "action",
    "project_id",
    "resource_etag",
    "effects",
    "risks",
    "confirmation_token",
    "created_at",
    "expires_at",
    ...(action === "rollback" ? rollbackFields : []),
    ...(action === "promote" ? promotionFields : []),
  ]);
  return value;
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function responseExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (required.some((key) => !(key in value))) throw new TypeError("Product response key missing");
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("Unexpected product response key");
  }
}

function responseString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  pattern: RegExp,
  minimum: number,
  maximum: number,
): string {
  const item = value[key];
  if (
    typeof item !== "string" ||
    item.length < minimum ||
    item.length > maximum ||
    !pattern.test(item)
  ) {
    throw new TypeError(`Product response ${key} is invalid`);
  }
  return item;
}

function responseUlid(value: Readonly<Record<string, unknown>>, key: string): void {
  parseUlid(responseString(value, key, /^[0-9A-HJKMNP-TV-Z]{26}$/u, 26, 26));
}

function responseDigest(value: Readonly<Record<string, unknown>>, key: string): void {
  responseString(value, key, /^sha256:[0-9a-f]{64}$/u, 71, 71);
}

function responseOptionalDigest(value: Readonly<Record<string, unknown>>, key: string): void {
  if (key in value) responseDigest(value, key);
}

function responseTimestamp(value: Readonly<Record<string, unknown>>, key: string): void {
  assertCanonicalTimestamp(responseString(value, key, /^.+$/su, 1, 64), `Product response ${key}`);
}

function responseTtl(value: Readonly<Record<string, unknown>>, seconds: number): void {
  const createdAt = Date.parse(String(value["created_at"]));
  const expiresAt = Date.parse(String(value["expires_at"]));
  if (expiresAt - createdAt !== seconds * 1000)
    throw new TypeError("Product response TTL is invalid");
}

function responseHttpsUrl(value: Readonly<Record<string, unknown>>, key: string): void {
  const item = responseString(value, key, /^https:\/\/.+$/u, 9, 2048);
  const parsed = new URL(item);
  if (parsed.protocol !== "https:") throw new TypeError(`Product response ${key} is invalid`);
}

function responseStringArray(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumItemLength: number,
): void {
  const items = value[key];
  if (!Array.isArray(items)) throw new TypeError(`Product response ${key} is invalid`);
  for (const item of items) {
    if (typeof item !== "string" || item.length < 1 || item.length > maximumItemLength) {
      throw new TypeError(`Product response ${key} is invalid`);
    }
  }
}

function validatedHeader(
  context: Context,
  requestId: string,
  name: string,
  label: string,
  minimum: number,
  maximum: number,
): string | Response {
  const value = context.req.header(name);
  if (
    value === undefined ||
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim() ||
    containsControlCharacter(value)
  ) {
    return problem(requestId, 400, "invalid_request", `${label} is invalid.`);
  }
  return value;
}

function validatedConfirmationToken(context: Context, requestId: string): string | Response {
  const value = validatedHeader(
    context,
    requestId,
    "x-confirmation-token",
    "X-Confirmation-Token",
    32,
    4096,
  );
  if (value instanceof Response) return value;
  return /^[A-Za-z0-9._~-]+$/u.test(value)
    ? value
    : problem(requestId, 400, "invalid_request", "X-Confirmation-Token is invalid.");
}

function canonicalJson(value: unknown): string {
  const serialize = canonicalize as unknown as (input: unknown) => string | undefined;
  const result = serialize(value);
  if (result === undefined) throw new TypeError("Request cannot be canonicalized");
  return result;
}

async function parseStrictJsonBody<T>(
  context: Context,
  requestId: string,
  parse: (value: Record<string, unknown>) => T | null,
): Promise<ParsedInput<T>> {
  const parsed = await parseJsonObject(context);
  if (parsed.outcome === "error")
    return {
      outcome: "error",
      response: problem(requestId, parsed.status, parsed.code, parsed.detail),
    };
  const value = parse(parsed.value);
  return value === null
    ? {
        outcome: "error",
        response: problem(requestId, 400, "invalid_request", "Request fields are invalid."),
      }
    : { outcome: "ok", value, canonicalValue: parsed.value };
}

function parseLinkSourceBody(
  context: Context,
  requestId: string,
): Promise<ParsedInput<{ repositoryOwner: string; repositoryName: string }>> {
  return parseStrictJsonBody(context, requestId, (value) => {
    if (!hasExactKeys(value, ["repository_name", "repository_owner"])) return null;
    const repositoryOwner = value["repository_owner"];
    const repositoryName = value["repository_name"];
    return typeof repositoryOwner === "string" &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(repositoryOwner) &&
      typeof repositoryName === "string" &&
      /^[A-Za-z0-9._-]{1,100}$/u.test(repositoryName)
      ? { repositoryOwner, repositoryName }
      : null;
  });
}

function parseCreditBudgetBody(context: Context, requestId: string) {
  return parseStrictJsonBody(context, requestId, (value) => {
    if (!hasExactKeys(value, ["amount_micros", "mode"])) return null;
    const amount = value["amount_micros"];
    const mode = value["mode"];
    if (
      amount !== null &&
      (typeof amount !== "string" ||
        !/^(0|[1-9][0-9]{0,18})$/u.test(amount) ||
        BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER))
    )
      return null;
    if ((mode !== "continue" && mode !== "stop") || (amount === null && mode !== "continue"))
      return null;
    return { amountMicros: amount as string | null, mode: mode as "continue" | "stop" };
  });
}

function parseProjectDatabaseQueryBody(
  context: Context,
  requestId: string,
): Promise<
  ParsedInput<{
    environment: "dev" | "prod";
    statement: string;
    parameters: readonly (string | number | boolean | null)[];
  }>
> {
  return parseStrictJsonBody(context, requestId, (value) => {
    if (!hasExactKeys(value, ["environment", "parameters", "statement"])) return null;
    const statement = value["statement"];
    const parameters = value["parameters"];
    if (
      (value["environment"] !== "dev" && value["environment"] !== "prod") ||
      typeof statement !== "string" ||
      !/^(?:select|with)\b/iu.test(statement.trimStart()) ||
      new TextEncoder().encode(statement).byteLength > 4_096 ||
      !Array.isArray(parameters) ||
      parameters.length > 32 ||
      !parameters.every(
        (parameter) =>
          parameter === null ||
          typeof parameter === "string" ||
          typeof parameter === "boolean" ||
          (typeof parameter === "number" && Number.isFinite(parameter)),
      )
    ) {
      return null;
    }
    return {
      environment: value["environment"],
      statement,
      parameters: Object.freeze([...parameters]) as readonly (string | number | boolean | null)[],
    };
  });
}

/** The one field a rename carries: the address the customer chose. */
function parseProjectHandleBody(context: Context, requestId: string): Promise<ParsedInput<string>> {
  return parseStrictJsonBody(context, requestId, (value) => {
    if (!hasExactKeys(value, ["handle"]) || typeof value["handle"] !== "string") return null;
    return value["handle"];
  });
}

function parsePaidDomainBody(
  context: Context,
  requestId: string,
): Promise<ParsedInput<{ hostname: string }>> {
  return parseStrictJsonBody(context, requestId, (value) => {
    if (!hasExactKeys(value, ["hostname"]) || !validPaidHostname(value["hostname"])) return null;
    return { hostname: value["hostname"] };
  });
}

function validPaidHostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value) &&
    !value.endsWith(".poc.aixyte.com") &&
    value !== "omh.st" &&
    !value.endsWith(".omh.st") &&
    value !== "ohmyho.st" &&
    !value.endsWith(".ohmyho.st")
  );
}

function parseCloudflareAuthorizationBody(
  context: Context,
  requestId: string,
): Promise<ParsedInput<{ readonly zone: string }>> {
  return parseStrictJsonBody(context, requestId, (value) => {
    return hasExactKeys(value, ["zone"]) && validPaidHostname(value["zone"])
      ? { zone: value["zone"] }
      : null;
  });
}

function parsePoweredByFlagBody(
  context: Context,
  requestId: string,
): Promise<ParsedInput<boolean>> {
  return parseStrictJsonBody(context, requestId, (value) =>
    hasExactKeys(value, ["enabled"]) && typeof value["enabled"] === "boolean"
      ? value["enabled"]
      : null,
  );
}

function parseDevAccessModeBody(
  context: Context,
  requestId: string,
): Promise<ParsedInput<"protected" | "public">> {
  return parseStrictJsonBody(context, requestId, (value) => {
    if (!hasExactKeys(value, ["mode"])) return null;
    return value["mode"] === "protected" || value["mode"] === "public" ? value["mode"] : null;
  });
}

function parseAutoDeployBody(
  context: Context,
  requestId: string,
): Promise<ParsedInput<{ branch: string; enabled: boolean }>> {
  return parseStrictJsonBody(context, requestId, (value) => {
    if (!hasExactKeys(value, ["branch", "enabled"])) return null;
    const branch = value["branch"];
    const enabled = value["enabled"];
    return typeof branch === "string" &&
      validGithubBranchName(branch) &&
      typeof enabled === "boolean"
      ? { branch, enabled }
      : null;
  });
}

function validGithubBranchName(value: string): boolean {
  return !(
    value.length < 1 ||
    value.length > 1_024 ||
    !/^[A-Za-z0-9]/u.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x20 || code === 0x7f || "\\~^:?*[]".includes(character);
    }) ||
    value.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock"))
  );
}

function parseDeploymentPlanBody(
  context: Context,
  requestId: string,
): Promise<ParsedInput<{ commitSha: string; environment?: "dev" | "prod" }>> {
  return parseStrictJsonBody(context, requestId, (value) => {
    const environment = value["environment"];
    return (hasExactKeys(value, ["commit_sha"]) ||
      hasExactKeys(value, ["commit_sha", "environment"])) &&
      typeof value["commit_sha"] === "string" &&
      /^[0-9a-f]{40}$/u.test(value["commit_sha"]) &&
      (environment === undefined || environment === "dev" || environment === "prod")
      ? { commitSha: value["commit_sha"], ...(environment === undefined ? {} : { environment }) }
      : null;
  });
}
function parseDiagnosticQuery(
  context: Context,
  requestId: string,
): ParsedInput<{ cursor?: string; limit: number }> {
  const url = new URL(context.req.url);
  if (
    [...url.searchParams.keys()].some((key) => key !== "cursor" && key !== "limit") ||
    url.searchParams.getAll("cursor").length > 1 ||
    url.searchParams.getAll("limit").length > 1
  )
    return {
      outcome: "error",
      response: problem(requestId, 400, "invalid_request", "Diagnostic query is invalid."),
    };
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined) {
    try {
      if (cursor.length > 2048) throw new Error("long");
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<
        string,
        unknown
      >;
      if (
        Object.keys(parsed).sort().join() !== "id,occurredAt" ||
        typeof parsed["id"] !== "string" ||
        typeof parsed["occurredAt"] !== "string" ||
        new Date(parsed["occurredAt"]).toISOString() !== parsed["occurredAt"]
      )
        throw new Error("invalid");
      parseUlid(parsed["id"]);
    } catch {
      return {
        outcome: "error",
        response: problem(requestId, 400, "invalid_request", "Diagnostic cursor is invalid."),
      };
    }
  }
  const limit = Number(url.searchParams.get("limit") ?? "100");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    return {
      outcome: "error",
      response: problem(requestId, 400, "invalid_request", "Diagnostic limit is invalid."),
    };
  const value = { ...(cursor === undefined ? {} : { cursor }), limit };
  return { outcome: "ok", value, canonicalValue: value };
}

function parseCreateDeploymentBody(
  context: Context,
  requestId: string,
): Promise<ParsedInput<{ planId: Ulid }>> {
  return parseStrictJsonBody(context, requestId, (value) => {
    if (!hasExactKeys(value, ["plan_id"]) || typeof value["plan_id"] !== "string") return null;
    const planId = parseRouteUlid(value["plan_id"]);
    return planId === null ? null : { planId };
  });
}

async function parseDataChangeBody(
  context: Context,
  requestId: string,
): Promise<
  ParsedInput<{ change: import("@ohmyhost/contracts/project-data-changes").ProjectDataChangeKind }>
> {
  const parsed = await parseJsonObject(context);
  if (parsed.outcome === "error")
    return {
      outcome: "error",
      response: problem(requestId, parsed.status, parsed.code, parsed.detail),
    };
  if (!hasExactKeys(parsed.value, ["change"]) || !isProjectDataChangeKind(parsed.value["change"]))
    return {
      outcome: "error",
      response: problem(
        requestId,
        400,
        "invalid_request",
        "Supply change: isolate_prod_keeps_data, isolate_dev_keeps_data, share_prod_keeps_data or reset_dev; no other fields are accepted.",
      ),
    };
  const value = { change: parsed.value["change"] };
  return { outcome: "ok", value, canonicalValue: value };
}

function parseUlidParameter(
  context: Context,
  name: string,
  label: string,
  requestId = "invalid",
): ParsedInput<Ulid> {
  const rawValue =
    context.req.param(name)?.split(":", 1)[0] ??
    (name === "target_deployment_id"
      ? /\/deployments\/([^/:]+):rollback(?:-plan)?$/u.exec(context.req.path)?.[1]
      : name === "source_deployment_id"
        ? /\/deployments\/([^/:]+):promote(?:-plan)?$/u.exec(context.req.path)?.[1]
        : undefined);
  const value = rawValue === undefined ? null : parseRouteUlid(rawValue);
  return value === null
    ? {
        outcome: "error",
        response: problem(requestId, 400, "invalid_request", `${label} is invalid.`),
      }
    : { outcome: "ok", value, canonicalValue: value };
}

function registerProjectDatabaseEventsRoutes(
  app: Hono,
  dependencies: ControlApiDependencies,
  createRequestId: () => string,
): void {
  const route = <T>(definition: DatabaseEventsRoute<T>): void => {
    app.on(definition.method, definition.path, async (context) => {
      const response = await handleProductSurfaceRequest(context, dependencies, createRequestId, {
        action: definition.action,
        responseShape: definition.responseShape,
        ...(definition.mutation === true ? { mutation: true } : {}),
        body: definition.parse,
        invoke: async (prepared, input: T) => {
          if (!dependencies.projectDatabaseEvents) throw new Error("Database events unavailable");
          return definition.invoke(dependencies.projectDatabaseEvents, prepared, input);
        },
      });
      // A created webhook carries its signing secret once; no cache or proxy may keep that answer.
      if (definition.mutation === true) {
        response.headers.set("Cache-Control", "no-store");
        response.headers.set("Pragma", "no-cache");
      }
      return response;
    });
  };
  const base = "/v1/projects/:project_id/database";
  const environmentQuery = { query: ["environment"], environment: "optional" } as const;
  const environmentRequired = { query: ["environment"], environment: "required" } as const;

  const subscription = `${base}/webhook-subscriptions/:subscription_id`;
  const activation = `${subscription}/activations/:generation`;
  const subscriptionParts = (parts: DatabaseEventsParts) => ({
    environment: parts.environment,
    subscriptionId: parseDatabaseWebhookSubscriptionId(parts.path["subscription_id"]),
  });
  const activationParts = (parts: DatabaseEventsParts) => ({
    ...subscriptionParts(parts),
    generation: parseDatabaseWebhookGeneration(parts.path["generation"]),
  });
  route({
    method: "PUT",
    path: activation,
    action: "projects:write",
    responseShape: "database-webhook-subscription-activation",
    mutation: true,
    parse: (context, requestId) =>
      databaseEventsBody(
        context,
        requestId,
        { ...environmentRequired, path: ["subscription_id", "generation"] },
        (parts, body) => ({
          ...activationParts(parts),
          request: parseDatabaseWebhookCreateRequest(body),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(
        200,
        await port.activateWebhookSubscription({
          ...prepared.context,
          ...input,
          idempotencyKey: prepared.mutation.idempotencyKey,
        }),
      ),
  });
  route({
    method: "DELETE",
    path: activation,
    action: "projects:write",
    responseShape: "database-webhook-subscription",
    mutation: true,
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { ...environmentRequired, path: ["subscription_id", "generation"] },
        activationParts,
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(
        200,
        await port.deactivateWebhookSubscription({
          ...prepared.context,
          ...input,
          idempotencyKey: prepared.mutation.idempotencyKey,
        }),
      ),
  });
  route({
    method: "GET",
    path: subscription,
    action: "projects:read",
    responseShape: "database-webhook-subscription",
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { ...environmentRequired, path: ["subscription_id"] },
        subscriptionParts,
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(
        200,
        await port.getWebhookSubscription({ ...prepared.context, ...input }),
      ),
  });

  route({
    method: "POST",
    path: `${base}/webhooks`,
    action: "projects:write",
    responseShape: "database-webhook-created",
    mutation: true,
    parse: (context, requestId) =>
      databaseEventsBody(
        context,
        requestId,
        environmentRequired,
        (parts, body) => ({
          environment: parts.environment,
          request: parseDatabaseWebhookCreateRequest(body),
        }),
        (body) =>
          isDatabaseWebhookEventTypes(body["event_types"])
            ? "Request fields are invalid."
            : WEBHOOK_EVENT_TYPES_DETAIL,
      ),
    invoke: async (port, prepared, input) => {
      const created = await port.createWebhook({
        ...prepared.context,
        environment: input.environment,
        idempotencyKey: prepared.mutation.idempotencyKey,
        request: input.request,
      });
      return databaseEventsResult(201, created);
    },
  });
  route({
    method: "GET",
    path: `${base}/webhooks`,
    action: "projects:read",
    responseShape: "database-webhook-page",
    parse: (context, requestId) =>
      databaseEventsInput(context, requestId, environmentQuery, (parts) => ({
        environment: parts.environment,
      })),
    invoke: async (port, prepared, input) => {
      const page = await port.listWebhooks({ ...prepared.context, environment: input.environment });
      if (page === null || (await canSeeWebhookUrls(dependencies, prepared)))
        return databaseEventsResult(200, page);
      return databaseEventsResult(200, { items: page.items.map(redactWebhookUrl) });
    },
  });
  route({
    method: "GET",
    path: `${base}/webhooks/:webhook_id`,
    action: "projects:read",
    responseShape: "database-webhook",
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { ...environmentQuery, path: ["webhook_id"] },
        (parts) => ({
          environment: parts.environment,
          webhookId: parseDatabaseWebhookId(parts.path["webhook_id"]),
        }),
      ),
    invoke: async (port, prepared, input) => {
      const webhook = await port.getWebhook({ ...prepared.context, ...input });
      if (webhook === null || (await canSeeWebhookUrls(dependencies, prepared)))
        return databaseEventsResult(200, webhook);
      return databaseEventsResult(200, redactWebhookUrl(webhook));
    },
  });
  route({
    method: "DELETE",
    path: `${base}/webhooks/:webhook_id`,
    action: "projects:write",
    responseShape: "database-webhook-deleted",
    mutation: true,
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { ...environmentRequired, path: ["webhook_id"] },
        (parts) => ({
          environment: parts.environment,
          webhookId: parseDatabaseWebhookId(parts.path["webhook_id"]),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(
        200,
        await port.deleteWebhook({
          ...prepared.context,
          ...input,
          idempotencyKey: prepared.mutation.idempotencyKey,
        }),
      ),
  });
  route({
    method: "POST",
    path: `${base}/webhooks/:webhook_id/test`,
    action: "projects:write",
    responseShape: "database-webhook-test",
    mutation: true,
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { ...environmentRequired, path: ["webhook_id"] },
        (parts) => ({
          environment: parts.environment,
          webhookId: parseDatabaseWebhookId(parts.path["webhook_id"]),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(
        200,
        await port.testWebhook({
          ...prepared.context,
          ...input,
          idempotencyKey: prepared.mutation.idempotencyKey,
        }),
      ),
  });
  route({
    method: "GET",
    path: `${base}/webhook-deliveries`,
    action: "projects:read",
    responseShape: "database-webhook-delivery-page",
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { query: ["environment", "webhook_id", "limit", "cursor"], environment: "optional" },
        (parts) => ({
          environment: parts.environment,
          webhookId:
            parts.values["webhook_id"] === undefined
              ? null
              : parseDatabaseWebhookId(parts.values["webhook_id"]),
          limit: parseDatabaseListLimit(parts.values["limit"], 100, 50),
          cursor: parseDatabaseCursor(parts.values["cursor"]),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(200, await port.listDeliveries({ ...prepared.context, ...input })),
  });
  route({
    method: "POST",
    path: `${base}/webhook-deliveries/:delivery_id/replay`,
    action: "projects:write",
    responseShape: "database-webhook-replay-accepted",
    mutation: true,
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { ...environmentRequired, path: ["delivery_id"] },
        (parts) => ({
          environment: parts.environment,
          deliveryId: parseDatabaseDeliveryId(parts.path["delivery_id"]),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(
        202,
        await port.replayDelivery({
          ...prepared.context,
          ...input,
          idempotencyKey: prepared.mutation.idempotencyKey,
        }),
      ),
  });
  route({
    method: "POST",
    path: `${base}/watches`,
    action: "projects:write",
    responseShape: "database-watch",
    mutation: true,
    parse: (context, requestId) =>
      // A watch names its environment in the body, so the query string must stay empty.
      databaseEventsBody(
        context,
        requestId,
        { query: [], environment: "optional" },
        (_parts, body) => {
          const { environment, ...request } = body;
          return {
            environment: parseDatabaseEnvironment(environment),
            request: parseDatabaseWatchCreateRequest(request),
          };
        },
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(201, await port.createWatch({ ...prepared.context, ...input })),
  });
  route({
    method: "GET",
    path: `${base}/watches`,
    action: "projects:read",
    responseShape: "database-watch-page",
    parse: (context, requestId) =>
      databaseEventsInput(context, requestId, environmentQuery, (parts) => ({
        environment: parts.environment,
      })),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(200, await port.listWatches({ ...prepared.context, ...input })),
  });
  route({
    method: "DELETE",
    path: `${base}/watches/:watch_id`,
    action: "projects:write",
    responseShape: "database-watch-deleted",
    mutation: true,
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { ...environmentRequired, path: ["watch_id"] },
        (parts) => ({
          environment: parts.environment,
          watchId: parseDatabaseWatchId(parts.path["watch_id"]),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(200, await port.deleteWatch({ ...prepared.context, ...input })),
  });
  route({
    method: "POST",
    path: `${base}/tables`,
    action: "projects:write",
    responseShape: "database-table",
    mutation: true,
    parse: (context, requestId) =>
      // A table names its environment in the body, so the query string must stay empty.
      databaseEventsBody(
        context,
        requestId,
        { query: [], environment: "optional" },
        (_parts, body) => parseDatabaseTableCreateBody(body),
      ),
    invoke: async (port, prepared, input) => {
      const created = await port.createTable({ ...prepared.context, ...input });
      // An identical table that already exists answers 200; a table this request created answers 201.
      return created === null
        ? null
        : databaseEventsResult(created.created ? 201 : 200, databaseTableBody(created));
    },
  });
  route({
    method: "PUT",
    path: `${base}/schedules/:name`,
    action: "projects:write",
    responseShape: "database-schedule",
    parse: (context, requestId) =>
      databaseEventsBody(
        context,
        requestId,
        { ...environmentRequired, path: ["name"] },
        (parts, body) => ({
          environment: parts.environment,
          name: parseDatabaseScheduleName(parts.path["name"]),
          request: parseDatabaseScheduleSetRequest(body),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(200, await port.setSchedule({ ...prepared.context, ...input })),
  });
  route({
    method: "GET",
    path: `${base}/schedules`,
    action: "projects:read",
    responseShape: "database-schedule-page",
    parse: (context, requestId) =>
      databaseEventsInput(context, requestId, environmentQuery, (parts) => ({
        environment: parts.environment,
      })),
    invoke: async (port, prepared, input) => {
      const page = await port.listSchedules({
        ...prepared.context,
        environment: input.environment,
      });
      if (page === null || (await canSeeWebhookUrls(dependencies, prepared)))
        return databaseEventsResult(200, page);
      return databaseEventsResult(200, { items: page.items.map(redactScheduleStatements) });
    },
  });
  route({
    method: "GET",
    path: `${base}/schedules/:name`,
    action: "projects:read",
    responseShape: "database-schedule",
    parse: (context, requestId) =>
      databaseEventsInput(context, requestId, { ...environmentQuery, path: ["name"] }, (parts) => ({
        environment: parts.environment,
        name: parseDatabaseScheduleName(parts.path["name"]),
      })),
    invoke: async (port, prepared, input) => {
      const schedule = await port.getSchedule({ ...prepared.context, ...input });
      if (schedule === null || (await canSeeWebhookUrls(dependencies, prepared)))
        return databaseEventsResult(200, schedule);
      return databaseEventsResult(200, redactScheduleStatements(schedule));
    },
  });
  route({
    method: "DELETE",
    path: `${base}/schedules/:name`,
    action: "projects:write",
    responseShape: "database-schedule-deleted",
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { ...environmentRequired, path: ["name"] },
        (parts) => ({
          environment: parts.environment,
          name: parseDatabaseScheduleName(parts.path["name"]),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(200, await port.deleteSchedule({ ...prepared.context, ...input })),
  });
  route({
    method: "GET",
    path: `${base}/schedules/:name/runs`,
    action: "projects:read",
    responseShape: "database-schedule-run-page",
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { query: ["environment", "limit"], environment: "optional", path: ["name"] },
        (parts) => ({
          environment: parts.environment,
          name: parseDatabaseScheduleName(parts.path["name"]),
          limit: parseDatabaseListLimit(parts.values["limit"], 50, 20),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(200, await port.listScheduleRuns({ ...prepared.context, ...input })),
  });
  route({
    method: "POST",
    path: `${base}/schedules/:name/run`,
    action: "projects:write",
    responseShape: "database-schedule-run-accepted",
    mutation: true,
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        { ...environmentRequired, path: ["name"] },
        (parts) => ({
          environment: parts.environment,
          name: parseDatabaseScheduleName(parts.path["name"]),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(
        202,
        await port.runSchedule({
          ...prepared.context,
          ...input,
          idempotencyKey: prepared.mutation.idempotencyKey,
        }),
      ),
  });
  route({
    method: "GET",
    path: `${base}/execution-usage`,
    action: "projects:read",
    responseShape: "database-execution-usage-page",
    parse: (context, requestId) =>
      databaseEventsInput(
        context,
        requestId,
        {
          query: ["environment", "from", "to", "granularity", "limit", "cursor"],
          environment: "optional",
        },
        (parts) => ({
          environment: parts.environment,
          window: parseDatabaseUsageWindow(
            parts.values["from"],
            parts.values["to"],
            parts.values["granularity"],
          ),
          limit: parseDatabaseListLimit(parts.values["limit"], 100, 50),
          cursor: parseDatabaseCursor(parts.values["cursor"]),
        }),
      ),
    invoke: async (port, prepared, input) =>
      databaseEventsResult(200, await port.readExecutionUsage({ ...prepared.context, ...input })),
  });
}

/** Resolves the query, the path and the optional JSON body; any refusal is one 400 problem. */
function databaseEventsInput<T>(
  context: Context,
  requestId: string,
  options: {
    readonly query: readonly string[];
    readonly environment: "required" | "optional";
    readonly path?: readonly string[];
  },
  build: (parts: DatabaseEventsParts) => T,
): ParsedInput<T> {
  try {
    const query = parseDatabaseEventsQuery(
      new URL(context.req.url).searchParams,
      options.query,
      options.environment,
    );
    const path = Object.fromEntries(
      (options.path ?? []).map((name) => [name, context.req.param(name) ?? ""]),
    );
    const value = build({ ...query, path });
    return { outcome: "ok", value, canonicalValue: value };
  } catch {
    return {
      outcome: "error",
      response: problem(requestId, 400, "invalid_request", "Database event request is invalid."),
    };
  }
}

/**
 * The detail of a refused body is fixed text chosen from the body's own keys; without a hook every refusal is the
 * generic one. Only a body that parsed as an object reaches the hook, so the text never echoes customer values.
 */
async function databaseEventsBody<T>(
  context: Context,
  requestId: string,
  options: {
    readonly query: readonly string[];
    readonly environment: "required" | "optional";
    readonly path?: readonly string[];
  },
  build: (parts: DatabaseEventsParts, body: Record<string, unknown>) => T,
  invalidDetail?: (body: Record<string, unknown>) => string,
): Promise<ParsedInput<T>> {
  const head = databaseEventsInput(context, requestId, options, (parts) => parts);
  if (head.outcome === "error") return head;
  const rejected: { body?: Record<string, unknown> } = {};
  const body = await parseStrictJsonBody(context, requestId, (value) => {
    try {
      return { value: build(head.value, value) };
    } catch {
      rejected.body = value;
      return null;
    }
  });
  if (body.outcome === "error") {
    return invalidDetail === undefined || rejected.body === undefined
      ? body
      : {
          outcome: "error",
          response: problem(requestId, 400, "invalid_request", invalidDetail(rejected.body)),
        };
  }
  return {
    outcome: "ok",
    value: body.value.value,
    canonicalValue: { ...head.value, body: body.canonicalValue },
  };
}

function databaseEventsResult(
  status: 200 | 201 | 202,
  value: object | null,
): ProductSurfaceResult | null {
  return value === null ? null : { status, body: { ...value } };
}

/**
 * A receiver URL often carries its secret in the path or the query, so only a caller who may write the project sees it
 * whole. An unavailable authorization is refused, as the other reads of this route are.
 */
async function canSeeWebhookUrls(
  dependencies: ControlApiDependencies,
  prepared: PreparedProductRequest,
): Promise<boolean> {
  const owner = await authorize(
    dependencies,
    prepared.principal,
    {
      kind: "project",
      organizationId: prepared.context.organizationId,
      projectId: prepared.context.projectId,
    },
    "projects:write",
  );
  if (owner === "unavailable") throw new Error("Authorization is unavailable");
  return owner === "allow";
}

/** Other callers see the origin of a receiver URL, which keeps the https shape of the answer. */
function redactWebhookUrl<T extends { readonly url: string }>(webhook: T): T {
  return { ...webhook, url: `${new URL(webhook.url).origin}/` };
}

/** Callers without projects:write see a SHA-256 digest of each scheduled statement instead of its SQL text. */
function redactScheduleStatements<T extends { readonly statements: readonly string[] }>(
  schedule: T,
): T {
  return {
    ...schedule,
    statements: schedule.statements.map(
      (statement) => `sha256:${createHash("sha256").update(statement).digest("hex")}`,
    ),
  };
}

function tableCreated(body: Readonly<Record<string, unknown>>): boolean {
  const table = body["table"];
  return isRecord(table) && table["created"] === true;
}

function databaseEventsProblem(requestId: string, code: ProjectDatabaseEventsRejection): Response {
  switch (code) {
    case "invalid":
      return problem(requestId, 400, "invalid_request", "Database event request is invalid.");
    case "webhook_limit":
      return problem(
        requestId,
        409,
        "database_webhook_limit",
        "This environment already has the maximum number of database webhooks.",
      );
    case "schedule_limit":
      return problem(
        requestId,
        409,
        "database_schedule_limit",
        "This environment already has the maximum number of database schedules.",
      );
    case "schedule_not_runnable":
      return problem(
        requestId,
        409,
        "database_schedule_not_runnable",
        "The schedule is disabled or a run for it is already queued.",
      );
    case "delivery_pending":
      return problem(
        requestId,
        409,
        "database_webhook_delivery_pending",
        "The platform is still retrying this webhook delivery.",
      );
    case "throttled": {
      const response = problem(
        requestId,
        429,
        "rate_limited",
        "This webhook was tested recently. Retry in five seconds.",
        true,
        5,
      );
      response.headers.set("Retry-After", "5");
      return response;
    }
    case "idempotency_key_reused":
      return problem(
        requestId,
        409,
        "idempotency_key_reused",
        "The idempotency key belongs to a different database request.",
      );
    case "watch_limit":
      return problem(
        requestId,
        409,
        "database_watch_limit",
        "This database already has the maximum number of watches.",
      );
    case "watch_table_unavailable":
      return problem(
        requestId,
        409,
        "database_watch_table_unavailable",
        "The table does not exist in this database, is not an ordinary table owned by the application, or is in a schema that cannot be watched.",
      );
    case "watch_column_unavailable":
      return problem(
        requestId,
        409,
        "database_watch_column_unavailable",
        "A listed column does not exist in the table.",
      );
    case "watch_events_unavailable":
      return problem(
        requestId,
        409,
        "database_watch_events_unavailable",
        "The platform event schema is not installed in this database yet.",
      );
    case "watch_conflict":
      return problem(
        requestId,
        409,
        "database_watch_conflict",
        "The table already has a different capture trigger, or the watch name is taken by another trigger.",
      );
    case "table_conflict":
      return problem(
        requestId,
        409,
        "database_table_conflict",
        "The table already exists with another definition in this database.",
      );
    case "table_limit":
      return problem(
        requestId,
        409,
        "database_table_limit",
        "This database already holds the maximum number of tables in its public schema.",
      );
    case "pending":
      return problem(
        requestId,
        503,
        "service_unavailable",
        "The database event request is still being processed. Retry shortly.",
        true,
      );
  }
}

const WEBHOOK_EVENT_TYPES_DETAIL =
  "event_types takes database.created, database.ready, database.woke, database.slept, database.suspended, database.resized, database.deleted, data.<topic> for one watched table or data.* for every watched table, at most 16 without repeats; * is not accepted and does not include data events.";

type DatabaseEventShape =
  | "database-webhook-subscription"
  | "database-webhook-subscription-activation"
  | "database-webhook-created"
  | "database-webhook"
  | "database-webhook-page"
  | "database-webhook-deleted"
  | "database-webhook-test"
  | "database-webhook-delivery-page"
  | "database-webhook-replay-accepted"
  | "database-schedule"
  | "database-schedule-page"
  | "database-schedule-deleted"
  | "database-schedule-run-page"
  | "database-schedule-run-accepted"
  | "database-execution-usage-page"
  | "database-watch"
  | "database-watch-page"
  | "database-watch-deleted";

const DATABASE_EVENT_ASSERTIONS: Record<DatabaseEventShape, (value: unknown) => void> = {
  "database-webhook-subscription": assertDatabaseWebhookSubscription,
  "database-webhook-subscription-activation": assertDatabaseWebhookSubscriptionActivation,
  "database-webhook-created": assertDatabaseWebhookCreated,
  "database-webhook": assertDatabaseWebhook,
  "database-webhook-page": assertDatabaseWebhookPage,
  "database-webhook-deleted": assertDatabaseWebhookDeleted,
  "database-webhook-test": assertDatabaseWebhookTest,
  "database-webhook-delivery-page": assertDatabaseWebhookDeliveryPage,
  "database-webhook-replay-accepted": assertDatabaseWebhookReplayAccepted,
  "database-schedule": assertDatabaseSchedule,
  "database-schedule-page": assertDatabaseSchedulePage,
  "database-schedule-deleted": assertDatabaseScheduleDeleted,
  "database-schedule-run-page": assertDatabaseScheduleRunPage,
  "database-schedule-run-accepted": assertDatabaseScheduleRunAccepted,
  "database-execution-usage-page": assertDatabaseExecutionUsagePage,
  "database-watch": assertDatabaseWatch,
  "database-watch-page": assertDatabaseWatchPage,
  "database-watch-deleted": assertDatabaseWatchDeleted,
};

function isDatabaseEventShape(shape: ProductResponseShape): shape is DatabaseEventShape {
  return Object.hasOwn(DATABASE_EVENT_ASSERTIONS, shape);
}

function validateDatabaseEvent(shape: DatabaseEventShape, body: unknown): Record<string, unknown> {
  const value = responseRecord(body, "Database event");
  DATABASE_EVENT_ASSERTIONS[shape](value);
  return value;
}

type DatabaseEventsParts = DatabaseEventsQuery & {
  readonly path: Readonly<Record<string, string>>;
};

type DatabaseEventsRoute<T> = {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly action: AuthorizationAction;
  readonly responseShape: ProductResponseShape;
  readonly mutation?: boolean;
  readonly parse: (context: Context, requestId: string) => Promise<ParsedInput<T>> | ParsedInput<T>;
  readonly invoke: (
    port: ProjectDatabaseEventsPort,
    prepared: PreparedProductRequest,
    input: T,
  ) => Promise<ProductSurfaceResult | null>;
};

const DATABASE_EVENT_ROUTE_LABELS: readonly (readonly [RegExp, string])[] = [
  [/^\/v1\/projects\/[^/]+\/database\/webhooks$/u, "/v1/projects/{project_id}/database/webhooks"],
  [
    /^\/v1\/projects\/[^/]+\/database\/webhooks\/[^/]+$/u,
    "/v1/projects/{project_id}/database/webhooks/{webhook_id}",
  ],
  [
    /^\/v1\/projects\/[^/]+\/database\/webhooks\/[^/]+\/test$/u,
    "/v1/projects/{project_id}/database/webhooks/{webhook_id}/test",
  ],
  [
    /^\/v1\/projects\/[^/]+\/database\/webhook-deliveries$/u,
    "/v1/projects/{project_id}/database/webhook-deliveries",
  ],
  [
    /^\/v1\/projects\/[^/]+\/database\/webhook-deliveries\/[^/]+\/replay$/u,
    "/v1/projects/{project_id}/database/webhook-deliveries/{delivery_id}/replay",
  ],
  [/^\/v1\/projects\/[^/]+\/database\/watches$/u, "/v1/projects/{project_id}/database/watches"],
  [
    /^\/v1\/projects\/[^/]+\/database\/watches\/[^/]+$/u,
    "/v1/projects/{project_id}/database/watches/{watch_id}",
  ],
  [/^\/v1\/projects\/[^/]+\/database\/tables$/u, "/v1/projects/{project_id}/database/tables"],
  [/^\/v1\/projects\/[^/]+\/database\/schedules$/u, "/v1/projects/{project_id}/database/schedules"],
  [
    /^\/v1\/projects\/[^/]+\/database\/schedules\/[^/]+$/u,
    "/v1/projects/{project_id}/database/schedules/{name}",
  ],
  [
    /^\/v1\/projects\/[^/]+\/database\/schedules\/[^/]+\/runs$/u,
    "/v1/projects/{project_id}/database/schedules/{name}/runs",
  ],
  [
    /^\/v1\/projects\/[^/]+\/database\/schedules\/[^/]+\/run$/u,
    "/v1/projects/{project_id}/database/schedules/{name}/run",
  ],
  [
    /^\/v1\/projects\/[^/]+\/database\/execution-usage$/u,
    "/v1/projects/{project_id}/database/execution-usage",
  ],
];

function parsePreviewEnvironment(context: Context, requestId: string): ParsedInput<"dev" | "prod"> {
  const entries = [...new URL(context.req.url).searchParams.entries()];
  const environment = context.req.query("environment");
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== "environment" ||
    (environment !== "dev" && environment !== "prod")
  )
    return {
      outcome: "error",
      response: problem(
        requestId,
        400,
        "invalid_request",
        "Choose environment=dev or environment=prod.",
      ),
    };
  return { outcome: "ok", value: environment, canonicalValue: { environment } };
}

function parseDatabaseAccessQuery(
  context: Context,
  requestId: string,
): ParsedInput<{ environment?: "dev" | "prod" }> {
  const entries = [...new URL(context.req.url).searchParams.entries()];
  const environment = context.req.query("environment");
  if (
    entries.some(([key]) => key !== "environment") ||
    new Set(entries.map(([key]) => key)).size !== entries.length ||
    (environment !== undefined && environment !== "dev" && environment !== "prod")
  ) {
    return {
      outcome: "error",
      response: problem(
        requestId,
        400,
        "invalid_request",
        "Database access query parameters are invalid.",
      ),
    };
  }
  const value: { environment?: "dev" | "prod" } = environment === undefined ? {} : { environment };
  return { outcome: "ok", value, canonicalValue: value };
}

function parseDeploymentListQuery(
  context: Context,
  requestId: string,
): ParsedInput<{ cursor?: string; limit: number }> {
  const entries = [...new URL(context.req.url).searchParams.entries()];
  if (
    entries.some(([key]) => key !== "cursor" && key !== "limit") ||
    new Set(entries.map(([key]) => key)).size !== entries.length
  ) {
    return {
      outcome: "error",
      response: problem(
        requestId,
        400,
        "invalid_request",
        "Deployment query parameters are invalid.",
      ),
    };
  }
  const cursor = context.req.query("cursor");
  const rawLimit = context.req.query("limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (
    (cursor !== undefined && !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(cursor)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return {
      outcome: "error",
      response: problem(
        requestId,
        400,
        "invalid_request",
        "Deployment query parameters are invalid.",
      ),
    };
  }
  const value = { ...(cursor === undefined ? {} : { cursor }), limit };
  return { outcome: "ok", value, canonicalValue: value };
}

function parseProjectListQuery(
  context: Context,
  requestId: string,
): ParsedInput<{ cursor?: string; limit: number }> {
  const parsed = parseDeploymentListQuery(context, requestId);
  if (parsed.outcome === "ok") return parsed;
  return {
    outcome: "error",
    response: problem(requestId, 400, "invalid_request", "Project query parameters are invalid."),
  };
}

async function parseJsonObject(context: Context): Promise<
  | { readonly outcome: "ok"; readonly value: Record<string, unknown> }
  | {
      readonly outcome: "error";
      readonly status: 400 | 413;
      readonly code: "invalid_request" | "payload_too_large";
      readonly detail: string;
    }
> {
  if (!/^application\/json(?:\s*;|$)/iu.test(context.req.header("content-type") ?? ""))
    return { outcome: "error", status: 400, code: "invalid_request", detail: "JSON is required." };
  if ((context.req.header("content-encoding") ?? "identity").toLowerCase() !== "identity")
    return {
      outcome: "error",
      status: 400,
      code: "invalid_request",
      detail: "Encoded request bodies are not accepted.",
    };
  const body = await readBoundedBody(context.req.raw, MAX_JSON_BYTES);
  if (body.outcome === "too_large")
    return {
      outcome: "error",
      status: 413,
      code: "payload_too_large",
      detail: "Request body is too large.",
    };
  if (body.outcome !== "ok")
    return { outcome: "error", status: 400, code: "invalid_request", detail: "JSON is invalid." };
  try {
    assertIJsonText(body.text);
    const value = JSON.parse(body.text) as unknown;
    assertIJsonValue(value);
    return isRecord(value)
      ? { outcome: "ok", value }
      : {
          outcome: "error",
          status: 400,
          code: "invalid_request",
          detail: "JSON object is required.",
        };
  } catch {
    return { outcome: "error", status: 400, code: "invalid_request", detail: "JSON is invalid." };
  }
}

async function enforceOperationLimits(
  dependencies: ControlApiDependencies,
  requestId: string,
  result: {
    readonly organizationId: Ulid;
    readonly operation: { readonly projectId: Ulid };
  },
): Promise<Response | null> {
  const organization = await enforceLimit(
    dependencies,
    requestId,
    "organization",
    result.organizationId,
  );
  return (
    organization ?? enforceLimit(dependencies, requestId, "project", result.operation.projectId)
  );
}

async function enforcePrincipalLimits(
  dependencies: ControlApiDependencies,
  requestId: string,
  principal: AuthenticatedPrincipal,
): Promise<Response | null> {
  const actor = await enforceLimit(dependencies, requestId, "actor", principal.actorId);
  return actor ?? enforceLimit(dependencies, requestId, "credential", principal.credentialId);
}

async function authenticate(
  context: Context,
  dependencies: ControlApiDependencies,
): Promise<RequestAuthenticationResult> {
  const observation = growthRequests.get(context.req.raw);
  const attach = (result: RequestAuthenticationResult): RequestAuthenticationResult => {
    if (result.outcome !== "authenticated") return result;
    const principal = { ...result.authentication.principal };
    if (observation) growthPrincipals.set(principal, observation);
    const usage = usageRequests.get(context.req.raw);
    if (usage) {
      usage.accountSeen = true;
      usage.accountId =
        principal.authorizationPrincipal.kind === "user" && principal.actorId.startsWith("user:")
          ? usageAccount(principal.actorId.slice(5))
          : null;
      usage.start?.();
      usagePrincipals.set(principal, usage);
    }
    return {
      outcome: "authenticated",
      authentication: {
        principal,
        revalidate: async () => attach(await result.authentication.revalidate()),
      },
    };
  };
  if (dependencies.internalAuthentication !== undefined) {
    const principal = await dependencies.internalAuthentication.resolve(context.req.raw);
    if (principal !== null) {
      if (principal.connectionDisconnected) return { outcome: "invalid" };
      const internal = dependencies.internalAuthentication;
      const revalidate: RequestAuthentication["revalidate"] = async () => {
        const fresh = await internal.revalidate(principal);
        return fresh === null
          ? { outcome: "invalid" }
          : {
              outcome: "authenticated",
              authentication: { principal: fresh, revalidate },
            };
      };
      return attach({
        outcome: "authenticated",
        authentication: { principal, revalidate },
      });
    }
  }
  const authorization = context.req.header("authorization");
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (bearer !== undefined) {
    return attach(await authenticateBearer(bearer, dependencies));
  }
  return { outcome: "invalid" };
}

async function authenticateBearer(
  bearer: string,
  dependencies: ControlApiDependencies,
): Promise<RequestAuthenticationResult> {
  try {
    const principal = await dependencies.authentication.authenticate(bearer);
    return principal === null
      ? { outcome: "invalid" }
      : {
          outcome: "authenticated",
          authentication: {
            principal,
            revalidate: () => authenticateBearer(bearer, dependencies),
          },
        };
  } catch {
    return { outcome: "unavailable" };
  }
}

async function authorize(
  dependencies: ControlApiDependencies,
  principal: AuthenticatedPrincipal,
  resource: AuthorizationResource,
  action: AuthorizationAction,
): Promise<AuthorizationOutcome> {
  if (!restrictionAllows(principal.authorizationRestriction, resource, action)) return "deny";
  if (
    principal.handoffDelegation &&
    (principal.handoffDelegation.action !== action ||
      !restrictionAllows(principal.handoffDelegation.authorizationRestriction, resource, action))
  )
    return "deny";
  if (
    principal.authorizationScopeConstraint !== undefined &&
    !principal.authorizationScopeConstraint.includes(action)
  ) {
    return "deny";
  }
  try {
    const decision: unknown = await dependencies.authorization.check({
      principal: principal.authorizationPrincipal,
      resource,
      action,
    });
    if (decision !== "allow") return decision === "deny" ? "deny" : "unavailable";
    if (principal.connectUser !== undefined) {
      if (dependencies.remoteAuthorization === undefined) return "deny";
      if (!(await dependencies.remoteAuthorization(principal, resource, action))) return "deny";
    }
    const usage = usagePrincipals.get(principal);
    if (usage && !usage.ambiguous) {
      const projectId = resource.kind === "project" ? resource.projectId : null;
      if (!usage.scopeSeen) {
        usage.organizationId = resource.organizationId;
        usage.projectId = projectId;
        usage.scopeSeen = true;
      } else if (
        usage.organizationId !== resource.organizationId ||
        (usage.projectId !== null && projectId !== null && usage.projectId !== projectId)
      ) {
        usage.organizationId = null;
        usage.projectId = null;
        usage.ambiguous = true;
      } else if (projectId !== null) usage.projectId = projectId;
    }
    const observation = growthPrincipals.get(principal);
    if (observation)
      observation.authorized = {
        accountId:
          principal.authorizationPrincipal.kind === "user" && principal.actorId.startsWith("user:")
            ? principal.actorId.slice(5)
            : null,
        organizationId: resource.organizationId,
      };
    return "allow";
  } catch {
    return "unavailable";
  }
}

async function findVisibleProject(
  dependencies: ControlApiDependencies,
  principal: AuthenticatedPrincipal,
  projectId: Ulid,
  permission: { readonly action: AuthorizationAction; readonly environmentId?: Ulid } = {
    action: "projects:read",
  },
): Promise<VisibleProjectResult> {
  for (const organizationId of principal.organizationIds) {
    const projectDecision = await authorize(
      dependencies,
      principal,
      {
        kind: "project",
        organizationId,
        projectId,
        ...(permission.environmentId === undefined
          ? {}
          : { environmentId: permission.environmentId }),
      },
      permission.action,
    );
    if (projectDecision === "unavailable") return { outcome: "unavailable" };
    if (projectDecision === "deny") continue;
    const project = await dependencies.persistence.getProject(organizationId, projectId);
    if (project !== null) {
      if (project.projectId !== projectId || project.organizationId !== organizationId) {
        throw new TypeError("Project persistence result escaped its requested scope");
      }
      return { outcome: "found", project };
    }
  }
  return { outcome: "not_found" };
}

async function findVisibleOperation(
  context: Context,
  dependencies: ControlApiDependencies,
  requestId: string,
): Promise<VisibleOperationResult> {
  const authenticationResult = await authenticate(context, dependencies);
  if (authenticationResult.outcome === "invalid") return { outcome: "unauthenticated" };
  if (authenticationResult.outcome === "unavailable") return { outcome: "unavailable" };
  const authentication = authenticationResult.authentication;
  const principalLimit = await enforcePrincipalLimits(
    dependencies,
    requestId,
    authentication.principal,
  );
  if (principalLimit !== null) return { outcome: "rejected", response: principalLimit };
  const requestIdError = validateCallerRequestId(context);
  if (requestIdError !== null) return { outcome: "invalid", detail: requestIdError };
  const rawOperationId = /^\/v1\/operations\/([^/:]+)(?::reconcile|\/events)?$/u.exec(
    context.req.path,
  )?.[1];
  const operationId = rawOperationId === undefined ? null : parseRouteUlid(rawOperationId);
  if (operationId === null) return { outcome: "invalid", detail: "Operation ID is invalid." };
  for (const organizationId of authentication.principal.organizationIds) {
    const operation = await dependencies.persistence.getOperation(organizationId, operationId);
    if (operation === null) continue;
    if (operation.operationId !== operationId) {
      throw new TypeError("Operation persistence result escaped its requested scope");
    }
    const projectDecision = await authorize(
      dependencies,
      authentication.principal,
      { kind: "project", organizationId, projectId: operation.projectId },
      "operations:read",
    );
    if (projectDecision === "unavailable") return { outcome: "unavailable" };
    return projectDecision === "allow"
      ? {
          outcome: "found",
          operation,
          organizationId,
          principal: authentication.principal,
          revalidate: authentication.revalidate,
        }
      : { outcome: "not_found" };
  }
  return { outcome: "not_found" };
}

async function parseCreateProjectRequest(context: Context): Promise<
  | {
      readonly outcome: "ok";
      readonly organizationId: Ulid;
      readonly name: string;
      readonly dataMode: "shared" | "isolated";
      readonly devAccessMode: "protected" | "public";
      readonly includeDevelopmentEnvironment: boolean;
      readonly region: HostingRegion;
      readonly source?: { readonly provider: "managed"; readonly template: "vite-react" | "empty" };
    }
  | {
      readonly outcome: "error";
      readonly status: 400 | 413;
      readonly code: "invalid_request" | "payload_too_large";
      readonly detail: string;
    }
> {
  if (!/^application\/json(?:\s*;|$)/iu.test(context.req.header("content-type") ?? "")) {
    return { outcome: "error", status: 400, code: "invalid_request", detail: "JSON is required." };
  }
  const contentEncoding = context.req.header("content-encoding");
  if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== "identity") {
    return {
      outcome: "error",
      status: 400,
      code: "invalid_request",
      detail: "Encoded request bodies are not accepted.",
    };
  }
  const declaredLength = Number(context.req.header("content-length"));
  if (Number.isFinite(declaredLength) && (declaredLength < 0 || declaredLength > MAX_JSON_BYTES)) {
    return {
      outcome: "error",
      status: 413,
      code: "payload_too_large",
      detail: "Request body is too large.",
    };
  }
  const body = await readBoundedBody(context.req.raw, MAX_JSON_BYTES);
  if (body.outcome === "too_large") {
    return {
      outcome: "error",
      status: 413,
      code: "payload_too_large",
      detail: "Request body is too large.",
    };
  }
  if (body.outcome === "invalid_utf8") {
    return {
      outcome: "error",
      status: 400,
      code: "invalid_request",
      detail: "Request body must be valid UTF-8.",
    };
  }
  if (body.outcome !== "ok") {
    throw new Error("Bounded body reader returned an unsupported outcome");
  }
  let value: unknown;
  try {
    assertIJsonText(body.text);
    value = JSON.parse(body.text) as unknown;
    assertIJsonValue(value);
  } catch {
    return { outcome: "error", status: 400, code: "invalid_request", detail: "JSON is invalid." };
  }
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => CREATE_PROJECT_KEYS.includes(key)) ||
    !("name" in value) ||
    !("organization_id" in value)
  ) {
    return {
      outcome: "error",
      status: 400,
      code: "invalid_request",
      detail: "Project request fields are invalid.",
    };
  }
  const rawSource = value["source"];
  const source =
    rawSource === undefined
      ? undefined
      : isRecord(rawSource) &&
          hasExactKeys(rawSource, ["provider", "template"]) &&
          rawSource["provider"] === "managed" &&
          (rawSource["template"] === "vite-react" || rawSource["template"] === "empty")
        ? {
            provider: "managed" as const,
            template: rawSource["template"] as "vite-react" | "empty",
          }
        : null;
  if (source === null)
    return {
      outcome: "error",
      status: 400,
      code: "invalid_request",
      detail: "Managed source must specify provider managed and template vite-react or empty.",
    };
  const name = value["name"];
  const rawOrganizationId = value["organization_id"];
  const dataMode = value["data_mode"] === undefined ? "shared" : value["data_mode"];
  const region = value["region"] === undefined ? DEFAULT_HOSTING_REGION : value["region"];
  const devAccessMode =
    value["dev_access_mode"] === undefined ? "protected" : value["dev_access_mode"];
  const includeDevelopmentEnvironment =
    value["include_development_environment"] === undefined
      ? true
      : value["include_development_environment"];
  if (
    typeof name !== "string" ||
    name !== name.trim() ||
    [...name].length < 1 ||
    [...name].length > 128 ||
    typeof rawOrganizationId !== "string" ||
    (dataMode !== "shared" && dataMode !== "isolated") ||
    (devAccessMode !== "protected" && devAccessMode !== "public") ||
    typeof includeDevelopmentEnvironment !== "boolean" ||
    !isHostingRegion(region)
  ) {
    return {
      outcome: "error",
      status: 400,
      code: "invalid_request",
      detail: "Project request fields are invalid.",
    };
  }
  const organizationId = parseRouteUlid(rawOrganizationId);
  return organizationId === null
    ? {
        outcome: "error",
        status: 400,
        code: "invalid_request",
        detail: "Organization ID is invalid.",
      }
    : {
        outcome: "ok",
        organizationId,
        name,
        dataMode,
        devAccessMode,
        includeDevelopmentEnvironment,
        region,
        ...(source === undefined ? {} : { source }),
      };
}

const CREATE_PROJECT_KEYS: readonly string[] = [
  "source",
  "data_mode",
  "dev_access_mode",
  "include_development_environment",
  "name",
  "organization_id",
  "region",
];

function isHostingRegion(value: unknown): value is HostingRegion {
  return (HOSTING_REGIONS as readonly unknown[]).includes(value);
}

function assertIJsonText(text: string): void {
  const end = scanJsonValue(text, skipJsonWhitespace(text, 0));
  if (skipJsonWhitespace(text, end) !== text.length) throw new TypeError("Trailing JSON data");
}

function scanJsonValue(text: string, start: number): number {
  const index = skipJsonWhitespace(text, start);
  const token = text[index];
  if (token === '"') return scanJsonString(text, index).end;
  if (token === "{") return scanJsonObject(text, index);
  if (token === "[") return scanJsonArray(text, index);
  for (const literal of ["true", "false", "null"] as const) {
    if (text.startsWith(literal, index)) return index + literal.length;
  }
  const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(index));
  if (number?.[0] !== undefined) return index + number[0].length;
  throw new TypeError("Invalid JSON value");
}

function scanJsonObject(text: string, start: number): number {
  let index = skipJsonWhitespace(text, start + 1);
  if (text[index] === "}") return index + 1;
  const keys = new Set<string>();
  while (true) {
    const key = scanJsonString(text, index);
    if (keys.has(key.value)) throw new TypeError("Duplicate JSON object key");
    keys.add(key.value);
    index = skipJsonWhitespace(text, key.end);
    if (text[index] !== ":") throw new TypeError("Invalid JSON object member");
    index = skipJsonWhitespace(text, scanJsonValue(text, index + 1));
    if (text[index] === "}") return index + 1;
    if (text[index] !== ",") throw new TypeError("Invalid JSON object separator");
    index = skipJsonWhitespace(text, index + 1);
  }
}

function scanJsonArray(text: string, start: number): number {
  let index = skipJsonWhitespace(text, start + 1);
  if (text[index] === "]") return index + 1;
  while (true) {
    index = skipJsonWhitespace(text, scanJsonValue(text, index));
    if (text[index] === "]") return index + 1;
    if (text[index] !== ",") throw new TypeError("Invalid JSON array separator");
    index = skipJsonWhitespace(text, index + 1);
  }
}

function scanJsonString(
  text: string,
  start: number,
): { readonly value: string; readonly end: number } {
  if (text[start] !== '"') throw new TypeError("JSON object key must be a string");
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const end = index + 1;
      const value = JSON.parse(text.slice(start, end)) as unknown;
      if (typeof value !== "string" || hasLoneSurrogate(value)) {
        throw new TypeError("JSON string is not valid I-JSON");
      }
      return { value, end };
    }
    if (character === "\\") {
      const escape = text[index + 1];
      if (escape === "u") {
        if (!/^[0-9A-Fa-f]{4}$/u.test(text.slice(index + 2, index + 6))) {
          throw new TypeError("Invalid JSON unicode escape");
        }
        index += 6;
        continue;
      }
      if (escape === undefined || !/["\\/bfnrt]/u.test(escape)) {
        throw new TypeError("Invalid JSON escape");
      }
      index += 2;
      continue;
    }
    if (character === undefined || character.charCodeAt(0) < 0x20) {
      throw new TypeError("Invalid JSON string character");
    }
    index += 1;
  }
  throw new TypeError("Unterminated JSON string");
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && isJsonWhitespace(text.charCodeAt(index))) {
    index += 1;
  }
  return index;
}

function assertIJsonValue(value: unknown): void {
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new TypeError("JSON string is not valid I-JSON");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON number is not valid I-JSON");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertIJsonValue(item);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (hasLoneSurrogate(key)) throw new TypeError("JSON object key is not valid I-JSON");
      assertIJsonValue(item);
    }
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<
  | { readonly outcome: "ok"; readonly text: string }
  | { readonly outcome: "too_large" | "invalid_utf8" }
> {
  if (request.body === null) return { outcome: "ok", text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("body limit exceeded");
      return { outcome: "too_large" };
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { outcome: "ok", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { outcome: "invalid_utf8" };
  }
}

function parseAuditFilters(context: Context): {
  readonly projectId?: Ulid;
  readonly operationId?: Ulid;
  readonly cursor?: string;
  readonly limit: number;
} | null {
  const rawProject = context.req.query("project_id");
  const rawOperation = context.req.query("operation_id");
  const cursor = context.req.query("cursor");
  const rawLimit = context.req.query("limit");
  const projectId = rawProject === undefined ? undefined : parseRouteUlid(rawProject);
  const operationId = rawOperation === undefined ? undefined : parseRouteUlid(rawOperation);
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (
    projectId === null ||
    operationId === null ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== undefined && !/^[A-Za-z0-9_-]+$/u.test(cursor))
  ) {
    return null;
  }
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  };
}

function operationBody(operation: {
  readonly operationId: Ulid;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly failureDiagnostic?: OperationView["failureDiagnostic"];
  readonly result?: Operation["result"];
  readonly events: Parameters<typeof rehydrateOperation>[0];
  readonly reconciliation?: OperationView["reconciliation"];
}): Record<string, unknown> {
  const canonical = rehydrateOperation(operation.events);
  if (
    canonical.operationId !== operation.operationId ||
    canonical.state !== operation.state ||
    canonical.createdAt !== operation.createdAt ||
    canonical.updatedAt !== operation.updatedAt ||
    canonical.failure?.code !== operation.failure?.code ||
    canonical.failure?.message !== operation.failure?.message ||
    JSON.stringify(canonical.result) !== JSON.stringify(operation.result)
  ) {
    throw new TypeError("Operation output does not match its immutable history");
  }
  parseUlid(operation.operationId);
  if (!isOperationState(operation.state)) throw new TypeError("Operation state is invalid");
  if (
    operation.reconciliation !== undefined &&
    operation.state !== "queued" &&
    operation.state !== "running"
  )
    throw new TypeError("Terminal operation has reconciliation guidance");
  return {
    id: operation.operationId,
    state: operation.state,
    created_at: operation.createdAt,
    updated_at: operation.updatedAt,
    ...(operation.reconciliation === undefined
      ? {}
      : { reconciliation: publicOperationReconciliation(operation.reconciliation) }),
    ...(canonical.result === undefined ? {} : { result: canonical.result }),
    ...(operation.failure === undefined
      ? {}
      : {
          error: publicOperationFailure(operation.failure.code, operation.failureDiagnostic),
        }),
  };
}

function providerReconciliationBody(
  reconciliation: {
    readonly attemptId: Ulid;
    readonly operationId: Ulid;
    readonly state: "completed" | "pending" | "uncertain";
  },
  expectedOperationId: Ulid,
) {
  parseUlid(reconciliation.attemptId);
  parseUlid(reconciliation.operationId);
  if (reconciliation.operationId !== expectedOperationId) {
    throw new TypeError("Provider reconciliation escaped its requested operation scope");
  }
  return Object.freeze({
    reconciliation_id: reconciliation.attemptId,
    operation_id: reconciliation.operationId,
    state: reconciliation.state,
  });
}

/** The accepted project creation answer: the operation plus the new project's identifier. */
function storedProjectCreateBody(body: unknown): Record<string, unknown> {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["created_at", "id", "project_id", "state", "updated_at"]) ||
    body["state"] !== "queued"
  )
    throw new TypeError("Stored project creation result is invalid");
  const { project_id: projectId, ...operation } = body;
  if (typeof projectId !== "string") throw new TypeError("Stored project identifier is invalid");
  parseUlid(projectId);
  return { ...storedOperationBody(operation), project_id: projectId };
}

function storedOperationBody(body: unknown): Record<string, unknown> {
  const expectedKeys = [
    "created_at",
    "id",
    "state",
    "updated_at",
    ...(isRecord(body) && "error" in body ? ["error"] : []),
    ...(isRecord(body) && "reconciliation" in body ? ["reconciliation"] : []),
    ...(isRecord(body) && "blocking_operation_id" in body ? ["blocking_operation_id"] : []),
  ]
    .sort()
    .join(",");
  if (
    !isRecord(body) ||
    Object.keys(body).sort().join(",") !== expectedKeys ||
    typeof body["id"] !== "string" ||
    typeof body["state"] !== "string" ||
    !isOperationState(body["state"]) ||
    typeof body["created_at"] !== "string" ||
    typeof body["updated_at"] !== "string"
  ) {
    throw new TypeError("Stored operation response is invalid");
  }
  parseUlid(body["id"]);
  if ("blocking_operation_id" in body) {
    if (typeof body["blocking_operation_id"] !== "string")
      throw new TypeError("Stored blocking operation is invalid");
    parseUlid(body["blocking_operation_id"]);
  }
  assertCanonicalTimestamp(body["created_at"], "Stored operation created timestamp");
  assertCanonicalTimestamp(body["updated_at"], "Stored operation updated timestamp");
  if (body["state"] === "queued" && body["created_at"] !== body["updated_at"]) {
    throw new TypeError("Stored queued operation timestamps must match");
  }
  let failure: PublicOperationFailure | undefined;
  if (body["state"] === "failed") {
    const error = body["error"];
    if (!isRecord(error) || typeof error["code"] !== "string")
      throw new TypeError("Stored operation failure is invalid");
    // Accept only the closed metadata of a migration failure; all other details are catalog-rendered.
    const hasMigration = Object.hasOwn(error, "migration"),
      migration = hasMigration ? parseMigrationFailureDiagnostic(error["migration"]) : null;
    if (hasMigration && (error["code"] !== "database_migration_failed" || migration === null))
      throw new TypeError("Stored operation failure is invalid");
    failure = publicOperationFailure(
      error["code"],
      migration ?? frameworkConversionDiagnosticFromDetail(error["detail"]),
    );
    if (
      Object.keys(error).sort().join(",") !== Object.keys(failure).sort().join(",") ||
      error["code"] !== failure.code ||
      error["retryable"] !== false ||
      error["suggested_action"] !== failure.suggested_action ||
      error["detail"] !== failure.detail ||
      typeof error["message"] !== "string" ||
      error["message"].length < 1 ||
      error["message"].length > 512
    ) {
      throw new TypeError("Stored operation failure is invalid");
    }
  } else if (body["error"] !== undefined) {
    throw new TypeError("Stored non-failed operation has an error");
  }
  let reconciliation;
  if (body["reconciliation"] !== undefined) {
    const observation = body["reconciliation"];
    if (
      (body["state"] !== "queued" && body["state"] !== "running") ||
      !isRecord(observation) ||
      Object.keys(observation).sort().join(",") !== "attempt_id,observed_at,state,suggested_action"
    )
      throw new TypeError("Stored reconciliation guidance is invalid");
    reconciliation = publicOperationReconciliation(
      observation as unknown as NonNullable<OperationView["reconciliation"]>,
    );
    if (reconciliation.suggested_action !== observation["suggested_action"])
      throw new TypeError("Stored reconciliation guidance is invalid");
  }
  return {
    id: body["id"],
    state: body["state"],
    created_at: body["created_at"],
    updated_at: body["updated_at"],
    ...(reconciliation === undefined ? {} : { reconciliation }),
    ...(failure === undefined ? {} : { error: failure }),
  };
}

function projectBody(project: {
  readonly projectId: Ulid;
  readonly organizationId: Ulid;
  readonly name: string;
  readonly handle: string;
  readonly dataMode: "shared" | "isolated";
  readonly region: HostingRegion;
  readonly createdAt: string;
}): Record<string, unknown> {
  parseUlid(project.projectId);
  parseUlid(project.organizationId);
  if (project.dataMode !== "shared" && project.dataMode !== "isolated")
    throw new TypeError("Project data mode is invalid");
  if (!isHostingRegion(project.region)) throw new TypeError("Project hosting region is invalid");
  if (
    project.name !== project.name.trim() ||
    [...project.name].length < 1 ||
    [...project.name].length > 128
  ) {
    throw new TypeError("Project name is invalid");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(project.handle) || project.handle.length > 59) {
    throw new TypeError("Project handle is invalid");
  }
  assertCanonicalTimestamp(project.createdAt, "Project created timestamp");
  return {
    id: project.projectId,
    organization_id: project.organizationId,
    name: project.name,
    handle: project.handle,
    data_mode: project.dataMode,
    region: project.region,
    created_at: project.createdAt,
  };
}

function strongResourceEtag(body: Readonly<Record<string, unknown>>): string {
  const serializeCanonicalJson = canonicalize as unknown as (input: unknown) => string | undefined;
  const canonical = serializeCanonicalJson(body);
  if (canonical === undefined) throw new TypeError("Resource cannot be canonicalized");
  return `"sha256-${createHash("sha256").update(canonical).digest("hex")}"`;
}

function auditEventBody(event: {
  readonly eventId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid | null;
  readonly eventType: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly summary: string;
  readonly occurredAt: string;
}): Record<string, unknown> {
  parseUlid(event.eventId);
  parseUlid(event.projectId);
  if (event.operationId !== null) parseUlid(event.operationId);
  if (
    event.eventType.trim() === "" ||
    event.actorType.trim() === "" ||
    event.actorId.trim() === "" ||
    event.summary.trim() === "" ||
    event.summary.length > 512
  ) {
    throw new TypeError("Audit event output is invalid");
  }
  assertCanonicalTimestamp(event.occurredAt, "Audit event timestamp");
  return {
    audit_event_id: event.eventId,
    project_id: event.projectId,
    ...(event.operationId === null ? {} : { operation_id: event.operationId }),
    event_type: event.eventType,
    actor_type: event.actorType,
    actor_id: event.actorId,
    payload: { summary: event.summary },
    occurred_at: event.occurredAt,
  };
}

/** An operation fails once, at its last event, so its stored diagnostic belongs to that event. */
function operationEventBody(
  event: {
    readonly eventId: Ulid;
    readonly operationId: Ulid;
    readonly projectId: Ulid;
    readonly type: string;
    readonly occurredAt: string;
    readonly failure?: { readonly code: string; readonly message: string };
  },
  failureDiagnostic: OperationView["failureDiagnostic"],
): Record<string, unknown> {
  parseUlid(event.eventId);
  parseUlid(event.operationId);
  parseUlid(event.projectId);
  if (!isOperationEventType(event.type)) throw new TypeError("Operation event type is invalid");
  assertCanonicalTimestamp(event.occurredAt, "Operation event timestamp");
  return {
    event_id: event.eventId,
    operation_id: event.operationId,
    project_id: event.projectId,
    type: event.type,
    occurred_at: event.occurredAt,
    ...(event.failure === undefined
      ? {}
      : { failure: publicOperationFailure(event.failure.code, failureDiagnostic) }),
  };
}

function operationEventStream(
  dependencies: ControlApiDependencies,
  initial: {
    readonly operation: NonNullable<
      Awaited<ReturnType<ControlApiDependencies["persistence"]["getOperation"]>>
    >;
    readonly organizationId: Ulid;
    readonly principal: AuthenticatedPrincipal;
    readonly revalidate: () => Promise<RequestAuthenticationResult>;
  },
  signal: AbortSignal,
  lastEventId: string | undefined,
  requestId: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  let delivered = continuationIndex(initial.operation.events, lastEventId);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => {
        cancelled = true;
        try {
          controller.close();
        } catch {
          // The consumer may already have cancelled the stream.
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      const run = async () => {
        let operation = initial.operation;
        let principal = initial.principal;
        let heartbeatAt = Date.now();
        let revalidatedAt = heartbeatAt;
        while (!cancelled) {
          while (delivered < operation.events.length) {
            const event = operation.events[delivered];
            if (event === undefined) break;
            await waitForDemand(controller, () => cancelled);
            if (cancelled) return;
            controller.enqueue(
              encoder.encode(
                `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(operationEventBody(event, operation.failureDiagnostic))}\n\n`,
              ),
            );
            delivered += 1;
          }
          if (isTerminalOperationState(operation.state)) {
            controller.close();
            return;
          }
          if (Date.now() - heartbeatAt >= 15_000) {
            await waitForDemand(controller, () => cancelled);
            if (cancelled) return;
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            heartbeatAt = Date.now();
          }
          await delay(1_000, signal);
          if (cancelled || signal.aborted) return;
          // Access is revalidated every fifteen seconds, like the heartbeat; events still come on every one-second tick.
          if (Date.now() - revalidatedAt >= 15_000) {
            revalidatedAt = Date.now();
            const revalidated = await initial.revalidate();
            if (revalidated.outcome === "unavailable") {
              reportFailure(
                dependencies,
                requestId,
                "STREAM_AUTHENTICATION_UNAVAILABLE",
                "/v1/operations/{operation_id}/events",
              );
            }
            if (
              revalidated.outcome !== "authenticated" ||
              !samePrincipal(principal, revalidated.authentication.principal)
            ) {
              controller.close();
              return;
            }
            principal = revalidated.authentication.principal;
            const decision = await authorize(
              dependencies,
              principal,
              {
                kind: "project",
                organizationId: initial.organizationId,
                projectId: operation.projectId,
              },
              "operations:read",
            );
            if (decision === "unavailable") {
              reportFailure(
                dependencies,
                requestId,
                "STREAM_AUTHORIZATION_UNAVAILABLE",
                "/v1/operations/{operation_id}/events",
              );
            }
            if (decision !== "allow") {
              controller.close();
              return;
            }
          }
          const refreshed = await dependencies.persistence.getOperation(
            initial.organizationId,
            operation.operationId,
          );
          if (refreshed === null) {
            controller.close();
            return;
          }
          if (
            refreshed.operationId !== operation.operationId ||
            refreshed.projectId !== operation.projectId
          ) {
            throw new TypeError("Operation stream persistence result escaped its requested scope");
          }
          operation = refreshed;
        }
      };
      void run()
        .catch(() => {
          if (!cancelled) {
            reportFailure(
              dependencies,
              requestId,
              "OPERATION_STREAM_FAILED",
              "/v1/operations/{operation_id}/events",
            );
            controller.error(new Error("Operation event stream failed"));
          }
        })
        .finally(() => signal.removeEventListener("abort", abort));
    },
    cancel() {
      cancelled = true;
    },
  });
}

function continuationIndex(
  events: readonly { readonly eventId: Ulid }[],
  lastEventId: string | undefined,
): number {
  if (lastEventId === undefined || lastEventId === "") return 0;
  const index = events.findIndex((event) => event.eventId === lastEventId);
  return index === -1 ? 0 : index + 1;
}

async function waitForDemand(
  controller: ReadableStreamDefaultController<Uint8Array>,
  cancelled: () => boolean,
): Promise<void> {
  while (!cancelled() && (controller.desiredSize ?? 1) <= 0) {
    await delay(10);
  }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const aborted = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function isTerminalOperationState(state: string): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function samePrincipal(left: AuthenticatedPrincipal, right: AuthenticatedPrincipal): boolean {
  return (
    left.connectionDisconnected === right.connectionDisconnected &&
    left.actorId === right.actorId &&
    left.credentialId === right.credentialId &&
    left.authorizationPrincipal.kind === right.authorizationPrincipal.kind &&
    left.authorizationPrincipal.subjectId === right.authorizationPrincipal.subjectId &&
    arraysEqual(left.organizationIds, right.organizationIds) &&
    left.selectedOrganizationId === right.selectedOrganizationId &&
    JSON.stringify(left.authorizationRestriction) ===
      JSON.stringify(right.authorizationRestriction) &&
    JSON.stringify(left.handoffDelegation) === JSON.stringify(right.handoffDelegation) &&
    ((left.authorizationScopeConstraint === undefined &&
      right.authorizationScopeConstraint === undefined) ||
      (left.authorizationScopeConstraint !== undefined &&
        right.authorizationScopeConstraint !== undefined &&
        arraysEqual(left.authorizationScopeConstraint, right.authorizationScopeConstraint)))
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isOperationState(value: string): boolean {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isOperationEventType(value: string): boolean {
  return (
    value === "OperationQueued" ||
    value === "OperationStarted" ||
    value === "OperationSucceeded" ||
    value === "OperationFailed" ||
    value === "OperationCancelled"
  );
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

export function problem<Code extends ProblemCode>(
  requestId: string,
  status: (typeof PROBLEM_POLICY)[Code]["status"],
  code: Code,
  detail: string,
  _retryable?: boolean,
  retryAfterSeconds?: number,
): Response {
  // The policy alone decides the status, so a caller that names another one is a defect, not a response.
  if (status !== PROBLEM_POLICY[code].status)
    throw new TypeError(`Problem ${code} is answered with ${PROBLEM_POLICY[code].status}`);
  const slug = code.replaceAll("_", "-");
  return setUsageResponse(
    new Response(
      JSON.stringify({
        type: `https://docs.ohmyho.st/errors/${slug}`,
        title: titleFor(code),
        status: PROBLEM_POLICY[code].status,
        detail,
        code,
        request_id: requestId,
        retryable: PROBLEM_POLICY[code].retryable,
        suggested_action: suggestedActionFor(code),
        ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }),
      }),
      {
        status: PROBLEM_POLICY[code].status,
        headers: {
          "Content-Type": "application/problem+json; charset=utf-8",
          "X-Request-Id": requestId,
        },
      },
    ),
    { code },
  );
}

async function enforceBaseLimits(
  dependencies: ControlApiDependencies,
  requestId: string,
  clientIp: string | undefined,
): Promise<Response | null> {
  const application = await enforceLimit(
    dependencies,
    requestId,
    "application",
    `${dependencies.applicationId}:ip:${rateLimitClientKey(clientIp)}`,
  );
  return application;
}

async function enforceLimit(
  dependencies: ControlApiDependencies,
  requestId: string,
  dimension: "application" | "credential" | "actor" | "organization" | "project",
  key: string,
): Promise<Response | null> {
  try {
    const decision = await dependencies.rateLimits.consume({ dimension, key });
    if (decision.allowed) return null;
    if (
      !Number.isSafeInteger(decision.retryAfterSeconds) ||
      decision.retryAfterSeconds < 1 ||
      decision.retryAfterSeconds > 86_400
    ) {
      throw new TypeError("Rate limiter returned an invalid retry interval");
    }
    const response = problem(
      requestId,
      429,
      "rate_limited",
      "The request rate limit was exceeded.",
      true,
      decision.retryAfterSeconds,
    );
    response.headers.set("Retry-After", String(decision.retryAfterSeconds));
    return response;
  } catch {
    reportFailure(dependencies, requestId, "RATE_LIMIT_UNAVAILABLE", "rate-limit");
    return problem(
      requestId,
      503,
      "service_unavailable",
      "Request admission is temporarily unavailable.",
      true,
    );
  }
}

function reportFailure(
  dependencies: ControlApiDependencies,
  requestId: string,
  code: string,
  route: string,
): void {
  try {
    const result = dependencies.reporter.report({ requestId, code, route });
    void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Reporting failure cannot change or reveal the request outcome.
  }
}

function json(
  body: unknown,
  status: number,
  requestId: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return setUsageResponse(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Request-Id": requestId,
        ...headers,
      },
    }),
    {},
  );
}

function setSecurityHeaders(context: Context, allowedOrigins: ReadonlySet<string>): void {
  context.header("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
  // Only authenticated callback success gets the static template policy; errors and every
  // other API endpoint retain the strict default, regardless of response-supplied headers.
  const callbackSuccess =
    context.req.path === "/v1/cloudflare/oauth/callback" &&
    context.res.status === 200 &&
    context.res.headers.get("content-type")?.startsWith("text/html;");
  context.header(
    "Content-Security-Policy",
    callbackSuccess ? standalonePageCsp() : "default-src 'none'; frame-ancestors 'none'",
  );
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "no-referrer");
  if (!context.res.headers.has("Cache-Control")) context.header("Cache-Control", "no-store");
  const origin = context.req.header("origin");
  if (origin !== undefined && allowedOrigins.has(origin)) {
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Vary", "Origin");
  }
}

function requestIdFor(context: Context, createRequestId: () => string): string {
  const supplied = context.req.header("x-request-id");
  return supplied !== undefined && validRequestId(supplied) ? supplied : createRequestId();
}

function validateCallerRequestId(context: Context): string | null {
  const supplied = context.req.header("x-request-id");
  return supplied === undefined || validRequestId(supplied) ? null : "X-Request-Id is invalid.";
}

function validRequestId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !containsControlCharacter(value);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20;
}

function safeRouteLabel(path: string): string {
  if (path === "/v1/projects") return "/v1/projects";
  const databaseEventLabel = DATABASE_EVENT_ROUTE_LABELS.find(([pattern]) => pattern.test(path));
  if (databaseEventLabel !== undefined) return databaseEventLabel[1];
  if (/^\/v1\/projects\/[^/]+:delete-plan$/u.test(path))
    return "/v1/projects/{project_id}:delete-plan";
  if (/^\/v1\/projects\/[^/]+$/u.test(path)) return "/v1/projects/{project_id}";
  if (/^\/v1\/projects\/[^/]+\/source(?::link)?$/u.test(path))
    return "/v1/projects/{project_id}/source";
  if (/^\/v1\/projects\/[^/]+\/source\/auto-deploy$/u.test(path))
    return "/v1/projects/{project_id}/source/auto-deploy";
  if (/^\/v1\/projects\/[^/]+\/cloudflare-dns(?:\/authorization)?$/u.test(path))
    return "/v1/projects/{project_id}/cloudflare-dns";
  if (/^\/v1\/projects\/[^/]+\/domains$/u.test(path)) return "/v1/projects/{project_id}/domains";
  if (path === "/v1/cloudflare/oauth/callback") return "/v1/cloudflare/oauth/callback";
  if (/^\/v1\/projects\/[^/]+\/dev-share-link(?::rotate)?$/u.test(path))
    return "/v1/projects/{project_id}/dev-share-link";
  if (/^\/v1\/projects\/[^/]+\/preview\/token$/u.test(path))
    return "/v1/projects/{project_id}/preview/token";
  if (/^\/v1\/projects\/[^/]+\/preview$/u.test(path)) return "/v1/projects/{project_id}/preview";
  if (/^\/v1\/projects\/[^/]+\/dev-access-mode$/u.test(path))
    return "/v1/projects/{project_id}/dev-access-mode";
  if (/^\/v1\/projects\/[^/]+\/powered-by-flag$/u.test(path))
    return "/v1/projects/{project_id}/powered-by-flag";
  if (/^\/v1\/projects\/[^/]+\/dev-access-tickets$/u.test(path))
    return "/v1/projects/{project_id}/dev-access-tickets";
  if (/^\/v1\/projects\/[^/]+\/database\/access(?:\/[^/]+)?$/u.test(path))
    return "/v1/projects/{project_id}/database/access";
  if (/^\/v1\/projects\/[^/]+\/deployments/u.test(path))
    return "/v1/projects/{project_id}/deployments";
  if (/^\/v1\/operations\/[^/]+\/events$/u.test(path)) {
    return "/v1/operations/{operation_id}/events";
  }
  if (/^\/v1\/operations\/[^/]+$/u.test(path)) return "/v1/operations/{operation_id}";
  if (path === "/v1/audit-events") return "/v1/audit-events";
  return "unmatched";
}

function isOpaqueOAuthValue(value: string, minimum: number, maximum: number): boolean {
  return (
    value.length >= minimum &&
    value.length <= maximum &&
    !containsControlCharacter(value) &&
    /^[A-Za-z0-9._~-]+$/u.test(value)
  );
}

function parseRouteUlid(value: string): Ulid | null {
  try {
    return parseUlid(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function titleFor(code: ProblemCode): string {
  return PROBLEM_POLICY[code].title;
}

function suggestedActionFor(code: ProblemCode): string {
  const policy = PROBLEM_POLICY[code];
  return "restAction" in policy ? policy.restAction : policy.action;
}
