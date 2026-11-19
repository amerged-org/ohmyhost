export interface MoneyFact {
  id?: string;
  provider_fact_id?: string;
  currency: string;
  amount_minor: number;
  money_effect: "received" | "refunded" | "withdrawn" | "restored" | "none";
}
export function calculateNetReceipts(facts: MoneyFact[]) {
  const seen = new Set<string>();
  const currencies = new Map<
    string,
    {
      currency: string;
      gross: number;
      refunds: number;
      withdrawn: number;
      restored: number;
      net: number;
      openDisputes: number;
    }
  >();
  for (const fact of facts) {
    const id = fact.provider_fact_id ?? fact.id;
    if (
      !id ||
      seen.has(id) ||
      !Number.isSafeInteger(fact.amount_minor) ||
      fact.amount_minor < 0 ||
      !/^[a-z]{3}$/i.test(fact.currency)
    )
      continue;
    seen.add(id);
    const currency = fact.currency.toLowerCase();
    const row = currencies.get(currency) ?? {
      currency,
      gross: 0,
      refunds: 0,
      withdrawn: 0,
      restored: 0,
      net: 0,
      openDisputes: 0,
    };
    if (fact.money_effect === "received") row.gross += fact.amount_minor;
    if (fact.money_effect === "refunded") row.refunds += fact.amount_minor;
    if (fact.money_effect === "withdrawn") row.withdrawn += fact.amount_minor;
    if (fact.money_effect === "restored") row.restored += fact.amount_minor;
    if (fact.money_effect === "none") row.openDisputes += fact.amount_minor;
    row.net = row.gross - row.refunds - row.withdrawn + row.restored;
    currencies.set(currency, row);
  }
  return [...currencies.values()];
}
