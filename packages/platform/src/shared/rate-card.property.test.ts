import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { creditMicros, usdMicros } from "./micros.js";
import {
  evaluateRateCard,
  roundIntegerDivision,
  selectEffectiveRateCard,
  type IntegerRoundingMode,
  type RateCard,
} from "./rate-card.js";

const PROPERTY_SEED = 0x4a7eca4d;
const PROPERTY_RUNS = 200;
const BASE_TIME = Date.UTC(2026, 0, 1);

function card(offsetDays: number, publishedDaysBefore: number, index: number): RateCard {
  const effective = BASE_TIME + offsetDays * 86_400_000;
  return {
    id: `rate-card-${index}`,
    effectiveFrom: new Date(effective).toISOString(),
    publishedAt: new Date(effective - publishedDaysBefore * 86_400_000).toISOString(),
    currency: "USD",
    rates: [],
  };
}

describe("rate-card properties", () => {
  it("selects the same effective card regardless of input order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 365 }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.integer({ min: 0, max: 365 }),
        fc.integer({ min: 1, max: 60 }),
        fc.integer(),
        (offsets, eventDay, publishedDaysBefore, shuffleSeed) => {
          const cards = offsets.map((offset, index) => card(offset, publishedDaysBefore, index));
          const expected = cards
            .filter(
              (candidate) =>
                Date.parse(candidate.effectiveFrom) <= BASE_TIME + eventDay * 86_400_000,
            )
            .sort(
              (left, right) => Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom),
            )[0];
          fc.pre(expected !== undefined);

          const shuffled = fc.sample(
            fc.shuffledSubarray(cards, { minLength: cards.length, maxLength: cards.length }),
            { seed: shuffleSeed, numRuns: 1 },
          )[0];
          if (shuffled === undefined) {
            throw new Error("Fast-check did not produce the requested shuffled card list");
          }
          const eventTime = new Date(BASE_TIME + eventDay * 86_400_000);

          expect(selectEffectiveRateCard(cards, eventTime).id).toBe(expected.id);
          expect(selectEffectiveRateCard(shuffled, eventTime).id).toBe(expected.id);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });

  it("values usage with exact integer arithmetic and the declared minimum", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.constantFrom<IntegerRoundingMode>("floor", "ceil", "half-up"),
        (quantity, units, providerRate, creditRate, minimum, mode) => {
          const rateCard: RateCard = {
            ...card(0, 1, 0),
            rates: [
              {
                meter: "requests",
                unit: "request",
                unitsPerCharge: units,
                providerCostPerCharge: usdMicros(providerRate),
                creditsPerCharge: creditMicros(creditRate),
                minimumCreditCharge: creditMicros(minimum),
                roundingMode: mode,
              },
            ],
          };

          const result = evaluateRateCard([rateCard], {
            eventTime: new Date(BASE_TIME),
            meter: "requests",
            unit: "request",
            quantity,
          });
          const exactProviderCost = roundIntegerDivision(quantity * providerRate, units, mode);
          const exactCredits = roundIntegerDivision(quantity * creditRate, units, mode);

          expect(result.providerCost).toBe(exactProviderCost);
          expect(result.creditCharge).toBe(exactCredits < minimum ? minimum : exactCredits);
        },
      ),
      { seed: PROPERTY_SEED + 1, numRuns: PROPERTY_RUNS },
    );
  });
});
