import { fail } from "./control-d1-codec.mjs";

export const STORAGE_COLUMNS = Object.freeze({
  storage_gateway_keys:
    "organization_id,project_id,environment_id,key_version,key_sha256,created_at",
});
export const STORAGE_TARGETS = Object.freeze(Object.keys(STORAGE_COLUMNS));
export const STORAGE_SCHEMA_PINS = Object.freeze({
  "0337_provider_canonical_sources.sql":
    "c856a047838e982befae4f71fab7b73232bf82bec1f023ed2a23228e6ff419f8",
  "0372_runtime_secret_storage_key.sql":
    "78ed5b2ab276600825c93c7fa7819acbee629f917219706eaa39dc3005dfb6fc",
});
const KINDS = {
  storage_gateway_keys: {
    key_version: "integer",
    key_sha256: "bytea",
    created_at: "timestamp",
  },
};

function converted(rows, manifest) {
  for (const [name, sha256] of Object.entries(STORAGE_SCHEMA_PINS))
    if (
      !manifest.targetPin.migrations.some((entry) => entry.name === name && entry.sha256 === sha256)
    )
      fail("STORAGE_SCHEMA_PREREQUISITE");
  const records = [];
  for (const [table, columns] of Object.entries(STORAGE_COLUMNS)) {
    const definition = manifest.tables.find((entry) => entry.name === table);
    if (
      !definition ||
      [...definition.columns.map((c) => c.name)].sort().join(",") !==
        columns.split(",").sort().join(",")
    )
      fail("STORAGE_SOURCE_COLUMNS");
    const originals = rows.get(table);
    if (!Array.isArray(originals)) fail("STORAGE_SOURCE_TABLE");
    for (const original of originals) {
      if (Object.keys(original).sort().join(",") !== columns.split(",").sort().join(","))
        fail("STORAGE_ROW_SHAPE");
      const row = { ...original };
      for (const name of columns.split(",")) {
        const kind = KINDS[table][name];
        const value = row[name];
        if (value === null) continue;
        if (typeof value !== "string") fail("STORAGE_ROW_VALUE");
        if (kind === "timestamp" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value))
          fail("STORAGE_TIMESTAMP_UNREPRESENTABLE");
        if (
          kind === "integer" &&
          (!/^-?(?:0|[1-9][0-9]*)$/u.test(value) ||
            BigInt(value) < -9223372036854775808n ||
            BigInt(value) > 9223372036854775807n)
        )
          fail("STORAGE_INTEGER_UNREPRESENTABLE");
        if (kind === "bytea" && !/^(?:[a-f0-9]{2})*$/u.test(value))
          fail("STORAGE_BYTEA_UNREPRESENTABLE");
      }
      records.push({ table, row });
    }
  }
  return records;
}

/** Original typed facts only: opaque evidence and sealed ciphertext/AAD identities are never rewritten. */
export async function readStorageSourceFacts(db) {
  const facts = new Map();
  for (const [table, columns] of Object.entries(STORAGE_COLUMNS)) {
    const selected = columns.split(",").map((name) => {
      const kind = KINDS[table][name];
      return kind === "integer"
        ? `CAST(${name} AS TEXT) ${name}`
        : kind === "bytea"
          ? `CASE WHEN ${name} IS NULL THEN NULL ELSE lower(hex(${name})) END ${name}`
          : name;
    });
    const values = (await db.prepare(`SELECT ${selected.join(",")} FROM ${table}`).all()).results;
    facts.set(
      table,
      values.map((original) => {
        return { ...original };
      }),
    );
  }
  return facts;
}

export function mapStorage(rows, manifest) {
  return converted(rows, manifest);
}
