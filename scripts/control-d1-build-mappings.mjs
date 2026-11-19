import { fail, integerText } from "./control-d1-codec.mjs";
import { readFixedProjectionPages } from "./control-d1-readback-pages.mjs";

export const BUILD_COLUMNS = Object.freeze({
  build_input_reservations:
    "organization_id,project_id,environment_id,operation_id,input_fingerprint,claim_id,claim_mode,claimed_at,lease_expires_at,attempt_number,created_at,start_allowed_until",
  build_receipts:
    "organization_id,project_id,environment_id,operation_id,provider_build_id,build_project_name,created_at,input_fingerprint,build_claim_id",
  build_usage:
    "organization_id,project_id,environment_id,operation_id,billing_epoch_id,provider_build_id,build_project_name,runner,instance_type,status,started_at,provisioning_started_at,completed_at,observed_at",
});
export const BUILD_SCHEMA_PINS = Object.freeze({
  "0322_build_receipts.sql": "dedc06d9e3001e92be9a97bc527fd7d83d4880198400c666811bb1b5a05cd353",
  "0325_build_history_scope.sql":
    "886cc867922ba28b4dc30f8341aa910dc21dbddb96658487d7cfa0f731e6b0fc",
});
const KEYS = ["organization_id", "project_id", "environment_id", "operation_id"];
const TIMES = new Set([
  "claimed_at",
  "lease_expires_at",
  "created_at",
  "start_allowed_until",
  "started_at",
  "provisioning_started_at",
  "completed_at",
  "observed_at",
]);

/** Original127 physical facts only; no provider result, usage settlement or new launch permission is inferred. */
export function mapBuild(rows, manifest) {
  for (const [name, sha256] of Object.entries(BUILD_SCHEMA_PINS))
    if (
      !manifest.targetPin.migrations.some((entry) => entry.name === name && entry.sha256 === sha256)
    )
      fail("BUILD_SCHEMA_PREREQUISITE");
  const records = [];
  for (const [table, fields] of Object.entries(BUILD_COLUMNS)) {
    const expected = fields.split(",").sort().join(","),
      definition = manifest.tables.find((entry) => entry.name === table);
    if (
      !definition ||
      definition.columns
        .map((column) => column.name)
        .sort()
        .join(",") !== expected
    )
      fail("BUILD_SOURCE_COLUMNS");
    const source = rows.get(table);
    if (!Array.isArray(source)) fail("BUILD_SOURCE_TABLE");
    for (const row of source) {
      if (Object.keys(row).sort().join(",") !== expected) fail("BUILD_ROW_SHAPE");
      for (const [field, value] of Object.entries(row)) {
        if (value === null) continue;
        if (typeof value !== "string") fail("BUILD_ROW_VALUE");
        if (TIMES.has(field) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value))
          fail("BUILD_TIMESTAMP_UNREPRESENTABLE");
        if (field === "input_fingerprint" && !/^(?:[a-f0-9]{2})*$/u.test(value))
          fail("BUILD_BYTEA_UNREPRESENTABLE");
        if (field === "attempt_number") integerText(value);
      }
      records.push({ table, row: { ...row } });
    }
  }
  return records;
}

/** Fixed original-shaped pages. All four cursor fields are the original non-NULL ASCII ULID primary key. */
export function readBuildSourcePages(db, table) {
  if (!Object.hasOwn(BUILD_COLUMNS, table)) fail("BUILD_READBACK_TABLE");
  const columns = BUILD_COLUMNS[table].split(","),
    selected = columns.map((column) =>
      column === "input_fingerprint"
        ? `CASE WHEN input_fingerprint IS NULL THEN NULL ELSE lower(hex(input_fingerprint)) END input_fingerprint`
        : column === "attempt_number"
          ? "CAST(attempt_number AS TEXT) attempt_number"
          : column,
    );
  return readFixedProjectionPages(db, {
    sql: `SELECT ${selected.join(",")} FROM ${table}`,
    columns,
    keys: KEYS.map((column) => ({ column, kind: "text", maxBytes: 26 })),
    keyProof: {
      kind: "primary-key",
      source:
        "original127 retained four-ULID PK; qualified0325 identical key and original static scope",
    },
  });
}

/** Fixture compatibility only. Whole-source proof consumes readBuildSourcePages directly. */
export async function readBuildSourceFacts(db) {
  const facts = new Map();
  for (const table of Object.keys(BUILD_COLUMNS)) {
    const rows = [];
    for await (const page of readBuildSourcePages(db, table)) rows.push(...page);
    facts.set(table, rows);
  }
  return facts;
}
