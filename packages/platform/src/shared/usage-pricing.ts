import { creditMicros, usdMicros } from "./micros.js";
import type { RateCard } from "./rate-card.js";

export const USAGE_RATE_CARD_ID = "usage-2026-09-07-v1";
/** Published list-cost basis; provider allowances remain platform pools. */
export function usageRateCard(publishedAt: string, effectiveFrom: string): RateCard {
  if (
    new Date(publishedAt).toISOString() !== publishedAt ||
    new Date(effectiveFrom).toISOString() !== effectiveFrom ||
    publishedAt > effectiveFrom
  )
    throw new TypeError("Prices must be published before use");
  const prices: readonly [string, string, bigint, bigint][] = [
    // Historical row: no build is charged by it any more (builds run in the build sandbox and
    // are priced by `build-pricing.ts`). It stays because card `usage-2026-09-07-v1` is
    // published with this row in Dev and Prod and a published card is immutable: publishing it
    // again compares the stored rates and fails with "Published price version cannot change".
    ["codebuild.linux.small.us-east-1", "minute", 1n, 5000n],
    ["wfp.requests", "request", 1_000_000n, 300_000n],
    ["wfp.cpu", "cpu_ms", 1_000_000n, 20_000n],
    ["neon.compute.scale", "cu_second", 3600n, 222_000n],
    ["neon.storage.root", "byte_month", 1_000_000_000n, 350_000n],
    ["neon.storage.child", "byte_month", 1_000_000_000n, 350_000n],
    ["neon.history", "byte_month", 1_000_000_000n, 200_000n],
    ["neon.snapshot", "byte_month", 1_000_000_000n, 90_000n],
    ["neon.transfer.public", "byte", 1_000_000_000n, 100_000n],
    ["neon.transfer.private", "byte", 1_000_000_000n, 10_000n],
    ["neon.branches", "branch_hour", 744n, 1_500_000n],
  ];
  return {
    id: USAGE_RATE_CARD_ID,
    currency: "USD",
    publishedAt,
    effectiveFrom,
    // Exact approved conversion: one USD micro-unit is 2300/7 credit micro-units.
    rates: prices.map(([meter, unit, units, cost]) => ({
      meter,
      unit,
      unitsPerCharge: units * 7n,
      providerCostPerCharge: usdMicros(cost * 7n),
      creditsPerCharge: creditMicros(cost * 2300n),
      minimumCreditCharge: creditMicros(0n),
      roundingMode: "ceil",
    })),
  };
}

export const PGCF_MEMORY_METER = "pgcf.memory.active";
export const PGCF_MEMORY_UNIT = "memory_mib_milliseconds";
