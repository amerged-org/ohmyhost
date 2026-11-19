import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

import type { D1Database } from "../../src/d1-types.js";
import { migrationFiles } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";

const MIGRATION = "0648_paid_coverage_ownership.sql";
let miniflare: Miniflare;
let db: D1Database;
const sql = (statement: string, ...values: unknown[]) => db.prepare(statement).bind(...values);

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { CORE: "paid-coverage-migration" },
  });
  db = (await miniflare.getD1Database("CORE")) as unknown as D1Database;
  // the Core as it was before this migration, with the legacy grants of the lot to backfill
  for (const file of migrationFiles("core").filter(({ name }) => name < MIGRATION))
    await db.batch(splitStatements(file.sql).map((statement) => db.prepare(statement)));
  const at = "2026-10-30T09:00:05.000000Z";
  await db.batch([
    sql(
      "INSERT INTO credit_account(organization_id, monthly_micros, monthly_ends_at, onetime_micros, reserved_micros, overrun_micros, paid_until, paid_source, updated_at) VALUES ('org_a', 0, '2026-11-30T09:00:00.000000Z', 0, 0, 0, '2026-12-14T09:00:00.000000Z', 'stripe', ?1), ('org_b', 0, '2026-11-30T09:00:00.000000Z', 0, 0, 0, '2026-12-14T09:00:00.000000Z', 'granted', ?1)",
      at,
    ),
    sql(
      "INSERT INTO credit_grant(key, organization_id, amount_micros, paid_minor, reversed_micros, granted_at) VALUES ('invoice:in_0', 'org_a', 1000000000, 1100, 0, ?1), ('invoice:in_1', 'org_a', 1000000000, 1100, 0, ?1), ('invoice:in_gone', 'org_a', 1000000000, 1100, 0, ?1), ('topup:pi_1', 'org_a', 1000000000, 1100, 0, ?1)",
      at,
    ),
    sql(
      "INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail) VALUES ('grant:invoice:in_0', ?1, 'org_a', 'grant', 1000000000, 1000000000, '{\"subscriptionId\":\"sub_old\",\"periodEnd\":\"2026-10-30T09:00:00.000Z\"}'), ('grant:invoice:in_1', ?1, 'org_a', 'grant', 1000000000, 1000000000, '{\"subscriptionId\":\"sub_a\",\"periodEnd\":\"2026-11-30T09:00:00.000Z\"}'), ('grant:invoice:in_b', ?1, 'org_b', 'grant', 1000000000, 1000000000, '{\"subscriptionId\":\"sub_b\",\"periodEnd\":\"2026-11-30T09:00:00.000Z\"}')",
      at,
    ),
  ]);
  await db.batch(
    splitStatements(migrationFiles("core").find(({ name }) => name === MIGRATION)?.sql ?? "").map(
      (statement) => db.prepare(statement),
    ),
  );
}, 120_000);
afterAll(async () => miniflare?.dispose());

it("backfills the coverage end of invoice grants and the subscription of a Stripe account from the grant log", async () => {
  const grants = await db
    .prepare("SELECT key, covers_until FROM credit_grant ORDER BY key")
    .all<{ key: string; covers_until: string | null }>();
  expect(grants.results).toEqual([
    { key: "invoice:in_0", covers_until: "2026-11-13T09:00:00.000000Z" },
    { key: "invoice:in_1", covers_until: "2026-12-14T09:00:00.000000Z" },
    // the log has rotated the period of this grant away: an upper bound, 60 days after the grant
    { key: "invoice:in_gone", covers_until: "2026-12-29T09:00:05.000000Z" },
    { key: "topup:pi_1", covers_until: null },
  ]);
  const accounts = await db
    .prepare(
      "SELECT organization_id, paid_subscription_id FROM credit_account ORDER BY organization_id",
    )
    .all<{ organization_id: string; paid_subscription_id: string | null }>();
  // the latest invoice grant names the subscription; a granted account gets none
  expect(accounts.results).toEqual([
    { organization_id: "org_a", paid_subscription_id: "sub_a" },
    { organization_id: "org_b", paid_subscription_id: null },
  ]);
});
