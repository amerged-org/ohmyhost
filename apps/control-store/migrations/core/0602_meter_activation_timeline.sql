-- W33.5 price changes: the activations of a meter become a timeline. Migration 0251 ported the original table with
-- PRIMARY KEY (meter), so a meter could be activated exactly once and its price could never change after that. The key
-- is now (meter, starts_at): a later activation of the same meter with another published card supersedes the earlier
-- one from its own start time, the earlier rows keep pricing everything before it, and every row stays append-only.
-- Rows are copied unchanged and nothing references the table. Operator writes go through scripts/credit-prices.mjs.

CREATE TABLE usage_meter_activations_timeline (
  meter        TEXT NOT NULL CHECK (length(meter) BETWEEN 1 AND 128),
  rate_card_id TEXT NOT NULL REFERENCES published_credit_rate_cards (rate_card_id),
  starts_at    TEXT NOT NULL CHECK (starts_at GLOB '????-??-??T??:??:??.??????Z'),
  activated_at TEXT NOT NULL CHECK (activated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (meter, starts_at),
  CHECK (starts_at >= activated_at)
) STRICT, WITHOUT ROWID;
INSERT INTO usage_meter_activations_timeline (meter, rate_card_id, starts_at, activated_at)
  SELECT meter, rate_card_id, starts_at, activated_at FROM usage_meter_activations;
DROP TABLE usage_meter_activations;
ALTER TABLE usage_meter_activations_timeline RENAME TO usage_meter_activations;
CREATE TRIGGER usage_meter_activations_immutable BEFORE UPDATE ON usage_meter_activations
BEGIN SELECT RAISE(ABORT, 'usage_meter_activations is append-only'); END;
CREATE TRIGGER usage_meter_activations_no_delete BEFORE DELETE ON usage_meter_activations
BEGIN SELECT RAISE(ABORT, 'usage_meter_activations rows are never deleted'); END;
CREATE TRIGGER usage_meter_activations_released_shape BEFORE INSERT ON usage_meter_activations
  WHEN NEW.meter NOT GLOB '[a-z]*' OR NEW.meter GLOB '*[^a-z0-9_.-]*'
BEGIN SELECT RAISE(ABORT, 'meter requires original 087 grammar'); END;
