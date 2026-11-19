import { Buffer } from "node:buffer";
import { URL, URLSearchParams } from "node:url";
import { it, expect } from "vitest";
import { createServer } from "node:http";
import Stripe from "stripe";
import { createStripeBillingProvider, verifyStripeWebhook } from "./index.ts";

it("finds the paid recharge invoice behind a full first page of paid invoices by following starting_after", async () => {
  const org = "00000000000000000000000001",
    recharge = "00000000000000000000000005";
  const config = {
    accountId: "acct_test",
    mode: "test",
    paidPriceId: "price_paid",
    topupPriceId: "price_topup",
    returnOrigin: "https://dev.app.ohmyho.st",
  };
  const now = Math.floor(Date.now() / 1000);
  const others = Array.from({ length: 100 }, (_, index) => ({
    id: `in_other_${String(index).padStart(3, "0")}`,
    customer: "cus_one",
    status: "paid",
    metadata: {},
    status_transitions: { paid_at: now },
  }));
  const pages = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://local");
    let result;
    if (url.pathname === "/v1/account") result = { id: "acct_test" };
    else if (url.pathname.startsWith("/v1/prices/"))
      result = {
        id: url.pathname.split("/").pop(),
        active: true,
        livemode: false,
        currency: "usd",
        unit_amount: 1000,
        tax_behavior: "exclusive",
        product: "prod_topup",
        recurring: url.pathname.endsWith("price_paid")
          ? { interval: "month", interval_count: 1 }
          : null,
      };
    else if (url.pathname === "/v1/customers/cus_one")
      result = {
        id: "cus_one",
        livemode: false,
        metadata: { ohmyhost_organization_id: org },
        tax: { automatic_tax: "supported" },
      };
    else if (url.pathname === "/v1/invoices" && url.searchParams.get("status") === "paid") {
      const after = url.searchParams.get("starting_after");
      pages.push(after);
      result =
        after === null
          ? { object: "list", has_more: true, data: others }
          : after === others.at(-1).id
            ? {
                object: "list",
                has_more: false,
                data: [
                  {
                    id: "in_recharge_last",
                    customer: "cus_one",
                    status: "paid",
                    metadata: { ohmyhost_organization_id: org, ohmyhost_recharge_id: recharge },
                    status_transitions: { paid_at: now },
                  },
                ],
              }
            : { object: "list", has_more: false, data: [] };
    } else {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const stripe = new Stripe("sk_test_local", {
      host: "127.0.0.1",
      port: server.address().port,
      protocol: "http",
      maxNetworkRetries: 0,
    });
    const p = await createStripeBillingProvider(stripe, config);
    expect(
      await p.findPaidRechargeInvoices({
        organizationId: org,
        customerId: "cus_one",
        paidSince: new Date(Date.now() - 86400 * 1000),
      }),
    ).toEqual([{ rechargeId: recharge, invoiceId: "in_recharge_last" }]);
    expect(pages).toEqual([null, others.at(-1).id]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

it("uses off-session card setup and invoice-first collection with exact scope, gross limits and no Stripe retry automation", async () => {
  const org = "00000000000000000000000001",
    id = "00000000000000000000000002";
  const config = {
    accountId: "acct_test",
    mode: "test",
    paidPriceId: "price_paid",
    topupPriceId: "price_topup",
    returnOrigin: "https://dev.app.ohmyho.st",
  };
  const requests = [];
  let setupDone = false,
    expired = false,
    decline = false,
    badInvoice = false,
    badCustomer = false,
    moreInvoices = false,
    invalidTax = false;
  const invoices = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    const url = new URL(req.url, "http://local");
    const path = url.pathname;
    requests.push({ path, body, key: req.headers["idempotency-key"] });
    let result;
    if (path === "/v1/account") result = { id: "acct_test" };
    else if (path.startsWith("/v1/prices/"))
      result = {
        id: path.split("/").pop(),
        active: true,
        livemode: false,
        currency: "usd",
        unit_amount: 1000,
        tax_behavior: "exclusive",
        product: "prod_topup",
        recurring: path.endsWith("price_paid") ? { interval: "month", interval_count: 1 } : null,
      };
    else if (path === "/v1/customers/cus_one")
      result = {
        id: "cus_one",
        livemode: false,
        metadata: { ohmyhost_organization_id: badCustomer ? "00000000000000000000000009" : org },
        tax: { automatic_tax: invalidTax ? "unrecognized_location" : "supported" },
      };
    else if (path === "/v1/checkout/sessions" || path === "/v1/checkout/sessions/cs_test_one")
      result = {
        id: "cs_test_one",
        mode: "setup",
        livemode: false,
        customer: "cus_one",
        client_reference_id: id,
        metadata: { ohmyhost_organization_id: org, ohmyhost_recharge_id: id },
        status: expired ? "expired" : setupDone ? "complete" : "open",
        url: setupDone ? null : "https://checkout.stripe.com/c/pay/test",
        setup_intent: setupDone
          ? {
              id: "seti_one",
              status: "succeeded",
              usage: "off_session",
              customer: "cus_one",
              livemode: false,
              payment_method: "pm_one",
              metadata: { ohmyhost_organization_id: org, ohmyhost_recharge_id: id },
            }
          : null,
      };
    else if (path === "/v1/subscriptions/sub_tax")
      result = {
        id: "sub_tax",
        customer: "cus_one",
        livemode: false,
        status: "active",
        ended_at: null,
        latest_invoice: "in_tax_subscription",
        automatic_tax: { enabled: true },
        items: { has_more: false, data: [{ quantity: 1, price: { id: "price_paid" } }] },
      };
    else if (path === "/v1/payment_methods/pm_one")
      result = { id: "pm_one", type: "card", customer: "cus_one", livemode: false };
    else if (path === "/v1/invoices" && req.method === "GET")
      result = {
        object: "list",
        has_more: moreInvoices,
        data: [...invoices.values()].filter(
          (invoice) =>
            invoice.customer === url.searchParams.get("customer") &&
            invoice.status === url.searchParams.get("status"),
        ),
      };
    else if (path === "/v1/invoices" && req.method === "POST") {
      const identity = body.get("metadata[ohmyhost_recharge_id]");
      const invoiceId = "in_" + identity;
      if (!invoices.has(invoiceId))
        invoices.set(invoiceId, {
          id: invoiceId,
          customer: "cus_one",
          livemode: false,
          currency: "usd",
          auto_advance: false,
          collection_method: "charge_automatically",
          parent: null,
          status: "draft",
          metadata: { ohmyhost_organization_id: org, ohmyhost_recharge_id: identity },
          lines: { has_more: false, data: [] },
          total: 0,
          subtotal: 0,
          automatic_tax: { enabled: true, status: null },
          hosted_invoice_url: null,
        });
      result = invoices.get(invoiceId);
    } else if (path === "/v1/invoiceitems") {
      const invoice = invoices.get(body.get("invoice"));
      invoice.lines.data = [{ quantity: 1, amount: 900 }];
      invoice.subtotal = 900;
      result = { id: "ii_one" };
    } else if (path.startsWith("/v1/invoices/")) {
      const invoice = invoices.get(path.split("/")[3]);
      if (path.endsWith("/finalize") && invalidTax) {
        Object.assign(invoice, {
          automatic_tax: { enabled: true, status: "requires_location_inputs" },
          last_finalization_error: {
            code: "customer_tax_location_invalid",
            message: "private-address-canary",
          },
        });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "customer_tax_location_invalid",
              message: "private-address-canary",
            },
          }),
        );
        return;
      }
      if (path.endsWith("/finalize"))
        Object.assign(invoice, {
          last_finalization_error: null,
          status: "open",
          total: 1089,
          automatic_tax: { enabled: true, status: "complete" },
          hosted_invoice_url: "https://invoice.stripe.com/i/test",
        });
      if (path.endsWith("/pay")) {
        if (decline) {
          res.writeHead(402, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { type: "card_error", code: "card_declined", message: "Test decline" },
            }),
          );
          return;
        }
        Object.assign(invoice, {
          status: "paid",
          amount_paid: 1089,
          amount_remaining: 0,
          payments: {
            has_more: false,
            data: [
              {
                status: "paid",
                amount_paid: 1089,
                payment: {
                  type: "payment_intent",
                  payment_intent: {
                    id: "pi_one",
                    status: "succeeded",
                    customer: "cus_one",
                    currency: "usd",
                    livemode: false,
                    amount_received: 1089,
                  },
                },
              },
            ],
          },
        });
      }
      if (path.endsWith("/void")) invoice.status = "void";
      result =
        req.method === "DELETE"
          ? { id: invoice.id, deleted: true }
          : { ...invoice, auto_advance: badInvoice ? true : invoice.auto_advance };
    }
    if (!result) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const stripe = new Stripe("sk_test_local", {
      host: "127.0.0.1",
      port: server.address().port,
      protocol: "http",
      maxNetworkRetries: 0,
    });
    const p = await createStripeBillingProvider(stripe, config);
    const s = {
      organizationId: org,
      customerId: "cus_one",
      id,
      createdAt: new Date().toISOString(),
    };
    expect((await p.rechargeSetup({ ...s, sessionId: null })).url).toMatch(
      /^https:\/\/checkout.stripe.com/,
    );
    expect(
      requests
        .find((r) => r.path === "/v1/checkout/sessions")
        .body.get("managed_payments[enabled]"),
    ).toBe("false");
    const setupRequest = requests.find((r) => r.path === "/v1/checkout/sessions");
    expect(setupRequest.body.get("branding_settings[display_name]")).toBe("ohmyho.st");
    expect(setupRequest.body.get("branding_settings[font_family]")).toBe("inter");
    expect(setupRequest.body.get("branding_settings[icon][url]")).toBe(
      "https://ohmyho.st/brand/assets/omega-light.png",
    );
    expect(setupRequest.body.get("success_url")).toBe("https://dev.app.ohmyho.st/billing");
    expect(setupRequest.body.has("automatic_tax[enabled]")).toBe(false);
    setupDone = true;
    expect((await p.rechargeSetup({ ...s, sessionId: "cs_test_one" })).paymentMethodId).toBe(
      "pm_one",
    );
    setupDone = false;
    expired = true;
    expect((await p.rechargeSetup({ ...s, sessionId: "cs_test_one" })).expired).toBe(true);
    await expect(
      p.rechargeSetup({ ...s, createdAt: "2020-01-01T00:00:00.000Z", sessionId: null }),
    ).rejects.toThrow("billing_needs_reconciliation");
    const invoice = await p.createRechargeInvoice({ ...s, paymentMethodId: "pm_one" }),
      target = { ...s, invoiceId: invoice.invoiceId };
    expect(invoice.state).toBe("draft");
    invalidTax = true;
    const blocked = await p.finalizeRechargeInvoice(target);
    expect(blocked).toMatchObject({
      invoiceId: invoice.invoiceId,
      state: "draft",
      taxIssue: "billing_tax_location_required",
    });
    expect(JSON.stringify(blocked)).not.toContain("private-address-canary");
    const finalizeCount = requests.filter((r) => r.path.endsWith("/finalize")).length;
    expect(
      (await p.finalizeRechargeInvoice({ ...target, retryAfterTaxCorrection: true })).state,
    ).toBe("draft");
    expect(requests.filter((r) => r.path.endsWith("/finalize"))).toHaveLength(finalizeCount);
    invalidTax = false;
    const finalized = await p.finalizeRechargeInvoice({ ...target, retryAfterTaxCorrection: true });
    const finalizations = requests.filter((r) => r.path.endsWith("/finalize"));
    expect(finalizations[0].key).not.toBe(finalizations[1].key);
    expect(requests.filter((r) => r.path === "/v1/invoices")).toHaveLength(1);
    expect(finalized.taxIssue).toBeNull();
    for (const type of ["invoice.updated", "invoice.finalization_failed"]) {
      const payload = JSON.stringify({
        id: "evt_tax",
        type,
        livemode: false,
        data: { object: { id: invoice.invoiceId, object: "invoice" } },
      });
      const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_tax" });
      expect(
        await verifyStripeWebhook({
          payload,
          signature,
          secret: "whsec_tax",
          mode: "test",
          accountId: "acct_test",
        }),
      ).toEqual({ id: "evt_tax", type, objectId: invoice.invoiceId });
      await expect(
        verifyStripeWebhook({
          payload: payload + " ",
          signature,
          secret: "whsec_tax",
          mode: "test",
          accountId: "acct_test",
        }),
      ).rejects.toThrow("stripe_webhook_invalid");
    }
    expect(finalized.totalMinor).toBe(1089);
    expect((await p.finalizeRechargeInvoice(target)).state).toBe("open");
    await expect(
      p.payRechargeInvoice({ ...target, paymentMethodId: "pm_one", maximumMinor: 1000 }),
    ).rejects.toThrow("billing_conflict");
    expect(requests.filter((r) => r.path.endsWith("/pay"))).toHaveLength(0);
    decline = true;
    expect(
      (await p.payRechargeInvoice({ ...target, paymentMethodId: "pm_one", maximumMinor: 2000 }))
        .state,
    ).toBe("open");
    decline = false;
    expect(
      (await p.payRechargeInvoice({ ...target, paymentMethodId: "pm_one", maximumMinor: 2000 }))
        .paymentIntentId,
    ).toBe("pi_one");
    expect(
      requests
        .filter((r) => r.path.endsWith("/pay"))
        .every((r) => r.body.get("off_session") === "true"),
    ).toBe(true);
    expect(requests.find((r) => r.path === "/v1/invoices").body.get("auto_advance")).toBe("false");
    expect(
      requests.find((r) => r.path === "/v1/invoiceitems").body.get("price_data[unit_amount]"),
    ).toBe("900");
    badInvoice = true;
    await expect(p.observeRechargeInvoice(target)).rejects.toThrow("stripe_scope_conflict");
    badInvoice = false;
    badCustomer = true;
    await expect(p.observeRechargeInvoice(target)).rejects.toThrow("stripe_scope_conflict");
    badCustomer = false;
    const draftScope = { ...s, id: "00000000000000000000000003", paymentMethodId: "pm_one" };
    const draft = await p.createRechargeInvoice(draftScope);
    await p.voidRechargeInvoice({ ...draftScope, invoiceId: draft.invoiceId });
    const openScope = { ...s, id: "00000000000000000000000004", paymentMethodId: "pm_one" };
    const open = await p.createRechargeInvoice(openScope);
    const openTarget = { ...openScope, invoiceId: open.invoiceId };
    await p.finalizeRechargeInvoice(openTarget);
    await p.voidRechargeInvoice(openTarget);
    expect((await p.observeRechargeInvoice(openTarget)).state).toBe("void");
    await p.voidRechargeInvoice(openTarget);
    await expect(p.voidRechargeInvoice(target)).rejects.toThrow("billing_conflict");
    const paidAt = Math.floor(Date.now() / 1000);
    const subscriptionInvoice = {
      ...globalThis.structuredClone(invoices.get(invoice.invoiceId)),
      id: "in_tax_subscription",
      parent: { subscription_details: { subscription: "sub_tax" } },
      billing_reason: "subscription_cycle",
      automatic_tax: { enabled: false, status: null },
      subtotal: 1000,
      total: 1210,
      amount_paid: 1210,
      amount_remaining: 0,
      status_transitions: { paid_at: paidAt },
      lines: {
        has_more: false,
        data: [
          {
            quantity: 1,
            amount: 1000,
            pricing: { price_details: { price: "price_paid" } },
            parent: { subscription_item_details: { proration: false, subscription: "sub_tax" } },
            period: { start: paidAt, end: paidAt + 30 * 86400 },
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
                id: "pi_subscription",
                status: "succeeded",
                customer: "cus_one",
                livemode: false,
                currency: "usd",
                amount_received: 1210,
              },
            },
          },
        ],
      },
    };
    invoices.set(subscriptionInvoice.id, subscriptionInvoice);
    const subscriptionScope = {
      organizationId: org,
      customerId: "cus_one",
      subscriptionId: "sub_tax",
    };
    expect(await p.observePaidInvoice(subscriptionScope)).toMatchObject({
      invoice: {
        invoiceId: "in_tax_subscription",
        paymentIntentId: "pi_subscription",
        amountTotal: 1210,
      },
      invoiceId: "in_tax_subscription",
      paymentRequired: true,
      taxIssue: "billing_tax_configuration_required",
    });
    subscriptionInvoice.amount_paid = 0;
    await expect(p.observePaidInvoice(subscriptionScope)).rejects.toThrow(
      "stripe_response_invalid",
    );
    subscriptionInvoice.amount_paid = 1210;
    Object.assign(subscriptionInvoice, {
      status: "draft",
      automatic_tax: { enabled: true, status: "requires_location_inputs" },
    });
    expect(await p.observePaidInvoice(subscriptionScope)).toMatchObject({
      invoice: null,
      paymentRequired: true,
      taxIssue: "billing_tax_location_required",
    });
    subscriptionInvoice.customer = "cus_foreign";
    await expect(p.observePaidInvoice(subscriptionScope)).rejects.toThrow("stripe_scope_conflict");
    await expect(
      p.createRechargeInvoice({
        ...s,
        paymentMethodId: "pm_one",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("billing_needs_reconciliation");
    // the recharge invoices that are neither paid nor void are found by the customer, and only the recharge ones
    const draftTwo = await p.createRechargeInvoice({
      ...s,
      id: "00000000000000000000000005",
      paymentMethodId: "pm_one",
    });
    const openScope2 = { ...s, id: "00000000000000000000000006", paymentMethodId: "pm_one" };
    const openTwo = await p.createRechargeInvoice(openScope2);
    await p.finalizeRechargeInvoice({ ...openScope2, invoiceId: openTwo.invoiceId });
    invoices.set("in_not_a_recharge", {
      ...globalThis.structuredClone(invoices.get(draftTwo.invoiceId)),
      id: "in_not_a_recharge",
      metadata: {},
    });
    const found = await p.findRechargeInvoices({ organizationId: org, customerId: "cus_one" });
    expect(found.map((row) => row.rechargeId)).toEqual(
      expect.arrayContaining(["00000000000000000000000005", "00000000000000000000000006"]),
    );
    expect(found.find((row) => row.rechargeId === "00000000000000000000000005")).toMatchObject({
      invoiceId: draftTwo.invoiceId,
      state: "draft",
    });
    expect(found.find((row) => row.rechargeId === "00000000000000000000000006")).toMatchObject({
      invoiceId: openTwo.invoiceId,
      state: "open",
      url: "https://invoice.stripe.com/i/test",
    });
    expect(found.some((row) => row.invoiceId === "in_not_a_recharge")).toBe(false);
    expect(found.some((row) => ["paid", "void"].includes(row.state))).toBe(false);
    moreInvoices = true;
    await expect(
      p.findRechargeInvoices({ organizationId: org, customerId: "cus_one" }),
    ).rejects.toThrow("stripe_response_invalid");
    // the paid ones are found by who paid them and when, without trusting more than their identity
    const paidInvoice = (id, owner, paidAt) => ({
      ...globalThis.structuredClone(invoices.get(draftTwo.invoiceId)),
      id,
      status: "paid",
      metadata: {
        ohmyhost_organization_id: owner,
        ohmyhost_recharge_id: draftTwo.invoiceId.slice(3),
      },
      status_transitions: { paid_at: paidAt },
    });
    const now = Math.floor(Date.now() / 1000);
    invoices.set("in_paid_recent", paidInvoice("in_paid_recent", org, now - 3600));
    invoices.set("in_paid_old", paidInvoice("in_paid_old", org, now - 40 * 86400));
    invoices.set("in_paid_other", paidInvoice("in_paid_other", "00000000000000000000000009", now));
    invoices.set("in_paid_unknown", paidInvoice("in_paid_unknown", org, undefined));
    moreInvoices = false;
    const since = new Date(Date.now() - 86400 * 1000);
    expect(
      await p.findPaidRechargeInvoices({
        organizationId: org,
        customerId: "cus_one",
        paidSince: since,
      }),
    ).toEqual([{ rechargeId: draftTwo.invoiceId.slice(3), invoiceId: "in_paid_recent" }]);
    moreInvoices = true;
    await expect(
      p.findPaidRechargeInvoices({ organizationId: org, customerId: "cus_one", paidSince: since }),
    ).rejects.toThrow("stripe_response_invalid");
    moreInvoices = false;
    badCustomer = true;
    await expect(
      p.findRechargeInvoices({ organizationId: org, customerId: "cus_one" }),
    ).rejects.toThrow("stripe_scope_conflict");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
