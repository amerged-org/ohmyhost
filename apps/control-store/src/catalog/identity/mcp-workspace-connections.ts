import { z } from "zod";

import { instant, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { consentUseActive } from "./mcp-delegations.js";

const orgScope = z.strictObject({ organizationId: ulid });
/** A delegation grant id, as `ensureMcpConnectionProof` derives it; one consent may hold several grants. */
const connectionId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

/**
 * The live MCP consents of one workspace: one row per user, client and consent. The row's `connection_id` is one
 * of its grants; a workspace disconnect names it. Consents revoked here or account-wide are not listed.
 */
export async function listOrganizationMcpConnections(context: CatalogContext, raw: unknown) {
  const i = orgScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = await db
    .prepare(
      `SELECT MIN(g.grant_id) AS connection_id,g.client_id,g.user_id,MIN(g.created_at) AS connected_at
    FROM mcp_client_grants g
    WHERE g.organization_id=?1 AND g.revoked_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=g.organization_id AND r.user_id=g.user_id AND r.client_id=g.client_id AND r.consent_hash=g.consent_hash)
      AND NOT EXISTS(SELECT 1 FROM mcp_connection_revocations r WHERE r.user_id=g.user_id AND r.client_id=g.client_id AND r.consent_hash=g.consent_hash)
      AND NOT EXISTS(SELECT 1 FROM revocations r WHERE r.kind='user' AND r.resource_id=g.user_id)
    GROUP BY g.user_id,g.client_id,g.consent_hash
    ORDER BY connected_at,connection_id`,
    )
    .bind(i.organizationId)
    .all<Record<string, unknown>>();
  return rows.results;
}

/**
 * Disconnects the consent behind one grant from this workspace only, and only for this workspace: the account
 * keeps its other workspaces. Answers `pending` while a provider use of the consent still drains, like the account
 * disconnect; null when the workspace has no such grant.
 */
export async function revokeOrganizationMcpConnection(context: CatalogContext, raw: unknown) {
  const i = orgScope.extend({ connectionId, now: instant }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const grant = await db
    .prepare(
      "SELECT user_id,client_id,consent_hash FROM mcp_client_grants WHERE organization_id=?1 AND grant_id=?2",
    )
    .bind(i.organizationId, i.connectionId)
    .first<{ user_id: string; client_id: string; consent_hash: string }>();
  if (grant === null) return null;
  const consent = {
    userId: grant.user_id,
    clientId: grant.client_id,
    consentHash: grant.consent_hash,
  };
  try {
    await db
      .prepare(
        "INSERT INTO mcp_client_revocations(organization_id,user_id,client_id,consent_hash,revoked_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",
      )
      .bind(i.organizationId, consent.userId, consent.clientId, consent.consentHash, i.now)
      .run();
  } catch (error) {
    // A recovery that uses this consent refuses the tombstone until it finishes: the caller retries.
    if (error instanceof Error && error.message.includes("mcp_connection_recovery_use_active"))
      return { state: "pending" as const };
    throw error;
  }
  return {
    state:
      (await consentUseActive(db, consent)) === null ? ("revoked" as const) : ("pending" as const),
  };
}
