import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import Stripe from "stripe";
import { createRequire } from "node:module";
import {
  createStripeBillingProvider,
  createStripeBillingProviderFromKey,
  verifyStripeWebhook,
} from "./index.js";

const organizationId = "00000000000000000000000001";
const checkoutId = "00000000000000000000000002";
const configuration = {
  accountId: "acct_test",
  mode: "test" as const,
  paidPriceId: "price_paid",
  topupPriceId: "price_topup",
  returnOrigin: "https://dev.app.ohmyho.st",
  portalConfigurationId: "bpc_test",
};
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

async function fixture() {
  const behavior = {
    status: 200,
    moreSessions: false,
    moreSubscriptions: false,
    moreCustomers: false,
  };
  const subscriptions: Record<string, unknown>[] = [];
  const cards: Record<string, unknown>[] = [];
  const disputes: Record<string, unknown>[] = [];
  const requests: {
    method: string;
    path: string;
    body: URLSearchParams;
    key: string | undefined;
  }[] = [];
  const customer = {
    id: "cus_one",
    object: "customer",
    livemode: false,
    metadata: {
      ohmyhost_organization_id: organizationId,
      ohmyhost_customer_request_id: checkoutId,
    },
  };
  const session = {
    id: "cs_test_one",
    object: "checkout.session",
    livemode: false,
    customer: "cus_one",
    mode: "payment",
    status: "open",
    payment_status: "unpaid",
    payment_intent: null,
    subscription: null,
    invoice: null,
    currency: "usd",
    amount_subtotal: 1000,
    amount_total: null,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    url: "https://checkout.stripe.com/c/pay/cs_test_one",
    client_reference_id: checkoutId,
    metadata: {
      ohmyhost_organization_id: organizationId,
      ohmyhost_checkout_id: checkoutId,
      ohmyhost_offer: "topup",
    },
    automatic_tax: { enabled: true },
    total_details: { amount_discount: 0 },
    line_items: {
      has_more: false,
      data: [
        {
          quantity: 1,
          price: {
            id: "price_topup",
            currency: "usd",
            unit_amount: 1000,
            tax_behavior: "exclusive",
          },
        },
      ],
    },
  };
  const periodStart = Math.floor(Date.now() / 1000),
    periodEnd = periodStart + 30 * 86400;
  const invoice = {
    id: "in_paid",
    object: "invoice",
    livemode: false,
    customer: "cus_one",
    currency: "usd",
    status: "paid",
    parent: { subscription_details: { subscription: "sub_one" } },
    billing_reason: "subscription_create",
    subtotal: 1000,
    total: 1210,
    amount_paid: 1210,
    amount_remaining: 0,
    automatic_tax: { enabled: true, status: "complete" },
    status_transitions: { paid_at: periodStart },
    lines: {
      has_more: false,
      data: [
        {
          quantity: 1,
          amount: 1000,
          pricing: { price_details: { price: "price_paid" } },
          parent: { subscription_item_details: { proration: false, subscription: "sub_one" } },
          period: { start: periodStart, end: periodEnd },
        },
      ],
    },
    payments: {
      has_more: false,
      data: [
        {
          status: "paid",
          amount_paid: 1210,
          payment: {
            type: "payment_intent",
            payment_intent: {
              id: "pi_paid",
              customer: "cus_one",
              status: "succeeded",
              livemode: false,
              currency: "usd",
              amount_received: 1210,
            },
          },
        },
      ],
    },
  };
  const retrievedSubscription = {
    id: "sub_one",
    object: "subscription",
    customer: "cus_one",
    livemode: false,
    status: "active",
    ended_at: null as number | null,
    latest_invoice: "in_paid",
    items: {
      has_more: false,
      data: [{ quantity: 1, price: { id: "price_paid" } }],
    },
  };
  const listedSessions = [session];
  const listedCustomers = [customer];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    requests.push({
      method: req.method ?? "",
      path,
      body: new URLSearchParams(Buffer.concat(chunks).toString()),
      key: req.headers["idempotency-key"] as string | undefined,
    });
    if (path.endsWith("/expire")) Object.assign(session, { status: "expired", url: null });
    // Stripe's answers to a cancellation and to a detach: the subscription ends and the card leaves the customer
    if (req.method === "DELETE" && path.startsWith("/v1/subscriptions/"))
      for (const row of subscriptions)
        if (path === `/v1/subscriptions/${String(row["id"])}`) row["status"] = "canceled";
    const detached = path.match(/^\/v1\/payment_methods\/([^/]+)\/detach$/u);
    if (detached) {
      const index = cards.findIndex((card) => card["id"] === detached[1]);
      if (index >= 0) cards.splice(index, 1);
    }
    const customerResponse =
      path === "/v1/customers/search"
        ? { object: "search_result", has_more: behavior.moreCustomers, data: listedCustomers }
        : customer;
    const value =
      path === "/v1/billing_portal/configurations/bpc_test"
        ? {
            id: "bpc_test",
            active: true,
            livemode: false,
            default_return_url: configuration.returnOrigin + "/billing",
            features: {
              customer_update: { enabled: true, allowed_updates: ["address", "name", "tax_id"] },
              invoice_history: { enabled: true },
              payment_method_update: { enabled: true },
              subscription_cancel: { enabled: true, mode: "at_period_end" },
              subscription_update: { enabled: false },
            },
          }
        : path === "/v1/billing_portal/sessions"
          ? {
              id: "bps_test",
              configuration: "bpc_test",
              customer: "cus_one",
              livemode: false,
              return_url: configuration.returnOrigin + "/billing",
              url: "https://billing.stripe.com/p/session/test",
              created: 1788793200,
            }
          : path === "/v1/invoice_payments"
            ? {
                has_more: false,
                data: [
                  {
                    id: "inpay_one",
                    invoice: "in_paid",
                    status: "paid",
                    payment: { type: "payment_intent", payment_intent: "pi_paid" },
                  },
                ],
              }
            : path.startsWith("/v1/subscriptions/")
              ? retrievedSubscription
              : path.startsWith("/v1/invoices/")
                ? invoice
                : path.startsWith("/v1/events/")
                  ? {
                      id: path.split("/").at(-1),
                      object: "event",
                      livemode: false,
                      type: path.endsWith("evt_refund")
                        ? "refund.updated"
                        : path.endsWith("evt_invoice") || path.endsWith("evt_recharge")
                          ? "invoice.paid"
                          : "checkout.session.completed",
                      data: {
                        object: path.endsWith("evt_refund")
                          ? { id: "re_one", object: "refund", payment_intent: "pi_paid" }
                          : path.endsWith("evt_invoice")
                            ? invoice
                            : path.endsWith("evt_recharge")
                              ? {
                                  id: "in_recharge",
                                  object: "invoice",
                                  customer: "cus_one",
                                  metadata: {
                                    ohmyhost_organization_id: organizationId,
                                    ohmyhost_recharge_id: checkoutId,
                                  },
                                }
                              : session,
                      },
                    }
                  : req.method === "GET" && path === "/v1/checkout/sessions"
                    ? { object: "list", has_more: behavior.moreSessions, data: listedSessions }
                    : path === "/v1/account"
                      ? { id: "acct_test", object: "account" }
                      : path.startsWith("/v1/customers")
                        ? customerResponse
                        : path.startsWith("/v1/prices")
                          ? {
                              id: path.endsWith("price_paid") ? "price_paid" : "price_topup",
                              object: "price",
                              active: true,
                              livemode: false,
                              currency: "usd",
                              unit_amount: 1000,
                              tax_behavior: "exclusive",
                              recurring: path.endsWith("price_paid")
                                ? { interval: "month", interval_count: 1 }
                                : null,
                            }
                          : path.startsWith("/v1/payment_intents")
                            ? {
                                id: "pi_paid",
                                object: "payment_intent",
                                customer: "cus_one",
                                livemode: false,
                                currency: "usd",
                                status: "succeeded",
                                amount_received: 1210,
                              }
                            : path === "/v1/refunds"
                              ? {
                                  object: "list",
                                  has_more: false,
                                  data: [
                                    {
                                      id: "re_one",
                                      object: "refund",
                                      payment_intent: "pi_paid",
                                      currency: "usd",
                                      amount: 121,
                                      status: "succeeded",
                                    },
                                  ],
                                }
                              : path === "/v1/disputes"
                                ? { has_more: false, data: disputes }
                                : path === "/v1/subscriptions"
                                  ? { has_more: behavior.moreSubscriptions, data: subscriptions }
                                  : path === "/v1/payment_methods"
                                    ? { has_more: false, data: cards }
                                    : detached
                                      ? {
                                          id: detached[1],
                                          object: "payment_method",
                                          customer: null,
                                        }
                                      : session;
    res.writeHead(behavior.status, {
      "content-type": "application/json",
      "request-id": "req_fixture",
    });
    res.end(
      JSON.stringify(
        behavior.status === 200
          ? value
          : {
              error: {
                type: "invalid_request_error",
                code: "parameter_unknown",
                message: "private-provider-message",
              },
            },
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server");
  const CommonJsStripe = createRequire(import.meta.url)("stripe") as typeof Stripe;
  const stripe = new CommonJsStripe("sk_test_fixture", {
    host: "127.0.0.1",
    port: address.port,
    protocol: "http",
    maxNetworkRetries: 0,
  });
  const provider = await createStripeBillingProvider(stripe, configuration);
  return {
    provider,
    requests,
    customer,
    session,
    stripe,
    behavior,
    invoice,
    disputes,
    listedSessions,
    subscriptions,
    cards,
    retrievedSubscription,
    listedCustomers,
  };
}

/** The subscriptions that the requests of a fixture cancelled, in order. */
const cancelledSubscriptions = (f: { requests: { method: string; path: string }[] }) =>
  f.requests
    .filter(
      (request) => request.method === "DELETE" && request.path.startsWith("/v1/subscriptions/"),
    )
    .map((request) => request.path.slice("/v1/subscriptions/".length));
/** The cards that the requests of a fixture detached, in order. */
const detachedCards = (f: { requests: { method: string; path: string }[] }) =>
  f.requests
    .filter((request) => request.method === "POST" && request.path.endsWith("/detach"))
    .map((request) => request.path);

describe("closed Stripe billing boundary", () => {
  it("recovers only one current customer bound to the original organization and request, without a create", async () => {
    const f = await fixture(),
      scope = { organizationId, requestId: checkoutId };
    f.requests.length = 0;
    expect(await f.provider.recoverCustomer(scope)).toEqual({ customerId: "cus_one" });
    expect(f.requests.map((r) => r.path)).toEqual([
      "/v1/customers/search",
      "/v1/customers/cus_one",
    ]);
    expect(f.requests.every((r) => r.key === undefined && r.body.size === 0)).toBe(true);
    f.customer.metadata.ohmyhost_customer_request_id = "00000000000000000000000003";
    await expect(f.provider.recoverCustomer(scope)).rejects.toThrow("stripe_scope_conflict");
    f.listedCustomers.length = 0;
    expect(await f.provider.recoverCustomer(scope)).toBeNull();
    f.behavior.moreCustomers = true;
    await expect(f.provider.recoverCustomer(scope)).rejects.toThrow("stripe_response_invalid");
  });
  it("distinguishes terminal subscriptions from active or recoverable ones without accepting incomplete or foreign inventory", async () => {
    const f = await fixture(),
      scope = { organizationId, customerId: "cus_one", checkoutId };
    expect(await f.provider.hasPaidPurchase(scope)).toBe(false);
    const subscription = { id: "sub_one", customer: "cus_one", livemode: false, status: "active" };
    f.subscriptions.push(subscription);
    for (const status of ["active", "past_due", "unpaid", "paused", "incomplete", "trialing"]) {
      subscription.status = status;
      expect(await f.provider.hasPaidPurchase(scope)).toBe(true);
    }
    for (const status of ["canceled", "incomplete_expired"]) {
      subscription.status = status;
      expect(await f.provider.hasPaidPurchase(scope)).toBe(false);
    }
    // another subscription Checkout that is still open could become a second plan; this checkout's own cannot
    subscription.status = "canceled";
    const open = {
      ...f.session,
      id: "cs_test_two",
      mode: "subscription",
      status: "open",
      client_reference_id: "00000000000000000000000009",
    };
    f.listedSessions.push(open);
    expect(await f.provider.hasPaidPurchase(scope)).toBe(true);
    open.client_reference_id = checkoutId;
    expect(await f.provider.hasPaidPurchase(scope)).toBe(false);
    open.client_reference_id = "00000000000000000000000009";
    open.status = "expired";
    expect(await f.provider.hasPaidPurchase(scope)).toBe(false);
    open.status = "open";
    open.customer = "cus_foreign";
    expect(await f.provider.hasPaidPurchase(scope)).toBe(false);
    f.behavior.moreSessions = true;
    await expect(f.provider.hasPaidPurchase(scope)).rejects.toThrow("stripe_response_invalid");
    f.behavior.moreSessions = false;
    f.listedSessions.pop();
    subscription.customer = "cus_foreign";
    await expect(f.provider.hasPaidPurchase(scope)).rejects.toThrow("stripe_response_invalid");
    f.subscriptions.length = 0;
    f.behavior.moreSubscriptions = true;
    await expect(f.provider.hasPaidPurchase(scope)).rejects.toThrow("stripe_response_invalid");
    f.behavior.status = 503;
    await expect(f.provider.hasPaidPurchase(scope)).rejects.toThrow("stripe_unavailable");
  });
  it("recovers only the exact original checkout and never treats incomplete or foreign inventory as absence", async () => {
    const f = await fixture();
    const input = {
      organizationId,
      checkoutId,
      customerId: "cus_one",
      offer: "topup" as const,
      packs: 1,
      createdAt: new Date((f.session.expires_at - 3600) * 1000).toISOString(),
      expiresAt: new Date(f.session.expires_at * 1000).toISOString(),
    };
    f.requests.length = 0;
    expect(await f.provider.recoverCheckout(input)).toMatchObject({
      id: "cs_test_one",
      paid: false,
      state: "open",
    });
    expect(f.requests.every((r) => r.key === undefined && r.body.size === 0)).toBe(true);
    f.session.metadata.ohmyhost_organization_id = "00000000000000000000000003";
    await expect(f.provider.recoverCheckout(input)).rejects.toThrow("stripe_response_invalid");
    f.listedSessions.length = 0;
    expect(await f.provider.recoverCheckout(input)).toBeNull();
    f.behavior.moreSessions = true;
    await expect(f.provider.recoverCheckout(input)).rejects.toThrow("stripe_response_invalid");
    f.behavior.status = 503;
    await expect(f.provider.recoverCheckout(input)).rejects.toThrow("stripe_unavailable");
  });
  it("creates only the scoped configured portal and never accepts a foreign customer or return destination", async () => {
    const f = await fixture();
    expect(
      await f.provider.createPortal({
        organizationId,
        customerId: "cus_one",
        requestId: checkoutId,
      }),
    ).toEqual({
      url: "https://billing.stripe.com/p/session/test",
      createdAt: new Date(1788793200000).toISOString(),
    });
    const call = f.requests.find((r) => r.path === "/v1/billing_portal/sessions");
    expect(call?.body.get("customer")).toBe("cus_one");
    expect(call?.body.get("return_url")).toBe(configuration.returnOrigin + "/billing");
    await expect(
      f.provider.createPortal({
        organizationId: "00000000000000000000000003",
        customerId: "cus_one",
        requestId: checkoutId,
      }),
    ).rejects.toThrow();
  });
  it("admits only the paid subscription invoice's verified price, period and actual payment", async () => {
    const f = await fixture();
    const input = { organizationId, customerId: "cus_one", subscriptionId: "sub_one" };
    expect(await f.provider.observePaidInvoice(input)).toMatchObject({
      paymentRequired: false,
      subscriptionEndedAt: null,
      invoice: {
        accountId: "acct_test",
        mode: "test",
        subscriptionId: "sub_one",
        invoiceId: "in_paid",
        paymentIntentId: "pi_paid",
        amountSubtotal: 1000,
        amountTotal: 1210,
        priceId: "price_paid",
      },
    });
    // Stripe's reported end of a cancelled subscription closes Paid; a live one reports none.
    Object.assign(f.retrievedSubscription, { status: "canceled", ended_at: 1793966400 });
    expect(await f.provider.observePaidInvoice(input)).toMatchObject({
      subscriptionEndedAt: "2026-11-06T12:00:00.000Z",
      invoice: { invoiceId: "in_paid" },
    });
    for (const [status, ended] of [
      ["canceled", null],
      ["active", 1793966400],
      ["ended", 1793966400],
    ] as const) {
      Object.assign(f.retrievedSubscription, { status, ended_at: ended });
      await expect(f.provider.observePaidInvoice(input)).rejects.toThrow("stripe_response_invalid");
    }
    Object.assign(f.retrievedSubscription, { status: "past_due", ended_at: null });
    f.invoice.status = "open";
    expect(await f.provider.observePaidInvoice(input)).toEqual({
      invoice: null,
      invoiceId: "in_paid",
      taxIssue: null,
      paymentRequired: true,
      subscriptionEndedAt: null,
    });
    f.invoice.status = "draft";
    expect(await f.provider.observePaidInvoice(input)).toEqual({
      invoice: null,
      invoiceId: "in_paid",
      taxIssue: null,
      paymentRequired: false,
      subscriptionEndedAt: null,
    });
    f.invoice.status = "paid";
    f.invoice.amount_paid = 0;
    await expect(f.provider.observePaidInvoice(input)).rejects.toThrow("stripe_response_invalid");
    f.invoice.amount_paid = 1210;
    f.invoice.customer = "cus_foreign";
    await expect(f.provider.observePaidInvoice(input)).rejects.toThrow("stripe_scope_conflict");
    f.invoice.customer = "cus_one";
    Object.assign(f.session, {
      mode: "subscription",
      subscription: "sub_one",
      invoice: "in_paid",
      payment_intent: null,
      metadata: { ...f.session.metadata, ohmyhost_offer: "paid" },
    });
    expect(
      await f.provider.resolveWebhookEvent({
        id: "evt_refund",
        type: "refund.updated",
        objectId: "re_one",
      }),
    ).toEqual({ organizationId, checkoutId, sessionId: "cs_test_one", invoiceId: "in_paid" });
  });
  it("resolves signed payment/refund identities through the actual provider lookup and rejects conflicting event identity", async () => {
    const f = await fixture();
    Object.assign(f.session, { payment_intent: "pi_paid" });
    const expected = { organizationId, checkoutId, sessionId: "cs_test_one" };
    expect(
      await f.provider.resolveWebhookEvent({
        id: "evt_paid",
        type: "checkout.session.completed",
        objectId: "cs_test_one",
      }),
    ).toEqual(expected);
    Object.assign(f.invoice, { parent: null, billing_reason: "manual" });
    const lookups = f.requests.filter((request) => request.path === "/v1/checkout/sessions").length;
    expect(
      await f.provider.resolveWebhookEvent({
        id: "evt_invoice",
        type: "invoice.paid",
        objectId: "in_paid",
      }),
    ).toBeNull();
    expect(f.requests.filter((request) => request.path === "/v1/checkout/sessions")).toHaveLength(
      lookups,
    );
    f.invoice.billing_reason = "subscription_create";
    await expect(
      f.provider.resolveWebhookEvent({
        id: "evt_invoice",
        type: "invoice.paid",
        objectId: "in_paid",
      }),
    ).rejects.toThrow("stripe_scope_conflict");
    expect(
      await f.provider.resolveWebhookEvent({
        id: "evt_refund",
        type: "refund.updated",
        objectId: "re_one",
      }),
    ).toEqual(expected);
    await expect(
      f.provider.resolveWebhookEvent({
        id: "evt_refund",
        type: "refund.updated",
        objectId: "re_foreign",
      }),
    ).rejects.toThrow("stripe_scope_conflict");
    // A renewal invoice resolves through its subscription, not a new checkout or a refund lookup.
    Object.assign(f.invoice, {
      parent: { subscription_details: { subscription: "sub_one" } },
      billing_reason: "subscription_cycle",
    });
    Object.assign(f.session, {
      mode: "subscription",
      subscription: "sub_one",
      metadata: { ...f.session.metadata, ohmyhost_offer: "paid" },
    });
    const renewalEvent = { id: "evt_invoice", type: "invoice.paid", objectId: "in_paid" };
    expect(await f.provider.resolveWebhookEvent(renewalEvent)).toEqual({
      ...expected,
      invoiceId: "in_paid",
    });
    expect(await f.provider.resolveWebhookEvent(renewalEvent)).toEqual({
      ...expected,
      invoiceId: "in_paid",
    });
    f.behavior.moreSessions = true;
    await expect(f.provider.resolveWebhookEvent(renewalEvent)).rejects.toThrow(
      "stripe_response_invalid",
    );
    f.behavior.moreSessions = false;
    Object.assign(f.session, { subscription: "sub_foreign" });
    await expect(f.provider.resolveWebhookEvent(renewalEvent)).rejects.toThrow(
      "stripe_response_invalid",
    );
    Object.assign(f.session, { subscription: "sub_one" });
    Object.assign(f.session, { metadata: {} });
    expect(
      await f.provider.resolveWebhookEvent({
        id: "evt_paid",
        type: "checkout.session.completed",
        objectId: "cs_test_one",
      }),
    ).toBeNull();
  });
  it("names the recharge and its invoice for the events of a recharge invoice, whether it was paid or refunded", async () => {
    const f = await fixture();
    expect(
      await f.provider.resolveWebhookEvent({
        id: "evt_recharge",
        type: "invoice.paid",
        objectId: "in_recharge",
      }),
    ).toEqual({ organizationId, rechargeId: checkoutId, invoiceId: "in_recharge" });
    // a refund finds its payment's invoice, which carries the recharge
    f.listedSessions.length = 0;
    Object.assign(f.invoice, {
      metadata: {
        ohmyhost_organization_id: organizationId,
        ohmyhost_recharge_id: checkoutId,
      },
    });
    expect(
      await f.provider.resolveWebhookEvent({
        id: "evt_refund",
        type: "refund.updated",
        objectId: "re_one",
      }),
    ).toEqual({ organizationId, rechargeId: checkoutId, invoiceId: "in_paid" });
  });
  it("creates one scoped hosted Checkout using only the server catalog and stable retry identity", async () => {
    const f = await fixture();
    expect(await f.provider.createCustomer({ organizationId, requestId: checkoutId })).toEqual({
      customerId: "cus_one",
    });
    const input = {
      organizationId,
      checkoutId,
      customerId: "cus_one",
      offer: "topup" as const,
      packs: 1,
      expiresAt: new Date(f.session.expires_at * 1000).toISOString(),
      sessionId: null,
    };
    const first = await f.provider.createCheckout(input);
    expect(first).toMatchObject({
      id: "cs_test_one",
      state: "open",
      url: f.session.url,
      organizationId,
      checkoutId,
      paid: false,
    });
    expect(await f.provider.createCheckout(input)).toEqual(first);
    const calls = f.requests.filter((r) => r.path === "/v1/checkout/sessions");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe(calls[1]?.key);
    expect(calls[0]?.body.get("line_items[0][price]")).toBe("price_topup");
    expect(calls[0]?.body.get("automatic_tax[enabled]")).toBe("true");
    expect(calls[0]?.body.get("invoice_creation[enabled]")).toBe("true");
    expect(calls[0]?.body.get("managed_payments[enabled]")).toBe("false");
    expect(calls[0]?.body.get("adaptive_pricing[enabled]")).toBe("false");
    expect(calls[0]?.body.get("success_url")).toBe("https://dev.app.ohmyho.st/billing");
    expect(calls[0]?.body.has("payment_intent_data[setup_future_usage]")).toBe(false);
    expect(await f.provider.expireCheckout({ ...input, sessionId: "cs_test_one" })).toMatchObject({
      state: "expired",
      url: null,
      paid: false,
    });
  });

  it("rejects foreign customers and altered payment facts; paid is based on the verified provider result", async () => {
    expect(() => createStripeBillingProviderFromKey("sk_live_fixture", configuration)).toThrow(
      "stripe_scope_conflict",
    );
    expect(() =>
      createStripeBillingProviderFromKey("sk_test_fixture", { ...configuration, mode: "live" }),
    ).toThrow("stripe_scope_conflict");
    await expect(
      createStripeBillingProviderFromKey("sk_test_fixture", {
        ...configuration,
        returnOrigin: "https://app.ohmyho.st",
      }),
    ).rejects.toThrow("stripe_scope_conflict");
    const f = await fixture();
    const input = {
      organizationId,
      checkoutId,
      customerId: "cus_one",
      offer: "topup" as const,
      packs: 1,
      expiresAt: new Date(f.session.expires_at * 1000).toISOString(),
    };
    f.customer.metadata.ohmyhost_organization_id = "00000000000000000000000009";
    await expect(f.provider.createCheckout(input)).rejects.toThrow();
    expect(f.requests.filter((r) => r.path === "/v1/checkout/sessions")).toHaveLength(0);
    f.customer.metadata.ohmyhost_organization_id = organizationId;
    const original = { ...f.session };
    Object.assign(f.session, {
      status: "complete",
      payment_status: "paid",
      payment_intent: "pi_paid",
      amount_total: 1210,
      url: null,
      automatic_tax: { enabled: true, status: "complete" },
    });
    expect(await f.provider.observeCheckout({ ...input, sessionId: "cs_test_one" })).toMatchObject({
      paid: true,
      amountSubtotal: 1000,
      amountTotal: 1210,
      paymentIntentId: "pi_paid",
      url: null,
    });
    Object.assign(f.session, { amount_subtotal: 1 });
    await expect(
      f.provider.observeCheckout({ ...input, sessionId: "cs_test_one" }),
    ).rejects.toThrow();
    f.behavior.status = 400;
    const failure = await f.provider.createCheckout(input).catch((error) => error);
    expect(failure).toMatchObject({
      code: "stripe_rejected",
      retryable: false,
      provider: { status: 400, code: "parameter_unknown", requestId: "req_fixture" },
    });
    expect(JSON.stringify(failure)).not.toContain("private-provider-message");
    f.behavior.status = 200;
    expect(
      await f.provider.observePaymentReversals({
        organizationId,
        customerId: "cus_one",
        paymentIntentId: "pi_paid",
        amountTotal: 1210,
      }),
    ).toEqual({
      accountId: "acct_test",
      mode: "test",
      customerId: "cus_one",
      paymentIntentId: "pi_paid",
      currency: "usd",
      paymentTotalMinor: 1210,
      items: [{ id: "re_one", amountMinor: 121, status: "succeeded" }],
      disputes: [],
    });
    const movement = {
      id: "txn_out",
      amount: -860,
      fee: 2000,
      net: -2860,
      currency: "eur",
      source: "du_one",
      reporting_category: "dispute",
    };
    const dispute = {
      id: "du_one",
      amount: 1210,
      currency: "usd",
      livemode: false,
      payment_intent: "pi_paid",
      balance_transactions: [movement],
    };
    f.disputes.push(dispute);
    const disputed = await f.provider.observePaymentReversals({
      organizationId,
      customerId: "cus_one",
      paymentIntentId: "pi_paid",
      amountTotal: 1210,
    });
    expect(disputed.disputes).toEqual([
      { id: "du_one", amountMinor: 1210, movements: [{ id: "txn_out", direction: "withdrawn" }] },
    ]);
    expect(JSON.stringify(disputed)).not.toContain("2860");
    Object.assign(dispute, {
      balance_transactions: [
        movement,
        { ...movement, id: "txn_return", amount: 850, reporting_category: "dispute_reversal" },
      ],
    });
    expect(
      (
        await f.provider.observePaymentReversals({
          organizationId,
          customerId: "cus_one",
          paymentIntentId: "pi_paid",
          amountTotal: 1210,
        })
      ).disputes[0]?.movements,
    ).toHaveLength(2);
    await expect(
      f.provider.observePaymentReversals({
        organizationId,
        customerId: "cus_one",
        paymentIntentId: "pi_other",
        amountTotal: 1210,
      }),
    ).rejects.toThrow();
    Object.assign(f.session, original, { livemode: true });
    await expect(
      f.provider.observeCheckout({ ...input, sessionId: "cs_test_one" }),
    ).rejects.toThrow();
  });

  it("verifies the raw webhook signature and mode without returning customer or payment details", async () => {
    const secret = "whsec_fixture";
    const payload = JSON.stringify({
      id: "evt_one",
      object: "event",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_one", customer_details: { email: "private@example.com" } } },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(await verifyStripeWebhook({ ...configuration, payload, signature, secret })).toEqual({
      id: "evt_one",
      type: "checkout.session.completed",
      objectId: "cs_test_one",
    });
    await expect(
      verifyStripeWebhook({ ...configuration, payload: payload + " ", signature, secret }),
    ).rejects.toThrow();
    for (const type of [
      "charge.dispute.updated",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.funds_reinstated",
    ]) {
      const body = JSON.stringify({
        id: "evt_dispute",
        livemode: false,
        type,
        data: { object: { id: "du_one" } },
      });
      expect(
        await verifyStripeWebhook({
          ...configuration,
          payload: body,
          signature: Stripe.webhooks.generateTestHeaderString({ payload: body, secret }),
          secret,
        }),
      ).toEqual({ id: "evt_dispute", type, objectId: "du_one" });
    }
    const wrong = payload.replace('"livemode":false', '"livemode":true');
    await expect(
      verifyStripeWebhook({
        ...configuration,
        payload: wrong,
        signature: Stripe.webhooks.generateTestHeaderString({ payload: wrong, secret }),
        secret,
      }),
    ).rejects.toThrow();
  });
});

describe("closing a deleted organization's Stripe billing", () => {
  it.each([
    [
      "makes at most twenty changes in one pass and leaves the rest to a later pass, which cancels each subscription once",
      async () => {
        const f = await fixture();
        const scope = { organizationId, customerId: "cus_one" };
        f.subscriptions.push(
          ...Array.from({ length: 25 }, (_, index) => ({
            id: `sub_live_${index + 1}`,
            customer: "cus_one",
            livemode: false,
            status: "active",
          })),
        );
        f.cards.push({
          id: "pm_one",
          object: "payment_method",
          type: "card",
          customer: "cus_one",
          livemode: false,
        });
        // twenty-six changes: the first pass cancels twenty subscriptions, detaches nothing and is not closed
        expect(await f.provider.closeCustomer(scope)).toEqual({ closed: false });
        expect(cancelledSubscriptions(f)).toHaveLength(20);
        expect(detachedCards(f)).toEqual([]);
        expect(f.cards).toHaveLength(1);
        // the next pass cancels the five that are left, detaches the card, and closes the customer
        expect(await f.provider.closeCustomer(scope)).toEqual({ closed: true });
        expect(cancelledSubscriptions(f)).toHaveLength(25);
        expect(new Set(cancelledSubscriptions(f)).size).toBe(25);
        expect(detachedCards(f)).toEqual(["/v1/payment_methods/pm_one/detach"]);
        expect(f.cards).toHaveLength(0);
      },
    ],
    [
      "leaves a subscription that has already ended alone, and closes the customer",
      async () => {
        const f = await fixture();
        const scope = { organizationId, customerId: "cus_one" };
        f.subscriptions.push(
          { id: "sub_ended", customer: "cus_one", livemode: false, status: "canceled" },
          { id: "sub_live", customer: "cus_one", livemode: false, status: "active" },
        );
        expect(await f.provider.closeCustomer(scope)).toEqual({ closed: true });
        expect(cancelledSubscriptions(f)).toEqual(["sub_live"]);
        expect(f.subscriptions.map((row) => row["status"])).toEqual(["canceled", "canceled"]);
      },
    ],
  ])("%s", async (_name, scenario) => {
    await scenario();
  });
});
