import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { shiftStored, storedTimestamp } from "../../timestamps.js";
import {
  type CatalogContext,
  addMilliseconds,
  newUlid,
  publicTimestamp,
  routeOrganization,
  ulid,
} from "../common.js";
import { MICROS_PER_CREDIT, readAccount, type AccountView } from "../credit/index.js";
import { RECHARGE_MINIMUM_MINOR } from "./stripe-payment.js";

/** An automatic recharge starts when the credit falls below this. */
export const RECHARGE_THRESHOLD_MICROS = 100 * MICROS_PER_CREDIT;
/** One organization is looked at again after this long, whatever the outcome. */
export const RECHARGE_LEASE_MS = 120_000;
/** Stripe's idempotency window: no setup session is created again under a setup id this old. */
const SETUP_IDEMPOTENCY_MS = 86_400_000;

const time = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .transform(storedTimestamp);
const configuration = z.strictObject({
  accountId: z.string().regex(/^acct_[A-Za-z0-9_]{1,128}$/u),
  mode: z.enum(["test", "live"]),
});
const scope = configuration.extend({ organizationId: ulid, now: time });
const configure = scope
  .extend({
    enabled: z.boolean(),
    monthlyLimitMinor: z.number().int().min(1000).max(100000),
    consent: z.string().nullable(),
    revision: z.number().int().nonnegative().safe(),
    actorId: z.string().min(1).max(255),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    id: ulid,
  })
  .refine((value) => (value.enabled ? value.consent === "off_session_v1" : value.consent === null));
// Without a session only an expired transition is meaningful: it gives a waiting policy a fresh setup id.
const setup = scope
  .extend({
    revision: z.number().int(),
    sessionId: z.string().nullable(),
    paymentMethodId: z.string().nullable(),
    expired: z.boolean(),
  })
  .refine((value) => value.sessionId !== null || value.expired);
const transition = scope.extend({
  kind: z.enum(["reconciliation", "payment_required", "tax_required", "on", "monthly_limit"]),
  revision: z.number().int().optional(),
});
const candidates = configuration.extend({ now: time });

export interface RechargePolicyRow {
  organization_id: string;
  account_id: string;
  mode: "test" | "live";
  enabled: number;
  revision: number;
  monthly_limit_minor: number;
  status: string;
  setup_id: string;
  setup_session_id: string | null;
  payment_method_id: string | null;
  updated_at: string;
  checked_at: string | null;
}
const POLICY =
  "SELECT organization_id, account_id, mode, enabled, revision, monthly_limit_minor, status, setup_id, setup_session_id, payment_method_id, updated_at, checked_at FROM stripe_recharge_policies WHERE organization_id = ?1 AND account_id = ?2 AND mode = ?3";

function parsed<Schema extends z.ZodType>(schema: Schema, raw: unknown): z.output<Schema> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error("billing_request_invalid");
  return result.data;
}
function policyDto(row: RechargePolicyRow | null) {
  return row
    ? {
        ...row,
        enabled: row.enabled === 1,
        updated_at: publicTimestamp(row.updated_at),
        checked_at: row.checked_at === null ? null : publicTimestamp(row.checked_at),
      }
    : null;
}
const readPolicy = (
  db: D1Database,
  input: { organizationId: string; accountId: string; mode: string },
) =>
  db
    .prepare(POLICY)
    .bind(input.organizationId, input.accountId, input.mode)
    .first<RechargePolicyRow>();

/** What the organization has spent on automatic recharges this UTC month, in minor units of what was paid. */
async function spentMinor(db: D1Database, organizationId: string, now: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT CAST(total(paid_minor) AS INTEGER) AS spent FROM credit_grant
       WHERE key >= 'recharge:' AND key < 'recharge;' AND organization_id = ?1 AND substr(granted_at, 1, 7) = substr(?2, 1, 7)`,
    )
    .bind(organizationId, now)
    .first<{ spent: number }>();
  return row?.spent ?? 0;
}

async function portalAvailable(
  db: D1Database,
  input: { organizationId: string; accountId: string; mode: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT EXISTS (SELECT 1 FROM stripe_billing_customers WHERE organization_id = ?1 AND account_id = ?2 AND mode = ?3 AND provider_id IS NOT NULL) AS available",
    )
    .bind(input.organizationId, input.accountId, input.mode)
    .first<{ available: number }>();
  return row?.available === 1;
}

/** The recharge view of an organization; the Worker adds the Stripe links and the tax issue it observes. */
async function rechargeView(
  db: D1Database,
  input: { organizationId: string; accountId: string; mode: string; now: string },
  policy: RechargePolicyRow | null,
) {
  return {
    organization_id: input.organizationId,
    portal_available: await portalAvailable(db, input),
    enabled: policy?.enabled === 1,
    revision: policy?.revision ?? 0,
    // a monthly limit reached lasts to the end of its UTC month
    status:
      policy?.enabled === 1 &&
      policy.status === "monthly_limit" &&
      policy.updated_at.slice(0, 7) !== input.now.slice(0, 7)
        ? "on"
        : (policy?.status ?? "off"),
    monthly_limit_minor: policy?.monthly_limit_minor ?? 10000,
    spent_minor: await spentMinor(db, input.organizationId, input.now),
    currency: "usd" as const,
    amount_minor: RECHARGE_MINIMUM_MINOR,
    credits: 1000 as const,
    threshold_credits: 100 as const,
    setup_url: null as string | null,
    invoice_url: null as string | null,
    billing_issue: null,
  };
}

export async function readRechargePolicy(context: CatalogContext, raw: unknown) {
  const input = parsed(scope, raw),
    { db } = await routeOrganization(context, input.organizationId);
  return policyDto(await readPolicy(db, input));
}

export async function readRecharge(context: CatalogContext, raw: unknown) {
  const input = parsed(scope, raw),
    { db } = await routeOrganization(context, input.organizationId);
  return rechargeView(db, input, await readPolicy(db, input));
}

/**
 * Turns automatic recharge on or off and sets its monthly limit. The revision the caller saw is a compare-and-set, so a
 * second tab cannot overwrite the first; the same change sent twice is answered, not refused. Turning it on needs Paid
 * and saves a card first (`setup_required`) unless one is saved already.
 */
export async function configureRecharge(context: CatalogContext, raw: unknown) {
  const input = parsed(configure, raw),
    { db } = await routeOrganization(context, input.organizationId);
  // the change this request asks for may already have been made, by this request or by its twin
  const applied = async () => {
    const policy = await readPolicy(db, input);
    return policy !== null &&
      policy.revision === input.revision + 1 &&
      policy.enabled === (input.enabled ? 1 : 0) &&
      policy.monthly_limit_minor === input.monthlyLimitMinor
      ? policy
      : null;
  };
  const prior = await applied();
  if (prior !== null) return rechargeView(db, input, prior);
  if (input.enabled && !(await readAccount(db, input.organizationId, input.now)).paid)
    throw new Error("paid_plan_required");
  // Only turning it on needs an active organization; switching it off is always allowed, as a suspended organization cannot
  // be signed in to switch it off any other way.
  const written = await db
    .prepare(
      `INSERT INTO stripe_recharge_policies(organization_id, account_id, mode, enabled, revision, monthly_limit_minor, status, setup_id, setup_session_id, payment_method_id, updated_at, checked_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9, NULL WHERE ?4 = 0 OR EXISTS (SELECT 1 FROM organizations WHERE organization_id = ?1 AND state = 'active')
       ON CONFLICT(organization_id) DO UPDATE SET
         enabled = excluded.enabled, revision = excluded.revision, monthly_limit_minor = excluded.monthly_limit_minor,
         status = CASE WHEN excluded.enabled = 1 THEN (CASE WHEN stripe_recharge_policies.payment_method_id IS NOT NULL THEN 'on' ELSE 'setup_required' END) ELSE 'off' END,
         setup_id = CASE WHEN stripe_recharge_policies.payment_method_id IS NOT NULL THEN stripe_recharge_policies.setup_id ELSE excluded.setup_id END,
         setup_session_id = CASE WHEN stripe_recharge_policies.payment_method_id IS NOT NULL THEN stripe_recharge_policies.setup_session_id ELSE NULL END,
         updated_at = excluded.updated_at
       WHERE stripe_recharge_policies.revision = ?10 AND stripe_recharge_policies.account_id = excluded.account_id AND stripe_recharge_policies.mode = excluded.mode`,
    )
    .bind(
      input.organizationId,
      input.accountId,
      input.mode,
      input.enabled ? 1 : 0,
      input.revision + 1,
      input.monthlyLimitMinor,
      input.enabled ? "setup_required" : "off",
      input.id,
      input.now,
      input.revision,
    )
    .run();
  if (written.meta.changes !== 1) {
    const twin = await applied();
    if (twin === null) throw new Error("billing_conflict");
  }
  return rechargeView(db, input, await readPolicy(db, input));
}

/**
 * The saved card of a setup session, or its expiry; only the setup of the policy revision the caller saw counts. An expired
 * session is dropped and the policy keeps waiting for a card, under a fresh setup id: Stripe answers a repeated idempotency
 * key with the expired session. Only the session the policy stores can expire, so a repeat changes nothing.
 */
export async function saveRechargeSetup(context: CatalogContext, raw: unknown) {
  const input = parsed(setup, raw),
    { db } = await routeOrganization(context, input.organizationId);
  const expired = input.expired && input.paymentMethodId === null ? 1 : 0;
  await db
    .prepare(
      `UPDATE stripe_recharge_policies SET
         setup_session_id = CASE WHEN ?3 = 1 THEN NULL ELSE ?1 END,
         payment_method_id = ?2,
         status = CASE WHEN ?2 IS NOT NULL THEN 'on' ELSE 'setup_required' END,
         setup_id = CASE WHEN ?3 = 1 THEN ?4 ELSE setup_id END,
         updated_at = CASE WHEN ?3 = 1 THEN ?5 ELSE updated_at END
       WHERE organization_id = ?6 AND account_id = ?7 AND mode = ?8 AND revision = ?9 AND enabled = 1 AND status = 'setup_required'
         AND (?3 = 0 OR (setup_session_id IS ?1 AND (?1 IS NOT NULL OR updated_at <= ?10)))`,
    )
    .bind(
      input.sessionId,
      input.paymentMethodId,
      expired,
      newUlid(),
      input.now,
      input.organizationId,
      input.accountId,
      input.mode,
      input.revision,
      shiftStored(input.now, -SETUP_IDEMPOTENCY_MS),
    )
    .run();
  return { recorded: true };
}

/** Whether an organization with this policy and credit needs a new recharge invoice now. */
export function rechargeDue(
  policy: Pick<RechargePolicyRow, "enabled" | "status" | "payment_method_id" | "updated_at">,
  account: Pick<AccountView, "paid" | "availableMicros">,
  now: string,
): boolean {
  return (
    policy.enabled === 1 &&
    policy.payment_method_id !== null &&
    account.paid &&
    account.availableMicros < RECHARGE_THRESHOLD_MICROS &&
    (policy.status === "on" ||
      (policy.status === "monthly_limit" && policy.updated_at.slice(0, 7) !== now.slice(0, 7)))
  );
}

/**
 * Leases the organization for this look (nobody else looks at it for two minutes) and says whether a new recharge is due.
 * A monthly limit that no further recharge fits under stops it until the month ends. Null: someone else holds the lease,
 * or recharge is off.
 */
export async function claimRecharge(context: CatalogContext, raw: unknown) {
  const input = parsed(scope, raw),
    { db } = await routeOrganization(context, input.organizationId);
  const leased = await db
    .prepare(
      "UPDATE stripe_recharge_policies SET checked_at = ?1 WHERE organization_id = ?2 AND account_id = ?3 AND mode = ?4 AND enabled = 1 AND (checked_at IS NULL OR checked_at <= ?5) AND EXISTS (SELECT 1 FROM organizations o WHERE o.organization_id = ?2 AND o.state = 'active')",
    )
    .bind(
      input.now,
      input.organizationId,
      input.accountId,
      input.mode,
      addMilliseconds(input.now, -RECHARGE_LEASE_MS),
    )
    .run();
  if (leased.meta.changes !== 1) return null;
  const policy = await readPolicy(db, input);
  if (policy === null) return null;
  const account = await readAccount(db, input.organizationId, input.now);
  const due = rechargeDue(policy, account, input.now);
  const remainingMinor =
    policy.monthly_limit_minor - (await spentMinor(db, input.organizationId, input.now));
  const fits = remainingMinor >= RECHARGE_MINIMUM_MINOR;
  if (due && !fits) {
    await db
      .prepare(
        "UPDATE stripe_recharge_policies SET status = 'monthly_limit', updated_at = ?1 WHERE organization_id = ?2 AND enabled = 1 AND status IN ('on', 'monthly_limit')",
      )
      .bind(input.now, input.organizationId)
      .run();
  }
  return { policy: policyDto(await readPolicy(db, input)), create: due && fits, remainingMinor };
}

/**
 * The status of the policy changes because of what Stripe says about its invoice. A revision pins the change to one
 * setting; `tax_required` and `monthly_limit` never replace a payment that is due, and `on` only undoes a state of
 * Stripe's making. The monthly limit lasts to the end of the month it was set in.
 */
export async function transitionRechargePolicy(context: CatalogContext, raw: unknown) {
  const input = parsed(transition, raw),
    { db } = await routeOrganization(context, input.organizationId);
  const rules = {
    reconciliation: ["needs_reconciliation", "1 = 1"],
    payment_required: ["payment_required", "1 = 1"],
    tax_required: ["tax_required", "status IN ('on', 'monthly_limit', 'tax_required')"],
    monthly_limit: ["monthly_limit", "status IN ('on', 'monthly_limit', 'tax_required')"],
    on: ["on", "status IN ('tax_required', 'payment_required')"],
  } as const;
  const [to, from] = rules[input.kind];
  await db
    .prepare(
      `UPDATE stripe_recharge_policies SET status = ?1, updated_at = CASE WHEN ?1 = 'monthly_limit' THEN ?4 ELSE updated_at END
       WHERE organization_id = ?2 AND enabled = 1 AND (?3 IS NULL OR revision = ?3) AND ${from}`,
    )
    .bind(to, input.organizationId, input.revision ?? null, input.now)
    .run();
  return { recorded: true };
}

/** The organizations a recharge tick looks at: a card to save or an invoice to settle, or credit running low. */
export async function listRechargeCandidates(context: CatalogContext, raw: unknown) {
  const input = parsed(candidates, raw);
  await context.router.assertLayout();
  return (
    await context.directory
      .prepare(
        `SELECT p.organization_id AS organization_id FROM stripe_recharge_policies p
         JOIN organizations o ON o.organization_id = p.organization_id AND o.state = 'active'
         LEFT JOIN credit_account a ON a.organization_id = p.organization_id
         WHERE p.account_id = ?1 AND p.mode = ?2 AND p.enabled = 1 AND (p.checked_at IS NULL OR p.checked_at <= ?3)
           AND (p.status IN ('setup_required', 'payment_required', 'tax_required')
             OR (p.payment_method_id IS NOT NULL AND a.paid_until > ?4 AND a.monthly_ends_at > ?4
               AND a.monthly_micros + a.onetime_micros - a.reserved_micros < ?5))
         ORDER BY p.checked_at ASC NULLS FIRST LIMIT 3`,
      )
      .bind(
        input.accountId,
        input.mode,
        addMilliseconds(input.now, -RECHARGE_LEASE_MS),
        input.now,
        RECHARGE_THRESHOLD_MICROS,
      )
      .all<{ organization_id: string }>()
  ).results;
}
