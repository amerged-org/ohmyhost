/* v8 ignore file -- compile-time contract; exercised by TypeScript tests */

import type { Ulid } from "../shared/index.js";

export const AUTHORIZATION_ACTIONS = [
  "api-keys:manage",
  "feedback:create",
  "credits:read",
  "billing:manage",
  "projects:create",
  "projects:read",
  "projects:write",
  "projects:dev-access",
  "projects:rollback-plan",
  "projects:rollback",
  "projects:promote-plan",
  "projects:promote",
  "projects:delete-plan",
  "projects:delete",
  "sources:link",
  "sources:read",
  "deployments:plan",
  "deployments:create",
  "deployments:read",
  "operations:read",
  "operations:reconcile",
  "logs:read",
  "integrations:read",
  "integrations:manage",
  "auth:read",
  "auth:manage",
  "secrets:read",
  "secrets:write",
  "secrets:delete",
  "audit:read",
  "mail-domains:read",
  "mail-domains:use",
  "mail-domains:admin",
] as const;

export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];

export interface AuthorizationRestriction {
  readonly actions?: readonly AuthorizationAction[];
  readonly organizationIds?: readonly Ulid[];
  readonly projectIds?: readonly Ulid[];
  readonly mailDomainIds?: readonly Ulid[];
}

export type AuthorizationPrincipal =
  | { readonly kind: "user"; readonly subjectId: `user:${string}` }
  | { readonly kind: "organization_api_key"; readonly subjectId: `api_key:${string}` }
  | { readonly kind: "m2m_service"; readonly subjectId: `service:${string}` };

export type AuthorizationResource =
  | { readonly kind: "mail_domain"; readonly organizationId: Ulid; readonly mailDomainId: Ulid }
  | {
      readonly kind: "organization";
      readonly organizationId: Ulid;
    }
  | {
      readonly kind: "project";
      readonly organizationId: Ulid;
      readonly projectId: Ulid;
      readonly environmentId?: Ulid;
    };

export interface AuthorizationCheck {
  readonly principal: AuthorizationPrincipal;
  readonly resource: AuthorizationResource;
  readonly action: AuthorizationAction;
}

export type AuthorizationDecision = "allow" | "deny";

/**
 * Backend-neutral authorization decision boundary.
 *
 * Exactly one adapter implements this port in a running control plane. Core code
 * must not identify or combine authorization vendors.
 */
export interface AuthorizationPort {
  check(input: AuthorizationCheck): Promise<AuthorizationDecision>;
}
