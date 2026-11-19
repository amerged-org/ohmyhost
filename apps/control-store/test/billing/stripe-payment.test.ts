import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { ensureStatement } from "../../src/catalog/credit/account.js";
import { FREE_MONTHLY_MICROS, readAccount, runChargeOrg } from "../../src/catalog/credit/index.js";
import { createControlStore } from "../../src/store.js";
import { accountOf, all, credits, first, logOf, newOrganization } from "../credit/support.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { endPaid, makePaid } from "../support/credit-fixtures.js";
import { clawBackReferralReward } from "../../src/catalog/billing/payment-referral-plan.js";
import { ulidOf } from "../support/platform-fixtures.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 120_000);
afterAll(async () => control.dispose());

const NOW = "2026-10-30T10:00:00.000Z";
const STORED = (iso: string) => iso.replace(/Z$/u, "000Z");

let counter = 0;
const invoice = (organizationId: string, extra: Record<string, unknown> = {}) => {
  counter += 1;
  return {
    organizationId,
    now: NOW,
    payment: {
      kind: "invoice" as const,
      invoiceId: `in_${counter}`,
      subscriptionId: `sub_${organizationId}`,
      paymentIntentId: `pi_in${counter}`,
      amountSubtotal: 1000,
      amountTotal: 1100,
      periodStart: "2026-10-30T09:00:00.000Z",
      periodEnd: "2026-11-30T09:00:00.000Z",
      paidAt: "2026-10-30T09:00:05.000Z",
      endedAt: null,
      ...extra,
    },
  };
};
const topup = (organizationId: string, extra: Record<string, unknown> = {}) => {
  counter += 1;
  return {
    organizationId,
    now: NOW,
    payment: {
      kind: "topup" as const,
      paymentIntentId: `pi_top${counter}`,
      packs: 1,
      amountSubtotal: 1000,
      amountTotal: 1100,
      ...extra,
    },
  };
};
const recharge = (organizationId: string, extra: Record<string, unknown> = {}) => {
  counter += 1;
  return {
    organizationId,
    now: NOW,
    payment: {
      kind: "recharge" as const,
      invoiceId: `in_re${counter}`,
      paymentIntentId: `pi_re${counter}`,
      amountTotal: 990,
      ...extra,
    },
  };
};
const customerOf = (organizationId: string) => `cus_${organizationId}`;
/** The Stripe customer of an organization, as the Billing Worker confirmed it. */
async function withCustomer(organizationId: string) {
  await control.core
    .prepare(
      "INSERT INTO stripe_billing_customers(organization_id, request_id, account_id, mode, created_by, created_at, provider_id, provider_confirmed_at) VALUES (?1, ?2, 'acct_payments', 'test', 'user:test', ?3, ?4, ?3)",
    )
    .bind(organizationId, newUlid(), STORED(NOW), customerOf(organizationId))
    .run();
}
const observation = (
  organizationId: string,
  paymentIntentId: string,
  total: number,
  items: { id: string; amountMinor: number; status: string }[] = [],
  disputes: {
    id: string;
    amountMinor: number;
    movements: { id: string; direction: string }[];
  }[] = [],
) => ({
  accountId: "acct_payments",
  mode: "test" as const,
  customerId: customerOf(organizationId),
  paymentIntentId,
  currency: "usd",
  paymentTotalMinor: total,
  items,
  disputes,
});

describe("a paid invoice", () => {
  it("sets the monthly allowance to 1000 credits until the period ends and opens Paid 14 days past it", async () => {
    const org = (await newOrganization(control)).organizationId;
    const input = invoice(org);
    const first_ = await store.stripeBilling.grantStripePayment(input);
    expect(first_).toEqual({
      grantKey: `invoice:${input.payment.invoiceId}`,
      granted: true,
      creditedMicros: String(credits(1000)),
      paidUntil: "2026-12-14T09:00:00.000Z",
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(1000),
      monthly_ends_at: "2026-11-30T09:00:00.000000Z",
      onetime_micros: 0,
      paid_until: "2026-12-14T09:00:00.000000Z",
      paid_source: "stripe",
      exhausted_at: null,
    });
    expect(
      await all(
        control.core,
        "SELECT key, amount_micros, paid_minor, reversed_micros FROM credit_grant WHERE organization_id = ?",
        org,
      ),
    ).toEqual([
      {
        key: first_.grantKey,
        amount_micros: credits(1000),
        paid_minor: 1100,
        reversed_micros: 0,
      },
    ]);
    // the Free month was replaced by the paid month, and the log says why
    const log = await logOf(control.core, org);
    expect(log.map((row) => row.key)).toContain(`grant:${first_.grantKey}`);
    expect(JSON.parse(log.find((row) => row.kind === "grant")?.detail ?? "")).toMatchObject({
      invoiceId: input.payment.invoiceId,
      periodEnd: "2026-11-30T09:00:00.000Z",
      flagBonus: false,
      bucket: "monthly",
    });
    // observing it again changes nothing
    const before = await accountOf(control.core, org);
    expect(await store.stripeBilling.grantStripePayment(input)).toEqual({
      ...first_,
      granted: false,
    });
    expect(await accountOf(control.core, org)).toEqual(before);
    expect(await logOf(control.core, org)).toEqual(log);
  });

  it("gives a project with the powered-by flag 250 credits more", async () => {
    const project = await newOrganization(control);
    await control.core
      .prepare("INSERT INTO project_powered_by_flag_periods VALUES (?1, ?2, ?3, ?4, NULL)")
      .bind(newUlid(), project.organizationId, project.projectId, STORED(NOW))
      .run();
    const result = await store.stripeBilling.grantStripePayment(invoice(project.organizationId));
    expect(result.creditedMicros).toBe(String(credits(1250)));
    expect(await accountOf(control.core, project.organizationId)).toMatchObject({
      monthly_micros: credits(1250),
    });
  });

  it("never opens the Paid coverage past the end of the subscription", async () => {
    const org = (await newOrganization(control)).organizationId;
    const result = await store.stripeBilling.grantStripePayment(
      invoice(org, { endedAt: "2026-11-10T00:00:00.000Z" }),
    );
    expect(result.paidUntil).toBe("2026-11-10T00:00:00.000Z");
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-11-10T00:00:00.000000Z",
      paid_source: "stripe",
    });
  });

  it("records an invoice of an older period without touching the current allowance or coverage", async () => {
    const org = (await newOrganization(control)).organizationId;
    await store.stripeBilling.grantStripePayment(invoice(org));
    await runChargeOrg(control.core, {
      organizationId: org,
      key: "use:older",
      amountMicros: credits(100),
      now: NOW,
    });
    const older = invoice(org, {
      periodStart: "2026-09-30T09:00:00.000Z",
      periodEnd: "2026-10-30T09:00:00.000Z",
    });
    expect((await store.stripeBilling.grantStripePayment(older)).granted).toBe(true);
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(900),
      monthly_ends_at: "2026-11-30T09:00:00.000000Z",
      paid_until: "2026-12-14T09:00:00.000000Z",
    });
  });

  it("does not shorten a longer coverage that an operator granted", async () => {
    const org = (await newOrganization(control)).organizationId;
    await makePaid(control.core, org, "2027-06-01T00:00:00.000Z", NOW, "manual");
    await store.stripeBilling.grantStripePayment(invoice(org));
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2027-06-01T00:00:00.000000Z",
      paid_source: "manual",
      monthly_micros: credits(1000),
    });
  });

  it("refuses an invoice that is not the Paid price for one month, or a payer that does not exist", async () => {
    const org = (await newOrganization(control)).organizationId;
    for (const bad of [
      { amountSubtotal: 999 },
      { amountTotal: 999 },
      { periodEnd: "2026-10-30T09:00:00.000Z" },
      { periodEnd: "2026-12-30T09:00:00.000Z" },
      { paidAt: "2026-10-31T00:00:00.000Z" },
    ])
      await expect(store.stripeBilling.grantStripePayment(invoice(org, bad))).rejects.toThrow(
        "billing_paid_invoice_conflict",
      );
    await expect(
      store.stripeBilling.grantStripePayment({ ...invoice(org), extra: true }),
    ).rejects.toThrow("billing_request_invalid");
    await expect(
      store.stripeBilling.grantStripePayment(invoice(ulidOf("ghost", 51))),
    ).rejects.toThrow(/organization_credit_scope_missing|route/u);
    expect(
      await all(control.core, "SELECT 1 FROM credit_grant WHERE organization_id = ?", org),
    ).toEqual([]);
  });

  it("refuses the key of a payment of another organization", async () => {
    const [a, b] = [
      (await newOrganization(control)).organizationId,
      (await newOrganization(control)).organizationId,
    ];
    const input = invoice(a);
    await store.stripeBilling.grantStripePayment(input);
    await expect(
      store.stripeBilling.grantStripePayment({ ...input, organizationId: b }),
    ).rejects.toThrow("billing_payment_conflict");
    await expect(
      store.stripeBilling.grantStripePayment({
        ...input,
        payment: { ...input.payment, amountTotal: 1200 },
      }),
    ).rejects.toThrow("billing_payment_conflict");
  });
});

describe("a deleted or suspended organization", () => {
  const LATER = "2026-10-30T10:10:00.000Z";
  const closureConfiguration = {
    accountId: "acct_closure",
    mode: "test" as const,
    paidPriceId: "price_paid",
    topupPriceId: "price_topup",
  };
  /** An organization with a confirmed Stripe customer of the closure configuration, deleted when asked. */
  async function closureCustomerOf(deleted: boolean): Promise<string> {
    const org = (await newOrganization(control)).organizationId;
    const intent = await store.stripeBilling.prepareStripeCustomer({
      organizationId: org,
      configuration: closureConfiguration,
      requestId: newUlid(),
      actorId: "user:owner",
      now: NOW,
    });
    await store.stripeBilling.confirmStripeCustomer({
      organizationId: org,
      requestId: intent.requestId,
      customerId: `cus_${org}`,
      now: NOW,
    });
    if (deleted)
      await control.core
        .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
        .bind(org)
        .run();
    return org;
  }

  it.each([
    [
      "is neither credited nor extended by a Stripe payment of a deleted organization, which waits for an operator",
      async () => {
        const deleted = (await newOrganization(control)).organizationId;
        await control.core
          .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
          .bind(deleted)
          .run();
        await expect(store.stripeBilling.grantStripePayment(invoice(deleted))).rejects.toThrow(
          "billing_organization_inactive",
        );
        await expect(store.stripeBilling.grantStripePayment(topup(deleted))).rejects.toThrow(
          "billing_organization_inactive",
        );
        expect(
          await all(control.core, "SELECT 1 FROM credit_grant WHERE organization_id = ?", deleted),
        ).toEqual([]);
        expect(
          await all(
            control.core,
            "SELECT 1 FROM credit_account WHERE organization_id = ? AND paid_until IS NOT NULL",
            deleted,
          ),
        ).toEqual([]);
      },
    ],
    [
      "acknowledges a replay of a payment credited before its organization was deleted, and changes nothing",
      async () => {
        const org = (await newOrganization(control)).organizationId;
        const pay = invoice(org);
        const credited = await store.stripeBilling.grantStripePayment(pay);
        const account = await accountOf(control.core, org);
        const log = await logOf(control.core, org);
        await control.core
          .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
          .bind(org)
          .run();
        // the same Stripe event arrives again: it is already credited, so it is acknowledged and not parked
        expect(await store.stripeBilling.grantStripePayment(pay)).toEqual({
          ...credited,
          granted: false,
        });
        expect(await accountOf(control.core, org)).toEqual(account);
        expect(await logOf(control.core, org)).toEqual(log);
      },
    ],
    [
      "credits and extends a suspended organization's Stripe payments as an active one's, because no refund exists",
      async () => {
        const suspended = (await newOrganization(control)).organizationId;
        await control.core
          .prepare("UPDATE organizations SET state = 'suspended' WHERE organization_id = ?")
          .bind(suspended)
          .run();
        expect(await store.stripeBilling.grantStripePayment(invoice(suspended))).toMatchObject({
          granted: true,
          creditedMicros: String(credits(1000)),
          paidUntil: "2026-12-14T09:00:00.000Z",
        });
        expect(await store.stripeBilling.grantStripePayment(topup(suspended))).toMatchObject({
          granted: true,
          creditedMicros: String(credits(1000)),
        });
        expect(await accountOf(control.core, suspended)).toMatchObject({
          paid_until: "2026-12-14T09:00:00.000000Z",
          paid_source: "stripe",
        });
      },
    ],
    [
      "gets its zero account from a write unless it is deleted, so a suspended paying organization can be credited",
      async () => {
        const [active, suspended, deleted] = [
          (await newOrganization(control)).organizationId,
          (await newOrganization(control)).organizationId,
          (await newOrganization(control)).organizationId,
        ];
        await control.core
          .prepare("UPDATE organizations SET state = 'suspended' WHERE organization_id = ?")
          .bind(suspended)
          .run();
        await control.core
          .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
          .bind(deleted)
          .run();
        await control.core.batch([
          ensureStatement(control.core, active, NOW),
          ensureStatement(control.core, suspended, NOW),
          ensureStatement(control.core, deleted, NOW),
        ]);
        const opened = await all<{ organization_id: string }>(
          control.core,
          "SELECT organization_id FROM credit_account WHERE organization_id IN (?, ?, ?)",
          active,
          suspended,
          deleted,
        );
        expect(opened.map((row) => row.organization_id).sort()).toEqual([active, suspended].sort());
      },
    ],
    [
      "is leased for one attempt, is closed once, and belongs to its own account and mode",
      async () => {
        const active = await closureCustomerOf(false);
        const deleted = await closureCustomerOf(true);
        const claim = (now: string, accountId = closureConfiguration.accountId) =>
          store.stripeBilling.claimStripeBillingClosure({ accountId, mode: "test", now });
        // the first pass that sees the deletion opens its closure and leases it; an active organization has none
        expect(await claim(NOW)).toEqual({ organizationId: deleted, customerId: `cus_${deleted}` });
        // a concurrent pass finds the lease held, and another account or mode finds nothing of this one
        expect(await claim(NOW)).toBeNull();
        expect(await claim(NOW, "acct_elsewhere")).toBeNull();
        // a lease that ran out is taken again until Stripe's billing is recorded as ended
        expect(await claim(LATER)).toEqual({
          organizationId: deleted,
          customerId: `cus_${deleted}`,
        });
        expect(
          await store.stripeBilling.finishStripeBillingClosure({
            organizationId: deleted,
            now: LATER,
          }),
        ).toEqual({
          organizationId: deleted,
        });
        expect(await claim(LATER)).toBeNull();
        // only an organization that has a closure can be finished
        await expect(
          store.stripeBilling.finishStripeBillingClosure({ organizationId: active, now: LATER }),
        ).rejects.toThrow("billing_request_invalid");
      },
    ],
  ])("%s", async (_name, scenario) => {
    await scenario();
  });
});

describe("a top-up and an automatic recharge", () => {
  it("add credit that never expires, once per payment", async () => {
    const org = (await newOrganization(control)).organizationId;
    const input = topup(org, { packs: 2, amountSubtotal: 2000, amountTotal: 2160 });
    const result = await store.stripeBilling.grantStripePayment(input);
    expect(result).toMatchObject({
      granted: true,
      creditedMicros: String(credits(2000)),
      paidUntil: null,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      onetime_micros: credits(2000),
      monthly_micros: credits(200),
    });
    expect(await store.stripeBilling.grantStripePayment(input)).toMatchObject({ granted: false });
    expect(await accountOf(control.core, org)).toMatchObject({ onetime_micros: credits(2000) });
    // 11 packs get the volume bonus of the top-up price list
    const big = await store.stripeBilling.grantStripePayment(
      topup(org, { packs: 11, amountSubtotal: 11000, amountTotal: 11000 }),
    );
    expect(big.creditedMicros).toBe(String(credits(11250)));
    await expect(
      store.stripeBilling.grantStripePayment(topup(org, { amountSubtotal: 2000 })),
    ).rejects.toThrow("billing_payment_conflict");
  });

  it("credits a recharge with 1000 credits and lets the next recharge start", async () => {
    const org = (await newOrganization(control)).organizationId;
    await control.core
      .prepare(
        "INSERT INTO stripe_recharge_policies VALUES (?1, 'acct_payments', 'test', 1, 1, 3000, 'payment_required', ?2, NULL, 'pm_1', ?3, NULL)",
      )
      .bind(org, newUlid(), STORED(NOW))
      .run();
    const input = recharge(org);
    expect(await store.stripeBilling.grantStripePayment(input)).toMatchObject({
      grantKey: `recharge:${input.payment.paymentIntentId}`,
      creditedMicros: String(credits(1000)),
    });
    expect(await accountOf(control.core, org)).toMatchObject({ onetime_micros: credits(1000) });
    expect(
      await first<{ status: string }>(
        control.core,
        "SELECT status FROM stripe_recharge_policies WHERE organization_id = ?",
        org,
      ),
    ).toEqual({ status: "on" });
    await expect(
      store.stripeBilling.grantStripePayment(recharge(org, { amountTotal: 899 })),
    ).rejects.toThrow("billing_payment_conflict");
  });
});

describe("refunds and disputes", () => {
  it("take the credit back in proportion to what was given back, once", async () => {
    const org = (await newOrganization(control)).organizationId;
    await withCustomer(org);
    const pay = topup(org);
    const key = pay.payment.paymentIntentId;
    await store.stripeBilling.grantStripePayment(pay);
    const reverse = (
      items: { id: string; amountMinor: number; status: string }[],
      disputes: Parameters<typeof observation>[4] = [],
    ) =>
      store.stripeBilling.reverseStripePayment({
        organizationId: org,
        payment: { kind: "topup", paymentIntentId: key },
        observation: observation(org, key, 1100, items, disputes),
        now: NOW,
      });
    // nothing refunded yet, and a refund that is still pending has not left yet
    expect(await reverse([])).toEqual({ revokedMicros: "0", refundedMinor: "0" });
    expect(await reverse([{ id: "re_1", amountMinor: 550, status: "pending" }])).toEqual({
      revokedMicros: "0",
      refundedMinor: "0",
    });
    // half of the payment succeeded: half of the credit goes
    const half = [{ id: "re_1", amountMinor: 550, status: "succeeded" }];
    expect(await reverse(half)).toEqual({
      revokedMicros: String(credits(500)),
      refundedMinor: "550",
    });
    expect(await accountOf(control.core, org)).toMatchObject({ onetime_micros: credits(500) });
    expect(await reverse(half)).toMatchObject({ revokedMicros: String(credits(500)) });
    expect(await accountOf(control.core, org)).toMatchObject({ onetime_micros: credits(500) });
    // a lost dispute adds its amount, a dispute that was won again adds nothing
    const lost = [
      {
        id: "du_1",
        amountMinor: 200,
        movements: [{ id: "txn_1", direction: "withdrawn" }],
      },
    ];
    expect(await reverse(half, lost)).toEqual({
      revokedMicros: "681818181",
      refundedMinor: "750",
    });
    const won = [
      {
        id: "du_1",
        amountMinor: 200,
        movements: [
          { id: "txn_1", direction: "withdrawn" },
          { id: "txn_2", direction: "reinstated" },
        ],
      },
    ];
    expect(await reverse(half, won)).toMatchObject({ refundedMinor: "550" });
    expect((await accountOf(control.core, org)).onetime_micros).toBe(credits(1000) - 681_818_181);
    // everything refunded: nothing of the grant is left, and the rest is capped at the payment
    expect(
      await reverse([
        { id: "re_1", amountMinor: 550, status: "succeeded" },
        { id: "re_2", amountMinor: 550, status: "succeeded" },
      ]),
    ).toEqual({ revokedMicros: String(credits(1000)), refundedMinor: "1100" });
    expect(await accountOf(control.core, org)).toMatchObject({ onetime_micros: 0 });
    expect((await logOf(control.core, org)).filter((row) => row.kind === "reverse")).toHaveLength(
      3,
    );
  });

  it("take a paid invoice back from the monthly allowance and absorb what was spent", async () => {
    const org = (await newOrganization(control)).organizationId;
    await withCustomer(org);
    const pay = invoice(org);
    await store.stripeBilling.grantStripePayment(pay);
    await runChargeOrg(control.core, {
      organizationId: org,
      key: "use:invoice",
      amountMicros: credits(900),
      now: NOW,
    });
    const result = await store.stripeBilling.reverseStripePayment({
      organizationId: org,
      payment: {
        kind: "invoice",
        invoiceId: pay.payment.invoiceId,
        paymentIntentId: pay.payment.paymentIntentId,
      },
      observation: observation(org, pay.payment.paymentIntentId, 1100, [
        { id: "re_9", amountMinor: 1100, status: "succeeded" },
      ]),
      now: NOW,
    });
    expect(result.revokedMicros).toBe(String(credits(1000)));
    // 100 credits were left; the 900 that were already spent are the platform's loss
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: 0,
      overrun_micros: credits(900),
    });
  });

  it("end the Paid coverage of a fully returned invoice, while a partial refund keeps it", async () => {
    const org = (await newOrganization(control)).organizationId;
    await withCustomer(org);
    const pay = invoice(org);
    const key = pay.payment.paymentIntentId;
    await store.stripeBilling.grantStripePayment(pay);
    const reverse = (items: { id: string; amountMinor: number; status: string }[]) =>
      store.stripeBilling.reverseStripePayment({
        organizationId: org,
        payment: { kind: "invoice", invoiceId: pay.payment.invoiceId, paymentIntentId: key },
        observation: observation(org, key, 1100, items),
        now: NOW,
      });
    await reverse([{ id: "re_half", amountMinor: 550, status: "succeeded" }]);
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-14T09:00:00.000000Z",
      paid_source: "stripe",
    });
    await reverse([{ id: "re_all", amountMinor: 1100, status: "succeeded" }]);
    const returned = await accountOf(control.core, org);
    const coverageEnd = returned.paid_until ?? "";
    expect(coverageEnd !== "" && coverageEnd <= STORED(NOW)).toBe(true);
    expect(returned.paid_source).toBeNull();
    // the renewal on 1 December is the Free allowance, not the 1000 credits of a Paid month
    expect((await readAccount(control.core, org, "2026-12-01T00:00:00.000Z")).monthlyMicros).toBe(
      FREE_MONTHLY_MICROS,
    );
  });

  it("fall back to the coverage of the invoice that is still paid when a later one is returned", async () => {
    const org = (await newOrganization(control)).organizationId;
    await withCustomer(org);
    const earlier = invoice(org, {
      periodStart: "2026-09-30T09:00:00.000Z",
      periodEnd: "2026-10-30T09:00:00.000Z",
    });
    const later = invoice(org);
    await store.stripeBilling.grantStripePayment(earlier);
    await store.stripeBilling.grantStripePayment(later);
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-14T09:00:00.000000Z",
    });
    const key = later.payment.paymentIntentId;
    await store.stripeBilling.reverseStripePayment({
      organizationId: org,
      payment: { kind: "invoice", invoiceId: later.payment.invoiceId, paymentIntentId: key },
      observation: observation(org, key, 1100, [
        { id: "re_later", amountMinor: 1100, status: "succeeded" },
      ]),
      now: NOW,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-11-13T09:00:00.000000Z",
      paid_source: "stripe",
    });
  });

  it("keep the Paid coverage when the earlier invoice is returned while the later one stands", async () => {
    const org = (await newOrganization(control)).organizationId;
    await withCustomer(org);
    const earlier = invoice(org, {
      periodStart: "2026-09-30T09:00:00.000Z",
      periodEnd: "2026-10-30T09:00:00.000Z",
    });
    await store.stripeBilling.grantStripePayment(earlier);
    await store.stripeBilling.grantStripePayment(invoice(org));
    const key = earlier.payment.paymentIntentId;
    await store.stripeBilling.reverseStripePayment({
      organizationId: org,
      payment: { kind: "invoice", invoiceId: earlier.payment.invoiceId, paymentIntentId: key },
      observation: observation(org, key, 1100, [
        { id: "re_earlier", amountMinor: 1100, status: "succeeded" },
      ]),
      now: NOW,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-14T09:00:00.000000Z",
      paid_source: "stripe",
    });
  });

  it("keep the Paid coverage when another invoice has no known coverage end", async () => {
    const org = (await newOrganization(control)).organizationId;
    await withCustomer(org);
    const legacy = invoice(org, {
      periodStart: "2026-09-30T09:00:00.000Z",
      periodEnd: "2026-10-30T09:00:00.000Z",
    });
    const later = invoice(org);
    await store.stripeBilling.grantStripePayment(legacy);
    await store.stripeBilling.grantStripePayment(later);
    // a grant made before the coverage end was recorded
    await control.core
      .prepare("UPDATE credit_grant SET covers_until = NULL WHERE key = ?1")
      .bind(`invoice:${legacy.payment.invoiceId}`)
      .run();
    const key = later.payment.paymentIntentId;
    await store.stripeBilling.reverseStripePayment({
      organizationId: org,
      payment: { kind: "invoice", invoiceId: later.payment.invoiceId, paymentIntentId: key },
      observation: observation(org, key, 1100, [
        { id: "re_later", amountMinor: 1100, status: "succeeded" },
      ]),
      now: NOW,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-14T09:00:00.000000Z",
      paid_source: "stripe",
    });
  });

  it("ask the owner to look at a refunded recharge before the next one", async () => {
    const org = (await newOrganization(control)).organizationId;
    await withCustomer(org);
    await control.core
      .prepare(
        "INSERT INTO stripe_recharge_policies VALUES (?1, 'acct_payments', 'test', 1, 1, 3000, 'on', ?2, NULL, 'pm_1', ?3, NULL)",
      )
      .bind(org, newUlid(), STORED(NOW))
      .run();
    const pay = recharge(org);
    await store.stripeBilling.grantStripePayment(pay);
    const reverse = (status: string) =>
      store.stripeBilling.reverseStripePayment({
        organizationId: org,
        payment: { kind: "recharge", paymentIntentId: pay.payment.paymentIntentId },
        observation: observation(org, pay.payment.paymentIntentId, 990, [
          { id: "re_r", amountMinor: 990, status },
        ]),
        now: NOW,
      });
    await reverse("failed");
    expect(
      await first(
        control.core,
        "SELECT status FROM stripe_recharge_policies WHERE organization_id = ?",
        org,
      ),
    ).toEqual({ status: "on" });
    await reverse("succeeded");
    expect(
      await first(
        control.core,
        "SELECT status FROM stripe_recharge_policies WHERE organization_id = ?",
        org,
      ),
    ).toEqual({ status: "payment_required" });
  });

  it("refuse an observation of another payment, a payment that was never credited and a malformed one", async () => {
    const org = (await newOrganization(control)).organizationId;
    await withCustomer(org);
    const pay = topup(org);
    const key = pay.payment.paymentIntentId;
    await store.stripeBilling.grantStripePayment(pay);
    const reverse = (
      observed: ReturnType<typeof observation>,
      payment = key,
      organizationId = org,
    ) =>
      store.stripeBilling.reverseStripePayment({
        organizationId,
        payment: { kind: "topup", paymentIntentId: payment },
        observation: observed,
        now: NOW,
      });
    // another total, another payment, another customer
    await expect(reverse(observation(org, key, 1000))).rejects.toThrow(
      "billing_refund_scope_conflict",
    );
    await expect(reverse(observation(org, "pi_other", 1100))).rejects.toThrow(
      "billing_refund_scope_conflict",
    );
    await expect(
      reverse({ ...observation(org, key, 1100), customerId: "cus_other" }),
    ).rejects.toThrow("billing_refund_scope_conflict");
    await expect(
      reverse({ ...observation(org, key, 1100), accountId: "acct_other" }),
    ).rejects.toThrow("billing_refund_scope_conflict");
    // a payment that was never credited, and one of another organization
    await expect(reverse(observation(org, "pi_never", 1100), "pi_never")).rejects.toThrow(
      "billing_refund_scope_conflict",
    );
    const stranger = (await newOrganization(control)).organizationId;
    await withCustomer(stranger);
    await expect(reverse(observation(stranger, key, 1100), key, stranger)).rejects.toThrow(
      "billing_refund_scope_conflict",
    );
    await expect(
      reverse(observation(org, key, 1100, [{ id: "re_x", amountMinor: 1, status: "bogus" }])),
    ).rejects.toThrow("billing_refund_invalid");
    await expect(store.stripeBilling.reverseStripePayment({})).rejects.toThrow(
      "billing_request_invalid",
    );
    expect(await accountOf(control.core, org)).toMatchObject({ onetime_micros: credits(1000) });
  });
});

describe("the Paid coverage of a subscription", () => {
  it("closes at Stripe's end, but never an operator's or a referral's access", async () => {
    const org = (await newOrganization(control)).organizationId;
    await store.stripeBilling.grantStripePayment(invoice(org));
    const end = {
      organizationId: org,
      subscriptionId: `sub_${org}`,
      endedAt: "2026-11-05T00:00:00.000Z",
      now: NOW,
    };
    expect(await store.stripeBilling.recordStripeSubscriptionEnd(end)).toEqual({ recorded: true });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-11-05T00:00:00.000000Z",
      paid_source: "stripe",
    });
    // a later end, or the same end again, never reopens it
    await store.stripeBilling.recordStripeSubscriptionEnd({
      ...end,
      endedAt: "2026-12-05T00:00:00.000Z",
    });
    await store.stripeBilling.recordStripeSubscriptionEnd(end);
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-11-05T00:00:00.000000Z",
    });
    const other = (await newOrganization(control)).organizationId;
    await makePaid(control.core, other, "2026-12-01T00:00:00.000Z", NOW, "granted");
    await store.stripeBilling.recordStripeSubscriptionEnd({ ...end, organizationId: other });
    expect(await accountOf(control.core, other)).toMatchObject({
      paid_until: "2026-12-01T00:00:00.000000Z",
      paid_source: "granted",
    });
    await expect(
      store.stripeBilling.recordStripeSubscriptionEnd({
        ...end,
        organizationId: ulidOf("ghost", 52),
      }),
    ).rejects.toThrow(/organization_credit_scope_missing|route/u);
    await expect(store.stripeBilling.recordStripeSubscriptionEnd({})).rejects.toThrow(
      "billing_request_invalid",
    );
  });
});

describe("a granted or bounded access under a subscription", () => {
  for (const source of ["granted", "manual"] as const) {
    it(`keeps ${source} Paid days that run past a subscription which ends first, and gives them back once the payment is taken back`, async () => {
      const org = (await newOrganization(control)).organizationId;
      // access until 6 Dec; an invoice of the period that ends 1 Dec covers to 15 Dec, which overwrites the access
      await makePaid(control.core, org, "2026-12-06T00:00:00.000Z", NOW, source);
      await store.stripeBilling.grantStripePayment(
        invoice(org, {
          periodStart: "2026-11-01T00:00:00.000Z",
          periodEnd: "2026-12-01T00:00:00.000Z",
        }),
      );
      expect(await accountOf(control.core, org)).toMatchObject({
        paid_until: "2026-12-15T00:00:00.000000Z",
        paid_source: "stripe",
      });
      // the subscription ends on 1 Dec, before the access does: the Stripe coverage ends, the access stays
      await store.stripeBilling.recordStripeSubscriptionEnd({
        organizationId: org,
        subscriptionId: `sub_${org}`,
        endedAt: "2026-12-01T00:00:00.000Z",
        now: NOW,
      });
      expect(await accountOf(control.core, org)).toMatchObject({
        paid_until: "2026-12-06T00:00:00.000000Z",
        paid_source: source,
      });
    });
  }
});

describe("a kept access after an operator or a later invoice", () => {
  it("is dropped when an operator ends the coverage, so a later subscription end cannot bring it back", async () => {
    const org = (await newOrganization(control)).organizationId;
    await makePaid(control.core, org, "2026-12-06T00:00:00.000Z", NOW, "granted");
    await store.stripeBilling.grantStripePayment(
      invoice(org, {
        periodStart: "2026-11-01T00:00:00.000Z",
        periodEnd: "2026-12-01T00:00:00.000Z",
      }),
    );
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-15T00:00:00.000000Z",
      paid_source: "stripe",
    });
    // the operator ends the coverage; the access that the invoice kept aside belonged to the coverage that is ended
    await endPaid(control.core, org, NOW);
    // a later invoice starts a new coverage, and its subscription then ends before the period does
    await store.stripeBilling.grantStripePayment(
      invoice(org, {
        periodStart: "2026-12-01T00:00:00.000Z",
        periodEnd: "2027-01-01T00:00:00.000Z",
      }),
    );
    await store.stripeBilling.recordStripeSubscriptionEnd({
      organizationId: org,
      subscriptionId: `sub_${org}`,
      endedAt: "2026-12-02T00:00:00.000Z",
      now: NOW,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-02T00:00:00.000000Z",
      paid_source: "stripe",
    });
  });

  it("keeps the access that was first captured when a later invoice only extends the Stripe coverage", async () => {
    const org = (await newOrganization(control)).organizationId;
    await makePaid(control.core, org, "2026-12-06T00:00:00.000Z", NOW, "granted");
    await store.stripeBilling.grantStripePayment(
      invoice(org, {
        periodStart: "2026-11-01T00:00:00.000Z",
        periodEnd: "2026-12-01T00:00:00.000Z",
      }),
    );
    // the second invoice overwrites nothing: the Stripe coverage it extends is not access that Stripe overwrote
    await store.stripeBilling.grantStripePayment(
      invoice(org, {
        periodStart: "2026-12-01T00:00:00.000Z",
        periodEnd: "2027-01-01T00:00:00.000Z",
      }),
    );
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2027-01-15T00:00:00.000000Z",
      paid_source: "stripe",
    });
    expect(
      await first(
        control.core,
        "SELECT granted_until, granted_source FROM credit_account WHERE organization_id = ?",
        org,
      ),
    ).toEqual({ granted_until: "2026-12-06T00:00:00.000000Z", granted_source: "granted" });
  });
});

describe("the Paid coverage of each subscription", () => {
  it("lets the end of an ended subscription close only the coverage that subscription produced", async () => {
    const org = (await newOrganization(control)).organizationId;
    await store.stripeBilling.grantStripePayment(
      invoice(org, { subscriptionId: "sub_first", endedAt: "2026-11-05T00:00:00.000Z" }),
    );
    // a newer subscription pays after the first one ended, so the organization is Paid through it
    await store.stripeBilling.grantStripePayment(invoice(org, { subscriptionId: "sub_second" }));
    const owner = () =>
      first<{ paid_subscription_id: string | null }>(
        control.core,
        "SELECT paid_subscription_id FROM credit_account WHERE organization_id = ?",
        org,
      );
    expect(await owner()).toEqual({ paid_subscription_id: "sub_second" });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-14T09:00:00.000000Z",
      paid_source: "stripe",
    });
    // a late end of the first subscription, from a refund or a status read of its old checkout, changes nothing
    await store.stripeBilling.recordStripeSubscriptionEnd({
      organizationId: org,
      subscriptionId: "sub_first",
      endedAt: "2026-11-05T00:00:00.000Z",
      now: NOW,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-14T09:00:00.000000Z",
      paid_source: "stripe",
    });
    // the end of the subscription that is paid closes its coverage
    await store.stripeBilling.recordStripeSubscriptionEnd({
      organizationId: org,
      subscriptionId: "sub_second",
      endedAt: "2026-11-20T00:00:00.000Z",
      now: NOW,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-11-20T00:00:00.000000Z",
    });
  });
});

describe("the referral reward", () => {
  /** An organization whose first onboarding request came from `source`. */
  async function referred(from: string | ((payer: string) => string)): Promise<string> {
    const payer = await newOrganization(control);
    const source = typeof from === "string" ? from : from(payer.organizationId);
    const user = `user_${payer.organizationId}`;
    const request = newUlid();
    const workos = await first<{ id: string }>(
      control.core,
      "SELECT workos_organization_id AS id FROM organizations WHERE organization_id = ?",
      payer.organizationId,
    );
    await control.core.batch([
      control.core
        .prepare(
          "INSERT OR IGNORE INTO signup_sources(source_id, active, admits_beta, bonus_micros) VALUES (?, 1, 1, 0)",
        )
        .bind(source),
      control.core
        .prepare(
          "INSERT INTO onboarding_requests(request_id, workos_user_id, idempotency_sha256, request_sha256, name, workos_organization_id, organization_id, completed_at, signup_source, created_at, organization_attempted, membership_attempted) VALUES (?, ?, zeroblob(32), unhex(?), 'Payer', ?, ?, ?, ?, ?, 1, 1)",
        )
        .bind(
          request,
          user,
          "11".repeat(32),
          workos.id,
          payer.organizationId,
          STORED(NOW),
          source,
          STORED(NOW),
        ),
      control.core
        .prepare(
          "INSERT INTO user_signup(workos_user_id, origin_present, recorded_at, attributed_source, first_request_id, bonus_micros, attributed_at) VALUES (?, 0, ?, ?, ?, '0', ?)",
        )
        .bind(user, STORED(NOW), source, request, STORED(NOW)),
    ]);
    return payer.organizationId;
  }
  const pay = (organizationId: string) =>
    store.stripeBilling.grantStripePayment(topup(organizationId));

  it("gives the referrer 1000 credits and 30 days of Paid for the first payment, once", async () => {
    const referrer = (await newOrganization(control)).organizationId;
    const payer = await referred(`ref-${referrer.toLowerCase()}`);
    await pay(payer);
    const key = `referral_reward:${payer}`;
    expect(
      await all(
        control.core,
        "SELECT organization_id, amount_micros FROM credit_grant WHERE key = ?",
        key,
      ),
    ).toEqual([{ organization_id: referrer, amount_micros: credits(1000) }]);
    expect(await accountOf(control.core, referrer)).toMatchObject({
      onetime_micros: credits(1000),
      paid_until: "2026-11-29T10:00:00.000000Z",
      paid_source: "granted",
    });
    // the payer's second payment, and the same payment again, reward nobody
    await pay(payer);
    await store.stripeBilling.grantStripePayment({
      ...topup(payer),
      now: "2026-11-02T00:00:00.000Z",
    });
    expect(await accountOf(control.core, referrer)).toMatchObject({
      onetime_micros: credits(1000),
      paid_until: "2026-11-29T10:00:00.000000Z",
    });
    expect(await all(control.core, "SELECT 1 FROM credit_grant WHERE key = ?", key)).toHaveLength(
      1,
    );
  });

  it("pays a referrer at most ten rewards, and a later payer of that referrer earns none", async () => {
    const referrer = (await newOrganization(control)).organizationId;
    for (let index = 1; index <= 10; index += 1)
      await control.core
        .prepare(
          "INSERT INTO credit_grant(key, organization_id, amount_micros, paid_minor, reversed_micros, granted_at, covers_until) VALUES (?1, ?2, 0, NULL, 0, ?3, NULL)",
        )
        .bind(`referral_reward:earlier_${index}`, referrer, STORED(NOW))
        .run();
    const payer = await referred(`ref-${referrer.toLowerCase()}`);
    await pay(payer);
    expect(
      await all(
        control.core,
        "SELECT key FROM credit_grant WHERE key = ?",
        `referral_reward:${payer}`,
      ),
    ).toEqual([]);
    expect(
      await all(
        control.core,
        "SELECT key FROM credit_grant WHERE organization_id = ? AND key LIKE 'referral_reward:%'",
        referrer,
      ),
    ).toHaveLength(10);
  });

  it("takes the granted Paid days back once when two reversals of the same payment overlap", async () => {
    const referrer = (await newOrganization(control)).organizationId;
    await makePaid(control.core, referrer, "2026-12-31T00:00:00.000Z", NOW, "granted");
    const payer = await referred(`ref-${referrer.toLowerCase()}`);
    const pay = topup(payer);
    await store.stripeBilling.grantStripePayment(pay);
    expect((await accountOf(control.core, referrer)).paid_until).toBe(
      "2027-01-30T00:00:00.000000Z",
    );
    const paymentKey = `topup:${pay.payment.paymentIntentId}`;
    // both reversals read the reward before either one writes, as two concurrent observations do
    const first = await clawBackReferralReward(control.core, {
      payerId: payer,
      paymentKey,
      now: NOW,
    });
    const second = await clawBackReferralReward(control.core, {
      payerId: payer,
      paymentKey,
      now: NOW,
    });
    await control.core.batch(first);
    await control.core.batch(second);
    expect(await accountOf(control.core, referrer)).toMatchObject({
      onetime_micros: 0,
      paid_until: "2026-12-31T00:00:00.000000Z",
    });
  });

  it("claws the reward back from the payment that earned it, not from the first payment, which earned nothing", async () => {
    const referrer = (await newOrganization(control)).organizationId;
    await control.core
      .prepare("UPDATE organizations SET state = 'suspended' WHERE organization_id = ?")
      .bind(referrer)
      .run();
    const payer = await referred(`ref-${referrer.toLowerCase()}`);
    await withCustomer(payer);
    // the referrer is not active yet: the first payment earns no reward
    const first = topup(payer);
    await store.stripeBilling.grantStripePayment(first);
    expect(
      await all(
        control.core,
        "SELECT key FROM credit_grant WHERE key = ?",
        `referral_reward:${payer}`,
      ),
    ).toEqual([]);
    await control.core
      .prepare("UPDATE organizations SET state = 'active' WHERE organization_id = ?")
      .bind(referrer)
      .run();
    // the second payment earns it
    const LATER = "2026-11-02T00:00:00.000Z";
    const second = { ...topup(payer), now: LATER };
    await store.stripeBilling.grantStripePayment(second);
    expect((await accountOf(control.core, referrer)).onetime_micros).toBe(credits(1000));
    const reverse = (payment: ReturnType<typeof topup>, at: string) =>
      store.stripeBilling.reverseStripePayment({
        organizationId: payer,
        payment: { kind: "topup", paymentIntentId: payment.payment.paymentIntentId },
        observation: observation(payer, payment.payment.paymentIntentId, 1100, [
          { id: `re_${payment.payment.paymentIntentId}`, amountMinor: 1100, status: "succeeded" },
        ]),
        now: at,
      });
    // refunding the payment that earned nothing takes nothing from the referrer
    await reverse(first, NOW);
    expect((await accountOf(control.core, referrer)).onetime_micros).toBe(credits(1000));
    // refunding the payment that earned the reward takes it back
    await reverse(second, LATER);
    expect((await accountOf(control.core, referrer)).onetime_micros).toBe(0);
  });

  it("claws back only for the payer's first paid grant, so a refund of a later payment takes nothing", async () => {
    const referrer = (await newOrganization(control)).organizationId;
    const payer = await referred(`ref-${referrer.toLowerCase()}`);
    await withCustomer(payer);
    const first = topup(payer);
    await store.stripeBilling.grantStripePayment(first);
    const later = { ...topup(payer), now: "2026-11-02T00:00:00.000Z" };
    await store.stripeBilling.grantStripePayment(later);
    await store.stripeBilling.reverseStripePayment({
      organizationId: payer,
      payment: { kind: "topup", paymentIntentId: later.payment.paymentIntentId },
      observation: observation(payer, later.payment.paymentIntentId, 1100, [
        { id: "re_later", amountMinor: 1100, status: "succeeded" },
      ]),
      now: "2026-11-02T00:00:00.000Z",
    });
    expect(await accountOf(control.core, referrer)).toMatchObject({
      onetime_micros: credits(1000),
      paid_until: "2026-11-29T10:00:00.000000Z",
    });
    await store.stripeBilling.reverseStripePayment({
      organizationId: payer,
      payment: { kind: "topup", paymentIntentId: first.payment.paymentIntentId },
      observation: observation(payer, first.payment.paymentIntentId, 1100, [
        { id: "re_first", amountMinor: 1100, status: "succeeded" },
      ]),
      now: NOW,
    });
    expect((await accountOf(control.core, referrer)).onetime_micros).toBe(0);
  });

  it("claws the referrer's reward back when the payer's payment is refunded, and only once", async () => {
    const referrer = (await newOrganization(control)).organizationId;
    const payer = await referred(`ref-${referrer.toLowerCase()}`);
    await withCustomer(payer);
    const pay = topup(payer);
    await store.stripeBilling.grantStripePayment(pay);
    expect(await accountOf(control.core, referrer)).toMatchObject({
      onetime_micros: credits(1000),
      paid_until: "2026-11-29T10:00:00.000000Z",
    });
    const reverse = (items: { id: string; amountMinor: number; status: string }[]) =>
      store.stripeBilling.reverseStripePayment({
        organizationId: payer,
        payment: { kind: "topup", paymentIntentId: pay.payment.paymentIntentId },
        observation: observation(payer, pay.payment.paymentIntentId, 1100, items),
        now: NOW,
      });
    await reverse([{ id: "re_part", amountMinor: 550, status: "succeeded" }]);
    expect(await accountOf(control.core, referrer)).toMatchObject({
      onetime_micros: 0,
      paid_until: STORED(NOW),
      paid_source: "granted",
    });
    // a later refund of the same payment takes nothing more back from the referrer
    await reverse([{ id: "re_rest", amountMinor: 550, status: "succeeded" }]);
    expect(await accountOf(control.core, referrer)).toMatchObject({
      onetime_micros: 0,
      paid_until: STORED(NOW),
    });
  });

  it("takes the reward's days back from a granted access that a later invoice of the referrer overwrote", async () => {
    const referrer = (await newOrganization(control)).organizationId;
    await makePaid(control.core, referrer, "2026-12-31T00:00:00.000Z", NOW, "granted");
    const payer = await referred(`ref-${referrer.toLowerCase()}`);
    const pay = topup(payer);
    await store.stripeBilling.grantStripePayment(pay);
    expect((await accountOf(control.core, referrer)).paid_until).toBe(
      "2027-01-30T00:00:00.000000Z",
    );
    // the referrer's invoice covers to 3 Feb 2027 and so overwrites the granted access, which it keeps aside
    await withCustomer(referrer);
    await store.stripeBilling.grantStripePayment(
      invoice(referrer, {
        periodStart: "2026-12-20T00:00:00.000Z",
        periodEnd: "2027-01-20T00:00:00.000Z",
      }),
    );
    expect(await accountOf(control.core, referrer)).toMatchObject({
      paid_until: "2027-02-03T00:00:00.000000Z",
      paid_source: "stripe",
    });
    await control.core.batch(
      await clawBackReferralReward(control.core, {
        payerId: payer,
        paymentKey: `topup:${pay.payment.paymentIntentId}`,
        now: NOW,
      }),
    );
    expect(
      await first(
        control.core,
        "SELECT granted_until, granted_source FROM credit_account WHERE organization_id = ?",
        referrer,
      ),
    ).toEqual({ granted_until: "2026-12-31T00:00:00.000000Z", granted_source: "granted" });
  });

  it("takes no days back from a granted access that an invoice overwrote before the reward came", async () => {
    const referrer = (await newOrganization(control)).organizationId;
    await withCustomer(referrer);
    // granted until 31 Dec; the referrer's invoice covers to 3 Feb 2027 and keeps 31 Dec aside
    await makePaid(control.core, referrer, "2026-12-31T00:00:00.000Z", NOW, "granted");
    await store.stripeBilling.grantStripePayment(
      invoice(referrer, {
        periodStart: "2026-12-20T00:00:00.000Z",
        periodEnd: "2027-01-20T00:00:00.000Z",
      }),
    );
    expect(await accountOf(control.core, referrer)).toMatchObject({
      paid_until: "2027-02-03T00:00:00.000000Z",
      paid_source: "stripe",
    });
    // the payer arrives after the overwrite: the Stripe coverage stands, so the kept access gets none of the reward's days
    const payer = await referred(`ref-${referrer.toLowerCase()}`);
    const later = { ...topup(payer), now: "2026-11-02T00:00:00.000Z" };
    await store.stripeBilling.grantStripePayment(later);
    expect(await accountOf(control.core, referrer)).toMatchObject({
      onetime_micros: credits(1000),
      paid_until: "2027-02-03T00:00:00.000000Z",
    });
    await control.core.batch(
      await clawBackReferralReward(control.core, {
        payerId: payer,
        paymentKey: `topup:${later.payment.paymentIntentId}`,
        now: "2026-11-03T00:00:00.000Z",
      }),
    );
    expect(
      await first(
        control.core,
        "SELECT granted_until, granted_source FROM credit_account WHERE organization_id = ?",
        referrer,
      ),
    ).toEqual({ granted_until: "2026-12-31T00:00:00.000000Z", granted_source: "granted" });
  });

  it("extends a granted access by 30 days and leaves a Stripe or operator access alone", async () => {
    const granted = (await newOrganization(control)).organizationId;
    await makePaid(control.core, granted, "2026-11-10T00:00:00.000Z", NOW, "granted");
    await pay(await referred(`ref-${granted.toLowerCase()}`));
    expect((await accountOf(control.core, granted)).paid_until).toBe("2026-12-10T00:00:00.000000Z");
    const stripe = (await newOrganization(control)).organizationId;
    await store.stripeBilling.grantStripePayment(invoice(stripe));
    await pay(await referred(`ref-${stripe.toLowerCase()}`));
    expect(await accountOf(control.core, stripe)).toMatchObject({
      paid_until: "2026-12-14T09:00:00.000000Z",
      paid_source: "stripe",
      onetime_micros: credits(1000),
    });
  });

  it("rewards the owner of the project whose powered-by flag brought the payer", async () => {
    const project = await newOrganization(control);
    await pay(await referred(`flag-${project.projectId.toLowerCase()}`));
    expect(await accountOf(control.core, project.organizationId)).toMatchObject({
      onetime_micros: credits(1000),
      paid_source: "granted",
    });
  });

  it("rewards nobody for a direct signup, a payer's own organization or an unknown referrer", async () => {
    const rewards = () =>
      all(control.core, "SELECT key FROM credit_grant WHERE key LIKE 'referral_reward:%'");
    const before = await rewards();
    await pay(await referred("direct"));
    await pay(await referred(() => `ref-${ulidOf("self", 1).toLowerCase()}`));
    await pay(await referred((payer) => `ref-${payer.toLowerCase()}`));
    await pay(await referred(() => `flag-${ulidOf("self", 2).toLowerCase()}`));
    expect(await rewards()).toEqual(before);
  });

  it("refuses to guess between two first requests of one organization", async () => {
    const payer = await referred("direct");
    const user = `user_second_${payer}`;
    const request = newUlid();
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO onboarding_requests(request_id, workos_user_id, idempotency_sha256, request_sha256, name, workos_organization_id, organization_id, completed_at, signup_source, created_at, organization_attempted, membership_attempted) SELECT ?, ?, zeroblob(32), unhex(?), 'Payer', 'org_second_' || organization_id, organization_id, completed_at, signup_source, created_at, 1, 1 FROM onboarding_requests WHERE organization_id = ?",
        )
        .bind(request, user, "22".repeat(32), payer),
      control.core
        .prepare(
          "INSERT INTO user_signup(workos_user_id, origin_present, recorded_at, attributed_source, first_request_id, bonus_micros, attributed_at) VALUES (?, 0, ?, 'direct', ?, '0', ?)",
        )
        .bind(user, STORED(NOW), request, STORED(NOW)),
    ]);
    await expect(pay(payer)).rejects.toThrow("referral_payment_scope_changed");
  });
});

describe("a granted access that a refunded invoice overwrote", () => {
  it("comes back when the invoice is refunded in full", async () => {
    const org = (await newOrganization(control)).organizationId;
    await withCustomer(org);
    await makePaid(control.core, org, "2026-12-06T00:00:00.000Z", NOW, "granted");
    const pay = invoice(org, {
      periodStart: "2026-11-01T00:00:00.000Z",
      periodEnd: "2026-12-01T00:00:00.000Z",
    });
    const key = pay.payment.paymentIntentId;
    await store.stripeBilling.grantStripePayment(pay);
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-15T00:00:00.000000Z",
      paid_source: "stripe",
    });
    await store.stripeBilling.reverseStripePayment({
      organizationId: org,
      payment: { kind: "invoice", invoiceId: pay.payment.invoiceId, paymentIntentId: key },
      observation: observation(org, key, 1100, [
        { id: "re_all", amountMinor: 1100, status: "succeeded" },
      ]),
      now: NOW,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-12-06T00:00:00.000000Z",
      paid_source: "granted",
    });
  });
});
