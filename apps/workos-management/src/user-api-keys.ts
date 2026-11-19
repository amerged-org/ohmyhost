import {
  expectRecord,
  parseWorkosUserApiKeyObservationRequest,
  parseWorkosUserApiKeyRequest,
  parseWorkosUserApiKeyResponse,
} from "@ohmyhost/workos-auth-contracts";
import { readJson } from "./workos-readonly-transport.js";
import { AUTHORIZATION_ACTIONS } from "@ohmyhost/platform";

interface UserKeyScope {
  readonly userId: string;
  readonly organizationId: string;
}

export interface ManagedUserApiKey extends UserKeyScope {
  readonly id: string;
  readonly name: string;
  readonly obfuscatedValue: string;
  readonly permissions: readonly string[];
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export class UserApiKeyManagementError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "key_permissions_unavailable"
      /** Failed before the creation request was sent, so no key exists (CORE-46). */
      | "key_creation_not_sent"
      | "unavailable",
  ) {
    super(code);
  }
}

/** Expected environment permission definitions; configuration remains an operator action. */
export const WORKOS_NATIVE_AUTH_PERMISSIONS = Object.freeze([
  Object.freeze({
    slug: "auth:read",
    name: "Read Native Auth",
    description: "Read Owner-authorized Native Auth configuration and users.",
  }),
  Object.freeze({
    slug: "auth:manage",
    name: "Manage Native Auth",
    description: "Manage Owner-authorized Native Auth configuration, providers and users.",
  }),
] as const);

/** Read-only check of both Native permission definitions in the credential's WorkOS environment. */
export async function checkWorkosNativeAuthPermissionDefinitions(input: {
  readonly credential: string;
  readonly fetcher: (request: Request) => Promise<Response>;
}): Promise<{ readonly ready: boolean; readonly missing: readonly string[] }> {
  const missing: string[] = [];
  for (const { slug } of WORKOS_NATIVE_AUTH_PERMISSIONS) {
    let response: Response;
    try {
      response = await input.fetcher(
        new Request(
          `https://api.workos.com/authorization/permissions/${encodeURIComponent(slug)}`,
          {
            method: "GET",
            redirect: "manual",
            headers: { authorization: `Bearer ${input.credential}` },
            signal: AbortSignal.timeout(10_000),
          },
        ),
      );
      if (response.status === 404) {
        await response.body?.cancel();
        missing.push(slug);
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error();
      }
      const value = expectRecord(await readJson(response, 16_384));
      if (
        value["object"] !== "permission" ||
        value["slug"] !== slug ||
        typeof value["id"] !== "string" ||
        !/^perm(?:ission)?_[A-Za-z0-9_]{1,128}$/u.test(value["id"])
      )
        throw new Error();
    } catch {
      throw new UserApiKeyManagementError("unavailable");
    }
  }
  return { ready: missing.length === 0, missing: Object.freeze(missing) };
}

/** Private provider adapter. The caller authorizes scope and durably claims creation before entry. */
export function createWorkosUserApiKeyManagement(input: {
  readonly credential: string;
  readonly fetcher: (request: Request) => Promise<Response>;
}) {
  const request = async (path: string, method = "GET", body?: object, allowAbsent = false) => {
    try {
      const response = await input.fetcher(
        new Request(`https://api.workos.com${path}`, {
          method,
          redirect: "manual",
          headers: {
            authorization: `Bearer ${input.credential}`,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(10_000),
        }),
      );
      if (response.status === 422 && method === "POST") {
        const result = expectRecord(await readJson(response, 16_384));
        if (
          Array.isArray(result["errors"]) &&
          result["errors"].some(
            (error: unknown) =>
              error !== null &&
              typeof error === "object" &&
              Reflect.get(error, "field") === "permissions",
          )
        )
          throw new UserApiKeyManagementError("key_permissions_unavailable");
      }
      // WorkOS answers 404 for a key that is already gone; only a caller that asks for it sees that as absent.
      if (allowAbsent && response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (response.status !== (method === "POST" ? 201 : method === "DELETE" ? 204 : 200)) {
        await response.body?.cancel();
        throw new UserApiKeyManagementError("unavailable");
      }
      if (method === "DELETE") {
        await response.body?.cancel();
        return null;
      }
      return expectRecord(await readJson(response, 65_536));
    } catch (error) {
      if (error instanceof UserApiKeyManagementError) throw error;
      throw new UserApiKeyManagementError("unavailable");
    }
  };
  const list = async (scope: UserKeyScope & { after?: string }) => {
    validateUserKeyScope(scope);
    if (scope.after !== undefined && !keyIdentifier(scope.after))
      throw new UserApiKeyManagementError("invalid_request");
    const query = new URLSearchParams({
      organization_id: scope.organizationId,
      limit: "20",
      ...(scope.after === undefined ? {} : { after: scope.after }),
    });
    const response = await request(`/user_management/users/${scope.userId}/api_keys?${query}`);
    if (
      response?.["object"] !== "list" ||
      !Array.isArray(response["data"]) ||
      response["data"].length > 20
    )
      throw new UserApiKeyManagementError("unavailable");
    const keys = response["data"].map((value) => managedUserKey(value, scope));
    const metadata = response["list_metadata"];
    const next =
      metadata !== null && typeof metadata === "object"
        ? Reflect.get(metadata, "after")
        : undefined;
    if (
      (next !== null &&
        (!keyIdentifier(next) || next === scope.after || next !== keys.at(-1)?.id)) ||
      new Set(keys.map((key) => key.id)).size !== keys.length
    )
      throw new UserApiKeyManagementError("unavailable");
    return { keys, nextCursor: next as string | null };
  };
  const get = async (
    scope: UserKeyScope & { keyId: string },
  ): Promise<ManagedUserApiKey | null> => {
    validateUserKeyScope(scope);
    if (!keyIdentifier(scope.keyId)) throw new UserApiKeyManagementError("invalid_request");
    let after: string | undefined;
    const seen = new Set<string>();
    // WorkOS has no public single-key GET. Observe through the scoped, bounded user listing.
    for (let page = 0; page < 10; page++) {
      const result = await list({
        userId: scope.userId,
        organizationId: scope.organizationId,
        ...(after === undefined ? {} : { after }),
      });
      const key = result.keys.find((item) => item.id === scope.keyId);
      if (key) return key;
      if (result.nextCursor === null) return null;
      if (seen.has(result.nextCursor)) throw new UserApiKeyManagementError("unavailable");
      seen.add(result.nextCursor);
      after = result.nextCursor;
    }
    throw new UserApiKeyManagementError("unavailable");
  };
  return {
    async create(
      scope: UserKeyScope & {
        name: string;
        permissions: readonly string[];
        expiresAt: string | null;
      },
    ) {
      validateUserKeyScope(scope);
      if (
        !keyName(scope.name) ||
        (scope.expiresAt !== null && !keyDate(scope.expiresAt)) ||
        !Array.isArray(scope.permissions) ||
        scope.permissions.length > AUTHORIZATION_ACTIONS.length ||
        new Set(scope.permissions).size !== scope.permissions.length ||
        scope.permissions.some(
          (permission) => !(AUTHORIZATION_ACTIONS as readonly string[]).includes(permission),
        )
      )
        throw new UserApiKeyManagementError("invalid_request");
      if (scope.permissions.includes("auth:read") || scope.permissions.includes("auth:manage")) {
        let readiness: Awaited<ReturnType<typeof checkWorkosNativeAuthPermissionDefinitions>>;
        try {
          readiness = await checkWorkosNativeAuthPermissionDefinitions(input);
        } catch {
          // The definitions read precedes the creation request: a failure here sends nothing (CORE-46).
          throw new UserApiKeyManagementError("key_creation_not_sent");
        }
        if (!readiness.ready) throw new UserApiKeyManagementError("key_permissions_unavailable");
      }
      // WorkOS ignored Idempotency-Key in the real P30 probe. Never retry this mutation here.
      const response = await request(`/user_management/users/${scope.userId}/api_keys`, "POST", {
        name: scope.name,
        organization_id: scope.organizationId,
        permissions: scope.permissions,
        ...(scope.expiresAt === null ? {} : { expires_at: scope.expiresAt }),
      });
      const key = managedUserKey(response, scope);
      if (
        key.name !== scope.name ||
        key.expiresAt !== scope.expiresAt ||
        [...key.permissions].sort().join(",") !== [...scope.permissions].sort().join(",")
      )
        throw new UserApiKeyManagementError("unavailable");
      let value: string;
      try {
        value = parseWorkosUserApiKeyRequest({ value: response?.["value"] }).value;
      } catch {
        throw new UserApiKeyManagementError("unavailable");
      }
      return { key, value };
    },
    list,
    get,
    /**
     * Deletes the key by its id, with no listing scan: WorkOS has no single-key read, and the caller has proven the
     * key from the creation it recorded. A key that is already gone answers absent.
     */
    async revoke(
      scope: UserKeyScope & { keyId: string },
    ): Promise<{ status: "revoked" | "absent" }> {
      validateUserKeyScope(scope);
      if (!keyIdentifier(scope.keyId)) throw new UserApiKeyManagementError("invalid_request");
      const deleted = await request(`/api_keys/${scope.keyId}`, "DELETE", undefined, true);
      return { status: deleted === undefined ? "absent" : "revoked" };
    },
  };
}

function keyIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^api_key_[A-Za-z0-9_]{1,120}$/u.test(value);
}

function validateUserKeyScope(scope: UserKeyScope) {
  if (
    typeof scope.userId !== "string" ||
    !/^user_[A-Za-z0-9_]{1,123}$/u.test(scope.userId) ||
    typeof scope.organizationId !== "string" ||
    !/^org_[A-Za-z0-9_]{1,124}$/u.test(scope.organizationId)
  )
    throw new UserApiKeyManagementError("invalid_request");
}

function keyName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 128 &&
    !/\p{Cc}/u.test(value)
  );
}

function keyDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function managedUserKey(value: unknown, scope: UserKeyScope): ManagedUserApiKey {
  try {
    const input = expectRecord(value);
    const owner = expectRecord(input["owner"]);
    if (
      input["object"] !== "api_key" ||
      owner["type"] !== "user" ||
      owner["id"] !== scope.userId ||
      owner["organization_id"] !== scope.organizationId ||
      !keyName(input["name"]) ||
      typeof input["obfuscated_value"] !== "string" ||
      !/^sk_(?:\.\.\.|…)[A-Za-z0-9_-]{1,12}$/u.test(input["obfuscated_value"]) ||
      !keyDate(input["created_at"]) ||
      (input["last_used_at"] !== null && !keyDate(input["last_used_at"]))
    )
      throw new UserApiKeyManagementError("unavailable");
    const metadata = parseWorkosUserApiKeyResponse({
      key: {
        id: input["id"],
        userId: scope.userId,
        organizationId: scope.organizationId,
        permissions: input["permissions"],
        expiresAt: input["expires_at"],
      },
    }).key;
    if (metadata === null) throw new UserApiKeyManagementError("unavailable");
    return {
      ...metadata,
      name: input["name"],
      obfuscatedValue: input["obfuscated_value"],
      createdAt: input["created_at"],
      lastUsedAt: input["last_used_at"],
    };
  } catch {
    throw new UserApiKeyManagementError("unavailable");
  }
}

/** Only the private WorkOS boundary receives the environment management credential. */
export function createWorkosUserApiKeyValidation(input: {
  readonly credential: string;
  readonly fetcher: (request: Request) => Promise<Response>;
}) {
  return {
    async observe(value: unknown) {
      const scope = parseWorkosUserApiKeyObservationRequest(value);
      const key = await createWorkosUserApiKeyManagement(input).get(scope);
      return parseWorkosUserApiKeyResponse({
        key:
          key === null
            ? null
            : {
                id: key.id,
                userId: key.userId,
                organizationId: key.organizationId,
                permissions: key.permissions,
                expiresAt: key.expiresAt,
              },
      });
    },
    async validate(value: unknown) {
      const request = parseWorkosUserApiKeyRequest(value);
      const response = await input.fetcher(
        new Request("https://api.workos.com/api_keys/validations", {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${input.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(10000),
        }),
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("api_key_validation_unavailable");
      }
      const result = expectRecord(await readJson(response, 16384));
      if (result["api_key"] === null) return { key: null };
      const key = expectRecord(result["api_key"]);
      if (key["object"] !== "api_key") throw new Error("api_key_validation_unavailable");
      const owner = expectRecord(key["owner"]);
      if (owner["type"] !== "user") return { key: null };
      return parseWorkosUserApiKeyResponse({
        key: {
          id: key["id"],
          userId: owner["id"],
          organizationId: owner["organization_id"],
          permissions: key["permissions"],
          expiresAt: key["expires_at"],
        },
      });
    },
  };
}
