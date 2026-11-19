export function up(pgm) {
  pgm.dropTrigger("environments", "environments_require_current_owner");
  pgm.sql(`CREATE FUNCTION require_active_environment_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM project_ownerships
        WHERE project_id=NEW.project_id AND organization_id=NEW.organization_id AND state='active';
      IF FOUND THEN RETURN NEW; END IF;
      IF TG_OP='UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        PERFORM 1 FROM project_transfer_intents
          WHERE project_id=NEW.project_id AND source_organization_id=OLD.organization_id
            AND target_organization_id=NEW.organization_id AND state='pending_frozen';
        IF FOUND THEN RETURN NEW; END IF;
      END IF;
      RAISE EXCEPTION 'current-state writes require active current project ownership'
        USING ERRCODE='42501';
    END $$;
    CREATE TRIGGER environments_require_current_owner BEFORE INSERT OR UPDATE ON environments
      FOR EACH ROW EXECUTE FUNCTION require_active_environment_owner();`);
  pgm.addColumns("projects", {
    lifecycle_state: { type: "text", notNull: true, default: "active" },
    lifecycle_version: { type: "integer", notNull: true, default: 1 },
  });
  pgm.addConstraint("projects", "projects_lifecycle_check", {
    check: "lifecycle_state IN ('active','deleting','deleted') AND lifecycle_version>0",
  });

  pgm.addColumns("environments", {
    is_default: { type: "boolean", notNull: true, default: false },
    active_deployment_id: { type: "ulid" },
    active_revision_id: { type: "ulid" },
    head_version: { type: "integer", notNull: true, default: 0 },
  });
  pgm.sql(`WITH ranked AS (
    SELECT organization_id,environment_id,
           row_number() OVER (PARTITION BY organization_id,project_id ORDER BY created_at,environment_id) AS rank
    FROM environments
  )
  UPDATE environments environment
  SET is_default=true
  FROM ranked
  WHERE environment.organization_id=ranked.organization_id
    AND environment.environment_id=ranked.environment_id AND ranked.rank=1`);
  pgm.sql(`INSERT INTO environments
    (organization_id,environment_id,project_id,name,desired_state,created_at,updated_at,is_default)
    SELECT ownership.organization_id,project.project_id,project.project_id,'sandbox','{}'::jsonb,
           project.created_at,project.created_at,true
    FROM projects project
    INNER JOIN project_ownerships ownership USING (project_id)
    WHERE NOT EXISTS (SELECT 1 FROM environments environment
                      WHERE environment.organization_id=ownership.organization_id
                        AND environment.project_id=project.project_id)`);
  pgm.createIndex("environments", ["organization_id", "project_id"], {
    name: "environments_one_default_per_project_key",
    unique: true,
    where: "is_default",
  });
  pgm.addConstraint("environments", "environments_head_shape_check", {
    check: `head_version>=0 AND ((head_version=0 AND active_deployment_id IS NULL AND active_revision_id IS NULL)
      OR (head_version>0 AND active_deployment_id IS NOT NULL AND active_revision_id IS NOT NULL))`,
  });
  pgm.sql(`CREATE FUNCTION ensure_default_sandbox_environment() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO environments
        (organization_id,environment_id,project_id,name,desired_state,created_at,updated_at,is_default)
      SELECT ownership.organization_id,NEW.project_id,NEW.project_id,'sandbox','{}'::jsonb,
             NEW.created_at,NEW.created_at,true
      FROM project_ownerships ownership WHERE ownership.project_id=NEW.project_id
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER projects_default_environment
      AFTER INSERT ON projects DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ensure_default_sandbox_environment();`);

  pgm.createTable("project_sources", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    source_id: { type: "ulid", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
    grant_id: { type: "ulid", notNull: true },
    provider: { type: "text", notNull: true },
    installation_id: { type: "text", notNull: true },
    external_repository_id: { type: "text", notNull: true },
    repository_owner: { type: "text", notNull: true },
    repository_name: { type: "text", notNull: true },
    state: { type: "text", notNull: true },
    failure_code: { type: "text" },
    revision: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("project_sources", "project_sources_pkey", {
    primaryKey: ["organization_id", "project_id", "source_id"],
  });
  pgm.addConstraint("project_sources", "project_sources_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_sources", "project_sources_epoch_fkey", {
    foreignKeys: {
      columns: ["billing_epoch_id", "project_id", "organization_id"],
      references: "billing_epochs (billing_epoch_id, project_id, organization_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_sources", "project_sources_grant_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "grant_id"],
      references: "repository_grants (organization_id, project_id, grant_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_sources", "project_sources_check", {
    check: `provider='github' AND state IN ('pending','ready','failed','revoked') AND revision>0 AND updated_at>=created_at
    AND ((state='failed' AND failure_code IS NOT NULL) OR (state<>'failed' AND failure_code IS NULL))`,
  });

  pgm.addColumns("deployments", {
    environment_id: { type: "ulid", notNull: true },
    kind: { type: "text", notNull: true, default: "deploy" },
    status: { type: "text", notNull: true, default: "queued" },
    rollback_target_deployment_id: { type: "ulid" },
    rollback_target_revision_id: { type: "ulid" },
  });
  pgm.addConstraint("deployments", "deployments_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployments", "deployments_kind_status_check", {
    check: `kind IN ('deploy','rollback') AND status IN ('queued','running','succeeded','failed','reconciliation_required')
    AND ((kind='deploy' AND rollback_target_deployment_id IS NULL AND rollback_target_revision_id IS NULL)
      OR (kind='rollback' AND rollback_target_deployment_id IS NOT NULL AND rollback_target_revision_id IS NOT NULL))`,
  });
  pgm.addConstraint("deployments", "deployments_rollback_target_fkey", {
    foreignKeys: {
      columns: [
        "organization_id",
        "project_id",
        "rollback_target_deployment_id",
        "rollback_target_revision_id",
      ],
      references: "deployment_revisions (organization_id, project_id, deployment_id, revision_id)",
      onDelete: "RESTRICT",
      deferrable: true,
      initiallyDeferred: true,
    },
  });
  pgm.addConstraint("environments", "environments_active_deployment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "active_deployment_id"],
      references: "deployments (organization_id, project_id, deployment_id)",
      onDelete: "RESTRICT",
      deferrable: true,
      initiallyDeferred: true,
    },
  });

  pgm.addColumns("operations", {
    result_deployment_id: { type: "ulid" },
    result_url: { type: "text" },
    result_artifact_sha256: { type: "bytea" },
  });
  pgm.addConstraint("operations", "operations_result_check", {
    check: `((result_deployment_id IS NULL AND result_url IS NULL AND result_artifact_sha256 IS NULL)
      OR (state='succeeded' AND result_deployment_id IS NOT NULL AND result_url IS NOT NULL
          AND result_artifact_sha256 IS NOT NULL AND result_url~'^https://'
          AND octet_length(result_artifact_sha256)=32))`,
  });

  pgm.createTable("aws_build_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    provider_build_id: { type: "text", notNull: true },
    codebuild_project_name: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("aws_build_receipts", "aws_build_receipts_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint("aws_build_receipts", "aws_build_receipts_provider_identity_key", {
    unique: ["codebuild_project_name", "provider_build_id"],
  });
  pgm.addConstraint("aws_build_receipts", "aws_build_receipts_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("aws_build_receipts", "aws_build_receipts_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("aws_build_receipts", "aws_build_receipts_shape_check", {
    check: `provider_build_id=btrim(provider_build_id) AND length(provider_build_id) BETWEEN 1 AND 512
      AND codebuild_project_name=btrim(codebuild_project_name)
      AND length(codebuild_project_name) BETWEEN 1 AND 255`,
  });
  pgm.createTrigger("aws_build_receipts", "aws_build_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("cleanup_runs", {
    cleanup_run_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    state: { type: "text", notNull: true },
    revision: { type: "integer", notNull: true },
    reconciliation_code: { type: "text" },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" },
  });
  pgm.addConstraint("cleanup_runs", "cleanup_runs_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("cleanup_runs", "cleanup_runs_identity_key", {
    unique: ["organization_id", "project_id", "operation_id"],
  });
  pgm.addConstraint("cleanup_runs", "cleanup_runs_check", {
    check: `state IN ('pending','running','succeeded','reconciliation_required') AND revision>0 AND updated_at>=created_at
    AND ((state='reconciliation_required' AND reconciliation_code IS NOT NULL AND completed_at IS NULL)
      OR (state='succeeded' AND reconciliation_code IS NULL AND completed_at IS NOT NULL)
      OR (state IN ('pending','running') AND reconciliation_code IS NULL AND completed_at IS NULL))`,
  });
}

export function down(pgm) {
  pgm.dropTable("cleanup_runs");
  pgm.dropTable("aws_build_receipts");
  pgm.dropConstraint("operations", "operations_result_check");
  pgm.dropColumns("operations", ["result_deployment_id", "result_url", "result_artifact_sha256"]);
  pgm.dropConstraint("environments", "environments_active_deployment_fkey");
  pgm.dropConstraint("deployments", "deployments_rollback_target_fkey");
  pgm.dropConstraint("deployments", "deployments_kind_status_check");
  pgm.dropConstraint("deployments", "deployments_environment_fkey");
  pgm.dropColumns("deployments", [
    "environment_id",
    "kind",
    "status",
    "rollback_target_deployment_id",
    "rollback_target_revision_id",
  ]);
  pgm.dropTable("project_sources");
  pgm.dropTrigger("projects", "projects_default_environment");
  pgm.dropFunction("ensure_default_sandbox_environment", []);
  pgm.dropConstraint("environments", "environments_head_shape_check");
  pgm.dropIndex("environments", [], { name: "environments_one_default_per_project_key" });
  pgm.dropColumns("environments", [
    "is_default",
    "active_deployment_id",
    "active_revision_id",
    "head_version",
  ]);
  pgm.dropConstraint("projects", "projects_lifecycle_check");
  pgm.dropColumns("projects", ["lifecycle_state", "lifecycle_version"]);
  pgm.dropTrigger("environments", "environments_require_current_owner");
  pgm.dropFunction("require_active_environment_owner", []);
  pgm.createTrigger("environments", "environments_require_current_owner", {
    when: "BEFORE",
    operation: ["INSERT", "UPDATE"],
    level: "ROW",
    function: "require_active_current_owner",
  });
}
