import { hmrOverlaySha256, hmrWorkload } from "../worker/container/hmr-probe.mjs";

export const fixtures = Object.freeze([
  "react-vite",
  "vanilla-vite",
  "tanstack-start",
  "next-edge",
  "astro-edge",
  "next-native-auth",
  "next-app-mail",
]);
export const instances = Object.freeze(["basic", "standard-1", "standard-2", "standard-3"]);
export const states = Object.freeze(["cold", "wake", "hmr"]);
export function statesForFixture(fixture) {
  return fixture.startsWith("next-") ? states : ["wake", "hmr"];
}
export function capabilityFields(fixture, check) {
  if (!fixtures.includes(fixture) || !["capability_before", "capability_after"].includes(check))
    throw new Error("capability_scope_invalid");
  return [
    "databaseCrud",
    ...(fixture === "next-native-auth"
      ? check === "capability_before"
        ? ["twoUserAuth", "userIsolation"]
        : ["authAfterWake", "authAfterEdit", "authLogout"]
      : []),
    ...(fixture === "next-app-mail" ? ["mailReceiptMatched", "mailDeliveredOnce"] : []),
  ];
}
const outcomes = new Set(["pass", "reload", "error", "timeout", "invalid_evidence"]);

// Nearest-rank empirical quantile. With 20 observations p50 is rank 10 and p95 rank 19.
export function percentile(values, probability) {
  if (!Array.isArray(values) || !values.length || !(probability > 0 && probability <= 1))
    throw new Error("percentile_input_invalid");
  if (values.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("percentile_input_invalid");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(probability * sorted.length) - 1];
}

export function validateConfig(config) {
  const provenance = config?.provenance;
  if (
    !config ||
    !fixtures.includes(config.fixture) ||
    !instances.includes(config.instance) ||
    !Number.isSafeInteger(config.samples) ||
    config.samples < 20 ||
    config.samples > 1000 ||
    !Number.isSafeInteger(config.inactivityMs) ||
    config.inactivityMs < 5000 ||
    !Number.isSafeInteger(config.passiveObservationMs) ||
    config.passiveObservationMs < 1000 ||
    !Number.isSafeInteger(config.deadlineMs) ||
    config.deadlineMs < 1 ||
    config.deadlineMs > 86_400_000 ||
    !provenance ||
    !/^[a-f0-9]{40}$/u.test(provenance.sourceRevision ?? "") ||
    !/^[a-f0-9]{40}$/u.test(provenance.fixtureSourceRevision ?? "") ||
    !/^[a-f0-9]{64}$/u.test(provenance.fixtureArchiveSha256 ?? "") ||
    !Object.hasOwn(provenance, "hmrOverlaySha256") ||
    provenance.hmrOverlaySha256 !== hmrOverlaySha256(config.fixture) ||
    !/^[a-f0-9]{64}$/u.test(provenance.fixtureTreeSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(provenance.imageSha256 ?? "") ||
    !/^[a-f0-9]{32}$/u.test(provenance.accountId ?? "") ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u.test(
      provenance.containerApplicationId ?? "",
    ) ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(provenance.workerVersionId ?? "") ||
    !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(provenance.sandboxSdkVersion ?? "") ||
    !["seeded", "empty"].includes(provenance.packageCache)
  )
    throw new Error("configuration_invalid");
}

const requiredEvidence = {
  provenance: ["identityReadbackMatched"],
  provenance_final: ["identityReadbackMatched"],
  setup: [
    "ready",
    "backupVerified",
    "identityReadbackMatched",
    "identityReadbackBefore",
    "identityReadbackAfter",
  ],
  idle_tab: [
    "socketConnectedBefore",
    "idleSleepObserved",
    "noPassiveWake",
    "userWakeObserved",
    "hmrAfterWake",
    "identityReadbackBefore",
    "identityReadbackAfter",
  ],
  cold: [
    "freshSession",
    "noInstalledDependencies",
    "noBackupRestore",
    "packageCacheVerified",
    "usable",
    "destroyed",
    "identityReadbackBefore",
    "identityReadbackAfter",
  ],
  wake: [
    "sleepVerified",
    "manualStopVerified",
    "backupVerified",
    "usable",
    "sameUrl",
    "restored",
    "newGeneration",
    "identityReadbackBefore",
    "identityReadbackAfter",
  ],
  hmr: [
    "visible",
    "sameDocument",
    "hmrUpdateObserved",
    "dispatchObserved",
    "paintObserved",
    "controlConfirmed",
    "identityReadbackBefore",
    "identityReadbackAfter",
  ],
};
function validEvidence(value, kind) {
  return value && requiredEvidence[kind].every((key) => value[key] === true);
}

function validDuration(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 86_400_000;
}

/** Fail closed on missing, duplicated, malformed or unplanned observations. */
export function evaluate(events) {
  if (!Array.isArray(events)) throw new Error("journal_invalid");
  const starts = events.filter((event) => event?.event === "run_start");
  if (starts.length !== 1 || starts[0].schemaVersion !== 6) throw new Error("journal_invalid");
  const run = starts[0];
  validateConfig(run);
  if (
    !Object.hasOwn(run.provenance, "hmrOverlaySha256") ||
    run.provenance.hmrOverlaySha256 !== hmrOverlaySha256(run.fixture) ||
    run.hmrWorkload !== hmrWorkload(run.fixture)
  )
    throw new Error("journal_invalid");
  const allowedEvents = new Set([
    "run_start",
    "preflight_start",
    "preflight_result",
    "sample_start",
    "sample_result",
    "cleanup_start",
    "cleanup_result",
    "run_end",
  ]);
  const malformed = events.some(
    (event) =>
      !allowedEvents.has(event?.event) ||
      typeof event.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(event.recordedAt)) ||
      new Date(event.recordedAt).toISOString() !== event.recordedAt,
  );
  const ends = events.filter((event) => event?.event === "run_end");
  const provenanceStarts = events.filter(
    (event) => event?.event === "preflight_start" && event.check === "provenance",
  );
  const provenanceResults = events.filter(
    (event) => event?.event === "preflight_result" && event.check === "provenance",
  );
  const finalProvenanceStarts = events.filter(
    (event) => event?.event === "preflight_start" && event.check === "provenance_final",
  );
  const finalProvenanceResults = events.filter(
    (event) => event?.event === "preflight_result" && event.check === "provenance_final",
  );
  const idleTabStarts = events.filter(
    (event) => event?.event === "preflight_start" && event.check === "idle_tab",
  );
  const idleTabResults = events.filter(
    (event) => event?.event === "preflight_result" && event.check === "idle_tab",
  );
  const setupStarts = events.filter(
    (event) => event?.event === "preflight_start" && event.check === "setup",
  );
  const setupResults = events.filter(
    (event) => event?.event === "preflight_result" && event.check === "setup",
  );
  const unexpectedPreflights = events.some(
    (event) =>
      ["preflight_start", "preflight_result"].includes(event?.event) &&
      ![
        "provenance",
        "provenance_final",
        "setup",
        "idle_tab",
        "capability_before",
        "capability_after",
      ].includes(event.check),
  );
  const capabilitiesPassed = ["capability_before", "capability_after"].every((check) => {
    const start = events.filter(
      (event) => event?.event === "preflight_start" && event.check === check,
    );
    const result = events.filter(
      (event) => event?.event === "preflight_result" && event.check === check,
    );
    return (
      start.length === 1 &&
      result.length === 1 &&
      result[0].outcome === "pass" &&
      [
        ...capabilityFields(run.fixture, check),
        "identityReadbackBefore",
        "identityReadbackAfter",
      ].every((key) => result[0].evidence?.[key] === true)
    );
  });
  const identityReadbackPassed =
    provenanceStarts.length === 1 &&
    provenanceResults.length === 1 &&
    provenanceResults[0].outcome === "pass" &&
    validEvidence(provenanceResults[0].evidence, "provenance") &&
    finalProvenanceStarts.length === 1 &&
    finalProvenanceResults.length === 1 &&
    finalProvenanceResults[0].outcome === "pass" &&
    validEvidence(finalProvenanceResults[0].evidence, "provenance_final");
  const setupPassed =
    setupStarts.length === 1 &&
    setupResults.length === 1 &&
    setupResults[0].outcome === "pass" &&
    validEvidence(setupResults[0].evidence, "setup");
  const idleTabPassed =
    idleTabStarts.length === 1 &&
    idleTabResults.length === 1 &&
    idleTabResults[0].outcome === "pass" &&
    validEvidence(idleTabResults[0].evidence, "idle_tab") &&
    ["observedMs", "sleepWaitMs", "passiveWaitMs"].every((key) =>
      validDuration(idleTabResults[0][key]),
    ) &&
    idleTabResults[0].observedMs >= run.inactivityMs &&
    idleTabResults[0].observedMs >=
      idleTabResults[0].sleepWaitMs + idleTabResults[0].passiveWaitMs &&
    idleTabResults[0].sleepWaitMs >= run.inactivityMs &&
    idleTabResults[0].passiveWaitMs >= run.passiveObservationMs;
  const summary = {};
  const activeStates = statesForFixture(run.fixture);
  let integrity =
    !malformed &&
    run.hmrTimingBoundary === "file-write-request-dispatch-to-visible-marker-and-two-raf" &&
    run.sleepInduction === "manual" &&
    !unexpectedPreflights &&
    ends.length === 1 &&
    ends[0].outcome === "complete" &&
    events.filter((event) => event?.event === "cleanup_start").length === 1 &&
    events.filter((event) => event?.event === "cleanup_result" && event.outcome === "pass")
      .length === 1 &&
    identityReadbackPassed &&
    setupPassed &&
    capabilitiesPassed &&
    idleTabPassed;
  const sampleEvents = (state) =>
    Array.from({ length: run.samples }, (_, index) => [
      ["sample_start", state, index + 1],
      ["sample_result", state, index + 1],
    ]).flat();
  const ordered = [
    ["run_start", undefined],
    ["preflight_start", "provenance"],
    ["preflight_result", "provenance"],
    ...(activeStates.includes("cold") ? sampleEvents("cold") : []),
    ["preflight_start", "setup"],
    ["preflight_result", "setup"],
    ["preflight_start", "capability_before"],
    ["preflight_result", "capability_before"],
    ["preflight_start", "idle_tab"],
    ["preflight_result", "idle_tab"],
    ...sampleEvents("wake"),
    ...sampleEvents("hmr"),
    ["preflight_start", "capability_after"],
    ["preflight_result", "capability_after"],
    ["cleanup_start", undefined],
    ["cleanup_result", undefined],
    ["preflight_start", "provenance_final"],
    ["preflight_result", "provenance_final"],
    ["run_end", undefined],
  ];
  if (
    events.length !== ordered.length ||
    ordered.some(([name, scope, sample], index) => {
      const event = events[index];
      return (
        event?.event !== name ||
        (name.startsWith("preflight_") && event.check !== scope) ||
        (name.startsWith("sample_") && (event.state !== scope || event.sample !== sample))
      );
    })
  )
    integrity = false;
  for (const state of activeStates) {
    const stateStarts = events.filter(
      (event) => event?.event === "sample_start" && event.state === state,
    );
    const stateResults = events.filter(
      (event) => event?.event === "sample_result" && event.state === state,
    );
    const results = [];
    for (let sample = 1; sample <= run.samples; sample += 1) {
      const begun = stateStarts.filter((event) => event.sample === sample);
      const finished = stateResults.filter((event) => event.sample === sample);
      if (begun.length !== 1 || finished.length !== 1) {
        integrity = false;
        results.push({ sample, outcome: begun.length ? "interrupted" : "not_started" });
        continue;
      }
      const item = finished[0];
      if (
        !outcomes.has(item.outcome) ||
        (item.outcome === "pass" && !validDuration(item.elapsedMs)) ||
        (item.outcome === "pass" && !validEvidence(item.evidence, state)) ||
        (item.outcome === "pass" &&
          state === "hmr" &&
          (!validDuration(item.editToPaintMs) ||
            item.elapsedMs !== item.editToPaintMs ||
            !validDuration(item.operatorElapsedMs) ||
            item.operatorElapsedMs < item.editToPaintMs)) ||
        (item.outcome === "pass" && state === "wake" && item.sleepInduction !== "manual") ||
        (item.outcome === "pass" &&
          state === "wake" &&
          !["containerStartMs", "restoreMs", "serverStartMs"].every((name) =>
            validDuration(item.phases?.[name]),
          )) ||
        (item.elapsedMs !== null && !validDuration(item.elapsedMs)) ||
        events.indexOf(begun[0]) >= events.indexOf(item)
      ) {
        integrity = false;
        results.push({ sample, outcome: "invalid_evidence" });
        continue;
      }
      results.push({
        sample,
        outcome: item.outcome,
        elapsedMs: item.elapsedMs,
        ...(state === "hmr"
          ? { editToPaintMs: item.editToPaintMs, operatorElapsedMs: item.operatorElapsedMs }
          : {}),
      });
    }
    if (
      stateStarts.length !== run.samples ||
      stateResults.length !== run.samples ||
      stateStarts.some(
        (item) =>
          !Number.isSafeInteger(item.sample) || item.sample < 1 || item.sample > run.samples,
      ) ||
      stateResults.some(
        (item) =>
          !Number.isSafeInteger(item.sample) || item.sample < 1 || item.sample > run.samples,
      )
    )
      integrity = false;
    const successful = results
      .filter((item) => item.outcome === "pass")
      .map((item) => item.elapsedMs);
    const failures = results.length - successful.length;
    // Success-only numbers are descriptive; any failure prevents a valid acceptance result.
    summary[state] = {
      expected: run.samples,
      succeeded: successful.length,
      failures,
      successOnly: successful.length
        ? { p50Ms: percentile(successful, 0.5), p95Ms: percentile(successful, 0.95) }
        : null,
      results,
    };
  }
  if (
    events.some(
      (event) =>
        ["sample_start", "sample_result"].includes(event?.event) &&
        !activeStates.includes(event.state),
    )
  )
    integrity = false;
  const targets = {
    cold: { p95Ms: 60000 },
    hmr: { p50Ms: 1000, p95Ms: 3000 },
    wake: run.fixture.includes("vite")
      ? { p50Ms: 5000, p95Ms: 10000 }
      : run.fixture.startsWith("next-")
        ? { p50Ms: 10000, p95Ms: 20000 }
        : null,
  };
  for (const state of activeStates) {
    const entry = summary[state],
      target = targets[state];
    entry.latencyTargetMet =
      !integrity || entry.failures > 0
        ? false
        : target === null
          ? null
          : (target.p50Ms === undefined || entry.successOnly.p50Ms <= target.p50Ms) &&
            entry.successOnly.p95Ms <= target.p95Ms;
    // A passing transport timer cannot establish DB, Auth or Mail capability.
    entry.acceptance = entry.latencyTargetMet === false ? false : null;
  }
  const idlePolicyTargetMet = idleTabPassed && run.inactivityMs === 600000;
  const idleSleepAfterMs =
    idleTabPassed && validDuration(idleTabResults[0].idleSleepAfterMs)
      ? idleTabResults[0].idleSleepAfterMs
      : null;
  const idleStopDelayMs = idleSleepAfterMs === null ? null : idleSleepAfterMs - run.inactivityMs;
  const idleTimingQualification =
    run.inactivityMs !== 600000
      ? "characterization-only"
      : idleSleepAfterMs === null
        ? "unobserved-stop-time"
        : idleStopDelayMs < 0
          ? "invalid-stop-before-policy-deadline"
          : idleStopDelayMs > 0
            ? "incomplete-no-agreed-jitter-tolerance"
            : "observed-at-policy-deadline";
  const idleTabTargetMet =
    idlePolicyTargetMet && idleTimingQualification === "observed-at-policy-deadline";
  const measurements = Object.values(summary);
  const observationsComplete = integrity && measurements.every((state) => state.failures === 0);
  const frameworkTargets =
    !observationsComplete ||
    idleTimingQualification === "invalid-stop-before-policy-deadline" ||
    measurements.some((state) => state.latencyTargetMet === false)
      ? "failed"
      : !idleTabTargetMet || measurements.some((state) => state.latencyTargetMet === null)
        ? "incomplete"
        : "passed";
  return {
    fixture: run.fixture,
    instance: run.instance,
    samples: run.samples,
    provenance: run.provenance,
    startedAt: run.recordedAt,
    inactivityMs: run.inactivityMs,
    passiveObservationMs: run.passiveObservationMs,
    wakeSleepInduction: run.sleepInduction === "manual" ? "manual" : null,
    hmrTimingBoundary: run.hmrTimingBoundary,
    hmrWorkload: run.hmrWorkload,
    nativeFixtureHmrAcceptance:
      run.hmrWorkload === "instrumented-self-accepting-module" ? null : undefined,
    integrity,
    identityReadbackPassed,
    provenanceEvidenceLevel: "provider-readback-and-operator-source-claim",
    provenanceReadbackWindow: "before-and-after-each-preflight-and-sample",
    cryptographicBuildAttestation: false,
    setupPassed,
    capabilitiesPassed,
    idleTabPassed,
    idleTabTargetMet,
    idlePolicyTargetMet,
    idleSleepAfterMs,
    idleStopDelayMs,
    idleTimingQualification,
    idleJitterToleranceMs: null,
    observationsComplete,
    frameworkTargets,
    idleEvidenceScope: "configured-inactivity-and-passive-observation-windows-only",
    measurementScope: "isolated-development-fixture-capabilities",
    overallAcceptance: "incomplete",
    percentileMethod: "nearest-rank",
    states: summary,
  };
}
