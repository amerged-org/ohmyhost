import { fail, integerText } from "./control-d1-codec.mjs";

export const FUNCTION_COLUMNS = Object.freeze({
  environment_function_schedules:
    "organization_id,project_id,environment_id,deployment_id,candidate_receipt_id,immutable_script_name,crons,egress_allowed_origins,updated_at",
  function_runs:
    "run_id,organization_id,project_id,environment_id,deployment_id,immutable_script_name,cron,scheduled_at,state,attempt,lease_until,started_at,finished_at,status_code,egress_allowed_origins,created_at,updated_at",
});
export const FUNCTION_KEYS = Object.freeze({
  environment_function_schedules: ["organization_id", "environment_id"],
  function_runs: ["organization_id", "run_id"],
});
export const FUNCTION_TARGETS = Object.freeze(Object.keys(FUNCTION_COLUMNS));
export const FUNCTION_DERIVED_TRIGGERS = Object.freeze([]);
export const FUNCTION_SCHEMA_PINS = Object.freeze({
  "0361_function_schedule_source_shape.sql":
    "34c6f6b7e02ec8d3231986dec1dcb30c9e0d8e0fb8c1f2ee18e0e50364a1b3f8",
});
export const FUNCTION_SOURCE_MIGRATIONS = Object.freeze({
  "120_functions_runtime_and_cron_schedules.mjs":
    "56ff23a425808cba0b2551c73f6b21a0aef0d8050384350c409e06bbb42c2eea",
});
const integers = new Set(["attempt", "status_code"]),
  json = new Set(["crons", "egress_allowed_origins"]),
  ulids = new Set([
    "organization_id",
    "project_id",
    "environment_id",
    "deployment_id",
    "candidate_receipt_id",
    "run_id",
  ]);
export const FUNCTION_KINDS = Object.freeze(
  Object.fromEntries(
    Object.entries(FUNCTION_COLUMNS).map(([table, columns]) => [
      table,
      Object.fromEntries(
        columns
          .split(",")
          .map((column) => [
            column,
            integers.has(column)
              ? "integer"
              : column.endsWith("_at") || column === "lease_until"
                ? "timestamp"
                : "text",
          ]),
      ),
    ]),
  ),
);

/** Original120 only: do not normalize captured JSON, crons, script names, orphan runs or historical times. */
export function mapFunctionSchedules(rows, manifest) {
  if (!(rows instanceof Map) || !Array.isArray(manifest?.tables)) fail("FUNCTION_MANIFEST");
  for (const [name, sha256] of Object.entries(FUNCTION_SCHEMA_PINS))
    if (
      !manifest.targetPin?.migrations?.some(
        (migration) => migration.name === name && migration.sha256 === sha256,
      )
    )
      fail("FUNCTION_PREREQUISITE");
  const records = [];
  for (const [table, columns] of Object.entries(FUNCTION_COLUMNS)) {
    const names = columns.split(","),
      metadata = manifest.tables.find((entry) => entry.name === table),
      source = rows.get(table);
    if (
      !metadata ||
      !Array.isArray(metadata.columns) ||
      metadata.columns
        .map((column) => column.name)
        .sort()
        .join(",") !== names.slice().sort().join(",") ||
      !Array.isArray(source)
    )
      fail("FUNCTION_SOURCE_REQUIRED");
    for (const column of metadata.columns) {
      const kind = FUNCTION_KINDS[table][column.name],
        pgType =
          kind === "integer"
            ? "integer"
            : kind === "timestamp"
              ? "timestamp with time zone"
              : json.has(column.name)
                ? "jsonb"
                : "text";
      if (
        column.pgType !== pgType ||
        (column.sourceType ?? column.pgType) !== (ulids.has(column.name) ? "ulid" : pgType)
      )
        fail("FUNCTION_SOURCE_TYPE");
    }
    for (const original of source) {
      if (!original || Object.keys(original).sort().join(",") !== names.slice().sort().join(","))
        fail("FUNCTION_ROW_SHAPE");
      for (const column of names) {
        const value = original[column],
          kind = FUNCTION_KINDS[table][column];
        if (value === null) continue;
        if (typeof value !== "string") fail("FUNCTION_ROW_VALUE");
        if (kind === "integer") integerText(value);
        if (
          kind === "timestamp" &&
          (!/^(?!0000-)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))
        )
          fail("FUNCTION_TIMESTAMP_UNREPRESENTABLE");
      }
      records.push({ table, row: { ...original } });
    }
  }
  return records;
}

/** Fixed native BINARY PK seeks; key/length windows never collect a whole table's opaque payloads. */
export async function* readFunctionSchedulePages(db, table) {
  if (!Object.hasOwn(FUNCTION_COLUMNS, table)) fail("FUNCTION_READBACK_TABLE");
  const columns = FUNCTION_COLUMNS[table].split(","),
    keys = FUNCTION_KEYS[table],
    kinds = FUNCTION_KINDS[table];
  const projection = columns
    .map((column) =>
      kinds[column] === "integer" ? `CAST(${column} AS TEXT) AS ${column}` : column,
    )
    .join(",");
  const overhead = columns.reduce((sum, column) => sum + column.length + 10, 2),
    bytes = columns.map((column) => `6*coalesce(length(CAST(${column} AS BLOB)),0)`).join("+");
  const count = await db.prepare(`SELECT CAST(count(*) AS TEXT) n FROM ${table}`).first();
  if (typeof count?.n !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(count.n))
    fail("FUNCTION_READBACK_COUNT");
  let after = null,
    seen = 0n;
  for (;;) {
    const where =
      after === null ? "" : ` WHERE (${keys.join(",")})>(${keys.map(() => "?").join(",")})`;
    const candidates = (
      await db
        .prepare(
          `SELECT ${keys.join(",")},${overhead}+${bytes} __bytes FROM ${table}${where} ORDER BY ${keys.join(",")} LIMIT 128`,
        )
        .bind(...(after ?? []))
        .all()
    ).results;
    if (candidates.length === 0) break;
    let size = 0;
    const chosen = [];
    for (const candidate of candidates) {
      if (
        !Number.isSafeInteger(candidate.__bytes) ||
        candidate.__bytes < 0 ||
        keys.some(
          (key) =>
            typeof candidate[key] !== "string" ||
            !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(candidate[key]),
        )
      )
        fail("FUNCTION_READBACK_KEY");
      if (chosen.length && size + candidate.__bytes > 256 * 1024) break;
      chosen.push(candidate);
      size += candidate.__bytes;
    }
    const end = keys.map((key) => chosen.at(-1)[key]);
    const predicate = `${where}${where ? " AND" : " WHERE"} (${keys.join(",")})<=(${keys.map(() => "?").join(",")})`;
    const page = (
      await db
        .prepare(
          `SELECT ${projection} FROM ${table}${predicate} ORDER BY ${keys.join(",")} LIMIT ${chosen.length}`,
        )
        .bind(...(after ?? []), ...end)
        .all()
    ).results;
    if (
      page.length !== chosen.length ||
      page.some((row, index) => keys.some((key) => row[key] !== chosen[index][key])) ||
      JSON.stringify(after) === JSON.stringify(end)
    )
      fail("FUNCTION_READBACK_CURSOR");
    seen += BigInt(page.length);
    after = end;
    yield page;
  }
  if (
    seen !== BigInt(count.n) ||
    (await db.prepare(`SELECT CAST(count(*) AS TEXT) n FROM ${table}`).first())?.n !== count.n
  )
    fail("FUNCTION_READBACK_COUNT_CHANGED");
}
