export function up(pgm) {
  pgm.addColumns("product_provider_mutation_observations", {
    container_state: { type: "text", notNull: true, default: "unknown" },
    container_application_id: { type: "uuid" },
    container_product_deployment_id: { type: "ulid" },
    container_image_sha256: { type: "bytea" },
    container_health_status: { type: "smallint" },
    container_observed_at: { type: "timestamptz" },
  });
  replaceObservationPhaseConstraint(pgm, true);
  pgm.createTable("container_artifact_objects", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    kind: { type: "text", notNull: true },
    bucket_name: { type: "text", notNull: true },
    object_key: { type: "text", notNull: true },
    object_version_id: { type: "text", notNull: true },
    object_etag: { type: "text", notNull: true },
    byte_length: { type: "bigint", notNull: true },
    sha256: { type: "bytea", notNull: true },
    recorded_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("container_artifact_objects", "container_artifact_objects_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id", "kind"],
  });
  pgm.addConstraint("container_artifact_objects", "container_artifact_objects_version_key", {
    unique: ["bucket_name", "object_key", "object_version_id"],
  });
  pgm.addConstraint("container_artifact_objects", "container_artifact_objects_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("container_artifact_objects", "container_artifact_objects_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("container_artifact_objects", "container_artifact_objects_shape", {
    check: `kind IN ('rootfs_manifest','rootfs_layer','sbom','oci_bundle')
      AND bucket_name=btrim(bucket_name) AND length(bucket_name) BETWEEN 3 AND 63
      AND object_version_id=btrim(object_version_id) AND length(object_version_id) BETWEEN 1 AND 512
      AND object_etag=btrim(object_etag) AND length(object_etag) BETWEEN 1 AND 512
      AND byte_length BETWEEN 1 AND 1090519040 AND octet_length(sha256)=32
      AND object_key='runs/'||project_id::text||'/'||environment_id::text||'/'||operation_id::text||
        '/output/container/'||CASE kind
          WHEN 'rootfs_manifest' THEN 'rootfs-manifest.json'
          WHEN 'rootfs_layer' THEN 'layer.tar.gz'
          WHEN 'sbom' THEN 'sbom.cdx.json'
          ELSE 'oci-bundle.tar.gz' END`,
  });
  pgm.createTrigger("container_artifact_objects", "container_artifact_objects_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
  pgm.createTable("container_application_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    application_id: { type: "uuid", notNull: true },
    application_name: { type: "text", notNull: true },
    deployment_url: { type: "text", notNull: true },
    image_reference: { type: "text", notNull: true },
    image_digest: { type: "bytea", notNull: true },
    durable_object_namespace_id: { type: "uuid", notNull: true },
    rollout_id: { type: "uuid" },
    outcome: { type: "text", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("container_application_receipts", "container_application_receipts_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint(
    "container_application_receipts",
    "container_application_receipts_deployment_key",
    { unique: ["organization_id", "project_id", "deployment_id"] },
  );
  pgm.addConstraint(
    "container_application_receipts",
    "container_application_receipts_revision_key",
    { unique: ["organization_id", "project_id", "deployment_id", "application_id"] },
  );
  pgm.addConstraint(
    "container_application_receipts",
    "container_application_receipts_environment_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "environment_id"],
        references: "environments (organization_id, project_id, environment_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "container_application_receipts",
    "container_application_receipts_operation_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "operation_id"],
        references: "operations (organization_id, project_id, operation_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint("container_application_receipts", "container_application_receipts_shape", {
    check: `application_name='c-'||lower(project_id::text)
      AND deployment_url='https://r-'||lower(project_id::text)||'.your-omh-account.workers.dev'
      AND image_reference~'^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$'
      AND octet_length(image_digest)=32
      AND image_reference LIKE '%@sha256:'||encode(image_digest,'hex')
      AND outcome IN ('created','replayed','rollout_started')
      AND ((outcome='rollout_started')=(rollout_id IS NOT NULL))`,
  });
  pgm.createTrigger(
    "container_application_receipts",
    "container_application_receipts_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );
  pgm.alterColumn("deployment_revisions", "wfp_receipt_id", { notNull: false });
  pgm.addColumns("deployment_revisions", {
    runtime_provider: { type: "text", notNull: true, default: "wfp" },
    container_application_id: { type: "uuid" },
    container_health_status: { type: "smallint" },
    container_health_observed_at: { type: "timestamptz" },
  });
  pgm.addConstraint("deployment_revisions", "deployment_revisions_runtime_provider_check", {
    check: `(runtime_provider='wfp' AND wfp_receipt_id IS NOT NULL
              AND container_application_id IS NULL AND container_health_status IS NULL
              AND container_health_observed_at IS NULL)
      OR (runtime_provider='container' AND wfp_receipt_id IS NULL
              AND container_application_id IS NOT NULL AND container_health_status=200
              AND container_health_observed_at IS NOT NULL)`,
  });
  pgm.addConstraint("deployment_revisions", "deployment_revisions_container_scope_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "deployment_id", "container_application_id"],
      references:
        "container_application_receipts (organization_id, project_id, deployment_id, application_id)",
      onDelete: "RESTRICT",
    },
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM container_application_receipts)
    OR EXISTS (SELECT 1 FROM container_artifact_objects)
    OR EXISTS (SELECT 1 FROM product_provider_mutation_observations
      WHERE hint_phase='container' OR container_state<>'unknown'
        OR container_application_id IS NOT NULL OR container_product_deployment_id IS NOT NULL
        OR container_image_sha256 IS NOT NULL OR container_health_status IS NOT NULL
        OR container_observed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Container application evidence prevents a lossless migration downgrade'
      USING ERRCODE='23514'; END IF; END $$`);
  pgm.dropConstraint("deployment_revisions", "deployment_revisions_container_scope_fkey");
  pgm.dropConstraint("deployment_revisions", "deployment_revisions_runtime_provider_check");
  pgm.dropColumns("deployment_revisions", [
    "runtime_provider",
    "container_application_id",
    "container_health_status",
    "container_health_observed_at",
  ]);
  pgm.alterColumn("deployment_revisions", "wfp_receipt_id", { notNull: true });
  pgm.dropTable("container_application_receipts");
  pgm.dropTable("container_artifact_objects");
  replaceObservationPhaseConstraint(pgm, false);
  pgm.dropColumns("product_provider_mutation_observations", [
    "container_state",
    "container_application_id",
    "container_product_deployment_id",
    "container_image_sha256",
    "container_health_status",
    "container_observed_at",
  ]);
}

function replaceObservationPhaseConstraint(pgm, includeContainer) {
  const phases = includeContainer
    ? "'source','build','database','runtime-secrets','gateway','wfp','container'"
    : "'source','build','database','runtime-secrets','gateway','wfp'";
  pgm.dropConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
  );
  pgm.addConstraint(
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
    {
      check: `attempt_number BETWEEN 0 AND 5
        AND observation_kind IN ('uncertainty','preflight','execution_failure')
        AND event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1')
        AND accepted_lifecycle_version>0 AND octet_length(evidence_sha256)=32
        AND hint_phase IN (${phases})
        AND (expected_artifact_sha256 IS NULL OR octet_length(expected_artifact_sha256)=32)
        AND source_state IN ('unknown','absent','ready','succeeded','running','failed','cleanup_failable')
        AND build_state IN ('unknown','absent','ready','succeeded','running','failed','cleanup_failable')
        AND gateway_state IN ('unknown','absent','ready')
        AND wfp_state IN ('unknown','absent','ready')
        AND ((gateway_state='ready' AND gateway_provider_tag IS NOT NULL)
          OR (gateway_state='absent' AND gateway_provider_tag IS NULL) OR gateway_state='unknown')
        AND ((wfp_state='ready' AND wfp_provider_tag IS NOT NULL
              AND wfp_product_deployment_id IS NOT NULL AND octet_length(wfp_artifact_sha256)=32)
          OR (wfp_state='absent' AND wfp_provider_tag IS NULL
              AND wfp_product_deployment_id IS NULL AND wfp_artifact_sha256 IS NULL)
          OR wfp_state='unknown')
        ${
          includeContainer
            ? `AND container_state IN ('unknown','absent','running','ready')
        AND ((container_state='ready' AND container_application_id IS NOT NULL
              AND container_product_deployment_id IS NOT NULL
              AND octet_length(container_image_sha256)=32 AND container_health_status=200
              AND container_observed_at IS NOT NULL)
          OR (container_state='running' AND container_application_id IS NOT NULL
              AND container_product_deployment_id IS NOT NULL
              AND octet_length(container_image_sha256)=32 AND container_health_status IS NULL
              AND container_observed_at IS NOT NULL)
          OR (container_state='absent' AND container_application_id IS NULL
              AND container_product_deployment_id IS NULL AND container_image_sha256 IS NULL
              AND container_health_status IS NULL)
          OR (container_state='unknown' AND container_health_status IS NULL
              AND ((container_application_id IS NULL
                    AND container_product_deployment_id IS NULL AND container_image_sha256 IS NULL)
                OR (container_application_id IS NOT NULL
                    AND container_product_deployment_id IS NOT NULL
                    AND octet_length(container_image_sha256)=32))))`
            : ""
        }
        AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`,
    },
  );
}
