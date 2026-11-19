export function up(pgm) {
  pgm.addConstraint("cleanup_runs", "cleanup_runs_scope_key", {
    unique: ["organization_id", "project_id", "operation_id", "cleanup_run_id"],
  });
  pgm.createTable("product_command_intents", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
    event_type: { type: "text", notNull: true },
    installation_id: { type: "text" },
    repository_owner: { type: "text" },
    repository_name: { type: "text" },
    plan_id: { type: "ulid" },
    source_connection_id: { type: "ulid" },
    deployment_id: { type: "ulid" },
    target_deployment_id: { type: "ulid" },
    target_revision_id: { type: "ulid" },
    target_artifact_id: { type: "ulid" },
    expected_etag: { type: "text" },
    cleanup_run_id: { type: "ulid" },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_epoch_fkey", {
    foreignKeys: {
      columns: ["billing_epoch_id", "project_id", "organization_id"],
      references: "billing_epochs (billing_epoch_id, project_id, organization_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_plan_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "plan_id"],
      references: "deployment_plans (organization_id, project_id, plan_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_source_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "source_connection_id"],
      references: "repository_grants (organization_id, project_id, source_connection_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_deployment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id", "deployment_id"],
      references: "deployments (organization_id, project_id, operation_id, deployment_id)",
      onDelete: "RESTRICT",
      deferrable: true,
      initiallyDeferred: true,
    },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_target_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "target_deployment_id", "target_revision_id"],
      references: "deployment_revisions (organization_id, project_id, deployment_id, revision_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_artifact_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "target_artifact_id"],
      references: "build_artifacts (organization_id, project_id, artifact_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_cleanup_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id", "cleanup_run_id"],
      references: "cleanup_runs (organization_id, project_id, operation_id, cleanup_run_id)",
      onDelete: "RESTRICT",
      deferrable: true,
      initiallyDeferred: true,
    },
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_shape_check", {
    check: `
      (event_type='SourceLinkRequestedV1'
       AND installation_id IS NOT NULL AND repository_owner IS NOT NULL AND repository_name IS NOT NULL
       AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL
       AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
       AND expected_etag IS NULL AND cleanup_run_id IS NULL)
      OR
      (event_type='DeploymentRequestedV1'
       AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
       AND plan_id IS NOT NULL AND source_connection_id IS NOT NULL AND deployment_id IS NOT NULL
       AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
       AND expected_etag IS NULL AND cleanup_run_id IS NULL)
      OR
      (event_type='DeploymentRollbackRequestedV1'
       AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
       AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NOT NULL
       AND target_deployment_id IS NOT NULL AND target_revision_id IS NOT NULL AND target_artifact_id IS NOT NULL
       AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL)
      OR
      (event_type='ProjectDeletionRequestedV1'
       AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
       AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL
       AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
       AND expected_etag IS NOT NULL AND cleanup_run_id IS NOT NULL)`,
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_text_check", {
    check: `(installation_id IS NULL OR (installation_id=btrim(installation_id) AND length(installation_id) BETWEEN 1 AND 255))
      AND (repository_owner IS NULL OR (repository_owner=btrim(repository_owner) AND length(repository_owner) BETWEEN 1 AND 255))
      AND (repository_name IS NULL OR (repository_name=btrim(repository_name) AND length(repository_name) BETWEEN 1 AND 255))
      AND (expected_etag IS NULL OR (expected_etag=btrim(expected_etag) AND length(expected_etag) BETWEEN 1 AND 255))`,
  });
  pgm.createTrigger("product_command_intents", "product_command_intents_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function down(pgm) {
  pgm.dropTable("product_command_intents");
  pgm.dropConstraint("cleanup_runs", "cleanup_runs_scope_key");
}
