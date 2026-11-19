import { describe, expect, it } from "vitest";

import {
  BUILD_PRICE_VERSION,
  BUILD_RESERVED_SECONDS,
  buildRateCard,
  quoteBuildCost,
} from "./build-pricing.js";
import { evaluateRateCard } from "./rate-card.js";

const QUOTED_AT = "2026-09-17T12:00:00.000Z";

function charge(seconds: bigint) {
  return evaluateRateCard([buildRateCard(QUOTED_AT)], {
    eventTime: new Date(QUOTED_AT),
    meter: "build.sandbox.standard-3",
    unit: "second",
    quantity: seconds,
  });
}

describe("build pricing", () => {
  it("quotes the 840 reserved seconds as the hold shown before a deployment", () => {
    expect(BUILD_RESERVED_SECONDS).toBe(840n);
    expect(quoteBuildCost(QUOTED_AT)).toEqual({
      amount_micros: "168692",
      currency: "USD",
      rate_card_version: BUILD_PRICE_VERSION,
      credit_micros: "16869120",
      credits: "16.86912",
      provider_cost_micros: "51341",
      scope: "build_compute",
      reserved_seconds: "840",
    });
    expect(Object.isFrozen(quoteBuildCost(QUOTED_AT))).toBe(true);
  });

  it("charges each measured second by the approved formula and rounds a partial microcredit up", () => {
    // USD 0.00006112 per second x 2300/7 = 0.020082285... credits; 175 seconds are exactly
    // USD 0.010696 and 3.5144 credits, the smallest quantity where both are whole micro-units.
    expect(charge(1n)).toMatchObject({ creditCharge: 20_083n, providerCost: 62n });
    expect(charge(60n)).toMatchObject({ creditCharge: 1_204_938n, providerCost: 3_668n });
    expect(charge(175n)).toMatchObject({ creditCharge: 3_514_400n, providerCost: 10_696n });
    expect(charge(840n)).toMatchObject({ creditCharge: 16_869_120n, providerCost: 51_341n });
    // The rate is the approved formula exactly: credits = provider cost x 2300 / 7.
    expect(3_514_400n * 7n).toBe(10_696n * 2_300n);
    expect(10_696n * 100n).toBe(6_112n * 175n);
  });

  it("publishes one rate under the quoted instant and refuses a time that is not a canonical UTC instant", () => {
    expect(buildRateCard(QUOTED_AT)).toMatchObject({
      id: "build-sandbox-standard-3-v1",
      currency: "USD",
      publishedAt: QUOTED_AT,
      effectiveFrom: QUOTED_AT,
      rates: [{ meter: "build.sandbox.standard-3", unit: "second", roundingMode: "ceil" }],
    });
    for (const invalid of ["2026-09-17", "2026-09-17T12:00:00Z", "not a date"]) {
      expect(() => quoteBuildCost(invalid)).toThrow(
        "Build quote time must be a canonical UTC instant",
      );
    }
  });
});
