import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyPlan,
  parseRateCard,
  planActivate,
  planPublish,
  planSwitch,
  readState,
  type Plan,
} from "../../../../scripts/credit-prices-model.mjs";
import type { CatalogContext } from "../../src/catalog/common.js";
import { createCreditCommands } from "../../src/catalog/credit/index.js";
import { mailChargeMicros, mailPriceSql, type MailPrice } from "../../src/catalog/mail/credit.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createControlStore } from "../../src/store.js";
import { organizationLines, priceLine, ratesToCards } from "../../../credit-service/src/pricing.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  fundOrganization,
  publishMailPricing,
  seedMailRig,
} from "../support/mail-events-fixture.js";

/*
 * The price list end to end on a real local D1 Core: a card is published and a meter switched to it with the SAME
 * statements the operator command emits (scripts/credit-prices-model.mjs), and then the Core's `readRates`, the credit
 * service's pricing and the mail price must all follow the activation timeline, before and from its start.
 */

const NOW = Date.parse("2026-10-30T09:20:00.000Z");
const OLD_AT = "2026-11-30T23:00:00.000Z";
const NEW_AT = "2026-12-01T00:00:00.000Z";

const rate = (
  meter: string,
  unit: string,
  units: string,
  cost: string | null,
  credits: string,
) => ({
  meter,
  unit,
  units_per_charge: units,
  provider_cost_micros: cost,
  credit_micros: credits,
});
/** The live September card of Worker usage: 690 credits per 7,000,000 requests. */
const SEPTEMBER = [
  rate("wfp.requests", "request", "7000000", "2100000", "690000000"),
  rate("wfp.cpu", "cpu_ms", "7000000", "140000", "46000000"),
];
/** The December card: requests 10 percent dearer, CPU unchanged. */
const DECEMBER = {
  id: "usage-2026-12-v1",
  effective_from: NEW_AT,
  rates: [
    rate("wfp.requests", "request", "7000000", "2100000", "759000000"),
    rate("wfp.cpu", "cpu_ms", "7000000", "140000", "46000000"),
  ],
};

let control: TestControl;
let credit: ReturnType<typeof createCreditCommands>;
beforeAll(async () => {
  control = await createTestControl();
  const context: CatalogContext = {
    directory: control.core,
    router: new SharedCoreRouter(control.core),
  };
  credit = createCreditCommands(
    (command) => (input) => command(context, input),
    () => "2026-10-30T09:20:00.000000Z",
  );
  // the rows the import of the previous Control brought: the September card, activated since then
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO published_credit_rate_cards(rate_card_id, published_at, effective_from, rates) VALUES (?, ?, ?, ?)",
      )
      .bind(
        "usage-2026-09-07-v1",
        "2026-09-07T00:00:00.000000Z",
        "2026-09-07T00:00:00.000000Z",
        JSON.stringify(SEPTEMBER),
      ),
    ...SEPTEMBER.map((entry) =>
      control.core
        .prepare(
          "INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(
          entry.meter,
          "usage-2026-09-07-v1",
          "2026-09-07T00:00:00.000000Z",
          "2026-09-07T00:00:00.000000Z",
        ),
    ),
  ]);
}, 120_000);
afterAll(async () => control.dispose());

const write = async (plan: Plan) => applyPlan(control.core, plan);
const publish = async (document: object) =>
  write(planPublish(await readState(control.core), parseRateCard(JSON.stringify(document)), NOW));

/** What the credit service bills for `quantity` requests of one window: the line, or null when unpriced. */
async function billedRequests(at: string, quantity: bigint) {
  const cards = ratesToCards(await credit.readRates({ at }), at);
  return priceLine(cards, at, {
    organizationId: "o",
    projectId: "p",
    environmentId: "e",
    meter: "wfp.requests",
    unit: "request",
    quantity,
  });
}

describe("changing a price with the operator command's statements", () => {
  it("prices a window by the card of the latest activation that started, the old card before it", async () => {
    expect(await billedRequests(NEW_AT, 7_000_000n)).toMatchObject({
      rateCardId: "usage-2026-09-07-v1",
      chargeMicros: 690_000_000,
    });

    // a published card prices nothing until an activation names it
    const published = await publish(DECEMBER);
    expect(published.cards.map((card) => card.id)).toContain("usage-2026-12-v1");
    expect(await billedRequests(NEW_AT, 7_000_000n)).toMatchObject({ chargeMicros: 690_000_000 });

    // one switch, one batch: both meters of the card
    const state = await readState(control.core);
    const plan = planSwitch(state, { cardId: DECEMBER.id, startsAtMs: Date.parse(NEW_AT) }, NOW);
    expect(plan.writes).toHaveLength(2);
    expect(plan.changes.map((change) => [change.meter, change.percent])).toEqual([
      ["wfp.requests", "+10.00%"],
      ["wfp.cpu", "0.00%"],
    ]);
    await write(plan);

    // before the start the old card prices, from the start the new one, and a window does not move afterwards
    for (const [at, card, charge] of [
      [OLD_AT, "usage-2026-09-07-v1", 690_000_000],
      [NEW_AT, "usage-2026-12-v1", 759_000_000],
      ["2027-03-01T05:00:00.000Z", "usage-2026-12-v1", 759_000_000],
    ] as const)
      expect(await billedRequests(at, 7_000_000n), at).toMatchObject({
        rateCardId: card,
        chargeMicros: charge,
      });
    // each meter is priced by exactly one card at an instant: the service never meets an ambiguous holder
    for (const at of [OLD_AT, NEW_AT]) {
      const cards = ratesToCards(await credit.readRates({ at }), at);
      const holders = cards.filter((card) => card.rates.some((entry) => entry.meter === "wfp.cpu"));
      expect(holders).toHaveLength(1);
    }
    // the line of a real window, merged and rounded once like the service does it
    const at = NEW_AT;
    const { byOrganization, unpriced } = organizationLines(
      [
        {
          organizationId: "o",
          projectId: "p",
          environmentId: "e",
          meter: "wfp.requests",
          unit: "request",
          quantity: 1_000_000n,
        },
      ],
      ratesToCards(await credit.readRates({ at }), at),
      at,
    );
    expect(unpriced).toEqual([]);
    // 759,000,000 micro-credits per 7,000,000 requests, rounded up once: 108,428,572 for one million
    expect(byOrganization.get("o")).toEqual([
      expect.objectContaining({ meter: "wfp.requests", chargeMicros: 108_428_572 }),
    ]);

    // a rollback is one more activation after the latest one, and the timeline keeps every row
    await write(
      planActivate(
        await readState(control.core),
        {
          meter: "wfp.requests",
          cardId: "usage-2026-09-07-v1",
          startsAtMs: Date.parse("2027-04-01T00:00:00.000Z"),
        },
        NOW,
      ),
    );
    expect(await billedRequests("2027-03-31T23:00:00.000Z", 7_000_000n)).toMatchObject({
      chargeMicros: 759_000_000,
    });
    expect(await billedRequests("2027-04-01T00:00:00.000Z", 7_000_000n)).toMatchObject({
      rateCardId: "usage-2026-09-07-v1",
      chargeMicros: 690_000_000,
    });
    const timeline = (await readState(control.core)).activations.filter(
      (activation) => activation.meter === "wfp.requests",
    );
    expect(timeline.map((activation) => activation.cardId)).toEqual([
      "usage-2026-09-07-v1",
      "usage-2026-12-v1",
      "usage-2026-09-07-v1",
    ]);
  });

  it("adds a priced feature: a meter without an activation is unpriced, from its activation it bills", async () => {
    const charge = {
      organizationId: "o",
      projectId: "p",
      environmentId: "e",
      meter: "ai.tokens",
      unit: "token",
      quantity: 5000n,
    };
    const at = "2027-01-01T05:00:00.000Z";
    const price = async () => {
      const cards = ratesToCards(await credit.readRates({ at }), at);
      return organizationLines([charge], cards, at);
    };
    expect((await price()).unpriced).toEqual(["ai.tokens"]);

    await publish({
      id: "ai-tokens-2027-01-v1",
      effective_from: "2027-01-01T00:00:00Z",
      rates: [rate("ai.tokens", "token", "1000", "5", "12")],
    });
    // published, still not billed
    expect((await price()).unpriced).toEqual(["ai.tokens"]);
    await write(
      planActivate(
        await readState(control.core),
        {
          meter: "ai.tokens",
          cardId: "ai-tokens-2027-01-v1",
          startsAtMs: Date.parse("2027-01-01T00:00:00.000Z"),
        },
        NOW,
      ),
    );
    const billed = await price();
    expect(billed.unpriced).toEqual([]);
    expect(billed.byOrganization.get("o")).toEqual([
      expect.objectContaining({
        meter: "ai.tokens",
        rateCardId: "ai-tokens-2027-01-v1",
        chargeMicros: 60,
      }),
    ]);
  });

  it("refuses in the Core a plan that the Core has outgrown, and takes an applied plan again as done", async () => {
    // two cards for the CPU meter; the plan for the earlier one is made first
    for (const [id, effective, credits] of [
      ["usage-2027-06-v1", "2027-06-01T00:00:00Z", "50000000"],
      ["usage-2027-09-v1", "2027-09-01T00:00:00Z", "55000000"],
    ] as const)
      await publish({
        id,
        effective_from: effective,
        rates: [rate("wfp.cpu", "cpu_ms", "7000000", "140000", credits)],
      });
    const activate = async (cardId: string, startsAt: string) =>
      planActivate(
        await readState(control.core),
        { meter: "wfp.cpu", cardId, startsAtMs: Date.parse(startsAt) },
        NOW,
      );
    const early = await activate("usage-2027-06-v1", "2027-06-01T00:00:00Z");
    const late = await activate("usage-2027-09-v1", "2027-09-01T00:00:00Z");
    await write(late);
    // the Core refuses to put an activation into the past of a later one, and nothing of the plan stays behind
    await expect(write(early)).rejects.toThrow("CREDIT_PRICES_WRITE_REFUSED");
    expect(
      (await readState(control.core)).activations.filter(
        (activation) => activation.meter === "wfp.cpu" && activation.cardId === "usage-2027-06-v1",
      ),
    ).toEqual([]);
    // the same plan again (a lost reply that is retried) finds its rows and is done
    await expect(write(late)).resolves.toBeDefined();
    // a published card is never rewritten
    const published = await readState(control.core);
    expect(() =>
      planPublish(
        published,
        parseRateCard(JSON.stringify({ ...DECEMBER, id: "usage-2027-06-v1" })),
        NOW,
      ),
    ).toThrow("CREDIT_PRICES_CARD_CONFLICT");
  });
});

describe("the mail follows the activation timeline", () => {
  let mail: TestControl;
  beforeAll(async () => {
    mail = await createTestControl();
    await publishMailPricing(mail, "2026-10-01T00:00:00.000Z");
  }, 120_000);
  afterAll(async () => mail.dispose());

  const priceAt = async (
    db: TestControl["core"],
    meter: "mail.sent" | "mail.received",
    at: string,
  ) => {
    const row = await db
      .prepare(`SELECT ${mailPriceSql(meter, "?1")} AS price`)
      .bind(at)
      .first<{ price: string | null }>();
    const price = row?.price ?? null;
    return price === null ? null : (JSON.parse(price) as MailPrice);
  };

  it("charges the card of the latest activation that started and ignores a newer card that none names", async () => {
    // the card of 22 September is activated for both meters; mail.sent costs 0.18 credits per recipient
    const before = await priceAt(mail.core, "mail.sent", "2026-11-15T00:00:00.000000Z");
    expect(before?.card).toBe("resend-2026-09-22-v1");
    expect(mailChargeMicros(before?.rate as MailPrice["rate"])).toBe(180_000);
    expect(await priceAt(mail.core, "mail.sent", "2026-09-30T00:00:00.000000Z")).toBeNull();

    // a dearer card exists and is even in effect, but no activation names it: the price does not move
    const state = await readState(mail.core);
    await applyPlan(
      mail.core,
      planPublish(
        state,
        parseRateCard(
          JSON.stringify({
            id: "resend-2026-12-v1",
            effective_from: NEW_AT,
            rates: [
              rate("mail.sent", "recipient", "1", "900", "200000"),
              rate("mail.received", "message", "1", "900", "200000"),
            ],
          }),
        ),
        NOW,
      ),
    );
    expect((await priceAt(mail.core, "mail.sent", "2027-01-01T00:00:00.000000Z"))?.card).toBe(
      "resend-2026-09-22-v1",
    );

    // activated for mail.sent only: from its start the new card prices sends, receipts keep the old price
    await applyPlan(
      mail.core,
      planActivate(
        await readState(mail.core),
        { meter: "mail.sent", cardId: "resend-2026-12-v1", startsAtMs: Date.parse(NEW_AT) },
        NOW,
      ),
    );
    const sent = (at: string) => priceAt(mail.core, "mail.sent", at);
    expect((await sent("2026-11-30T23:59:59.999999Z"))?.card).toBe("resend-2026-09-22-v1");
    const after = await sent("2026-12-01T00:00:00.000000Z");
    expect(after?.card).toBe("resend-2026-12-v1");
    expect(mailChargeMicros(after?.rate as MailPrice["rate"])).toBe(200_000);
    expect((await priceAt(mail.core, "mail.received", "2027-01-01T00:00:00.000000Z"))?.card).toBe(
      "resend-2026-09-22-v1",
    );
  });

  it("still admits receiving when the receiving meter has several activations", async () => {
    const store = createControlStore(mail.bindings);
    const rig = await seedMailRig(mail);
    await fundOrganization(mail, rig.scope.organizationId, rig.now);
    await store.mailManagement.admitReceiving({ ...rig.scope, now: rig.now });
    const later = "2027-01-01T00:00:00.000Z";
    await applyPlan(
      mail.core,
      planActivate(
        await readState(mail.core),
        { meter: "mail.received", cardId: "resend-2026-12-v1", startsAtMs: Date.parse(NEW_AT) },
        NOW,
      ),
    );
    const activations = await mail.core
      .prepare("SELECT count(*) AS n FROM usage_meter_activations WHERE meter = 'mail.received'")
      .first<{ n: number }>();
    expect(activations?.n).toBe(2);
    await store.mailManagement.admitReceiving({ ...rig.scope, now: later });
    // without any started activation of the meter, receiving stays unavailable
    await expect(
      store.mailManagement.admitReceiving({ ...rig.scope, now: "2026-09-01T00:00:00.000Z" }),
    ).rejects.toThrow("mail_pricing_unavailable");
  });
});
