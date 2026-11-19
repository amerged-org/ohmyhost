export function up(pgm) {
  pgm.dropConstraint("source_archives", "source_archives_content_check");
  pgm.addConstraint("source_archives", "source_archives_content_check", {
    check:
      "provider='github' AND external_repository_id~'^[1-9][0-9]{0,15}$' AND external_repository_id::numeric<=9007199254740991 AND requested_commit_sha~'^[0-9a-f]{40}$' AND requested_commit_sha<>repeat('0',40) AND resolved_commit_sha=requested_commit_sha AND archive_format='tar.gz' AND octet_length(sha256)=32 AND byte_length BETWEEN 1 AND 9007199254740991 AND ((object_ref~'^archive_[0-7][0-9A-HJKMNP-TV-Z]{25}_[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND split_part(object_ref,'_',2)=operation_id::text) OR (length(object_ref)<=512 AND object_ref~'^s3-version:[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^?#[:space:]]+#[A-Za-z0-9._~!%()*+,-]{1,128}$'))",
  });
  pgm.createTable("product_source_archive_objects", {
    operation_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    bucket_name: { type: "text", notNull: true },
    object_key: { type: "text", notNull: true },
    object_version_id: { type: "text", notNull: true },
    object_etag: { type: "text", notNull: true },
    byte_length: { type: "bigint", notNull: true },
    source_sha256: { type: "bytea", notNull: true },
    recorded_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "product_source_archive_objects",
    "product_source_archive_objects_operation_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "operation_id"],
        references: "operations (organization_id, project_id, operation_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "product_source_archive_objects",
    "product_source_archive_objects_environment_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "environment_id"],
        references: "environments (organization_id, project_id, environment_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "product_source_archive_objects",
    "product_source_archive_objects_shape_check",
    {
      check:
        "length(bucket_name) BETWEEN 3 AND 63 AND length(object_key) BETWEEN 1 AND 512 AND length(object_version_id) BETWEEN 1 AND 512 AND length(object_etag) BETWEEN 1 AND 512 AND byte_length BETWEEN 1 AND 9007199254740991 AND octet_length(source_sha256)=32",
    },
  );
  pgm.createTrigger(
    "product_source_archive_objects",
    "product_source_archive_objects_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );
  pgm.addColumns("deployment_plans", { framework_plan: { type: "jsonb" } });
  pgm.addConstraint("deployment_plans", "deployment_plans_framework_plan_check", {
    check: `framework_plan IS NULL OR (
      jsonb_typeof(framework_plan)='object'
      AND framework_plan ?& ARRAY['adapter','runtime','installCommand','buildCommand','outputDirectory']
      AND framework_plan - ARRAY['adapter','runtime','installCommand','buildCommand','outputDirectory']='{}'::jsonb
      AND framework_plan->>'adapter'='vite-static'
      AND framework_plan->>'runtime'='static'
      AND length(btrim(framework_plan->>'installCommand'))>0
      AND length(btrim(framework_plan->>'buildCommand'))>0
      AND length(btrim(framework_plan->>'outputDirectory'))>0)`,
  });

  pgm.createTable("product_workflow_runs", {
    workflow_id: { type: "text", primaryKey: true },
    event_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
    event_type: { type: "text", notNull: true },
    state: { type: "text", notNull: true },
    terminal_evidence: { type: "jsonb" },
    intermediate_evidence: { type: "jsonb" },
    reconciliation_code: { type: "text" },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" },
  });
  pgm.addConstraint("outbox_events", "outbox_events_product_workflow_identity_key", {
    unique: ["event_id", "organization_id", "project_id", "operation_id", "billing_epoch_id"],
  });
  pgm.addConstraint("product_command_intents", "product_command_intents_workflow_identity_key", {
    unique: [
      "organization_id",
      "project_id",
      "environment_id",
      "operation_id",
      "billing_epoch_id",
      "event_type",
    ],
  });
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_outbox_fkey", {
    foreignKeys: {
      columns: ["event_id", "organization_id", "project_id", "operation_id", "billing_epoch_id"],
      references:
        "outbox_events (event_id, organization_id, project_id, operation_id, billing_epoch_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_intent_fkey", {
    foreignKeys: {
      columns: [
        "organization_id",
        "project_id",
        "environment_id",
        "operation_id",
        "billing_epoch_id",
        "event_type",
      ],
      references:
        "product_command_intents (organization_id, project_id, environment_id, operation_id, billing_epoch_id, event_type)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_scope_key", {
    unique: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_event_key", {
    unique: ["event_id"],
  });
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_shape_check", {
    check: `workflow_id=btrim(workflow_id) AND length(workflow_id) BETWEEN 1 AND 255
      AND event_type IN ('SourceLinkRequestedV1','DeploymentRequestedV1','DeploymentRollbackRequestedV1','ProjectDeletionRequestedV1')
      AND state IN ('queued','completed','reconciliation_required')
      AND updated_at>=created_at
      AND ((state='queued' AND terminal_evidence IS NULL AND reconciliation_code IS NULL AND completed_at IS NULL)
        OR (state='completed' AND jsonb_typeof(terminal_evidence)='object' AND reconciliation_code IS NULL AND completed_at IS NOT NULL)
        OR (state='reconciliation_required' AND terminal_evidence IS NULL
            AND reconciliation_code=btrim(reconciliation_code) AND length(reconciliation_code) BETWEEN 1 AND 128
            AND completed_at IS NULL))`,
  });
}

export function down(pgm) {
  pgm.dropTable("product_source_archive_objects");
  pgm.dropTable("product_workflow_runs");
  pgm.dropConstraint("product_command_intents", "product_command_intents_workflow_identity_key");
  pgm.dropConstraint("outbox_events", "outbox_events_product_workflow_identity_key");
  pgm.dropConstraint("deployment_plans", "deployment_plans_framework_plan_check");
  pgm.dropColumn("deployment_plans", "framework_plan");
  pgm.dropConstraint("source_archives", "source_archives_content_check");
  pgm.addConstraint("source_archives", "source_archives_content_check", {
    check:
      "provider='github' AND external_repository_id~'^[1-9][0-9]{0,15}$' AND external_repository_id::numeric<=9007199254740991 AND requested_commit_sha~'^[0-9a-f]{40}$' AND requested_commit_sha<>repeat('0',40) AND resolved_commit_sha=requested_commit_sha AND archive_format='tar.gz' AND octet_length(sha256)=32 AND byte_length BETWEEN 1 AND 9007199254740991 AND object_ref~'^archive_[0-7][0-9A-HJKMNP-TV-Z]{25}_[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND split_part(object_ref,'_',2)=operation_id::text",
  });
}
