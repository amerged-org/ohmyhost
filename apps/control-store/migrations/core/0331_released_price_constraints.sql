-- Original 085 / 087 constraints, retained as INSERT guards without rebuilding FK parents or rewriting price bytes.
CREATE TRIGGER published_credit_rate_cards_released_shape BEFORE INSERT ON published_credit_rate_cards
  WHEN NEW.rate_card_id GLOB '*[^a-z0-9_.-]*' OR json_array_length(NEW.rates) > 32
BEGIN SELECT RAISE(ABORT, 'published price identity and rate count require original 085 shape'); END;
CREATE TRIGGER usage_meter_activations_released_shape BEFORE INSERT ON usage_meter_activations
  WHEN NEW.meter NOT GLOB '[a-z]*' OR NEW.meter GLOB '*[^a-z0-9_.-]*'
BEGIN SELECT RAISE(ABORT, 'meter requires original 087 grammar'); END;
CREATE TRIGGER usage_sources_released_kind BEFORE INSERT ON usage_sources
  WHEN length(NEW.source_kind) > 64 OR NEW.source_kind NOT GLOB '[a-z]*' OR NEW.source_kind GLOB '*[^a-z0-9_.-]*'
BEGIN SELECT RAISE(ABORT, 'source kind requires original 085 grammar'); END;
CREATE TRIGGER usage_valuations_released_kind BEFORE INSERT ON usage_valuations
  WHEN length(NEW.source_kind) > 64 OR NEW.source_kind NOT GLOB '[a-z]*' OR NEW.source_kind GLOB '*[^a-z0-9_.-]*'
BEGIN SELECT RAISE(ABORT, 'source kind requires original 085 grammar'); END;
