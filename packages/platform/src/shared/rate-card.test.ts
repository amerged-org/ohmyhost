import { describe, expect, it } from "vitest";

import { creditMicros, usdMicros } from "./micros.js";
import {
  evaluateRateCard,
  roundIntegerDivision,
  selectEffectiveRateCard,
  type RateCard,
} from "./rate-card.js";

const januaryCard: RateCard = {
  id: "rates-2026-01",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  publishedAt: "2025-12-01T00:00:00.000Z",
  currency: "USD",
  rates: [
    {
      meter: "worker.requests",
      unit: "request",
      unitsPerCharge: 1000n,
      providerCostPerCharge: usdMicros(5n),
      creditsPerCharge: creditMicros(11n),
      minimumCreditCharge: creditMicros(2n),
      roundingMode: "ceil",
    },
  ],
};

const februaryCard: RateCard = {
  id: "rates-2026-02",
  effectiveFrom: "2026-02-01T00:00:00.000Z",
  publishedAt: "2026-01-15T00:00:00.000Z",
  currency: "USD",
  rates: [
    {
      meter: "worker.requests",
      unit: "request",
      unitsPerCharge: 1000n,
      providerCostPerCharge: usdMicros(7n),
      creditsPerCharge: creditMicros(13n),
      minimumCreditCharge: creditMicros(2n),
      roundingMode: "ceil",
    },
  ],
};

const cards: readonly RateCard[] = [januaryCard, februaryCard];

describe("rate-card engine", () => {
  it("selects the latest card effective at event time without rewriting history", () => {
    expect(selectEffectiveRateCard(cards, new Date("2026-01-31T23:59:59.999Z")).id).toBe(
      "rates-2026-01",
    );
    expect(selectEffectiveRateCard(cards, new Date("2026-02-01T00:00:00.000Z")).id).toBe(
      "rates-2026-02",
    );
    expect(() => selectEffectiveRateCard(cards, new Date("2025-12-31T23:59:59.999Z"))).toThrow(
      /effective/,
    );
  });

  it("values usage with explicit integer rounding and exposes the rate-card version", () => {
    expect(
      evaluateRateCard(cards, {
        eventTime: new Date("2026-01-20T00:00:00.000Z"),
        meter: "worker.requests",
        unit: "request",
        quantity: 1001n,
      }),
    ).toEqual({
      rateCardId: "rates-2026-01",
      providerCost: usdMicros(6n),
      creditCharge: creditMicros(12n),
    });
  });

  it("applies the minimum credit charge to zero usage", () => {
    expect(
      evaluateRateCard(cards, {
        eventTime: new Date("2026-01-20T00:00:00.000Z"),
        meter: "worker.requests",
        unit: "request",
        quantity: 0n,
      }).creditCharge,
    ).toBe(2n);
  });

  it("implements floor, ceil, and half-up rounding without floating point", () => {
    expect(roundIntegerDivision(5n, 2n, "floor")).toBe(2n);
    expect(roundIntegerDivision(5n, 2n, "ceil")).toBe(3n);
    expect(roundIntegerDivision(4n, 3n, "half-up")).toBe(1n);
    expect(roundIntegerDivision(5n, 3n, "half-up")).toBe(2n);
    expect(() => roundIntegerDivision(-1n, 2n, "floor")).toThrow(/numerator/);
    expect(() => roundIntegerDivision(1n, 0n, "floor")).toThrow(/denominator/);
    expect(() => roundIntegerDivision(1n, 2n, "bankers" as never)).toThrow(/Unsupported/);
  });

  it("rejects invalid usage and ambiguous rates", () => {
    expect(() =>
      evaluateRateCard(cards, {
        eventTime: new Date("2026-01-20T00:00:00.000Z"),
        meter: "worker.requests",
        unit: "request",
        quantity: -1n,
      }),
    ).toThrow(/quantity/);

    const duplicateRate: RateCard = {
      ...januaryCard,
      rates: [
        januaryCard.rates[0] as RateCard["rates"][number],
        januaryCard.rates[0] as RateCard["rates"][number],
      ],
    };
    expect(() =>
      evaluateRateCard([duplicateRate], {
        eventTime: new Date("2026-01-20T00:00:00.000Z"),
        meter: "worker.requests",
        unit: "request",
        quantity: 1n,
      }),
    ).toThrow(/exactly one rate/);
  });

  it("rejects invalid and ambiguously effective card metadata", () => {
    expect(() =>
      selectEffectiveRateCard(
        [{ ...januaryCard, effectiveFrom: "invalid" }],
        new Date("2026-01-20T00:00:00.000Z"),
      ),
    ).toThrow(/effective time/);
    expect(() =>
      selectEffectiveRateCard(
        [{ ...januaryCard, publishedAt: "invalid" }],
        new Date("2026-01-20T00:00:00.000Z"),
      ),
    ).toThrow(/publication time/);
    expect(() =>
      selectEffectiveRateCard(
        [
          {
            ...januaryCard,
            publishedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        new Date("2026-01-20T00:00:00.000Z"),
      ),
    ).toThrow(/published before/);
    expect(() =>
      selectEffectiveRateCard(
        [januaryCard, { ...januaryCard, id: "duplicate" }],
        new Date("2026-01-20T00:00:00.000Z"),
      ),
    ).toThrow(/share an effective time/);
  });
});
