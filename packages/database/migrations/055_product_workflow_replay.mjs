export function up(pgm) {
  pgm.createTable("product_workflow_replay_attempts", {
    attempt_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    event_id: { type: "ulid", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
    logical_workflow_id: { type: "text", notNull: true },
    physical_workflow_id: { type: "text", notNull: true, unique: true },
    event_type: { type: "text", notNull: true },
    idempotency_sha256: { type: "bytea", notNull: true },
    attempt_number: { type: "integer", notNull: true },
    actor_id: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "product_workflow_replay_attempts",
    "product_workflow_replay_attempts_idempotency_key",
    { unique: ["organization_id", "operation_id", "idempotency_sha256"] },
  );
  pgm.addConstraint(
    "product_workflow_replay_attempts",
    "product_workflow_replay_attempts_identity_key",
    {
      unique: [
        "attempt_id",
        "logical_workflow_id",
        "event_id",
        "organization_id",
        "project_id",
        "environment_id",
        "operation_id",
        "billing_epoch_id",
        "event_type",
      ],
    },
  );
  pgm.addConstraint(
    "product_workflow_replay_attempts",
    "product_workflow_replay_attempts_failure_identity_key",
    {
      unique: ["attempt_id", "organization_id", "operation_id", "physical_workflow_id", "actor_id"],
    },
  );
  pgm.addConstraint("product_workflow_replay_attempts", "product_workflow_replay_attempts_shape", {
    check: `event_type IN ('SourceLinkRequestedV1','ProjectDeletionRequestedV1')
      AND octet_length(idempotency_sha256)=32 AND attempt_number BETWEEN 1 AND 5
      AND logical_workflow_id=btrim(logical_workflow_id)
      AND length(logical_workflow_id) BETWEEN 1 AND 255
      AND physical_workflow_id=btrim(physical_workflow_id)
      AND length(physical_workflow_id) BETWEEN 1 AND 255
      AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
  });
  pgm.createTrigger(
    "product_workflow_replay_attempts",
    "product_workflow_replay_attempts_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );

  pgm.createTable("product_workflow_replay_failures", {
    failure_id: { type: "ulid", primaryKey: true },
    attempt_id: { type: "ulid", notNull: true, unique: true },
    organization_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    physical_workflow_id: { type: "text", notNull: true },
    terminal_status: { type: "text", notNull: true },
    evidence_sha256: { type: "bytea", notNull: true },
    actor_id: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("product_workflow_replay_failures", "product_workflow_replay_failures_shape", {
    check: `terminal_status IN ('errored','terminated') AND octet_length(evidence_sha256)=32
      AND physical_workflow_id=btrim(physical_workflow_id)
      AND length(physical_workflow_id) BETWEEN 1 AND 255
      AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
  });
  pgm.addConstraint(
    "product_workflow_replay_failures",
    "product_workflow_replay_failures_attempt_fkey",
    {
      foreignKeys: {
        columns: [
          "attempt_id",
          "organization_id",
          "operation_id",
          "physical_workflow_id",
          "actor_id",
        ],
        references:
          "product_workflow_replay_attempts (attempt_id, organization_id, operation_id, physical_workflow_id, actor_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.createTrigger(
    "product_workflow_replay_failures",
    "product_workflow_replay_failures_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );

  pgm.addColumn("product_workflow_runs", {
    active_replay_attempt_id: { type: "ulid" },
  });
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_active_replay_attempt_fkey", {
    foreignKeys: {
      columns: [
        "active_replay_attempt_id",
        "workflow_id",
        "event_id",
        "organization_id",
        "project_id",
        "environment_id",
        "operation_id",
        "billing_epoch_id",
        "event_type",
      ],
      references:
        "product_workflow_replay_attempts (attempt_id, logical_workflow_id, event_id, organization_id, project_id, environment_id, operation_id, billing_epoch_id, event_type)",
      onDelete: "RESTRICT",
    },
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM product_workflow_replay_attempts)
      OR EXISTS (SELECT 1 FROM product_workflow_replay_failures) THEN
      RAISE EXCEPTION 'product Workflow replay evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropConstraint("product_workflow_runs", "product_workflow_runs_active_replay_attempt_fkey");
  pgm.dropColumn("product_workflow_runs", "active_replay_attempt_id");
  pgm.dropTable("product_workflow_replay_failures");
  pgm.dropTable("product_workflow_replay_attempts");
}
