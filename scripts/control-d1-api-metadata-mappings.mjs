import { fail, integerText } from "./control-d1-codec.mjs";
import { readFixedProjectionPages } from "./control-d1-readback-pages.mjs";

export const API_METADATA_COLUMNS = Object.freeze({
  project_agent_notes: "project_id,version,markdown,updated_at",
  project_agent_note_requests:
    "organization_id,project_id,actor_id,idempotency_key,request_sha256,version,updated_at",
  project_powered_by_flag_requests:
    "organization_id,project_id,actor_id,idempotency_key,request_sha256,enabled,enabled_at,recorded_at",
});
export const API_METADATA_TARGETS = Object.freeze(Object.keys(API_METADATA_COLUMNS));
export const API_METADATA_SCHEMA_PINS = Object.freeze({
  "0493_original_api_metadata.sql":
    "c1deae06ae6cf4b91625368721e49392e2b90e0e4ef671b929293cf51143f46b",
});
const keys = {
  project_agent_notes: ["project_id"],
  project_agent_note_requests: ["organization_id", "project_id", "actor_id", "idempotency_key"],
  project_powered_by_flag_requests: [
    "organization_id",
    "project_id",
    "actor_id",
    "idempotency_key",
  ],
};
/** Original103/156 facts only: captured markdown, actor/key text and full historical timestamps are never normalized. */
export function mapApiMetadata(rows, manifest) {
  for (const [name, sha256] of Object.entries(API_METADATA_SCHEMA_PINS))
    if (
      !manifest?.targetPin?.migrations?.some(
        (entry) => entry.name === name && entry.sha256 === sha256,
      )
    )
      fail("API_METADATA_SCHEMA_PREREQUISITE");
  const records = [];
  for (const [table, projection] of Object.entries(API_METADATA_COLUMNS)) {
    const columns = projection.split(","),
      source = rows.get(table),
      metadata = manifest.tables.find((entry) => entry.name === table);
    if (
      !Array.isArray(source) ||
      !Array.isArray(metadata?.columns) ||
      metadata.columns
        .map((column) => column.name)
        .sort()
        .join(",") !== columns.slice().sort().join(",")
    )
      fail("API_METADATA_SOURCE_COLUMNS");
    for (const column of metadata.columns) {
      const pgType =
        column.name === "version"
          ? "integer"
          : column.name === "enabled"
            ? "boolean"
            : column.name === "request_sha256"
              ? "bytea"
              : column.name.endsWith("_at")
                ? "timestamp with time zone"
                : "text";
      const sourceType =
        column.name === "project_id" || column.name === "organization_id" ? "ulid" : pgType;
      if (column.pgType !== pgType || (column.sourceType ?? column.pgType) !== sourceType)
        fail("API_METADATA_SOURCE_TYPE");
    }
    for (const row of source) {
      if (!row || Object.keys(row).sort().join(",") !== columns.slice().sort().join(","))
        fail("API_METADATA_ROW_SHAPE");
      for (const [column, value] of Object.entries(row)) {
        if (value === null) continue;
        if (typeof value !== "string") fail("API_METADATA_ROW_VALUE");
        if (
          column === "version" &&
          (BigInt(integerText(value)) < 1n || BigInt(value) > 2147483647n)
        )
          fail("API_METADATA_VERSION");
        if (column === "enabled" && value !== "true" && value !== "false")
          fail("API_METADATA_BOOLEAN");
        if (column === "request_sha256" && !/^[a-f0-9]{64}$/u.test(value))
          fail("API_METADATA_DIGEST");
        if (
          column.endsWith("_at") &&
          (!/^(?!0000-)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))
        )
          fail("API_METADATA_TIMESTAMP");
      }
      records.push({
        table,
        row:
          table === "project_powered_by_flag_requests"
            ? { ...row, enabled: row.enabled === null ? null : row.enabled === "true" ? "1" : "0" }
            : { ...row },
      });
    }
  }
  return records;
}
/** Exact original non-NULL primary keys; native source widths bound the UTF8 cursor, never the returned history. */
export function readApiMetadataPages(db, table) {
  if (!Object.hasOwn(API_METADATA_COLUMNS, table)) fail("API_METADATA_READBACK_TABLE");
  const columns = API_METADATA_COLUMNS[table].split(","),
    projection = columns.map((column) =>
      column === "version"
        ? "CAST(version AS TEXT) version"
        : column === "enabled"
          ? "CASE enabled WHEN 1 THEN 'true' ELSE 'false' END enabled"
          : column === "request_sha256"
            ? "lower(hex(request_sha256)) request_sha256"
            : column,
    );
  return readFixedProjectionPages(db, {
    sql: `SELECT ${projection.join(",")} FROM ${table}`,
    columns,
    keys: keys[table].map((column) => ({
      column,
      kind: "text",
      maxBytes: column === "actor_id" ? 1024 : column === "idempotency_key" ? 512 : 26,
    })),
    keyProof: {
      kind: "primary-key",
      source:
        "Original103/156 non-null native PK; project/org ULID26 bytes, actor256/idempotency128 PostgreSQL characters at most4 UTF8 bytes each",
    },
  });
}
