import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RECHARGE_LEASE_MS,
  rechargeDue,
} from "../../src/catalog/billing/stripe-recharge-metadata.js";
import { newUlid } from "../../src/catalog/common.js";
import { runChargeOrg, runGrantCredit } from "../../src/catalog/credit/index.js";
import { createControlStore } from "../../src/store.js";
import { accountOf, all, credits, first, newOrganization } from "../credit/support.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { makePaid } from "../support/credit-fixtures.js";
import { ulidOf } from "../support/platform-fixtures.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 120_000);
afterAll(async () => control.dispose());

const NOW = "2026-10-30T10:00:00.000Z";
const LATER = new Date(Date.parse(NOW) + RECHARGE_LEASE_MS + 1000).toISOString();
const scope = (organizationId: string, now = NOW, accountId = "acct_recharge") => ({
  organizationId,
  accountId,
  mode: "test" as const,
  now,
});
const configure = (
  organizationId: string,
  extra: Record<string, unknown> = {},
  accountId = "acct_recharge",
) => ({
  ...scope(organizationId, NOW, accountId),
  enabled: true,
  monthlyLimitMinor: 3000,
  consent: "off_session_v1",
  revision: 0,
  actorId: "user:owner",
  idempotencyKey: "recharge-1",
  id: newUlid(),
  ...extra,
});
async function paid(): Promise<string> {
  const org = (await newOrganization(control)).organizationId;
  await makePaid(control.core, org, "2099-01-01T00:00:00.000Z", NOW, "manual");
  return org;
}
/** A policy with a saved card whose organization has spent all but `left` credits. */
async function armed(left = 50, accountId = "acct_recharge"): Promise<string> {
  const org = await paid();
  await store.stripeBilling.configureRecharge(configure(org, {}, accountId));
  await store.stripeBilling.saveRechargeSetup({
    ...scope(org, NOW, accountId),
    revision: 1,
    sessionId: "cs_setup",
    paymentMethodId: "pm_1",
    expired: false,
  });
  await runChargeOrg(control.core, {
    organizationId: org,
    key: `spend:${org}`,
    amountMicros: credits(1000 - left),
    now: NOW,
  });
  return org;
}
const setupRow = (org: string) =>
  first<{ setup_id: string; setup_session_id: string | null }>(
    control.core,
    "SELECT setup_id, setup_session_id FROM stripe_recharge_policies WHERE organization_id = ?",
    org,
  );
const status = async (org: string) =>
  (
    await first<{ status: string }>(
      control.core,
      "SELECT status FROM stripe_recharge_policies WHERE organization_id = ?",
      org,
    )
  ).status;

describe("configuring automatic recharge", () => {
  it("needs Paid, saves a card first and treats a repeat as the answer to the first", async () => {
    const free = (await newOrganization(control)).organizationId;
    await expect(store.stripeBilling.configureRecharge(configure(free))).rejects.toThrow(
      "paid_plan_required",
    );
    // turning it off needs nothing
    expect(
      await store.stripeBilling.configureRecharge(
        configure(free, { enabled: false, consent: null, id: newUlid() }),
      ),
    ).toMatchObject({ enabled: false, status: "off", revision: 1 });
    const org = await paid();
    const input = configure(org);
    const view = await store.stripeBilling.configureRecharge(input);
    expect(view).toEqual({
      organization_id: org,
      portal_available: false,
      enabled: true,
      revision: 1,
      status: "setup_required",
      monthly_limit_minor: 3000,
      spent_minor: 0,
      currency: "usd",
      amount_minor: 900,
      credits: 1000,
      threshold_credits: 100,
      setup_url: null,
      invoice_url: null,
      billing_issue: null,
    });
    expect(await store.stripeBilling.configureRecharge(input)).toEqual(view);
    expect(
      await all(
        control.core,
        "SELECT revision FROM stripe_recharge_policies WHERE organization_id = ?",
        org,
      ),
    ).toEqual([{ revision: 1 }]);
    // a second tab that saw the old revision loses, however it asks
    await expect(
      store.stripeBilling.configureRecharge(configure(org, { monthlyLimitMinor: 5000 })),
    ).rejects.toThrow("billing_conflict");
    expect(
      await store.stripeBilling.configureRecharge(
        configure(org, { revision: 1, monthlyLimitMinor: 5000 }),
      ),
    ).toMatchObject({ revision: 2, monthly_limit_minor: 5000, status: "setup_required" });
    await expect(
      store.stripeBilling.configureRecharge(configure(org, { consent: null, revision: 2 })),
    ).rejects.toThrow("billing_request_invalid");
    await expect(
      store.stripeBilling.configureRecharge(
        configure(org, { monthlyLimitMinor: 999, revision: 2 }),
      ),
    ).rejects.toThrow("billing_request_invalid");
    // the policy of another account or mode is not this one's to change
    await expect(
      store.stripeBilling.configureRecharge(configure(org, { mode: "live", revision: 2 })),
    ).rejects.toThrow("billing_conflict");
  });

  it("keeps a saved card when it is switched off and on again", async () => {
    const org = await armed();
    expect(await status(org)).toBe("on");
    expect(
      await store.stripeBilling.configureRecharge(
        configure(org, { enabled: false, consent: null, revision: 1 }),
      ),
    ).toMatchObject({ enabled: false, status: "off", revision: 2 });
    expect(
      await store.stripeBilling.configureRecharge(configure(org, { revision: 2 })),
    ).toMatchObject({ enabled: true, status: "on", revision: 3 });
    expect(await store.stripeBilling.readRechargePolicy(scope(org))).toMatchObject({
      payment_method_id: "pm_1",
      setup_session_id: "cs_setup",
      enabled: true,
    });
    expect(await store.stripeBilling.readRechargePolicy(scope(ulidOf("none", 71)))).toBe(null);
  });
});

describe("the card of a setup session", () => {
  it("makes the policy ready, or asks for another setup when the session expired", async () => {
    const org = await paid();
    await store.stripeBilling.configureRecharge(configure(org));
    const setup = (extra: Record<string, unknown>) =>
      store.stripeBilling.saveRechargeSetup({
        ...scope(org),
        revision: 1,
        sessionId: "cs_1",
        paymentMethodId: null,
        expired: false,
        ...extra,
      });
    await setup({ revision: 7, paymentMethodId: "pm_stale" });
    expect(await status(org)).toBe("setup_required");
    await setup({});
    expect(await status(org)).toBe("setup_required");
    const waiting = await setupRow(org);
    expect(waiting.setup_session_id).toBe("cs_1");
    await setup({ expired: true });
    // the expired session is dropped and the policy asks for a new one, under a fresh setup id
    expect(await status(org)).toBe("setup_required");
    const replaced = await setupRow(org);
    expect(replaced.setup_session_id).toBeNull();
    expect(replaced.setup_id).not.toBe(waiting.setup_id);
    // a repeat of the expiry names a session that is gone, so it changes nothing
    await setup({ expired: true });
    expect(await setupRow(org)).toEqual(replaced);
    // only a policy that waits for a card takes one
    await setup({ paymentMethodId: "pm_late" });
    expect(await status(org)).toBe("on");
    const fresh = await paid();
    await store.stripeBilling.configureRecharge(configure(fresh));
    await store.stripeBilling.saveRechargeSetup({
      ...scope(fresh),
      revision: 1,
      sessionId: "cs_2",
      paymentMethodId: "pm_ok",
      expired: false,
    });
    expect(await status(fresh)).toBe("on");
    expect(await store.stripeBilling.readRecharge(scope(fresh))).toMatchObject({
      status: "on",
      portal_available: false,
    });
  });

  it("renews a waiting setup without a session only once it is a day old, under a fresh setup id", async () => {
    const org = await paid();
    await store.stripeBilling.configureRecharge(configure(org));
    const waiting = await setupRow(org);
    expect(waiting.setup_session_id).toBeNull();
    const renew = (now: string) =>
      store.stripeBilling.saveRechargeSetup({
        ...scope(org, now),
        revision: 1,
        sessionId: null,
        paymentMethodId: null,
        expired: true,
      });
    // half a day later the policy keeps its setup id, because a session of it may still be on its way
    await renew("2026-10-30T22:00:00.000Z");
    expect(await setupRow(org)).toEqual(waiting);
    // a day later the old id is past Stripe's idempotency window, so the policy gets a fresh one
    await renew("2026-11-01T10:00:00.000Z");
    const renewed = await setupRow(org);
    expect(renewed.setup_id).not.toBe(waiting.setup_id);
    expect(renewed.setup_session_id).toBeNull();
    expect(await status(org)).toBe("setup_required");
    expect(
      await first<{ updated_at: string }>(
        control.core,
        "SELECT updated_at FROM stripe_recharge_policies WHERE organization_id = ?",
        org,
      ),
    ).toEqual({ updated_at: "2026-11-01T10:00:00.000000Z" });
  });
});

describe("when a recharge is due", () => {
  it("is when a Paid organization with a saved card is down to less than 100 credits", () => {
    const policy = {
      enabled: 1,
      status: "on",
      payment_method_id: "pm_1",
      updated_at: "2026-10-01T00:00:00.000000Z",
    };
    const account = { paid: true, availableMicros: credits(99) };
    expect(rechargeDue(policy, account, NOW)).toBe(true);
    expect(rechargeDue(policy, { ...account, availableMicros: credits(100) }, NOW)).toBe(false);
    expect(rechargeDue(policy, { ...account, paid: false }, NOW)).toBe(false);
    expect(rechargeDue({ ...policy, enabled: 0 }, account, NOW)).toBe(false);
    expect(rechargeDue({ ...policy, payment_method_id: null }, account, NOW)).toBe(false);
    for (const waiting of ["setup_required", "payment_required", "tax_required", "off"])
      expect(rechargeDue({ ...policy, status: waiting }, account, NOW)).toBe(false);
    // a monthly limit holds until the month turns
    const limited = { ...policy, status: "monthly_limit" };
    expect(rechargeDue(limited, account, NOW)).toBe(false);
    expect(
      rechargeDue({ ...limited, updated_at: "2026-09-30T10:00:00.000000Z" }, account, NOW),
    ).toBe(true);
  });

  it("is claimed by one look at a time and reports what a recharge may still cost", async () => {
    const org = await armed(50);
    const claimed = await store.stripeBilling.claimRecharge(scope(org));
    expect(claimed).toMatchObject({
      create: true,
      remainingMinor: 3000,
      policy: { status: "on", checked_at: NOW },
    });
    // nobody else looks at it for two minutes
    expect(await store.stripeBilling.claimRecharge(scope(org, "2026-10-30T10:01:00.000Z"))).toBe(
      null,
    );
    expect(await store.stripeBilling.claimRecharge(scope(org, LATER))).toMatchObject({
      create: true,
    });
    // plenty of credit left: nothing is due
    const rich = await armed(500);
    expect(await store.stripeBilling.claimRecharge(scope(rich))).toMatchObject({ create: false });
    // recharge off: not claimable
    const off = await paid();
    await store.stripeBilling.configureRecharge(configure(off, { enabled: false, consent: null }));
    expect(await store.stripeBilling.claimRecharge(scope(off))).toBe(null);
  });

  it("stops at the monthly limit, which the grants of this month use up", async () => {
    const org = await armed(50);
    await store.stripeBilling.configureRecharge(
      configure(org, { revision: 1, monthlyLimitMinor: 1000 }),
    );
    expect(await store.stripeBilling.readRecharge(scope(org))).toMatchObject({
      status: "on",
      spent_minor: 0,
    });
    // a recharge of October used 990 of the 1000 cents; one of September does not count
    await runGrantCredit(control.core, {
      organizationId: org,
      key: "recharge:pi_oct",
      kind: "onetime",
      amountMicros: credits(1000),
      paidMinor: 990,
      now: NOW,
    });
    await runGrantCredit(control.core, {
      organizationId: org,
      key: "recharge:pi_sep",
      kind: "onetime",
      amountMicros: credits(1000),
      paidMinor: 5000,
      now: "2026-09-15T00:00:00.000Z",
    });
    await runChargeOrg(control.core, {
      organizationId: org,
      key: "spend:more",
      amountMicros: credits(2000),
      now: NOW,
    });
    expect(await store.stripeBilling.readRecharge(scope(org))).toMatchObject({
      status: "on",
      spent_minor: 990,
    });
    expect(await store.stripeBilling.claimRecharge(scope(org))).toMatchObject({
      create: false,
      remainingMinor: 10,
      policy: { status: "monthly_limit" },
    });
    expect(await store.stripeBilling.readRecharge(scope(org))).toMatchObject({
      status: "monthly_limit",
    });
    // the next month it is on again
    expect(
      await store.stripeBilling.readRecharge(scope(org, "2026-11-02T00:00:00.000Z")),
    ).toMatchObject({ status: "on", spent_minor: 0 });
    expect(await accountOf(control.core, org)).toMatchObject({
      onetime_micros: expect.any(Number),
    });
  });
});

describe("the status of the policy", () => {
  it("follows what Stripe says about the invoice, and only for a policy that is on", async () => {
    const org = await armed();
    const move = (kind: string, extra: Record<string, unknown> = {}) =>
      store.stripeBilling.transitionRechargePolicy({ ...scope(org), kind, ...extra });
    await move("tax_required");
    expect(await status(org)).toBe("tax_required");
    await move("on");
    expect(await status(org)).toBe("on");
    await move("payment_required");
    expect(await status(org)).toBe("payment_required");
    // a tax issue does not hide a payment that is due, and Stripe's word undoes only its own states
    await move("tax_required");
    expect(await status(org)).toBe("payment_required");
    await move("on");
    expect(await status(org)).toBe("on");
    await move("on");
    // a revision pins the change to the setting that was looked at
    await move("reconciliation", { revision: 9 });
    expect(await status(org)).toBe("on");
    await move("reconciliation", { revision: 1 });
    expect(await status(org)).toBe("needs_reconciliation");
    await move("on");
    expect(await status(org)).toBe("needs_reconciliation");
    // a monthly limit starts the month it is set in, and replaces a tax wait but not a payment that is due
    await control.core
      .prepare("UPDATE stripe_recharge_policies SET status = 'on' WHERE organization_id = ?")
      .bind(org)
      .run();
    await move("tax_required");
    await move("monthly_limit");
    expect(await status(org)).toBe("monthly_limit");
    expect(
      await first(
        control.core,
        "SELECT updated_at FROM stripe_recharge_policies WHERE organization_id = ?",
        org,
      ),
    ).toEqual({ updated_at: "2026-10-30T10:00:00.000000Z" });
    await move("payment_required");
    await move("monthly_limit");
    expect(await status(org)).toBe("payment_required");
    // nothing changes for a policy that is off
    const off = await paid();
    await store.stripeBilling.configureRecharge(configure(off, { enabled: false, consent: null }));
    await store.stripeBilling.transitionRechargePolicy({ ...scope(off), kind: "payment_required" });
    expect(await status(off)).toBe("off");
    await expect(
      store.stripeBilling.transitionRechargePolicy({ ...scope(off), kind: "void" }),
    ).rejects.toThrow("billing_request_invalid");
  });
});

describe("the organizations a tick looks at", () => {
  it("are those with a card to save, an invoice to settle or credit running low, least recently looked at first", async () => {
    const account = "acct_candidates";
    const list = async (now: string, accountId = account) =>
      (await store.stripeBilling.listRechargeCandidates({ accountId, mode: "test", now })).map(
        (row: { organization_id: string }) => row.organization_id,
      );
    const low = await armed(50, account);
    const rich = await armed(500, account);
    const unpaid = await armed(50, account);
    await control.core
      .prepare(
        "UPDATE credit_account SET paid_until = NULL, paid_source = NULL WHERE organization_id = ?",
      )
      .bind(unpaid)
      .run();
    const waiting = await paid();
    await store.stripeBilling.configureRecharge(configure(waiting, {}, account));
    expect((await list(NOW)).sort()).toEqual([low, waiting].sort());
    // looking at one takes it off the list for the lease, and it comes back after it
    await store.stripeBilling.claimRecharge(scope(low, NOW, account));
    expect(await list(NOW)).toEqual([waiting]);
    expect((await list(LATER)).sort()).toEqual([low, waiting].sort());
    expect(await list(NOW, "acct_elsewhere")).toEqual([]);
    expect([rich, unpaid]).not.toContain(low);
    // the oldest look comes first
    await store.stripeBilling.claimRecharge(scope(waiting, "2026-10-30T10:00:30.000Z", account));
    expect(await list("2026-10-30T10:05:00.000Z")).toEqual([low, waiting]);
  });
});
