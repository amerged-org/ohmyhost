import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admitAi, settleAi } from "../../src/catalog/ai/index.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf } from "../support/platform-fixtures.js";
import { ESTIMATE_NANO, LIVE_COST_NANO, readyProject, type AiProject } from "./support.js";

/*
 * The price of a settlement is the card of the latest activation that has started and whose card has been published.
 * Activations are append-only, so every card here is its own activation; the base card of `publishAiCard` is not used.
 */

let control: TestControl;
let sequence = 0;
const reservationId = () => ulidOf("ai-price", (sequence += 1));

async function publish(card: string, creditMicros: number, at: string): Promise<void> {
  const rates = JSON.stringify([
    {
      meter: "ai.cost",
      unit: "usd_micro",
      units_per_charge: "10000",
      provider_cost_micros: null,
      credit_micros: String(creditMicros),
    },
  ]);
  await control.core
    .prepare(
      "INSERT INTO published_credit_rate_cards(rate_card_id, published_at, effective_from, rates) VALUES (?1, ?2, ?2, ?3)",
    )
    .bind(card, at, rates)
    .run();
}

async function activate(card: string, startsAt: string, activatedAt: string): Promise<void> {
  await control.core
    .prepare(
      "INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at) VALUES ('ai.cost', ?1, ?2, ?3)",
    )
    .bind(card, startsAt, activatedAt)
    .run();
}

beforeAll(async () => {
  control = await createTestControl();
  // A: active from 2026-01-01 at 1_390_895. B: from 2026-06-01 at 2_000_000 (in the past). C: published, starts 2099.
  // D: starts in the past, after B, but its card is published in 2099, so it must not price anything yet.
  await publish("price-a", 1_390_895, "2026-01-01T00:00:00.000000Z");
  await activate("price-a", "2026-01-01T00:00:00.000000Z", "2026-01-01T00:00:00.000000Z");
  await publish("price-b", 2_000_000, "2026-05-01T00:00:00.000000Z");
  await activate("price-b", "2026-06-01T00:00:00.000000Z", "2026-05-01T00:00:00.000000Z");
  await publish("price-c", 9_000_000, "2026-05-02T00:00:00.000000Z");
  await activate("price-c", "2099-01-01T00:00:00.000000Z", "2099-01-01T00:00:00.000000Z");
  await publish("price-d", 7_000_000, "2099-02-01T00:00:00.000000Z");
  await activate("price-d", "2026-07-01T00:00:00.000000Z", "2026-07-01T00:00:00.000000Z");
}, 120_000);
afterAll(async () => control.dispose());

async function admitAndSettle(p: AiProject): Promise<number> {
  const id = reservationId();
  const admitted = await admitAi(p.context, {
    scope: p.scope,
    reservationId: id,
    model: "claude-haiku-5-5",
    estimateNanoUsd: ESTIMATE_NANO,
  });
  expect(admitted).toMatchObject({ admitted: true });
  const settled = await settleAi(p.context, {
    scope: p.scope,
    reservationId: id,
    model: "claude-haiku-5-5",
    costNanoUsd: LIVE_COST_NANO,
    usage: {},
    traceId: null,
  });
  if (!settled.settled) throw new Error(settled.reason);
  return settled.chargedMicros;
}

describe("the card that prices an AI call", () => {
  it("prices the call with the latest started activation whose card is published, and ignores the later ones", async () => {
    const p = await readyProject(control, { credits: 500 });
    // B (2_000_000) started after A and is the latest started one. The future-dated C and the unpublished D do not count.
    // ceil(3_600 * 2_000_000 / (10_000 * 1_000)) = 720
    expect(await admitAndSettle(p)).toBe(720);
  });

  it("never prices with the card of D, whose activation has started but whose card is not yet published", async () => {
    const p = await readyProject(control, { credits: 500 });
    expect(await admitAndSettle(p)).not.toBe(ceilOfD());
  });
});

/** The charge the unpublished card D would make: 3_600 * 7_000_000 / (10_000 * 1_000), rounded up. */
function ceilOfD(): number {
  return Math.ceil((3_600 * 7_000_000) / (10_000 * 1_000));
}
