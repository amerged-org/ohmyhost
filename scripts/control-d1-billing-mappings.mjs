import { fail, integerText } from "./control-d1-codec.mjs";

/** The Stripe customer and recharge-policy relations of an organization; the payment history tables are removed. */
export const BILLING_COLUMNS = Object.freeze({
  stripe_billing_customers:
    "organization_id,request_id,account_id,mode,created_by,created_at,provider_id,provider_confirmed_at",
  stripe_recharge_policies:
    "organization_id,account_id,mode,enabled,revision,monthly_limit_minor,status,setup_id,setup_session_id,payment_method_id,updated_at,checked_at",
});
export const BILLING_TARGETS = Object.freeze(Object.keys(BILLING_COLUMNS));
export const BILLING_REQUIRED_MIGRATIONS = Object.freeze({
  "0250_billing_policy.sql": "6c7cd3767648ac0843daf181ee9d88fca6a2360d7b51037e5cd777e1175d2774",
  "0340_stripe_billing.sql": "a99c57e7e71a9bf74c1f8279f5ced92d2f2eb09c43924cbf96d12266f6c789d2",
});
const BOOLEANS = new Set(["enabled"]);
function originalRows(rows, manifest, table) {
  const values = rows.get(table),
    definition = manifest.tables.find((entry) => entry.name === table);
  if (
    !Array.isArray(values) ||
    !definition ||
    definition.columns
      .map((column) => column.name)
      .sort()
      .join(",") !== BILLING_COLUMNS[table].split(",").sort().join(",")
  )
    fail("BILLING_SOURCE_COLUMNS");
  return values.map((original) => {
    if (
      Object.keys(original).sort().join(",") !== BILLING_COLUMNS[table].split(",").sort().join(",")
    )
      fail("BILLING_SOURCE_COLUMNS");
    const row = { ...original };
    for (const column of definition.columns) {
      const value = row[column.name];
      if (value !== null && typeof value !== "string") fail("BILLING_SOURCE_VALUE");
      if (
        value !== null &&
        column.kind === "timestamp" &&
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
      )
        fail("BILLING_TIMESTAMP_UNREPRESENTABLE");
      if (value !== null && column.kind === "integer") integerText(value);
      if (value !== null && column.kind === "bytea" && !/^(?:[a-f0-9]{2})*$/u.test(value))
        fail("BILLING_BYTES");
      if (BOOLEANS.has(column.name)) {
        if (value !== "true" && value !== "false") fail("BILLING_BOOLEAN");
        row[column.name] = value === "true" ? "1" : "0";
      }
    }
    return row;
  });
}
/** The original rows of the two relations, each under its organization. */
export function mapBilling(rows, manifest) {
  for (const [name, sha256] of Object.entries(BILLING_REQUIRED_MIGRATIONS))
    if (
      !manifest.targetPin.migrations.some((entry) => entry.name === name && entry.sha256 === sha256)
    )
      fail("BILLING_SCHEMA_PREREQUISITE");
  const organizations = new Set(
    rows.get("workos_organization_mappings").map((row) => row.organization_id),
  );
  const records = [];
  for (const table of Object.keys(BILLING_COLUMNS))
    for (const row of originalRows(rows, manifest, table)) {
      if (!organizations.has(row.organization_id)) fail("BILLING_PARENT_UNREPRESENTABLE");
      records.push({ table, row });
    }
  return records;
}
