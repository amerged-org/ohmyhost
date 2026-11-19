// D250: the platform offers no customer container runtime. Every table, column, constraint,
// trigger and function that only existed for it is removed (migrations 034-038, 051 and 052,
// with the restatements in 040, 043, 060 and 120). Every environment runs on Workers for
// Platforms, so the runtime provider discriminator disappears from the schema as well.
import {
  containerShape,
  frameworkConstraint as previousFrameworkConstraint,
} from "./120_functions_runtime_and_cron_schedules.mjs";

const FRAMEWORK_CONSTRAINT = "deployment_plans_framework_plan_check";
export const frameworkConstraint = previousFrameworkConstraint.replace(` OR ${containerShape}`, "");

const UUID_V4 = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const CONTAINER_OBSERVATION_SHAPE = `AND container_state IN ('unknown','absent','running','ready')
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
              AND octet_length(container_image_sha256)=32))))`;

const observationShape = (includeContainer) => `attempt_number>=0 AND attempt_number<=32
  AND observation_kind IN ('uncertainty','preflight','execution_failure')
  AND event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1')
  AND accepted_lifecycle_version>0 AND octet_length(evidence_sha256)=32
  AND hint_phase IN ('source','build','database','runtime-secrets','storage','gateway','wfp'${includeContainer ? ",'container'" : ""})
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
  ${includeContainer ? CONTAINER_OBSERVATION_SHAPE : ""}
  AND actor_id=btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255`;

const capabilityCheck = (includeContainer) =>
  `capability IN ('static-hosting', 'edge-runtime', ${includeContainer ? "'container-runtime', " : ""}'build', 'database', 'domain', 'mail', 'usage')`;

const secretLeaseCheck = (
  includeProvider,
) => `(active_lease_id IS NULL AND claimed_generation IS NULL AND claimed_trigger IS NULL
    ${includeProvider ? "AND claimed_runtime_provider IS NULL " : ""}AND claimed_at IS NULL AND lease_expires_at IS NULL)
  OR (active_lease_id IS NOT NULL AND claimed_generation IS NOT NULL
    AND claimed_generation>=applied_generation AND claimed_generation<=desired_generation
    AND claimed_trigger IN ('deploy','rollback','promotion','reconcile')
    ${includeProvider ? "AND claimed_runtime_provider IN ('wfp','container') " : ""}AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at)`;

const secretManifestCheck = (
  includeProvider,
) => `(provider_tag IS NULL ${includeProvider ? "AND runtime_provider IS NULL " : ""}AND applied_manifest_sha256 IS NULL
    AND applied_secret_count=0 AND cardinality(applied_secret_names)=0)
  OR (provider_tag IS NOT NULL ${includeProvider ? "AND runtime_provider IN ('wfp','container') " : ""}AND octet_length(applied_manifest_sha256)=32
    AND applied_secret_count=cardinality(applied_secret_names)
    AND applied_secret_count BETWEEN 0 AND 100)`;

const CONTAINER_TABLES = [
  "container_application_receipts",
  "container_worker_receipts",
  "container_artifact_objects",
  "ecr_image_receipts",
  "oci_assembly_receipts",
  "oci_assembly_input_reservations",
];

export function up(pgm) {
  pgm.sql(`DO $$ BEGIN IF ${CONTAINER_TABLES.map((table) => `EXISTS (SELECT 1 FROM ${table})`).join("\n      OR ")}
      OR EXISTS (SELECT 1 FROM deployment_revisions WHERE runtime_provider='container')
      OR EXISTS (SELECT 1 FROM product_provider_mutation_observations
        WHERE hint_phase='container' OR container_state<>'unknown')
      OR EXISTS (SELECT 1 FROM runtime_secret_delivery_states
        WHERE runtime_provider='container' OR claimed_runtime_provider='container')
      OR EXISTS (SELECT 1 FROM runtime_secret_delivery_receipts WHERE runtime_provider='container')
      OR EXISTS (SELECT 1 FROM deployment_plans WHERE framework_plan->>'runtime'='container')
      OR EXISTS (SELECT 1 FROM provider_resources WHERE capability='container-runtime')
    THEN RAISE EXCEPTION 'customer container runtime evidence prevents its removal'
      USING ERRCODE='23514'; END IF; END $$`);

  pgm.dropTrigger(
    "container_application_receipts",
    "container_application_receipts_runtime_secret_receipt",
  );
  pgm.dropFunction("enforce_container_application_runtime_secret_receipt", []);
  pgm.dropConstraint("deployment_revisions", "deployment_revisions_container_scope_fkey");
  pgm.dropConstraint("deployment_revisions", "deployment_revisions_runtime_provider_check");
  pgm.dropColumns("deployment_revisions", [
    "runtime_provider",
    "container_application_id",
    "container_health_status",
    "container_health_observed_at",
  ]);
  pgm.alterColumn("deployment_revisions", "wfp_receipt_id", { notNull: true });
  pgm.dropTrigger("oci_assembly_input_reservations", "oci_assembly_input_reservations_guard");
  pgm.dropFunction("enforce_oci_assembly_reservation_change", []);
  for (const table of CONTAINER_TABLES) pgm.dropTable(table);

  replaceCheck(
    pgm,
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
    observationShape(false),
  );
  pgm.dropColumns("product_provider_mutation_observations", [
    "container_state",
    "container_application_id",
    "container_product_deployment_id",
    "container_image_sha256",
    "container_health_status",
    "container_observed_at",
  ]);

  pgm.dropIndex("runtime_secret_delivery_receipts", [], {
    name: "runtime_secret_delivery_receipts_container_evidence_idx",
  });
  pgm.dropConstraint(
    "runtime_secret_delivery_receipts",
    "runtime_secret_delivery_receipts_runtime_provider_check",
  );
  pgm.dropColumns("runtime_secret_delivery_receipts", ["runtime_provider"]);

  replaceCheck(
    pgm,
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_manifest_check",
    secretManifestCheck(false),
  );
  replaceCheck(
    pgm,
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_lease_check",
    secretLeaseCheck(false),
  );
  pgm.dropConstraint(
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_claimed_provider_check",
  );
  pgm.dropConstraint(
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_runtime_provider_check",
  );
  pgm.dropColumns("runtime_secret_delivery_states", [
    "claimed_runtime_provider",
    "runtime_provider",
  ]);

  replaceCheck(pgm, "deployment_plans", FRAMEWORK_CONSTRAINT, frameworkConstraint);
  replaceCheck(
    pgm,
    "provider_resources",
    "provider_resources_capability_check",
    capabilityCheck(false),
  );
}

/**
 * Restores the schema exactly as migration 124 left it. The removed tables come back empty;
 * every existing row is a Workers for Platforms row and is backfilled as such.
 */
export function down(pgm) {
  replaceCheck(
    pgm,
    "provider_resources",
    "provider_resources_capability_check",
    capabilityCheck(true),
  );
  replaceCheck(pgm, "deployment_plans", FRAMEWORK_CONSTRAINT, previousFrameworkConstraint);

  pgm.sql(`
    ALTER TABLE runtime_secret_delivery_states
      ADD COLUMN runtime_provider text,
      ADD COLUMN claimed_runtime_provider text;
    UPDATE runtime_secret_delivery_states SET runtime_provider='wfp'
      WHERE provider_tag IS NOT NULL;
    UPDATE runtime_secret_delivery_states SET claimed_runtime_provider='wfp'
      WHERE active_lease_id IS NOT NULL;
    ALTER TABLE runtime_secret_delivery_states
      ADD CONSTRAINT runtime_secret_delivery_states_runtime_provider_check CHECK (
        runtime_provider IS NULL OR runtime_provider IN ('wfp','container')
      ),
      ADD CONSTRAINT runtime_secret_delivery_states_claimed_provider_check CHECK (
        (active_lease_id IS NULL AND claimed_runtime_provider IS NULL)
        OR (active_lease_id IS NOT NULL AND claimed_runtime_provider IN ('wfp','container'))
      );`);
  replaceCheck(
    pgm,
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_lease_check",
    secretLeaseCheck(true),
  );
  replaceCheck(
    pgm,
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_manifest_check",
    secretManifestCheck(true),
  );

  pgm.sql(`
    ALTER TABLE runtime_secret_delivery_receipts
      ADD COLUMN runtime_provider text NOT NULL DEFAULT 'wfp';
    ALTER TABLE runtime_secret_delivery_receipts ALTER COLUMN runtime_provider DROP DEFAULT;
    ALTER TABLE runtime_secret_delivery_receipts
      ADD CONSTRAINT runtime_secret_delivery_receipts_runtime_provider_check
        CHECK (runtime_provider IN ('wfp','container'));
    CREATE INDEX runtime_secret_delivery_receipts_container_evidence_idx
      ON runtime_secret_delivery_receipts(
        organization_id,project_id,environment_id,generation,manifest_secret_count
      ) WHERE runtime_provider='container';`);

  pgm.addColumns("product_provider_mutation_observations", {
    container_state: { type: "text", notNull: true, default: "unknown" },
    container_application_id: { type: "uuid" },
    container_product_deployment_id: { type: "ulid" },
    container_image_sha256: { type: "bytea" },
    container_health_status: { type: "smallint" },
    container_observed_at: { type: "timestamptz" },
  });
  replaceCheck(
    pgm,
    "product_provider_mutation_observations",
    "product_provider_mutation_observations_shape_check",
    observationShape(true),
  );

  createOciAssemblyTables(pgm);
  createEcrImageReceipts(pgm);
  createContainerWorkerReceipts(pgm);
  createContainerArtifactObjects(pgm);
  createContainerApplicationReceipts(pgm);

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

function replaceCheck(pgm, table, constraint, check) {
  pgm.dropConstraint(table, constraint);
  pgm.addConstraint(table, constraint, { check });
}

// Migration 058 re-pointed every environment reference at (project_id, environment_id).
function addScopeConstraints(pgm, table, operationColumn = "operation_id") {
  pgm.addConstraint(table, `${table}_operation_fkey`, {
    foreignKeys: {
      columns: ["organization_id", "project_id", operationColumn],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  if (operationColumn !== "operation_id") return;
  pgm.addConstraint(table, `${table}_environment_fkey`, {
    foreignKeys: {
      columns: ["project_id", "environment_id"],
      references: "environments (project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
}

function rejectChanges(pgm, table) {
  pgm.createTrigger(table, `${table}_append_only`, {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

function createOciAssemblyTables(pgm) {
  pgm.createTable("oci_assembly_input_reservations", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    input_fingerprint: { type: "bytea", notNull: true },
    claim_id: { type: "text", notNull: true },
    claim_mode: { type: "text", notNull: true },
    claimed_at: { type: "timestamptz", notNull: true },
    lease_expires_at: { type: "timestamptz", notNull: true },
    attempt_number: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    start_allowed_until: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("oci_assembly_input_reservations", "oci_assembly_input_reservations_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint(
    "oci_assembly_input_reservations",
    "oci_assembly_input_reservations_claim_id_key",
    { unique: ["claim_id"] },
  );
  addScopeConstraints(pgm, "oci_assembly_input_reservations");
  pgm.addConstraint("oci_assembly_input_reservations", "oci_assembly_input_reservations_shape", {
    check: `octet_length(input_fingerprint)=32
      AND claim_id~'${UUID_V4}'
      AND claim_mode IN ('start','observe')
      AND attempt_number>0 AND claimed_at>=created_at
      AND lease_expires_at>claimed_at
      AND lease_expires_at<=claimed_at+interval '300 seconds'
      AND start_allowed_until=created_at+interval '4 minutes'
      AND (claim_mode='observe' OR claimed_at<start_allowed_until)`,
  });

  pgm.createTable("oci_assembly_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    provider_build_id: { type: "text", notNull: true },
    codebuild_project_name: { type: "text", notNull: true },
    input_fingerprint: { type: "bytea", notNull: true },
    assembly_claim_id: { type: "text", notNull: true },
  });
  pgm.addConstraint("oci_assembly_receipts", "oci_assembly_receipts_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint("oci_assembly_receipts", "oci_assembly_receipts_build_id_key", {
    unique: ["provider_build_id"],
  });
  addScopeConstraints(pgm, "oci_assembly_receipts");
  pgm.addConstraint("oci_assembly_receipts", "oci_assembly_receipts_shape", {
    check: `length(provider_build_id) BETWEEN 1 AND 512
      AND length(codebuild_project_name) BETWEEN 1 AND 255
      AND octet_length(input_fingerprint)=32
      AND assembly_claim_id~'${UUID_V4}'`,
  });
  rejectChanges(pgm, "oci_assembly_receipts");

  pgm.sql(`CREATE FUNCTION enforce_oci_assembly_reservation_change() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'oci_assembly_input_reservations is append-only' USING ERRCODE='55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM oci_assembly_receipts receipt
        WHERE receipt.organization_id=OLD.organization_id
          AND receipt.project_id=OLD.project_id
          AND receipt.environment_id=OLD.environment_id
          AND receipt.operation_id=OLD.operation_id
      ) OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.start_allowed_until IS DISTINCT FROM OLD.start_allowed_until
        OR NEW.claim_id=OLD.claim_id
        OR OLD.lease_expires_at>NEW.claimed_at
        OR NEW.claimed_at<=OLD.claimed_at
        OR NEW.lease_expires_at<=OLD.lease_expires_at
        OR NEW.attempt_number<>OLD.attempt_number+1
        OR (OLD.claim_mode='observe' AND NEW.claim_mode<>'observe')
        OR (NEW.claim_mode='start' AND NEW.claimed_at>=NEW.start_allowed_until) THEN
        RAISE EXCEPTION 'oci_assembly_input_reservations permits only expired claim renewal'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$`);
  pgm.createTrigger("oci_assembly_input_reservations", "oci_assembly_input_reservations_guard", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "enforce_oci_assembly_reservation_change",
  });
}

function createEcrImageReceipts(pgm) {
  pgm.createTable("ecr_image_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    registry_id: { type: "text", notNull: true },
    repository_name: { type: "text", notNull: true },
    repository_url: { type: "text", notNull: true },
    image_digest: { type: "bytea", notNull: true },
    image_tag: { type: "text", notNull: true },
    image_reference: { type: "text", notNull: true },
    published_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("ecr_image_receipts", "ecr_image_receipts_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint("ecr_image_receipts", "ecr_image_receipts_deployment_key", {
    unique: ["organization_id", "project_id", "deployment_id"],
  });
  addScopeConstraints(pgm, "ecr_image_receipts");
  pgm.addConstraint("ecr_image_receipts", "ecr_image_receipts_shape", {
    check: `registry_id~'^[0-9]{12}$'
      AND repository_name~'^[a-z0-9]+([._/-][a-z0-9]+)*$'
      AND repository_url~'^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9]+([._/-][a-z0-9]+)*$'
      AND octet_length(image_digest)=32
      AND image_tag='deployment-'||lower(deployment_id::text)
      AND image_reference=repository_url||'@sha256:'||encode(image_digest,'hex')`,
  });
  rejectChanges(pgm, "ecr_image_receipts");
}

function createContainerWorkerReceipts(pgm) {
  pgm.createTable("container_worker_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    created_operation_id: { type: "ulid", notNull: true },
    script_name: { type: "text", notNull: true },
    module_digest: { type: "bytea", notNull: true },
    durable_object_namespace_id: { type: "uuid", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_script_key", {
    unique: ["script_name"],
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_namespace_key", {
    unique: ["durable_object_namespace_id"],
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  addScopeConstraints(pgm, "container_worker_receipts", "created_operation_id");
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_shape", {
    check: `script_name='r-'||lower(project_id::text) AND octet_length(module_digest)=32`,
  });
  rejectChanges(pgm, "container_worker_receipts");
}

function createContainerArtifactObjects(pgm) {
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
  addScopeConstraints(pgm, "container_artifact_objects");
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
  rejectChanges(pgm, "container_artifact_objects");
}

function createContainerApplicationReceipts(pgm) {
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
    runtime_secret_generation: { type: "bigint", notNull: true },
    runtime_secret_manifest_sha256: { type: "bytea", notNull: true },
    runtime_secret_count: { type: "integer", notNull: true },
    runtime_secret_release_sequence: { type: "bigint", notNull: true },
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
  addScopeConstraints(pgm, "container_application_receipts");
  pgm.addConstraint("container_application_receipts", "container_application_receipts_shape", {
    check: `application_name='c-'||lower(project_id::text)
      AND deployment_url='https://r-'||lower(project_id::text)||'.your-omh-account.workers.dev'
      AND image_reference~'^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$'
      AND octet_length(image_digest)=32
      AND image_reference LIKE '%@sha256:'||encode(image_digest,'hex')
      AND outcome IN ('created','replayed','rollout_started')
      AND ((outcome='rollout_started')=(rollout_id IS NOT NULL))`,
  });
  // PostgreSQL truncates this identifier to 63 bytes, exactly as it did for migration 052.
  pgm.sql(`ALTER TABLE container_application_receipts
    ADD CONSTRAINT container_application_receipts_runtime_secret_shape CHECK (
      runtime_secret_generation >= 0
      AND octet_length(runtime_secret_manifest_sha256)=32
      AND runtime_secret_count BETWEEN 0 AND 100
    ),
    ADD CONSTRAINT container_application_receipts_runtime_secret_release_sequence_check
      CHECK (runtime_secret_release_sequence > 0)`);
  rejectChanges(pgm, "container_application_receipts");
  pgm.sql(`CREATE FUNCTION enforce_container_application_runtime_secret_receipt()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM runtime_secret_delivery_receipts receipt
        WHERE receipt.organization_id=NEW.organization_id
          AND receipt.project_id=NEW.project_id
          AND receipt.environment_id=NEW.environment_id
          AND receipt.runtime_provider='container'
          AND receipt.release_sequence=NEW.runtime_secret_release_sequence
          AND receipt.generation=NEW.runtime_secret_generation
          AND receipt.manifest_sha256=NEW.runtime_secret_manifest_sha256
          AND receipt.manifest_secret_count=NEW.runtime_secret_count
          AND receipt.completed_at<=NEW.observed_at
      ) THEN
        RAISE EXCEPTION 'container application receipt requires completed container runtime secret evidence'
          USING ERRCODE='23503',
            CONSTRAINT='container_application_receipts_runtime_secret_receipt';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER container_application_receipts_runtime_secret_receipt
      BEFORE INSERT ON container_application_receipts
      FOR EACH ROW EXECUTE FUNCTION enforce_container_application_runtime_secret_receipt();`);
}
