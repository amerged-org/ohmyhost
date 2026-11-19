import {
  buildEgressContext,
  WFP_DISPATCH_LIMITS,
  type WfpEgressContext,
} from "@ohmyhost/contracts/wfp-dispatch";
import {
  DEV_ACCESS_SESSION_TTL_SECONDS,
  verifyDevAccessSession,
} from "@ohmyhost/dev-access-tokens";
import { refusesPlatformCookie } from "./browser-security.js";

const PUBLIC_SECURITY_HEADERS = Object.freeze({
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; manifest-src 'self'; worker-src 'none'",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  // A custom apex keeps its own subdomains' HTTPS policy: HSTS covers only this host.
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});
const EDGE_SECURITY_HEADERS = Object.freeze({
  ...PUBLIC_SECURITY_HEADERS,
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; manifest-src 'self'; worker-src 'none'",
});

const canonicalUlid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const canonicalTicket = /^[A-Za-z0-9_-]{43}$/u;
const DEV_ACCESS_COOKIE_NAME = "__Host-ohmyhost_dev_access";

const contentTypes = Object.freeze<Record<string, string>>({
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
});

export interface DispatchedWorker {
  fetch(request: Request): Promise<Response>;
}

export interface DispatchNamespaceBinding {
  get(
    scriptName: string,
    args: Record<string, never>,
    options: {
      limits: typeof WFP_DISPATCH_LIMITS;
      outbound: { EGRESS_CONTEXT: WfpEgressContext };
    },
  ): DispatchedWorker;
}

export type ProjectEnvironmentName = "dev" | "prod";

export interface ProjectIsolatedGatewayEnvironment {
  readonly OMH_DATABASE_CUTOVER_MAINTENANCE?: string;
  readonly DISPATCHER: DispatchNamespaceBinding;
  readonly DEV_ACCESS?: DevAccessServiceBinding;
  readonly PROJECT_ID: string;
  readonly PROJECT_HANDLE: string;
  readonly ENVIRONMENT_NAME: ProjectEnvironmentName;
  readonly PUBLIC_ORIGIN: string;
}

export interface DevAccessServiceBinding {
  redeem(
    input: Readonly<{
      ticket: string;
      projectId: string;
      environmentId: string;
      handle: string;
      origin: string;
      clientAddress: string;
    }>,
  ): Promise<unknown>;
  authorize(
    input: Readonly<{
      sessionToken: string | null;
      organizationHint?: string;
      projectId: string;
      environmentId: string;
      handle: string;
      origin: string;
    }>,
  ): Promise<unknown>;
}

export interface ProjectGatewayDevAccessConfiguration {
  readonly environmentId: string;
  readonly keyId: `sha256:${string}`;
  readonly publicJwk: JsonWebKey;
  readonly crypto?: Pick<Crypto, "subtle">;
  readonly now?: () => Date;
}

export interface ProjectIsolatedGatewayWorker {
  fetch(request: Request, environment: ProjectIsolatedGatewayEnvironment): Promise<Response>;
}

export const projectScriptName = (
  projectId: string,
  environmentName: ProjectEnvironmentName,
): string => {
  if (!canonicalUlid.test(projectId) || (environmentName !== "dev" && environmentName !== "prod")) {
    throw new TypeError("Project ID must be a canonical ULID");
  }
  return `p-${projectId.toLowerCase()}-${environmentName}`;
};

const noStoreResponse = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: {
      ...PUBLIC_SECURITY_HEADERS,
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

const contentTypeForPath = (pathname: string): string => {
  if (pathname === "/" || pathname.endsWith("/")) return "text/html; charset=utf-8";
  const filename = pathname.slice(pathname.lastIndexOf("/") + 1);
  const extensionIndex = filename.lastIndexOf(".");
  const extension = extensionIndex === -1 ? "" : filename.slice(extensionIndex).toLowerCase();
  return contentTypes[extension] ?? "application/octet-stream";
};

const securePublicResponse = (
  response: Response,
  pathname: string,
  removeCorsAuthority = false,
): Response => {
  const upstreamCookies = removeCorsAuthority ? response.headers.getSetCookie() : [];
  const headers = new Headers(response.headers);
  const edge = headers.get("x-ohmyhost-runtime") === "edge-v1";
  headers.delete("x-ohmyhost-runtime");
  if (removeCorsAuthority) {
    for (const name of [...headers.keys()]) {
      if (name.startsWith("access-control-")) headers.delete(name);
    }
    headers.delete("set-cookie");
    for (const cookie of hostOnlyCookies(upstreamCookies)) headers.append("set-cookie", cookie);
  }
  for (const [name, value] of Object.entries(
    edge ? EDGE_SECURITY_HEADERS : PUBLIC_SECURITY_HEADERS,
  )) {
    headers.set(name, value);
  }
  if (!headers.has("content-type")) headers.set("content-type", contentTypeForPath(pathname));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    // A native Worker upgrade remains attached while the response headers are secured.
    ...(response.status === 101
      ? { webSocket: (response as Response & { webSocket: unknown }).webSocket }
      : {}),
  });
};

const hostOnlyCookies = (cookies: readonly string[]): readonly string[] =>
  cookies.slice(0, 32).filter(
    (cookie) =>
      cookie.length <= 4096 &&
      !refusesPlatformCookie(cookie, DEV_ACCESS_COOKIE_NAME) &&
      !cookie
        .split(";")
        .slice(1)
        .some((attribute) => /^\s*domain\s*=/iu.test(attribute)),
  );

const configuredGateway = (
  environment: ProjectIsolatedGatewayEnvironment,
): Readonly<{
  projectId: string;
  handle: string;
  environmentName: ProjectEnvironmentName;
  publicOrigin: string;
}> | null => {
  if (!canonicalUlid.test(environment?.PROJECT_ID)) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(environment.PROJECT_HANDLE)) return null;
  if (environment.ENVIRONMENT_NAME !== "dev" && environment.ENVIRONMENT_NAME !== "prod")
    return null;
  if (typeof environment.PUBLIC_ORIGIN !== "string") return null;
  try {
    const url = new URL(environment.PUBLIC_ORIGIN);
    const loopback =
      url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (
      (url.protocol !== "https:" && !loopback) ||
      url.origin !== environment.PUBLIC_ORIGIN ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    const label = `${environment.ENVIRONMENT_NAME === "dev" ? "dev-" : ""}${environment.PROJECT_HANDLE}`;
    if (!loopback && ![`${label}.dev.check.omh.st`, `${label}.check.omh.st`].includes(url.hostname))
      return null;
    return Object.freeze({
      projectId: environment.PROJECT_ID,
      handle: environment.PROJECT_HANDLE,
      environmentName: environment.ENVIRONMENT_NAME,
      publicOrigin: url.origin,
    });
  } catch {
    return null;
  }
};

const requestTargetsGateway = (
  request: Request,
  gateway: Readonly<{ publicOrigin: string; environmentName: ProjectEnvironmentName }>,
): boolean => {
  const url = new URL(request.url);
  return (
    url.origin === gateway.publicOrigin ||
    (gateway.environmentName === "prod" && url.protocol === "https:")
  );
};

const isDispatchBinding = (value: unknown): value is DispatchNamespaceBinding =>
  typeof value === "object" && value !== null && "get" in value && typeof value.get === "function";

const dispatchFailureResponse = (error: unknown): Response => {
  if (error instanceof Error && error.message.startsWith("Worker not found")) {
    return noStoreResponse("", 404);
  }
  if (error instanceof Error && error.message.includes("CPU time limit")) {
    return noStoreResponse("Runtime limit exceeded", 429);
  }
  return noStoreResponse("Upstream unavailable", 502);
};

const browserMutationIsForbidden = (request: Request, publicOrigin: string): boolean => {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const requestOrigin = new URL(request.url).origin;
  if (requestOrigin !== publicOrigin && !requestOrigin.startsWith("https://")) return true;
  const origin = request.headers.get("origin");
  if (origin !== null) return origin !== requestOrigin;
  return request.headers.has("cookie");
};

const exactRedemptionTicket = (url: URL): string | null => {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 2 ||
    entries.filter(([name]) => name === "stage").length !== 1 ||
    entries.filter(([name]) => name === "ticket").length !== 1 ||
    url.searchParams.get("stage") !== "dev"
  ) {
    return null;
  }
  const ticket = url.searchParams.get("ticket");
  return ticket !== null && canonicalTicket.test(ticket) ? ticket : null;
};

const hasRedemptionParameter = (url: URL): boolean =>
  url.searchParams.has("stage") || url.searchParams.has("ticket");

const cookieValues = (request: Request, name: string): readonly string[] | null => {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 8192) return null;
  const values = header
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`))
    .map((value) => value.slice(name.length + 1));
  return values.some((value) => value.length < 1 || value.length > 4096) ? null : values;
};

const withoutPlatformCookie = (request: Request): Request => {
  const headers = new Headers(request.headers);
  const cookies = (headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !value.startsWith(`${DEV_ACCESS_COOKIE_NAME}=`));
  if (cookies.length === 0) headers.delete("cookie");
  else headers.set("cookie", cookies.join("; "));
  return new Request(request, { headers });
};

const validDevAccessConfiguration = (
  value: ProjectGatewayDevAccessConfiguration | undefined,
): value is Required<
  Pick<ProjectGatewayDevAccessConfiguration, "environmentId" | "keyId" | "publicJwk">
> &
  ProjectGatewayDevAccessConfiguration =>
  value !== undefined &&
  canonicalUlid.test(value.environmentId) &&
  /^sha256:[a-f0-9]{64}$/u.test(value.keyId) &&
  typeof value.publicJwk === "object" &&
  value.publicJwk !== null;

const canonicalNow = (configuration: ProjectGatewayDevAccessConfiguration): string => {
  const now = configuration.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Dev access clock is invalid");
  }
  return now.toISOString();
};

const redeemDevAccess = async (
  request: Request,
  url: URL,
  environment: ProjectIsolatedGatewayEnvironment,
  gateway: Readonly<{ projectId: string; handle: string; publicOrigin: string }>,
  configuration: ProjectGatewayDevAccessConfiguration,
): Promise<Response> => {
  const ticket = request.method === "GET" ? exactRedemptionTicket(url) : null;
  if (ticket === null || typeof environment.DEV_ACCESS?.redeem !== "function") {
    return noStoreResponse("", 404);
  }
  let result: unknown;
  try {
    result = await environment.DEV_ACCESS.redeem({
      ticket,
      projectId: gateway.projectId,
      environmentId: configuration.environmentId,
      handle: gateway.handle,
      origin: gateway.publicOrigin,
      clientAddress: request.headers.get("cf-connecting-ip") ?? "unknown",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Dev access rate limit exceeded") {
      return noStoreResponse("Service unavailable", 503);
    }
    return revokedDevRedirect();
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return noStoreResponse("", 404);
  }
  const resultRecord = result as Record<string, unknown>;
  if (Object.keys(resultRecord).sort().join(",") !== "expiresAt,sessionToken") {
    return noStoreResponse("", 404);
  }
  const sessionToken = resultRecord["sessionToken"];
  const expiresAt = resultRecord["expiresAt"];
  if (typeof sessionToken !== "string" || typeof expiresAt !== "string") {
    return noStoreResponse("", 404);
  }
  const now = canonicalNow(configuration);
  const claims = await verifyDevAccessSession(
    configuration.crypto ?? globalThis.crypto,
    configuration.publicJwk,
    sessionToken,
    {
      projectId: gateway.projectId as never,
      environmentId: configuration.environmentId as never,
      handle: gateway.handle as never,
      origin: gateway.publicOrigin,
    },
    now,
  );
  if (claims === null || claims.kid !== configuration.keyId || claims.expiresAt !== expiresAt) {
    return noStoreResponse("", 404);
  }
  const headers = new Headers({
    location: `${gateway.publicOrigin}${url.pathname}`,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append(
    "set-cookie",
    `${DEV_ACCESS_COOKIE_NAME}=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DEV_ACCESS_SESSION_TTL_SECONDS}`,
  );
  return new Response(null, { status: 303, headers });
};

const revokedDevRedirect = (): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: "https://ohmyho.st/",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

const authorizeDevAccess = async (
  service: DevAccessServiceBinding | undefined,
  sessionToken: string | null,
  gateway: Readonly<{ projectId: string; handle: string; publicOrigin: string }>,
  environmentId: string,
): Promise<boolean> => {
  if (typeof service?.authorize !== "function") return false;
  try {
    const result = await service.authorize({
      sessionToken,
      projectId: gateway.projectId,
      environmentId,
      handle: gateway.handle,
      origin: gateway.publicOrigin,
    });
    return (
      typeof result === "object" &&
      result !== null &&
      !Array.isArray(result) &&
      Object.keys(result).length === 1 &&
      (result as Record<string, unknown>)["authorized"] === true
    );
  } catch {
    return false;
  }
};

export const createProjectIsolatedGatewayWorker = (
  devAccess?: ProjectGatewayDevAccessConfiguration,
): ProjectIsolatedGatewayWorker => ({
  async fetch(request, environment) {
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
    const gateway = configuredGateway(environment);
    if (gateway === null || !isDispatchBinding(environment?.DISPATCHER)) {
      return noStoreResponse("Service unavailable", 503);
    }
    if (!requestTargetsGateway(request, gateway)) return noStoreResponse("", 404);
    const url = new URL(request.url);
    if (gateway.environmentName === "prod" && hasRedemptionParameter(url)) {
      return noStoreResponse("", 404);
    }
    let dispatchRequest = request;
    if (gateway.environmentName === "dev") {
      if (!validDevAccessConfiguration(devAccess)) return noStoreResponse("", 404);
      if (hasRedemptionParameter(url)) {
        return redeemDevAccess(request, url, environment, gateway, devAccess);
      }
      const sessions = cookieValues(request, DEV_ACCESS_COOKIE_NAME);
      if (sessions === null || sessions.length > 1) return noStoreResponse("", 404);
      const sessionToken = sessions[0];
      const claims =
        sessionToken === undefined
          ? null
          : await verifyDevAccessSession(
              devAccess.crypto ?? globalThis.crypto,
              devAccess.publicJwk,
              sessionToken,
              {
                projectId: gateway.projectId as never,
                environmentId: devAccess.environmentId as never,
                handle: gateway.handle as never,
                origin: gateway.publicOrigin,
              },
              canonicalNow(devAccess),
            );
      const validCookie = claims !== null && claims.kid === devAccess.keyId;
      if (
        !(await authorizeDevAccess(
          environment.DEV_ACCESS,
          validCookie ? (sessionToken ?? null) : null,
          gateway,
          devAccess.environmentId,
        ))
      ) {
        return validCookie &&
          request.method === "GET" &&
          request.headers.get("sec-fetch-mode") === "navigate"
          ? revokedDevRedirect()
          : noStoreResponse("", 404);
      }
      dispatchRequest = withoutPlatformCookie(request);
    }
    if (browserMutationIsForbidden(dispatchRequest, gateway.publicOrigin)) {
      return noStoreResponse("Forbidden", 403);
    }
    try {
      const userWorker = environment.DISPATCHER.get(
        projectScriptName(gateway.projectId, gateway.environmentName),
        {},
        {
          limits: WFP_DISPATCH_LIMITS,
          outbound: {
            EGRESS_CONTEXT: buildEgressContext(gateway.projectId, []),
          },
        },
      );
      return securePublicResponse(await userWorker.fetch(dispatchRequest), url.pathname, true);
    } catch (error) {
      return dispatchFailureResponse(error);
    }
  },
});
