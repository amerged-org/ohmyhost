import { fail, integerText } from "./control-d1-codec.mjs";
import { parseProviderUuidArray } from "./control-d1-provider-parent-array.mjs";

// Exact original column order and base types agree in BOTH retained20261028 Control schema-only baselines.
export const PROVIDER_PARENT_COLUMNS = Object.freeze({
  database_provider_operations:
    "organization_id,project_id,physical_environment_id,operation_id,claim_id,step,idempotency_key,provider_project_id,request_digest,request_body,provider_operation_id,database_id,state,dispatched_at,observed_at",
  database_provider_target_revisions:
    "organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,branch_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at",
  neon_project_placement_receipts:
    "organization_id,project_id,environment_id,operation_id,claim_id,project_name,region_id,postgres_version,provider_project_id,default_branch_id,operation_ids,state,observed_at,created_at,provisioned_compute_profile",
  project_database_registration_receipts:
    "organization_id,project_id,physical_environment_id,operation_id,claim_id,registration_version,status,metadata,observed_at",
  project_database_registration_reservations:
    "organization_id,project_id,physical_environment_id,operation_id,claim_id,registration_version,metadata",
  pgcf_database_serving_intervals:
    "organization_id,project_id,physical_environment_id,target_version,provider_project_id,database_id,started_at,billable_from,ended_at",
  database_provider_target_heads:
    "organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at",
});
export const PROVIDER_PARENT_TYPES = Object.freeze({
  database_provider_operations: {
    organization_id: "text",
    project_id: "text",
    physical_environment_id: "text",
    operation_id: "text",
    claim_id: "text",
    step: "text",
    idempotency_key: "text",
    provider_project_id: "text",
    request_digest: "bytea",
    request_body: "jsonb",
    provider_operation_id: "text",
    database_id: "text",
    state: "text",
    dispatched_at: "timestamp with time zone",
    observed_at: "timestamp with time zone",
  },
  database_provider_target_revisions: {
    organization_id: "text",
    project_id: "text",
    physical_environment_id: "text",
    target_version: "bigint",
    provider: "text",
    provider_project_id: "text",
    database_id: "text",
    branch_id: "text",
    region_id: "text",
    size_class_id: "text",
    runtime_role: "text",
    credential_reference: "text",
    operation_id: "text",
    created_at: "timestamp with time zone",
  },
  neon_project_placement_receipts: {
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    operation_id: "text",
    claim_id: "text",
    project_name: "text",
    region_id: "text",
    postgres_version: "smallint",
    provider_project_id: "text",
    default_branch_id: "text",
    operation_ids: "uuid[]",
    state: "text",
    observed_at: "timestamp with time zone",
    created_at: "timestamp with time zone",
    provisioned_compute_profile: "text",
  },
  project_database_registration_receipts: {
    organization_id: "text",
    project_id: "text",
    physical_environment_id: "text",
    operation_id: "text",
    claim_id: "text",
    registration_version: "bigint",
    status: "text",
    metadata: "jsonb",
    observed_at: "timestamp with time zone",
  },
  project_database_registration_reservations: {
    organization_id: "text",
    project_id: "text",
    physical_environment_id: "text",
    operation_id: "text",
    claim_id: "text",
    registration_version: "bigint",
    metadata: "jsonb",
  },
  pgcf_database_serving_intervals: {
    organization_id: "text",
    project_id: "text",
    physical_environment_id: "text",
    target_version: "bigint",
    provider_project_id: "text",
    database_id: "text",
    started_at: "timestamp with time zone",
    billable_from: "timestamp with time zone",
    ended_at: "timestamp with time zone",
  },
  database_provider_target_heads: {
    organization_id: "text",
    project_id: "text",
    physical_environment_id: "text",
    target_version: "bigint",
    state: "text",
    activated_at: "timestamp with time zone",
    updated_at: "timestamp with time zone",
  },
});
export const PROVIDER_PARENT_TARGETS = Object.freeze(Object.keys(PROVIDER_PARENT_COLUMNS));
export const PROVIDER_PARENT_PINS = Object.freeze({
  "0273_provider_history_inventory.sql":
    "cbb8564d77af469032e5bacd893dd6eba786d43cdec748c6f3851ee90fff0c78",
  "0353_provider_operation_scope.sql":
    "ef48109f917f58afaed19ee5e9ac78ffd9838a67f0e4e8fc8382898f2eac0207",
  "0413_original_provider_parent_arrays.sql":
    "23ccb8daacd499180824b0317fa8cfe1a7a955ce30923c3707b43d69d1f7171b",
});

/** Original physical identities/opaque references only. No current alias, activation, credential or provider result is invented. */
export function mapProviderParents(rows, manifest) {
  for (const [name, sha256] of Object.entries(PROVIDER_PARENT_PINS))
    if (
      !manifest.targetPin.migrations.some((entry) => entry.name === name && entry.sha256 === sha256)
    )
      fail("PROVIDER_PARENT_SCHEMA_PREREQUISITE");
  const records = [];
  const revisions = new Map(
    (rows.get("database_provider_target_revisions") ?? []).map((row) => [
      [row.organization_id, row.project_id, row.physical_environment_id, row.target_version].join(
        "/",
      ),
      row,
    ]),
  );
  for (const [table, declaration] of Object.entries(PROVIDER_PARENT_COLUMNS)) {
    const fields = declaration.split(","),
      definition = manifest.tables.find((entry) => entry.name === table),
      source = rows.get(table);
    if (
      !definition ||
      definition.columns.map((column) => column.name).join(",") !== declaration ||
      !Array.isArray(source)
    )
      fail("PROVIDER_PARENT_SOURCE_COLUMNS");
    for (const column of definition.columns)
      if (column.pgType !== PROVIDER_PARENT_TYPES[table][column.name])
        fail("PROVIDER_PARENT_SOURCE_TYPE");
    for (const original of source) {
      if (!original || Object.keys(original).sort().join(",") !== [...fields].sort().join(","))
        fail("PROVIDER_PARENT_ROW_SHAPE");
      const row = { ...original };
      for (const field of fields) {
        const value = row[field],
          type = PROVIDER_PARENT_TYPES[table][field];
        if (value === null) continue;
        if (typeof value !== "string") fail("PROVIDER_PARENT_ROW_VALUE");
        if (["smallint", "bigint"].includes(type)) integerText(value);
        if (type === "bytea" && !/^(?:[a-f0-9]{2})*$/u.test(value)) fail("PROVIDER_PARENT_BYTEA");
        if (
          type === "timestamp with time zone" &&
          !/^(?!0000-)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
        )
          fail("PROVIDER_PARENT_TIMESTAMP_UNREPRESENTABLE");
      }
      if (table === "neon_project_placement_receipts") {
        const array = parseProviderUuidArray(row.operation_ids);
        if (array.values === null) fail("PROVIDER_PARENT_ARRAY_NULL");
        const pending = [array.values];
        let count = 0;
        while (pending.length) {
          const value = pending.pop();
          if (Array.isArray(value)) pending.push(...value);
          else count++;
        }
        if (count > 128) fail("PROVIDER_PARENT_ARRAY_CARDINALITY");
        row.operation_ids = JSON.stringify(array.values);
        row.operation_ids_bounds = array.bounds === null ? null : JSON.stringify(array.bounds);
      }
      if (table === "database_provider_target_heads" && row.state === "active") {
        const revision = revisions.get(
          [
            row.organization_id,
            row.project_id,
            row.physical_environment_id,
            row.target_version,
          ].join("/"),
        );
        if (!revision) fail("PROVIDER_PARENT_REVISION_REQUIRED");
        if (revision.provider !== "pgcf") fail("PROVIDER_PARENT_ACTIVE_NEON_UNREPRESENTABLE");
      }
      records.push({ table, row });
    }
  }
  return records;
}

/** Only these exact derived serving callbacks yield during original raw history import. */
export const PROVIDER_PARENT_DERIVED_TRIGGERS = Object.freeze([
  {
    name: "pgcf_serving_interval_on_head_delete",
    migration: "0353_provider_operation_scope.sql",
    migrationSha256: "ef48109f917f58afaed19ee5e9ac78ffd9838a67f0e4e8fc8382898f2eac0207",
    sqlSha256: "cde33135fdf6f0fcaf4cfddf1aa385e335442886e7b34868a8998a94c487d5b9",
  },
  {
    name: "pgcf_serving_interval_on_head_insert",
    migration: "0353_provider_operation_scope.sql",
    migrationSha256: "ef48109f917f58afaed19ee5e9ac78ffd9838a67f0e4e8fc8382898f2eac0207",
    sqlSha256: "e1a81fb4fc3ef7df05c3714909a14a84fba93aad7f27626d23cf371020d38c83",
  },
  {
    name: "pgcf_serving_interval_on_head_update",
    migration: "0353_provider_operation_scope.sql",
    migrationSha256: "ef48109f917f58afaed19ee5e9ac78ffd9838a67f0e4e8fc8382898f2eac0207",
    sqlSha256: "b157aa89b5f5ebc86ecbaaeb07e94e885423bc07556b0e4a12cb29796f995fd7",
  },
]);
