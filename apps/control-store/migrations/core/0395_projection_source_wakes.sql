-- Original append-source projection maintenance, with0338 measured header-before-body ordering.
-- Empty wallet existence matches original182's mapping trigger; it contains no credit or effect.
INSERT INTO credit_wallets(organization_id,version,created_at,updated_at) SELECT organization_id,0,created_at,created_at FROM organizations WHERE true ON CONFLICT DO NOTHING;
CREATE TRIGGER organizations_projection_wallet AFTER INSERT ON organizations BEGIN INSERT INTO credit_wallets(organization_id,version,created_at,updated_at) VALUES(NEW.organization_id,0,NEW.created_at,NEW.created_at) ON CONFLICT DO NOTHING; END;
CREATE TRIGGER credit_lots_projection_apply AFTER INSERT ON credit_lots BEGIN
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'wallet',NEW.organization_id,active_generation,'grant',NEW.grant_id,0 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'wallet',NEW.organization_id,building_generation,'grant',NEW.grant_id,1 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND building_generation IS NOT NULL AND 1;
END;
CREATE TRIGGER credit_holds_projection_reservation AFTER INSERT ON credit_holds WHEN NOT EXISTS(SELECT 1 FROM measured_credit_reservations m WHERE m.reservation_id=NEW.hold_id) BEGIN
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'wallet',NEW.organization_id,active_generation,'reservation',NEW.hold_id,0 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'wallet',NEW.organization_id,building_generation,'reservation',NEW.hold_id,1 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND building_generation IS NOT NULL AND 1;
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'reporting',NEW.organization_id,active_generation,'reservation',NEW.hold_id,0 FROM credit_usage_reporting_state WHERE organization_id=NEW.organization_id AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'reporting',NEW.organization_id,building_generation,'reservation',NEW.hold_id,1 FROM credit_usage_reporting_state WHERE organization_id=NEW.organization_id AND building_generation IS NOT NULL AND 1;
END;
CREATE TRIGGER measured_reservations_projection_apply AFTER INSERT ON measured_credit_reservations BEGIN
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'wallet',NEW.organization_id,active_generation,'reservation',NEW.reservation_id,0 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'wallet',NEW.organization_id,building_generation,'reservation',NEW.reservation_id,1 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND building_generation IS NOT NULL AND 1;
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'reporting',NEW.organization_id,active_generation,'reservation',NEW.reservation_id,0 FROM credit_usage_reporting_state WHERE organization_id=NEW.organization_id AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'reporting',NEW.organization_id,building_generation,'reservation',NEW.reservation_id,1 FROM credit_usage_reporting_state WHERE organization_id=NEW.organization_id AND building_generation IS NOT NULL AND 1;
END;
CREATE TRIGGER credit_holds_projection_resolution AFTER UPDATE ON credit_holds WHEN OLD.state='open' AND NEW.state<>'open' AND NOT EXISTS(SELECT 1 FROM measured_credit_reservations m WHERE m.reservation_id=NEW.hold_id) BEGIN
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'wallet',NEW.organization_id,active_generation,'resolution',NEW.hold_id,0 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'wallet',NEW.organization_id,building_generation,'resolution',NEW.hold_id,1 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND building_generation IS NOT NULL AND 1;
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'reporting',NEW.organization_id,active_generation,'resolution',NEW.hold_id,0 FROM credit_usage_reporting_state WHERE organization_id=NEW.organization_id AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'reporting',NEW.organization_id,building_generation,'resolution',NEW.hold_id,1 FROM credit_usage_reporting_state WHERE organization_id=NEW.organization_id AND building_generation IS NOT NULL AND 1;
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'wallet',NEW.organization_id,s.active_generation,'movement',m.reservation_id||':'||m.grant_id||':'||m.phase,0 FROM metering_projection_movements m JOIN credit_projection_state s ON s.organization_id=m.organization_id WHERE m.organization_id=NEW.organization_id AND m.reservation_id=NEW.hold_id AND m.phase='resolve' AND s.active_generation IS NOT NULL UNION ALL SELECT 'wallet',NEW.organization_id,s.building_generation,'movement',m.reservation_id||':'||m.grant_id||':'||m.phase,1 FROM metering_projection_movements m JOIN credit_projection_state s ON s.organization_id=m.organization_id WHERE m.organization_id=NEW.organization_id AND m.reservation_id=NEW.hold_id AND m.phase='resolve' AND s.building_generation IS NOT NULL;
END;
CREATE TRIGGER measured_resolutions_projection_apply AFTER INSERT ON measured_credit_resolutions BEGIN
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'wallet',(SELECT organization_id FROM metering_projection_reservations WHERE reservation_id=NEW.reservation_id),active_generation,'resolution',NEW.reservation_id,0 FROM credit_projection_state WHERE organization_id=(SELECT organization_id FROM metering_projection_reservations WHERE reservation_id=NEW.reservation_id) AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'wallet',(SELECT organization_id FROM metering_projection_reservations WHERE reservation_id=NEW.reservation_id),building_generation,'resolution',NEW.reservation_id,1 FROM credit_projection_state WHERE organization_id=(SELECT organization_id FROM metering_projection_reservations WHERE reservation_id=NEW.reservation_id) AND building_generation IS NOT NULL AND 1;
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'reporting',(SELECT organization_id FROM metering_projection_reservations WHERE reservation_id=NEW.reservation_id),active_generation,'resolution',NEW.reservation_id,0 FROM credit_usage_reporting_state WHERE organization_id=(SELECT organization_id FROM metering_projection_reservations WHERE reservation_id=NEW.reservation_id) AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'reporting',(SELECT organization_id FROM metering_projection_reservations WHERE reservation_id=NEW.reservation_id),building_generation,'resolution',NEW.reservation_id,1 FROM credit_usage_reporting_state WHERE organization_id=(SELECT organization_id FROM metering_projection_reservations WHERE reservation_id=NEW.reservation_id) AND building_generation IS NOT NULL AND 1;
END;
CREATE TRIGGER credit_hold_lots_projection_reserve AFTER INSERT ON credit_hold_lots WHEN NEW.held_micros>0 AND NOT EXISTS(SELECT 1 FROM measured_credit_reservations m WHERE m.reservation_id=NEW.hold_id) BEGIN
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'wallet',NEW.organization_id,active_generation,'movement',NEW.hold_id||':'||NEW.grant_id||':reserve',0 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'wallet',NEW.organization_id,building_generation,'movement',NEW.hold_id||':'||NEW.grant_id||':reserve',1 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND building_generation IS NOT NULL AND 1;
END;
CREATE TRIGGER measured_movements_projection_apply AFTER INSERT ON measured_credit_movements BEGIN
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked) SELECT 'wallet',NEW.organization_id,active_generation,'movement',NEW.reservation_id||':'||NEW.grant_id||':'||NEW.phase,0 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND active_generation IS NOT NULL AND 1 UNION ALL SELECT 'wallet',NEW.organization_id,building_generation,'movement',NEW.reservation_id||':'||NEW.grant_id||':'||NEW.phase,1 FROM credit_projection_state WHERE organization_id=NEW.organization_id AND building_generation IS NOT NULL AND 1;
END;
CREATE TRIGGER credit_lots_expiry_insert AFTER INSERT ON credit_lots BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id;
END;
CREATE TRIGGER credit_lots_expiry_update AFTER UPDATE ON credit_lots WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.grant_id IS NOT NEW.grant_id OR OLD.kind IS NOT NEW.kind OR OLD.source_reference IS NOT NEW.source_reference OR OLD.granted_at IS NOT NEW.granted_at OR OLD.expires_at IS NOT NEW.expires_at BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id IN(OLD.organization_id,NEW.organization_id);
END;
CREATE TRIGGER credit_lots_expiry_delete AFTER DELETE ON credit_lots BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id;
END;
CREATE TRIGGER credit_lot_adjustments_expiry_insert AFTER INSERT ON credit_lot_adjustments BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id;
END;
CREATE TRIGGER credit_lot_adjustments_expiry_update AFTER UPDATE ON credit_lot_adjustments WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.grant_id IS NOT NEW.grant_id OR OLD.amount_micros IS NOT NEW.amount_micros OR OLD.occurred_at IS NOT NEW.occurred_at BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id IN(OLD.organization_id,NEW.organization_id);
END;
CREATE TRIGGER credit_lot_adjustments_expiry_delete AFTER DELETE ON credit_lot_adjustments BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id;
END;
CREATE TRIGGER credit_lot_expirations_expiry_insert AFTER INSERT ON credit_lot_expirations BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id;
END;
CREATE TRIGGER credit_lot_expirations_expiry_update AFTER UPDATE ON credit_lot_expirations WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.grant_id IS NOT NEW.grant_id OR OLD.expires_at IS NOT NEW.expires_at BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id IN(OLD.organization_id,NEW.organization_id);
END;
CREATE TRIGGER credit_lot_expirations_expiry_delete AFTER DELETE ON credit_lot_expirations BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id;
END;
CREATE TRIGGER stripe_credit_payments_expiry_insert AFTER INSERT ON stripe_credit_payments BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id;
END;
CREATE TRIGGER stripe_credit_payments_expiry_update AFTER UPDATE ON stripe_credit_payments WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.grant_id IS NOT NEW.grant_id OR OLD.offer IS NOT NEW.offer OR OLD.account_id IS NOT NEW.account_id OR OLD.mode IS NOT NEW.mode OR OLD.subscription_id IS NOT NEW.subscription_id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.period_start IS NOT NEW.period_start OR OLD.period_end IS NOT NEW.period_end OR OLD.paid_at IS NOT NEW.paid_at OR OLD.confirmed_at IS NOT NEW.confirmed_at OR OLD.credited_micros IS NOT NEW.credited_micros OR OLD.checkout_id IS NOT NEW.checkout_id BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id IN(OLD.organization_id,NEW.organization_id);
END;
CREATE TRIGGER stripe_credit_payments_expiry_delete AFTER DELETE ON stripe_credit_payments BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id;
END;
CREATE TRIGGER credit_subscription_ends_expiry_insert AFTER INSERT ON credit_subscription_ends BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id;
END;
CREATE TRIGGER credit_subscription_ends_expiry_update AFTER UPDATE ON credit_subscription_ends WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.account_id IS NOT NEW.account_id OR OLD.mode IS NOT NEW.mode OR OLD.subscription_id IS NOT NEW.subscription_id OR OLD.ended_at IS NOT NEW.ended_at BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id IN(OLD.organization_id,NEW.organization_id);
END;
CREATE TRIGGER credit_subscription_ends_expiry_delete AFTER DELETE ON credit_subscription_ends BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id;
END;
CREATE TRIGGER credit_paid_access_events_expiry_insert AFTER INSERT ON credit_paid_access_events BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id;
END;
CREATE TRIGGER credit_paid_access_events_expiry_update AFTER UPDATE ON credit_paid_access_events WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.event_id IS NOT NEW.event_id OR OLD.occurred_at IS NOT NEW.occurred_at OR OLD.enabled IS NOT NEW.enabled OR OLD.paid_until IS NOT NEW.paid_until BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id IN(OLD.organization_id,NEW.organization_id);
END;
CREATE TRIGGER credit_paid_access_events_expiry_delete AFTER DELETE ON credit_paid_access_events BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id;
END;
CREATE TRIGGER credit_paid_access_expiry_insert AFTER INSERT ON credit_paid_access BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id;
END;
CREATE TRIGGER credit_paid_access_expiry_update AFTER UPDATE ON credit_paid_access WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.enabled IS NOT NEW.enabled OR OLD.updated_at IS NOT NEW.updated_at OR OLD.paid_until IS NOT NEW.paid_until BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id IN(OLD.organization_id,NEW.organization_id);
END;
CREATE TRIGGER credit_paid_access_expiry_delete AFTER DELETE ON credit_paid_access BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id;
END;
CREATE TRIGGER stripe_checkout_requests_expiry_insert AFTER INSERT ON stripe_checkout_requests BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id;
END;
CREATE TRIGGER stripe_checkout_requests_expiry_update AFTER UPDATE ON stripe_checkout_requests WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.checkout_id IS NOT NEW.checkout_id OR OLD.created_at IS NOT NEW.created_at BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id IN(OLD.organization_id,NEW.organization_id);
END;
CREATE TRIGGER stripe_checkout_requests_expiry_delete AFTER DELETE ON stripe_checkout_requests BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id;
END;
CREATE TRIGGER stripe_recharge_attempts_expiry_insert AFTER INSERT ON stripe_recharge_attempts BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id;
END;
CREATE TRIGGER stripe_recharge_attempts_expiry_update AFTER UPDATE ON stripe_recharge_attempts WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.grant_id IS NOT NEW.grant_id OR OLD.created_at IS NOT NEW.created_at BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=NEW.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id IN(OLD.organization_id,NEW.organization_id);
END;
CREATE TRIGGER stripe_recharge_attempts_expiry_delete AFTER DELETE ON stripe_recharge_attempts BEGIN
  SELECT RAISE(ABORT,'credit_expiry_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_expiry_state WHERE organization_id=OLD.organization_id);
  UPDATE credit_expiry_state SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id;
END;
CREATE TRIGGER usage_valuations_source_projection AFTER INSERT ON usage_valuations BEGIN
  SELECT RAISE(ABORT,'credit_source_unavailable') WHERE NOT EXISTS(SELECT 1 FROM credit_source_custody WHERE singleton=1);
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked,source_reference,resource_kind) SELECT 'source',NEW.organization_id,(SELECT generation FROM credit_source_builds WHERE source_kind=NEW.source_kind AND source_reference=NEW.source_reference),'valuation',NEW.valuation_id,(NOT EXISTS(SELECT 1 FROM credit_source_heads h WHERE h.source_kind=NEW.source_kind AND h.source_reference=NEW.source_reference AND h.state='ready') AND EXISTS(SELECT 1 FROM credit_source_builds b WHERE b.source_kind=NEW.source_kind AND b.source_reference=NEW.source_reference AND b.status='building')),NEW.source_reference,NEW.source_kind WHERE EXISTS(SELECT 1 FROM credit_source_heads h WHERE h.source_kind=NEW.source_kind AND h.source_reference=NEW.source_reference AND h.state='ready') OR EXISTS(SELECT 1 FROM credit_source_builds b WHERE b.source_kind=NEW.source_kind AND b.source_reference=NEW.source_reference AND b.status='building') OR (NOT EXISTS(SELECT 1 FROM credit_source_heads h WHERE h.source_kind=NEW.source_kind AND h.source_reference=NEW.source_reference) AND NOT EXISTS(SELECT 1 FROM credit_source_builds b WHERE b.source_kind=NEW.source_kind AND b.source_reference=NEW.source_reference) AND EXISTS(SELECT 1 FROM credit_source_custody WHERE singleton=1 AND mode='hot_only') AND NOT EXISTS(SELECT 1 FROM usage_valuations v WHERE v.source_kind=NEW.source_kind AND v.source_reference=NEW.source_reference AND v.valuation_id<>NEW.valuation_id));
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked,source_reference,resource_kind) SELECT 'source',NEW.organization_id,(SELECT generation FROM credit_source_builds WHERE source_kind=NEW.source_kind AND source_reference=NEW.source_reference),'movement',m.reservation_id||':'||m.grant_id||':'||m.phase,(NOT EXISTS(SELECT 1 FROM credit_source_heads h WHERE h.source_kind=NEW.source_kind AND h.source_reference=NEW.source_reference AND h.state='ready') AND EXISTS(SELECT 1 FROM credit_source_builds b WHERE b.source_kind=NEW.source_kind AND b.source_reference=NEW.source_reference AND b.status='building')),NEW.source_reference,NEW.source_kind FROM metering_projection_movements m WHERE m.organization_id=NEW.organization_id AND m.reservation_id=NEW.valuation_id AND m.spent_micros<>0 AND (EXISTS(SELECT 1 FROM credit_source_heads h WHERE h.source_kind=NEW.source_kind AND h.source_reference=NEW.source_reference AND h.state='ready') OR EXISTS(SELECT 1 FROM credit_source_builds b WHERE b.source_kind=NEW.source_kind AND b.source_reference=NEW.source_reference AND b.status='building') OR (NOT EXISTS(SELECT 1 FROM credit_source_heads h WHERE h.source_kind=NEW.source_kind AND h.source_reference=NEW.source_reference) AND NOT EXISTS(SELECT 1 FROM credit_source_builds b WHERE b.source_kind=NEW.source_kind AND b.source_reference=NEW.source_reference) AND EXISTS(SELECT 1 FROM credit_source_custody WHERE singleton=1 AND mode='hot_only') AND NOT EXISTS(SELECT 1 FROM usage_valuations v WHERE v.source_kind=NEW.source_kind AND v.source_reference=NEW.source_reference AND v.valuation_id<>NEW.valuation_id)));
END;
CREATE TRIGGER measured_movements_source_projection AFTER INSERT ON measured_credit_movements WHEN NEW.spent_micros<>0 BEGIN
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked,source_reference,resource_kind) SELECT 'source',NEW.organization_id,b.generation,'valuation',v.valuation_id,1,v.source_reference,v.source_kind FROM usage_valuations v JOIN credit_source_builds b ON b.source_kind=v.source_kind AND b.source_reference=v.source_reference AND b.status='building' WHERE v.valuation_id=NEW.reservation_id AND NOT EXISTS(SELECT 1 FROM credit_source_heads h WHERE h.source_kind=v.source_kind AND h.source_reference=v.source_reference AND h.state='ready');
  INSERT INTO metering_projection_apply(family,organization_id,generation,source_kind,source_key,marked,source_reference,resource_kind) SELECT 'source',NEW.organization_id,b.generation,'movement',NEW.reservation_id||':'||NEW.grant_id||':'||NEW.phase,CASE WHEN h.state='ready' THEN 0 ELSE 1 END,v.source_reference,v.source_kind FROM usage_valuations v LEFT JOIN credit_source_builds b ON b.source_kind=v.source_kind AND b.source_reference=v.source_reference LEFT JOIN credit_source_heads h ON h.source_kind=v.source_kind AND h.source_reference=v.source_reference WHERE v.valuation_id=NEW.reservation_id AND (h.state='ready' OR b.status='building');
END;
