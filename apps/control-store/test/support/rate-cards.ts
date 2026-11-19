import type { RateCard } from "@ohmyhost/platform/shared";
import { z } from "zod";

import type { D1Database } from "../../src/d1-types.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { resendMailCard, usageCard, type CardDates } from "./rate-card-catalog.js";

/** The databases a price version is written to; every write is idempotent, so a retry converges. */
export interface RateCardTargets {
  list(): Promise<readonly D1Database[]>;
}

// Validate the released API's canonical millisecond form BEFORE normalizing for D1 storage.
// Truncating microseconds first could turn a backwards publication into equal valid instants.
const originalInstant = z.string().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}, "canonical millisecond UTC timestamp required");
const datesInput = z.strictObject({ publishedAt: originalInstant, effectiveFrom: originalInstant });
const label = z.string().min(1).max(128);
const activationInput = z.strictObject({
  meter: label,
  rateCardId: label,
  startsAt: originalInstant.transform(storedTimestamp),
  now: originalInstant.transform(storedTimestamp),
});

/** Stable text of a rates document: key order must not make two equal price versions differ. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );

const ratesOf = (card: RateCard) =>
  card.rates.map((rate) => ({
    meter: rate.meter,
    unit: rate.unit,
    units_per_charge: rate.unitsPerCharge.toString(),
    provider_cost_micros: rate.providerCostPerCharge?.toString() ?? null,
    credit_micros: rate.creditsPerCharge.toString(),
  }));

async function allTargets(targets: RateCardTargets): Promise<readonly D1Database[]> {
  const list = await targets.list();
  if (list.length === 0) throw new Error("no shard is available for the rate-card authority");
  return list;
}

async function persist(db: D1Database, card: RateCard): Promise<void> {
  const rates = ratesOf(card);
  const publishedAt = storedTimestamp(card.publishedAt);
  const effectiveFrom = storedTimestamp(card.effectiveFrom);
  await db
    .prepare(
      `INSERT INTO published_credit_rate_cards(rate_card_id, published_at, effective_from, rates)
       VALUES (?, ?, ?, ?) ON CONFLICT (rate_card_id) DO NOTHING`,
    )
    .bind(card.id, publishedAt, effectiveFrom, JSON.stringify(rates))
    .run();
  const stored = await db
    .prepare(
      "SELECT published_at, effective_from, rates FROM published_credit_rate_cards WHERE rate_card_id = ?",
    )
    .bind(card.id)
    .first<{ published_at: string; effective_from: string; rates: string }>();
  if (
    stored === null ||
    stored.published_at !== publishedAt ||
    stored.effective_from !== effectiveFrom ||
    canonical(JSON.parse(stored.rates)) !== canonical(rates)
  ) {
    throw new Error("Published price version cannot change");
  }
}

/** Test fixture: publishes the immutable price versions and activates their meters in the given Core databases. */
export function createRateCardAuthority(targets: RateCardTargets) {
  const publish = (build: (dates: CardDates) => RateCard) => async (rawInput: unknown) => {
    const input = datesInput.parse(rawInput);
    // The platform builders validate the ISO instants of the original (millisecond) form.
    const card = build(input);
    for (const db of await allTargets(targets)) await persist(db, card);
    return card.id;
  };
  return Object.freeze({
    publishUsageRateCard: publish(usageCard),
    publishResendMailUsageRateCard: publish(resendMailCard),

    /** Operator activation is prospective and immutable; a published price alone never starts billing. */
    async activateUsageMeter(rawInput: unknown): Promise<void> {
      const input = activationInput.parse(rawInput);
      // Prospectivity is enforced by the INSERT only; an existing exact activation replays after its start.
      for (const db of await allTargets(targets)) {
        await db
          .prepare(
            `INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at)
             SELECT ?, ?, ?, ? FROM published_credit_rate_cards card
             WHERE card.rate_card_id = ? AND card.published_at <= ? AND card.effective_from <= ? AND ? >= ?
               AND EXISTS (SELECT 1 FROM json_each(card.rates) rate WHERE json_extract(rate.value, '$.meter') = ?)
             ON CONFLICT (meter, starts_at) DO NOTHING`,
          )
          .bind(
            input.meter,
            input.rateCardId,
            input.startsAt,
            input.now,
            input.rateCardId,
            input.now,
            input.startsAt,
            input.startsAt,
            input.now,
            input.meter,
          )
          .run();
        const stored = await db
          .prepare(
            "SELECT 1 AS ok FROM usage_meter_activations WHERE meter = ? AND rate_card_id = ? AND starts_at = ?",
          )
          .bind(input.meter, input.rateCardId, input.startsAt)
          .first();
        if (stored === null) {
          throw new Error("Meter activation conflicts or is not covered by a published price");
        }
      }
    },
  });
}
