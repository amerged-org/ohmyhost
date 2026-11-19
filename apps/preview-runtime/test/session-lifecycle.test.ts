import { expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { BACKUP_RETENTION_MS, PreviewBackups, type DirectoryBackupPort } from "../src/backup.js";
import { PreviewSessionController, type PreviewSessionPorts } from "../src/session.js";

function fixture() {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const version = {
    sourceConnectionId: id,
    sourceGeneration: 1,
    sequence: 1,
    commitSha: "a".repeat(40),
  };
  const plan = {
    applicationRoot: ".",
    adapter: "vite-static",
    runtime: "static",
    runtimePolicy: { egressAllowedOrigins: [] },
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
  };
  let now = 1_000,
    running = false,
    refusePreparation = false,
    refuseRenewal = false,
    failStop = false,
    failWrite = false,
    backupCount = 0;
  let cancelBackups = async () => {};
  let record = {
    previewId: id,
    organizationId: id,
    projectId: id,
    environmentId: id,
    dataEnvironmentId: id,
    environment: "prod",
    region: "us",
    assignmentVersion: 1,
    billingEpochId: id,
    ownershipVersion: 1,
    lifecycleVersion: 1,
    rowVersion: 1,
    runtimeGeneration: 1,
    tokenGeneration: 1,
    authGeneration: 1,
    state: "cold",
    targetSource: version,
    appliedSource: null as typeof version | null,
    backup: null as null | { handle: string; source: typeof version; expiresAt: string },
    lastActivityAt: new Date(now).toISOString(),
    paidUntil: null,
    retirement: "none",
  };
  const entries = new Map<string, unknown>(),
    calls: string[] = [],
    deleted: string[] = [],
    closes: unknown[] = [],
    scheduled: Promise<unknown>[] = [];
  const storage = {
    async get<T>(key: string) {
      return entries.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      entries.set(key, structuredClone(value));
    },
    async setAlarm() {},
    async getAlarm() {
      return null;
    },
    async deleteAlarm() {},
  };
  const sdk: DirectoryBackupPort = {
    async backup() {
      calls.push("backup");
      backupCount += 1;
      return {
        id: backupCount === 1 ? "backup-id" : `backup-id-${backupCount}`,
        dir: "/workspace/app",
        size: 1,
        sha256: "b".repeat(64),
        format: "tar+zstd/1",
      };
    },
    async restore() {
      calls.push("restore");
    },
    async delete(record) {
      calls.push("delete");
      deleted.push(record.id);
    },
  };
  const core = {
    async authorizeRuntime(fence: { runtimeGeneration: number; tokenGeneration: number }) {
      return fence.runtimeGeneration === record.runtimeGeneration &&
        fence.tokenGeneration === record.tokenGeneration
        ? record
        : null;
    },
    async getCleanupState() {
      return {
        ...record,
        hasBackup: !!record.backup,
        backupHandle: record.backup?.handle ?? null,
        backupExpiresAt: record.backup?.expiresAt ?? null,
      };
    },
    async renewActivity(input: { occurredAt: string }) {
      record = { ...record, lastActivityAt: input.occurredAt, rowVersion: record.rowVersion + 1 };
      return record;
    },
    async reserveUsage(input: { intervalId: string; start: boolean }) {
      calls.push(input.start ? "reserve-start" : "reserve-renew");
      if (!input.start && refuseRenewal) throw new Error("credit exhausted");
      if (input.start)
        record = {
          ...record,
          state: "starting",
          runtimeGeneration: record.runtimeGeneration + 1,
          rowVersion: record.rowVersion + 1,
        };
      return { preview: record, intervalId: input.intervalId, seconds: 60, quotedMicros: 1 };
    },
    async recordAppliedSource(input: { source: typeof version }) {
      record = { ...record, appliedSource: input.source, rowVersion: record.rowVersion + 1 };
      return record;
    },
    async recordBackup(input: { backup: typeof record.backup }) {
      record = { ...record, backup: input.backup, rowVersion: record.rowVersion + 1 };
      return record;
    },
    async recordState(input: { state: string }) {
      record = { ...record, state: input.state, rowVersion: record.rowVersion + 1 };
      return record;
    },
    async recordStopped() {
      record = {
        ...record,
        state: record.appliedSource ? "sleeping" : "cold",
        rowVersion: record.rowVersion + 1,
      };
      return record;
    },
    async closeUsage(input: unknown) {
      closes.push(input);
    },
    async listBackupCleanup() {
      return [];
    },
    async acknowledgeBackupCleanup() {},
  };
  const writer = {
    async apply() {
      calls.push("write");
      if (failWrite) throw new Error("source write failed");
    },
  };
  const driver = {
    running: () => running,
    async ensureUsageAuthority() {
      return "d".repeat(32);
    },
    async start() {
      calls.push("start");
      running = true;
    },
    async prepareWorkspace() {},
    async prepareCaches() {},
    writer: () => writer,
    async install() {
      calls.push("install");
    },
    async ensurePrepared() {
      if (refusePreparation) throw new Error("preview_native_preparing");
    },
    async prepare() {},
    async updateSource() {},
    async serve() {
      calls.push("serve");
    },
    async destroy() {
      calls.push("destroy");
      if (failStop) throw new Error("stop outcome unknown");
      running = false;
    },
    async closeConnections() {
      calls.push("close-connections");
    },
    async drainNative() {
      calls.push("drain-native");
    },
  };
  const source = {
    async previewDiff(input: { from: typeof version | null; to: typeof version }) {
      return {
        from: input.from,
        to: input.to,
        operations: [],
        dependenciesChanged: input.from === null,
        install: {
          applicationRoot: ".",
          manager: "pnpm",
          version: "10.28.2",
          lockfile: "pnpm-lock.yaml",
          command: "fixed",
        },
        inspection: { frameworkPlan: plan, buildPlanSha256: "same-plan" },
      };
    },
  };
  const backups = new PreviewBackups(storage, sdk);
  const controller = new PreviewSessionController({
    core,
    source,
    storage,
    backups,
    driver,
    cancelBackup: () => cancelBackups(),
    reconcileBackup: async () => {},
    now: () => now,
    waitUntil: (promise: Promise<unknown>) => {
      scheduled.push(promise);
    },
  } as unknown as PreviewSessionPorts);
  return {
    controller,
    calls,
    deleted,
    closes,
    backups,
    sdk,
    version,
    entries,
    core,
    driver,
    writer,
    source,
    record: () => record,
    tick: (ms: number) => {
      now += ms;
    },
    refuse: () => {
      refusePreparation = true;
    },
    refuseRenewal: () => {
      refuseRenewal = true;
    },
    onCancelBackup: (cancel: () => Promise<void>) => {
      cancelBackups = cancel;
    },
    failStop: () => {
      failStop = true;
    },
    failWrite: () => {
      failWrite = true;
    },
    setTarget: () => {
      record = { ...record, targetSource: { ...version, sequence: 2, commitSha: "b".repeat(40) } };
    },
    stopped: () => {
      running = false;
    },
    retire: (retirement: string) => {
      record = { ...record, retirement };
    },
    flush: () => Promise.all(scheduled),
  };
}

it("reserves before starting, sleeps on idle, and restores dependencies without reinstalling", async () => {
  const f = fixture(),
    id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  await f.controller.wake(
    { previewId: id, runtimeGeneration: 1, tokenGeneration: 1 },
    "https://preview.example",
  );
  expect(f.calls.indexOf("reserve-start")).toBeLessThan(f.calls.indexOf("start"));
  expect(f.calls.indexOf("install")).toBeLessThan(f.calls.indexOf("backup"));
  expect(f.calls.indexOf("backup")).toBeLessThan(f.calls.indexOf("serve"));
  f.tick(600_001);
  await f.controller.alarm();
  expect((await f.controller.status()).state).toBe("sleeping");
  await f.controller.sourceChanged(2);
  await f.flush();
  expect(f.calls.filter((value) => value === "start")).toHaveLength(1);
  await f.controller.wake(
    { previewId: id, runtimeGeneration: 2, tokenGeneration: 1 },
    "https://preview.example",
  );
  expect(f.calls).toContain("restore");
  expect(f.calls.filter((value) => value === "install")).toHaveLength(1);
  await f.controller.touch();
  expect(f.record().lastActivityAt).toBe(new Date(601_001).toISOString());
});

it("releases an unstarted reservation without inventing CPU usage", async () => {
  const f = fixture();
  f.refuse();
  await expect(
    f.controller.wake(
      { previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", runtimeGeneration: 1, tokenGeneration: 1 },
      "https://preview.example",
    ),
  ).rejects.toThrow("preview_native_preparing");
  expect(f.calls).not.toContain("start");
  expect(f.closes[0]).toMatchObject({ activeMilliseconds: 0, containerStartAttempted: false });
  expect((await f.controller.status()).failure).toBe("native_preparing");
});

it("fences and cleans exact backup handles after retirement, including interrupted handoff", async () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    fence = { previewId: id, runtimeGeneration: 1, tokenGeneration: 1 };
  const f = fixture();
  await expect(
    f.backups.checkpoint(f.version, 1_000, async () => {
      throw new Error("reply lost");
    }),
  ).rejects.toThrow("reply lost");
  await f.controller.wake(fence, "https://preview.example");
  expect(f.calls).toContain("restore");
  f.retire("rotating");
  await f.controller.fence({ ...fence, runtimeGeneration: 2 }, "rotate");
  expect(f.calls).toContain("drain-native");
  await expect(
    f.backups.checkpoint(f.version, 1_000, async () => {
      throw new Error("handoff never reached Core");
    }),
  ).rejects.toThrow("handoff never reached Core");
  expect((await f.backups.selected())?.record.id).toBe("backup-id-2");
  expect(f.record().backup?.handle).toBe("backup-id");
  f.entries.set("product-scope-cleanup-intent-v1", {
    fence: { ...fence, runtimeGeneration: 2 },
    handle: "backup-id-2",
  });
  f.retire("destroying");
  const handle = await f.controller.cleanupScope({ ...fence, runtimeGeneration: 2 });
  expect(handle).toBe("backup-id");
  expect(f.calls).toContain("delete");
  expect(new Set(f.deleted)).toEqual(new Set(["backup-id", "backup-id-2"]));
  expect((await f.controller.status()).state).toBe("cold");
  expect(await f.controller.cleanupScope({ ...fence, runtimeGeneration: 2 })).toBe(handle);

  const expiring = fixture();
  await expiring.controller.wake(fence, "https://preview.example");
  expiring.tick(600_001);
  await expiring.controller.alarm();
  expiring.tick(BACKUP_RETENTION_MS);
  await expiring.controller.expireBackup({ ...fence, runtimeGeneration: 2 });
  expect(expiring.calls).toContain("delete");

  const failedDrain = fixture();
  await failedDrain.controller.wake(fence, "https://preview.example");
  failedDrain.driver.drainNative = async () => {
    failedDrain.calls.push("drain-native");
    throw new Error("Native drain unavailable");
  };
  failedDrain.retire("destroying");
  const closedFence = { ...fence, runtimeGeneration: 2 };
  await expect(failedDrain.controller.fence(closedFence, "destroy")).rejects.toThrow(
    "Native drain unavailable",
  );
  expect(failedDrain.calls).toContain("destroy");
  expect(failedDrain.driver.running()).toBe(false);
  expect(failedDrain.closes).toHaveLength(1);
  expect((await failedDrain.controller.status()).state).not.toBe("ready");
  expect(failedDrain.record().retirement).toBe("destroying");
  expect(failedDrain.record().backup?.handle).toBe("backup-id");
  expect(failedDrain.deleted).toEqual([]);
  await failedDrain.controller.rememberOrigin("https://preview.example");
  await expect(failedDrain.controller.wake(closedFence, "https://preview.example")).rejects.toThrow(
    "preview_scope_unavailable",
  );
  expect(failedDrain.calls.filter((call) => call === "start")).toHaveLength(1);
  expect(failedDrain.record().retirement).toBe("destroying");
});

it("stops on a lost usage hold or an unexpectedly stopped container", async () => {
  const fence = {
    previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runtimeGeneration: 1,
    tokenGeneration: 1,
  };
  const lostHold = fixture();
  await lostHold.controller.wake(fence, "https://preview.example");
  lostHold.refuseRenewal();
  lostHold.tick(45_001);
  await lostHold.controller.alarm();
  expect((await lostHold.controller.status()).state).toBe("sleeping");
  expect(lostHold.closes).toHaveLength(1);

  const stopped = fixture();
  await stopped.controller.wake(fence, "https://preview.example");
  stopped.stopped();
  await stopped.controller.alarm();
  expect((await stopped.controller.status()).state).toBe("sleeping");
  expect(stopped.closes).toHaveLength(1);

  const uncertain = fixture();
  uncertain.refuse();
  uncertain.failStop();
  await expect(uncertain.controller.wake(fence, "https://preview.example")).rejects.toThrow(
    "preview_native_preparing",
  );
  expect(uncertain.closes).toHaveLength(0);

  const unknownBackup = fixture();
  const pending = {
    current: null,
    records: [],
    pendingDelete: [],
    deleted: [],
    pending: { kind: "unknown", generation: 1, objectKey: "backup-without-upload-id" },
  };
  unknownBackup.entries.set("preview-directory-backup-v1", pending);
  await unknownBackup.controller.alarm();
  expect(unknownBackup.entries.get("preview-directory-backup-v1")).toEqual(pending);

  const failedUpdate = fixture();
  await failedUpdate.controller.wake(fence, "https://preview.example");
  failedUpdate.setTarget();
  failedUpdate.failWrite();
  failedUpdate.failStop();
  await expect(failedUpdate.controller.synchronize()).rejects.toThrow("source write failed");
  expect(failedUpdate.closes).toHaveLength(0);

  // Neither a stalled backup nor an unresponsive guest helper may hold the
  // lifecycle queue ahead of the funding stop or publish a later success.
  for (const blocked of ["backup", "helper"] as const) {
    const pending = fixture();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (blocked === "backup") {
      let rejectBackup!: (error: Error) => void;
      pending.sdk.backup = () => {
        entered();
        return new Promise((resolve, reject) => {
          rejectBackup = reject;
          void gate.then(() =>
            resolve({
              id: "late-backup",
              dir: "/workspace/app",
              size: 1,
              sha256: "b".repeat(64),
              format: "tar+zstd/1",
            }),
          );
        });
      };
      pending.onCancelBackup(() => {
        rejectBackup(new Error("backup cancelled"));
        return new Promise<void>(() => {});
      });
    } else {
      pending.driver.prepareWorkspace = async () => {
        entered();
        await gate;
      };
    }
    const waking = pending.controller.wake(fence, "https://preview.example");
    void waking.catch(() => undefined);
    await waiting;
    pending.refuseRenewal();
    pending.tick(45_001);
    const alarm = pending.controller.alarm();
    await setImmediate();
    expect(pending.calls).toContain("destroy");
    await expect(waking).rejects.toThrow();
    await alarm;
    release();
    await setImmediate();
    expect(pending.record().backup).toBeNull();
    expect(pending.record().state).not.toBe("ready");
    expect(pending.closes).toHaveLength(1);
    if (blocked === "helper") expect(pending.record().appliedSource).toBeNull();
  }

  const failedCleanup = fixture();
  await failedCleanup.controller.wake(fence, "https://preview.example");
  failedCleanup.onCancelBackup(async () => {
    failedCleanup.calls.push("cancel-backup");
    throw new Error("Backup cancellation unavailable");
  });
  failedCleanup.driver.closeConnections = async () => {
    failedCleanup.calls.push("close-connections");
    throw new Error("Connection closure unavailable");
  };
  failedCleanup.refuseRenewal();
  failedCleanup.tick(45_001);
  await expect(failedCleanup.controller.alarm()).rejects.toThrow("Connection closure unavailable");
  expect(failedCleanup.calls.indexOf("cancel-backup")).toBeLessThan(
    failedCleanup.calls.indexOf("destroy"),
  );
  expect(failedCleanup.calls.indexOf("close-connections")).toBeLessThan(
    failedCleanup.calls.indexOf("destroy"),
  );
  expect(failedCleanup.driver.running()).toBe(false);
  expect(failedCleanup.closes).toHaveLength(1);
  expect((await failedCleanup.controller.status()).state).toBe("sleeping");

  const timedOut = fixture();
  const entered = Promise.withResolvers<undefined>();
  let guestSignal: AbortSignal | undefined;
  timedOut.driver.prepareWorkspace = async (signal?: AbortSignal) => {
    guestSignal = signal;
    entered.resolve(undefined);
    await new Promise<void>(() => {});
  };
  timedOut.failStop();
  vi.useFakeTimers();
  try {
    const waking = expect(
      timedOut.controller.wake(fence, "https://preview.example"),
    ).rejects.toThrow("preview_operation_cancelled");
    await entered.promise;
    timedOut.tick(269_999);
    await vi.advanceTimersByTimeAsync(269_999);
    expect(guestSignal?.aborted).toBe(false);
    expect(timedOut.calls).not.toContain("destroy");
    timedOut.tick(1);
    await vi.advanceTimersByTimeAsync(1);
    await waking;
    expect(guestSignal?.aborted).toBe(true);
    expect(timedOut.calls).toContain("destroy");
    expect(timedOut.record().state).not.toBe("ready");
    expect(timedOut.record().appliedSource).toBeNull();
    expect(timedOut.record().backup).toBeNull();
    expect(timedOut.closes).toHaveLength(0);
    expect(timedOut.entries.get("product-run-v1")).toMatchObject({
      fence: { ...fence, runtimeGeneration: 2 },
      startedAt: 1_000,
      holdSequence: 1,
    });
    // The guest never releases its helper, but a public queued call still completes.
    await expect(timedOut.controller.touch()).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("drops rejected wake intents while reconciling an uncertain reservation by its original identity", async () => {
  const fence = {
    previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runtimeGeneration: 1,
    tokenGeneration: 1,
  };
  for (const rejection of [
    "preview_version_conflict",
    "D1_ERROR: CHECK constraint failed: guard_insufficient_credits: SQLITE_CONSTRAINT",
  ]) {
    const f = fixture();
    const reserve = f.core.reserveUsage;
    let refused = true,
      rejectedId = "";
    let rejectedIntent: unknown;
    f.core.reserveUsage = async (input) => {
      if (input.start && (refused || input.intervalId === rejectedId)) {
        rejectedId = input.intervalId;
        rejectedIntent = f.entries.get("product-run-intent-v1");
        throw new Error(rejection);
      }
      return reserve(input);
    };
    await expect(f.controller.wake(fence, "https://preview.example")).rejects.toThrow(rejection);
    expect(f.calls).not.toContain("start");
    expect(f.entries.get("product-run-intent-v1")).toBeNull();
    // A journal left by the previous Worker version must recover the same way.
    f.entries.set("product-run-intent-v1", rejectedIntent);
    refused = false;
    await f.controller.wake(fence, "https://preview.example");
    expect((await f.controller.status()).state).toBe("ready");
    expect(f.calls.filter((call) => call === "start")).toHaveLength(1);
    expect(f.entries.get("product-run-intent-v1")).toBeNull();
  }

  const uncertain = fixture();
  const reserve = uncertain.core.reserveUsage;
  let original: Awaited<ReturnType<typeof reserve>> | undefined;
  uncertain.core.reserveUsage = async (input) => {
    if (original?.intervalId === input.intervalId) return original;
    const result = await reserve(input);
    if (!original) {
      original = result;
      throw new Error("reservation reply lost");
    }
    return result;
  };
  await expect(uncertain.controller.wake(fence, "https://preview.example")).rejects.toThrow(
    "reservation reply lost",
  );
  expect(uncertain.entries.get("product-run-intent-v1")).toMatchObject({
    intervalId: original?.intervalId,
  });
  await uncertain.controller.wake(fence, "https://preview.example");
  expect(uncertain.closes).toEqual([
    expect.objectContaining({
      intervalId: original?.intervalId,
      activeMilliseconds: 0,
      containerStartAttempted: false,
    }),
  ]);
  expect(uncertain.calls.filter((call) => call === "reserve-start")).toHaveLength(2);
  expect(uncertain.calls.filter((call) => call === "start")).toHaveLength(1);
});

it("serializes activity behind a source update so a delayed touch cannot restore stale applied state", async () => {
  const f = fixture();
  await f.controller.wake(
    { previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", runtimeGeneration: 1, tokenGeneration: 1 },
    "https://preview.example",
  );
  const originalGeneration = (await f.controller.status()).fence?.runtimeGeneration;
  f.setTarget();
  let releaseWrite!: () => void, enteredWrite!: () => void, releaseTouch!: () => void;
  const writing = new Promise<void>((resolve) => {
    enteredWrite = resolve;
  });
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const touchGate = new Promise<void>((resolve) => {
    releaseTouch = resolve;
  });
  f.writer.apply = async () => {
    enteredWrite();
    await writeGate;
  };
  const renew = f.core.renewActivity;
  f.core.renewActivity = async (input) => {
    if (input.occurredAt === new Date(1_000).toISOString()) await touchGate;
    return renew(input);
  };
  const updating = f.controller.synchronize();
  await writing;
  const touching = f.controller.touch();
  // Let the competing RPC reach its await; the serialized implementation remains queued.
  await setImmediate();
  f.tick(1);
  releaseWrite();
  await updating;
  releaseTouch();
  await touching;
  expect((await f.controller.status()).applied).toEqual(f.record().targetSource);
  expect((await f.controller.status()).fence?.runtimeGeneration).toBe(originalGeneration);
  expect((await f.controller.status()).lastActivityAt).toBe(1_001);
  expect(f.calls).not.toContain("destroy");
});

it("restarts from a full source snapshot without restoring the unavailable base from a backup", async () => {
  for (const asleep of [false, true]) {
    const f = fixture();
    const fence = {
      previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      runtimeGeneration: 1,
      tokenGeneration: 1,
    };
    await f.controller.wake(fence, "https://preview.example");
    if (asleep) {
      f.tick(600_001);
      await f.controller.alarm();
    }
    f.setTarget();
    const read = f.source.previewDiff;
    f.source.previewDiff = async (input) => ({
      ...(await read(input)),
      from: null,
      dependenciesChanged: true,
    });
    if (asleep)
      await f.controller.wake(
        { ...fence, runtimeGeneration: f.record().runtimeGeneration },
        "https://preview.example",
      );
    else {
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const destroy = f.driver.destroy;
      f.driver.destroy = async () => {
        await destroy();
        entered.resolve(undefined);
        await release.promise;
      };
      const restarting = f.controller.synchronize();
      await entered.promise;
      expect((await f.controller.status()).restartPending).toBe(true);
      release.resolve(undefined);
      await restarting;
      expect((await f.controller.status()).restartPending).toBe(false);
    }
    expect((await f.controller.status()).state).toBe("ready");
    expect((await f.controller.status()).applied).toEqual(f.record().targetSource);
    expect(f.calls.filter((call) => call === "start")).toHaveLength(2);
    expect(f.calls.filter((call) => call === "install")).toHaveLength(2);
    expect(f.calls.filter((call) => call === "backup")).toHaveLength(2);
    expect(f.calls).not.toContain("restore");
    expect(f.deleted).toEqual(["backup-id"]);
  }

  const failed = fixture();
  const fence = {
    previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runtimeGeneration: 1,
    tokenGeneration: 1,
  };
  await failed.controller.wake(fence, "https://preview.example");
  failed.setTarget();
  const read = failed.source.previewDiff;
  failed.source.previewDiff = async (input) => ({
    ...(await read(input)),
    dependenciesChanged: true,
  });
  failed.failStop();
  await expect(failed.controller.synchronize()).rejects.toThrow();
  expect((await failed.controller.status()).restartPending).toBe(false);
});
