import {
  createCoreStoragePersistence,
  markUnconfirmedStorageClaimAttempts,
  readUnconfirmedStorageClaims,
  requireStorageCore,
} from "./core-persistence.js";
import {
  StorageErasureConflictError,
  StorageGatewayBindingChangedError,
  StorageGatewayDataChangeInProgressError,
  StorageGatewayConflictError,
  StorageGatewayQuotaError,
} from "@ohmyhost/database";
import {
  SystemClock,
  SystemEntropy,
  createUlidFactory,
  parseUlid,
  classifyPlatformGatewayHostname,
  parsePinnedStorageGatewayOrigin,
} from "@ohmyhost/platform";
import {
  CloudflareR2TransferContractError,
  CloudflareR2TransferInputError,
  CloudflareR2TransferRejectedError,
  createCloudflareR2ObjectTransferProvider,
} from "@ohmyhost/provider-cloudflare";

import {
  requireStorageGatewayBindings,
  readStorageGatewayScope,
  type StorageGatewayBindings,
  type StorageGatewayScope,
} from "./bindings.js";
import {
  createStorageGateway,
  StorageGatewayInputError,
  StorageGatewayDeletePendingError,
} from "./runtime.js";
import { STORAGE_BATCH_CONTENT_TYPE } from "./batch.js";
import { createUploadSweep } from "./upload-sweep.js";
import {
  STORAGE_EGRESS_CALLER,
  createStorageEgressEntrypoint,
  createStorageGatewayRelayEntrypoint,
} from "./egress-entrypoint.js";
export { StorageDataManagementEntrypoint } from "./management-entrypoint.js";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_BATCH_BODY_BYTES = 4 * 1024 * 1024;
/** The egress Worker streams the customer's body through; it must not hold a request open. */
const FORWARDED_BODY_DEADLINE_MILLISECONDS = 5_000;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const EGRESS_PROJECT_HEADER = "x-ohmyhost-egress-project-id";
/** Marks a 401 that was decided by the key lookup, which a rejection before the Core is reached never is. */
const KEY_LOOKUP_STAGE = Object.freeze({ "x-ohmyhost-gateway-stage": "key_lookup" });
type Runtime = ReturnType<typeof createStorageGateway>;
type Route = "upload" | "complete" | "delete" | "download" | "readMany" | "deleteMany";

/** C3 pins full deployment scope; only temporary unpinned callers derive it from their key. */
export interface StorageGatewayEgressScope {
  readonly kind: "egress";
  readonly projectId: string;
  readonly deploymentScope?: StorageGatewayScope;
}
type RuntimeScope = StorageGatewayScope | StorageGatewayEgressScope;
interface Admitted {
  readonly authorization: string;
  readonly body: Record<string, unknown>;
}

export function createStorageGatewayEntrypoint(
  dependencies: {
    readonly runtimeFactory?: (
      bindings: StorageGatewayBindings,
      scope: RuntimeScope,
      signal?: AbortSignal,
    ) => Runtime;
  } = {},
) {
  const runtimeFactory = dependencies.runtimeFactory ?? createProductionRuntime;

  /** Everything after admission. Both callers share it; only the runtime scope differs. */
  async function serve(
    request: Request,
    rawBindings: unknown,
    route: Route,
    { authorization, body }: Admitted,
    scope: RuntimeScope,
  ): Promise<Response> {
    const bindings = requireStorageGatewayBindings(rawBindings);
    try {
      const common = { ...body, key: authorization.slice(7) };
      const runtime = runtimeFactory(bindings, scope, request.signal);
      const result =
        route === "upload"
          ? await runtime.upload({
              ...common,
              idempotencyKey: request.headers.get("idempotency-key"),
            })
          : route === "complete"
            ? await runtime.complete(common)
            : route === "delete"
              ? await runtime.delete({
                  ...common,
                  idempotencyKey: request.headers.get("idempotency-key"),
                })
              : route === "readMany"
                ? await runtime.readMany(common)
                : route === "deleteMany"
                  ? await runtime.deleteMany(common)
                  : await runtime.download(common);
      if (result.status === "stream")
        return new Response(result.body, {
          headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE, "cache-control": "no-store" },
        });
      if (result.status === "batch")
        return response(200, { state: result.state, results: result.results });
      if (result.status === "unauthorized")
        return response(401, { code: "unauthorized" }, "kind" in scope ? KEY_LOOKUP_STAGE : {});
      if (result.status === "not_found") return response(404, { code: "object_not_found" });
      if (result.status === "expired")
        return response(409, { code: "upload_expired", transfer_id: result.transferId });
      if (result.status === "pending")
        return response(202, { state: "pending", transfer_id: result.transferId });
      if (result.status === "completed")
        return response(200, {
          state: "completed",
          ...(!("transferId" in result) ? {} : { transfer_id: result.transferId }),
          ...(!("deletionId" in result) ? {} : { deletion_id: result.deletionId }),
        });
      return response(200, {
        state: "ready",
        ...(!("transferId" in result) ? {} : { transfer_id: result.transferId }),
        capability: result.capability,
      });
    } catch (error) {
      if (error instanceof StorageGatewayDeletePendingError)
        return response(409, { code: error.code, retry_at: error.retryAt });
      if (
        error instanceof StorageGatewayBindingChangedError ||
        error instanceof StorageGatewayDataChangeInProgressError
      )
        return response(409, { code: error.code });
      if (error instanceof StorageGatewayInputError) return response(400, { code: error.code });
      if (error instanceof StorageGatewayQuotaError) return response(413, { code: error.code });
      if (
        error instanceof StorageGatewayConflictError ||
        error instanceof StorageErasureConflictError
      )
        return response(409, { code: error.code });
      if (error instanceof CloudflareR2TransferRejectedError) {
        console.warn(
          JSON.stringify({
            event: "cloudflare_r2_transfer_rejected",
            providerCode: error.providerCode,
            providerStatus: error.providerStatus,
          }),
        );
        return response(502, { code: error.code });
      }
      if (
        error instanceof CloudflareR2TransferInputError ||
        error instanceof CloudflareR2TransferContractError
      )
        return response(500, { code: error.code });
      return response(503, { code: "storage_gateway_unavailable" });
    }
  }

  return Object.freeze({
    /** The service binding of a deployment: its props carry the complete trusted scope. */
    async fetch(
      request: Request,
      rawBindings: unknown,
      context?: { readonly props: unknown },
    ): Promise<Response> {
      const route = routeFor(request);
      if (route === null) return response(404, { code: "resource_not_found" });
      const admitted = await admit(request, route);
      if (admitted instanceof Response) return admitted;
      const scope = readStorageGatewayScope(context?.props);
      if (
        scope === null ||
        admitted.body["projectId"] !== scope.projectId ||
        admitted.body["environmentId"] !== scope.environmentId
      )
        return response(401, { code: "unauthorized" });
      // This binding has no limit of its own: the project's gateway limit runs before the Core is reached.
      if (!(await withinProjectLimit(rawBindings, scope.projectId)))
        return response(429, { code: "rate_limited" });
      return serve(request, rawBindings, route, admitted, scope);
    },
    /**
     * The egress policy Worker's private route. The platform marker comes first; the project is
     * the header the egress Worker stamps over anything the customer sent, and it must equal the
     * body's. Every check here runs before the Core is reached.
     */
    async fetchForwarded(
      request: Request,
      rawBindings: unknown,
      caller: unknown,
    ): Promise<Response> {
      if (!isEgressCaller(caller)) {
        await logScopeRejection("marker_missing", rawBindings);
        return response(401, { code: "unauthorized" });
      }
      const route = routeFor(request);
      if (route === null) return response(404, { code: "resource_not_found" });
      const stamped = request.headers.get(EGRESS_PROJECT_HEADER);
      if (!isCanonicalUlid(stamped)) return response(401, { code: "unauthorized" });
      const target = new URL(request.url);
      const pin = parsePinnedStorageGatewayOrigin(target.origin);
      // C3 alone retains the exact unpinned gateway family for active old callers. A malformed
      // pin can never take that migration path; C4 closes unpinned admission after restaging.
      if (
        pin === null &&
        (target.protocol !== "https:" ||
          target.port !== "" ||
          target.hostname.split(".").length !== 4 ||
          classifyPlatformGatewayHostname(target.hostname) !== "storage" ||
          !target.hostname
            .split(".")
            .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)))
      )
        return response(401, { code: "unauthorized" });
      const admitted = await admit(request, route, true);
      if (admitted instanceof Response) return admitted;
      if (admitted.body["projectId"] !== stamped) {
        await logScopeRejection("project_mismatch", rawBindings, stamped);
        return response(401, { code: "unauthorized" });
      }
      if (!isCanonicalUlid(admitted.body["environmentId"]))
        return response(400, { code: "invalid_request" });
      if (pin !== null && admitted.body["environmentId"] !== pin.environmentId)
        return response(401, { code: "unauthorized" });
      return serve(request, rawBindings, route, admitted, {
        kind: "egress",
        projectId: stamped,
        ...(pin === null
          ? {}
          : {
              deploymentScope: {
                organizationId: pin.organizationId,
                projectId: stamped,
                environmentId: pin.environmentId,
                dataEnvironmentId: pin.dataEnvironmentId,
              },
            }),
      });
    },
  });
}

export function createProductionRuntime(
  bindings: StorageGatewayBindings,
  scope: RuntimeScope,
  signal?: AbortSignal,
): Runtime {
  const persistence = createCoreStoragePersistence(
    requireStorageCore(bindings.STORAGE_GATEWAY_RUNTIME),
    scope,
  );
  const clock = new SystemClock();
  return createStorageGateway(
    {
      ...persistence,
      provider: createCloudflareR2ObjectTransferProvider({
        accountId: bindings.CLOUDFLARE_ACCOUNT_ID,
        apiToken: bindings.CLOUDFLARE_R2_API_TOKEN,
        parentAccessKeyId: bindings.CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID,
        fetch: globalThis.fetch,
      }),
      sha256: async (value) =>
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
      ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
      now: () => clock.now(),
    },
    signal === undefined ? {} : { signal },
  );
}

const entrypoint = createStorageGatewayEntrypoint();

/** Bound only by the egress policy Worker, with the marker as static props. */
export const StorageEgressEntrypoint = createStorageEgressEntrypoint(entrypoint);
export const StorageGatewayRelayEntrypoint = createStorageGatewayRelayEntrypoint(entrypoint);

/**
 * The hourly sweep of abandoned signed uploads. It reads the Core for the whole partition, then erases each claim in
 * its own frozen scope through the same Core commands a deletion uses.
 */
export function createProductionUploadSweep(bindings: StorageGatewayBindings) {
  const core = requireStorageCore(bindings.STORAGE_GATEWAY_RUNTIME);
  const clock = new SystemClock();
  return createUploadSweep({
    listUnconfirmed: (input) => readUnconfirmedStorageClaims(core, input),
    markAttempts: (input) => markUnconfirmedStorageClaimAttempts(core, input),
    persistence: (scope) => createCoreStoragePersistence(core, scope),
    provider: createCloudflareR2ObjectTransferProvider({
      accountId: bindings.CLOUDFLARE_ACCOUNT_ID,
      apiToken: bindings.CLOUDFLARE_R2_API_TOKEN,
      parentAccessKeyId: bindings.CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID,
      fetch: globalThis.fetch,
    }),
    ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
    sha256: async (value) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    now: () => clock.now(),
  });
}

export default {
  fetch(request: Request, env: StorageGatewayBindings, context: { readonly props: unknown }) {
    return entrypoint.fetch(request, env, context);
  },
  /** The cron trigger of wrangler.*.jsonc: one pass over the unconfirmed claims a day old. */
  async scheduled(_controller: unknown, env: unknown): Promise<void> {
    const summary = await createProductionUploadSweep(requireStorageGatewayBindings(env)).sweep();
    console.info(JSON.stringify({ event: "storage_upload_sweep_pass", ...summary }));
  },
};

function routeFor(request: Request): Route | null {
  if (request.method !== "POST") return null;
  const url = new URL(request.url);
  if (url.search !== "") return null;
  if (url.pathname === "/v1/uploads") return "upload";
  if (url.pathname === "/v1/uploads/complete") return "complete";
  if (url.pathname === "/v1/downloads") return "download";
  if (url.pathname === "/v1/deletions") return "delete";
  if (url.pathname === "/v1/downloads/batch") return "readMany";
  if (url.pathname === "/v1/deletions/batch") return "deleteMany";
  return null;
}

/**
 * Bearer, media type and the bounded JSON object, in the order both callers rely on. A forwarded
 * request is admitted more strictly: the key must have its exact shape and the body must arrive
 * within a deadline, because nothing but the platform's egress Worker sends it.
 */
async function admit(
  request: Request,
  route: Route,
  forwarded = false,
): Promise<Response | Admitted> {
  const authorization = request.headers.get("authorization");
  if (
    authorization === null ||
    !authorization.startsWith("Bearer ") ||
    (forwarded && !STORAGE_KEY_PATTERN.test(authorization.slice(7))) ||
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
  )
    return response(400, { code: "invalid_request" });
  let body: unknown;
  try {
    const bytes = await readBoundedGatewayBody(
      request,
      route === "readMany" || route === "deleteMany" ? MAX_BATCH_BODY_BYTES : MAX_BODY_BYTES,
      forwarded ? FORWARDED_BODY_DEADLINE_MILLISECONDS : undefined,
    );
    if (bytes === null) return response(413, { code: "payload_too_large" });
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return response(400, { code: "invalid_request" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return response(400, { code: "invalid_request" });
  return { authorization, body: body as Record<string, unknown> };
}

/** Whether the project's gateway limit admits one call; a missing or failing limiter refuses. */
async function withinProjectLimit(rawBindings: unknown, projectId: string): Promise<boolean> {
  const limiter = Object(rawBindings)["GATEWAY_RATE_LIMITER"];
  try {
    if (typeof limiter?.limit !== "function") return false;
    const result = await limiter.limit({ key: projectId });
    return result?.success === true;
  } catch {
    return false;
  }
}

/** The static props of the egress policy Worker's binding: exactly `{ caller: <marker> }`. */
function isEgressCaller(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "caller" &&
    (value as Record<string, unknown>)["caller"] === STORAGE_EGRESS_CALLER
  );
}

function isCanonicalUlid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parseUlid(value);
    return true;
  } catch {
    return false;
  }
}

/** Integrity events only: a reason and the stamped project, never a key, header or body. */
async function logScopeRejection(
  reason: "marker_missing" | "project_mismatch",
  rawBindings: unknown,
  projectId?: string,
) {
  if (typeof rawBindings !== "object" || rawBindings === null) return;
  const limiter = (rawBindings as Partial<StorageGatewayBindings>).STORAGE_SCOPE_LOG_LIMITER;
  if (typeof limiter?.limit !== "function") return;
  try {
    if (!(await limiter.limit({ key: projectId ?? "unmarked" })).success) return;
  } catch {
    // An observability failure must neither permit the request nor flood persisted logs.
    return;
  }
  console.warn(
    JSON.stringify({
      event: "storage_egress_scope_rejected",
      reason,
      ...(projectId === undefined ? {} : { projectId }),
    }),
  );
}

async function readBoundedGatewayBody(
  request: Request,
  maximum: number,
  deadlineMilliseconds?: number,
): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry =
    deadlineMilliseconds === undefined
      ? undefined
      : new Promise<"expired">((resolve) => {
          timer = setTimeout(resolve, deadlineMilliseconds, "expired");
        });
  try {
    while (true) {
      const next = await (expiry === undefined
        ? reader.read()
        : Promise.race([reader.read(), expiry]));
      if (next === "expired") throw new StorageGatewayInputError();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) return null;
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function response(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
