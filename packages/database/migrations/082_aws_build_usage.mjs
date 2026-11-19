export function up(pgm) {
  pgm.sql(`CREATE TABLE aws_build_usage (
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL,
    environment_id ulid NOT NULL,
    operation_id ulid NOT NULL,
    billing_epoch_id ulid NOT NULL,
    provider_build_id text NOT NULL,
    codebuild_project_name text NOT NULL,
    arn text NOT NULL UNIQUE,
    status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','FAULT','STOPPED','TIMED_OUT')),
    started_at timestamptz NOT NULL,
    provisioning_started_at timestamptz,
    completed_at timestamptz NOT NULL,
    environment_type text NOT NULL CHECK (environment_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    compute_type text NOT NULL CHECK (compute_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id,project_id,environment_id,operation_id),
    FOREIGN KEY (organization_id,project_id,environment_id,operation_id)
      REFERENCES aws_build_receipts(organization_id,project_id,environment_id,operation_id),
    FOREIGN KEY (billing_epoch_id,project_id,organization_id)
      REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
    CHECK (completed_at>=started_at AND (provisioning_started_at IS NULL OR
      provisioning_started_at BETWEEN started_at AND completed_at)),
    CHECK (arn ~ '^arn:aws:codebuild:[a-z0-9-]+:[0-9]{12}:build/'
      AND split_part(arn,':build/',2)=provider_build_id)
  );
  CREATE TRIGGER aws_build_usage_append_only BEFORE UPDATE OR DELETE ON aws_build_usage
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM aws_build_usage) THEN
      RAISE EXCEPTION 'Measured build usage must be retained before downgrade';
    END IF;
  END $$;`);
  pgm.dropTable("aws_build_usage");
}
