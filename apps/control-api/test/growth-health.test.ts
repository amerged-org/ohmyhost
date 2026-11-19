import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    constructor(
      _ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));
import { GrowthTelemetryHealth, GrowthHealthReadService } from "../src/growth-health.js";
import { createGrowthReporter } from "../src/growth-events.js";

it("keeps independently persisted, deduplicated acknowledgement counters through the actual DO RPC", async () => {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec<T>(query: string, ...values: unknown[]) {
      if (query.startsWith("CREATE TABLE")) {
        database.exec(query);
        return { toArray: () => [] as T[] };
      }
      const rows = database.prepare(query).all(...(values as (string | number | null)[]));
      return { toArray: () => rows as T[] };
    },
  };
  const state = {
    storage: {
      sql,
      transactionSync<T>(callback: () => T): T {
        database.exec("BEGIN");
        try {
          const value = callback();
          database.exec("COMMIT");
          return value;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  const published: unknown[] = [];
  const health = new GrowthTelemetryHealth(state, {
    GROWTH_ANALYTICS: {
      async collectSourceHealth(input) {
        published.push(input);
        return { accepted: true };
      },
    },
  });
  const event = {
    producer: "control_api" as const,
    event_id: crypto.randomUUID(),
    outcome: "offered" as const,
    occurred_at: new Date().toISOString(),
  };
  await health.record(event);
  await health.record(event);
  await health.record({ ...event, outcome: "gap" });
  const reader = new GrowthHealthReadService(
    {},
    { GROWTH_HEALTH: { idFromName: () => "counter", get: () => health } },
  );
  expect(await reader.read({ hours: 24 })).toMatchObject({
    available: true,
    offered: 1,
    unconfirmed: 1,
  });
  await health.alarm();
  expect(published).toHaveLength(1);
  await expect(health.record({ ...event, event_id: "invalid" })).rejects.toThrow(
    "growth_health_invalid",
  );
  await expect(
    health.record({ ...event, occurred_at: "2020-01-01T00:00:00.000Z" }),
  ).rejects.toThrow("growth_health_time_invalid");
  await expect(health.read({ hours: 721 })).rejects.toThrow("growth_health_window_invalid");
  database.close();
  const bundle = await build({
    stdin: {
      contents: `import {GrowthTelemetryHealth} from './apps/control-api/src/growth-health.ts'; export {GrowthTelemetryHealth}; export default {async fetch(request,env){const stub=env.HEALTH.get(env.HEALTH.idFromName('health'));if(request.method==='POST')await stub.record(await request.json());return Response.json(await stub.read({hours:24}));}}`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "health",
          modules: true,
          script: bundle.outputFiles[0]?.text ?? "",
          compatibilityDate: "2026-08-24",
          durableObjects: { HEALTH: { className: "GrowthTelemetryHealth", useSQLite: true } },
        },
      ],
    }),
  );
  try {
    for (let index = 0; index < 2; index++) {
      const response = await mf.dispatchFetch("https://health.test/", {
        method: "POST",
        body: JSON.stringify(event),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ available: true, offered: 1, unconfirmed: 0 });
    }
  } finally {
    await mf.dispose();
  }
});

it("bounds telemetry timeouts and preserves only trusted request country without failing product work", async () => {
  vi.useFakeTimers();
  const pending: Promise<unknown>[] = [];
  const events: unknown[] = [];
  const counts: string[] = [];
  const input = {
    event_name: "product_call_succeeded" as const,
    outcome: "succeeded" as const,
    transport: "portal" as const,
    account_id: "user_one",
  };
  try {
    const report = createGrowthReporter(
      {
        async collect(event) {
          events.push(event);
          return { accepted: true };
        },
      },
      { waitUntil: (p) => pending.push(p) },
      "development",
      {
        async record(record) {
          counts.push(record.outcome);
        },
      },
      "actual-version",
      "NL",
    );
    expect(() => report(input)).not.toThrow();
    await Promise.all(pending);
    expect(events).toMatchObject([{ request_country: "NL", platform_version: "actual-version" }]);
    pending.length = 0;
    const unavailable = createGrowthReporter(
      { collect: () => new Promise(() => {}) },
      { waitUntil: (p) => pending.push(p) },
      "development",
      {
        async record(record) {
          counts.push(record.outcome);
        },
      },
      undefined,
      "XX",
    );
    expect(() => unavailable(input)).not.toThrow();
    await vi.advanceTimersByTimeAsync(2001);
    await Promise.all(pending);
    expect(counts).toEqual(["offered", "offered", "gap"]);
    expect(() =>
      createGrowthReporter(
        undefined,
        {
          waitUntil() {
            throw new Error("closed context");
          },
        },
        "development",
      )(input),
    ).not.toThrow();
  } finally {
    vi.useRealTimers();
  }
});
