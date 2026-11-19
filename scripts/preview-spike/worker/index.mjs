/* global Response, Headers, fetch, Request, WebSocketPair, TextEncoder, TextDecoder, URL, HTMLRewriter */
import { DirectoryBackup, Files, SandboxBackupError } from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { allowedEdit, allowedOutbound, signId } from "./protocol.mjs";
import { activeNavigation, shouldExpire, wakeScript } from "./idle.mjs";
import { handleRequest } from "./router.mjs";
import { ReadinessFailure, waitForReady } from "./readiness.mjs";
import { bounded } from "./deadline.mjs";
import { EditRejected, OperationJournal } from "./operations.mjs";
import { parseFixtureManifest, runtimeProvenance } from "./provenance.mjs";
import {
  prepareQaSession,
  guestQaVariables,
  readMailSession,
  readQaSession,
  readQaLease,
  revokeQaSession,
  qaManifest,
} from "./qa.mjs";
import { handleDatabaseRequest } from "../capabilities/bridge.mjs";
import { handleQaAuthPublic, handleQaAuthSession } from "../auth/bridge.mjs";
import { gateMailIngress } from "../mail/adapter.mjs";
export { QaMailIntercept } from "../mail/worker.mjs";

export { DirectoryBackupGateway } from "@cloudflare/sandbox";

export class SpikeMailAuthority extends WorkerEntrypoint {
  readMailSession(input) {
    return readMailSession(this.env, input);
  }
}

export class SpikeCapabilities extends WorkerEntrypoint {
  async fetch(request) {
    const props = this.ctx.props;
    if (!props || !qaManifest(this.env)) return new Response(null, { status: 503 });
    if (
      !(await readQaSession(
        this.env,
        { sessionId: props.sessionId },
        props.fixture,
        props.generation,
      ))
    )
      return new Response(null, { status: 503 });
    const response =
      new URL(request.url).pathname === "/native-auth/session"
        ? await handleQaAuthSession(request, this.env, props.authScope)
        : await handleDatabaseRequest(request, this.env, { fixture: props.fixture });
    if (
      !(await readQaSession(
        this.env,
        { sessionId: props.sessionId },
        props.fixture,
        props.generation,
      ))
    ) {
      await response.body?.cancel();
      return Response.json({ outcome: "unknown", retryable: false }, { status: 409 });
    }
    return response;
  }
}

const WORKSPACE = "/workspace/app";
const PORT = 3001;
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const ENV = {
  HOME: "/home/preview",
  COREPACK_HOME: "/opt/corepack",
  CI: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_EXTRA_CA_CERTS: CA,
  REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
};
const TRUST = `set -eu; b=/etc/ssl/certs/ca-certificates.crt; s=/etc/ssl/certs/ca-certificates.system.crt; [ -e "$s" ] || cp "$b" "$s"; timeout 10 sh -c 'until [ -s ${CA} ]; do sleep 0.1; done'; cat "$s" ${CA} >"$b.tmp"; mv "$b.tmp" "$b"`;
const html = (body, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Preview spike</title>${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
const waitPage = () =>
  html("<p>Starting the preview…</p><script>setTimeout(()=>location.reload(),500)</script>");
const sleepingPage = () =>
  html(
    "<p>The preview is sleeping.</p><button id=w>Wake preview</button><script>document.querySelector('#w').addEventListener('click',async e=>{if(!e.isTrusted)return;const r=await fetch('/__spike/activity',{method:'POST',headers:{'x-spike-activity':'1'}});if(r.ok)location.reload()})</script>",
    503,
  );
const now = () => new Date().toISOString();
async function rearmAlarm(storage, deadline) {
  const existing = await storage.getAlarm();
  if (existing === null || existing > deadline)
    await storage.setAlarm(Math.max(deadline, Date.now() + 1));
}

// Only public package downloads are permitted. Redirects are returned to the container so a
// subsequent request is checked again. The container receives neither Worker secrets nor R2 keys.
export class SpikeEgress extends WorkerEntrypoint {
  async fetch(request) {
    if (!allowedOutbound(request.url) || !["GET", "HEAD"].includes(request.method))
      return new Response("Blocked", { status: 403 });
    const headers = new Headers(request.headers);
    for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name);
    return fetch(new Request(request, { headers, redirect: "manual" }));
  }
}

// One shared lease bounds compute. An uncertain timeout keeps the lease until cleanup is
// confirmed. Its ID is recoverable through the authenticated API. An alarm attempts cleanup.
export class SpikeLimit extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const lease = await ctx.storage.get("lease");
      if (lease) await rearmAlarm(ctx.storage, lease.expiresAt);
    });
  }

  async current() {
    return (await this.ctx.storage.get("lease")) ?? null;
  }
  async claim(id) {
    if (await this.current()) return false;
    const lease = { id, createdAt: Date.now(), expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
    await this.ctx.storage.put("lease", lease);
    await this.ctx.storage.setAlarm(lease.expiresAt);
    return true;
  }
  async release(id) {
    const lease = await this.current();
    if (lease?.id !== id) return false;
    await this.ctx.storage.delete("lease");
    await this.ctx.storage.deleteAlarm();
    return true;
  }
  async alarm() {
    const lease = await this.current();
    if (!lease) return;
    if (Date.now() < lease.expiresAt) {
      await this.ctx.storage.setAlarm(lease.expiresAt);
      return;
    }
    await this.env.SANDBOX.getByName(lease.id).cleanup();
    await this.release(lease.id);
  }
}

function bridge(response) {
  const upstream = response.webSocket;
  const [client, server] = Object.values(new WebSocketPair());
  upstream.binaryType = "arraybuffer";
  server.binaryType = "arraybuffer";
  upstream.accept();
  server.accept();
  function relay(from, to) {
    from.addEventListener("message", (event) => {
      try {
        to.send(event.data);
      } catch {
        try {
          from.close(1011);
        } catch {
          // The socket may already be closed.
        }
      }
    });
    from.addEventListener("close", (event) => {
      try {
        to.close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, event.reason);
      } catch {
        // The peer may already be closed.
      }
    });
    from.addEventListener("error", () => {
      try {
        to.close(1011);
      } catch {
        // The peer may already be closed.
      }
    });
  }
  relay(server, upstream);
  relay(upstream, server);
  const headers = new Headers();
  const protocol = response.headers.get("sec-websocket-protocol");
  if (protocol) headers.set("sec-websocket-protocol", protocol);
  return new Response(null, { status: 101, webSocket: client, headers });
}

export class PreviewSpike extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("container_missing");
    this.container = ctx.container;
    this.files = new Files(ctx.container);
    this.backups = new DirectoryBackup(ctx.container, ctx.exports.DirectoryBackupGateway, {
      binding: "BACKUP_BUCKET",
      prefix: "backups/",
    });
    this.queue = Promise.resolve();
    this.waking = null;
    this.networkReady = false;
    this.journal = new OperationJournal(ctx.storage);
    if (this.container.running) {
      void ctx.blockConcurrencyWhile(async () => {
        try {
          const state = await ctx.storage.get("session");
          if (!state) throw new Error("session_missing");
          await this.journal.assertSettled();
          if (state.cleanupRequested || state.poisoned || !state.ready) {
            await this.destroyContainer();
            return;
          }
          if (state.config.idleMode !== "sdk") {
            const activity = Number.isFinite(state.lastUserActivityAt)
              ? state.lastUserActivityAt
              : Date.parse(state.phases?.serverReadyAt ?? "");
            if (!Number.isFinite(activity)) throw new Error("idle_activity_unavailable");
            const deadline = activity + state.config.inactivityMs;
            if (deadline <= Date.now()) {
              await this.stopForIdle(state);
              return;
            }
            await rearmAlarm(ctx.storage, deadline);
          }
          await this.configureNetwork(state.config, state);
        } catch (error) {
          if (this.container.running) await this.container.destroy();
          throw error;
        }
      });
    }
  }

  serial(run) {
    const operation = this.queue.then(run, run);
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async state() {
    const state = await this.ctx.storage.get("session");
    if (!state) throw new Error("session_missing");
    return state;
  }

  async save(state) {
    await this.ctx.storage.put("session", state);
  }

  async initialize(config) {
    return this.serial(async () => {
      if (await this.ctx.storage.get("session")) throw new Error("session_exists");
      await this.save({
        config,
        previewId: this.ctx.id.name,
        qa: null,
        qaAuthPending: qaManifest(this.env) !== null && config.fixture === "next-native-auth",
        generation: 0,
        wakeCount: 0,
        sourceRevision: 0,
        backup: null,
        ready: false,
        phases: null,
        lastStopReason: null,
        stoppedAt: null,
        stopRequestedAt: null,
        stopGeneration: null,
        lastUserActivityAt: null,
        pendingEdits: {},
        coldProof: null,
        capabilityVerification: "unavailable",
      });
      if (qaManifest(this.env)) {
        const state = await this.state();
        state.qa = await prepareQaSession(this.env, config, this.ctx.id.name);
        state.qaAuthPending = false;
        state.capabilityVerification = "configured";
        await this.save(state);
      }
    });
  }

  async status() {
    const state = await this.state();
    const { backup, ...safe } = state;
    delete safe.pendingEdits;
    delete safe.fixtureProvenance;
    if (safe.qa) safe.qa = { fixture: safe.qa.fixture, configured: true };
    return {
      ...safe,
      provenance: runtimeProvenance(this.env, state.fixtureProvenance, state.config.fixture),
      operations: await this.journal.summary(),
      cleanup: await this.cleanupState(),
      running: this.container.running,
      ready:
        this.container.running &&
        state.ready &&
        !state.poisoned &&
        (await this.journal.blocking()).length === 0,
      observedProviderStop:
        !this.container.running && state.ready && state.config.idleMode === "sdk",
      backup: backup
        ? {
            id: backup.record.id,
            sha256: backup.record.sha256,
            size: backup.record.size,
            sourceRevision: backup.sourceRevision,
            generation: backup.generation,
          }
        : null,
    };
  }

  async command(argv, options = {}) {
    return bounded(async (signal) => {
      const process = await this.container.exec(argv, {
        stdout: "ignore",
        stderr: "ignore",
        ...options,
        signal,
      });
      const code = await process.exitCode;
      if (code !== 0 || signal.aborted) throw new Error("container_command_failed");
    }, 180_000);
  }

  async backupOperation(method, argument) {
    return bounded(async (signal) => {
      const result = await this.backups[method](argument, { signal });
      if (signal.aborted) throw new Error("backup_deadline");
      return result;
    }, 180_000);
  }

  async destroyContainer() {
    if (this.container.running) await this.container.destroy();
    if (this.container.running) throw new Error("container_stop_unconfirmed");
    this.networkReady = false;
  }

  async cleanupState() {
    const operations = await this.journal.entries();
    return {
      reconciliationRequired: operations.some(
        (op) =>
          op.kind === "backup-create" && !op.record && ["intent", "unknown"].includes(op.state),
      ),
      pendingDeletes: operations.filter(
        (op) => op.kind === "backup-delete" && op.state !== "deleted",
      ).length,
    };
  }

  async deleteBackup(record) {
    const previous = (await this.journal.entries()).find(
      (op) => op.kind === "backup-delete" && op.record.id === record.id,
    );
    if (previous?.state === "deleted") return;
    const operation = previous ?? (await this.journal.begin("backup-delete", { record }));
    // SDK deletion is idempotent for this exact recorded object, including when it is already gone.
    await this.backupOperation("delete", record);
    await this.journal.finish(operation, "deleted");
  }

  async checkpoint(state) {
    // Checkpoints run only before the dev server starts in this container generation.
    // Package installation is script-free and has exited; refuse any remaining guest process.
    await this.command(["sh", "-c", "! pgrep -u 10001 >/dev/null"]);
    const startedAt = now();
    const operation = await this.journal.begin("backup-create", {
      generation: state.generation,
      sourceRevision: state.sourceRevision,
    });
    operation.name = `preview-spike-${this.ctx.id.name}-${operation.id}`;
    await this.journal.put(operation);
    let record;
    try {
      record = await bounded(async (signal) => {
        const result = await this.backups.backup({
          dir: WORKSPACE,
          name: operation.name,
          exclude: ["/.next/", "/.astro/", "/.wrangler/", "/node_modules/.vite/"],
          signal,
        });
        if (signal.aborted) throw new Error("backup_deadline");
        return result;
      }, 180_000);
    } catch (error) {
      await this.journal.finish(operation, "unknown");
      throw error;
    }
    // Persist the returned identity before replacing the selected checkpoint. A failed save
    // leaves either a known object here or the original unresolved create intent, never no work.
    const created = await this.journal.finish(operation, "created", { record });
    const previous = state.backup;
    const next = {
      ...state,
      backup: { record, sourceRevision: state.sourceRevision, generation: state.generation },
      pendingEdits: {},
      lastBackup: { startedAt, finishedAt: now(), quiescentGeneration: state.generation },
    };
    await this.save(next);
    Object.assign(state, next);
    await this.journal.finish(created, "committed");
    if (previous) {
      try {
        await this.deleteBackup(previous.record);
      } catch {
        /* The new checkpoint is confirmed; the exact old identity stays pending cleanup. */
      }
    }
  }

  async writeEdit(path, content) {
    return bounded(async (signal) => {
      const process = await this.container.exec(["/usr/local/bin/spike-write", path], {
        user: "10001:10001",
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        signal,
      });
      const writer = process.stdin.getWriter();
      await writer.write(new TextEncoder().encode(content));
      await writer.close();
      const code = await process.exitCode;
      if (!signal.aborted && [2, 3, 4].includes(code)) throw new EditRejected();
      if (code !== 0 || signal.aborted) throw new Error("edit_failed");
    }, 30_000);
  }

  async replayEdits(state) {
    state.phases.applyEditsStartAt = now();
    for (const [path, content] of Object.entries(state.pendingEdits))
      await this.writeEdit(path, content);
    state.phases.applyEditsEndAt = now();
  }

  async configureNetwork(config, currentState) {
    // DirectoryBackup's host interception must precede both catch-all handlers.
    await this.backups.intercept();
    const state = currentState ?? (await this.state());
    if (state.qa) {
      await this.container.interceptOutboundHttp(
        "preview.capabilities",
        this.ctx.exports.SpikeCapabilities({
          props: { ...state.qa, sessionId: this.ctx.id.name, generation: state.generation },
        }),
      );
      if (config.fixture === "next-app-mail")
        await this.container.interceptOutboundHttps(
          "qa-mail.invalid",
          this.ctx.exports.QaMailIntercept({
            props: { sessionId: this.ctx.id.name, generation: state.generation },
          }),
        );
    }
    const egress = this.ctx.exports.SpikeEgress({ props: {} });
    await this.container.interceptAllOutboundHttp(egress);
    await this.container.interceptOutboundHttps("*", egress);
    // The product idle alarm should fire first; SDK inactivity remains a separate fallback.
    await this.container.setInactivityTimeout(
      config.inactivityMs + (config.idleMode === "sdk" ? 0 : 30_000),
    );
    await this.command(["sh", "-c", TRUST]);
    this.networkReady = true;
  }

  async readFixtureProvenance() {
    return bounded(async (signal) => {
      const response = await this.files.readFile("/opt/preview-spike/fixture-provenance.json", {
        signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("fixture_provenance_invalid");
      const chunks = [];
      let size = 0;
      let count = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (++count > 128 || size > 16_384) throw new Error("fixture_provenance_invalid");
          if (part.value.byteLength) chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return parseFixtureManifest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    }, 30_000);
  }

  async startContainer(state, kind) {
    if (qaManifest(this.env) && !(await readQaLease(this.env, this.ctx.id.name)))
      throw new Error("qa_lease_expired");
    state.generation++;
    if (kind === "wake") state.wakeCount++;
    state.ready = false;
    state.lastStopReason = null;
    state.stoppedAt = null;
    state.stopRequestedAt = null;
    state.stopGeneration = null;
    state.phases = {
      kind,
      generation: state.generation,
      startedAt: now(),
      startRequestedAt: now(),
    };
    const instance =
      state.config.instance === "basic-custom-equivalent"
        ? { vcpu: 0.25, memoryMib: 1024, diskMb: 4000 }
        : state.config.instance;
    this.container.start({ image: this.container.images.fixture, instance, enableInternet: false });
    this.networkReady = false;
    await bounded(() => this.configureNetwork(state.config, state), 180_000);
    // Read pristine image metadata before any fixture preparation or dev server runs.
    state.fixtureProvenance = parseFixtureManifest(await this.readFixtureProvenance());
    state.phases.containerReadyAt = now();
    await this.save(state);
  }

  async startServer(state) {
    const label = await signId(this.ctx.id.name, this.env.SPIKE_CONTROL_TOKEN);
    const hostname = `${label}.${this.env.SPIKE_PREVIEW_DOMAIN}`;
    const guestEnv = { ...ENV, ...(await guestQaVariables(this.env, state)) };
    state.phases.serverStartAt = now();
    // SDK operation cleanup can swallow a failed deny reset; confirm it before guest code starts.
    await bounded(() => this.backups.intercept(), 30_000);
    await bounded(
      (signal) =>
        this.container.exec(
          ["node", "/opt/preview-spike/driver.mjs", "serve", state.config.fixture, hostname],
          {
            user: "10001:10001",
            env: guestEnv,
            stdout: "ignore",
            stderr: "ignore",
            signal,
          },
        ),
      180_000,
    );
    // Do not keep an exitCode wait pending after readiness: it would itself keep the DO active
    // and invalidate the SDK-only inactivity experiment.
    await waitForReady(
      (request) => this.container.getTcpPort(PORT).fetch(request),
      `http://${hostname}/`,
    );
    state.ready = true;
    state.phases.serverReadyAt = now();
    await this.save(state);
  }

  async markActive(state) {
    state.lastUserActivityAt = Date.now();
    await this.save(state);
    if (state.config.idleMode !== "sdk")
      await this.ctx.storage.setAlarm(state.lastUserActivityAt + state.config.inactivityMs);
  }

  async fail(state, phase) {
    try {
      // Do not overwrite a checkpoint or edit commit whose save may have succeeded before
      // its response was lost. Read its current identity before writing failure metadata.
      const current = await this.state();
      current.ready = false;
      current.poisoned = true;
      current.lastError = { phase, at: now() };
      await this.save(current);
    } finally {
      try {
        await this.destroyContainer();
      } finally {
        this.networkReady = false;
      }
    }
  }

  async setup() {
    return this.serial(async () => {
      const state = await this.state();
      if (qaManifest(this.env) && !state.qa) {
        state.qaAuthPending = state.config.fixture === "next-native-auth";
        await this.save(state);
        state.qa = await prepareQaSession(this.env, state.config, this.ctx.id.name);
        state.qaAuthPending = false;
        state.capabilityVerification = "configured";
        await this.save(state);
      }
      await this.journal.assertSettled();
      if (state.generation || this.container.running) throw new Error("session_already_started");
      let phase = "container_start";
      try {
        await this.startContainer(state, "cold");
        phase = "install";
        await this.command(["test", "!", "-e", `${WORKSPACE}/node_modules`]);
        state.coldProof = {
          noNodeModulesBeforeInstall: true,
          restored: false,
          cacheMode: state.config.cacheMode,
        };
        state.phases.installStartAt = now();
        await this.command(["mkdir", WORKSPACE]);
        await this.command(["chown", "10001:10001", WORKSPACE]);
        await this.command(
          [
            "node",
            "/opt/preview-spike/driver.mjs",
            "prepare",
            state.config.fixture,
            "unused",
            state.config.cacheMode,
          ],
          { user: "10001:10001", env: { ...ENV, ...(await guestQaVariables(this.env, state)) } },
        );
        state.phases.installEndAt = now();
        phase = "initial_backup";
        state.phases.backupStartAt = now();
        await this.checkpoint(state);
        state.phases.backupEndAt = now();
        phase = "server_start";
        await this.startServer(state);
        await this.markActive(state);
        return this.status();
      } catch (error) {
        await this.fail(state, phase);
        throw error;
      }
    });
  }

  async backup() {
    return this.serial(async () => {
      const state = await this.state();
      await this.journal.assertSettled();
      if (!this.container.running || !state.ready) throw new Error("container_not_ready");
      let phase = "destroy_previous_container";
      try {
        state.ready = false;
        await this.save(state);
        // Destroying the VM ends every process. Restore in a fresh container with no
        // server or customer writer, apply durable edits, then checkpoint that directory.
        await this.container.destroy();
        this.networkReady = false;
        await this.startContainer(state, "checkpoint");
        phase = "restore";
        await this.backupOperation("restore", state.backup.record);
        await this.replayEdits(state);
        phase = "backup";
        await this.checkpoint(state);
        phase = "server_start";
        await this.startServer(state);
        await this.markActive(state);
        return this.status();
      } catch (error) {
        await this.fail(state, phase);
        throw error;
      }
    });
  }

  async resumeState(state) {
    await this.journal.assertSettled();
    if (state.cleanupRequested) throw new Error("cleanup_requested");
    if (state.poisoned) throw new Error("session_poisoned");
    if (this.container.running && state.ready) return;
    if (!state.backup || this.container.running) throw new Error("backup_not_ready");
    for (let attempt = 1; attempt <= 2; attempt++) {
      const operation = await this.journal.begin("wake", {
        generation: state.generation + 1,
        attempt,
      });
      let phase = "container_start";
      try {
        await this.startContainer(state, "wake");
        phase = "restore";
        state.phases.restoreStartAt = now();
        await this.backupOperation("restore", state.backup.record);
        state.phases.restoreEndAt = now();
        phase = "replay_edits";
        await this.replayEdits(state);
        phase = "server_start";
        await this.startServer(state);
        await this.markActive(state);
        await this.journal.finish(operation, "applied");
        return;
      } catch (error) {
        const retryable =
          (phase === "restore" &&
            SandboxBackupError.is(error) &&
            error.operation === "restore" &&
            error.path === WORKSPACE &&
            error.code === "BACKUP_TRANSFER") ||
          (phase === "server_start" && error instanceof ReadinessFailure);
        if (retryable) {
          // This SDK refusal is settled and documents that no swap occurred, or the only
          // outstanding work is a read-only readiness request. Stop the old VM before retry.
          await this.destroyContainer();
          await this.journal.finish(operation, "rejected", { retryable: true, phase });
          Object.assign(state, await this.state());
          state.ready = false;
          state.lastError = { phase, at: now(), retryable: true, attempts: attempt };
          await this.save(state);
          if (attempt < 2) continue;
          throw new Error("wake_retryable_failure");
        }
        try {
          await this.journal.finish(operation, "unknown", { phase });
        } finally {
          await this.fail(state, phase);
        }
        throw error;
      } finally {
        this.journal.active.delete(operation.id);
      }
    }
  }

  wake() {
    if (!this.waking) {
      this.waking = this.serial(async () => this.resumeState(await this.state())).finally(() => {
        this.waking = null;
      });
    }
    return this.waking;
  }

  async activity() {
    if (qaManifest(this.env) && !(await readQaLease(this.env, this.ctx.id.name)))
      throw new Error("qa_lease_expired");
    const observed = await this.state();
    const observedSleeping = !this.container.running || !observed.ready || Boolean(this.waking);
    return this.serial(async () => {
      await this.journal.assertSettled();
      const state = await this.state();
      const needsWake = !this.container.running || !state.ready;
      if (needsWake) await this.resumeState(state);
      await this.markActive(state);
      return { woke: observedSleeping || needsWake || state.generation !== observed.generation };
    });
  }

  async stopForIdle(state) {
    if (
      !this.container.running &&
      !state.ready &&
      state.stopGeneration === state.generation &&
      typeof state.stoppedAt === "string" &&
      ["idle", "manual", "provider-stopped-before-alarm"].includes(state.lastStopReason)
    )
      return;
    const wasRunning = this.container.running;
    const stopRequestedAt = now();
    await this.destroyContainer();
    state.ready = false;
    state.lastStopReason = wasRunning ? "idle" : "provider-stopped-before-alarm";
    state.stoppedAt = now();
    state.stopRequestedAt = stopRequestedAt;
    state.stopGeneration = state.generation;
    this.networkReady = false;
    await this.save(state);
  }

  async alarm() {
    return this.serial(async () => {
      const state = await this.state();
      if (!shouldExpire(state.lastUserActivityAt, state.config.inactivityMs, Date.now())) {
        await this.ctx.storage.setAlarm(state.lastUserActivityAt + state.config.inactivityMs);
        return;
      }
      await this.stopForIdle(state);
    });
  }

  async stop() {
    return this.serial(async () => {
      const state = await this.state();
      const stopRequestedAt = now();
      await this.destroyContainer();
      state.ready = false;
      state.lastStopReason = "manual";
      state.stoppedAt = now();
      state.stopRequestedAt = stopRequestedAt;
      state.stopGeneration = state.generation;
      await this.ctx.storage.deleteAlarm();
      await this.save(state);
      this.networkReady = false;
      return this.status();
    });
  }

  async edit({ path, content }) {
    return this.serial(async () => {
      if (!allowedEdit(path, content)) throw new EditRejected();
      await this.journal.assertSettled();
      const state = await this.state();
      if (!this.container.running || !state.ready) throw new Error("container_not_ready");
      if (!Object.hasOwn(state.pendingEdits, path) && Object.keys(state.pendingEdits).length >= 32)
        throw new Error("edit_limit");
      const operation = await this.journal.begin("edit", {
        path,
        content,
        generation: state.generation,
        sourceRevision: state.sourceRevision,
      });
      try {
        await this.writeEdit(path, content);
      } catch (error) {
        if (error instanceof EditRejected) {
          await this.journal.finish(operation, "rejected");
          throw error;
        }
        try {
          await this.journal.finish(operation, "unknown");
        } finally {
          await this.fail(state, "edit");
        }
        throw error;
      }
      let committed;
      try {
        await this.ctx.storage.transaction(async (tx) => {
          const current = await tx.get("session");
          if (
            current.generation !== operation.generation ||
            current.sourceRevision !== operation.sourceRevision
          )
            throw new Error("edit_generation_changed");
          current.pendingEdits[path] = content;
          current.sourceRevision++;
          await tx.put("session", current);
          await tx.put(`operation/${operation.id}`, { ...operation, state: "applied" });
          committed = current;
        });
      } catch {
        // A commit failure can itself have an unknown outcome. Preserve its durable intent
        // or committed record; never restore an old revision or repeat the guest write.
        this.journal.active.delete(operation.id);
        await this.destroyContainer();
        throw new Error("edit_outcome_unknown");
      }
      this.journal.active.delete(operation.id);
      await this.markActive(committed);
      return {
        sourceRevision: committed.sourceRevision,
        writtenAt: now(),
        generation: committed.generation,
        contentSha256: [
          ...new Uint8Array(
            await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
          ),
        ]
          .map((x) => x.toString(16).padStart(2, "0"))
          .join(""),
      };
    });
  }

  async cleanup() {
    return this.serial(async () => {
      const state = await this.ctx.storage.get("session");
      if (state) await this.save({ ...state, ready: false, cleanupRequested: true });
      await this.destroyContainer();
      const operations = await this.journal.entries();
      const records = new Map(
        operations.filter((op) => op.record).map((op) => [op.record.id, op.record]),
      );
      if (state?.backup) records.set(state.backup.record.id, state.backup.record);
      for (const record of records.values()) await this.deleteBackup(record);
      if ((await this.cleanupState()).reconciliationRequired)
        throw new Error("backup_reconciliation_required");
      await revokeQaSession(this.env, state);
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return { destroyed: true, backupDeleted: records.size > 0 };
    });
  }

  async fetch(request) {
    let state;
    try {
      state = await this.state();
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (state.poisoned || state.cleanupRequested || (await this.journal.blocking()).length)
      return new Response("Preview requires reconciliation", { status: 503 });
    if (qaManifest(this.env) && !(await readQaLease(this.env, this.ctx.id.name)))
      return new Response("Preview session expired", { status: 503 });
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (upgrade && request.headers.get("origin") !== new URL(request.url).origin)
      return new Response("Forbidden", { status: 403 });
    const navigation = !upgrade && activeNavigation(request.headers);
    if (navigation) {
      await this.serial(async () => this.markActive(await this.state()));
      state = await this.state();
    }
    if (!this.container.running) {
      if (navigation) {
        this.ctx.waitUntil(this.wake().catch(() => {}));
        return waitPage();
      }
      return sleepingPage();
    }
    if (!state.ready || this.waking) return waitPage();
    if (
      state.qa &&
      !(await readQaSession(
        this.env,
        { sessionId: this.ctx.id.name },
        state.config.fixture,
        state.generation,
        true,
      ))
    )
      return new Response("Preview session expired", { status: 503 });
    if (state.qa?.authScope && new URL(request.url).pathname.startsWith("/api/auth/"))
      return handleQaAuthPublic(request, this.env, state.qa.authScope, {
        clientAddress: request.headers.get("cf-connecting-ip"),
      });
    if (state.qa && state.config.fixture === "next-app-mail") {
      const gated = await gateMailIngress(
        request,
        {
          QA_MAIL_PRIVATE: this.env.QA_MAIL_PRIVATE,
          QA_SPIKE_MAIL_AUTHORITY: { readMailSession: (input) => readMailSession(this.env, input) },
        },
        this.ctx.id.name,
      );
      if (gated.response) return gated.response;
      request = gated.request;
    }
    try {
      const url = new URL(request.url);
      url.protocol = "http:";
      const response = await this.container.getTcpPort(PORT).fetch(new Request(url, request));
      if (response.webSocket) return bridge(response);
      if (response.headers.get("content-type")?.includes("text/html")) {
        return new HTMLRewriter()
          .on("body", {
            element(element) {
              element.append(wakeScript, { html: true });
            },
          })
          .transform(response);
      }
      return response;
    } catch {
      return new Response("Preview unavailable", { status: 503 });
    }
  }
}

export default { fetch: handleRequest };
