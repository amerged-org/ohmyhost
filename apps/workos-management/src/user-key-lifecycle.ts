import { parseUlid } from "@ohmyhost/platform";
import { parseWorkosSessionStatusRequest } from "@ohmyhost/workos-auth-contracts";
import {
  parseUserApiKey,
  parseUserApiKeyCreation,
  parseUserApiKeyPage,
  USER_API_KEY_ID,
  type UserApiKey,
  type UserApiKeyCreation,
  type UserApiKeyPage,
} from "@ohmyhost/contracts/user-api-keys";
import type { UserApiKeyFinishOutcome, WorkosUserKeyIdentityPort } from "./identity-port.js";
import {
  createWorkosUserApiKeyManagement,
  UserApiKeyManagementError,
  type ManagedUserApiKey,
} from "./user-api-keys.js";

export class UserKeyLifecycleError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "forbidden"
      | "resource_not_found"
      | "api_key_creation_uncertain"
      | "api_key_permissions_unavailable"
      | "service_unavailable",
  ) {
    super(code);
  }
}
interface Scope {
  organizationId: string;
  workosOrganizationId: string;
  userId: string;
  sessionId: string;
  tokenExpiresAt: number;
}

/** Authenticated private orchestration; a WorkOS key never receives provider-management authority. */
export function createWorkosUserKeyLifecycle(input: {
  identity: WorkosUserKeyIdentityPort;
  credential: string;
  fetcher: (request: Request) => Promise<Response>;
  clock: { now(): Date };
  ids: { next(): string };
}) {
  const provider = createWorkosUserApiKeyManagement(input);
  const scope = (raw: unknown, fields: readonly string[]) => {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid");
      const value = raw as Record<string, unknown>;
      const required = [
        "organizationId",
        "workosOrganizationId",
        "userId",
        "sessionId",
        "tokenExpiresAt",
        ...fields,
      ];
      if (Object.keys(value).sort().join() !== required.sort().join()) throw new Error("invalid");
      if (typeof value["organizationId"] !== "string") throw new Error("invalid");
      parseUlid(value["organizationId"]);
      parseWorkosSessionStatusRequest({
        sessionId: value["sessionId"],
        userId: value["userId"],
        organizationId: value["workosOrganizationId"],
        tokenExpiresAt: value["tokenExpiresAt"],
      });
      return {
        value,
        scope: {
          organizationId: value["organizationId"] as string,
          workosOrganizationId: value["workosOrganizationId"] as string,
          userId: value["userId"] as string,
          sessionId: value["sessionId"] as string,
          tokenExpiresAt: value["tokenExpiresAt"] as number,
        },
      };
    } catch {
      throw new UserKeyLifecycleError("invalid_request");
    }
  };
  const authorize = async (scope: Scope) => {
    if (scope.tokenExpiresAt <= Math.floor(input.clock.now().getTime() / 1000))
      throw new UserKeyLifecycleError("forbidden");
    await input.identity.authorizeUserApiKeyScope({
      ...identityScope(scope),
      now: input.clock.now().toISOString(),
    });
  };
  /** The identity port never sees the token expiry: the Worker checks it itself, against its own clock. */
  const identityScope = (scope: Scope) => ({
    organizationId: scope.organizationId,
    workosOrganizationId: scope.workosOrganizationId,
    userId: scope.userId,
    sessionId: scope.sessionId,
  });
  const providerScope = (scope: Scope) => ({
    userId: scope.userId,
    organizationId: scope.workosOrganizationId,
  });
  const keyView = (key: ManagedUserApiKey, scope: Scope, name = key.name): UserApiKey =>
    parseUserApiKey({
      id: key.id,
      organization_id: scope.organizationId,
      name,
      obfuscated_value: key.obfuscatedValue,
      permissions: [...key.permissions],
      expires_at: key.expiresAt,
      created_at: key.createdAt,
      last_used_at: key.lastUsedAt,
    });
  return {
    async create(raw: unknown): Promise<UserApiKeyCreation> {
      const parsed = scope(raw, ["name", "idempotencyKey"]),
        current = parsed.scope;
      await authorize(current);
      const claim = await input.identity.claimUserApiKeyCreation({
        ...identityScope(current),
        name: parsed.value["name"] as string,
        idempotencyKey: parsed.value["idempotencyKey"] as string,
        requestId: input.ids.next(),
        auditEventId: input.ids.next(),
        now: input.clock.now().toISOString(),
      });
      const finish = (outcome: UserApiKeyFinishOutcome) =>
        input.identity.finishUserApiKeyCreation({
          ...identityScope(current),
          requestId: claim.requestId,
          auditEventId: input.ids.next(),
          now: input.clock.now().toISOString(),
          outcome,
        });
      if (claim.action === "create") {
        // Refused before any request is sent: the claim ends rejected, so a retry under the same key creates again (CORE-46).
        try {
          await authorize(current);
        } catch (error) {
          await finish({ kind: "rejected", code: "KEY_CREATION_NOT_SENT" });
          throw error;
        }
        let result;
        try {
          result = await provider.create({
            ...providerScope(current),
            name: claim.providerName,
            permissions: claim.permissions,
            expiresAt: claim.expiresAt,
          });
        } catch (error) {
          if (
            error instanceof UserApiKeyManagementError &&
            error.code === "key_permissions_unavailable"
          ) {
            await finish({ kind: "rejected", code: "KEY_PERMISSIONS_UNAVAILABLE" });
            throw new UserKeyLifecycleError("api_key_permissions_unavailable");
          }
          if (
            error instanceof UserApiKeyManagementError &&
            error.code === "key_creation_not_sent"
          ) {
            await finish({ kind: "rejected", code: "KEY_CREATION_NOT_SENT" });
            throw new UserKeyLifecycleError("service_unavailable");
          }
          throw new UserKeyLifecycleError("api_key_creation_uncertain");
        }
        await finish({ kind: "created", keyId: result.key.id });
        await authorize(current);
        return parseUserApiKeyCreation({
          request_id: claim.requestId,
          replayed: false,
          key: keyView(result.key, current, parsed.value["name"] as string),
          value: result.value,
        });
      }
      let key =
        claim.keyId === null
          ? null
          : await provider.get({ ...providerScope(current), keyId: claim.keyId });
      if (claim.keyId !== null && key === null)
        throw new UserKeyLifecycleError("resource_not_found");
      if (claim.keyId === null) {
        let after: string | undefined;
        for (let page = 0; page < 10; page++) {
          const result = await provider.list({
            ...providerScope(current),
            ...(after ? { after } : {}),
          });
          const matches = result.keys.filter((candidate) => candidate.name === claim.providerName);
          if (matches.length > 1 || (key !== null && matches.length))
            throw new UserKeyLifecycleError("api_key_creation_uncertain");
          key = matches[0] ?? key;
          if (result.nextCursor === null) break;
          if (page === 9) throw new UserKeyLifecycleError("api_key_creation_uncertain");
          after = result.nextCursor;
        }
        if (
          key === null ||
          key.expiresAt !== claim.expiresAt ||
          [...key.permissions].sort().join() !== [...claim.permissions].sort().join()
        )
          throw new UserKeyLifecycleError("api_key_creation_uncertain");
        await finish({ kind: "created", keyId: key.id });
      }
      if (key === null) throw new UserKeyLifecycleError("api_key_creation_uncertain");
      await authorize(current);
      return parseUserApiKeyCreation({
        request_id: claim.requestId,
        replayed: true,
        key: keyView(key, current, parsed.value["name"] as string),
        value: null,
      });
    },
    async list(raw: unknown): Promise<UserApiKeyPage> {
      const parsed = scope(raw, ["after"]),
        current = parsed.scope;
      if (
        parsed.value["after"] !== null &&
        (typeof parsed.value["after"] !== "string" || !USER_API_KEY_ID.test(parsed.value["after"]))
      )
        throw new UserKeyLifecycleError("invalid_request");
      await authorize(current);
      const result = await provider.list({
        ...providerScope(current),
        ...(parsed.value["after"] === null ? {} : { after: parsed.value["after"] as string }),
      });
      const names = await input.identity.readUserApiKeyNames({
        organizationId: current.organizationId,
        userId: current.userId,
        keyIds: result.keys.map((key) => key.id),
      });
      await authorize(current);
      return parseUserApiKeyPage({
        data: result.keys.map((key) => keyView(key, current, names.get(key.id))),
        next_cursor: result.nextCursor,
      });
    },
    async revoke(raw: unknown): Promise<{ revoked: true }> {
      const parsed = scope(raw, ["keyId"]),
        current = parsed.scope,
        keyId = parsed.value["keyId"];
      if (typeof keyId !== "string" || !USER_API_KEY_ID.test(keyId))
        throw new UserKeyLifecycleError("invalid_request");
      await authorize(current);
      // WorkOS has no single-key read and the pages of its listing are bounded here, so ownership is proven from the
      // creation this user recorded and the key is deleted by its id. A key that was never recorded for this user is
      // not found. A key that is already gone answers absent, so a retry still records the revoked stage.
      const recorded = await input.identity.readUserApiKeyNames({
        organizationId: current.organizationId,
        userId: current.userId,
        keyIds: [keyId],
      });
      if (!recorded.has(keyId)) throw new UserKeyLifecycleError("resource_not_found");
      await authorize(current);
      const audit = (stage: "requested" | "revoked") =>
        input.identity.recordUserApiKeyRevocationAudit({
          organizationId: parseUlid(current.organizationId),
          workosOrganizationId: current.workosOrganizationId,
          userId: current.userId,
          keyId,
          stage,
          auditEventId: parseUlid(input.ids.next()),
          now: input.clock.now().toISOString(),
        });
      await audit("requested");
      await provider.revoke({ ...providerScope(current), keyId });
      await audit("revoked");
      return { revoked: true };
    },
  };
}
