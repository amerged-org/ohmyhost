/* global structuredClone, process, URL, setTimeout */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJournal, readJournal, recoverJournal } from "./journal.mjs";
import { runBenchmark } from "./runner.mjs";
import { evaluate, percentile } from "./statistics.mjs";
import { hmrOverlaySha256 } from "../worker/container/hmr-probe.mjs";

const config = {
  fixture: "next-edge",
  instance: "standard-2",
  samples: 20,
  inactivityMs: 5000,
  passiveObservationMs: 1000,
  deadlineMs: 100,
  provenance: {
    sourceRevision: "a".repeat(40),
    fixtureSourceRevision: "e".repeat(40),
    fixtureArchiveSha256: "f".repeat(64),
    fixtureTreeSha256: "b".repeat(64),
    hmrOverlaySha256: null,
    imageSha256: "c".repeat(64),
    accountId: "d".repeat(32),
    containerApplicationId: "e".repeat(32),
    workerVersionId: "12345678-1234-1234-1234-123456789abc",
    sandboxSdkVersion: "1.0.0",
    packageCache: "seeded",
  },
};
function simulation() {
  let clock = 0;
  let wake = 0;
  let edit = 0;
  const events = [];
  return {
    events,
    now: () => clock,
    journal: { append: async (event) => events.push(event) },
    adapter: {
      verifyScope: async () => ({ identityReadbackMatched: true }),
      setup: async () => ({ ready: true, backupVerified: true, identityReadbackMatched: true }),
      capabilityBefore: async () => ({
        databaseCrud: true,
        twoUserAuth: true,
        userIsolation: true,
        mailReceiptMatched: true,
        mailDeliveredOnce: true,
      }),
      capabilityAfter: async () => ({
        databaseCrud: true,
        authAfterWake: true,
        authAfterEdit: true,
        authLogout: true,
        mailReceiptMatched: true,
        mailDeliveredOnce: true,
      }),
      checkIdleTab: async ({ inactivityMs, passiveObservationMs }) => {
        clock += inactivityMs + passiveObservationMs;
        return {
          socketConnectedBefore: true,
          idleSleepObserved: true,
          noPassiveWake: true,
          userWakeObserved: true,
          hmrAfterWake: true,
          sleepWaitMs: inactivityMs,
          passiveWaitMs: passiveObservationMs,
          idleSleepAfterMs: inactivityMs,
        };
      },
      coldStart: async () => {
        clock += 30000;
        return {
          freshSession: true,
          noInstalledDependencies: true,
          noBackupRestore: true,
          packageCache: "seeded",
          usable: true,
        };
      },
      finishCold: async () => ({ destroyed: true }),
      finishRun: async () => ({ destroyed: true, backupDeleted: true }),
      prepareWake: async () => ({
        sleepVerified: true,
        manualStopVerified: true,
        backupVerified: true,
        sleepInduction: "manual",
      }),
      wake: async () => {
        clock += ++wake * 100;
        return { usable: true, sameUrl: true };
      },
      verifyWake: async () => ({
        restored: true,
        newGeneration: true,
        phases: { containerStartMs: 4, restoreMs: 8, serverStartMs: 12 },
      }),
      prepareHmr: async () => ({ ready: true }),
      editAndObserve: async () => {
        const editToPaintMs = ++edit * 10;
        clock += 4000 + editToPaintMs;
        return {
          visible: true,
          sameDocument: true,
          hmrUpdateObserved: true,
          editToPaintMs,
          dispatchObserved: true,
          paintObserved: true,
          controlConfirmed: true,
        };
      },
    },
  };
}

test("twenty independently recorded wakes and edits produce explicit nearest-rank percentiles", async () => {
  const s = simulation();
  assert.deepEqual(await runBenchmark({ ...s, config }), { completed: true });
  const result = evaluate(s.events);
  assert.equal(result.integrity, true);
  assert.equal(result.idleTabPassed, true);
  assert.deepEqual(result.states.wake.successOnly, { p50Ms: 1000, p95Ms: 1900 });
  assert.deepEqual(result.states.hmr.successOnly, { p50Ms: 100, p95Ms: 190 });
  assert.equal(result.states.hmr.results[0].operatorElapsedMs, 4010);
  assert.equal(result.states.hmr.results[0].editToPaintMs, 10);
  assert.equal(result.states.hmr.latencyTargetMet, true);
  assert.equal(result.states.wake.latencyTargetMet, true);
  assert.equal(result.states.wake.acceptance, null);
  assert.equal(result.states.cold.succeeded, 20);
  assert.equal(result.states.cold.latencyTargetMet, true);
  assert.equal(result.states.cold.acceptance, null);
  assert.equal(result.overallAcceptance, "incomplete");
  assert.equal(s.events.filter((event) => event.event === "sample_start").length, 60);
  assert.equal(s.events.filter((event) => event.event === "sample_result").length, 60);
  assert.equal(
    percentile(
      Array.from({ length: 20 }, (_, index) => index + 1),
      0.95,
    ),
    19,
  );
});

test("HMR uses dispatched marker paint while awaiting confirmed control, and refuses invented timing", async () => {
  const { createBrowserProbe } = await import("./browser.mjs");
  const create = async () => {
    let clock = 0,
      showMarker;
    const sockets = new Map(),
      events = new Map();
    const page = {
      on: (name, callback) => events.set(name, callback),
      url: () => "https://fixture.example.invalid/",
      locator: () => ({
        waitFor: async () => {},
        textContent: async () => "preview-probe-initial",
        filter: () => ({
          waitFor: () =>
            new Promise((resolve) => {
              showMarker = resolve;
            }),
        }),
      }),
      evaluate: async (_, name) => {
        if (!name) clock += 20;
        return true;
      },
    };
    const probe = await createBrowserProbe({
      browser: { newPage: async () => page },
      url: page.url(),
      fixture: "react-vite",
      now: () => clock,
    });
    events.get("websocket")({
      url: () => "wss://fixture.example.invalid/",
      isClosed: () => false,
      on: (name, callback) => sockets.set(name, callback),
    });
    const frame = (value) => sockets.get("framereceived")({ payload: JSON.stringify(value) });
    frame({ type: "connected" });
    await probe.prepareEdit();
    return {
      probe,
      now: () => clock,
      advance: (ms) => {
        clock += ms;
      },
      paint: () => {
        frame({
          type: "update",
          updates: [
            {
              type: "js-update",
              acceptedPath: "/src/__preview_spike_hmr__.js",
              path: "/src/__preview_spike_hmr__.js",
              timestamp: 1,
            },
          ],
        });
        showMarker();
      },
    };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const s = await create();
  let confirm;
  const gate = new Promise((resolve) => {
    confirm = resolve;
  });
  const pending = s.probe.editAndObserve(async (_, onDispatch) => {
    s.advance(5000); // Provider preguard and durable intent, before actual fetch dispatch.
    onDispatch();
    s.paint();
    await gate;
    s.advance(7000); // Confirmed response, provider postguard and durable outcome.
    return { controlConfirmed: true };
  });
  await flush();
  assert.equal(s.now(), 5020, "paint must finish while the control confirmation is still pending");
  confirm();
  const observed = await pending;
  assert.equal(observed.editToPaintMs, 20);
  assert.equal(observed.dispatchObserved, true);
  assert.equal(observed.paintObserved, true);
  assert.equal(observed.controlConfirmed, true);
  assert.equal(observed.hmrUpdateObserved, true);
  assert.equal(s.now(), 12020);

  for (const mode of [
    "missing_dispatch",
    "duplicate_dispatch",
    "early_marker",
    "missing_confirmation",
  ]) {
    const probe = await create();
    const value = await probe.probe.editAndObserve(async (_, onDispatch) => {
      if (mode === "early_marker") {
        probe.paint();
        await flush();
      }
      if (mode !== "missing_dispatch") onDispatch();
      if (mode === "duplicate_dispatch") onDispatch();
      if (mode !== "early_marker") probe.paint();
      return { controlConfirmed: mode !== "missing_confirmation" };
    });
    assert.equal(value.editToPaintMs, null, mode);
  }
  const failed = await create();
  const rejected = failed.probe.editAndObserve(async (_, onDispatch) => {
    onDispatch();
    failed.paint();
    await flush();
    throw new Error("control_outcome_unknown");
  });
  await assert.rejects(rejected, /control_outcome_unknown/);

  const run = simulation();
  run.adapter.editAndObserve = async () => ({
    visible: true,
    sameDocument: true,
    hmrUpdateObserved: true,
    editToPaintMs: 1,
    dispatchObserved: false,
    paintObserved: true,
    controlConfirmed: true,
  });
  await runBenchmark({ ...run, config });
  assert.equal(
    evaluate(run.events).states.hmr.succeeded,
    0,
    "a short number is not dispatch evidence",
  );
  const valid = simulation();
  await runBenchmark({ ...valid, config });
  for (const mutate of [
    (sample) => {
      delete sample.evidence.dispatchObserved;
    },
    (sample) => {
      sample.evidence.paintObserved = false;
    },
    (sample) => {
      sample.evidence.controlConfirmed = false;
    },
    (sample) => {
      delete sample.editToPaintMs;
    },
    (sample) => {
      sample.elapsedMs = 1;
    },
    (sample) => {
      sample.operatorElapsedMs = 1;
    },
  ]) {
    const forged = structuredClone(valid.events);
    mutate(forged.find((event) => event.event === "sample_result" && event.state === "hmr"));
    assert.equal(evaluate(forged).integrity, false);
    assert.equal(evaluate(forged).states.hmr.latencyTargetMet, false);
  }
});

test("capability checks bracket the persistent timing cohort and fail closed for every fixture", async () => {
  const fixtures = [
    "react-vite",
    "vanilla-vite",
    "tanstack-start",
    "next-edge",
    "astro-edge",
    "next-native-auth",
    "next-app-mail",
  ];
  for (const fixture of fixtures) {
    const s = simulation();
    s.adapter.capabilityBefore = async () => ({
      databaseCrud: true,
      twoUserAuth: true,
      userIsolation: true,
      mailReceiptMatched: true,
      mailDeliveredOnce: true,
    });
    s.adapter.capabilityAfter = async () => ({
      databaseCrud: true,
      authAfterWake: true,
      authAfterEdit: true,
      authLogout: true,
      mailReceiptMatched: true,
      mailDeliveredOnce: true,
    });
    await runBenchmark({
      ...s,
      config: {
        ...config,
        fixture,
        provenance: { ...config.provenance, hmrOverlaySha256: hmrOverlaySha256(fixture) },
      },
    });
    const report = evaluate(s.events);
    assert.equal(report.capabilitiesPassed, true);
    if (hmrOverlaySha256(fixture)) {
      assert.equal(report.hmrWorkload, "instrumented-self-accepting-module");
      assert.equal(report.nativeFixtureHmrAcceptance, null);
      for (const value of [undefined, null, "0".repeat(64)]) {
        const forged = structuredClone(s.events);
        if (value === undefined) delete forged[0].provenance.hmrOverlaySha256;
        else forged[0].provenance.hmrOverlaySha256 = value;
        assert.throws(() => evaluate(forged), /configuration_invalid|journal_invalid/);
      }
      const mislabeled = structuredClone(s.events);
      mislabeled[0].hmrWorkload = "fixture-route-component";
      assert.throws(() => evaluate(mislabeled), /journal_invalid/);
    }
    const before = s.events.findIndex(
      (event) => event.check === "capability_before" && event.event === "preflight_result",
    );
    const firstWake = s.events.findIndex(
      (event) => event.event === "sample_start" && event.state === "wake",
    );
    const after = s.events.findIndex(
      (event) => event.check === "capability_after" && event.event === "preflight_result",
    );
    const lastEdit = s.events.findLastIndex(
      (event) => event.event === "sample_result" && event.state === "hmr",
    );
    assert.ok(before >= 0 && before < firstWake && after > lastEdit);
    const tampered = structuredClone(s.events);
    tampered[before].evidence.databaseCrud = false;
    assert.equal(evaluate(tampered).integrity, false);
    assert.equal(evaluate(tampered).capabilitiesPassed, false);
    for (const [index, fields] of [
      [
        before,
        fixture === "next-native-auth"
          ? ["twoUserAuth", "userIsolation"]
          : fixture === "next-app-mail"
            ? ["mailReceiptMatched", "mailDeliveredOnce"]
            : [],
      ],
      [
        after,
        fixture === "next-native-auth"
          ? ["authAfterWake", "authAfterEdit", "authLogout"]
          : fixture === "next-app-mail"
            ? ["mailReceiptMatched", "mailDeliveredOnce"]
            : [],
      ],
    ]) {
      for (const field of fields) {
        const incomplete = structuredClone(s.events);
        incomplete[index].evidence[field] = undefined;
        assert.equal(evaluate(incomplete).capabilitiesPassed, false, `${fixture} missing ${field}`);
      }
    }
    const missing = s.events.filter((event) => event.check !== "capability_after");
    assert.equal(evaluate(missing).integrity, false);
  }
});

test("older observations cannot masquerade as manual-stop capability evidence", async () => {
  const s = simulation();
  await runBenchmark({ ...s, config });
  for (const version of [2, 3, 4, 5]) {
    s.events[0].schemaVersion = version;
    assert.throws(() => evaluate(s.events), /journal_invalid/);
  }
});

test("each timed wake explicitly records a verified manual stop and cannot be relabeled idle", async () => {
  const s = simulation();
  s.adapter.prepareWake = async () => ({
    sleepVerified: true,
    manualStopVerified: true,
    backupVerified: true,
    sleepInduction: "manual",
  });
  await runBenchmark({ ...s, config });
  const wake = s.events.find((event) => event.event === "sample_result" && event.state === "wake");
  assert.equal(s.events[0].sleepInduction, "manual");
  assert.equal(wake.sleepInduction, "manual");
  assert.equal(wake.evidence.manualStopVerified, true);
  const relabeled = structuredClone(s.events);
  relabeled.find(
    (event) => event.event === "sample_result" && event.state === "wake",
  ).sleepInduction = "idle";
  assert.equal(evaluate(relabeled).integrity, false);
  const missing = structuredClone(s.events);
  missing.find(
    (event) => event.event === "sample_result" && event.state === "wake",
  ).evidence.manualStopVerified = false;
  assert.equal(evaluate(missing).integrity, false);
});

test("reloads, missing samples and duplicate records cannot become a passing percentile", async () => {
  const s = simulation();
  const normal = s.adapter.editAndObserve;
  s.adapter.editAndObserve = async ({ sample }) =>
    sample === 3 ? { visible: true, sameDocument: false, hmrUpdateObserved: true } : normal();
  await runBenchmark({ ...s, config });
  const result = evaluate(s.events);
  assert.equal(result.states.hmr.failures, 1);
  assert.equal(result.states.hmr.results[2].outcome, "reload");
  assert.equal(result.states.hmr.acceptance, false);
  assert.equal(result.states.hmr.succeeded, 19);
  const duplicate = [...s.events, s.events.find((event) => event.event === "sample_start")];
  assert.equal(evaluate(duplicate).integrity, false);
  const incomplete = s.events.filter(
    (event) => !(event.event === "sample_result" && event.state === "wake" && event.sample === 5),
  );
  assert.equal(evaluate(incomplete).states.wake.results[4].outcome, "interrupted");
});

test("provider failure is journaled without error text and never retried or silently excluded", async () => {
  const s = simulation();
  let calls = 0;
  s.adapter.prepareWake = async () => {
    calls += 1;
    if (calls === 3) throw new Error("secret bearer-value https://private.preview.invalid");
    return {
      sleepVerified: true,
      manualStopVerified: true,
      backupVerified: true,
      sleepInduction: "manual",
    };
  };
  assert.deepEqual(await runBenchmark({ ...s, config }), { completed: false });
  const result = evaluate(s.events);
  assert.equal(calls, 3);
  assert.equal(result.integrity, false);
  assert.equal(result.states.wake.results[2].outcome, "error");
  assert.equal(result.states.wake.results[3].outcome, "not_started");
  assert.equal(result.states.wake.acceptance, false);
  assert.doesNotMatch(JSON.stringify(s.events), /secret|bearer-value|private\.preview/);
});

test("a timed-out mutation stops the run and retains its sample and stage", async () => {
  const s = simulation();
  let laterCalled = false;
  s.adapter.wake = async ({ signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("private")), { once: true }),
    );
  s.adapter.verifyWake = async () => {
    laterCalled = true;
  };
  await runBenchmark({ ...s, config: { ...config, deadlineMs: 10 } });
  const result = s.events.find(
    (event) => event.event === "sample_result" && event.state === "wake",
  );
  assert.equal(result.outcome, "timeout");
  assert.equal(result.stage, "wake");
  assert.equal(laterCalled, false);
  assert.equal(evaluate(s.events).states.wake.failures, 20);
});

test("durable journal is exclusive, private, and treats a partial line as an error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-journal-test-"));
  try {
    const path = join(directory, "run.jsonl");
    const journal = await createJournal(path);
    await journal.append({ event: "sample_start", state: "wake", sample: 1 });
    await journal.close();
    assert.equal((await readJournal(path))[0].sample, 1);
    await assert.rejects(createJournal(path));
    assert.match(await readFile(path, "utf8"), /sample_start/);
    await writeFile(path, '{"event":"unfinished"}');
    await assert.rejects(readJournal(path), /journal_incomplete_write/);
    const recovered = await recoverJournal(path);
    assert.equal(recovered.incompleteTail, true);
    assert.deepEqual(recovered.events, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an apparent pass without phase evidence or with reordered preflights is rejected", async () => {
  const s = simulation();
  await runBenchmark({ ...s, config });
  const withoutRestore = structuredClone(s.events);
  const sample = withoutRestore.find(
    (event) => event.event === "sample_result" && event.state === "wake",
  );
  delete sample.phases.restoreMs;
  assert.equal(evaluate(withoutRestore).integrity, false);
  const reordered = structuredClone(s.events);
  [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  assert.equal(evaluate(reordered).integrity, false);
});

test("all seven fixture copies produce a narrow edit without modifying their lock graphs", async () => {
  const { fixtureEdit } = await import("./browser.mjs");
  const { fixtures } = await import("./statistics.mjs");
  const marker = `preview-probe-${"a".repeat(32)}`;
  for (const fixture of fixtures) {
    const edit = await fixtureEdit(fixture, marker);
    assert.match(edit.path, /^src\//);
    assert.equal(edit.content.split(marker).length, 2);
  }
  await assert.rejects(fixtureEdit("unknown", marker), /edit_invalid/);
  await assert.rejects(fixtureEdit("react-vite", "secret"), /edit_invalid/);
});

test("a preview status page cannot count as the fixture page", async () => {
  const { createBrowserProbe } = await import("./browser.mjs");
  let heading = "Starting preview";
  let notesPresent = false;
  let responseWaiter;
  const target = "https://fixture.example.invalid/";
  const page = {
    on() {},
    goto: async () => {},
    url: () => target,
    waitForResponse: (predicate) =>
      new Promise((resolve, reject) => {
        responseWaiter = () => {
          const response = {
            url: () => `${target}api/notes`,
            request: () => ({ method: () => "GET" }),
            ok: () => true,
            json: async () => ({ notes: [] }),
          };
          if (predicate(response)) resolve(response);
          else reject(new Error("wrong_response"));
        };
      }),
    locator(selector) {
      if (selector === "h1")
        return {
          filter: ({ hasText }) => ({
            waitFor: async () => {
              if (!hasText.test(heading)) throw new Error("still_status_page");
            },
          }),
        };
      if (selector === "#note-id")
        return {
          waitFor: async () => {
            if (!notesPresent) throw new Error("fixture_controls_missing");
          },
        };
      if (selector === "#note-read") return { click: async () => responseWaiter() };
      if (selector === "#note-result")
        return {
          filter: ({ hasText }) => ({
            waitFor: async () => assert.equal(hasText.test('{"notes":[]}'), true),
          }),
          textContent: async () => '{"notes":[]}',
        };
      throw new Error("unexpected_locator");
    },
    evaluate: async () => {},
  };
  const probe = await createBrowserProbe({
    browser: { newPage: async () => page },
    url: target,
    fixture: "next-edge",
  });
  await assert.rejects(probe.navigate(), /still_status_page/);
  heading = "Preview notes";
  await assert.rejects(probe.navigate(), /fixture_controls_missing/);
  notesPresent = true;
  assert.deepEqual(await probe.navigate(), { usable: true, sameUrl: true });
});

test("the measured navigation waits for the hydrated database action", async () => {
  const { createBrowserProbe } = await import("./browser.mjs");
  const target = "https://fixture.example.invalid/";
  let release,
    requested = false,
    settled = false;
  const response = {
    url: () => `${target}api/notes`,
    request: () => ({ method: () => "GET" }),
    ok: () => true,
    json: async () => ({ notes: [] }),
  };
  const page = {
    on() {},
    goto: async () => {},
    url: () => target,
    evaluate: async () => {},
    waitForResponse: (predicate) =>
      new Promise((resolve) => {
        release = () => {
          assert.equal(predicate(response), true);
          resolve(response);
        };
      }),
    locator: (selector) =>
      selector === "#note-read"
        ? {
            click: async () => {
              requested = true;
            },
          }
        : selector === "#note-result"
          ? { filter: () => ({ waitFor: async () => {} }), textContent: async () => '{"notes":[]}' }
          : { filter: () => ({ waitFor: async () => {} }), waitFor: async () => {} },
  };
  const probe = await createBrowserProbe({
    browser: { newPage: async () => page },
    url: target,
    fixture: "next-edge",
  });
  const navigation = probe.navigate().then((value) => {
    settled = true;
    return value;
  });
  while (!requested) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  release();
  assert.deepEqual(await navigation, { usable: true, sameUrl: true });
});

test("report exits distinguish recorded observations from complete targets and product acceptance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-report-test-"));
  try {
    const path = join(directory, "run.jsonl");
    const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const report = (command) => {
      const child = spawnSync(process.execPath, [cli, command, path], { encoding: "utf8" });
      assert.equal(child.signal, null);
      return { status: child.status, result: JSON.parse(child.stdout) };
    };
    const writeEvents = (events, tail = "") =>
      writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n${tail}`);
    const short = simulation();
    await runBenchmark({ ...short, config });
    await writeEvents(short.events);
    assert.equal(report("report").status, 2);
    assert.equal(report("report-observations").status, 2);
    assert.equal(evaluate(short.events).idleTabTargetMet, false);
    assert.equal(evaluate(short.events).frameworkTargets, "incomplete");

    const long = simulation();
    await runBenchmark({ ...long, config: { ...config, inactivityMs: 1200000 } });
    await writeEvents(long.events);
    assert.equal(evaluate(long.events).idleTabTargetMet, false);
    assert.equal(evaluate(long.events).frameworkTargets, "incomplete");
    assert.equal(report("report-observations").status, 2);

    const early = simulation();
    const earlyIdle = early.adapter.checkIdleTab;
    early.adapter.checkIdleTab = async (options) => ({
      ...(await earlyIdle(options)),
      idleSleepAfterMs: 1,
    });
    await runBenchmark({ ...early, config: { ...config, inactivityMs: 600000 } });
    await writeEvents(early.events);
    assert.equal(evaluate(early.events).idleTabTargetMet, false);
    assert.equal(
      evaluate(early.events).idleTimingQualification,
      "invalid-stop-before-policy-deadline",
    );
    assert.equal(evaluate(early.events).frameworkTargets, "failed");
    assert.equal(report("report-observations").status, 1);

    const late = simulation();
    const normalIdle = late.adapter.checkIdleTab;
    late.adapter.checkIdleTab = async (options) => ({
      ...(await normalIdle(options)),
      idleSleepAfterMs: 600001,
    });
    await runBenchmark({ ...late, config: { ...config, inactivityMs: 600000 } });
    await writeEvents(late.events);
    assert.equal(evaluate(late.events).idleTabTargetMet, false);
    assert.equal(evaluate(late.events).idlePolicyTargetMet, true);
    assert.equal(evaluate(late.events).idleStopDelayMs, 1);
    assert.equal(
      evaluate(late.events).idleTimingQualification,
      "incomplete-no-agreed-jitter-tolerance",
    );
    assert.equal(evaluate(late.events).frameworkTargets, "incomplete");
    assert.equal(report("report-observations").status, 2);

    const unobserved = simulation();
    const unobservedIdle = unobserved.adapter.checkIdleTab;
    unobserved.adapter.checkIdleTab = async (options) => {
      const result = await unobservedIdle(options);
      delete result.idleSleepAfterMs;
      return result;
    };
    await runBenchmark({ ...unobserved, config: { ...config, inactivityMs: 600000 } });
    await writeEvents(unobserved.events);
    assert.equal(evaluate(unobserved.events).idleTabTargetMet, false);
    assert.equal(evaluate(unobserved.events).frameworkTargets, "incomplete");
    assert.equal(evaluate(unobserved.events).idleTimingQualification, "unobserved-stop-time");
    assert.equal(report("report-observations").status, 2);

    const complete = simulation();
    await runBenchmark({ ...complete, config: { ...config, inactivityMs: 600000 } });
    await writeEvents(complete.events);
    const observations = report("report-observations");
    assert.equal(observations.status, 0);
    assert.equal(observations.result.overallAcceptance, "incomplete");
    assert.equal(observations.result.reportScope, "framework-target-observations");
    assert.equal(report("report").status, 2);

    const noWakeTarget = simulation();
    await runBenchmark({
      ...noWakeTarget,
      config: {
        ...config,
        fixture: "astro-edge",
        inactivityMs: 600000,
        provenance: { ...config.provenance, hmrOverlaySha256: hmrOverlaySha256("astro-edge") },
      },
    });
    await writeEvents(noWakeTarget.events);
    assert.equal(report("report-observations").status, 2);
    assert.equal(report("report-observations").result.states.wake.latencyTargetMet, null);

    await writeEvents(complete.events, '{"event":');
    const torn = report("report-observations");
    assert.equal(torn.status, 1);
    assert.equal(torn.result.frameworkTargets, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HMR evidence rejects unrelated, stale, malformed and unknown WebSocket frames", async () => {
  const { createBrowserProbe } = await import("./browser.mjs");
  const createProbe = async (options) => {
    const probe = await createBrowserProbe(options);
    return {
      ...probe,
      editAndObserve: (send) =>
        probe.editAndObserve(async (edit, onDispatch) => {
          onDispatch();
          await send(edit);
          return { controlConfirmed: true };
        }),
    };
  };
  const url = "https://fixture.example.invalid/";
  const events = new Map();
  const socketEvents = new Map();
  const socket = {
    url: () => "wss://fixture.example.invalid/",
    on: (name, callback) => socketEvents.set(name, callback),
    isClosed: () => false,
  };
  let observedMarker,
    documentPreserved = true,
    helperReady = true,
    helperMarker = "preview-probe-initial";
  const page = {
    on: (name, callback) => events.set(name, callback),
    url: () => url,
    evaluate: async () => documentPreserved,
    locator: () => ({
      waitFor: async () => {
        if (!helperReady) throw new Error("helper_absent");
      },
      textContent: async () => helperMarker,
      filter: () => ({ waitFor: async () => {} }),
    }),
    getByText: (marker, options) => {
      assert.equal(options.exact, true);
      observedMarker = marker;
      return { waitFor: async () => {} };
    },
  };
  const probe = await createProbe({
    browser: { newPage: async () => page },
    url,
    fixture: "react-vite",
  });
  let unwantedSubscriptions = 0;
  for (const address of ["ws://fixture.example.invalid/", "wss://other.example.invalid/"])
    events.get("websocket")({
      url: () => address,
      on: () => {
        unwantedSubscriptions += 1;
      },
    });
  assert.equal(unwantedSubscriptions, 0);
  events.get("websocket")(socket);
  const frame = (payload) => socketEvents.get("framereceived")({ payload });
  const update = (path = "/src/__preview_spike_hmr__.js") =>
    JSON.stringify({
      type: "update",
      updates: [{ type: "js-update", path, acceptedPath: path, timestamp: 123 }],
    });
  frame('{"type":"ping"}');
  assert.equal(probe.socketOpen(), false);
  frame('{"type":"connected"}');
  assert.equal(probe.socketOpen(), true);
  await probe.prepareEdit();
  helperReady = false;
  await assert.rejects(probe.prepareEdit(), /helper_absent/);
  let writes = 0;
  await assert.rejects(
    probe.editAndObserve(async () => {
      writes += 1;
    }),
    /edit_not_prepared/,
  );
  assert.equal(writes, 0);
  helperReady = true;
  helperMarker = "unexpected content";
  await assert.rejects(probe.prepareEdit(), /hmr_probe_not_ready/);
  helperMarker = `preview-probe-${"a".repeat(32)}`;
  for (const payload of [
    '{"type":"ping"}',
    '{"type":"custom","event":"app-message"}',
    update("/src/unrelated.tsx"),
    '{"type":"full-reload"}',
    "malformed",
    new Uint8Array([1]),
  ]) {
    await probe.prepareEdit();
    const result = await probe.editAndObserve(async () => frame(payload));
    assert.equal(result.hmrUpdateObserved, false);
  }
  await probe.prepareEdit();
  frame(update()); // Between preparation and the actual write: not evidence for this edit.
  assert.equal((await probe.editAndObserve(async () => {})).hmrUpdateObserved, false);
  await probe.prepareEdit();
  assert.equal((await probe.editAndObserve(async () => frame(update()))).hmrUpdateObserved, true);
  let next = await createProbe({
    browser: { newPage: async () => page },
    url,
    fixture: "next-edge",
  });
  events.get("websocket")(socket);
  frame('{"type":"connected"}');
  assert.equal(next.socketOpen(), false);
  await next.prepareEdit();
  assert.equal((await next.editAndObserve(async () => frame(update()))).hmrUpdateObserved, false);

  const module = "[project]/src/app/notes.tsx [app-client] (ecmascript)";
  const nextUpdate = (marker, key = module) => ({
    type: "turbopack-message",
    hmrVersion: "1",
    data: [
      {
        type: "partial",
        instruction: {
          type: "ChunkListUpdate",
          merged: [
            {
              type: "EcmascriptMergedUpdate",
              entries: { [key]: { code: `export const marker = "${marker}";`, map: "", url: "" } },
            },
          ],
        },
      },
    ],
  });
  const nextSocket = { ...socket, url: () => "wss://fixture.example.invalid/_next/hmr?id=fixture" };
  for (const fixture of ["next-edge", "next-native-auth", "next-app-mail"]) {
    next = await createProbe({ browser: { newPage: async () => page }, url, fixture });
    events.get("websocket")({
      ...socket,
      on: () => {
        unwantedSubscriptions += 1;
      },
    });
    assert.equal(unwantedSubscriptions, 0);
    events.get("websocket")(nextSocket);
    frame('{"type":"turbopack-connected","data":{"sessionId":"wrong","hmrVersion":"0"}}');
    assert.equal(next.socketOpen(), false);
    frame('{"type":"turbopack-connected","data":{"sessionId":123,"hmrVersion":"0"}}');
    assert.equal(next.socketOpen(), true);
    await next.prepareEdit();
    const observed = await next.editAndObserve(async (edit) => {
      assert.equal(edit.path, "src/app/notes.tsx");
      assert.equal(edit.content.split(observedMarker).length, 2);
      frame(JSON.stringify(nextUpdate(observedMarker)));
    });
    assert.equal(observed.hmrUpdateObserved, true);
    assert.equal(observed.sameDocument, true);
  }
  await next.prepareEdit();
  const single = await next.editAndObserve(async () => {
    const value = nextUpdate(observedMarker);
    value.data = value.data[0];
    frame(JSON.stringify(value));
  });
  assert.equal(single.hmrUpdateObserved, true);
  for (const makeFrame of [
    (marker) => ({ type: "serverComponentChanges", hmrVersion: "1", marker }),
    (marker) => ({ type: "built", marker }),
    (marker) => nextUpdate(marker, "[project]/src/app/other.tsx [app-client] (ecmascript)"),
    (marker) => nextUpdate(marker, "[project]/other/src/app/notes.tsx [app-client] (ecmascript)"),
    (marker) => {
      const value = nextUpdate("not-the-edit");
      value.marker = marker;
      value.data[0].instruction.merged[0].entries[module].map = marker;
      return value;
    },
    (marker) => {
      const value = nextUpdate(marker);
      value.data[0].type = "issues";
      return value;
    },
    (marker) => {
      const value = nextUpdate(marker);
      value.data[0].instruction.type = "UnknownUpdate";
      return value;
    },
    (marker) => {
      const value = nextUpdate(marker);
      value.data[0].instruction.merged[0].type = "UnknownMergedUpdate";
      return value;
    },
  ]) {
    await next.prepareEdit();
    const observed = await next.editAndObserve(async () =>
      frame(JSON.stringify(makeFrame(observedMarker))),
    );
    assert.equal(observed.hmrUpdateObserved, false);
  }
  await next.prepareEdit();
  frame(JSON.stringify(nextUpdate(observedMarker)));
  assert.equal((await next.editAndObserve(async () => {})).hmrUpdateObserved, false);
  await next.prepareEdit();
  const reload = await next.editAndObserve(async () => {
    frame(JSON.stringify(nextUpdate(observedMarker)));
    frame('{"type":"reloadPage"}');
  });
  assert.equal(reload.hmrUpdateObserved, false);
  await next.prepareEdit();
  documentPreserved = false;
  const navigated = await next.editAndObserve(async () =>
    frame(JSON.stringify(nextUpdate(observedMarker))),
  );
  assert.equal(navigated.sameDocument, false);
});
