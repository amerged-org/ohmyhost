import { z } from "zod";
import { instant, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { readRuntimeDecision } from "../credit/index.js";

const inputSchema = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  now: instant,
});

/**
 * The serving read of the gateway: one read batch over the credit account, the project's budget and its scope, then
 * the pure runtime decision of the credit core. It writes nothing: the lazy renewal of a lapsed month is only
 * applied by the next spending write, and the decision already reads the renewed month.
 */
export async function readGatewayRuntimeCreditDecision(context: CatalogContext, raw: unknown) {
  const input = inputSchema.parse(raw);
  const db = (await routeOrganization(context, input.organizationId)).db;
  const decision = await readRuntimeDecision(db, input);
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    allowed: decision.allowed,
    paidAllowed: decision.paidAllowed,
    reason: decision.reason,
    checkedAt: decision.checkedAt,
    expiresAt: decision.expiresAt,
  };
}
