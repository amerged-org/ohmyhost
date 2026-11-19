-- Measured usage of the tenant shard (milestone Q2-B): the source head and the observation history behind
-- postMeasuredUsage. Ports usage_credit_valuations and the scope/latest-valuation part of credit_source_heads.
-- The money of a posting lives in the 0020 ledger: a charge is a settled `metered_usage` hold (hold id = valuation id,
-- the original reservation id) with its credit_hold_lots; a downward restatement is a set of refund rows over the
-- pooled holds of the source. Nothing here duplicates a balance; a valuation row records WHAT was valued, so a later
-- observation posts only the difference to the cumulative target and a replay at any later time answers from it.
--
-- Money keeps the 0020 contract (INTEGER micro-credits, decimal text through CAST, never added in SQL). The signed
-- columns (the delta of one observation) are symmetric int8 and are only ever read back and summed in BigInt.

-- One row per measured source (kind + reference), global to the shard. Scope is immutable for the life of the source.
-- The head columns move forward only: one revision per observation, a strictly later observation instant.
CREATE TABLE usage_sources (
  source_kind                 TEXT    NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 256),
  source_reference            TEXT    NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 256),
  organization_id             TEXT    NOT NULL,
  project_id                  TEXT    NOT NULL,
  environment_id              TEXT,
  billing_epoch_id            TEXT    NOT NULL,
  meter                       TEXT    NOT NULL CHECK (length(meter) BETWEEN 1 AND 256),
  unit                        TEXT    NOT NULL CHECK (length(unit) BETWEEN 1 AND 256),
  event_time                  TEXT    NOT NULL CHECK (event_time GLOB '????-??-??T??:??:??.??????Z'),
  latest_valuation_id         TEXT    NOT NULL CHECK (length(latest_valuation_id) = 26),
  latest_observed_at          TEXT    NOT NULL CHECK (latest_observed_at GLOB '????-??-??T??:??:??.??????Z'),
  latest_rate_card_id         TEXT    NOT NULL REFERENCES published_credit_rate_cards (rate_card_id),
  target_quantity             INTEGER NOT NULL CHECK (target_quantity BETWEEN 0 AND 9223372036854775807),
  target_charge_micros        INTEGER NOT NULL CHECK (target_charge_micros BETWEEN 0 AND 9223372036854775807),
  -- NULL: the provider cost is not allocated per unit (PGCF memory). It is never a 0 and never changes basis.
  target_provider_cost_micros INTEGER CHECK (target_provider_cost_micros IS NULL OR target_provider_cost_micros BETWEEN 0 AND 9223372036854775807),
  revision                    INTEGER NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (source_kind, source_reference),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, billing_epoch_id) REFERENCES billing_epochs (organization_id, billing_epoch_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX usage_sources_by_organization ON usage_sources (organization_id, project_id);
CREATE TRIGGER usage_sources_identity BEFORE UPDATE OF source_kind, source_reference, organization_id, project_id,
    environment_id, billing_epoch_id, meter, unit, event_time ON usage_sources
BEGIN SELECT RAISE(ABORT, 'usage_sources scope is immutable'); END;
CREATE TRIGGER usage_sources_forward_only BEFORE UPDATE ON usage_sources
  WHEN NEW.revision <> OLD.revision + 1 OR NEW.latest_observed_at <= OLD.latest_observed_at
    OR (NEW.target_provider_cost_micros IS NULL) <> (OLD.target_provider_cost_micros IS NULL)
BEGIN SELECT RAISE(ABORT, 'usage_sources moves forward one observation at a time'); END;
CREATE TRIGGER usage_sources_no_delete BEFORE DELETE ON usage_sources
BEGIN SELECT RAISE(ABORT, 'usage_sources rows are never deleted'); END;

-- One row per accepted observation of a source: the cumulative target it valued and the delta it posted. A settled
-- observation (target at or above the previous one) is the `metered_usage` hold of the same id; a corrected one
-- (target below the previous) has no hold and appears in the ledger as the refund rows `refund-<valuation id>:<hold id>`.
CREATE TABLE usage_valuations (
  organization_id             TEXT    NOT NULL,
  valuation_id                TEXT    NOT NULL CHECK (length(valuation_id) = 26),
  source_kind                 TEXT    NOT NULL,
  source_reference            TEXT    NOT NULL,
  observation_reference       TEXT    NOT NULL CHECK (length(observation_reference) BETWEEN 1 AND 256),
  outcome                     TEXT    NOT NULL CHECK (outcome IN ('settled', 'corrected')),
  rate_card_id                TEXT    NOT NULL REFERENCES published_credit_rate_cards (rate_card_id),
  observed_at                 TEXT    NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  posted_at                   TEXT    NOT NULL CHECK (posted_at GLOB '????-??-??T??:??:??.??????Z'),
  target_quantity             INTEGER NOT NULL CHECK (target_quantity BETWEEN 0 AND 9223372036854775807),
  target_charge_micros        INTEGER NOT NULL CHECK (target_charge_micros BETWEEN 0 AND 9223372036854775807),
  target_provider_cost_micros INTEGER CHECK (target_provider_cost_micros IS NULL OR target_provider_cost_micros BETWEEN 0 AND 9223372036854775807),
  quantity_delta              INTEGER NOT NULL CHECK (quantity_delta BETWEEN -9223372036854775807 AND 9223372036854775807),
  charge_delta_micros         INTEGER NOT NULL CHECK (charge_delta_micros BETWEEN -9223372036854775807 AND 9223372036854775807),
  funded_delta_micros         INTEGER NOT NULL CHECK (funded_delta_micros BETWEEN -9223372036854775807 AND 9223372036854775807),
  PRIMARY KEY (organization_id, valuation_id),
  UNIQUE (source_kind, source_reference, observation_reference),
  -- Observations of a source are strictly ordered: the stale check is a unique instant.
  UNIQUE (source_kind, source_reference, observed_at),
  FOREIGN KEY (source_kind, source_reference) REFERENCES usage_sources (source_kind, source_reference),
  CHECK ((outcome = 'settled' AND charge_delta_micros >= 0 AND funded_delta_micros >= 0 AND quantity_delta >= 0)
      OR (outcome = 'corrected' AND charge_delta_micros <= 0 AND funded_delta_micros <= 0 AND quantity_delta < 0))
) STRICT, WITHOUT ROWID;
CREATE INDEX usage_valuations_by_organization ON usage_valuations (organization_id, observed_at);
CREATE TRIGGER usage_valuations_immutable BEFORE UPDATE ON usage_valuations
BEGIN SELECT RAISE(ABORT, 'usage_valuations is append-only'); END;
CREATE TRIGGER usage_valuations_no_delete BEFORE DELETE ON usage_valuations
BEGIN SELECT RAISE(ABORT, 'usage_valuations rows are never deleted'); END;
