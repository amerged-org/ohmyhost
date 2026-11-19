-- Published credit rate cards and prospective meter activations of the tenant shard (milestone Q2-B). Ports
-- published_credit_rate_cards and usage_meter_activations: a price version is published once and never changes, and a
-- meter bills only after an operator activated it for a published card at a future instant. Both are global facts that
-- every shard holds as an identical replica: the rate-card authority writes each shard through the same idempotent
-- statements, and a posting reads the card on the shard of its organization, inside its own decision snapshot.
--
-- `rates` is the JSON array of the original jsonb document, byte-for-byte per rate: meter, unit, units_per_charge,
-- provider_cost_micros (a decimal string, or null when the provider cost is not allocated per unit) and credit_micros.
-- Every amount is a decimal string, never a JSON number, so int8 values survive a round trip. The valuation arithmetic
-- (one ceil rounding per completed interval) is the platform's evaluateRateCard and is not restated here.

CREATE TABLE published_credit_rate_cards (
  rate_card_id   TEXT NOT NULL PRIMARY KEY CHECK (length(rate_card_id) BETWEEN 1 AND 128),
  published_at   TEXT NOT NULL CHECK (published_at GLOB '????-??-??T??:??:??.??????Z'),
  effective_from TEXT NOT NULL CHECK (effective_from GLOB '????-??-??T??:??:??.??????Z'),
  rates          TEXT NOT NULL CHECK (json_valid(rates) AND json_type(rates) = 'array' AND json_array_length(rates) >= 1),
  -- A price is published before it is effective (selectEffectiveRateCard refuses the opposite).
  CHECK (published_at <= effective_from),
  -- The original table is UNIQUE(effective_from): two versions never start at the same instant, so "the card in
  -- force" is never a tie.
  UNIQUE (effective_from)
) STRICT, WITHOUT ROWID;
CREATE INDEX published_credit_rate_cards_by_effect ON published_credit_rate_cards (effective_from DESC);
CREATE TRIGGER published_credit_rate_cards_immutable BEFORE UPDATE ON published_credit_rate_cards
BEGIN SELECT RAISE(ABORT, 'published_credit_rate_cards is append-only'); END;
CREATE TRIGGER published_credit_rate_cards_no_delete BEFORE DELETE ON published_credit_rate_cards
BEGIN SELECT RAISE(ABORT, 'published_credit_rate_cards rows are never deleted'); END;

-- One activation per meter, prospective and immutable: a published price alone never starts billing.
CREATE TABLE usage_meter_activations (
  meter        TEXT NOT NULL PRIMARY KEY CHECK (length(meter) BETWEEN 1 AND 128),
  rate_card_id TEXT NOT NULL REFERENCES published_credit_rate_cards (rate_card_id),
  starts_at    TEXT NOT NULL CHECK (starts_at GLOB '????-??-??T??:??:??.??????Z'),
  activated_at TEXT NOT NULL CHECK (activated_at GLOB '????-??-??T??:??:??.??????Z'),
  CHECK (starts_at >= activated_at)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER usage_meter_activations_immutable BEFORE UPDATE ON usage_meter_activations
BEGIN SELECT RAISE(ABORT, 'usage_meter_activations is append-only'); END;
CREATE TRIGGER usage_meter_activations_no_delete BEFORE DELETE ON usage_meter_activations
BEGIN SELECT RAISE(ABORT, 'usage_meter_activations rows are never deleted'); END;
