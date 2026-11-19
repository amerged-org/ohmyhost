import { fail, integerText } from "./control-d1-codec.mjs";
import { parseMeteringUuidArray } from "./control-d1-metering-array.mjs";

/** Exact native PG18 column order/sets of the three provider resource families the Core keeps; the rest of metering is removed. */
export const METERING_COLUMNS = Object.freeze({
  project_r2_bucket_receipts:
    "organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at",
  project_database_compute_changes:
    "operation_id,organization_id,project_id,environment_id,data_environment_id,billing_epoch_id,provider_project_id,default_branch_id,endpoint_id,profile,compute_units,suspend_timeout_seconds,requested_at,claim_id,claim_expires_at,patch_started_at,last_attempted_at,provider_operation_ids,provider_observed_at,completed_at,failure_code,requested_preset",
  paid_project_domains:
    "organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,custom_hostname_receipt,worker_route_receipt,delete_idempotency_sha256,delete_request_sha256,created_at,updated_at,deleted_at,provisioning_started_at",
});
export const METERING_TARGETS = Object.freeze(Object.keys(METERING_COLUMNS));
const METERING_SCHEMA_PINS = Object.freeze({
  "0480_paid_domain_native_integrity.sql":
    "4f874a39325ae9b605300c755654c0c286d3902c08ed2decafde14dd379bfcd4",
  "0481_compute_operation_uuid_integrity.sql":
    "8649a5f8551711350f01060984fcaf6a6150939ebc9c050db87dca1483dd987c",
  "0482_compute_operation_array_bounds.sql":
    "94f0bece9976619aa84ccbe98b5abff820b6879e94149162b027257a2974155b",
  "0483_compute_operation_array_leaf_depth.sql":
    "8c3abfc0466092ed32916d94d60a9a9efef907074eb61f699bf81794289bd58a",
});
const BOOLEAN = new Set(["public_access"]);
function prerequisites(manifest) {
  for (const [name, sha] of Object.entries(METERING_SCHEMA_PINS))
    if (!manifest.targetPin.migrations.some((entry) => entry.name === name && entry.sha256 === sha))
      fail("METERING_SOURCE_PREREQUISITE");
}
function checkedRows(rows, manifest, table) {
  const found = rows.get(table),
    definition = manifest.tables.find((entry) => entry.name === table);
  if (
    !Array.isArray(found) ||
    !definition ||
    definition.columns.map((column) => column.name).join(",") !== METERING_COLUMNS[table]
  )
    fail("METERING_SOURCE_COLUMNS");
  for (const row of found)
    for (const column of definition.columns) {
      const value = row[column.name];
      if (value !== null && typeof value !== "string") fail("METERING_SOURCE_VALUE");
      if (value === null) continue;
      if (
        column.kind === "timestamp" &&
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
      )
        fail("METERING_TIMESTAMP_UNREPRESENTABLE");
      if (column.kind === "integer") integerText(value);
    }
  return found;
}
/** Original source facts only; no quantity/price inference, ID replacement or archive rewrite. */
export function mapMetering(rows, manifest) {
  prerequisites(manifest);
  const records = [];
  for (const table of METERING_TARGETS)
    for (const fact of checkedRows(rows, manifest, table)) {
      const row = { ...fact };
      for (const name of BOOLEAN)
        if (Object.hasOwn(row, name)) {
          if (row[name] !== "true" && row[name] !== "false") fail("METERING_BOOLEAN");
          row[name] = row[name] === "true" ? "1" : "0";
        }
      if (table === "project_database_compute_changes") {
        const array = parseMeteringUuidArray(row.provider_operation_ids);
        row.provider_operation_ids = array.values === null ? null : JSON.stringify(array.values);
        row.provider_operation_ids_bounds =
          array.bounds === null ? null : JSON.stringify(array.bounds);
      }
      records.push({ table, row });
    }
  return records;
}
