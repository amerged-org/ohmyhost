export function up(pgm) {
  pgm.sql(`CREATE TABLE project_database_writes (
    operation_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL,
    environment_id ulid NOT NULL,
    environment text NOT NULL CHECK(environment IN ('dev','prod')),
    data_environment_id ulid NOT NULL,
    billing_epoch_id ulid NOT NULL,
    provider_project_id text NOT NULL,
    default_branch_id text NOT NULL,
    principal_id text NOT NULL,
    idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
    request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
    started_at timestamptz NOT NULL,
    deadline_at timestamptz NOT NULL,
    completed_at timestamptz,
    command text CHECK(command IN ('INSERT','UPDATE','DELETE')),
    affected_rows integer CHECK(affected_rows BETWEEN 0 AND 1000),
    failure_code text CHECK(failure_code IN ('DATABASE_WRITE_REJECTED','DATABASE_WRITE_UNAVAILABLE','DATABASE_WRITE_OUTCOME_UNKNOWN')),
    UNIQUE(organization_id,principal_id,idempotency_key),
    FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
    FOREIGN KEY(billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
    CHECK(deadline_at=started_at+interval '60 seconds'),
    CHECK((completed_at IS NULL AND command IS NULL AND affected_rows IS NULL AND failure_code IS NULL)
       OR (completed_at>=started_at AND ((command IS NOT NULL AND affected_rows IS NOT NULL AND failure_code IS NULL)
         OR (command IS NULL AND affected_rows IS NULL AND failure_code IS NOT NULL))))
  );
  CREATE INDEX project_database_writes_pending ON project_database_writes(deadline_at) WHERE completed_at IS NULL;
  CREATE FUNCTION guard_project_database_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' THEN
      IF NOT EXISTS(SELECT 1 FROM projects WHERE project_id=OLD.project_id AND lifecycle_state='deleted') THEN
        RAISE EXCEPTION 'Write receipt is retained until project deletion' USING ERRCODE='55000';
      END IF;
      RETURN OLD;
    END IF;
    IF (to_jsonb(NEW)-ARRAY['completed_at','command','affected_rows','failure_code']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['completed_at','command','affected_rows','failure_code'])
       OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'Write execution identity is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER project_database_write_guard BEFORE UPDATE OR DELETE ON project_database_writes FOR EACH ROW EXECUTE FUNCTION guard_project_database_write();
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') AND has_table_privilege('control_runtime','operations','INSERT') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON project_database_writes TO control_runtime;
  END IF; END $$;`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_database_writes) THEN RAISE EXCEPTION 'Database write receipts prevent lossless downgrade' USING ERRCODE='23514'; END IF; END $$;
    DROP TABLE project_database_writes;
    DROP FUNCTION guard_project_database_write();`);
}
