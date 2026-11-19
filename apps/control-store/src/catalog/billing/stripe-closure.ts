import { z } from "zod";
import { shiftStored, storedTimestamp } from "../../timestamps.js";
import { type CatalogContext, routeOrganization, ulid } from "../common.js";

const wireInstant = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .transform(storedTimestamp);
const claimInput = z.strictObject({
  accountId: z.string().regex(/^acct_[A-Za-z0-9_]{1,128}$/u),
  mode: z.enum(["test", "live"]),
  now: wireInstant,
});
const finishInput = z.strictObject({ organizationId: ulid, now: wireInstant });
/** A closure attempt that does not finish within this time is leased again by the next pass. */
const CLOSURE_LEASE_MS = 5 * 60_000;

function parse<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const value = schema.safeParse(input);
  if (!value.success) throw new Error("billing_request_invalid");
  return value.data;
}

/**
 * The next deleted organization of this account and mode whose Stripe billing is still open, leased for one attempt.
 * The first pass that sees an organization deleted opens its closure; a closed one is never reopened. Null when none
 * is due or a concurrent pass leased it first.
 */
export async function claimStripeBillingClosure(context: CatalogContext, raw: unknown) {
  const input = parse(claimInput, raw);
  await context.router.assertLayout();
  await context.directory
    .prepare(
      `INSERT OR IGNORE INTO stripe_billing_closures(organization_id, account_id, mode, customer_id, requested_at)
       SELECT c.organization_id, c.account_id, c.mode, c.provider_id, ?3
       FROM stripe_billing_customers c JOIN organizations o ON o.organization_id = c.organization_id
       WHERE o.state = 'deleted' AND c.account_id = ?1 AND c.mode = ?2 AND c.provider_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM stripe_billing_closures s WHERE s.organization_id = c.organization_id)`,
    )
    .bind(input.accountId, input.mode, input.now)
    .run();
  const next = await context.directory
    .prepare(
      `SELECT organization_id, customer_id FROM stripe_billing_closures
       WHERE account_id = ?1 AND mode = ?2 AND closed_at IS NULL AND (leased_until IS NULL OR leased_until <= ?3)
       ORDER BY requested_at, organization_id LIMIT 1`,
    )
    .bind(input.accountId, input.mode, input.now)
    .first<{ organization_id: string; customer_id: string }>();
  if (next === null) return null;
  const leased = await context.directory
    .prepare(
      `UPDATE stripe_billing_closures SET leased_until = ?2
       WHERE organization_id = ?1 AND closed_at IS NULL AND (leased_until IS NULL OR leased_until <= ?3)`,
    )
    .bind(next.organization_id, shiftStored(input.now, CLOSURE_LEASE_MS), input.now)
    .run();
  if (leased.meta.changes !== 1) return null;
  return { organizationId: next.organization_id, customerId: next.customer_id };
}

/** Records that Stripe ended the billing of a deleted organization; a repeat changes nothing. */
export async function finishStripeBillingClosure(context: CatalogContext, raw: unknown) {
  const input = parse(finishInput, raw);
  const { db } = await routeOrganization(context, input.organizationId);
  const row = await db
    .prepare("SELECT organization_id FROM stripe_billing_closures WHERE organization_id = ?")
    .bind(input.organizationId)
    .first();
  if (row === null) throw new Error("billing_request_invalid");
  await db
    .prepare(
      "UPDATE stripe_billing_closures SET closed_at = ?2, leased_until = NULL WHERE organization_id = ?1 AND closed_at IS NULL",
    )
    .bind(input.organizationId, input.now)
    .run();
  return { organizationId: input.organizationId };
}
