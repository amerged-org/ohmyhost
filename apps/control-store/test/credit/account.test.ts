import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CREDIT_GRACE_MS,
  FREE_MONTHLY_MICROS,
  PAID_MONTHLY_MICROS,
  accountView,
  chargeOrg,
  ensureAccount,
  monthPeriod,
  nextMonthStart,
  readAccount,
  renewIfDue,
  runChargeOrg,
  runGrantCredit,
  runRefundOrg,
  runReleaseReservation,
  runReserve,
  runReverseGrant,
  runSettleReservation,
  setPaid,
} from "../../src/catalog/credit/index.js";
import { classifyFailure } from "../../src/guards.js";
import { ulidOf } from "../support/platform-fixtures.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { OCT, accountOf, all, credits, first, logOf, newOrganization } from "./support.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

const charge = (organizationId: string, key: string, amount: number, now = OCT, extra = {}) =>
  runChargeOrg(control.core, {
    organizationId,
    key,
    amountMicros: credits(amount),
    now,
    ...extra,
  });

describe("charging usage", () => {
  it("spends monthly, then one-time, then overrun; exhausted_at is set once and a grant ends it", async () => {
    const org = (await newOrganization(control)).organizationId;
    // the first write renews the Free allowance of October: 200 credits until the month turns
    expect((await charge(org, "u1", 150)).balanceMicros).toBe(credits(50));
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(50),
      monthly_ends_at: "2026-11-01T00:00:00.000000Z",
      onetime_micros: 0,
      overrun_micros: 0,
      exhausted_at: null,
    });
    await runGrantCredit(control.core, {
      organizationId: org,
      key: "topup:a",
      kind: "onetime",
      amountMicros: credits(100),
      now: OCT,
    });
    // 50 monthly + 70 one-time
    await charge(org, "u2", 120, "2026-10-30T10:01:00.000Z");
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: 0,
      onetime_micros: credits(30),
      overrun_micros: 0,
      exhausted_at: null,
    });
    // 30 one-time, 20 overrun: the exhaustion starts at this write
    await charge(org, "u3", 50, "2026-10-30T10:02:00.000Z");
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: 0,
      onetime_micros: 0,
      overrun_micros: credits(20),
      exhausted_at: "2026-10-30T10:02:00.000000Z",
    });
    // more use is absorbed and the exhaustion keeps its first instant
    const exhausted = await charge(org, "u4", 5, "2026-10-30T10:03:00.000Z");
    expect(exhausted.balanceMicros).toBe(0);
    expect(await accountOf(control.core, org)).toMatchObject({
      overrun_micros: credits(25),
      exhausted_at: "2026-10-30T10:02:00.000000Z",
    });
    await runGrantCredit(control.core, {
      organizationId: org,
      key: "topup:b",
      kind: "onetime",
      amountMicros: credits(10),
      now: "2026-10-30T10:04:00.000Z",
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      onetime_micros: credits(10),
      overrun_micros: credits(25),
      exhausted_at: null,
    });
    expect(
      (await logOf(control.core, org)).map((row) => [
        row.kind,
        row.delta_micros,
        row.balance_micros,
      ]),
    ).toEqual([
      ["renew", credits(200), credits(200)],
      ["usage", -credits(150), credits(50)],
      ["grant", credits(100), credits(150)],
      ["usage", -credits(120), credits(30)],
      ["usage", -credits(50), 0],
      ["usage", -credits(5), 0],
      ["grant", credits(10), credits(10)],
    ]);
  });

  it("counts the charge against its projects and restarts the count in a new UTC month", async () => {
    const p = await newOrganization(control);
    const other = ulidOf("other-project", 1);
    const usage = (
      key: string,
      now: string,
      projects: { projectId: string; amountMicros: number }[],
    ) =>
      runChargeOrg(control.core, {
        organizationId: p.organizationId,
        key,
        amountMicros: projects.reduce((sum, project) => sum + project.amountMicros, 0),
        now,
        projects,
      });
    await usage("m1", OCT, [
      { projectId: p.projectId, amountMicros: credits(10) },
      { projectId: other, amountMicros: credits(5) },
      { projectId: ulidOf("free-project", 1), amountMicros: 0 },
    ]);
    await usage("m2", "2026-10-30T11:00:00.000Z", [
      { projectId: p.projectId, amountMicros: credits(2) },
    ]);
    const used = () =>
      all<{ project_id: string; period: string; used_micros: number }>(
        control.core,
        "SELECT project_id, period, used_micros FROM project_credit WHERE organization_id = ? ORDER BY project_id",
        p.organizationId,
      );
    expect(await used()).toEqual(
      [
        { project_id: p.projectId, period: "2026-10", used_micros: credits(12) },
        { project_id: other, period: "2026-10", used_micros: credits(5) },
      ].sort((a, b) => (a.project_id < b.project_id ? -1 : 1)),
    );
    // a later month starts the count again, a late posting for an older month does not touch it
    await usage("m3", "2026-11-02T00:00:00.000Z", [
      { projectId: p.projectId, amountMicros: credits(1) },
    ]);
    await runChargeOrg(control.core, {
      organizationId: p.organizationId,
      key: "m4",
      amountMicros: credits(40),
      now: "2026-11-02T00:01:00.000Z",
      at: "2026-10-31T23:00:00.000Z",
      projects: [{ projectId: p.projectId, amountMicros: credits(40) }],
    });
    expect((await used()).find((row) => row.project_id === p.projectId)).toEqual({
      project_id: p.projectId,
      period: "2026-11",
      used_micros: credits(1),
    });
    // the late row is filed under its event time
    expect((await logOf(control.core, p.organizationId)).find((row) => row.key === "m4")?.at).toBe(
      "2026-10-31T23:00:00.000000Z",
    );
  });

  it("aborts the whole batch for a key that was posted before and changes nothing", async () => {
    const org = (await newOrganization(control)).organizationId;
    await charge(org, "dup", 50);
    const before = await accountOf(control.core, org);
    const logged = (await logOf(control.core, org)).length;
    // a month later the same key would renew and charge: the duplicate must roll all of it back
    const later = "2026-11-02T00:00:00.000Z";
    const plan = chargeOrg(control.core, {
      organizationId: org,
      key: "dup",
      amountMicros: credits(50),
      now: later,
    });
    const failure = await control.core.batch(plan.statements).catch((error: unknown) => error);
    expect(classifyFailure(failure)).toEqual({
      kind: "unique",
      table: "credit_log",
      columns: ["credit_log.key"],
    });
    expect(await accountOf(control.core, org)).toEqual(before);
    expect(await logOf(control.core, org)).toHaveLength(logged);
    const replay = await charge(org, "dup", 50, later);
    expect(replay).toMatchObject({ posted: false, balanceMicros: FREE_MONTHLY_MICROS });
    expect(await accountOf(control.core, org)).toEqual(before);
  });

  it("sums 50 parallel charges exactly and never lets the balance go negative", async () => {
    const p = await newOrganization(control);
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        charge(p.organizationId, `parallel:${index}`, 5, OCT, {
          projects: [{ projectId: p.projectId, amountMicros: credits(5) }],
        }),
      ),
    );
    expect(await accountOf(control.core, p.organizationId)).toMatchObject({
      monthly_micros: 0,
      onetime_micros: 0,
      overrun_micros: credits(50),
    });
    const log = await logOf(control.core, p.organizationId);
    expect(log.filter((row) => row.kind === "usage")).toHaveLength(50);
    expect(log.reduce((sum, row) => sum + row.delta_micros, 0)).toBe(-credits(50));
    expect(Math.min(...log.map((row) => row.balance_micros))).toBe(0);
    expect(log.filter((row) => row.kind === "renew")).toHaveLength(1);
    expect(
      (
        await first<{ used_micros: number }>(
          control.core,
          "SELECT used_micros FROM project_credit WHERE project_id = ?",
          p.projectId,
        )
      ).used_micros,
    ).toBe(credits(250));
  });

  it("charges nothing for an organization that does not exist and refuses bad amounts", async () => {
    const ghost = ulidOf("ghost", 1);
    expect(await charge(ghost, "ghost", 10)).toEqual({
      posted: false,
      balanceMicros: 0,
      account: null,
    });
    expect(
      await all(control.core, "SELECT 1 FROM credit_account WHERE organization_id = ?", ghost),
    ).toEqual([]);
    expect(await all(control.core, "SELECT 1 FROM credit_log WHERE key = 'ghost'")).toEqual([]);
    for (const amountMicros of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
      expect(() =>
        chargeOrg(control.core, { organizationId: ghost, key: "bad", amountMicros, now: OCT }),
      ).toThrow(RangeError);
    }
  });

  it("refunds first against what the platform absorbed, then as one-time credit", async () => {
    const p = await newOrganization(control);
    const org = p.organizationId;
    const project = [{ projectId: p.projectId, amountMicros: credits(230) }];
    await charge(org, "r-use", 230, OCT, { projects: project });
    expect(await accountOf(control.core, org)).toMatchObject({
      overrun_micros: credits(30),
      exhausted_at: "2026-10-30T10:00:00.000000Z",
    });
    const refund = (key: string, amount: number, projectId?: string) =>
      runRefundOrg(control.core, {
        organizationId: org,
        key,
        amountMicros: credits(amount),
        now: "2026-10-30T11:00:00.000Z",
        ...(projectId === undefined ? {} : { projectId }),
      });
    expect(await refund("mailrefund:1", 20)).toMatchObject({ posted: true, balanceMicros: 0 });
    expect(await accountOf(control.core, org)).toMatchObject({
      overrun_micros: credits(10),
      onetime_micros: 0,
      exhausted_at: "2026-10-30T10:00:00.000000Z",
    });
    const second = await refund("mailrefund:2", 25, p.projectId);
    expect(second).toMatchObject({ posted: true, balanceMicros: credits(15) });
    expect(await accountOf(control.core, org)).toMatchObject({
      overrun_micros: 0,
      onetime_micros: credits(15),
      exhausted_at: null,
    });
    expect(
      (
        await first<{ used_micros: number }>(
          control.core,
          "SELECT used_micros FROM project_credit WHERE project_id = ?",
          p.projectId,
        )
      ).used_micros,
    ).toBe(credits(205));
    // a refund key counts once
    expect(await refund("mailrefund:2", 25, p.projectId)).toMatchObject({
      posted: false,
      balanceMicros: credits(15),
    });
    expect(await accountOf(control.core, org)).toMatchObject({ onetime_micros: credits(15) });
    expect((await logOf(control.core, org)).filter((row) => row.kind === "refund")).toHaveLength(2);
    expect(
      await runRefundOrg(control.core, {
        organizationId: ulidOf("ghost", 2),
        key: "mailrefund:ghost",
        amountMicros: 1,
        now: OCT,
      }),
    ).toMatchObject({ posted: false, account: null });
  });
});

describe("refunding a charge to the bucket it was spent from", () => {
  // A Paid organization with 1000 monthly credits of October and 100 one-time credits; the charge of 1150 spends
  // all of both and 50 of overrun.
  const paidWith100OneTime = async (key: string) => {
    const org = (await newOrganization(control)).organizationId;
    await runSetPaid(org, "2027-01-15T00:00:00.000Z", "granted", OCT);
    await runRenew(org, OCT);
    await runGrantCredit(control.core, {
      organizationId: org,
      key: `topup:${key}`,
      kind: "onetime",
      amountMicros: credits(100),
      now: OCT,
    });
    await charge(org, `mail:${key}`, 1150);
    return org;
  };
  const refund = (organizationId: string, key: string, now: string) =>
    runRefundOrg(control.core, {
      organizationId,
      key: `mailrefund:${key}`,
      amountMicros: credits(1150),
      chargeKey: `mail:${key}`,
      now,
    });

  it("returns monthly, one-time and overrun exactly to their prior values, and the monthly part stays expiring", async () => {
    const org = await paidWith100OneTime("paid");
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: 0,
      onetime_micros: 0,
      overrun_micros: credits(50),
    });
    expect(await refund(org, "paid", "2026-10-30T11:00:00.000Z")).toMatchObject({
      posted: true,
      balanceMicros: credits(1100),
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(1000),
      monthly_ends_at: "2026-11-01T00:00:00.000000Z",
      onetime_micros: credits(100),
      overrun_micros: 0,
      exhausted_at: null,
    });
  });

  it("refunds a charge without a recorded split as one-time credit, as before the split was logged", async () => {
    const org = await paidWith100OneTime("legacy");
    // a charge row written before the split was recorded
    await control.core
      .prepare("UPDATE credit_log SET detail = '{}' WHERE key = 'mail:legacy'")
      .run();
    await refund(org, "legacy", "2026-10-30T11:00:00.000Z");
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: 0,
      onetime_micros: credits(1100),
      overrun_micros: 0,
    });
  });

  it("refunds the monthly part to the current month when the month renewed between charge and refund", async () => {
    const org = (await newOrganization(control)).organizationId;
    await runSetPaid(org, "2027-01-15T00:00:00.000Z", "granted", OCT);
    await runRenew(org, OCT);
    await charge(org, "mail:late", 300);
    // 700 monthly expire with October; the refund then lands in the new month's 1000
    expect(
      await runRefundOrg(control.core, {
        organizationId: org,
        key: "mailrefund:late",
        amountMicros: credits(300),
        chargeKey: "mail:late",
        now: "2026-11-02T00:00:00.000Z",
      }),
    ).toMatchObject({ posted: true });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: credits(1300),
      monthly_ends_at: "2026-12-01T00:00:00.000000Z",
      onetime_micros: 0,
      overrun_micros: 0,
    });
    expect(
      (await logOf(control.core, org))
        .filter((row) => row.kind === "expire")
        .map((row) => row.delta_micros),
    ).toEqual([-credits(700)]);
    // the refunded part expires with the November allowance like any other monthly credit
    await runRenew(org, "2026-12-01T00:00:00.000Z");
    expect(
      (await logOf(control.core, org))
        .filter((row) => row.kind === "expire")
        .map((row) => row.delta_micros),
    ).toEqual([-credits(700), -credits(1300)]);
  });
});

describe("the monthly allowance", () => {
  it("renews Free credit once per UTC month and expires the unspent remainder", async () => {
    const org = (await newOrganization(control)).organizationId;
    const renew = (now: string) => runRenew(org, now);
    expect(await renew(OCT)).toMatchObject({ renewed: true });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: FREE_MONTHLY_MICROS,
      monthly_ends_at: "2026-11-01T00:00:00.000000Z",
    });
    expect(await renew("2026-10-31T23:59:59.000Z")).toMatchObject({ renewed: false });
    await charge(org, "n1", 150);
    expect(await renew("2026-11-01T00:00:00.000Z")).toMatchObject({
      renewed: true,
      account: { monthlyMicros: FREE_MONTHLY_MICROS, monthlyEndsAt: "2026-12-01T00:00:00.000000Z" },
    });
    // the same period renews nothing a second time
    expect(await renew("2026-11-01T00:00:00.000Z")).toMatchObject({ renewed: false });
    expect(await renew("2026-11-20T00:00:00.000Z")).toMatchObject({ renewed: false });
    expect(
      (await logOf(control.core, org)).map((row) => [
        row.kind,
        row.delta_micros,
        row.balance_micros,
      ]),
    ).toEqual([
      ["renew", credits(200), credits(200)],
      ["usage", -credits(150), credits(50)],
      ["expire", -credits(50), 0],
      ["renew", credits(200), credits(200)],
    ]);
    expect((await logOf(control.core, org)).map((row) => row.key)).toEqual([
      "renew:" + org + ":2026-11-01T00:00:00.000000Z",
      "n1",
      "expire:" + org + ":2026-12-01T00:00:00.000000Z",
      "renew:" + org + ":2026-12-01T00:00:00.000000Z",
    ]);
  });

  it("renews a Paid organization with 1000 credits until its coverage or the month ends", async () => {
    const org = (await newOrganization(control)).organizationId;
    await runRenew(org, OCT);
    const paid = await runSetPaid(
      org,
      "2026-12-20T00:00:00.000Z",
      "stripe",
      "2026-11-05T00:00:00.000Z",
    );
    expect(paid).toEqual({ changed: true });
    expect(await runRenew(org, "2026-12-01T00:00:00.000Z")).toMatchObject({
      renewed: true,
      account: {
        monthlyMicros: PAID_MONTHLY_MICROS,
        monthlyEndsAt: "2026-12-20T00:00:00.000000Z",
        paid: true,
      },
    });
    // coverage that reaches beyond the month is cut at the month, and an ended coverage renews the Free allowance
    expect(await runRenew(org, "2026-12-20T00:00:00.000Z")).toMatchObject({
      renewed: true,
      account: {
        monthlyMicros: FREE_MONTHLY_MICROS,
        monthlyEndsAt: "2027-01-01T00:00:00.000000Z",
        paid: false,
      },
    });
    await runSetPaid(org, "2027-03-01T00:00:00.000Z", "granted", "2026-12-21T00:00:00.000Z");
    expect(await runRenew(org, "2027-01-01T00:00:00.000Z")).toMatchObject({
      account: { monthlyMicros: PAID_MONTHLY_MICROS, monthlyEndsAt: "2027-02-01T00:00:00.000000Z" },
    });
  });

  it("ends the exhaustion when the next month renews, even before any write", async () => {
    const org = (await newOrganization(control)).organizationId;
    await charge(org, "x1", 250);
    const stored = await accountOf(control.core, org);
    expect(stored.exhausted_at).toBe("2026-10-30T10:00:00.000000Z");
    const october = await readAccount(control.core, org, "2026-10-31T00:00:00.000Z");
    expect(october).toMatchObject({
      balanceMicros: 0,
      availableMicros: 0,
      exhaustedAt: "2026-10-30T10:00:00.000000Z",
      graceEndsAt: "2026-11-06T10:00:00.000000Z",
      graceLapsed: false,
      renewalPending: false,
    });
    const november = await readAccount(control.core, org, "2026-11-01T00:00:00.000Z");
    expect(november).toMatchObject({
      monthlyMicros: FREE_MONTHLY_MICROS,
      exhaustedAt: null,
      graceLapsed: false,
      renewalPending: true,
    });
    // the view changed nothing; the write that follows does
    expect(await accountOf(control.core, org)).toEqual(stored);
    await runRenew(org, "2026-11-01T00:00:00.000Z");
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: FREE_MONTHLY_MICROS,
      exhausted_at: null,
    });
  });
});

describe("the account view", () => {
  it("reads an organization that was never written as an untouched account", async () => {
    const org = (await newOrganization(control)).organizationId;
    const view = await readAccount(control.core, org, OCT);
    expect(view).toEqual({
      organizationId: org,
      monthlyMicros: FREE_MONTHLY_MICROS,
      monthlyEndsAt: "2026-11-01T00:00:00.000000Z",
      onetimeMicros: 0,
      reservedMicros: 0,
      overrunMicros: 0,
      overrunMonthMicros: 0,
      balanceMicros: FREE_MONTHLY_MICROS,
      availableMicros: FREE_MONTHLY_MICROS,
      exhaustedAt: null,
      graceEndsAt: null,
      graceLapsed: false,
      paid: false,
      paidUntil: null,
      paidSource: null,
      renewalPending: true,
    });
    expect(
      await all(control.core, "SELECT 1 FROM credit_account WHERE organization_id = ?", org),
    ).toEqual([]);
  });

  it("lapses the grace exactly seven days after the exhaustion", () => {
    const stored = {
      monthly_micros: 0,
      monthly_ends_at: "2026-12-01T00:00:00.000000Z",
      onetime_micros: 0,
      reserved_micros: 0,
      overrun_micros: 5,
      exhausted_at: "2026-11-10T08:00:00.000000Z",
      paid_until: null,
      paid_source: null,
    } as const;
    expect(CREDIT_GRACE_MS).toBe(7 * 86_400_000);
    expect(accountView("o", stored, "2026-11-17T07:59:59.999Z")).toMatchObject({
      graceEndsAt: "2026-11-17T08:00:00.000000Z",
      graceLapsed: false,
    });
    expect(accountView("o", stored, "2026-11-17T08:00:00.000Z").graceLapsed).toBe(true);
    // reserved credit is not available even while there is a balance
    expect(
      accountView(
        "o",
        { ...stored, monthly_micros: 10, reserved_micros: 25, exhausted_at: null },
        "2026-11-11T00:00:00.000Z",
      ),
    ).toMatchObject({ balanceMicros: 10, availableMicros: 0 });
    expect(nextMonthStart("2026-12-31T23:59:59.999999Z")).toBe("2027-01-01T00:00:00.000000Z");
    expect(monthPeriod("2026-10-30T10:00:00.000000Z")).toBe("2026-10");
  });

  it("creates an account on first touch and only for an organization that exists", async () => {
    const org = (await newOrganization(control)).organizationId;
    const create = async (organizationId: string) => {
      const plan = ensureAccount(control.core, { organizationId, now: OCT });
      return plan.read(await control.core.batch(plan.statements));
    };
    expect(await create(org)).toEqual({ created: true });
    expect(await create(org)).toEqual({ created: false });
    expect(await accountOf(control.core, org)).toMatchObject({
      monthly_micros: 0,
      monthly_ends_at: "1970-01-01T00:00:00.000000Z",
    });
    expect(await create(ulidOf("ghost", 3))).toEqual({ created: false });
  });
});

describe("paid access", () => {
  it("sets, extends and ends the coverage; an older event cannot shorten it", async () => {
    const org = (await newOrganization(control)).organizationId;
    const at = "2026-10-30T12:00:00.000Z";
    expect(await runSetPaid(org, "2026-11-20T00:00:00.000Z", "stripe", at, true)).toEqual({
      changed: true,
    });
    expect((await readAccount(control.core, org, at)).paid).toBe(true);
    expect(await runSetPaid(org, "2026-11-10T00:00:00.000Z", "stripe", at, true)).toEqual({
      changed: false,
    });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: "2026-11-20T00:00:00.000000Z",
      paid_source: "stripe",
    });
    expect(await runSetPaid(org, "2026-12-20T00:00:00.000Z", "stripe", at, true)).toEqual({
      changed: true,
    });
    // paid only while paid_until lies ahead
    expect((await readAccount(control.core, org, "2026-12-20T00:00:00.000Z")).paid).toBe(false);
    expect(await runSetPaid(org, null, null, at)).toEqual({ changed: true });
    expect(await accountOf(control.core, org)).toMatchObject({
      paid_until: null,
      paid_source: null,
    });
    expect(() =>
      setPaid(control.core, { organizationId: org, paidUntil: null, source: "manual", now: at }),
    ).toThrow(TypeError);
    expect(await runSetPaid(ulidOf("ghost", 4), "2026-12-20T00:00:00.000Z", "manual", at)).toEqual({
      changed: false,
    });
  });
});

describe("failures that are not the module's own", () => {
  it("reach the caller instead of being read as a duplicate or a refusal", async () => {
    const lost = new Error("D1_ERROR: disk I/O error");
    const broken = {
      prepare: (sql: string) => control.core.prepare(sql),
      batch: () => Promise.reject(lost),
    };
    const organizationId = ulidOf("broken", 1);
    const reservationId = ulidOf("broken-reservation", 1);
    const calls = [
      runChargeOrg(broken, { organizationId, key: "k", amountMicros: 1, now: OCT }),
      runRefundOrg(broken, { organizationId, key: "k", amountMicros: 1, now: OCT }),
      runGrantCredit(broken, {
        organizationId,
        key: "topup:k",
        kind: "onetime",
        amountMicros: 1,
        now: OCT,
      }),
      runReverseGrant(broken, { organizationId, grantKey: "topup:k", now: OCT }),
      runReserve(broken, {
        organizationId,
        reservationId,
        projectId: null,
        amountMicros: 1,
        now: OCT,
      }),
      runSettleReservation(broken, { organizationId, reservationId, chargedMicros: 1, now: OCT }),
      runReleaseReservation(broken, { organizationId, reservationId, now: OCT }),
    ];
    for (const call of calls) await expect(call).rejects.toBe(lost);
  });
});

async function runRenew(organizationId: string, now: string) {
  const plan = renewIfDue(control.core, { organizationId, now });
  return plan.read(await control.core.batch(plan.statements));
}

async function runSetPaid(
  organizationId: string,
  paidUntil: string | null,
  source: "stripe" | "granted" | "manual" | null,
  now: string,
  extendOnly = false,
) {
  const plan = setPaid(control.core, { organizationId, paidUntil, source, now, extendOnly });
  return plan.read(await control.core.batch(plan.statements));
}
