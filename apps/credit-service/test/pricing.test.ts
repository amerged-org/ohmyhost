import { describe, expect, it } from "vitest";
import { organizationLines, priceLine, ratesToCards, type Charge } from "../src/pricing.js";
import { RATE_CARDS } from "./doubles.js";

const AT = "2026-10-30T09:00:00.000Z";
const cards = ratesToCards(RATE_CARDS, AT);
const ceilDiv = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator - 1n) / denominator;
const charge = (overrides: Partial<Charge> = {}): Charge => ({
  organizationId: "org_1",
  projectId: "prj_1",
  environmentId: "env_1",
  meter: "wfp.requests",
  unit: "request",
  quantity: 1000n,
  ...overrides,
});

describe("ratesToCards", () => {
  it("reads the stored card rows of the Core", () => {
    expect(cards.map((card) => card.id)).toEqual([
      "usage-2026-09-07-v1",
      "pgcf-memory-2026-10-26-v1",
      "r2-test-v1",
      "resources-test-v1",
    ]);
    const requests = cards[0]?.rates.find((rate) => rate.meter === "wfp.requests");
    expect(requests).toMatchObject({
      unit: "request",
      unitsPerCharge: 7_000_000n,
      creditsPerCharge: 690_000_000n,
      providerCostPerCharge: 2_100_000n,
      roundingMode: "ceil",
    });
  });

  it("also reads platform rate objects with bigint, string or number values", () => {
    const [card] = ratesToCards(
      [
        {
          rateCardId: "mixed",
          rates: [
            {
              meter: "m",
              unit: "u",
              unitsPerCharge: 10n,
              creditsPerCharge: "5",
              providerCostPerCharge: 3,
            },
          ],
        },
      ],
      AT,
    );
    expect(card?.rates[0]).toMatchObject({
      unitsPerCharge: 10n,
      creditsPerCharge: 5n,
      providerCostPerCharge: 3n,
    });
  });

  it("rejects malformed cards", () => {
    const bad = (rates: unknown) => () => ratesToCards([{ rateCardId: "bad", rates }], AT);
    expect(bad("nope")).toThrow("credit_service_rate_invalid");
    expect(bad([null])).toThrow("credit_service_rate_invalid");
    expect(bad([[]])).toThrow("credit_service_rate_invalid");
    expect(bad([{ meter: 1, unit: "u" }])).toThrow("credit_service_rate_invalid");
    for (const value of ["01", "-1", "1.5", -1, 1.5, -1n, null, undefined])
      expect(bad([{ meter: "m", unit: "u", units_per_charge: value, credit_micros: "1" }])).toThrow(
        "credit_service_rate_invalid",
      );
  });
});

describe("priceLine", () => {
  it("prices requests and CPU with the published rates, rounding up once", () => {
    const requests = priceLine(cards, AT, charge({ quantity: 1000n }));
    expect(requests).toEqual({
      projectId: "prj_1",
      environmentId: "env_1",
      meter: "wfp.requests",
      quantity: "1000",
      unit: "request",
      rateCardId: "usage-2026-09-07-v1",
      chargeMicros: Number(ceilDiv(1000n * 690_000_000n, 7_000_000n)),
    });
    expect(requests?.chargeMicros).toBe(98_572);
    const cpu = priceLine(cards, AT, charge({ meter: "wfp.cpu", unit: "cpu_ms", quantity: 9n }));
    expect(cpu?.chargeMicros).toBe(Number(ceilDiv(9n * 46_000_000n, 7_000_000n)));
  });

  it("prices one hour of PGCF memory with the memory card", () => {
    const line = priceLine(
      cards,
      AT,
      charge({
        meter: "pgcf.memory.active",
        unit: "memory_mib_milliseconds",
        quantity: 921_600_000n,
      }),
    );
    expect(line).toMatchObject({
      rateCardId: "pgcf-memory-2026-10-26-v1",
      chargeMicros: 10_000_000,
    });
  });

  it("returns null for a meter no card in force prices and refuses an ambiguous one", () => {
    expect(priceLine(cards, AT, charge({ meter: "unknown", unit: "request" }))).toBeNull();
    const usage = RATE_CARDS[0] as (typeof RATE_CARDS)[number];
    const twice = ratesToCards([usage, { ...usage, rateCardId: "copy" }], AT);
    expect(() => priceLine(twice, AT, charge())).toThrow("credit_service_rate_ambiguous");
  });

  it("refuses a charge that does not fit a safe integer", () => {
    expect(() => priceLine(cards, AT, charge({ quantity: 10n ** 15n }))).toThrow(
      "credit_service_charge_range",
    );
  });
});

describe("organizationLines", () => {
  it("merges equal scopes, groups by organization in a fixed order and reports unpriced meters", () => {
    const result = organizationLines(
      [
        charge({ organizationId: "org_b", quantity: 10n }),
        charge({ organizationId: "org_a", projectId: "prj_2", quantity: 5n }),
        charge({ organizationId: "org_a", projectId: "prj_1", quantity: 1n }),
        charge({ organizationId: "org_a", projectId: "prj_1", quantity: 2n }),
        charge({ organizationId: "org_a", meter: "wfp.cpu", unit: "cpu_ms", quantity: 4n }),
        charge({ organizationId: "org_a", quantity: 0n }),
        charge({ organizationId: "org_a", meter: "mail.sent", unit: "recipient", quantity: 1n }),
        charge({ organizationId: "org_c", meter: "mail.sent", unit: "recipient", quantity: 1n }),
      ],
      cards,
      AT,
    );
    expect([...result.byOrganization.keys()]).toEqual(["org_a", "org_b"]);
    expect(
      result.byOrganization
        .get("org_a")
        ?.map((line) => [line.projectId, line.meter, line.quantity]),
    ).toEqual([
      ["prj_1", "wfp.cpu", "4"],
      ["prj_1", "wfp.requests", "3"],
      ["prj_2", "wfp.requests", "5"],
    ]);
    expect(result.unpriced).toEqual(["mail.sent"]);
  });
});
