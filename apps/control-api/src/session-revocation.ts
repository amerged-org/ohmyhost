import type { ControlApiDependencies } from "./contracts.js";
import { readBoundedText, type WorkosSessionStatusBinding } from "./workos-session-status.js";

export function createCurrentSessionRevocationPort(
  binding: WorkosSessionStatusBinding,
): NonNullable<ControlApiDependencies["sessionRevocation"]> {
  return {
    async revoke(principal) {
      if (
        principal.authorizationPrincipal.kind !== "user" ||
        !principal.actorId.startsWith("user:user_") ||
        !principal.credentialId.startsWith("workos_session:session_")
      )
        throw new Error("Current user session is required");
      const response = await binding.fetch(
        new Request("https://auth-status.internal/session-revoke", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            userId: principal.actorId.slice(5),
            sessionId: principal.credentialId.slice("workos_session:".length),
          }),
          signal: AbortSignal.timeout(30_000),
        }),
      );
      const result: unknown = JSON.parse(await readBoundedText(response, 2048));
      if (
        response.status !== 200 ||
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).join(",") !== "revoked" ||
        Reflect.get(result, "revoked") !== true
      )
        throw new Error("Session revocation is unavailable");
    },
  };
}
