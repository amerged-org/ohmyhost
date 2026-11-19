const OBSERVATION_STATES =
  "('unknown','absent','ready','succeeded','running','failed','cleanup_failable')";

export function up(pgm) {
  pgm.createTable("product_provider_mutation_observations", {
    observation_id: { type: "ulid", primaryKey: true },
    claim_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    event_id: { type: "ulid", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
    logical_workflow_id: { type: "text", notNull: true },
    event_type: { type: "text", notNull: true },
    accepted_lifecycle_version: { type: "integer", notNull: true },
    observation_kind: { type: "text", notNull: true },
    attempt_number: { type: "integer", notNull: true },
    evidence_sha256: { type: "bytea", notNull: true },
    hint_phase: { type: "text", notNull: true },
    expected_artifact_sha256: { type: "bytea" },
    hint_provider_tag: { type: "text" },
    hint_product_deployment_id: { type: "ulid" },
    source_state: { type: "text", notNull: true },
    build_state: { type: "text", notNull: true },
    gateway_state: { type: "text", notNull: true },
    gateway_provider_tag: { type: "text" },
    gateway_observed_at: { type: "timestamptz" },
    wfp_state: { type: "text", notNull: true },
    wfp_provider_tag: { type: "text" },
    wfp_product_deployment_id: { type: "ulid" },
    wfp_artifact_sha256: { type: "bytea" },
    wfp_observed_at: { type: "timestamptz" },
    actor_id: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_attempt_key",
    { unique: ["claim_id", "attempt_number", "observation_kind"] },
  );
  pgm.addConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_full_identity_key",
    {
      unique: [
        "observation_id",
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
  pgm.sql(`CREATE FUNCTION validate_product_provider_mutation_observation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM product_provider_mutation_claims claim
        WHERE claim.claim_id=NEW.claim_id AND claim.organization_id=NEW.organization_id
          AND claim.project_id=NEW.project_id AND claim.environment_id=NEW.environment_id
          AND claim.operation_id=NEW.operation_id AND claim.event_id=NEW.event_id
          AND claim.billing_epoch_id=NEW.billing_epoch_id
          AND claim.logical_workflow_id=NEW.logical_workflow_id
          AND claim.event_type=NEW.event_type
          AND claim.accepted_lifecycle_version=NEW.accepted_lifecycle_version
        FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'provider reconciliation observation claim identity is invalid'
          USING ERRCODE='23503';
      END IF;
      RETURN NEW;
    END
  $$`);
  pgm.createTrigger(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_claim_guard",
    {
      when: "BEFORE",
      operation: "INSERT",
      level: "ROW",
      function: "validate_product_provider_mutation_observation",
    },
  );
  pgm.addConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
    {
      check: `attempt_number BETWEEN 0 AND 5
        AND observation_kind IN ('uncertainty','preflight','execution_failure')
        AND event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1')
        AND accepted_lifecycle_version>0 AND octet_length(evidence_sha256)=32
        AND hint_phase IN ('source','build','runtime-secrets','gateway','wfp')
        AND (expected_artifact_sha256 IS NULL OR octet_length(expected_artifact_sha256)=32)
        AND source_state IN ${OBSERVATION_STATES} AND build_state IN ${OBSERVATION_STATES}
        AND gateway_state IN ('unknown','absent','ready')
        AND wfp_state IN ('unknown','absent','ready')
        AND ((gateway_state='ready' AND gateway_provider_tag IS NOT NULL)
          OR (gateway_state='absent' AND gateway_provider_tag IS NULL) OR gateway_state='unknown')
        AND ((wfp_state='ready' AND wfp_provider_tag IS NOT NULL
              AND wfp_product_deployment_id IS NOT NULL AND octet_length(wfp_artifact_sha256)=32)
          OR (wfp_state='absent' AND wfp_provider_tag IS NULL
              AND wfp_product_deployment_id IS NULL AND wfp_artifact_sha256 IS NULL)
          OR wfp_state='unknown')
        AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
    },
  );
  pgm.createTrigger(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );

  pgm.createTable("product_provider_reconciliation_attempts", {
    attempt_id: { type: "ulid", primaryKey: true },
    observation_id: {
      type: "ulid",
      notNull: true,
    },
    claim_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    event_id: { type: "ulid", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
    logical_workflow_id: { type: "text", notNull: true },
    event_type: { type: "text", notNull: true },
    accepted_lifecycle_version: { type: "integer", notNull: true },
    physical_workflow_id: { type: "text", notNull: true, unique: true },
    mode: { type: "text", notNull: true },
    outcome: { type: "text", notNull: true },
    idempotency_sha256: { type: "bytea", notNull: true },
    attempt_number: { type: "integer", notNull: true },
    actor_id: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "product_provider_reconciliation_attempts",
    "product_provider_reconciliation_attempts_idempotency_key",
    { unique: ["claim_id", "idempotency_sha256"] },
  );
  pgm.addConstraint(
    "product_provider_reconciliation_attempts",
    "product_provider_reconciliation_attempts_workflow_identity_key",
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
    "product_provider_reconciliation_attempts",
    "product_provider_reconciliation_attempts_observation_fkey",
    {
      foreignKeys: {
        columns: [
          "observation_id",
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
        references:
          "product_provider_mutation_observations (observation_id, claim_id, organization_id, project_id, environment_id, operation_id, event_id, billing_epoch_id, logical_workflow_id, event_type, accepted_lifecycle_version)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "product_provider_reconciliation_attempts",
    "product_provider_reconciliation_attempts_shape_check",
    {
      check: `mode IN ('retry','abandon') AND outcome IN ('prepared','resolved_absent','unknown')
        AND ((mode='retry' AND outcome='prepared') OR (mode='abandon' AND outcome='resolved_absent')
          OR outcome='unknown')
        AND octet_length(idempotency_sha256)=32 AND attempt_number BETWEEN 1 AND 5
        AND event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1')
        AND accepted_lifecycle_version>0
        AND logical_workflow_id=btrim(logical_workflow_id) AND length(logical_workflow_id) BETWEEN 1 AND 255
        AND physical_workflow_id=btrim(physical_workflow_id) AND length(physical_workflow_id) BETWEEN 1 AND 255
        AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
    },
  );
  pgm.sql(`CREATE FUNCTION validate_product_provider_reconciliation_attempt() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM product_provider_mutation_claims claim
        WHERE claim.claim_id=NEW.claim_id AND claim.organization_id=NEW.organization_id
          AND claim.project_id=NEW.project_id AND claim.environment_id=NEW.environment_id
          AND claim.operation_id=NEW.operation_id AND claim.event_id=NEW.event_id
          AND claim.billing_epoch_id=NEW.billing_epoch_id
          AND claim.logical_workflow_id=NEW.logical_workflow_id
          AND claim.event_type=NEW.event_type
          AND claim.accepted_lifecycle_version=NEW.accepted_lifecycle_version
        FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'provider reconciliation attempt claim identity is invalid'
          USING ERRCODE='23503';
      END IF;
      RETURN NEW;
    END
  $$`);
  pgm.createTrigger(
    "product_provider_reconciliation_attempts",
    "product_provider_reconciliation_attempts_claim_guard",
    {
      when: "BEFORE",
      operation: "INSERT",
      level: "ROW",
      function: "validate_product_provider_reconciliation_attempt",
    },
  );
  pgm.addColumn("product_workflow_runs", {
    active_reconciliation_attempt_id: { type: "ulid" },
  });
  pgm.addConstraint(
    "product_workflow_runs",
    "product_workflow_runs_active_reconciliation_attempt_fkey",
    {
      foreignKeys: {
        columns: [
          "active_reconciliation_attempt_id",
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
          "product_provider_reconciliation_attempts (attempt_id, logical_workflow_id, event_id, organization_id, project_id, environment_id, operation_id, billing_epoch_id, event_type)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.createTrigger(
    "product_provider_reconciliation_attempts",
    "product_provider_reconciliation_attempts_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );

  pgm.sql(`CREATE OR REPLACE FUNCTION guard_product_provider_mutation_claim_delete() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM operations operation
        WHERE operation.organization_id=OLD.organization_id AND operation.project_id=OLD.project_id
          AND operation.operation_id=OLD.operation_id
          AND operation.state IN ('succeeded','failed')
      ) AND NOT EXISTS (
        SELECT 1 FROM product_provider_reconciliation_attempts attempt
        WHERE attempt.claim_id=OLD.claim_id AND attempt.mode='abandon'
          AND attempt.outcome='resolved_absent'
          AND attempt.organization_id=OLD.organization_id
          AND attempt.project_id=OLD.project_id
          AND attempt.environment_id=OLD.environment_id
          AND attempt.operation_id=OLD.operation_id
          AND attempt.event_id=OLD.event_id
          AND attempt.billing_epoch_id=OLD.billing_epoch_id
          AND attempt.logical_workflow_id=OLD.logical_workflow_id
          AND attempt.event_type=OLD.event_type
          AND attempt.accepted_lifecycle_version=OLD.accepted_lifecycle_version
      ) THEN
        RAISE EXCEPTION 'active product provider mutation claim cannot be deleted'
          USING ERRCODE='55000';
      END IF;
      RETURN OLD;
    END
  $$`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM product_provider_reconciliation_attempts)
      OR EXISTS (SELECT 1 FROM product_provider_mutation_observations) THEN
      RAISE EXCEPTION 'product provider reconciliation evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.sql(`CREATE OR REPLACE FUNCTION guard_product_provider_mutation_claim_delete() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM operations operation
        WHERE operation.organization_id=OLD.organization_id AND operation.project_id=OLD.project_id
          AND operation.operation_id=OLD.operation_id
          AND operation.state IN ('succeeded','failed')
      ) THEN
        RAISE EXCEPTION 'active product provider mutation claim cannot be deleted' USING ERRCODE='55000';
      END IF;
      RETURN OLD;
    END
  $$`);
  pgm.dropConstraint(
    "product_workflow_runs",
    "product_workflow_runs_active_reconciliation_attempt_fkey",
  );
  pgm.dropColumn("product_workflow_runs", "active_reconciliation_attempt_id");
  pgm.dropTable("product_provider_reconciliation_attempts");
  pgm.sql("DROP FUNCTION validate_product_provider_reconciliation_attempt()");
  pgm.dropTable("product_provider_mutation_observations");
  pgm.sql("DROP FUNCTION validate_product_provider_mutation_observation()");
}
