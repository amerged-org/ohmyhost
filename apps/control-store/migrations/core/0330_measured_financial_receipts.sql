-- Lossless compatibility with the released measured ledger (081, 085, 204/205). These are immutable original
-- reservation / resolution / movement facts, not a second wallet. A correction has a zero reservation and a signed
-- resolution even when rounding makes its monetary delta zero. Formats 19/20 read these exact facts and microseconds.
CREATE TABLE financial_reservation_identities (
  reservation_id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT,
  billing_epoch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  reserved_at TEXT NOT NULL,
  UNIQUE (kind, source_reference)
) STRICT, WITHOUT ROWID;
INSERT INTO financial_reservation_identities
  SELECT hold_id, organization_id, project_id, environment_id, billing_epoch_id, kind, source_reference,
    amount_micros, created_at FROM credit_holds;
CREATE TRIGGER credit_holds_global_reservation AFTER INSERT ON credit_holds
BEGIN
  INSERT INTO financial_reservation_identities
    VALUES (NEW.hold_id, NEW.organization_id, NEW.project_id, NEW.environment_id, NEW.billing_epoch_id,
      NEW.kind, NEW.source_reference, NEW.amount_micros, NEW.created_at);
END;

CREATE TABLE measured_credit_reservations (
  reservation_id TEXT NOT NULL PRIMARY KEY CHECK (length(reservation_id) = 26),
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id),
  project_id TEXT NOT NULL,
  environment_id TEXT,
  billing_epoch_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'metered_usage'),
  source_reference TEXT NOT NULL CHECK (length(source_reference) = 64 AND source_reference NOT GLOB '*[^0-9a-f]*'),
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  reserved_at TEXT NOT NULL CHECK (reserved_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE (organization_id, reservation_id),
  UNIQUE (kind, source_reference),
  FOREIGN KEY (organization_id, billing_epoch_id) REFERENCES billing_epochs (organization_id, billing_epoch_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES billing_environment_scopes (organization_id, environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER measured_credit_reservations_global_identity AFTER INSERT ON measured_credit_reservations
BEGIN
  INSERT INTO financial_reservation_identities
    SELECT NEW.reservation_id, NEW.organization_id, NEW.project_id, NEW.environment_id, NEW.billing_epoch_id,
      NEW.kind, NEW.source_reference, NEW.amount_micros, NEW.reserved_at
    WHERE NOT EXISTS (SELECT 1 FROM financial_reservation_identities WHERE reservation_id = NEW.reservation_id);
  SELECT RAISE(ABORT, 'CHECK constraint failed: guard_attribution_conflict')
    WHERE NOT EXISTS (SELECT 1 FROM financial_reservation_identities
      WHERE reservation_id = NEW.reservation_id AND organization_id = NEW.organization_id
        AND project_id = NEW.project_id AND environment_id IS NEW.environment_id AND billing_epoch_id = NEW.billing_epoch_id
        AND kind = NEW.kind AND source_reference = NEW.source_reference AND amount_micros = NEW.amount_micros
        AND reserved_at = NEW.reserved_at);
END;

CREATE TABLE measured_credit_resolutions (
  reservation_id TEXT NOT NULL PRIMARY KEY REFERENCES measured_credit_reservations (reservation_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('settled', 'corrected')),
  charge_micros INTEGER NOT NULL,
  funded_micros INTEGER NOT NULL,
  provider_cost_micros INTEGER,
  rate_card_id TEXT NOT NULL REFERENCES published_credit_rate_cards (rate_card_id),
  meter TEXT NOT NULL CHECK (length(meter) BETWEEN 1 AND 128),
  unit TEXT NOT NULL CHECK (length(unit) BETWEEN 1 AND 64),
  quantity INTEGER NOT NULL,
  event_time TEXT NOT NULL CHECK (event_time GLOB '????-??-??T??:??:??.??????Z'),
  resolved_at TEXT NOT NULL CHECK (resolved_at GLOB '????-??-??T??:??:??.??????Z'),
  CHECK ((outcome = 'settled' AND charge_micros >= 0 AND funded_micros BETWEEN 0 AND charge_micros
      AND (provider_cost_micros IS NULL OR provider_cost_micros >= 0) AND quantity >= 0)
    OR (outcome = 'corrected' AND charge_micros <= 0 AND funded_micros BETWEEN charge_micros AND 0
      AND (provider_cost_micros IS NULL OR provider_cost_micros <= 0) AND quantity <= 0)),
  CHECK (provider_cost_micros IS NOT NULL OR meter = 'pgcf.memory.active')
) STRICT, WITHOUT ROWID;

CREATE TABLE measured_credit_movements (
  organization_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('resolve', 'correction')),
  reserved_micros INTEGER NOT NULL CHECK (reserved_micros = 0),
  spent_micros INTEGER NOT NULL,
  PRIMARY KEY (reservation_id, grant_id, phase),
  FOREIGN KEY (organization_id, reservation_id) REFERENCES measured_credit_reservations (organization_id, reservation_id),
  FOREIGN KEY (organization_id, grant_id) REFERENCES credit_lots (organization_id, grant_id),
  CHECK ((phase = 'resolve' AND spent_micros > 0) OR (phase = 'correction' AND spent_micros < 0))
) STRICT, WITHOUT ROWID;

-- A valuation cannot authorize completion without its complete original receipt. The summed movements are signed
-- and bounded by one resolution's int8 funded amount; they never sum platform-wide balances.
CREATE TRIGGER usage_valuations_require_financial_receipt BEFORE INSERT ON usage_valuations
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: guard_attribution_conflict')
    WHERE NOT EXISTS (
      SELECT 1 FROM measured_credit_reservations r
      JOIN measured_credit_resolutions x ON x.reservation_id = r.reservation_id
      JOIN usage_sources s ON s.source_kind = NEW.source_kind AND s.source_reference = NEW.source_reference
      WHERE r.reservation_id = NEW.valuation_id AND r.organization_id = NEW.organization_id
        AND r.project_id = s.project_id AND r.environment_id IS s.environment_id
        AND r.billing_epoch_id = s.billing_epoch_id AND r.organization_id = s.organization_id
        AND x.outcome = NEW.outcome AND x.rate_card_id = NEW.rate_card_id
        AND x.meter = s.meter AND x.unit = s.unit AND x.event_time = s.event_time
        AND x.resolved_at = NEW.posted_at AND x.quantity = NEW.quantity_delta
        AND x.charge_micros = NEW.charge_delta_micros AND x.funded_micros = NEW.funded_delta_micros
        AND x.funded_micros = COALESCE((SELECT sum(m.spent_micros) FROM measured_credit_movements m
          WHERE m.reservation_id = r.reservation_id), 0));
END;

CREATE TRIGGER financial_reservation_identities_no_update BEFORE UPDATE ON financial_reservation_identities
BEGIN SELECT RAISE(ABORT, 'financial reservation identity is immutable'); END;
CREATE TRIGGER financial_reservation_identities_no_delete BEFORE DELETE ON financial_reservation_identities
BEGIN SELECT RAISE(ABORT, 'financial reservation identity is retained'); END;
CREATE TRIGGER measured_credit_reservations_no_update BEFORE UPDATE ON measured_credit_reservations
BEGIN SELECT RAISE(ABORT, 'measured reservation is immutable'); END;
CREATE TRIGGER measured_credit_reservations_no_delete BEFORE DELETE ON measured_credit_reservations
BEGIN SELECT RAISE(ABORT, 'measured reservation is retained'); END;
CREATE TRIGGER measured_credit_resolutions_no_update BEFORE UPDATE ON measured_credit_resolutions
BEGIN SELECT RAISE(ABORT, 'measured resolution is immutable'); END;
CREATE TRIGGER measured_credit_resolutions_no_delete BEFORE DELETE ON measured_credit_resolutions
BEGIN SELECT RAISE(ABORT, 'measured resolution is retained'); END;
CREATE TRIGGER measured_credit_movements_no_update BEFORE UPDATE ON measured_credit_movements
BEGIN SELECT RAISE(ABORT, 'measured movement is immutable'); END;
CREATE TRIGGER measured_credit_movements_no_delete BEFORE DELETE ON measured_credit_movements
BEGIN SELECT RAISE(ABORT, 'measured movement is retained'); END;
