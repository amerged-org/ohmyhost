import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { priceLine, ratesToCards } from "../apps/credit-service/dist/pricing.js";
import { parsePriceArguments, runPrices } from "../scripts/credit-prices.mjs";
import {
  KNOWN_METERS,
  applyPlan,
  decimal,
  describeRate,
  parseRateCard,
  percentChange,
  planActivate,
  planSwitch,
  readState,
  renderState,
} from "../scripts/credit-prices-model.mjs";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const accountId = "a".repeat(32);
const databaseId = "22222222-2222-4222-8222-222222222222";
/** 2026-10-30 09:20:00 UTC: every instant of these tests is relative to this clock. */
const NOW = Date.parse("2026-10-30T09:20:00.000Z");
const stored = (iso) => `${iso.slice(0, 19)}.000000Z`;

/** The Cloudflare D1 API answering the fixed Core's lookup by name, exactly as the operator tests do. */
const provider =
  (environment) =>
  async ({ path }) => {
    const database = {
      uuid: databaseId,
      name: `ohmyho-control-core-${environment}`,
      jurisdiction: "eu",
      read_replication: { mode: "disabled" },
    };
    return { result: path.includes("?name=") ? [database] : database };
  };

/** A D1 binding over a real SQLite database: prepare/bind/all/run and an all-or-nothing batch. */
function d1(sqlite) {
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({
      results: sqlite
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row })),
    }),
    run: async () => {
      sqlite.prepare(sql).run(...params);
      return { success: true };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const entry of statements) results.push(await entry.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const migration = (name) =>
  readFile(join(SOURCE, "apps/control-store/migrations/core", name), "utf8");

/** The two price tables exactly as the checked-in Core migrations create them (0251, the card trigger of 0331, 0602). */
async function priceSchema(sqlite, { timeline = true } = {}) {
  sqlite.exec(await migration("0251_rate_cards.sql"));
  const released = (await migration("0331_released_price_constraints.sql")).match(
    /CREATE TRIGGER published_credit_rate_cards_released_shape[\s\S]*?END;/u,
  );
  sqlite.exec(String(released?.[0]));
  if (timeline) sqlite.exec(await migration("0602_meter_activation_timeline.sql"));
}

const rate = (meter, unit, units, provider, credits) => ({
  meter,
  unit,
  units_per_charge: units,
  provider_cost_micros: provider,
  credit_micros: credits,
});
/** The live price list as of 30 October 2026, in the Core's stored form. */
const CARDS = {
  "usage-2026-09-07-v1": [
    rate("wfp.requests", "request", "7000000", "2100000", "690000000"),
    rate("wfp.cpu", "cpu_ms", "7000000", "140000", "46000000"),
    rate("neon.branches", "branch_hour", "5208", "10500000", "3450000000"),
  ],
  "resend-2026-09-22-v1": [
    rate("mail.sent", "recipient", "1", "900", "180000"),
    rate("mail.received", "message", "1", "900", "180000"),
  ],
  "pgcf-memory-2026-10-26-v1": [
    rate("pgcf.memory.active", "memory_mib_milliseconds", "2304", null, "25"),
  ],
};
const ISSUED = [
  ["usage-2026-09-07-v1", "2026-09-07T00:00:00Z"],
  ["resend-2026-09-22-v1", "2026-09-22T00:00:00Z"],
  ["pgcf-memory-2026-10-26-v1", "2026-10-26T00:00:00Z"],
];

function seed(sqlite) {
  for (const [id, effective] of ISSUED) {
    sqlite
      .prepare(
        "INSERT INTO published_credit_rate_cards(rate_card_id, published_at, effective_from, rates) VALUES (?, ?, ?, ?)",
      )
      .run(id, stored(effective), stored(effective), JSON.stringify(CARDS[id]));
  }
  for (const [meter, card, at] of [
    ["wfp.requests", "usage-2026-09-07-v1", "2026-09-07T00:00:00Z"],
    ["wfp.cpu", "usage-2026-09-07-v1", "2026-09-07T00:00:00Z"],
    ["mail.sent", "resend-2026-09-22-v1", "2026-09-22T00:00:00Z"],
    ["mail.received", "resend-2026-09-22-v1", "2026-09-22T00:00:00Z"],
  ])
    sqlite
      .prepare(
        "INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at) VALUES (?, ?, ?, ?)",
      )
      .run(meter, card, stored(at), stored(at));
}

const cardFile = (card) => JSON.stringify(card, null, 2);
/** A valid new price list for `wfp.requests` and `wfp.cpu`: 10 % dearer requests, the same CPU. */
const NEW_USAGE = {
  id: "usage-2026-12-v1",
  effective_from: "2026-12-01T00:00:00Z",
  rates: [
    rate("wfp.requests", "request", "7000000", "2100000", "759000000"),
    rate("wfp.cpu", "cpu_ms", "7000000", "140000", "46000000"),
  ],
};

async function harness(context, environment = "development") {
  const root = await mkdtemp(join(tmpdir(), "omh-credit-prices-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "source");
  const custody = join(root, "custody");
  await mkdir(join(repositoryRoot, "apps/control-store/src"), { recursive: true });
  await mkdir(custody, { mode: 0o700 });
  await chmod(custody, 0o700);
  await writeFile(
    join(repositoryRoot, "apps/control-store/wrangler.jsonc"),
    await readFile(join(SOURCE, "apps/control-store/wrangler.jsonc")),
  );
  await writeFile(
    join(repositoryRoot, "apps/control-store/src/worker-main.ts"),
    "export default {};\n",
  );
  const sqlite = new DatabaseSync(":memory:");
  await priceSchema(sqlite);
  seed(sqlite);
  const sessions = [];
  let clock = 0;
  const open = async (input) => {
    sessions.push({ upgrade: input.upgrade, environment: input.contract.environment });
    return { proof: {}, db: d1(sqlite), dispose: async () => sessions.push("disposed") };
  };
  const run = (command, extra = {}) =>
    runPrices(
      { accountId, environment, custody, repositoryRoot, command, ...extra },
      {
        request: provider(environment),
        inspect: async () => ({ repositoryRoot, sha: "b".repeat(40) }),
        inspectRelease: async ({ cwd }) => {
          assert.equal(cwd, repositoryRoot);
          return { repositoryRoot, sha: "b".repeat(40) };
        },
        verifyCommit: async ({ sha, existingOnly }) => {
          assert.equal(sha, "b".repeat(40));
          assert.equal(existingOnly, true);
        },
        open,
        // Every session names its own packet directory by the second, so each call is a later second.
        now: () => new Date(NOW + 1000 * (clock += 1)),
      },
    );
  const cards = () =>
    sqlite
      .prepare(
        "SELECT rate_card_id, published_at, effective_from FROM published_credit_rate_cards ORDER BY effective_from",
      )
      .all()
      .map((row) => ({ ...row }));
  const activations = (meter) =>
    sqlite
      .prepare(
        "SELECT meter, rate_card_id, starts_at, activated_at FROM usage_meter_activations WHERE meter = ? ORDER BY starts_at",
      )
      .all(meter)
      .map((row) => ({ ...row }));
  const write = async (name, content) => {
    const path = join(root, name);
    await writeFile(path, content, { mode: 0o600 });
    return path;
  };
  return { custody, sqlite, sessions, run, cards, activations, write, root };
}

const code = (expected) => (error) => {
  assert.equal(error.message, expected, `${error.message} ${error.detail ?? ""}`);
  return true;
};

test("a card file is read strictly and priced by the credit service's own conversion", () => {
  const card = parseRateCard(cardFile(NEW_USAGE));
  assert.equal(card.id, "usage-2026-12-v1");
  assert.equal(card.effectiveFrom, "2026-12-01T00:00:00.000000Z");
  assert.deepEqual(Object.keys(card.rates[0]), [
    "meter",
    "unit",
    "units_per_charge",
    "provider_cost_micros",
    "credit_micros",
  ]);
  // a rate may leave the provider cost unallocated, and a new meter needs no registration
  const free = parseRateCard(
    cardFile({
      id: "feature-v1",
      effective_from: "2026-12-01T00:00:00.000Z",
      rates: [rate("ai.tokens", "token", "1000", null, "0")],
    }),
  );
  assert.equal(free.rates[0].provider_cost_micros, null);

  const bad = (patch, expected) => {
    const document =
      typeof patch === "function" ? patch(JSON.parse(JSON.stringify(NEW_USAGE))) : patch;
    assert.throws(
      () => parseRateCard(typeof document === "string" ? document : cardFile(document)),
      code(expected),
      JSON.stringify(document).slice(0, 120),
    );
  };
  bad("{", "CREDIT_PRICES_CARD_JSON");
  bad("[]", "CREDIT_PRICES_CARD_SHAPE");
  bad((d) => ({ ...d, extra: 1 }), "CREDIT_PRICES_CARD_SHAPE");
  bad(
    (d) => Object.fromEntries(Object.entries(d).filter(([key]) => key !== "id")),
    "CREDIT_PRICES_CARD_SHAPE",
  );
  bad((d) => ({ ...d, id: "Bad Id" }), "CREDIT_PRICES_CARD_SHAPE");
  bad((d) => ({ ...d, rates: [] }), "CREDIT_PRICES_CARD_SHAPE");
  bad(
    (d) => ({
      ...d,
      rates: Array.from({ length: 33 }, (_, i) => rate(`m${String(i)}`, "u", "1", null, "1")),
    }),
    "CREDIT_PRICES_CARD_SHAPE",
  );
  bad((d) => ({ ...d, rates: [{ ...d.rates[0], extra: "x" }] }), "CREDIT_PRICES_CARD_SHAPE");
  bad(
    (d) => ({ ...d, rates: [{ ...d.rates[0], meter: "Wfp.Requests" }] }),
    "CREDIT_PRICES_CARD_SHAPE",
  );
  bad((d) => ({ ...d, rates: [{ ...d.rates[0], unit: "" }] }), "CREDIT_PRICES_CARD_SHAPE");
  bad((d) => ({ ...d, rates: [d.rates[0], d.rates[0]] }), "CREDIT_PRICES_DUPLICATE_METER");
  // amounts are decimal strings of whole micro-units: no JSON numbers, no fractions, no signs, no leading zeros
  for (const value of [690000000, "6.9", "-1", "01", "", "1e9", null, "9223372036854775808"])
    bad(
      (d) => ({ ...d, rates: [{ ...d.rates[0], credit_micros: value }] }),
      "CREDIT_PRICES_CARD_SHAPE",
    );
  bad(
    (d) => ({ ...d, rates: [{ ...d.rates[0], provider_cost_micros: 7 }] }),
    "CREDIT_PRICES_CARD_SHAPE",
  );
  bad(
    (d) => ({ ...d, rates: [{ ...d.rates[0], units_per_charge: "0" }] }),
    "CREDIT_PRICES_RATE_INVALID",
  );
  // a charge the service cannot hold in a JavaScript safe integer is refused with the service's reason
  bad(
    (d) => ({ ...d, rates: [{ ...d.rates[0], credit_micros: "9007199254740993" }] }),
    "CREDIT_PRICES_RATE_INVALID",
  );
  // effective_from: a UTC hour boundary only
  for (const value of [
    "2026-12-01",
    "2026-12-01T00:30:00Z",
    "2026-12-01T00:00:00+02:00",
    "2026-12-01T00:00:00.5Z",
    "2026-02-30T00:00:00Z",
    "2026-12-01T24:00:00Z",
    5,
    null,
  ])
    bad((d) => ({ ...d, effective_from: value }), "CREDIT_PRICES_INSTANT");
  // a known meter in another unit would stay unpriced by the credit service
  bad(
    (d) => ({ ...d, rates: [{ ...d.rates[0], unit: "requests" }] }),
    "CREDIT_PRICES_UNIT_MISMATCH",
  );
});

test("the AI meter is priced in usd_micro: its card rate is accepted and a malformed one refused", () => {
  const aiCard = (rateEntry) =>
    JSON.stringify({
      id: "ai-orq-2026-11-v1",
      effective_from: "2026-12-01T00:00:00Z",
      rates: [rateEntry],
    });
  // orq cost x 1.045 (orq credit fee) x 1.10 (margin) x 1.21 (owner surcharge) = 1.390895: 1390895 credit micros per 10000 USD micros
  const good = {
    meter: "ai.cost",
    unit: "usd_micro",
    units_per_charge: "10000",
    provider_cost_micros: null,
    credit_micros: "1390895",
  };
  const card = parseRateCard(aiCard(good));
  assert.deepEqual(card.rates, [
    {
      meter: "ai.cost",
      unit: "usd_micro",
      units_per_charge: "10000",
      provider_cost_micros: null,
      credit_micros: "1390895",
    },
  ]);
  assert.equal(KNOWN_METERS["ai.cost"].unit, "usd_micro");

  const refused = (rateEntry, expected) =>
    assert.throws(
      () => parseRateCard(aiCard(rateEntry)),
      code(expected),
      JSON.stringify(rateEntry),
    );
  refused({ ...good, unit: "usd" }, "CREDIT_PRICES_UNIT_MISMATCH");
  refused({ ...good, units_per_charge: "0" }, "CREDIT_PRICES_RATE_INVALID");
  refused({ ...good, units_per_charge: 10000 }, "CREDIT_PRICES_CARD_SHAPE");
  refused({ ...good, credit_micros: "1390895.5" }, "CREDIT_PRICES_CARD_SHAPE");
  refused({ ...good, credit_micros: "-1390895" }, "CREDIT_PRICES_CARD_SHAPE");
  refused({ ...good, credit_micros: null }, "CREDIT_PRICES_CARD_SHAPE");
  refused({ ...good, provider_cost_micros: 20 }, "CREDIT_PRICES_CARD_SHAPE");
  refused({ ...good, price: "2299" }, "CREDIT_PRICES_CARD_SHAPE");
  refused(
    Object.fromEntries(Object.entries(good).filter(([key]) => key !== "credit_micros")),
    "CREDIT_PRICES_CARD_SHAPE",
  );
});

test("the AI price in the contract is the card the code prices: 1.045 x 1.10 x 1.21 = 1.390895", async () => {
  // Exact factor of the owner's decision: 1045 x 110 x 121 / 10^7 = 1390895 / 10^6.
  assert.equal(1045n * 110n * 121n * 10n ** 6n, 1_390_895n * 10n ** 7n);
  const contract = await readFile(join(SOURCE, "docs/architecture/pricing-contract.md"), "utf8");
  const section = contract.split("\n## AI usage\n")[1]?.split("\n## ")[0] ?? "";
  assert.match(section, /1\.390895/u);
  assert.match(section, /1,390,895 microcredits per 10,000 USD micro-units/u);
  assert.match(section, /1\.21/u);
  assert.doesNotMatch(section, /1\.1495|2,299/u);
  // A cost of 3,600 nano-USD (3.6 USD micros) is charged 501 microcredits, the worked example of the contract.
  assert.match(section, /3\.6 USD micro-units[^\n]*501 microcredits/u);
  assert.equal(Number((3_600n * 1_390_895n + 9_999_999n) / 10_000_000n), 501);

  const money = await readFile(
    join(SOURCE, "packages/platform/src/shared/ai-money.test.ts"),
    "utf8",
  );
  assert.match(money, /unitsPerCharge: 10_000n, creditMicros: 1_390_895n/u);

  // The card the contract states, priced by the credit service's own conversion.
  const card = parseRateCard(
    JSON.stringify({
      id: "ai-orq-2026-11-v1",
      effective_from: "2026-12-01T00:00:00Z",
      rates: [
        {
          meter: "ai.cost",
          unit: "usd_micro",
          units_per_charge: "10000",
          provider_cost_micros: null,
          credit_micros: "1390895",
        },
      ],
    }),
  );
  const at = "2026-12-01T00:00:00.000Z";
  const cards = ratesToCards([{ rateCardId: card.id, rates: card.rates }], at);
  const line = (quantity) =>
    priceLine(cards, at, {
      organizationId: "o",
      projectId: "p",
      environmentId: "e",
      meter: "ai.cost",
      unit: "usd_micro",
      quantity,
    })?.chargeMicros;
  assert.equal(line(10_000n), 1_390_895);
  assert.equal(line(20n), 2_782);
});

test("a rate without provider_cost_micros is refused: only the explicit null means unallocated", () => {
  const withoutProviderCost = JSON.stringify({
    id: "usage-2026-12-v1",
    effective_from: "2026-12-01T00:00:00Z",
    rates: [
      {
        meter: "wfp.requests",
        unit: "request",
        units_per_charge: "7000000",
        credit_micros: "690000000",
      },
    ],
  });
  assert.throws(
    () => parseRateCard(withoutProviderCost),
    (error) => {
      assert.equal(error.message, "CREDIT_PRICES_CARD_SHAPE");
      assert.match(error.detail, /provider_cost_micros is missing/u);
      return true;
    },
  );
});

test("the card file of the runbook is a valid card", async () => {
  const chapter = await readFile(join(SOURCE, "docs/architecture/billing-and-pricing.md"), "utf8");
  const example = chapter
    .split("## Changing prices and adding priced features")[1]
    ?.match(/```json\n([\s\S]*?)```/u);
  assert.ok(example, "the chapter shows a card file");
  const card = parseRateCard(String(example[1]));
  assert.equal(card.id, "pgcf-memory-2027-01-v1");
  assert.equal(card.rates[0].meter, "pgcf.memory.active");
});

test("prices and their change are exact integer arithmetic", () => {
  assert.equal(decimal(690000000n, 1000000n, 6), "690");
  assert.equal(decimal(1n, 3n, 6), "0.333333");
  assert.equal(decimal(2n, 3n, 6), "0.666667");
  assert.equal(decimal(0n, 7n, 6), "0");
  const requests = CARDS["usage-2026-09-07-v1"][0];
  assert.deepEqual(describeRate(requests), {
    perCharge: "690 credits per 7000000 request",
    perUnit: "0.000098571428571 credits per request",
  });
  assert.deepEqual(describeRate(CARDS["pgcf-memory-2026-10-26-v1"][0]), {
    perCharge: "0.000025 credits per 2304 memory_mib_milliseconds",
    perUnit: "0.000000010850694 credits per memory_mib_milliseconds",
  });
  assert.equal(percentChange(requests, { ...requests, credit_micros: "759000000" }), "+10.00%");
  assert.equal(percentChange(requests, { ...requests, credit_micros: "655500000" }), "-5.00%");
  assert.equal(percentChange(requests, requests), "0.00%");
  // the same price per unit written with another charge size is no change
  assert.equal(
    percentChange(requests, {
      ...requests,
      units_per_charge: "14000000",
      credit_micros: "1380000000",
    }),
    "0.00%",
  );
  assert.equal(percentChange(requests, { ...requests, credit_micros: "1" }), "-100.00%");
  assert.equal(
    percentChange({ ...requests, credit_micros: "0" }, requests),
    "new price (was free)",
  );
  assert.equal(
    percentChange({ ...requests, credit_micros: "0" }, { ...requests, credit_micros: "0" }),
    "0.00%",
  );
  assert.equal(
    percentChange({ ...requests, credit_micros: "3" }, { ...requests, credit_micros: "4" }),
    "+33.33%",
  );
});

test("list prints the cards, every meter's timeline and its current price", async (context) => {
  const h = await harness(context);
  h.sqlite.exec(`
    INSERT INTO published_credit_rate_cards VALUES ('usage-2026-11-v1','2026-10-01T00:00:00.000000Z','2026-11-01T00:00:00.000000Z','${JSON.stringify(NEW_USAGE.rates)}');
    INSERT INTO published_credit_rate_cards VALUES ('usage-2026-12-v1','2026-10-30T08:00:00.000000Z','2026-12-01T00:00:00.000000Z','${JSON.stringify(NEW_USAGE.rates)}');
    INSERT INTO usage_meter_activations VALUES ('wfp.requests','usage-2026-11-v1','2026-11-01T00:00:00.000000Z','2026-10-01T00:00:00.000000Z');
    INSERT INTO usage_meter_activations VALUES ('wfp.requests','usage-2026-12-v1','2026-12-01T00:00:00.000000Z','2026-10-30T08:00:00.000000Z');`);
  const result = await h.run("list");
  assert.equal(result.applied, false);
  const lines = result.text.split("\n");
  assert.ok(lines.includes("Cards (5), by effective time"));
  assert.ok(
    lines.includes(
      "  pgcf-memory-2026-10-26-v1  published 2026-10-26T00:00:00.000Z  effective 2026-10-26T00:00:00.000Z  1 rates",
    ),
  );
  // 30 October: the September card is in force, November started nothing yet (it is pending too), December is pending
  const at = lines.findIndex((line) => line.startsWith("  wfp.requests  "));
  assert.equal(
    lines[at],
    "  wfp.requests  unit request  current 0.000098571428571 credits per request (690 credits per 7000000 request)",
  );
  assert.deepEqual(lines.slice(at + 1, at + 4), [
    "    from 2026-09-07T00:00:00.000Z -> usage-2026-09-07-v1  690 credits per 7000000 request  [in force]",
    "    from 2026-11-01T00:00:00.000Z -> usage-2026-11-v1  759 credits per 7000000 request  [pending]",
    "    from 2026-12-01T00:00:00.000Z -> usage-2026-12-v1  759 credits per 7000000 request  [pending]",
  ]);
  assert.ok(
    lines.includes(
      "Rated on a card but never activated (billed nothing, reported as unpriced): neon.branches, pgcf.memory.active",
    ),
  );
  assert.deepEqual(h.sessions, [{ upgrade: true, environment: "development" }, "disposed"]);
  // read only: no row changed, no journal written
  assert.equal(h.cards().length, 5);
  await assert.rejects(stat(join(h.custody, "credit-prices-development.json")), { code: "ENOENT" });
  // later in time the November card is in force and the September card is superseded
  const later = renderState(await readState(d1(h.sqlite)), Date.parse("2026-11-15T00:00:00Z"));
  assert.match(later, /usage-2026-09-07-v1 {2}690 credits per 7000000 request {2}\[superseded\]/u);
  assert.match(later, /usage-2026-11-v1 {2}759 credits per 7000000 request {2}\[in force\]/u);
});

test("publish shows the price difference first, writes only with --apply and journals the write", async (context) => {
  const h = await harness(context);
  const file = await h.write("usage.json", cardFile(NEW_USAGE));
  const dry = await h.run("publish", { cardFile: file });
  assert.equal(dry.applied, false);
  assert.match(dry.text, /^development: publish card usage-2026-12-v1$/mu);
  assert.match(
    dry.text,
    /old: {4}690 credits per 7000000 request .* on usage-2026-09-07-v1 since 2026-09-07T00:00:00\.000Z/u,
  );
  assert.match(dry.text, /new: {4}759 credits per 7000000 request/u);
  assert.match(dry.text, /change: \+10\.00%/u);
  assert.match(dry.text, /change: 0\.00%/u);
  assert.match(
    dry.text,
    /note: wfp\.requests keeps its current price until an activation of this card starts/u,
  );
  assert.match(dry.text, /Dry run: nothing written\. Add --apply/u);
  assert.equal(h.cards().length, 3);

  const applied = await h.run("publish", { cardFile: file, apply: true });
  assert.equal(applied.applied, true);
  const published = h.cards().at(-1);
  assert.deepEqual(
    [published.rate_card_id, published.effective_from],
    ["usage-2026-12-v1", "2026-12-01T00:00:00.000000Z"],
  );
  // published at the tool's clock (30 October, a few seconds after 09:20), effective at the card's hour
  assert.match(published.published_at, /^2026-10-30T09:20:\d\d\.000000Z$/u);
  const row = h.sqlite
    .prepare(
      "SELECT rates FROM published_credit_rate_cards WHERE rate_card_id = 'usage-2026-12-v1'",
    )
    .get();
  assert.deepEqual(JSON.parse(row.rates), NEW_USAGE.rates);
  // publishing alone starts no billing: the activation timeline is untouched
  assert.equal(h.activations("wfp.requests").length, 1);

  // the journal names what and when, in a private file, and nothing else
  const path = join(h.custody, "credit-prices-development.json");
  assert.equal((await stat(path)).mode & 0o077, 0);
  const journal = JSON.parse(await readFile(path, "utf8"));
  assert.equal(journal.schemaVersion, "omh.credit-prices/v1");
  assert.equal(journal.entries.length, 1);
  assert.deepEqual(
    Object.keys(journal.entries[0]).sort(),
    [
      "at",
      "cardId",
      "command",
      "digest",
      "effectiveFrom",
      "id",
      "meters",
      "publishedAt",
      "readBack",
      "startsAt",
      "status",
    ].sort(),
  );
  assert.equal(journal.entries[0].status, "applied");
  assert.equal(journal.entries[0].readBack, true);
  assert.ok(
    !JSON.stringify(journal).includes(accountId) && !JSON.stringify(journal).includes(databaseId),
  );
});

test("publish is idempotent for identical content and refuses a changed card", async (context) => {
  const h = await harness(context);
  const file = await h.write("usage.json", cardFile(NEW_USAGE));
  await h.run("publish", { cardFile: file, apply: true });
  const again = await h.run("publish", { cardFile: file, apply: true });
  assert.equal(again.unchanged, true);
  assert.match(again.text, /already published with this content, nothing to write/u);
  assert.equal(h.cards().length, 4);
  // key order and whitespace do not make a card different
  const reordered = await h.write(
    "reordered.json",
    JSON.stringify({
      rates: NEW_USAGE.rates.map((r) => Object.fromEntries(Object.entries(r).reverse())),
      effective_from: "2026-12-01T00:00:00.000Z",
      id: NEW_USAGE.id,
    }),
  );
  assert.equal((await h.run("publish", { cardFile: reordered, apply: true })).unchanged, true);
  // another price, another effective time or another rate under the same id is a conflict and writes nothing
  for (const changed of [
    {
      ...NEW_USAGE,
      rates: [{ ...NEW_USAGE.rates[0], credit_micros: "760000000" }, NEW_USAGE.rates[1]],
    },
    { ...NEW_USAGE, effective_from: "2026-12-01T01:00:00Z" },
    { ...NEW_USAGE, rates: [NEW_USAGE.rates[0]] },
  ])
    await assert.rejects(
      h.run("publish", { cardFile: await h.write("changed.json", cardFile(changed)), apply: true }),
      code("CREDIT_PRICES_CARD_CONFLICT"),
    );
  assert.equal(h.cards().length, 4);
  assert.deepEqual(
    JSON.parse(
      h.sqlite
        .prepare(
          "SELECT rates FROM published_credit_rate_cards WHERE rate_card_id = 'usage-2026-12-v1'",
        )
        .get().rates,
    ),
    NEW_USAGE.rates,
  );
  // an old, identical card replays as unchanged even though its effective time is long past
  const old = await h.write(
    "old.json",
    cardFile({
      id: "usage-2026-09-07-v1",
      effective_from: "2026-09-07T00:00:00Z",
      rates: CARDS["usage-2026-09-07-v1"],
    }),
  );
  assert.equal((await h.run("publish", { cardFile: old, apply: true })).unchanged, true);
});

test("publish never applies a price retroactively and keeps one card per effective time and a meter's unit", async (context) => {
  const h = await harness(context);
  const publish = async (patch) =>
    h.run("publish", {
      cardFile: await h.write("card.json", cardFile({ ...NEW_USAGE, ...patch })),
      apply: true,
    });
  // now is 09:20: the next hour boundary is 40 minutes away, one hour of notice needs 11:00
  await assert.rejects(
    publish({ effective_from: "2026-10-30T09:00:00Z" }),
    code("CREDIT_PRICES_RETROACTIVE"),
  );
  await assert.rejects(
    publish({ effective_from: "2026-10-30T10:00:00Z" }),
    code("CREDIT_PRICES_RETROACTIVE"),
  );
  await assert.rejects(
    publish({ effective_from: "2026-10-29T00:00:00Z" }),
    code("CREDIT_PRICES_RETROACTIVE"),
  );
  await assert.rejects(
    publish({ effective_from: "2026-10-30T09:30:00Z" }),
    code("CREDIT_PRICES_INSTANT"),
  );
  assert.equal(h.cards().length, 3);
  await publish({ effective_from: "2026-10-30T11:00:00Z" });
  assert.equal(h.cards().length, 4);
  // two cards never take effect at the same instant
  await assert.rejects(
    publish({ id: "usage-other-v1", effective_from: "2026-10-30T11:00:00Z" }),
    code("CREDIT_PRICES_EFFECTIVE_TAKEN"),
  );
  // the unit of an activated meter stays, because the posting code keeps it: another unit needs a new meter name
  h.sqlite
    .exec(`INSERT INTO published_credit_rate_cards VALUES ('custom-v1','2026-10-01T00:00:00.000000Z','2026-10-02T00:00:00.000000Z','${JSON.stringify([rate("custom.meter", "unit_a", "1", null, "1")])}');
    INSERT INTO usage_meter_activations VALUES ('custom.meter','custom-v1','2026-10-02T00:00:00.000000Z','2026-10-01T00:00:00.000000Z');`);
  const custom = (unit, id = "custom-v2") => ({
    id,
    effective_from: "2027-01-01T00:00:00Z",
    rates: [rate("custom.meter", unit, "1", null, "2")],
  });
  await assert.rejects(publish(custom("unit_b")), code("CREDIT_PRICES_UNIT_CHANGED"));
  await publish(custom("unit_a"));
  assert.equal(h.cards().length, 6);
  // a meter that was never activated may still choose its unit
  await publish({
    id: "branches-v1",
    effective_from: "2027-01-02T00:00:00Z",
    rates: [rate("neon.branches", "branch_day", "1", null, "5")],
  });
  assert.equal(h.cards().length, 7);
});

test("a card for a meter that nothing posts is allowed with a warning that the posting code must exist first", async (context) => {
  const h = await harness(context);
  const file = await h.write(
    "feature.json",
    cardFile({
      id: "ai-tokens-v1",
      effective_from: "2027-01-01T00:00:00Z",
      rates: [rate("ai.tokens", "token", "1000", "5", "10")],
    }),
  );
  const dry = await h.run("publish", { cardFile: file });
  assert.match(dry.text, /old: {4}no activation, nothing is billed today/u);
  assert.match(
    dry.text,
    /note: ai\.tokens has no activation: it bills nothing until activate or switch starts this card/u,
  );
  await h.run("publish", { cardFile: file, apply: true });
  const activation = await h.run("activate", {
    meter: "ai.tokens",
    cardId: "ai-tokens-v1",
    startsAt: "2027-01-01T00:00:00Z",
  });
  assert.match(
    activation.text,
    /note: ai\.tokens is not posted by any usage source or charge in this repository/u,
  );
});

test("a daily source says which day a start inside the day first prices", async (context) => {
  const h = await harness(context);
  const r2 = {
    id: "r2-2027-v1",
    effective_from: "2027-01-01T00:00:00Z",
    rates: [rate("r2.class_a", "request", "1000000", "4500000", "1478571429")],
  };
  await h.run("publish", { cardFile: await h.write("r2.json", cardFile(r2)), apply: true });
  const at = (startsAt) =>
    h.run("activate", { meter: "r2.class_a", cardId: "r2-2027-v1", startsAt });
  assert.match(
    (await at("2027-01-01T05:00:00Z")).text,
    /note: r2\.class_a is billed per finished UTC day and each day is priced by its start: this start first prices the day beginning 2027-01-02T00:00:00\.000Z/u,
  );
  assert.doesNotMatch((await at("2027-01-01T00:00:00Z")).text, /note:/u);
});

test("activate adds a prospective activation that supersedes the meter's earlier card from its start", async (context) => {
  const h = await harness(context);
  await h.run("publish", {
    cardFile: await h.write("usage.json", cardFile(NEW_USAGE)),
    apply: true,
  });
  const input = {
    meter: "wfp.requests",
    cardId: "usage-2026-12-v1",
    startsAt: "2026-12-01T00:00:00Z",
  };
  const dry = await h.run("activate", input);
  assert.match(
    dry.text,
    /^development: activate usage-2026-12-v1 from 2026-12-01T00:00:00\.000Z$/mu,
  );
  assert.match(dry.text, /change: \+10\.00%/u);
  assert.equal(h.activations("wfp.requests").length, 1);

  const applied = await h.run("activate", { ...input, apply: true });
  assert.equal(applied.applied, true);
  assert.deepEqual(
    h.activations("wfp.requests").map((r) => [r.rate_card_id, r.starts_at]),
    [
      ["usage-2026-09-07-v1", "2026-09-07T00:00:00.000000Z"],
      ["usage-2026-12-v1", "2026-12-01T00:00:00.000000Z"],
    ],
  );
  assert.equal(h.activations("wfp.requests")[1].activated_at.slice(0, 10), "2026-10-30");
  // wfp.cpu was not activated by this command
  assert.equal(h.activations("wfp.cpu").length, 1);
  // replay
  const again = await h.run("activate", { ...input, apply: true });
  assert.equal(again.unchanged, true);
  assert.equal(h.activations("wfp.requests").length, 2);
  const journal = JSON.parse(
    await readFile(join(h.custody, "credit-prices-development.json"), "utf8"),
  );
  assert.deepEqual(
    journal.entries.map((e) => [e.command, e.status]),
    [
      ["publish", "applied"],
      ["activate", "applied"],
    ],
  );
  assert.deepEqual(journal.entries[1].meters, ["wfp.requests"]);
});

test("activate refuses what would change history or fail the credit service", async (context) => {
  const h = await harness(context);
  await h.run("publish", {
    cardFile: await h.write("usage.json", cardFile(NEW_USAGE)),
    apply: true,
  });
  await h.run("publish", {
    cardFile: await h.write(
      "next.json",
      cardFile({ ...NEW_USAGE, id: "usage-2027-v1", effective_from: "2027-01-01T00:00:00Z" }),
    ),
    apply: true,
  });
  const activate = (patch) =>
    h.run("activate", {
      meter: "wfp.requests",
      cardId: "usage-2026-12-v1",
      startsAt: "2026-12-01T00:00:00Z",
      apply: true,
      ...patch,
    });
  await assert.rejects(
    activate({ startsAt: "2026-12-01T00:30:00Z" }),
    code("CREDIT_PRICES_INSTANT"),
  );
  await assert.rejects(activate({ startsAt: "2026-12-01" }), code("CREDIT_PRICES_INSTANT"));
  await assert.rejects(activate({ startsAt: undefined }), code("CREDIT_PRICES_INSTANT"));
  // today at 09:00 has passed, 10:00 is still before the card takes effect
  await assert.rejects(
    activate({ startsAt: "2026-10-30T09:00:00Z" }),
    code("CREDIT_PRICES_RETROACTIVE"),
  );
  await assert.rejects(
    activate({ startsAt: "2026-10-30T10:00:00Z" }),
    code("CREDIT_PRICES_BEFORE_EFFECTIVE"),
  );
  await assert.rejects(
    activate({ startsAt: "2026-11-30T00:00:00Z" }),
    code("CREDIT_PRICES_BEFORE_EFFECTIVE"),
  );
  await assert.rejects(activate({ cardId: "nope" }), code("CREDIT_PRICES_CARD_UNKNOWN"));
  await assert.rejects(activate({ meter: "mail.sent" }), code("CREDIT_PRICES_METER_NOT_ON_CARD"));
  assert.equal(h.activations("wfp.requests").length, 1);

  await activate({});
  await activate({ cardId: "usage-2027-v1", startsAt: "2027-01-01T00:00:00Z" });
  assert.deepEqual(
    h.activations("wfp.requests").map((row) => row.rate_card_id),
    ["usage-2026-09-07-v1", "usage-2026-12-v1", "usage-2027-v1"],
  );
  // an activation is never changed: another card at an instant that is taken is a conflict
  await assert.rejects(
    activate({ cardId: "usage-2027-v1" }),
    code("CREDIT_PRICES_ACTIVATION_CONFLICT"),
  );
  // and never inserted into the past of a later one
  await assert.rejects(
    activate({ startsAt: "2026-12-15T00:00:00Z" }),
    code("CREDIT_PRICES_ACTIVATION_LATER"),
  );
  // the card that already prices the meter last is no change, however late it is asked for
  const same = await activate({ cardId: "usage-2027-v1", startsAt: "2027-02-01T00:00:00Z" });
  assert.equal(same.unchanged, true);
  // a return to an older card is a new activation after the latest one
  const rollback = await activate({
    cardId: "usage-2026-09-07-v1",
    startsAt: "2027-03-01T00:00:00Z",
  });
  assert.equal(rollback.applied, true);
  assert.equal(h.activations("wfp.requests").length, 4);
  // a card that changes the unit of an activated meter, or gives a known meter a unit nothing posts, is refused
  // even when it was published before
  h.sqlite.exec(
    `INSERT INTO published_credit_rate_cards VALUES ('odd-v1','2026-10-30T09:00:00.000000Z','2027-04-01T00:00:00.000000Z','${JSON.stringify([rate("wfp.requests", "calls", "1", null, "1"), rate("pgcf.memory.active", "mib_ms", "1", null, "1")])}')`,
  );
  await assert.rejects(
    activate({ cardId: "odd-v1", startsAt: "2027-04-01T00:00:00Z" }),
    code("CREDIT_PRICES_UNIT_CHANGED"),
  );
  await assert.rejects(
    activate({ meter: "pgcf.memory.active", cardId: "odd-v1", startsAt: "2027-04-01T00:00:00Z" }),
    code("CREDIT_PRICES_UNIT_MISMATCH"),
  );
});

test("switch activates every meter of a card in one batch, leaving meters that already stand on it", async (context) => {
  const h = await harness(context);
  await h.run("publish", {
    cardFile: await h.write("usage.json", cardFile(NEW_USAGE)),
    apply: true,
  });
  const dry = await h.run("switch", {
    cardId: "usage-2026-12-v1",
    startsAt: "2026-12-01T00:00:00Z",
  });
  assert.match(dry.text, /^development: switch usage-2026-12-v1 from 2026-12-01T00:00:00\.000Z$/mu);
  assert.match(dry.text, /these 2 rows as one batch/u);
  assert.equal(h.activations("wfp.cpu").length, 1);
  await h.run("switch", {
    cardId: "usage-2026-12-v1",
    startsAt: "2026-12-01T00:00:00Z",
    apply: true,
  });
  assert.equal(h.activations("wfp.requests").length, 2);
  assert.equal(h.activations("wfp.cpu").length, 2);
  assert.equal(
    (
      await h.run("switch", {
        cardId: "usage-2026-12-v1",
        startsAt: "2026-12-01T00:00:00Z",
        apply: true,
      })
    ).unchanged,
    true,
  );

  // all or nothing: one meter that cannot move stops the whole switch before anything is written
  await h.run("publish", {
    cardFile: await h.write(
      "next.json",
      cardFile({ ...NEW_USAGE, id: "usage-2027-01-v1", effective_from: "2027-01-01T00:00:00Z" }),
    ),
    apply: true,
  });
  h.sqlite
    .exec(`INSERT INTO published_credit_rate_cards VALUES ('cpu-2027-03','2026-10-30T09:00:00.000000Z','2027-03-01T00:00:00.000000Z','${JSON.stringify([NEW_USAGE.rates[1]])}');
    INSERT INTO usage_meter_activations VALUES ('wfp.cpu','cpu-2027-03','2027-03-01T00:00:00.000000Z','2026-10-30T09:00:00.000000Z')`);
  await assert.rejects(
    h.run("switch", { cardId: "usage-2027-01-v1", startsAt: "2027-01-01T00:00:00Z", apply: true }),
    code("CREDIT_PRICES_ACTIVATION_LATER"),
  );
  assert.equal(h.activations("wfp.requests").length, 2);
});

test("the statements are atomic and guarded in the Core even when the state changed after it was read", async (context) => {
  const h = await harness(context);
  const db = d1(h.sqlite);
  const insertCard = (id, effective, rates) =>
    h.sqlite
      .prepare("INSERT INTO published_credit_rate_cards VALUES (?, ?, ?, ?)")
      .run(id, stored("2026-10-30T09:00:00Z"), stored(effective), JSON.stringify(rates));
  insertCard("usage-2026-12-v1", "2026-12-01T00:00:00Z", NEW_USAGE.rates);
  const startsAtMs = Date.parse("2026-12-01T00:00:00Z");

  // another writer activates wfp.cpu for a later start between the read and the write: the whole switch is refused
  const plan = planSwitch(await readState(db), { cardId: "usage-2026-12-v1", startsAtMs }, NOW);
  assert.equal(plan.writes.length, 2);
  insertCard("cpu-2027-03-v1", "2027-03-01T00:00:00Z", [NEW_USAGE.rates[1]]);
  h.sqlite.exec(
    "INSERT INTO usage_meter_activations VALUES ('wfp.cpu','cpu-2027-03-v1','2027-03-01T00:00:00.000000Z','2026-10-30T09:00:00.000000Z')",
  );
  await assert.rejects(applyPlan(db, plan), code("CREDIT_PRICES_WRITE_REFUSED"));
  assert.equal(
    h.activations("wfp.requests").length,
    1,
    "the first row of the batch is rolled back with the second",
  );

  // a lost reply: the batch committed but the answer threw, the read-back finds the rows and reports success
  const single = planActivate(
    await readState(db),
    { meter: "wfp.requests", cardId: "usage-2026-12-v1", startsAtMs },
    NOW,
  );
  const lost = {
    prepare: db.prepare,
    batch: async (statements) => {
      await db.batch(statements);
      throw new Error("reply lost");
    },
  };
  const after = await applyPlan(lost, single);
  assert.equal(after.activations.filter((row) => row.meter === "wfp.requests").length, 2);

  // the guard of the statement itself: a card that was never published, or that lacks the meter, writes nothing
  for (const [meter, card] of [
    ["wfp.requests", "missing"],
    ["mail.sent", "usage-2026-12-v1"],
  ])
    await assert.rejects(
      applyPlan(db, {
        ...single,
        writes: [
          {
            ...single.writes[0],
            params: [meter, card, "2027-06-01T00:00:00.000000Z", "2026-10-30T09:20:00.000000Z"],
          },
        ],
        expect: {
          cards: [],
          activations: [
            {
              meter,
              cardId: card,
              startsAt: "2027-06-01T00:00:00.000000Z",
              activatedAt: "2026-10-30T09:20:00.000000Z",
            },
          ],
        },
      }),
      code("CREDIT_PRICES_WRITE_REFUSED"),
    );
  // rows are never updated or deleted
  assert.throws(
    () => h.sqlite.exec("UPDATE usage_meter_activations SET starts_at = starts_at"),
    /append-only/u,
  );
  assert.throws(() => h.sqlite.exec("DELETE FROM usage_meter_activations"), /never deleted/u);
  assert.throws(
    () => h.sqlite.exec("UPDATE published_credit_rate_cards SET rates = rates"),
    /append-only/u,
  );
  assert.throws(() => h.sqlite.exec("DELETE FROM published_credit_rate_cards"), /never deleted/u);
});

test("migration 0602 keeps every activation and lets a meter be activated again", async () => {
  const sqlite = new DatabaseSync(":memory:");
  await priceSchema(sqlite, { timeline: false });
  seed(sqlite);
  // before: one row per meter, a second activation of wfp.requests is impossible
  assert.throws(
    () =>
      sqlite.exec(
        "INSERT INTO usage_meter_activations VALUES ('wfp.requests','usage-2026-09-07-v1','2026-12-01T00:00:00.000000Z','2026-10-30T00:00:00.000000Z')",
      ),
    /UNIQUE|PRIMARY/u,
  );
  const before = sqlite
    .prepare("SELECT * FROM usage_meter_activations ORDER BY meter, starts_at")
    .all()
    .map((r) => ({ ...r }));
  sqlite.exec(await migration("0602_meter_activation_timeline.sql"));
  assert.deepEqual(
    sqlite
      .prepare("SELECT * FROM usage_meter_activations ORDER BY meter, starts_at")
      .all()
      .map((r) => ({ ...r })),
    before,
  );
  sqlite.exec(
    "INSERT INTO usage_meter_activations VALUES ('wfp.requests','usage-2026-09-07-v1','2026-12-01T00:00:00.000000Z','2026-10-30T00:00:00.000000Z')",
  );
  assert.equal(
    sqlite
      .prepare("SELECT count(*) AS n FROM usage_meter_activations WHERE meter = 'wfp.requests'")
      .get().n,
    2,
  );
  // the same key twice, a start before the activation, a meter outside the grammar and an unknown card are still refused
  assert.throws(
    () =>
      sqlite.exec(
        "INSERT INTO usage_meter_activations VALUES ('wfp.requests','usage-2026-09-07-v1','2026-12-01T00:00:00.000000Z','2026-10-30T00:00:00.000000Z')",
      ),
    /UNIQUE|PRIMARY/u,
  );
  assert.throws(
    () =>
      sqlite.exec(
        "INSERT INTO usage_meter_activations VALUES ('wfp.cpu','usage-2026-09-07-v1','2026-11-01T00:00:00.000000Z','2026-12-30T00:00:00.000000Z')",
      ),
    /CHECK/u,
  );
  assert.throws(
    () =>
      sqlite.exec(
        "INSERT INTO usage_meter_activations VALUES ('Bad Meter','usage-2026-09-07-v1','2026-12-01T00:00:00.000000Z','2026-10-30T00:00:00.000000Z')",
      ),
    /087 grammar/u,
  );
  assert.throws(
    () =>
      sqlite.exec(
        "INSERT INTO usage_meter_activations VALUES ('wfp.cpu','missing','2026-12-01T00:00:00.000000Z','2026-10-30T00:00:00.000000Z')",
      ),
    /FOREIGN KEY/u,
  );
  assert.throws(
    () => sqlite.exec("UPDATE usage_meter_activations SET starts_at = starts_at"),
    /append-only/u,
  );
  assert.throws(() => sqlite.exec("DELETE FROM usage_meter_activations"), /never deleted/u);
});

test("an AI card published before its activation says that AI calls are refused, not that they are free", async (context) => {
  const h = await harness(context);
  const file = await h.write(
    "ai.json",
    cardFile({
      id: "ai-orq-2026-11-v1",
      effective_from: "2027-01-01T00:00:00Z",
      rates: [
        {
          meter: "ai.cost",
          unit: "usd_micro",
          units_per_charge: "10000",
          provider_cost_micros: null,
          credit_micros: "1390895",
        },
      ],
    }),
  );
  const dry = await h.run("publish", { cardFile: file });
  assert.match(
    dry.text,
    /note: ai\.cost has no activation: AI calls are refused until activate or switch starts this card/u,
  );
});

test("the known meters and units are the ones the usage sources and the mail post", async () => {
  const sources = {
    "apps/credit-service/src/wfp.ts": ["wfp.requests", "wfp.cpu"],
    "apps/credit-service/src/r2.ts": ["r2.storage.standard", "r2.class_a", "r2.class_b"],
    "apps/credit-service/src/resources.ts": ["wfp.script", "domain.custom_hostname"],
    "packages/platform/src/shared/usage-pricing.ts": ["pgcf.memory.active"],
    "apps/control-store/src/catalog/mail/credit.ts": ["mail.sent", "mail.received"],
    "packages/platform/src/shared/ai-gateway.ts": ["ai.cost"],
    "packages/platform/src/shared/browser-gateway.ts": ["browser.duration"],
  };
  const listed = Object.values(sources).flat().sort();
  assert.deepEqual(Object.keys(KNOWN_METERS).sort(), listed);
  for (const [file, meters] of Object.entries(sources)) {
    const text = await readFile(join(SOURCE, file), "utf8");
    for (const meter of meters) {
      assert.ok(text.includes(`"${meter}"`), `${file} names ${meter}`);
      const unit = KNOWN_METERS[meter].unit;
      const usage = file.endsWith("usage-pricing.ts") ? text : text;
      assert.ok(
        usage.includes(`"${unit}"`) || usage.includes(`${unit}"`) || usage.includes(`: "${unit}"`),
        `${file} posts ${meter} in ${unit}`,
      );
    }
  }
});

test("the operator arguments are exact and Production always needs its word", () => {
  const base = ["--environment", "development", "--custody", "/private/c"];
  assert.deepEqual(parsePriceArguments(["list", ...base]), {
    command: "list",
    environment: "development",
    custody: "/private/c",
    cardFile: undefined,
    cardId: undefined,
    meter: undefined,
    startsAt: undefined,
    apply: false,
  });
  assert.equal(
    parsePriceArguments(["publish", ...base, "--card", "/tmp/card.json"]).cardFile,
    "/tmp/card.json",
  );
  assert.equal(
    parsePriceArguments(["publish", ...base, "--card", "/tmp/card.json", "--apply"]).apply,
    true,
  );
  const activate = parsePriceArguments([
    "activate",
    ...base,
    "--meter",
    "wfp.cpu",
    "--card",
    "c1",
    "--starts-at",
    "2026-12-01T00:00:00Z",
  ]);
  assert.deepEqual(
    [activate.meter, activate.cardId, activate.startsAt, activate.cardFile],
    ["wfp.cpu", "c1", "2026-12-01T00:00:00Z", undefined],
  );
  assert.equal(
    parsePriceArguments(["switch", ...base, "--card", "c1", "--starts-at", "2026-12-01T00:00:00Z"])
      .meter,
    undefined,
  );
  assert.equal(
    parsePriceArguments(["list", ...base, "--confirm", "development"]).environment,
    "development",
  );
  const production = ["--environment", "production", "--custody", "/private/c"];
  assert.equal(
    parsePriceArguments(["list", ...production, "--confirm", "production"]).environment,
    "production",
  );
  for (const bad of [
    [],
    ["bogus", ...base],
    ["list"],
    ["list", "--environment", "development"],
    ["list", "--environment", "staging", "--custody", "/c"],
    ["list", ...production],
    ["publish", ...production, "--card", "c.json", "--apply"],
    ["publish", ...production, "--card", "c.json", "--apply", "--confirm", "development"],
    ["list", ...base, "--confirm", "production"],
    ["list", ...base, "--apply"],
    ["list", ...base, "--card", "c1"],
    ["publish", ...base],
    ["publish", ...base, "--card"],
    ["publish", ...base, "--card", "--apply"],
    ["publish", ...base, "--card", "a.json", "--card", "b.json"],
    ["activate", ...base, "--card", "c1", "--starts-at", "2026-12-01T00:00:00Z"],
    [
      "switch",
      ...base,
      "--meter",
      "wfp.cpu",
      "--card",
      "c1",
      "--starts-at",
      "2026-12-01T00:00:00Z",
    ],
    ["switch", ...base, "--card", "c1"],
  ])
    assert.throws(() => parsePriceArguments(bad), /usage/u, JSON.stringify(bad));
});

test("a custody directory that others can read, or a card file that cannot be read, refuses before the Core is opened", async (context) => {
  const h = await harness(context);
  await assert.rejects(
    h.run("publish", { cardFile: join(h.root, "missing.json") }),
    code("CREDIT_PRICES_CARD_FILE"),
  );
  await assert.rejects(
    h.run("publish", { cardFile: await h.write("big.json", " ".repeat(1_048_577)) }),
    code("CREDIT_PRICES_CARD_FILE"),
  );
  await assert.rejects(
    h.run("activate", { meter: "wfp.cpu", cardId: "c", startsAt: "2026-12-01T00:30:00Z" }),
    code("CREDIT_PRICES_INSTANT"),
  );
  await chmod(h.custody, 0o755);
  await assert.rejects(h.run("list"), code("CREDIT_PRICES_CUSTODY"));
  assert.deepEqual(h.sessions, []);
});

test("a foreign or damaged journal stops a write before it is sent", async (context) => {
  const h = await harness(context);
  const file = await h.write("usage.json", cardFile(NEW_USAGE));
  const path = join(h.custody, "credit-prices-development.json");
  for (const content of [
    { schemaVersion: "other", environment: "development", entries: [] },
    { schemaVersion: "omh.credit-prices/v1", environment: "production", entries: [] },
    { schemaVersion: "omh.credit-prices/v1", environment: "development", entries: "x" },
  ]) {
    await writeFile(path, JSON.stringify(content), { mode: 0o600 });
    await assert.rejects(
      h.run("publish", { cardFile: file, apply: true }),
      code("CREDIT_PRICES_JOURNAL"),
    );
  }
  await writeFile(path, "{", { mode: 0o600 });
  await assert.rejects(
    h.run("publish", { cardFile: file, apply: true }),
    code("CREDIT_PRICES_JOURNAL"),
  );
  assert.equal(h.cards().length, 3);
});

test("a refused write is journaled as failed and leaves the Core unchanged", async (context) => {
  const h = await harness(context);
  const file = await h.write("usage.json", cardFile(NEW_USAGE));
  // a concurrent writer takes the effective time between the read and the write
  const run = h.run;
  h.sqlite.exec(
    "CREATE TRIGGER race BEFORE INSERT ON published_credit_rate_cards BEGIN SELECT RAISE(ABORT, 'taken'); END",
  );
  await assert.rejects(
    run("publish", { cardFile: file, apply: true }),
    code("CREDIT_PRICES_WRITE_REFUSED"),
  );
  assert.equal(h.cards().length, 3);
  const journal = JSON.parse(
    await readFile(join(h.custody, "credit-prices-development.json"), "utf8"),
  );
  assert.deepEqual(
    [journal.entries[0].status, journal.entries[0].code],
    ["failed", "CREDIT_PRICES_WRITE_REFUSED"],
  );
});

test("Production runs on the Production Core with its own journal", async (context) => {
  const h = await harness(context, "production");
  const result = await h.run("publish", {
    cardFile: await h.write("usage.json", cardFile(NEW_USAGE)),
    apply: true,
  });
  assert.equal(result.environment, "production");
  assert.equal(h.sessions[0].environment, "production");
  assert.ok((await stat(join(h.custody, "credit-prices-production.json"))).isFile());
});

test("renderState explains a state with no activation at all", () => {
  const text = renderState({ cards: [], activations: [] }, NOW);
  assert.equal(
    text,
    [
      "Cards (0), by effective time",
      "",
      "Activated meters (0), timeline and current price",
      "",
      "Every rated meter is activated.",
    ].join("\n"),
  );
});

test("Browser duration cards always charge exactly twice their declared provider cost", () => {
  const card = (provider, credits) =>
    JSON.stringify({
      id: "browser-test",
      effective_from: "2026-12-01T00:00:00Z",
      rates: [
        {
          meter: "browser.duration",
          unit: "millisecond",
          units_per_charge: "1000",
          provider_cost_micros: provider,
          credit_micros: credits,
        },
      ],
    });
  assert.equal(parseRateCard(card("25", "5000")).rates[0].credit_micros, "5000");
  assert.throws(() => parseRateCard(card(null, "5000")), code("CREDIT_PRICES_RATE_INVALID"));
  assert.throws(() => parseRateCard(card("25", "5001")), code("CREDIT_PRICES_RATE_INVALID"));
});
