export function up(pgm) {
  pgm.sql(`CREATE TABLE r2_consumption_observations (
    account_id text NOT NULL CHECK(account_id~'^[0-9a-f]{32}$'),
    bucket_name text NOT NULL REFERENCES project_r2_bucket_receipts(bucket_name),
    jurisdiction text NOT NULL CHECK(jurisdiction IN ('eu','us')),
    timeframe_start timestamptz NOT NULL,
    timeframe_end timestamptz NOT NULL,
    meter text NOT NULL CHECK(meter IN ('r2.storage.standard','r2.storage.observed','r2.class_a','r2.class_b')),
    unit text NOT NULL CHECK(unit IN ('byte_peak_day','request')),
    quantity bigint NOT NULL CHECK(quantity>=0),
    exact boolean NOT NULL,
    project_id ulid NOT NULL REFERENCES projects(project_id),
    organization_id ulid,
    environment_id ulid,
    billing_epoch_id ulid,
    observed_at timestamptz NOT NULL,
    PRIMARY KEY(account_id,bucket_name,jurisdiction,timeframe_start,meter,observed_at),
    FOREIGN KEY(billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
    FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id),
    CHECK((organization_id IS NULL AND billing_epoch_id IS NULL AND environment_id IS NULL)
      OR (organization_id IS NOT NULL AND billing_epoch_id IS NOT NULL)),
    CHECK((meter IN ('r2.storage.standard','r2.storage.observed') AND unit='byte_peak_day' AND timeframe_end=timeframe_start+interval '1 day'
      AND timeframe_start=date_trunc('day',timeframe_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      OR (meter IN ('r2.class_a','r2.class_b') AND unit='request' AND timeframe_end=timeframe_start+interval '1 hour'
      AND timeframe_start=date_trunc('hour',timeframe_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),
    CHECK(observed_at>=timeframe_end),
    CHECK(meter<>'r2.storage.observed' OR NOT exact)
  );
  CREATE TRIGGER r2_consumption_append_only BEFORE UPDATE OR DELETE ON r2_consumption_observations
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE VIEW latest_r2_consumption WITH (security_invoker=true) AS
    SELECT DISTINCT ON(account_id,bucket_name,jurisdiction,timeframe_start,meter) *
    FROM r2_consumption_observations
    ORDER BY account_id,bucket_name,jurisdiction,timeframe_start,meter,observed_at DESC;`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM r2_consumption_observations) THEN
    RAISE EXCEPTION 'Retain R2 measurements before removing this delivery'; END IF; END $$;`);
  pgm.dropView("latest_r2_consumption");
  pgm.dropTable("r2_consumption_observations");
}
