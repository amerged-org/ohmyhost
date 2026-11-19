import { AUTHORIZATION_ACTIONS } from "../../ports/index.js";
import type {
  AuthorizationAction,
  AuthorizationCheck,
  AuthorizationPort,
  AuthorizationPrincipal,
  AuthorizationResource,
} from "../../ports/index.js";
import type { Ulid } from "../../shared/index.js";

export type LocalAuthorizationRole = "owner" | "member";

export interface LocalAuthorizationGrant {
  readonly grantId: Ulid;
  readonly principal: AuthorizationPrincipal;
  readonly resource: AuthorizationResource;
  readonly role: LocalAuthorizationRole;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly projectScope: {
    readonly ownershipVersion: number;
    readonly billingEpochId: Ulid;
    readonly state: "active" | "transfer_pending_frozen" | "security_frozen";
  } | null;
}

export interface LocalAuthorizationGrantReader {
  findGrant(input: AuthorizationCheck): Promise<LocalAuthorizationGrant | null>;
}

const MEMBER_ACTIONS: ReadonlySet<AuthorizationAction> = new Set([
  "api-keys:manage",
  "feedback:create",
  "projects:read",
  "sources:read",
  "deployments:read",
  "operations:read",
  "logs:read",
  "audit:read",
  "mail-domains:read",
  "integrations:read",
]);

/** Maps one unambiguous WorkOS role into the local two-role model. */
export function mapWorkosRolesToLocalRole(roles: readonly string[]): LocalAuthorizationRole | null {
  const normalized = [...new Set(roles.map((role) => role.trim()).filter(Boolean))];
  if (normalized.length !== 1) return null;
  return normalized[0] === "admin" || normalized[0] === "owner"
    ? "owner"
    : normalized[0] === "member"
      ? "member"
      : null;
}

/** Creates the sole local owner/member authorization adapter. */
export function createLocalAuthorizationPort(
  reader: LocalAuthorizationGrantReader,
): AuthorizationPort {
  return Object.freeze({
    async check(input: AuthorizationCheck) {
      if (input.principal.kind !== "user") return "deny";
      if (!actionSupportsResource(input.action, input.resource)) return "deny";
      const grant = await reader.findGrant(input);
      if (grant === null || !grantMatchesCheck(grant, input)) return "deny";
      if (grant.revokedAt !== null) return "deny";
      if (grant.role !== "owner" && grant.role !== "member") return "deny";
      if (grant.resource.kind === "project") {
        if (grant.projectScope?.state !== "active") return "deny";
      } else if (grant.projectScope !== null) {
        return "deny";
      }
      return grant.role === "owner" || MEMBER_ACTIONS.has(input.action) ? "allow" : "deny";
    },
  });
}

function actionSupportsResource(
  action: AuthorizationAction,
  resource: AuthorizationResource,
): boolean {
  if (action === "mail-domains:read" || action === "mail-domains:admin")
    return resource.kind === "organization" || resource.kind === "mail_domain";
  if (action === "mail-domains:use") return resource.kind === "mail_domain";
  if (resource.kind === "mail_domain") return false;
  if (action === "integrations:read" || action === "integrations:manage")
    return (
      resource.kind === "organization" ||
      (resource.kind === "project" && resource.environmentId !== undefined)
    );
  if (
    action === "feedback:create" ||
    action === "audit:read" ||
    action === "projects:read" ||
    action === "sources:link" ||
    action === "sources:read"
  )
    return true;
  if (
    action === "api-keys:manage" ||
    action === "projects:create" ||
    action === "credits:read" ||
    action === "billing:manage"
  )
    return resource.kind === "organization";
  if (
    action === "secrets:read" ||
    action === "secrets:write" ||
    action === "secrets:delete" ||
    action === "auth:read" ||
    action === "auth:manage"
  ) {
    return resource.kind === "project" && resource.environmentId !== undefined;
  }
  return resource.kind === "project";
}

function grantMatchesCheck(grant: LocalAuthorizationGrant, check: AuthorizationCheck): boolean {
  if (
    grant.principal.kind !== check.principal.kind ||
    grant.principal.subjectId !== check.principal.subjectId ||
    grant.resource.kind !== check.resource.kind ||
    grant.resource.organizationId !== check.resource.organizationId
  ) {
    return false;
  }
  if (grant.resource.kind === "organization" || check.resource.kind === "organization") {
    return grant.resource.kind === check.resource.kind;
  }
  if (grant.resource.kind === "mail_domain" || check.resource.kind === "mail_domain")
    return (
      grant.resource.kind === "mail_domain" &&
      check.resource.kind === "mail_domain" &&
      grant.resource.mailDomainId === check.resource.mailDomainId
    );
  return (
    grant.resource.projectId === check.resource.projectId &&
    grant.resource.environmentId === check.resource.environmentId
  );
}

export type ProjectAuthorizationState =
  | "active"
  | "frozen"
  | "transfer_pending_frozen"
  | "security_frozen";

export interface AuthorizeProjectActionInput {
  readonly port: AuthorizationPort;
  readonly check: AuthorizationCheck;
  readonly transferState: ProjectAuthorizationState;
}

export type ProjectAuthorizationOutcome =
  | { readonly decision: "allow" }
  | {
      readonly decision: "deny";
      readonly reason:
        | "BACKEND_DENIED"
        | "PROJECT_FROZEN"
        | "AUTHORIZATION_BACKEND_UNAVAILABLE"
        | "INVALID_BACKEND_DECISION";
    };

/**
 * Makes one fresh backend decision for every active-project request and fails
 * closed for frozen projects, backend failures, and malformed decisions.
 */
export async function authorizeProjectAction({
  port,
  check,
  transferState,
}: AuthorizeProjectActionInput): Promise<ProjectAuthorizationOutcome> {
  if (transferState !== "active") {
    return deny("PROJECT_FROZEN");
  }

  try {
    const decision: unknown = await port.check(check);
    if (decision === "allow") {
      return Object.freeze({ decision: "allow" });
    }
    return deny(decision === "deny" ? "BACKEND_DENIED" : "INVALID_BACKEND_DECISION");
  } catch {
    return deny("AUTHORIZATION_BACKEND_UNAVAILABLE");
  }
}

function deny(
  reason: Extract<ProjectAuthorizationOutcome, { decision: "deny" }>["reason"],
): ProjectAuthorizationOutcome {
  return Object.freeze({ decision: "deny", reason });
}

/** Intersects a verified credential ceiling with the concrete requested resource. */
export function restrictionAllows(
  restriction: import("../../ports/index.js").AuthorizationRestriction | undefined,
  resource: AuthorizationResource,
  action: AuthorizationAction,
): boolean {
  if (!restriction) return true;
  if (restriction.actions && !restriction.actions.includes(action)) return false;
  if (restriction.organizationIds && !restriction.organizationIds.includes(resource.organizationId))
    return false;
  if (
    resource.kind === "organization" &&
    restriction.projectIds &&
    (action === "projects:create" ||
      action === "sources:link" ||
      action === "sources:read" ||
      action === "integrations:read" ||
      action === "integrations:manage")
  )
    return false;
  if (
    resource.kind === "organization" &&
    restriction.mailDomainIds &&
    action === "mail-domains:admin"
  )
    return false;
  if (
    resource.kind === "project" &&
    restriction.projectIds &&
    !restriction.projectIds.includes(resource.projectId)
  )
    return false;
  if (
    resource.kind === "mail_domain" &&
    restriction.mailDomainIds &&
    !restriction.mailDomainIds.includes(resource.mailDomainId)
  )
    return false;
  return true;
}

/** Preserve both independent credential ceilings in durable work. */
export function intersectAuthorizationRestriction(
  restriction: import("../../ports/index.js").AuthorizationRestriction | undefined,
  scope: readonly string[] | undefined,
): import("../../ports/index.js").AuthorizationRestriction | undefined {
  if (scope === undefined) return restriction;
  const actions = scope.filter((action): action is AuthorizationAction =>
    (AUTHORIZATION_ACTIONS as readonly string[]).includes(action),
  );
  return {
    ...restriction,
    actions: restriction?.actions
      ? actions.filter((action) => restriction.actions?.includes(action))
      : actions,
  };
}
