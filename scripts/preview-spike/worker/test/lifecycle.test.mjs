/* global URL, Buffer, structuredClone, Response, setTimeout, Request, WritableStream */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../index.mjs", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "local-platform-double",
      setup(builder) {
        builder.onResolve({ filter: /^(cloudflare:workers|@cloudflare\/sandbox)$/ }, (args) => ({
          path: args.path,
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents:
            args.path === "cloudflare:workers"
              ? "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } } export class WorkerEntrypoint {}"
              : "export class DirectoryBackup { constructor() {} } export class DirectoryBackupGateway {} export class Files {constructor() {}} export const SandboxBackupError = {is(e) { return e instanceof Error && e.name === 'SandboxBackupError' && typeof e.code === 'string' && typeof e.operation === 'string' && typeof e.path === 'string' && typeof e.detail === 'string'; }};",
          loader: "js",
        }));
      },
    },
  ],
});
const { PreviewSpike, SpikeLimit } = await import(
  `data:text/javascript;base64,${Buffer.from(`${result.outputFiles[0].text}\n//# sourceURL=preview-spike-worker-test.mjs`).toString("base64")}`
);

function harness() {
  const data = new Map();
  const events = [];
  const storage = {
    async get(key) {
      const value = data.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async put(key, value) {
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async deleteAll() {
      data.clear();
    },
    async list({ prefix }) {
      return new Map([...data].filter(([key]) => key.startsWith(prefix)));
    },
    async transaction(run) {
      const next = new Map([...data].map(([key, value]) => [key, structuredClone(value)]));
      const result = await run({
        get: async (key) => structuredClone(next.get(key)),
        put: async (key, value) => next.set(key, structuredClone(value)),
      });
      data.clear();
      for (const [key, value] of next) data.set(key, value);
      return result;
    },
    async setAlarm(time) {
      this.alarmTime = time;
    },
    async deleteAlarm() {
      this.alarmTime = undefined;
    },
    async getAlarm() {
      return this.alarmTime ?? null;
    },
  };
  const container = {
    running: false,
    images: { fixture: "public-image" },
    files: new Map(),
    devRunning: false,
    start() {
      events.push("container-start");
      this.running = true;
      this.files = new Map();
      this.devRunning = false;
    },
    async destroy() {
      events.push("container-destroy");
      if (this.beforeDestroy) await this.beforeDestroy();
      this.running = false;
      this.devRunning = false;
      this.files.clear();
    },
    getTcpPort() {
      return {
        async fetch() {
          return new Response("visible");
        },
      };
    },
  };
  const ctx = {
    storage,
    container,
    exports: {},
    id: { name: "fixture" },
    waitUntil(promise) {
      void promise;
    },
  };
  const worker = new PreviewSpike(ctx, { SPIKE_PREVIEW_DOMAIN: "preview.dev.omh.st" });
  worker.configureNetwork = async () => {
    events.push("network-ready");
  };
  worker.readFixtureProvenance = async () => {
    events.push("fixture-provenance");
    return {
      fixtureSourceRevision: "a".repeat(40),
      fixtureArchiveSha256: "b".repeat(64),
      hmrOverlays: Object.fromEntries(
        ["react-vite", "vanilla-vite", "astro-edge"].map((name) => [name, "d".repeat(64)]),
      ),
      fixtureTrees: Object.fromEntries(
        [
          "react-vite",
          "vanilla-vite",
          "tanstack-start",
          "next-edge",
          "astro-edge",
          "next-native-auth",
          "next-app-mail",
        ].map((name) => [name, "c".repeat(64)]),
      ),
    };
  };
  worker.command = async (argv) => {
    if (argv.includes("prepare")) {
      events.push("guest-prepare");
      container.files.set("src/app/page.tsx", "initial");
    }
  };
  worker.writeEdit = async (path, content) => {
    container.files.set(path, content);
  };
  worker.startServer = async (state) => {
    events.push("server-start");
    container.devRunning = true;
    state.ready = true;
    state.phases.serverReadyAt = new Date().toISOString();
    await worker.save(state);
  };
  const snapshots = new Map();
  let counter = 0;
  worker.backups = {
    async backup() {
      assert.equal(container.devRunning, false, "a checkpoint must not read a running fixture");
      events.push("backup");
      const id = `backup-${++counter}`;
      snapshots.set(id, new Map(container.files));
      return { id, sha256: "a".repeat(64), size: 42, dir: "/workspace/app" };
    },
    async restore(record) {
      events.push("restore");
      container.files = new Map(snapshots.get(record.id));
    },
    async delete(record) {
      snapshots.delete(record.id);
    },
  };
  return { worker, container, events, storage, snapshots };
}

async function setup(h) {
  await h.worker.initialize({
    fixture: "next-edge",
    instance: "standard-1",
    inactivityMs: 5_000,
    cacheMode: "empty",
  });
  return h.worker.setup();
}

async function expire(h) {
  const state = await h.worker.state();
  state.lastUserActivityAt = Date.now() - 10_000;
  await h.worker.save(state);
}

test("first ready has a quiescent backup, and accepted edits survive idle and wake", async () => {
  const h = harness();
  const initial = await setup(h);
  assert.equal(initial.ready, true);
  assert.equal(initial.coldProof.noNodeModulesBeforeInstall, true);
  assert.ok(initial.backup);
  assert.ok(h.events.indexOf("backup") < h.events.indexOf("server-start"));
  const edit = await h.worker.edit({ path: "src/app/page.tsx", content: "updated" });
  assert.equal(edit.contentSha256, createHash("sha256").update("updated").digest("hex"));
  assert.equal(edit.sourceRevision, 1);
  assert.equal(edit.generation, initial.generation);
  assert.equal((await h.worker.status()).pendingEdits, undefined);
  await expire(h);
  await h.worker.alarm();
  assert.equal((await h.worker.status()).lastStopReason, "idle");
  assert.equal(h.container.running, false);
  assert.deepEqual(await h.worker.activity(), { woke: true });
  assert.equal(h.container.files.get("src/app/page.tsx"), "updated");
  assert.equal((await h.worker.status()).sourceRevision, 1);
  assert.equal((await h.worker.status()).wakeCount, 1);
  await h.worker.backup();
  assert.equal((await h.worker.status()).backup.sourceRevision, 1);
  assert.ok(h.events.lastIndexOf("container-destroy") < h.events.lastIndexOf("backup"));
});

test("a confirmed backup gateway deny precedes every guest launch and unconfirmed resets stop the VM", async (t) => {
  function serverHarness() {
    const h = harness();
    h.worker.ctx.id.name = "a".repeat(32);
    h.worker.env.SPIKE_CONTROL_TOKEN = "synthetic-control-token-at-least-32-bytes";
    h.worker.startServer = PreviewSpike.prototype.startServer;
    let grant = "deny";
    let reset = async () => undefined;
    const backup = h.worker.backups.backup;
    h.worker.backups.backup = async (...args) => {
      const record = await backup(...args);
      grant = "write"; // Model the SDK returning after its deny attempt lost its reply.
      return record;
    };
    const restore = h.worker.backups.restore;
    h.worker.backups.restore = async (...args) => {
      await restore(...args);
      grant = "read";
    };
    h.worker.backups.intercept = async () => {
      h.events.push("backup-deny-request");
      await reset();
      grant = "deny";
      h.events.push("backup-deny-confirmed");
    };
    h.container.exec = async (argv) => {
      assert.ok(argv.includes("serve"));
      assert.equal(grant, "deny", "the guest cannot launch with a leftover backup grant");
      h.events.push("server-start");
      h.container.devRunning = true;
      return {};
    };
    return {
      ...h,
      setReset: (operation) => {
        reset = operation;
      },
    };
  }

  await t.test(
    "cold, restored and checkpointed servers launch only after confirmed deny",
    async () => {
      const h = serverHarness();
      await setup(h);
      await h.worker.stop();
      await h.worker.activity();
      await h.worker.backup();
      const indices = (event) =>
        h.events.flatMap((value, index) => (value === event ? [index] : []));
      const launches = indices("server-start");
      const denials = indices("backup-deny-confirmed");
      assert.equal(launches.length, 3);
      assert.equal(denials.length, 3);
      for (const [index, launch] of launches.entries()) {
        assert.ok(denials[index] < launch);
        if (index > 0) assert.ok(denials[index] > launches[index - 1]);
      }
      assert.equal((await h.worker.status()).ready, true);
    },
  );

  for (const phase of ["cold", "wake"]) {
    await t.test(
      `a rejected deny on ${phase} cannot launch or discard its known backup`,
      async () => {
        const h = serverHarness();
        if (phase === "wake") {
          await setup(h);
          await h.worker.stop();
        }
        const launches = h.events.filter((event) => event === "server-start").length;
        h.setReset(async () => {
          throw new Error("backup deny reset rejected");
        });
        await assert.rejects(
          phase === "cold" ? setup(h) : h.worker.activity(),
          /backup deny reset rejected/u,
        );
        assert.equal(h.events.filter((event) => event === "server-start").length, launches);
        assert.equal(h.container.running, false);
        assert.equal((await h.worker.state()).poisoned, true);
        assert.ok((await h.worker.state()).backup);
        assert.equal((await h.worker.status()).ready, false);
        assert.equal(h.snapshots.size, 1);
        await h.worker.cleanup();
        assert.equal(h.snapshots.size, 0);
      },
    );
  }

  await t.test(
    "a deny reset with no reply reaches its deadline without starting the restored guest",
    async (context) => {
      const h = serverHarness();
      await setup(h);
      await h.worker.stop();
      context.mock.timers.enable({ apis: ["setTimeout"] });
      let entered;
      const resetting = new Promise((resolve) => {
        entered = resolve;
      });
      h.setReset(() => {
        entered();
        return new Promise(() => undefined);
      });
      const launches = h.events.filter((event) => event === "server-start").length;
      const result = h.worker.activity().then(
        () => null,
        (error) => error,
      );
      assert.equal(
        await Promise.race([resetting.then(() => "reset"), result.then(() => "finished")]),
        "reset",
      );
      context.mock.timers.tick(30_000);
      assert.equal((await result)?.message, "phase_deadline");
      assert.equal(h.events.filter((event) => event === "server-start").length, launches);
      assert.equal(h.container.running, false);
      assert.equal((await h.worker.status()).ready, false);
      assert.equal(h.snapshots.size, 1);
    },
  );
});

test("activity concurrent with idle stop and two tabs wakes once and both learn to reload", async () => {
  const h = harness();
  await setup(h);
  await expire(h);
  let release;
  let entered;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  h.container.beforeDestroy = async () => {
    entered();
    await blocked;
    h.container.beforeDestroy = null;
  };
  const alarm = h.worker.alarm();
  await started;
  const tab1 = h.worker.activity();
  const tab2 = h.worker.activity();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await alarm;
  assert.deepEqual(await Promise.all([tab1, tab2]), [{ woke: true }, { woke: true }]);
  const status = await h.worker.status();
  assert.equal(status.wakeCount, 1);
  assert.equal(status.running, true);
});

test("a real navigation renews the deadline, and the shared slot releases only its own ID", async () => {
  const h = harness();
  await setup(h);
  await expire(h);
  const response = await h.worker.fetch(
    new Request("https://fixture.preview.dev.omh.st/", {
      headers: {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-site": "none",
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.ok((await h.worker.status()).lastUserActivityAt > Date.now() - 1000);
  const limit = new SpikeLimit({ storage: h.storage, blockConcurrencyWhile: (run) => run() }, {});
  assert.equal(await limit.claim("first"), true);
  assert.equal(await limit.claim("second"), false);
  assert.equal(await limit.release("second"), false);
  assert.equal(await limit.claim("second"), false);
  assert.equal(await limit.release("first"), true);
  assert.equal(await limit.claim("second"), true);
});

test("SDK-only mode leaves the product alarm unset and reports a provider stop without inventing its cause", async () => {
  const h = harness();
  await h.worker.initialize({
    fixture: "next-edge",
    instance: "standard-1",
    inactivityMs: 5_000,
    cacheMode: "empty",
    idleMode: "sdk",
  });
  await h.worker.setup();
  assert.equal(h.storage.alarmTime, undefined);
  h.container.running = false;
  const stopped = await h.worker.status();
  assert.equal(stopped.observedProviderStop, true);
  assert.equal(stopped.lastStopReason, null);
  assert.deepEqual(await h.worker.activity(), { woke: true });
});

test("a failed error journal still destroys the container", async () => {
  const h = harness();
  await setup(h);
  const state = await h.worker.state();
  h.storage.put = async () => {
    throw new Error("storage_unavailable");
  };
  await assert.rejects(h.worker.fail(state, "install"), /storage_unavailable/);
  assert.equal(h.container.running, false);
});

test("edits distinguish rejected targets from unconfirmed writes without inventing a revision", async (t) => {
  await t.test("the API and helper path grammars agree before persistence", async () => {
    const h = harness();
    await setup(h);
    await assert.rejects(h.worker.edit({ path: "src/a..b.ts", content: "bad" }), /edit_rejected/);
    const state = await h.worker.state();
    assert.equal(state.sourceRevision, 0);
    assert.deepEqual(state.pendingEdits, {});
    assert.equal(state.poisoned, undefined);
  });
  await t.test("an existing-file refusal does not poison the live session", async () => {
    const h = harness();
    await setup(h);
    h.worker.writeEdit = PreviewSpike.prototype.writeEdit;
    h.container.exec = async () => ({
      stdin: new WritableStream(),
      exitCode: Promise.resolve(4),
    });
    await assert.rejects(
      h.worker.edit({ path: "src/missing.ts", content: "bad" }),
      /edit_rejected/,
    );
    const state = await h.worker.state();
    assert.equal(state.sourceRevision, 0);
    assert.deepEqual(state.pendingEdits, {});
    assert.equal(state.poisoned, undefined);
    assert.equal(h.container.running, true);
  });
  await t.test("an unconfirmed write retains its intent and fences the session", async () => {
    const h = harness();
    await setup(h);
    h.worker.writeEdit = async () => {
      h.container.files.set("src/app/page.tsx", "possibly-written");
      throw new Error("connection_lost");
    };
    await assert.rejects(h.worker.edit({ path: "src/app/page.tsx", content: "new" }));
    const state = await h.worker.state();
    assert.equal(state.sourceRevision, 0);
    assert.deepEqual(state.pendingEdits, {});
    const operations = [...(await h.storage.list({ prefix: "operation/" })).values()];
    assert.ok(
      operations.some((op) => op.kind === "edit" && ["intent", "unknown"].includes(op.state)),
    );
    assert.equal(state.poisoned, true);
  });
  await t.test(
    "a failed edit commit retains its intent and cannot be silently replayed",
    async () => {
      const h = harness();
      await setup(h);
      h.storage.transaction = async () => {
        throw new Error("commit_response_unknown");
      };
      await assert.rejects(
        h.worker.edit({ path: "src/app/page.tsx", content: "new" }),
        /edit_outcome_unknown/,
      );
      assert.equal((await h.worker.state()).sourceRevision, 0);
      await assert.rejects(h.worker.activity(), /reconciliation_required/);
    },
  );
  await t.test("a committed edit with a lost acknowledgement is never rolled back", async () => {
    const h = harness();
    await setup(h);
    const transaction = h.storage.transaction;
    h.storage.transaction = async (run) => {
      await transaction(run);
      throw new Error("commit_ack_lost");
    };
    await assert.rejects(
      h.worker.edit({ path: "src/app/page.tsx", content: "accepted" }),
      /edit_outcome_unknown/,
    );
    const current = await h.worker.state();
    assert.equal(current.sourceRevision, 1);
    assert.equal(current.pendingEdits["src/app/page.tsx"], "accepted");
    await h.worker.activity();
    assert.equal(h.container.files.get("src/app/page.tsx"), "accepted");
    assert.equal((await h.worker.state()).sourceRevision, 1);
  });
});

test("backup journals retain unknown uploads and every known object across handoff failures", async (t) => {
  await t.test("an upload without a record cannot claim complete cleanup", async () => {
    const h = harness();
    const upload = h.worker.backups.backup;
    h.worker.backups.backup = async () => {
      await upload();
      throw new Error("upload_outcome_unknown");
    };
    await assert.rejects(setup(h));
    await assert.rejects(h.worker.cleanup(), /backup_reconciliation_required/);
    assert.ok(await h.storage.get("session"));
    assert.equal((await h.worker.status()).cleanup.reconciliationRequired, true);
    assert.equal(h.snapshots.size, 1);
  });
  await t.test("a failed checkpoint save does not lose the new or old object", async () => {
    const h = harness();
    await setup(h);
    const put = h.storage.put;
    let rejected = false;
    h.storage.put = async (key, value) => {
      if (key === "session" && value.backup?.record.id === "backup-2" && !rejected) {
        rejected = true;
        throw new Error("checkpoint_save_failed");
      }
      return put.call(h.storage, key, value);
    };
    await assert.rejects(h.worker.backup());
    await h.worker.cleanup();
    assert.equal(h.snapshots.size, 0);
  });
  await t.test(
    "failed deletion stays visible while the confirmed checkpoint remains usable",
    async () => {
      const h = harness();
      await setup(h);
      const remove = h.worker.backups.delete;
      let rejected = false;
      h.worker.backups.delete = async (record) => {
        if (record.id === "backup-1" && !rejected) {
          rejected = true;
          throw new Error("delete_unconfirmed");
        }
        return remove(record);
      };
      const current = await h.worker.backup();
      assert.equal(current.ready, true);
      assert.equal(current.cleanup.pendingDeletes, 1);
      await h.worker.cleanup();
      assert.equal(h.snapshots.size, 0);
      assert.equal(h.events.filter((event) => event === "backup").length, 2);
    },
  );
  await t.test(
    "a failed cleanup cannot restart a checkpoint that may already be deleted",
    async () => {
      const h = harness();
      await setup(h);
      h.worker.backups.delete = async () => {
        throw new Error("delete_unknown");
      };
      await assert.rejects(h.worker.cleanup());
      await assert.rejects(h.worker.activity(), /cleanup_requested/);
    },
  );
  await t.test("cleanup remains possible when new operation admission is full", async () => {
    const h = harness();
    await setup(h);
    for (let index = 0; index < 127; index++)
      await h.storage.put(`operation/full-${index}`, {
        id: `full-${index}`,
        kind: "wake",
        state: "rejected",
      });
    await h.worker.cleanup();
    assert.equal(h.snapshots.size, 0);
  });
});

test("wake recovery repeats only a settled restore refusal and preserves ambiguous outcomes", async (t) => {
  const transfer = () =>
    Object.assign(new Error("untrusted_detail"), {
      name: "SandboxBackupError",
      code: "BACKUP_TRANSFER",
      operation: "restore",
      path: "/workspace/app",
      detail: "local synthetic",
    });
  await t.test("a transient SDK restore refusal gets one clean-VM recovery", async () => {
    const h = harness();
    await setup(h);
    await h.worker.stop();
    const restore = h.worker.backups.restore;
    let calls = 0;
    h.worker.backups.restore = async (record) => {
      if (++calls === 1) throw transfer();
      return restore(record);
    };
    assert.deepEqual(await h.worker.activity(), { woke: true });
    assert.equal(calls, 2);
    assert.equal((await h.worker.status()).ready, true);
  });
  await t.test("a lost restore response is not retried", async () => {
    const h = harness();
    await setup(h);
    await h.worker.stop();
    let calls = 0;
    h.worker.backups.restore = async () => {
      calls++;
      throw new Error("transport_lost");
    };
    await assert.rejects(h.worker.activity());
    assert.equal(calls, 1);
    assert.equal((await h.worker.state()).poisoned, true);
    assert.ok(
      (await h.worker.status()).operations.some(
        (op) => op.kind === "wake" && op.state === "unknown",
      ),
    );
  });
  await t.test("our deadline wins over a retry-shaped SDK abort error", async () => {
    const { bounded, PhaseDeadline } = await import("../deadline.mjs");
    await assert.rejects(
      bounded(
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(transfer()), { once: true });
          }),
        1,
      ),
      PhaseDeadline,
    );
  });
  await t.test("settled transient refusals do not exceed two automatic attempts", async () => {
    const h = harness();
    await setup(h);
    await h.worker.stop();
    let calls = 0;
    h.worker.backups.restore = async () => {
      calls++;
      throw transfer();
    };
    await assert.rejects(h.worker.activity(), /wake_retryable_failure/);
    assert.equal(calls, 2);
    assert.equal(h.container.running, false);
    assert.equal((await h.worker.state()).poisoned, undefined);
  });
  await t.test(
    "status binds runtime version metadata and pristine fixture identity before guest work",
    async () => {
      const h = harness();
      h.worker.env.CF_VERSION_METADATA = { id: "12345678-1234-4234-8234-123456789abc" };
      h.worker.env.SPIKE_SOURCE_REVISION = "d".repeat(40);
      const manifest = await h.worker.readFixtureProvenance();
      h.worker.files = { readFile: async () => Response.json(manifest) };
      assert.deepEqual(await PreviewSpike.prototype.readFixtureProvenance.call(h.worker), manifest);
      h.worker.files = {
        readFile: async () => Response.json({ fixtureSourceRevision: "a".repeat(40) }),
      };
      await assert.rejects(
        PreviewSpike.prototype.readFixtureProvenance.call(h.worker),
        /fixture_provenance_invalid/,
      );
      await setup(h);
      assert.deepEqual((await h.worker.status()).provenance, {
        workerVersionId: "12345678-1234-4234-8234-123456789abc",
        sourceRevision: "d".repeat(40),
        fixtureSourceRevision: "a".repeat(40),
        fixtureArchiveSha256: "b".repeat(64),
        fixtureTreeSha256: "c".repeat(64),
        hmrOverlaySha256: null,
      });
      assert.ok(h.events.indexOf("fixture-provenance") < h.events.indexOf("guest-prepare"));
    },
  );
  await t.test("a new generation cannot reuse the previous idle-stop evidence", async () => {
    const h = harness();
    await setup(h);
    await expire(h);
    await h.worker.alarm();
    const first = await h.worker.status();
    assert.equal(first.stopGeneration, first.generation);
    assert.ok(Date.parse(first.stoppedAt) >= Date.parse(first.stopRequestedAt));
    await h.worker.activity();
    h.container.running = false;
    const external = await h.worker.status();
    assert.equal(external.lastStopReason, null);
    assert.equal(external.stoppedAt, null);
    assert.equal(external.stopGeneration, null);
  });
  await t.test(
    "actor restart restores missing product and lease alarms without extending deadlines",
    async () => {
      const h = harness();
      await setup(h);
      await h.storage.deleteAlarm();
      const state = await h.worker.state();
      const original = PreviewSpike.prototype.configureNetwork;
      let recovery;
      h.worker.ctx.blockConcurrencyWhile = (run) => {
        recovery = run();
        return recovery;
      };
      PreviewSpike.prototype.configureNetwork = async () => {};
      try {
        const restarted = new PreviewSpike(h.worker.ctx, h.worker.env);
        await recovery;
        assert.equal(h.container.running, true, "a held socket may keep the existing VM alive");
        assert.equal(h.storage.alarmTime, state.lastUserActivityAt + state.config.inactivityMs);
        const earlier = state.lastUserActivityAt + 1000;
        await h.storage.setAlarm(earlier);
        new PreviewSpike(h.worker.ctx, h.worker.env);
        await recovery;
        assert.equal(h.storage.alarmTime, earlier, "an earlier alarm must not be postponed");
        await expire({ ...h, worker: restarted });
        await h.storage.deleteAlarm();
        const expiredActor = new PreviewSpike(h.worker.ctx, h.worker.env);
        await recovery;
        assert.equal(
          h.container.running,
          false,
          "an already-expired deadline must stop before network setup",
        );
        const stopped = await expiredActor.status();
        await expiredActor.alarm();
        const repeated = await expiredActor.status();
        assert.equal(repeated.lastStopReason, "idle");
        assert.equal(repeated.stoppedAt, stopped.stoppedAt);
      } finally {
        PreviewSpike.prototype.configureNetwork = original;
      }
      const lease = { id: "lease-id", expiresAt: Date.now() + 12_000 };
      await h.storage.put("lease", lease);
      await h.storage.deleteAlarm();
      const ctx = {
        storage: h.storage,
        blockConcurrencyWhile(run) {
          recovery = run();
          return recovery;
        },
      };
      new SpikeLimit(ctx, {});
      await recovery;
      assert.equal(h.storage.alarmTime, lease.expiresAt);
      const earlierLeaseAlarm = lease.expiresAt - 1000;
      await h.storage.setAlarm(earlierLeaseAlarm);
      new SpikeLimit(ctx, {});
      await recovery;
      assert.equal(h.storage.alarmTime, earlierLeaseAlarm);
      const expiredLease = { ...lease, expiresAt: Date.now() - 1000 };
      await h.storage.put("lease", expiredLease);
      await h.storage.deleteAlarm();
      const beforeTrigger = Date.now();
      new SpikeLimit(ctx, {});
      await recovery;
      assert.ok(h.storage.alarmTime > beforeTrigger, "an expired lease needs a future trigger");
      assert.equal((await h.storage.get("lease")).expiresAt, expiredLease.expiresAt);
    },
  );
  await t.test("a created backup handoff is an explicit blocker after actor restart", async () => {
    const h = harness();
    await setup(h);
    const selected = (await h.worker.state()).backup;
    await h.storage.put("operation/handoff", {
      id: "handoff",
      kind: "backup-create",
      state: "created",
      record: selected.record,
    });
    h.worker.journal.active.clear();
    assert.equal((await h.worker.journal.blocking()).length, 1);
    await assert.rejects(h.worker.activity(), /reconciliation_required/);
    assert.equal((await h.worker.status()).ready, false);
    await h.worker.cleanup();
    assert.equal(h.snapshots.size, 0, "the known record is removable without another upload");
  });
});
