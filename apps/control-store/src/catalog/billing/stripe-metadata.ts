import { z } from "zod";
import { classifyFailure } from "../../guards.js";
import { shiftStored, storedTimestamp } from "../../timestamps.js";
import { type CatalogContext, publicTimestamp, routeOrganization, ulid } from "../common.js";
import { readAccount } from "../credit/index.js";

const wireInstant = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const nowInput = wireInstant.transform(storedTimestamp);
const actor = z.string().min(1).max(255);
const account = z.string().regex(/^acct_[A-Za-z0-9_]{1,128}$/u);
const mode = z.enum(["test", "live"]);
const price = z.string().regex(/^price_[A-Za-z0-9_]{1,128}$/u);
const configuration = z
  .strictObject({ accountId: account, mode, paidPriceId: price, topupPriceId: price })
  .refine((value) => value.paidPriceId !== value.topupPriceId);
const customerInput = z.strictObject({ organizationId: ulid, configuration });
const prepareCustomerInput = customerInput.extend({
  requestId: ulid,
  actorId: actor,
  now: nowInput,
});
const confirmCustomerInput = z.strictObject({
  organizationId: ulid,
  requestId: ulid,
  customerId: z.string().regex(/^cus_[A-Za-z0-9_]{1,128}$/u),
  now: nowInput,
});
const renewCustomerInput = customerInput.extend({ requestId: ulid, now: nowInput });
/** Stripe keeps a customer creation's idempotency key for a day; an older attempt is never replayed. */
const IDEMPOTENCY_RETENTION_MS = 86_400_000;
const paidInput = z.strictObject({ organizationId: ulid, now: nowInput });

interface CustomerRow {
  organization_id: string;
  request_id: string;
  account_id: string;
  mode: "test" | "live";
  provider_id: string | null;
  created_at: string;
}
const CUSTOMER =
  "SELECT organization_id, request_id, account_id, mode, provider_id, created_at FROM stripe_billing_customers WHERE organization_id = ?";

function parse<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  code: string,
): z.output<Schema> {
  const value = schema.safeParse(input);
  if (!value.success) throw new Error(code);
  return value.data;
}
function customer(row: CustomerRow) {
  return {
    organizationId: row.organization_id,
    requestId: row.request_id,
    customerId: row.provider_id,
    createdAt: publicTimestamp(row.created_at),
  };
}

/**
 * The organization's Stripe customer intent of one account and mode: created once, for an active organization, before
 * Stripe is asked, so a lost response can be recovered by the request id. A repeat returns the intent that exists.
 */
export async function prepareStripeCustomer(context: CatalogContext, raw: unknown) {
  const input = parse(prepareCustomerInput, raw, "billing_request_invalid"),
    { db } = await routeOrganization(context, input.organizationId);
  await db
    .prepare(
      `INSERT OR IGNORE INTO stripe_billing_customers(organization_id, request_id, account_id, mode, created_by, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE EXISTS (SELECT 1 FROM organizations WHERE organization_id = ?1 AND state = 'active')
         AND NOT EXISTS (SELECT 1 FROM stripe_billing_customers WHERE request_id = ?2 AND organization_id <> ?1)`,
    )
    .bind(
      input.organizationId,
      input.requestId,
      input.configuration.accountId,
      input.configuration.mode,
      input.actorId,
      input.now,
    )
    .run();
  const row = await db.prepare(CUSTOMER).bind(input.organizationId).first<CustomerRow>();
  if (
    row === null ||
    row.account_id !== input.configuration.accountId ||
    row.mode !== input.configuration.mode
  )
    throw new Error("billing_customer_conflict");
  return customer(row);
}

/** Records the Stripe customer id that the intent resolved to; the first id wins and a repeat confirms it. */
export async function confirmStripeCustomer(context: CatalogContext, raw: unknown) {
  const input = parse(confirmCustomerInput, raw, "billing_customer_conflict"),
    { db } = await routeOrganization(context, input.organizationId);
  const result = {
    organizationId: input.organizationId,
    requestId: input.requestId,
    customerId: input.customerId,
  };
  const row = await db.prepare(CUSTOMER).bind(input.organizationId).first<CustomerRow>();
  if (row === null || row.request_id !== input.requestId)
    throw new Error("billing_customer_conflict");
  if (row.provider_id === input.customerId) return result;
  if (row.provider_id !== null) throw new Error("billing_customer_conflict");
  try {
    await db
      .prepare(
        "UPDATE stripe_billing_customers SET provider_id = ?3, provider_confirmed_at = ?4 WHERE organization_id = ?1 AND request_id = ?2 AND provider_id IS NULL",
      )
      .bind(input.organizationId, input.requestId, input.customerId, input.now)
      .run();
  } catch (error) {
    // another organization already holds this customer of the same account and mode
    if (classifyFailure(error).kind === "unique") throw new Error("billing_customer_conflict");
    throw error;
  }
  const after = await db.prepare(CUSTOMER).bind(input.organizationId).first<CustomerRow>();
  if (after?.provider_id !== input.customerId) throw new Error("billing_customer_conflict");
  return result;
}

/**
 * Starts a new attempt for an intent that never reached Stripe. The caller searched Stripe first and found no customer
 * of the intent; once the intent is a day old, its request id and creation instant move to the given ones, so the
 * creation gets a fresh idempotency key. A younger intent, a confirmed one and any other account or mode are answered
 * unchanged. Only an active organization can renew.
 */
export async function renewStripeCustomerIntent(context: CatalogContext, raw: unknown) {
  const input = parse(renewCustomerInput, raw, "billing_request_invalid"),
    { db } = await routeOrganization(context, input.organizationId);
  const active = await db
    .prepare("SELECT 1 FROM organizations WHERE organization_id = ? AND state = 'active'")
    .bind(input.organizationId)
    .first();
  if (active === null) throw new Error("billing_customer_conflict");
  await db
    .prepare(
      `UPDATE stripe_billing_customers SET request_id = ?2, created_at = ?3
       WHERE organization_id = ?1 AND account_id = ?4 AND mode = ?5 AND provider_id IS NULL AND created_at <= ?6`,
    )
    .bind(
      input.organizationId,
      input.requestId,
      input.now,
      input.configuration.accountId,
      input.configuration.mode,
      shiftStored(input.now, -IDEMPOTENCY_RETENTION_MS),
    )
    .run();
  const row = await db.prepare(CUSTOMER).bind(input.organizationId).first<CustomerRow>();
  if (
    row === null ||
    row.account_id !== input.configuration.accountId ||
    row.mode !== input.configuration.mode
  )
    throw new Error("billing_customer_conflict");
  return customer(row);
}

export async function readStripeBillingCustomer(
  context: CatalogContext,
  raw: unknown,
): Promise<string | null> {
  const input = parse(customerInput, raw, "billing_request_invalid"),
    { db } = await routeOrganization(context, input.organizationId);
  const row = await db
    .prepare(
      "SELECT provider_id FROM stripe_billing_customers WHERE organization_id = ? AND account_id = ? AND mode = ?",
    )
    .bind(input.organizationId, input.configuration.accountId, input.configuration.mode)
    .first<{ provider_id: string | null }>();
  return row?.provider_id ?? null;
}

/**
 * Until when the organization is Paid, and who says so (`stripe`, `granted` or `manual`); null when it is not Paid. A
 * top-up or an automatic recharge needs this, and a checkout shows it.
 */
export async function readOrganizationPaid(context: CatalogContext, raw: unknown) {
  const input = parse(paidInput, raw, "billing_request_invalid"),
    { db } = await routeOrganization(context, input.organizationId);
  const view = await readAccount(db, input.organizationId, input.now);
  return view.paid && view.paidUntil !== null && view.paidSource !== null
    ? { paidUntil: publicTimestamp(view.paidUntil), source: view.paidSource }
    : null;
}
