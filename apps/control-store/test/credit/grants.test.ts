import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  grantCredit,
  reverseGrant,
  runChargeOrg,
  runGrantCredit,
  runReverseGrant,
} from "../../src/catalog/credit/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { makePaid } from "../support/credit-fixtures.js";
import { ulidOf } from "../support/platform-fixtures.js";
import { OCT, accountOf, all, credits, first, logOf, newOrganization } from "./support.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

const grant = (organizationId: string, key: string, amount: number, extra = {}) =>
  runGrantCredit(control.core, {
    organizationId,
    key,
    kind: "onetime",
    amountMicros: credits(amount),
    now: OCT,
    ...extra,
  });

const charge = (organizationId: string, key: string, amount: number) =>
  runChargeOrg(control.core, { organizationId, key, amountMicros: credits(amount), now: OCT });

const reverse = (organizationId: string, grantKey: string, refundedMinor?: number) =>
  runReverseGrant(control.core, {
    organizationId,
    grantKey,
    now: "2026-10-30T11:00:00.000Z",
    ...(refundedMinor === undefined ? {} : { refundedMinor }),
  });

describe("granting credit", () => {
  it("grants one-time credit once per key", async () => {
    const org = (await newOrganization(control)).organizationId;
    const granted = await grant(org, "topup:pi_1", 100, {
      paidMinor: 1000,
      detail: { source: "stripe" },
    });
    // the Free allowance of the month arrives with the first write
    expect(granted).toMatchObject({ granted: true, balanceMicros: credits(300) });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(200),
      onetime_micros: credits(100),
    });
    // the same key with any amount grants nothing and changes nothing
    const again = await grant(org, "topup:pi_1", 999);
    expect(again).toMatchObject({ granted: false, balanceMicros: credits(300) });
    expect(await accountOf(control.core, org)).toMatchObject({ onetime_micros: credits(100) });
    expect(
      await all(
        control.core,
        "SELECT organization_id, amount_micros, paid_minor, reversed_micros, granted_at FROM credit_grant WHERE key = 'topup:pi_1'",
      ),
    ).toEqual([
      {
        organization_id: org,
        amount_micros: credits(100),
        paid_minor: 1000,
        reversed_micros: 0,
        granted_at: "2026-10-30T10:00:00.000000Z",
      },
    ]);
    const log = (await logOf(control.core, org)).filter((row) => row.kind === "grant");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      key: "grant:topup:pi_1",
      delta_micros: credits(100),
      balance_micros: credits(300),
    });
    expect(JSON.parse(log[0]?.detail ?? "")).toEqual({
      source: "stripe",
      grantKey: "topup:pi_1",
      kind: "topup",
      bucket: "onetime",
    });
    expect(await grant(ulidOf("ghost", 20), "topup:ghost", 5)).toMatchObject({
      granted: false,
      account: null,
    });
    expect(await all(control.core, "SELECT 1 FROM credit_grant WHERE key = 'topup:ghost'")).toEqual(
      [],
    );
  });

  it("sets the monthly allowance of a paid invoice, unless it covers an older period", async () => {
    const org = (await newOrganization(control)).organizationId;
    await charge(org, "g-use", 250);
    expect((await accountOf(control.core, org)).exhausted_at).not.toBeNull();
    const invoice = (key: string, endsAt: string) =>
      grant(org, key, 1000, {
        kind: "monthly",
        monthlyEndsAt: endsAt,
        periodStart: "2026-10-01T00:00:00.000Z",
        paidMinor: 5000,
      });
    expect(await invoice("invoice:in_1", "2026-11-15T00:00:00.000Z")).toMatchObject({
      granted: true,
      balanceMicros: credits(1000),
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(1000),
      monthly_ends_at: "2026-11-15T00:00:00.000000Z",
      overrun_micros: credits(50),
      exhausted_at: null,
    });
    await charge(org, "g-use-2", 100);
    // an invoice of an older period is recorded but leaves the current allowance alone
    expect(await invoice("invoice:in_0", "2026-10-31T00:00:00.000Z")).toMatchObject({
      granted: true,
      balanceMicros: credits(900),
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(900),
      monthly_ends_at: "2026-11-15T00:00:00.000000Z",
    });
    expect(await invoice("invoice:in_0", "2026-10-31T00:00:00.000Z")).toMatchObject({
      granted: false,
    });
    const log = await logOf(control.core, org);
    expect(log.filter((row) => row.kind === "grant").map((row) => row.key)).toEqual([
      "grant:invoice:in_1",
      "grant:invoice:in_0",
    ]);
  });

  it("nets the Paid renewal that bridged to an invoice of its period, so one period never gives two allowances", async () => {
    const org = (await newOrganization(control)).organizationId;
    // invoice A covers 15 Oct to 15 Nov; its coverage runs fourteen days past the period
    await runGrantCredit(control.core, {
      organizationId: org,
      key: "invoice:in_a",
      kind: "monthly",
      amountMicros: credits(1000),
      monthlyEndsAt: "2026-11-15T00:00:00.000Z",
      periodStart: "2026-10-15T00:00:00.000Z",
      now: "2026-10-15T00:00:00.000Z",
      paidMinor: 5000,
    });
    await makePaid(
      control.core,
      org,
      "2026-11-29T00:00:00.000Z",
      "2026-10-15T00:00:00.000Z",
      "manual",
    );
    // the lapsed month renews as Paid on 16 Nov and 900 credits are spent of it
    await runChargeOrg(control.core, {
      organizationId: org,
      key: "g-bridge",
      amountMicros: credits(900),
      now: "2026-11-16T00:00:00.000Z",
    });
    expect(await accountOf(control.core, org)).toMatchObject({ monthly_micros: credits(100) });
    // invoice B covers 15 Nov to 15 Dec: its allowance is the period's, less what was spent of the renewal
    await runGrantCredit(control.core, {
      organizationId: org,
      key: "invoice:in_b",
      kind: "monthly",
      amountMicros: credits(1000),
      monthlyEndsAt: "2026-12-15T00:00:00.000Z",
      periodStart: "2026-11-15T00:00:00.000Z",
      now: "2026-11-16T01:00:00.000Z",
      paidMinor: 5000,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(100),
      monthly_ends_at: "2026-12-15T00:00:00.000000Z",
    });
  });

  it("replaces a bridged allowance in full with an invoice whose period began after the Paid renewal", async () => {
    const org = (await newOrganization(control)).organizationId;
    expect(
      await runGrantCredit(control.core, {
        organizationId: org,
        key: "invoice:in_bridge_a",
        kind: "monthly",
        amountMicros: credits(1000),
        monthlyEndsAt: "2026-11-15T00:00:00.000Z",
        periodStart: "2026-10-15T00:00:00.000Z",
        now: "2026-10-15T00:00:00.000Z",
        paidMinor: 5000,
      }),
    ).toMatchObject({ granted: true });
    await makePaid(
      control.core,
      org,
      "2026-11-29T00:00:00.000Z",
      "2026-10-15T00:00:00.000Z",
      "manual",
    );
    await runChargeOrg(control.core, {
      organizationId: org,
      key: "g-bridge-late",
      amountMicros: credits(900),
      now: "2026-11-16T00:00:00.000Z",
    });
    expect(await accountOf(control.core, org)).toMatchObject({ monthly_micros: credits(100) });
    // invoice B covers 20 Nov to 20 Dec: it began after the renewal of 16 Nov, so nothing of that renewal is netted
    expect(
      await runGrantCredit(control.core, {
        organizationId: org,
        key: "invoice:in_bridge_b",
        kind: "monthly",
        amountMicros: credits(1000),
        monthlyEndsAt: "2026-12-20T00:00:00.000Z",
        periodStart: "2026-11-20T00:00:00.000Z",
        now: "2026-11-20T01:00:00.000Z",
        paidMinor: 5000,
      }),
    ).toMatchObject({ granted: true });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(1000),
      monthly_ends_at: "2026-12-20T00:00:00.000000Z",
    });
    expect(
      await first(
        control.core,
        "SELECT paid_renewal_at FROM credit_account WHERE organization_id = ?",
        org,
      ),
    ).toEqual({ paid_renewal_at: null });
  });

  it("does not net a Free renewal against the paid invoice of its period, since Free credit ends with the Paid period", async () => {
    const org = (await newOrganization(control)).organizationId;
    // the Free month renews on 1 Nov without any Paid renewal, and 150 of its 200 credits are spent
    await runChargeOrg(control.core, {
      organizationId: org,
      key: "g-free-spend",
      amountMicros: credits(150),
      now: "2026-11-02T00:00:00.000Z",
    });
    expect(await accountOf(control.core, org)).toMatchObject({ monthly_micros: credits(50) });
    expect(
      await first(
        control.core,
        "SELECT paid_renewal_at FROM credit_account WHERE organization_id = ?",
        org,
      ),
    ).toEqual({ paid_renewal_at: null });
    // an invoice whose period began before that renewal still gets its full allowance: the Free spend is not netted
    expect(
      await runGrantCredit(control.core, {
        organizationId: org,
        key: "invoice:in_free_c",
        kind: "monthly",
        amountMicros: credits(1000),
        monthlyEndsAt: "2026-12-15T00:00:00.000Z",
        periodStart: "2026-10-15T00:00:00.000Z",
        now: "2026-11-02T01:00:00.000Z",
        paidMinor: 5000,
      }),
    ).toMatchObject({ granted: true });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(1000),
      monthly_ends_at: "2026-12-15T00:00:00.000000Z",
    });
  });

  it("refuses grants that cannot be applied", async () => {
    const org = ulidOf("ghost", 21);
    const base = { organizationId: org, key: "topup:x", kind: "onetime", now: OCT } as const;
    expect(() => grantCredit(control.core, { ...base, amountMicros: 0 })).toThrow(RangeError);
    expect(() => grantCredit(control.core, { ...base, amountMicros: 1, paidMinor: -5 })).toThrow(
      RangeError,
    );
    expect(() => grantCredit(control.core, { ...base, kind: "monthly", amountMicros: 1 })).toThrow(
      TypeError,
    );
  });
});

describe("reversing a grant", () => {
  it("takes a one-time grant back in proportion to the refund, once per refund", async () => {
    const org = (await newOrganization(control)).organizationId;
    await charge(org, "t-use", 200);
    await grant(org, "topup:pi_2", 1000, { paidMinor: 10_000 });
    expect(await reverse(org, "topup:pi_2", 2500)).toMatchObject({
      reversedMicros: credits(250),
      balanceMicros: credits(750),
    });
    // the same cumulative refund again reverses nothing and logs nothing
    expect(await reverse(org, "topup:pi_2", 2500)).toMatchObject({
      reversedMicros: 0,
      balanceMicros: credits(750),
    });
    expect(await reverse(org, "topup:pi_2", 10_000)).toMatchObject({
      reversedMicros: credits(750),
      balanceMicros: 0,
    });
    // a refund beyond the payment cannot take back more than the grant
    expect(await reverse(org, "topup:pi_2", 20_000)).toMatchObject({ reversedMicros: 0 });
    expect(
      (
        await first<{ reversed_micros: number }>(
          control.core,
          "SELECT reversed_micros FROM credit_grant WHERE key = 'topup:pi_2'",
        )
      ).reversed_micros,
    ).toBe(credits(1000));
    const reversals = (await logOf(control.core, org)).filter((row) => row.kind === "reverse");
    expect(reversals.map((row) => [row.key, row.delta_micros, row.balance_micros])).toEqual([
      ["reverse:topup:pi_2:2500", -credits(250), credits(750)],
      ["reverse:topup:pi_2:10000", -credits(750), 0],
    ]);
    expect(JSON.parse(reversals[0]?.detail ?? "")).toEqual({
      grantKey: "topup:pi_2",
      refundedMinor: 2500,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      onetime_micros: 0,
      overrun_micros: 0,
      exhausted_at: "2026-10-30T11:00:00.000000Z",
    });
  });

  it("lets the platform absorb what the customer already spent", async () => {
    const org = (await newOrganization(control)).organizationId;
    await charge(org, "s-use", 200);
    await grant(org, "topup:pi_3", 100, { paidMinor: 1000 });
    await charge(org, "s-use-2", 80);
    expect(await accountOf(control.core, org)).toMatchObject({
      onetime_micros: credits(20),
      overrun_micros: 0,
    });
    // no amount: the whole grant goes, 20 from the balance and 80 to overrun
    expect(await reverse(org, "topup:pi_3")).toMatchObject({
      reversedMicros: credits(100),
      balanceMicros: 0,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      onetime_micros: 0,
      overrun_micros: credits(80),
    });
    expect((await logOf(control.core, org)).at(-1)?.key).toBe("reverse:topup:pi_3:full");
  });

  it("takes an invoice back from the monthly allowance first", async () => {
    const org = (await newOrganization(control)).organizationId;
    await grant(org, "invoice:in_9", 1000, {
      kind: "monthly",
      monthlyEndsAt: "2026-12-01T00:00:00.000Z",
      periodStart: "2026-11-01T00:00:00.000Z",
      paidMinor: 5000,
    });
    await grant(org, "topup:pi_4", 300);
    expect(await reverse(org, "invoice:in_9", 2500)).toMatchObject({
      reversedMicros: credits(500),
      balanceMicros: credits(800),
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(500),
      onetime_micros: credits(300),
    });
    // the rest of the invoice empties the monthly allowance and leaves the one-time credit alone
    expect(await reverse(org, "invoice:in_9", 5000)).toMatchObject({
      reversedMicros: credits(500),
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: 0,
      onetime_micros: credits(300),
    });
    // a grant that nothing was paid for goes whole
    await grant(org, "signup_bonus:user_1", 50);
    expect(await reverse(org, "signup_bonus:user_1", 1)).toMatchObject({
      reversedMicros: credits(50),
    });
  });

  it("knows only the grants of its own organization", async () => {
    const org = (await newOrganization(control)).organizationId;
    const other = (await newOrganization(control)).organizationId;
    await grant(org, "topup:pi_5", 10, { paidMinor: 100 });
    expect(await reverse(other, "topup:pi_5")).toEqual({ reversedMicros: 0, unknownGrant: true });
    expect(await reverse(org, "topup:unknown")).toEqual({ reversedMicros: 0, unknownGrant: true });
    expect(await accountOf(control.core, org)).toMatchObject({ onetime_micros: credits(10) });
    expect(() =>
      reverseGrant(control.core, {
        organizationId: org,
        grantKey: "topup:pi_5",
        refundedMinor: -1,
        now: OCT,
      }),
    ).toThrow(RangeError);
  });
});
