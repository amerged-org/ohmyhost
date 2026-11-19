export function up(pgm) {
  pgm.sql(`CREATE TABLE project_database_compute_changes (
    operation_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL,
    environment_id ulid NOT NULL,
    data_environment_id ulid NOT NULL,
    billing_epoch_id ulid NOT NULL,
    provider_project_id text NOT NULL CHECK(provider_project_id ~ '^[a-z0-9-]{1,60}$'),
    default_branch_id text NOT NULL CHECK(default_branch_id ~ '^br-[a-z0-9-]{1,57}$'),
    endpoint_id text NOT NULL CHECK(endpoint_id ~ '^ep-[a-z0-9-]{1,57}$'),
    profile text NOT NULL CHECK(profile IN ('free','paid')),
    compute_units numeric(3,2) NOT NULL,
    suspend_timeout_seconds integer NOT NULL,
    requested_at timestamptz NOT NULL,
    claim_id uuid,
    claim_expires_at timestamptz,
    patch_started_at timestamptz,
    last_attempted_at timestamptz,
    provider_operation_ids uuid[],
    provider_observed_at timestamptz,
    completed_at timestamptz,
    failure_code text,
    FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
    FOREIGN KEY(billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
    FOREIGN KEY(project_id,environment_id) REFERENCES environments(project_id,environment_id),
    FOREIGN KEY(organization_id,project_id,data_environment_id) REFERENCES neon_project_placement_receipts(organization_id,project_id,environment_id),
    CHECK(suspend_timeout_seconds=60 AND ((profile='free' AND compute_units=0.25) OR (profile='paid' AND compute_units=0.5))),
    CHECK((claim_id IS NULL)=(claim_expires_at IS NULL)),
    CHECK(patch_started_at IS NULL OR patch_started_at>=requested_at),
    CHECK(provider_operation_ids IS NULL OR cardinality(provider_operation_ids)<=16),
    CHECK(provider_observed_at IS NULL OR provider_observed_at>=requested_at),
    CHECK(completed_at IS NULL OR (completed_at>=requested_at AND claim_id IS NULL)),
    CHECK(failure_code IS NULL OR (completed_at IS NOT NULL AND failure_code IN ('DATABASE_COMPUTE_FAILED','DATABASE_COMPUTE_PLAN_CHANGED','DATABASE_COMPUTE_REJECTED')))
  );
  CREATE UNIQUE INDEX project_database_compute_changes_unfinished ON project_database_compute_changes(project_id,data_environment_id) WHERE completed_at IS NULL;
  CREATE FUNCTION guard_project_database_compute_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Compute change history is retained' USING ERRCODE='55000'; END IF;
    IF (to_jsonb(NEW)-ARRAY['claim_id','claim_expires_at','patch_started_at','last_attempted_at','provider_operation_ids','provider_observed_at','completed_at','failure_code'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['claim_id','claim_expires_at','patch_started_at','last_attempted_at','provider_operation_ids','provider_observed_at','completed_at','failure_code'])
      OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
      OR (OLD.patch_started_at IS NOT NULL AND NEW.patch_started_at IS DISTINCT FROM OLD.patch_started_at)
      OR (OLD.provider_operation_ids IS NOT NULL AND NEW.provider_operation_ids IS DISTINCT FROM OLD.provider_operation_ids)
    THEN RAISE EXCEPTION 'Compute change identity cannot change' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER project_database_compute_changes_guard BEFORE UPDATE OR DELETE ON project_database_compute_changes FOR EACH ROW EXECUTE FUNCTION guard_project_database_compute_change();`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_database_compute_changes) THEN
    RAISE EXCEPTION 'Compute change evidence prevents lossless downgrade' USING ERRCODE='23514';
    END IF; END $$;
    DROP TABLE project_database_compute_changes;
    DROP FUNCTION guard_project_database_compute_change();`);
}
