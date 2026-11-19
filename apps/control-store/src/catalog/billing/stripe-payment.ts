import { z } from "zod";
import { topupCreditMicros } from "@ohmyhost/platform";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { classifyFailure } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import {
  type CatalogContext,
  addMilliseconds,
  publicTimestamp,
  routeOrganization,
  ulid,
} from "../common.js";
import {
  grantCredit,
  MICROS_PER_CREDIT,
  readAccount,
  reverseGrant,
  type CreditPlan,
  type GrantResult,
} from "../credit/index.js";
import { isDuplicate } from "../credit/spend.js";
import { clawBackReferralReward, rewardReferrer } from "./payment-referral-plan.js";
import { reversedMinor, type ReversalObservation } from "./payment-reversal-plan.js";
import { endCoverage } from "./stripe-subscription.js";

/** A Paid month is 1000 credits, a project with the powered-by flag gets 250 more. */
export const PAID_INVOICE_MICROS = 1_000 * MICROS_PER_CREDIT;
export const FLAG_BONUS_MICROS = 250 * MICROS_PER_CREDIT;
/** An auto-recharge buys 1000 credits for 900 cents. */
export const RECHARGE_MICROS = 1_000 * MICROS_PER_CREDIT;
export const RECHARGE_MINIMUM_MINOR = 900;
/** The Paid coverage of an invoice runs this long past the end of its period, so a late renewal does not cut service. */
export const PAID_GRACE_MS = 14 * 86_400_000;

const wire = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const time = wire.transform(storedTimestamp);
const paymentIntent = z.string().regex(/^pi_[A-Za-z0-9_]{1,253}$/u);
const invoiceId = z.string().regex(/^in_[A-Za-z0-9_]{1,253}$/u);
const minor = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const invoicePayment = z.strictObject({
  kind: z.literal("invoice"),
  invoiceId,
  subscriptionId: z.string().regex(/^sub_[A-Za-z0-9_]{1,252}$/u),
  paymentIntentId: paymentIntent,
  amountSubtotal: z.number(),
  amountTotal: z.number(),
  periodStart: time,
  periodEnd: time,
  paidAt: time,
  /** Stripe's end of the subscription when it has ended: the Paid coverage closes there. */
  endedAt: time.nullable(),
});
const topupPayment = z.strictObject({
  kind: z.literal("topup"),
  paymentIntentId: paymentIntent,
  packs: z.number().int().min(1).max(100),
  amountSubtotal: z.number(),
  amountTotal: z.number(),
});
const rechargePayment = z.strictObject({
  kind: z.literal("recharge"),
  invoiceId,
  paymentIntentId: paymentIntent,
  amountTotal: minor.max(2_147_483_647),
});
export const stripePaymentInput = z.strictObject({
  organizationId: ulid,
  payment: z.discriminatedUnion("kind", [invoicePayment, topupPayment, rechargePayment]),
  now: time,
});

/** Names a payment by what its credit grant is keyed on, and by the Stripe payment that money moved in. */
export const stripePaymentRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("invoice"), invoiceId, paymentIntentId: paymentIntent }),
  z.strictObject({ kind: z.literal("topup"), paymentIntentId: paymentIntent }),
  z.strictObject({ kind: z.literal("recharge"), paymentIntentId: paymentIntent }),
]);
export const stripeReversalInput = z.strictObject({
  organizationId: ulid,
  payment: stripePaymentRef,
  observation: z.strictObject({
    accountId: z.string(),
    mode: z.enum(["test", "live"]),
    customerId: z.string(),
    paymentIntentId: z.string(),
    currency: z.string(),
    paymentTotalMinor: z.number(),
    items: z
      .array(z.strictObject({ id: z.string(), amountMinor: z.number(), status: z.string() }))
      .max(1000),
    disputes: z
      .array(
        z.strictObject({
          id: z.string(),
          amountMinor: z.number(),
          movements: z.array(z.strictObject({ id: z.string(), direction: z.string() })).max(10),
        }),
      )
      .max(100),
  }),
  now: time,
});

export const grantKeyOf = (payment: z.output<typeof stripePaymentRef>): string =>
  payment.kind === "invoice"
    ? `invoice:${payment.invoiceId}`
    : `${payment.kind}:${payment.paymentIntentId}`;

export interface StripePaymentResult {
  /** The credit grant of the payment; the same key for every observation of it. */
  readonly grantKey: string;
  /** False when the payment had been credited before. */
  readonly granted: boolean;
  readonly creditedMicros: string;
  /** The end of the Paid coverage of the organization after the payment. */
  readonly paidUntil: string | null;
}

const FLAG_ON = `SELECT EXISTS (SELECT 1 FROM projects p JOIN project_powered_by_flag_periods f ON f.project_id = p.project_id AND f.organization_id = p.organization_id
     WHERE p.organization_id = ?1 AND p.owner_state = 'active' AND p.lifecycle_state = 'active' AND f.disabled_at IS NULL) AS flagged`;

interface Planned {
  readonly key: string;
  readonly paidMinor: number;
  /** The credit of the payment, then whatever else the payment changes in the same batch. */
  readonly grant: CreditPlan<GrantResult>;
  readonly more: D1PreparedStatement[];
}

/** The money rules of one payment: what is credited, to which bucket, and what Paid coverage it gives. */
function plan(
  db: D1Database,
  input: z.output<typeof stripePaymentInput>,
  flagged: boolean,
): Planned {
  const { payment, organizationId, now } = input;
  if (payment.kind === "invoice") {
    if (
      payment.amountSubtotal !== 1000 ||
      !Number.isSafeInteger(payment.amountTotal) ||
      payment.amountTotal < 1000 ||
      payment.periodStart >= payment.periodEnd ||
      Date.parse(payment.periodEnd) - Date.parse(payment.periodStart) > 32 * 86_400_000 ||
      payment.paidAt > now
    )
      throw new Error("billing_paid_invoice_conflict");
    const covered = addMilliseconds(payment.periodEnd, PAID_GRACE_MS);
    const paidUntil =
      payment.endedAt !== null && payment.endedAt < covered ? payment.endedAt : covered;
    const key = `invoice:${payment.invoiceId}`;
    return {
      key,
      paidMinor: payment.amountTotal,
      grant: grantCredit(db, {
        organizationId,
        key,
        kind: "monthly",
        amountMicros: PAID_INVOICE_MICROS + (flagged ? FLAG_BONUS_MICROS : 0),
        paidMinor: payment.amountTotal,
        monthlyEndsAt: payment.periodEnd,
        periodStart: payment.periodStart,
        coversUntil: paidUntil,
        now,
        detail: {
          invoiceId: payment.invoiceId,
          subscriptionId: payment.subscriptionId,
          paymentIntentId: payment.paymentIntentId,
          periodStart: publicTimestamp(payment.periodStart),
          periodEnd: publicTimestamp(payment.periodEnd),
          flagBonus: flagged,
        },
      }),
      more: [
        // The coverage only ever grows with a payment (a later period, a later invoice) and never outlasts the
        // subscription: a paid invoice processed after the subscription ended must not reopen the coverage.
        db
          .prepare(
            `UPDATE credit_account SET
               granted_until = CASE WHEN paid_source IN ('granted', 'manual') AND paid_until > ?3 THEN paid_until ELSE granted_until END,
               granted_source = CASE WHEN paid_source IN ('granted', 'manual') AND paid_until > ?3 THEN paid_source ELSE granted_source END,
               granted_captured_at = CASE WHEN paid_source IN ('granted', 'manual') AND paid_until > ?3 THEN ?3 ELSE granted_captured_at END,
               paid_until = ?2, paid_source = 'stripe', paid_subscription_id = ?4, updated_at = ?3
             WHERE organization_id = ?1 AND (paid_until IS NULL OR paid_until < ?2)`,
          )
          .bind(organizationId, paidUntil, now, payment.subscriptionId),
        ...(payment.endedAt === null
          ? []
          : [endCoverage(db, organizationId, payment.endedAt, now, payment.subscriptionId)]),
      ],
    };
  }
  if (payment.kind === "topup") {
    const subtotal = 1000 * payment.packs;
    if (
      payment.amountSubtotal !== subtotal ||
      !Number.isSafeInteger(payment.amountTotal) ||
      payment.amountTotal < subtotal
    )
      throw new Error("billing_payment_conflict");
    const key = `topup:${payment.paymentIntentId}`;
    return {
      key,
      paidMinor: payment.amountTotal,
      grant: grantCredit(db, {
        organizationId,
        key,
        kind: "onetime",
        amountMicros: Number(topupCreditMicros(payment.packs)),
        paidMinor: payment.amountTotal,
        now,
        detail: { packs: payment.packs, paymentIntentId: payment.paymentIntentId },
      }),
      more: [],
    };
  }
  if (payment.amountTotal < RECHARGE_MINIMUM_MINOR) throw new Error("billing_payment_conflict");
  const key = `recharge:${payment.paymentIntentId}`;
  return {
    key,
    paidMinor: payment.amountTotal,
    grant: grantCredit(db, {
      organizationId,
      key,
      kind: "onetime",
      amountMicros: RECHARGE_MICROS,
      paidMinor: payment.amountTotal,
      now,
      detail: { invoiceId: payment.invoiceId, paymentIntentId: payment.paymentIntentId },
    }),
    // an unpaid recharge no longer blocks the next one
    more: [
      db
        .prepare(
          "UPDATE stripe_recharge_policies SET status = 'on' WHERE organization_id = ?1 AND enabled = 1 AND status = 'payment_required'",
        )
        .bind(organizationId),
    ],
  };
}

interface GrantRow {
  readonly organization_id: string;
  readonly amount_micros: number;
  readonly paid_minor: number | null;
  readonly reversed_micros: number;
}

/**
 * Hands back the Paid coverage that a fully returned invoice gave: the coverage falls to the latest coverage of the
 * organization's other invoices that are not fully returned, or to now. It only shortens a Stripe coverage, so a
 * granted or manual coverage is never touched, and it changes nothing while a standing invoice has no known coverage
 * end (a coverage that cannot be told is kept, never cut).
 */
function endInvoiceCoverage(
  db: D1Database,
  organizationId: string,
  now: string,
): D1PreparedStatement {
  const standing =
    "g.organization_id = ?1 AND g.key LIKE 'invoice:%' AND g.reversed_micros < g.amount_micros";
  const fallback = `(SELECT COALESCE(MAX(g.covers_until), ?2) FROM credit_grant g WHERE ${standing})`;
  return db
    .prepare(
      `UPDATE credit_account SET
         paid_until = CASE WHEN granted_until > ${fallback} THEN granted_until ELSE ${fallback} END,
         paid_source = CASE WHEN granted_until > ${fallback} THEN granted_source WHEN ${fallback} > ?2 THEN paid_source ELSE NULL END,
         granted_until = NULL, granted_source = NULL, granted_captured_at = NULL, updated_at = ?2
       WHERE organization_id = ?1 AND paid_source = 'stripe' AND paid_until > ${fallback}
         AND NOT EXISTS (SELECT 1 FROM credit_grant g WHERE ${standing} AND g.covers_until IS NULL)`,
    )
    .bind(organizationId, now);
}

const readGrant = (db: D1Database, key: string) =>
  db
    .prepare(
      "SELECT organization_id, amount_micros, paid_minor, reversed_micros FROM credit_grant WHERE key = ?",
    )
    .bind(key)
    .first<GrantRow>();

/**
 * Credits one verified Stripe payment, once. A paid invoice sets the monthly allowance to 1000 credits (1250 for a
 * project with the powered-by flag) until the end of its period and opens the Paid coverage until 14 days after it; a
 * top-up and an auto-recharge add credit that never expires. Every payment is one batch keyed by its Stripe identity
 * (`invoice:<in_>`, `topup:<pi_>`, `recharge:<pi_>`), so observing it again changes nothing. The payer's referrer is
 * rewarded for the first payment, in its own idempotent batch that every observation repeats until it has happened.
 */
export async function grantStripePayment(
  context: CatalogContext,
  raw: unknown,
): Promise<StripePaymentResult> {
  const parsed = stripePaymentInput.safeParse(raw);
  if (!parsed.success) throw new Error("billing_request_invalid");
  const input = parsed.data;
  const { db } = await routeOrganization(context, input.organizationId);
  // A payment that is already credited is a replay, acknowledged even once its organization is deleted. A new payment of a
  // deleted organization is neither credited nor extended; it stays in the inbox for an operator. A suspended one is
  // credited like an active one, since no refund exists.
  if ((await readGrant(db, grantKeyOf(input.payment))) === null) {
    const organization = await db
      .prepare("SELECT state FROM organizations WHERE organization_id = ?")
      .bind(input.organizationId)
      .first<{ state: string }>();
    if (organization !== null && organization.state === "deleted")
      throw new Error("billing_organization_inactive");
  }
  const flagged =
    input.payment.kind === "invoice" &&
    (await db.prepare(FLAG_ON).bind(input.organizationId).first<{ flagged: number }>())?.flagged ===
      1;
  const planned = plan(db, input, flagged);
  let granted = true;
  try {
    const results = await db.batch([...planned.grant.statements, ...planned.more]);
    // nothing inserted and no duplicate: the organization does not exist
    if (!planned.grant.read(results).granted) throw new Error("organization_credit_scope_missing");
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    granted = false;
  }
  const row = await readGrant(db, planned.key);
  if (row === null) throw new Error("organization_credit_scope_missing");
  if (row.organization_id !== input.organizationId || row.paid_minor !== planned.paidMinor)
    throw new Error("billing_payment_conflict");
  await rewardReferrer(db, { payerId: input.organizationId, now: input.now });
  const account = await readAccount(db, input.organizationId, input.now);
  return {
    grantKey: planned.key,
    granted,
    creditedMicros: String(row.amount_micros),
    paidUntil:
      account.paid && account.paidUntil !== null ? publicTimestamp(account.paidUntil) : null,
  };
}

export interface StripeReversalResult {
  /** The part of the credit taken back so far, in micro-credits. */
  readonly revokedMicros: string;
  /** What has been refunded or lost to disputes so far, in minor currency units. */
  readonly refundedMinor: string;
}

/**
 * Takes back the credit of a payment in proportion to what Stripe reports as refunded or disputed. The credit is taken
 * from the monthly allowance for an invoice and from the one-time credit otherwise; what no balance covers is
 * absorbed. Observing the same refunds again takes back nothing more, a refund of a recharge asks the owner to
 * look at the payment before the next automatic recharge, and a fully returned invoice also hands back its Paid
 * coverage. A dispute counts from the moment Stripe withdraws the funds, and a dispute that is won later does not
 * restore what was taken back.
 */
export async function reverseStripePayment(
  context: CatalogContext,
  raw: unknown,
): Promise<StripeReversalResult> {
  const parsed = stripeReversalInput.safeParse(raw);
  if (!parsed.success) throw new Error("billing_request_invalid");
  const input = parsed.data;
  const { db } = await routeOrganization(context, input.organizationId);
  const key = grantKeyOf(input.payment);
  const row = await readGrant(db, key);
  if (row?.organization_id !== input.organizationId || row.paid_minor === null)
    throw new Error("billing_refund_scope_conflict");
  // the observation must come from the Stripe customer of this organization
  const customer = await db
    .prepare(
      "SELECT provider_id FROM stripe_billing_customers WHERE organization_id = ? AND account_id = ? AND mode = ?",
    )
    .bind(input.organizationId, input.observation.accountId, input.observation.mode)
    .first<{ provider_id: string | null }>();
  if (customer?.provider_id !== input.observation.customerId)
    throw new Error("billing_refund_scope_conflict");
  const refunded = reversedMinor(
    {
      accountId: input.observation.accountId,
      mode: input.observation.mode,
      customerId: input.observation.customerId,
      paymentIntentId: input.payment.paymentIntentId,
      totalMinor: row.paid_minor,
    },
    input.observation as ReversalObservation,
  );
  const target = Number((BigInt(row.amount_micros) * BigInt(refunded)) / BigInt(row.paid_minor));
  if (target > row.reversed_micros) {
    const reversal = reverseGrant(db, {
      organizationId: input.organizationId,
      grantKey: key,
      refundedMinor: refunded,
      now: input.now,
      detail: { paymentIntentId: input.payment.paymentIntentId },
    });
    // The referrer of this payer gives its reward back when the payer's first paid payment is refunded or disputed.
    const referrerReward = await clawBackReferralReward(db, {
      payerId: input.organizationId,
      paymentKey: key,
      now: input.now,
    });
    try {
      await db.batch([
        ...reversal.statements,
        ...referrerReward,
        ...(input.payment.kind === "recharge"
          ? [
              db
                .prepare(
                  "UPDATE stripe_recharge_policies SET status = 'payment_required' WHERE organization_id = ?1 AND enabled = 1",
                )
                .bind(input.organizationId),
            ]
          : []),
        ...(input.payment.kind === "invoice" && target === row.amount_micros
          ? [endInvoiceCoverage(db, input.organizationId, input.now)]
          : []),
      ]);
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure.kind === "guard" && failure.code === "precondition_changed")
        throw new Error("billing_refund_scope_conflict");
      throw error;
    }
  }
  const after = await readGrant(db, key);
  return {
    revokedMicros: String(after?.reversed_micros ?? row.reversed_micros),
    refundedMinor: String(refunded),
  };
}
