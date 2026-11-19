// A closed fixture of the Stripe REST API, enough for the Billing Worker's whole use of it: customers, Checkout
// sessions (created already paid), subscriptions, invoices, payment intents, refunds, disputes, events and the portal.
// The real Stripe SDK talks to it through `fetch`, so the product code under test is the code that runs in production.

export type Row = Record<string, unknown>;

const list = (data: Row[], hasMore = false) => ({ object: "list", data, has_more: hasMore });
const price = (id: string) => ({
  id,
  object: "price",
  active: true,
  livemode: false,
  currency: "usd",
  unit_amount: 1000,
  tax_behavior: "exclusive",
  recurring: id === "price_paid" ? { interval: "month", interval_count: 1 } : null,
  product: "prod_fixture",
});

export function createStripeFixture(account: string, secret = "sk_test_billing_worker_fixture") {
  const customers = new Map<string, Row>(),
    sessions = new Map<string, Row>(),
    invoices = new Map<string, Row>(),
    subscriptions = new Map<string, Row>(),
    payments = new Map<string, Row>(),
    events = new Map<string, Row>(),
    refunds = new Map<string, Row[]>(),
    disputes = new Map<string, Row[]>(),
    taxIssues = new Set<string>(),
    cards = new Set<string>(),
    declines = new Set<string>(),
    stuck = new Set<string>(),
    refusedCancels = new Set<string>(),
    gross = new Map<string, number>(),
    setupsOpen = new Set<string>(),
    pays = new Map<string, number>(),
    state = { calls: 0, moreInvoices: false };

  function payment(id: string, customer: string, total: number) {
    const intent = {
      id,
      object: "payment_intent",
      status: "succeeded",
      customer,
      currency: "usd",
      livemode: false,
      amount_received: total,
    };
    payments.set(id, intent);
    return intent;
  }
  function paidInvoice(id: string, customer: string, subscription: string) {
    const seconds = Math.floor(Date.now() / 1000),
      intent = payment(`pi_${id}`, customer, 1000);
    return {
      id,
      object: "invoice",
      livemode: false,
      customer,
      parent: { subscription_details: { subscription } },
      currency: "usd",
      status: "paid",
      billing_reason: "subscription_create",
      subtotal: 1000,
      total: 1000,
      amount_paid: 1000,
      amount_remaining: 0,
      automatic_tax: { enabled: true, status: "complete" },
      status_transitions: { paid_at: seconds },
      lines: list([
        {
          quantity: 1,
          amount: 1000,
          pricing: { price_details: { price: "price_paid" } },
          parent: { subscription_item_details: { proration: false, subscription } },
          period: { start: seconds, end: seconds + 30 * 86400 },
        },
      ]),
      payments: list([
        {
          status: "paid",
          amount_paid: 1000,
          payment: { type: "payment_intent", payment_intent: intent },
        },
      ]),
    };
  }
  /** Marks a recharge invoice as paid the way Stripe does after a successful charge. */
  function collect(invoice: Row) {
    const total = Number(invoice["total"]),
      intent = payment(`pi_${String(invoice["id"])}`, String(invoice["customer"]), total);
    Object.assign(invoice, {
      status: "paid",
      amount_paid: total,
      amount_remaining: 0,
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      payments: list([
        {
          status: "paid",
          amount_paid: total,
          payment: { type: "payment_intent", payment_intent: intent },
        },
      ]),
    });
  }

  async function request(input: Request): Promise<Response> {
    state.calls++;
    const url = new URL(input.url),
      path = url.pathname;
    if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected origin ${url.origin}`);
    if (input.headers.get("authorization") !== `Bearer ${secret}`)
      throw new Error("Unexpected Stripe credential");
    const params = new URLSearchParams(input.method === "POST" ? await input.text() : ""),
      json = (value: unknown) =>
        Response.json(value ?? {}, { status: value === undefined ? 404 : 200 });
    if (path === "/v1/account") return json({ id: account, object: "account" });
    if (path.startsWith("/v1/prices/")) return json(price(path.split("/").at(-1) ?? ""));
    if (path === "/v1/customers" && input.method === "POST") {
      const org = params.get("metadata[ohmyhost_organization_id]") ?? "",
        id = `cus_${org}`,
        row = {
          id,
          object: "customer",
          livemode: false,
          metadata: {
            ohmyhost_organization_id: org,
            ohmyhost_customer_request_id: params.get("metadata[ohmyhost_customer_request_id]"),
          },
          tax: { automatic_tax: "supported" },
        };
      customers.set(id, row);
      return json(row);
    }
    if (path === "/v1/customers/search") {
      // the metadata search of an organization's customer by its request id; Stripe answers the matches of the query
      const query = url.searchParams.get("query") ?? "",
        organization = /metadata\['ohmyhost_organization_id'\]:'([^']+)'/u.exec(query)?.[1],
        request = /metadata\['ohmyhost_customer_request_id'\]:'([^']+)'/u.exec(query)?.[1];
      return json({
        object: "search_result",
        has_more: false,
        data: [...customers.values()].filter(
          (row) =>
            (row["metadata"] as Row)["ohmyhost_organization_id"] === organization &&
            (row["metadata"] as Row)["ohmyhost_customer_request_id"] === request,
        ),
      });
    }
    if (path.startsWith("/v1/customers/")) {
      const row = customers.get(path.split("/").at(-1) ?? "");
      return json(
        row
          ? {
              ...row,
              tax: {
                automatic_tax: taxIssues.has(
                  String((row["metadata"] as Row)["ohmyhost_organization_id"]),
                )
                  ? "unsupported"
                  : "supported",
              },
            }
          : undefined,
      );
    }
    if (path === "/v1/subscriptions")
      return json(
        list(
          [...subscriptions.values()].filter(
            (row) => row["customer"] === url.searchParams.get("customer"),
          ),
        ),
      );
    if (path.startsWith("/v1/subscriptions/") && input.method === "DELETE") {
      const id = path.split("/").at(-1) ?? "";
      // a cancellation that Stripe refuses for now, so the closure of the customer stays unfinished
      if (refusedCancels.has(id))
        return Response.json(
          { error: { type: "invalid_request_error", code: "resource_missing" } },
          { status: 400 },
        );
      // cancelled at once: the subscription bills nothing again
      const row = subscriptions.get(id);
      if (row) row["status"] = "canceled";
      return json(row);
    }
    if (path.startsWith("/v1/subscriptions/"))
      return json(subscriptions.get(path.split("/").at(-1) ?? ""));
    if (path === "/v1/checkout/sessions" && input.method === "GET")
      return json(
        list(
          [...sessions.values()].filter(
            (s) =>
              (!url.searchParams.has("customer") ||
                s["customer"] === url.searchParams.get("customer")) &&
              (!url.searchParams.has("subscription") ||
                s["subscription"] === url.searchParams.get("subscription")) &&
              (!url.searchParams.has("payment_intent") ||
                s["payment_intent"] === url.searchParams.get("payment_intent")),
          ),
        ),
      );
    if (path === "/v1/checkout/sessions" && input.method === "POST") {
      const org = params.get("metadata[ohmyhost_organization_id]") ?? "",
        id = params.get("client_reference_id") ?? "",
        customer = params.get("customer") ?? "";
      if (params.get("mode") === "setup") {
        // an organization in `setupsOpen` gets a session that waits for its card, retrievable by id
        const open = setupsOpen.has(org);
        const row: Row = {
          id: `cs_${id}`,
          object: "checkout.session",
          mode: "setup",
          customer,
          client_reference_id: id,
          livemode: false,
          metadata: { ohmyhost_organization_id: org, ohmyhost_recharge_id: id },
          status: open ? "open" : "complete",
          url: open ? `https://checkout.stripe.com/c/pay/cs_${id}` : null,
          setup_intent: open
            ? null
            : {
                status: "succeeded",
                usage: "off_session",
                customer,
                livemode: false,
                payment_method: `pm_${org}`,
                metadata: { ohmyhost_organization_id: org, ohmyhost_recharge_id: id },
              },
        };
        if (open) sessions.set(row["id"] as string, row);
        return json(row);
      }
      const offer = params.get("metadata[ohmyhost_offer]") ?? "",
        quantity = Number(params.get("line_items[0][quantity]")),
        sub = offer === "paid" ? `sub_${id}` : null,
        invoice = offer === "paid" ? `in_${id}` : null,
        pi = offer === "topup" ? `pi_${id}` : null;
      if (sub && invoice) {
        subscriptions.set(sub, {
          id: sub,
          customer,
          livemode: false,
          status: "active",
          ended_at: null,
          latest_invoice: invoice,
          automatic_tax: { enabled: true },
          items: list([{ quantity: 1, price: { id: "price_paid" } }]),
        });
        invoices.set(invoice, paidInvoice(invoice, customer, sub));
      } else if (pi) payment(pi, customer, 1000 * quantity);
      const row = {
        id: `cs_${id}`,
        object: "checkout.session",
        mode: params.get("mode"),
        customer,
        client_reference_id: id,
        metadata: {
          ohmyhost_organization_id: org,
          ohmyhost_checkout_id: id,
          ohmyhost_offer: offer,
        },
        livemode: false,
        status: "complete",
        payment_status: "paid",
        currency: "usd",
        amount_subtotal: 1000 * quantity,
        amount_total: 1000 * quantity,
        automatic_tax: { enabled: true, status: "complete" },
        total_details: { amount_discount: 0 },
        line_items: list([
          { quantity, price: price(offer === "paid" ? "price_paid" : "price_topup") },
        ]),
        expires_at: Number(params.get("expires_at")),
        url: null,
        subscription: sub,
        invoice,
        payment_intent: pi,
      };
      sessions.set(row.id, row);
      return json(row);
    }
    if (path.startsWith("/v1/checkout/sessions/"))
      return json(sessions.get(path.split("/").at(-1) ?? ""));
    if (path === "/v1/payment_methods" && input.method === "GET")
      // the cards attached to the customer (`pm_<org>` belongs to `cus_<org>`)
      return json(
        list(
          [...cards]
            .filter((id) => `cus_${id.slice(3)}` === url.searchParams.get("customer"))
            .map((id) => ({
              id,
              object: "payment_method",
              type: "card",
              customer: `cus_${id.slice(3)}`,
              livemode: false,
            })),
        ),
      );
    if (path.startsWith("/v1/payment_methods/") && path.endsWith("/detach")) {
      const id = path.split("/").at(-2) ?? "";
      cards.delete(id);
      return json({ id, object: "payment_method", type: "card", customer: null, livemode: false });
    }
    if (path.startsWith("/v1/payment_methods/")) {
      const org = path.split("/").at(-1)?.slice(3) ?? "";
      return json({ id: `pm_${org}`, type: "card", customer: `cus_${org}`, livemode: false });
    }
    if (path === "/v1/invoices" && input.method === "GET")
      return json(
        list(
          [...invoices.values()].filter(
            (row) =>
              row["customer"] === url.searchParams.get("customer") &&
              row["status"] === url.searchParams.get("status"),
          ),
          state.moreInvoices,
        ),
      );
    if (path === "/v1/invoices" && input.method === "POST") {
      const org = params.get("metadata[ohmyhost_organization_id]") ?? "",
        recharge = params.get("metadata[ohmyhost_recharge_id]") ?? "",
        id = `in_${recharge}`;
      const row = {
        id,
        object: "invoice",
        customer: params.get("customer"),
        livemode: false,
        metadata: { ohmyhost_organization_id: org, ohmyhost_recharge_id: recharge },
        currency: "usd",
        auto_advance: false,
        collection_method: "charge_automatically",
        parent: null,
        status: "draft",
        subtotal: 900,
        total: gross.get(org) ?? 1000,
        automatic_tax: {
          enabled: true,
          status: taxIssues.has(org) ? "requires_location_inputs" : "complete",
        },
        lines: list([]),
        hosted_invoice_url: `https://invoice.stripe.com/${id}`,
      };
      invoices.set(id, row);
      return json(row);
    }
    if (path === "/v1/invoiceitems") {
      const row = invoices.get(params.get("invoice") ?? "");
      if (row) row["lines"] = list([{ quantity: 1, amount: 900 }]);
      return json({ id: "ii_fixture" });
    }
    if (path.startsWith("/v1/invoices/")) {
      const id = path.split("/")[3] ?? "",
        row = invoices.get(id);
      if (!row) return json(undefined);
      if (path.endsWith("/finalize")) {
        row["status"] = "open";
        row["automatic_tax"] = {
          enabled: true,
          status: taxIssues.has(String((row["metadata"] as Row)["ohmyhost_organization_id"]))
            ? "requires_location_inputs"
            : "complete",
        };
      }
      if (path.endsWith("/pay")) {
        const org = String((row["metadata"] as Row)["ohmyhost_organization_id"]);
        if (declines.has(org))
          return Response.json(
            { error: { type: "card_error", code: "card_declined", message: "declined" } },
            { status: 402 },
          );
        pays.set(org, (pays.get(org) ?? 0) + 1);
        collect(row);
      }
      if (path.endsWith("/void") || input.method === "DELETE") {
        // an invoice whose payment is under way cannot be withdrawn
        if (stuck.has(String((row["metadata"] as Row)["ohmyhost_organization_id"])))
          return Response.json(
            { error: { type: "invalid_request_error", code: "invoice_not_editable" } },
            { status: 400 },
          );
        row["status"] = "void";
      }
      return json(row);
    }
    if (path.startsWith("/v1/payment_intents/"))
      return json(payments.get(path.split("/").at(-1) ?? ""));
    if (path === "/v1/invoice_payments") {
      const intent = url.searchParams.get("payment[payment_intent]") ?? "",
        invoice = [...invoices.values()].find(
          (row) => `pi_${String(row["id"])}` === intent && row["status"] === "paid",
        );
      return json(
        list(
          invoice
            ? [
                {
                  id: `inpay_${intent}`,
                  invoice: invoice["id"],
                  status: "paid",
                  payment: { type: "payment_intent", payment_intent: intent },
                },
              ]
            : [],
        ),
      );
    }
    if (path === "/v1/refunds")
      return json(list(refunds.get(url.searchParams.get("payment_intent") ?? "") ?? []));
    if (path === "/v1/disputes")
      return json(list(disputes.get(url.searchParams.get("payment_intent") ?? "") ?? []));
    if (path.startsWith("/v1/events/")) return json(events.get(path.split("/").at(-1) ?? ""));
    if (path === "/v1/billing_portal/configurations/bpc_fixture")
      return json({
        id: "bpc_fixture",
        active: true,
        livemode: false,
        default_return_url: "https://dev.app.ohmyho.st/billing",
        features: {
          customer_update: { enabled: true, allowed_updates: ["address", "name", "tax_id"] },
          invoice_history: { enabled: true },
          payment_method_update: { enabled: true },
          subscription_cancel: { enabled: true, mode: "at_period_end" },
          subscription_update: { enabled: false },
        },
      });
    if (path === "/v1/billing_portal/sessions")
      return json({
        customer: params.get("customer"),
        configuration: "bpc_fixture",
        livemode: false,
        return_url: "https://dev.app.ohmyho.st/billing",
        url: "https://billing.stripe.com/p/session_fixture",
        created: Math.floor(Date.now() / 1000),
      });
    throw new Error(`Unexpected fixture Stripe request ${input.method} ${path}`);
  }

  return {
    request,
    state,
    customers,
    cards,
    sessions,
    setupsOpen,
    invoices,
    subscriptions,
    payments,
    events,
    refunds,
    disputes,
    taxIssues,
    declines,
    stuck,
    refusedCancels,
    gross,
    pays,
    collect,
  };
}
