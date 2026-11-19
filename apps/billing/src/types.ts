/** The Stripe account, mode and catalog this Billing Worker is bound to. */
export interface BillingConfiguration {
  accountId: string;
  mode: "test" | "live";
  paidPriceId: string;
  topupPriceId: string;
}

/** A checkout as the request names it: derived from its id, never stored. `sessionId` is known after Stripe saw it. */
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

/** What Stripe reports of the refunds and disputes of one payment. */
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

/** A signed Stripe event, as the webhook ingress stored it. */
export interface StripeInboxEvent {
  id: string;
  type: string;
  objectId: string;
  accountId: string;
  mode: "test" | "live";
}

export type RechargeStatus =
  | "off"
  | "setup_required"
  | "on"
  | "payment_required"
  | "monthly_limit"
  | "needs_reconciliation"
  | "tax_required";

export interface RechargePolicy {
  organization_id: string;
  account_id: string;
  mode: "test" | "live";
  enabled: boolean;
  revision: number;
  monthly_limit_minor: number;
  status: RechargeStatus;
  setup_id: string;
  setup_session_id: string | null;
  payment_method_id: string | null;
  updated_at: Date;
  checked_at: Date | null;
}
