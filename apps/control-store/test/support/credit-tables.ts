import type { D1Database } from "../../src/d1-types.js";
import { splitStatements } from "./sql.js";

/**
 * The six tables exactly as the W33 contract states them. Used only while migration 0600 is not part of the checked-in
 * lineage; the test applies the real 0600 as soon as the file exists.
 */
export const W33_CONTRACT_SCHEMA = `
CREATE TABLE credit_account (
  organization_id TEXT PRIMARY KEY,
  monthly_micros  INTEGER NOT NULL DEFAULT 0 CHECK (monthly_micros >= 0),
  monthly_ends_at TEXT    NOT NULL,
  onetime_micros  INTEGER NOT NULL DEFAULT 0 CHECK (onetime_micros >= 0),
  reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  overrun_micros  INTEGER NOT NULL DEFAULT 0,
  exhausted_at    TEXT,
  paid_until      TEXT,
  paid_source     TEXT CHECK (paid_source IN ('stripe','granted','manual')),
  updated_at      TEXT NOT NULL
) STRICT;
CREATE TABLE project_credit (
  project_id      TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  period          TEXT NOT NULL,
  used_micros     INTEGER NOT NULL DEFAULT 0,
  budget_micros   INTEGER,
  budget_mode     TEXT CHECK (budget_mode IN ('continue','stop'))
) STRICT;
CREATE TABLE credit_reservation (
  reservation_id  TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id      TEXT,
  amount_micros   INTEGER NOT NULL CHECK (amount_micros > 0),
  created_at      TEXT NOT NULL
) STRICT;
CREATE TABLE credit_grant (
  key             TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  amount_micros   INTEGER NOT NULL,
  paid_minor      INTEGER,
  reversed_micros INTEGER NOT NULL DEFAULT 0,
  granted_at      TEXT NOT NULL
) STRICT;
CREATE TABLE usage_cursor (source TEXT PRIMARY KEY, through TEXT NOT NULL) STRICT;
CREATE TABLE credit_log (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL UNIQUE,
  at              TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  kind            TEXT NOT NULL,
  delta_micros    INTEGER NOT NULL,
  balance_micros  INTEGER NOT NULL,
  detail          TEXT NOT NULL
) STRICT;
CREATE INDEX credit_log_at ON credit_log(at);
CREATE INDEX credit_log_org ON credit_log(organization_id, seq);
CREATE INDEX credit_grant_org ON credit_grant(organization_id, granted_at);
`;

/** Creates the six W33 tables when no migration has: the real 0600 is applied by `migrate` as soon as it exists. */
export async function ensureCreditTables(db: D1Database): Promise<void> {
  const present = await db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'credit_account'")
    .first();
  if (present === null)
    await db.batch(splitStatements(W33_CONTRACT_SCHEMA).map((statement) => db.prepare(statement)));
}
