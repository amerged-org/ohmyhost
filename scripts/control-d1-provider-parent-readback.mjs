import { Buffer } from "node:buffer";
import { fail, integerText, quoteIdentifier } from "./control-d1-codec.mjs";
import { providerUuidArrayText } from "./control-d1-provider-parent-array.mjs";
import {
  PROVIDER_PARENT_COLUMNS,
  PROVIDER_PARENT_TYPES,
} from "./control-d1-provider-parent-mappings.mjs";

const KEYS = Object.freeze({
  database_provider_operations: [
    "organization_id",
    "project_id",
    "physical_environment_id",
    "operation_id",
    "step",
  ],
  database_provider_target_revisions: [
    "organization_id",
    "project_id",
    "physical_environment_id",
    "target_version",
  ],
  neon_project_placement_receipts: ["organization_id", "project_id", "environment_id"],
  project_database_registration_receipts: [
    "organization_id",
    "project_id",
    "physical_environment_id",
    "registration_version",
  ],
  project_database_registration_reservations: [
    "organization_id",
    "project_id",
    "physical_environment_id",
    "registration_version",
  ],
  pgcf_database_serving_intervals: [
    "organization_id",
    "project_id",
    "physical_environment_id",
    "started_at",
  ],
  database_provider_target_heads: ["organization_id", "project_id", "physical_environment_id"],
});
const numeric = (type) => ["smallint", "bigint"].includes(type);
const WIDTHS = Object.freeze({ step: 128, started_at: 27 });

/** Native PKs stay unwrapped in candidate WHERE/ORDER BY; only returned source values are text/hex projected. */
export async function* readProviderParentPages(db, table) {
  if (!Object.hasOwn(KEYS, table)) fail("PROVIDER_PARENT_READBACK_TABLE");
  const columns = PROVIDER_PARENT_COLUMNS[table].split(","),
    keys = KEYS[table],
    types = PROVIDER_PARENT_TYPES[table],
    extra = table === "neon_project_placement_receipts" ? ["operation_ids_bounds"] : [],
    stored = [...columns, ...extra],
    names = keys.map(quoteIdentifier),
    order = names.join(","),
    parameters = keys.map((field, index) =>
      numeric(types[field]) ? `CAST(?${index + 1} AS INTEGER)` : `?${index + 1}`,
    ),
    selected = columns.map((field) => {
      const name = `facts.${quoteIdentifier(field)}`,
        type = types[field];
      return (
        (numeric(type)
          ? `CAST(${name} AS TEXT)`
          : type === "bytea"
            ? `CASE WHEN ${name} IS NULL THEN NULL ELSE lower(hex(${name})) END`
            : name) + ` AS ${quoteIdentifier(field)}`
      );
    });
  if (extra.length) selected.push('facts.operation_ids_bounds AS "__provider_operation_bounds"');
  const estimate = stored
      .map(
        (field) =>
          (types[field] === "bytea" ? 12 : 6) +
          `*coalesce(length(CAST(${quoteIdentifier(field)} AS BLOB)),0)`,
      )
      .join("+"),
    overhead =
      2 +
      stored.reduce(
        (size, field) => size + Buffer.byteLength(JSON.stringify(field), "utf8") + 10,
        0,
      ),
    countSql = `SELECT CAST(count(*) AS TEXT) n FROM ${quoteIdentifier(table)}`;
  const count = (await db.prepare(countSql).first())?.n;
  if (typeof count !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(count))
    fail("PROVIDER_PARENT_READBACK_COUNT");
  let after = null,
    observed = 0n;
  for (;;) {
    const sql = `WITH candidates AS (SELECT ${order},${overhead}+${estimate} AS __bytes FROM ${quoteIdentifier(table)} AS stored${after === null ? "" : ` WHERE (${order})>(${parameters.join(",")})`} ORDER BY ${order} LIMIT 128),sized AS (SELECT *,row_number() OVER(ORDER BY ${order}) AS __row,sum(__bytes) OVER(ORDER BY ${order} ROWS UNBOUNDED PRECEDING) AS __total FROM candidates),chosen AS (SELECT ${order} FROM sized WHERE __row=1 OR __total<=262144) SELECT ${selected.join(",")} FROM ${quoteIdentifier(table)} AS facts JOIN chosen ON ${keys.map((field) => `facts.${quoteIdentifier(field)} IS chosen.${quoteIdentifier(field)}`).join(" AND ")} ORDER BY ${keys.map((field) => `facts.${quoteIdentifier(field)}`).join(",")} LIMIT 129`;
    let page;
    try {
      page = (
        await db
          .prepare(sql)
          .bind(...(after ?? []))
          .all()
      ).results;
    } catch (cause) {
      throw new Error("CONTROL_D1_PROVIDER_PARENT_READBACK_UNREPRESENTABLE", { cause });
    }
    if (!Array.isArray(page) || page.length > 128) fail("PROVIDER_PARENT_READBACK_RESPONSE");
    if (page.length === 0) break;
    for (const row of page) {
      for (const column of columns)
        if (row[column] !== null && typeof row[column] !== "string")
          fail("PROVIDER_PARENT_READBACK_VALUE");
      for (const field of keys) {
        const value = row[field];
        if (typeof value !== "string") fail("PROVIDER_PARENT_READBACK_KEY");
        if (numeric(types[field])) integerText(value);
        else if (Buffer.byteLength(value, "utf8") > (WIDTHS[field] ?? 26))
          fail("PROVIDER_PARENT_READBACK_KEY_WIDTH");
      }
      if (extra.length) {
        try {
          row.operation_ids = providerUuidArrayText(
            JSON.parse(row.operation_ids),
            row.__provider_operation_bounds === null
              ? null
              : JSON.parse(row.__provider_operation_bounds),
          );
        } catch (cause) {
          throw new Error("CONTROL_D1_PROVIDER_PARENT_ARRAY_TARGET_UNREPRESENTABLE", { cause });
        }
        delete row.__provider_operation_bounds;
      }
    }
    const next = keys.map((field) => page.at(-1)[field]);
    if (JSON.stringify(next) === JSON.stringify(after)) fail("PROVIDER_PARENT_READBACK_CURSOR");
    after = next;
    observed += BigInt(page.length);
    if (observed > BigInt(count)) fail("PROVIDER_PARENT_READBACK_COUNT_CHANGED");
    yield page;
  }
  if (observed !== BigInt(count) || (await db.prepare(countSql).first())?.n !== count)
    fail("PROVIDER_PARENT_READBACK_COUNT_CHANGED");
}

/** Fixture collector only; whole-source proof consumes readProviderParentPages directly. */
export async function readProviderParentFacts(db) {
  const facts = new Map();
  for (const table of Object.keys(PROVIDER_PARENT_COLUMNS)) {
    const rows = [];
    for await (const page of readProviderParentPages(db, table)) rows.push(...page);
    facts.set(table, rows);
  }
  return facts;
}
