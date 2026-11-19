import { z } from "zod";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { canonicalAuthorizationCondition } from "../projects/customer-projects-access.js";

const inputSchema = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  principalId: z.string().min(1).max(256),
});

/** Read-only admission. A later mutation must repeat this predicate in its own transaction. */
export async function authorizeNativeAuthOwner(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = inputSchema.parse(raw);
  const { db } = await routeOrganization(context, input.organizationId);
  // Native Auth has its own owner-only environment action and canonical sync-barrier policy.
  const authority = canonicalAuthorizationCondition({ ...input, action: "auth:read" });
  const row = await db
    .prepare(
      `SELECT 1 AS allowed FROM projects p
    JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id
    WHERE (${authority.sql}) AND p.organization_id=?7 AND p.project_id=?8 AND e.environment_id=?9
      AND p.owner_state='active' AND p.lifecycle_state='active'`,
    )
    .bind(...authority.params, input.organizationId, input.projectId, input.environmentId)
    .first();
  return row !== null;
}
