import {
  parseUserApiKeyCreation,
  parseUserApiKeyPage,
  type UserApiKeyCreation,
  type UserApiKeyPage,
} from "@ohmyhost/contracts/user-api-keys";
import type { AuthenticatedPrincipal } from "./contracts.js";
import { readBoundedText } from "./workos-session-status.js";

type KeyServiceCode =
  | "invalid_request"
  | "forbidden"
  | "resource_not_found"
  | "idempotency_key_reused"
  | "api_key_creation_uncertain"
  | "api_key_permissions_unavailable"
  | "service_unavailable";
export class UserApiKeyServiceError extends Error {
  constructor(readonly code: KeyServiceCode) {
    super(code);
  }
}
interface Context {
  principal: AuthenticatedPrincipal;
  organizationId: string;
}
export interface UserApiKeyManagementPort {
  create(input: Context & { name: string; idempotencyKey: string }): Promise<UserApiKeyCreation>;
  list(input: Context & { after: string | null }): Promise<UserApiKeyPage>;
  revoke(input: Context & { keyId: string }): Promise<void>;
}

/** All provider credentials stay in the existing private WorkOS Worker. */
export function createUserApiKeyManagementPort(binding: {
  fetch(request: Request): Promise<Response>;
}): UserApiKeyManagementPort {
  const call = async (
    action: string,
    context: Context,
    fields: Record<string, unknown>,
  ): Promise<unknown> => {
    const session = context.principal.session;
    if (
      !session?.organizationId ||
      context.principal.actorId !== `user:${session.userId}` ||
      context.principal.credentialId !== `workos_session:${session.sessionId}`
    )
      throw new UserApiKeyServiceError("forbidden");
    try {
      const response = await binding.fetch(
        new Request(`https://auth-status.internal/user-api-keys/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: context.organizationId,
            workosOrganizationId: session.organizationId,
            userId: session.userId,
            sessionId: session.sessionId,
            tokenExpiresAt: session.tokenExpiresAt,
            ...fields,
          }),
          signal: AbortSignal.timeout(30_000),
        }),
      );
      const value: unknown = JSON.parse(await readBoundedText(response, 65_536));
      if (!response.ok) {
        const code: unknown =
          value &&
          typeof value === "object" &&
          "error" in value &&
          value.error &&
          typeof value.error === "object"
            ? Reflect.get(value.error, "code")
            : undefined;
        if (
          typeof code === "string" &&
          [
            "invalid_request",
            "forbidden",
            "resource_not_found",
            "idempotency_key_reused",
            "api_key_creation_uncertain",
            "api_key_permissions_unavailable",
          ].includes(code)
        )
          throw new UserApiKeyServiceError(code as KeyServiceCode);
        throw new UserApiKeyServiceError("service_unavailable");
      }
      return value;
    } catch (error) {
      if (error instanceof UserApiKeyServiceError) throw error;
      throw new UserApiKeyServiceError("service_unavailable");
    }
  };
  return {
    async create(input) {
      const result = parseUserApiKeyCreation(
        await call("create", input, { name: input.name, idempotencyKey: input.idempotencyKey }),
      );
      if (result.key.organization_id !== input.organizationId)
        throw new UserApiKeyServiceError("service_unavailable");
      return result;
    },
    async list(input) {
      const result = parseUserApiKeyPage(await call("list", input, { after: input.after }));
      if (result.data.some((key) => key.organization_id !== input.organizationId))
        throw new UserApiKeyServiceError("service_unavailable");
      return result;
    },
    async revoke(input) {
      const result = await call("revoke", input, { keyId: input.keyId });
      if (
        !result ||
        typeof result !== "object" ||
        Object.keys(result).join() !== "revoked" ||
        Reflect.get(result, "revoked") !== true
      )
        throw new UserApiKeyServiceError("service_unavailable");
    },
  };
}
