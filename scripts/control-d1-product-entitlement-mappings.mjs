import { fail, integerText } from "./control-d1-codec.mjs";
export const ENTITLEMENT_COLUMNS = Object.freeze({
  pgcf_database_entitlement_policies:
    "organization_id,project_id,physical_environment_id,database_id,suspended_by_entitlement,suspension_operation_id,suspension_generation,last_checked_at",
  pgcf_database_entitlement_actions:
    "action_id,organization_id,project_id,physical_environment_id,billing_epoch_id,target_version,provider_project_id,database_id,action,expected_generation,idempotency_key,state,provider_operation_id,provider_generation,claim_id,claim_expires_at,created_at,dispatched_at,observed_at",
});
export const ENTITLEMENT_KINDS = Object.freeze({
  pgcf_database_entitlement_policies: {
    organization_id: "text",
    project_id: "text",
    physical_environment_id: "text",
    database_id: "text",
    suspended_by_entitlement: "boolean",
    suspension_operation_id: "text",
    suspension_generation: "integer",
    last_checked_at: "timestamp",
  },
  pgcf_database_entitlement_actions: {
    action_id: "text",
    organization_id: "text",
    project_id: "text",
    physical_environment_id: "text",
    billing_epoch_id: "text",
    target_version: "integer",
    provider_project_id: "text",
    database_id: "text",
    action: "text",
    expected_generation: "integer",
    idempotency_key: "text",
    state: "text",
    provider_operation_id: "text",
    provider_generation: "integer",
    claim_id: "text",
    claim_expires_at: "timestamp",
    created_at: "timestamp",
    dispatched_at: "timestamp",
    observed_at: "timestamp",
  },
});
export const ENTITLEMENT_MIGRATIONS = Object.freeze({
  "0402_original_pgcf_entitlements.sql":
    "e05c402fd648c9d6a1c3151019dc2a5936efb4b96d15a30e5c139ca9185b9733",
});
export const ENTITLEMENT_SOURCE_MIGRATIONS = Object.freeze({
  "226_pgcf_database_entitlements.mjs":
    "4ea9bbd766765bf73e405e332da117cf7ba05c5e15945eedc878128d6bc4441c",
});
export const ENTITLEMENT_TARGETS = Object.freeze(Object.keys(ENTITLEMENT_COLUMNS));
export const ENTITLEMENT_DERIVED_TRIGGERS = Object.freeze([]);

/** Two original226 families. Keep capture rows and proof bytes untouched; only the mapped copy changes representation. */
export function mapProductEntitlements(rows, manifest) {
  if (
    !(rows instanceof Map) ||
    !Array.isArray(manifest?.tables) ||
    !Array.isArray(manifest?.targetPin?.migrations)
  )
    fail("ENTITLEMENT_MANIFEST");
  for (const [name, sha256] of Object.entries(ENTITLEMENT_MIGRATIONS))
    if (!manifest.targetPin.migrations.some((m) => m.name === name && m.sha256 === sha256))
      fail("ENTITLEMENT_PREREQUISITE");
  const records = [];
  const ulids = new Set([
    "action_id",
    "organization_id",
    "project_id",
    "physical_environment_id",
    "billing_epoch_id",
    "claim_id",
  ]);
  for (const [table, declaration] of Object.entries(ENTITLEMENT_COLUMNS)) {
    const fields = declaration.split(","),
      metadata = manifest.tables.find((t) => t.name === table);
    if (
      !metadata ||
      !Array.isArray(metadata.columns) ||
      metadata.columns
        .map((c) => c.name)
        .sort()
        .join(",") !== fields.slice().sort().join(",") ||
      !rows.has(table) ||
      !Array.isArray(rows.get(table))
    )
      fail("ENTITLEMENT_SOURCE_REQUIRED");
    for (const c of metadata.columns) {
      const kind = ENTITLEMENT_KINDS[table][c.name],
        domain = ulids.has(c.name),
        pgType = domain
          ? "text"
          : kind === "integer"
            ? "bigint"
            : kind === "boolean"
              ? "boolean"
              : kind === "timestamp"
                ? "timestamp with time zone"
                : "text";
      if (c.pgType !== pgType || (c.sourceType ?? c.pgType) !== (domain ? "ulid" : pgType))
        fail("ENTITLEMENT_SOURCE_TYPE");
    }
    for (const original of rows.get(table)) {
      if (!original || Object.keys(original).sort().join(",") !== fields.slice().sort().join(","))
        fail("ENTITLEMENT_ROW_SHAPE");
      const row = {};
      for (const field of fields) {
        const value = original[field],
          kind = ENTITLEMENT_KINDS[table][field];
        if (value === null) {
          row[field] = null;
          continue;
        }
        if (typeof value !== "string") fail("ENTITLEMENT_ROW_VALUE");
        if (kind === "integer") row[field] = integerText(value);
        else if (kind === "boolean") {
          if (value !== "true" && value !== "false") fail("ENTITLEMENT_BOOLEAN");
          row[field] = value === "true" ? "1" : "0";
        } else if (kind === "timestamp") {
          if (
            !/^(?!0000-)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
          )
            fail("ENTITLEMENT_TIMESTAMP_UNREPRESENTABLE");
          row[field] = value;
        } else row[field] = value;
      }
      records.push({ table, row });
    }
  }
  return records;
}
