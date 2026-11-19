/* global Buffer, Request, Response, structuredClone */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { QA_FIXTURES } from "../../capabilities/config.mjs";
import { encodeValue } from "../../capabilities/wire.mjs";
import { GUEST_ACCEPTANCE, GUEST_MAIL_KEY } from "../../mail/adapter.mjs";

// The actual Worker, DO classes and router run here. Only the platform's container,
// storage and external services are doubled; these tests are not hosted evidence.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../index.mjs", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "qa-platform-ports",
      setup(builder) {
        builder.onResolve(
          { filter: /^(cloudflare:workers|@cloudflare\/sandbox)$/ },
          ({ path }) => ({
            path,
            namespace: "qa-platform",
          }),
        );
        builder.onLoad({ filter: /.*/, namespace: "qa-platform" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "cloudflare:workers"
              ? `class Base { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }
                 export class DurableObject extends Base {} export class WorkerEntrypoint extends Base {}`
              : `export class DirectoryBackup {
                   constructor(container) { this.container=container; this.count=0; }
                   async intercept() { this.container.events.push(['backup-intercept']); }
                   async backup() { return {id:'backup-'+(++this.count),sha256:'a'.repeat(64),size:1,dir:'/workspace/app'}; }
                   async restore() { this.container.events.push(['backup-restore']); }
                   async delete() { this.container.events.push(['backup-delete']); }
                 }
                 export class DirectoryBackupGateway {}
                 export class Files {
                   async readFile() { return Response.json({fixtureSourceRevision:'a'.repeat(40),fixtureArchiveSha256:'b'.repeat(64),fixtureTrees:Object.fromEntries(${JSON.stringify(QA_FIXTURES)}.map(x=>[x,'c'.repeat(64)])),hmrOverlays:Object.fromEntries(['react-vite','vanilla-vite','astro-edge'].map(x=>[x,'d'.repeat(64)]))}); }
                 }
                 export const SandboxBackupError={is(){return false;}};`,
        }));
      },
    },
  ],
});
const {
  PreviewSpike,
  SpikeLimit,
  SpikeCapabilities,
  default: router,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const sessionId = "a".repeat(32);
const token = "synthetic-qa-control-token-at-least-32-bytes";
const id = (number) => String(number).padStart(26, "0");
const manifest = {
  platform: "development",
  projects: QA_FIXTURES.map((fixture, index) => ({
    fixture,
    organizationId: id(1),
    projectId: id(10 + index),
    environmentId: id(20 + index),
    physicalEnvironmentId: id(30 + index),
    registrationVersion: 1,
    region: "eu",
    handle: `qa-${index}`,
    origin: `https://dev-qa-${index}.dev.check.omh.st`,
    principalId: "qa-operator",
    devAccessEpoch: 1,
  })),
};

function storage(events, name) {
  const values = new Map();
  let alarm = null;
  return {
    async get(key) {
      return structuredClone(values.get(key));
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      events.push([`${name}-delete`, key]);
      values.delete(key);
    },
    async deleteAll() {
      events.push([`${name}-delete-all`]);
      values.clear();
    },
    async list({ prefix }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)));
    },
    async transaction(run) {
      const next = new Map([...values].map(([key, value]) => [key, structuredClone(value)]));
      const result = await run({
        get: async (key) => structuredClone(next.get(key)),
        put: async (key, value) => next.set(key, structuredClone(value)),
      });
      values.clear();
      for (const [key, value] of next) values.set(key, value);
      return result;
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(value) {
      alarm = value;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
}

async function harness(fixture) {
  const events = [];
  const saved = storage(events, "sandbox");
  const limitStorage = storage(events, "limit");
  const env = {
    SPIKE_QA_ENABLED: "development",
    SPIKE_QA_MANIFEST: JSON.stringify(manifest),
    SPIKE_CONTROL_TOKEN: token,
    SPIKE_PREVIEW_DOMAIN: "preview.dev.omh.st",
    QA_STABLE_PREVIEW_MANAGEMENT: {
      create: async ({ previewId }) => ({ previewId, authGeneration: 1 }),
      retire: async () => true,
    },
    QA_MAIL_PRIVATE: {
      configuration: async () => ({
        OHMYHOST_MAIL_GATEWAY_URL: "https://qa-mail.invalid",
        OHMYHOST_MAIL_KEY: GUEST_MAIL_KEY,
        OHMYHOST_PROJECT_ID: manifest.projects[6].projectId,
        PREVIEW_ACCEPTANCE_KEY: GUEST_ACCEPTANCE,
        PREVIEW_MAIL_RECIPIENT: "qa@example.invalid",
      }),
      cleanup: async () => ({ deleted: true }),
    },
  };
  const container = {
    events,
    running: false,
    images: { fixture: "public-fixture-image" },
    start() {
      events.push(["container-start"]);
      this.running = true;
    },
    async destroy() {
      events.push(["container-destroy"]);
      this.running = false;
    },
    async exec(argv, options) {
      events.push(["exec", argv, options.env]);
      return { exitCode: Promise.resolve(0) };
    },
    async interceptOutboundHttp(host, binding) {
      events.push(["http-intercept", host, structuredClone(binding.ctx.props)]);
    },
    async interceptOutboundHttps(host, binding) {
      events.push(["https-intercept", host, structuredClone(binding.ctx.props)]);
    },
    async interceptAllOutboundHttp() {},
    async setInactivityTimeout() {},
    getTcpPort() {
      return { fetch: async () => new Response("fixture") };
    },
  };
  const worker = new PreviewSpike(
    {
      storage: saved,
      container,
      id: { name: sessionId },
      exports: {
        DirectoryBackupGateway: {},
        SpikeEgress: (ctx) => ({ ctx }),
        SpikeCapabilities: (ctx) => new SpikeCapabilities(ctx, env),
        QaMailIntercept: (ctx) => ({ ctx }),
      },
      waitUntil(promise) {
        void promise;
      },
    },
    env,
  );
  const limit = new SpikeLimit(
    { storage: limitStorage, blockConcurrencyWhile: (run) => run() },
    env,
  );
  env.SPIKE_LIMIT = { getByName: () => limit };
  env.SANDBOX = {
    getByName(value) {
      assert.equal(value, sessionId);
      return worker;
    },
  };
  await limit.claim(sessionId);
  const config = {
    fixture,
    instance: "standard-1",
    inactivityMs: 5_000,
    cacheMode: "empty",
    idleMode: "product",
  };
  return { worker, env, container, events, saved, limitStorage, limit, config };
}

test("cold start and wake bind the current generation, and expired QA cannot renew or start compute", async (t) => {
  for (const fixture of ["react-vite", "next-app-mail"]) {
    await t.test(fixture, async () => {
      const h = await harness(fixture);
      await h.worker.initialize(h.config);
      await h.worker.setup();
      assert.equal((await h.worker.status()).generation, 1);
      await h.worker.stop();
      assert.deepEqual(await h.worker.activity(), { woke: true });
      assert.equal((await h.worker.status()).generation, 2);
      for (const host of fixture === "next-app-mail"
        ? ["preview.capabilities", "qa-mail.invalid"]
        : ["preview.capabilities"]) {
        const scopes = h.events
          .filter(([, selected]) => selected === host)
          .map(([, , scope]) => scope);
        assert.deepEqual(
          scopes.map((scope) => scope.generation),
          [1, 2],
        );
        assert.ok(scopes.every((scope) => scope.sessionId === sessionId));
      }
      await h.worker.stop();
      const previous = await h.worker.state();
      await h.limitStorage.put("lease", { id: sessionId, expiresAt: Date.now() - 1 });
      const starts = h.events.filter(([kind]) => kind === "container-start").length;
      const response = await h.worker.fetch(
        new Request("https://preview.example.invalid/", {
          headers: {
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
            "sec-fetch-user": "?1",
          },
        }),
      );
      assert.equal(response.status, 503);
      await assert.rejects(h.worker.activity(), /qa_lease_expired/u);
      assert.equal(h.events.filter(([kind]) => kind === "container-start").length, starts);
      assert.equal((await h.worker.state()).lastUserActivityAt, previous.lastUserActivityAt);
      assert.equal(h.container.running, false);
    });
  }
});

test("a committed Auth create with lost reply keeps its lease until exact retirement is confirmed", async () => {
  const h = await harness("next-native-auth");
  let active = false;
  let confirm = false;
  const retirements = [];
  h.env.QA_STABLE_PREVIEW_MANAGEMENT = {
    async create() {
      active = true;
      throw new Error("lost create reply");
    },
    async retire(identity) {
      retirements.push(identity);
      h.events.push(["auth-retire", confirm]);
      if (!confirm) return false;
      active = false;
      return true;
    },
  };
  await assert.rejects(h.worker.initialize(h.config), /lost create reply/u);
  assert.equal(active, true);
  assert.equal((await h.worker.state()).qaAuthPending, true);
  const remove = () =>
    router.fetch(
      new Request(`https://control.preview.dev.omh.st/__spike/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
      h.env,
    );
  assert.equal((await remove()).status, 500);
  assert.equal((await h.limit.current()).id, sessionId);
  assert.equal((await h.worker.state()).cleanupRequested, true);
  assert.equal(active, true);
  assert.equal(
    h.events.some(([kind]) => kind === "limit-delete"),
    false,
  );
  confirm = true;
  assert.equal((await remove()).status, 200);
  assert.equal(await h.limit.current(), null);
  assert.equal(await h.saved.get("session"), undefined);
  assert.equal(active, false);
  assert.deepEqual(retirements, [
    { previewId: sessionId, authGeneration: 1 },
    { previewId: sessionId, authGeneration: 1 },
  ]);
  assert.ok(
    h.events.findIndex(([kind, result]) => kind === "auth-retire" && result) <
      h.events.findIndex(([kind]) => kind === "limit-delete"),
  );
});

test("disappearance after DB or Auth dispatch returns unknown without backend data or replay", async (t) => {
  for (const fixture of ["react-vite", "next-native-auth"]) {
    await t.test(fixture, async () => {
      const h = await harness(fixture);
      await h.worker.initialize(h.config);
      await h.worker.setup();
      const state = await h.worker.state();
      const selected = manifest.projects.find((scope) => scope.fixture === fixture);
      h.env.QA_DEV_ACCESS = { authorizeDevAccessSession: async () => true };
      h.env.QA_CREDIT = {
        read: async () => ({
          organizationId: selected.organizationId,
          projectId: selected.projectId,
          environmentId: selected.environmentId,
          allowed: true,
          paidAllowed: true,
          reason: null,
          checkedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      };
      let dispatches = 0;
      const disappear = async () => {
        dispatches++;
        const current = await h.worker.state();
        await h.worker.save({ ...current, cleanupRequested: true });
      };
      h.env.QA_SCOPED_DATABASE = {
        execute: async () => {
          await disappear();
          return { command: "SELECT", rowCount: 1, rows: [{ private: "backend-data" }] };
        },
      };
      if (fixture === "next-native-auth") {
        const scope = state.qa.authScope;
        h.env.QA_STABLE_PREVIEW_AUTHORITY = {
          resolve: async () => ({
            platform: "development",
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            region: scope.region,
            previewId: scope.previewId,
            previewOrigin: scope.previewOrigin,
            authGeneration: scope.authGeneration,
            devAccessEpoch: scope.devAccessEpoch,
            revocationEpoch: 1,
            configurationRevision: 1,
            enabled: true,
            sourceCapable: true,
            paidAllowed: true,
            runtimeAllowed: true,
          }),
        };
        h.env.QA_NATIVE_STABLE_PREVIEW = {
          validateStablePreviewSession: async () => {
            await disappear();
            return {
              user: { id: "backend-data", email: "qa@example.invalid" },
              session: { id: "session", expiresAt: new Date(Date.now() + 60_000).toISOString() },
            };
          },
        };
      }
      const outbound = new SpikeCapabilities(
        {
          props: {
            ...state.qa,
            sessionId,
            generation: state.generation,
          },
        },
        h.env,
      );
      const response = await outbound.fetch(
        new Request(
          `http://preview.capabilities/${fixture === "next-native-auth" ? "native-auth/session" : "database/query"}`,
          fixture === "next-native-auth"
            ? { method: "POST", headers: { cookie: "synthetic=1" } }
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: encodeValue({ text: "SELECT 1", values: [] }),
              },
        ),
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { outcome: "unknown", retryable: false });
      assert.equal(dispatches, 1);
    });
  }
});
