/** Owner-held activation evidence for non-customer Control databases. */
export function up(pgm) {
  pgm.sql(`CREATE TABLE pgcf_platform_database_activations (
    provider_project_id text NOT NULL CHECK(provider_project_id~'^prj_[a-z0-9]{20}$'),
    database_id text NOT NULL CHECK(database_id~'^[a-z][a-z0-9]{19}$'),
    activated_at timestamptz NOT NULL,manifest_sha256 bytea NOT NULL CHECK(octet_length(manifest_sha256)=32),
    recorded_by text NOT NULL DEFAULT current_user,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(provider_project_id,database_id)
  );
  CREATE TRIGGER pgcf_platform_database_activations_append_only BEFORE UPDATE OR DELETE ON pgcf_platform_database_activations FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN GRANT SELECT ON pgcf_platform_database_activations TO control_runtime; END IF; END $$;`);
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM pgcf_platform_database_activations) THEN RAISE EXCEPTION 'Control activation evidence prevents downgrade'; END IF; END $$; DROP TABLE pgcf_platform_database_activations;`,
  );
}
