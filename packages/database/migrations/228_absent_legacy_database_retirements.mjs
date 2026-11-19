/** Owner-authored proof that a historical Neon target is absent from a complete inventory. */
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE database_provider_legacy_retirements (
      organization_id ulid NOT NULL,project_id ulid NOT NULL,physical_environment_id ulid NOT NULL,
      target_version bigint NOT NULL,provider_project_id text NOT NULL,branch_id text NOT NULL,
      manifest_sha256 bytea NOT NULL CHECK(octet_length(manifest_sha256)=32),
      inventory_sha256 bytea NOT NULL CHECK(octet_length(inventory_sha256)=32),
      retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),retired_by text NOT NULL DEFAULT current_user,
      PRIMARY KEY(organization_id,project_id,physical_environment_id,target_version),
      FOREIGN KEY(organization_id,project_id,physical_environment_id,target_version)
        REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version)
    );
    CREATE TRIGGER database_provider_legacy_retirements_append_only BEFORE UPDATE OR DELETE
      ON database_provider_legacy_retirements FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    REVOKE ALL ON database_provider_legacy_retirements FROM PUBLIC;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      REVOKE ALL ON database_provider_legacy_retirements FROM control_runtime;
      GRANT SELECT ON database_provider_legacy_retirements TO control_runtime;
    END IF; END $$;
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM database_provider_legacy_retirements) THEN
    RAISE EXCEPTION 'Legacy retirement evidence prevents downgrade'; END IF; END $$;
    DROP TABLE database_provider_legacy_retirements;`);
}
