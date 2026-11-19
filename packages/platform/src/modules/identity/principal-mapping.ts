import type { AuthorizationPrincipal } from "../../ports/index.js";
import { DomainError } from "../../shared/index.js";

export type AuthenticationPrincipal =
  | { readonly kind: "workos_user"; readonly userId: string }
  | { readonly kind: "device_session"; readonly sessionId: string; readonly userId: string }
  | { readonly kind: "organization_api_key"; readonly apiKeyId: string }
  | { readonly kind: "m2m_service"; readonly clientId: string };

export function toAuthorizationPrincipal(source: AuthenticationPrincipal): AuthorizationPrincipal {
  switch (source.kind) {
    case "workos_user":
      return freezePrincipal("user", `user:${requireSubject(source.userId)}`);
    case "device_session":
      return freezePrincipal("user", `user:${requireSubject(source.userId)}`);
    case "organization_api_key":
      return freezePrincipal("organization_api_key", `api_key:${requireSubject(source.apiKeyId)}`);
    case "m2m_service":
      return freezePrincipal("m2m_service", `service:${requireSubject(source.clientId)}`);
  }
}

function requireSubject(subjectId: string): string {
  if (subjectId.trim() === "") {
    throw new DomainError("INVALID_AUTHENTICATION_PRINCIPAL", "Principal subject is required");
  }
  return subjectId;
}

function freezePrincipal(
  kind: AuthorizationPrincipal["kind"],
  subjectId: AuthorizationPrincipal["subjectId"],
): AuthorizationPrincipal {
  return Object.freeze({ kind, subjectId }) as AuthorizationPrincipal;
}
