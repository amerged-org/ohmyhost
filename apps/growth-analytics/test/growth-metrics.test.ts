import { expect, it } from "vitest";
import { calculateReturnCohort } from "../src/retention-metrics.js";
import { calculateNetReceipts } from "../src/payment-projections.js";

it("counts qualifying return and money without free-credit inflation", () => {
  const returns = calculateReturnCohort({
    asOf: "2026-11-15T00:00:00Z",
    days: 7,
    activations: [
      { workspace: "a", at: "2026-11-01T12:00:00Z" },
      { workspace: "b", at: "2026-11-14T12:00:00Z" },
    ],
    activities: [
      { workspace: "a", at: "2026-11-08T08:00:00Z", kind: "source_change" },
      { workspace: "a", at: "2026-11-08T09:00:00Z", kind: "poll" },
    ],
    historyComplete: false,
  });
  expect(returns).toMatchObject({
    numerator: 1,
    denominator: 1,
    mature: 1,
    pending: 1,
    historyComplete: false,
  });
  const money = calculateNetReceipts([
    { id: "1", currency: "usd", amount_minor: 1000, money_effect: "received" },
    { id: "1", currency: "usd", amount_minor: 1000, money_effect: "received" },
    { id: "2", currency: "usd", amount_minor: 100, money_effect: "refunded" },
    { id: "3", currency: "usd", amount_minor: 300, money_effect: "none" },
    { id: "4", currency: "usd", amount_minor: 200, money_effect: "withdrawn" },
    { id: "5", currency: "usd", amount_minor: 200, money_effect: "restored" },
  ]);
  expect(money[0]).toMatchObject({
    gross: 1000,
    refunds: 100,
    withdrawn: 200,
    restored: 200,
    net: 900,
    openDisputes: 300,
  });
});
