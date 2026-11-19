/* global AbortController, setTimeout, clearTimeout */
import { performance } from "node:perf_hooks";
import { capabilityFields, statesForFixture, validateConfig } from "./statistics.mjs";
import { hmrWorkload } from "../worker/container/hmr-probe.mjs";

class Deadline extends Error {}

async function bounded(operation, milliseconds) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Deadline());
          controller.abort();
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const failure = (error) => (error instanceof Deadline ? "timeout" : "error");
const duration = (start, now) => Math.max(0, now() - start);
const phaseNames = ["containerStartMs", "restoreMs", "serverStartMs"];
function safePhases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const name of phaseNames) {
    if (!Number.isFinite(value[name]) || value[name] < 0 || value[name] > 86_400_000) return null;
    result[name] = value[name];
  }
  return result;
}

/**
 * The adapter owns the actual provider and browser. Every intent is synced before
 * the operation starts. Provider responses, URLs, error text and credentials never
 * enter the journal. An uncertain error ends the run, with no automatic replay.
 */
export async function runBenchmark({
  adapter,
  journal,
  config,
  now = () => performance.now(),
  utcNow = () => new Date(),
}) {
  validateConfig(config);
  if (!journal || typeof journal.append !== "function") throw new Error("journal_required");
  const record = (event) => journal.append({ ...event, recordedAt: utcNow().toISOString() });
  await record({
    event: "run_start",
    schemaVersion: 6,
    hmrTimingBoundary: "file-write-request-dispatch-to-visible-marker-and-two-raf",
    hmrWorkload: hmrWorkload(config.fixture),
    sleepInduction: "manual",
    fixture: config.fixture,
    instance: config.instance,
    samples: config.samples,
    inactivityMs: config.inactivityMs,
    passiveObservationMs: config.passiveObservationMs,
    deadlineMs: config.deadlineMs,
    provenance: {
      sourceRevision: config.provenance.sourceRevision,
      fixtureSourceRevision: config.provenance.fixtureSourceRevision,
      fixtureArchiveSha256: config.provenance.fixtureArchiveSha256,
      fixtureTreeSha256: config.provenance.fixtureTreeSha256,
      hmrOverlaySha256: config.provenance.hmrOverlaySha256,
      imageSha256: config.provenance.imageSha256,
      accountId: config.provenance.accountId,
      containerApplicationId: config.provenance.containerApplicationId,
      workerVersionId: config.provenance.workerVersionId,
      sandboxSdkVersion: config.provenance.sandboxSdkVersion,
      packageCache: config.provenance.packageCache,
    },
  });
  let stopped = false;
  async function requireIdentity(signal) {
    const result = await adapter.verifyScope({ ...config, signal });
    if (result?.identityReadbackMatched !== true) throw new Error("identity_readback_mismatch");
    return true;
  }
  async function preflight(check) {
    await record({ event: "preflight_start", check });
    const started = now();
    let result;
    try {
      const value = await bounded(
        async (signal) => {
          if (["provenance", "provenance_final"].includes(check))
            return { identityReadbackMatched: await requireIdentity(signal) };
          await requireIdentity(signal);
          let value;
          if (check === "setup") value = await adapter.setup({ ...config, signal });
          else if (check === "capability_before")
            value = await adapter.capabilityBefore({ signal });
          else if (check === "capability_after") value = await adapter.capabilityAfter({ signal });
          else
            value = await adapter.checkIdleTab({
              inactivityMs: config.inactivityMs,
              passiveObservationMs: config.passiveObservationMs,
              signal,
            });
          await requireIdentity(signal);
          return { ...value, identityReadbackBefore: true, identityReadbackAfter: true };
        },
        config.deadlineMs +
          (check === "idle_tab" ? config.inactivityMs + config.passiveObservationMs : 0),
      );
      const observedMs = duration(started, now);
      const evidence = ["provenance", "provenance_final"].includes(check)
        ? { identityReadbackMatched: value?.identityReadbackMatched === true }
        : check === "setup"
          ? {
              ready: value?.ready === true,
              backupVerified: value?.backupVerified === true,
              identityReadbackMatched: value?.identityReadbackMatched === true,
              identityReadbackBefore: value?.identityReadbackBefore === true,
              identityReadbackAfter: value?.identityReadbackAfter === true,
            }
          : check.startsWith("capability_")
            ? Object.fromEntries(
                [
                  ...capabilityFields(config.fixture, check),
                  "identityReadbackBefore",
                  "identityReadbackAfter",
                ].map((key) => [key, value?.[key] === true]),
              )
            : {
                socketConnectedBefore: value?.socketConnectedBefore === true,
                idleSleepObserved: value?.idleSleepObserved === true,
                noPassiveWake: value?.noPassiveWake === true,
                userWakeObserved: value?.userWakeObserved === true,
                hmrAfterWake: value?.hmrAfterWake === true,
                identityReadbackBefore: value?.identityReadbackBefore === true,
                identityReadbackAfter: value?.identityReadbackAfter === true,
              };
      const timingsValid =
        check !== "idle_tab" ||
        (Number.isFinite(value?.sleepWaitMs) &&
          value.sleepWaitMs >= config.inactivityMs &&
          Number.isFinite(value?.passiveWaitMs) &&
          value.passiveWaitMs >= config.passiveObservationMs &&
          observedMs >= value.sleepWaitMs + value.passiveWaitMs &&
          observedMs >= config.inactivityMs);
      const pass = Object.values(evidence).every(Boolean) && timingsValid;
      result = {
        event: "preflight_result",
        check,
        outcome: pass ? "pass" : "invalid_evidence",
        observedMs,
        evidence,
        ...(check === "idle_tab" && timingsValid
          ? {
              sleepWaitMs: value.sleepWaitMs,
              passiveWaitMs: value.passiveWaitMs,
              idleSleepAfterMs:
                Number.isFinite(value.idleSleepAfterMs) &&
                value.idleSleepAfterMs >= 0 &&
                value.idleSleepAfterMs <= 86_400_000
                  ? value.idleSleepAfterMs
                  : null,
            }
          : {}),
      };
      stopped = !pass;
    } catch (error) {
      result = {
        event: "preflight_result",
        check,
        outcome: failure(error),
        observedMs: duration(started, now),
      };
      stopped = true;
    }
    // Do not catch a journal failure as a provider failure or start another mutation.
    await record(result);
  }
  async function sampleState(state) {
    for (let sample = 1; sample <= config.samples; sample += 1) {
      await record({ event: "sample_start", state, sample });
      let stage = "provenance_before";
      let elapsedMs = null;
      let editToPaintMs = null,
        operatorElapsedMs = null;
      let sleepInduction = null;
      let outcome = "invalid_evidence";
      let evidence = {};
      let phases = {};
      let identityReadbackBefore = false,
        identityReadbackAfter = false;
      try {
        identityReadbackBefore = await bounded(requireIdentity, config.deadlineMs);
        stage = state === "wake" ? "sleep" : state === "cold" ? "cold_start" : "prepare";
        if (state === "cold") {
          const start = now();
          const observed = await bounded(
            (signal) => adapter.coldStart({ sample, signal }),
            config.deadlineMs,
          );
          elapsedMs = duration(start, now);
          stage = "provenance_after_measurement";
          await bounded(requireIdentity, config.deadlineMs);
          stage = "cold_cleanup";
          const proof = await bounded(
            (signal) => adapter.finishCold({ signal }),
            config.deadlineMs,
          );
          evidence = {
            freshSession: observed?.freshSession === true,
            noInstalledDependencies: observed?.noInstalledDependencies === true,
            noBackupRestore: observed?.noBackupRestore === true,
            packageCacheVerified: observed?.packageCache === config.provenance.packageCache,
            usable: observed?.usable === true,
            destroyed: proof?.destroyed === true,
          };
          if (Object.values(evidence).every(Boolean)) outcome = "pass";
          if (!evidence.destroyed) stopped = true;
        } else {
          const prepared = await bounded(
            (signal) =>
              state === "wake" ? adapter.prepareWake({ signal }) : adapter.prepareHmr({ signal }),
            config.deadlineMs,
          );
          if (state === "wake") {
            sleepInduction = prepared?.sleepInduction === "manual" ? "manual" : null;
            if (
              sleepInduction !== "manual" ||
              prepared?.manualStopVerified !== true ||
              prepared?.sleepVerified !== true ||
              prepared?.backupVerified !== true
            )
              throw new Error("manual_stop_unverified");
          }
          if (
            state === "wake" &&
            prepared?.sleepVerified === true &&
            prepared?.manualStopVerified === true &&
            prepared?.backupVerified === true
          ) {
            stage = "wake";
            const start = now();
            const observed = await bounded((signal) => adapter.wake({ signal }), config.deadlineMs);
            elapsedMs = duration(start, now);
            stage = "verify";
            const proof = await bounded(
              (signal) => adapter.verifyWake({ signal }),
              config.deadlineMs,
            );
            const validPhases = safePhases(proof?.phases);
            evidence = {
              sleepVerified: true,
              manualStopVerified: true,
              backupVerified: true,
              usable: observed?.usable === true,
              sameUrl: observed?.sameUrl === true,
              restored: proof?.restored === true,
              newGeneration: proof?.newGeneration === true,
            };
            if (Object.values(evidence).every(Boolean) && validPhases !== null) {
              outcome = "pass";
              phases = validPhases;
            }
          } else if (state === "hmr" && prepared?.ready === true) {
            stage = "edit";
            const start = now();
            let observed;
            try {
              observed = await bounded(
                (signal) => adapter.editAndObserve({ sample, signal }),
                config.deadlineMs,
              );
            } finally {
              operatorElapsedMs = duration(start, now);
            }
            evidence = {
              visible: observed?.visible === true,
              sameDocument: observed?.sameDocument === true,
              hmrUpdateObserved: observed?.hmrUpdateObserved === true,
              dispatchObserved: observed?.dispatchObserved === true,
              paintObserved: observed?.paintObserved === true,
              controlConfirmed: observed?.controlConfirmed === true,
            };
            if (
              evidence.dispatchObserved &&
              evidence.paintObserved &&
              evidence.controlConfirmed &&
              Number.isFinite(observed?.editToPaintMs) &&
              observed.editToPaintMs >= 0 &&
              observed.editToPaintMs <= 86_400_000 &&
              observed.editToPaintMs <= operatorElapsedMs
            )
              elapsedMs = editToPaintMs = observed.editToPaintMs;
            if (evidence.visible && !evidence.sameDocument) outcome = "reload";
            else if (Object.values(evidence).every(Boolean) && editToPaintMs !== null)
              outcome = "pass";
          }
        }
        stage = "provenance_after";
        identityReadbackAfter = await bounded(requireIdentity, config.deadlineMs);
      } catch (error) {
        outcome = failure(error);
        stopped = true;
      }
      await record({
        event: "sample_result",
        state,
        sample,
        outcome,
        ...(state === "wake" ? { sleepInduction } : {}),
        elapsedMs,
        ...(state === "hmr" ? { editToPaintMs, operatorElapsedMs } : {}),
        stage,
        evidence: { ...evidence, identityReadbackBefore, identityReadbackAfter },
        phases,
      });
      if (stopped) break;
    }
  }
  await preflight("provenance");
  if (!stopped && statesForFixture(config.fixture).includes("cold")) await sampleState("cold");
  if (!stopped) await preflight("setup");
  if (!stopped) await preflight("capability_before");
  if (!stopped) await preflight("idle_tab");
  if (!stopped) await sampleState("wake");
  if (!stopped) await sampleState("hmr");
  if (!stopped) await preflight("capability_after");
  if (!stopped) {
    await record({ event: "cleanup_start" });
    let cleanup;
    try {
      const result = await bounded((signal) => adapter.finishRun({ signal }), config.deadlineMs);
      cleanup = {
        event: "cleanup_result",
        outcome:
          result?.destroyed === true && result?.backupDeleted === true
            ? "pass"
            : "invalid_evidence",
      };
    } catch (error) {
      cleanup = { event: "cleanup_result", outcome: failure(error) };
    }
    await record(cleanup);
    stopped = cleanup.outcome !== "pass";
  }
  if (!stopped) await preflight("provenance_final");
  await record({ event: "run_end", outcome: stopped ? "interrupted" : "complete" });
  return { completed: !stopped };
}
