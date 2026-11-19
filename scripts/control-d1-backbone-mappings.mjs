import { fail } from "./control-d1-codec.mjs";

export const BACKBONE_COLUMNS = Object.freeze({
  principal_mappings:
    "provider,provider_principal_id,principal_id,organization_id,first_observed_at,last_observed_at",
  webhook_inbox:
    "inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,signature_timestamp,state,attempt_count,max_attempts,available_at,claim_id,claimed_at,lease_expires_at,last_error_code,acknowledged_at",
  operation_mcp_delegations:
    "operation_id,organization_id,project_id,environment_id,billing_epoch_id,principal_id,grant_id,client_id,consent_hash,requires_publication,event_type,created_at",
});
export const BACKBONE_TARGETS = Object.freeze(Object.keys(BACKBONE_COLUMNS));
const SCHEMA = Object.freeze({
  "0326_global_webhook_inbox.sql":
    "0c51726ba4913511e8a949a2fae7069913b3760a3f2fd24a3b17a2b4a0012a98",
  "0327_global_inbox_identity.sql":
    "9f021ba70a44cabae796bea04da102afbb2423e3ae80273908fcd2f448e1dea2",
  "0410_original_identity_backbone.sql":
    "27cbe15f0fb31357db2ad6db3f41e7dc5f269ea0a1cbbe644e97c3a3b82dff81",
});
function prerequisite(manifest, name) {
  if (
    !manifest.targetPin.migrations.some(
      (migration) => migration.name === name && migration.sha256 === SCHEMA[name],
    )
  )
    fail("BACKBONE_SCHEMA_PREREQUISITE");
}
function timestamps(rows, manifest, table) {
  for (const column of manifest.tables
    .find((entry) => entry.name === table)
    .columns.filter((field) => field.kind === "timestamp"))
    for (const row of rows.get(table))
      if (
        row[column.name] !== null &&
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row[column.name])
      )
        fail("BACKBONE_TIMESTAMP_UNREPRESENTABLE");
}

/** Original observations have no organization FK and no chronology constraint; do not invent either. */
export function mapPrincipalMappings(rows, manifest) {
  prerequisite(manifest, "0410_original_identity_backbone.sql");
  timestamps(rows, manifest, "principal_mappings");
  return rows.get("principal_mappings").map((row) => ({ table: "principal_mappings", row }));
}

/** Every global event retains all seventeen original facts. Routing remains absent until a real caller resolves it. */
export function mapGlobalInbox(rows, manifest) {
  prerequisite(manifest, "0326_global_webhook_inbox.sql");
  prerequisite(manifest, "0327_global_inbox_identity.sql");
  timestamps(rows, manifest, "webhook_inbox");
  return rows.get("webhook_inbox").map((row) => ({
    table: "webhook_inbox",
    row: { ...row, organization_id: null },
  }));
}

/** Original global grant identity and static operation/environment relationships remain SQL-enforced. */
export function mapOperationDelegations(rows, manifest) {
  prerequisite(manifest, "0410_original_identity_backbone.sql");
  timestamps(rows, manifest, "operation_mcp_delegations");
  return rows.get("operation_mcp_delegations").map((row) => {
    if (row.requires_publication !== "true" && row.requires_publication !== "false")
      fail("BACKBONE_BOOLEAN");
    return {
      table: "operation_mcp_delegations",
      row: { ...row, requires_publication: row.requires_publication === "true" ? "1" : "0" },
    };
  });
}

/** Closed original-shaped readers exclude nullable inbox routing metadata. Evidence JSON remains opaque text. */
export async function readBackboneSourceFacts(db) {
  const facts = new Map();
  for (const [table, columns] of Object.entries(BACKBONE_COLUMNS)) {
    const selected = columns.split(",").map((name) => {
      if (name === "requires_publication")
        return "CASE requires_publication WHEN 1 THEN 'true' ELSE 'false' END requires_publication";
      if (name === "attempt_count" || name === "max_attempts")
        return `CAST(${name} AS TEXT) ${name}`;
      if (name === "body_sha256") return "lower(hex(body_sha256)) body_sha256";
      return name;
    });
    facts.set(
      table,
      (await db.prepare(`SELECT ${selected.join(",")} FROM ${table}`).all()).results,
    );
  }
  return facts;
}
