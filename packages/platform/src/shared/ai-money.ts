/** One rate of a published card for the meter `ai.cost`: `creditMicros` credit micros per `unitsPerCharge` USD micros. */
export interface AiCardRate {
  readonly unitsPerCharge: bigint;
  readonly creditMicros: bigint;
}

const NANO_USD_PER_USD_MICRO = 1_000n;

/**
 * The credit micros of an orq cost: the card's charge for the USD micros in `costNanoUsd`, rounded up to a whole
 * credit micro, so a call is never charged less than the card prices it. Zero cost is zero; a cost above zero is at
 * least one credit micro. The Core is the only caller that turns a cost into money.
 */
export function aiCreditMicros(costNanoUsd: bigint, rate: AiCardRate): number {
  if (costNanoUsd < 0n) throw new RangeError("an AI cost is not negative");
  if (rate.unitsPerCharge <= 0n || rate.creditMicros < 0n)
    throw new RangeError("an AI rate has positive units per charge and a non-negative charge");
  const divisor = rate.unitsPerCharge * NANO_USD_PER_USD_MICRO;
  const charged = (costNanoUsd * rate.creditMicros + divisor - 1n) / divisor;
  if (charged > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("an AI charge exceeds safe integers");
  return Number(charged);
}
