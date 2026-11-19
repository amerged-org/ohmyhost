/* global URL, fetch, performance, process */
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBrowserProbe, fixtureOriginal } from "./browser.mjs";
import { startCapabilityJourney } from "./capability-journeys.mjs";
import { verify } from "./provenance.mjs";
import { directoryTreeSha256 } from "./source.mjs";
import { fixtures, instances } from "./statistics.mjs";
import { assertControlTarget } from "../deployment/control-target.mjs";
import { readOnlyJson } from "../deployment/read-only-json.mjs";
import { hmrOverlaySha256 } from "../worker/container/hmr-probe.mjs";

const CONTROL = "https://control.preview.dev.omh.st";
const ROOT = fileURLToPath(new URL("../../../fixtures/cloudflare-preview/", import.meta.url));
const ID = /^[a-f0-9]{32}$/u;
const BACKUP_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
function previewUrl(id, value) {
  return (
    typeof value === "string" &&
    new RegExp(`^https://${id}-[a-f0-9]{24}\\.preview\\.dev\\.omh\\.st/$`, "u").test(value)
  );
}

/** Hash the exact public fixture, including sorted paths, bytes and executable bits. */
export async function fixtureTreeSha256(fixture) {
  if (
    !/^(?:react-vite|vanilla-vite|tanstack-start|next-edge|astro-edge|next-native-auth|next-app-mail)$/u.test(
      fixture,
    )
  )
    throw new Error("fixture_invalid");
  return directoryTreeSha256(join(ROOT, fixture));
}

function hasBackup(status) {
  return Boolean(
    status?.backup &&
      typeof status.backup.id === "string" &&
      status.backup.id.length > 0 &&
      /^[a-f0-9]{64}$/u.test(status.backup.sha256 ?? "") &&
      Number.isFinite(status.backup.size) &&
      status.backup.size > 0 &&
      Number.isSafeInteger(status.backup.sourceRevision),
  );
}
function phaseDuration(start, end) {
  const first = Date.parse(start ?? ""),
    last = Date.parse(end ?? "");
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first)
    throw new Error("phase_invalid");
  return last - first;
}
function phasesFrom(status) {
  const phase = status?.phases;
  if (phase?.kind !== "wake" || phase.generation !== status.generation || phase.installStartAt)
    throw new Error("wake_phase_invalid");
  return {
    containerStartMs: phaseDuration(phase.startRequestedAt, phase.containerReadyAt),
    restoreMs: phaseDuration(phase.restoreStartAt, phase.restoreEndAt),
    serverStartMs: phaseDuration(phase.serverStartAt, phase.serverReadyAt),
  };
}

// Only these controller clock fields and validated scalar identities leave the DTO.
function runtimeCheckpoint(session, status, config, purpose) {
  const backup = status?.backup,
    phase = status?.phases,
    cold = purpose === "cold" || purpose === "setup";
  if (
    !["cold", "setup", "wake"].includes(purpose) ||
    !fixtures.includes(config.fixture) ||
    !instances.includes(config.instance) ||
    typeof session?.id !== "string" ||
    !ID.test(session.id) ||
    status?.previewId !== session.id ||
    !Number.isSafeInteger(status?.generation) ||
    status.generation < 1 ||
    !Number.isSafeInteger(status.sourceRevision) ||
    status.sourceRevision < 0 ||
    typeof backup?.id !== "string" ||
    !BACKUP_ID.test(backup.id) ||
    typeof backup.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(backup.sha256) ||
    !Number.isSafeInteger(backup.size) ||
    backup.size < 1 ||
    !Number.isSafeInteger(backup.sourceRevision) ||
    backup.sourceRevision < 0 ||
    backup.sourceRevision > status.sourceRevision ||
    !Number.isSafeInteger(backup.generation) ||
    backup.generation < 1 ||
    backup.generation > status.generation ||
    phase?.kind !== (cold ? "cold" : "wake") ||
    phase.generation !== status.generation
  )
    throw new Error("runtime_checkpoint_invalid");
  const pairs = [
    ["startRequestedAt", "containerReadyAt"],
    ...(cold
      ? [
          ["installStartAt", "installEndAt"],
          ["backupStartAt", "backupEndAt"],
        ]
      : [["restoreStartAt", "restoreEndAt"]]),
    ["serverStartAt", "serverReadyAt"],
  ];
  const times = {};
  for (const key of [...(phase.startedAt === undefined ? [] : ["startedAt"]), ...pairs.flat()]) {
    const value = phase[key],
      parsed = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
      throw new Error("runtime_checkpoint_invalid");
    times[key] = value;
  }
  for (const [start, end] of pairs) phaseDuration(times[start], times[end]);
  return {
    event: "runtime-checkpoint",
    purpose,
    fixture: config.fixture,
    instance: config.instance,
    sessionId: session.id,
    generation: status.generation,
    sourceRevision: status.sourceRevision,
    backupId: backup.id,
    backupSha256: backup.sha256,
    backupCompressedBytes: backup.size,
    backupSourceRevision: backup.sourceRevision,
    backupGeneration: backup.generation,
    ...times,
  };
}
function matching(status, config) {
  return (
    status?.config?.fixture === config.fixture &&
    status.config.instance === config.instance &&
    status.config.inactivityMs === config.inactivityMs &&
    status.config.cacheMode === config.provenance.packageCache &&
    Object.hasOwn(status.provenance ?? {}, "hmrOverlaySha256") &&
    config.provenance.hmrOverlaySha256 === hmrOverlaySha256(config.fixture) &&
    status.provenance.hmrOverlaySha256 === config.provenance.hmrOverlaySha256 &&
    [
      "workerVersionId",
      "sourceRevision",
      "fixtureSourceRevision",
      "fixtureArchiveSha256",
      "fixtureTreeSha256",
    ].every(
      (key) =>
        typeof config.provenance[key] === "string" &&
        status.provenance?.[key] === config.provenance[key],
    )
  );
}

/** Explicit dependencies make it possible to test without provider access. */
export function cloudflareAdapter({
  browser,
  token,
  verifyProvenance,
  verifyControlTarget,
  observeRead = () => {},
  resourceJournal,
  config,
  qa,
  fetchImpl = fetch,
  probeFactory = createBrowserProbe,
  journeyFactory = startCapabilityJourney,
  wait = delay,
  now = () => performance.now(),
}) {
  if (
    !browser ||
    typeof token !== "string" ||
    token.length < 32 ||
    typeof verifyProvenance !== "function" ||
    typeof verifyControlTarget !== "function" ||
    typeof resourceJournal?.append !== "function"
  )
    throw new Error("adapter_configuration_invalid");
  let main,
    page,
    cold,
    beforeWake,
    capabilityPage,
    journey,
    scopeVerified = false,
    checkpointAuditState = "ready",
    sequence = 0;
  const ids = new Set();
  const graceMs = 1000;
  const recordResource = (event) =>
    resourceJournal.append({ ...event, recordedAt: new Date().toISOString() });
  function invalidCheckpoint() {
    checkpointAuditState = "failed";
    throw new Error("runtime_checkpoint_invalid");
  }
  function captureCheckpoint(session, status, purpose) {
    if (checkpointAuditState !== "ready") throw new Error("runtime_checkpoint_write_unknown");
    try {
      return runtimeCheckpoint(session, status, config, purpose);
    } catch {
      return invalidCheckpoint();
    }
  }
  async function recordCheckpoint(checkpoint, signal) {
    if (checkpointAuditState !== "ready") throw new Error("runtime_checkpoint_write_unknown");
    checkpointAuditState = "writing";
    try {
      signal?.throwIfAborted();
      await recordResource(checkpoint);
      signal?.throwIfAborted();
    } catch {
      checkpointAuditState = "failed";
      throw new Error("runtime_checkpoint_write_unknown");
    }
    if (checkpointAuditState !== "writing") throw new Error("runtime_checkpoint_write_unknown");
    checkpointAuditState = "ready";
  }
  async function control(action, { id, body, method = "POST", signal, onDispatch } = {}) {
    if (method !== "GET" && checkpointAuditState !== "ready")
      throw new Error("runtime_checkpoint_write_unknown");
    const deadlineAt = now() + config.deadlineMs;
    if ((await verifyControlTarget({ signal, deadlineAt, now, phase: "control-before" })) !== true)
      throw new Error("control_target_unverified");
    const path = id
      ? `/__spike/sessions/${id}${action ? `/${action}` : ""}`
      : action === "lease"
        ? "/__spike/lease"
        : "/__spike/sessions";
    const mutating = method !== "GET";
    const operation = id ? action || "delete" : "create";
    const requestId = mutating ? ++sequence : null;
    if (mutating)
      await recordResource({
        event: "intent",
        operation,
        requestId,
        sessionId: id ?? null,
      });
    let value,
      failed = false;
    try {
      const request = {
        method,
        signal,
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      };
      signal?.throwIfAborted();
      // Private synchronous observation, after the preguard and synced intent.
      // Nothing is awaited between this timestamp and the actual fetch call.
      let requestFailed = false;
      try {
        if (method === "GET") {
          value = await readOnlyJson(`${CONTROL}${path}`, {
            label: action === "lease" ? "control-lease" : "control-status",
            fetcher: fetchImpl,
            headers: request.headers,
            signal,
            deadlineAt,
            now,
            maxBytes: 65536,
            observe: (event) => observeRead({ ...event, phase: "control-read" }),
          });
        } else {
          onDispatch?.();
          const response = await fetchImpl(`${CONTROL}${path}`, request);
          if (!response.ok) throw new Error("control_failed");
          const text = await response.text();
          if (text.length > 65536) throw new Error("control_response_invalid");
          value = JSON.parse(text);
        }
      } catch {
        requestFailed = true;
      }
      if ((await verifyControlTarget({ signal, deadlineAt, now, phase: "control-after" })) !== true)
        throw new Error("control_target_unverified");
      if (requestFailed) throw new Error("control_failed");
      if (
        !id &&
        action !== "lease" &&
        (!ID.test(value?.id ?? "") || !previewUrl(value.id, value.url))
      )
        throw new Error("session_invalid");
    } catch {
      failed = true;
    }
    if (mutating)
      await recordResource({
        event: "result",
        operation,
        requestId,
        sessionId: id ?? (!failed ? value.id : null),
        outcome: failed ? "unknown" : "confirmed",
      });
    if (failed) throw new Error("control_outcome_unknown");
    return value;
  }
  async function create(signal) {
    if (!scopeVerified) throw new Error("provenance_unverified");
    if ((await control("lease", { method: "GET", signal })) !== null)
      throw new Error("lease_occupied");
    const result = await control("", {
      body: {
        fixture: config.fixture,
        instance: config.instance,
        inactivityMs: config.inactivityMs,
        cacheMode: config.provenance.packageCache,
      },
      signal,
    });
    if (!ID.test(result?.id ?? "") || ids.has(result.id) || !previewUrl(result.id, result.url))
      throw new Error("session_invalid");
    ids.add(result.id);
    return { id: result.id, url: result.url };
  }
  const status = (session, signal) => control("status", { id: session.id, method: "GET", signal });
  async function waitSocket(probe, signal) {
    const deadline = Date.now() + Math.min(config.deadlineMs, 10000);
    while (!probe.socketOpen() && Date.now() < deadline) await wait(100, undefined, { signal });
    return probe.socketOpen();
  }
  async function openPage(session) {
    return probeFactory({
      browser,
      url: session.url,
      fixture: config.fixture,
      now,
      deadlineMs: config.deadlineMs,
    });
  }
  async function sendEdit(edit, signal, onDispatch) {
    const before = await status(main, signal);
    if (
      !matching(before, config) ||
      before.running !== true ||
      before.ready !== true ||
      !Number.isSafeInteger(before.generation) ||
      before.generation < 1 ||
      !Number.isSafeInteger(before.sourceRevision) ||
      before.sourceRevision < 0 ||
      !Number.isSafeInteger(before.sourceRevision + 1)
    )
      throw new Error("edit_identity_mismatch");
    const expectedHash = createHash("sha256").update(edit.content, "utf8").digest("hex");
    const receipt = await control("edit", { id: main.id, body: edit, signal, onDispatch });
    const after = await status(main, signal);
    if (
      !matching(after, config) ||
      after.running !== true ||
      after.ready !== true ||
      receipt?.contentSha256 !== expectedHash ||
      receipt.generation !== before.generation ||
      after.generation !== before.generation ||
      receipt.sourceRevision !== before.sourceRevision + 1 ||
      after.sourceRevision !== receipt.sourceRevision ||
      typeof receipt.writtenAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.writtenAt))
    )
      throw new Error("edit_receipt_unverified");
    return { controlConfirmed: true };
  }
  return {
    async verifyScope({ signal } = {}) {
      scopeVerified = false;
      if ((await fixtureTreeSha256(config.fixture)) !== config.provenance.fixtureTreeSha256)
        throw new Error("fixture_pin_mismatch");
      if (
        (await verifyProvenance(config.provenance, {
          fixture: config.fixture,
          instance: config.instance,
          signal,
          deadlineAt: now() + config.deadlineMs,
          now,
          observe: (event) => observeRead({ ...event, phase: "provenance" }),
        })) !== true
      )
        throw new Error("provenance_unverified");
      for (const session of [main, cold].filter(Boolean))
        if (!matching(await status(session, signal), config))
          throw new Error("runtime_identity_mismatch");
      scopeVerified = true;
      return { identityReadbackMatched: true };
    },
    async setup({ signal }) {
      main = await create(signal);
      const initialized = await control("setup", { id: main.id, signal });
      if (!matching(initialized, config) || !initialized.running || !initialized.ready)
        throw new Error("setup_unverified");
      await recordCheckpoint(captureCheckpoint(main, initialized, "setup"), signal);
      return {
        ready: true,
        backupVerified: hasBackup(initialized),
        identityReadbackMatched: scopeVerified,
      };
    },
    async capabilityBefore({ signal }) {
      if (journey) throw new Error("capability_journey_already_started");
      capabilityPage = await openPage(main);
      const observed = await capabilityPage.navigate({ signal });
      if (!observed.usable || !observed.sameUrl) throw new Error("capability_page_invalid");
      journey = await journeyFactory({
        browser,
        page: capabilityPage.page,
        fixture: config.fixture,
        url: main.url,
        sessionId: main.id,
        qa,
        signal,
        recordOperation: recordResource,
      });
      return journey.before;
    },
    async capabilityAfter({ signal }) {
      if (!journey) throw new Error("capability_journey_missing");
      return journey.finish({ signal });
    },
    async checkIdleTab({ inactivityMs, passiveObservationMs, signal }) {
      page = await openPage(main);
      await page.navigate({ signal });
      const socketConnectedBefore = await waitSocket(page, signal);
      const active = await status(main, signal);
      const sleepStart = now();
      await wait(inactivityMs + graceMs, undefined, { signal });
      const sleepWaitMs = now() - sleepStart;
      const asleep = await status(main, signal);
      const idleSleepObserved =
        matching(active, config) &&
        active.running === true &&
        active.ready === true &&
        matching(asleep, config) &&
        asleep.running === false &&
        asleep.lastStopReason === "idle";
      // Use the Worker's confirmed stop observation, never the client's wait or
      // a status-poll completion as a synthetic stop timestamp.
      const stoppedAt = typeof asleep.stoppedAt === "string" ? Date.parse(asleep.stoppedAt) : NaN;
      const sleepAfter = stoppedAt - active.lastUserActivityAt;
      const idleSleepAfterMs =
        idleSleepObserved &&
        Number.isSafeInteger(active.lastUserActivityAt) &&
        active.lastUserActivityAt >= 0 &&
        asleep.lastUserActivityAt === active.lastUserActivityAt &&
        Number.isFinite(stoppedAt) &&
        new Date(stoppedAt).toISOString() === asleep.stoppedAt &&
        Number.isFinite(sleepAfter) &&
        sleepAfter >= 0 &&
        sleepAfter <= 86_400_000
          ? sleepAfter
          : null;
      const passiveStart = now();
      await wait(passiveObservationMs, undefined, { signal });
      const passiveWaitMs = now() - passiveStart;
      const stillAsleep = await status(main, signal);
      const noPassiveWake =
        matching(stillAsleep, config) &&
        stillAsleep.running === false &&
        stillAsleep.generation === asleep.generation &&
        stillAsleep.wakeCount === asleep.wakeCount;
      if (!socketConnectedBefore || !idleSleepObserved || !noPassiveWake)
        return {
          socketConnectedBefore,
          idleSleepObserved,
          noPassiveWake,
          sleepWaitMs,
          passiveWaitMs,
          idleSleepAfterMs,
        };
      // Real pointer input creates a trusted browser event. Reconnect and status polling do not.
      const navigation = page.page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.page.mainFrame(),
        timeout: config.deadlineMs,
      });
      await page.page.locator("h1").click();
      await navigation;
      await page.waitUsable({ signal });
      const woken = await status(main, signal);
      const userWakeObserved =
        matching(woken, config) &&
        woken.running === true &&
        woken.ready === true &&
        woken.generation > asleep.generation &&
        woken.wakeCount > asleep.wakeCount;
      const socketAfter = await waitSocket(page, signal);
      await page.prepareEdit();
      const edited = await page.editAndObserve((edit, onDispatch) =>
        sendEdit(edit, signal, onDispatch),
      );
      // Keep the checkpoint current and restore the original fixture before repeated wake trials.
      await sendEdit(await fixtureOriginal(config.fixture), signal);
      await page.close();
      page = undefined;
      const backed = await control("backup", { id: main.id, signal });
      if (
        !matching(backed, config) ||
        !hasBackup(backed) ||
        backed.backup.sourceRevision !== backed.sourceRevision
      )
        throw new Error("backup_stale");
      return {
        socketConnectedBefore,
        idleSleepObserved,
        noPassiveWake,
        userWakeObserved,
        hmrAfterWake:
          socketAfter &&
          edited.visible &&
          edited.sameDocument &&
          edited.hmrUpdateObserved &&
          edited.dispatchObserved &&
          edited.paintObserved &&
          edited.controlConfirmed,
        sleepWaitMs,
        passiveWaitMs,
        idleSleepAfterMs,
      };
    },
    async coldStart({ signal }) {
      if (cold) throw new Error("cold_session_unsettled");
      cold = await create(signal);
      const initialized = await control("setup", { id: cold.id, signal });
      if (!matching(initialized, config) || !initialized.running || !initialized.ready)
        throw new Error("cold_setup_invalid");
      cold.checkpoint = captureCheckpoint(cold, initialized, "cold");
      cold.page = await openPage(cold);
      const observed = await cold.page.navigate({ signal });
      return {
        freshSession: true,
        noInstalledDependencies: initialized.coldProof?.noNodeModulesBeforeInstall === true,
        noBackupRestore:
          initialized.coldProof?.restored === false &&
          initialized.phases?.kind === "cold" &&
          Number.isFinite(
            phaseDuration(initialized.phases.installStartAt, initialized.phases.installEndAt),
          ),
        packageCache: initialized.coldProof?.cacheMode,
        usable: observed.usable === true && observed.sameUrl === true,
      };
    },
    async finishCold({ signal }) {
      if (!cold?.checkpoint) throw new Error("runtime_checkpoint_missing");
      if (cold.checkpointAttempted) throw new Error("runtime_checkpoint_write_unknown");
      cold.checkpointAttempted = true;
      // The caller has stopped the timer; sync the projection before any cleanup.
      await recordCheckpoint(cold.checkpoint, signal);
      cold.checkpoint = undefined;
      await cold.page.close();
      const deleted = await control("", { id: cold.id, method: "DELETE", signal });
      const released = await control("lease", { method: "GET", signal });
      cold = undefined;
      return {
        destroyed:
          deleted?.destroyed === true && deleted.backupDeleted === true && released === null,
      };
    },
    async prepareWake({ signal }) {
      if (page) await page.close();
      page = undefined;
      const running = await status(main, signal);
      if (
        !matching(running, config) ||
        running.running !== true ||
        running.ready !== true ||
        !hasBackup(running) ||
        running.backup.sourceRevision !== running.sourceRevision
      )
        throw new Error("manual_stop_not_ready");
      const stopped = await control("stop", { id: main.id, signal });
      beforeWake = await status(main, signal);
      const confirmed = [stopped, beforeWake].every(
        (value) =>
          matching(value, config) &&
          value.running === false &&
          value.ready === false &&
          value.lastStopReason === "manual" &&
          value.generation === running.generation &&
          value.stopGeneration === running.generation &&
          value.wakeCount === running.wakeCount &&
          typeof value.stoppedAt === "string" &&
          Number.isFinite(Date.parse(value.stoppedAt)) &&
          new Date(value.stoppedAt).toISOString() === value.stoppedAt &&
          hasBackup(value) &&
          value.backup.id === running.backup.id &&
          value.backup.sha256 === running.backup.sha256 &&
          value.backup.sourceRevision === value.sourceRevision &&
          value.sourceRevision === running.sourceRevision,
      );
      if (!confirmed || stopped.stoppedAt !== beforeWake.stoppedAt)
        throw new Error("manual_stop_unverified");
      return {
        sleepVerified: true,
        manualStopVerified: true,
        sleepInduction: "manual",
        backupVerified: true,
      };
    },
    async wake({ signal } = {}) {
      page = await openPage(main);
      return page.navigate({ signal });
    },
    async verifyWake({ signal }) {
      const observed = await status(main, signal);
      const identityMatched = matching(observed, config);
      let phases;
      try {
        phases = phasesFrom(observed);
      } catch {
        return invalidCheckpoint();
      }
      const proof = {
        newGeneration:
          identityMatched &&
          observed.generation > beforeWake.generation &&
          observed.wakeCount > beforeWake.wakeCount,
        restored:
          observed.running === true &&
          observed.ready === true &&
          hasBackup(observed) &&
          observed.backup.id === beforeWake.backup.id &&
          observed.backup.sha256 === beforeWake.backup.sha256 &&
          observed.sourceRevision === observed.backup.sourceRevision,
        phases,
      };
      try {
        if (journey) await journey.afterWake({ signal });
      } finally {
        if (identityMatched) {
          if (
            !hasBackup(observed) ||
            observed.backup.id !== beforeWake.backup.id ||
            observed.backup.sha256 !== beforeWake.backup.sha256 ||
            observed.backup.size !== beforeWake.backup.size ||
            observed.backup.generation !== beforeWake.backup.generation ||
            observed.backup.sourceRevision !== beforeWake.backup.sourceRevision
          )
            invalidCheckpoint();
          await recordCheckpoint(captureCheckpoint(main, observed, "wake"), signal);
        }
      }
      return proof;
    },
    async prepareHmr({ signal }) {
      if (!page || !(await waitSocket(page, signal))) return { ready: false };
      return page.prepareEdit();
    },
    async editAndObserve({ signal }) {
      return page.editAndObserve((edit, onDispatch) => sendEdit(edit, signal, onDispatch));
    },
    async finishRun({ signal }) {
      if (page) await page.close();
      page = undefined;
      if (journey) await journey.close();
      journey = undefined;
      if (capabilityPage) await capabilityPage.close();
      capabilityPage = undefined;
      const deleted = await control("", { id: main.id, method: "DELETE", signal });
      const released = await control("lease", { method: "GET", signal });
      main = undefined;
      return {
        destroyed: deleted?.destroyed === true && released === null,
        backupDeleted: deleted?.backupDeleted === true,
      };
    },
    async closeLocal() {
      if (page) await page.close().catch(() => {});
      if (cold?.page) await cold.page.close().catch(() => {});
      if (journey) await journey.close().catch(() => {});
      if (capabilityPage) await capabilityPage.close().catch(() => {});
      try {
        if (typeof qa?.close === "function") await qa.close();
      } finally {
        await browser.close();
      }
    },
  };
}

/** Local operator drivers supply a browser and independent provider readback. */
export async function createAdapter(config, { resourceJournal } = {}) {
  if (process.env.PREVIEW_SPIKE_PROVENANCE_DRIVER !== undefined)
    throw new Error("external_provenance_driver_unsupported");
  const browserDriver = process.env.PREVIEW_SPIKE_BROWSER_DRIVER;
  if (!browserDriver?.startsWith("/")) throw new Error("drivers_required");
  const qaDriver = process.env.PREVIEW_SPIKE_CAPABILITY_DRIVER;
  let qa;
  if (["next-native-auth", "next-app-mail"].includes(config.fixture)) {
    if (!qaDriver?.startsWith("/")) throw new Error("capability_driver_required");
    const module = await import(pathToFileURL(await realpath(qaDriver)).href);
    if (typeof module.createQaAdapter !== "function") throw new Error("capability_driver_invalid");
    qa = await module.createQaAdapter({ fixture: config.fixture });
    if (
      !qa ||
      typeof qa.readInbox !== "function" ||
      (config.fixture === "next-native-auth" && typeof qa.auth !== "function") ||
      (config.fixture === "next-app-mail" &&
        (typeof qa.mail !== "function" || typeof qa.armMail !== "function"))
    ) {
      if (typeof qa?.close === "function") await qa.close();
      throw new Error("capability_driver_invalid");
    }
  }
  let browser;
  try {
    const browserModule = await import(pathToFileURL(await realpath(browserDriver)).href);
    if (typeof browserModule.openBrowser !== "function") throw new Error("drivers_invalid");
    browser = await browserModule.openBrowser();
    return cloudflareAdapter({
      browser,
      token: process.env.SPIKE_CONTROL_TOKEN,
      verifyProvenance: verify,
      verifyControlTarget: ({ signal, deadlineAt, now, phase } = {}) =>
        assertControlTarget({
          accountId: config.provenance.accountId,
          zoneId: "0000000000000000000000000000000b",
          routeId: process.env.PREVIEW_SPIKE_ROUTE_ID,
          workerVersionId: config.provenance.workerVersionId,
          token: process.env.CLOUDFLARE_API_TOKEN,
          signal,
          deadlineAt,
          now,
          observe: (event) =>
            resourceJournal.append({ ...event, phase, recordedAt: new Date().toISOString() }),
        }),
      observeRead: (event) =>
        resourceJournal.append({ ...event, recordedAt: new Date().toISOString() }),
      resourceJournal,
      config,
      qa,
    });
  } catch (error) {
    if (browser) await browser.close();
    if (typeof qa?.close === "function") await qa.close();
    throw error;
  }
}
