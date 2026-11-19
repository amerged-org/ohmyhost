import { channel } from "node:diagnostics_channel";
import { isIP } from "node:net";
import { parseBrowserPolicy, type BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import {
  isNativeAuthPublicRoute,
  NATIVE_AUTH_BASE_PATH,
  NATIVE_AUTH_REQUEST_DEADLINE_MS,
  type NativeAuthRealmContext,
} from "@ohmyhost/contracts/native-auth";
import {
  verifyDevAccessSession,
  verifyDevRuntimeProbe,
  type DevAccessScope,
  type DevRuntimeProbeScope,
} from "@ohmyhost/dev-access-tokens";
import {
  buildEgressContext,
  cpuLimitMessage,
  isCpuLimitError,
  WFP_DISPATCH_LIMITS,
} from "@ohmyhost/contracts/wfp-dispatch";
import { isDnsEgressOrigin } from "@ohmyhost/contracts/egress-origin";
import type { DevAccessServiceBinding, DispatchNamespaceBinding } from "./dispatch.js";
import { poweredByFlagMarkup } from "./powered-by-flag.js";
import { routePreviewRequest, type PreviewIngressEnvironment } from "./preview-routing.js";
import {
  browserContentSecurityPolicy,
  isBrowserMutationAllowed,
  refusesPlatformCookie,
  secureBrowserCors,
} from "./browser-security.js";

/** Private Control routing result: no authority may be supplied by the browser. */
export interface SharedGatewayTarget {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly environmentName: "dev" | "prod";
  readonly handle: string;
  readonly hostname: string;
  readonly publicOrigin: string;
  readonly targetDeploymentId: string;
  readonly targetScriptName: string;
  readonly egressAllowedOrigins: readonly string[];
  readonly browserPolicy?: BrowserPolicy;
  /** Native capability stays reserved while paused; the private runtime checks current policy. */
  readonly nativeAuth?: Readonly<{
    realmGeneration: number | null;
    configurationRevision: number | null;
    region: "us" | "eu";
  }>;
  readonly devAccess: Readonly<{ keyId: `sha256:${string}`; publicJwk: JsonWebKey }> | null;
  /** The owner shows the "Powered by ohmyho.st" flag on this production site. */
  readonly poweredBy: boolean;
}

interface HtmlRewriterElement {
  append(content: string, options: Readonly<{ html: boolean }>): void;
}
interface HtmlRewriter {
  on(selector: string, handlers: Readonly<{ element(element: HtmlRewriterElement): void }>): this;
  transform(response: Response): Response;
}
declare const HTMLRewriter: new () => HtmlRewriter;

export interface GatewayRoutingServiceBinding {
  resolve(input: Readonly<{ hostname: string }>): Promise<unknown>;
}

export interface GatewayCreditServiceBinding {
  read(
    input: Readonly<{
      organizationId: string;
      projectId: string;
      environmentId: string;
      includePaidPlan: true;
    }>,
  ): Promise<unknown>;
}

export interface GatewayNativeAuthServiceBinding {
  fetchPublic(
    request: Request,
    scope: NativeAuthRealmContext & Readonly<{ deploymentId: string }>,
    client: Readonly<{ clientAddress: string }>,
  ): Promise<Response>;
}

export interface DiagnosticRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface SharedGatewayEnvironment extends PreviewIngressEnvironment {
  readonly OMH_DATABASE_CUTOVER_MAINTENANCE?: string;
  readonly DEV_AUTH_ATOMIC_MODE?: string;
  readonly NATIVE_GATEWAY_LATENCY_PROFILE?: string;
  readonly GATEWAY_ROUTING: GatewayRoutingServiceBinding;
  readonly DISPATCHER: DispatchNamespaceBinding;
  readonly DEV_ACCESS: DevAccessServiceBinding;
  readonly CREDIT_ADMISSION: GatewayCreditServiceBinding;
  /** Private service; it independently rechecks current realm and deployment authority. */
  readonly NATIVE_AUTH_US?: GatewayNativeAuthServiceBinding;
  readonly NATIVE_AUTH_EU?: GatewayNativeAuthServiceBinding;
  readonly DIAGNOSTIC_MARKER_SIGNING_KEY_BASE64: string;
  /** Optional: absent or failing publishes every marker, as before the limiter existed. */
  readonly DIAGNOSTIC_LIMITER?: DiagnosticRateLimitBinding;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const COOKIE_NAME = "__Host-ohmyhost_dev_access";
const UNAVAILABLE_PAGE =
  "This page is unavailable or requires access. For a protected Dev app, ask the project owner for a current Dev share link from project status (ohmyhost project dev-share link). Help: https://docs.ohmyho.st/";
const PROBE_HEADER = "x-ohmyhost-runtime-probe";
// The only path Control issues share links and redemption URLs for: every other path, with any
// query, belongs to the app.
const REDEEM_PATH = "/.ohmyhost/dev-access/redeem";
const STATIC_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; manifest-src 'self'; worker-src 'none'";
const SECURITY_HEADERS = Object.freeze({
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "same-origin",
  // A custom apex keeps its own subdomains' HTTPS policy: HSTS covers only this host.
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml; charset=utf-8",
});

// Per-isolate route and credit caches retain their bounded validity. Dev authorization is never
// cached: a share-link revocation or Dev access mode change applies to the next request (D334).
const ROUTE_CACHE_MS = 30_000;
// An unknown hostname is remembered briefly, and concurrent Core route lookups are capped per isolate.
const NEGATIVE_ROUTE_CACHE_MS = 15_000;
// A marker names one deployment's failure: one per deployment per window and isolate keeps a failing URL from flooding Core.
const DIAGNOSTIC_WINDOW_MS = 60_000;
// Concurrent Core route lookups per isolate: known hostnames and never-resolved hostnames have separate budgets, so a
// flood of random hostnames cannot hold the slots a hot hostname needs.
const ROUTE_LOOKUP_CONCURRENCY = 32;
const ROUTE_LOOKUP_UNKNOWN_CONCURRENCY = 16;
// A hostname that resolved stays known for an hour, so its expired route refreshes on the known budget.
const KNOWN_ROUTE_MS = 3_600_000;
const CREDIT_CACHE_MS = 300_000;
const CACHE_ENTRIES = 4096;
// A pause names its cause and the owner's way out; the credit cache above bounds the recovery.
const PAUSED = Object.freeze({
  project_budget_exceeded:
    "Project execution paused: this project's Stop budget is used up (project_budget_exceeded). Raise the budget or switch it to continue; the app serves again within about five minutes.",
  insufficient_organization_credits:
    "Project execution paused: the organization's credits are used up (insufficient_organization_credits). Add credits; the app serves again within about five minutes.",
  paid_plan_required:
    "Project execution paused: a custom domain needs Paid access or the project's powered-by flag (paid_plan_required); the project's check.omh.st address still serves.",
  native_paid_plan_required: "Native Auth requires Paid access (paid_plan_required).",
});
type Admission = 200 | 404 | 503 | keyof typeof PAUSED;
type CreditDecision = Readonly<{ allowed: boolean; paidAllowed: boolean; reason: unknown }>;
type Cached<T> = Readonly<{ value: T; until: number }>;

// ASSETS decodes path segments and collapses slashes. Check successive decodings too, so a
// customer's URL normalization cannot turn an admitted public path into a private cache read.
function isPrivateNextCachePath(pathname: string): boolean {
  const prefix = "/cdn-cgi/_next_cache";
  let path = pathname;
  while (true) {
    const segments: string[] = [];
    for (const segment of path.replaceAll(String.fromCharCode(92), "/").split("/")) {
      if (segment === "..") segments.pop();
      else if (segment !== "" && segment !== ".") segments.push(segment);
    }
    const normalized = `/${segments.join("/")}`;
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
    const decoded = path
      .split("/")
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .join("/");
    if (decoded === path) return false;
    path = decoded;
  }
}

export function createSharedGatewayWorker(
  options: Readonly<{
    now?: () => Date;
    diagnosticSink?: (value: unknown) => void;
    latencyClock?: () => number;
    latencySink?: (value: string) => void;
  }> = {},
) {
  const now = options.now ?? (() => new Date());
  const routes = new Map<string, Cached<SharedGatewayTarget>>();
  const misses = new Map<string, Cached<true>>();
  const diagnosticWindows = new Map<string, Cached<true>>();
  // One in-flight Core lookup per hostname, shared by every concurrent request for it.
  const routeLookups = new Map<string, Promise<unknown>>();
  const knownRoutes = new Map<string, Cached<true>>();
  let knownLookups = 0;
  let unknownLookups = 0;
  // Starts or joins the lookup for one hostname; a saturated budget throws and the caller answers 503.
  const lookupRoute = (
    environment: SharedGatewayEnvironment,
    hostname: string,
    at: Date,
  ): Promise<unknown> => {
    const existing = routeLookups.get(hostname);
    if (existing !== undefined) return existing;
    const known = recall(knownRoutes, hostname, at) !== undefined;
    if (
      known
        ? knownLookups >= ROUTE_LOOKUP_CONCURRENCY
        : unknownLookups >= ROUTE_LOOKUP_UNKNOWN_CONCURRENCY
    )
      throw new Error("route_lookups_saturated");
    if (known) knownLookups += 1;
    else unknownLookups += 1;
    const lookup = (async () =>
      bounded(environment.GATEWAY_ROUTING.resolve({ hostname }), 5000))().finally(() => {
      routeLookups.delete(hostname);
      if (known) knownLookups -= 1;
      else unknownLookups -= 1;
    });
    routeLookups.set(hostname, lookup);
    return lookup;
  };
  const credits = new Map<string, Cached<CreditDecision>>();
  async function creditAdmission(
    environment: SharedGatewayEnvironment,
    target: SharedGatewayTarget,
    customDomain: boolean,
    nativeAuth: boolean,
  ): Promise<Admission> {
    const key = `${target.organizationId}:${target.projectId}:${target.environmentId}`;
    let decision = recall(credits, key, now());
    if (decision === undefined) {
      const read = await readCreditDecision(environment, target, now());
      if (read === null) return 503;
      remember(credits, key, read.value, read.until);
      decision = read.value;
    }
    if (nativeAuth && decision.allowed && decision.reason === null && !decision.paidAllowed)
      return "native_paid_plan_required";
    return creditStatus(decision, customDomain, target.poweredBy);
  }
  return Object.freeze({
    async fetch(request: Request, environment: SharedGatewayEnvironment): Promise<Response> {
      const clock = () => {
        try {
          const n = options.latencyClock === undefined ? performance.now() : options.latencyClock();
          return Number.isFinite(n) && n >= 0 ? n : null;
        } catch {
          return null;
        }
      };
      const timingCandidate =
        environment.NATIVE_GATEWAY_LATENCY_PROFILE === "c5-development-v1" &&
        request.method === "GET";
      const totalStart = timingCandidate ? clock() : null;
      const durations: Record<
        | "routeLookupMs"
        | "localDevVerificationMs"
        | "devAuthorizationMs"
        | "creditAdmissionMs"
        | "workerDispatchMs",
        number | null
      > = {
        routeLookupMs: null,
        localDevVerificationMs: null,
        devAuthorizationMs: null,
        creditAdmissionMs: null,
        workerDispatchMs: null,
      };
      const finish = (key: keyof typeof durations, start: number | null) => {
        if (start === null) return;
        const end = clock();
        if (end !== null && end >= start) durations[key] = end - start;
      };
      let eligible = false;
      let responseStatus: number | null = null;
      try {
        const result = await (async (): Promise<Response> => {
          if (environment.OMH_DATABASE_CUTOVER_MAINTENANCE === "on")
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
          const url = new URL(request.url);
          const preview = await routePreviewRequest(request, environment);
          if (preview !== null) return preview;
          if (isPrivateNextCachePath(url.pathname)) return plain("", 404);
          if (
            url.protocol !== "https:" ||
            url.port !== "" ||
            url.username !== "" ||
            url.password !== "" ||
            !canonicalHostname(url.hostname)
          )
            return plain("", 404);
          let target: SharedGatewayTarget;
          try {
            const cached = recall(routes, url.hostname, now());
            if (cached === undefined) {
              if (recall(misses, url.hostname, now()) !== undefined) {
                const response = plain("", 404);
                response.headers.set("x-ohmyhost-gateway", "shared-v1");
                return response;
              }
              const routeStarted = timingCandidate ? clock() : null;
              let value: unknown;
              try {
                value = await lookupRoute(environment, url.hostname, now());
              } finally {
                finish("routeLookupMs", routeStarted);
              }
              if (value === null) {
                remember(misses, url.hostname, true, now().getTime() + NEGATIVE_ROUTE_CACHE_MS);
                const response = plain("", 404);
                response.headers.set("x-ohmyhost-gateway", "shared-v1");
                return response;
              }
              target = parseTarget(value, url.hostname);
              remember(routes, url.hostname, target, now().getTime() + ROUTE_CACHE_MS);
              remember(knownRoutes, url.hostname, true, now().getTime() + KNOWN_ROUTE_MS);
              misses.delete(url.hostname);
            } else target = cached;
            eligible =
              timingCandidate &&
              url.pathname === "/protected" &&
              target.projectId === "01M6PG6R7A0B8YJ9PBMZ9AB565" &&
              target.environmentId === "01M6PG6R7A0B8YJ9PBMZ9AB56A" &&
              target.environmentName === "dev";
            if (typeof environment.DISPATCHER?.get !== "function")
              return plain("Service unavailable", 503);
          } catch {
            return plain("Service unavailable", 503);
          }
          let upstream = request;
          let runtimeProbe = false;
          let authorization: Promise<"authorized" | "denied" | "unavailable"> =
            Promise.resolve("authorized");
          let validDevCookie = false;
          if (target.environmentName === "dev") {
            // A route for Dev never grants access by itself: identity is reauthorized per request.
            if (url.origin !== target.publicOrigin || target.devAccess === null)
              return plain("", 404);
            if (request.headers.has(PROBE_HEADER)) {
              if (!(await validProbe(request, url, target, now()))) return plain("", 404);
              runtimeProbe = true;
              const headers = new Headers(request.headers);
              headers.delete(PROBE_HEADER);
              upstream = new Request(request, { headers });
            } else if (url.pathname === REDEEM_PATH) {
              return redeem(request, url, target, environment, now());
            } else {
              const parts = cookieParts(request);
              const tokens = parts.filter((part) => part.startsWith(`${COOKIE_NAME}=`));
              const token =
                tokens.length === 1 ? tokens[0]?.slice(COOKIE_NAME.length + 1) : undefined;
              const localStarted = eligible && token !== undefined ? clock() : null;
              let claims;
              try {
                claims = token === undefined ? null : await validSession(token, target, now());
              } finally {
                finish("localDevVerificationMs", localStarted);
              }
              validDevCookie = claims !== null;
              const authStarted = eligible ? clock() : null;
              authorization = devAuthorization(
                environment,
                target,
                claims === null ? null : (token ?? null),
              );
              if (eligible)
                authorization = authorization.then((value) => {
                  finish("devAuthorizationMs", authStarted);
                  return value;
                });
              const headers = new Headers(request.headers);
              const cookies = parts.filter((part) => !part.startsWith(`${COOKIE_NAME}=`));
              if (cookies.length === 0) headers.delete("cookie");
              else headers.set("cookie", cookies.join("; "));
              upstream = new Request(request, { headers });
            }
          } else if (url.pathname === REDEEM_PATH || request.headers.has(PROBE_HEADER)) {
            return plain("", 404);
          }
          const nativeNamespace =
            target.nativeAuth !== undefined &&
            (url.pathname === NATIVE_AUTH_BASE_PATH ||
              url.pathname.startsWith(`${NATIVE_AUTH_BASE_PATH}/`));
          // Dev reauthorization and credit admission are independent Control reads.
          const creditStarted = eligible && !runtimeProbe ? clock() : null;
          let admitted: Promise<Admission> = runtimeProbe
            ? Promise.resolve(200)
            : creditAdmission(
                environment,
                target,
                url.origin !== target.publicOrigin,
                nativeNamespace,
              );
          if (eligible && !runtimeProbe)
            admitted = admitted.then((value) => {
              finish("creditAdmissionMs", creditStarted);
              return value;
            });
          const decision = await authorization;
          if (decision === "unavailable")
            return nativeNamespace
              ? nativeResponse(plain("Service unavailable", 503))
              : plain("Service unavailable", 503);
          if (decision === "denied")
            return nativeNamespace
              ? nativeResponse(plain("", 404))
              : validDevCookie && isDocumentNavigation(request)
                ? revokedDevRedirect()
                : plain("", 404);
          // A WebSocket upgrade is a GET, so the mutation rule below never sees it: it gets the same exact Origin test.
          if (
            upstream.headers.get("upgrade")?.toLowerCase() === "websocket" &&
            !isBrowserMutationAllowed(upstream, target.browserPolicy)
          ) {
            const refusal = plain(
              "Forbidden: ohmyho.st refuses a WebSocket upgrade whose Origin header names another origin, or that carries cookies without an Origin header.",
              403,
            );
            return nativeNamespace ? nativeResponse(refusal) : refusal;
          }
          if (!nativeNamespace && upstream.method !== "GET" && upstream.method !== "HEAD") {
            if (!isBrowserMutationAllowed(upstream, target.browserPolicy))
              return plain(
                "Forbidden: ohmyho.st refuses a request other than GET or HEAD whose Origin header names another origin, or that carries cookies without an Origin header. Send it from a page on this origin, or without cookies.",
                403,
              );
          }
          {
            const admission = await admitted;
            if (typeof admission === "string")
              return nativeNamespace
                ? nativeResponse(plain(PAUSED[admission], 402))
                : plain(PAUSED[admission], 402);
            if (admission !== 200)
              return nativeNamespace
                ? nativeResponse(
                    plain(admission === 404 ? "" : "Credit check unavailable", admission),
                  )
                : plain(admission === 404 ? "" : "Credit check unavailable", admission);
          }
          if (nativeNamespace) {
            if (
              runtimeProbe ||
              url.protocol !== "https:" ||
              !isNativeAuthPublicRoute(request.method, url.pathname) ||
              (request.method !== "GET" && request.headers.get("origin") !== url.origin) ||
              (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
            )
              return nativeResponse(plain("", 404));
            try {
              if (
                target.nativeAuth === undefined ||
                target.nativeAuth.realmGeneration === null ||
                target.nativeAuth.configurationRevision === null
              )
                return nativeUnavailable();
              const nativeService =
                target.nativeAuth.region === "eu"
                  ? environment.NATIVE_AUTH_EU
                  : environment.NATIVE_AUTH_US;
              // Cloudflare sets this ingress header; customer headers cannot supply a private RPC context.
              const clientAddress = request.headers.get("cf-connecting-ip");
              if (
                nativeService === undefined ||
                clientAddress === null ||
                isIP(clientAddress) === 0
              )
                return nativeUnavailable();
              const headers = new Headers(upstream.headers);
              for (const name of [...headers.keys()])
                if (name.startsWith("x-ohmyhost-")) headers.delete(name);
              const response = await bounded(
                nativeService.fetchPublic(
                  new Request(upstream, { headers }),
                  {
                    projectId: target.projectId,
                    environmentId: target.environmentId,
                    deploymentId: target.targetDeploymentId,
                    canonicalOrigin: url.origin,
                    realmGeneration: target.nativeAuth.realmGeneration,
                    configurationRevision: target.nativeAuth.configurationRevision,
                  },
                  { clientAddress },
                ),
                NATIVE_AUTH_REQUEST_DEADLINE_MS,
              );
              return nativeResponse(response);
            } catch {
              return nativeUnavailable();
            }
          }
          try {
            const worker = environment.DISPATCHER.get(
              target.targetScriptName,
              {},
              {
                limits: WFP_DISPATCH_LIMITS,
                outbound: {
                  EGRESS_CONTEXT: buildEgressContext(target.projectId, target.egressAllowedOrigins),
                },
              },
            );
            const nonce = crypto.randomUUID().replaceAll("-", "");
            const productionDocument =
              target.environmentName === "prod" &&
              request.method === "GET" &&
              request.headers.get("sec-fetch-dest") === "document";
            const flag =
              target.poweredBy && productionDocument
                ? poweredByFlagMarkup({ projectId: target.projectId, nonce })
                : null;
            const headers = new Headers(upstream.headers);
            headers.delete("content-security-policy-report-only");
            // A 304 would keep a returning visitor's copy with the previous flag state and a stale
            // style nonce, so a production document is always answered in full.
            if (productionDocument) {
              headers.delete("if-none-match");
              headers.delete("if-modified-since");
            }
            headers.set(
              "content-security-policy",
              browserContentSecurityPolicy(
                edgePolicy(nonce, target.egressAllowedOrigins, false),
                target.browserPolicy,
              ),
            );
            headers.set("x-nonce", nonce);
            const dispatchStarted = eligible ? clock() : null;
            let response: Response;
            try {
              response = await worker.fetch(new Request(upstream, { headers }));
            } finally {
              finish("workerDispatchMs", dispatchStarted);
            }
            if (response.status >= 500)
              await publishDiagnostic(
                environment,
                target,
                now(),
                options.diagnosticSink,
                diagnosticWindows,
              );
            return await secure(
              response,
              url.pathname,
              nonce,
              target.egressAllowedOrigins,
              !runtimeProbe,
              request.headers.get("sec-fetch-mode") === "navigate",
              flag,
              target.browserPolicy,
              request.headers.get("origin"),
              target.nativeAuth !== undefined,
            );
          } catch (error) {
            await publishDiagnostic(
              environment,
              target,
              now(),
              options.diagnosticSink,
              diagnosticWindows,
            );
            if (error instanceof Error && error.message.startsWith("Worker not found")) {
              // A replaced deployment must not stay unreachable behind a cached route.
              routes.delete(url.hostname);
              return plain("", 404);
            }
            if (isCpuLimitError(error)) return plain(cpuLimitMessage(), 429);
            return plain(
              "Upstream unavailable: this app threw an exception or did not answer the request.",
              502,
            );
          }
        })();
        responseStatus = result.status;
        return result;
      } finally {
        if (eligible)
          try {
            const end = clock();
            const totalUntilHeadersMs =
              totalStart !== null && end !== null && end >= totalStart ? end - totalStart : null;
            const event = JSON.stringify({
              kind: "native_gateway_latency_v1",
              outcome: responseStatus === null ? "exception" : "response",
              status: responseStatus,
              timingsAreNonAdditive: true,
              durations: { ...durations, totalUntilHeadersMs },
            });
            if (options.latencySink === undefined) console.log(event);
            else options.latencySink(event);
          } catch {
            /* Diagnostics cannot affect the gateway response. */
          }
      }
    },
  });
}

const TARGET_KEYS = [
  "organizationId",
  "projectId",
  "environmentId",
  "environmentName",
  "handle",
  "hostname",
  "publicOrigin",
  "targetDeploymentId",
  "targetScriptName",
  "egressAllowedOrigins",
  "devAccess",
  "poweredBy",
] as const;

function parseTarget(value: unknown, hostname: string): SharedGatewayTarget {
  const keys: readonly string[] = [
    ...TARGET_KEYS,
    ...(typeof value === "object" && value !== null && Object.hasOwn(value, "browserPolicy")
      ? ["browserPolicy"]
      : []),
    ...(typeof value === "object" && value !== null && Object.hasOwn(value, "nativeAuth")
      ? ["nativeAuth"]
      : []),
  ];
  if (!exactRecord(value, keys)) throw new TypeError("Invalid gateway target");
  const browserPolicy =
    value["browserPolicy"] === undefined ? undefined : parseBrowserPolicy(value["browserPolicy"]);
  if (Object.hasOwn(value, "browserPolicy") && browserPolicy === undefined)
    throw new TypeError("Invalid gateway browser policy");
  if (Object.hasOwn(value, "nativeAuth")) {
    const native = value["nativeAuth"];
    const pending =
      typeof native === "object" &&
      native !== null &&
      Reflect.get(native, "realmGeneration") === null &&
      Reflect.get(native, "configurationRevision") === null;
    if (
      !exactRecord(native, ["realmGeneration", "configurationRevision", "region"]) ||
      (!pending &&
        (!Number.isSafeInteger(native["realmGeneration"]) ||
          Number(native["realmGeneration"]) < 1 ||
          !Number.isSafeInteger(native["configurationRevision"]) ||
          Number(native["configurationRevision"]) < 1)) ||
      (native["region"] !== "us" && native["region"] !== "eu")
    )
      throw new TypeError("Invalid Native Auth route");
  }
  const poweredBy = value["poweredBy"];
  if (typeof poweredBy !== "boolean" || (poweredBy && value["environmentName"] !== "prod"))
    throw new TypeError("Invalid gateway flag");
  for (const key of ["organizationId", "projectId", "environmentId", "targetDeploymentId"])
    if (typeof value[key] !== "string" || !ULID.test(value[key]))
      throw new TypeError("Invalid gateway identity");
  if (
    (value["environmentName"] !== "dev" && value["environmentName"] !== "prod") ||
    typeof value["handle"] !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(value["handle"]) ||
    value["handle"].length < 3 ||
    value["handle"].length > 63 ||
    value["hostname"] !== hostname ||
    typeof value["publicOrigin"] !== "string" ||
    !isDnsEgressOrigin(value["publicOrigin"])
  )
    throw new TypeError("Invalid gateway address");
  const projectId = String(value["projectId"]),
    deploymentId = String(value["targetDeploymentId"]);
  if (
    value["targetScriptName"] !==
    `p-${projectId.toLowerCase()}-${value["environmentName"]}-${deploymentId.toLowerCase()}`
  )
    throw new TypeError("Invalid gateway target script");
  const origins = value["egressAllowedOrigins"];
  if (
    !Array.isArray(origins) ||
    origins.length > 16 ||
    origins.some(
      (origin, index) => !isDnsEgressOrigin(origin) || (index > 0 && origins[index - 1] >= origin),
    )
  )
    throw new TypeError("Invalid gateway egress");
  const access = value["devAccess"];
  if (
    value["environmentName"] === "prod"
      ? access !== null
      : !exactRecord(access, ["keyId", "publicJwk"]) ||
        typeof access["keyId"] !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(access["keyId"]) ||
        !exactRecord(access["publicJwk"], ["crv", "kty", "x", "y"]) ||
        access["publicJwk"]["crv"] !== "P-256" ||
        access["publicJwk"]["kty"] !== "EC" ||
        typeof access["publicJwk"]["x"] !== "string" ||
        typeof access["publicJwk"]["y"] !== "string"
  )
    throw new TypeError("Invalid gateway Dev verification key");
  return Object.freeze({
    ...value,
    egressAllowedOrigins: Object.freeze([...origins]),
    ...(browserPolicy === undefined ? {} : { browserPolicy }),
    poweredBy,
  }) as unknown as SharedGatewayTarget;
}

function canonicalHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    value.includes(".") &&
    !value.endsWith(".local") &&
    !value.endsWith(".internal") &&
    !/^\d+(?:\.\d+){3}$/u.test(value) &&
    value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  );
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Private gateway request timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function accessScope(target: SharedGatewayTarget): DevAccessScope {
  return {
    projectId: target.projectId,
    environmentId: target.environmentId,
    handle: target.handle,
    origin: target.publicOrigin,
  } as DevAccessScope;
}

async function validSession(token: string, target: SharedGatewayTarget, now: Date) {
  try {
    if (target.devAccess === null) return null;
    const claims = await verifyDevAccessSession(
      crypto,
      target.devAccess.publicJwk,
      token,
      accessScope(target),
      now.toISOString(),
    );
    return claims?.kid === target.devAccess.keyId ? claims : null;
  } catch {
    return null;
  }
}

/** Every cookie is kept whatever the header's length: only the platform cookie is ever removed. */
function cookieParts(request: Request): readonly string[] {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** "unavailable" is a Control failure or rate limit, never a denial of the visitor. */
async function devAuthorization(
  environment: SharedGatewayEnvironment,
  target: SharedGatewayTarget,
  token: string | null,
): Promise<"authorized" | "denied" | "unavailable"> {
  let result: unknown;
  try {
    if (environment.DEV_AUTH_ATOMIC_MODE !== undefined && environment.DEV_AUTH_ATOMIC_MODE !== "v1")
      return "unavailable";
    result = await bounded(
      environment.DEV_ACCESS.authorize({
        ...accessScope(target),
        sessionToken: token,
        ...(environment.DEV_AUTH_ATOMIC_MODE === "v1"
          ? { organizationHint: target.organizationId }
          : {}),
      }),
      5000,
    );
  } catch {
    return "unavailable";
  }
  if (!exactRecord(result, ["authorized"]) || typeof result["authorized"] !== "boolean")
    return environment.DEV_AUTH_ATOMIC_MODE === "v1" ? "unavailable" : "denied";
  return result["authorized"] ? "authorized" : "denied";
}

async function redeem(
  request: Request,
  url: URL,
  target: SharedGatewayTarget,
  environment: SharedGatewayEnvironment,
  now: Date,
): Promise<Response> {
  const entries = [...url.searchParams.entries()];
  const ticket = url.searchParams.get("ticket");
  if (
    request.method !== "GET" ||
    entries.length !== 2 ||
    entries.filter(([name]) => name === "ticket").length !== 1 ||
    entries.filter(([name]) => name === "stage").length !== 1 ||
    url.searchParams.get("stage") !== "dev" ||
    ticket === null ||
    !/^[A-Za-z0-9_-]{43}$/u.test(ticket)
  )
    return plain("", 404);
  try {
    const value = await bounded(
      environment.DEV_ACCESS.redeem({
        ...accessScope(target),
        ticket,
        clientAddress: request.headers.get("cf-connecting-ip") ?? "unknown",
      }),
      5000,
    );
    if (
      !exactRecord(value, ["expiresAt", "sessionToken"]) ||
      typeof value["sessionToken"] !== "string"
    )
      return plain("", 404);
    const claims = await validSession(value["sessionToken"], target, now);
    if (claims === null || claims.expiresAt !== value["expiresAt"]) return plain("", 404);
    return seeOther(
      `${target.publicOrigin}/`,
      `${COOKIE_NAME}=${value["sessionToken"]}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`,
    );
  } catch (error) {
    // A limited redemption is retried later, not refused: the share link stays valid.
    if (error instanceof Error && error.message === "Dev access rate limit exceeded")
      return plain("Service unavailable", 503);
    // Switching Dev to public revokes the share link: its old URL then opens the public Dev URL.
    const decision = await devAuthorization(environment, target, null);
    if (decision === "authorized") return seeOther(`${target.publicOrigin}/`);
    return decision === "unavailable" ? plain("Service unavailable", 503) : revokedDevRedirect();
  }
}

function revokedDevRedirect(): Response {
  return seeOther("https://ohmyho.st/");
}

/** The ticket stays out of the next page's Referer and out of every cache. */
function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  if (cookie !== undefined) headers.set("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function isDocumentNavigation(request: Request): boolean {
  return request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate";
}

async function validProbe(
  request: Request,
  url: URL,
  target: SharedGatewayTarget,
  now: Date,
): Promise<boolean> {
  if (
    target.devAccess === null ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    url.search !== "" ||
    request.headers.has("cookie") ||
    request.headers.has("origin")
  )
    return false;
  const token = request.headers.get(PROBE_HEADER);
  if (token === null || token.length > 2048) return false;
  try {
    // Only the operation nonce is obtained from the unverified envelope; all routing
    // authority is fixed above and the complete envelope is verified before use.
    const encoded = token.split(".")[0] ?? "";
    const payload = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))) as Record<
      string,
      unknown
    >;
    if (typeof payload["operationId"] !== "string" || !ULID.test(payload["operationId"]))
      return false;
    const claims = await verifyDevRuntimeProbe(
      crypto,
      target.devAccess.publicJwk,
      token,
      {
        ...accessScope(target),
        organizationId: target.organizationId,
        operationId: payload["operationId"],
        deploymentId: target.targetDeploymentId,
        path: url.pathname,
        method: request.method,
      } as DevRuntimeProbeScope,
      now.toISOString(),
    );
    return claims?.kid === target.devAccess.keyId;
  } catch {
    return false;
  }
}

/** A custom domain needs Paid access, or the owner showing the flag on this production site. */
function creditStatus(
  decision: CreditDecision,
  customDomain: boolean,
  poweredBy: boolean,
): Admission {
  if (decision.allowed && decision.reason === null)
    return customDomain && !decision.paidAllowed && !poweredBy ? "paid_plan_required" : 200;
  if (!decision.allowed) {
    if (decision.reason === "project_unavailable") return 404;
    if (
      decision.reason === "project_budget_exceeded" ||
      decision.reason === "insufficient_organization_credits"
    )
      return decision.reason;
  }
  return 503;
}

function recall<T>(cache: Map<string, Cached<T>>, key: string, now: Date): T | undefined {
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  if (entry.until > now.getTime()) return entry.value;
  cache.delete(key);
  return undefined;
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T, until: number): void {
  cache.delete(key);
  if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { value, until });
}

async function readCreditDecision(
  environment: SharedGatewayEnvironment,
  target: SharedGatewayTarget,
  now: Date,
): Promise<Cached<CreditDecision> | null> {
  try {
    const value = await bounded(
      environment.CREDIT_ADMISSION.read({
        organizationId: target.organizationId,
        projectId: target.projectId,
        environmentId: target.environmentId,
        includePaidPlan: true,
      }),
      2000,
    );
    if (
      !exactRecord(value, [
        "allowed",
        "checkedAt",
        "environmentId",
        "expiresAt",
        "organizationId",
        "paidAllowed",
        "projectId",
        "reason",
      ]) ||
      value["organizationId"] !== target.organizationId ||
      value["projectId"] !== target.projectId ||
      value["environmentId"] !== target.environmentId ||
      typeof value["paidAllowed"] !== "boolean" ||
      typeof value["checkedAt"] !== "string" ||
      typeof value["expiresAt"] !== "string"
    )
      return null;
    const checked = Date.parse(value["checkedAt"]),
      expires = Date.parse(value["expiresAt"]);
    if (
      !Number.isFinite(checked) ||
      !Number.isFinite(expires) ||
      checked > now.getTime() + 30000 ||
      checked < now.getTime() - 60000 ||
      expires - checked !== 900000 ||
      typeof value["allowed"] !== "boolean"
    )
      return null;
    const decision = {
      allowed: value["allowed"],
      paidAllowed: value["paidAllowed"],
      reason: value["reason"],
    };
    return { value: decision, until: Math.min(now.getTime() + CREDIT_CACHE_MS, expires) };
  } catch {
    return null;
  }
}

function requestedBrowserDirective(
  header: string | null,
  separator: string,
  directive: string,
): boolean {
  return (
    header !== null &&
    header.length <= 4096 &&
    header.split(separator).some((part) => part.trim() === directive)
  );
}

function edgePolicy(nonce: string, origins: readonly string[], allowMedia: boolean): string {
  const imageSources = origins.filter((origin) =>
    /^https:\/\/[0-9a-f]{32}\.(?:eu|us)\.r2\.cloudflarestorage\.com$/u.test(origin),
  );
  return `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:${imageSources.length === 0 ? "" : ` ${imageSources.join(" ")}`};${allowMedia ? " media-src 'self' blob:;" : ""} font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; manifest-src 'self'; worker-src 'none'`;
}

async function secure(
  response: Response,
  pathname: string,
  nonce: string,
  origins: readonly string[],
  allowCookies: boolean,
  navigation: boolean,
  flag: string | null,
  browserPolicy: BrowserPolicy | undefined,
  actualOrigin: string | null,
  nativeAuth: boolean,
): Promise<Response> {
  const cookies = allowCookies
    ? response.headers
        .getSetCookie()
        .slice(0, 32)
        .filter(
          (cookie) =>
            cookie.length <= 4096 &&
            !refusesPlatformCookie(cookie, COOKIE_NAME) &&
            !cookie
              .split(";")
              .slice(1)
              .some((attribute) => /^\s*domain\s*=/iu.test(attribute)),
        )
    : [];
  const headers = new Headers(response.headers);
  const edge = headers.get("x-ohmyhost-runtime") === "edge-v1";
  const document =
    edge && headers.get("content-type")?.toLowerCase().startsWith("text/html") === true;
  const allowMedia =
    document &&
    requestedBrowserDirective(
      headers.get("content-security-policy"),
      ";",
      "media-src 'self' blob:",
    );
  const allowMicrophone =
    document &&
    requestedBrowserDirective(headers.get("permissions-policy"), ",", "microphone=(self)");
  headers.delete("x-ohmyhost-runtime");
  secureBrowserCors(headers, actualOrigin, browserPolicy);
  headers.delete("set-cookie");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if ((browserPolicy?.frameAncestors.length ?? 0) > 0) headers.delete("x-frame-options");
  if (allowMicrophone)
    headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(self)");
  if (!headers.has("content-type"))
    headers.set(
      "content-type",
      navigation || pathname.endsWith("/")
        ? "text/html; charset=utf-8"
        : (CONTENT_TYPES[pathname.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() ?? ""] ??
            "application/octet-stream"),
    );
  const html =
    response.status === 200 &&
    headers.get("content-type")?.toLowerCase().startsWith("text/html") === true;
  // The flag can only be added to a document this gateway can read. A gzip or deflate document is decoded, within
  // MAX_DECODED_HTML_BYTES and completely before the answer starts, so a corrupt or oversized body fails closed.
  // Any other encoding with a flag to add fails closed too; without a flag the body passes through untouched.
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  const encoded = encoding !== undefined && encoding !== "" && encoding !== "identity";
  let body: BodyInit | null = response.body;
  if (flag !== null && html && encoded) {
    if (encoding !== "gzip" && encoding !== "deflate") {
      response.body?.cancel().catch(() => undefined);
      return plain(FLAG_UNAVAILABLE, 502);
    }
    try {
      body = await new Response(
        response.body
          ?.pipeThrough(new DecompressionStream(encoding))
          .pipeThrough(limitDecodedBytes(MAX_DECODED_HTML_BYTES)) ?? null,
      ).arrayBuffer();
    } catch {
      return plain(FLAG_UNAVAILABLE, 502);
    }
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  const withFlag = flag !== null && html && !headers.has("content-encoding");
  headers.set(
    "content-security-policy",
    browserContentSecurityPolicy(
      edge
        ? edgePolicy(nonce, origins, allowMedia)
        : withFlag
          ? STATIC_POLICY.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`).replace(
              "connect-src 'none'",
              nativeAuth ? "connect-src 'self'" : "connect-src 'none'",
            )
          : nativeAuth
            ? STATIC_POLICY.replace("connect-src 'none'", "connect-src 'self'")
            : STATIC_POLICY,
      browserPolicy,
    ),
  );
  const secured = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    // A native Worker upgrade remains attached while the response headers are secured.
    ...(response.status === 101
      ? { webSocket: (response as Response & { webSocket: unknown }).webSocket }
      : {}),
  });
  if (!withFlag) return secured;
  secured.headers.delete("content-length");
  const etag = secured.headers.get("etag");
  if (etag !== null && !etag.startsWith("W/")) secured.headers.set("etag", `W/${etag}`);
  return new HTMLRewriter()
    .on("body", {
      element(element) {
        element.append(flag, { html: true });
      },
    })
    .transform(secured);
}

function nativeResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function nativeUnavailable(): Response {
  return nativeResponse(Response.json({ error: "auth_unavailable" }, { status: 503 }));
}

const MAX_DECODED_HTML_BYTES = 16 * 1024 * 1024;
const FLAG_UNAVAILABLE =
  "The owner's powered-by flag cannot be added to this encoded page, so ohmyho.st does not serve it.";

/** Counts the decoded bytes and errors as soon as they pass the limit. */
function limitDecodedBytes(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) throw new RangeError("Decoded page is too large");
      controller.enqueue(chunk);
    },
  });
}

function plain(body: string, status: number): Response {
  // Unknown and inaccessible targets deliberately share the same explanation. Never disclose
  // whether a project, deployment, ticket or session exists in an unauthenticated response.
  return new Response(status === 404 && body === "" ? UNAVAILABLE_PAGE : body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...(status === 404 ? { "x-ohmyhost-gateway": "shared-v1" } : {}),
      "cache-control": "no-store",
      "content-security-policy": STATIC_POLICY,
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

async function diagnosticAdmitted(
  environment: SharedGatewayEnvironment,
  target: SharedGatewayTarget,
): Promise<boolean> {
  // Counters are approximate per location. The limit is set in the wrangler ratelimits entry
  // (6 per 60 s per environment, an adjustable default); a limiter failure keeps the marker.
  try {
    const limiter = environment.DIAGNOSTIC_LIMITER;
    if (limiter === undefined) return true;
    return (await limiter.limit({ key: target.environmentId })).success;
  } catch {
    return true;
  }
}

async function publishDiagnostic(
  environment: SharedGatewayEnvironment,
  target: SharedGatewayTarget,
  now: Date,
  sink: ((value: unknown) => void) | undefined,
  windows: Map<string, Cached<true>>,
): Promise<void> {
  if (recall(windows, target.targetDeploymentId, now) !== undefined) return;
  remember(windows, target.targetDeploymentId, true, now.getTime() + DIAGNOSTIC_WINDOW_MS);
  if (!(await diagnosticAdmitted(environment, target))) return;
  try {
    const value = environment.DIAGNOSTIC_MARKER_SIGNING_KEY_BASE64;
    if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) throw new TypeError("Invalid diagnostic key");
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let milliseconds = now.getTime(),
      diagnosticId = "";
    for (let index = 0; index < 10; index++) {
      diagnosticId = alphabet[milliseconds % 32] + diagnosticId;
      milliseconds = Math.floor(milliseconds / 32);
    }
    for (const byte of crypto.getRandomValues(new Uint8Array(16)))
      diagnosticId += alphabet[byte & 31];
    const marker = {
      schemaVersion: "ohmyhost.diagnostic-marker/v1",
      diagnosticId,
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
      deploymentId: target.targetDeploymentId,
      source: "runtime",
      code: "RUNTIME_FAILED",
      occurredAt: now.toISOString(),
    };
    const bytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(marker))),
    );
    const markerSignature = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const signed = Object.freeze({ ...marker, markerSignature });
    if (sink === undefined) channel("ohmyhost.diagnostic.v1").publish(signed);
    else sink(signed);
  } catch {
    // Diagnostics must never replace the original customer response with a telemetry failure.
    console.warn("runtime-diagnostic:unavailable");
  }
}
