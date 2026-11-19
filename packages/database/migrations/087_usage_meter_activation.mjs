export function up(pgm) {
  pgm.sql(`CREATE TABLE usage_meter_activations (
    meter text PRIMARY KEY CHECK(meter ~ '^[a-z][a-z0-9_.-]{0,127}$'),
    rate_card_id text NOT NULL REFERENCES published_credit_rate_cards(rate_card_id),
    starts_at timestamptz NOT NULL,
    activated_at timestamptz NOT NULL CHECK(activated_at<=starts_at)
  );
  CREATE TRIGGER usage_meter_activation_append_only BEFORE UPDATE OR DELETE ON usage_meter_activations
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM usage_meter_activations) THEN
    RAISE EXCEPTION 'Meter activation history must be retained'; END IF; END $$;`);
  pgm.dropTable("usage_meter_activations");
}
