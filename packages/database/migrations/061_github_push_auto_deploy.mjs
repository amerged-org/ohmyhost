export function up(pgm) {
  pgm.createTable("github_auto_deploy_configs", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    source_connection_id: { type: "ulid", notNull: true },
    branch_ref: { type: "text", notNull: true },
    generation: { type: "integer", notNull: true },
    enabled: { type: "boolean", notNull: true },
    configured_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("github_auto_deploy_configs", "github_auto_deploy_configs_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("github_auto_deploy_configs", "github_auto_deploy_configs_source_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "source_connection_id"],
      references: "repository_grants (organization_id, project_id, source_connection_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("github_auto_deploy_configs", "github_auto_deploy_configs_shape_check", {
    check: `length(branch_ref) BETWEEN 12 AND 1035
      AND branch_ref~'^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$'
      AND branch_ref!~'[[:cntrl:][:space:]~^:?*]'
      AND position(chr(92) in branch_ref)=0 AND position('[' in branch_ref)=0 AND position(']' in branch_ref)=0
      AND branch_ref NOT LIKE '%..%' AND branch_ref NOT LIKE '%@{%' AND branch_ref NOT LIKE '%//%'
      AND branch_ref!~'(^|/)\\.' AND branch_ref!~'\\.lock(/|$)' AND branch_ref!~'\\.$'
      AND generation>0 AND updated_at>=configured_at`,
  });

  pgm.createTable("github_push_deployments", {
    push_deployment_id: { type: "ulid", primaryKey: true },
    inbox_event_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    source_connection_id: { type: "ulid", notNull: true },
    config_generation: { type: "integer", notNull: true },
    delivery_guid: { type: "text", notNull: true },
    github_installation_id: { type: "text", notNull: true },
    external_repository_id: { type: "text", notNull: true },
    branch_ref: { type: "text", notNull: true },
    commit_sha: { type: "text", notNull: true },
    sequence: { type: "bigint", notNull: true },
    operation_id: { type: "ulid" },
    state: { type: "text", notNull: true },
    superseded_by_id: { type: "ulid" },
    cleanup_required: { type: "boolean", notNull: true, default: false },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("github_push_deployments", "github_push_deployments_inbox_fkey", {
    foreignKeys: { columns: ["inbox_event_id"], references: "webhook_inbox", onDelete: "RESTRICT" },
  });
  pgm.addConstraint("github_push_deployments", "github_push_deployments_config_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "github_auto_deploy_configs (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("github_push_deployments", "github_push_deployments_source_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "source_connection_id"],
      references: "repository_grants (organization_id, project_id, source_connection_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("github_push_deployments", "github_push_deployments_superseded_fkey", {
    foreignKeys: {
      columns: ["superseded_by_id"],
      references: "github_push_deployments",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("github_push_deployments", "github_push_deployments_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "operation_id"],
      references: "operations (organization_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("github_push_deployments", "github_push_deployments_delivery_key", {
    unique: ["organization_id", "project_id", "delivery_guid"],
  });
  pgm.addConstraint("github_push_deployments", "github_push_deployments_commit_key", {
    unique: [
      "organization_id",
      "project_id",
      "source_connection_id",
      "config_generation",
      "commit_sha",
    ],
  });
  pgm.addConstraint("github_push_deployments", "github_push_deployments_operation_key", {
    unique: ["operation_id"],
  });
  pgm.addConstraint("github_push_deployments", "github_push_deployments_shape_check", {
    check: `config_generation>0 AND sequence>0 AND delivery_guid~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND github_installation_id~'^[1-9][0-9]{0,19}$' AND external_repository_id~'^[1-9][0-9]{0,15}$' AND branch_ref~'^refs/heads/' AND commit_sha~'^[0-9a-f]{40}$' AND commit_sha<>repeat('0',40) AND state IN ('queued','running','superseded','failed','active','reconciliation_required') AND operation_id IS NOT NULL AND ((state='superseded' AND superseded_by_id IS NOT NULL AND cleanup_required) OR (state<>'superseded' AND superseded_by_id IS NULL)) AND updated_at>=created_at`,
  });
  pgm.createIndex("github_push_deployments", ["organization_id", "project_id", "sequence"], {
    name: "github_push_deployments_latest_idx",
    unique: true,
  });

  pgm.createTable("github_push_target_denials", {
    inbox_event_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    source_connection_id: { type: "ulid", notNull: true },
    github_installation_id: { type: "text", notNull: true },
    external_repository_id: { type: "text", notNull: true },
    branch_ref: { type: "text", notNull: true },
    error_code: { type: "text", notNull: true },
    denied_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("github_push_target_denials", "github_push_target_denials_pkey", {
    primaryKey: ["inbox_event_id", "project_id"],
  });
  pgm.addConstraint("github_push_target_denials", "github_push_target_denials_inbox_fkey", {
    foreignKeys: { columns: ["inbox_event_id"], references: "webhook_inbox", onDelete: "RESTRICT" },
  });
  pgm.addConstraint("github_push_target_denials", "github_push_target_denials_source_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "source_connection_id"],
      references: "repository_grants (organization_id, project_id, source_connection_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("github_push_target_denials", "github_push_target_denials_shape_check", {
    check: `github_installation_id~'^[1-9][0-9]{0,19}$'
      AND external_repository_id~'^[1-9][0-9]{0,15}$' AND branch_ref~'^refs/heads/'
      AND error_code IN ('GITHUB_AUTO_DEPLOY_GRANT_REVOKED','GITHUB_AUTO_DEPLOY_DISABLED')`,
  });
}

export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM github_push_deployments) OR EXISTS (SELECT 1 FROM github_auto_deploy_configs) THEN RAISE EXCEPTION 'GitHub auto-deploy evidence prevents a lossless downgrade' USING ERRCODE='23514'; END IF; END $$`,
  );
  pgm.dropTable("github_push_target_denials");
  pgm.dropTable("github_push_deployments");
  pgm.dropTable("github_auto_deploy_configs");
}
