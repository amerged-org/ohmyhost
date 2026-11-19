import { parseUlid } from "@ohmyhost/platform";
import type { ControlApiDependencies } from "./contracts.js";
import { readBoundedText, type WorkosSessionStatusBinding } from "./workos-session-status.js";

export class OrganizationCreationError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "forbidden"
      | "idempotency_key_reused"
      | "service_unavailable",
  ) {
    super(code);
  }
}

export function createOrganizationOnboardingPort(
  binding: WorkosSessionStatusBinding,
): NonNullable<ControlApiDependencies["organizationOnboarding"]> {
  return {
    async create({ principal, name, signupSource, idempotencyKey }) {
      if (
        principal.authorizationPrincipal.kind !== "user" ||
        !principal.actorId.startsWith("user:user_") ||
        !principal.credentialId.startsWith("workos_session:session_")
      )
        throw new OrganizationCreationError("forbidden");
      try {
        const response = await binding.fetch(
          new Request("https://auth-status.internal/organizations", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              initial: principal.organizationIds.length === 0,
              userId: principal.actorId.slice(5),
              sessionId: principal.credentialId.slice("workos_session:".length),
              name,
              signupSource,
              idempotencyKey,
            }),
            signal: AbortSignal.timeout(30_000),
          }),
        );
        const body: unknown = JSON.parse(await readBoundedText(response, 2048));
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("Invalid organization response");
        const result = body as Record<string, unknown>;
        if (response.status !== 201) {
          const code = (result["error"] as { code?: unknown } | undefined)?.code;
          if (
            (response.status === 400 && code === "invalid_request") ||
            (response.status === 403 && code === "forbidden") ||
            (response.status === 409 && code === "idempotency_key_reused")
          )
            throw new OrganizationCreationError(code);
          throw new OrganizationCreationError("service_unavailable");
        }
        if (
          Object.keys(result).sort().join(",") !== "id,name" ||
          typeof result["id"] !== "string" ||
          typeof result["name"] !== "string" ||
          result["name"].length < 1 ||
          result["name"].length > 128
        )
          throw new Error("Invalid organization response");
        return { id: parseUlid(result["id"]), name: result["name"] };
      } catch (error) {
        if (error instanceof OrganizationCreationError) throw error;
        throw new OrganizationCreationError("service_unavailable");
      }
    },
  };
}
