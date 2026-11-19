import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      _ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));
import { GrowthPaymentService } from "../src/worker-main.js";
import { createGrowthPaymentReader } from "../src/growth-payment.js";

it("retains legacy payment charges and resolves related disputes through the same fixed charge endpoint", async () => {
  const paths: string[] = [];
  const reader = createGrowthPaymentReader({
    credential: "sk_test_fixture",
    accountId: "acct_fixture",
    mode: "test",
    resolveCustomer: async () => "org_fixture",
    fetcher: async (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/v1/account") return Response.json({ id: "acct_fixture" });
      if (path === "/v1/balance_transactions")
        return Response.json({
          has_more: false,
          data: [
            {
              id: "txn_payment",
              type: "payment",
              status: "available",
              amount: 1000,
              currency: "eur",
              created: 1700000000,
              source: {
                id: "py_fixture",
                object: "charge",
                customer: "cus_fixture",
                payment_intent: "pi_fixture",
              },
            },
            {
              id: "txn_withdrawal",
              type: "adjustment",
              status: "available",
              amount: -1000,
              currency: "eur",
              created: 1700000001,
              source: { id: "du_fixture", object: "dispute", charge: "py_fixture" },
            },
          ],
        });
      if (path === "/v1/disputes")
        return Response.json({
          has_more: false,
          data: [
            {
              id: "du_fixture",
              status: "needs_response",
              charge: "py_fixture",
              amount: 1000,
              currency: "eur",
              created: 1700000001,
            },
          ],
        });
      if (path === "/v1/charges/py_fixture")
        return Response.json({
          id: "py_fixture",
          object: "charge",
          customer: "cus_fixture",
          payment_intent: "pi_fixture",
        });
      throw new Error("unexpected endpoint");
    },
  });
  expect((await reader.readGrowthPaymentPage({ cursor: null, limit: 2 })).facts).toMatchObject([
    { provider_fact_id: "txn_payment", money_effect: "received", organization_id: "org_fixture" },
    {
      provider_fact_id: "txn_withdrawal",
      money_effect: "withdrawn",
      organization_id: "org_fixture",
    },
  ]);
  expect((await reader.readGrowthOpenDisputePage({ cursor: null, limit: 2 })).facts).toMatchObject([
    { provider_fact_id: "du_fixture", money_effect: "none" },
  ]);
  expect(paths.filter((p) => p === "/v1/charges/py_fixture")).toHaveLength(2);
});

it("reads confirmed money effects with original IDs and leaves unresolved customers unassigned", async () => {
  const reader = createGrowthPaymentReader({
    credential: "sk_test_secret",
    accountId: "acct_123",
    mode: "test",
    resolveCustomer: async (customer) =>
      customer === "cus_1" ? "01ARZ3NDEKTSV4RRFFQ69G5FAV" : null,
    fetcher: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/account") return Response.json({ id: "acct_123" });
      if (path === "/v1/balance_transactions")
        return Response.json({
          has_more: false,
          data: [
            {
              id: "txn_1",
              type: "charge",
              status: "available",
              amount: 1000,
              currency: "usd",
              created: 1700000000,
              source: { id: "ch_1", object: "charge", customer: "cus_1", payment_intent: "pi_1" },
            },
            {
              id: "txn_2",
              type: "adjustment",
              status: "available",
              amount: -400,
              currency: "usd",
              created: 1700000001,
              source: { id: "du_1", object: "dispute", charge: "ch_2", payment_intent: "pi_2" },
            },
          ],
        });
      if (path === "/v1/disputes")
        return Response.json({
          has_more: false,
          data: [
            {
              id: "du_2",
              status: "needs_response",
              charge: "ch_2",
              payment_intent: "pi_2",
              amount: 400,
              currency: "usd",
              created: 1700000002,
            },
          ],
        });
      if (path === "/v1/charges/ch_2")
        return Response.json({ id: "ch_2", customer: "cus_2", payment_intent: "pi_2" });
      throw new Error("unexpected endpoint");
    },
  });
  const result = await reader.readGrowthPaymentPage({ cursor: null, limit: 2 });
  expect(result.facts).toMatchObject([
    {
      provider_fact_id: "txn_1",
      money_effect: "received",
      amount_minor: 1000,
      currency: "USD",
      organization_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    },
    {
      provider_fact_id: "txn_2",
      money_effect: "withdrawn",
      amount_minor: 400,
      organization_id: null,
    },
  ]);
  expect(result.facts[0]).toMatchObject({
    source_version: "txn_1",
    observed_at: expect.any(String),
  });
  expect(result.history_floor).toBeNull();
  const disputes = await reader.readGrowthOpenDisputePage({ cursor: null, limit: 2 });
  expect(disputes.facts).toMatchObject([
    { provider_fact_id: "du_2", money_effect: "none", amount_minor: 400, organization_id: null },
  ]);
  expect(JSON.stringify(result)).not.toContain("secret");
  await expect(reader.readGrowthPaymentPage({ cursor: null, limit: 201 })).rejects.toThrow();
});

it("maps Stripe customers only through the private Worker capability for payment and dispute pages", async () => {
  const paths: string[] = [];
  const fetcher = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    paths.push(url.pathname);
    expect(request.headers.get("authorization")).toBe("Bearer sk_test_fixture");
    if (url.pathname === "/v1/account") return Response.json({ id: "acct_123" });
    if (url.pathname === "/v1/balance_transactions")
      return Response.json({
        has_more: false,
        data: [
          {
            id: "txn_1",
            type: "charge",
            status: "available",
            amount: 1000,
            currency: "usd",
            created: 1700000000,
            source: { id: "ch_1", object: "charge", customer: "cus_1", payment_intent: "pi_1" },
          },
        ],
      });
    if (url.pathname === "/v1/disputes")
      return Response.json({
        has_more: false,
        data: [
          {
            id: "du_1",
            status: "needs_response",
            charge: "ch_2",
            amount: 400,
            currency: "usd",
            created: 1700000001,
          },
        ],
      });
    if (url.pathname === "/v1/charges/ch_2")
      return Response.json({ id: "ch_2", customer: "cus_2", payment_intent: "pi_2" });
    throw new Error(`unexpected path ${url.pathname}`);
  });
  const resolveGrowthStripeCustomer = vi.fn(async ({ customer_id }: { customer_id: string }) =>
    customer_id === "cus_1" ? { organization_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } : null,
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    const Entry = GrowthPaymentService as unknown as new (
      ctx: unknown,
      env: unknown,
    ) => GrowthPaymentService;
    const env = {
      STRIPE_SECRET_KEY: "sk_test_fixture",
      STRIPE_ACCOUNT_ID: "acct_123",
      STRIPE_MODE: "test",
      GROWTH_STRIPE_CUSTOMER_RUNTIME: { resolveGrowthStripeCustomer },
    };
    const service = new Entry({}, env);
    const payments = await service.readGrowthPaymentPage({ cursor: null, limit: 2 });
    const disputes = await service.readGrowthOpenDisputePage({ cursor: null, limit: 2 });
    expect(payments.facts).toMatchObject([
      { provider_fact_id: "txn_1", organization_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    ]);
    expect(disputes.facts).toMatchObject([{ provider_fact_id: "du_1", organization_id: null }]);
    expect(resolveGrowthStripeCustomer.mock.calls.map(([input]) => input.customer_id)).toEqual([
      "cus_1",
      "cus_2",
    ]);
    expect(JSON.stringify([payments, disputes])).not.toMatch(/cus_1|cus_2|sk_test/);
    expect(paths).toEqual([
      "/v1/account",
      "/v1/balance_transactions",
      "/v1/account",
      "/v1/disputes",
      "/v1/charges/ch_2",
    ]);
    const absent = new Entry({}, { ...env, GROWTH_STRIPE_CUSTOMER_RUNTIME: undefined });
    await expect(absent.readGrowthPaymentPage({ cursor: null, limit: 2 })).rejects.toThrow(
      "stripe_growth_mapping_unavailable",
    );
    await expect(absent.readGrowthOpenDisputePage({ cursor: null, limit: 2 })).rejects.toThrow(
      "stripe_growth_mapping_unavailable",
    );
    expect(fetcher).toHaveBeenCalledTimes(5);
  } finally {
    vi.unstubAllGlobals();
  }
});
