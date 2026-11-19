-- W33 simple credits: one credit account per organization replaces the lot / hold / effect / valuation / projection chain.
-- The Core holds only AMOUNTS; the reason for every change is a credit_log row that is rotated to R2 at 00:00 UTC and kept
-- 14 days. Money is INTEGER micro-credits (1 credit = 1_000_000 micros), bound with CAST(? AS INTEGER) because D1 binds
-- JavaScript numbers as REAL. Every write is ONE db.batch; the UNIQUE credit_log.key is the double-posting guard.
-- Migration 0601 drops the old credit tables and triggers; this one only creates the new tables and seeds them.

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
  updated_at      TEXT    NOT NULL,
  warned_for_exhausted_at TEXT,
  warning_next_attempt_at TEXT
) STRICT;

CREATE TABLE project_credit (
  project_id      TEXT PRIMARY KEY,
  organization_id TEXT    NOT NULL,
  period          TEXT    NOT NULL,
  used_micros     INTEGER NOT NULL DEFAULT 0,
  budget_micros   INTEGER,
  budget_mode     TEXT CHECK (budget_mode IN ('continue','stop'))
) STRICT;

CREATE TABLE credit_reservation (
  reservation_id  TEXT PRIMARY KEY,
  organization_id TEXT    NOT NULL,
  project_id      TEXT,
  amount_micros   INTEGER NOT NULL CHECK (amount_micros > 0),
  created_at      TEXT    NOT NULL
) STRICT;

CREATE TABLE credit_grant (
  key             TEXT PRIMARY KEY,
  organization_id TEXT    NOT NULL,
  amount_micros   INTEGER NOT NULL,
  paid_minor      INTEGER,
  reversed_micros INTEGER NOT NULL DEFAULT 0,
  granted_at      TEXT    NOT NULL
) STRICT;

CREATE TABLE usage_cursor (source TEXT PRIMARY KEY, through TEXT NOT NULL) STRICT;

CREATE TABLE credit_log (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT    NOT NULL UNIQUE,
  at              TEXT    NOT NULL,
  organization_id TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  delta_micros    INTEGER NOT NULL,
  balance_micros  INTEGER NOT NULL,
  detail          TEXT    NOT NULL
) STRICT;
CREATE INDEX credit_log_at ON credit_log (at);
CREATE INDEX credit_log_org ON credit_log (organization_id, seq);
CREATE INDEX credit_grant_org ON credit_grant (organization_id, granted_at);

-- Seed: one account per organization, approximated from the lots that are valid now. A lot offers
-- amount - held - spent - adjustments, never below zero. A lot that expires is monthly (Free or Paid allowance), a lot
-- without expiry or a top-up is one-time. The monthly period ends at the latest expiry of a valid monthly lot; an
-- organization without one starts lapsed, so its first write renews the Free allowance. Paid runs until the latest
-- Stripe coverage (period end + 14 days, capped by the subscription end) or the operator access that is in force.
-- The old exhaustion grace survives only while nothing is left to spend. Reservations and holds are not carried over.
INSERT INTO credit_account(organization_id, monthly_micros, monthly_ends_at, onetime_micros, reserved_micros, overrun_micros, exhausted_at, paid_until, paid_source, updated_at)
  WITH clock(now) AS (
    SELECT strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'
  ),
  lots AS (
    SELECT l.organization_id AS organization_id,
      l.grant_id AS grant_id,
      CASE WHEN l.is_topup = 0 AND l.expires_at IS NOT NULL THEN 1 ELSE 0 END AS monthly,
      COALESCE((SELECT p.period_end FROM credit_paid_periods p WHERE p.organization_id = l.organization_id AND p.grant_id = l.grant_id), l.expires_at) AS expiry,
      MAX(l.amount_micros - l.held_micros - l.spent_micros - COALESCE((SELECT total(a.amount_micros) FROM credit_lot_adjustments a WHERE a.organization_id = l.organization_id AND a.grant_id = l.grant_id AND a.occurred_at <= clock.now), 0), 0) AS remaining
    FROM credit_lots l, clock
    WHERE l.granted_at <= clock.now
  ),
  valid AS (
    SELECT lots.organization_id AS organization_id, lots.monthly AS monthly, lots.expiry AS expiry, lots.remaining AS remaining
    FROM lots, clock
    WHERE (lots.expiry IS NULL OR lots.expiry > clock.now)
      AND NOT EXISTS (SELECT 1 FROM credit_lot_expirations e WHERE e.organization_id = lots.organization_id AND e.grant_id = lots.grant_id AND e.expires_at <= clock.now)
  ),
  totals AS (
    SELECT organization_id,
      CAST(total(CASE WHEN monthly = 1 THEN remaining END) AS INTEGER) AS monthly_micros,
      MAX(CASE WHEN monthly = 1 THEN expiry END) AS monthly_ends_at,
      CAST(total(CASE WHEN monthly = 0 THEN remaining END) AS INTEGER) AS onetime_micros
    FROM valid
    GROUP BY organization_id
  ),
  coverage AS (
    SELECT p.organization_id AS organization_id,
      MAX(MIN(strftime('%Y-%m-%dT%H:%M:%f', p.period_end, '+14 days') || '000Z', COALESCE(e.ended_at, '9999-12-31T23:59:59.999999Z'))) AS paid_until
    FROM credit_paid_periods p
      LEFT JOIN credit_subscription_ends e ON e.organization_id = p.organization_id AND e.account_id = p.account_id AND e.mode = p.mode AND e.subscription_id = p.subscription_id
    GROUP BY p.organization_id
  ),
  access AS (
    SELECT a.organization_id AS organization_id, COALESCE(a.paid_until, '9999-12-31T23:59:59.999999Z') AS paid_until, a.source AS source
    FROM credit_paid_access a, clock
    WHERE a.enabled = 1 AND (a.paid_until IS NULL OR a.paid_until > clock.now)
  )
  SELECT o.organization_id,
    COALESCE(t.monthly_micros, 0),
    COALESCE(t.monthly_ends_at, '1970-01-01T00:00:00.000000Z'),
    COALESCE(t.onetime_micros, 0),
    0,
    0,
    CASE WHEN COALESCE(t.monthly_micros, 0) + COALESCE(t.onetime_micros, 0) = 0 THEN g.exhausted_at END,
    CASE WHEN x.paid_until IS NOT NULL AND (c.paid_until IS NULL OR x.paid_until > c.paid_until) THEN x.paid_until ELSE c.paid_until END,
    CASE WHEN x.paid_until IS NOT NULL AND (c.paid_until IS NULL OR x.paid_until > c.paid_until) THEN x.source WHEN c.paid_until IS NOT NULL THEN 'stripe' END,
    clock.now
  FROM organizations o
    CROSS JOIN clock
    LEFT JOIN totals t ON t.organization_id = o.organization_id
    LEFT JOIN credit_grace_periods g ON g.organization_id = o.organization_id
    LEFT JOIN coverage c ON c.organization_id = o.organization_id
    LEFT JOIN access x ON x.organization_id = o.organization_id;

-- An exhaustion whose warning email was already sent does not warn again after the cutover.
WITH warned(organization_id, exhausted_at) AS (
  SELECT organization_id, exhausted_at FROM organization_credit_warnings
  WHERE state IN ('accepted','delivered','bounced','complained','uncertain')
)
UPDATE credit_account SET warned_for_exhausted_at = exhausted_at
  WHERE (organization_id, exhausted_at) IN (SELECT organization_id, exhausted_at FROM warned);

-- Project budgets and the month's use so far (settled charge net of refunds in the current UTC month). A project that was
-- transferred keeps only its current owner's budget.
INSERT OR IGNORE INTO project_credit(project_id, organization_id, period, used_micros, budget_micros, budget_mode)
  WITH clock(period, month_start, month_end) AS (
    SELECT strftime('%Y-%m', 'now'), strftime('%Y-%m-01T00:00:00.000000Z', 'now'), strftime('%Y-%m-01T00:00:00.000000Z', 'now', 'start of month', '+1 month')
  )
  SELECT b.project_id, b.organization_id, clock.period,
    CAST(COALESCE((SELECT total(h.charge_micros - h.refunded_micros) FROM credit_holds h WHERE h.organization_id = b.organization_id AND h.project_id = b.project_id AND h.state = 'settled' AND h.event_time >= clock.month_start AND h.event_time < clock.month_end), 0) AS INTEGER),
    b.amount_micros,
    b.mode
  FROM project_credit_budgets b
    CROSS JOIN clock
    JOIN projects p ON p.organization_id = b.organization_id AND p.project_id = b.project_id AND p.owner_state <> 'transferred';
