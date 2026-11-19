export function up(pgm) {
  pgm.createTable("product_provider_mutation_claims", {
    claim_id: { type: "ulid", notNull: true, unique: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
    event_id: { type: "ulid", notNull: true },
    logical_workflow_id: { type: "text", notNull: true },
    event_type: { type: "text", notNull: true },
    accepted_lifecycle_version: { type: "integer", notNull: true },
    claimed_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("product_provider_mutation_claims", "product_provider_mutation_claims_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint(
    "product_provider_mutation_claims",
    "product_provider_mutation_claims_full_identity_key",
    {
      unique: [
        "claim_id",
        "organization_id",
        "project_id",
        "environment_id",
        "operation_id",
        "event_id",
        "billing_epoch_id",
        "logical_workflow_id",
        "event_type",
        "accepted_lifecycle_version",
      ],
    },
  );
  pgm.addConstraint(
    "product_provider_mutation_claims",
    "product_provider_mutation_claims_intent_fkey",
    {
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
    },
  );
  pgm.addConstraint("product_workflow_runs", "product_workflow_runs_provider_claim_identity_key", {
    unique: [
      "workflow_id",
      "event_id",
      "organization_id",
      "project_id",
      "environment_id",
      "operation_id",
      "billing_epoch_id",
      "event_type",
    ],
  });
  pgm.addConstraint(
    "product_provider_mutation_claims",
    "product_provider_mutation_claims_workflow_fkey",
    {
      foreignKeys: {
        columns: [
          "logical_workflow_id",
          "event_id",
          "organization_id",
          "project_id",
          "environment_id",
          "operation_id",
          "billing_epoch_id",
          "event_type",
        ],
        references:
          "product_workflow_runs (workflow_id, event_id, organization_id, project_id, environment_id, operation_id, billing_epoch_id, event_type)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "product_provider_mutation_claims",
    "product_provider_mutation_claims_shape_check",
    {
      check: `event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1')
        AND accepted_lifecycle_version>0
        AND logical_workflow_id=btrim(logical_workflow_id)
        AND length(logical_workflow_id) BETWEEN 1 AND 255`,
    },
  );
  pgm.createTrigger(
    "product_provider_mutation_claims",
    "product_provider_mutation_claims_update_forbidden",
    {
      when: "BEFORE",
      operation: "UPDATE",
      level: "ROW",
      function: "reject_append_only_change",
    },
  );
  pgm.sql(`CREATE FUNCTION guard_product_provider_mutation_claim_delete() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM operations operation
        WHERE operation.organization_id=OLD.organization_id
          AND operation.project_id=OLD.project_id
          AND operation.operation_id=OLD.operation_id
          AND operation.state IN ('succeeded','failed')
      ) THEN
        RAISE EXCEPTION 'active product provider mutation claim cannot be deleted'
          USING ERRCODE='55000';
      END IF;
      RETURN OLD;
    END
  $$`);
  pgm.createTrigger(
    "product_provider_mutation_claims",
    "product_provider_mutation_claims_delete_guard",
    {
      when: "BEFORE",
      operation: "DELETE",
      level: "ROW",
      function: "guard_product_provider_mutation_claim_delete",
    },
  );
}

export function down(pgm) {
  pgm.sql(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM product_provider_mutation_claims) THEN
        RAISE EXCEPTION 'product provider mutation claims prevent a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
    END
  $$`);
  pgm.dropTable("product_provider_mutation_claims");
  pgm.sql("DROP FUNCTION guard_product_provider_mutation_claim_delete()");
  pgm.dropConstraint("product_workflow_runs", "product_workflow_runs_provider_claim_identity_key");
}
