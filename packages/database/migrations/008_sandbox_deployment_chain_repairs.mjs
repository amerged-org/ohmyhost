export function up(pgm) {
  pgm.addColumns("repository_grants", {
    billing_epoch_id: { type: "ulid", notNull: true },
  });
  pgm.addConstraint("repository_grants", "repository_grants_scope_key", {
    unique: ["organization_id", "project_id", "grant_id"],
  });
  pgm.addConstraint("repository_grants", "repository_grants_source_connection_fkey", {
    foreignKeys: {
      columns: [
        "organization_id",
        "project_id",
        "billing_epoch_id",
        "source_connection_id",
        "external_repository_id",
      ],
      references:
        "github_source_connections (organization_id, project_id, billing_epoch_id, source_connection_id, external_repository_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.createTable("repository_grant_revocations", {
    revocation_id: { type: "ulid", primaryKey: true },
    grant_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    reason: { type: "text", notNull: true },
    revoked_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("repository_grant_revocations", "repository_grant_revocations_grant_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "grant_id"],
      references: "repository_grants (organization_id, project_id, grant_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("repository_grant_revocations", "repository_grant_revocations_grant_key", {
    unique: ["grant_id"],
  });
  pgm.addConstraint("repository_grant_revocations", "repository_grant_revocations_reason_check", {
    check: "reason IN ('installation_uninstalled','permission_revoked','repository_removed')",
  });
  pgm.createTrigger("repository_grant_revocations", "repository_grant_revocations_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
  pgm.createIndex("repository_grant_revocations", ["organization_id", "project_id", "grant_id"], {
    name: "repository_grant_revocations_active_lookup_idx",
  });

  pgm.dropConstraint("aws_source_uploads", "aws_source_uploads_identity_key");
  pgm.addConstraint("aws_source_uploads", "aws_source_uploads_identity_key", {
    unique: ["organization_id", "project_id", "operation_id", "source_connection_id", "commit_sha"],
  });

  pgm.addColumns("deployment_plans", {
    plan_sha256: { type: "bytea", notNull: true },
  });
  pgm.addConstraint("deployment_plans", "deployment_plans_digest_check", {
    check: "octet_length(plan_sha256)=32",
  });

  pgm.addColumns("deployments", {
    operation_id: { type: "ulid", notNull: true },
  });
  pgm.addConstraint("deployments", "deployments_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployments", "deployments_operation_scope_key", {
    unique: ["organization_id", "project_id", "operation_id", "deployment_id"],
  });
  pgm.addColumns("deployment_revisions", {
    operation_id: { type: "ulid", notNull: true },
  });
  pgm.dropConstraint("deployment_revisions", "deployment_revisions_deployment_fkey");
  pgm.addConstraint("deployment_revisions", "deployment_revisions_deployment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id", "deployment_id"],
      references: "deployments (organization_id, project_id, operation_id, deployment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("deployment_revisions", "deployment_revisions_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });

  pgm.addColumns("wfp_publish_receipts", {
    environment_id: { type: "ulid", notNull: true },
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });

  pgm.dropConstraint("action_confirmations", "action_confirmations_shape_check");
  pgm.dropColumn("action_confirmations", "subject_version");
  pgm.addColumns("action_confirmations", {
    issued_to_principal_id: { type: "text", notNull: true },
    target_deployment_id: { type: "ulid" },
    subject_etag: { type: "text", notNull: true },
  });
  pgm.addConstraint("action_confirmations", "action_confirmations_target_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "target_deployment_id"],
      references: "deployments (organization_id, project_id, deployment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("action_confirmations", "action_confirmations_shape_check", {
    check: `action IN ('rollback','delete')
      AND issued_to_principal_id=btrim(issued_to_principal_id)
      AND length(issued_to_principal_id) BETWEEN 1 AND 255
      AND subject_etag=btrim(subject_etag) AND length(subject_etag) BETWEEN 1 AND 255
      AND octet_length(token_sha256)=32
      AND expires_at=created_at+interval '10 minutes'
      AND (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at)
      AND ((action='rollback' AND target_deployment_id IS NOT NULL)
        OR (action='delete' AND target_deployment_id IS NULL))`,
  });
  pgm.createIndex(
    "action_confirmations",
    ["organization_id", "project_id", "action", "issued_to_principal_id", "token_sha256"],
    { name: "action_confirmations_consume_idx", where: "consumed_at IS NULL" },
  );

  pgm.addColumns("run_resource_inventory", {
    cleanup_locator: { type: "text", notNull: true },
  });
  pgm.addConstraint("run_resource_inventory", "run_resource_inventory_locator_check", {
    check: `cleanup_locator=btrim(cleanup_locator)
      AND length(cleanup_locator) BETWEEN 1 AND 1024
      AND cleanup_locator !~ '[[:cntrl:]]'
      AND cleanup_locator !~ '://|[?@#]'`,
  });
}

export function down(pgm) {
  pgm.dropConstraint("run_resource_inventory", "run_resource_inventory_locator_check");
  pgm.dropColumn("run_resource_inventory", "cleanup_locator");

  pgm.dropIndex("action_confirmations", [], { name: "action_confirmations_consume_idx" });
  pgm.dropConstraint("action_confirmations", "action_confirmations_shape_check");
  pgm.dropConstraint("action_confirmations", "action_confirmations_target_fkey");
  pgm.dropColumn("action_confirmations", "issued_to_principal_id");
  pgm.dropColumn("action_confirmations", "target_deployment_id");
  pgm.dropColumn("action_confirmations", "subject_etag");
  pgm.addColumns("action_confirmations", {
    subject_version: { type: "integer", notNull: true },
  });
  pgm.addConstraint("action_confirmations", "action_confirmations_shape_check", {
    check:
      "action IN ('rollback','delete') AND subject_version>=0 AND octet_length(token_sha256)=32 AND expires_at=created_at+interval '10 minutes' AND (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at)",
  });

  pgm.dropConstraint("wfp_publish_receipts", "wfp_publish_receipts_environment_fkey");
  pgm.dropColumn("wfp_publish_receipts", "environment_id");

  pgm.dropConstraint("deployment_revisions", "deployment_revisions_operation_fkey");
  pgm.dropConstraint("deployment_revisions", "deployment_revisions_deployment_fkey");
  pgm.dropColumn("deployment_revisions", "operation_id");
  pgm.addConstraint("deployment_revisions", "deployment_revisions_deployment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "deployment_id"],
      references: "deployments (organization_id, project_id, deployment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.dropConstraint("deployments", "deployments_operation_scope_key");
  pgm.dropConstraint("deployments", "deployments_operation_fkey");
  pgm.dropColumn("deployments", "operation_id");

  pgm.dropConstraint("deployment_plans", "deployment_plans_digest_check");
  pgm.dropColumn("deployment_plans", "plan_sha256");

  pgm.dropConstraint("aws_source_uploads", "aws_source_uploads_identity_key");
  pgm.addConstraint("aws_source_uploads", "aws_source_uploads_identity_key", {
    unique: ["organization_id", "project_id", "source_connection_id", "commit_sha"],
  });

  pgm.dropTable("repository_grant_revocations");
  pgm.dropConstraint("repository_grants", "repository_grants_source_connection_fkey");
  pgm.dropConstraint("repository_grants", "repository_grants_scope_key");
  pgm.dropColumn("repository_grants", "billing_epoch_id");
}
