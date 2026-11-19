import { isDnsEgressOrigin } from "@ohmyhost/contracts/egress-origin";
import {
  classifyPlatformGatewayHostname,
  parsePinnedStorageGatewayOrigin,
} from "@ohmyhost/contracts/platform-origins";

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
});

/** The security headers of the storage gateway's own JSON answers, so every gateway failure reads alike. */
const GATEWAY_FAILURE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

/** The only routes of each gateway that customer code reaches, all with the method POST. */
const GATEWAY_ROUTES: Readonly<Record<PlatformGateway, readonly string[]>> = Object.freeze({
  mail: Object.freeze(["/v1/send", "/v1/attachments/download"]),
  storage: Object.freeze([
    "/v1/uploads",
    "/v1/uploads/complete",
    "/v1/downloads",
    "/v1/deletions",
    "/v1/downloads/batch",
    "/v1/deletions/batch",
  ]),
});

/**
 * The managed Browser PDF gateway's origins (`BROWSER_GATEWAY_ORIGIN_*` in `@ohmyhost/platform`, pinned by
 * a test) and its fixed client deadline (`BROWSER_MAX_MS`). This Worker does not depend on that package.
 */
const BROWSER_GATEWAY_ORIGINS: readonly string[] = Object.freeze([
  "https://browser.ohmyho.st",
  "https://browser.dev.ohmyho.st",
]);
const BROWSER_DEADLINE_MS = 30_000;

/** Every request header with this prefix is the platform's: the egress Worker alone sets them. */
const EGRESS_HEADER_PREFIX = "x-ohmyhost-egress-";
const PROJECT_HEADER = "x-ohmyhost-egress-project-id";

type PlatformGateway = "mail" | "storage";

/** Why the relay itself answered; each token is also the `x-ohmyhost-egress-outcome` header value. */
type GatewayOutcome =
  | "not_enabled"
  | "route_denied"
  | "origin_unbound"
  | "binding_missing"
  | "transport_error"
  | "redirect_refused"
  | "rate_limited"
  | "limiter_unavailable";

type EgressPolicy = Readonly<{ projectId: string; allowedOrigins: readonly string[] }>;

interface GatewayBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WfpOutboundEnvironment {
  readonly EGRESS_CONTEXT: unknown;
  readonly MAIL_GATEWAY_ORIGIN?: unknown;
  readonly MAIL_GATEWAY?: GatewayBinding | undefined;
  readonly STORAGE_GATEWAY_ORIGIN?: unknown;
  readonly STORAGE_GATEWAY?:
    | (GatewayBinding & { permit(projectId: string): Promise<boolean> })
    | undefined;
}

export interface WfpOutboundWorker {
  fetch(request: Request, environment: WfpOutboundEnvironment): Promise<Response>;
}

export interface WfpOutboundWorkerDependencies {
  readonly fetch?: typeof globalThis.fetch;
}

export function createPolicyOutboundWorker(
  dependencies: WfpOutboundWorkerDependencies = {},
): WfpOutboundWorker {
  const outboundFetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  return Object.freeze({
    async fetch(request: Request, environment: WfpOutboundEnvironment) {
      const policy = parseEgressContext(environment?.EGRESS_CONTEXT);
      if (policy === null) return unavailable();
      let target: URL;
      try {
        target = new URL(request.url);
      } catch {
        return denied("the request URL is invalid.");
      }
      const host = target.hostname.toLowerCase().replace(/\.+$/u, "");
      // Neon is retired: its hosts are refused before the allow-list or any customer fetch, even
      // when an older origin grant remains. The decision depends on the host alone. Nothing is
      // logged here: the Worker's logs would carry the customer's request URL.
      if (
        ["neon.tech", "neon.com"].some((domain) => host === domain || host.endsWith(`.${domain}`))
      ) {
        return denied("this database provider is unavailable.");
      }
      // A platform gateway name never reaches the public fetch below, whatever is wrong with it.
      const gateway = classifyPlatformGatewayHostname(target.hostname);
      if (gateway !== null) return relayGateway(gateway, request, target, policy, environment);
      if (!policy.allowedOrigins.includes(target.origin))
        return denied(
          `${target.origin} is not listed in runtime.egress.allow in ohmyhost.yaml. Add that exact HTTPS origin, commit and deploy; a retry fails again.`,
        );
      // The Browser gateway's own 30 s clock starts only when its handler runs, which a hop that buffers
      // the upload may delay. This Worker is the first trusted component to see the tenant's stream, so
      // it times the call on its own clock and aborts the fetch (which cancels the upload) at the deadline.
      const browserDeadline = BROWSER_GATEWAY_ORIGINS.includes(target.origin)
        ? new AbortController()
        : null;
      const browserTimer =
        browserDeadline === null
          ? undefined
          : setTimeout(() => browserDeadline.abort(), BROWSER_DEADLINE_MS);
      try {
        // `cf: {}` drops the tenant's own `cf` options: a `cacheTtl` makes workerd refuse `no-store`, and
        // `cacheEverything` or `resolveOverride` would reach the account-level fetch.
        const response = await outboundFetch(
          new Request(request, {
            redirect: "manual",
            cache: "no-store",
            cf: {},
            ...(browserDeadline === null
              ? {}
              : { signal: AbortSignal.any([request.signal, browserDeadline.signal]) }),
          } as RequestInit),
        );
        if (isRedirect(response)) {
          await response.body?.cancel().catch(() => undefined);
          const location = redirectOrigin(response.headers.get("location"));
          return upstreamUnavailable(
            `${target.origin} answered ${response.status}${location === null ? "" : ` redirecting to ${location}`}; ohmyho.st follows no redirect. Call the final URL directly and list its origin in runtime.egress.allow.`,
          );
        }
        return response;
      } catch {
        // The gateway's own deadline answer, so a caller handles one shape wherever the clock ran out.
        if (browserDeadline?.signal.aborted === true)
          return Response.json(
            { error: { code: "browser_timeout" } },
            { status: 504, headers: { "cache-control": "no-store" } },
          );
        return upstreamUnavailable(`${target.origin} could not be reached. Retrying may help.`);
      } finally {
        // The gateway answers with its complete PDF, so the call is over once its headers arrive.
        if (browserTimer !== undefined) clearTimeout(browserTimer);
      }
    },
  });
}

/**
 * Customer Workers reach the private gateways through ordinary `fetch`; this Worker answers the
 * gateway's own origin over its own service binding, which runs outside the customer's egress
 * policy. Only the gateway bound to this deployment is reachable, only on its fixed routes, and the
 * dispatcher-set project replaces whatever identity the caller sent.
 */
async function relayGateway(
  gateway: PlatformGateway,
  request: Request,
  target: URL,
  policy: EgressPolicy,
  environment: WfpOutboundEnvironment,
): Promise<Response> {
  const refuse = (outcome: GatewayOutcome) => gatewayFailure(gateway, outcome, policy.projectId);
  if (!policy.allowedOrigins.includes(target.origin)) return refuse("not_enabled");
  // Workers Logs attaches the request URL to every persisted line. Judge the fixed route before
  // any logging path; customer-controlled gateway lookalikes and unbound origins never log.
  if (
    request.method !== "POST" ||
    !GATEWAY_ROUTES[gateway].includes(target.pathname) ||
    target.search !== "" ||
    target.hash !== "" ||
    target.username !== "" ||
    target.password !== ""
  )
    return refuse("route_denied");
  const boundOrigin =
    gateway === "mail" ? environment.MAIL_GATEWAY_ORIGIN : environment.STORAGE_GATEWAY_ORIGIN;
  const boundIsBaseOrigin =
    typeof boundOrigin === "string" &&
    /^https:\/\/ohmyho-(?:mail|storage)-gateway-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/u.test(
      boundOrigin,
    );
  const pin = gateway === "storage" ? parsePinnedStorageGatewayOrigin(target.origin) : null;
  // Pins retain their exact allow-listed origin and are anchored to this configured base. During
  // the preparation wave the exact unpinned base remains usable by existing callers. Malformed
  // family names and foreign bases never fall through to public fetch or a stored URL.
  if (!boundIsBaseOrigin || (pin?.baseOrigin ?? target.origin) !== boundOrigin)
    return refuse(boundIsBaseOrigin ? "route_denied" : "origin_unbound");
  // The standard storage Worker owns the native limiter. Its private RPC admits both gateway
  // families under the same dispatcher-supplied project key, before any body or gateway is touched.
  try {
    const admission = environment.STORAGE_GATEWAY;
    if (typeof admission?.permit !== "function") return refuse("limiter_unavailable");
    // Call on the binding itself: bind/detach would name a different remote RPC method.
    const permitted = await admission.permit(policy.projectId);
    if (typeof permitted !== "boolean") return refuse("limiter_unavailable");
    if (!permitted) return refuse("rate_limited");
  } catch {
    return refuse("limiter_unavailable");
  }
  const binding = gateway === "mail" ? environment.MAIL_GATEWAY : environment.STORAGE_GATEWAY;
  if (typeof binding?.fetch !== "function") return refuse("binding_missing");
  try {
    // One Request, built once: the body moves to it unread, and a second construction from the
    // same request would find it used. Only this copy's headers are edited; the incoming
    // request's are immutable on workerd.
    const forwarded = new Request(request, { redirect: "manual" });
    for (const name of [...forwarded.headers.keys()])
      if (name.startsWith(EGRESS_HEADER_PREFIX)) forwarded.headers.delete(name);
    forwarded.headers.set(PROJECT_HEADER, policy.projectId);
    const response = await binding.fetch(forwarded);
    if (!isRedirect(response)) return response;
    await response.body?.cancel().catch(() => undefined);
    return refuse("redirect_refused");
  } catch {
    return refuse("transport_error");
  }
}

/** A 304 answers the caller's own conditional request and redirects nowhere. */
function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400 && response.status !== 304;
}

/**
 * Gateway refusals share JSON security headers and a closed outcome token. Caller denials and
 * quota exhaustion never log. origin_unbound is suppressed because its URL may be customer-chosen;
 * all other fault lines follow a validated fixed route and bound origin. No body, key or error text
 * enters the line; Workers Logs still attaches the request method and URL beside it.
 */
function gatewayFailure(
  gateway: PlatformGateway,
  outcome: GatewayOutcome,
  projectId: string,
): Response {
  const deniedCode =
    outcome === "not_enabled"
      ? "gateway_not_enabled"
      : outcome === "route_denied"
        ? "gateway_route_denied"
        : outcome === "rate_limited"
          ? "gateway_rate_limited"
          : null;
  // Only a fault leaves a line. The Worker itself writes only these four fixed fields, never a
  // header, a body or error text; the method and URL that Workers Logs stores beside them are an
  // allow-listed gateway origin and a fixed route (see above).
  if (deniedCode === null && outcome !== "origin_unbound")
    console.warn(JSON.stringify({ event: "egress_gateway_outcome", gateway, outcome, projectId }));
  return Response.json(
    { code: deniedCode ?? `${gateway}_gateway_unavailable` },
    {
      status: outcome === "rate_limited" ? 429 : deniedCode === null ? 503 : 403,
      headers: {
        ...GATEWAY_FAILURE_HEADERS,
        "x-ohmyhost-egress-outcome": outcome,
        ...(outcome === "rate_limited" ? { "retry-after": "60" } : {}),
      },
    },
  );
}

function parseEgressContext(value: unknown): EgressPolicy | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).sort().join(",") !== "allowedOrigins,projectId,version" ||
    record["version"] !== 1 ||
    typeof record["projectId"] !== "string" ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(record["projectId"]) ||
    !Array.isArray(record["allowedOrigins"]) ||
    record["allowedOrigins"].length > 16
  ) {
    return null;
  }
  const allowedOrigins: string[] = [];
  for (const origin of record["allowedOrigins"]) {
    if (typeof origin !== "string" || !isDnsEgressOrigin(origin)) return null;
    const previous = allowedOrigins.at(-1);
    if (previous !== undefined && previous >= origin) return null;
    allowedOrigins.push(origin);
  }
  return Object.freeze({
    projectId: record["projectId"],
    allowedOrigins: Object.freeze(allowedOrigins),
  });
}

/** Only an absolute redirect names another origin; its path and query stay private. */
function redirectOrigin(location: string | null): string | null {
  if (location === null) return null;
  try {
    const url = new URL(location);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function denied(reason: string): Response {
  return new Response(`Egress denied: ${reason}`, { status: 403, headers: SECURITY_HEADERS });
}

function unavailable(): Response {
  return new Response("Egress policy unavailable", { status: 503, headers: SECURITY_HEADERS });
}

function upstreamUnavailable(reason: string): Response {
  return new Response(`Egress upstream unavailable: ${reason}`, {
    status: 502,
    headers: SECURITY_HEADERS,
  });
}
