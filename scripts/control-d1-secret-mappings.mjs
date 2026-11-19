import { fail } from "./control-d1-codec.mjs";
import { postgresArrayToJson, postgresArrayText } from "./control-d1-identity-mappings.mjs";

export const SECRET_COLUMNS = Object.freeze({
  environment_secrets:
    "organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at",
  environment_secret_requests:
    "organization_id,project_id,environment_id,action,name,idempotency_key,request_sha256,response,requested_at,completed_at",
  runtime_secret_delivery_states:
    "organization_id,project_id,environment_id,desired_generation,applied_generation,active_lease_id,claimed_generation,claimed_trigger,claimed_at,lease_expires_at,provider_tag,applied_secret_names,applied_manifest_sha256,applied_secret_count,last_failure_code,last_failed_at,created_at,updated_at,next_release_sequence,claimed_release_sequence,applied_release_sequence",
  runtime_secret_delivery_receipts:
    "receipt_id,organization_id,project_id,environment_id,lease_id,generation,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,completed_at,release_sequence",
  runtime_secret_delivery_stages:
    "stage_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,candidate_receipt_id,lease_id,generation,release_sequence,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,staged_at",
  runtime_secret_delivery_stage_activations:
    "activation_receipt_id,stage_receipt_id,gateway_version_id,gateway_deployment_id,activated_at,organization_id,project_id,environment_id,shared_gateway_revision",
  runtime_secret_delivery_stage_compensations:
    "compensation_receipt_id,stage_receipt_id,failure_code,compensated_at",
});
export const SECRET_TARGETS = Object.freeze(Object.keys(SECRET_COLUMNS));
export const SECRET_SCHEMA_PINS = Object.freeze({
  "0370_runtime_secret_delivery.sql":
    "1a60659019ad2ceabd5d5829d476e63cf44f0bc04b07b55ab6a06e46e743d0dd",
  "0371_runtime_secret_stage_history.sql":
    "46dd57529a47b8916ee71acc3f88db2e5b51d4d46e17fd335d6dd73301e80834",
  "0373_environment_secret_request_history.sql":
    "b7fb3434e2ea5e2ad58fada0a1144b68ab2a99f3f79544bfc2f40ca157244e99",
});
const KINDS = {
  environment_secrets: {
    ciphertext: "bytea",
    nonce: "bytea",
    value_sha256: "bytea",
    key_version: "integer",
    revision: "integer",
    created_at: "timestamp",
    updated_at: "timestamp",
  },
  environment_secret_requests: {
    request_sha256: "bytea",
    requested_at: "timestamp",
    completed_at: "timestamp",
  },
  runtime_secret_delivery_states: {
    desired_generation: "integer",
    applied_generation: "integer",
    claimed_generation: "integer",
    claimed_at: "timestamp",
    lease_expires_at: "timestamp",
    applied_secret_names: "array",
    applied_manifest_sha256: "bytea",
    applied_secret_count: "integer",
    last_failed_at: "timestamp",
    created_at: "timestamp",
    updated_at: "timestamp",
    next_release_sequence: "integer",
    claimed_release_sequence: "integer",
    applied_release_sequence: "integer",
  },
  runtime_secret_delivery_receipts: {
    generation: "integer",
    applied_secret_names: "array",
    manifest_sha256: "bytea",
    manifest_secret_count: "integer",
    completed_at: "timestamp",
    release_sequence: "integer",
  },
  runtime_secret_delivery_stages: {
    generation: "integer",
    release_sequence: "integer",
    applied_secret_names: "array",
    manifest_sha256: "bytea",
    manifest_secret_count: "integer",
    staged_at: "timestamp",
  },
  runtime_secret_delivery_stage_activations: {
    activated_at: "timestamp",
    shared_gateway_revision: "integer",
  },
  runtime_secret_delivery_stage_compensations: {
    compensated_at: "timestamp",
  },
};

function converted(rows, manifest) {
  for (const [name, sha256] of Object.entries(SECRET_SCHEMA_PINS))
    if (
      !manifest.targetPin.migrations.some((entry) => entry.name === name && entry.sha256 === sha256)
    )
      fail("SECRET_SCHEMA_PREREQUISITE");
  const records = [];
  for (const [table, columns] of Object.entries(SECRET_COLUMNS)) {
    const definition = manifest.tables.find((entry) => entry.name === table);
    if (
      !definition ||
      [...definition.columns.map((c) => c.name)].sort().join(",") !==
        columns.split(",").sort().join(",")
    )
      fail("SECRET_SOURCE_COLUMNS");
    const originals = rows.get(table);
    if (!Array.isArray(originals)) fail("SECRET_SOURCE_TABLE");
    for (const original of originals) {
      if (Object.keys(original).sort().join(",") !== columns.split(",").sort().join(","))
        fail("SECRET_ROW_SHAPE");
      const row = { ...original };
      for (const name of columns.split(",")) {
        const kind = KINDS[table][name];
        const value = row[name];
        if (value === null) continue;
        if (typeof value !== "string") fail("SECRET_ROW_VALUE");
        if (kind === "timestamp" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value))
          fail("SECRET_TIMESTAMP_UNREPRESENTABLE");
        if (
          kind === "integer" &&
          (!/^-?(?:0|[1-9][0-9]*)$/u.test(value) ||
            BigInt(value) < -9223372036854775808n ||
            BigInt(value) > 9223372036854775807n)
        )
          fail("SECRET_INTEGER_UNREPRESENTABLE");
        if (kind === "bytea" && !/^(?:[a-f0-9]{2})*$/u.test(value))
          fail("SECRET_BYTEA_UNREPRESENTABLE");
        if (kind === "array") row[name] = postgresArrayToJson(value);
      }
      records.push({ table, row });
    }
  }
  return records;
}

/** Original typed facts only: opaque evidence and sealed ciphertext/AAD identities are never rewritten. */
export async function readSecretSourceFacts(db) {
  const facts = new Map();
  for (const [table, columns] of Object.entries(SECRET_COLUMNS)) {
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
        const row = { ...original };
        for (const [name, kind] of Object.entries(KINDS[table]))
          if (kind === "array" && row[name] !== null)
            row[name] = postgresArrayText(JSON.parse(row[name]));
        return row;
      }),
    );
  }
  return facts;
}

export function mapSecret(rows, manifest) {
  return converted(rows, manifest);
}
