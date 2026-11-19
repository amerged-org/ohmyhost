import Stripe from "stripe";
import { createRechargeProvider, invoiceTaxIssue } from "./recharge.js";
export type { RechargeInvoice, RechargeScope, BillingTaxIssueCode } from "./recharge.js";
import { parseUlid } from "@ohmyhost/platform";
import type { StripeWebhookEvent } from "./webhooks.js";
export { verifyStripeWebhook } from "./webhooks.js";

export interface StripeBillingConfiguration {
  accountId: string;
  mode: "test" | "live";
  paidPriceId: string;
  topupPriceId: string;
  returnOrigin: string;
  portalConfigurationId?: string;
}
export interface StripeCheckoutScope {
  organizationId: string;
  checkoutId: string;
  customerId: string;
  offer: "paid" | "topup";
  packs: number;
  expiresAt: string;
}
const checkoutBranding = {
  display_name: "ohmyho.st",
  background_color: "#000000",
  button_color: "#F0F1F2",
  border_style: "rounded",
  font_family: "inter",
  logo: { type: "url", url: "https://ohmyho.st/brand/assets/omega-light.png" },
  icon: { type: "url", url: "https://ohmyho.st/brand/assets/omega-light.png" },
} satisfies Stripe.Checkout.SessionCreateParams.BrandingSettings;
const requestOptions = { timeout: 10_000, maxNetworkRetries: 1 } as const;
const refundStatuses = ["pending", "requires_action", "succeeded", "failed", "canceled"] as const;
const subscriptionStatuses = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
];
const endedSubscriptionStatuses = ["canceled", "incomplete_expired"];
/** The subscription cancellations and card detaches that one pass of a deleted organization's closure makes at most. */
const CLOSURE_CHANGES_PER_PASS = 20;
export function createStripeBillingProviderFromKey(
  secret: string,
  configuration: StripeBillingConfiguration,
) {
  if (!secret.startsWith(configuration.mode === "test" ? "sk_test_" : "sk_live_"))
    throw new Error("stripe_scope_conflict");
  return createStripeBillingProvider(
    new Stripe(secret, {
      httpClient: Stripe.createFetchHttpClient(),
      timeout: 10000,
      maxNetworkRetries: 1,
    }),
    configuration,
  );
}

export class StripeBillingError extends Error {
  constructor(
    readonly code:
      | "stripe_scope_conflict"
      | "stripe_response_invalid"
      | "stripe_unavailable"
      | "stripe_rejected"
      | "stripe_webhook_invalid",
    readonly retryable = false,
    readonly provider?: Readonly<{ status?: number; code?: string; requestId?: string }>,
  ) {
    super(code);
    this.name = "StripeBillingError";
  }
}

/** Trusted billing composition supplies the SDK, never an SDK/URL selected by a public caller. */
export async function createStripeBillingProvider(
  stripe: Stripe,
  configuration: StripeBillingConfiguration,
) {
  if (
    !["test", "live"].includes(configuration.mode) ||
    !/^acct_[A-Za-z0-9_]{1,128}$/u.test(configuration.accountId) ||
    ![configuration.paidPriceId, configuration.topupPriceId].every((id) =>
      /^price_[A-Za-z0-9_]{1,128}$/u.test(id),
    ) ||
    configuration.paidPriceId === configuration.topupPriceId ||
    configuration.returnOrigin !==
      (configuration.mode === "test"
        ? "https://dev.app.ohmyho.st"
        : configuration.mode === "live"
          ? "https://app.ohmyho.st"
          : "")
  )
    throw new StripeBillingError("stripe_scope_conflict");
  const account = await providerCall(() => stripe.accounts.retrieve(null, {}, requestOptions));
  if (account.id !== configuration.accountId) throw new StripeBillingError("stripe_scope_conflict");
  for (const offer of ["paid", "topup"] as const) {
    const id = offer === "paid" ? configuration.paidPriceId : configuration.topupPriceId;
    const price = await providerCall(() => stripe.prices.retrieve(id, {}, requestOptions));
    if (
      price.id !== id ||
      !price.active ||
      price.livemode !== (configuration.mode === "live") ||
      price.currency !== "usd" ||
      price.unit_amount !== 1000 ||
      price.tax_behavior !== "exclusive" ||
      (offer === "paid"
        ? price.recurring?.interval !== "month" || price.recurring.interval_count !== 1
        : price.recurring !== null)
    )
      throw new StripeBillingError("stripe_scope_conflict");
  }

  async function requireCustomer(organizationId: string, customerId: string) {
    parseUlid(organizationId);
    if (!/^cus_[A-Za-z0-9_]{1,128}$/u.test(customerId))
      throw new StripeBillingError("stripe_scope_conflict");
    const customer = await providerCall(() =>
      stripe.customers.retrieve(customerId, { expand: ["tax"] }, requestOptions),
    );
    if (
      customer.deleted ||
      customer.id !== customerId ||
      customer.livemode !== (configuration.mode === "live") ||
      customer.metadata["ohmyhost_organization_id"] !== organizationId
    )
      throw new StripeBillingError("stripe_scope_conflict");
    return customer;
  }

  async function observeCheckout(input: StripeCheckoutScope & { sessionId: string }) {
    validateScope(input);
    await requireCustomer(input.organizationId, input.customerId);
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]{1,256}$/u.test(input.sessionId))
      throw new StripeBillingError("stripe_scope_conflict");
    const session = await providerCall(() =>
      stripe.checkout.sessions.retrieve(
        input.sessionId,
        { expand: ["line_items"] },
        requestOptions,
      ),
    );
    if (session.id !== input.sessionId) throw new StripeBillingError("stripe_response_invalid");
    return checkoutResult(session, input, configuration);
  }

  /** Whether another subscription Checkout of the customer is still open: it could still become a second paid plan. */
  async function hasOpenSubscriptionCheckout(input: {
    customerId: string;
    checkoutId: string;
  }): Promise<boolean> {
    const sessions = await providerCall(() =>
      stripe.checkout.sessions.list(
        {
          customer: input.customerId,
          created: { gte: Math.floor(Date.now() / 1000) - 86400 },
          limit: 100,
        },
        requestOptions,
      ),
    );
    if (!Array.isArray(sessions.data) || sessions.data.length > 100 || sessions.has_more !== false)
      throw new StripeBillingError("stripe_response_invalid");
    return sessions.data.some(
      (session) =>
        session.customer === input.customerId &&
        session.mode === "subscription" &&
        session.status === "open" &&
        session.client_reference_id !== input.checkoutId,
    );
  }

  return {
    ...createRechargeProvider(stripe, configuration, requireCustomer, checkoutBranding),
    async recoverCustomer(input: { organizationId: string; requestId: string }) {
      parseUlid(input.organizationId);
      parseUlid(input.requestId);
      // Search is eventually consistent: absence inside the idempotency window never permits another creation. A day-old
      // intent that is still absent starts a new attempt under a new request id (the Billing Worker renews the intent).
      const page = await providerCall(() =>
        stripe.customers.search(
          {
            query: `metadata['ohmyhost_organization_id']:'${input.organizationId}' AND metadata['ohmyhost_customer_request_id']:'${input.requestId}'`,
            limit: 2,
          },
          requestOptions,
        ),
      );
      if (
        page.object !== "search_result" ||
        !Array.isArray(page.data) ||
        page.has_more !== false ||
        page.data.length > 1
      )
        throw new StripeBillingError("stripe_response_invalid");
      const found = page.data[0];
      if (!found) return null;
      const current = await requireCustomer(input.organizationId, found.id);
      if (current.metadata["ohmyhost_customer_request_id"] !== input.requestId)
        throw new StripeBillingError("stripe_scope_conflict");
      return { customerId: current.id };
    },
    /**
     * Whether the customer already has a paid plan on its way or running: a subscription that has not ended, or a
     * subscription Checkout of another checkout that is still open and could become one. The paid purchase of a
     * checkout does not count against itself.
     */
    async hasPaidPurchase(input: {
      organizationId: string;
      customerId: string;
      checkoutId: string;
    }) {
      parseUlid(input.checkoutId);
      await requireCustomer(input.organizationId, input.customerId);
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const page = await providerCall(() =>
          stripe.subscriptions.list(
            {
              customer: input.customerId,
              status: "all",
              limit: 100,
              ...(cursor ? { starting_after: cursor } : {}),
            },
            requestOptions,
          ),
        );
        if (
          !Array.isArray(page.data) ||
          page.data.length > 100 ||
          typeof page.has_more !== "boolean"
        )
          throw new StripeBillingError("stripe_response_invalid");
        for (const subscription of page.data) {
          if (
            !/^sub_[A-Za-z0-9_]{1,252}$/u.test(subscription.id) ||
            seen.has(subscription.id) ||
            subscription.customer !== input.customerId ||
            subscription.livemode !== (configuration.mode === "live") ||
            !subscriptionStatuses.includes(subscription.status)
          )
            throw new StripeBillingError("stripe_response_invalid");
          seen.add(subscription.id);
          if (!endedSubscriptionStatuses.includes(subscription.status)) return true;
        }
        if (!page.has_more) return hasOpenSubscriptionCheckout(input);
        cursor = page.data.at(-1)?.id;
        if (!cursor) throw new StripeBillingError("stripe_response_invalid");
      }
      throw new StripeBillingError("stripe_response_invalid");
    },
    async createCustomer(input: { organizationId: string; requestId: string }) {
      parseUlid(input.organizationId);
      parseUlid(input.requestId);
      const customer = await providerCall(() =>
        stripe.customers.create(
          {
            metadata: {
              ohmyhost_organization_id: input.organizationId,
              ohmyhost_customer_request_id: input.requestId,
            },
          },
          {
            ...requestOptions,
            idempotencyKey: `ohmyhost/customer/${input.organizationId}/${input.requestId}`,
          },
        ),
      );
      if (
        !/^cus_[A-Za-z0-9_]{1,128}$/u.test(customer.id) ||
        customer.livemode !== (configuration.mode === "live") ||
        customer.metadata["ohmyhost_organization_id"] !== input.organizationId ||
        customer.metadata["ohmyhost_customer_request_id"] !== input.requestId
      )
        throw new StripeBillingError("stripe_response_invalid");
      return { customerId: customer.id };
    },
    /**
     * Ends the Stripe billing of a deleted organization: each subscription of the customer that has not ended is
     * cancelled and each card is detached, at most twenty such changes per call. `closed` is true once nothing is left;
     * a later call makes the rest, and an ended subscription is never cancelled again. Both listings are read whole (100
     * is one page), and a longer one is refused before any change rather than closed in part.
     */
    async closeCustomer(input: {
      organizationId: string;
      customerId: string;
    }): Promise<{ closed: boolean }> {
      await requireCustomer(input.organizationId, input.customerId);
      const subscriptions = await providerCall(() =>
        stripe.subscriptions.list(
          { customer: input.customerId, status: "all", limit: 100 },
          requestOptions,
        ),
      );
      if (
        !Array.isArray(subscriptions.data) ||
        subscriptions.data.length > 100 ||
        subscriptions.has_more !== false
      )
        throw new StripeBillingError("stripe_response_invalid");
      const changes: (() => Promise<unknown>)[] = [];
      for (const subscription of subscriptions.data) {
        if (
          !/^sub_[A-Za-z0-9_]{1,252}$/u.test(subscription.id) ||
          subscription.customer !== input.customerId ||
          subscription.livemode !== (configuration.mode === "live")
        )
          throw new StripeBillingError("stripe_response_invalid");
        if (endedSubscriptionStatuses.includes(subscription.status)) continue;
        changes.push(() =>
          providerCall(() => stripe.subscriptions.cancel(subscription.id, {}, requestOptions)),
        );
      }
      const cards = await providerCall(() =>
        stripe.paymentMethods.list(
          { customer: input.customerId, type: "card", limit: 100 },
          requestOptions,
        ),
      );
      if (!Array.isArray(cards.data) || cards.data.length > 100 || cards.has_more !== false)
        throw new StripeBillingError("stripe_response_invalid");
      for (const card of cards.data) {
        if (!/^pm_[A-Za-z0-9_]{1,252}$/u.test(card.id) || card.customer !== input.customerId)
          throw new StripeBillingError("stripe_response_invalid");
        changes.push(() =>
          providerCall(() => stripe.paymentMethods.detach(card.id, {}, requestOptions)),
        );
      }
      // cancellations come first in the list, so a card is detached only after every subscription has ended
      for (const change of changes.slice(0, CLOSURE_CHANGES_PER_PASS)) await change();
      return { closed: changes.length <= CLOSURE_CHANGES_PER_PASS };
    },
    async createCheckout(input: StripeCheckoutScope) {
      validateScope(input);
      await requireCustomer(input.organizationId, input.customerId);
      const session = await providerCall(() =>
        stripe.checkout.sessions.create(
          {
            mode: input.offer === "paid" ? "subscription" : "payment",
            customer: input.customerId,
            client_reference_id: input.checkoutId,
            metadata: {
              ohmyhost_organization_id: input.organizationId,
              ohmyhost_checkout_id: input.checkoutId,
              ohmyhost_offer: input.offer,
            },
            line_items: [
              {
                price:
                  input.offer === "paid" ? configuration.paidPriceId : configuration.topupPriceId,
                quantity: input.packs,
              },
            ],
            payment_method_types: ["card"],
            allow_promotion_codes: false,
            adaptive_pricing: { enabled: false },
            managed_payments: { enabled: false },
            automatic_tax: { enabled: true },
            tax_id_collection: { enabled: true, required: "never" },
            branding_settings: checkoutBranding,
            customer_update: { address: "auto", name: "auto" },
            billing_address_collection: "required",
            ...(input.offer === "topup" ? { invoice_creation: { enabled: true } } : {}),
            expires_at: Date.parse(input.expiresAt) / 1000,
            success_url: configuration.returnOrigin + "/billing",
            cancel_url: configuration.returnOrigin + "/billing",
            expand: ["line_items"],
          },
          {
            ...requestOptions,
            idempotencyKey: `ohmyhost/checkout/${input.organizationId}/${input.checkoutId}`,
          },
        ),
      );
      return checkoutResult(session, input, configuration);
    },
    observeCheckout,
    async recoverCheckout(input: StripeCheckoutScope & { createdAt: string }) {
      validateScope(input);
      const created = Date.parse(input.createdAt),
        expires = Date.parse(input.expiresAt);
      if (!Number.isFinite(created) || created >= expires || expires - created > 86400000)
        throw new StripeBillingError("stripe_scope_conflict");
      await requireCustomer(input.organizationId, input.customerId);
      let cursor: string | undefined, match: string | undefined;
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const page = await providerCall(() =>
          stripe.checkout.sessions.list(
            {
              customer: input.customerId,
              created: { gte: Math.floor(created / 1000), lte: Math.floor(expires / 1000) },
              limit: 100,
              ...(cursor ? { starting_after: cursor } : {}),
            },
            requestOptions,
          ),
        );
        if (
          !Array.isArray(page.data) ||
          page.data.length > 100 ||
          typeof page.has_more !== "boolean"
        )
          throw new StripeBillingError("stripe_response_invalid");
        for (const session of page.data) {
          if (
            !/^cs_(?:test_|live_)?[A-Za-z0-9_]{1,256}$/u.test(session.id) ||
            session.customer !== input.customerId ||
            session.livemode !== (configuration.mode === "live") ||
            seen.has(session.id)
          )
            throw new StripeBillingError("stripe_scope_conflict");
          seen.add(session.id);
          if (
            session.client_reference_id === input.checkoutId ||
            session.metadata?.["ohmyhost_checkout_id"] === input.checkoutId
          ) {
            if (match) throw new StripeBillingError("stripe_response_invalid");
            match = session.id;
          }
        }
        if (!page.has_more) return match ? observeCheckout({ ...input, sessionId: match }) : null;
        cursor = page.data.at(-1)?.id;
        if (!cursor) throw new StripeBillingError("stripe_response_invalid");
      }
      throw new StripeBillingError("stripe_response_invalid");
    },
    async createPortal(input: { organizationId: string; customerId: string; requestId: string }) {
      parseUlid(input.requestId);
      await requireCustomer(input.organizationId, input.customerId);
      const id = configuration.portalConfigurationId;
      if (!id || !/^bpc_[A-Za-z0-9_]{1,128}$/u.test(id))
        throw new StripeBillingError("stripe_scope_conflict");
      const config = await providerCall(() =>
        stripe.billingPortal.configurations.retrieve(id, {}, requestOptions),
      );
      if (
        config.id !== id ||
        !config.active ||
        config.livemode !== (configuration.mode === "live") ||
        config.default_return_url !== configuration.returnOrigin + "/billing" ||
        !config.features.customer_update.enabled ||
        !["address", "name", "tax_id"].every((field) =>
          config.features.customer_update.allowed_updates.includes(
            field as "address" | "name" | "tax_id",
          ),
        ) ||
        !config.features.invoice_history.enabled ||
        !config.features.payment_method_update.enabled ||
        !config.features.subscription_cancel.enabled ||
        config.features.subscription_cancel.mode !== "at_period_end" ||
        config.features.subscription_update.enabled
      )
        throw new StripeBillingError("stripe_scope_conflict");
      const session = await providerCall(() =>
        stripe.billingPortal.sessions.create(
          {
            customer: input.customerId,
            configuration: id,
            return_url: configuration.returnOrigin + "/billing",
          },
          {
            ...requestOptions,
            idempotencyKey: `ohmyhost/portal/${input.organizationId}/${input.requestId}`,
          },
        ),
      );
      const url = new URL(session.url);
      if (
        session.customer !== input.customerId ||
        session.configuration !== id ||
        session.livemode !== (configuration.mode === "live") ||
        session.return_url !== configuration.returnOrigin + "/billing" ||
        url.protocol !== "https:" ||
        url.hostname !== "billing.stripe.com" ||
        url.username ||
        url.password ||
        url.port ||
        !Number.isSafeInteger(session.created)
      )
        throw new StripeBillingError("stripe_response_invalid");
      return { url: session.url, createdAt: new Date(session.created * 1000).toISOString() };
    },
    async observePaidInvoice(input: {
      organizationId: string;
      customerId: string;
      subscriptionId: string;
      invoiceId?: string;
    }) {
      await requireCustomer(input.organizationId, input.customerId);
      if (!/^sub_[A-Za-z0-9_]{1,252}$/u.test(input.subscriptionId))
        throw new StripeBillingError("stripe_scope_conflict");
      const subscription = await providerCall(() =>
        stripe.subscriptions.retrieve(input.subscriptionId, {}, requestOptions),
      );
      const item = subscription.items.data[0];
      if (
        subscription.id !== input.subscriptionId ||
        subscription.customer !== input.customerId ||
        subscription.livemode !== (configuration.mode === "live") ||
        subscription.items.has_more !== false ||
        subscription.items.data.length !== 1 ||
        item?.quantity !== 1 ||
        item.price.id !== configuration.paidPriceId
      )
        throw new StripeBillingError("stripe_scope_conflict");
      // Only an ended subscription carries Stripe's end, which closes its Paid coverage there.
      const endedAt = subscription.ended_at;
      const ended = endedSubscriptionStatuses.includes(subscription.status);
      if (
        !subscriptionStatuses.includes(subscription.status) ||
        (ended
          ? typeof endedAt !== "number" || !Number.isSafeInteger(endedAt) || endedAt <= 0
          : endedAt !== null)
      )
        throw new StripeBillingError("stripe_response_invalid");
      const subscriptionEndedAt = endedAt === null ? null : new Date(endedAt * 1000).toISOString();
      const invoiceId =
        input.invoiceId ??
        (typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : null);
      if (!invoiceId || !/^in_[A-Za-z0-9_]{1,253}$/u.test(invoiceId))
        throw new StripeBillingError("stripe_response_invalid");
      const invoice = await providerCall(() =>
        stripe.invoices.retrieve(
          invoiceId,
          { expand: ["payments.data.payment.payment_intent"] },
          requestOptions,
        ),
      );
      if (
        invoice.id !== invoiceId ||
        invoice.livemode !== (configuration.mode === "live") ||
        invoice.customer !== input.customerId ||
        invoice.parent?.subscription_details?.subscription !== subscription.id ||
        invoice.currency !== "usd"
      )
        throw new StripeBillingError("stripe_scope_conflict");
      if (
        invoice.status === null ||
        !["draft", "open", "paid", "uncollectible", "void"].includes(invoice.status)
      )
        throw new StripeBillingError("stripe_response_invalid");
      const taxIssue =
        invoiceTaxIssue(invoice) ??
        (subscription.automatic_tax?.enabled === false
          ? "billing_tax_configuration_required"
          : null);
      if (invoice.status !== "paid")
        return {
          invoice: null,
          invoiceId: invoice.id,
          taxIssue,
          paymentRequired:
            taxIssue !== null || invoice.status === "open" || invoice.status === "uncollectible",
          subscriptionEndedAt,
        };
      const line = invoice.lines.data[0],
        payment = invoice.payments?.data[0],
        intent = payment?.payment.payment_intent,
        paidAt = invoice.status_transitions.paid_at;
      if (
        invoice.lines.has_more !== false ||
        invoice.lines.data.length !== 1 ||
        line?.quantity !== 1 ||
        line.amount !== 1000 ||
        line.pricing?.price_details?.price !== configuration.paidPriceId ||
        line.parent?.subscription_item_details?.proration !== false ||
        line.parent.subscription_item_details.subscription !== subscription.id ||
        !["subscription_create", "subscription_cycle"].includes(invoice.billing_reason ?? "") ||
        invoice.subtotal !== 1000 ||
        !Number.isSafeInteger(invoice.total) ||
        invoice.total < 1000 ||
        invoice.amount_paid !== invoice.total ||
        invoice.amount_remaining !== 0 ||
        (taxIssue === null &&
          (invoice.automatic_tax?.enabled !== true ||
            invoice.automatic_tax.status !== "complete")) ||
        invoice.payments?.has_more !== false ||
        invoice.payments.data.length !== 1 ||
        payment?.status !== "paid" ||
        payment.amount_paid !== invoice.total ||
        payment.payment.type !== "payment_intent" ||
        !intent ||
        typeof intent === "string" ||
        intent.status !== "succeeded" ||
        intent.customer !== input.customerId ||
        intent.livemode !== (configuration.mode === "live") ||
        intent.currency !== "usd" ||
        intent.amount_received !== invoice.total ||
        typeof paidAt !== "number" ||
        !Number.isSafeInteger(paidAt) ||
        !Number.isSafeInteger(line.period.start) ||
        !Number.isSafeInteger(line.period.end) ||
        line.period.end <= line.period.start
      )
        throw new StripeBillingError("stripe_response_invalid");
      return {
        // A tax issue is separate from the full proof of a payment already collected.
        paymentRequired: taxIssue !== null,
        invoiceId: invoice.id,
        taxIssue,
        subscriptionEndedAt,
        invoice: {
          accountId: configuration.accountId,
          mode: configuration.mode,
          customerId: input.customerId,
          subscriptionId: subscription.id,
          invoiceId: invoice.id,
          paymentIntentId: intent.id,
          priceId: configuration.paidPriceId,
          currency: "usd",
          amountSubtotal: invoice.subtotal,
          amountTotal: invoice.total,
          periodStart: new Date(line.period.start * 1000).toISOString(),
          periodEnd: new Date(line.period.end * 1000).toISOString(),
          paidAt: new Date(paidAt * 1000).toISOString(),
        },
      };
    },
    async resolveWebhookEvent(input: StripeWebhookEvent) {
      if (!/^evt_[A-Za-z0-9_]{1,128}$/u.test(input.id))
        throw new StripeBillingError("stripe_scope_conflict");
      const event = await providerCall(() => stripe.events.retrieve(input.id, {}, requestOptions));
      const object = event.data.object;
      if (
        event.id !== input.id ||
        event.type !== input.type ||
        !("id" in object) ||
        object.id !== input.objectId ||
        event.livemode !== (configuration.mode === "live") ||
        (event.account !== undefined && event.account !== configuration.accountId)
      )
        throw new StripeBillingError("stripe_scope_conflict");
      if (object.object === "invoice" && object.metadata?.["ohmyhost_recharge_id"]) {
        const organizationId = parseUlid(String(object.metadata["ohmyhost_organization_id"]));
        const rechargeId = parseUlid(object.metadata["ohmyhost_recharge_id"]);
        if (typeof object.customer !== "string")
          throw new StripeBillingError("stripe_scope_conflict");
        await requireCustomer(organizationId, object.customer);
        return { organizationId, rechargeId, invoiceId: object.id };
      }
      if (
        object.object === "checkout.session" &&
        object.mode === "setup" &&
        object.metadata?.["ohmyhost_recharge_id"]
      )
        return null;
      // One-time purchases settle from Checkout events; their paid invoices remain enabled.
      if (
        object.object === "invoice" &&
        object.billing_reason === "manual" &&
        object.parent === null
      )
        return null;
      let session: Stripe.Checkout.Session;
      let invoiceId: string | undefined;
      if (event.type.startsWith("checkout.session.") && object.object === "checkout.session") {
        session = await providerCall(() =>
          stripe.checkout.sessions.retrieve(object.id, {}, requestOptions),
        );
        if (session.id !== object.id) throw new StripeBillingError("stripe_response_invalid");
      } else if (
        (event.type.startsWith("refund.") && object.object === "refund") ||
        (event.type.startsWith("charge.dispute.") && object.object === "dispute") ||
        (event.type === "charge.refunded" && object.object === "charge")
      ) {
        const paymentIntent = object.payment_intent;
        if (typeof paymentIntent !== "string")
          throw new StripeBillingError("stripe_response_invalid");
        let sessions = await providerCall(() =>
          stripe.checkout.sessions.list(
            { payment_intent: paymentIntent, limit: 2 },
            requestOptions,
          ),
        );
        if (
          sessions.has_more === false &&
          (sessions.data.length === 0 ||
            (sessions.data.length === 1 &&
              sessions.data[0]?.payment_intent === null &&
              typeof sessions.data[0]?.subscription === "string"))
        ) {
          const payments = await providerCall(() =>
            stripe.invoicePayments.list(
              {
                payment: { type: "payment_intent", payment_intent: paymentIntent },
                status: "paid",
                limit: 2,
              },
              requestOptions,
            ),
          );
          const payment = payments.data[0];
          if (
            payments.has_more !== false ||
            payments.data.length !== 1 ||
            payment?.payment.payment_intent !== paymentIntent ||
            typeof payment.invoice !== "string"
          )
            throw new StripeBillingError("stripe_response_invalid");
          invoiceId = payment.invoice;
          const matchedInvoiceId = payment.invoice;
          const invoice = await providerCall(() =>
            stripe.invoices.retrieve(matchedInvoiceId, {}, requestOptions),
          );
          if (invoice.metadata?.["ohmyhost_recharge_id"]) {
            const organizationId = parseUlid(String(invoice.metadata["ohmyhost_organization_id"]));
            if (typeof invoice.customer !== "string")
              throw new StripeBillingError("stripe_scope_conflict");
            await requireCustomer(organizationId, invoice.customer);
            return {
              organizationId,
              rechargeId: parseUlid(invoice.metadata["ohmyhost_recharge_id"]),
              invoiceId: matchedInvoiceId,
            };
          }
          const subscription = invoice.parent?.subscription_details?.subscription;
          if (typeof subscription !== "string")
            throw new StripeBillingError("stripe_response_invalid");
          sessions = await providerCall(() =>
            stripe.checkout.sessions.list({ subscription, limit: 2 }, requestOptions),
          );
        }
        if (
          sessions.has_more !== false ||
          sessions.data.length !== 1 ||
          (!invoiceId && sessions.data[0]?.payment_intent !== paymentIntent)
        )
          throw new StripeBillingError("stripe_response_invalid");
        const matched = sessions.data[0];
        if (!matched) throw new StripeBillingError("stripe_response_invalid");
        session = matched;
      } else if (object.object === "invoice" || object.object === "subscription") {
        const subscription =
          object.object === "invoice"
            ? object.parent?.subscription_details?.subscription
            : object.id;
        if (typeof subscription !== "string") throw new StripeBillingError("stripe_scope_conflict");
        const sessions = await providerCall(() =>
          stripe.checkout.sessions.list({ subscription, limit: 2 }, requestOptions),
        );
        if (
          sessions.has_more !== false ||
          sessions.data.length !== 1 ||
          sessions.data[0]?.subscription !== subscription
        )
          throw new StripeBillingError("stripe_response_invalid");
        const matched = sessions.data[0];
        if (!matched) throw new StripeBillingError("stripe_response_invalid");
        session = matched;
        if (object.object === "invoice") invoiceId = object.id;
      } else throw new StripeBillingError("stripe_scope_conflict");
      const organizationId = session.metadata?.["ohmyhost_organization_id"],
        checkoutId = session.metadata?.["ohmyhost_checkout_id"];
      if (!organizationId && !checkoutId) return null; // An authenticated payment outside this product.
      if (
        !organizationId ||
        !checkoutId ||
        !["topup", "paid"].includes(session.metadata?.["ohmyhost_offer"] ?? "") ||
        session.livemode !== (configuration.mode === "live") ||
        !/^cs_[A-Za-z0-9_]{1,256}$/u.test(session.id)
      )
        throw new StripeBillingError("stripe_scope_conflict");
      return {
        organizationId: parseUlid(organizationId),
        checkoutId: parseUlid(checkoutId),
        sessionId: session.id,
        ...(invoiceId ? { invoiceId } : {}),
      };
    },
    async observePaymentReversals(input: {
      organizationId: string;
      customerId: string;
      paymentIntentId: string;
      amountTotal: number;
    }) {
      await requireCustomer(input.organizationId, input.customerId);
      if (
        !/^pi_[A-Za-z0-9_]{1,253}$/u.test(input.paymentIntentId) ||
        !Number.isSafeInteger(input.amountTotal) ||
        input.amountTotal <= 0
      )
        throw new StripeBillingError("stripe_scope_conflict");
      const payment = await providerCall(() =>
        stripe.paymentIntents.retrieve(input.paymentIntentId, {}, requestOptions),
      );
      if (
        payment.id !== input.paymentIntentId ||
        payment.customer !== input.customerId ||
        payment.livemode !== (configuration.mode === "live") ||
        payment.currency !== "usd" ||
        payment.status !== "succeeded" ||
        payment.amount_received !== input.amountTotal
      )
        throw new StripeBillingError("stripe_response_invalid");
      const items: {
        id: string;
        amountMinor: number;
        status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
      }[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await providerCall(() =>
          stripe.refunds.list(
            {
              payment_intent: input.paymentIntentId,
              limit: 100,
              ...(cursor ? { starting_after: cursor } : {}),
            },
            requestOptions,
          ),
        );
        for (const refund of page.data) {
          const status = refundStatuses.find((value) => value === refund.status);
          if (
            !/^re_[A-Za-z0-9_]{1,253}$/u.test(refund.id) ||
            seen.has(refund.id) ||
            refund.payment_intent !== input.paymentIntentId ||
            refund.currency !== "usd" ||
            !Number.isSafeInteger(refund.amount) ||
            refund.amount <= 0 ||
            refund.amount > input.amountTotal ||
            !status
          )
            throw new StripeBillingError("stripe_response_invalid");
          seen.add(refund.id);
          items.push({ id: refund.id, amountMinor: refund.amount, status });
        }
        if (
          items.length > 1000 ||
          (page.has_more && (page.data.length === 0 || items.length === 1000))
        )
          throw new StripeBillingError("stripe_response_invalid");
        cursor = page.has_more ? page.data.at(-1)?.id : undefined;
      } while (cursor);
      const disputes: {
        id: string;
        amountMinor: number;
        movements: { id: string; direction: "withdrawn" | "reinstated" }[];
      }[] = [];
      const page = await providerCall(() =>
        stripe.disputes.list({ payment_intent: input.paymentIntentId, limit: 100 }, requestOptions),
      );
      if (page.has_more !== false || !Array.isArray(page.data))
        throw new StripeBillingError("stripe_response_invalid");
      const disputeIds = new Set<string>(),
        transactionIds = new Set<string>();
      for (const dispute of page.data) {
        if (
          !/^du_[A-Za-z0-9_]{1,253}$/u.test(dispute.id) ||
          disputeIds.has(dispute.id) ||
          dispute.payment_intent !== input.paymentIntentId ||
          dispute.currency !== "usd" ||
          dispute.livemode !== (configuration.mode === "live") ||
          !Number.isSafeInteger(dispute.amount) ||
          dispute.amount <= 0 ||
          !Array.isArray(dispute.balance_transactions) ||
          dispute.balance_transactions.length > 10
        )
          throw new StripeBillingError("stripe_response_invalid");
        disputeIds.add(dispute.id);
        const movements: { id: string; direction: "withdrawn" | "reinstated" }[] = [];
        for (const transaction of dispute.balance_transactions) {
          if (
            !/^txn_[A-Za-z0-9_]{1,252}$/u.test(transaction.id) ||
            transactionIds.has(transaction.id) ||
            transaction.source !== dispute.id ||
            !Number.isSafeInteger(transaction.amount) ||
            transaction.amount === 0 ||
            (transaction.amount < 0
              ? transaction.reporting_category !== "dispute"
              : transaction.reporting_category !== "dispute_reversal")
          )
            throw new StripeBillingError("stripe_response_invalid");
          transactionIds.add(transaction.id);
          movements.push({
            id: transaction.id,
            direction: transaction.amount < 0 ? "withdrawn" : "reinstated",
          });
        }
        // Charge-currency principal is authoritative; balance-currency FX and fees are platform costs.
        disputes.push({ id: dispute.id, amountMinor: dispute.amount, movements });
      }
      return {
        accountId: configuration.accountId,
        mode: configuration.mode,
        customerId: input.customerId,
        paymentIntentId: input.paymentIntentId,
        currency: "usd",
        paymentTotalMinor: input.amountTotal,
        items,
        disputes,
      };
    },
    async expireCheckout(input: StripeCheckoutScope & { sessionId: string }) {
      const before = await observeCheckout(input);
      if (before.state !== "open") return before;
      await providerCall(() =>
        stripe.checkout.sessions.expire(
          input.sessionId,
          {},
          { ...requestOptions, idempotencyKey: `ohmyhost/expire/${input.checkoutId}` },
        ),
      );
      return observeCheckout(input);
    },
  };
}

function validateScope(input: StripeCheckoutScope) {
  parseUlid(input.organizationId);
  parseUlid(input.checkoutId);
  if (
    !["paid", "topup"].includes(input.offer) ||
    !Number.isSafeInteger(input.packs) ||
    input.packs < 1 ||
    input.packs > 100 ||
    (input.offer === "paid" && input.packs !== 1) ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    new Date(input.expiresAt).toISOString() !== input.expiresAt ||
    Date.parse(input.expiresAt) % 1000 !== 0
  )
    throw new StripeBillingError("stripe_scope_conflict");
}

function checkoutResult(
  session: Stripe.Checkout.Session,
  input: StripeCheckoutScope,
  configuration: StripeBillingConfiguration,
) {
  const lines = Array.isArray(session.line_items?.data) ? session.line_items.data : [];
  const line = lines[0],
    price = line?.price;
  const subtotal = 1000 * input.packs;
  if (
    !/^cs_(?:test_|live_)?[A-Za-z0-9_]{1,256}$/u.test(session.id) ||
    session.livemode !== (configuration.mode === "live") ||
    session.customer !== input.customerId ||
    session.client_reference_id !== input.checkoutId ||
    session.metadata?.["ohmyhost_organization_id"] !== input.organizationId ||
    session.metadata["ohmyhost_checkout_id"] !== input.checkoutId ||
    session.metadata["ohmyhost_offer"] !== input.offer ||
    session.mode !== (input.offer === "paid" ? "subscription" : "payment") ||
    !["open", "complete", "expired"].includes(session.status ?? "") ||
    !["paid", "unpaid", "no_payment_required"].includes(session.payment_status) ||
    session.currency !== "usd" ||
    session.amount_subtotal !== subtotal ||
    !session.automatic_tax?.enabled ||
    session.total_details?.amount_discount !== 0 ||
    session.line_items?.has_more !== false ||
    lines.length !== 1 ||
    line?.quantity !== input.packs ||
    price?.id !==
      (input.offer === "paid" ? configuration.paidPriceId : configuration.topupPriceId) ||
    price.currency !== "usd" ||
    price.unit_amount !== 1000 ||
    price.tax_behavior !== "exclusive" ||
    (session.amount_total !== null &&
      (!Number.isSafeInteger(session.amount_total) || session.amount_total < subtotal)) ||
    !Number.isSafeInteger(session.expires_at) ||
    new Date(session.expires_at * 1000).toISOString() !== input.expiresAt
  )
    throw new StripeBillingError("stripe_response_invalid");
  if (session.url !== null) {
    const url = new URL(session.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "checkout.stripe.com" ||
      url.username ||
      url.password ||
      url.port
    )
      throw new StripeBillingError("stripe_response_invalid");
  }
  const paid = session.status === "complete" && session.payment_status === "paid";
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : null;
  const invoiceId = typeof session.invoice === "string" ? session.invoice : null;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
  if (
    paid &&
    (session.amount_total === null ||
      session.automatic_tax.status !== "complete" ||
      (input.offer === "topup" ? !paymentIntentId : !subscriptionId || !invoiceId))
  )
    throw new StripeBillingError("stripe_response_invalid");
  return {
    id: session.id,
    accountId: configuration.accountId,
    mode: configuration.mode,
    priceId: input.offer === "paid" ? configuration.paidPriceId : configuration.topupPriceId,
    currency: "usd" as const,
    organizationId: input.organizationId,
    checkoutId: input.checkoutId,
    customerId: input.customerId,
    offer: input.offer,
    packs: input.packs,
    state: session.status,
    paid,
    url: session.url,
    expiresAt: input.expiresAt,
    amountSubtotal: subtotal,
    amountTotal: session.amount_total,
    paymentIntentId,
    invoiceId,
    subscriptionId,
  };
}

async function providerCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof StripeBillingError) throw error;
    // SDK errors can cross ESM/CommonJS or Worker bundle boundaries; validate metadata, not class identity.
    const metadata =
      typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
    const candidate = metadata["statusCode"];
    const status =
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 400 &&
      candidate <= 599
        ? candidate
        : undefined;
    const retryable = status === undefined || status === 429 || status >= 500;
    throw new StripeBillingError(retryable ? "stripe_unavailable" : "stripe_rejected", retryable, {
      ...(status === undefined ? {} : { status }),
      ...(typeof metadata["code"] === "string" && /^[a-z0-9_]{1,128}$/u.test(metadata["code"])
        ? { code: metadata["code"] }
        : {}),
      ...(typeof metadata["requestId"] === "string" &&
      /^req_[A-Za-z0-9_]{1,128}$/u.test(metadata["requestId"])
        ? { requestId: metadata["requestId"] }
        : {}),
    });
  }
}
