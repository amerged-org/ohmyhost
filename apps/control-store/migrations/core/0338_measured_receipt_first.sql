-- The measured original reservation must be visible before its wallet/hold projection rows are written. Projection
-- sources can then classify ordinary facts by the ORIGINAL receipt presence, including ordinary holds whose kind
-- happens to be 'metered_usage'. Both physical representations share one global identity, never a second debit.
-- Retain legacy/import hold-first admission, and permit header-first ONLY for the identical measured reservation.
DROP TRIGGER credit_holds_global_reservation;
CREATE TRIGGER credit_holds_global_reservation AFTER INSERT ON credit_holds
BEGIN
  INSERT INTO financial_reservation_identities
    SELECT NEW.hold_id,NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.billing_epoch_id,
      NEW.kind,NEW.source_reference,NEW.amount_micros,NEW.created_at
    WHERE NOT EXISTS(SELECT 1 FROM measured_credit_reservations r
      WHERE r.reservation_id=NEW.hold_id AND r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id
        AND r.environment_id IS NEW.environment_id AND r.billing_epoch_id=NEW.billing_epoch_id
        AND r.kind=NEW.kind AND r.source_reference=NEW.source_reference AND r.amount_micros=NEW.amount_micros
        AND r.reserved_at=NEW.created_at);
  SELECT RAISE(ABORT,'CHECK constraint failed: guard_attribution_conflict')
    WHERE NOT EXISTS(SELECT 1 FROM financial_reservation_identities i
      WHERE i.reservation_id=NEW.hold_id AND i.organization_id=NEW.organization_id AND i.project_id=NEW.project_id
        AND i.environment_id IS NEW.environment_id AND i.billing_epoch_id=NEW.billing_epoch_id AND i.kind=NEW.kind
        AND i.source_reference=NEW.source_reference AND i.amount_micros=NEW.amount_micros AND i.reserved_at=NEW.created_at);
END;
