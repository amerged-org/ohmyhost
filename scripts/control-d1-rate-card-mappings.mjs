import { fail } from "./control-d1-codec.mjs";

/** The two credit configuration tables that survive the W33 credit rebuild; every other financial table is removed. */
export const RATE_CARD_COLUMNS = Object.freeze({
  published_credit_rate_cards: "rate_card_id,published_at,effective_from,rates",
  usage_meter_activations: "meter,rate_card_id,starts_at,activated_at",
});
export const RATE_CARD_TARGETS = Object.freeze(Object.keys(RATE_CARD_COLUMNS));

export function mapRateCards(rows, manifest) {
  const records = [];
  for (const name of RATE_CARD_TARGETS) {
    const columns = manifest.tables
      .find((table) => table.name === name)
      .columns.filter((column) => column.kind === "timestamp");
    for (const row of rows.get(name)) {
      for (const column of columns)
        if (
          row[column.name] !== null &&
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row[column.name])
        )
          fail("RATE_CARD_TIMESTAMP_UNREPRESENTABLE");
      records.push({ table: name, row });
    }
  }
  return records;
}
