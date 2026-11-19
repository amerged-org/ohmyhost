// @ts-check
import { createHash } from "node:crypto";
import { priceLine, ratesToCards } from "../apps/credit-service/dist/pricing.js";

/**
 * The rules of the credit price list, without any I/O: how a rate card file is read and validated, what a publication
 * or an activation would change against the Core's current state, the exact statements that write it and how the state
 * is rendered. `scripts/credit-prices.mjs` is the operator command around it, the vitest on a real local D1 Core drives
 * the same functions, so the SQL tested is the SQL that runs against the Core.
 *
 * A rate card is immutable. An activation says that from its start instant a meter is priced by one card: a meter has a
 * timeline of activations (migration 0602) and the latest one that started by a usage window prices that window, which
 * is what `CreditRuntime.readRates` and the mail price read. Nothing here updates or deletes a row.
 */

/** @typedef {{ meter: string, unit: string, units_per_charge: string, provider_cost_micros: string | null, credit_micros: string }} StoredRate */
/** @typedef {{ id: string, effectiveFrom: string, rates: StoredRate[] }} Card A validated card as it will be stored (instants in the Core's form). */
/** @typedef {{ id: string, publishedAt: string, effectiveFrom: string, rates: StoredRate[] }} PublishedCard */
/** @typedef {{ meter: string, cardId: string, startsAt: string, activatedAt: string }} Activation */
/** @typedef {{ cards: PublishedCard[], activations: Activation[] }} PriceState */
/** @typedef {{ sql: string, params: string[] }} Write */
/** @typedef {{ meter: string, unit: string, oldCardId: string | null, oldStartsAt: string | null, old: StoredRate | null, new: StoredRate, percent: string | null }} Change */
/**
 * @typedef {object} Plan
 * @property {"publish" | "activate" | "switch"} kind
 * @property {"new" | "unchanged"} status
 * @property {string} cardId
 * @property {string | null} startsAt
 * @property {Change[]} changes
 * @property {string[]} warnings
 * @property {Write[]} writes
 * @property {{ cards: PublishedCard[], activations: Activation[] }} expect What a read-back must find after the writes.
 */
/** @typedef {{ bind(...values: string[]): Statement, all(): Promise<{ results: Record<string, unknown>[] }> }} Statement */
/** @typedef {{ prepare(sql: string): Statement, batch(statements: Statement[]): Promise<unknown> }} Database */

export const HOUR_MS = 3_600_000;
const INT8_MAX = 2n ** 63n - 1n;
const MAX_RATES = 32;
/** The Core's triggers hold the same grammars (migrations 0331 and 0602); the tool refuses first with a reason. */
const CARD_ID = /^[a-z0-9_.-]{1,128}$/u;
const METER = /^[a-z][a-z0-9_.-]{0,127}$/u;
const UNIT = /^[a-z][a-z0-9_.-]{0,63}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
/** An hour boundary written as an ISO instant in UTC: `2026-12-01T09:00:00Z`, optionally with a zero fraction. */
const HOUR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.0{1,9})?Z$/u;

/**
 * @param {string} code
 * @param {string} [detail]
 * @returns {never}
 */
export function fail(code, detail) {
  throw Object.assign(new Error(code), detail === undefined ? {} : { detail });
}

/**
 * The meters the credit service, the mail and the AI gateway charge today, the unit they post and the window a price
 * applies to. A card that rates one of them in another unit would match nothing (`unpriced`), so the tool refuses it.
 * A meter not listed here is a new feature: allowed, with a warning that its emitting code must exist. The names are
 * checked against the sources by tests/credit-prices.node-test.mjs.
 *
 * `refusesUnpriced` marks a meter whose usage the Core refuses until its card is activated, so nothing is billed for free.
 *
 * @type {Readonly<Record<string, { unit: string, window: "hour" | "day" | "instant", refusesUnpriced?: boolean }>>}
 */
export const KNOWN_METERS = Object.freeze({
  "wfp.requests": { unit: "request", window: "hour" },
  "wfp.cpu": { unit: "cpu_ms", window: "hour" },
  "pgcf.memory.active": { unit: "memory_mib_milliseconds", window: "hour" },
  "r2.storage.standard": { unit: "byte_peak_day", window: "day" },
  "r2.class_a": { unit: "request", window: "day" },
  "r2.class_b": { unit: "request", window: "day" },
  "wfp.script": { unit: "script_second", window: "day" },
  "domain.custom_hostname": { unit: "hostname_second", window: "day" },
  "mail.sent": { unit: "recipient", window: "instant" },
  "mail.received": { unit: "message", window: "instant" },
  "ai.cost": { unit: "usd_micro", window: "instant", refusesUnpriced: true },
  "browser.duration": { unit: "millisecond", window: "instant", refusesUnpriced: true },
});

/** The Core's stored form of an instant: `2026-10-30T09:00:00.000000Z`. */
export const storedInstant = (/** @type {number} */ milliseconds) =>
  `${new Date(milliseconds).toISOString().slice(0, 23)}000Z`;
/** The instant of a stored value, in milliseconds. */
export const instantMs = (/** @type {string} */ stored) => Date.parse(`${stored.slice(0, 23)}Z`);
/** The public form of a stored instant: `2026-10-30T09:00:00.000Z`. */
export const publicInstant = (/** @type {string} */ stored) => `${stored.slice(0, 23)}Z`;

/**
 * An hour boundary given on the command line or in a card file, as milliseconds.
 * @param {unknown} value
 * @param {string} name
 */
export function hourInstant(value, name) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  // the round trip refuses what Date.parse silently moves: 2026-02-30 is not 2 March, 24:00 is not the next day
  if (
    typeof value !== "string" ||
    !HOUR_INSTANT.test(value) ||
    Number.isNaN(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 13) !== value.slice(0, 13)
  )
    return fail(
      "CREDIT_PRICES_INSTANT",
      `${name} must be a UTC hour boundary such as 2026-12-01T09:00:00Z`,
    );
  return milliseconds;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} keys
 * @returns {Record<string, unknown>}
 */
function exactObject(value, path, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("CREDIT_PRICES_CARD_SHAPE", `${path} must be an object`);
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record))
    if (!keys.includes(key))
      fail("CREDIT_PRICES_CARD_SHAPE", `${path}.${key} is not a known field`);
  for (const key of keys)
    if (!Object.hasOwn(record, key)) fail("CREDIT_PRICES_CARD_SHAPE", `${path}.${key} is missing`);
  return record;
}

/**
 * An amount as a canonical decimal string (JSON numbers lose precision and are refused).
 * @param {unknown} value
 * @param {string} path
 */
function amount(value, path) {
  if (typeof value !== "string" || !DECIMAL.test(value))
    return fail(
      "CREDIT_PRICES_CARD_SHAPE",
      `${path} must be a canonical decimal string such as "25"`,
    );
  if (BigInt(value) > INT8_MAX) return fail("CREDIT_PRICES_CARD_SHAPE", `${path} exceeds int8`);
  return value;
}

/**
 * Reads and validates a card file: `{ "id", "effective_from", "rates": [{ "meter", "unit", "units_per_charge",
 * "provider_cost_micros", "credit_micros" }] }`. Every amount is a decimal string of whole micro-units. The rates are
 * then run through the credit service's own conversion and pricing (`ratesToCards`, `priceLine`), so a card the
 * service would not price is refused here, with the service's reason.
 *
 * @param {string} text
 * @returns {Card}
 */
export function parseRateCard(text) {
  /** @type {unknown} */
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return fail("CREDIT_PRICES_CARD_JSON", "the card file is not valid JSON");
  }
  const top = exactObject(document, "card", ["id", "effective_from", "rates"]);
  const id = top["id"];
  if (typeof id !== "string" || !CARD_ID.test(id))
    fail("CREDIT_PRICES_CARD_SHAPE", "card.id must match [a-z0-9_.-]{1,128}");
  const effectiveMs = hourInstant(top["effective_from"], "card.effective_from");
  const list = top["rates"];
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_RATES)
    fail("CREDIT_PRICES_CARD_SHAPE", `card.rates must hold 1 to ${String(MAX_RATES)} rates`);
  /** @type {StoredRate[]} */
  const rates = [];
  for (const [index, entry] of /** @type {unknown[]} */ (list).entries()) {
    const path = `card.rates[${String(index)}]`;
    const rate = exactObject(entry, path, [
      "meter",
      "unit",
      "units_per_charge",
      "provider_cost_micros",
      "credit_micros",
    ]);
    const meter = rate["meter"];
    const unit = rate["unit"];
    if (typeof meter !== "string" || !METER.test(meter))
      fail("CREDIT_PRICES_CARD_SHAPE", `${path}.meter must match [a-z][a-z0-9_.-]{0,127}`);
    if (typeof unit !== "string" || !UNIT.test(unit))
      fail("CREDIT_PRICES_CARD_SHAPE", `${path}.unit must match [a-z][a-z0-9_.-]{0,63}`);
    if (rates.some((other) => other.meter === meter))
      fail("CREDIT_PRICES_DUPLICATE_METER", String(meter));
    const providerCost = rate["provider_cost_micros"];
    rates.push({
      meter: /** @type {string} */ (meter),
      unit: /** @type {string} */ (unit),
      units_per_charge: amount(rate["units_per_charge"], `${path}.units_per_charge`),
      provider_cost_micros:
        providerCost === null ? null : amount(providerCost, `${path}.provider_cost_micros`),
      credit_micros: amount(rate["credit_micros"], `${path}.credit_micros`),
    });
  }
  const card = { id: /** @type {string} */ (id), effectiveFrom: storedInstant(effectiveMs), rates };
  probePricing(card, effectiveMs);
  for (const rate of rates) {
    unitIsKnown(rate);
    if (
      rate.meter === "browser.duration" &&
      (rate.provider_cost_micros === null ||
        BigInt(rate.credit_micros) !== BigInt(rate.provider_cost_micros) * 200n)
    )
      fail("CREDIT_PRICES_RATE_INVALID", "browser.duration must be priced at twice provider cost");
  }
  return card;
}

/**
 * The credit service must price one full charge of every rate to exactly the stated credits.
 * @param {Card} card
 * @param {number} effectiveMs
 */
function probePricing(card, effectiveMs) {
  const at = new Date(effectiveMs).toISOString();
  try {
    const cards = ratesToCards([{ rateCardId: card.id, rates: card.rates }], at);
    for (const rate of card.rates) {
      const line = priceLine(cards, at, {
        organizationId: "probe",
        projectId: "probe",
        environmentId: "probe",
        meter: rate.meter,
        unit: rate.unit,
        quantity: BigInt(rate.units_per_charge),
      });
      if (line === null || BigInt(line.chargeMicros) !== BigInt(rate.credit_micros))
        fail(
          "CREDIT_PRICES_RATE_INVALID",
          `${rate.meter} is not priced by the credit service as stated`,
        );
    }
  } catch (error) {
    if (error instanceof Error && /^CREDIT_PRICES_/u.test(error.message)) throw error;
    return fail(
      "CREDIT_PRICES_RATE_INVALID",
      `the credit service refuses this card: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

/** @param {StoredRate} rate */
function unitIsKnown(rate) {
  const known = KNOWN_METERS[rate.meter];
  if (known !== undefined && known.unit !== rate.unit)
    fail(
      "CREDIT_PRICES_UNIT_MISMATCH",
      `${rate.meter} is posted in unit ${known.unit}, the card says ${rate.unit}; usage would stay unpriced`,
    );
}

/** The content digest a journal can name without repeating the card. */
export const cardDigest = (/** @type {Card | PublishedCard} */ card) =>
  createHash("sha256")
    .update(canonical({ id: card.id, effective_from: card.effectiveFrom, rates: card.rates }))
    .digest("hex");

/** Stable text of a value: object keys sorted, so key order never makes two equal documents differ. */
export const canonical = (/** @type {unknown} */ value) =>
  JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );

/**
 * The Core's current price state: every card and every activation.
 * @param {Database} db
 * @returns {Promise<PriceState>}
 */
export async function readState(db) {
  const cards = await db
    .prepare(
      "SELECT rate_card_id, published_at, effective_from, rates FROM published_credit_rate_cards ORDER BY effective_from",
    )
    .all();
  const activations = await db
    .prepare(
      "SELECT meter, rate_card_id, starts_at, activated_at FROM usage_meter_activations ORDER BY meter, starts_at",
    )
    .all();
  return {
    cards: cards.results.map((row) => ({
      id: String(row["rate_card_id"]),
      publishedAt: String(row["published_at"]),
      effectiveFrom: String(row["effective_from"]),
      rates: /** @type {StoredRate[]} */ (JSON.parse(String(row["rates"]))),
    })),
    activations: activations.results.map((row) => ({
      meter: String(row["meter"]),
      cardId: String(row["rate_card_id"]),
      startsAt: String(row["starts_at"]),
      activatedAt: String(row["activated_at"]),
    })),
  };
}

const rateOf = (/** @type {{ rates: StoredRate[] }} */ card, /** @type {string} */ meter) =>
  card.rates.find((rate) => rate.meter === meter);

/** The activations of one meter, oldest first. */
const timelineOf = (/** @type {PriceState} */ state, /** @type {string} */ meter) =>
  state.activations.filter((activation) => activation.meter === meter);

/**
 * The activation that prices a meter at a stored instant: the latest that started by then.
 * @param {PriceState} state
 * @param {string} meter
 * @param {string} at
 */
export function activationInForce(state, meter, at) {
  return timelineOf(state, meter)
    .filter((activation) => activation.startsAt <= at)
    .at(-1);
}

/** The rate and card behind an activation. */
function rateBehind(
  /** @type {PriceState} */ state,
  /** @type {Activation | undefined} */ activation,
) {
  const card =
    activation === undefined ? undefined : state.cards.find((c) => c.id === activation.cardId);
  const rate =
    card === undefined || activation === undefined ? undefined : rateOf(card, activation.meter);
  return rate === undefined ? null : rate;
}

/**
 * `numerator / denominator` as a decimal with at most `digits` fractional digits (half up), trailing zeros removed.
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @param {number} digits
 */
export function decimal(numerator, denominator, digits) {
  const scale = 10n ** BigInt(digits);
  const scaled = (numerator * scale * 2n + denominator) / (denominator * 2n);
  const fraction = (scaled % scale).toString().padStart(digits, "0").replace(/0+$/u, "");
  return fraction === ""
    ? (scaled / scale).toString()
    : `${(scaled / scale).toString()}.${fraction}`;
}

/** What one rate costs: the stated charge and the same per single unit, in credits. */
export function describeRate(/** @type {StoredRate} */ rate) {
  const credits = BigInt(rate.credit_micros);
  const units = BigInt(rate.units_per_charge);
  return {
    perCharge: `${decimal(credits, 1_000_000n, 6)} credits per ${rate.units_per_charge} ${rate.unit}`,
    perUnit: `${decimal(credits, units * 1_000_000n, 15)} credits per ${rate.unit}`,
  };
}

/**
 * The relative change of the price per unit, exact in integers, as `+12.50%`.
 * @param {StoredRate} previous
 * @param {StoredRate} next
 */
export function percentChange(previous, next) {
  const [oldCredits, oldUnits] = [
    BigInt(previous.credit_micros),
    BigInt(previous.units_per_charge),
  ];
  const [newCredits, newUnits] = [BigInt(next.credit_micros), BigInt(next.units_per_charge)];
  const difference = newCredits * oldUnits - oldCredits * newUnits;
  if (oldCredits === 0n) return difference === 0n ? "0.00%" : "new price (was free)";
  const denominator = oldCredits * newUnits;
  const scaled =
    ((difference < 0n ? -difference : difference) * 20_000n + denominator) / (denominator * 2n);
  const sign = difference === 0n ? "" : difference < 0n ? "-" : "+";
  return `${sign}${(scaled / 100n).toString()}.${(scaled % 100n).toString().padStart(2, "0")}%`;
}

/**
 * The change a rate makes against the latest activation of its meter.
 * @param {PriceState} state
 * @param {StoredRate} rate
 * @returns {Change}
 */
function changeOf(state, rate) {
  const latest = timelineOf(state, rate.meter).at(-1);
  const old = rateBehind(state, latest);
  return {
    meter: rate.meter,
    unit: rate.unit,
    oldCardId: latest?.cardId ?? null,
    oldStartsAt: latest?.startsAt ?? null,
    old,
    new: rate,
    percent: old === null ? null : percentChange(old, rate),
  };
}

/**
 * A unit never changes under a meter that was activated before: the posting code keeps its unit, so another unit would
 * leave the usage unpriced. A new unit needs a new meter name.
 * @param {PriceState} state
 * @param {StoredRate} rate
 */
function unitIsStable(state, rate) {
  const before = rateBehind(state, timelineOf(state, rate.meter).at(-1));
  if (before !== null && before.unit !== rate.unit)
    fail(
      "CREDIT_PRICES_UNIT_CHANGED",
      `${rate.meter} is priced in unit ${before.unit}; a unit change needs a new meter name`,
    );
}

/**
 * Hints that depend on the window a source bills by.
 * @param {StoredRate} rate
 * @param {string} startsAt
 */
function windowHints(rate, startsAt) {
  const known = KNOWN_METERS[rate.meter];
  if (known === undefined)
    return [
      `${rate.meter} is not posted by any usage source or charge in this repository: the code that posts its quantities must exist first, otherwise nothing is billed`,
    ];
  if (known.window === "day" && !startsAt.slice(11).startsWith("00:00:00")) {
    const day = 24 * HOUR_MS;
    const firstDay = storedInstant(Math.ceil(instantMs(startsAt) / day) * day);
    return [
      `${rate.meter} is billed per finished UTC day and each day is priced by its start: this start first prices the day beginning ${publicInstant(firstDay)}`,
    ];
  }
  return [];
}

/**
 * Plans the publication of a card: refuses a changed card, a retroactive or taken effective time and a changed unit.
 * @param {PriceState} state
 * @param {Card} card
 * @param {number} nowMs
 * @returns {Plan}
 */
export function planPublish(state, card, nowMs) {
  const existing = state.cards.find((candidate) => candidate.id === card.id);
  const changes = card.rates.map((rate) => changeOf(state, rate));
  if (existing !== undefined) {
    if (cardDigest(existing) !== cardDigest(card))
      fail(
        "CREDIT_PRICES_CARD_CONFLICT",
        `${card.id} is published with other content; a published card never changes, publish a new id`,
      );
    return {
      kind: "publish",
      status: "unchanged",
      cardId: card.id,
      startsAt: null,
      changes,
      warnings: [],
      writes: [],
      expect: { cards: [existing], activations: [] },
    };
  }
  if (instantMs(card.effectiveFrom) - nowMs < HOUR_MS)
    fail(
      "CREDIT_PRICES_RETROACTIVE",
      `effective_from ${publicInstant(card.effectiveFrom)} must be at least one hour after now: a price never applies retroactively`,
    );
  const taken = state.cards.find((candidate) => candidate.effectiveFrom === card.effectiveFrom);
  if (taken !== undefined)
    fail(
      "CREDIT_PRICES_EFFECTIVE_TAKEN",
      `${taken.id} already takes effect at ${publicInstant(card.effectiveFrom)}; two cards never share an effective time`,
    );
  for (const rate of card.rates) unitIsStable(state, rate);
  const publishedAt = storedInstant(nowMs);
  const published = {
    id: card.id,
    publishedAt,
    effectiveFrom: card.effectiveFrom,
    rates: card.rates,
  };
  return {
    kind: "publish",
    status: "new",
    cardId: card.id,
    startsAt: null,
    changes,
    warnings: card.rates.map((rate) =>
      timelineOf(state, rate.meter).length === 0
        ? KNOWN_METERS[rate.meter]?.refusesUnpriced === true
          ? `${rate.meter} has no activation: AI calls are refused until activate or switch starts this card`
          : `${rate.meter} has no activation: it bills nothing until activate or switch starts this card`
        : `${rate.meter} keeps its current price until an activation of this card starts`,
    ),
    writes: [
      {
        sql: "INSERT INTO published_credit_rate_cards(rate_card_id, published_at, effective_from, rates) VALUES (?, ?, ?, ?)",
        params: [card.id, publishedAt, card.effectiveFrom, JSON.stringify(card.rates)],
      },
    ],
    expect: { cards: [published], activations: [] },
  };
}

/**
 * The write of one activation. A failed guard leaves the card column NULL, which aborts the whole batch, so a switch of
 * several meters is all or nothing even when another writer got in between the read and this statement.
 */
const ACTIVATE_SQL = `WITH input(meter, card_id, starts_at, activated_at) AS (VALUES (?, ?, ?, ?))
INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at)
SELECT input.meter,
  CASE WHEN EXISTS (
      SELECT 1 FROM published_credit_rate_cards card
      WHERE card.rate_card_id = input.card_id AND card.published_at <= input.activated_at
        AND card.effective_from <= input.starts_at
        AND EXISTS (SELECT 1 FROM json_each(card.rates) rate WHERE json_extract(rate.value, '$.meter') = input.meter))
    AND NOT EXISTS (
      SELECT 1 FROM usage_meter_activations later WHERE later.meter = input.meter AND later.starts_at >= input.starts_at)
  THEN input.card_id END,
  input.starts_at, input.activated_at
FROM input`;

/**
 * The activation of one meter on a card, or null when it is already in place.
 * @param {PriceState} state
 * @param {PublishedCard} card
 * @param {string} meter
 * @param {number} startsAtMs
 * @param {number} nowMs
 * @returns {{ change: Change, write: Write, activation: Activation, hints: string[] } | null}
 */
function activationOf(state, card, meter, startsAtMs, nowMs) {
  const rate = rateOf(card, meter);
  if (rate === undefined)
    return fail("CREDIT_PRICES_METER_NOT_ON_CARD", `${card.id} has no rate for ${meter}`);
  const startsAt = storedInstant(startsAtMs);
  const timeline = timelineOf(state, meter);
  const same = timeline.find((activation) => activation.startsAt === startsAt);
  if (same !== undefined) {
    if (same.cardId === card.id) return null;
    return fail(
      "CREDIT_PRICES_ACTIVATION_CONFLICT",
      `${meter} is already activated at ${publicInstant(startsAt)} on ${same.cardId}; an activation never changes`,
    );
  }
  if (startsAtMs <= nowMs)
    return fail(
      "CREDIT_PRICES_RETROACTIVE",
      `starts-at ${publicInstant(startsAt)} is not in the future: a price never applies retroactively`,
    );
  const latest = timeline.at(-1);
  if (latest !== undefined && latest.startsAt > startsAt)
    return fail(
      "CREDIT_PRICES_ACTIVATION_LATER",
      `${meter} already has an activation from ${publicInstant(latest.startsAt)} on ${latest.cardId}; a new one must start after it`,
    );
  if (latest?.cardId === card.id) return null;
  if (card.effectiveFrom > startsAt)
    return fail(
      "CREDIT_PRICES_BEFORE_EFFECTIVE",
      `${card.id} takes effect at ${publicInstant(card.effectiveFrom)}, after starts-at ${publicInstant(startsAt)}`,
    );
  unitIsStable(state, rate);
  unitIsKnown(rate);
  const activatedAt = storedInstant(nowMs);
  return {
    change: changeOf(state, rate),
    write: { sql: ACTIVATE_SQL, params: [meter, card.id, startsAt, activatedAt] },
    activation: { meter, cardId: card.id, startsAt, activatedAt },
    hints: windowHints(rate, startsAt),
  };
}

/**
 * @param {PriceState} state
 * @param {string} cardId
 * @returns {PublishedCard}
 */
function publishedCard(state, cardId) {
  const card = state.cards.find((candidate) => candidate.id === cardId);
  return (
    card ?? fail("CREDIT_PRICES_CARD_UNKNOWN", `${cardId} is not published; run publish first`)
  );
}

/**
 * Plans the activation of one meter on a published card from a future hour.
 * @param {PriceState} state
 * @param {{ meter: string, cardId: string, startsAtMs: number }} input
 * @param {number} nowMs
 * @returns {Plan}
 */
export function planActivate(state, input, nowMs) {
  const card = publishedCard(state, input.cardId);
  const done = activationOf(state, card, input.meter, input.startsAtMs, nowMs);
  return activationPlan("activate", card, input.startsAtMs, done === null ? [] : [done]);
}

/**
 * Plans the activation of every meter of a published card from a future hour, as one batch. A meter that already
 * stands on this card is left alone.
 * @param {PriceState} state
 * @param {{ cardId: string, startsAtMs: number }} input
 * @param {number} nowMs
 * @returns {Plan}
 */
export function planSwitch(state, input, nowMs) {
  const card = publishedCard(state, input.cardId);
  const steps = card.rates.flatMap((rate) => {
    const step = activationOf(state, card, rate.meter, input.startsAtMs, nowMs);
    return step === null ? [] : [step];
  });
  return activationPlan("switch", card, input.startsAtMs, steps);
}

/**
 * @param {"activate" | "switch"} kind
 * @param {PublishedCard} card
 * @param {number} startsAtMs
 * @param {{ change: Change, write: Write, activation: Activation, hints: string[] }[]} steps
 * @returns {Plan}
 */
function activationPlan(kind, card, startsAtMs, steps) {
  return {
    kind,
    status: steps.length === 0 ? "unchanged" : "new",
    cardId: card.id,
    startsAt: storedInstant(startsAtMs),
    changes: steps.map((step) => step.change),
    warnings: [...new Set(steps.flatMap((step) => step.hints))],
    writes: steps.map((step) => step.write),
    expect: { cards: [], activations: steps.map((step) => step.activation) },
  };
}

/**
 * Writes a plan as one atomic D1 batch and reads the result back. Nothing is updated or deleted.
 * @param {Database} db
 * @param {Plan} plan
 * @returns {Promise<PriceState>} The state read back after the write.
 */
export async function applyPlan(db, plan) {
  if (plan.writes.length === 0) return readState(db);
  try {
    await db.batch(plan.writes.map((write) => db.prepare(write.sql).bind(...write.params)));
  } catch {
    // The statement guards and the Core's constraints refused the write, or its outcome is unknown: read back to tell.
    const after = await readState(db);
    return foundOrFail(after, plan, "CREDIT_PRICES_WRITE_REFUSED");
  }
  return foundOrFail(await readState(db), plan, "CREDIT_PRICES_READBACK");
}

/**
 * @param {PriceState} state
 * @param {Plan} plan
 * @param {string} code
 */
function foundOrFail(state, plan, code) {
  const cardsFound = plan.expect.cards.every((card) => {
    const stored = state.cards.find((candidate) => candidate.id === card.id);
    return (
      stored !== undefined &&
      stored.publishedAt === card.publishedAt &&
      cardDigest(stored) === cardDigest(card)
    );
  });
  const activationsFound = plan.expect.activations.every((activation) =>
    state.activations.some(
      (stored) =>
        stored.meter === activation.meter &&
        stored.startsAt === activation.startsAt &&
        stored.cardId === activation.cardId &&
        stored.activatedAt === activation.activatedAt,
    ),
  );
  if (!cardsFound || !activationsFound) return fail(code);
  return state;
}

/**
 * The text of the current price state.
 * @param {PriceState} state
 * @param {number} nowMs
 */
export function renderState(state, nowMs) {
  const now = storedInstant(nowMs);
  const lines = [`Cards (${String(state.cards.length)}), by effective time`];
  for (const card of state.cards)
    lines.push(
      `  ${card.id}  published ${publicInstant(card.publishedAt)}  effective ${publicInstant(card.effectiveFrom)}  ${String(card.rates.length)} rates`,
    );
  const meters = [...new Set(state.activations.map((activation) => activation.meter))].sort();
  lines.push("", `Activated meters (${String(meters.length)}), timeline and current price`);
  for (const meter of meters) {
    const inForce = activationInForce(state, meter, now);
    const rate = rateBehind(state, inForce);
    lines.push(
      `  ${meter}  ${rate === null ? "" : `unit ${rate.unit}  current ${describeRate(rate).perUnit} (${describeRate(rate).perCharge})`}${inForce === undefined ? "  not started yet" : ""}`,
    );
    for (const activation of timelineOf(state, meter)) {
      const behind = rateBehind(state, activation);
      const label =
        activation === inForce ? "in force" : activation.startsAt > now ? "pending" : "superseded";
      lines.push(
        `    from ${publicInstant(activation.startsAt)} -> ${activation.cardId}  ${behind === null ? "(no rate on the card)" : describeRate(behind).perCharge}  [${label}]`,
      );
    }
  }
  const activated = new Set(meters);
  const unactivated = [
    ...new Set(state.cards.flatMap((card) => card.rates.map((rate) => rate.meter))),
  ]
    .filter((meter) => !activated.has(meter))
    .sort();
  lines.push(
    "",
    unactivated.length === 0
      ? "Every rated meter is activated."
      : `Rated on a card but never activated (billed nothing, reported as unpriced): ${unactivated.join(", ")}`,
  );
  return lines.join("\n");
}

/**
 * The text of a plan: what would be written and what each meter's price becomes.
 * @param {Plan} plan
 */
export function renderPlan(plan) {
  const head =
    plan.kind === "publish"
      ? `publish card ${plan.cardId}${plan.status === "unchanged" ? " (already published with this content, nothing to write)" : ""}`
      : `${plan.kind} ${plan.cardId} from ${plan.startsAt === null ? "?" : publicInstant(plan.startsAt)}${plan.status === "unchanged" ? " (already in place, nothing to write)" : ""}`;
  const lines = [head];
  for (const change of plan.changes) {
    lines.push(`  ${change.meter}  unit ${change.unit}`);
    if (change.old === null) lines.push("    old:    no activation, nothing is billed today");
    else
      lines.push(
        `    old:    ${describeRate(change.old).perCharge} (${describeRate(change.old).perUnit}) on ${change.oldCardId ?? "?"} since ${change.oldStartsAt === null ? "?" : publicInstant(change.oldStartsAt)}`,
      );
    lines.push(
      `    new:    ${describeRate(change.new).perCharge} (${describeRate(change.new).perUnit})`,
    );
    if (change.percent !== null) lines.push(`    change: ${change.percent}`);
  }
  for (const warning of plan.warnings) lines.push(`  note: ${warning}`);
  return lines.join("\n");
}
