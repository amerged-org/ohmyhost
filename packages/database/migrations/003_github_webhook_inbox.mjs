export function up(pgm) {
  pgm.alterColumn("webhook_inbox", "signature_timestamp", { notNull: false });
  pgm.addConstraint("webhook_inbox", "webhook_inbox_provider_signature_check", {
    check:
      "(provider='workos' AND signature_timestamp IS NOT NULL) OR (provider='github' AND signature_timestamp IS NULL)",
  });

  pgm.addConstraint("operations", "operations_billing_scope_key", {
    unique: ["organization_id", "project_id", "operation_id", "billing_epoch_id"],
  });

  pgm.createTable("github_source_connections", {
    source_connection_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
    provider: { type: "text", notNull: true },
    external_repository_id: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("github_source_connections", "github_source_connections_scope_key", {
    unique: [
      "organization_id",
      "project_id",
      "billing_epoch_id",
      "source_connection_id",
      "external_repository_id",
    ],
  });
  pgm.addConstraint("github_source_connections", "github_source_connections_billing_fkey", {
    foreignKeys: {
      columns: ["billing_epoch_id", "project_id", "organization_id"],
      references: "billing_epochs (billing_epoch_id, project_id, organization_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("github_source_connections", "github_source_connections_content_check", {
    check:
      "provider='github' AND external_repository_id~'^[1-9][0-9]{0,15}$' AND external_repository_id::numeric<=9007199254740991",
  });
  pgm.createTrigger("github_source_connections", "github_source_connections_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("source_archives", {
    operation_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
    provider: { type: "text", notNull: true },
    source_connection_id: { type: "ulid", notNull: true },
    external_repository_id: { type: "text", notNull: true },
    requested_commit_sha: { type: "text", notNull: true },
    resolved_commit_sha: { type: "text", notNull: true },
    archive_format: { type: "text", notNull: true },
    sha256: { type: "bytea", notNull: true },
    byte_length: { type: "bigint", notNull: true },
    object_ref: { type: "text", notNull: true },
    acquired_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("source_archives", "source_archives_operation_billing_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id", "billing_epoch_id"],
      references: "operations (organization_id, project_id, operation_id, billing_epoch_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("source_archives", "source_archives_source_connection_fkey", {
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
  pgm.addConstraint("source_archives", "source_archives_content_check", {
    check:
      "provider='github' AND external_repository_id~'^[1-9][0-9]{0,15}$' AND external_repository_id::numeric<=9007199254740991 AND requested_commit_sha~'^[0-9a-f]{40}$' AND requested_commit_sha<>repeat('0',40) AND resolved_commit_sha=requested_commit_sha AND archive_format='tar.gz' AND octet_length(sha256)=32 AND byte_length BETWEEN 1 AND 9007199254740991 AND object_ref~'^archive_[0-7][0-9A-HJKMNP-TV-Z]{25}_[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND split_part(object_ref,'_',2)=operation_id::text",
  });
  pgm.createTrigger("source_archives", "source_archives_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM source_archives)
          OR EXISTS (SELECT 1 FROM github_source_connections) THEN
         RAISE EXCEPTION 'GitHub source evidence must be retained before downgrade'
           USING ERRCODE='23514', CONSTRAINT='source_archives_downgrade_requires_empty';
       END IF;
     END $$`,
  );
  pgm.dropTrigger("source_archives", "source_archives_append_only");
  pgm.dropTable("source_archives");
  pgm.dropTrigger("github_source_connections", "github_source_connections_append_only");
  pgm.dropTable("github_source_connections");
  pgm.dropConstraint("operations", "operations_billing_scope_key");
  pgm.dropConstraint("webhook_inbox", "webhook_inbox_provider_signature_check");
  // PostgreSQL refuses this atomically while any provider row has no signed timestamp. That is
  // intentional: a rollback must never invent GitHub signature metadata or discard inbox rows.
  pgm.alterColumn("webhook_inbox", "signature_timestamp", { notNull: true });
}
