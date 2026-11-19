export function up(pgm) {
  pgm.sql(`ALTER TABLE organization_credit_reservations ALTER COLUMN environment_id DROP NOT NULL;
    ALTER TABLE organization_credit_reservations ADD CONSTRAINT credit_reservation_shared_scope
      CHECK(environment_id IS NOT NULL OR kind='metered_usage');
    CREATE TABLE published_credit_rate_cards (
      rate_card_id text PRIMARY KEY CHECK(rate_card_id ~ '^[a-z0-9_.-]{1,128}$'),
      published_at timestamptz NOT NULL,effective_from timestamptz NOT NULL UNIQUE,
      rates jsonb NOT NULL CHECK(jsonb_typeof(rates)='array' AND jsonb_array_length(rates) BETWEEN 1 AND 32),
      CHECK(published_at<=effective_from)
    );
    CREATE TRIGGER published_credit_rate_cards_append_only BEFORE UPDATE OR DELETE ON published_credit_rate_cards
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TABLE usage_credit_valuations (
      valuation_id ulid PRIMARY KEY REFERENCES organization_credit_reservations(reservation_id),
      source_kind text NOT NULL CHECK(source_kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
      source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 1 AND 256),
      observation_reference text NOT NULL CHECK(length(observation_reference) BETWEEN 1 AND 256),
      target_quantity bigint NOT NULL CHECK(target_quantity>=0),
      target_charge_micros bigint NOT NULL CHECK(target_charge_micros>=0),
      target_provider_cost_micros bigint NOT NULL CHECK(target_provider_cost_micros>=0),
      rate_card_id text NOT NULL REFERENCES published_credit_rate_cards(rate_card_id),
      observed_at timestamptz NOT NULL,
      UNIQUE(source_kind,source_reference,observation_reference)
    );
    CREATE TRIGGER usage_credit_valuations_append_only BEFORE UPDATE OR DELETE ON usage_credit_valuations
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    ALTER TABLE organization_credit_resolutions
      DROP CONSTRAINT organization_credit_resolutions_charge_micros_check,
      DROP CONSTRAINT organization_credit_resolutions_check,
      DROP CONSTRAINT organization_credit_resolutions_check1,
      DROP CONSTRAINT organization_credit_resolutions_outcome_check,
      DROP CONSTRAINT organization_credit_resolutions_provider_cost_micros_check,
      DROP CONSTRAINT organization_credit_resolutions_quantity_check;
    ALTER TABLE organization_credit_resolutions ADD CONSTRAINT credit_resolution_shape CHECK(
      (outcome='released' AND charge_micros=0 AND funded_micros=0 AND provider_cost_micros=0 AND rate_card_id IS NULL AND meter IS NULL AND unit IS NULL AND quantity IS NULL AND event_time IS NULL)
      OR (outcome IN ('settled','corrected') AND rate_card_id IS NOT NULL AND meter IS NOT NULL AND unit IS NOT NULL AND quantity IS NOT NULL AND event_time IS NOT NULL
        AND length(rate_card_id) BETWEEN 1 AND 128 AND length(meter) BETWEEN 1 AND 128 AND length(unit) BETWEEN 1 AND 64
        AND ((outcome='settled' AND charge_micros>=0 AND funded_micros BETWEEN 0 AND charge_micros AND provider_cost_micros>=0 AND quantity>=0)
          OR (outcome='corrected' AND charge_micros<=0 AND funded_micros BETWEEN charge_micros AND 0 AND provider_cost_micros<=0 AND quantity<=0))));
    ALTER TABLE organization_credit_movements
      DROP CONSTRAINT organization_credit_movements_check,
      DROP CONSTRAINT organization_credit_movements_phase_check,
      DROP CONSTRAINT organization_credit_movements_spent_micros_check;
    ALTER TABLE organization_credit_movements ADD CONSTRAINT credit_movement_shape CHECK(
      (phase='reserve' AND reserved_micros>0 AND spent_micros=0)
      OR (phase='resolve' AND reserved_micros<=0 AND spent_micros>=0 AND (reserved_micros<0 OR spent_micros>0))
      OR (phase='correction' AND reserved_micros=0 AND spent_micros<0));`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM usage_credit_valuations)
    OR EXISTS(SELECT 1 FROM published_credit_rate_cards) OR EXISTS(SELECT 1 FROM organization_credit_reservations WHERE environment_id IS NULL)
    OR EXISTS(SELECT 1 FROM organization_credit_resolutions WHERE outcome='corrected') THEN
      RAISE EXCEPTION 'Published prices and measured credit history must be retained'; END IF; END $$;
    ALTER TABLE organization_credit_movements DROP CONSTRAINT credit_movement_shape;
    ALTER TABLE organization_credit_movements ADD CONSTRAINT organization_credit_movements_phase_check CHECK(phase IN ('reserve','resolve')),
      ADD CONSTRAINT organization_credit_movements_spent_micros_check CHECK(spent_micros>=0),
      ADD CONSTRAINT organization_credit_movements_check CHECK((phase='reserve' AND reserved_micros>0 AND spent_micros=0) OR (phase='resolve' AND reserved_micros<=0 AND (reserved_micros<0 OR spent_micros>0)));
    ALTER TABLE organization_credit_resolutions DROP CONSTRAINT credit_resolution_shape;
    ALTER TABLE organization_credit_resolutions ADD CONSTRAINT organization_credit_resolutions_outcome_check CHECK(outcome IN ('settled','released')),
      ADD CONSTRAINT organization_credit_resolutions_charge_micros_check CHECK(charge_micros>=0),
      ADD CONSTRAINT organization_credit_resolutions_check CHECK(funded_micros BETWEEN 0 AND charge_micros),
      ADD CONSTRAINT organization_credit_resolutions_provider_cost_micros_check CHECK(provider_cost_micros>=0),
      ADD CONSTRAINT organization_credit_resolutions_quantity_check CHECK(quantity>=0),
      ADD CONSTRAINT organization_credit_resolutions_check1 CHECK((outcome='released' AND charge_micros=0 AND funded_micros=0 AND provider_cost_micros=0 AND rate_card_id IS NULL AND meter IS NULL AND unit IS NULL AND quantity IS NULL AND event_time IS NULL)
        OR (outcome='settled' AND rate_card_id IS NOT NULL AND meter IS NOT NULL AND unit IS NOT NULL AND length(rate_card_id) BETWEEN 1 AND 128 AND length(meter) BETWEEN 1 AND 128 AND length(unit) BETWEEN 1 AND 64 AND quantity IS NOT NULL AND event_time IS NOT NULL));
    ALTER TABLE organization_credit_reservations DROP CONSTRAINT credit_reservation_shared_scope;
    ALTER TABLE organization_credit_reservations ALTER COLUMN environment_id SET NOT NULL;`);
  pgm.dropTable("usage_credit_valuations");
  pgm.dropTable("published_credit_rate_cards");
}
