import { describe, expect, it } from "vitest";
import { aiCreditMicros } from "./ai-money.js";

// The owner's price: orq cost x 1.045 (orq credit fee) x 1.10 (margin) x 1.21 = 1390895 credit micros per 10000 USD micros.
const card = { unitsPerCharge: 10_000n, creditMicros: 1_390_895n };

describe("aiCreditMicros", () => {
  it("prices the measured Haiku 5.5 call of 2 November 2026 (3.6 USD micros of orq cost) at 501 credit micros", () => {
    expect(aiCreditMicros(3_600n, card)).toBe(501);
  });

  it("rounds up, never below the card, and charges at least one micro for any cost", () => {
    expect(aiCreditMicros(1n, card)).toBe(1);
    expect(aiCreditMicros(0n, card)).toBe(0);
    expect(aiCreditMicros(20_000n, card)).toBe(2782);
    expect(aiCreditMicros(10_000_000n, card)).toBe(1_390_895);
  });

  it("refuses a negative cost and a malformed card", () => {
    expect(() => aiCreditMicros(-1n, card)).toThrow(RangeError);
    expect(() => aiCreditMicros(1n, { unitsPerCharge: 0n, creditMicros: 1n })).toThrow(RangeError);
    expect(() => aiCreditMicros(1n, { unitsPerCharge: 1n, creditMicros: -1n })).toThrow(RangeError);
    expect(() => aiCreditMicros(10n ** 30n, card)).toThrow(RangeError);
  });
});
