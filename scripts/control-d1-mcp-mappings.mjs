import { fail } from "./control-d1-codec.mjs";
import { postgresArrayToJson, postgresArrayText } from "./control-d1-identity-mappings.mjs";

export const MCP_COLUMNS = Object.freeze({
  mcp_portal_handoffs:
    "request_hash,user_id,client_id,consent_hash,organization_id,kind,project_ids,allow_create,allow_publish,secret_target,github_target,created_at,expires_at,consumed_at,outcome,mail_domain_scopes,allow_mail_domain_create",
  mcp_client_grants:
    "grant_id,user_id,client_id,consent_hash,organization_id,project_id,ownership_version,billing_epoch_id,allow_publish,created_at,revoked_at,revision",
  mcp_client_revocations: "user_id,client_id,consent_hash,organization_id,revoked_at",
  mcp_mail_domain_grants:
    "grant_id,user_id,client_id,consent_hash,organization_id,mail_domain_id,permissions,revision,created_at,revoked_at",
});
export const MCP_TARGETS = Object.freeze([...Object.keys(MCP_COLUMNS), "mcp_handoff_routes"]);
export const MCP_IDENTITY_SCHEMA_SHA256 =
  "d31a3de08e0b8500391fb9fd6824b9de5d535d27893bd27a25399fc31500b3d6";
const BOOLEANS = new Set(["allow_create", "allow_publish", "allow_mail_domain_create"]);

/** Closed original consent facts; original operation delegations/principal mappings are separate authorities. */
export function mapMcp(rows, manifest) {
  if (
    !manifest.targetPin.migrations.some(
      (entry) =>
        entry.name === "0380_mcp_global_grant_identity.sql" &&
        entry.sha256 === MCP_IDENTITY_SCHEMA_SHA256,
    )
  )
    fail("MCP_GLOBAL_IDENTITY_PREREQUISITE");
  const organizations = new Set(
    (rows.get("workos_organization_mappings") ?? []).map((row) => row.organization_id),
  );
  const records = [];
  for (const table of Object.keys(MCP_COLUMNS)) {
    const timestamps = manifest.tables
      .find((entry) => entry.name === table)
      .columns.filter((column) => column.kind === "timestamp");
    for (const original of rows.get(table)) {
      if (!organizations.has(original.organization_id)) fail("MCP_PARENT_UNREPRESENTABLE");
      for (const column of timestamps)
        if (
          original[column.name] !== null &&
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(original[column.name])
        )
          fail("MCP_TIMESTAMP_UNREPRESENTABLE");
      const row = { ...original };
      for (const field of BOOLEANS)
        if (Object.hasOwn(row, field)) {
          if (row[field] !== "true" && row[field] !== "false") fail("MCP_BOOLEAN");
          row[field] = row[field] === "true" ? "1" : "0";
        }
      if (table === "mcp_portal_handoffs") {
        const atomicGroup = `mcp.handoff:${row.request_hash}`;
        records.push({
          table: "mcp_handoff_routes",
          row: {
            request_hash: row.request_hash,
            organization_id: row.organization_id,
            expires_at: row.expires_at,
          },
          atomicGroup,
        });
        row.project_ids = postgresArrayToJson(row.project_ids);
        records.push({ table, row, atomicGroup });
      } else {
        if (table === "mcp_mail_domain_grants")
          row.permissions = postgresArrayToJson(row.permissions);
        records.push({ table, row });
      }
    }
  }
  return records;
}

/** Original four tables only; derived routing metadata is never fabricated original evidence. */
export async function readMcpSourceFacts(db) {
  const facts = new Map();
  for (const [table, columns] of Object.entries(MCP_COLUMNS)) {
    const selected = columns
      .split(",")
      .map((name) =>
        BOOLEANS.has(name)
          ? `CASE ${name} WHEN 1 THEN 'true' ELSE 'false' END ${name}`
          : ["revision", "ownership_version"].includes(name)
            ? `CAST(${name} AS TEXT) ${name}`
            : name,
      );
    const rows = (await db.prepare(`SELECT ${selected.join(",")} FROM ${table}`).all()).results;
    facts.set(
      table,
      rows.map((original) => {
        const row = { ...original };
        if (table === "mcp_portal_handoffs")
          row.project_ids = postgresArrayText(JSON.parse(row.project_ids));
        if (table === "mcp_mail_domain_grants")
          row.permissions = postgresArrayText(JSON.parse(row.permissions));
        return row;
      }),
    );
  }
  return facts;
}
