import { appendUsageRecord } from "../src/usage-store.js";
import { archiveUsage } from "../src/usage-archive.js";
import { readUsageArchive } from "../src/usage-bucket.js";
import type { UsageLogRecord } from "@ohmyhost/contracts/usage-log";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));
import worker, { GrowthCollectRuntime, GrowthReconcileRuntime } from "../src/worker-main.js";
import { splitStatements } from "../../control-store/test/support/sql.js";
import { createGrowthRuntime, type GrowthEnvironment } from "../src/runtime.js";
import type { GrowthD1 } from "../src/event-store.js";

async function setup() {
  const manifest = createRequire(import.meta.url).resolve("../../control-store/package.json");
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    createRequire(manifest).resolve("wrangler/package.json"),
  )("miniflare");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "growth",
          modules: true,
          script: "export default { fetch(){return new Response()} }",
          d1Databases: { DB: "db" },
          r2Buckets: { ARCHIVE: "usage" },
        },
      ],
    }),
  );
  const db = (await mf.getD1Database("DB", "growth")) as GrowthD1;
  for (const file of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await db.batch(
      splitStatements(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")).map(
        (sql) => db.prepare(sql),
      ),
    );
  }
  const packets: unknown[] = [];
  const page = { facts: [], next_cursor: null, source_watermark: null, history_floor: null };
  const env: GrowthEnvironment = {
    GROWTH_DB: db,
    GROWTH_USAGE_ARCHIVE: await mf.getR2Bucket("ARCHIVE", "growth"),
    GROWTH_QUEUE: {
      send: async (body) => {
        packets.push(body);
      },
    },
    GROWTH_RECONCILER: { reconcile: async () => ({}) },
    GROWTH_FACTS: { readFactPage: async () => ({ ...page, evidence_kind: "original" }) },
    GROWTH_IDENTITY: {
      readGrowthIdentityPage: async () => page,
      readGrowthUserSnapshotPage: async () => page,
      getGrowthIdentity: async () => ({ name: null, email: null }),
    },
    GROWTH_PAYMENTS: {
      readGrowthPaymentPage: async () => page,
      readGrowthOpenDisputePage: async () => page,
    },
    GROWTH_PLATFORM_ENV: "development",
    GROWTH_QUEUE_NAME: "growth",
    GROWTH_DLQ_NAME: "growth-dlq",
    GROWTH_PUBLIC_ORIGIN: "https://ops.example",
    GROWTH_ACCESS_ISSUER: "https://access.example",
    GROWTH_ACCESS_AUDIENCE: "ops",
    GROWTH_OPERATOR_PERMISSIONS_JSON: "{}",
  };
  return { mf, db, packets, env, runtime: createGrowthRuntime(env, { waitUntil() {} }) };
}

function usageFixture(): UsageLogRecord {
  const at = new Date().toISOString();
  return {
    schema_version: 1,
    record_id: crypto.randomUUID(),
    invocation_id: crypto.randomUUID(),
    parent_invocation_id: null,
    phase: "started",
    occurred_at: at,
    started_at: at,
    platform_environment: "development",
    transport: "remote_mcp",
    operation: "project_list",
    account_id: "user_one",
    organization_id: null,
    project_id: null,
    operation_id: null,
    operation_status: null,
    outcome: "started",
    duration_ms: null,
    http_status: null,
    error_code: null,
    platform_version: null,
  };
}

function message(id: string, body: unknown) {
  const state = { ack: 0, retry: 0, delay: 0 };
  return {
    state,
    value: {
      id,
      body,
      timestamp: new Date("2026-11-15T01:00:00.000Z"),
      ack() {
        state.ack++;
      },
      retry(options?: { delaySeconds: number }) {
        state.retry++;
        state.delay = options?.delaySeconds ?? 0;
      },
    },
  };
}

it("admits only matching producer events and acknowledges delivered packets while retrying malformed or conflicting deliveries", async () => {
  const { mf, db, packets, runtime, env } = await setup();
  try {
    const now = new Date().toISOString();
    const event = {
      schema_version: 1,
      event_id: "evt_runtime",
      event_name: "login_started",
      outcome: "succeeded",
      occurred_at: now,
      received_at: now,
      platform_environment: "development",
      producer: "control_api",
      evidence_kind: "event",
      flow_id: "flow_one",
      account_id: null,
      organization_id: null,
      project_id: null,
      operation_id: null,
      deployment_id: null,
      transport: "unknown",
      client_class: "unknown",
      client_class_trust: "unknown",
      error_class: null,
      campaign_key: null,
      request_country: null,
    };
    await expect(
      runtime.collect({ ...event, platform_environment: "production" }),
    ).rejects.toThrow();
    await expect(runtime.collect({ ...event, producer: "core" })).rejects.toThrow();
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(work: Promise<unknown>) {
        pending.push(work);
      },
    };
    const collector = new GrowthCollectRuntime(ctx as never, env);
    expect(await collector.collect(event)).toEqual({ accepted: true });
    expect(packets).toHaveLength(1);
    const valid = message("one", packets[0]);
    const malformed = message("two", { kind: "event", event, extra: "secret" });
    await worker.queue({ queue: "growth", messages: [valid.value, malformed.value] }, env, ctx);
    expect(valid.state).toMatchObject({ ack: 1, retry: 0 });
    expect(malformed.state).toMatchObject({ ack: 0, retry: 1, delay: 30 });
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM growth_events WHERE event_id=?")
          .bind(event.event_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    const conflict = message("three", { kind: "event", event: { ...event, outcome: "failed" } });
    await runtime.consume({ queue: "growth", messages: [conflict.value] });
    expect(conflict.state).toMatchObject({ ack: 0, retry: 1 });
    await expect(runtime.consume({ queue: "wrong", messages: [] })).rejects.toThrow();
    const usage = usageFixture();
    expect(await collector.collectUsage(usage)).toEqual({ accepted: true });
    await expect(
      collector.collectUsage({ ...usage, platform_environment: "production" }),
    ).rejects.toThrow();
    expect(packets).toHaveLength(1);
    expect(
      (await db.prepare("SELECT count(*) n FROM growth_usage_records").first<{ n: number }>())?.n,
    ).toBe(1);
    const usagePacket = { kind: "usage", record: usage };
    const usageMessage = message("usage", usagePacket);
    const badUsage = message("bad-usage", {
      kind: "usage",
      record: { ...usage, platform_environment: "production" },
    });
    await runtime.consume({ queue: "growth", messages: [usageMessage.value, badUsage.value] });
    expect(usageMessage.state.ack).toBe(1);
    expect(badUsage.state.retry).toBe(1);
    const terminalUsage = message("usage-dlq", usagePacket);
    await runtime.consume({ queue: "growth-dlq", messages: [terminalUsage.value] });
    expect(terminalUsage.state.ack).toBe(1);
    await runtime.consume({ queue: "growth", messages: [usageMessage.value] });
    const usageConflict = message("usage-conflict", {
      kind: "usage",
      record: { ...usage, operation: "identity_get" },
    });
    await runtime.consume({ queue: "growth", messages: [usageConflict.value] });
    expect(usageConflict.state.retry).toBe(1);
    const reconciler = new GrowthReconcileRuntime(ctx as never, env);
    await reconciler.reconcile("projects");
    await expect(reconciler.reconcile("invalid" as never)).rejects.toThrow();
    worker.scheduled({}, env, ctx);
    await Promise.all(pending);
    const stored = await env.GROWTH_USAGE_ARCHIVE.list({ prefix: "usage/v1/", limit: 10 });
    expect(stored.objects).toHaveLength(1);
    const key = stored.objects[0]?.key;
    if (!key) throw new Error("Native archive was not created");
    expect(await readUsageArchive(env.GROWTH_USAGE_ARCHIVE, key, 10_000)).toContain("project_list");
    expect(await readUsageArchive(env.GROWTH_USAGE_ARCHIVE, key, 1)).toBeNull();
    expect(await readUsageArchive(env.GROWTH_USAGE_ARCHIVE, "missing", 100)).toBeNull();
    expect(
      (await db.prepare("SELECT count(*) n FROM growth_usage_records").first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (await worker.fetch(new Request("https://elsewhere.example/growth"), env, ctx)).status,
    ).toBe(404);
  } finally {
    await mf.dispose();
  }
});

it("records health and terminal delivery receipts and denies an unauthenticated operator", async () => {
  const { mf, db, packets, runtime, env } = await setup();
  try {
    const now = new Date().toISOString();
    const snapshot = {
      schema_version: 1,
      producer: "control_api",
      available: true,
      as_of: now,
      since: now,
      offered: 5,
      unconfirmed: 1,
    };
    const observation = {
      schema_version: 1,
      observation_id: "a1b2c3d4-0000-4000-8000-000000000000",
      candidate_receipt_id: "01M21T9VB6J0P0QWQJ4J3086ZH",
      organization_id: "01M21T9VB6J0P0QWQJ4J3086ZJ",
      project_id: "01M21T9VB6J0P0QWQJ4J3086ZK",
      environment_id: "01M21T9VB6J0P0QWQJ4J3086ZM",
      deployment_id: "01M21T9VB6J0P0QWQJ4J3086ZN",
      health_status: "passed",
      http_status: 200,
      observed_at: now,
    };
    const collector = new GrowthCollectRuntime({ waitUntil() {} } as never, env);
    await collector.collectSourceHealth(snapshot);
    await collector.observeHealth(observation);
    const health = packets.map((body, i) => message(`health-${i}`, body));
    await runtime.consume({ queue: "growth", messages: health.map((item) => item.value) });
    expect(health.every((item) => item.state.ack === 1)).toBe(true);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_source_health").first<{ n: number }>())
        ?.n,
    ).toBe(1);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM growth_deployment_health")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    env.GROWTH_FACTS.readFactPage = async () => ({
      facts: [
        {
          source_id: "source_one",
          status: "succeeded",
          target_environment: "prod",
          kind: "deploy",
          deployment_id: observation.deployment_id,
          environment_id: observation.environment_id,
          candidate_receipt_id: observation.candidate_receipt_id,
          organization_id: observation.organization_id,
          project_id: observation.project_id,
          terminal_at: now,
          updated_at: now,
        },
      ],
      next_cursor: null,
      source_watermark: null,
      history_floor: null,
      evidence_kind: "original",
    });
    await runtime.reconcile("deployments");
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM growth_facts WHERE json_extract(body, '$.fact_type')='deployment'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    const dlq = message("terminal", { kind: "event", event: { private: "must not persist" } });
    await runtime.consume({ queue: "growth-dlq", messages: [dlq.value] });
    expect(dlq.state).toMatchObject({ ack: 1, retry: 0 });
    const receipt = await db
      .prepare("SELECT * FROM growth_delivery_failures WHERE message_id='terminal'")
      .first();
    expect(receipt).toMatchObject({ event_id: null, error_class: "delivery_exhausted" });
    expect(JSON.stringify(receipt)).not.toContain("must not persist");
    expect((await runtime.fetch(new Request("https://ops.example/growth"))).status).toBe(403);
    expect((await runtime.fetch(new Request("https://elsewhere.example/growth"))).status).toBe(404);
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const encode = (v: unknown) =>
      btoa(JSON.stringify(v)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    env.GROWTH_ACCESS_ISSUER = "https://team.cloudflareaccess.com";
    env.GROWTH_OPERATOR_PERMISSIONS_JSON = JSON.stringify({
      operator: ["growth.read_aggregate", "growth.read_identity", "growth.manage_experiments"],
    });
    const signed = `${encode({ alg: "RS256", kid: "test" })}.${encode({ iss: env.GROWTH_ACCESS_ISSUER, aud: "ops", sub: "operator", exp: Math.floor(Date.now() / 1000) + 60 })}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(signed),
      ),
    );
    const token = `${signed}.${btoa(String.fromCharCode(...signature))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")}`;
    const authorized = createGrowthRuntime(env, { waitUntil() {} }, async () =>
      Response.json({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] }),
    );
    const headers = { "cf-access-jwt-assertion": token };
    const dashboard = await authorized.fetch(
      new Request("https://ops.example/growth", { headers }),
    );
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("unconfirmed");
    const usage = usageFixture();
    await appendUsageRecord(db, usage);
    await archiveUsage(db, env.GROWTH_USAGE_ARCHIVE);
    const calls = await authorized.fetch(
      new Request("https://ops.example/growth/calls", { headers }),
    );
    expect(calls.status).toBe(200);
    expect(await calls.text()).toContain("project_list");
    const timeline = await authorized.fetch(
      new Request("https://ops.example/growth/timeline?subject=user_one&scope=org_one&identity=1", {
        headers,
      }),
    );
    expect(timeline.status).toBe(200);
    expect(await timeline.text()).toContain("Identity:");
    const start = new Date(Date.now() + 60_000).toISOString(),
      end = new Date(Date.now() + 86_400_000).toISOString();
    const experiment = {
      action: "register",
      hypothesis: "Improve activation",
      evidence_basis: "hypothesis",
      evidence_reference: null,
      segment: "all",
      primary_metric: "workspace_ready_7d",
      guardrails: ["errors"],
      baseline_version: "v1",
      variant_version: "v2",
      surface: "authorized_product_response",
      exposure_mode: "before_after",
      horizon_start: start,
      horizon_end: end,
    };
    const registration = await authorized.fetch(
      new Request("https://ops.example/growth", {
        method: "POST",
        headers: {
          ...headers,
          origin: "https://ops.example",
          "content-type": "application/json",
          "x-growth-csrf": "1",
        },
        body: JSON.stringify(experiment),
      }),
    );
    expect(registration.status).toBe(201);
  } finally {
    await mf.dispose();
  }
});

it("runs scheduled reconciliation through the actual named self-service RPC", async () => {
  const { build } = await import("esbuild");
  const { fileURLToPath } = await import("node:url");
  const manifest = createRequire(import.meta.url).resolve("../../control-store/package.json");
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    createRequire(manifest).resolve("wrangler/package.json"),
  )("miniflare");
  const output = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../src", import.meta.url)),
      loader: "ts",
      contents: `
      import worker, { GrowthCollectRuntime, GrowthReconcileRuntime } from './worker-main.ts';
      export { GrowthCollectRuntime, GrowthReconcileRuntime };
      export default { async fetch(request, env) {
        const pending = [];
        worker.scheduled({}, env, { waitUntil(p) { pending.push(p); } });
        await Promise.all(pending);
        return new Response('done');
      } };`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["source", "workerd", "worker", "browser"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "growth",
          compatibilityDate: "2026-09-14",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            { type: "ESModule", path: "growth.mjs", contents: output.outputFiles[0]?.text ?? "" },
          ],
          d1Databases: { GROWTH_DB: "db" },
          r2Buckets: { GROWTH_USAGE_ARCHIVE: "usage-rpc" },
          bindings: {
            GROWTH_PLATFORM_ENV: "development",
            GROWTH_QUEUE_NAME: "growth",
            GROWTH_DLQ_NAME: "growth-dlq",
            GROWTH_PUBLIC_ORIGIN: "https://ops.example",
            GROWTH_ACCESS_ISSUER: "https://access.example",
            GROWTH_ACCESS_AUDIENCE: "ops",
            GROWTH_OPERATOR_PERMISSIONS_JSON: "{}",
          },
          serviceBindings: {
            GROWTH_RECONCILER: { name: "growth", entrypoint: "GrowthReconcileRuntime" },
            GROWTH_FACTS: { name: "ports", entrypoint: "Core" },
            GROWTH_IDENTITY: { name: "ports", entrypoint: "Identity" },
            GROWTH_PAYMENTS: { name: "ports", entrypoint: "Payments" },
          },
        },
        {
          name: "ports",
          compatibilityDate: "2026-09-14",
          modules: [
            {
              type: "ESModule",
              path: "ports.mjs",
              contents: `
      import { WorkerEntrypoint } from 'cloudflare:workers';
      const page = {facts:[],next_cursor:null,source_watermark:null,history_floor:null};
      export class Core extends WorkerEntrypoint { readFactPage() { return {...page,evidence_kind:'original'}; } }
      export class Identity extends WorkerEntrypoint { readGrowthIdentityPage() { return page; } readGrowthUserSnapshotPage() { return page; } }
      export class Payments extends WorkerEntrypoint { readGrowthPaymentPage() { return page; } readGrowthOpenDisputePage() { return page; } }
      export default {};`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const db = (await mf.getD1Database("GROWTH_DB", "growth")) as GrowthD1;
    for (const file of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await db.batch(
        splitStatements(
          readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
        ).map((sql) => db.prepare(sql)),
      );
    expect((await mf.dispatchFetch("https://growth.invalid/")).status).toBe(200);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM growth_source_status WHERE last_success_at IS NOT NULL",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(10);
  } finally {
    await mf.dispose();
  }
}, 30_000);
