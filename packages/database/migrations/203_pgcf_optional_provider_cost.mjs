/** PGCF retail pricing is independent of unallocated node costs. Existing values stay unchanged. */
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE organization_credit_resolutions ALTER COLUMN provider_cost_micros DROP NOT NULL;
    ALTER TABLE organization_credit_resolutions ADD CONSTRAINT credit_resolution_optional_cost
      CHECK(provider_cost_micros IS NOT NULL OR (meter='pgcf.memory.active' AND unit='memory_mib_milliseconds' AND outcome IN ('settled','corrected')));
    ALTER TABLE usage_credit_valuations ALTER COLUMN target_provider_cost_micros DROP NOT NULL;
    ALTER TABLE usage_credit_valuations ADD CONSTRAINT credit_valuation_optional_cost
      CHECK(target_provider_cost_micros IS NOT NULL OR (source_kind='pgcf' AND rate_card_id='pgcf-memory-2026-10-26-v1'));
    ALTER TABLE credit_source_heads ALTER COLUMN target_provider_cost_micros DROP NOT NULL;
    ALTER TABLE credit_source_heads ADD CONSTRAINT credit_source_optional_cost
      CHECK(target_provider_cost_micros IS NOT NULL OR (source_kind='pgcf' AND meter='pgcf.memory.active'));
    CREATE TABLE pgcf_node_cost_facts (
      fact_id text PRIMARY KEY CHECK(length(fact_id) BETWEEN 1 AND 256),
      node_id text NOT NULL CHECK(length(node_id) BETWEEN 1 AND 128),
      period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
      cost_micros bigint NOT NULL CHECK(cost_micros>=0), currency text NOT NULL CHECK(currency='USD'),
      evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 1 AND 256),
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(period_start<period_end)
    );
    CREATE TRIGGER pgcf_node_cost_facts_append_only BEFORE UPDATE OR DELETE ON pgcf_node_cost_facts
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    -- Production default privileges grant new tables to control_runtime. Invoice evidence is
    -- operator-written only; reset those inherited grants as well as PUBLIC explicitly.
    REVOKE ALL ON pgcf_node_cost_facts FROM PUBLIC;
    DO $$ DECLARE runtime_role text; BEGIN
      FOR runtime_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('control_runtime','metering_runtime') LOOP
        EXECUTE format('REVOKE ALL ON TABLE pgcf_node_cost_facts FROM %I',runtime_role);
        EXECUTE format('GRANT SELECT ON TABLE pgcf_node_cost_facts TO %I',runtime_role);
      END LOOP;
    END $$;
  `);
  pgm.sql(`DO $install$ BEGIN EXECUTE replace($definition$
    CREATE OR REPLACE FUNCTION @S@.credit_source_contribute_valuation(
      p_source_kind text, p_source_reference text, p_valuation_id text, p_marked boolean,
      p_create_state text, p_generation text
    ) RETURNS text
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
    DECLARE
      v_inserted bigint;
      v_val record;
      v_head record;
      v_event timestamptz;
      v_differs boolean;
      v_take boolean;
    BEGIN
      SELECT v.target_quantity, v.target_charge_micros, v.target_provider_cost_micros, v.rate_card_id,
          v.observed_at, r.organization_id, r.project_id, r.environment_id, r.billing_epoch_id,
          x.reservation_id AS resolution_id, x.meter, x.unit, x.event_time
        INTO v_val
        FROM @S@.usage_credit_valuations v
        JOIN @S@.organization_credit_reservations r ON r.reservation_id = v.valuation_id
        LEFT JOIN @S@.organization_credit_resolutions x ON x.reservation_id = v.valuation_id
        WHERE v.valuation_id = p_valuation_id AND v.source_kind = p_source_kind
          AND v.source_reference = p_source_reference;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'credit_source_source_missing' USING ERRCODE = '55000';
      END IF;
      IF v_val.resolution_id IS NULL THEN
        RETURN 'resolution_missing';
      END IF;
      IF p_marked THEN
        INSERT INTO @S@.credit_source_build_applied(source_kind, source_reference, marker_kind, marker_key)
        VALUES (p_source_kind, p_source_reference, 'valuation', p_valuation_id)
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
          RETURN 'duplicate';
        END IF;
      END IF;

      SELECT h.organization_id, h.project_id, h.environment_id, h.billing_epoch_id, h.meter, h.unit,
          h.event_time, h.latest_valuation_id, h.latest_observed_at, h.latest_rate_card_id,
          h.target_quantity, h.target_charge_micros, h.target_provider_cost_micros,
          h.latest_tie_ambiguous
        INTO v_head
        FROM @S@.credit_source_heads h
        WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference FOR UPDATE;
      IF NOT FOUND THEN
        IF p_create_state IS NULL THEN
          RAISE EXCEPTION 'credit_source_unavailable' USING ERRCODE = '55000';
        END IF;
        INSERT INTO @S@.credit_source_heads(source_kind, source_reference, state, organization_id,
          project_id, environment_id, billing_epoch_id, meter, unit, event_time, latest_valuation_id,
          latest_observed_at, latest_rate_card_id, target_quantity, target_charge_micros,
          target_provider_cost_micros, build_generation)
        VALUES (p_source_kind, p_source_reference, p_create_state, v_val.organization_id,
          v_val.project_id, v_val.environment_id, v_val.billing_epoch_id, v_val.meter, v_val.unit,
          v_val.event_time, p_valuation_id, v_val.observed_at, v_val.rate_card_id,
          v_val.target_quantity, v_val.target_charge_micros, v_val.target_provider_cost_micros,
          p_generation);
        RETURN 'applied';
      END IF;

      IF v_head.organization_id <> v_val.organization_id THEN
        RETURN 'organization_conflict';
      END IF;
      -- Exactly the old per-row checks; the event time at the driver's millisecond resolution.
      IF v_head.project_id <> v_val.project_id
        OR v_head.environment_id IS DISTINCT FROM v_val.environment_id
        OR v_head.billing_epoch_id <> v_val.billing_epoch_id
        OR v_head.meter <> v_val.meter OR v_head.unit <> v_val.unit
        OR pg_catalog.date_trunc('milliseconds', v_head.event_time)
          <> pg_catalog.date_trunc('milliseconds', v_val.event_time) THEN
        RETURN 'scope_conflict';
      END IF;

      v_event := least(v_head.event_time, v_val.event_time);
      IF v_val.observed_at > v_head.latest_observed_at THEN
        UPDATE @S@.credit_source_heads h
          SET event_time = v_event, latest_valuation_id = p_valuation_id,
            latest_observed_at = v_val.observed_at, latest_rate_card_id = v_val.rate_card_id,
            target_quantity = v_val.target_quantity, target_charge_micros = v_val.target_charge_micros,
            target_provider_cost_micros = v_val.target_provider_cost_micros,
            latest_tie_ambiguous = false, revision = h.revision + 1
          WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference;
      ELSIF v_val.observed_at = v_head.latest_observed_at THEN
        v_differs := v_head.latest_rate_card_id <> v_val.rate_card_id
          OR v_head.target_quantity <> v_val.target_quantity
          OR v_head.target_charge_micros <> v_val.target_charge_micros
          OR v_head.target_provider_cost_micros IS DISTINCT FROM v_val.target_provider_cost_micros;
        v_take := p_valuation_id > v_head.latest_valuation_id;
        IF v_differs OR v_take OR v_event <> v_head.event_time THEN
          UPDATE @S@.credit_source_heads h
            SET event_time = v_event,
              latest_valuation_id = CASE WHEN v_take THEN p_valuation_id ELSE h.latest_valuation_id END,
              latest_rate_card_id = CASE WHEN v_take THEN v_val.rate_card_id ELSE h.latest_rate_card_id END,
              target_quantity = CASE WHEN v_take THEN v_val.target_quantity ELSE h.target_quantity END,
              target_charge_micros = CASE WHEN v_take THEN v_val.target_charge_micros
                ELSE h.target_charge_micros END,
              target_provider_cost_micros = CASE WHEN v_take THEN v_val.target_provider_cost_micros
                ELSE h.target_provider_cost_micros END,
              latest_tie_ambiguous = h.latest_tie_ambiguous OR v_differs, revision = h.revision + 1
            WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference;
        END IF;
      ELSIF v_event <> v_head.event_time THEN
        UPDATE @S@.credit_source_heads h SET event_time = v_event, revision = h.revision + 1
          WHERE h.source_kind = p_source_kind AND h.source_reference = p_source_reference;
      END IF;
      RETURN 'applied';
    END
    $body$;
  $definition$, '@S@', quote_ident(current_schema())); END $install$;`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM usage_credit_valuations WHERE target_provider_cost_micros IS NULL)
      OR EXISTS(SELECT 1 FROM organization_credit_resolutions WHERE provider_cost_micros IS NULL)
      OR EXISTS(SELECT 1 FROM credit_source_heads WHERE target_provider_cost_micros IS NULL)
      OR EXISTS(SELECT 1 FROM pgcf_node_cost_facts)
    THEN RAISE EXCEPTION 'PGCF financial facts must be retained'; END IF;
  END $$;
  DROP TABLE pgcf_node_cost_facts;
  ALTER TABLE credit_source_heads DROP CONSTRAINT credit_source_optional_cost, ALTER COLUMN target_provider_cost_micros SET NOT NULL;
  ALTER TABLE usage_credit_valuations DROP CONSTRAINT credit_valuation_optional_cost, ALTER COLUMN target_provider_cost_micros SET NOT NULL;
  ALTER TABLE organization_credit_resolutions DROP CONSTRAINT credit_resolution_optional_cost, ALTER COLUMN provider_cost_micros SET NOT NULL;`);
}
