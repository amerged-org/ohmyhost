import {
  MAIL_COLUMNS,
  MAIL_KINDS,
  MAIL_RETIRED_COLUMNS,
  route53NameserversText,
} from "./control-d1-mail-mappings.mjs";
import { postgresArrayText } from "./control-d1-identity-mappings.mjs";

/**
 * Closed original fact projection only: no current owner, inferred absence, capability seed or repaired history.
 * The retired source columns are not in the Core and so are not in the projection.
 */
export async function readMailSourceFacts(db) {
  const facts = new Map();
  for (const [table, columns] of Object.entries(MAIL_COLUMNS)) {
    const retired = MAIL_RETIRED_COLUMNS[table] ?? [],
      selected = columns
        .split(",")
        .filter((column) => !retired.includes(column))
        .map((column) => {
          const kind = MAIL_KINDS[table][column];
          if (kind === "integer") return `CAST(${column} AS TEXT) ${column}`;
          if (kind === "bytea")
            return `CASE WHEN ${column} IS NULL THEN NULL ELSE lower(hex(${column})) END ${column}`;
          if (kind === "boolean")
            return `CASE ${column} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END ${column}`;
          return column;
        }),
      values = (await db.prepare(`SELECT ${selected.join(",")} FROM ${table}`).all()).results;
    facts.set(
      table,
      values.map((original) => {
        const row = { ...original };
        for (const [column, kind] of Object.entries(MAIL_KINDS[table]))
          if (kind === "array" && row[column] !== null)
            row[column] =
              table === "route53_dkim_change_receipts" && column === "name_servers"
                ? route53NameserversText(row[column])
                : postgresArrayText(JSON.parse(row[column]));
        return row;
      }),
    );
  }
  return facts;
}
