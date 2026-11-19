import { creditMicros, type CreditMicros, usdMicros, type UsdMicros } from "./micros.js";

export type IntegerRoundingMode = "floor" | "ceil" | "half-up";

export interface Rate {
  readonly meter: string;
  readonly unit: string;
  readonly unitsPerCharge: bigint;
  readonly providerCostPerCharge: UsdMicros | null;
  readonly creditsPerCharge: CreditMicros;
  readonly minimumCreditCharge: CreditMicros;
  readonly roundingMode: IntegerRoundingMode;
}

export interface RateCard {
  readonly id: string;
  readonly effectiveFrom: string;
  readonly publishedAt: string;
  readonly currency: "USD";
  readonly rates: readonly Rate[];
}

export interface UsageToValue {
  readonly eventTime: Date;
  readonly meter: string;
  readonly unit: string;
  readonly quantity: bigint;
}

export interface ValuedUsage {
  readonly rateCardId: string;
  readonly providerCost: UsdMicros | null;
  readonly creditCharge: CreditMicros;
}

export function selectEffectiveRateCard(cards: readonly RateCard[], eventTime: Date): RateCard {
  const eventTimestamp = eventTime.getTime();
  if (!Number.isFinite(eventTimestamp)) {
    throw new RangeError("Usage event time must be valid");
  }

  let selected: RateCard | undefined;
  let selectedTimestamp = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const effectiveTimestamp = Date.parse(card.effectiveFrom);
    const publishedTimestamp = Date.parse(card.publishedAt);
    if (!Number.isFinite(effectiveTimestamp)) {
      throw new RangeError(`Rate card ${card.id} has an invalid effective time`);
    }
    if (!Number.isFinite(publishedTimestamp)) {
      throw new RangeError(`Rate card ${card.id} has an invalid publication time`);
    }
    if (publishedTimestamp > effectiveTimestamp) {
      throw new RangeError(`Rate card ${card.id} must be published before it is effective`);
    }
    if (effectiveTimestamp <= eventTimestamp && effectiveTimestamp > selectedTimestamp) {
      selected = card;
      selectedTimestamp = effectiveTimestamp;
    } else if (effectiveTimestamp <= eventTimestamp && effectiveTimestamp === selectedTimestamp) {
      throw new Error("Rate cards must not share an effective time");
    }
  }

  if (selected === undefined) {
    throw new RangeError("No rate card is effective at the usage event time");
  }
  return selected;
}

export function evaluateRateCard(cards: readonly RateCard[], usage: UsageToValue): ValuedUsage {
  if (usage.quantity < 0n) {
    throw new RangeError("Usage quantity must be non-negative");
  }

  const card = selectEffectiveRateCard(cards, usage.eventTime);
  const matchingRates = card.rates.filter(
    (rate) => rate.meter === usage.meter && rate.unit === usage.unit,
  );
  if (matchingRates.length !== 1) {
    throw new Error("A rate card must contain exactly one rate for meter and unit");
  }
  const rate = matchingRates.at(0);
  if (rate === undefined) {
    throw new Error("A rate card must contain exactly one rate for meter and unit");
  }
  validateRate(rate);

  const providerCost =
    rate.providerCostPerCharge === null
      ? null
      : usdMicros(
          roundIntegerDivision(
            usage.quantity * rate.providerCostPerCharge,
            rate.unitsPerCharge,
            rate.roundingMode,
          ),
        );
  const calculatedCredits = roundIntegerDivision(
    usage.quantity * rate.creditsPerCharge,
    rate.unitsPerCharge,
    rate.roundingMode,
  );

  return {
    rateCardId: card.id,
    providerCost,
    creditCharge: creditMicros(
      calculatedCredits < rate.minimumCreditCharge ? rate.minimumCreditCharge : calculatedCredits,
    ),
  };
}

export function roundIntegerDivision(
  numerator: bigint,
  denominator: bigint,
  mode: IntegerRoundingMode,
): bigint {
  if (numerator < 0n) {
    throw new RangeError("Rounding numerator must be non-negative");
  }
  if (denominator <= 0n) {
    throw new RangeError("Rounding denominator must be positive");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || mode === "floor") {
    return quotient;
  }
  if (mode === "ceil") {
    return quotient + 1n;
  }
  if (mode === "half-up") {
    return remainder * 2n >= denominator ? quotient + 1n : quotient;
  }
  return assertNever(mode);
}

function validateRate(rate: Rate): void {
  if (rate.unitsPerCharge <= 0n) {
    throw new RangeError("Rate units per charge must be positive");
  }
  if (
    (rate.providerCostPerCharge !== null && rate.providerCostPerCharge < 0n) ||
    rate.creditsPerCharge < 0n ||
    rate.minimumCreditCharge < 0n
  ) {
    throw new RangeError("Rates and minimum charges must be non-negative");
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported integer rounding mode: ${String(value)}`);
}
