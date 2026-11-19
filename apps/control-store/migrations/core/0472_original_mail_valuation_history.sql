-- Original ordinary Mail accepted receipt can precede a legal later provider-failure correction.
-- Every0462 static request/hold/rate/quantity/allocation and live predicate remains intact.
-- ONLY the latest-head temporal clause recognizes the exact unserved named history family.
DROP TRIGGER core_historical_import_open;
CREATE TRIGGER core_historical_import_open BEFORE INSERT ON core_historical_import
BEGIN
  SELECT RAISE(ABORT,'an ever-activated authority can never open historical import') WHERE EXISTS(SELECT 1 FROM core_authority_activation);
  SELECT RAISE(ABORT,'historical import begins loading, never already qualified')
    WHERE NEW.closed_at IS NOT NULL OR NEW.comparison_sha256 IS NOT NULL OR NEW.restored_runtime_schema_sha256 IS NOT NULL;
  SELECT RAISE(ABORT,'historical temporal admission has a closed exact table allowlist')
    WHERE EXISTS(SELECT 1 FROM json_each(NEW.temporal_tables) WHERE type<>'text' OR value NOT IN (
      'wfp_candidate_receipts','wfp_candidate_cleanup_receipts','wfp_publish_receipts','wfp_rollback_activation_receipts','runtime_secret_delivery_stage_activations','operations','environment_data_assignments','mail_credit_accounts','mail_credit_ledger','project_mail_domain_bindings','usage_valuations'))
      OR (SELECT count(*) FROM json_each(NEW.temporal_tables))<>(SELECT count(DISTINCT value) FROM json_each(NEW.temporal_tables));
END;

DROP TRIGGER usage_valuations_require_financial_receipt;
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
          WHERE m.reservation_id = r.reservation_id), 0)) AND NOT EXISTS (
      SELECT 1 FROM mail_send_requests r
      JOIN credit_holds h ON h.hold_id=r.credit_reservation_id AND h.organization_id=r.organization_id AND h.project_id=r.project_id
      JOIN usage_sources s ON s.source_kind='ses' AND s.source_reference=r.request_id
      WHERE (r.request_id,r.organization_id,NEW.source_kind,NEW.observation_reference,NEW.outcome,r.state,r.credit_meter)
          =(NEW.source_reference,NEW.organization_id,'ses','accepted','settled','accepted','mail.sent')
        AND (h.hold_id,h.kind,h.source_reference,h.amount_micros,h.created_at,h.state,h.charge_micros,
          h.provider_cost_micros,h.rate_card_id,h.meter,h.unit,h.quantity,h.event_time)
          =(NEW.valuation_id,'mail_send',r.request_id,r.credit_charge_micros,r.requested_at,'settled',r.credit_charge_micros,
          r.credit_provider_cost_micros,r.credit_rate_card_id,r.credit_meter,'recipient',1,r.requested_at)
        AND (s.organization_id,s.project_id,s.billing_epoch_id,s.meter,s.unit,s.event_time)
          =(h.organization_id,h.project_id,h.billing_epoch_id,'mail.sent',h.unit,h.event_time)
        AND ((s.latest_valuation_id,s.latest_observed_at,s.latest_rate_card_id,s.target_quantity,s.target_charge_micros,s.target_provider_cost_micros)
          =(NEW.valuation_id,NEW.observed_at,NEW.rate_card_id,1,h.charge_micros,h.provider_cost_micros)
          OR EXISTS(SELECT 1 FROM core_historical_import historical WHERE historical.closed_at IS NULL
            AND EXISTS(SELECT 1 FROM json_each(historical.temporal_tables) WHERE value='usage_valuations')
            AND NOT EXISTS(SELECT 1 FROM core_authority_activation)))
        AND (NEW.rate_card_id,NEW.posted_at,NEW.observed_at,NEW.target_quantity,NEW.quantity_delta,
          NEW.target_charge_micros,NEW.charge_delta_micros,NEW.target_provider_cost_micros,NEW.funded_delta_micros)
          =(h.rate_card_id,h.resolved_at,h.resolved_at,1,1,h.charge_micros,h.charge_micros,h.provider_cost_micros,h.funded_micros)
        AND h.environment_id IS NULL AND s.environment_id IS NULL AND r.provider_started_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM measured_credit_reservations m WHERE m.reservation_id=h.hold_id)
        AND h.funded_micros=COALESCE((SELECT sum(l.spent_micros) FROM credit_hold_lots l
          WHERE l.organization_id=h.organization_id AND l.hold_id=h.hold_id),0));
END;
