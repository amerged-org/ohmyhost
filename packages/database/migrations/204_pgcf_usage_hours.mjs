/** Provider observations and collection progress contain no money; the common runner settles. */
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE pgcf_usage_hours (
      provider_project_id text NOT NULL, database_id text NOT NULL,
      hour_start timestamptz NOT NULL, hour_end timestamptz NOT NULL,
      final boolean NOT NULL, raw_metrics jsonb NOT NULL, gaps jsonb NOT NULL,
      memory_mib_milliseconds bigint CHECK(memory_mib_milliseconds>=0),
      observed_at timestamptz NOT NULL,
      organization_id ulid, project_id ulid, environment_id ulid, billing_epoch_id ulid,
      scope text NOT NULL CHECK(scope IN ('customer','platform','unattributed','before_activation')),
      PRIMARY KEY(provider_project_id,database_id,hour_start),
      CHECK(hour_end=hour_start+interval '1 hour' AND date_trunc('hour',hour_start,'UTC')=hour_start),
      CHECK((scope='customer')=(organization_id IS NOT NULL AND project_id IS NOT NULL AND billing_epoch_id IS NOT NULL)),
      CHECK(jsonb_typeof(raw_metrics)='object' AND jsonb_typeof(gaps)='array'),
      CHECK(memory_mib_milliseconds IS NULL OR (final AND NOT gaps ?| ARRAY['memory_mib_seconds','lifecycle','resource_snapshot','rollup_pending']))
    );
    CREATE TABLE pgcf_collection_cursors (
      provider_project_id text PRIMARY KEY,
      completed_through timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK(date_trunc('hour',completed_through,'UTC')=completed_through)
    );
    CREATE FUNCTION guard_pgcf_final_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' OR OLD.final THEN RAISE EXCEPTION 'Final PGCF usage must be retained'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER pgcf_usage_hours_final BEFORE UPDATE OR DELETE ON pgcf_usage_hours
      FOR EACH ROW EXECUTE FUNCTION guard_pgcf_final_usage();
    REVOKE ALL ON pgcf_usage_hours,pgcf_collection_cursors FROM PUBLIC;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        GRANT SELECT,INSERT,UPDATE ON pgcf_usage_hours,pgcf_collection_cursors TO control_runtime;
      END IF;
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='metering_runtime') THEN
        GRANT SELECT ON pgcf_usage_hours,pgcf_collection_cursors TO metering_runtime;
      END IF;
    END $$;
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pgcf_usage_hours) THEN
    RAISE EXCEPTION 'PGCF usage observations must be retained'; END IF; END $$;
    DROP TABLE pgcf_usage_hours; DROP FUNCTION guard_pgcf_final_usage(); DROP TABLE pgcf_collection_cursors;`);
}
