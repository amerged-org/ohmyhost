/* global URL, Response, AbortController */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cloudflareAdapter, fixtureTreeSha256 } from "./cloudflare.mjs";

const token = "a-secret-that-must-never-be-saved";
const backupHash = "b".repeat(64);
const backupId = "12345678-1234-4234-8234-123456789abc";
const coldPhases = {
  kind: "cold",
  generation: 1,
  startedAt: "2026-11-14T00:00:00.000Z",
  startRequestedAt: "2026-11-14T00:00:00.000Z",
  containerReadyAt: "2026-11-14T00:00:01.000Z",
  installStartAt: "2026-11-14T00:00:01.000Z",
  installEndAt: "2026-11-14T00:00:03.000Z",
  backupStartAt: "2026-11-14T00:00:03.000Z",
  backupEndAt: "2026-11-14T00:00:04.000Z",
  serverStartAt: "2026-11-14T00:00:04.000Z",
  serverReadyAt: "2026-11-14T00:00:05.000Z",
};
const config = {
  fixture: "next-edge",
  instance: "standard-2",
  inactivityMs: 5000,
  deadlineMs: 10000,
  provenance: {
    packageCache: "seeded",
    workerVersionId: "23456789-1234-1234-1234-123456789abc",
    sourceRevision: "a".repeat(40),
    fixtureSourceRevision: "b".repeat(40),
    fixtureArchiveSha256: "c".repeat(64),
    hmrOverlaySha256: null,
  },
};

test("Cloudflare adapter requires real idle, unchanged passive state, wake restore and distinct cold sessions", async () => {
  config.provenance.fixtureTreeSha256 = await fixtureTreeSha256(config.fixture);
  const sessions = new Map(),
    calls = [],
    resources = [],
    events = [];
  let serial = 0,
    clock = 0,
    stopDelayMs = 0,
    manualStopReason = "manual",
    mainId,
    journeyWakes = 0,
    journeyClosed = false,
    guardLatencyMs = 0,
    journalLatencyMs = 0,
    responseLatencyMs = 0,
    dispatchedAt = null,
    paintedAt = null,
    receiptFault = null,
    failPostGuard = false,
    denyNextGuard = false,
    dispatches = 0;
  const phases = () => ({
    kind: "wake",
    generation: sessions.get(mainId).generation,
    startRequestedAt: "2026-11-14T00:00:00.000Z",
    containerReadyAt: "2026-11-14T00:00:01.000Z",
    restoreStartAt: "2026-11-14T00:00:01.000Z",
    restoreEndAt: "2026-11-14T00:00:03.000Z",
    serverStartAt: "2026-11-14T00:00:03.000Z",
    serverReadyAt: "2026-11-14T00:00:04.000Z",
    ignoredAt: token,
  });
  function wake(id) {
    const state = sessions.get(id);
    if (!state.running) {
      state.generation += 1;
      state.wakeCount += 1;
      state.running = true;
      state.ready = true;
      state.sourceRevision = state.backup.sourceRevision;
      state.phases = phases();
    }
  }
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.redirect, "error");
    const path = new URL(url).pathname.split("/").filter(Boolean);
    if (path[1] === "lease")
      return Response.json(sessions.size ? { id: [...sessions.keys()][0] } : null);
    const id = path[2],
      action = path[3];
    calls.push({ id, action: action ?? (id ? "delete" : "create") });
    events.push(action ?? (id ? "delete" : "create"));
    if (!id) {
      assert.equal(sessions.size, 0, "only one live session is allowed");
      const next = (++serial).toString(16).padStart(32, "0");
      const input = JSON.parse(init.body);
      sessions.set(next, {
        previewId: next,
        config: input,
        running: false,
        ready: false,
        generation: 0,
        wakeCount: 0,
        sourceRevision: 0,
        backup: null,
        capabilityVerification: "unavailable",
        provenance: Object.fromEntries(
          [
            "workerVersionId",
            "sourceRevision",
            "fixtureSourceRevision",
            "fixtureArchiveSha256",
            "fixtureTreeSha256",
          ].map((key) => [key, config.provenance[key]]),
        ),
      });
      sessions.get(next).provenance.hmrOverlaySha256 = null;
      mainId = next;
      return Response.json({
        id: next,
        url: `https://${next}-${"f".repeat(24)}.preview.dev.omh.st/`,
      });
    }
    const state = sessions.get(id);
    if (action === "setup") {
      state.running = state.ready = true;
      state.generation = 1;
      state.coldProof = { noNodeModulesBeforeInstall: true, restored: false, cacheMode: "seeded" };
      state.phases = { ...coldPhases, ignored: token };
      state.backup = {
        id: backupId,
        sha256: backupHash,
        size: 10,
        sourceRevision: state.sourceRevision,
        generation: state.generation,
        ignored: token,
      };
      state.qa = { ignored: token };
      state.url = `https://private.example/${token}`;
    }
    if (action === "backup")
      state.backup = {
        id: backupId,
        sha256: backupHash,
        size: 10,
        sourceRevision: state.sourceRevision,
        generation: state.generation,
      };
    if (action === "edit") {
      if (dispatchedAt !== null)
        assert.equal(clock, dispatchedAt, "dispatch is immediately before fetch");
      assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ["content", "path"]);
      state.sourceRevision += 1;
      clock += 20;
      paintedAt = clock;
      clock += responseLatencyMs;
      if (failPostGuard) denyNextGuard = true;
      const receipt = {
        sourceRevision: state.sourceRevision,
        generation: state.generation,
        writtenAt: new Date(clock).toISOString(),
        contentSha256: createHash("sha256")
          .update(JSON.parse(init.body).content, "utf8")
          .digest("hex"),
      };
      if (receiptFault === "hash") receipt.contentSha256 = "0".repeat(64);
      if (receiptFault === "generation") receipt.generation += 1;
      if (receiptFault === "revision") receipt.sourceRevision += 1;
      return Response.json(receipt);
    }
    if (action === "stop") {
      state.running = state.ready = false;
      state.lastStopReason = manualStopReason;
      state.stopGeneration = state.generation;
      state.stoppedAt = new Date(clock).toISOString();
    }
    if (!action) {
      sessions.delete(id);
      return Response.json({ destroyed: true, backupDeleted: Boolean(state.backup) });
    }
    return Response.json(state);
  };
  const probeFactory = async ({ url }) => {
    const id = new URL(url).hostname.split(".")[0].split("-")[0];
    return {
      page: {
        waitForEvent: async () => ({}),
        mainFrame: () => ({}),
        locator: () => ({ click: async () => wake(id) }),
      },
      navigate: async () => {
        wake(id);
        sessions.get(id).lastUserActivityAt = clock;
        return { usable: true, sameUrl: true };
      },
      waitUsable: async () => {},
      socketOpen: () => true,
      prepareEdit: async () => ({ ready: true }),
      editAndObserve: async (send) => {
        let dispatched = false;
        const confirmed = await send({ path: "src/main.ts", content: "public fixture" }, () => {
          dispatched = true;
          dispatches += 1;
          dispatchedAt = clock;
          assert.equal(resources.at(-1).event, "intent");
          assert.equal(resources.at(-1).operation, "edit");
        });
        const editToPaintMs = dispatched ? paintedAt - dispatchedAt : null;
        dispatchedAt = null;
        return {
          visible: true,
          sameDocument: true,
          hmrUpdateObserved: true,
          dispatchObserved: dispatched,
          paintObserved: dispatched,
          controlConfirmed: confirmed?.controlConfirmed === true,
          editToPaintMs,
        };
      },
      close: async () => {},
    };
  };
  const adapter = cloudflareAdapter({
    browser: { close: async () => {} },
    token,
    config,
    fetchImpl,
    probeFactory,
    verifyProvenance: async () => true,
    verifyControlTarget: async () => {
      clock += guardLatencyMs;
      if (denyNextGuard) {
        denyNextGuard = false;
        return false;
      }
      return true;
    },
    resourceJournal: {
      append: async (event) => {
        resources.push(event);
        events.push(event.event);
        clock += journalLatencyMs;
      },
    },
    journeyFactory: async ({ fixture, sessionId, recordOperation }) => {
      assert.equal(fixture, config.fixture);
      assert.equal(sessionId, mainId);
      await recordOperation({ event: "intent", operation: "fixture_test", sessionId });
      return {
        before: { databaseCrud: true },
        afterWake: async () => {
          journeyWakes += 1;
        },
        finish: async () => ({ databaseCrud: true }),
        close: async () => {
          journeyClosed = true;
        },
      };
    },
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
      if (ms >= config.inactivityMs) {
        const state = sessions.get(mainId);
        state.running = state.ready = false;
        state.lastStopReason = "idle";
        state.stoppedAt = new Date(
          state.lastUserActivityAt + config.inactivityMs + stopDelayMs,
        ).toISOString();
      }
    },
  });
  assert.deepEqual(await adapter.verifyScope({}), { identityReadbackMatched: true });
  for (let i = 0; i < 2; i += 1) {
    journalLatencyMs = 500;
    const before = resources.filter((event) => event.event === "runtime-checkpoint").length;
    const cold = await adapter.coldStart({});
    assert.equal(cold.noInstalledDependencies, true);
    assert.equal(cold.noBackupRestore, true);
    assert.equal(resources.filter((event) => event.event === "runtime-checkpoint").length, before);
    const coldTimerStoppedAt = clock;
    events.push("cold-timer-stopped");
    assert.equal((await adapter.finishCold({})).destroyed, true);
    const checkpoint = resources.filter((event) => event.event === "runtime-checkpoint").at(-1);
    const { recordedAt, ...projection } = checkpoint;
    assert.equal(new Date(recordedAt).toISOString(), recordedAt);
    assert.deepEqual(projection, {
      event: "runtime-checkpoint",
      purpose: "cold",
      fixture: "next-edge",
      instance: "standard-2",
      sessionId: mainId,
      generation: 1,
      sourceRevision: 0,
      backupId,
      backupSha256: backupHash,
      backupCompressedBytes: 10,
      backupSourceRevision: 0,
      backupGeneration: 1,
      ...Object.fromEntries(Object.entries(coldPhases).filter(([key]) => key.endsWith("At"))),
    });
    assert.ok(clock > coldTimerStoppedAt, "journal sync occurs after the cold timer stops");
    const checkpointPosition = events.lastIndexOf("runtime-checkpoint");
    assert.ok(events.lastIndexOf("cold-timer-stopped") < checkpointPosition);
    assert.ok(checkpointPosition < events.lastIndexOf("delete"));
    journalLatencyMs = 0;
  }
  assert.deepEqual(await adapter.setup({}), {
    ready: true,
    backupVerified: true,
    identityReadbackMatched: true,
  });
  const setupCheckpoint = resources.filter((event) => event.event === "runtime-checkpoint").at(-1);
  const { recordedAt: setupRecordedAt, ...setupProjection } = setupCheckpoint;
  assert.equal(new Date(setupRecordedAt).toISOString(), setupRecordedAt);
  assert.deepEqual(setupProjection, {
    event: "runtime-checkpoint",
    purpose: "setup",
    fixture: "next-edge",
    instance: "standard-2",
    sessionId: mainId,
    generation: 1,
    sourceRevision: 0,
    backupId,
    backupSha256: backupHash,
    backupCompressedBytes: 10,
    backupSourceRevision: 0,
    backupGeneration: 1,
    ...Object.fromEntries(Object.entries(coldPhases).filter(([key]) => key.endsWith("At"))),
  });
  sessions.get(mainId).provenance.hmrOverlaySha256 = "0".repeat(64);
  await assert.rejects(adapter.verifyScope({}), /runtime_identity_mismatch/);
  sessions.get(mainId).provenance.hmrOverlaySha256 = null;
  assert.deepEqual(await adapter.verifyScope({}), { identityReadbackMatched: true });
  assert.deepEqual(await adapter.capabilityBefore({}), { databaseCrud: true });
  const idle = await adapter.checkIdleTab({ inactivityMs: 5000, passiveObservationMs: 1000 });
  assert.equal(idle.idleSleepObserved, true);
  assert.equal(idle.noPassiveWake, true);
  assert.equal(idle.userWakeObserved, true);
  assert.equal(idle.hmrAfterWake, true);
  assert.equal(idle.idleSleepAfterMs, 5000);
  stopDelayMs = 250;
  const delayed = await adapter.checkIdleTab({ inactivityMs: 5000, passiveObservationMs: 1000 });
  assert.equal(delayed.idleSleepAfterMs, 5250);
  stopDelayMs = 0;
  assert.equal(sessions.get(mainId).backup.sourceRevision, sessions.get(mainId).sourceRevision);
  const clockBeforeStop = clock;
  const prepared = await adapter.prepareWake({ inactivityMs: 5000 });
  assert.equal(prepared.sleepVerified, true);
  assert.equal(prepared.manualStopVerified, true);
  assert.equal(prepared.sleepInduction, "manual");
  assert.equal(clock, clockBeforeStop, "the timed wake uses a manual stop, not an idle wait");
  const checkpointsBeforeWake = resources.filter(
    (event) => event.event === "runtime-checkpoint",
  ).length;
  assert.deepEqual(await adapter.wake({}), { usable: true, sameUrl: true });
  assert.equal(
    resources.filter((event) => event.event === "runtime-checkpoint").length,
    checkpointsBeforeWake,
  );
  events.push("wake-timer-stopped");
  journalLatencyMs = 500;
  const verified = await adapter.verifyWake({});
  journalLatencyMs = 0;
  assert.ok(events.lastIndexOf("wake-timer-stopped") < events.lastIndexOf("runtime-checkpoint"));
  assert.equal(journeyWakes, 1);
  assert.equal(verified.restored, true);
  assert.equal(verified.newGeneration, true);
  assert.deepEqual(verified.phases, {
    containerStartMs: 1000,
    restoreMs: 2000,
    serverStartMs: 1000,
  });
  const { recordedAt: wakeRecordedAt, ...wakeCheckpoint } = resources
    .filter((event) => event.event === "runtime-checkpoint")
    .at(-1);
  assert.equal(new Date(wakeRecordedAt).toISOString(), wakeRecordedAt);
  const state = sessions.get(mainId);
  assert.deepEqual(wakeCheckpoint, {
    event: "runtime-checkpoint",
    purpose: "wake",
    fixture: "next-edge",
    instance: "standard-2",
    sessionId: mainId,
    generation: state.generation,
    sourceRevision: state.sourceRevision,
    backupId,
    backupSha256: backupHash,
    backupCompressedBytes: 10,
    backupSourceRevision: state.backup.sourceRevision,
    backupGeneration: state.backup.generation,
    ...Object.fromEntries(
      [
        "startRequestedAt",
        "containerReadyAt",
        "restoreStartAt",
        "restoreEndAt",
        "serverStartAt",
        "serverReadyAt",
      ].map((key) => [key, state.phases[key]]),
    ),
  });
  assert.equal((await adapter.prepareHmr({})).ready, true);
  guardLatencyMs = 3000;
  journalLatencyMs = 500;
  responseLatencyMs = 1000;
  const operatorStart = clock;
  const edit = await adapter.editAndObserve({});
  assert.equal(edit.sameDocument, true);
  assert.equal(edit.editToPaintMs, 20);
  assert.equal(edit.controlConfirmed, true);
  assert.ok(
    clock - operatorStart > 20000,
    "full guarded operator time remains outside paint metric",
  );
  guardLatencyMs = journalLatencyMs = responseLatencyMs = 0;
  for (const fault of ["hash", "generation", "revision"]) {
    receiptFault = fault;
    await assert.rejects(adapter.editAndObserve({}), /edit_receipt_unverified/);
    dispatchedAt = null;
  }
  receiptFault = null;
  failPostGuard = true;
  const dispatchedBeforeFailure = dispatches;
  await assert.rejects(adapter.editAndObserve({}), /control_outcome_unknown/);
  assert.equal(dispatches, dispatchedBeforeFailure + 1);
  assert.equal(resources.at(-1).operation, "edit");
  assert.equal(resources.at(-1).outcome, "unknown");
  failPostGuard = false;
  dispatchedAt = null;
  assert.deepEqual(await adapter.capabilityAfter({}), { databaseCrud: true });
  sessions.get(mainId).backup.sourceRevision = sessions.get(mainId).sourceRevision;
  manualStopReason = "idle";
  await assert.rejects(adapter.prepareWake({ inactivityMs: 5000 }), /manual_stop_unverified/);
  assert.deepEqual(await adapter.finishRun({}), { destroyed: true, backupDeleted: true });
  assert.equal(journeyClosed, true);
  assert.equal(sessions.size, 0);
  assert.equal(
    resources.filter((record) => record.operation === "create" && record.outcome === "confirmed")
      .length,
    3,
  );
  assert.doesNotMatch(JSON.stringify(resources), /a-secret-that-must-never-be-saved/);
  assert.doesNotMatch(JSON.stringify(resources), /https?:\/\//);
  assert.equal(
    new Set(calls.filter((call) => call.action === "setup").map((call) => call.id)).size,
    3,
  );
});

test("a mismatched local fixture or unverified provenance prevents every provider mutation", async () => {
  let calls = 0;
  const adapter = cloudflareAdapter({
    browser: {},
    token,
    config: { ...config, provenance: { ...config.provenance, fixtureTreeSha256: "0".repeat(64) } },
    verifyProvenance: async () => true,
    verifyControlTarget: async () => true,
    resourceJournal: { append: async () => {} },
    fetchImpl: async () => {
      calls += 1;
    },
  });
  await assert.rejects(adapter.verifyScope({}), /fixture_pin_mismatch/);
  assert.equal(calls, 0);
  const drifted = cloudflareAdapter({
    browser: {},
    token,
    config,
    verifyProvenance: async () => true,
    verifyControlTarget: async () => {
      throw new Error("control_target_unverified");
    },
    resourceJournal: { append: async () => {} },
    fetchImpl: async () => {
      calls++;
      throw new Error("control_bearer_must_not_be_sent");
    },
  });
  await drifted.verifyScope({});
  await assert.rejects(drifted.setup({}), /control_target_unverified/);
  assert.equal(calls, 0);
});

test("an uncertain create is journaled privately and is not repeated or cleaned up automatically", async () => {
  const records = [];
  let creates = 0;
  const adapter = cloudflareAdapter({
    browser: {},
    token,
    config,
    verifyProvenance: async () => true,
    verifyControlTarget: async () => true,
    resourceJournal: { append: async (event) => records.push(event) },
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/__spike/lease") return Response.json(null);
      creates += 1;
      throw new Error("opaque private token and transport details");
    },
  });
  await adapter.verifyScope({});
  await assert.rejects(adapter.coldStart({}), /control_outcome_unknown/);
  assert.equal(creates, 1);
  assert.deepEqual(
    records.map(({ event, operation, outcome }) => ({ event, operation, outcome })),
    [
      { event: "intent", operation: "create", outcome: undefined },
      { event: "result", operation: "create", outcome: "unknown" },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(records),
    /opaque|private token|a-secret-that-must-never-be-saved/,
  );
});

test("invalid checkpoint DTOs and uncertain journal writes retain and fence their sessions", async () => {
  config.provenance.fixtureTreeSha256 = await fixtureTreeSha256(config.fixture);
  function harness({
    alterSetup = () => {},
    failPurpose = null,
    pauseCheckpoint,
    afterWake = async () => {},
  } = {}) {
    const id = "1".repeat(32),
      records = [],
      mutations = [];
    let state;
    const adapter = cloudflareAdapter({
      browser: { close: async () => {} },
      token,
      config,
      verifyProvenance: async () => true,
      verifyControlTarget: async () => true,
      resourceJournal: {
        append: async (event) => {
          records.push(event);
          if (event.event === "runtime-checkpoint" && event.purpose === failPurpose)
            throw new Error(`possibly written ${token}`);
          if (event.event === "runtime-checkpoint" && pauseCheckpoint) await pauseCheckpoint();
        },
      },
      fetchImpl: async (url, init) => {
        const parts = new URL(url).pathname.split("/").filter(Boolean),
          action = parts[3];
        if (parts[1] === "lease") return Response.json(state ? { id } : null);
        if (!parts[2]) {
          mutations.push("create");
          state = {
            previewId: id,
            config: JSON.parse(init.body),
            running: false,
            ready: false,
            generation: 0,
            wakeCount: 0,
            sourceRevision: 0,
            provenance: { ...config.provenance },
          };
          return Response.json({ id, url: `https://${id}-${"f".repeat(24)}.preview.dev.omh.st/` });
        }
        if (action === "setup") {
          mutations.push("setup");
          Object.assign(state, {
            running: true,
            ready: true,
            generation: 1,
            coldProof: { noNodeModulesBeforeInstall: true, restored: false, cacheMode: "seeded" },
            phases: { ...coldPhases },
            backup: {
              id: backupId,
              sha256: backupHash,
              size: 10,
              sourceRevision: 0,
              generation: 1,
            },
          });
          alterSetup(state);
        } else if (action === "stop") {
          mutations.push("stop");
          Object.assign(state, {
            running: false,
            ready: false,
            lastStopReason: "manual",
            stopGeneration: state.generation,
            stoppedAt: "2026-11-14T00:01:00.000Z",
          });
        } else if (!action) {
          mutations.push("delete");
          state = undefined;
          return Response.json({ destroyed: true, backupDeleted: true });
        }
        return Response.json(state);
      },
      probeFactory: async () => ({
        navigate: async () => {
          if (!state.running) {
            state.generation += 1;
            state.wakeCount += 1;
            state.running = state.ready = true;
            state.phases = {
              kind: "wake",
              generation: state.generation,
              startRequestedAt: "2026-11-14T00:02:00.000Z",
              containerReadyAt: "2026-11-14T00:02:01.000Z",
              restoreStartAt: "2026-11-14T00:02:01.000Z",
              restoreEndAt: "2026-11-14T00:02:02.000Z",
              serverStartAt: "2026-11-14T00:02:02.000Z",
              serverReadyAt: "2026-11-14T00:02:03.000Z",
            };
          }
          return { usable: true, sameUrl: true };
        },
        close: async () => {},
      }),
      journeyFactory: async () => ({ before: {}, afterWake, close: async () => {} }),
    });
    return { adapter, records, mutations, state: () => state };
  }

  for (const alterSetup of [
    (state) => delete state.previewId,
    (state) => (state.previewId = "f".repeat(32)),
    (state) => (state.backup.id = "https://private.example/backup"),
    (state) => (state.backup.sha256 = token),
    (state) => (state.backup.size = 1.5),
    (state) => (state.backup.sourceRevision = -1),
    (state) => (state.backup.generation = 2),
    (state) => (state.phases.generation = 2),
    (state) => (state.phases.containerReadyAt = "2026-11-14T00:00:01+00:00"),
    (state) => delete state.phases.backupStartAt,
  ]) {
    const h = harness({ alterSetup });
    await h.adapter.verifyScope({});
    await assert.rejects(h.adapter.coldStart({}), /runtime_checkpoint_invalid/);
    await assert.rejects(h.adapter.finishCold({}), /runtime_checkpoint_missing/);
    await assert.rejects(h.adapter.coldStart({}), /cold_session_unsettled/);
    assert.deepEqual(await h.adapter.verifyScope({}), { identityReadbackMatched: true });
    assert.deepEqual(h.mutations, ["create", "setup"]);
    assert.equal(
      h.records.some((event) => event.event === "runtime-checkpoint"),
      false,
    );
  }

  for (const purpose of ["cold", "setup", "wake"]) {
    const h = harness({ failPurpose: purpose });
    await h.adapter.verifyScope({});
    if (purpose === "cold") {
      await h.adapter.coldStart({});
      await assert.rejects(h.adapter.finishCold({}), /runtime_checkpoint_write_unknown/);
      await assert.rejects(h.adapter.finishCold({}), /runtime_checkpoint_write_unknown/);
      await assert.rejects(h.adapter.coldStart({}), /cold_session_unsettled/);
    } else if (purpose === "setup") {
      await assert.rejects(h.adapter.setup({}), /runtime_checkpoint_write_unknown/);
      await assert.rejects(h.adapter.finishRun({}), /runtime_checkpoint_write_unknown/);
    } else {
      await h.adapter.setup({});
      await h.adapter.prepareWake({});
      await h.adapter.wake({});
      await assert.rejects(h.adapter.verifyWake({}), /runtime_checkpoint_write_unknown/);
      await assert.rejects(h.adapter.finishRun({}), /runtime_checkpoint_write_unknown/);
    }
    assert.deepEqual(await h.adapter.verifyScope({}), { identityReadbackMatched: true });
    assert.equal(h.mutations.includes("delete"), false);
    assert.equal(
      h.records.filter((event) => event.event === "runtime-checkpoint" && event.purpose === purpose)
        .length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(h.records),
      /possibly written|a-secret-that-must-never-be-saved/,
    );
  }

  const malformedSetup = harness({ alterSetup: (state) => delete state.phases.backupEndAt });
  await malformedSetup.adapter.verifyScope({});
  await assert.rejects(malformedSetup.adapter.setup({}), /runtime_checkpoint_invalid/);
  assert.deepEqual(await malformedSetup.adapter.verifyScope({}), { identityReadbackMatched: true });
  await assert.rejects(malformedSetup.adapter.finishRun({}), /runtime_checkpoint_write_unknown/);
  assert.deepEqual(malformedSetup.mutations, ["create", "setup"]);

  const withoutStartedAt = harness({ alterSetup: (state) => delete state.phases.startedAt });
  await withoutStartedAt.adapter.verifyScope({});
  await withoutStartedAt.adapter.setup({});
  assert.equal(
    Object.hasOwn(withoutStartedAt.records.at(-1), "startedAt"),
    false,
    "an extra controller start clock is optional",
  );

  let releaseCheckpoint, checkpointStarted;
  const started = new Promise((resolve) => {
    checkpointStarted = resolve;
  });
  const resume = new Promise((resolve) => {
    releaseCheckpoint = resolve;
  });
  const pending = harness({
    pauseCheckpoint: async () => {
      checkpointStarted();
      await resume;
    },
  });
  await pending.adapter.verifyScope({});
  await pending.adapter.coldStart({});
  const controller = new AbortController();
  const completion = pending.adapter.finishCold({ signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending.adapter.finishCold({}), /runtime_checkpoint_write_unknown/);
  releaseCheckpoint();
  await assert.rejects(completion, /runtime_checkpoint_write_unknown/);
  assert.deepEqual(await pending.adapter.verifyScope({}), { identityReadbackMatched: true });
  assert.deepEqual(pending.mutations, ["create", "setup"]);

  const failedWake = harness();
  await failedWake.adapter.verifyScope({});
  await failedWake.adapter.setup({});
  await failedWake.adapter.prepareWake({});
  await failedWake.adapter.wake({});
  failedWake.state().wakeCount = 0;
  assert.equal((await failedWake.adapter.verifyWake({})).newGeneration, false);
  assert.equal(failedWake.records.at(-1).purpose, "wake");
  assert.equal(failedWake.records.at(-1).restoreEndAt, "2026-11-14T00:02:02.000Z");

  const capabilityFailure = harness({
    afterWake: async () => {
      throw new Error("wake_capability_unverified");
    },
  });
  await capabilityFailure.adapter.verifyScope({});
  await capabilityFailure.adapter.setup({});
  await capabilityFailure.adapter.capabilityBefore({});
  await capabilityFailure.adapter.prepareWake({});
  await capabilityFailure.adapter.wake({});
  await assert.rejects(capabilityFailure.adapter.verifyWake({}), /wake_capability_unverified/);
  assert.equal(capabilityFailure.records.at(-1).purpose, "wake");
  assert.equal(capabilityFailure.records.at(-1).restoreEndAt, "2026-11-14T00:02:02.000Z");

  for (const alterWake of [
    (state) => (state.backup.size += 1),
    (state) => (state.previewId = "f".repeat(32)),
  ]) {
    const h = harness();
    await h.adapter.verifyScope({});
    await h.adapter.setup({});
    await h.adapter.prepareWake({});
    await h.adapter.wake({});
    alterWake(h.state());
    await assert.rejects(h.adapter.verifyWake({}), /runtime_checkpoint_invalid/);
    await assert.rejects(h.adapter.finishRun({}), /runtime_checkpoint_write_unknown/);
    assert.equal(h.mutations.includes("delete"), false);
    assert.equal(h.records.filter((event) => event.event === "runtime-checkpoint").length, 1);
  }
});
