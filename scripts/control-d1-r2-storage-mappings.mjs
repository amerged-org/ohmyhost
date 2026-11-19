import { createHash } from "node:crypto";
import { fail, integerText } from "./control-d1-codec.mjs";

// Exact ordered columns/types match BOTH retained20261028 original Control schema-only baselines.
export const R2_STORAGE_COLUMNS = Object.freeze({
  project_r2_bucket_reservations:
    "organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,jurisdiction,storage_class,public_access,reserved_at,create_started_at",
  project_r2_upload_reservations:
    "transfer_id,organization_id,project_id,environment_id,idempotency_key,request_sha256,object_key,content_type,expected_bytes,requested_at,expires_at,data_environment_id,physical_object_key,logical_namespace_version",
  project_r2_objects:
    "organization_id,project_id,environment_id,transfer_id,object_key,content_type,size,etag,uploaded_at,created_at,data_environment_id,physical_object_key",
  project_r2_delete_requests:
    "deletion_id,organization_id,project_id,environment_id,idempotency_key,request_sha256,object_key,requested_at,request_environment_id,data_environment_id,physical_object_key,object_was_observed",
  project_r2_delete_receipts:
    "deletion_id,organization_id,project_id,environment_id,object_key,deleted_at,data_environment_id,physical_object_key",
  project_r2_erasure_barriers:
    "transfer_id,deletion_id,organization_id,project_id,environment_id,data_environment_id,object_key,physical_object_key,bucket_name,jurisdiction,marker_sha256,erased_at",
});
export const R2_STORAGE_TYPES = Object.freeze({
  project_r2_bucket_reservations: {
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    operation_id: "text",
    claim_id: "text",
    bucket_name: "text",
    jurisdiction: "text",
    storage_class: "text",
    public_access: "boolean",
    reserved_at: "timestamp with time zone",
    create_started_at: "timestamp with time zone",
  },
  project_r2_upload_reservations: {
    transfer_id: "text",
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    idempotency_key: "character varying(128)",
    request_sha256: "bytea",
    object_key: "text",
    content_type: "text",
    expected_bytes: "bigint",
    requested_at: "timestamp with time zone",
    expires_at: "timestamp with time zone",
    data_environment_id: "text",
    physical_object_key: "text",
    logical_namespace_version: "smallint",
  },
  project_r2_objects: {
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    transfer_id: "text",
    object_key: "text",
    content_type: "text",
    size: "bigint",
    etag: "text",
    uploaded_at: "timestamp with time zone",
    created_at: "timestamp with time zone",
    data_environment_id: "text",
    physical_object_key: "text",
  },
  project_r2_delete_requests: {
    deletion_id: "text",
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    idempotency_key: "character varying(128)",
    request_sha256: "bytea",
    object_key: "text",
    requested_at: "timestamp with time zone",
    request_environment_id: "text",
    data_environment_id: "text",
    physical_object_key: "text",
    object_was_observed: "boolean",
  },
  project_r2_delete_receipts: {
    deletion_id: "text",
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    object_key: "text",
    deleted_at: "timestamp with time zone",
    data_environment_id: "text",
    physical_object_key: "text",
  },
  project_r2_erasure_barriers: {
    transfer_id: "text",
    deletion_id: "text",
    organization_id: "text",
    project_id: "text",
    environment_id: "text",
    data_environment_id: "text",
    object_key: "text",
    physical_object_key: "text",
    bucket_name: "text",
    jurisdiction: "text",
    marker_sha256: "bytea",
    erased_at: "timestamp with time zone",
  },
});
export const R2_STORAGE_KEYS = Object.freeze({
  project_r2_bucket_reservations: ["organization_id", "project_id", "environment_id"],
  project_r2_upload_reservations: ["transfer_id"],
  project_r2_objects: ["organization_id", "project_id", "environment_id", "physical_object_key"],
  project_r2_delete_requests: ["deletion_id"],
  project_r2_delete_receipts: ["deletion_id"],
  project_r2_erasure_barriers: ["transfer_id"],
});
export const R2_STORAGE_PARENTS = Object.freeze({
  project_r2_bucket_reservations: ["product_provider_mutation_claims"],
  project_r2_upload_reservations: ["project_r2_bucket_receipts", "project_data_environments"],
  project_r2_objects: ["project_r2_upload_reservations", "project_data_environments"],
  project_r2_delete_requests: [
    "project_r2_bucket_receipts",
    "project_data_environments",
    "environments",
  ],
  project_r2_delete_receipts: ["project_r2_delete_requests", "project_data_environments"],
  project_r2_erasure_barriers: [
    "project_r2_upload_reservations",
    "project_r2_delete_requests",
    "project_r2_bucket_receipts",
    "project_data_environments",
  ],
});
export const R2_STORAGE_SCHEMA_PINS = Object.freeze({
  "0492_r2_management_native.sql":
    "d0aae08f3350c983f756c01392ef8dd790896d2984ffc2da5069b0795c8a1aee",
  "0497_storage_erasure_native.sql":
    "dab95a3d3ed3565ad87d8642576fed3c1b18e640be418489325338204eefac4d",
});
export const R2_STORAGE_TARGETS = Object.freeze(Object.keys(R2_STORAGE_COLUMNS));
const notNull = Object.freeze({
  project_r2_bucket_reservations: [
    "organization_id",
    "project_id",
    "environment_id",
    "operation_id",
    "claim_id",
    "bucket_name",
    "jurisdiction",
    "storage_class",
    "public_access",
    "reserved_at",
  ],
  project_r2_upload_reservations: [
    "transfer_id",
    "organization_id",
    "project_id",
    "environment_id",
    "idempotency_key",
    "request_sha256",
    "object_key",
    "content_type",
    "expected_bytes",
    "requested_at",
    "expires_at",
    "data_environment_id",
    "physical_object_key",
    "logical_namespace_version",
  ],
  project_r2_objects: [
    "organization_id",
    "project_id",
    "environment_id",
    "transfer_id",
    "object_key",
    "content_type",
    "size",
    "etag",
    "uploaded_at",
    "created_at",
    "data_environment_id",
    "physical_object_key",
  ],
  project_r2_delete_requests: [
    "deletion_id",
    "organization_id",
    "project_id",
    "environment_id",
    "idempotency_key",
    "request_sha256",
    "object_key",
    "requested_at",
    "request_environment_id",
    "data_environment_id",
    "physical_object_key",
    "object_was_observed",
  ],
  project_r2_delete_receipts: [
    "deletion_id",
    "organization_id",
    "project_id",
    "environment_id",
    "object_key",
    "deleted_at",
    "data_environment_id",
    "physical_object_key",
  ],
  project_r2_erasure_barriers: [
    "transfer_id",
    "deletion_id",
    "organization_id",
    "project_id",
    "environment_id",
    "data_environment_id",
    "object_key",
    "physical_object_key",
    "bucket_name",
    "jurisdiction",
    "marker_sha256",
    "erased_at",
  ],
});

const domainFields = new Set([
  "organization_id",
  "project_id",
  "environment_id",
  "operation_id",
  "claim_id",
  "transfer_id",
  "deletion_id",
  "data_environment_id",
  "request_environment_id",
]);
export function r2StorageKind(table, column) {
  const type = R2_STORAGE_TYPES[table]?.[column];
  if (!type) fail("R2_STORAGE_COLUMN");
  return ["smallint", "bigint"].includes(type)
    ? "integer"
    : type === "bytea"
      ? "bytea"
      : type === "boolean"
        ? "boolean"
        : type === "timestamp with time zone"
          ? "timestamp"
          : "text";
}
function timestamp(value) {
  if (
    !/^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    fail("R2_STORAGE_TIMESTAMP");
}
/** Validate the actual original167 marker bytes; never repair or synthesize a captured proof. */
export function assertR2StorageMarker(row) {
  const expected = createHash("sha256")
    .update(
      [
        "ohmyhost.r2-erasure/v1",
        row.organization_id,
        row.project_id,
        row.environment_id,
        row.data_environment_id,
        row.transfer_id,
        row.physical_object_key,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  if (row.marker_sha256 !== expected) fail("R2_STORAGE_MARKER");
}
/** Six original physical families only. Parent admission belongs to the central original-source planner. */
export function mapR2Storage(rows, manifest, capture) {
  void capture;
  if (
    !(rows instanceof Map) ||
    !Array.isArray(manifest?.tables) ||
    !Array.isArray(manifest?.targetPin?.migrations)
  )
    fail("R2_STORAGE_MANIFEST");
  for (const [name, sha256] of Object.entries(R2_STORAGE_SCHEMA_PINS))
    if (!manifest.targetPin.migrations.some((m) => m.name === name && m.sha256 === sha256))
      fail("R2_STORAGE_PREREQUISITE");
  const records = [];
  for (const [table, declaration] of Object.entries(R2_STORAGE_COLUMNS)) {
    const fields = declaration.split(","),
      metadata = manifest.tables.find((t) => t.name === table),
      source = rows.get(table);
    if (
      !metadata ||
      metadata.columns?.map((c) => c.name).join(",") !== declaration ||
      !Array.isArray(source)
    )
      fail("R2_STORAGE_SOURCE_REQUIRED");
    for (const c of metadata.columns) {
      const type = R2_STORAGE_TYPES[table][c.name],
        domain = domainFields.has(c.name);
      if (
        c.pgType !== type ||
        (c.sourceType ?? c.pgType) !== (domain ? "ulid" : type) ||
        c.notNull !== notNull[table].includes(c.name)
      )
        fail("R2_STORAGE_SOURCE_TYPE");
    }
    for (const original of source) {
      if (!original || Object.keys(original).sort().join(",") !== fields.slice().sort().join(","))
        fail("R2_STORAGE_ROW_SHAPE");
      const row = {};
      for (const field of fields) {
        const value = original[field],
          kind = r2StorageKind(table, field);
        if (value === null) {
          if (notNull[table].includes(field)) fail("R2_STORAGE_NULL");
          row[field] = null;
          continue;
        }
        if (typeof value !== "string") fail("R2_STORAGE_ROW_VALUE");
        if (domainFields.has(field) && !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value))
          fail("R2_STORAGE_ULID");
        if (kind === "integer") {
          integerText(value);
          if (
            R2_STORAGE_TYPES[table][field] === "smallint" &&
            (BigInt(value) < -32768n || BigInt(value) > 32767n)
          )
            fail("R2_STORAGE_INT2");
          row[field] = value;
        } else if (kind === "boolean") {
          if (value !== "true" && value !== "false") fail("R2_STORAGE_BOOLEAN");
          row[field] = value === "true" ? "1" : "0";
        } else if (kind === "bytea") {
          if (!/^[0-9a-f]{64}$/u.test(value)) fail("R2_STORAGE_BYTEA");
          row[field] = value;
        } else {
          if (kind === "timestamp") timestamp(value);
          else if (value.includes("\0")) fail("R2_STORAGE_TEXT");
          row[field] = value;
        }
      }
      if (table === "project_r2_erasure_barriers") assertR2StorageMarker(original);
      records.push({ table, row });
    }
  }
  return records;
}
