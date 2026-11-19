/** Product SQL keeps its existing durable identities while provider targets become explicit. */
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE project_database_access ADD COLUMN provider text NOT NULL DEFAULT 'neon';
    ALTER TABLE project_database_access ADD COLUMN database_id text;
    ALTER TABLE project_database_access ADD COLUMN provider_create_operation_id text;
    ALTER TABLE project_database_access ADD COLUMN provider_delete_operation_id text;
    ALTER TABLE project_database_access ALTER COLUMN default_branch_id DROP NOT NULL;
    ALTER TABLE project_database_access DROP CONSTRAINT project_database_access_provider_project_id_check;
    ALTER TABLE project_database_access ADD CONSTRAINT project_database_access_provider_target CHECK(
      (provider='neon' AND database_id IS NULL AND default_branch_id IS NOT NULL AND provider_project_id~'^[a-z0-9-]{1,60}$') OR
      (provider='pgcf' AND database_id IS NOT NULL AND database_id~'^[a-z][a-z0-9]{19}$' AND default_branch_id IS NULL AND provider_project_id~'^prj_[a-z0-9]{20}$'));
    ALTER TABLE project_database_access ADD CONSTRAINT project_database_access_provider_operations CHECK(
      (provider_create_operation_id IS NULL OR(provider='pgcf' AND provider_create_operation_id~'^op_[a-z0-9]{20}$')) AND
      (provider_delete_operation_id IS NULL OR(provider='pgcf' AND provider_delete_operation_id~'^op_[a-z0-9]{20}$')));
    ALTER TABLE project_database_writes ADD COLUMN provider text NOT NULL DEFAULT 'neon';
    ALTER TABLE project_database_writes ADD COLUMN database_id text;
    ALTER TABLE project_database_writes ALTER COLUMN default_branch_id DROP NOT NULL;
    ALTER TABLE project_database_writes ADD CONSTRAINT project_database_writes_provider_target CHECK(
      (provider='neon' AND database_id IS NULL AND default_branch_id IS NOT NULL) OR
      (provider='pgcf' AND database_id IS NOT NULL AND database_id~'^[a-z][a-z0-9]{19}$' AND default_branch_id IS NULL AND provider_project_id~'^prj_[a-z0-9]{20}$'));
    CREATE FUNCTION guard_project_database_access_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revocation_reason','role_dropped_at','provider_create_operation_id','provider_delete_operation_id']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revocation_reason','role_dropped_at','provider_create_operation_id','provider_delete_operation_id'])
        OR (OLD.provider_create_operation_id IS NOT NULL AND NEW.provider_create_operation_id IS DISTINCT FROM OLD.provider_create_operation_id)
        OR (OLD.provider_delete_operation_id IS NOT NULL AND NEW.provider_delete_operation_id IS DISTINCT FROM OLD.provider_delete_operation_id)
      THEN RAISE EXCEPTION 'Database access target identity is immutable' USING ERRCODE='55000'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER project_database_access_identity_guard BEFORE UPDATE ON project_database_access FOR EACH ROW EXECUTE FUNCTION guard_project_database_access_identity();
  `);
}
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_database_access WHERE provider='pgcf') OR EXISTS(SELECT 1 FROM project_database_writes WHERE provider='pgcf') THEN RAISE EXCEPTION 'PGCF SQL receipts prevent lossless downgrade' USING ERRCODE='23514'; END IF; END $$;
    DROP TRIGGER project_database_access_identity_guard ON project_database_access; DROP FUNCTION guard_project_database_access_identity();
    ALTER TABLE project_database_writes DROP CONSTRAINT project_database_writes_provider_target, DROP COLUMN provider, DROP COLUMN database_id;
    ALTER TABLE project_database_writes ALTER COLUMN default_branch_id SET NOT NULL;
    ALTER TABLE project_database_access DROP CONSTRAINT project_database_access_provider_target, DROP CONSTRAINT project_database_access_provider_operations,
      DROP COLUMN provider, DROP COLUMN database_id, DROP COLUMN provider_create_operation_id, DROP COLUMN provider_delete_operation_id;
    ALTER TABLE project_database_access ALTER COLUMN default_branch_id SET NOT NULL;
    ALTER TABLE project_database_access ADD CONSTRAINT project_database_access_provider_project_id_check CHECK(provider_project_id~'^[a-z0-9-]{1,60}$');`);
}
