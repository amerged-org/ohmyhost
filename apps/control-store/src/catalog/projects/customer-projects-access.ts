import { BARRIER_FREE_MEMBERSHIP_SQL } from "../identity/membership-barrier-sql.js";
import { z } from "zod";
import { AUTHORIZATION_ACTIONS } from "@ohmyhost/platform";

import { instant, type CatalogContext } from "../common.js";
import { ulid } from "../common.js";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import type { z as Zod } from "zod";

/**
 * The narrow reads the Control API needs to authenticate and authorize ONE customer request on D1. They answer decisions
 * and identifiers only (an organization id, the scopes of an M2M binding, allow or deny), never a row set, and none
 * accepts SQL, a permission list or a clock the caller controls beyond the observation instant of a token.
 */

export const resolveWorkosOrganizationInput = z.strictObject({
  workosOrganizationId: z.string().startsWith("org_").min(5).max(128),
});

/** `findOrganizationIdByWorkosOrganizationId`: the active mapping of a WorkOS organization, or null. */
export async function resolveWorkosOrganization(
  context: CatalogContext,
  rawInput: unknown,
): Promise<string | null> {
  const input = resolveWorkosOrganizationInput.parse(rawInput);
  const db = (await context.router.routeShard(0)).db;
  const row = await db
    .prepare(
      "SELECT organization_id FROM organizations WHERE workos_organization_id = ?1 AND state = 'active'",
    )
    .bind(input.workosOrganizationId)
    .first<{ organization_id: string }>();
  return row?.organization_id ?? null;
}

export const resolveM2mOrganizationInput = z.strictObject({
  connectClientId: z.string().min(1).max(255),
  workosOrganizationId: resolveWorkosOrganizationInput.shape.workosOrganizationId,
  observedAt: instant,
});

export interface M2mOrganizationBinding {
  readonly organizationId: string;
  readonly scopes: readonly string[];
}

/** `getM2mOrganizationBinding` behind the active organization mapping: an active, unexpired binding of this client. */
export async function resolveM2mOrganization(
  context: CatalogContext,
  rawInput: unknown,
): Promise<M2mOrganizationBinding | null> {
  const input = resolveM2mOrganizationInput.parse(rawInput);
  const db = (await context.router.routeShard(0)).db;
  const row = await db
    .prepare(
      `SELECT o.organization_id, b.scopes FROM organizations o
       JOIN m2m_organization_bindings b ON b.organization_id = o.organization_id
       WHERE o.workos_organization_id = ?1 AND o.state = 'active'
         AND b.connect_client_id = ?2 AND b.state = 'active'
         AND (b.expires_at IS NULL OR b.expires_at > ?3)`,
    )
    .bind(input.workosOrganizationId, input.connectClientId, input.observedAt)
    .first<{ organization_id: string; scopes: string }>();
  return row === null
    ? null
    : { organizationId: row.organization_id, scopes: JSON.parse(row.scopes) as string[] };
}

/** The project-route authorization follows the original local grant policy, including project epoch and membership. */
export const authorizeOrganizationActionInput = z.strictObject({
  organizationId: ulid,
  principalId: z.string().min(1),
  action: z.enum(AUTHORIZATION_ACTIONS),
  mailDomainId: ulid.optional(),
  projectId: ulid.optional(),
  environmentId: ulid.optional(),
});

type AuthorizationInput = Zod.output<typeof authorizeOrganizationActionInput>;
function validAuthorizationScope(input: AuthorizationInput): boolean {
  const domain = input.mailDomainId !== undefined;
  const project = input.projectId !== undefined;
  // Exact original actionSupportsResource policy; the caller supplies a concrete scope, never permissions.
  const organizationOnly = [
    "api-keys:manage",
    "projects:create",
    "credits:read",
    "billing:manage",
  ].includes(input.action);
  const flexible = [
    "feedback:create",
    "audit:read",
    "projects:read",
    "sources:link",
    "sources:read",
    "integrations:read",
    "integrations:manage",
  ].includes(input.action);
  const domainAction = ["mail-domains:read", "mail-domains:admin", "mail-domains:use"].includes(
    input.action,
  );
  if (
    !input.principalId.startsWith("user:") ||
    (project && domain) ||
    (!project && input.environmentId !== undefined) ||
    (domainAction && project) ||
    (input.action === "mail-domains:use" && !domain) ||
    (!domainAction && domain) ||
    (organizationOnly && project) ||
    (!domainAction && !organizationOnly && !flexible && !project) ||
    ((input.action.startsWith("secrets:") ||
      input.action.startsWith("auth:") ||
      (input.action.startsWith("integrations:") && project)) &&
      input.environmentId === undefined)
  )
    return false;
  return true;
}

// This single SQL expression defines the canonical role decision for both reads and transactional guards.
const AUTHORIZATION_ALLOWED = `WITH grants AS (SELECT g.role, m.role AS membership_role
    FROM local_authorization_grants g
    JOIN organization_memberships m ON m.organization_id=g.organization_id AND ('user:' || m.workos_user_id)=g.principal_id AND m.state='active'
    JOIN organizations o ON o.organization_id=g.organization_id AND o.state='active' AND o.beta_admitted_at IS NOT NULL
    LEFT JOIN projects p ON p.organization_id=g.organization_id AND p.project_id=?3
    LEFT JOIN billing_epochs e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.billing_epoch_id=p.active_billing_epoch_id AND e.ended_at IS NULL
    LEFT JOIN environments v ON v.organization_id=g.organization_id AND v.project_id=?3 AND v.environment_id=?4
    WHERE g.organization_id=?1 AND g.principal_kind='user' AND g.principal_id=?2 AND g.revoked_at IS NULL
      AND ${BARRIER_FREE_MEMBERSHIP_SQL}
      AND ((?3 IS NULL AND g.project_id IS NULL AND g.environment_id IS NULL)
        OR (?3 IS NOT NULL AND p.owner_state='active' AND e.billing_epoch_id IS NOT NULL AND (?4 IS NULL OR v.environment_id=?4)
          AND ((g.project_id IS NULL AND g.environment_id IS NULL)
            OR (g.project_id=?3 AND g.environment_id IS ?4 AND g.ownership_version=p.ownership_version AND g.billing_epoch_id=p.active_billing_epoch_id))))
      AND (?5 IS NULL OR EXISTS(SELECT 1 FROM workspace_mail_domains domain
        WHERE domain.organization_id=g.organization_id AND domain.domain_id=?5
        AND (?6<>'mail-domains:use' OR domain.status='active')))
    ORDER BY g.project_id NULLS LAST, g.created_at DESC, g.grant_id DESC LIMIT 3)
 SELECT CASE WHEN COUNT(*) BETWEEN 1 AND 2
   AND COUNT(DISTINCT role) = 1
   AND SUM(CASE WHEN (role='owner' AND membership_role IN ('admin','owner'))
                    OR (role='member' AND membership_role='member') THEN 0 ELSE 1 END) = 0
   AND (MIN(role)='owner' OR ?6 IN ('feedback:create','sources:read','deployments:read',
       'mail-domains:read','integrations:read','projects:read','operations:read','logs:read','audit:read','api-keys:manage'))
 THEN 1 ELSE 0 END FROM grants`;
function authorizationBinds(input: AuthorizationInput): unknown[] {
  return [
    input.organizationId,
    input.principalId,
    input.projectId ?? null,
    input.environmentId ?? null,
    input.mailDomainId ?? null,
    input.action,
  ];
}

/** Predicate and bound parameters shared by compound effect guards. */
export function canonicalAuthorizationCondition(input: AuthorizationInput): {
  sql: string;
  params: unknown[];
} {
  return validAuthorizationScope(input)
    ? { sql: `(${AUTHORIZATION_ALLOWED}) = 1`, params: authorizationBinds(input) }
    : { sql: "0", params: [] };
}

/** Current canonical role and resource authority, rechecked in the effect's transaction. */
export function canonicalAuthorizationGuard(db: D1Database, input: AuthorizationInput) {
  const condition = canonicalAuthorizationCondition(input);
  return guard(db, "consent_changed", `NOT (${condition.sql})`, condition.params);
}

/** One primary snapshot; ambiguous roles, stale project grants, frozen owners and unadmitted organizations deny. */
export async function authorizeOrganizationAction(
  context: CatalogContext,
  rawInput: unknown,
): Promise<"allow" | "deny"> {
  const input = authorizeOrganizationActionInput.parse(rawInput);
  if (!validAuthorizationScope(input)) return "deny";
  const core = await context.router.routeShard(0);
  const row = await core.db
    .prepare(`SELECT (${AUTHORIZATION_ALLOWED}) AS allowed`)
    .bind(...authorizationBinds(input))
    .first<{ allowed: number }>();
  return row?.allowed === 1 ? "allow" : "deny";
}
