import type { D1Database } from "../../src/d1-types.js";
import type { AccountRow } from "../../src/catalog/credit/index.js";
import type { TestControl } from "../support/control-d1.js";
import { seedProject, type SeededProject } from "../support/platform-fixtures.js";

/** A whole number of credits in micro-credits. */
export const credits = (count: number) => count * 1_000_000;

/** The instant of the first write of most tests: late October, so the month ends in two days. */
export const OCT = "2026-10-30T10:00:00.000Z";
export const MONTH_END = "2026-11-01T00:00:00.000000Z";

export async function all<Row>(db: D1Database, sql: string, ...binds: unknown[]): Promise<Row[]> {
  return (
    await db
      .prepare(sql)
      .bind(...binds)
      .all<Row>()
  ).results;
}

export async function first<Row>(db: D1Database, sql: string, ...binds: unknown[]): Promise<Row> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<Row>();
  if (row === null) throw new Error(`no row: ${sql}`);
  return row;
}

export const accountOf = (db: D1Database, organizationId: string) =>
  first<AccountRow>(
    db,
    "SELECT monthly_micros, monthly_ends_at, onetime_micros, reserved_micros, overrun_micros, exhausted_at, paid_until, paid_source FROM credit_account WHERE organization_id = ?",
    organizationId,
  );

export interface LogRecord {
  readonly seq: number;
  readonly key: string;
  readonly at: string;
  readonly kind: string;
  readonly delta_micros: number;
  readonly balance_micros: number;
  readonly detail: string;
}

export const logOf = (db: D1Database, organizationId: string) =>
  all<LogRecord>(
    db,
    "SELECT seq, key, at, kind, delta_micros, balance_micros, detail FROM credit_log WHERE organization_id = ? ORDER BY seq",
    organizationId,
  );

export const count = async (db: D1Database, table: string): Promise<number> =>
  (await first<{ n: number }>(db, `SELECT count(*) AS n FROM ${table}`)).n;

/** A fresh organization with one active project and its two environments; no credit row exists for it yet. */
export const newOrganization = (control: TestControl): Promise<SeededProject> =>
  seedProject(control);
