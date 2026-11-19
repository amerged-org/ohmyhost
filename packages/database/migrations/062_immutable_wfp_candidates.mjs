function appendOnly(pgm, table) {
  pgm.createTrigger(table, `${table}_append_only`, {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function up(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM wfp_publish_receipts) THEN
      RAISE EXCEPTION 'immutable WFP candidate cutover requires fresh v6 runtime evidence; v5 receipts cannot be inferred or rewritten'
        USING ERRCODE='23514';
    END IF;
  END $$`);

  pgm.createTable("wfp_candidate_receipts", {
    candidate_receipt_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    product_deployment_id: { type: "ulid", notNull: true },
    artifact_id: { type: "ulid", notNull: true },
    dispatch_namespace: { type: "text", notNull: true },
    immutable_script_name: { type: "text", notNull: true },
    artifact_sha256: { type: "bytea", notNull: true },
    provider_tag: { type: "text", notNull: true },
    build_reused: { type: "boolean", notNull: true },
    staged_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_scope_key", {
    unique: ["organization_id", "project_id", "candidate_receipt_id"],
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_cleanup_scope_key", {
    unique: ["organization_id", "project_id", "candidate_receipt_id", "operation_id"],
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_runtime_scope_key", {
    unique: [
      "organization_id",
      "project_id",
      "environment_id",
      "candidate_receipt_id",
      "operation_id",
      "product_deployment_id",
    ],
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_deployment_key", {
    unique: ["organization_id", "project_id", "product_deployment_id"],
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_provider_identity_key", {
    unique: ["dispatch_namespace", "immutable_script_name", "provider_tag"],
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_deployment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id", "product_deployment_id"],
      references: "deployments (organization_id, project_id, operation_id, deployment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_artifact_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "artifact_id"],
      references: "build_artifacts (organization_id, project_id, artifact_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("wfp_candidate_receipts", "wfp_candidate_receipts_shape_check", {
    check: `length(dispatch_namespace) BETWEEN 1 AND 64
      AND immutable_script_name~'^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$'
      AND length(immutable_script_name)<=63
      AND octet_length(artifact_sha256)=32
      AND provider_tag=btrim(provider_tag) AND length(provider_tag) BETWEEN 1 AND 255`,
  });
  appendOnly(pgm, "wfp_candidate_receipts");

  pgm.createTable("wfp_candidate_cleanup_requests", {
    cleanup_request_id: { type: "ulid", primaryKey: true },
    candidate_receipt_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    reason: { type: "text", notNull: true },
    requested_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "wfp_candidate_cleanup_requests",
    "wfp_candidate_cleanup_requests_candidate_key",
    { unique: ["candidate_receipt_id"] },
  );
  pgm.addConstraint(
    "wfp_candidate_cleanup_requests",
    "wfp_candidate_cleanup_requests_candidate_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "candidate_receipt_id", "operation_id"],
        references:
          "wfp_candidate_receipts (organization_id, project_id, candidate_receipt_id, operation_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_candidate_cleanup_requests",
    "wfp_candidate_cleanup_requests_operation_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "operation_id"],
        references: "operations (organization_id, project_id, operation_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_candidate_cleanup_requests",
    "wfp_candidate_cleanup_requests_shape_check",
    { check: "reason IN ('superseded','failed','compensate')" },
  );
  appendOnly(pgm, "wfp_candidate_cleanup_requests");

  pgm.createTable("wfp_candidate_cleanup_resource_expectations", {
    cleanup_request_id: { type: "ulid", notNull: true },
    candidate_receipt_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    provider: { type: "text", notNull: true },
    resource_kind: { type: "text", notNull: true },
    resource_identity_sha256: { type: "bytea", notNull: true },
  });
  pgm.addConstraint(
    "wfp_candidate_cleanup_resource_expectations",
    "wfp_candidate_cleanup_resource_expectations_pkey",
    { primaryKey: ["cleanup_request_id", "provider", "resource_kind", "resource_identity_sha256"] },
  );
  pgm.addConstraint(
    "wfp_candidate_cleanup_resource_expectations",
    "wfp_candidate_cleanup_resource_expectations_candidate_key",
    {
      unique: [
        "cleanup_request_id",
        "candidate_receipt_id",
        "organization_id",
        "project_id",
        "operation_id",
        "provider",
        "resource_kind",
        "resource_identity_sha256",
      ],
    },
  );
  pgm.addConstraint(
    "wfp_candidate_cleanup_resource_expectations",
    "wfp_candidate_cleanup_resource_expectations_request_fkey",
    {
      foreignKeys: {
        columns: ["cleanup_request_id"],
        references: "wfp_candidate_cleanup_requests (cleanup_request_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_candidate_cleanup_resource_expectations",
    "wfp_candidate_cleanup_resource_expectations_candidate_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "candidate_receipt_id", "operation_id"],
        references:
          "wfp_candidate_receipts (organization_id, project_id, candidate_receipt_id, operation_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_candidate_cleanup_resource_expectations",
    "wfp_candidate_cleanup_resource_expectations_shape_check",
    {
      check: `provider='aws' AND resource_kind IN ('source-archive','build-artifact')
        AND octet_length(resource_identity_sha256)=32`,
    },
  );
  appendOnly(pgm, "wfp_candidate_cleanup_resource_expectations");

  pgm.createTable("wfp_candidate_cleanup_claims", {
    candidate_receipt_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    attempt_number: { type: "integer", notNull: true },
    claimed_at: { type: "timestamptz", notNull: true },
    lease_expires_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("wfp_candidate_cleanup_claims", "wfp_candidate_cleanup_claims_candidate_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "candidate_receipt_id"],
      references: "wfp_candidate_receipts (organization_id, project_id, candidate_receipt_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("wfp_candidate_cleanup_claims", "wfp_candidate_cleanup_claims_claim_key", {
    unique: ["claim_id"],
  });
  pgm.addConstraint("wfp_candidate_cleanup_claims", "wfp_candidate_cleanup_claims_shape_check", {
    check: "attempt_number>0 AND lease_expires_at>claimed_at",
  });

  pgm.createTable("wfp_candidate_cleanup_receipts", {
    cleanup_receipt_id: { type: "ulid", primaryKey: true },
    candidate_receipt_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    outcome: { type: "text", notNull: true },
    compensated_target_script_name: { type: "text" },
    gateway_version_id: { type: "text" },
    gateway_deployment_id: { type: "text" },
    observed_provider_tag: { type: "text", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "wfp_candidate_cleanup_receipts",
    "wfp_candidate_cleanup_receipts_candidate_key",
    {
      unique: ["candidate_receipt_id"],
    },
  );
  pgm.addConstraint(
    "wfp_candidate_cleanup_receipts",
    "wfp_candidate_cleanup_receipts_candidate_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "candidate_receipt_id"],
        references: "wfp_candidate_receipts (organization_id, project_id, candidate_receipt_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_candidate_cleanup_receipts",
    "wfp_candidate_cleanup_receipts_shape_check",
    {
      check: `outcome IN ('removed','not_found')
      AND observed_provider_tag=btrim(observed_provider_tag)
      AND length(observed_provider_tag) BETWEEN 1 AND 255
      AND ((compensated_target_script_name IS NULL AND gateway_version_id IS NULL AND gateway_deployment_id IS NULL)
        OR (compensated_target_script_name~'^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$'
          AND gateway_version_id=btrim(gateway_version_id) AND length(gateway_version_id) BETWEEN 1 AND 255
          AND gateway_deployment_id=btrim(gateway_deployment_id) AND length(gateway_deployment_id) BETWEEN 1 AND 255))`,
    },
  );
  appendOnly(pgm, "wfp_candidate_cleanup_receipts");

  pgm.createTable("wfp_candidate_operation_cleanup_receipts", {
    operation_cleanup_receipt_id: { type: "ulid", primaryKey: true },
    cleanup_request_id: { type: "ulid", notNull: true },
    candidate_receipt_id: { type: "ulid", notNull: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    provider: { type: "text", notNull: true },
    resource_kind: { type: "text", notNull: true },
    resource_identity_sha256: { type: "bytea", notNull: true },
    outcome: { type: "text", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "wfp_candidate_operation_cleanup_receipts",
    "wfp_candidate_operation_cleanup_receipts_identity_key",
    {
      unique: ["cleanup_request_id", "provider", "resource_kind", "resource_identity_sha256"],
    },
  );
  pgm.addConstraint(
    "wfp_candidate_operation_cleanup_receipts",
    "wfp_candidate_operation_cleanup_receipts_expectation_fkey",
    {
      foreignKeys: {
        columns: [
          "cleanup_request_id",
          "candidate_receipt_id",
          "organization_id",
          "project_id",
          "operation_id",
          "provider",
          "resource_kind",
          "resource_identity_sha256",
        ],
        references:
          "wfp_candidate_cleanup_resource_expectations (cleanup_request_id, candidate_receipt_id, organization_id, project_id, operation_id, provider, resource_kind, resource_identity_sha256)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_candidate_operation_cleanup_receipts",
    "wfp_candidate_operation_cleanup_receipts_shape_check",
    {
      check: `provider='aws'
        AND resource_kind IN ('source-archive','build-artifact')
        AND octet_length(resource_identity_sha256)=32
        AND outcome IN ('removed','not_found')`,
    },
  );
  appendOnly(pgm, "wfp_candidate_operation_cleanup_receipts");

  pgm.dropConstraint("wfp_publish_receipts", "wfp_publish_receipts_gateway_shape_check");
  pgm.addColumns("wfp_publish_receipts", {
    candidate_receipt_id: { type: "ulid", notNull: true },
    product_deployment_id: { type: "ulid", notNull: true },
    gateway_version_id: { type: "text", notNull: true },
    gateway_deployment_id: { type: "text", notNull: true },
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_candidate_key", {
    unique: ["candidate_receipt_id"],
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_candidate_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "candidate_receipt_id"],
      references: "wfp_candidate_receipts (organization_id, project_id, candidate_receipt_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_product_deployment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "product_deployment_id"],
      references: "deployments (organization_id, project_id, deployment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_gateway_shape_check", {
    check: `gateway_contract_version='ohmyhost.project-gateway/v6'
      AND gateway_script_name IS NOT NULL
      AND gateway_target_script_name IS NOT NULL
      AND gateway_workers_dev_subdomain IS NOT NULL
      AND gateway_provider_tag IS NOT NULL
      AND gateway_module_sha256 IS NOT NULL
      AND gateway_egress_policy_sha256 IS NOT NULL
      AND gateway_public_origin IS NOT NULL
      AND gateway_compatibility_date IS NOT NULL
      AND gateway_observed_at IS NOT NULL
      AND gateway_target_script_name=script_name
      AND script_name~'^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$'
      AND gateway_workers_dev_subdomain~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
      AND octet_length(gateway_provider_tag)=32
      AND octet_length(gateway_module_sha256)=32
      AND octet_length(gateway_egress_policy_sha256)=32
      AND (gateway_dev_access_service IS NULL OR gateway_dev_access_service~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
      AND (gateway_dev_access_entrypoint IS NULL OR gateway_dev_access_entrypoint='DevAccessService')
      AND (gateway_dev_access_key_id IS NULL OR octet_length(gateway_dev_access_key_id)=32)
      AND (gateway_dev_access_public_key_sha256 IS NULL OR octet_length(gateway_dev_access_public_key_sha256)=32)
      AND gateway_public_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev'
      AND deployment_url=gateway_public_origin
      AND gateway_compatibility_date>='2024-09-23'::date
      AND gateway_version_id=btrim(gateway_version_id) AND length(gateway_version_id) BETWEEN 1 AND 255
      AND gateway_deployment_id=btrim(gateway_deployment_id) AND length(gateway_deployment_id) BETWEEN 1 AND 255`,
  });

  pgm.createTable("wfp_rollback_activation_receipts", {
    rollback_activation_receipt_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    rollback_deployment_id: { type: "ulid", notNull: true },
    target_deployment_id: { type: "ulid", notNull: true },
    target_revision_id: { type: "ulid", notNull: true },
    candidate_receipt_id: { type: "ulid", notNull: true },
    wfp_receipt_id: { type: "ulid", notNull: true },
    gateway_version_id: { type: "text", notNull: true },
    gateway_deployment_id: { type: "text", notNull: true },
    activated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "wfp_rollback_activation_receipts",
    "wfp_rollback_activation_receipts_operation_key",
    { unique: ["organization_id", "project_id", "operation_id"] },
  );
  pgm.addConstraint(
    "wfp_rollback_activation_receipts",
    "wfp_rollback_activation_receipts_environment_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "environment_id"],
        references: "environments (organization_id, project_id, environment_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_rollback_activation_receipts",
    "wfp_rollback_activation_receipts_operation_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "operation_id"],
        references: "operations (organization_id, project_id, operation_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_rollback_activation_receipts",
    "wfp_rollback_activation_receipts_rollback_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "rollback_deployment_id"],
        references: "deployments (organization_id, project_id, deployment_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_rollback_activation_receipts",
    "wfp_rollback_activation_receipts_target_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "target_deployment_id", "target_revision_id"],
        references:
          "deployment_revisions (organization_id, project_id, deployment_id, revision_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_rollback_activation_receipts",
    "wfp_rollback_activation_receipts_candidate_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "candidate_receipt_id"],
        references: "wfp_candidate_receipts (organization_id, project_id, candidate_receipt_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_rollback_activation_receipts",
    "wfp_rollback_activation_receipts_wfp_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "wfp_receipt_id"],
        references: "wfp_publish_receipts (organization_id, project_id, wfp_receipt_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "wfp_rollback_activation_receipts",
    "wfp_rollback_activation_receipts_shape_check",
    {
      check: `gateway_version_id=btrim(gateway_version_id) AND length(gateway_version_id) BETWEEN 1 AND 255
        AND gateway_deployment_id=btrim(gateway_deployment_id) AND length(gateway_deployment_id) BETWEEN 1 AND 255`,
    },
  );
  appendOnly(pgm, "wfp_rollback_activation_receipts");

  pgm.createTable("runtime_secret_delivery_stages", {
    stage_receipt_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    product_deployment_id: { type: "ulid", notNull: true },
    candidate_receipt_id: { type: "ulid", notNull: true },
    lease_id: { type: "ulid", notNull: true },
    generation: { type: "bigint", notNull: true },
    release_sequence: { type: "bigint", notNull: true },
    trigger: { type: "text", notNull: true },
    provider_tag: { type: "text", notNull: true },
    applied_secret_names: { type: "text[]", notNull: true },
    manifest_sha256: { type: "bytea", notNull: true },
    manifest_secret_count: { type: "integer", notNull: true },
    staged_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("runtime_secret_delivery_stages", "runtime_secret_delivery_stages_lease_key", {
    unique: ["lease_id"],
  });
  pgm.addConstraint(
    "runtime_secret_delivery_stages",
    "runtime_secret_delivery_stages_candidate_fkey",
    {
      foreignKeys: {
        columns: [
          "organization_id",
          "project_id",
          "environment_id",
          "candidate_receipt_id",
          "operation_id",
          "product_deployment_id",
        ],
        references:
          "wfp_candidate_receipts (organization_id, project_id, environment_id, candidate_receipt_id, operation_id, product_deployment_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "runtime_secret_delivery_stages",
    "runtime_secret_delivery_stages_shape_check",
    {
      check: `generation>=0 AND release_sequence>0
      AND trigger IN ('deploy','rollback','promotion','reconcile')
      AND provider_tag~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
      AND octet_length(manifest_sha256)=32
      AND manifest_secret_count=cardinality(applied_secret_names)
      AND manifest_secret_count BETWEEN 0 AND 100`,
    },
  );
  appendOnly(pgm, "runtime_secret_delivery_stages");
  pgm.createTable("runtime_secret_delivery_stage_activations", {
    activation_receipt_id: { type: "ulid", primaryKey: true },
    stage_receipt_id: { type: "ulid", notNull: true, unique: true },
    gateway_version_id: { type: "text", notNull: true },
    gateway_deployment_id: { type: "text", notNull: true },
    activated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "runtime_secret_delivery_stage_activations",
    "runtime_secret_delivery_stage_activations_stage_fkey",
    {
      foreignKeys: {
        columns: ["stage_receipt_id"],
        references: "runtime_secret_delivery_stages",
        onDelete: "RESTRICT",
      },
    },
  );
  appendOnly(pgm, "runtime_secret_delivery_stage_activations");
  pgm.createTable("runtime_secret_delivery_stage_compensations", {
    compensation_receipt_id: { type: "ulid", primaryKey: true },
    stage_receipt_id: { type: "ulid", notNull: true, unique: true },
    failure_code: { type: "text", notNull: true },
    compensated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "runtime_secret_delivery_stage_compensations",
    "runtime_secret_delivery_stage_compensations_stage_fkey",
    {
      foreignKeys: {
        columns: ["stage_receipt_id"],
        references: "runtime_secret_delivery_stages",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "runtime_secret_delivery_stage_compensations",
    "runtime_secret_delivery_stage_compensations_code_check",
    {
      check: "failure_code~'^[A-Z][A-Z0-9_]{0,63}$'",
    },
  );
  appendOnly(pgm, "runtime_secret_delivery_stage_compensations");

  pgm.dropConstraint("github_push_deployments", "github_push_deployments_shape_check");
  pgm.addConstraint("github_push_deployments", "github_push_deployments_shape_check", {
    check: `config_generation>0 AND sequence>0
      AND delivery_guid~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND github_installation_id~'^[1-9][0-9]{0,19}$'
      AND external_repository_id~'^[1-9][0-9]{0,15}$'
      AND branch_ref~'^refs/heads/' AND commit_sha~'^[0-9a-f]{40}$'
      AND commit_sha<>repeat('0',40)
      AND state IN ('reserved','queued','running','cleanup_pending','superseded','failed','active','reconciliation_required')
      AND ((state='reserved' AND operation_id IS NULL) OR state='superseded'
        OR (state NOT IN ('reserved','superseded') AND operation_id IS NOT NULL))
      AND ((state='cleanup_pending' AND superseded_by_id IS NOT NULL AND cleanup_required)
        OR (state='superseded' AND superseded_by_id IS NOT NULL AND NOT cleanup_required)
        OR (state NOT IN ('cleanup_pending','superseded') AND superseded_by_id IS NULL AND NOT cleanup_required))
      AND updated_at>=created_at`,
  });

  pgm.sql(`
    CREATE FUNCTION require_exact_wfp_candidate() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      environment_name text;
      expected_artifact_sha256 bytea;
      expected_operation_id ulid;
    BEGIN
      SELECT environment.name,artifact.artifact_sha256,deployment.operation_id
        INTO STRICT environment_name,expected_artifact_sha256,expected_operation_id
      FROM environments environment
      INNER JOIN build_artifacts artifact
        ON artifact.organization_id=NEW.organization_id AND artifact.project_id=NEW.project_id
       AND artifact.artifact_id=NEW.artifact_id
      INNER JOIN deployments deployment
        ON deployment.organization_id=NEW.organization_id AND deployment.project_id=NEW.project_id
       AND deployment.deployment_id=NEW.product_deployment_id
      WHERE environment.organization_id=NEW.organization_id
        AND environment.project_id=NEW.project_id AND environment.environment_id=NEW.environment_id;
      IF expected_operation_id<>NEW.operation_id
        OR expected_artifact_sha256<>NEW.artifact_sha256
        OR NEW.immutable_script_name<>'p-'||lower(NEW.project_id::text)||'-'||environment_name||'-'||lower(NEW.product_deployment_id::text) THEN
        RAISE EXCEPTION 'WFP candidate does not match its immutable deployment identity'
          USING ERRCODE='23514', CONSTRAINT='wfp_candidate_receipts_exact_identity';
      END IF;
      RETURN NEW;
    EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'WFP candidate requires one exact scoped deployment identity'
        USING ERRCODE='23514', CONSTRAINT='wfp_candidate_receipts_exact_identity';
    END;
    $$;
    CREATE TRIGGER wfp_candidate_receipts_exact_identity
      BEFORE INSERT ON wfp_candidate_receipts FOR EACH ROW EXECUTE FUNCTION require_exact_wfp_candidate();

    CREATE OR REPLACE FUNCTION require_project_gateway_receipt_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      project_handle text;
      environment_name text;
      candidate wfp_candidate_receipts%ROWTYPE;
    BEGIN
      SELECT project.handle,environment.name INTO STRICT project_handle,environment_name
      FROM projects project INNER JOIN environments environment
        ON environment.project_id=project.project_id AND environment.environment_id=NEW.environment_id
      WHERE project.project_id=NEW.project_id;
      SELECT * INTO STRICT candidate FROM wfp_candidate_receipts
      WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
        AND candidate_receipt_id=NEW.candidate_receipt_id;
      IF EXISTS (SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup
                 WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)
        OR NEW.gateway_contract_version<>'ohmyhost.project-gateway/v6'
        OR NEW.product_deployment_id<>candidate.product_deployment_id
        OR NEW.environment_id<>candidate.environment_id
        OR NEW.artifact_id<>candidate.artifact_id
        OR NEW.dispatch_namespace<>candidate.dispatch_namespace
        OR NEW.script_name<>candidate.immutable_script_name
        OR NEW.provider_version_id<>candidate.provider_tag
        OR NEW.published_at<candidate.staged_at
        OR NEW.gateway_script_name<>(CASE environment_name WHEN 'prod' THEN project_handle WHEN 'dev' THEN 'dev-'||project_handle END)
        OR NEW.gateway_target_script_name<>candidate.immutable_script_name
        OR NEW.gateway_public_origin<>'https://'||NEW.gateway_script_name||'.'||NEW.gateway_workers_dev_subdomain||'.workers.dev'
        OR NEW.deployment_url<>NEW.gateway_public_origin
        OR (environment_name='dev' AND (NEW.gateway_dev_access_service IS NULL
          OR NEW.gateway_dev_access_entrypoint IS DISTINCT FROM 'DevAccessService'
          OR NEW.gateway_dev_access_key_id IS NULL
          OR NEW.gateway_dev_access_public_key_sha256 IS NULL
          OR NEW.gateway_dev_access_key_id<>NEW.gateway_dev_access_public_key_sha256))
        OR (environment_name='prod' AND (NEW.gateway_dev_access_service IS NOT NULL
          OR NEW.gateway_dev_access_entrypoint IS NOT NULL OR NEW.gateway_dev_access_key_id IS NOT NULL
          OR NEW.gateway_dev_access_public_key_sha256 IS NOT NULL)) THEN
        RAISE EXCEPTION 'WFP publish receipt does not match its immutable candidate and gateway receipt'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
      END IF;
      RETURN NEW;
    EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'WFP publish receipt requires one exact immutable candidate'
        USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
    END;
    $$;

    CREATE FUNCTION reject_cleaned_or_final_candidate() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM wfp_publish_receipts published
                 WHERE published.candidate_receipt_id=NEW.candidate_receipt_id) THEN
        RAISE EXCEPTION 'published WFP candidate cannot be cleaned'
          USING ERRCODE='23514', CONSTRAINT='wfp_candidate_cleanup_receipts_unpublished_check';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER wfp_candidate_cleanup_receipts_unpublished_check
      BEFORE INSERT ON wfp_candidate_cleanup_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_cleaned_or_final_candidate();

    CREATE FUNCTION require_candidate_cleanup_before_terminal_push() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.state='superseded' AND NOT NEW.cleanup_required
        AND NOT EXISTS (
          SELECT 1 FROM wfp_candidate_receipts candidate
          INNER JOIN wfp_candidate_cleanup_receipts cleanup
            ON cleanup.candidate_receipt_id=candidate.candidate_receipt_id
          WHERE candidate.organization_id=NEW.organization_id
            AND candidate.project_id=NEW.project_id AND candidate.operation_id=NEW.operation_id
            AND NOT EXISTS (
              SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected
              WHERE expected.candidate_receipt_id=candidate.candidate_receipt_id
                AND NOT EXISTS (
                  SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual
                  WHERE actual.cleanup_request_id=expected.cleanup_request_id
                    AND actual.provider=expected.provider AND actual.resource_kind=expected.resource_kind
                    AND actual.resource_identity_sha256=expected.resource_identity_sha256
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual
              WHERE actual.candidate_receipt_id=candidate.candidate_receipt_id
                AND NOT EXISTS (
                  SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected
                  WHERE expected.cleanup_request_id=actual.cleanup_request_id
                    AND expected.provider=actual.provider AND expected.resource_kind=actual.resource_kind
                    AND expected.resource_identity_sha256=actual.resource_identity_sha256
                )
            )
        ) THEN
        RAISE EXCEPTION 'superseded push requires durable WFP candidate cleanup evidence'
          USING ERRCODE='23514', CONSTRAINT='github_push_deployments_cleanup_receipt_check';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER github_push_deployments_cleanup_receipt_check
      BEFORE UPDATE ON github_push_deployments
      FOR EACH ROW EXECUTE FUNCTION require_candidate_cleanup_before_terminal_push();

    CREATE FUNCTION reject_runtime_secret_stage_activation_conflict() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM runtime_secret_delivery_stage_compensations
                 WHERE stage_receipt_id=NEW.stage_receipt_id) THEN
        RAISE EXCEPTION 'compensated runtime secret stage cannot activate'
          USING ERRCODE='23514', CONSTRAINT='runtime_secret_delivery_stage_terminal_check';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER runtime_secret_delivery_stage_activation_terminal_check
      BEFORE INSERT ON runtime_secret_delivery_stage_activations
      FOR EACH ROW EXECUTE FUNCTION reject_runtime_secret_stage_activation_conflict();
    CREATE FUNCTION reject_runtime_secret_stage_compensation_conflict() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM runtime_secret_delivery_stage_activations
                 WHERE stage_receipt_id=NEW.stage_receipt_id) THEN
        RAISE EXCEPTION 'activated runtime secret stage cannot compensate'
          USING ERRCODE='23514', CONSTRAINT='runtime_secret_delivery_stage_terminal_check';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER runtime_secret_delivery_stage_compensation_terminal_check
      BEFORE INSERT ON runtime_secret_delivery_stage_compensations
      FOR EACH ROW EXECUTE FUNCTION reject_runtime_secret_stage_compensation_conflict();
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM wfp_candidate_receipts)
      OR EXISTS (SELECT 1 FROM wfp_candidate_cleanup_receipts)
      OR EXISTS (SELECT 1 FROM wfp_publish_receipts) THEN
      RAISE EXCEPTION 'immutable WFP candidate evidence prevents a lossless downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTrigger("github_push_deployments", "github_push_deployments_cleanup_receipt_check");
  pgm.sql("DROP FUNCTION require_candidate_cleanup_before_terminal_push()");
  pgm.dropTrigger(
    "runtime_secret_delivery_stage_activations",
    "runtime_secret_delivery_stage_activation_terminal_check",
  );
  pgm.dropTrigger(
    "runtime_secret_delivery_stage_compensations",
    "runtime_secret_delivery_stage_compensation_terminal_check",
  );
  pgm.sql("DROP FUNCTION reject_runtime_secret_stage_activation_conflict()");
  pgm.sql("DROP FUNCTION reject_runtime_secret_stage_compensation_conflict()");
  pgm.dropConstraint("github_push_deployments", "github_push_deployments_shape_check");
  pgm.addConstraint("github_push_deployments", "github_push_deployments_shape_check", {
    check: `config_generation>0 AND sequence>0
      AND delivery_guid~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND github_installation_id~'^[1-9][0-9]{0,19}$'
      AND external_repository_id~'^[1-9][0-9]{0,15}$'
      AND branch_ref~'^refs/heads/' AND commit_sha~'^[0-9a-f]{40}$'
      AND commit_sha<>repeat('0',40)
      AND state IN ('reserved','queued','running','superseded','failed','active','reconciliation_required')
      AND ((state='reserved' AND operation_id IS NULL) OR state='superseded'
        OR (state NOT IN ('reserved','superseded') AND operation_id IS NOT NULL))
      AND ((state='superseded' AND superseded_by_id IS NOT NULL AND cleanup_required)
        OR (state<>'superseded' AND superseded_by_id IS NULL))
      AND updated_at>=created_at`,
  });
  pgm.dropTrigger(
    "wfp_candidate_cleanup_receipts",
    "wfp_candidate_cleanup_receipts_unpublished_check",
  );
  pgm.sql("DROP FUNCTION reject_cleaned_or_final_candidate()");
  pgm.dropTrigger("wfp_candidate_receipts", "wfp_candidate_receipts_exact_identity");
  pgm.sql("DROP FUNCTION require_exact_wfp_candidate()");
  pgm.dropTable("runtime_secret_delivery_stage_compensations");
  pgm.dropTable("runtime_secret_delivery_stage_activations");
  pgm.dropTable("runtime_secret_delivery_stages");
  pgm.dropTable("wfp_rollback_activation_receipts");
  pgm.dropConstraint("wfp_publish_receipts", "wfp_publish_receipts_gateway_shape_check");
  pgm.dropConstraint("wfp_publish_receipts", "wfp_publish_receipts_product_deployment_fkey");
  pgm.dropConstraint("wfp_publish_receipts", "wfp_publish_receipts_candidate_fkey");
  pgm.dropConstraint("wfp_publish_receipts", "wfp_publish_receipts_candidate_key");
  pgm.dropColumns("wfp_publish_receipts", [
    "candidate_receipt_id",
    "product_deployment_id",
    "gateway_version_id",
    "gateway_deployment_id",
  ]);
  pgm.addConstraint("wfp_publish_receipts", "wfp_publish_receipts_gateway_shape_check", {
    check: `gateway_contract_version='ohmyhost.project-gateway/v5'
      AND gateway_target_script_name=script_name
      AND octet_length(gateway_provider_tag)=32
      AND octet_length(gateway_module_sha256)=32
      AND octet_length(gateway_egress_policy_sha256)=32
      AND gateway_public_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev'
      AND deployment_url=gateway_public_origin`,
  });
  pgm.sql(`CREATE OR REPLACE FUNCTION require_project_gateway_receipt_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.gateway_contract_version IS NULL THEN
        RAISE EXCEPTION 'new WFP receipts require project gateway evidence'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_insert_required';
      END IF;
      RETURN NEW;
    END $$`);
  pgm.dropTable("wfp_candidate_cleanup_receipts");
  pgm.dropTable("wfp_candidate_operation_cleanup_receipts");
  pgm.dropTable("wfp_candidate_cleanup_claims");
  pgm.dropTable("wfp_candidate_cleanup_resource_expectations");
  pgm.dropTable("wfp_candidate_cleanup_requests");
  pgm.dropTable("wfp_candidate_receipts");
}
