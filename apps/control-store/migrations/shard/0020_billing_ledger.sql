-- Billing financial primitives of the tenant shard: wallet, credit lots, holds, refunds and the durable
-- archive outbox of every immutable financial effect. Ports organization-credits.ts (grant, reserve,
-- settle, release) and the refund half of the measured-credits corrections; Stripe payments, paid
-- coverage, lot adjustments, project budgets and the seven-day grace are separate later migrations.
--
-- Money is INTEGER micro-credits over the full PostgreSQL int8 range 0..9223372036854775807 per amount (the
-- existing money contract; there is no narrower cap). It is bound as decimal text through CAST(? AS INTEGER)
-- and read back through CAST(x AS TEXT); the application never holds it in a JavaScript number. SQLite turns
-- an INTEGER addition that overflows into a REAL, so no CHECK, index predicate or guard of the ledger ever
-- ADDS two money columns: every conservation rule is a subtraction of non-negative values
-- (`held <= amount - spent`), which cannot overflow. Totals above int8 (balances, platform exposure) are
-- never stored in a SQLite integer: the Worker sums them exactly in BigInt.
-- Idempotency rows (credit_lots, credit_holds, credit_refunds) are never compacted: the dedupe horizon of
-- a financial effect is the lifetime of the organization.

CREATE TABLE credit_wallets (
  organization_id TEXT    NOT NULL PRIMARY KEY REFERENCES organizations (organization_id),
  -- Bumped by every write that moves lot counters; a stale snapshot aborts with guard_wallet_version_conflict.
  -- No money lives here. Platform exposure (charge that no lot could fund) is derived per settled hold, as
  -- PostgreSQL derives it per resolution, so one legal resolution can never poison the next (credit_holds_exposed).
  version         INTEGER NOT NULL CHECK (version >= 0),
  created_at      TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at      TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

CREATE TABLE credit_lots (
  organization_id  TEXT    NOT NULL REFERENCES credit_wallets (organization_id),
  grant_id         TEXT    NOT NULL CHECK (length(grant_id) = 26),
  kind             TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  source_reference TEXT    NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 256),
  amount_micros    INTEGER NOT NULL CHECK (amount_micros BETWEEN 1 AND 9223372036854775807),
  granted_at       TEXT    NOT NULL CHECK (granted_at GLOB '????-??-??T??:??:??.??????Z'),
  -- NULL never expires. The instant is fixed at grant; a derived expiry (paid coverage) is a later migration.
  expires_at       TEXT    CHECK (expires_at IS NULL OR expires_at GLOB '????-??-??T??:??:??.??????Z'),
  is_topup         INTEGER NOT NULL CHECK (is_topup IN (0, 1)),
  held_micros      INTEGER NOT NULL CHECK (held_micros >= 0),
  spent_micros     INTEGER NOT NULL CHECK (spent_micros >= 0),
  PRIMARY KEY (organization_id, grant_id),
  UNIQUE (organization_id, kind, source_reference),
  -- Conservation: a lot is never over-allocated, whatever the application does. A subtraction, because
  -- `held + spent` would overflow into an imprecise REAL near the int8 maximum.
  CHECK (held_micros <= amount_micros - spent_micros)
) STRICT, WITHOUT ROWID;
CREATE INDEX credit_lots_with_remaining ON credit_lots (organization_id, granted_at)
  WHERE held_micros < amount_micros - spent_micros;
CREATE TRIGGER credit_lots_identity BEFORE UPDATE OF organization_id, grant_id, kind, source_reference, amount_micros, granted_at, expires_at, is_topup ON credit_lots
BEGIN SELECT RAISE(ABORT, 'credit_lots identity is immutable'); END;
CREATE TRIGGER credit_lots_no_delete BEFORE DELETE ON credit_lots
BEGIN SELECT RAISE(ABORT, 'credit_lots rows are never deleted'); END;

-- One row per reservation, merged with its resolution.
CREATE TABLE credit_holds (
  organization_id      TEXT    NOT NULL,
  hold_id              TEXT    NOT NULL CHECK (length(hold_id) = 26),
  project_id           TEXT    NOT NULL,
  environment_id       TEXT,
  billing_epoch_id     TEXT    NOT NULL,
  kind                 TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  source_reference     TEXT    NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 256),
  amount_micros        INTEGER NOT NULL CHECK (amount_micros BETWEEN 0 AND 9223372036854775807),
  state                TEXT    NOT NULL CHECK (state IN ('open', 'settled', 'released')),
  created_at           TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  resolved_at          TEXT    CHECK (resolved_at IS NULL OR resolved_at GLOB '????-??-??T??:??:??.??????Z'),
  charge_micros        INTEGER CHECK (charge_micros IS NULL OR charge_micros BETWEEN 0 AND 9223372036854775807),
  funded_micros        INTEGER CHECK (funded_micros IS NULL OR funded_micros BETWEEN 0 AND 9223372036854775807),
  -- Corrections after settlement: charge removed and funded credit restored to the lots.
  refunded_micros      INTEGER NOT NULL CHECK (refunded_micros >= 0),
  restored_micros      INTEGER NOT NULL CHECK (restored_micros >= 0),
  provider_cost_micros INTEGER,
  rate_card_id         TEXT,
  meter                TEXT,
  unit                 TEXT,
  quantity             INTEGER CHECK (quantity IS NULL OR quantity >= 0),
  event_time           TEXT    CHECK (event_time IS NULL OR event_time GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, hold_id),
  UNIQUE (organization_id, kind, source_reference),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, billing_epoch_id) REFERENCES billing_epochs (organization_id, billing_epoch_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id),
  CHECK (refunded_micros <= COALESCE(charge_micros, 0) AND restored_micros <= COALESCE(funded_micros, 0)),
  CHECK ((state = 'open' AND resolved_at IS NULL AND charge_micros IS NULL AND funded_micros IS NULL
          AND refunded_micros = 0 AND restored_micros = 0)
      OR (state = 'released' AND resolved_at IS NOT NULL AND charge_micros = 0 AND funded_micros = 0
          AND refunded_micros = 0 AND restored_micros = 0)
      OR (state = 'settled' AND resolved_at IS NOT NULL AND charge_micros IS NOT NULL
          AND funded_micros IS NOT NULL AND funded_micros <= charge_micros
          AND funded_micros - restored_micros <= charge_micros - refunded_micros
          AND rate_card_id IS NOT NULL AND meter IS NOT NULL AND unit IS NOT NULL
          AND quantity IS NOT NULL AND event_time IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX credit_holds_open ON credit_holds (organization_id, project_id) WHERE state = 'open';
-- Platform exposure of the organization: the settled holds whose net charge exceeds their net funded credit
-- (`charge - refunded` against `funded - restored`, all non-negative, so the subtractions cannot overflow).
-- The exposure read uses the identical predicate; it sums the per-hold remainders exactly (see reads.ts).
CREATE INDEX credit_holds_exposed ON credit_holds (organization_id)
  WHERE state = 'settled' AND funded_micros - restored_micros < charge_micros - refunded_micros;
CREATE TRIGGER credit_holds_identity BEFORE UPDATE OF organization_id, hold_id, project_id, environment_id, billing_epoch_id, kind, source_reference, amount_micros, created_at ON credit_holds
BEGIN SELECT RAISE(ABORT, 'credit_holds identity is immutable'); END;
-- A resolved hold keeps its resolution facts; only the refund counters move afterwards.
CREATE TRIGGER credit_holds_terminal BEFORE UPDATE OF state, resolved_at, charge_micros, funded_micros, provider_cost_micros, rate_card_id, meter, unit, quantity, event_time ON credit_holds WHEN OLD.state <> 'open'
BEGIN SELECT RAISE(ABORT, 'a resolved credit hold is terminal'); END;
CREATE TRIGGER credit_holds_no_delete BEFORE DELETE ON credit_holds
BEGIN SELECT RAISE(ABORT, 'credit_holds rows are never deleted'); END;

-- The per-lot allocation of one hold: what it held at reserve and what it spent from each lot at settlement.
CREATE TABLE credit_hold_lots (
  organization_id TEXT    NOT NULL,
  hold_id         TEXT    NOT NULL,
  grant_id        TEXT    NOT NULL,
  held_micros     INTEGER NOT NULL CHECK (held_micros >= 0),
  spent_micros    INTEGER NOT NULL CHECK (spent_micros >= 0),
  restored_micros INTEGER NOT NULL CHECK (restored_micros >= 0),
  PRIMARY KEY (organization_id, hold_id, grant_id),
  FOREIGN KEY (organization_id, hold_id) REFERENCES credit_holds (organization_id, hold_id),
  FOREIGN KEY (organization_id, grant_id) REFERENCES credit_lots (organization_id, grant_id),
  CHECK (restored_micros <= spent_micros)
) STRICT, WITHOUT ROWID;
CREATE INDEX credit_hold_lots_by_grant ON credit_hold_lots (organization_id, grant_id);

CREATE TABLE credit_refunds (
  organization_id  TEXT    NOT NULL,
  refund_id        TEXT    NOT NULL CHECK (length(refund_id) BETWEEN 1 AND 128),
  hold_id          TEXT    NOT NULL,
  refund_micros    INTEGER NOT NULL CHECK (refund_micros BETWEEN 1 AND 9223372036854775807),
  restored_micros  INTEGER NOT NULL CHECK (restored_micros BETWEEN 0 AND refund_micros),
  created_at       TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, refund_id),
  FOREIGN KEY (organization_id, hold_id) REFERENCES credit_holds (organization_id, hold_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER credit_refunds_immutable BEFORE UPDATE ON credit_refunds
BEGIN SELECT RAISE(ABORT, 'credit_refunds is append-only'); END;
CREATE TRIGGER credit_refunds_no_delete BEFORE DELETE ON credit_refunds
BEGIN SELECT RAISE(ABORT, 'credit_refunds rows are never deleted'); END;

-- Immutable financial effects and their durable archive outbox: a row with archived_at NULL is an
-- unfulfilled outbox entry. Only the archive pointer is ever written, once, and only an archived row can be
-- compacted away, so the hot ledger never loses an effect that is not in the archive.
CREATE TABLE credit_effects (
  organization_id TEXT NOT NULL,
  effect_id       TEXT NOT NULL CHECK (length(effect_id) BETWEEN 1 AND 192),
  effect_kind     TEXT NOT NULL CHECK (effect_kind IN ('grant', 'reserve', 'settle', 'release', 'refund')),
  occurred_at     TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  payload         TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  archived_at     TEXT CHECK (archived_at IS NULL OR archived_at GLOB '????-??-??T??:??:??.??????Z'),
  archive_key     TEXT,
  archive_sha256  TEXT CHECK (archive_sha256 IS NULL OR (length(archive_sha256) = 64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (organization_id, effect_id),
  CHECK ((archived_at IS NULL) = (archive_key IS NULL) AND (archived_at IS NULL) = (archive_sha256 IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX credit_effects_unarchived ON credit_effects (organization_id, occurred_at) WHERE archived_at IS NULL;
CREATE INDEX credit_effects_archived ON credit_effects (organization_id, archived_at) WHERE archived_at IS NOT NULL;
CREATE TRIGGER credit_effects_immutable BEFORE UPDATE OF organization_id, effect_id, effect_kind, occurred_at, payload ON credit_effects
BEGIN SELECT RAISE(ABORT, 'credit_effects is append-only'); END;
CREATE TRIGGER credit_effects_archive_once BEFORE UPDATE OF archived_at, archive_key, archive_sha256 ON credit_effects WHEN OLD.archived_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'credit_effects archive pointer is written once'); END;
CREATE TRIGGER credit_effects_delete_only_archived BEFORE DELETE ON credit_effects WHEN OLD.archived_at IS NULL
BEGIN SELECT RAISE(ABORT, 'credit_effects rows are deletable only after archive'); END;
