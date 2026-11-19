import { BARRIER_FREE_MEMBERSHIP_SQL } from "./membership-barrier-sql.js";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";

export interface McpConsentIdentity {
  readonly organizationId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly consentHash: string;
}

/** Current connection evidence and ownership pins, shared by reads and in-batch guards.
 * Canonical action authorization and the accepted credential restriction are checked separately.
 * SharedCoreRouter routes every organization and the directory to the same authority database.
 */
export const ACTIVE_GRANT_CONDITIONS = `
  g.organization_id = ?1 AND g.user_id = ?2 AND g.client_id = ?3 AND g.consent_hash = ?4
  AND g.project_id IS ?5 AND g.revoked_at IS NULL AND (?6 = 0 OR ?6 = 1)
  AND EXISTS (SELECT 1 FROM organization_memberships m JOIN organizations o ON o.organization_id=m.organization_id
    WHERE m.organization_id=g.organization_id AND m.workos_user_id=g.user_id AND m.state='active'
      AND o.state='active' AND o.beta_admitted_at IS NOT NULL AND ${BARRIER_FREE_MEMBERSHIP_SQL})
  AND NOT EXISTS (SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id = g.organization_id
    AND r.user_id = g.user_id AND r.client_id = g.client_id AND r.consent_hash = g.consent_hash)
  AND NOT EXISTS (SELECT 1 FROM mcp_connection_revocations r
    WHERE r.user_id = g.user_id AND r.client_id = g.client_id AND r.consent_hash = g.consent_hash)
  AND NOT EXISTS (SELECT 1 FROM revocations r WHERE r.kind='user' AND r.resource_id=g.user_id)
  AND (g.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.organization_id = g.organization_id
    AND p.project_id = g.project_id AND p.owner_state = 'active' AND p.ownership_version = g.ownership_version
    AND p.active_billing_epoch_id = g.billing_epoch_id AND p.lifecycle_state = 'active'))`;

function parameters(identity: McpConsentIdentity, projectId: string | null, publish: boolean) {
  return [
    identity.organizationId,
    identity.userId,
    identity.clientId,
    identity.consentHash,
    projectId,
    publish ? 1 : 0,
  ];
}

export interface ActiveGrantRow {
  readonly grant_id: string;
  readonly project_id: string | null;
  readonly allow_publish: number;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

export function activeGrantSelect(
  db: D1Database,
  identity: McpConsentIdentity,
  projectId: string | null,
  publish: boolean,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT g.grant_id, g.project_id, g.allow_publish, g.created_at, g.revoked_at FROM mcp_client_grants g WHERE ${ACTIVE_GRANT_CONDITIONS}`,
    )
    .bind(...parameters(identity, projectId, publish));
}

/** Aborts the batch with `consent_changed` unless this exact grant is still effective. */
export function activeGrantGuard(
  db: D1Database,
  identity: McpConsentIdentity,
  projectId: string | null,
  publish: boolean,
  grantId: string,
): D1PreparedStatement {
  return guard(
    db,
    "consent_changed",
    `NOT EXISTS (SELECT 1 FROM mcp_client_grants g WHERE ${ACTIVE_GRANT_CONDITIONS} AND g.grant_id = ?7)`,
    [...parameters(identity, projectId, publish), grantId],
  );
}

/** Is the WorkOS user terminally revoked? Read from the global directory. */
export async function isUserRevoked(directory: D1Database, userId: string): Promise<boolean> {
  const row = await directory
    .prepare("SELECT 1 AS revoked FROM revocations WHERE kind = 'user' AND resource_id = ?")
    .bind(userId)
    .first();
  return row !== null;
}
