import { describe, expect, it } from "vitest";

import { topupCreditMicros } from "./topup-credits.js";

describe("top-up credits", () => {
  it("grants 100 credits per dollar up to USD 100 and 125 per dollar for the part above", () => {
    expect(topupCreditMicros(1)).toBe(1_000_000_000n);
    expect(topupCreditMicros(10)).toBe(10_000_000_000n);
    expect(topupCreditMicros(11)).toBe(11_250_000_000n);
    expect(topupCreditMicros(20)).toBe(22_500_000_000n);
    expect(topupCreditMicros(100)).toBe(122_500_000_000n);
  });

  it("never grants fewer credits for a larger purchase and refuses a pack count no checkout can carry", () => {
    for (let packs = 2; packs <= 100; packs += 1) {
      expect(topupCreditMicros(packs)).toBeGreaterThan(topupCreditMicros(packs - 1));
    }
    for (const invalid of [0, 101, -1, 1.5, Number.NaN]) {
      expect(() => topupCreditMicros(invalid)).toThrow(
        "Top-up packs must be an integer from 1 to 100",
      );
    }
  });
});
