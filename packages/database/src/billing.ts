import type { BillingTaxIssue, BillingTaxIssueCode } from "@ohmyhost/contracts/billing";
import type { TransactionClient } from "./transaction.js";

export interface BillingConfiguration {
  accountId: string;
  mode: "test" | "live";
  paidPriceId: string;
  topupPriceId: string;
}
/** Current safe invoice issue projection; financial invoices and payments remain in Stripe. */
export declare function recordStripeBillingTaxIssue(
  c: TransactionClient,
  input: {
    organizationId: string;
    configuration: Pick<BillingConfiguration, "accountId" | "mode">;
    invoiceId: string;
    code: BillingTaxIssueCode | null;
    now: string;
  },
): Promise<void>;
export declare function readStripeBillingTaxIssue(
  c: TransactionClient,
  input: {
    organizationId: string;
    configuration: Pick<BillingConfiguration, "accountId" | "mode">;
  },
): Promise<BillingTaxIssue | null>;
export interface BillingCheckout {
  organizationId: string;
  checkoutId: string;
  accountId: string;
  mode: "test" | "live";
  customerId: string;
  offer: "paid" | "topup";
  packs: number;
  priceId: string;
  expiresAt: string;
  createdAt: string;
  sessionId: string | null;
}
export interface BillingCheckoutObservation
  extends Omit<BillingCheckout, "createdAt" | "sessionId"> {
  id: string;
  currency: string;
  state: string | null;
  paid: boolean;
  amountSubtotal: number;
  amountTotal: number | null;
  paymentIntentId: string | null;
  subscriptionId: string | null;
  invoiceId: string | null;
}

export interface BillingPaidInvoice {
  accountId: string;
  mode: "test" | "live";
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  paymentIntentId: string;
  priceId: string;
  currency: string;
  amountSubtotal: number;
  amountTotal: number;
  periodStart: string;
  periodEnd: string;
  paidAt: string;
}

/**
 * Stripe's reported end of an organization's subscription, recorded once. It closes that
 * subscription's Paid coverage at the end instead of 14 days after the period end.
 */
export declare function recordStripeSubscriptionEnd(
  c: TransactionClient,
  input: {
    organizationId: string;
    configuration: Pick<BillingConfiguration, "accountId" | "mode">;
    subscriptionId: string;
    endedAt: string;
    now: string;
  },
): Promise<void>;

export interface BillingPaymentReversalObservation {
  accountId: string;
  mode: "test" | "live";
  customerId: string;
  paymentIntentId: string;
  currency: string;
  paymentTotalMinor: number;
  items: {
    id: string;
    amountMinor: number;
    status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  }[];
  disputes: {
    id: string;
    amountMinor: number;
    movements: { id: string; direction: "withdrawn" | "reinstated" }[];
  }[];
}

export declare function prepareStripeCustomer(
  c: TransactionClient,
  input: {
    organizationId: string;
    requestId: string;
    actorId: string;
    configuration: BillingConfiguration;
    now: string;
  },
): Promise<{
  organizationId: string;
  requestId: string;
  customerId: string | null;
  createdAt: string;
}>;

export declare function confirmStripeCustomer(
  c: TransactionClient,
  input: {
    organizationId: string;
    requestId: string;
    customerId: string;
    now: string;
  },
): Promise<{
  organizationId: string;
  requestId: string;
  customerId: string;
}>;

export declare function readStripeCheckoutByKey(
  c: TransactionClient,
  input: {
    organizationId: string;
    actorId: string;
    idempotencyKey: string;
  },
): Promise<BillingCheckout | null>;

export declare function prepareStripeCheckout(
  c: TransactionClient,
  input: {
    organizationId: string;
    checkoutId: string;
    actorId: string;
    idempotencyKey: string;
    offer: "paid" | "topup";
    packs: number;
    configuration: BillingConfiguration;
    now: string;
  },
): Promise<BillingCheckout>;

export declare function readStripeCheckout(
  c: TransactionClient,
  input: {
    organizationId: string;
    checkoutId: string;
  },
): Promise<BillingCheckout | null>;

/** Only trusted billing composition may pass a provider-validated observation, never an HTTP body. */
export declare function attachStripeCheckout(
  c: TransactionClient,
  input: {
    observation: BillingCheckoutObservation;
    now: string;
  },
): Promise<{
  sessionId: string;
  organizationId: string;
  checkoutId: string;
  accountId: string;
  mode: "test" | "live";
  customerId: string;
  offer: "paid" | "topup";
  packs: number;
  priceId: string;
  expiresAt: string;
  createdAt: string;
}>;
