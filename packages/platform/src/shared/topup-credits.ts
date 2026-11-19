import { creditMicros, type CreditMicros } from "./micros.js";

const PACK_USD = 10n;
const BASE_CREDITS_PER_USD = 100n;
const BONUS_CREDITS_PER_USD = 125n;
const BONUS_ABOVE_USD = 100n;
const MICROS_PER_CREDIT = 1_000_000n;

/** A larger purchase buys more credits; no consumption rate changes (PRICING.md). */
export function topupCreditMicros(packs: number): CreditMicros {
  if (!Number.isSafeInteger(packs) || packs < 1 || packs > 100) {
    throw new TypeError("Top-up packs must be an integer from 1 to 100");
  }
  const usd = BigInt(packs) * PACK_USD;
  const credits =
    usd <= BONUS_ABOVE_USD
      ? usd * BASE_CREDITS_PER_USD
      : BONUS_ABOVE_USD * BASE_CREDITS_PER_USD + (usd - BONUS_ABOVE_USD) * BONUS_CREDITS_PER_USD;
  return creditMicros(credits * MICROS_PER_CREDIT);
}
