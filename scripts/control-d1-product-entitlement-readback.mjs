import { fail } from "./control-d1-codec.mjs";
import {
  ENTITLEMENT_COLUMNS,
  ENTITLEMENT_KINDS,
} from "./control-d1-product-entitlement-mappings.mjs";
/** Original226 non-null primary keys, with fixed ASCII widths proved by ULID/database domains in0402. */
export const ENTITLEMENT_READBACK_KEYS = Object.freeze({
  pgcf_database_entitlement_policies: [
    "organization_id",
    "project_id",
    "physical_environment_id",
    "database_id",
  ],
  pgcf_database_entitlement_actions: ["action_id"],
});
/**
 * These two original tables have no opaque/unbounded values: ULID26, database20, project24, operation23,
 * key80, int8<=20, boolean<=5, state<=10, action<=7 and UTC6=27 bytes, all ASCII without JSON escapes.
 * Including every column name and JSON delimiter, each source-shaped row is below2KiB;128rows fit256KiB.
 * Use the native BINARY primary-key columns directly: wrapping a row-value cursor in COLLATE prevents
 * SQLite's compound primary-key seek. This fixed domain reader never changes the shared Source pager.
 */
export async function readProductEntitlementFacts(db) {
  const facts = new Map();
  for (const [table, declaration] of Object.entries(ENTITLEMENT_COLUMNS)) {
    const columns = declaration.split(","),
      kinds = ENTITLEMENT_KINDS[table],
      keys = ENTITLEMENT_READBACK_KEYS[table],
      select = columns.map((c) =>
        kinds[c] === "integer"
          ? `CAST(${c} AS TEXT) AS ${c}`
          : kinds[c] === "boolean"
            ? `CASE ${c} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END AS ${c}`
            : c,
      ),
      rows = [];
    let after = null;
    for (;;) {
      const page = (
        await db
          .prepare(
            `SELECT ${select.join(",")} FROM ${table}${after === null ? "" : ` WHERE (${keys.join(",")})>(${keys.map(() => "?").join(",")})`} ORDER BY ${keys.join(",")} LIMIT 128`,
          )
          .bind(...(after ?? []))
          .all()
      ).results;
      rows.push(...page);
      if (page.length < 128) break;
      const tail = page.at(-1);
      after = keys.map((k) => tail[k]);
      if (after.some((v) => typeof v !== "string")) fail("ENTITLEMENT_READBACK_CURSOR");
    }
    facts.set(table, rows);
  }
  return facts;
}
