import { fail } from "./control-d1-codec.mjs";

export const SPINE_COLUMNS = Object.freeze({
  operations:
    "organization_id,operation_id,project_id,state,failure,created_at,updated_at,billing_epoch_id,result_deployment_id,result_url,result_artifact_sha256,lease_expires_at",
  operation_events:
    "organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at",
  api_idempotency_records:
    "organization_id,principal_id,http_method,route_template,idempotency_key,canonical_request_sha256,canonicalization_version,request_id,operation_id,http_status,response_headers,response_body,created_at,completed_at,expires_at",
  audit_events:
    "organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id",
  organization_audit_events:
    "organization_id,audit_event_id,event_type,actor_type,actor_id,payload,occurred_at",
  outbox_events:
    "organization_id,event_id,project_id,operation_id,event_type,payload,created_at,initial_available_at,available_at,attempt_count,max_attempts,current_attempt_id,claimed_at,lease_expires_at,last_error_code,reconciliation_required_at,acknowledged_at,billing_epoch_id",
  delivery_attempts:
    "attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,failed_at,next_available_at,error_code,acknowledged_at,status",
});
const SCHEMA = Object.freeze({
  "0381_original_operation_history_admission.sql":
    "9c41bceac2f5c4da3499eee7e6655f80afdf405f3c19f6ab21af36b24a0a1a22",
  "0382_original_delivery_attempts.sql":
    "4ecbf14b9872145ef1644c901aa0cd90b8850cc2bdfa05c3003cc375cb9e3875",
  "0383_original_audit_namespaces.sql":
    "04698de29b1455d76f966d7db07f8420aadb169e7739ad20df4b0eaa7416c3f4",
  "0385_original_spine_static_scopes.sql":
    "f399efcedb7ba33f26bd825c10b3d564bfc8379b41069f56476d637e4f3b5866",
});
function prerequisite(manifest, name) {
  if (
    !manifest.targetPin.migrations.some(
      (migration) => migration.name === name && migration.sha256 === SCHEMA[name],
    )
  )
    fail("SPINE_SCHEMA_PREREQUISITE");
}
function timestamps(rows, manifest, tables) {
  for (const table of tables)
    for (const column of manifest.tables
      .find((entry) => entry.name === table)
      .columns.filter((field) => field.kind === "timestamp"))
      for (const row of rows.get(table))
        if (
          row[column.name] !== null &&
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row[column.name])
        )
          fail("SPINE_TIMESTAMP_UNREPRESENTABLE");
}

export function mapOperations(rows, manifest) {
  prerequisite(manifest, "0381_original_operation_history_admission.sql");
  prerequisite(manifest, "0385_original_spine_static_scopes.sql");
  timestamps(rows, manifest, ["operations", "operation_events"]);
  return [
    ...rows
      .get("operations")
      .map((row) => ({ table: "operations", row: { ...row, archive_key: null } })),
    ...rows.get("operation_events").map((row) => ({ table: "operation_events", row })),
  ];
}
export function mapApiReceipts(rows, manifest) {
  timestamps(rows, manifest, ["api_idempotency_records"]);
  for (const row of rows.get("api_idempotency_records"))
    if (
      [
        "operation_id",
        "http_status",
        "response_headers",
        "response_body",
        "completed_at",
        "expires_at",
      ].some((name) => row[name] === null)
    )
      fail("SPINE_RECEIPT_INCOMPLETE");
  return rows
    .get("api_idempotency_records")
    .map((row) => ({ table: "api_idempotency_records", row }));
}
export function mapAuditFacts(rows, manifest) {
  prerequisite(manifest, "0383_original_audit_namespaces.sql");
  timestamps(rows, manifest, ["audit_events", "organization_audit_events"]);
  return ["audit_events", "organization_audit_events"].flatMap((table) =>
    rows.get(table).map((row) => ({ table, row })),
  );
}
export function mapOutboxFacts(rows, manifest) {
  prerequisite(manifest, "0382_original_delivery_attempts.sql");
  prerequisite(manifest, "0385_original_spine_static_scopes.sql");
  timestamps(rows, manifest, ["outbox_events", "delivery_attempts"]);
  const attempts = new Map(rows.get("delivery_attempts").map((row) => [row.attempt_id, row])),
    current = new Set(),
    records = [];
  for (const original of rows.get("outbox_events")) {
    const attempt =
      original.current_attempt_id === null ? undefined : attempts.get(original.current_attempt_id);
    if (
      original.current_attempt_id !== null &&
      (!attempt || attempt.event_id !== original.event_id)
    )
      fail("SPINE_CURRENT_ATTEMPT_MISSING");
    const atomicGroup = `outbox.current:${original.event_id}`;
    records.push({
      table: "outbox_events",
      row: { ...original, last_attempt_status: attempt?.status ?? null },
      atomicGroup,
    });
    if (attempt) {
      records.push({ table: "delivery_attempts", row: attempt, atomicGroup });
      current.add(attempt.attempt_id);
    }
  }
  for (const row of rows.get("delivery_attempts"))
    if (!current.has(row.attempt_id)) records.push({ table: "delivery_attempts", row });
  return records;
}
export async function readSpineSourceFacts(db) {
  const integers = new Set([
      "revision",
      "http_status",
      "attempt_count",
      "max_attempts",
      "attempt_number",
    ]),
    blobs = new Set(["canonical_request_sha256", "result_artifact_sha256"]),
    facts = new Map();
  for (const [table, columns] of Object.entries(SPINE_COLUMNS)) {
    const selected = columns
      .split(",")
      .map((name) =>
        integers.has(name)
          ? `CAST(${name} AS TEXT) ${name}`
          : blobs.has(name)
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
