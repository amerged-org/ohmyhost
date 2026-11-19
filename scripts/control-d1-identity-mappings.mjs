import { createRequire } from "node:module";
import { URL } from "node:url";
import { fail } from "./control-d1-codec.mjs";

const { types } = createRequire(new URL("../packages/database/package.json", import.meta.url))(
  "pg",
);
const parseTextArray = types.getTypeParser(1009, "text");
export { arrayJson as postgresArrayToJson, arrayText as postgresArrayText };
export const IDENTITY_KEY_COLUMNS = Object.freeze({
  api_key_metadata:
    "api_key_id,created_by_principal_id,organization_id,key_digest,key_prefix,pepper_version,scopes,created_at,expires_at,revoked_at,last_used_at",
  m2m_organization_bindings:
    "connect_client_id,organization_id,scopes,state,mapping_revision,created_at,expires_at,revoked_at",
  user_api_key_requests:
    "request_id,organization_id,workos_user_id,workos_organization_id,idempotency_sha256,request_sha256,name,permissions,requested_at,expires_at,provider_key_id,failure_code,finished_at",
});

function arrayText(values) {
  if (!Array.isArray(values) || values.some((value) => value !== null && typeof value !== "string"))
    fail("IDENTITY_ARRAY_UNREPRESENTABLE");
  return `{${values
    .map((value) => {
      if (value === null) return "NULL";
      return value === "" || /^null$/iu.test(value) || /[{},"\\ \t\n\r\v\f]/u.test(value)
        ? `"${value.replace(/["\\]/gu, "\\$&")}"`
        : value;
    })
    .join(",")}}`;
}

/** Preserve list order, duplicates, NULL/quoted text exactly; never erase PG dimensions/lower bounds. */
function arrayJson(value) {
  if (typeof value !== "string" || !value.startsWith("{")) fail("IDENTITY_ARRAY_BOUNDS");
  const values = parseTextArray(value);
  if (arrayText(values) !== value) fail("IDENTITY_ARRAY_UNREPRESENTABLE");
  return JSON.stringify(values);
}

/** Original issuance/legacy metadata only: no provider key values, reissue or inferred revocation. */
export function mapIdentityKeys(rows, manifest) {
  const records = [];
  const organizations = new Set(
    (rows.get("workos_organization_mappings") ?? []).map((row) => row.organization_id),
  );
  for (const table of Object.keys(IDENTITY_KEY_COLUMNS)) {
    const array = table === "user_api_key_requests" ? "permissions" : "scopes";
    const timestamps = manifest.tables
      .find((entry) => entry.name === table)
      .columns.filter((column) => column.kind === "timestamp");
    for (const row of rows.get(table)) {
      if (table !== "api_key_metadata" && !organizations.has(row.organization_id))
        fail("IDENTITY_PARENT_UNREPRESENTABLE");
      for (const column of timestamps)
        if (
          row[column.name] !== null &&
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row[column.name])
        )
          fail("IDENTITY_TIMESTAMP_UNREPRESENTABLE");
      records.push({ table, row: { ...row, [array]: arrayJson(row[array]) } });
    }
  }
  return records;
}

/** Closed original key-metadata readers. Scope-array lexical roundtrip is part of typed source proof. */
export async function readIdentityKeySourceFacts(db) {
  const facts = new Map();
  const integers = new Set(["pepper_version", "mapping_revision"]);
  const blobs = new Set(["key_digest", "idempotency_sha256", "request_sha256"]);
  for (const [table, columns] of Object.entries(IDENTITY_KEY_COLUMNS)) {
    const selected = columns
      .split(",")
      .map((name) =>
        integers.has(name)
          ? `CAST(${name} AS TEXT) ${name}`
          : blobs.has(name)
            ? `lower(hex(${name})) ${name}`
            : name,
      );
    const values = (await db.prepare(`SELECT ${selected.join(",")} FROM ${table}`).all()).results;
    const array = table === "user_api_key_requests" ? "permissions" : "scopes";
    facts.set(
      table,
      values.map((row) => ({ ...row, [array]: arrayText(JSON.parse(row[array])) })),
    );
  }
  return facts;
}
