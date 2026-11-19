import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchTraceCostNanoUsd,
  TELEMETRY_TIMEOUT_MS,
  TRACE_COST_ATTEMPTS,
  TRACE_COST_RETRY_MS,
} from "../src/orq-cost.js";
import { FakeOrq, ORQ_BASE_URL, TELEMETRY_URL, telemetryReply } from "./fakes.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const ORQ_KEY = "orq-test-key";
const TRACE = "trace-42";

function orqEndpoint(orq: FakeOrq) {
  return { fetch: orq.fetch, apiKey: ORQ_KEY, baseUrl: ORQ_BASE_URL };
}

function recordingWait(): { wait: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    wait: async (ms: number) => {
      waits.push(ms);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchTraceCostNanoUsd", () => {
  it("queries the cost of the trace for the day around now, with the orq key", async () => {
    const orq = new FakeOrq();
    orq.respond(() => telemetryReply(3.6e-6));
    const { wait, waits } = recordingWait();
    await fetchTraceCostNanoUsd(orqEndpoint(orq), TRACE, wait);
    expect(orq.calls).toHaveLength(1);
    const call = orq.calls[0];
    expect(call?.url).toBe(TELEMETRY_URL);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.headers).toEqual({
      authorization: `Bearer ${ORQ_KEY}`,
      "content-type": "application/json",
    });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(call?.init.body))).toEqual({
      source: "TELEMETRY_SOURCE_TRACES",
      from: "2026-11-01T12:00:00.000Z",
      to: "2026-11-03T12:00:00.000Z",
      compute: [{ metric: "cost.total", op: "sum" }],
      filters: [{ field: "trace_id", op: "eq", values: [TRACE] }],
      mode: "scalar",
    });
    expect(waits).toEqual([]);
  });

  it.each([
    [3.6e-6, 3_600n],
    [1.6e-6, 1_600n],
    [0.1, 100_000_000n],
    [1e-9, 1n],
  ])("converts %s USD to exactly %s nano-USD", async (usd, nano) => {
    const orq = new FakeOrq();
    orq.respond(() => telemetryReply(usd));
    const { wait } = recordingWait();
    expect(await fetchTraceCostNanoUsd(orqEndpoint(orq), TRACE, wait)).toBe(nano);
  });

  it("treats an explicit zero as not yet ingested, retries it and accepts a later value", async () => {
    const orq = new FakeOrq();
    let attempt = 0;
    orq.respond(() => {
      attempt += 1;
      return telemetryReply(attempt === 1 ? 0 : 2e-6);
    });
    const { wait, waits } = recordingWait();
    expect(await fetchTraceCostNanoUsd(orqEndpoint(orq), TRACE, wait)).toBe(2_000n);
    expect(orq.calls).toHaveLength(2);
    expect(waits).toEqual([TRACE_COST_RETRY_MS]);
  });

  it("keeps an explicitly recorded zero distinct from missing telemetry", async () => {
    const orq = new FakeOrq();
    for (const zeroAttempt of [0, 1, 3, TRACE_COST_ATTEMPTS]) {
      let attempt = 0;
      orq.respond(() => {
        attempt += 1;
        return zeroAttempt === 0 || attempt === zeroAttempt
          ? telemetryReply(0)
          : Response.json({ data: [] });
      });
      const { wait } = recordingWait();
      expect(await fetchTraceCostNanoUsd(orqEndpoint(orq), TRACE, wait)).toBe(0n);
      expect(attempt).toBe(TRACE_COST_ATTEMPTS);
    }
  });

  it("keeps the worst case of all attempts at 25 s, leaving 5 s of the 30 s background budget to settle", () => {
    const worstCaseMs =
      TRACE_COST_ATTEMPTS * TELEMETRY_TIMEOUT_MS + (TRACE_COST_ATTEMPTS - 1) * TRACE_COST_RETRY_MS;
    expect(worstCaseMs).toBeLessThanOrEqual(25_000);
  });

  it("retries an absent value after the retry delay and accepts the value of the second attempt", async () => {
    const orq = new FakeOrq();
    let attempt = 0;
    orq.respond(() => {
      attempt += 1;
      return attempt === 1 ? Response.json({ data: [] }) : telemetryReply(1.6e-6);
    });
    const { wait, waits } = recordingWait();
    expect(await fetchTraceCostNanoUsd(orqEndpoint(orq), TRACE, wait)).toBe(1_600n);
    expect(orq.calls).toHaveLength(2);
    expect(waits).toEqual([TRACE_COST_RETRY_MS]);
  });

  it.each([
    ["a network error", () => Promise.reject(new TypeError("connect failed"))],
    ["an HTTP error", () => new Response("denied", { status: 403 })],
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { location: "https://outside.example" } }),
    ],
    ["a body that is not JSON", () => new Response("{", { status: 200 })],
    ["a negative cost", () => telemetryReply(-1)],
    [
      "a cost that is not a number",
      () => Response.json({ data: [{ metrics: { "cost.total:sum": "1" } }] }),
    ],
  ])("gives up after all attempts with null on %s", async (_label, reply) => {
    const orq = new FakeOrq();
    orq.respond(reply);
    const { wait, waits } = recordingWait();
    expect(await fetchTraceCostNanoUsd(orqEndpoint(orq), TRACE, wait)).toBeNull();
    expect(orq.calls).toHaveLength(TRACE_COST_ATTEMPTS);
    expect(waits).toHaveLength(TRACE_COST_ATTEMPTS - 1);
  });
});
