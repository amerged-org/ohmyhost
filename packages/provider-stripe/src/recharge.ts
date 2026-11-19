import type Stripe from "stripe";
import { parseUlid } from "@ohmyhost/platform";

export type BillingTaxIssueCode =
  | "billing_tax_location_required"
  | "billing_tax_calculation_failed"
  | "billing_tax_configuration_required";
/** Classify verified invoice data; provider messages and customer details never leave this boundary. */
export function invoiceTaxIssue(invoice: Stripe.Invoice): BillingTaxIssueCode | null {
  if (invoice.automatic_tax?.enabled === false) return "billing_tax_configuration_required";
  if (
    invoice.automatic_tax?.status === "requires_location_inputs" ||
    invoice.last_finalization_error?.code === "customer_tax_location_invalid"
  )
    return "billing_tax_location_required";
  if (invoice.automatic_tax?.status === "failed") return "billing_tax_calculation_failed";
  return null;
}
export interface RechargeScope {
  organizationId: string;
  customerId: string;
  id: string;
}
export interface RechargeInvoice {
  invoiceId: string;
  state: "draft" | "open" | "paid" | "void" | "uncollectible";
  totalMinor: number;
  paymentIntentId: string | null;
  url: string | null;
  taxIssue: BillingTaxIssueCode | null;
}
const options = { timeout: 10000, maxNetworkRetries: 1 } as const;
/** The most pages (100 invoices each) of paid invoices one look reads before it refuses the listing. */
const PAID_INVOICE_PAGE_CAP = 20;
/** Called only after the parent adapter has verified the exact account and price catalog. */
export function createRechargeProvider(
  stripe: Stripe,
  config: { mode: "test" | "live"; returnOrigin: string; topupPriceId: string },
  requireCustomer: (organizationId: string, customerId: string) => Promise<Stripe.Customer>,
  branding: Stripe.Checkout.SessionCreateParams.BrandingSettings,
) {
  async function scope(s: RechargeScope) {
    parseUlid(s.id);
    await requireCustomer(s.organizationId, s.customerId);
  }
  function invoiceView(i: Stripe.Invoice, s: RechargeScope): RechargeInvoice {
    if (
      i.customer !== s.customerId ||
      i.livemode !== (config.mode === "live") ||
      i.metadata?.["ohmyhost_recharge_id"] !== s.id ||
      i.metadata["ohmyhost_organization_id"] !== s.organizationId ||
      i.currency !== "usd" ||
      i.auto_advance !== false ||
      i.collection_method !== "charge_automatically" ||
      i.parent !== null ||
      !i.status ||
      !["draft", "open", "paid", "void", "uncollectible"].includes(i.status)
    )
      throw new Error("stripe_scope_conflict");
    const taxIssue = invoiceTaxIssue(i);
    const line = i.lines.data[0];
    if (
      i.lines.has_more ||
      i.lines.data.length > 1 ||
      (line && (line.quantity !== 1 || line.amount !== 900)) ||
      (i.status !== "draft" &&
        (!line ||
          i.subtotal !== 900 ||
          !Number.isSafeInteger(i.total) ||
          i.total < 900 ||
          (taxIssue === null &&
            (i.automatic_tax.enabled !== true || i.automatic_tax.status !== "complete"))))
    )
      throw new Error("stripe_response_invalid");
    let paymentIntentId: string | null = null;
    if (i.status === "paid") {
      const payment = i.payments?.data[0],
        intent = payment?.payment.payment_intent;
      if (
        i.amount_paid !== i.total ||
        i.amount_remaining !== 0 ||
        i.payments?.has_more !== false ||
        i.payments.data.length !== 1 ||
        payment?.status !== "paid" ||
        payment.amount_paid !== i.total ||
        !intent ||
        typeof intent === "string" ||
        intent.status !== "succeeded" ||
        intent.customer !== s.customerId ||
        intent.currency !== "usd" ||
        intent.livemode !== (config.mode === "live") ||
        intent.amount_received !== i.total
      )
        throw new Error("stripe_response_invalid");
      paymentIntentId = intent.id;
    }
    if (i.hosted_invoice_url) {
      const u = new URL(i.hosted_invoice_url);
      if (u.origin !== "https://invoice.stripe.com" || u.username || u.password)
        throw new Error("stripe_response_invalid");
    }
    return {
      invoiceId: i.id,
      state: i.status as RechargeInvoice["state"],
      totalMinor: i.total,
      paymentIntentId,
      url: i.hosted_invoice_url ?? null,
      taxIssue,
    };
  }
  /**
   * The recharge invoices of the customer that are neither paid nor void: the drafts and the open ones. Stripe lists are
   * consistent, so an invoice whose creation response was lost is found here, and with it the recharge it belongs to.
   */
  async function findRechargeInvoices(s: { organizationId: string; customerId: string }) {
    await requireCustomer(s.organizationId, s.customerId);
    const found: (RechargeInvoice & { rechargeId: string })[] = [];
    for (const status of ["draft", "open"] as const) {
      const page = await stripe.invoices.list(
        { customer: s.customerId, status, limit: 100 },
        options,
      );
      if (!Array.isArray(page.data) || page.has_more !== false)
        throw new Error("stripe_response_invalid");
      for (const invoice of page.data) {
        const rechargeId = invoice.metadata?.["ohmyhost_recharge_id"];
        if (!rechargeId) continue;
        found.push({
          ...invoiceView(invoice, {
            organizationId: s.organizationId,
            customerId: s.customerId,
            id: parseUlid(rechargeId),
          }),
          rechargeId,
        });
      }
    }
    return found;
  }
  /**
   * The recharge invoices of the customer that were paid since `paidSince`: what a lost event may have left uncredited.
   * Only their identities are returned; observing one verifies its payment. Every page of the customer's paid invoices
   * is read (`starting_after` the last invoice of the previous page); a listing beyond the page cap is refused, never
   * read partially.
   */
  async function findPaidRechargeInvoices(s: {
    organizationId: string;
    customerId: string;
    paidSince: Date;
  }) {
    await requireCustomer(s.organizationId, s.customerId);
    const found: { rechargeId: string; invoiceId: string }[] = [];
    let startingAfter: string | undefined;
    for (let pages = 1; ; pages++) {
      if (pages > PAID_INVOICE_PAGE_CAP) throw new Error("stripe_response_invalid");
      const page = await stripe.invoices.list(
        {
          customer: s.customerId,
          status: "paid",
          created: { gte: Math.floor(s.paidSince.getTime() / 1000) - 45 * 86400 },
          limit: 100,
          ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
        },
        options,
      );
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean")
        throw new Error("stripe_response_invalid");
      for (const invoice of page.data) {
        const rechargeId = invoice.metadata?.["ohmyhost_recharge_id"];
        const paidAt = invoice.status_transitions?.paid_at;
        if (
          rechargeId &&
          invoice.metadata?.["ohmyhost_organization_id"] === s.organizationId &&
          typeof paidAt === "number" &&
          paidAt * 1000 >= s.paidSince.getTime()
        )
          found.push({ rechargeId: parseUlid(rechargeId), invoiceId: invoice.id });
      }
      if (!page.has_more) return found;
      const last = page.data.at(-1);
      if (last === undefined) throw new Error("stripe_response_invalid");
      startingAfter = last.id;
    }
  }
  async function observeRechargeInvoice(s: RechargeScope & { invoiceId: string }) {
    await scope(s);
    const i = await stripe.invoices.retrieve(
      s.invoiceId,
      { expand: ["payments.data.payment.payment_intent"] },
      options,
    );
    return invoiceView(i, s);
  }
  return {
    async rechargeSetup(s: RechargeScope & { sessionId: string | null; createdAt: string }) {
      await scope(s);
      if (!s.sessionId && Date.now() - Date.parse(s.createdAt) >= 86400000)
        throw new Error("billing_needs_reconciliation");
      const session = s.sessionId
        ? await stripe.checkout.sessions.retrieve(
            s.sessionId,
            { expand: ["setup_intent"] },
            options,
          )
        : await stripe.checkout.sessions.create(
            {
              mode: "setup",
              managed_payments: { enabled: false },
              branding_settings: branding,
              currency: "usd",
              customer: s.customerId,
              client_reference_id: s.id,
              payment_method_types: ["card"],
              billing_address_collection: "required",
              customer_update: { address: "auto", name: "auto" },
              metadata: { ohmyhost_organization_id: s.organizationId, ohmyhost_recharge_id: s.id },
              setup_intent_data: {
                metadata: {
                  ohmyhost_organization_id: s.organizationId,
                  ohmyhost_recharge_id: s.id,
                },
              },
              custom_text: {
                submit: {
                  message:
                    "Save this card for your explicitly authorized ohmyho.st automatic credit top-ups. Manage or disable auto-recharge in Billing.",
                },
              },
              success_url: config.returnOrigin + "/billing",
              cancel_url: config.returnOrigin + "/billing",
              expand: ["setup_intent"],
            },
            { ...options, idempotencyKey: `ohmyhost/recharge-setup/${s.id}` },
          );
      if (
        session.mode !== "setup" ||
        session.customer !== s.customerId ||
        session.client_reference_id !== s.id ||
        session.livemode !== (config.mode === "live") ||
        session.metadata?.["ohmyhost_recharge_id"] !== s.id ||
        session.metadata["ohmyhost_organization_id"] !== s.organizationId
      )
        throw new Error("stripe_scope_conflict");
      let paymentMethodId: string | null = null;
      if (session.status === "complete") {
        const setup = session.setup_intent;
        if (
          !setup ||
          typeof setup === "string" ||
          setup.status !== "succeeded" ||
          setup.usage !== "off_session" ||
          setup.customer !== s.customerId ||
          setup.livemode !== (config.mode === "live") ||
          typeof setup.payment_method !== "string" ||
          setup.metadata?.["ohmyhost_recharge_id"] !== s.id ||
          setup.metadata?.["ohmyhost_organization_id"] !== s.organizationId
        )
          throw new Error("stripe_response_invalid");
        const pm = await stripe.paymentMethods.retrieve(setup.payment_method, {}, options);
        if (
          pm.type !== "card" ||
          pm.customer !== s.customerId ||
          pm.livemode !== (config.mode === "live")
        )
          throw new Error("stripe_scope_conflict");
        paymentMethodId = pm.id;
      }
      if (session.url) {
        const u = new URL(session.url);
        if (u.origin !== "https://checkout.stripe.com" || u.username || u.password)
          throw new Error("stripe_response_invalid");
      }
      return {
        sessionId: session.id,
        url: session.status === "open" ? session.url : null,
        paymentMethodId,
        expired: session.status === "expired",
      };
    },
    async createRechargeInvoice(s: RechargeScope & { paymentMethodId: string; createdAt: string }) {
      await scope(s);
      if (Date.now() - Date.parse(s.createdAt) >= 86400000)
        throw new Error("billing_needs_reconciliation");
      const i = await stripe.invoices.create(
        {
          customer: s.customerId,
          currency: "usd",
          auto_advance: false,
          collection_method: "charge_automatically",
          default_payment_method: s.paymentMethodId,
          pending_invoice_items_behavior: "exclude",
          automatic_tax: { enabled: true },
          discounts: "",
          metadata: { ohmyhost_organization_id: s.organizationId, ohmyhost_recharge_id: s.id },
          description: "ohmyho.st auto-recharge: 1,000 credits (10% discount)",
        },
        { ...options, idempotencyKey: `ohmyhost/recharge-invoice/${s.id}` },
      );
      return invoiceView(i, s);
    },
    async finalizeRechargeInvoice(
      s: RechargeScope & { invoiceId: string; retryAfterTaxCorrection?: boolean },
    ) {
      const before = await observeRechargeInvoice(s);
      if (before.state !== "draft") return before;
      const recoveringTax = before.taxIssue !== null || s.retryAfterTaxCorrection === true;
      if (recoveringTax) {
        if (before.taxIssue !== null && before.taxIssue !== "billing_tax_location_required")
          return before;
        const customer = await requireCustomer(s.organizationId, s.customerId);
        if (!["supported", "not_collecting"].includes(customer.tax?.automatic_tax ?? ""))
          return { ...before, taxIssue: "billing_tax_location_required" as const };
      }
      const current = await stripe.invoices.retrieve(s.invoiceId, {}, options);
      if (current.lines.data.length === 0) {
        const price = await stripe.prices.retrieve(config.topupPriceId, {}, options);
        const product = typeof price.product === "string" ? price.product : price.product.id;
        await stripe.invoiceItems.create(
          {
            customer: s.customerId,
            invoice: s.invoiceId,
            price_data: { currency: "usd", product, unit_amount: 900, tax_behavior: "exclusive" },
            quantity: 1,
            discountable: false,
            description: "1,000 non-expiring credits — auto-recharge 10% discount",
          },
          { ...options, idempotencyKey: `ohmyhost/recharge-line/${s.id}` },
        );
      }
      try {
        await stripe.invoices.finalizeInvoice(
          s.invoiceId,
          { auto_advance: false },
          {
            ...options,
            idempotencyKey: `ohmyhost/recharge-finalize/${s.id}${recoveringTax ? `/tax/${crypto.randomUUID()}` : ""}`,
          },
        );
      } catch (error) {
        const observed = await observeRechargeInvoice(s);
        // A competing finalization may have succeeded; observe the same invoice, never pay here.
        if (observed.state !== "draft" || observed.taxIssue !== null) return observed;
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "customer_tax_location_invalid"
        )
          return { ...observed, taxIssue: "billing_tax_location_required" as const };
        throw error;
      }
      return observeRechargeInvoice(s);
    },
    observeRechargeInvoice,
    findRechargeInvoices,
    findPaidRechargeInvoices,
    async payRechargeInvoice(
      s: RechargeScope & { invoiceId: string; paymentMethodId: string; maximumMinor: number },
    ) {
      const before = await observeRechargeInvoice(s);
      if (before.taxIssue !== null || before.state !== "open" || before.totalMinor > s.maximumMinor)
        throw new Error("billing_conflict");
      try {
        await stripe.invoices.pay(
          s.invoiceId,
          { off_session: true, payment_method: s.paymentMethodId, forgive: false },
          { ...options, idempotencyKey: `ohmyhost/recharge-pay/${s.id}` },
        );
      } catch (error) {
        if (!(error instanceof Error) || !("type" in error) || error.type !== "StripeCardError")
          throw error;
      }
      return observeRechargeInvoice(s);
    },
    async voidRechargeInvoice(s: RechargeScope & { invoiceId: string }) {
      const before = await observeRechargeInvoice(s);
      if (before.state === "draft") await stripe.invoices.del(s.invoiceId, options);
      else if (before.state === "open")
        await stripe.invoices.voidInvoice(
          s.invoiceId,
          {},
          { ...options, idempotencyKey: `ohmyhost/recharge-void/${s.id}` },
        );
      else if (before.state !== "void") throw new Error("billing_conflict");
    },
  };
}
