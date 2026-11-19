import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { D1Database } from "../../src/d1-types.js";
import { migrationFiles, shardBinding, type TestControl } from "../support/control-d1.js";
import { seedProject, ulidOf, type SeededProject } from "../support/platform-fixtures.js";
import { splitStatements } from "../support/sql.js";
import { all } from "./support.js";

// The migration reads the wall clock of the database, so every date below is relative to the real now.
const base = Date.now();
const day = 86_400_000;
const ms = (days: number) => new Date(base + days * day).toISOString();
const micro = (days: number) => ms(days).replace("Z", "000Z");
const MONTH = new Date(base).toISOString().slice(0, 7);
const MONTH_START = `${MONTH}-01T00:00:00.000000Z`;
const LAST_MONTH = new Date(Date.parse(`${MONTH}-01T00:00:00.000Z`) - day)
  .toISOString()
  .replace("Z", "000Z");
const EPOCH = "1970-01-01T00:00:00.000000Z";
const FOREVER = "9999-12-31T23:59:59.999999Z";

let miniflare: Miniflare;
let db: D1Database;
let n = 0;
const lotId = () => ulidOf("lot", (n += 1));

async function applyMigrations(select: (name: string) => boolean) {
  for (const file of migrationFiles("core").filter(({ name }) => select(name))) {
    await db.batch(splitStatements(file.sql).map((statement) => db.prepare(statement)));
  }
}

const lot = (
  organizationId: string,
  kind: string,
  amount: number,
  options: {
    expires?: string | null;
    topup?: boolean;
    held?: number;
    spent?: number;
    reference?: string;
  } = {},
) => {
  const grantId = lotId();
  return {
    grantId,
    statement: db
      .prepare(
        "INSERT INTO credit_lots(organization_id, grant_id, kind, source_reference, amount_micros, granted_at, expires_at, is_topup, held_micros, spent_micros) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
      )
      .bind(
        organizationId,
        grantId,
        kind,
        options.reference ?? `${kind}/${grantId}`,
        amount,
        micro(-30),
        options.expires ?? null,
        options.topup === true ? 1 : 0,
        options.held ?? 0,
        options.spent ?? 0,
      ),
  };
};

const paidPeriod = (
  organizationId: string,
  grantId: string,
  periodEndDays: number,
  suffix: string,
) =>
  db
    .prepare(
      "INSERT INTO credit_paid_periods(organization_id, grant_id, account_id, mode, subscription_id, invoice_id, period_start, period_end, paid_at, confirmed_at, credited_micros) VALUES (?1, ?2, 'acct_seed01', 'live', ?3, ?4, ?5, ?6, NULL, ?5, 1000000000)",
    )
    .bind(
      organizationId,
      grantId,
      `sub_${suffix}`,
      `in_${suffix}`,
      micro(periodEndDays - 30),
      micro(periodEndDays),
    );

const paidAccess = (
  organizationId: string,
  enabled: number,
  source: string,
  paidUntil: string | null,
) =>
  db
    .prepare(
      "INSERT INTO credit_paid_access(organization_id, enabled, source, reason, updated_at, paid_until, revision) VALUES (?1, ?2, ?3, 'seed', ?4, ?5, 1)",
    )
    .bind(organizationId, enabled, source, micro(-5), paidUntil);

const hold = (p: SeededProject, id: number, eventTime: string, charge: number, refunded: number) =>
  db
    .prepare(
      `INSERT INTO credit_holds(organization_id, hold_id, project_id, environment_id, billing_epoch_id, kind, source_reference, amount_micros, state,
         created_at, resolved_at, charge_micros, funded_micros, refunded_micros, restored_micros, rate_card_id, meter, unit, quantity, event_time)
       VALUES (?1, ?2, ?3, NULL, ?4, 'build', ?2, ?5, 'settled', ?6, ?6, ?5, ?5, ?7, ?7, 'seed-v1', 'build.minutes', 'minute', 1, ?8)`,
    )
    .bind(
      p.organizationId,
      ulidOf("hold", id),
      p.projectId,
      p.billingEpochId,
      charge,
      micro(-1),
      refunded,
      eventTime,
    );

const budget = (p: SeededProject, amount: number | null, mode: string) =>
  db
    .prepare(
      "INSERT INTO project_credit_budgets(organization_id, project_id, amount_micros, mode, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(p.organizationId, p.projectId, amount, mode, micro(-1));

const control = (): TestControl => ({
  core: db,
  bindings: { CONTROL_CORE: db },
  directory: db,
  shards: { [shardBinding(0)]: db, [shardBinding(1)]: db },
  dispose: async () => undefined,
});

interface Seeded {
  readonly a: SeededProject;
  readonly b: SeededProject;
  readonly c: SeededProject;
  readonly d: SeededProject;
  readonly e: SeededProject;
  readonly f: SeededProject;
  readonly h: SeededProject;
}
let seeded: Seeded;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { CONTROL_CORE: "seed" },
  });
  db = (await miniflare.getD1Database("CONTROL_CORE")) as unknown as D1Database;
  await applyMigrations((name) => name < "0600");
  const fixture = control();
  const [a, b, c, d, e, f, h] = [
    await seedProject(fixture),
    await seedProject(fixture),
    await seedProject(fixture),
    await seedProject(fixture),
    await seedProject(fixture),
    await seedProject(fixture),
    await seedProject(fixture),
  ] as [
    SeededProject,
    SeededProject,
    SeededProject,
    SeededProject,
    SeededProject,
    SeededProject,
    SeededProject,
  ];
  seeded = { a, b, c, d, e, f, h };

  // A: a Free month in use, an expired one, a top-up with a refund, a bonus, a top-up that expired under the old rule
  const freeA = lot(a.organizationId, "free_monthly", 200_000_000, {
    expires: micro(10),
    spent: 80_000_000,
  });
  const topupA = lot(a.organizationId, "stripe_topup", 500_000_000, {
    topup: true,
    held: 50_000_000,
    spent: 100_000_000,
  });
  const expiredTopup = lot(a.organizationId, "stripe_topup", 77_000_000, { topup: true });
  // B: a Paid month, 400 credits used
  const paidB = lot(b.organizationId, "paid_monthly", 1_000_000_000, {
    expires: micro(10),
    spent: 400_000_000,
  });
  // C: a Paid month fully used, the subscription ended earlier than the 14 days of grace
  const paidC = lot(c.organizationId, "paid_monthly", 1_000_000_000, {
    expires: micro(10),
    spent: 1_000_000_000,
  });
  // D: a Free month fully used and exhausted two days ago
  const freeD = lot(d.organizationId, "free_monthly", 200_000_000, {
    expires: micro(10),
    spent: 200_000_000,
  });
  // H: Stripe coverage that the operator access outlasts
  const paidH = lot(h.organizationId, "paid_monthly", 1_000_000_000, { expires: micro(10) });
  await db.batch([
    ...[freeA, topupA, expiredTopup, paidB, paidC, freeD, paidH].map((entry) => entry.statement),
    lot(a.organizationId, "free_monthly", 200_000_000, { expires: micro(-10), spent: 200_000_000 })
      .statement,
    lot(a.organizationId, "signup_bonus", 100_000_000).statement,
    db
      .prepare(
        "INSERT INTO credit_lot_adjustments(organization_id, adjustment_id, grant_id, source_kind, source_reference, amount_micros, occurred_at) VALUES (?1, ?2, ?3, 'refund', 'seed', 100000000, ?4)",
      )
      .bind(a.organizationId, ulidOf("adjustment", 1), topupA.grantId, micro(-1)),
    db
      .prepare(
        "INSERT INTO credit_lot_expirations(organization_id, grant_id, expires_at, recorded_at) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(a.organizationId, expiredTopup.grantId, micro(-20), micro(-19)),
    paidPeriod(b.organizationId, paidB.grantId, 10, "b"),
    paidPeriod(c.organizationId, paidC.grantId, 10, "c"),
    paidPeriod(h.organizationId, paidH.grantId, 10, "h"),
    db
      .prepare(
        "INSERT INTO credit_subscription_ends(organization_id, account_id, mode, subscription_id, ended_at, observed_at) VALUES (?1, 'acct_seed01', 'live', 'sub_c', ?2, ?3)",
      )
      .bind(c.organizationId, micro(12), micro(-1)),
    paidAccess(e.organizationId, 0, "manual", micro(100)),
    paidAccess(f.organizationId, 1, "granted", null),
    paidAccess(h.organizationId, 1, "manual", micro(100)),
    db
      .prepare("INSERT INTO credit_grace_periods(organization_id, exhausted_at) VALUES (?1, ?2)")
      .bind(d.organizationId, micro(-2)),
    db
      .prepare("INSERT INTO credit_grace_periods(organization_id, exhausted_at) VALUES (?1, ?2)")
      .bind(a.organizationId, micro(-2)),
    db
      .prepare(
        "INSERT INTO organization_credit_warnings(notice_id, organization_id, exhausted_at, owner_id, state, attempts, provider_message_id, created_at, updated_at) VALUES (?1, ?2, ?3, 'user_owner', 'accepted', 1, 'msg_seed', ?3, ?3)",
      )
      .bind(ulidOf("notice", 1), d.organizationId, micro(-2)),
    budget(a, 50_000_000, "stop"),
    budget(b, null, "continue"),
    budget(c, 10_000_000, "continue"),
    hold(a, 1, MONTH_START, 30_000_000, 5_000_000),
    hold(a, 2, LAST_MONTH, 99_000_000, 0),
  ]);
  await applyMigrations((name) => name === "0600_credit_simple.sql");
}, 120_000);
afterAll(async () => miniflare.dispose());

interface Account {
  organization_id: string;
  monthly_micros: number;
  monthly_ends_at: string;
  onetime_micros: number;
  reserved_micros: number;
  overrun_micros: number;
  exhausted_at: string | null;
  paid_until: string | null;
  paid_source: string | null;
  updated_at: string;
  warned_for_exhausted_at: string | null;
  warning_next_attempt_at: string | null;
}

const accounts = async () =>
  new Map(
    (await all<Account>(db, "SELECT * FROM credit_account")).map((row) => [
      row.organization_id,
      row,
    ]),
  );

describe("migration 0600 seeds the simple credit account from the old ledger", () => {
  it("creates one account per organization and none with reserved or overrun credit", async () => {
    const rows = await accounts();
    expect(rows.size).toBe(7);
    expect(
      (
        await all<{ organization_id: string }>(db, "SELECT organization_id FROM organizations")
      ).every((row) => rows.has(row.organization_id)),
    ).toBe(true);
    for (const row of rows.values()) {
      expect(row.reserved_micros).toBe(0);
      expect(row.overrun_micros).toBe(0);
      expect(row.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u);
    }
  });

  it("takes the valid monthly lots as the month and the other valid lots as one-time credit", async () => {
    const rows = await accounts();
    // 200 - 80 monthly until the lot expires; 500 - 50 held - 100 spent - 100 refunded + 100 bonus; the expired
    // month and the top-up that expired before are left out; the grace of a positive balance does not carry over
    expect(rows.get(seeded.a.organizationId)).toMatchObject({
      monthly_micros: 120_000_000,
      monthly_ends_at: micro(10),
      onetime_micros: 350_000_000,
      exhausted_at: null,
      paid_until: null,
      paid_source: null,
    });
    // an organization without lots starts lapsed, so its first write renews the Free allowance
    expect(rows.get(seeded.e.organizationId)).toMatchObject({
      monthly_micros: 0,
      monthly_ends_at: EPOCH,
      onetime_micros: 0,
      exhausted_at: null,
      paid_until: null,
      paid_source: null,
    });
  });

  it("keeps the exhaustion only while nothing is left", async () => {
    expect((await accounts()).get(seeded.d.organizationId)).toMatchObject({
      monthly_micros: 0,
      monthly_ends_at: micro(10),
      onetime_micros: 0,
      exhausted_at: micro(-2),
    });
    // a month used up without a recorded grace has none to keep
    expect((await accounts()).get(seeded.c.organizationId)).toMatchObject({
      monthly_micros: 0,
      exhausted_at: null,
    });
  });

  it("does not warn again for an exhaustion whose warning email was already sent", async () => {
    const rows = await accounts();
    expect(rows.get(seeded.d.organizationId)).toMatchObject({
      exhausted_at: micro(-2),
      warned_for_exhausted_at: micro(-2),
      warning_next_attempt_at: null,
    });
    for (const [organizationId, row] of rows)
      if (organizationId !== seeded.d.organizationId)
        expect(row).toMatchObject({ warned_for_exhausted_at: null, warning_next_attempt_at: null });
  });

  it("derives Paid from the Stripe coverage and the operator access in force", async () => {
    const rows = await accounts();
    expect(rows.get(seeded.b.organizationId)).toMatchObject({
      monthly_micros: 600_000_000,
      monthly_ends_at: micro(10),
      paid_until: micro(24),
      paid_source: "stripe",
    });
    // the subscription ended before the 14 days of renewal grace
    expect(rows.get(seeded.c.organizationId)).toMatchObject({
      paid_until: micro(12),
      paid_source: "stripe",
    });
    // an access without an end never ends; a disabled one counts for nothing
    expect(rows.get(seeded.f.organizationId)).toMatchObject({
      paid_until: FOREVER,
      paid_source: "granted",
    });
    expect(rows.get(seeded.e.organizationId)?.paid_until).toBeNull();
    // the later of Stripe and the operator wins
    expect(rows.get(seeded.h.organizationId)).toMatchObject({
      paid_until: micro(100),
      paid_source: "manual",
    });
  });

  it("moves the project budgets with the month's use net of refunds", async () => {
    const rows = await all<{
      project_id: string;
      organization_id: string;
      period: string;
      used_micros: number;
      budget_micros: number | null;
      budget_mode: string | null;
    }>(db, "SELECT * FROM project_credit ORDER BY project_id");
    const expected = [
      { project: seeded.a, used: 25_000_000, budget: 50_000_000, mode: "stop" },
      { project: seeded.b, used: 0, budget: null, mode: "continue" },
      { project: seeded.c, used: 0, budget: 10_000_000, mode: "continue" },
    ]
      .map((entry) => ({
        project_id: entry.project.projectId,
        organization_id: entry.project.organizationId,
        period: MONTH,
        used_micros: entry.used,
        budget_micros: entry.budget,
        budget_mode: entry.mode,
      }))
      .sort((x, y) => (x.project_id < y.project_id ? -1 : 1));
    expect(rows).toEqual(expected);
  });

  it("creates the remaining tables empty and the log index", async () => {
    for (const table of ["credit_reservation", "credit_grant", "usage_cursor", "credit_log"]) {
      expect(await all(db, `SELECT 1 FROM ${table}`)).toEqual([]);
    }
    expect(
      (
        await all<{ name: string }>(
          db,
          "SELECT name FROM sqlite_master WHERE name = 'credit_log_at'",
        )
      ).length,
    ).toBe(1);
  });
});
