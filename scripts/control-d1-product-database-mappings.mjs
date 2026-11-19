import { fail, integerText } from "./control-d1-codec.mjs";

export const PRODUCT_DATABASE_COLUMNS = Object.freeze({
  project_database_access:
    "access_id,organization_id,project_id,environment_id,environment,data_environment_id,provider_project_id,default_branch_id,role_name,mode,label,principal_id,origin_host,issued_at,expires_at,revoked_at,revoked_by,revocation_reason,role_dropped_at,provider,database_id,provider_create_operation_id,provider_delete_operation_id",
  project_database_writes:
    "operation_id,organization_id,project_id,environment_id,environment,data_environment_id,billing_epoch_id,provider_project_id,default_branch_id,principal_id,idempotency_key,request_sha256,started_at,deadline_at,completed_at,command,affected_rows,failure_code,provider,database_id",
  pgcf_database_compute_changes:
    "operation_id,organization_id,project_id,environment_id,data_environment_id,billing_epoch_id,provider_project_id,database_id,target_version,memory_mib,size_class_id,accepted_lifecycle_version,requested_at,claim_id,claim_expires_at,last_attempted_at,completed_at,failure_code",
});
export const PRODUCT_DATABASE_TARGETS = Object.freeze(Object.keys(PRODUCT_DATABASE_COLUMNS));
export const PRODUCT_DATABASE_SCHEMA_PINS = Object.freeze({
  "0401_original_product_database_ulid.sql":
    "ca37a288c8ca528b9e043cab5551a18977eb42b7cabe3ed5fdfd0519d255c9de",
  "0400_original_product_database_jobs.sql":
    "9c6c7ed3507b32fc4bd0721c0f0e32d0c71504a0349a41568f1e49db0d193e3e",
});
const KINDS = {
  project_database_access: {
    issued_at: "timestamp",
    expires_at: "timestamp",
    revoked_at: "timestamp",
    role_dropped_at: "timestamp",
  },
  project_database_writes: {
    request_sha256: "bytea",
    started_at: "timestamp",
    deadline_at: "timestamp",
    completed_at: "timestamp",
    affected_rows: "integer",
  },
  pgcf_database_compute_changes: {
    target_version: "integer",
    memory_mib: "integer",
    accepted_lifecycle_version: "integer",
    requested_at: "timestamp",
    claim_expires_at: "timestamp",
    last_attempted_at: "timestamp",
    completed_at: "timestamp",
  },
};

/** Raw original facts, including expired/revoked logins, failed/unknown writes and unchanged historical class names. */
export function mapProductDatabase(rows, manifest) {
  for (const [name, sha256] of Object.entries(PRODUCT_DATABASE_SCHEMA_PINS))
    if (
      !manifest.targetPin.migrations.some((entry) => entry.name === name && entry.sha256 === sha256)
    )
      fail("PRODUCT_DATABASE_SCHEMA_PREREQUISITE");
  const records = [];
  for (const [table, columns] of Object.entries(PRODUCT_DATABASE_COLUMNS)) {
    const names = columns.split(","),
      expected = [...names].sort().join(","),
      definition = manifest.tables.find((entry) => entry.name === table);
    if (
      !definition ||
      definition.columns
        .map((c) => c.name)
        .sort()
        .join(",") !== expected
    )
      fail("PRODUCT_DATABASE_SOURCE_COLUMNS");
    const source = rows.get(table);
    if (!Array.isArray(source)) fail("PRODUCT_DATABASE_SOURCE_TABLE");
    for (const row of source) {
      if (Object.keys(row).sort().join(",") !== expected) fail("PRODUCT_DATABASE_ROW_SHAPE");
      for (const name of names) {
        const value = row[name],
          kind = KINDS[table][name];
        if (value === null) continue;
        if (typeof value !== "string") fail("PRODUCT_DATABASE_ROW_VALUE");
        if (kind === "integer") integerText(value);
        if (kind === "timestamp" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value))
          fail("PRODUCT_DATABASE_TIMESTAMP_UNREPRESENTABLE");
        if (kind === "bytea" && !/^(?:[a-f0-9]{2})*$/u.test(value))
          fail("PRODUCT_DATABASE_BYTEA_UNREPRESENTABLE");
      }
      records.push({ table, row: { ...row } });
    }
  }
  return records;
}

/** Small-fixture collector; the whole-source converter must use its bounded streaming proof path. */
export async function readProductDatabaseSourceFacts(db) {
  const facts = new Map();
  for (const [table, columns] of Object.entries(PRODUCT_DATABASE_COLUMNS)) {
    const selected = columns
      .split(",")
      .map((name) =>
        KINDS[table][name] === "integer"
          ? `CAST(${name} AS TEXT) ${name}`
          : KINDS[table][name] === "bytea"
            ? `CASE WHEN ${name} IS NULL THEN NULL ELSE lower(hex(${name})) END ${name}`
            : name,
      );
    facts.set(
      table,
      (await db.prepare(`SELECT ${selected.join(",")} FROM ${table}`).all()).results,
    );
  }
  return facts;
}
