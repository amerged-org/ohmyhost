import type { D1Database, D1PreparedStatement } from "../../d1-types.js";

export type LocalRole = "owner" | "member";

/** The local two-role projection of one WorkOS membership (`projectRole` of the PostgreSQL adapter). */
export function projectRole(status: string, role: string): LocalRole | null {
  if (status !== "active") return null;
  if (role === "admin" || role === "owner") return "owner";
  return role === "member" ? "member" : null;
}

/** Revokes every active organization grant (`revokeActiveLocalAuthorizationGrants` without a principal). */
export function revokeAllGrantsStatement(
  db: D1Database,
  organizationId: string,
  revokedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE local_authorization_grants SET revoked_at = ?2
       WHERE organization_id = ?1 AND revoked_at IS NULL AND created_at <= ?2`,
    )
    .bind(organizationId, revokedAt);
}

/** Revokes the active grants of a set of users, one statement for the whole set (`userIds` travels as one JSON array). */
export function revokeUserGrantsStatement(
  db: D1Database,
  organizationId: string,
  userIds: readonly string[],
  revokedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE local_authorization_grants SET revoked_at = ?2
       WHERE organization_id = ?1 AND revoked_at IS NULL AND created_at <= ?2 AND principal_kind = 'user'
         AND principal_id IN (SELECT 'user:' || value FROM json_each(?3))`,
    )
    .bind(organizationId, revokedAt, JSON.stringify(userIds));
}

export interface OrganizationGrantEntry {
  readonly grantId: string;
  readonly userId: string;
  readonly role: LocalRole;
}

/**
 * Persists a set of organization-level local grants in one statement, each only while its user is an active
 * member whose role fits the grant and the organization is active: the conditions are part of the statement,
 * so they are evaluated in the same batch as the membership writes that precede it.
 */
export function persistOrganizationGrantsStatement(
  db: D1Database,
  organizationId: string,
  entries: readonly OrganizationGrantEntry[],
  createdAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO local_authorization_grants
         (organization_id, grant_id, project_id, environment_id, principal_kind, principal_id, role, ownership_version, billing_epoch_id, created_at)
       SELECT ?1, e.grant_id, NULL, NULL, 'user', 'user:' || e.user_id, e.role, NULL, NULL, ?2
       FROM (SELECT json_extract(value, '$[0]') AS grant_id, json_extract(value, '$[1]') AS user_id, json_extract(value, '$[2]') AS role FROM json_each(?3)) e
       WHERE EXISTS (
         SELECT 1 FROM organization_memberships m JOIN organizations o ON o.organization_id = m.organization_id
         WHERE m.organization_id = ?1 AND m.workos_user_id = e.user_id AND m.state = 'active' AND o.state = 'active'
           AND ((e.role = 'owner' AND m.role IN ('admin','owner')) OR (e.role = 'member' AND m.role = 'member')))`,
    )
    .bind(
      organizationId,
      createdAt,
      JSON.stringify(entries.map((entry) => [entry.grantId, entry.userId, entry.role])),
    );
}
