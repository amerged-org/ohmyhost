function appendOnly(pgm, table) {
  pgm.createTrigger(table, `${table}_append_only`, {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function up(pgm) {
  pgm.createTable("repository_grants", {
    grant_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    source_connection_id: { type: "ulid", notNull: true },
    provider: { type: "text", notNull: true },
    github_installation_id: { type: "text", notNull: true },
    external_repository_id: { type: "text", notNull: true },
    repository_owner: { type: "text", notNull: true },
    repository_name: { type: "text", notNull: true },
    permission: { type: "text", notNull: true },
    granted_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("repository_grants", "repository_grants_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("repository_grants", "repository_grants_identity_key", {
    unique: ["organization_id", "project_id", "source_connection_id"],
  });
  pgm.addConstraint("repository_grants", "repository_grants_shape_check", {
    check: `provider='github' AND permission='contents:read'
      AND github_installation_id~'^[1-9][0-9]{0,19}$'
      AND external_repository_id~'^[1-9][0-9]{0,15}$'
      AND repository_owner~'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
      AND repository_name=btrim(repository_name) AND length(repository_name) BETWEEN 1 AND 100`,
  });
  appendOnly(pgm, "repository_grants");

  pgm.createTable("aws_source_uploads", {
    upload_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    source_connection_id: { type: "ulid", notNull: true },
    commit_sha: { type: "text", notNull: true },
    bucket_name: { type: "text", notNull: true },
    object_key: { type: "text", notNull: true },
    object_version_id: { type: "text" },
    multipart_upload_id: { type: "text" },
    state: { type: "text", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    claimed_at: { type: "timestamptz", notNull: true },
    lease_expires_at: { type: "timestamptz", notNull: true },
    attempt_number: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("aws_source_uploads", "aws_source_uploads_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("aws_source_uploads", "aws_source_uploads_identity_key", {
    unique: ["organization_id", "project_id", "source_connection_id", "commit_sha"],
  });
  pgm.addConstraint("aws_source_uploads", "aws_source_uploads_scope_key", {
    unique: ["organization_id", "project_id", "upload_id"],
  });
  pgm.addConstraint("aws_source_uploads", "aws_source_uploads_shape_check", {
    check: `commit_sha~'^[0-9a-f]{40}$' AND commit_sha<>repeat('0',40)
      AND bucket_name=btrim(bucket_name) AND length(bucket_name) BETWEEN 3 AND 63
      AND object_key=btrim(object_key) AND length(object_key) BETWEEN 1 AND 1024
      AND state IN ('uploading','completed','aborted','reconciliation_required')
      AND attempt_number>0 AND lease_expires_at>claimed_at AND updated_at>=created_at
      AND ((state='completed' AND object_version_id IS NOT NULL)
        OR (state<>'completed' AND object_version_id IS NULL))`,
  });

  pgm.createTable("aws_source_upload_parts", {
    upload_id: {
      type: "ulid",
      notNull: true,
      references: "aws_source_uploads",
      onDelete: "RESTRICT",
    },
    part_number: { type: "integer", notNull: true },
    etag: { type: "text", notNull: true },
    byte_length: { type: "bigint", notNull: true },
    sha256: { type: "bytea", notNull: true },
    recorded_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("aws_source_upload_parts", "aws_source_upload_parts_pkey", {
    primaryKey: ["upload_id", "part_number"],
  });
  pgm.addConstraint("aws_source_upload_parts", "aws_source_upload_parts_shape_check", {
    check:
      "part_number BETWEEN 1 AND 10000 AND byte_length>0 AND octet_length(sha256)=32 AND length(etag) BETWEEN 1 AND 256",
  });
  appendOnly(pgm, "aws_source_upload_parts");

  pgm.createTable("build_executions", {
    build_execution_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    source_upload_id: {
      type: "ulid",
      notNull: true,
      references: "aws_source_uploads",
      onDelete: "RESTRICT",
    },
    build_plan_sha256: { type: "bytea", notNull: true },
    codebuild_project_name: { type: "text", notNull: true },
    provider_build_id: { type: "text" },
    state: { type: "text", notNull: true },
    claim_id: { type: "ulid" },
    claimed_at: { type: "timestamptz" },
    lease_expires_at: { type: "timestamptz" },
    attempt_number: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("build_executions", "build_executions_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("build_executions", "build_executions_source_scope_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "source_upload_id"],
      references: "aws_source_uploads (organization_id, project_id, upload_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("build_executions", "build_executions_scope_key", {
    unique: ["organization_id", "project_id", "build_execution_id"],
  });
  pgm.addConstraint("build_executions", "build_executions_identity_key", {
    unique: ["source_upload_id", "build_plan_sha256"],
  });
  pgm.addConstraint("build_executions", "build_executions_shape_check", {
    check: `octet_length(build_plan_sha256)=32 AND attempt_number>0 AND updated_at>=created_at
      AND state IN ('pending','running','succeeded','failed','reconciliation_required')
      AND ((state IN ('pending','running') AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at)
        OR (state NOT IN ('pending','running') AND claim_id IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL))`,
  });

  pgm.createTable("deployment_plans", {
    plan_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    source_connection_id: { type: "ulid", notNull: true },
    commit_sha: { type: "text", notNull: true },
    source_sha256: { type: "bytea", notNull: true },
    build_plan_sha256: { type: "bytea", notNull: true },
    runtime: { type: "text", notNull: true },
    impacts: { type: "jsonb", notNull: true },
    risks: { type: "jsonb", notNull: true },
    cost_estimate: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("deployment_plans", "deployment_plans_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployment_plans", "deployment_plans_source_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "source_connection_id"],
      references: "repository_grants (organization_id, project_id, source_connection_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployment_plans", "deployment_plans_scope_key", {
    unique: ["organization_id", "project_id", "plan_id"],
  });
  pgm.addConstraint("deployment_plans", "deployment_plans_shape_check", {
    check: `commit_sha~'^[0-9a-f]{40}$' AND octet_length(source_sha256)=32 AND octet_length(build_plan_sha256)=32
      AND runtime=btrim(runtime) AND length(runtime) BETWEEN 1 AND 64
      AND jsonb_typeof(impacts)='array' AND jsonb_typeof(risks)='array' AND jsonb_typeof(cost_estimate)='object'
      AND expires_at=created_at+interval '15 minutes'`,
  });
  appendOnly(pgm, "deployment_plans");

  pgm.createTable("build_artifacts", {
    artifact_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    build_execution_id: {
      type: "ulid",
      notNull: true,
      references: "build_executions",
      onDelete: "RESTRICT",
    },
    artifact_sha256: { type: "bytea", notNull: true },
    manifest_sha256: { type: "bytea", notNull: true },
    sbom_sha256: { type: "bytea", notNull: true },
    object_version_ref: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("build_artifacts", "build_artifacts_shape_check", {
    check:
      "octet_length(artifact_sha256)=32 AND octet_length(manifest_sha256)=32 AND octet_length(sbom_sha256)=32 AND length(object_version_ref) BETWEEN 1 AND 512",
  });
  pgm.addConstraint("build_artifacts", "build_artifacts_build_scope_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "build_execution_id"],
      references: "build_executions (organization_id, project_id, build_execution_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("build_artifacts", "build_artifacts_scope_key", {
    unique: ["organization_id", "project_id", "artifact_id"],
  });
  pgm.addConstraint("build_artifacts", "build_artifacts_identity_key", {
    unique: ["build_execution_id", "artifact_sha256"],
  });
  appendOnly(pgm, "build_artifacts");

  pgm.createTable("wfp_publish_receipts", {
    wfp_receipt_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    artifact_id: {
      type: "ulid",
      notNull: true,
      references: "build_artifacts",
      onDelete: "RESTRICT",
    },
    dispatch_namespace: { type: "text", notNull: true },
    script_name: { type: "text", notNull: true },
    provider_version_id: { type: "text", notNull: true },
    deployment_url: { type: "text", notNull: true },
    published_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_identity_key", {
    unique: ["dispatch_namespace", "script_name", "provider_version_id"],
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_artifact_scope_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "artifact_id"],
      references: "build_artifacts (organization_id, project_id, artifact_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_scope_key", {
    unique: ["organization_id", "project_id", "wfp_receipt_id"],
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_shape_check", {
    check:
      "length(dispatch_namespace) BETWEEN 1 AND 64 AND length(script_name) BETWEEN 1 AND 255 AND length(provider_version_id) BETWEEN 1 AND 255 AND deployment_url~'^https://'",
  });
  appendOnly(pgm, "wfp_publish_receipts");

  pgm.createTable("deployments", {
    deployment_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    active_revision_id: { type: "ulid" },
    active_version: { type: "integer", notNull: true, default: 0 },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("deployments", "deployments_scope_key", {
    unique: ["organization_id", "project_id", "deployment_id"],
  });
  pgm.addConstraint("deployments", "deployments_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployments", "deployments_shape_check", {
    check:
      "active_version>=0 AND updated_at>=created_at AND ((active_version=0 AND active_revision_id IS NULL) OR (active_version>0 AND active_revision_id IS NOT NULL))",
  });

  pgm.createTable("deployment_revisions", {
    revision_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    plan_id: { type: "ulid", notNull: true, references: "deployment_plans", onDelete: "RESTRICT" },
    build_execution_id: {
      type: "ulid",
      notNull: true,
      references: "build_executions",
      onDelete: "RESTRICT",
    },
    artifact_id: {
      type: "ulid",
      notNull: true,
      references: "build_artifacts",
      onDelete: "RESTRICT",
    },
    wfp_receipt_id: {
      type: "ulid",
      notNull: true,
      references: "wfp_publish_receipts",
      onDelete: "RESTRICT",
    },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("deployment_revisions", "deployment_revisions_deployment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "deployment_id"],
      references: "deployments (organization_id, project_id, deployment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployment_revisions", "deployment_revisions_plan_scope_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "plan_id"],
      references: "deployment_plans (organization_id, project_id, plan_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployment_revisions", "deployment_revisions_build_scope_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "build_execution_id"],
      references: "build_executions (organization_id, project_id, build_execution_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployment_revisions", "deployment_revisions_artifact_scope_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "artifact_id"],
      references: "build_artifacts (organization_id, project_id, artifact_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployment_revisions", "deployment_revisions_wfp_scope_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "wfp_receipt_id"],
      references: "wfp_publish_receipts (organization_id, project_id, wfp_receipt_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployment_revisions", "deployment_revisions_scope_key", {
    unique: ["organization_id", "project_id", "deployment_id", "revision_id"],
  });
  appendOnly(pgm, "deployment_revisions");
  pgm.addConstraint("deployments", "deployments_active_revision_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "deployment_id", "active_revision_id"],
      references: "deployment_revisions (organization_id, project_id, deployment_id, revision_id)",
      onDelete: "RESTRICT",
      deferrable: true,
      initiallyDeferred: true,
    },
  });

  pgm.createTable("action_confirmations", {
    confirmation_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    action: { type: "text", notNull: true },
    subject_version: { type: "integer", notNull: true },
    token_sha256: { type: "bytea", notNull: true, unique: true },
    created_at: { type: "timestamptz", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
    consumed_at: { type: "timestamptz" },
  });
  pgm.addConstraint("action_confirmations", "action_confirmations_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("action_confirmations", "action_confirmations_shape_check", {
    check:
      "action IN ('rollback','delete') AND subject_version>=0 AND octet_length(token_sha256)=32 AND expires_at=created_at+interval '10 minutes' AND (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at)",
  });

  pgm.createTable("run_resource_inventory", {
    resource_record_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    provider: { type: "text", notNull: true },
    resource_kind: { type: "text", notNull: true },
    external_ref_hash: { type: "bytea", notNull: true },
    recorded_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("run_resource_inventory", "run_resource_inventory_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("run_resource_inventory", "run_resource_inventory_identity_key", {
    unique: ["organization_id", "operation_id", "provider", "resource_kind", "external_ref_hash"],
  });
  pgm.addConstraint("run_resource_inventory", "run_resource_inventory_shape_check", {
    check:
      "octet_length(external_ref_hash)=32 AND length(provider) BETWEEN 1 AND 64 AND length(resource_kind) BETWEEN 1 AND 64",
  });
  appendOnly(pgm, "run_resource_inventory");

  pgm.createTable("run_cleanup_attempts", {
    cleanup_attempt_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    provider: { type: "text", notNull: true },
    resource_kind: { type: "text", notNull: true },
    external_ref_hash: { type: "bytea", notNull: true },
    outcome: { type: "text", notNull: true },
    error_code: { type: "text" },
    attempted_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("run_cleanup_attempts", "run_cleanup_attempts_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("run_cleanup_attempts", "run_cleanup_attempts_shape_check", {
    check:
      "octet_length(external_ref_hash)=32 AND outcome IN ('removed','not_found','failed') AND ((outcome='failed' AND error_code IS NOT NULL) OR (outcome<>'failed' AND error_code IS NULL))",
  });
  appendOnly(pgm, "run_cleanup_attempts");
}

export function down(pgm) {
  pgm.dropTable("run_cleanup_attempts");
  pgm.dropTable("run_resource_inventory");
  pgm.dropTable("action_confirmations");
  pgm.dropConstraint("deployments", "deployments_active_revision_fkey");
  pgm.dropTable("deployment_revisions");
  pgm.dropTable("deployments");
  pgm.dropTable("wfp_publish_receipts");
  pgm.dropTable("build_artifacts");
  pgm.dropTable("deployment_plans");
  pgm.dropTable("build_executions");
  pgm.dropTable("aws_source_upload_parts");
  pgm.dropTable("aws_source_uploads");
  pgm.dropTable("repository_grants");
}
