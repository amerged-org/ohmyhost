import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StripeBillingError } from "@ohmyhost/provider-stripe";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { runChargeOrg } from "../../control-store/src/catalog/credit/index.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { createControlStore } from "../../control-store/src/store.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import { seedOrganization } from "../../control-store/test/support/seed.js";
import { createBillingHandler } from "../src/http.js";
import { createBillingWorker } from "../src/worker-main.js";
import type { RechargeRuntimeBinding } from "../src/d1-recharge-persistence.js";
import { createStripeFixture, type Row } from "./stripe-fixture.js";

const nativeState = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = nativeState.env;
  },
}));
import { BillingRuntime } from "../../control-store/src/worker-main.js";

const ACCOUNT = "acct_worker_billing";
const stripe = createStripeFixture(ACCOUNT);
let control: TestControl;
let db: D1Database;
let store: ReturnType<typeof createControlStore>;
let env: Record<string, unknown>;
let originalFetch: typeof globalThis.fetch;
const worker = createBillingWorker();

beforeAll(async () => {
  control = await createTestControl();
  db = control.core;
  store = createControlStore(control.bindings);
  nativeState.env = control.bindings;
  env = {
    CONTROL_RUNTIME: new (BillingRuntime as unknown as new () => RechargeRuntimeBinding)(),
    STRIPE_SECRET_KEY: "sk_test_billing_worker_fixture",
    STRIPE_ACCOUNT_ID: ACCOUNT,
    STRIPE_MODE: "test",
    STRIPE_PAID_PRICE_ID: "price_paid",
    STRIPE_TOPUP_PRICE_ID: "price_topup",
    STRIPE_PORTAL_CONFIGURATION_ID: "bpc_fixture",
    BILLING_RETURN_ORIGIN: "https://dev.app.ohmyho.st",
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => stripe.request(new Request(input, init));
}, 120_000);
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await control?.dispose();
});

const at = () => new Date().toISOString(),
  stored = () => at().replace(/Z$/u, "000Z");
const rows = async (sql: string, ...values: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .all<Row>()
  ).results;
const post = (path: string, input: unknown = {}, bindings = env) =>
  worker.fetch(
    new Request(`https://billing.internal${path}`, {
      method: "POST",
      body: typeof input === "string" ? input : JSON.stringify(input),
    }),
    bindings as never,
  );
const json = async (response: Response) => (await response.json()) as Row;
const account = async (organizationId: string) =>
  (
    await rows(
      "SELECT monthly_micros, onetime_micros, paid_until, paid_source FROM credit_account WHERE organization_id = ?",
      organizationId,
    )
  )[0] as Row;
async function manual(): Promise<string> {
  const org = await seedOrganization(store, 2, 0);
  await makePaid(db, org, undefined, at(), "manual");
  return org;
}
const checkout = (organizationId: string, offer: "paid" | "topup", key: string, packs = 1) =>
  post("/checkouts", { organizationId, actorId: "user:owner", idempotencyKey: key, offer, packs });
/** Lets the next recharge tick look at the organization again. */
const release = (organizationId: string) =>
  db
    .prepare("UPDATE stripe_recharge_policies SET checked_at = NULL WHERE organization_id = ?")
    .bind(organizationId)
    .run();
const configure = (org: string, extra: Record<string, unknown> = {}) =>
  post("/recharge-configure", {
    organizationId: org,
    actorId: "user:owner",
    idempotencyKey: "worker-enable",
    enabled: true,
    monthlyLimitMinor: 3000,
    consent: "off_session_v1",
    revision: 0,
    ...extra,
  });
async function rechargeReady(limit = 3000): Promise<string> {
  const org = await manual();
  const result = await configure(org, { monthlyLimitMinor: limit });
  expect(result.status).toBe(200);
  expect(await json(result)).toMatchObject({ status: "on", enabled: true });
  // the organization is down to 50 credits
  await runChargeOrg(db, {
    organizationId: org,
    key: `spend:${org}`,
    amountMicros: 950_000_000,
    now: at(),
  });
  return org;
}
/** The recharge invoices Stripe holds for an organization. */
const invoicesOf = (org: string) =>
  [...stripe.invoices.values()].filter(
    (row) => (row["metadata"] as Row | undefined)?.["ohmyhost_organization_id"] === org,
  );
const status = async (org: string) =>
  (await rows("SELECT status FROM stripe_recharge_policies WHERE organization_id = ?", org))[0]?.[
    "status"
  ];
const grants = async (org: string, prefix: string) =>
  rows(
    "SELECT key, amount_micros, paid_minor, reversed_micros FROM credit_grant WHERE organization_id = ? AND key LIKE ?",
    org,
    `${prefix}%`,
  );

describe("checkout, payment, refund and subscription end", () => {
  it("credits a paid plan and a top-up once, takes refunds back, closes the plan at its end and rewards the referrer", async () => {
    const org = await seedOrganization(store, 2, 0),
      recipient = await seedOrganization(store, 2, 0),
      source = `ref-${recipient.toLowerCase()}`,
      request = newUlid(),
      t = stored();
    const mapping = (await rows(
      "SELECT workos_organization_id id FROM organizations WHERE organization_id=?",
      org,
    )) as { id: string }[];
    await db.batch([
      db
        .prepare(
          "INSERT INTO signup_sources(source_id,active,admits_beta,bonus_micros)VALUES(?,1,1,0)",
        )
        .bind(source),
      db
        .prepare(
          "INSERT INTO onboarding_requests(request_id,workos_user_id,idempotency_sha256,request_sha256,name,workos_organization_id,organization_id,completed_at,signup_source,created_at,organization_attempted,membership_attempted)VALUES(?,?,zeroblob(32),unhex(?),'Worker fixture',?,?,?,?,?,1,1)",
        )
        .bind(request, `user_${org}`, "11".repeat(32), mapping[0]?.id, org, t, source, t),
      db
        .prepare(
          "INSERT INTO user_signup(workos_user_id,origin_present,recorded_at,attributed_source,first_request_id,bonus_micros,attributed_at)VALUES(?,0,?,?,?,'0',?)",
        )
        .bind(`user_${org}`, t, source, request, t),
    ]);
    // a top-up needs a paid plan first
    const refused = await checkout(org, "topup", "worker-early");
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ code: "paid_plan_required" });

    const result = await checkout(org, "paid", "worker-paid");
    expect(result.status).toBe(201);
    const paid = await json(result);
    expect(paid).toMatchObject({
      organization_id: org,
      offer: "paid",
      state: "complete",
      payment_confirmed: true,
      credited_micros: "1000000000",
      revoked_micros: "0",
      required_action: "none",
      billing_issue: null,
    });
    expect(await account(org)).toMatchObject({
      monthly_micros: 1_000_000_000,
      paid_source: "stripe",
    });
    expect(await grants(org, "invoice:")).toHaveLength(1);
    // the referrer is rewarded for the first payment, once, and gets 30 days of Paid
    expect(await grants(recipient, "referral_reward:")).toEqual([
      expect.objectContaining({ amount_micros: 1_000_000_000 }),
    ]);
    expect(await account(recipient)).toMatchObject({
      onetime_micros: 1_000_000_000,
      paid_source: "granted",
    });

    // the same request again is the same checkout and credits nothing more
    const again = await checkout(org, "paid", "worker-paid");
    expect(again.status).toBe(201);
    expect(await json(again)).toMatchObject({
      checkout_id: paid["checkout_id"],
      credited_micros: "1000000000",
    });
    expect(await grants(org, "invoice:")).toHaveLength(1);
    // another request while a paid plan exists is refused
    const second = await checkout(org, "paid", "worker-paid-2");
    expect(second.status).toBe(409);
    expect(await json(second)).toEqual({ code: "billing_conflict" });

    const topupResult = await checkout(org, "topup", "worker-topup");
    expect(topupResult.status).toBe(201);
    const topup = await json(topupResult),
      id = String(topup["checkout_id"]),
      pi = `pi_${id}`;
    expect(topup).toMatchObject({ credited_micros: "1000000000", revoked_micros: "0" });
    expect((await account(org))["onetime_micros"]).toBe(1_000_000_000);
    stripe.refunds.set(pi, [
      { id: `re_${id}`, payment_intent: pi, currency: "usd", amount: 200, status: "succeeded" },
    ]);
    stripe.disputes.set(pi, [
      {
        id: `du_${id}`,
        payment_intent: pi,
        currency: "usd",
        livemode: false,
        amount: 300,
        balance_transactions: [
          { id: `txn_${id}`, source: `du_${id}`, amount: -350, reporting_category: "dispute" },
        ],
      },
    ]);
    const reversed = await post("/checkout-status", { organizationId: org, checkoutId: id });
    expect(reversed.status).toBe(200);
    expect(await json(reversed)).toMatchObject({
      credited_micros: "1000000000",
      revoked_micros: "500000000",
    });
    expect((await account(org))["onetime_micros"]).toBe(500_000_000);
    expect((await post("/portal", { organizationId: org })).status).toBe(200);

    // an event about the top-up is read through Stripe and settles nothing twice
    const session = stripe.sessions.get(`cs_${id}`) as Row;
    const event = {
      id: `evt_${id}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      account: ACCOUNT,
      data: { object: session },
    };
    stripe.events.set(String(event["id"]), event);
    await store.ingress.recordStripeWebhook({
      inboxEventId: newUlid(),
      receivedAt: at(),
      event: {
        id: String(event["id"]),
        type: String(event["type"]),
        objectId: String(session["id"]),
        accountId: ACCOUNT,
        mode: "test",
      },
    });
    expect(await (await post("/sync-webhooks")).json()).toMatchObject({
      acknowledged: 1,
      failed: 0,
    });
    expect(
      await rows(
        "SELECT state FROM webhook_inbox WHERE external_event_id=?",
        `${ACCOUNT}/test/evt_${id}`,
      ),
    ).toEqual([{ state: "acknowledged" }]);
    expect(await grants(org, "topup:")).toEqual([
      expect.objectContaining({ amount_micros: 1_000_000_000, reversed_micros: 500_000_000 }),
    ]);
    expect(await grants(recipient, "referral_reward:")).toHaveLength(1);

    // Stripe ends the subscription: the Paid coverage closes there
    const subscription = stripe.subscriptions.get(`sub_${String(paid["checkout_id"])}`) as Row;
    subscription["status"] = "canceled";
    subscription["ended_at"] = Math.floor(Date.now() / 1000) - 1;
    expect(
      (await post("/checkout-status", { organizationId: org, checkoutId: paid["checkout_id"] }))
        .status,
    ).toBe(200);
    const closed = (await account(org))["paid_until"] as string;
    expect(closed < stored()).toBe(true);
    expect(await store.stripeBilling.readOrganizationPaid({ organizationId: org, now: at() })).toBe(
      null,
    );
  }, 30_000);

  it("keeps the Paid coverage of a newer subscription when an older one is read after it ended", async () => {
    const org = await seedOrganization(store, 2, 0);
    const older = await json(await checkout(org, "paid", "worker-sub-old"));
    const olderId = String(older["checkout_id"]);
    // Stripe ends the first subscription, and the organization subscribes again
    const ended = stripe.subscriptions.get(`sub_${olderId}`) as Row;
    ended["status"] = "canceled";
    ended["ended_at"] = Math.floor(Date.now() / 1000) - 1;
    expect(
      (await post("/checkout-status", { organizationId: org, checkoutId: olderId })).status,
    ).toBe(200);
    expect(await account(org)).toMatchObject({ paid_source: "stripe" });
    const newer = await checkout(org, "paid", "worker-sub-new");
    expect(newer.status).toBe(201);
    const coverage = (await account(org))["paid_until"] as string;
    expect(coverage > stored()).toBe(true);
    // a late read of the first checkout, after its subscription ended, closes nothing of the new one
    expect(
      (await post("/checkout-status", { organizationId: org, checkoutId: olderId })).status,
    ).toBe(200);
    expect(await account(org)).toMatchObject({ paid_until: coverage, paid_source: "stripe" });
    expect(
      await store.stripeBilling.readOrganizationPaid({ organizationId: org, now: at() }),
    ).not.toBeNull();
  }, 30_000);

  it("shows the tax issue of a paid invoice and what the customer has to do about it", async () => {
    const org = await manual();
    const made = await json(await checkout(org, "paid", "worker-tax"));
    const invoice = stripe.invoices.get(`in_${String(made["checkout_id"])}`) as Row;
    const status = () =>
      post("/checkout-status", { organizationId: org, checkoutId: made["checkout_id"] });
    invoice["automatic_tax"] = { enabled: true, status: "requires_location_inputs" };
    expect(await json(await status())).toMatchObject({
      required_action: "open_billing_portal",
      billing_issue: {
        code: "billing_tax_location_required",
        invoice_id: invoice["id"],
        required_action: "open_billing_portal",
      },
    });
    invoice["automatic_tax"] = { enabled: false, status: null };
    expect(await json(await status())).toMatchObject({
      required_action: "contact_support",
      billing_issue: {
        code: "billing_tax_configuration_required",
        required_action: "contact_support",
      },
    });
    invoice["automatic_tax"] = { enabled: true, status: "complete" };
    expect(await json(await status())).toMatchObject({
      required_action: "none",
      billing_issue: null,
    });
  });

  it("answers an unknown, a foreign and an expired checkout, and refuses a request that is not one", async () => {
    const org = await manual();
    const foreign = await manual();
    const made = await json(await checkout(org, "topup", "worker-known"));
    const id = String(made["checkout_id"]);
    expect(
      (await post("/checkout-status", { organizationId: org, checkoutId: newUlid() })).status,
    ).toBe(404);
    // the checkout of another organization is not found through this one
    expect(
      (await post("/checkout-status", { organizationId: foreign, checkoutId: id })).status,
    ).toBe(404);
    await post("/portal", { organizationId: foreign }).then((response) =>
      expect(response.status).toBe(409),
    );
    // a checkout whose session never reached Stripe and whose hour has passed is expired
    const past = Date.now() - 4 * 3_600_000;
    const { checkoutIdFor } = await import("../src/checkout-id.js");
    const old = await checkoutIdFor({
      organizationId: org,
      actorId: "user:owner",
      idempotencyKey: "worker-old",
      offer: "topup",
      packs: 1,
      now: new Date(past),
    });
    const expired = await post("/checkout-status", { organizationId: org, checkoutId: old });
    expect(expired.status).toBe(200);
    expect(await json(expired)).toMatchObject({
      state: "expired",
      payment_confirmed: false,
      url: null,
      credited_micros: "0",
    });
    // one that is still within its hour but was never created is simply not there
    const fresh = await checkoutIdFor({
      organizationId: org,
      actorId: "user:owner",
      idempotencyKey: "worker-fresh",
      offer: "topup",
      packs: 1,
      now: new Date(),
    });
    expect(
      (await post("/checkout-status", { organizationId: org, checkoutId: fresh })).status,
    ).toBe(404);
    for (const [input, code] of [
      [
        {
          organizationId: org,
          actorId: "user:owner",
          idempotencyKey: "k",
          offer: "topup",
          packs: 0,
        },
        400,
      ],
      [
        {
          organizationId: org,
          actorId: "user:owner",
          idempotencyKey: "bad key",
          offer: "topup",
          packs: 1,
        },
        400,
      ],
      [
        {
          organizationId: org,
          actorId: "user:owner",
          idempotencyKey: "k",
          offer: "paid",
          packs: 2,
        },
        400,
      ],
      [{ organizationId: org, actorId: "user:owner", idempotencyKey: "k", offer: "topup" }, 400],
    ] as const) {
      const response = await post("/checkouts", input);
      expect(response.status, JSON.stringify(input)).toBe(code);
    }
  });

  it("speaks only its closed HTTP surface", async () => {
    expect(
      (
        await worker.fetch(
          new Request("https://public.test/sync-recharge", { method: "POST", body: "{}" }),
          env as never,
        )
      ).status,
    ).toBe(404);
    expect(
      (await worker.fetch(new Request("https://billing.internal/sync-recharge"), env as never))
        .status,
    ).toBe(404);
    expect((await post("/elsewhere")).status).toBe(404);
    expect(
      (
        await worker.fetch(
          new Request("https://billing.internal/sync-webhooks?x=1", { method: "POST", body: "{}" }),
          env as never,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          new Request("https://billing.internal/sync-webhooks", { method: "POST" }),
          env as never,
        )
      ).status,
    ).toBe(400);
    expect((await post("/sync-webhooks", "[]")).status).toBe(400);
    expect((await post("/sync-webhooks", { extra: 1 })).status).toBe(400);
    expect((await post("/sync-webhooks", "{")).status).toBe(503);
    expect((await post("/sync-webhooks", "x".repeat(5000))).status).toBe(413);
    expect((await post("/portal", { organizationId: newUlid(), extra: 1 })).status).toBe(400);
    expect((await post("/checkout-status", { organizationId: newUlid() })).status).toBe(400);
    expect((await post("/recharge", { organizationId: newUlid(), extra: 1 })).status).toBe(400);
    expect((await post("/recharge-configure", { organizationId: newUlid() })).status).toBe(400);
    expect((await post("/recharge", { organizationId: "nope" })).status).toBe(503);
    const org = await manual();
    expect(await json(await post("/recharge", { organizationId: org }))).toMatchObject({
      enabled: false,
      status: "off",
      revision: 0,
    });
  });
});

describe("a customer intent that never reached Stripe", () => {
  const configuration = {
    accountId: ACCOUNT,
    mode: "test" as const,
    paidPriceId: "price_paid",
    topupPriceId: "price_topup",
  };
  /** The intent of an organization whose first Stripe customer creation failed a day ago. */
  const intentOfADayAgo = (organizationId: string) =>
    store.stripeBilling.prepareStripeCustomer({
      organizationId,
      configuration,
      requestId: newUlid(),
      actorId: "user:owner",
      now: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    });
  const intentOf = (organizationId: string) =>
    rows(
      "SELECT request_id, provider_id FROM stripe_billing_customers WHERE organization_id = ?",
      organizationId,
    );

  it("gets a new customer and buys when Stripe holds no customer of the day-old intent", async () => {
    const org = await seedOrganization(store, 2, 0);
    const stuck = await intentOfADayAgo(org);
    expect(stuck.customerId).toBeNull();
    const result = await checkout(org, "paid", "stuck-intent");
    expect(result.status).toBe(201);
    expect(await json(result)).toMatchObject({
      offer: "paid",
      state: "complete",
      payment_confirmed: true,
    });
    expect(await intentOf(org)).toEqual([
      { request_id: expect.not.stringMatching(stuck.requestId), provider_id: `cus_${org}` },
    ]);
  });

  it("adopts the customer that the search finds for the day-old intent and creates none", async () => {
    const org = await seedOrganization(store, 2, 0);
    const intent = await intentOfADayAgo(org);
    // Stripe does hold this intent's customer: its first creation succeeded, but the response was lost
    stripe.customers.set(`cus_${org}`, {
      id: `cus_${org}`,
      object: "customer",
      livemode: false,
      metadata: { ohmyhost_organization_id: org, ohmyhost_customer_request_id: intent.requestId },
      tax: { automatic_tax: "supported" },
    });
    expect((await checkout(org, "paid", "found-intent")).status).toBe(201);
    expect(await intentOf(org)).toEqual([
      { request_id: intent.requestId, provider_id: `cus_${org}` },
    ]);
  });
});

describe("a deleted organization's Stripe billing", () => {
  it.each([
    [
      "ends its subscription and detaches its card once, on the next Billing sync",
      async () => {
        const org = await seedOrganization(store, 2, 0);
        expect((await checkout(org, "paid", "closing-paid")).status).toBe(201);
        stripe.cards.add(`pm_${org}`);
        await db
          .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
          .bind(org)
          .run();
        const subscriptionOf = () =>
          [...stripe.subscriptions.values()].find((row) => row["customer"] === `cus_${org}`);
        expect(subscriptionOf()?.["status"]).toBe("active");
        await post("/sync-recharge");
        expect(subscriptionOf()?.["status"]).toBe("canceled");
        expect(stripe.cards.has(`pm_${org}`)).toBe(false);
        expect(
          await rows(
            "SELECT closed_at FROM stripe_billing_closures WHERE organization_id = ?",
            org,
          ),
        ).toEqual([{ closed_at: expect.any(String) }]);
      },
    ],
    [
      "makes at most twenty changes in one sync and finishes the closure on a later sync",
      async () => {
        const org = await seedOrganization(store, 2, 0);
        expect((await checkout(org, "paid", "closing-many")).status).toBe(201);
        // twenty-six live subscriptions and a card: twenty-seven changes, more than one sync makes
        for (let index = 1; index <= 25; index += 1)
          stripe.subscriptions.set(`sub_${org}_${index}`, {
            id: `sub_${org}_${index}`,
            object: "subscription",
            customer: `cus_${org}`,
            livemode: false,
            status: "active",
          });
        stripe.cards.add(`pm_${org}`);
        await db
          .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
          .bind(org)
          .run();
        const endedOf = () =>
          [...stripe.subscriptions.values()].filter(
            (row) => row["customer"] === `cus_${org}` && row["status"] === "canceled",
          ).length;
        const closedAt = () =>
          rows("SELECT closed_at FROM stripe_billing_closures WHERE organization_id = ?", org);
        await post("/sync-recharge");
        expect(endedOf()).toBe(20);
        expect(stripe.cards.has(`pm_${org}`)).toBe(true);
        expect(await closedAt()).toEqual([{ closed_at: null }]);
        // the lease of the unfinished closure runs out, and the next sync makes the rest
        await db
          .prepare(
            "UPDATE stripe_billing_closures SET leased_until = NULL WHERE organization_id = ?",
          )
          .bind(org)
          .run();
        await post("/sync-recharge");
        expect(endedOf()).toBe(26);
        expect(stripe.cards.has(`pm_${org}`)).toBe(false);
        expect(await closedAt()).toEqual([{ closed_at: expect.any(String) }]);
      },
    ],
    [
      "keeps a closure open while Stripe refuses it, names the organization in the warning, and ends it on a later sync",
      async () => {
        const org = await seedOrganization(store, 2, 0);
        expect((await checkout(org, "paid", "closing-refused")).status).toBe(201);
        stripe.cards.add(`pm_${org}`);
        await db
          .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
          .bind(org)
          .run();
        const subscriptionOf = () =>
          [...stripe.subscriptions.values()].find((row) => row["customer"] === `cus_${org}`) as Row;
        stripe.refusedCancels.add(String(subscriptionOf()["id"]));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          await post("/sync-recharge");
          expect(subscriptionOf()["status"]).toBe("active");
          expect(stripe.cards.has(`pm_${org}`)).toBe(true);
          expect(
            await rows(
              "SELECT closed_at FROM stripe_billing_closures WHERE organization_id = ?",
              org,
            ),
          ).toEqual([{ closed_at: null }]);
          const logged = warn.mock.calls
            .map(([line]) => String(line))
            .filter((line) => line.includes("stripe_closure_failed"))
            .map((line) => JSON.parse(line) as Row);
          expect(logged).toEqual([
            {
              level: "warn",
              service: "billing",
              code: "stripe_closure_failed",
              organization_id: org,
            },
          ]);
          // Stripe accepts the cancellation on a later sync, once the lease runs out
          stripe.refusedCancels.clear();
          await db
            .prepare(
              "UPDATE stripe_billing_closures SET leased_until = NULL WHERE organization_id = ?",
            )
            .bind(org)
            .run();
          await post("/sync-recharge");
          expect(subscriptionOf()["status"]).toBe("canceled");
          expect(stripe.cards.has(`pm_${org}`)).toBe(false);
          expect(
            await rows(
              "SELECT closed_at FROM stripe_billing_closures WHERE organization_id = ?",
              org,
            ),
          ).toEqual([{ closed_at: expect.any(String) }]);
        } finally {
          warn.mockRestore();
        }
      },
    ],
    [
      "parks the payment of a deleted organization for an operator, and credits the payment of a suspended one",
      async () => {
        const [deleted, suspended] = [await rechargeReady(), await rechargeReady()];
        stripe.declines.add(deleted);
        stripe.declines.add(suspended);
        await post("/sync-recharge");
        // each recharge invoice waits for the customer, and Stripe collects it afterwards
        for (const org of [deleted, suspended]) stripe.collect(invoicesOf(org)[0] as Row);
        await db
          .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
          .bind(deleted)
          .run();
        await db
          .prepare("UPDATE organizations SET state = 'suspended' WHERE organization_id = ?")
          .bind(suspended)
          .run();
        /** Records the event that Stripe sends for the paid recharge invoice of an organization; returns its external id. */
        const eventOf = async (org: string): Promise<string> => {
          const invoice = invoicesOf(org)[0] as Row;
          const id = `evt_paid_${org}`;
          stripe.events.set(id, {
            id,
            object: "event",
            type: "invoice.paid",
            livemode: false,
            account: ACCOUNT,
            data: { object: invoice },
          });
          await store.ingress.recordStripeWebhook({
            inboxEventId: newUlid(),
            receivedAt: at(),
            event: {
              id,
              type: "invoice.paid",
              objectId: String(invoice["id"]),
              accountId: ACCOUNT,
              mode: "test",
            },
          });
          return `${ACCOUNT}/test/${id}`;
        };
        const deletedEvent = await eventOf(deleted);
        const suspendedEvent = await eventOf(suspended);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
          // the deleted organization's event is retried on every attempt until the tenth parks it for an operator
          for (let attempt = 1; attempt <= 10; attempt += 1) {
            await db
              .prepare("UPDATE webhook_inbox SET available_at = ? WHERE external_event_id = ?")
              .bind(stored(), deletedEvent)
              .run();
            await post("/sync-webhooks");
          }
          expect(
            await rows(
              "SELECT state, attempt_count, last_error_code FROM webhook_inbox WHERE external_event_id = ?",
              deletedEvent,
            ),
          ).toEqual([
            {
              state: "reconciliation_required",
              attempt_count: 10,
              last_error_code: "STRIPE_PROCESSING_FAILED",
            },
          ]);
          expect(await grants(deleted, "recharge:")).toEqual([]);
          expect(
            warn.mock.calls
              .map(([line]) => String(line))
              .filter((line) => line.includes("stripe_inbox_parked")),
          ).toHaveLength(1);
          // the suspended organization's payment is credited by the first pass that sees it
          expect(
            await rows(
              "SELECT state FROM webhook_inbox WHERE external_event_id = ?",
              suspendedEvent,
            ),
          ).toEqual([{ state: "acknowledged" }]);
          expect(await grants(suspended, "recharge:")).toEqual([
            expect.objectContaining({ amount_micros: 1_000_000_000 }),
          ]);
          // the parked payment leaves the deleted organization's Stripe billing to its closure, which the next sync ends
          await post("/sync-recharge");
          expect(
            await rows(
              "SELECT closed_at FROM stripe_billing_closures WHERE organization_id = ?",
              deleted,
            ),
          ).toEqual([{ closed_at: expect.any(String) }]);
        } finally {
          warn.mockRestore();
        }
      },
    ],
    [
      "still recharges an organization when the closure claim of the pass fails, and counts that failure",
      async () => {
        const org = await rechargeReady();
        // a Core whose closure claim fails with a D1 error, as it does before migration 0901 is applied
        const failingClaim = Object.create(
          new (BillingRuntime as unknown as new () => RechargeRuntimeBinding)(),
          {
            claimStripeBillingClosure: {
              value: () =>
                Promise.reject(new Error("D1_ERROR: no such table: stripe_billing_closures")),
            },
          },
        );
        const response = await post(
          "/sync-recharge",
          {},
          { ...env, CONTROL_RUNTIME: failingClaim },
        );
        expect(response.status).toBe(200);
        expect(await json(response)).toMatchObject({ failed: 1 });
        expect(stripe.pays.get(org)).toBe(1);
        expect(await grants(org, "recharge:")).toEqual([
          expect.objectContaining({ amount_micros: 1_000_000_000 }),
        ]);
      },
    ],
  ])(
    "%s",
    async (_name, scenario) => {
      await scenario();
    },
    30_000,
  );
});

describe("the Worker fails closed", () => {
  it("refuses a missing, partial or mixed Control binding before any Stripe call", async () => {
    const before = stripe.state.calls;
    const binding = env["CONTROL_RUNTIME"] as RechargeRuntimeBinding;
    for (const bindings of [
      { ...env, CONTROL_RUNTIME: undefined },
      { ...env, CONTROL_RUNTIME: {} },
      { ...env, CONTROL_CORE: {} },
      { ...env, CONTROL_SHARD_0: {} },
      { ...env, STRIPE_SECRET_KEY: "sk_live_wrong_mode" },
      { ...env, STRIPE_MODE: "staging" },
      { ...env, STRIPE_PORTAL_CONFIGURATION_ID: "" },
      {
        ...env,
        CONTROL_RUNTIME: new Proxy(binding, {
          get: (target, name) =>
            name === "grantStripePayment" ? undefined : Reflect.get(target, name),
        }),
      },
    ]) {
      const response = await post("/sync-recharge", {}, bindings);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "billing_unavailable" });
    }
    expect(stripe.state.calls).toBe(before);
  });
});

describe("automatic recharge", () => {
  it("asks for a new card setup, with a link, when the setup session expired", async () => {
    const org = await manual();
    stripe.setupsOpen.add(org);
    const waiting = await json(await configure(org));
    expect(waiting).toMatchObject({ status: "setup_required" });
    expect(waiting["setup_url"]).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
    const [before] = await rows(
      "SELECT setup_id, setup_session_id FROM stripe_recharge_policies WHERE organization_id = ?",
      org,
    );
    // Stripe ends the session the policy stored; the customer opens the page again later
    const expired = stripe.sessions.get(`cs_${String(before?.["setup_id"])}`);
    expect(expired).toBeDefined();
    Object.assign(expired as Row, { status: "expired", url: null });
    const view = await json(await post("/recharge", { organizationId: org }));
    expect(view).toMatchObject({ status: "setup_required", enabled: true });
    expect(view["setup_url"]).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
    const [after] = await rows(
      "SELECT setup_id, setup_session_id FROM stripe_recharge_policies WHERE organization_id = ?",
      org,
    );
    expect(after?.["setup_id"]).not.toBe(before?.["setup_id"]);
    expect(after?.["setup_session_id"]).toBe(`cs_${String(after?.["setup_id"])}`);
    // the policy is switched off again, so later ticks of this file do not look at it
    stripe.setupsOpen.delete(org);
    expect(
      (
        await configure(org, {
          enabled: false,
          consent: null,
          revision: 1,
          idempotencyKey: "worker-expired-off",
        })
      ).status,
    ).toBe(200);
  });

  it("gives a waiting policy that lost its session a new setup and a link once it is a day old", async () => {
    const org = await manual();
    stripe.setupsOpen.add(org);
    expect(await json(await configure(org))).toMatchObject({ status: "setup_required" });
    const [before] = await rows(
      "SELECT setup_id FROM stripe_recharge_policies WHERE organization_id = ?",
      org,
    );
    // the session is gone, and the policy has waited for a day without a link
    await db
      .prepare(
        "UPDATE stripe_recharge_policies SET setup_session_id = NULL, updated_at = ? WHERE organization_id = ?",
      )
      .bind(new Date(Date.now() - 25 * 3_600_000).toISOString().replace(/Z$/u, "000Z"), org)
      .run();
    const view = await json(await post("/recharge", { organizationId: org }));
    expect(view).toMatchObject({ status: "setup_required", enabled: true });
    expect(view["setup_url"]).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
    const [after] = await rows(
      "SELECT setup_id, setup_session_id FROM stripe_recharge_policies WHERE organization_id = ?",
      org,
    );
    expect(after?.["setup_id"]).not.toBe(before?.["setup_id"]);
    expect(after?.["setup_session_id"]).toBe(`cs_${String(after?.["setup_id"])}`);
    // the policy is switched off again, so later ticks of this file do not look at it
    stripe.setupsOpen.delete(org);
    expect(
      (
        await configure(org, {
          enabled: false,
          consent: null,
          revision: 1,
          idempotencyKey: "worker-stale-off",
        })
      ).status,
    ).toBe(200);
  });

  it("saves a card, then buys 1000 credits when the credit is below 100 and keeps its monthly spend", async () => {
    const org = await rechargeReady();
    expect(await (await post("/sync-recharge")).json()).toEqual({ processed: 1, failed: 0 });
    expect(stripe.pays.get(org)).toBe(1);
    expect(await grants(org, "recharge:")).toEqual([
      expect.objectContaining({ amount_micros: 1_000_000_000, paid_minor: 1000 }),
    ]);
    expect((await account(org))["onetime_micros"]).toBe(1_000_000_000);
    expect(await status(org)).toBe("on");
    expect(await json(await post("/recharge", { organizationId: org }))).toMatchObject({
      status: "on",
      spent_minor: 1000,
      portal_available: true,
    });
    // the credit is above the threshold now: the next tick finds nothing to do
    await release(org);
    await post("/sync-recharge");
    expect(stripe.pays.get(org)).toBe(1);
    // turning it off withdraws an invoice that is not paid and keeps the policy off
    const draft = [...stripe.invoices.values()].find((row) => row["status"] === "paid");
    expect(draft).toBeDefined();
    const off = await configure(org, {
      enabled: false,
      consent: null,
      revision: 1,
      idempotencyKey: "worker-off",
    });
    expect(off.status).toBe(200);
    expect(await json(off)).toMatchObject({ status: "off", enabled: false, revision: 2 });
  }, 30_000);

  it("waits for the customer to correct the tax address, and pays once it is corrected", async () => {
    const org = await rechargeReady();
    stripe.taxIssues.add(org);
    await post("/sync-recharge");
    expect(await status(org)).toBe("tax_required");
    expect(stripe.pays.get(org) ?? 0).toBe(0);
    const view = await json(await post("/recharge", { organizationId: org }));
    expect(view).toMatchObject({
      status: "tax_required",
      billing_issue: {
        code: "billing_tax_location_required",
        required_action: "open_billing_portal",
      },
    });
    stripe.taxIssues.delete(org);
    await release(org);
    await post("/sync-recharge");
    expect(stripe.pays.get(org)).toBe(1);
    expect(await status(org)).toBe("on");
  }, 30_000);

  it("never spends past the monthly limit, tax included", async () => {
    const org = await rechargeReady(1000);
    stripe.gross.set(org, 1100);
    await post("/sync-recharge");
    expect(stripe.pays.get(org) ?? 0).toBe(0);
    expect(await status(org)).toBe("monthly_limit");
    expect(await grants(org, "recharge:")).toEqual([]);
    const voided = [...stripe.invoices.values()].filter(
      (row) => (row["metadata"] as Row | undefined)?.["ohmyhost_organization_id"] === org,
    );
    expect(voided.map((row) => row["status"])).toEqual(["void"]);
    // and a limit too small for any recharge stops it before an invoice exists
    const small = await rechargeReady(1000);
    await db
      .prepare(
        "INSERT INTO credit_grant(key, organization_id, amount_micros, paid_minor, reversed_micros, granted_at) VALUES (?1, ?2, 1000000000, 990, 0, ?3)",
      )
      .bind(`recharge:pi_spent_${small}`, small, stored())
      .run();
    await post("/sync-recharge");
    expect(await status(small)).toBe("monthly_limit");
    expect(
      [...stripe.invoices.values()].some(
        (row) => (row["metadata"] as Row | undefined)?.["ohmyhost_organization_id"] === small,
      ),
    ).toBe(false);
  }, 30_000);

  it("asks the customer to pay a declined recharge and credits it when it is paid, even when the event is lost", async () => {
    const org = await rechargeReady();
    stripe.declines.add(org);
    await post("/sync-recharge");
    expect(await status(org)).toBe("payment_required");
    expect(await grants(org, "recharge:")).toEqual([]);
    const view = await json(await post("/recharge", { organizationId: org }));
    expect(view).toMatchObject({
      status: "payment_required",
      invoice_url: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//u),
    });
    // a declined payment is not tried again while it waits
    await release(org);
    await post("/sync-recharge");
    expect(stripe.pays.get(org) ?? 0).toBe(0);
    // the customer pays from the invoice page; the event never arrives
    const invoice = invoicesOf(org)[0] as Row;
    stripe.collect(invoice);
    await release(org);
    await post("/sync-recharge");
    expect(await grants(org, "recharge:")).toHaveLength(1);
    expect(await status(org)).toBe("on");
    await release(org);
    await post("/sync-recharge");
    expect(await grants(org, "recharge:")).toHaveLength(1);
  }, 30_000);

  it("credits a recharge that was paid but never credited before it buys another", async () => {
    const org = await rechargeReady();
    await post("/sync-recharge");
    expect(stripe.pays.get(org)).toBe(1);
    // the credit of that payment is lost, and the organization is down to 50 credits again
    await db.batch([
      db
        .prepare("DELETE FROM credit_grant WHERE organization_id = ? AND key LIKE 'recharge:%'")
        .bind(org),
      db
        .prepare("DELETE FROM credit_log WHERE organization_id = ? AND key LIKE 'grant:recharge:%'")
        .bind(org),
    ]);
    await db
      .prepare(
        "UPDATE credit_account SET onetime_micros = 0, monthly_micros = 50000000 WHERE organization_id = ?",
      )
      .bind(org)
      .run();
    await release(org);
    await post("/sync-recharge");
    // Stripe collected it, so the credit is made good and nothing is charged twice
    expect(stripe.pays.get(org)).toBe(1);
    expect(await grants(org, "recharge:")).toHaveLength(1);
    expect((await account(org))["onetime_micros"]).toBe(1_000_000_000);
    await release(org);
    await post("/sync-recharge");
    expect(stripe.pays.get(org)).toBe(1);
  }, 30_000);

  it("settles and takes back a recharge from the events about its invoice", async () => {
    const org = await rechargeReady();
    stripe.declines.add(org);
    await post("/sync-recharge");
    const invoice = invoicesOf(org)[0] as Row;
    stripe.collect(invoice);
    const send = async (id: string, type: string, object: Row) => {
      stripe.events.set(id, {
        id,
        object: "event",
        type,
        livemode: false,
        account: ACCOUNT,
        data: { object },
      });
      await store.ingress.recordStripeWebhook({
        inboxEventId: newUlid(),
        receivedAt: at(),
        event: { id, type, objectId: String(object["id"]), accountId: ACCOUNT, mode: "test" },
      });
      return (await post("/sync-webhooks")).json();
    };
    expect(await send(`evt_paid_${org}`, "invoice.paid", invoice)).toMatchObject({
      acknowledged: 1,
      failed: 0,
    });
    expect(await grants(org, "recharge:")).toEqual([
      expect.objectContaining({ amount_micros: 1_000_000_000, reversed_micros: 0 }),
    ]);
    // the customer is refunded: the credit goes back and the policy asks the owner to look
    const pi = `pi_${String(invoice["id"])}`;
    stripe.refunds.set(pi, [
      { id: `re_${org}`, payment_intent: pi, currency: "usd", amount: 1000, status: "succeeded" },
    ]);
    const refund = { id: `re_${org}`, object: "refund", payment_intent: pi };
    expect(await send(`evt_refund_${org}`, "refund.updated", refund)).toMatchObject({
      acknowledged: 1,
      failed: 0,
    });
    expect(await grants(org, "recharge:")).toEqual([
      expect.objectContaining({ reversed_micros: 1_000_000_000 }),
    ]);
    expect(await status(org)).toBe("payment_required");
  }, 30_000);

  it("stops at two recharges in flight at once and discards the invoices of a policy that is turned off", async () => {
    const org = await rechargeReady();
    const customer = `cus_${org}`;
    const draft = (id: string) => ({
      id: `in_${id}`,
      object: "invoice",
      customer,
      livemode: false,
      metadata: { ohmyhost_organization_id: org, ohmyhost_recharge_id: id },
      currency: "usd",
      auto_advance: false,
      collection_method: "charge_automatically",
      parent: null,
      status: "draft",
      subtotal: 900,
      total: 1000,
      automatic_tax: { enabled: true, status: "complete" },
      lines: { object: "list", data: [], has_more: false },
      hosted_invoice_url: null,
    });
    const first = draft(newUlid()),
      second = draft(newUlid());
    stripe.invoices.set(String(first["id"]), first);
    stripe.invoices.set(String(second["id"]), second);
    await post("/sync-recharge");
    expect(await status(org)).toBe("needs_reconciliation");
    expect(stripe.pays.get(org) ?? 0).toBe(0);
    // an invoice that cannot be listed fails the tick without changing anything
    stripe.state.moreInvoices = true;
    await release(org);
    expect(await (await post("/sync-recharge")).json()).toEqual({ processed: 0, failed: 1 });
    stripe.state.moreInvoices = false;
    const cleaned = await configure(org, {
      enabled: false,
      consent: null,
      revision: 1,
      idempotencyKey: "worker-clean",
    });
    expect(cleaned.status).toBe(200);
    expect([first, second].map((row) => row["status"])).toEqual(["void", "void"]);
  }, 30_000);

  it("keeps an invoice that cannot be withdrawn when the policy is turned off", async () => {
    const org = await rechargeReady();
    stripe.declines.add(org);
    await post("/sync-recharge");
    expect(await status(org)).toBe("payment_required");
    stripe.stuck.add(org);
    const off = await configure(org, {
      enabled: false,
      consent: null,
      revision: 1,
      idempotencyKey: "worker-stuck",
    });
    expect(off.status).toBe(200);
    expect(await json(off)).toMatchObject({ status: "off", enabled: false });
    expect(invoicesOf(org).map((row) => row["status"])).toEqual(["open"]);
    stripe.stuck.delete(org);
  }, 30_000);

  it("refuses to turn on without a paid plan, and a stale revision", async () => {
    const free = await seedOrganization(store, 2, 0);
    const refused = await configure(free);
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ code: "paid_plan_required" });
    const org = await manual();
    expect((await configure(org)).status).toBe(200);
    const stale = await configure(org, { monthlyLimitMinor: 5000 });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({ code: "billing_conflict" });
    expect((await configure(org, { enabled: true })).status).toBe(200);
  });
});

describe("a Stripe refusal is not an outage", () => {
  it("answers a refused Stripe call as a non-retryable conflict and only a transient one as unavailable", async () => {
    const reply = (error: Error) =>
      createBillingHandler({
        createCheckout: async () => {
          throw error;
        },
      } as never).fetch(
        new Request("https://billing.internal/checkouts", {
          method: "POST",
          body: JSON.stringify({
            organizationId: newUlid(),
            actorId: "user:owner",
            idempotencyKey: "refused-checkout",
            offer: "topup",
            packs: 1,
          }),
        }),
      );
    const refused = await reply(new StripeBillingError("stripe_rejected", false));
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ code: "billing_conflict" });
    const inconsistent = await reply(new StripeBillingError("stripe_response_invalid", false));
    expect(inconsistent.status).toBe(409);
    const transient = await reply(new StripeBillingError("stripe_unavailable", true));
    expect(transient.status).toBe(503);
    expect(await json(transient)).toEqual({ code: "billing_unavailable" });
  });
});
