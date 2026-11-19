import { creditMicros, usdMicros } from "./micros.js";
import { evaluateRateCard, type RateCard } from "./rate-card.js";

export const BUILD_PRICE_VERSION = "build-sandbox-standard-3-v1";
export const BUILD_METER = "build.sandbox.standard-3";
export const BUILD_UNIT = "second";
// Fourteen minutes: a build may run eight minutes and the build sandbox needs time to start
// and to hand over its bundle. Settlement charges the measured seconds and releases the rest.
export const BUILD_RESERVED_SECONDS = 840n;

/** The public deployment quote fixes this price before the customer accepts work. */
export function quoteBuildCost(quotedAt: string) {
  const value = evaluateRateCard([buildRateCard(quotedAt)], {
    eventTime: new Date(quotedAt),
    meter: BUILD_METER,
    unit: BUILD_UNIT,
    quantity: BUILD_RESERVED_SECONDS,
  });
  if (value.providerCost === null) throw new Error("Build price must include its provider cost");
  return Object.freeze({
    amount_micros: ((value.creditCharge + 99n) / 100n).toString(),
    currency: "USD" as const,
    rate_card_version: BUILD_PRICE_VERSION,
    credit_micros: value.creditCharge.toString(),
    credits: displayCredits(value.creditCharge),
    provider_cost_micros: value.providerCost.toString(),
    scope: "build_compute" as const,
    reserved_seconds: BUILD_RESERVED_SECONDS.toString(),
  });
}

/** Credits as people read them: 16869120 micros is "16.86912". */
function displayCredits(micros: bigint): string {
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${micros / 1_000_000n}${fraction === "" ? "" : `.${fraction}`}`;
}

export function buildRateCard(quotedAt: string): RateCard {
  if (!Number.isFinite(Date.parse(quotedAt)) || new Date(quotedAt).toISOString() !== quotedAt) {
    throw new TypeError("Build quote time must be a canonical UTC instant");
  }
  return {
    id: BUILD_PRICE_VERSION,
    currency: "USD",
    publishedAt: quotedAt,
    effectiveFrom: quotedAt,
    rates: [
      {
        // A standard-3 build sandbox (2 vCPU, 8 GiB memory, 16 GB disk) costs USD 0.00006112
        // per second. 175 seconds are the smallest quantity whose provider cost (USD 0.010696)
        // and whose price by the approved formula (x 2300/7 = 3.5144 credits) are both whole
        // micro-units, so the rate is exact.
        meter: BUILD_METER,
        unit: BUILD_UNIT,
        unitsPerCharge: 175n,
        providerCostPerCharge: usdMicros(10_696n),
        creditsPerCharge: creditMicros(3_514_400n),
        minimumCreditCharge: creditMicros(0n),
        roundingMode: "ceil",
      },
    ],
  };
}
