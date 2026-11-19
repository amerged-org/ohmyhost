-- core-v1 source: migrations/shard/0050_billing_policy.sql
-- Billing policy facts of the tenant shard (milestone Q2-A): the immutable payment, access, adjustment and
-- grace history that the credit-expiry policy v1, the Paid-access check, the seven-day exhaustion grace and
-- the project budgets read. Ports organization_credit_grant_adjustments / _expirations, stripe_credit_payments
-- (offer 'paid'), stripe_subscription_ends, organization_paid_access(_events), organization_credit_grace_periods
-- and project_credit_budgets. Stripe checkout bookkeeping, recharge attempts and the webhook inbox are a later
-- milestone (F08); the only checkout facts the policy needs are the top-up origin instants kept here.
--
-- Money keeps the 0020 contract: INTEGER micro-credits, full int8 range, bound as decimal text, never added in
-- SQL. An adjustment is signed (a refund revokes credit, a Paid transition removes unspent Free credit), so its
-- CHECK is a symmetric int8 range and nothing in SQL ever sums two adjustments: the Worker sums in BigInt.
-- Every fact table here is append-only except the grace row (one per continuous exhaustion), the current
-- paid-access row and the budget row; every write of a money-relevant fact bumps the wallet version.

-- A new immutable effect kind: a lot adjustment is a financial fact and joins the archive outbox. The table is
-- recreated (SQLite cannot alter a CHECK); it carries no foreign key and, before any D1 data exists, no row.
CREATE TABLE credit_effects_v2 (
  organization_id TEXT NOT NULL,
  effect_id       TEXT NOT NULL CHECK (length(effect_id) BETWEEN 1 AND 192),
  effect_kind     TEXT NOT NULL CHECK (effect_kind IN ('grant', 'reserve', 'settle', 'release', 'refund', 'adjust')),
  occurred_at     TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  payload         TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  archived_at     TEXT CHECK (archived_at IS NULL OR archived_at GLOB '????-??-??T??:??:??.??????Z'),
  archive_key     TEXT,
  archive_sha256  TEXT CHECK (archive_sha256 IS NULL OR (length(archive_sha256) = 64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (organization_id, effect_id),
  CHECK ((archived_at IS NULL) = (archive_key IS NULL) AND (archived_at IS NULL) = (archive_sha256 IS NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO credit_effects_v2 SELECT organization_id, effect_id, effect_kind, occurred_at, payload, archived_at, archive_key, archive_sha256 FROM credit_effects;
DROP TABLE credit_effects;
ALTER TABLE credit_effects_v2 RENAME TO credit_effects;
CREATE INDEX credit_effects_unarchived ON credit_effects (organization_id, occurred_at) WHERE archived_at IS NULL;
CREATE INDEX credit_effects_archived ON credit_effects (organization_id, archived_at) WHERE archived_at IS NOT NULL;
CREATE TRIGGER credit_effects_immutable BEFORE UPDATE OF organization_id, effect_id, effect_kind, occurred_at, payload ON credit_effects
BEGIN SELECT RAISE(ABORT, 'credit_effects is append-only'); END;
CREATE TRIGGER credit_effects_archive_once BEFORE UPDATE OF archived_at, archive_key, archive_sha256 ON credit_effects WHEN OLD.archived_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'credit_effects archive pointer is written once'); END;
CREATE TRIGGER credit_effects_delete_only_archived BEFORE DELETE ON credit_effects WHEN OLD.archived_at IS NULL
BEGIN SELECT RAISE(ABORT, 'credit_effects rows are deletable only after archive'); END;

-- Verified Stripe Paid invoices (offer 'paid'): one credited paid_monthly lot per period. paid_at is the invoice
-- payment instant when Stripe reported it (NULL: confirmed_at is the observation), confirmed_at the receipt.
CREATE TABLE credit_paid_periods (
  organization_id TEXT    NOT NULL,
  grant_id        TEXT    NOT NULL,
  account_id      TEXT    NOT NULL CHECK (account_id GLOB 'acct_*' AND length(account_id) BETWEEN 6 AND 133),
  mode            TEXT    NOT NULL CHECK (mode IN ('test', 'live')),
  subscription_id TEXT    NOT NULL CHECK (subscription_id GLOB 'sub_*' AND length(subscription_id) BETWEEN 5 AND 256),
  invoice_id      TEXT    NOT NULL CHECK (invoice_id GLOB 'in_*' AND length(invoice_id) BETWEEN 4 AND 256),
  period_start    TEXT    NOT NULL CHECK (period_start GLOB '????-??-??T??:??:??.??????Z'),
  period_end      TEXT    NOT NULL CHECK (period_end GLOB '????-??-??T??:??:??.??????Z'),
  paid_at         TEXT    CHECK (paid_at IS NULL OR paid_at GLOB '????-??-??T??:??:??.??????Z'),
  confirmed_at    TEXT    NOT NULL CHECK (confirmed_at GLOB '????-??-??T??:??:??.??????Z'),
  credited_micros INTEGER NOT NULL CHECK (credited_micros = 1000000000),
  PRIMARY KEY (organization_id, grant_id),
  UNIQUE (organization_id, account_id, mode, invoice_id),
  UNIQUE (organization_id, account_id, mode, subscription_id, period_start),
  FOREIGN KEY (organization_id, grant_id) REFERENCES credit_lots (organization_id, grant_id),
  CHECK (period_end > period_start),
  CHECK (paid_at IS NULL OR paid_at <= confirmed_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER credit_paid_periods_immutable BEFORE UPDATE ON credit_paid_periods
BEGIN SELECT RAISE(ABORT, 'credit_paid_periods is append-only'); END;
CREATE TRIGGER credit_paid_periods_no_delete BEFORE DELETE ON credit_paid_periods
BEGIN SELECT RAISE(ABORT, 'credit_paid_periods rows are never deleted'); END;

-- Stripe's reported end of a subscription: closes that subscription's Paid coverage at the end instead of 14 days after.
CREATE TABLE credit_subscription_ends (
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id),
  account_id      TEXT NOT NULL CHECK (account_id GLOB 'acct_*' AND length(account_id) BETWEEN 6 AND 133),
  mode            TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  subscription_id TEXT NOT NULL CHECK (subscription_id GLOB 'sub_*' AND length(subscription_id) BETWEEN 5 AND 256),
  ended_at        TEXT NOT NULL CHECK (ended_at GLOB '????-??-??T??:??:??.??????Z'),
  observed_at     TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, account_id, mode, subscription_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER credit_subscription_ends_immutable BEFORE UPDATE ON credit_subscription_ends
BEGIN SELECT RAISE(ABORT, 'credit_subscription_ends is append-only'); END;
CREATE TRIGGER credit_subscription_ends_no_delete BEFORE DELETE ON credit_subscription_ends
BEGIN SELECT RAISE(ABORT, 'credit_subscription_ends rows are never deleted'); END;

-- Signed lot adjustments (refund / dispute revocation, Paid allowance transition). Effective lot amount at
-- instant t is amount - sum(adjustments occurred_at <= t); movements still count across all time.
CREATE TABLE credit_lot_adjustments (
  organization_id  TEXT    NOT NULL,
  adjustment_id    TEXT    NOT NULL CHECK (length(adjustment_id) = 26),
  grant_id         TEXT    NOT NULL,
  source_kind      TEXT    NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 64),
  source_reference TEXT    NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 256),
  amount_micros    INTEGER NOT NULL CHECK (amount_micros <> 0 AND amount_micros BETWEEN -9223372036854775807 AND 9223372036854775807),
  occurred_at      TEXT    NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, adjustment_id),
  FOREIGN KEY (organization_id, grant_id) REFERENCES credit_lots (organization_id, grant_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX credit_lot_adjustments_by_grant ON credit_lot_adjustments (organization_id, grant_id, occurred_at);
-- A Paid allowance transition happens once per Paid period and Free lot: the PostgreSQL policy relied on the
-- replayed grant id; the natural key makes a twin transition impossible even under a different adjustment id.
CREATE UNIQUE INDEX credit_lot_adjustments_transition ON credit_lot_adjustments (organization_id, grant_id, source_reference)
  WHERE source_kind = 'paid_allowance_transition';
CREATE TRIGGER credit_lot_adjustments_immutable BEFORE UPDATE ON credit_lot_adjustments
BEGIN SELECT RAISE(ABORT, 'credit_lot_adjustments is append-only'); END;
CREATE TRIGGER credit_lot_adjustments_no_delete BEFORE DELETE ON credit_lot_adjustments
BEGIN SELECT RAISE(ABORT, 'credit_lot_adjustments rows are never deleted'); END;

-- Preserved expiry of a top-up under an earlier rule (migration 157 of the original), a lower bound of its derived expiry.
CREATE TABLE credit_lot_expirations (
  organization_id TEXT NOT NULL,
  grant_id        TEXT NOT NULL,
  expires_at      TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z'),
  recorded_at     TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, grant_id),
  FOREIGN KEY (organization_id, grant_id) REFERENCES credit_lots (organization_id, grant_id),
  CHECK (expires_at <= recorded_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER credit_lot_expirations_immutable BEFORE UPDATE ON credit_lot_expirations
BEGIN SELECT RAISE(ABORT, 'credit_lot_expirations is append-only'); END;
CREATE TRIGGER credit_lot_expirations_no_delete BEFORE DELETE ON credit_lot_expirations
BEGIN SELECT RAISE(ABORT, 'credit_lot_expirations rows are never deleted'); END;

-- The instant a top-up was started (its Checkout or recharge attempt creation), which decides whether the top-up
-- was bought inside a Paid coverage period; without a row the grant instant stands in, as in the original.
CREATE TABLE credit_topup_origins (
  organization_id TEXT NOT NULL,
  grant_id        TEXT NOT NULL,
  started_at      TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, grant_id),
  FOREIGN KEY (organization_id, grant_id) REFERENCES credit_lots (organization_id, grant_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER credit_topup_origins_immutable BEFORE UPDATE ON credit_topup_origins
BEGIN SELECT RAISE(ABORT, 'credit_topup_origins is append-only'); END;
CREATE TRIGGER credit_topup_origins_no_delete BEFORE DELETE ON credit_topup_origins
BEGIN SELECT RAISE(ABORT, 'credit_topup_origins rows are never deleted'); END;

-- Operator Paid access: the append-only event log and the current row (feature access, separate from Stripe periods).
CREATE TABLE credit_paid_access_events (
  organization_id TEXT    NOT NULL REFERENCES organizations (organization_id),
  event_id        TEXT    NOT NULL CHECK (length(event_id) = 26),
  enabled         INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  source          TEXT    NOT NULL CHECK (source IN ('granted', 'manual')),
  reason          TEXT    NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor_id        TEXT    NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
  occurred_at     TEXT    NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  paid_until      TEXT    CHECK (paid_until IS NULL OR paid_until GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, event_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX credit_paid_access_events_by_time ON credit_paid_access_events (organization_id, occurred_at, event_id);
CREATE TRIGGER credit_paid_access_events_immutable BEFORE UPDATE ON credit_paid_access_events
BEGIN SELECT RAISE(ABORT, 'credit_paid_access_events is append-only'); END;
CREATE TRIGGER credit_paid_access_events_no_delete BEFORE DELETE ON credit_paid_access_events
BEGIN SELECT RAISE(ABORT, 'credit_paid_access_events rows are never deleted'); END;

CREATE TABLE credit_paid_access (
  organization_id TEXT    NOT NULL PRIMARY KEY REFERENCES organizations (organization_id),
  enabled         INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  source          TEXT    NOT NULL CHECK (source IN ('granted', 'manual')),
  reason          TEXT    NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  updated_at      TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  paid_until      TEXT    CHECK (paid_until IS NULL OR paid_until GLOB '????-??-??T??:??:??.??????Z'),
  revision        INTEGER NOT NULL CHECK (revision >= 1)
) STRICT, WITHOUT ROWID;

-- One durable seven-day service grace per continuous exhaustion of the organization wallet.
CREATE TABLE credit_grace_periods (
  organization_id TEXT NOT NULL PRIMARY KEY REFERENCES organizations (organization_id),
  exhausted_at    TEXT NOT NULL CHECK (exhausted_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

-- Per-project monthly credit budget. `stop` refuses a new reservation or runtime admission that would exceed it.
CREATE TABLE project_credit_budgets (
  organization_id TEXT    NOT NULL,
  project_id      TEXT    NOT NULL,
  amount_micros   INTEGER CHECK (amount_micros IS NULL OR amount_micros BETWEEN 0 AND 9223372036854775807),
  mode            TEXT    NOT NULL CHECK (mode IN ('continue', 'stop')),
  updated_at      TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  CHECK (amount_micros IS NOT NULL OR mode = 'continue')
) STRICT, WITHOUT ROWID;

-- A refund is PostgreSQL's signed 'corrected' resolution: its negative charge counts in the project budget's used
-- total in the UTC event month of the corrected source (the settled hold's event_time). NULL: the hold carried
-- no usage event time, so neither the charge nor its correction is part of any month's used total.
ALTER TABLE credit_refunds ADD COLUMN event_time TEXT CHECK (event_time IS NULL OR event_time GLOB '????-??-??T??:??:??.??????Z');
CREATE INDEX credit_refunds_by_event ON credit_refunds (organization_id, event_time) WHERE event_time IS NOT NULL;

-- Month used/reserved of a project are read by event time of settled holds and by state of open holds.
CREATE INDEX credit_holds_settled_by_project_event ON credit_holds (organization_id, project_id, event_time)
  WHERE state = 'settled';
