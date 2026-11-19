import type { createStripeBillingProvider } from "@ohmyhost/provider-stripe";
import type { Clock, UlidFactory } from "@ohmyhost/platform";
import type { BillingPersistence } from "./d1-persistence.js";
import type { RechargePersistence } from "./d1-recharge-persistence.js";
import { checkoutIdFor, checkoutIdentity } from "./checkout-id.js";
import { createRechargeRuntime } from "./recharge.js";
import type {
  BillingCheckout,
  BillingCheckoutObservation,
  BillingConfiguration,
  BillingPaidInvoice,
  BillingPaymentReversalObservation,
  StripeInboxEvent,
} from "./types.js";

export interface BillingProvider
  extends Pick<
    Awaited<ReturnType<typeof createStripeBillingProvider>>,
    | "rechargeSetup"
    | "createRechargeInvoice"
    | "finalizeRechargeInvoice"
    | "observeRechargeInvoice"
    | "findRechargeInvoices"
    | "findPaidRechargeInvoices"
    | "payRechargeInvoice"
    | "voidRechargeInvoice"
    | "closeCustomer"
  > {
  recoverCustomer(input: {
    organizationId: string;
    requestId: string;
  }): Promise<{ customerId: string } | null>;
  hasPaidPurchase(input: {
    organizationId: string;
    customerId: string;
    checkoutId: string;
  }): Promise<boolean>;
  createPortal(input: {
    organizationId: string;
    customerId: string;
    requestId: string;
  }): Promise<{ url: string; createdAt: string }>;
  resolveWebhookEvent(input: StripeInboxEvent): Promise<
    | {
        organizationId: string;
        checkoutId: string;
        sessionId: string;
        invoiceId?: string;
      }
    | { organizationId: string; rechargeId: string; invoiceId: string }
    | null
  >;
  observePaidInvoice(input: {
    organizationId: string;
    customerId: string;
    subscriptionId: string;
    invoiceId?: string;
  }): Promise<{
    invoice: BillingPaidInvoice | null;
    paymentRequired: boolean;
    invoiceId: string;
    taxIssue: import("@ohmyhost/provider-stripe").BillingTaxIssueCode | null;
    /** Stripe's end of an ended subscription; null while it has not ended. */
    subscriptionEndedAt: string | null;
  }>;
  observePaymentReversals(input: {
    organizationId: string;
    customerId: string;
    paymentIntentId: string;
    amountTotal: number;
  }): Promise<BillingPaymentReversalObservation>;
  createCustomer(input: {
    organizationId: string;
    requestId: string;
  }): Promise<{ customerId: string }>;
  createCheckout(
    input: BillingCheckout,
  ): Promise<BillingCheckoutObservation & { url: string | null }>;
  observeCheckout(
    input: BillingCheckout & { sessionId: string },
  ): Promise<BillingCheckoutObservation & { url: string | null }>;
  recoverCheckout(
    input: BillingCheckout,
  ): Promise<(BillingCheckoutObservation & { url: string | null }) | null>;
}

/** Private billing use cases. The HTTP/RPC boundary must authorize the concrete org Owner. */
export function createBillingRuntime(dependencies: {
  persistence: BillingPersistence;
  rechargePersistence: RechargePersistence;
  provider: BillingProvider;
  configuration: BillingConfiguration;
  clock: Clock;
  ids: UlidFactory;
}) {
  const { persistence, provider, configuration } = dependencies;
  const now = () => dependencies.clock.now().toISOString();
  const taxIssueView = (
    code: NonNullable<Awaited<ReturnType<BillingProvider["observePaidInvoice"]>>["taxIssue"]>,
    invoiceId: string,
  ) => ({
    code,
    invoice_id: invoiceId,
    observed_at: now(),
    required_action:
      code === "billing_tax_location_required"
        ? ("open_billing_portal" as const)
        : ("contact_support" as const),
  });
  async function ensureCustomer(organizationId: string, actorId: string) {
    let intent = await persistence.prepareStripeCustomer({
      organizationId: organizationId,
      actorId: actorId,
      configuration,
    });
    if (intent.customerId !== null) return intent.customerId;
    let created: { customerId: string } | null = null;
    // Never replay a creation after Stripe may have pruned its idempotency key: a day-old intent is only searched for.
    if (Date.parse(now()) - Date.parse(intent.createdAt) >= 86400000) {
      created = await provider.recoverCustomer({
        organizationId: organizationId,
        requestId: intent.requestId,
      });
      if (created === null) {
        // Stripe holds no customer of this intent: its attempt starts again under a new request id.
        intent = await persistence.renewStripeCustomerIntent({
          organizationId: organizationId,
          configuration,
          requestId: dependencies.ids.next(),
        });
        if (intent.customerId !== null) return intent.customerId;
      }
    }
    created ??= await provider.createCustomer({
      organizationId: organizationId,
      requestId: intent.requestId,
    });
    await persistence.confirmStripeCustomer({
      organizationId: organizationId,
      requestId: intent.requestId,
      customerId: created.customerId,
    });
    return created.customerId;
  }
  /** The checkout a checkout id names, for an organization whose Stripe customer exists; null for a foreign id. */
  async function quoteOf(
    organizationId: string,
    checkoutId: string,
  ): Promise<BillingCheckout | null> {
    const identity = checkoutIdentity(checkoutId);
    if (identity === null) return null;
    const customerId = await persistence.readStripeBillingCustomer({
      organizationId,
      configuration,
    });
    if (customerId === null) return null;
    return {
      organizationId,
      checkoutId,
      accountId: configuration.accountId,
      mode: configuration.mode,
      customerId,
      offer: identity.offer,
      packs: identity.packs,
      priceId: identity.offer === "paid" ? configuration.paidPriceId : configuration.topupPriceId,
      expiresAt: identity.expiresAt,
      createdAt: identity.createdAt,
      sessionId: null,
    };
  }
  async function view(
    quote: BillingCheckout,
    fields: {
      state: string | null;
      paid: boolean;
      url: string | null;
      creditedMicros: string;
      revokedMicros: string;
      requiredAction: "none" | "complete_checkout" | "open_billing_portal" | "contact_support";
      billingIssue: ReturnType<typeof taxIssueView> | null;
    },
  ) {
    const paid = await persistence.readOrganizationPaid({ organizationId: quote.organizationId });
    return {
      organizationId: quote.organizationId,
      offer: quote.offer,
      checkoutId: quote.checkoutId,
      state: fields.state,
      paid: fields.paid,
      url: fields.url,
      expiresAt: quote.expiresAt,
      packs: quote.packs,
      creditedMicros: fields.creditedMicros,
      revokedMicros: fields.revokedMicros,
      paidUntil: paid?.paidUntil ?? null,
      requiredAction: fields.requiredAction,
      billingIssue: fields.billingIssue,
    };
  }
  /** Settles what Stripe says about a checkout: the credit of its payment, then its refunds and the subscription's end. */
  async function observe(
    quote: BillingCheckout,
    observation: BillingCheckoutObservation & { url: string | null },
    invoiceId?: string,
  ) {
    let creditedMicros = "0",
      revokedMicros = "0",
      billingIssue = null as ReturnType<typeof taxIssueView> | null;
    let requiredAction: "none" | "complete_checkout" | "open_billing_portal" | "contact_support" =
      observation.state === "open" && observation.url !== null ? "complete_checkout" : "none";
    if (observation.paid) {
      const currentInvoice =
        quote.offer === "paid"
          ? await provider.observePaidInvoice({
              organizationId: quote.organizationId,
              customerId: quote.customerId,
              subscriptionId: observation.subscriptionId ?? "",
              ...(invoiceId ? { invoiceId } : {}),
            })
          : null;
      const invoice = currentInvoice?.invoice ?? null;
      if (currentInvoice?.taxIssue) {
        billingIssue = taxIssueView(currentInvoice.taxIssue, currentInvoice.invoiceId);
        if (currentInvoice.taxIssue !== "billing_tax_location_required")
          requiredAction = "contact_support";
      }
      if (requiredAction !== "contact_support" && currentInvoice?.paymentRequired)
        requiredAction = "open_billing_portal";
      const paymentIntentId = invoice?.paymentIntentId ?? observation.paymentIntentId;
      const amountTotal = invoice?.amountTotal ?? observation.amountTotal;
      if (quote.offer === "topup" || invoice) {
        if (paymentIntentId === null || amountTotal === null)
          throw new Error("billing_payment_not_verified");
        const reversals = await provider.observePaymentReversals({
          organizationId: quote.organizationId,
          customerId: quote.customerId,
          paymentIntentId,
          amountTotal,
        });
        const granted = await persistence.grantPayment({
          organizationId: quote.organizationId,
          payment: invoice
            ? { kind: "invoice", invoice, endedAt: currentInvoice?.subscriptionEndedAt ?? null }
            : {
                kind: "topup",
                paymentIntentId,
                packs: quote.packs,
                subtotal: observation.amountSubtotal,
                total: amountTotal,
              },
        });
        const reversed = await persistence.reversePayment({
          organizationId: quote.organizationId,
          payment: invoice
            ? { kind: "invoice", invoiceId: invoice.invoiceId, paymentIntentId }
            : { kind: "topup", paymentIntentId },
          observation: reversals,
        });
        creditedMicros = granted.creditedMicros;
        revokedMicros = reversed.revokedMicros;
      }
      // After its payments, so an ended subscription's Paid coverage closes at Stripe's end.
      const endedAt = currentInvoice?.subscriptionEndedAt ?? null;
      if (endedAt !== null) {
        // Stripe reports an end only for the subscription that was observed, so it is known here.
        if (observation.subscriptionId === null) throw new Error("billing_subscription_missing");
        await persistence.recordStripeSubscriptionEnd({
          organizationId: quote.organizationId,
          subscriptionId: observation.subscriptionId,
          endedAt,
        });
      }
    }
    return view(quote, {
      state: observation.state,
      paid: observation.paid,
      url: observation.url,
      creditedMicros,
      revokedMicros,
      requiredAction,
      billingIssue,
    });
  }
  const recharge = createRechargeRuntime({
    ...dependencies,
    ensureCustomer,
  });
  return {
    ...recharge,
    async createPortal(input: { organizationId: string }) {
      const customerId = await persistence.readStripeBillingCustomer({
        ...input,
        configuration,
      });
      if (!customerId) throw new Error("billing_customer_not_ready");
      return provider.createPortal({
        ...input,
        customerId,
        requestId: dependencies.ids.next(),
      });
    },
    async syncWebhookBatch() {
      await persistence.recoverExpiredStripeInboxClaims({ ...configuration });
      const summary = { acknowledged: 0, failed: 0 };
      for (let i = 0; i < 10; i++) {
        const claimId = dependencies.ids.next();
        const claim = await persistence.claimStripeInboxEvent({ ...configuration, claimId });
        if (!claim) break;
        let errorCode: string | null = null;
        try {
          const reference = await provider.resolveWebhookEvent(claim.payload);
          if (reference && "rechargeId" in reference) {
            await recharge.reconcileRecharge(reference);
          } else if (reference) {
            const quote = await quoteOf(reference.organizationId, reference.checkoutId);
            if (!quote) throw new Error("billing_checkout_conflict");
            // A webhook can recover the exact Session whose create response was lost.
            const observation = await provider.observeCheckout({
              ...quote,
              sessionId: reference.sessionId,
            });
            await observe(quote, observation, reference.invoiceId);
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          errorCode = [
            "stripe_unavailable",
            "stripe_rejected",
            "stripe_scope_conflict",
            "stripe_response_invalid",
            "billing_checkout_conflict",
          ].includes(code)
            ? code.toUpperCase()
            : "STRIPE_PROCESSING_FAILED";
        }
        const { finished } = await persistence.finishStripeInboxEvent({
          inboxEventId: claim.inbox_event_id,
          claimId,
          errorCode,
        });
        if (errorCode === null && finished) summary.acknowledged++;
        else summary.failed++;
      }
      return summary;
    },
    async createCheckout(input: {
      organizationId: string;
      actorId: string;
      idempotencyKey: string;
      packs: number;
      offer: "topup" | "paid";
    }) {
      if (
        !Number.isSafeInteger(input.packs) ||
        input.packs < 1 ||
        input.packs > 100 ||
        !["topup", "paid"].includes(input.offer) ||
        (input.offer === "paid" && input.packs !== 1) ||
        !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.idempotencyKey)
      )
        throw new Error("billing_checkout_invalid");
      if (
        input.offer === "topup" &&
        !(await persistence.readOrganizationPaid({ organizationId: input.organizationId }))
      )
        throw new Error("paid_plan_required");
      await ensureCustomer(input.organizationId, input.actorId);
      const checkoutId = await checkoutIdFor({ ...input, now: dependencies.clock.now() });
      const quote = await quoteOf(input.organizationId, checkoutId);
      if (!quote) throw new Error("billing_customer_not_ready");
      // The same request again finds the Session it created: nothing is created twice.
      const existing = await provider.recoverCheckout(quote);
      if (existing) return observe(quote, existing);
      if (
        input.offer === "paid" &&
        (await provider.hasPaidPurchase({
          organizationId: input.organizationId,
          customerId: quote.customerId,
          checkoutId,
        }))
      )
        throw new Error("billing_paid_purchase_exists");
      return observe(quote, await provider.createCheckout(quote));
    },
    async syncCheckout(input: { organizationId: string; checkoutId: string }) {
      const quote = await quoteOf(input.organizationId, input.checkoutId);
      if (!quote) throw new Error("billing_checkout_not_found");
      const found = await provider.recoverCheckout(quote);
      if (found) return observe(quote, found);
      // Nothing at Stripe: either not created yet, or expired without a trace once its hour has passed.
      if (now() < quote.expiresAt) throw new Error("billing_checkout_not_found");
      return view(quote, {
        state: "expired",
        paid: false,
        url: null,
        creditedMicros: "0",
        revokedMicros: "0",
        requiredAction: "none",
        billingIssue: null,
      });
    },
  };
}
