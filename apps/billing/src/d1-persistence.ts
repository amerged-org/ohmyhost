import { parseUlid, type Clock, type UlidFactory } from "@ohmyhost/platform";
import type {
  BillingConfiguration,
  BillingPaidInvoice,
  BillingPaymentReversalObservation,
  StripeInboxEvent,
} from "./types.js";

/** Closed billing capability only; this binding never accepts SQL or a generic grant instruction. */
export interface BillingRuntimeBinding {
  prepareStripeCustomer(input: unknown): Promise<unknown>;
  confirmStripeCustomer(input: unknown): Promise<unknown>;
  renewStripeCustomerIntent(input: unknown): Promise<unknown>;
  readStripeBillingCustomer(input: unknown): Promise<unknown>;
  readOrganizationPaid(input: unknown): Promise<unknown>;
  recordStripeSubscriptionEnd(input: unknown): Promise<unknown>;
  claimStripeInboxEvent(input: unknown): Promise<unknown>;
  finishStripeInboxEvent(input: unknown): Promise<unknown>;
  recoverExpiredStripeInboxClaims(input: unknown): Promise<unknown>;
  claimStripeBillingClosure(input: unknown): Promise<unknown>;
  finishStripeBillingClosure(input: unknown): Promise<unknown>;
  grantStripePayment(input: unknown): Promise<unknown>;
  reverseStripePayment(input: unknown): Promise<unknown>;
}
export const BILLING_RUNTIME_METHODS = [
  "prepareStripeCustomer",
  "confirmStripeCustomer",
  "renewStripeCustomerIntent",
  "readStripeBillingCustomer",
  "readOrganizationPaid",
  "recordStripeSubscriptionEnd",
  "claimStripeInboxEvent",
  "finishStripeInboxEvent",
  "recoverExpiredStripeInboxClaims",
  "claimStripeBillingClosure",
  "finishStripeBillingClosure",
  "grantStripePayment",
  "reverseStripePayment",
] as const satisfies readonly (keyof BillingRuntimeBinding)[];

/** The codes the Core answers with that the Worker passes on; anything else is `billing_unavailable`. */
export const BILLING_ERRORS = [
  "billing_checkout_conflict",
  "billing_customer_conflict",
  "billing_customer_not_ready",
  "billing_paid_purchase_exists",
  "paid_plan_required",
  "billing_conflict",
  "billing_refund_scope_conflict",
  "billing_refund_invalid",
  "billing_dispute_invalid",
  "billing_refund_exceeds_payment",
  "billing_payment_conflict",
  "billing_payment_not_verified",
  "billing_paid_invoice_conflict",
  "billing_checkout_not_found",
  "billing_organization_inactive",
  "billing_request_invalid",
  "billing_checkout_invalid",
  "billing_actor_invalid",
  "organization_credit_scope_missing",
  "store_busy",
  "store_outcome_unknown",
  "referral_payment_scope_changed",
];
export const invalid = () => new Error("billing_unavailable");
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) throw invalid();
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw invalid();
  return value;
}
export function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
export function instant(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result)
    throw invalid();
  return result;
}
export function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}
/** An amount of micro-credits as the Core sends it: a decimal string. */
export function micros(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw invalid();
  return value;
}
export async function call(
  binding: Record<string, (input: unknown) => Promise<unknown>>,
  method: string,
  input: unknown,
): Promise<unknown> {
  try {
    return await (binding[method] as (input: unknown) => Promise<unknown>)(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = BILLING_ERRORS.find(
      (value) => message === value || message.endsWith(`: ${value}`),
    );
    throw new Error(code ?? "billing_unavailable");
  }
}

/** What the Core did with one verified payment. */
export interface PaymentGrant {
  readonly grantKey: string;
  /** False when the payment had been credited before. */
  readonly granted: boolean;
  readonly creditedMicros: string;
  readonly paidUntil: string | null;
}
export interface PaymentReversal {
  readonly revokedMicros: string;
  readonly refundedMinor: string;
}
export type PaymentRef =
  | { kind: "invoice"; invoiceId: string; paymentIntentId: string }
  | { kind: "topup"; paymentIntentId: string }
  | { kind: "recharge"; paymentIntentId: string };

export interface BillingPersistence {
  prepareStripeCustomer(input: {
    organizationId: string;
    actorId: string;
    configuration: BillingConfiguration;
  }): Promise<{
    organizationId: string;
    requestId: string;
    customerId: string | null;
    createdAt: string;
  }>;
  confirmStripeCustomer(input: {
    organizationId: string;
    requestId: string;
    customerId: string;
  }): Promise<{ organizationId: string; requestId: string; customerId: string }>;
  /** The next deleted organization whose Stripe billing is still open, leased for one attempt; null when none is due. */
  claimStripeBillingClosure(input: {
    configuration: BillingConfiguration;
  }): Promise<{ organizationId: string; customerId: string } | null>;
  finishStripeBillingClosure(input: { organizationId: string }): Promise<void>;
  /**
   * Starts a new attempt for a day-old intent that has no customer and that Stripe's search could not find; the intent
   * answers its current attempt otherwise, and its customer once one is confirmed.
   */
  renewStripeCustomerIntent(input: {
    organizationId: string;
    configuration: BillingConfiguration;
    requestId: string;
  }): Promise<{
    organizationId: string;
    requestId: string;
    customerId: string | null;
    createdAt: string;
  }>;
  readStripeBillingCustomer(input: {
    organizationId: string;
    configuration: BillingConfiguration;
  }): Promise<string | null>;
  /** Until when the organization is Paid, and who says so; null when it is not Paid. */
  readOrganizationPaid(input: { organizationId: string }): Promise<{
    paidUntil: string;
    source: "stripe" | "granted" | "manual";
  } | null>;
  /** Credits one verified payment, once; a repeat is answered, not credited again. */
  grantPayment(input: {
    organizationId: string;
    payment:
      | {
          kind: "invoice";
          invoice: BillingPaidInvoice;
          /** Stripe's end of the subscription when it has ended. */
          endedAt: string | null;
        }
      | { kind: "topup"; paymentIntentId: string; packs: number; subtotal: number; total: number }
      | { kind: "recharge"; invoiceId: string; paymentIntentId: string; total: number };
  }): Promise<PaymentGrant>;
  /** Takes the credit of a payment back in proportion to its refunds and disputes. */
  reversePayment(input: {
    organizationId: string;
    payment: PaymentRef;
    observation: BillingPaymentReversalObservation;
  }): Promise<PaymentReversal>;
  recordStripeSubscriptionEnd(input: {
    organizationId: string;
    subscriptionId: string;
    endedAt: string;
  }): Promise<void>;
  claimStripeInboxEvent(input: {
    accountId: string;
    mode: "test" | "live";
    claimId: string;
  }): Promise<{ inbox_event_id: string; payload: StripeInboxEvent } | null>;
  finishStripeInboxEvent(input: {
    inboxEventId: string;
    claimId: string;
    errorCode: string | null;
  }): Promise<{ finished: boolean; parked: boolean }>;
  recoverExpiredStripeInboxClaims(input: {
    accountId: string;
    mode: "test" | "live";
  }): Promise<number>;
}

function ulidOrInvalid(value: unknown): string {
  try {
    return parseUlid(text(value));
  } catch {
    throw invalid();
  }
}

/**
 * One structured warning per row the Core parks for an operator for the first time: the signal an alert counts. The Core keeps no logs,
 * so the Billing Worker, which does, writes it. It carries the event id only, never the payload.
 */
function logParked(inboxEventId: string): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      service: "billing",
      code: "stripe_inbox_parked",
      inbox_event_id: inboxEventId,
    }),
  );
}

/** Session-capable private Worker RPC; the Billing Worker owns no SQL URI and no database binding. */
export function createD1BillingPersistence(
  binding: BillingRuntimeBinding,
  clock: Clock,
  ids: UlidFactory,
): BillingPersistence {
  const now = () => clock.now().toISOString();
  const rpc = binding as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  return {
    async prepareStripeCustomer(input) {
      const row = record(
        await call(rpc, "prepareStripeCustomer", {
          ...input,
          requestId: ids.next(),
          now: now(),
        }),
      );
      keys(row, ["organizationId", "requestId", "customerId", "createdAt"]);
      return {
        organizationId: parseUlid(text(row["organizationId"])),
        requestId: parseUlid(text(row["requestId"])),
        customerId: nullableText(row["customerId"]),
        createdAt: instant(row["createdAt"]),
      };
    },
    async confirmStripeCustomer(input) {
      const row = record(await call(rpc, "confirmStripeCustomer", { ...input, now: now() }));
      keys(row, ["organizationId", "requestId", "customerId"]);
      return {
        organizationId: parseUlid(text(row["organizationId"])),
        requestId: parseUlid(text(row["requestId"])),
        customerId: text(row["customerId"]),
      };
    },
    async claimStripeBillingClosure(input) {
      const value = await call(rpc, "claimStripeBillingClosure", {
        accountId: input.configuration.accountId,
        mode: input.configuration.mode,
        now: now(),
      });
      if (value === null) return null;
      const row = record(value);
      keys(row, ["organizationId", "customerId"]);
      return {
        organizationId: parseUlid(text(row["organizationId"])),
        customerId: text(row["customerId"]),
      };
    },
    async finishStripeBillingClosure(input) {
      const row = record(
        await call(rpc, "finishStripeBillingClosure", {
          organizationId: input.organizationId,
          now: now(),
        }),
      );
      keys(row, ["organizationId"]);
      if (row["organizationId"] !== input.organizationId) throw invalid();
    },
    async renewStripeCustomerIntent(input) {
      const row = record(
        await call(rpc, "renewStripeCustomerIntent", {
          organizationId: input.organizationId,
          configuration: input.configuration,
          requestId: input.requestId,
          now: now(),
        }),
      );
      keys(row, ["organizationId", "requestId", "customerId", "createdAt"]);
      return {
        organizationId: parseUlid(text(row["organizationId"])),
        requestId: parseUlid(text(row["requestId"])),
        customerId: nullableText(row["customerId"]),
        createdAt: instant(row["createdAt"]),
      };
    },
    async readStripeBillingCustomer(input) {
      return nullableText(
        await call(rpc, "readStripeBillingCustomer", {
          organizationId: input.organizationId,
          configuration: input.configuration,
        }),
      );
    },
    async readOrganizationPaid(input) {
      const value = await call(rpc, "readOrganizationPaid", {
        organizationId: input.organizationId,
        now: now(),
      });
      if (value === null) return null;
      const row = record(value);
      keys(row, ["paidUntil", "source"]);
      const source = row["source"];
      if (source !== "stripe" && source !== "granted" && source !== "manual") throw invalid();
      return { paidUntil: instant(row["paidUntil"]), source };
    },
    async grantPayment(input) {
      const payment = input.payment;
      const wire =
        payment.kind === "invoice"
          ? {
              kind: "invoice",
              invoiceId: payment.invoice.invoiceId,
              subscriptionId: payment.invoice.subscriptionId,
              paymentIntentId: payment.invoice.paymentIntentId,
              amountSubtotal: payment.invoice.amountSubtotal,
              amountTotal: payment.invoice.amountTotal,
              periodStart: payment.invoice.periodStart,
              periodEnd: payment.invoice.periodEnd,
              paidAt: payment.invoice.paidAt,
              endedAt: payment.endedAt,
            }
          : payment.kind === "topup"
            ? {
                kind: "topup",
                paymentIntentId: payment.paymentIntentId,
                packs: payment.packs,
                amountSubtotal: payment.subtotal,
                amountTotal: payment.total,
              }
            : {
                kind: "recharge",
                invoiceId: payment.invoiceId,
                paymentIntentId: payment.paymentIntentId,
                amountTotal: payment.total,
              };
      const row = record(
        await call(rpc, "grantStripePayment", {
          organizationId: input.organizationId,
          payment: wire,
          now: now(),
        }),
      );
      keys(row, ["grantKey", "granted", "creditedMicros", "paidUntil"]);
      if (typeof row["granted"] !== "boolean") throw invalid();
      return {
        grantKey: text(row["grantKey"]),
        granted: row["granted"],
        creditedMicros: micros(row["creditedMicros"]),
        paidUntil: row["paidUntil"] === null ? null : instant(row["paidUntil"]),
      };
    },
    async reversePayment(input) {
      const observation = input.observation;
      const row = record(
        await call(rpc, "reverseStripePayment", {
          organizationId: input.organizationId,
          payment: input.payment,
          observation: {
            accountId: observation.accountId,
            mode: observation.mode,
            customerId: observation.customerId,
            paymentIntentId: observation.paymentIntentId,
            currency: observation.currency,
            paymentTotalMinor: observation.paymentTotalMinor,
            items: observation.items.map((item) => ({
              id: item.id,
              amountMinor: item.amountMinor,
              status: item.status,
            })),
            disputes: observation.disputes.map((dispute) => ({
              id: dispute.id,
              amountMinor: dispute.amountMinor,
              movements: dispute.movements.map((movement) => ({
                id: movement.id,
                direction: movement.direction,
              })),
            })),
          },
          now: now(),
        }),
      );
      keys(row, ["revokedMicros", "refundedMinor"]);
      return {
        revokedMicros: micros(row["revokedMicros"]),
        refundedMinor: micros(row["refundedMinor"]),
      };
    },
    async recordStripeSubscriptionEnd(input) {
      const row = record(
        await call(rpc, "recordStripeSubscriptionEnd", {
          organizationId: input.organizationId,
          subscriptionId: input.subscriptionId,
          endedAt: input.endedAt,
          now: now(),
        }),
      );
      keys(row, ["recorded"]);
      if (row["recorded"] !== true) throw invalid();
    },
    async claimStripeInboxEvent(input) {
      const value = await call(rpc, "claimStripeInboxEvent", {
        accountId: input.accountId,
        mode: input.mode,
        claimId: input.claimId,
        now: now(),
      });
      if (value === null) return null;
      const row = record(value);
      keys(row, ["inbox_event_id", "payload"]);
      return {
        inbox_event_id: parseUlid(text(row["inbox_event_id"])),
        payload: row["payload"] as StripeInboxEvent,
      };
    },
    async finishStripeInboxEvent(input) {
      const row = record(await call(rpc, "finishStripeInboxEvent", { ...input, now: now() }));
      keys(row, ["finished", "parked"]);
      if (typeof row["finished"] !== "boolean" || typeof row["parked"] !== "boolean")
        throw invalid();
      if (row["parked"]) logParked(input.inboxEventId);
      return { finished: row["finished"], parked: row["parked"] };
    },
    async recoverExpiredStripeInboxClaims(input) {
      const row = record(
        await call(rpc, "recoverExpiredStripeInboxClaims", {
          accountId: input.accountId,
          mode: input.mode,
          now: now(),
        }),
      );
      keys(row, ["count", "parkedIds"]);
      const count = integer(row["count"]);
      if (!Array.isArray(row["parkedIds"])) throw invalid();
      const parkedIds = row["parkedIds"].map(ulidOrInvalid);
      for (const id of parkedIds) logParked(id);
      return count;
    },
  };
}
