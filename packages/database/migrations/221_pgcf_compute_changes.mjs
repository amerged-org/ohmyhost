export function up(pgm) {
  pgm.sql(`CREATE TABLE pgcf_database_compute_changes (
    operation_id ulid PRIMARY KEY,organization_id ulid NOT NULL,project_id ulid NOT NULL,environment_id ulid NOT NULL,data_environment_id ulid NOT NULL,billing_epoch_id ulid NOT NULL,
    provider_project_id text NOT NULL CHECK(provider_project_id~'^prj_[a-z0-9]{20}$'),database_id text NOT NULL CHECK(database_id~'^[a-z][a-z0-9]{19}$'),
    target_version bigint NOT NULL CHECK(target_version>0),memory_mib integer NOT NULL CHECK(memory_mib IN(256,512,1024,2048,4096)),size_class_id text NOT NULL,
    accepted_lifecycle_version integer NOT NULL,requested_at timestamptz NOT NULL,
    claim_id ulid,claim_expires_at timestamptz,last_attempted_at timestamptz,completed_at timestamptz,failure_code text,
    FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
    FOREIGN KEY(billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
    FOREIGN KEY(organization_id,project_id,data_environment_id,target_version) REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version)
  );
  CREATE INDEX pgcf_database_compute_changes_history ON pgcf_database_compute_changes(organization_id,project_id,data_environment_id,database_id,billing_epoch_id,requested_at DESC);
  CREATE UNIQUE INDEX pgcf_database_compute_changes_unfinished ON pgcf_database_compute_changes(project_id) WHERE completed_at IS NULL;
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN GRANT SELECT,INSERT,UPDATE ON pgcf_database_compute_changes TO control_runtime; END IF; END $$;`);
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM pgcf_database_compute_changes) THEN RAISE EXCEPTION 'PGCF compute history prevents downgrade'; END IF; END $$; DROP TABLE pgcf_database_compute_changes;`,
  );
}
