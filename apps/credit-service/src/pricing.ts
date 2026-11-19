import {
  creditMicros,
  evaluateRateCard,
  usdMicros,
  type Rate,
  type RateCard,
} from "@ohmyhost/platform/shared";
import type { UsageLine } from "./port.js";

function integer(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new TypeError("credit_service_rate_invalid");
}

/**
 * One rate of a published card. The Core hands over the stored card rows (`units_per_charge`, `credit_micros`,
 * `provider_cost_micros`, decimal strings) or the platform `Rate` shape; every published card rounds up and has no
 * minimum charge, which is why those two fields are not part of the stored row.
 */
function toRate(raw: unknown): Rate {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new TypeError("credit_service_rate_invalid");
  const row = raw as Record<string, unknown>;
  const meter = row["meter"],
    unit = row["unit"];
  if (typeof meter !== "string" || typeof unit !== "string")
    throw new TypeError("credit_service_rate_invalid");
  const provider = row["providerCostPerCharge"] ?? row["provider_cost_micros"] ?? null;
  return {
    meter,
    unit,
    unitsPerCharge: integer(row["unitsPerCharge"] ?? row["units_per_charge"]),
    providerCostPerCharge: provider === null ? null : usdMicros(integer(provider)),
    creditsPerCharge: creditMicros(integer(row["creditsPerCharge"] ?? row["credit_micros"])),
    minimumCreditCharge: creditMicros(0n),
    roundingMode: "ceil",
  };
}

/** The cards `readRates` reports as in force at `at`, as platform rate cards ready for `evaluateRateCard`. */
export function ratesToCards(
  entries: { rateCardId: string; rates: unknown }[],
  at: string,
): RateCard[] {
  return entries.map((entry) => {
    if (!Array.isArray(entry.rates)) throw new TypeError("credit_service_rate_invalid");
    return {
      id: entry.rateCardId,
      currency: "USD",
      publishedAt: at,
      effectiveFrom: at,
      rates: entry.rates.map(toRate),
    };
  });
}

/** A quantity of one meter, owned by one organization, project and environment. */
export interface Charge {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly resourceKind?: "native_auth_database";
  readonly meter: string;
  readonly unit: string;
  readonly quantity: bigint;
}

/** The priced line of a quantity, or null when no card in force prices that meter (it is not activated). */
export function priceLine(
  cards: readonly RateCard[],
  at: string,
  charge: Charge,
): UsageLine | null {
  const holders = cards.filter((card) =>
    card.rates.some((rate) => rate.meter === charge.meter && rate.unit === charge.unit),
  );
  if (holders.length > 1) throw new TypeError("credit_service_rate_ambiguous");
  const card = holders[0];
  if (card === undefined) return null;
  const valued = evaluateRateCard([card], {
    eventTime: new Date(at),
    meter: charge.meter,
    unit: charge.unit,
    quantity: charge.quantity,
  });
  const chargeMicros = Number(valued.creditCharge);
  if (!Number.isSafeInteger(chargeMicros)) throw new RangeError("credit_service_charge_range");
  return {
    projectId: charge.projectId,
    environmentId: charge.environmentId,
    ...(charge.resourceKind === undefined ? {} : { resourceKind: charge.resourceKind }),
    meter: charge.meter,
    quantity: charge.quantity.toString(),
    unit: charge.unit,
    rateCardId: valued.rateCardId,
    chargeMicros,
  };
}

/**
 * Merges equal (organization, project, environment, meter) quantities, prices each once and groups the lines by
 * organization. Order is deterministic so that a rerun of a window posts byte-identical lines.
 */
export function organizationLines(
  charges: readonly Charge[],
  cards: readonly RateCard[],
  at: string,
): { byOrganization: Map<string, UsageLine[]>; unpriced: string[] } {
  const merged = new Map<string, Charge>();
  for (const charge of charges) {
    if (charge.quantity <= 0n) continue;
    const key = [
      charge.organizationId,
      charge.projectId,
      charge.environmentId,
      charge.resourceKind ?? "",
      charge.meter,
      charge.unit,
    ].join("\u0000");
    const previous = merged.get(key);
    merged.set(
      key,
      previous === undefined
        ? charge
        : { ...previous, quantity: previous.quantity + charge.quantity },
    );
  }
  const byOrganization = new Map<string, UsageLine[]>();
  const unpriced = new Set<string>();
  for (const key of [...merged.keys()].sort()) {
    const charge = merged.get(key) as Charge;
    const line = priceLine(cards, at, charge);
    if (line === null) {
      unpriced.add(charge.meter);
      continue;
    }
    const lines = byOrganization.get(charge.organizationId) ?? [];
    lines.push(line);
    byOrganization.set(charge.organizationId, lines);
  }
  return { byOrganization, unpriced: [...unpriced].sort() };
}
