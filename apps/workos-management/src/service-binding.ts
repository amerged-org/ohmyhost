import { UserApiKeyRequestError } from "./identity-port.js";
import { UserKeyLifecycleError, type createWorkosUserKeyLifecycle } from "./user-key-lifecycle.js";
import type { WorkosManagementRpc } from "./rpc.js";
import type { WorkosSessionStatusChecker } from "./session-status.js";
import { WorkosContractError } from "@ohmyhost/workos-auth-contracts";
import type { createWorkosUserApiKeyValidation } from "./user-api-keys.js";
import {
  SessionRevocationError,
  type createWorkosSessionRevocation,
} from "./session-revocation.js";
import type { createWorkosOrganizationOnboarding } from "./organization-onboarding.js";
import { OrganizationOnboardingError } from "./onboarding-error.js";
import { CurrentIdentityError, type createWorkosCurrentIdentity } from "./current-identity.js";

const serviceBindingCapability = Object.freeze({});

export function createServiceBindingAuthenticator() {
  return {
    authentication: serviceBindingCapability,
    authenticator: {
      async authenticate(input: {
        readonly authentication: unknown;
        readonly requestId: string;
      }): Promise<boolean> {
        return input.authentication === serviceBindingCapability;
      },
    },
  } as const;
}

const readBoundedBody = async (request: Request, maximumBytes: number): Promise<unknown> => {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new RangeError("Service binding request is too large");
    }
  }
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maximumBytes) throw new RangeError("Service binding request is too large");
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
};

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });

export function createPrivateServiceBindingHandler(input: {
  readonly rpc: WorkosManagementRpc;
  readonly maxRequestBytes?: number;
  readonly authentication?: unknown;
  readonly sessionStatus?: WorkosSessionStatusChecker;
  readonly organizationOnboarding?: ReturnType<typeof createWorkosOrganizationOnboarding>;
  readonly currentIdentity?: ReturnType<typeof createWorkosCurrentIdentity>;
  readonly sessionRevocation?: ReturnType<typeof createWorkosSessionRevocation>;
  readonly userApiKeys?: ReturnType<typeof createWorkosUserApiKeyValidation>;
  readonly userKeyLifecycle?: ReturnType<typeof createWorkosUserKeyLifecycle>;
}) {
  const boundary = createServiceBindingAuthenticator();
  const authentication = input.authentication ?? boundary.authentication;
  const maximumBytes = input.maxRequestBytes ?? 16_384;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("Service binding body limit must be a positive safe integer");
  }
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/current-identity" && url.search === "") {
        if (!input.currentIdentity)
          return jsonResponse({ error: { code: "service_unavailable" } }, 503);
        try {
          return jsonResponse(
            await input.currentIdentity.read(await readBoundedBody(request, maximumBytes)),
            200,
          );
        } catch (error) {
          const code =
            error instanceof CurrentIdentityError
              ? error.code
              : error instanceof SyntaxError || error instanceof RangeError
                ? "invalid_request"
                : "service_unavailable";
          return jsonResponse({ error: { code } }, code === "invalid_request" ? 400 : 503);
        }
      }
      if (
        request.method === "POST" &&
        url.search === "" &&
        ["/user-api-keys/create", "/user-api-keys/list", "/user-api-keys/revoke"].includes(
          url.pathname,
        )
      ) {
        if (!input.userKeyLifecycle)
          return jsonResponse({ error: { code: "service_unavailable" } }, 503);
        try {
          const body = await readBoundedBody(request, 4096);
          const action = url.pathname.endsWith("/create")
            ? "create"
            : url.pathname.endsWith("/list")
              ? "list"
              : "revoke";
          return jsonResponse(await input.userKeyLifecycle[action](body), 200);
        } catch (error) {
          const code =
            error instanceof UserKeyLifecycleError || error instanceof UserApiKeyRequestError
              ? error.code
              : "service_unavailable";
          return jsonResponse(
            { error: { code } },
            code === "invalid_request"
              ? 400
              : code === "forbidden"
                ? 403
                : code === "resource_not_found"
                  ? 404
                  : code === "idempotency_key_reused"
                    ? 409
                    : 503,
          );
        }
      }
      if (
        request.method === "POST" &&
        ["/api-key-validate", "/api-key-observe"].includes(url.pathname) &&
        url.search === ""
      ) {
        if (!input.userApiKeys) return jsonResponse({ error: { code: "unavailable" } }, 503);
        try {
          return jsonResponse(
            await input.userApiKeys[url.pathname === "/api-key-validate" ? "validate" : "observe"](
              await readBoundedBody(request, 512),
            ),
            200,
          );
        } catch (error) {
          const invalid =
            error instanceof WorkosContractError && error.code === "invalid_api_key_request";
          return jsonResponse(
            { error: { code: invalid ? "invalid_request" : "unavailable" } },
            invalid ? 400 : 503,
          );
        }
      }
      if (
        request.method === "POST" &&
        url.pathname === "/user-profile" &&
        url.search === "" &&
        input.organizationOnboarding
      ) {
        try {
          return jsonResponse(
            await input.organizationOnboarding.profile(await readBoundedBody(request, 1024)),
            200,
          );
        } catch (error) {
          const code =
            error instanceof OrganizationOnboardingError ? error.code : "service_unavailable";
          return jsonResponse(
            { error: { code } },
            code === "invalid_request" ? 400 : code === "forbidden" ? 403 : 503,
          );
        }
      }
      if (request.method === "POST" && url.pathname === "/session-revoke" && url.search === "") {
        if (!input.sessionRevocation)
          return jsonResponse({ error: { code: "service_unavailable" } }, 503);
        try {
          return jsonResponse(
            await input.sessionRevocation.revoke(await readBoundedBody(request, 1024)),
            200,
          );
        } catch (error) {
          const code = error instanceof SessionRevocationError ? error.code : "service_unavailable";
          return jsonResponse(
            { error: { code } },
            code === "forbidden" ? 403 : code === "invalid_request" ? 400 : 503,
          );
        }
      }
      if (
        request.method === "POST" &&
        url.pathname === "/organizations" &&
        url.search === "" &&
        input.organizationOnboarding
      ) {
        try {
          return jsonResponse(
            await input.organizationOnboarding.create(await readBoundedBody(request, maximumBytes)),
            201,
          );
        } catch (error) {
          const code =
            error instanceof OrganizationOnboardingError
              ? error.code
              : error instanceof SyntaxError
                ? "invalid_request"
                : "service_unavailable";
          const status =
            code === "invalid_request"
              ? 400
              : code === "idempotency_key_reused"
                ? 409
                : code === "forbidden"
                  ? 403
                  : 503;
          return jsonResponse({ error: { code } }, status);
        }
      }
      if (request.method === "POST" && url.pathname === "/session-status" && url.search === "") {
        if (input.sessionStatus === undefined) return jsonResponse({ active: false }, 503);
        try {
          const body = await readBoundedBody(request, maximumBytes);
          return jsonResponse(await input.sessionStatus.check(body), 200);
        } catch {
          return jsonResponse({ active: false }, 503);
        }
      }
      if (request.method !== "POST" || url.pathname !== "/rpc" || url.search !== "") {
        return jsonResponse({ ok: false, error: { code: "not_found" } }, 404);
      }
      let body: unknown;
      try {
        body = await readBoundedBody(request, maximumBytes);
      } catch (error) {
        return error instanceof RangeError
          ? jsonResponse({ ok: false, error: { code: "request_too_large" } }, 413)
          : jsonResponse({ ok: false, error: { code: "invalid_request" } }, 400);
      }
      const result = await input.rpc.dispatch(body, authentication);
      return jsonResponse(result.body, result.status);
    },
  };
}
