import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { storedTimestamp } from "../../timestamps.js";
import { type CatalogContext, routeOrganization, ulid } from "../common.js";

const time = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .transform(storedTimestamp);
const inputSchema = z.strictObject({
  organizationId: ulid,
  subscriptionId: z.string().regex(/^sub_[A-Za-z0-9_]{1,252}$/u),
  endedAt: time,
  now: time,
});

/**
 * The statement that cuts a Stripe coverage short at `endedAt`. It only closes the coverage that the subscription
 * produced (an account without a recorded subscription keeps the old rule); every other coverage is left alone.
 */
export function endCoverage(
  db: D1Database,
  organizationId: string,
  endedAt: string,
  now: string,
  subscriptionId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE credit_account SET
         paid_until = CASE WHEN granted_until > ?2 THEN granted_until ELSE ?2 END,
         paid_source = CASE WHEN granted_until > ?2 THEN granted_source ELSE paid_source END,
         granted_until = NULL, granted_source = NULL, granted_captured_at = NULL, updated_at = ?3
       WHERE organization_id = ?1 AND paid_source = 'stripe' AND paid_until > ?2 AND (paid_subscription_id IS NULL OR paid_subscription_id = ?4)`,
    )
    .bind(organizationId, endedAt, now, subscriptionId);
}

/**
 * Closes the Paid coverage a Stripe subscription gave at the moment Stripe ended it. The coverage only ever shortens, an
 * access an operator or a referral granted is not the subscription's to end, and a repeat changes nothing. It applies
 * to a deleted organization too: it is a fact about the subscription, not a permission.
 */
export async function recordStripeSubscriptionEnd(
  context: CatalogContext,
  raw: unknown,
): Promise<{ recorded: true }> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("billing_request_invalid");
  const input = parsed.data,
    { db } = await routeOrganization(context, input.organizationId);
  const [exists] = await db.batch([
    db
      .prepare("SELECT 1 AS present FROM organizations WHERE organization_id = ?1")
      .bind(input.organizationId),
    endCoverage(db, input.organizationId, input.endedAt, input.now, input.subscriptionId),
  ]);
  if (exists?.results.length !== 1) throw new Error("organization_credit_scope_missing");
  return { recorded: true };
}
