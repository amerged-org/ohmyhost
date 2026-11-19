import { fail, integerText } from "./control-d1-codec.mjs";

// Original tables whose Core table carries the same columns. Column names and PostgreSQL types are pinned from the
// reviewed source schema, so a drifted column fails the plan instead of being coerced.
const BEFORE_WFP = {
  build_source_uploads:
    "upload_id:text,organization_id:text,project_id:text,operation_id:text,source_connection_id:text,commit_sha:text,bucket_name:text,object_key:text,object_version_id:text,multipart_upload_id:text,state:text,claim_id:text,claimed_at:timestamp with time zone,lease_expires_at:timestamp with time zone,attempt_number:integer,created_at:timestamp with time zone,updated_at:timestamp with time zone",
  build_executions:
    "build_execution_id:text,organization_id:text,project_id:text,operation_id:text,source_upload_id:text,build_plan_sha256:bytea,build_project_name:text,provider_build_id:text,state:text,claim_id:text,claimed_at:timestamp with time zone,lease_expires_at:timestamp with time zone,attempt_number:integer,created_at:timestamp with time zone,updated_at:timestamp with time zone",
  build_artifacts:
    "artifact_id:text,organization_id:text,project_id:text,build_execution_id:text,artifact_sha256:bytea,manifest_sha256:bytea,sbom_sha256:bytea,object_version_ref:text,created_at:timestamp with time zone",
  build_source_upload_parts:
    "upload_id:text,part_number:integer,etag:text,byte_length:bigint,sha256:bytea,recorded_at:timestamp with time zone",
  cleanup_runs:
    "cleanup_run_id:text,organization_id:text,project_id:text,operation_id:text,state:text,revision:integer,reconciliation_code:text,created_at:timestamp with time zone,updated_at:timestamp with time zone,completed_at:timestamp with time zone",
  source_connections:
    "source_connection_id:text,organization_id:text,project_id:text,billing_epoch_id:text,provider:text,external_repository_id:text,created_at:timestamp with time zone",
  repository_grants:
    "grant_id:text,organization_id:text,project_id:text,source_connection_id:text,provider:text,github_installation_id:text,external_repository_id:text,repository_owner:text,repository_name:text,permission:text,granted_at:timestamp with time zone,billing_epoch_id:text",
  deployment_plans:
    "plan_id:text,organization_id:text,project_id:text,source_connection_id:text,commit_sha:text,source_sha256:bytea,build_plan_sha256:bytea,runtime:text,impacts:jsonb,risks:jsonb,cost_estimate:jsonb,created_at:timestamp with time zone,expires_at:timestamp with time zone,plan_sha256:bytea,framework_plan:jsonb,environment_id:text,source_generation:integer",
  dev_share_links:
    "project_id:text,organization_id:text,environment_id:text,token_sha256:bytea,ciphertext:bytea,nonce:bytea,key_version:integer,generation:bigint,created_at:timestamp with time zone,revoked_at:timestamp with time zone",
  dev_share_link_rotations:
    "project_id:text,key_sha256:bytea,generation:bigint,created_at:timestamp with time zone",
  github_auto_deploy_configs:
    "organization_id:text,project_id:text,source_connection_id:text,branch_ref:text,generation:integer,enabled:boolean,configured_at:timestamp with time zone,updated_at:timestamp with time zone",
  github_organization_connections:
    "connection_id:text,organization_id:text,installation_id:text,account_id:text,account_login:text,account_type:text,github_user_id:text,github_user_login:text,principal_id:text,settings_url:text,connected_at:timestamp with time zone,revoked_at:timestamp with time zone",
  github_push_deployments:
    "push_deployment_id:text,inbox_event_id:text,organization_id:text,project_id:text,source_connection_id:text,config_generation:integer,delivery_guid:text,github_installation_id:text,external_repository_id:text,branch_ref:text,commit_sha:text,sequence:bigint,operation_id:text,state:text,superseded_by_id:text,cleanup_required:boolean,created_at:timestamp with time zone,updated_at:timestamp with time zone",
  github_repository_link_consents:
    "operation_id:text,organization_id:text,project_id:text,environment_id:text,billing_epoch_id:text,connection_id:text,principal_id:text,installation_id:text,repository_id:text,repository_owner:text,repository_name:text,idempotency_key:text,request_sha256:bytea,authorized_at:timestamp with time zone",
  github_source_authorizations:
    "authorization_id:text,organization_id:text,project_id:text,environment_id:text,billing_epoch_id:text,principal_id:text,session_id:text,workos_organization_id:text,token_expires_at:bigint,repository_owner:text,repository_name:text,idempotency_key:text,request_sha256:bytea,state_sha256:bytea,ciphertext:bytea,nonce:bytea,value_sha256:bytea,key_version:integer,state:text,operation_id:text,github_user_id:text,installation_id:text,repository_id:text,created_at:timestamp with time zone,expires_at:timestamp with time zone,user_api_key_id:text,last_failure:text",
  github_source_connections:
    "source_connection_id:text,organization_id:text,project_id:text,billing_epoch_id:text,provider:text,external_repository_id:text,created_at:timestamp with time zone",
  managed_source_repositories:
    "source_connection_id:text,organization_id:text,project_id:text,billing_epoch_id:text,namespace:text,repository_name:text,created_at:timestamp with time zone",
  managed_source_publications:
    "operation_id:text,organization_id:text,project_id:text,billing_epoch_id:text,principal_id:text,source_connection_id:text,mode:text,delegation_grant_id:uuid,delegation_client_id:text,delegation_consent_sha256:text,expected_source_connection_id:text,expected_source_generation:integer,expected_managed_commit:text,state:text,message:text,manifest_sha256:text,manifest:jsonb,commit_sha:text,tree_sha:text,error_code:text,created_at:timestamp with time zone,expires_at:timestamp with time zone,updated_at:timestamp with time zone",
  // Blob inserts require their exact admission reservation (guard managed_source_blob_reservation).
  managed_source_reservations:
    "operation_id:text,path:text,sha256:text,byte_length:bigint,executable:boolean,created_at:timestamp with time zone",
  managed_source_blobs:
    "operation_id:text,path:text,sha256:text,byte_length:bigint,executable:boolean,bucket:text,object_key:text,version_id:text,etag:text,created_at:timestamp with time zone",
  managed_source_initializations:
    "parent_operation_id:text,organization_id:text,project_id:text,billing_epoch_id:text,source_connection_id:text,initialization_event_id:text,principal_id:text,template:text,region:text,request_id:text,state:text,child_operation_id:text,delegation_grant_id:uuid,delegation_client_id:text,delegation_consent_sha256:text,error_code:text,created_at:timestamp with time zone,updated_at:timestamp with time zone",
  database_provider_cutover_authorizations:
    "operation_id:text,organization_id:text,project_id:text,physical_environment_id:text,manifest_sha256:bytea,expected_lifecycle_version:integer,source_target_version:bigint,source_registration:jsonb,target_provider_project_id:text,target_region_id:text,target_size_class_id:text,approved_at:timestamp with time zone,approved_by:text",
  database_provider_cutover_binding_refreshes:
    "cutover_operation_id:text,refresh_operation_id:text,organization_id:text,project_id:text,environment_id:text,physical_environment_id:text,target_version:bigint,target_registration_version:bigint,approved_at:timestamp with time zone,approved_by:text",
  database_provider_cutover_receipts:
    "operation_id:text,phase:text,metadata:jsonb,recorded_at:timestamp with time zone",
  database_provider_cutover_releases:
    "operation_id:text,released_at:timestamp with time zone,released_by:text",
  database_provider_cutover_verifications:
    "operation_id:text,target_database_id:text,writer_fence_sha256:bytea,verification_sha256:bytea,verified_at:timestamp with time zone,verified_by:text",
  database_provider_legacy_retirements:
    "organization_id:text,project_id:text,physical_environment_id:text,target_version:bigint,provider_project_id:text,branch_id:text,manifest_sha256:bytea,inventory_sha256:bytea,retired_at:timestamp with time zone,retired_by:text",
  neon_project_role_receipts:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,claim_id:text,provider_project_id:text,branch_id:text,role_name:text,operation_ids:uuid[],state:text,observed_at:timestamp with time zone,created_at:timestamp with time zone",
  pgcf_database_migration_receipts:
    "organization_id:text,project_id:text,physical_environment_id:text,operation_id:text,claim_id:text,provider_project_id:text,database_id:text,bundle_sha256:bytea,applied_paths:text[],replayed_paths:text[],completed_at:timestamp with time zone",
  pgcf_platform_database_activations:
    "provider_project_id:text,database_id:text,activated_at:timestamp with time zone,manifest_sha256:bytea,recorded_by:text,recorded_at:timestamp with time zone",
  product_provider_mutation_observations:
    "observation_id:text,claim_id:text,organization_id:text,project_id:text,environment_id:text,operation_id:text,event_id:text,billing_epoch_id:text,logical_workflow_id:text,event_type:text,accepted_lifecycle_version:integer,observation_kind:text,attempt_number:integer,evidence_sha256:bytea,hint_phase:text,expected_artifact_sha256:bytea,hint_provider_tag:text,hint_product_deployment_id:text,source_state:text,build_state:text,gateway_state:text,gateway_provider_tag:text,gateway_observed_at:timestamp with time zone,wfp_state:text,wfp_provider_tag:text,wfp_product_deployment_id:text,wfp_artifact_sha256:bytea,wfp_observed_at:timestamp with time zone,actor_id:text,created_at:timestamp with time zone",
  product_provider_reconciliation_attempts:
    "attempt_id:text,observation_id:text,claim_id:text,organization_id:text,project_id:text,environment_id:text,operation_id:text,event_id:text,billing_epoch_id:text,logical_workflow_id:text,event_type:text,accepted_lifecycle_version:integer,physical_workflow_id:text,mode:text,outcome:text,idempotency_sha256:bytea,attempt_number:integer,actor_id:text,created_at:timestamp with time zone",
  product_source_archive_objects:
    "operation_id:text,organization_id:text,project_id:text,environment_id:text,bucket_name:text,object_key:text,object_version_id:text,object_etag:text,byte_length:bigint,source_sha256:bytea,recorded_at:timestamp with time zone",
  product_workflow_replay_attempts:
    "attempt_id:text,organization_id:text,project_id:text,environment_id:text,operation_id:text,event_id:text,billing_epoch_id:text,logical_workflow_id:text,physical_workflow_id:text,event_type:text,idempotency_sha256:bytea,attempt_number:integer,actor_id:text,created_at:timestamp with time zone",
  product_workflow_replay_failures:
    "failure_id:text,attempt_id:text,organization_id:text,operation_id:text,physical_workflow_id:text,terminal_status:text,evidence_sha256:bytea,actor_id:text,created_at:timestamp with time zone",
  project_dev_access_requests:
    "organization_id:text,project_id:text,actor_id:text,key_sha256:bytea,request_sha256:bytea,response_ciphertext:bytea,response_nonce:bytea,response_value_sha256:bytea,response_key_version:integer,recorded_at:timestamp with time zone",
  project_recovery_jobs:
    "operation_id:text,organization_id:text,project_id:text,environment_id:text,input_ciphertext:bytea,input_nonce:bytea,input_key_version:integer,input_expires_at:timestamp with time zone,requested_at:timestamp with time zone,claim_id:uuid,started_at:timestamp with time zone,archive_bucket:text,archive_bytes:bigint,archive_sha256:bytea,captured_at:timestamp with time zone,archive_expires_at:timestamp with time zone,verified_at:timestamp with time zone,finished_at:timestamp with time zone,failure_code:text,archive_key:text,sql_files:text[]",
  project_source_bindings:
    "organization_id:text,project_id:text,source_connection_id:text,provider:text,generation:integer,commit_sha:text,updated_at:timestamp with time zone",
  project_sources:
    "organization_id:text,project_id:text,source_id:text,billing_epoch_id:text,grant_id:text,provider:text,installation_id:text,external_repository_id:text,repository_owner:text,repository_name:text,state:text,failure_code:text,revision:integer,created_at:timestamp with time zone,updated_at:timestamp with time zone",
  provider_resources:
    "organization_id:text,project_id:text,operation_id:text,capability:text,provider:text,external_id:text,created_at:timestamp with time zone,observed_at:timestamp with time zone,state:text",
  repository_grant_revocations:
    "revocation_id:text,grant_id:text,organization_id:text,project_id:text,reason:text,revoked_at:timestamp with time zone",
  run_cleanup_attempts:
    "cleanup_attempt_id:text,organization_id:text,project_id:text,operation_id:text,provider:text,resource_kind:text,external_ref_hash:bytea,outcome:text,error_code:text,attempted_at:timestamp with time zone",
  run_resource_inventory:
    "resource_record_id:text,organization_id:text,project_id:text,operation_id:text,provider:text,resource_kind:text,external_ref_hash:bytea,recorded_at:timestamp with time zone,cleanup_locator:text",
  source_archives:
    "operation_id:text,organization_id:text,project_id:text,billing_epoch_id:text,provider:text,source_connection_id:text,external_repository_id:text,requested_commit_sha:text,resolved_commit_sha:text,archive_format:text,sha256:bytea,byte_length:bigint,object_ref:text,acquired_at:timestamp with time zone",
};
const AFTER_WFP = {
  action_confirmations:
    "confirmation_id:text,organization_id:text,project_id:text,action:text,token_sha256:bytea,created_at:timestamp with time zone,expires_at:timestamp with time zone,consumed_at:timestamp with time zone,issued_to_principal_id:text,target_deployment_id:text,subject_etag:text,source_generation:integer",
  deployment_diagnostics:
    "diagnostic_event_id:text,organization_id:text,project_id:text,environment_id:text,deployment_id:text,source:text,code:text,catalog_message:text,exception_class:text,source_file:text,source_line:integer,source_column:integer,route_template:text,request_id:text,trace_id:text,duration_ms:integer,occurred_at:timestamp with time zone,recorded_at:timestamp with time zone,excerpt:text,excerpt_truncated:boolean,status_code:smallint",
  product_command_intents:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,billing_epoch_id:text,event_type:text,installation_id:text,repository_owner:text,repository_name:text,plan_id:text,source_connection_id:text,deployment_id:text,target_deployment_id:text,target_revision_id:text,target_artifact_id:text,expected_etag:text,cleanup_run_id:text,created_at:timestamp with time zone,source_environment_id:text,source_deployment_id:text,source_revision_id:text,source_artifact_id:text,source_artifact_sha256:bytea,expected_source_head_version:integer,expected_target_head_version:integer,requested_handle:text,data_change:text,data_change_snapshot:jsonb,binding_refresh_snapshot:jsonb,source_generation:integer",
  product_workflow_runs:
    "workflow_id:text,event_id:text,organization_id:text,project_id:text,environment_id:text,operation_id:text,billing_epoch_id:text,event_type:text,state:text,terminal_evidence:jsonb,intermediate_evidence:jsonb,reconciliation_code:text,created_at:timestamp with time zone,updated_at:timestamp with time zone,completed_at:timestamp with time zone,active_reconciliation_attempt_id:text,active_replay_attempt_id:text",
  product_provider_mutation_claims:
    "claim_id:text,organization_id:text,project_id:text,environment_id:text,operation_id:text,billing_epoch_id:text,event_id:text,logical_workflow_id:text,event_type:text,accepted_lifecycle_version:integer,claimed_at:timestamp with time zone",
  runtime_probe_windows:
    "window_id:text,candidate_receipt_id:text,starts_at:timestamp with time zone,expires_at:timestamp with time zone",
  wfp_candidate_operation_cleanup_receipts:
    "operation_cleanup_receipt_id:text,cleanup_request_id:text,candidate_receipt_id:text,organization_id:text,project_id:text,operation_id:text,provider:text,resource_kind:text,resource_identity_sha256:bytea,outcome:text,observed_at:timestamp with time zone",
};

// Its insert guard reads the active project domain, so it follows the Cloudflare family.
const AFTER_CLOUDFLARE = {
  dev_access_tickets:
    "ticket_id:text,organization_id:text,project_id:text,environment_id:text,environment_name:text,handle:text,public_origin:text,dev_access_epoch:bigint,issued_to_principal_id:text,token_sha256:bytea,issued_at:timestamp with time zone,expires_at:timestamp with time zone,consumed_at:timestamp with time zone,revoked_at:timestamp with time zone",
};
export const GENERIC_AFTER_CLOUDFLARE = Object.freeze(Object.keys(AFTER_CLOUDFLARE));
export const GENERIC_BEFORE_WFP = Object.freeze(Object.keys(BEFORE_WFP));
export const GENERIC_AFTER_WFP = Object.freeze(Object.keys(AFTER_WFP));
const PINS = Object.freeze({ ...BEFORE_WFP, ...AFTER_WFP, ...AFTER_CLOUDFLARE });
export const GENERIC_TARGETS = Object.freeze(Object.keys(PINS));
export const GENERIC_COLUMNS = Object.freeze(
  Object.fromEntries(
    Object.entries(PINS).map(([table, spec]) => [
      table,
      spec
        .split(",")
        .map((column) => column.slice(0, column.indexOf(":")))
        .join(","),
    ]),
  ),
);

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const INTEGER_RANGE = {
  smallint: [-32768n, 32767n],
  integer: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
};

/** One-dimensional PostgreSQL text[] output with ordinary bounds and no NULL element, as a JSON array text. */
function arrayText(text) {
  if (!text.startsWith("{") || !text.endsWith("}") || text.length < 2)
    fail("GENERIC_ARRAY_UNREPRESENTABLE");
  if (text === "{}") return "[]";
  const items = [];
  let offset = 1;
  for (;;) {
    let item;
    if (text[offset] === '"') {
      item = "";
      offset += 1;
      while (text[offset] !== '"') {
        if (offset >= text.length - 1) fail("GENERIC_ARRAY_UNREPRESENTABLE");
        if (text[offset] === "\\") offset += 1;
        item += text[offset];
        offset += 1;
      }
      offset += 1;
    } else {
      const start = offset;
      while (offset < text.length && !',{}"\\'.includes(text[offset])) offset += 1;
      item = text.slice(start, offset);
      if (item === "" || item.toUpperCase() === "NULL") fail("GENERIC_ARRAY_UNREPRESENTABLE");
    }
    items.push(item);
    if (text[offset] === ",") offset += 1;
    else if (text[offset] === "}" && offset === text.length - 1) return JSON.stringify(items);
    else fail("GENERIC_ARRAY_UNREPRESENTABLE");
  }
}

function convert(type, value) {
  if (value === null) return null;
  if (typeof value !== "string") fail("GENERIC_VALUE");
  if (type in INTEGER_RANGE) {
    const [low, high] = INTEGER_RANGE[type],
      parsed = BigInt(integerText(value));
    if (parsed < low || parsed > high) fail("GENERIC_INTEGER_UNREPRESENTABLE");
    return value;
  }
  if (type === "boolean") {
    if (value !== "true" && value !== "false") fail("GENERIC_BOOLEAN_UNREPRESENTABLE");
    return value === "true" ? "1" : "0";
  }
  if (type === "bytea") {
    if (!/^(?:[a-f0-9]{2})*$/u.test(value)) fail("GENERIC_BYTEA_UNREPRESENTABLE");
    return value;
  }
  if (type === "timestamp with time zone") {
    if (!TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)) || value.startsWith("0000-"))
      fail("GENERIC_TIMESTAMP_UNREPRESENTABLE");
    return value;
  }
  if (type.endsWith("[]")) return arrayText(value);
  if (!["text", "jsonb", "uuid", "name"].includes(type)) fail("GENERIC_TYPE_UNREPRESENTABLE");
  return value;
}

const one = (rows, table, predicate) => {
  const found = (rows.get(table) ?? []).filter(predicate);
  if (found.length !== 1) fail("GENERIC_PARENT_REQUIRED");
  return found[0];
};
// Core-only technical columns. Source facts are never rewritten: each rule names its exact original parent.
const DERIVED = Object.freeze({
  dev_share_link_rotations: (row, rows) => ({
    organization_id: one(rows, "dev_share_links", (link) => link.project_id === row.project_id)
      .organization_id,
  }),
  database_provider_cutover_releases: (row, rows) => ({
    organization_id: one(
      rows,
      "database_provider_cutover_authorizations",
      (authorization) => authorization.operation_id === row.operation_id,
    ).organization_id,
  }),
});
// Core generates these from the same source columns; the original value must equal the generated one.
const GENERATED = Object.freeze({
  project_recovery_jobs: {
    archive_key: (row) =>
      `snapshots/${row.organization_id}/${row.project_id}/${row.operation_id}.zip`,
  },
});

/** Original typed facts in dependency order. A missing/extra column or type, or a value Core cannot hold, is a gap. */
export function mapGeneric(rows, manifest, tables) {
  const records = [];
  for (const table of tables) {
    const definition = manifest.tables.find((entry) => entry.name === table);
    const pinned = PINS[table].split(",").map((column) => column.split(":"));
    if (
      !definition ||
      definition.columns.map((column) => `${column.name}:${column.pgType}`).join(",") !==
        PINS[table]
    )
      fail("GENERIC_SOURCE_COLUMNS");
    const originals = rows.get(table);
    if (!Array.isArray(originals)) fail("GENERIC_SOURCE_TABLE");
    for (const original of originals) {
      const row = {};
      for (const [name, type] of pinned) {
        if (!(name in original)) fail("GENERIC_ROW_SHAPE");
        row[name] = convert(type, original[name]);
      }
      const generated = GENERATED[table] ?? {};
      for (const [name, expected] of Object.entries(generated))
        if (row[name] !== expected(row)) fail("GENERIC_GENERATED_COLUMN");
      const stored = Object.fromEntries(
        Object.entries(row).filter(([name]) => !(name in generated)),
      );
      records.push({ table, row: { ...stored, ...(DERIVED[table]?.(row, rows) ?? {}) } });
    }
  }
  return records;
}

/** PostgreSQL array_out quoting: an element is quoted when empty, NULL-like or holding a delimiter, quote, brace or space. */
function pgArrayText(json) {
  const items = JSON.parse(json);
  return `{${items
    .map((item) =>
      item === "" || /^null$/iu.test(item) || /[\s"\\{},]/u.test(item)
        ? `"${item.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : item,
    )
    .join(",")}}`;
}

/** Independent readback of the imported rows in the captured source text format, for the original multiset proof. */
export async function readGenericSourceFacts(db) {
  const facts = new Map();
  for (const [table, spec] of Object.entries(PINS)) {
    const columns = spec.split(",").map((column) => column.split(":"));
    const selected = columns.map(([name, type]) =>
      type in INTEGER_RANGE
        ? `CAST(${name} AS TEXT) ${name}`
        : type === "bytea"
          ? `CASE WHEN ${name} IS NULL THEN NULL ELSE lower(hex(${name})) END ${name}`
          : name,
    );
    const values = (await db.prepare(`SELECT ${selected.join(",")} FROM ${table}`).all()).results;
    facts.set(
      table,
      values.map((row) => {
        for (const [name, type] of columns) {
          if (row[name] === null) continue;
          if (type === "boolean") row[name] = row[name] === 1 ? "true" : "false";
          else if (type.endsWith("[]")) row[name] = pgArrayText(row[name]);
        }
        return row;
      }),
    );
  }
  return facts;
}

/** The 0336 binder derives a binding from each GitHub grant; the captured bindings are imported as original facts instead. */
export const GENERIC_DERIVED_TRIGGERS = Object.freeze([
  Object.freeze({
    name: "github_grant_bind_source",
    migration: "0336_deployment_static_integrity.sql",
    migrationSha256: "dfe68ee1d68c7a7f49c7d3452da9eda8447d8b4d2af8064890bfed3f6379bc4b",
    sqlSha256: "5e66c2a7d2b6c5cd098383d36ebe9d01aa2d5573e5f605b5966a09b0c690e6f0",
  }),
]);
