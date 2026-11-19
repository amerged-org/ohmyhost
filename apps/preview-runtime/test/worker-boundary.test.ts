import { expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
  decodePreviewValue,
  encodePreviewValue,
} from "@ohmyhost/customer-runtime/preview-transport";
import { createPrivateStorageClient } from "@ohmyhost/customer-runtime/storage";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: unknown,
    ) {}
  },
}));
vi.mock("@cloudflare/sandbox", () => ({
  DirectoryBackupGateway: class {
    readonly synthetic = true;
  },
  DirectoryBackup: class {
    constructor(
      container: unknown,
      private readonly gateway: (input: { props: Record<string, unknown> }) => {
        fetch(request: Request): Promise<Response>;
        createUpload(name?: string): Promise<string>;
        completeUpload(
          uploadId: string,
          parts: { partNumber: number; etag: string }[],
        ): Promise<number>;
        abortUpload(uploadId: string): Promise<void>;
        deleteObject(): Promise<void>;
      },
      private readonly storage: { binding: string; prefix: string },
    ) {
      void container;
    }
    private control(id: string) {
      return this.gateway({
        props: {
          protocolVersion: 1,
          mode: "control",
          binding: this.storage.binding,
          key: `${this.storage.prefix}${id}.tar.zst`,
        },
      });
    }
    async intercept() {
      this.gateway({ props: { protocolVersion: 1, mode: "deny" } });
    }
    async backup(input: { dir: string; name?: string }) {
      const id = "01234567-89ab-cdef-0123-456789abcdef";
      const control = this.control(id),
        uploadId = await control.createUpload(input.name);
      try {
        const write = this.gateway({
          props: {
            protocolVersion: 1,
            mode: "write",
            binding: this.storage.binding,
            key: `${this.storage.prefix}${id}.tar.zst`,
            uploadId,
          },
        });
        const uploaded = await write.fetch(
          new Request("https://backup.invalid/parts/1", { method: "PUT", body: "x" }),
        );
        if (!uploaded.ok) throw new Error("upload denied");
        await control.completeUpload(uploadId, [{ partNumber: 1, etag: "synthetic" }]);
      } catch (error) {
        await control.abortUpload(uploadId);
        throw error;
      }
      return {
        id,
        dir: input.dir,
        size: 1,
        sha256: "b".repeat(64),
        format: "tar+zstd/1",
      };
    }
    async restore() {}
    async delete(record: { id: string }) {
      await this.control(record.id).deleteObject();
    }
  },
}));

import worker, { PreviewEgress, PreviewExecution, PreviewSandbox } from "../src/worker-main.js";

it("routes only the exact capability through the private actor and authorizes outbound operations", async () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    token = "a".repeat(52),
    origin = `https://${token}.preview.dev.omh.st`;
  const source = {
    sourceConnectionId: id,
    sourceGeneration: 1,
    sequence: 1,
    commitSha: "a".repeat(40),
  };
  const record = {
    previewId: id,
    runtimeGeneration: 1,
    tokenGeneration: 1,
    state: "ready",
    retirement: "none",
    targetSource: source,
    appliedSource: source,
    region: "us",
    authGeneration: 1,
    assignmentVersion: 1,
    billingEpochId: id,
    dataEnvironmentId: id,
    ownershipVersion: 1,
    lifecycleVersion: 1,
  };
  const actor = {
    fetch: vi.fn(async () => new Response("app")),
    wake: vi.fn(async () => {}),
    sourceChanged: vi.fn(async () => {}),
    fence: vi.fn(async () => {}),
  };
  const authority = {
    resolveTokenHash: vi.fn(async () => record),
    authorizeRuntime: vi.fn(async () => record),
  };
  const env = {
    PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
    PREVIEW_AUTHORITY: authority,
    PREVIEW_CONTAINERS: { getByName: () => actor },
  };
  expect((await worker.fetch(new Request(origin), env as never)).status).toBe(200);
  expect((await worker.fetch(new Request("https://foreign.example/"), env as never)).status).toBe(
    404,
  );
  const pending: Promise<unknown>[] = [];
  const context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
  const execution = new PreviewExecution(context as never, env as never);
  await execution.wake({
    previewId: id,
    runtimeGeneration: 1,
    tokenGeneration: 1,
    publicOrigin: origin,
  });
  await Promise.all(pending);
  expect(actor.wake).toHaveBeenCalledOnce();
  await expect(
    execution.wake({
      previewId: id,
      runtimeGeneration: 1,
      tokenGeneration: 2,
      publicOrigin: origin,
    }),
  ).rejects.toThrow("preview_scope_unavailable");
  await expect(
    execution.wake({
      previewId: id,
      runtimeGeneration: 1,
      tokenGeneration: 1,
      publicOrigin: `${origin}/path`,
    }),
  ).rejects.toThrow("preview_scope_unavailable");
  expect(actor.wake).toHaveBeenCalledOnce();
  await execution.sourceChanged({ previewId: id, sequence: 2 });
  await execution.fence({
    previewId: id,
    runtimeGeneration: 1,
    tokenGeneration: 2,
    reason: "rotate",
  });
  await expect(
    execution.fence({
      previewId: id,
      runtimeGeneration: 1,
      tokenGeneration: 2,
      reason: "foreign" as never,
    }),
  ).rejects.toThrow("preview_fence_invalid");
  expect(actor.sourceChanged).toHaveBeenCalled();
  expect(actor.fence).toHaveBeenCalledOnce();
  const egress = new PreviewEgress(
    {
      props: {
        fence: { previewId: id, runtimeGeneration: 1, tokenGeneration: 1 },
        selection: { source, database: false, auth: false, mail: false, storage: false, ai: false },
        phase: "runtime",
        allowedOrigins: [],
        publicOrigin: origin,
      },
      waitUntil: () => {},
    } as never,
    env as never,
  );
  expect((await egress.fetch(new Request("http://preview.capabilities/ready"))).status).toBe(200);
  expect((await egress.fetch(new Request("https://foreign.example/"))).status).toBe(403);
  authority.resolveTokenHash.mockRejectedValueOnce(new Error("authority unavailable"));
  expect((await worker.fetch(new Request(origin), env as never)).status).toBe(503);
});

it("serves a no-store status without starting a sleeping container", async () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    token = "a".repeat(52),
    origin = `https://${token}.preview.dev.omh.st`;
  const record = { previewId: id, runtimeGeneration: 1, tokenGeneration: 1 };
  const entries = new Map<string, unknown>();
  const storage = {
    async get(key: string) {
      return entries.get(key);
    },
    async put(key: string, value: unknown) {
      entries.set(key, value);
    },
    async getAlarm() {
      return null;
    },
    async setAlarm() {},
    async deleteAlarm() {},
  };
  const container = {
    running: false,
    images: {},
    start: vi.fn(),
    async destroy() {},
    async setInactivityTimeout() {},
  };
  const context = {
    id: { name: id },
    storage,
    container,
    exports: { PreviewBackupGateway: () => ({}), PreviewEgress: () => ({}) },
    waitUntil: () => {},
    blockConcurrencyWhile: async (run: () => Promise<unknown>) => run(),
  };
  const env = {
    PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
    PREVIEW_AUTHORITY: {
      resolveTokenHash: async () => record,
      authorizeRuntime: async () => record,
    },
    PREVIEW_SOURCE: {},
  };
  const actor = new PreviewSandbox(context as never, env as never);
  const response = await actor.fetch(new Request(`${origin}/__ohmyhost/preview/status`));
  expect(await response.json()).toMatchObject({ state: "cold", phase: "idle", failure: null });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(container.start).not.toHaveBeenCalled();
});

it("retries exact cleanup, Native preparation and usage reconciliation without inventing provider facts", async () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    otherId = "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    calls: string[] = [];
  const actor = {
    async sourceChanged() {
      calls.push("source");
    },
    async expireBackup() {
      calls.push("backup");
    },
    async cleanupScope() {
      calls.push("cleanup");
      return "backup-id";
    },
    async fence(_fence: unknown, reason: string) {
      calls.push(reason);
    },
  };
  const failedActor = {
    ...actor,
    async sourceChanged() {
      throw new Error("temporary failure");
    },
    async cleanupScope() {
      return null;
    },
  };
  const candidates = [
    ...["resume", "backup_cleanup", "rotation", "destroy", "expired", "scope"].map((reason) => ({
      previewId: id,
      runtimeGeneration: 2,
      tokenGeneration: 1,
      rowVersion: 1,
      reason,
    })),
    {
      previewId: otherId,
      runtimeGeneration: 2,
      tokenGeneration: 1,
      rowVersion: 1,
      reason: "scope",
    },
  ];
  const core = {
    async listPendingSources() {
      return [
        { previewId: id, sequence: 1 },
        { previewId: otherId, sequence: 1 },
      ];
    },
    async acknowledgeSource() {
      calls.push("ack-source");
    },
    async getNativePreparationCursor() {
      return null;
    },
    async listPendingNativePreparations() {
      return [{ operationId: id }];
    },
    async setNativePreparationCursor() {
      calls.push("native-cursor");
    },
    async listCleanupCandidates() {
      return candidates;
    },
    async resumeSuspended() {
      calls.push("resume");
    },
    async confirmRotation() {
      calls.push("confirm-rotation");
    },
    async confirmDestroy() {
      calls.push("confirm-destroy");
    },
    async claimExpiredBackup() {
      return { backup: null };
    },
    async claimScopeCleanup(input: { previewId: string }) {
      return {
        previewId: input.previewId,
        runtimeGeneration: 2,
        tokenGeneration: 1,
        hasBackup: true,
      };
    },
    async finishScopeCleanup() {
      calls.push("finish-cleanup");
    },
  };
  const applicationId = "d".repeat(32),
    providerApplicationId = "dddddddd-dddd-dddd-dddd-dddddddddddd",
    instanceId = "c".repeat(64);
  const run = {
    previewId: id,
    runtimeGeneration: 2,
    intervalId: "observed-run",
    applicationId,
    startedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T00:00:10.000Z",
  };
  const reporter = {
    async getReconciliationCursor() {
      throw new Error("usage scheduling must use durable due work");
    },
    async listUsageForReconciliation(input: { limit: number }) {
      expect(input).toEqual({ limit: 20 });
      return [run, { ...run, intervalId: "pending-run" }, { ...run, intervalId: "failed-run" }];
    },
    observeUsage: vi.fn(async () => {}),
    async setReconciliationCursor() {
      throw new Error("failed work must not be skipped by a cursor");
    },
  };
  const env = {
    PREVIEW_AUTHORITY: core,
    PREVIEW_CONTAINERS: {
      getByName: (name: string) => (name === otherId ? failedActor : actor),
      idFromName: () => ({ toString: () => instanceId }),
    },
    PREVIEW_NATIVE_PREPARATION: {
      async prepare() {
        calls.push("native-prepare");
      },
    },
    PREVIEW_USAGE_REPORTER: reporter,
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_PREVIEW_USAGE_TOKEN: "synthetic-test-token",
    PREVIEW_CONTAINER_APPLICATION_NAME: "live-preview",
  };
  const providerFetch = vi.fn(async (request: Request) => {
    const input = (await request.json()) as {
      variables: { runLabel: string; instance: string; application: string };
    };
    expect(input.variables).toMatchObject({
      instance: instanceId,
      application: providerApplicationId,
    });
    if (input.variables.runLabel === "run=failed-run") throw new Error("provider unavailable");
    const rows =
      input.variables.runLabel === "run=observed-run"
        ? [
            {
              dimensions: {
                instanceId,
                applicationId: providerApplicationId,
                preview: id,
                runtime: "2",
                run: "observed-run",
              },
              sum: { cpuTimeSec: 0.1234 },
            },
          ]
        : [];
    return Response.json({
      data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: rows }] } },
    });
  });
  vi.stubGlobal("fetch", providerFetch);
  try {
    await worker.scheduled({}, env as never);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(calls).toEqual(
    expect.arrayContaining([
      "source",
      "ack-source",
      "native-prepare",
      "native-cursor",
      "resume",
      "backup",
      "rotate",
      "confirm-rotation",
      "destroy",
      "confirm-destroy",
      "cleanup",
      "finish-cleanup",
    ]),
  );
  expect(calls.filter((value) => value === "ack-source")).toHaveLength(1);
  expect(calls.filter((value) => value === "finish-cleanup")).toHaveLength(1);
  expect(reporter.observeUsage).toHaveBeenCalledOnce();
  expect(providerFetch).toHaveBeenCalledTimes(3);
  expect(reporter.observeUsage).toHaveBeenCalledWith({
    previewId: id,
    runtimeGeneration: 2,
    intervalId: "observed-run",
    cpuMilliseconds: 124,
    observedAt: expect.any(String),
    providerFactId: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
});

function sandboxFixture() {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    token = "a".repeat(52);
  const origin = `https://${token}.preview.dev.omh.st`;
  const fence = { previewId: id, runtimeGeneration: 1, tokenGeneration: 1 };
  const source = {
    sourceConnectionId: id,
    sourceGeneration: 1,
    sequence: 1,
    commitSha: "a".repeat(40),
  };
  const browser = {
    connect: [],
    scripts: [],
    styles: [],
    images: [],
    fonts: [],
    frames: [],
    frameAncestors: [],
    workers: { self: false, blob: false },
    cors: { origins: ["https://allowed.example"], credentials: false },
  };
  const plan = {
    applicationRoot: ".",
    adapter: "vite-static",
    runtime: "edge",
    runtimePolicy: { egressAllowedOrigins: ["https://allowed.example"], browser },
    database: { enabled: true },
    auth: { provider: "omh-native" },
    mail: { enabled: true },
    storage: { enabled: true, jurisdiction: "eu" },
    ai: { enabled: true },
  };
  let record = {
    ...fence,
    organizationId: id,
    projectId: id,
    environmentId: id,
    dataEnvironmentId: id,
    region: "eu",
    assignmentVersion: 1,
    billingEpochId: id,
    ownershipVersion: 1,
    lifecycleVersion: 1,
    authGeneration: 1,
    rowVersion: 1,
    state: "ready",
    retirement: "none",
    targetSource: source,
    appliedSource: source,
    lastActivityAt: new Date().toISOString(),
    backup: null as { handle: string; expiresAt: string } | null,
  };
  const entries = new Map<string, unknown>(),
    pending: Promise<unknown>[] = [];
  let alarm: number | null = null;
  const storage = {
    async get(key: string) {
      return entries.get(key);
    },
    async put(key: string, value: unknown) {
      entries.set(key, structuredClone(value));
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(value: number) {
      alarm = value;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
  const network: { props: unknown; target: string }[] = [],
    upstream: { port: number; request: Request }[] = [];
  let contentType = "text/plain";
  const container = {
    running: true,
    images: { preview: "image" },
    start: vi.fn(),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    interceptOutboundHttp: vi.fn(async (target: string) => {
      network.push({ target, props: null });
    }),
    interceptAllOutboundHttp: vi.fn(async () => {
      network.push({ target: "all-http", props: null });
    }),
    interceptOutboundHttps: vi.fn(async (target: string) => {
      network.push({ target, props: null });
    }),
    getTcpPort(port: number) {
      return {
        async fetch(request: Request) {
          upstream.push({ port, request });
          return new Response("application", {
            headers: {
              "content-type": contentType,
              "access-control-allow-origin": "https://allowed.example",
              "access-control-allow-credentials": "true",
            },
          });
        },
      };
    },
  };
  const core = {
    resolveTokenHash: vi.fn(async () => record),
    authorizeRuntime: vi.fn(async (candidate: typeof fence) =>
      candidate.previewId === id &&
      candidate.runtimeGeneration === record.runtimeGeneration &&
      candidate.tokenGeneration === record.tokenGeneration
        ? record
        : null,
    ),
    getCleanupState: vi.fn(async () => ({
      ...record,
      hasBackup: record.backup !== null,
      backupHandle: record.backup?.handle ?? null,
      backupExpiresAt: record.backup?.expiresAt ?? null,
    })),
    renewActivity: vi.fn(async () => record),
    queueNativePreparation: vi.fn(async () => ({ operationId: id, state: "pending" })),
    listBackupCleanup: vi.fn(async () => []),
  };
  const native = {
    fetchPreview: vi.fn(async () => new Response("native")),
    validatePreviewSession: vi.fn(async () => ({ subject: "customer" })),
    drainPreview: vi.fn(async () => {}),
  };
  const database = {
    execute: vi.fn(async () => ({ rows: [1] })),
    open: vi.fn(async () => ({ close: async () => {} })),
  };
  const previewDiff = vi.fn(async () => ({
    from: null,
    to: source,
    operations: [],
    dependenciesChanged: false,
    install: null,
    inspection: { frameworkPlan: plan, buildPlanSha256: "plan-hash" },
  }));
  const nativePrepare = vi.fn(async () => {});
  const backupTarget = {
    fetch: vi.fn(async () => new Response()),
    createUpload: vi.fn(async () => {
      expect(entries.get("preview-directory-backup-v1")).toMatchObject({
        pending: {
          kind: "creating",
          objectKey: `preview-backups/${id}/01234567-89ab-cdef-0123-456789abcdef.tar.zst`,
        },
      });
      return "synthetic-upload";
    }),
    completeUpload: vi.fn(async () => 1),
    abortUpload: vi.fn(async () => {}),
    deleteObject: vi.fn(async () => {}),
  };
  let backupActor: PreviewSandbox | null = null;
  let failBackupTransfer = false;
  const backupGateway = vi.fn(({ props }: { props: Record<string, unknown> }) => {
    if (props["mode"] !== "write") return backupTarget;
    return {
      ...backupTarget,
      fetch: async () => {
        if (!backupActor || typeof props["operationId"] !== "string")
          throw new Error("missing grant");
        const message = {
          operationId: props["operationId"],
          transferId: crypto.randomUUID(),
          partNumber: 1,
        };
        const permit = await backupActor.reserveBackupTransfer({
          ...message,
          kind: "reserve-upload",
          bytes: 1,
        });
        expect(permit).toMatchObject({
          mode: "write",
          binding: props["binding"],
          key: props["key"],
          uploadId: props["uploadId"],
          expiresAt: props["expiresAt"],
        });
        const run = entries.get("product-run-v1") as { holdAt: number };
        entries.set("product-run-v1", { ...run, holdAt: Date.now() - 45_000 });
        await expect(
          backupActor.reserveBackupTransfer({ kind: "check", operationId: props["operationId"] }),
        ).rejects.toThrow();
        entries.set("product-run-v1", run);
        await expect(
          backupActor.reserveBackupTransfer({ kind: "check", operationId: crypto.randomUUID() }),
        ).rejects.toThrow();
        await backupActor.reserveBackupTransfer({ ...message, kind: "dispatch-upload" });
        await backupActor.observeBackupPart({
          ...message,
          kind: "uploaded",
          key: props["key"] as string,
          uploadId: props["uploadId"] as string,
          etag: "synthetic",
        });
        await backupActor.reserveBackupTransfer({
          ...message,
          kind: "finish-upload",
          etag: "synthetic",
        });
        if (failBackupTransfer) {
          failBackupTransfer = false;
          return new Response(null, { status: 502 });
        }
        return Response.json({ etag: "synthetic" });
      },
    };
  });
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
    PREVIEW_AUTHORITY: core,
    PREVIEW_SOURCE: { previewDiff },
    PREVIEW_NATIVE_PREPARATION: { prepare: nativePrepare },
    DATABASE_PREVIEW_EU: database,
    NATIVE_PREVIEW_EU: native,
  };
  const context = {
    id: { name: id },
    storage,
    container,
    exports: {
      PreviewBackupGateway: backupGateway,
      PreviewEgress: ({ props }: { props: unknown }) => {
        network.push({ target: "props", props });
        return { fetch: async () => new Response() };
      },
    },
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    async blockConcurrencyWhile(run: () => Promise<unknown>) {
      return run();
    },
  };
  const flush = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return {
    id,
    origin,
    fence,
    source,
    plan,
    core,
    env,
    context,
    container,
    entries,
    network,
    upstream,
    native,
    database,
    previewDiff,
    nativePrepare,
    backupTarget,
    backupGateway,
    setBackupActor: (actor: PreviewSandbox) => {
      backupActor = actor;
    },
    failNextBackupTransfer: () => {
      failBackupTransfer = true;
    },
    flush,
    record: () => record,
    setRecord: (next: typeof record) => {
      record = next;
    },
    setContentType: (value: string) => {
      contentType = value;
    },
  };
}

it("keeps provider egress bound to the selected source, region and generation", async () => {
  const f = sandboxFixture();
  const selection = {
    source: f.source,
    database: true,
    auth: true,
    mail: true,
    storage: true,
    ai: true,
  };
  const held = vi.fn(async () => ({ handle: "scoped-handle" })),
    refreshNative = vi.fn(async () => {});
  const platform = { fetchPreview: vi.fn(async () => new Response("gateway")) };
  const env = {
    ...f.env,
    PREVIEW_RUNTIME_SECRETS: platform,
    PREVIEW_CONTAINERS: {
      getByName: (name: string) => {
        expect(name).toBe(f.id);
        return { database: held, refreshNative };
      },
    },
  };
  const pending: Promise<unknown>[] = [];
  const runtime = new PreviewEgress(
    {
      props: {
        fence: f.fence,
        selection,
        phase: "runtime",
        allowedOrigins: ["https://allowed.example"],
        publicOrigin: f.origin,
      },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as never,
    env as never,
  );
  const post = (url: string, body: unknown) =>
    new Request(url, { method: "POST", body: encodePreviewValue(body) });
  const direct = await runtime.fetch(
    post("http://preview.capabilities/database/query", { text: "SELECT 1", values: [] }),
  );
  expect(decodePreviewValue(await direct.text())).toEqual({ rows: [1] });
  expect(f.database.execute).toHaveBeenCalledWith({
    fence: f.fence,
    operation: "query",
    input: { text: "SELECT 1", values: [] },
  });
  const opened = await runtime.fetch(post("http://preview.capabilities/database/open", null));
  expect(decodePreviewValue(await opened.text())).toEqual({ handle: "scoped-handle" });
  expect(held).toHaveBeenCalledWith({
    fence: f.fence,
    region: "eu",
    operation: "open",
    input: null,
  });
  const auth = await runtime.fetch(
    new Request("http://preview.capabilities/native-auth/session", {
      method: "POST",
      headers: { cookie: "session=synthetic" },
    }),
  );
  expect(decodePreviewValue(await auth.text())).toEqual({ subject: "customer" });
  expect(f.native.validatePreviewSession).toHaveBeenCalledWith({
    fence: f.fence,
    cookie: "session=synthetic",
    publicOrigin: f.origin,
  });
  f.native.validatePreviewSession.mockRejectedValueOnce(new Error("temporarily unavailable"));
  expect(
    (
      await runtime.fetch(
        new Request("http://preview.capabilities/native-auth/session", { method: "POST" }),
      )
    ).status,
  ).toBe(503);
  await Promise.all(pending);
  expect(refreshNative).toHaveBeenCalledOnce();
  f.native.validatePreviewSession.mockRejectedValueOnce(new Error("temporarily unavailable"));
  refreshNative.mockRejectedValueOnce(new Error("refresh unavailable"));
  expect(
    (
      await runtime.fetch(
        new Request("http://preview.capabilities/native-auth/session", { method: "POST" }),
      )
    ).status,
  ).toBe(503);
  await Promise.all(pending);
  expect(refreshNative).toHaveBeenCalledTimes(2);
  for (const service of ["mail", "storage", "ai"]) {
    expect(
      (
        await runtime.fetch(
          new Request(`https://preview-${service}.invalid/v1/send?x=1`, {
            method: "POST",
            body: "test",
          }),
        )
      ).status,
    ).toBe(200);
    const call = platform.fetchPreview.mock.calls.at(-1);
    if (!call) throw new Error("missing gateway request");
    const [request, fence] = call as unknown as [Request, typeof f.fence];
    expect(request.url).toBe(`http://preview.capabilities/${service}/v1/send?x=1`);
    expect(fence).toEqual(f.fence);
  }
  let accepted = false;
  const deniedSocket = {
    accept: vi.fn(() => {
      accepted = true;
    }),
    close: vi.fn(() => {
      expect(accepted).toBe(true);
    }),
  };
  const deniedUpgrade = new Response(null);
  Object.defineProperty(deniedUpgrade, "status", { value: 101 });
  Object.defineProperty(deniedUpgrade, "webSocket", { value: deniedSocket });
  platform.fetchPreview.mockImplementationOnce(async () => {
    f.setRecord({ ...f.record(), assignmentVersion: f.record().assignmentVersion + 1 });
    return deniedUpgrade;
  });
  expect(
    (
      await runtime.fetch(
        new Request("https://preview-ai.invalid/v1/realtime?model=voice", {
          headers: { upgrade: "websocket" },
        }),
      )
    ).status,
  ).toBe(409);
  expect(deniedSocket.accept).toHaveBeenCalledOnce();
  expect(deniedSocket.close).toHaveBeenCalledWith(1001, "Preview ended");
  const send = vi.fn(async (request: Request) => {
    expect(request).toBeInstanceOf(Request);
    return new Response("local intercept");
  });
  vi.stubGlobal("fetch", send);
  try {
    expect((await runtime.fetch(new Request("https://allowed.example/path"))).status).toBe(200);
    expect(send.mock.calls[0]?.[0].redirect).toBe("manual");
    expect((await runtime.fetch(new Request("https://other.example/path"))).status).toBe(403);
    const install = new PreviewEgress(
      {
        props: {
          fence: f.fence,
          selection,
          phase: "install",
          allowedOrigins: [],
          publicOrigin: f.origin,
        },
        waitUntil: () => {},
      } as never,
      env as never,
    );
    expect((await install.fetch(new Request("http://preview.capabilities/ready"))).status).toBe(
      403,
    );
    expect(
      (
        await install.fetch(
          new Request("https://registry.npmjs.org/pkg", {
            headers: {
              authorization: "Bearer synthetic",
              cookie: "synthetic=1",
              "proxy-authorization": "synthetic",
            },
          }),
        )
      ).status,
    ).toBe(200);
    const sent = send.mock.calls.at(-1)?.[0];
    if (!sent) throw new Error("missing registry request");
    expect(
      sent.headers.has("authorization") ||
        sent.headers.has("cookie") ||
        sent.headers.has("proxy-authorization"),
    ).toBe(false);
    expect((await install.fetch(new Request("https://other.example/"))).status).toBe(403);
    f.setRecord({ ...f.record(), targetSource: { ...f.source, sequence: 2 } });
    expect((await runtime.fetch(new Request("https://allowed.example/"))).status).toBe(403);
    expect(
      (await runtime.fetch(post("http://preview.capabilities/database/query", {}))).status,
    ).toBe(403);
    expect(send).toHaveBeenCalledTimes(2);
    f.core.authorizeRuntime.mockRejectedValueOnce(new Error("authority unavailable"));
    expect((await runtime.fetch(new Request("https://allowed.example/"))).status).toBe(403);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("uses managed signed R2 URLs through the existing storage SDK without customer origin grants", async () => {
  for (const jurisdiction of ["eu", "us"]) {
    const f = sandboxFixture();
    f.plan.storage.jurisdiction = jurisdiction;
    f.entries.set("product-session-v1", {
      state: "ready",
      phase: "ready",
      failure: null,
      failedAt: null,
      fence: f.fence,
      applied: f.source,
      plan: f.plan,
      planHash: "plan-hash",
      region: "eu",
      lastActivityAt: Date.now(),
    });
    const actor = new PreviewSandbox(f.context as never, f.env as never);
    expect((await actor.fetch(new Request(`${f.origin}/`))).status).toBe(200);
    const configured = f.network.find((entry) => entry.target === "props");
    if (!configured) throw new Error("runtime network was not configured");
    const r2Origin = `https://${"a".repeat(32)}.${jurisdiction}.r2.cloudflarestorage.com`;
    const signedUrl = `${r2Origin}/managed-bucket/item.txt?X-Amz-Signature=synthetic`;
    const platform = {
      fetchPreview: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/storage/v1/uploads/complete")
          return Response.json({ state: "completed", transfer_id: f.id });
        return Response.json({
          state: "ready",
          ...(path === "/storage/v1/uploads" ? { transfer_id: f.id } : {}),
          capability: {
            operation: path === "/storage/v1/uploads" ? "PUT" : "GET",
            objectKey: "item.txt",
            url: signedUrl,
            expiresAt: "2027-01-01T00:00:00.000Z",
            expectedContentLength: 3,
            requiredHeaders: { "content-type": "text/plain" },
          },
        });
      }),
    };
    const egress = new PreviewEgress(
      { props: configured.props, waitUntil: () => {} } as never,
      { ...f.env, PREVIEW_RUNTIME_SECRETS: platform } as never,
    );
    const objectFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe(signedUrl);
      if (request.method === "PUT") expect(await request.text()).toBe("abc");
      return new Response(request.method === "PUT" ? null : "abc");
    });
    vi.stubGlobal("fetch", objectFetch);
    try {
      const storage = createPrivateStorageClient({
        projectId: f.id,
        environmentId: f.id,
        endpoint: "https://preview-storage.invalid",
        key: "A".repeat(43),
        fetch: (request) => egress.fetch(request),
        capabilityFetch: (request) => egress.fetch(request),
      });
      expect(
        await storage.upload({
          idempotencyKey: "upload-one",
          objectKey: "item.txt",
          contentType: "text/plain",
          bytes: new TextEncoder().encode("abc"),
        }),
      ).toEqual({ state: "completed", transferId: f.id });
      const read = await storage.createSignedRead("item.txt");
      expect(await (await egress.fetch(new Request(read.url))).text()).toBe("abc");
      expect(
        (await egress.fetch(new Request(signedUrl.replace("a".repeat(32), "b".repeat(32))))).status,
      ).toBe(403);
      const otherJurisdiction = jurisdiction === "eu" ? "us" : "eu";
      expect(
        (
          await egress.fetch(
            new Request(signedUrl.replace(`.${jurisdiction}.r2.`, `.${otherJurisdiction}.r2.`)),
          )
        ).status,
      ).toBe(403);
      expect(objectFetch).toHaveBeenCalledTimes(2);
      const aiOnly = sandboxFixture();
      aiOnly.plan.storage.enabled = false;
      aiOnly.entries.set("product-session-v1", {
        state: "ready",
        phase: "ready",
        failure: null,
        failedAt: null,
        fence: aiOnly.fence,
        applied: aiOnly.source,
        plan: aiOnly.plan,
        planHash: "plan-hash",
        region: "eu",
        lastActivityAt: Date.now(),
      });
      const aiActor = new PreviewSandbox(aiOnly.context as never, aiOnly.env as never);
      await aiActor.fetch(new Request(`${aiOnly.origin}/`));
      expect(aiOnly.network.find((entry) => entry.target === "props")?.props).toMatchObject({
        allowedOrigins: ["https://allowed.example"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

it("enforces browser scope and source consistency before proxying a ready preview", async () => {
  const f = sandboxFixture();
  f.entries.set("product-session-v1", {
    state: "ready",
    phase: "ready",
    failure: null,
    failedAt: null,
    fence: f.fence,
    applied: f.source,
    plan: f.plan,
    planHash: "plan-hash",
    region: "eu",
    lastActivityAt: Date.now(),
  });
  const actor = new PreviewSandbox(f.context as never, f.env as never);
  const waitUntil = vi.spyOn(f.context, "waitUntil");
  f.entries.set("product-source-notification-v1", 2);
  const initialStatus = await actor.fetch(new Request(`${f.origin}/__ohmyhost/preview/status`));
  expect(await initialStatus.json()).toMatchObject({ state: "ready", runtimeRevision: 1 });
  expect(waitUntil).not.toHaveBeenCalled();
  f.entries.delete("product-source-notification-v1");
  waitUntil.mockRestore();
  const originalRecord = f.record();
  f.setRecord({ ...originalRecord, runtimeGeneration: 2 });
  const fencedStatus = await actor.fetch(new Request(`${f.origin}/__ohmyhost/preview/status`));
  expect(await fencedStatus.json()).toMatchObject({ state: "sleeping", runtimeRevision: null });
  f.setRecord(originalRecord);
  const forged = await actor.fetch(
    new Request(`${f.origin}/__ohmyhost/preview/wake`, {
      method: "POST",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    }),
  );
  expect(forged.status).toBe(403);
  expect((await actor.fetch(new Request(`${f.origin}/__ohmyhost/preview/private`))).status).toBe(
    404,
  );
  expect(
    (
      await actor.fetch(
        new Request(`${f.origin}/action`, {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await actor.fetch(
        new Request(`${f.origin}/hot`, {
          headers: { upgrade: "websocket", origin: "https://evil.example" },
        }),
      )
    ).status,
  ).toBe(403);
  const proxied = await actor.fetch(
    new Request(`${f.origin}/api/items`, {
      method: "POST",
      headers: {
        origin: "https://allowed.example",
        referer: `${f.origin}/page`,
        "cf-connecting-ip": "192.0.2.5",
        "x-ohmyhost-preview-client-address": "spoof",
      },
      body: "value",
    }),
  );
  expect(proxied.status).toBe(200);
  expect(proxied.headers.get("content-security-policy")).toContain(
    `connect-src 'self' ${f.origin.replace("https:", "wss:")}`,
  );
  expect(proxied.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
  expect(proxied.headers.has("access-control-allow-credentials")).toBe(false);
  const firstRequest = f.upstream[0];
  if (!firstRequest) throw new Error("missing proxied request");
  const { port, request } = firstRequest;
  expect(port).toBe(3003);
  expect(request.url).toBe(`${f.origin.replace("https:", "http:")}/api/items`);
  expect(request.headers.has("cf-connecting-ip")).toBe(false);
  expect(request.headers.has("x-ohmyhost-preview-client-address")).toBe(false);
  expect(atob(request.headers.get("x-ohmyhost-preview-original-origin") ?? "")).toBe(
    "https://allowed.example",
  );
  expect(atob(request.headers.get("x-ohmyhost-preview-original-referer") ?? "")).toBe(
    `${f.origin}/page`,
  );
  expect(f.network.map((value) => value.target)).toEqual([
    "props",
    "preview.capabilities",
    "all-http",
    "*",
  ]);
  expect(f.network[0]?.props).toMatchObject({
    fence: f.fence,
    phase: "runtime",
    selection: {
      source: f.source,
      database: true,
      auth: true,
      mail: true,
      storage: true,
      ai: true,
    },
  });
  for (const address of ["bad", "1.2.3.999", "01.2.3.4", "::gg"]) {
    expect(
      (
        await actor.fetch(
          new Request(`${f.origin}/api/auth/v1/session`, {
            headers: { "x-ohmyhost-preview-client-address": address },
          }),
        )
      ).status,
    ).toBe(403);
  }
  for (const address of ["192.0.2.1", "2001:db8::1"]) {
    expect(
      await (
        await actor.fetch(
          new Request(`${f.origin}/api/auth/v1/session`, {
            headers: { "x-ohmyhost-preview-client-address": address },
          }),
        )
      ).text(),
    ).toBe("native");
    expect(f.native.fetchPreview).toHaveBeenLastCalledWith(expect.any(Request), {
      fence: f.fence,
      publicOrigin: f.origin,
      clientAddress: address,
    });
  }
  f.entries.set("product-native-target-v1", 1);
  f.core.getCleanupState.mockRejectedValueOnce(new Error("authority unavailable"));
  f.native.fetchPreview.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  expect(
    (
      await actor.fetch(
        new Request(`${f.origin}/api/auth/v1/session`, {
          headers: { "x-ohmyhost-preview-client-address": "192.0.2.1" },
        }),
      )
    ).status,
  ).toBe(503);
  await f.flush();
  const opened = (await actor.database({
    fence: f.fence,
    region: "eu",
    operation: "open",
    input: null,
  })) as { handle: string };
  await expect(
    actor.database({ fence: f.fence, region: "us", operation: "open", input: null }),
  ).rejects.toThrow("preview_database_unavailable");
  await actor.database({
    fence: f.fence,
    region: "eu",
    operation: "connection-close",
    input: opened,
  });
  expect(f.database.open).toHaveBeenCalledOnce();
  f.setRecord({ ...f.record(), targetSource: { ...f.source, sequence: 2 } });
  expect(
    (
      await actor.fetch(
        new Request(`${f.origin}/api/auth/v1/session`, {
          headers: { "x-ohmyhost-preview-client-address": "192.0.2.1" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await actor.fetch(
        new Request(`${f.origin}/action`, { method: "POST", headers: { origin: f.origin } }),
      )
    ).status,
  ).toBe(403);
  expect(f.native.fetchPreview).toHaveBeenCalledTimes(3);
  f.setRecord({ ...f.record(), targetSource: f.source });
  let inserted = "";
  let head = "";
  vi.stubGlobal(
    "HTMLRewriter",
    class {
      private handlers = new Map<
        string,
        {
          element(element: {
            append(value: string, options: { html: boolean }): void;
            prepend(value: string, options: { html: boolean }): void;
          }): void;
        }
      >();
      on(
        selector: string,
        handler: {
          element(element: {
            append(value: string, options: { html: boolean }): void;
            prepend(value: string, options: { html: boolean }): void;
          }): void;
        },
      ) {
        this.handlers.set(selector, handler);
        return this;
      }
      transform(response: Response) {
        for (const handler of this.handlers.values())
          handler.element({
            append(value, options) {
              expect(options.html).toBe(true);
              inserted = value;
            },
            prepend(value, options) {
              expect(options.html).toBe(true);
              head = value;
            },
          });
        return response;
      }
    },
  );
  try {
    f.setContentType("text/html; charset=utf-8");
    expect((await actor.fetch(new Request(`${f.origin}/`))).status).toBe(200);
    expect(inserted).toContain("/__ohmyhost/preview/activity");
    expect(inserted).toContain("e.isTrusted");
    expect(f.upstream.at(-1)?.port).toBe(3001);

    const timers = new Map<number, { callback: () => void; delay: number }>();
    let nextTimer = 0;
    let status = { state: "ready", runtimeRevision: 1 as number | null };
    const replace = vi.fn();
    const fetch = vi.fn(async (path: string, options?: { signal: AbortSignal }) => {
      expect(path).toBe("/__ohmyhost/preview/status");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => status };
    });
    const context = {
      AbortController,
      Date,
      URL,
      document: { addEventListener() {} },
      fetch,
      location: { href: `${f.origin}/page?original=1#section`, replace },
      setTimeout(callback: () => void, delay: number) {
        const id = ++nextTimer;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    };
    const script = inserted.replace(/^<script>|<\/script>$/gu, "");
    runInNewContext(script, context);
    const poll = async () => {
      const next = [...timers].find(([, value]) => value.delay === 10_000);
      if (!next) throw new Error("missing poll");
      timers.delete(next[0]);
      next[1].callback();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    await poll();
    expect(replace).not.toHaveBeenCalled();
    status = { state: "starting", runtimeRevision: null };
    await poll();
    expect(replace).not.toHaveBeenCalled();
    status = { state: "ready", runtimeRevision: 2 };
    await poll();
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(
      `${f.origin}/page?original=1&__ohmyhost_preview_passive=1#section`,
    );
    expect(fetch.mock.calls.every(([path]) => path === "/__ohmyhost/preview/status")).toBe(true);

    timers.clear();
    replace.mockClear();
    status = { state: "sleeping", runtimeRevision: null };
    runInNewContext(script, context);
    await poll();
    expect(replace).toHaveBeenCalledWith(
      `${f.origin}/page?original=1&__ohmyhost_preview_passive=1#section`,
    );

    timers.clear();
    replace.mockClear();
    fetch.mockImplementationOnce(
      (_path, options) =>
        new Promise((_, reject) => {
          options?.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    runInNewContext(script, context);
    await poll();
    expect([...timers.values()].some((value) => value.delay === 10_000)).toBe(false);
    const timeout = [...timers].find(([, value]) => value.delay === 5_000);
    if (!timeout) throw new Error("missing request timeout");
    timers.delete(timeout[0]);
    timeout[1].callback();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect([...timers.values()].some((value) => value.delay === 10_000)).toBe(true);

    f.entries.set("product-session-v1", {
      state: "sleeping",
      phase: "ready",
      failure: null,
      failedAt: null,
      fence: f.fence,
      applied: f.source,
      plan: f.plan,
      planHash: "plan-hash",
      region: "eu",
      lastActivityAt: Date.now(),
    });
    f.container.running = false;
    const sleeping = await actor.fetch(
      new Request(`${f.origin}/page?original=1&__ohmyhost_preview_passive=1`, {
        headers: { "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "sec-fetch-user": "?1" },
      }),
    );
    expect(await sleeping.text()).toContain("This preview is sleeping.");
    expect(f.container.start).not.toHaveBeenCalled();
    f.entries.set("product-session-v1", {
      state: "ready",
      phase: "ready",
      failure: null,
      failedAt: null,
      fence: f.fence,
      applied: f.source,
      plan: f.plan,
      planHash: "plan-hash",
      region: "eu",
      lastActivityAt: Date.now(),
    });
    f.container.running = true;
    await actor.fetch(new Request(`${f.origin}/page?original=1&__ohmyhost_preview_passive=1`));
    expect(f.upstream.at(-1)?.request.url).toBe(
      `${f.origin.replace("https:", "http:")}/page?original=1`,
    );
    expect(head).toContain("history.replaceState");
    const replaceState = vi.fn();
    runInNewContext(head.replace(/^<script>|<\/script>$/gu, ""), {
      URL,
      history: { state: null, replaceState },
      location: { href: `${f.origin}/page?original=1&__ohmyhost_preview_passive=1#section` },
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/page?original=1#section");
  } finally {
    vi.unstubAllGlobals();
  }
  f.core.authorizeRuntime.mockResolvedValueOnce(null as never);
  const denied = await actor.fetch(new Request(`${f.origin}/__ohmyhost/preview/status`));
  expect(await denied.json()).toEqual({ state: "cold", phase: "failed", failure: "admission" });
  expect(denied.headers.get("cache-control")).toBe("no-store");
});

it("rechecks a newer runtime generation before reporting a failed admission status", async () => {
  for (const state of ["starting", "ready"]) {
    const f = sandboxFixture();
    const beforeReservation = f.record();
    f.setRecord({ ...beforeReservation, runtimeGeneration: 2, state });
    f.core.resolveTokenHash.mockResolvedValueOnce(beforeReservation);
    f.entries.set("product-session-v1", {
      state,
      phase: state === "starting" ? "source" : "ready",
      failure: null,
      failedAt: null,
      fence: { ...f.fence, runtimeGeneration: 2 },
      applied: state === "ready" ? f.source : null,
      plan: state === "ready" ? f.plan : null,
      planHash: state === "ready" ? "plan-hash" : null,
      region: "eu",
      lastActivityAt: Date.now(),
    });
    const actor = new PreviewSandbox(f.context as never, f.env as never);
    const response = await actor.fetch(new Request(`${f.origin}/__ohmyhost/preview/status`));
    expect(await response.json()).toEqual({
      state,
      phase: state === "starting" ? "source" : "ready",
      failure: null,
      failedAt: null,
      runtimeRevision: state === "ready" ? 2 : null,
    });
    expect(f.core.resolveTokenHash).toHaveBeenCalledTimes(2);
    expect(f.core.authorizeRuntime.mock.calls.map(([fence]) => fence.runtimeGeneration)).toEqual([
      1, 2,
    ]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.upstream).toHaveLength(0);
  }
});

it("does not use the runtime generation retry to cross tokens, previews or denied authority", async () => {
  for (const change of ["same-runtime", "token", "preview", "revoked", "funding"] as const) {
    const f = sandboxFixture();
    const beforeReservation = f.record();
    f.setRecord({ ...beforeReservation, runtimeGeneration: 2 });
    const current = f.record();
    const refreshed =
      change === "same-runtime"
        ? beforeReservation
        : change === "token"
          ? { ...current, tokenGeneration: 2 }
          : change === "preview"
            ? { ...current, previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" }
            : change === "revoked"
              ? null
              : current;
    f.core.resolveTokenHash
      .mockResolvedValueOnce(beforeReservation)
      .mockResolvedValueOnce(refreshed as never);
    if (change === "funding") f.core.authorizeRuntime.mockResolvedValue(null as never);
    const actor = new PreviewSandbox(f.context as never, f.env as never);
    const response = await actor.fetch(new Request(`${f.origin}/__ohmyhost/preview/status`));
    expect(await response.json()).toEqual({ state: "cold", phase: "failed", failure: "admission" });
    expect(f.core.resolveTokenHash).toHaveBeenCalledTimes(2);
    expect(f.core.authorizeRuntime).toHaveBeenCalledTimes(change === "funding" ? 2 : 1);
    expect(f.upstream).toHaveLength(0);
  }
});

it("reuses the controller inspection for active saves and keeps Native refresh authoritative", async () => {
  for (const authProvider of ["none", "omh-native"]) {
    const f = sandboxFixture();
    const plan = { ...f.plan, auth: { provider: authProvider } };
    let target = { ...f.source, sequence: 2, commitSha: "b".repeat(40) };
    f.setRecord({ ...f.record(), targetSource: target });
    f.entries.set("product-session-v1", {
      state: "ready",
      phase: "ready",
      failure: null,
      failedAt: null,
      fence: f.fence,
      applied: f.source,
      plan,
      planHash: "plan-hash",
      region: "eu",
      lastActivityAt: Date.now(),
    });
    const previewDiff = vi.fn(async (input: { from: typeof f.source | null }) => ({
      from: input.from,
      to: target,
      operations: [],
      dependenciesChanged: false,
      install: null,
      inspection: { frameworkPlan: plan, buildPlanSha256: "plan-hash" },
    }));
    const readNativePreparation = vi.fn(async () => ({ state: "succeeded" }));
    const recordAppliedSource = vi.fn(async ({ source }: { source: typeof f.source }) => {
      f.setRecord({ ...f.record(), appliedSource: source });
      return f.record();
    });
    f.core.queueNativePreparation.mockResolvedValue({ operationId: f.id, state: "succeeded" });
    const actor = new PreviewSandbox(
      {
        ...f.context,
        waitUntil(promise: Promise<unknown>) {
          f.context.waitUntil(promise.catch(() => undefined));
        },
        container: {
          ...f.container,
          async exec() {
            return { stdin: new WritableStream(), exitCode: Promise.resolve(0) };
          },
        },
      } as never,
      {
        ...f.env,
        PREVIEW_SOURCE: { previewDiff },
        PREVIEW_AUTHORITY: { ...f.core, recordAppliedSource, readNativePreparation },
      } as never,
    );
    await actor.fetch(new Request(`${f.origin}/__ohmyhost/preview/status`));
    await actor.sourceChanged(2);
    await f.flush();
    expect(previewDiff).toHaveBeenCalledOnce();
    expect(recordAppliedSource).toHaveBeenCalledWith(expect.objectContaining({ source: target }));
    expect(f.entries.get("product-native-inspected-v2")).toMatchObject({ sequence: 2 });
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.container.destroy).not.toHaveBeenCalled();
    if (authProvider === "omh-native") {
      expect(f.core.queueNativePreparation).toHaveBeenCalledOnce();
      expect(readNativePreparation).toHaveBeenCalledOnce();
      await actor.refreshNative();
      await f.flush();
      expect(previewDiff).toHaveBeenCalledTimes(2);
      expect(f.core.queueNativePreparation).toHaveBeenCalledTimes(2);
      expect(f.core.authorizeRuntime).toHaveBeenCalledWith(f.fence);
      target = { ...target, sequence: 3, commitSha: "c".repeat(40) };
      f.setRecord({ ...f.record(), targetSource: target });
      readNativePreparation.mockResolvedValue({ state: "pending" });
      f.core.queueNativePreparation.mockResolvedValue({ operationId: f.id, state: "pending" });
      await actor.sourceChanged(3);
      await f.flush();
      expect(previewDiff).toHaveBeenCalledTimes(3);
      expect(f.record().appliedSource.sequence).toBe(2);
      expect(f.nativePrepare).toHaveBeenCalledOnce();
      await actor.alarm();
      await f.flush();
      expect(previewDiff).toHaveBeenCalledTimes(4);
      expect(f.record().appliedSource.sequence).toBe(2);
    } else expect(f.core.queueNativePreparation).not.toHaveBeenCalled();
  }
});

it("prepares sleeping and cold Native previews with fresh authority despite an older inspection marker", async () => {
  for (const state of ["cold", "sleeping"]) {
    const f = sandboxFixture();
    f.container.running = false;
    f.setRecord({ ...f.record(), state, authGeneration: 2 });
    f.entries.set("product-session-v1", { state });
    f.entries.set("product-native-inspected-v2", {
      sequence: 1,
      authGeneration: 1,
      runtimeGeneration: f.fence.runtimeGeneration,
      tokenGeneration: f.fence.tokenGeneration,
    });
    const actor = new PreviewSandbox(f.context as never, f.env as never);
    await actor.sourceChanged(1);
    await f.flush();
    expect(f.previewDiff).toHaveBeenCalledOnce();
    expect(f.core.queueNativePreparation).toHaveBeenCalledOnce();
    expect(f.nativePrepare).toHaveBeenCalledOnce();
    expect(f.entries.get("product-native-inspected-v2")).toMatchObject({ authGeneration: 2 });
    expect(f.container.start).not.toHaveBeenCalled();
    f.core.authorizeRuntime.mockResolvedValueOnce(null as never);
    await actor.refreshNative();
    await f.flush();
    expect(f.previewDiff).toHaveBeenCalledOnce();
    expect(f.core.queueNativePreparation).toHaveBeenCalledOnce();
  }
});

it("starts only after usage and Native authority, then drains the exact retired generation", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = sandboxFixture();
  f.setRecord({ ...f.record(), state: "cold", appliedSource: null as never });
  f.entries.set("preview-directory-backup-v1", {
    current: null,
    records: [],
    pendingDelete: [],
    deleted: [],
    pending: {
      kind: "unknown",
      generation: 1,
      objectKey: `preview-backups/${f.id}/01234567-89ab-cdef-0123-456789abcdef.tar.zst`,
      uploadId: "interrupted-upload",
    },
  });
  f.entries.set("preview-backup-transfer-grant-v1", {
    key: `preview-backups/${f.id}/01234567-89ab-cdef-0123-456789abcdef.tar.zst`,
    uploadId: "interrupted-upload",
    expiresAt: now + 120_000,
    settleAfter: now - 1,
    revoked: false,
    parts: {},
  });
  f.backupTarget.abortUpload.mockImplementationOnce(async () => {
    expect(f.entries.get("preview-backup-transfer-grant-v1")).toMatchObject({ revoked: true });
    throw { code: "NoSuchUpload" };
  });
  f.failNextBackupTransfer();
  const commands: { argv: readonly string[]; bytes: Uint8Array[] }[] = [];
  const container = {
    ...f.container,
    running: false,
    start: vi.fn(() => {
      container.running = true;
    }),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
    async exec(argv: readonly string[]) {
      const call = { argv, bytes: [] as Uint8Array[] };
      commands.push(call);
      return {
        stdin: new WritableStream<Uint8Array>({
          write(value) {
            call.bytes.push(value);
          },
        }),
        exitCode: argv.includes("/opt/ohmyho/apps/preview-runtime/container/serve.mjs")
          ? new Promise<number>(() => {})
          : Promise.resolve(0),
      };
    },
  };
  const core = {
    ...f.core,
    renewActivity: vi.fn(async () => f.record()),
    reserveUsage: vi.fn(async () => {
      f.setRecord({ ...f.record(), state: "starting" });
      return { preview: f.record() };
    }),
    readNativePreparation: vi.fn(async () => ({ state: "succeeded" })),
    recordAppliedSource: vi.fn(async ({ source }: { source: typeof f.source }) => {
      f.setRecord({ ...f.record(), appliedSource: source });
      return f.record();
    }),
    recordBackup: vi.fn(async ({ backup }: { backup: ReturnType<typeof f.record>["backup"] }) => {
      f.setRecord({ ...f.record(), backup });
      return f.record();
    }),
    recordState: vi.fn(async () => {
      f.setRecord({ ...f.record(), state: "ready" });
      return f.record();
    }),
    closeUsage: vi.fn(async () => {}),
    recordStopped: vi.fn(async () => {}),
  };
  const diff = vi.fn(async () => ({
    from: null,
    to: f.source,
    operations: [],
    dependenciesChanged: true,
    install: {
      applicationRoot: ".",
      manager: "pnpm",
      version: "10.28.2",
      lockfile: "pnpm-lock.yaml",
      command: "ignored",
    },
    inspection: { frameworkPlan: f.plan, buildPlanSha256: "plan-hash" },
  }));
  const readCustomerVariables = vi.fn(async () => ({ PUBLIC_VALUE: "synthetic" }));
  const env = {
    ...f.env,
    PREVIEW_AUTHORITY: core,
    PREVIEW_SOURCE: { previewDiff: diff },
    PREVIEW_RUNTIME_SECRETS: { readCustomerVariables },
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_PREVIEW_USAGE_TOKEN: "synthetic-test-token",
    PREVIEW_CONTAINER_APPLICATION_NAME: "live-preview",
    PREVIEW_CONTAINER_APPLICATION_ID: "d".repeat(32),
    PREVIEW_USAGE_REPORTER: {},
  };
  const actor = new PreviewSandbox({ ...f.context, container } as never, env as never);
  f.setBackupActor(actor);
  const providerFetch = vi.fn(async () =>
    Response.json({
      success: true,
      result: [
        {
          id: "d".repeat(32),
          account_id: "a".repeat(32),
          name: "live-preview",
          scheduling_policy: "durable_object",
          durable_objects: { namespace_id: "b".repeat(32) },
        },
      ],
      result_info: {},
    }),
  );
  vi.stubGlobal("fetch", providerFetch);
  try {
    await expect(actor.wake(f.fence, `${f.origin}/path`)).rejects.toThrow(
      "preview_scope_unavailable",
    );
    expect(container.start).not.toHaveBeenCalled();
    await expect(actor.wake(f.fence, f.origin)).rejects.toThrow("preview_backup_outcome_unknown");
    expect(f.backupTarget.abortUpload).toHaveBeenCalledWith("interrupted-upload");
    expect(f.backupTarget.abortUpload).not.toHaveBeenCalledWith("synthetic-upload");
    expect(core.closeUsage).toHaveBeenCalledOnce();
    expect(
      commands.some((call) =>
        call.argv.includes("/opt/ohmyho/apps/preview-runtime/container/serve.mjs"),
      ),
    ).toBe(false);
    now += 30_001;
    await actor.wake(f.fence, f.origin);
    expect(f.entries.get("preview-backup-transfer-grant-v1")).toMatchObject({
      completionDispatched: true,
      completionOutcome: 1,
    });
    expect(providerFetch).toHaveBeenCalledTimes(4);
    expect(f.backupTarget.abortUpload).toHaveBeenCalledWith("synthetic-upload");
    expect(core.readNativePreparation).toHaveBeenCalledWith({ previewId: f.id, sourceSequence: 1 });
    expect(core.reserveUsage).toHaveBeenCalledBefore(container.start);
    const writeGrant = f.backupGateway.mock.calls
      .map(([call]) => call.props)
      .find((props) => props["mode"] === "write");
    expect(writeGrant).toMatchObject({ previewId: f.id, operationId: expect.any(String) });
    await expect(
      actor.reserveBackupTransfer({
        kind: "check",
        operationId: writeGrant?.["operationId"] as string,
      }),
    ).rejects.toThrow();
    expect(container.start).toHaveBeenCalledWith({
      image: "image",
      instance: "standard-3",
      enableInternet: false,
      labels: { preview: f.id, runtime: "1", run: expect.any(String) },
    });
    expect(core.recordAppliedSource).toHaveBeenCalledWith(
      expect.objectContaining({ ...f.fence, source: f.source }),
    );
    expect(readCustomerVariables).toHaveBeenCalledWith({ fence: f.fence });
    const preparation = commands.find((call) =>
      call.argv.includes("/opt/ohmyho/apps/preview-runtime/container/prepare.mjs"),
    );
    if (!preparation?.bytes[0]) throw new Error("missing framework configuration");
    const config = JSON.parse(new TextDecoder().decode(preparation.bytes[0]));
    expect(config).toMatchObject({
      sessionId: f.id,
      previewOrigin: f.origin,
      capabilityBindings: { database: true, auth: true, mail: true, storage: true, ai: true },
      runtimeVariables: {
        PUBLIC_VALUE: "synthetic",
        OHMYHOST_PROJECT_ID: f.id,
        OHMYHOST_MAIL_GATEWAY_URL: "https://preview-mail.invalid",
        OHMYHOST_STORAGE_GATEWAY_URL: "https://preview-storage.invalid",
        OHMYHOST_AI_BASE_URL: "https://preview-ai.invalid/v1",
      },
    });
    expect(
      f.network
        .filter((item) => item.target === "props")
        .map((item) => (item.props as { phase: string }).phase),
    ).toEqual(["install", "install", "runtime"]);
    expect((await actor.fetch(new Request(`${f.origin}/__ohmyhost/preview/status`))).status).toBe(
      200,
    );
    await actor.sourceChanged(1);
    await f.flush();
    expect(diff).toHaveBeenCalledTimes(2);
    expect(core.queueNativePreparation).toHaveBeenCalledWith({
      fence: f.fence,
      source: f.source,
      buildPlanSha256: "plan-hash",
      authProvider: "omh-native",
    });
    expect(f.nativePrepare).toHaveBeenCalledWith({ operationId: f.id });
    await actor.refreshNative();
    await f.flush();
    expect(core.queueNativePreparation).toHaveBeenCalledTimes(3);
    await actor.refreshNative();
    expect(core.queueNativePreparation).toHaveBeenCalledTimes(3);
    await actor.alarm();
    f.setRecord({ ...f.record(), retirement: "rotating" });
    await actor.fence(f.fence, "rotate");
    expect(f.native.drainPreview).toHaveBeenCalledWith({ fence: f.fence });
    expect(container.destroy).toHaveBeenCalledTimes(2);
    expect(core.closeUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        previewId: f.id,
        runtimeGeneration: 1,
        containerStartAttempted: true,
      }),
    );
    f.setRecord({ ...f.record(), retirement: "destroying" });
    const backupId = "01234567-89ab-cdef-0123-456789abcdef";
    expect(await actor.cleanupScope(f.fence)).toBe(backupId);
    expect(await actor.cleanupScope(f.fence)).toBe(backupId);
    expect(f.backupTarget.createUpload).toHaveBeenCalledTimes(2);
    expect(f.backupTarget.completeUpload).toHaveBeenCalledWith("synthetic-upload", [
      { partNumber: 1, etag: "synthetic" },
    ]);
    expect(f.backupTarget.deleteObject).toHaveBeenCalledTimes(3);
    expect(f.backupGateway).toHaveBeenCalledWith({
      props: {
        protocolVersion: 1,
        mode: "control",
        binding: "BACKUP_BUCKET",
        key: `preview-backups/${f.id}/${backupId}.tar.zst`,
      },
    });
    await actor.expireBackup(f.fence);

    const failed = sandboxFixture();
    failed.setRecord({ ...failed.record(), state: "cold", appliedSource: null as never });
    const failedCore = {
      ...failed.core,
      renewActivity: vi.fn(async () => failed.record()),
      reserveUsage: vi.fn(async () => {
        failed.setRecord({ ...failed.record(), state: "starting" });
        return { preview: failed.record() };
      }),
      readNativePreparation: vi.fn(async () => ({ state: "succeeded" })),
      recordAppliedSource: vi.fn(async ({ source }: { source: typeof failed.source }) => {
        failed.setRecord({ ...failed.record(), appliedSource: source });
        return failed.record();
      }),
      closeUsage: vi.fn(async () => {}),
      recordStopped: vi.fn(async () => {}),
    };
    const failedContainer = {
      ...container,
      running: false,
      start: vi.fn(() => {
        failedContainer.running = true;
      }),
      destroy: vi.fn(async () => {
        failedContainer.running = false;
      }),
    };
    const failedStorage = {
      ...failed.context.storage,
      async put(key: string, value: unknown) {
        if (
          key === "preview-directory-backup-v1" &&
          (value as { pending?: { uploadId?: string } }).pending?.uploadId
        )
          throw new Error("journal unavailable");
        await failed.context.storage.put(key, value);
      },
    };
    failed.backupTarget.abortUpload.mockRejectedValueOnce(new Error("abort unavailable"));
    const failedActor = new PreviewSandbox(
      { ...failed.context, storage: failedStorage, container: failedContainer } as never,
      { ...env, PREVIEW_AUTHORITY: failedCore } as never,
    );
    const previousCommands = commands.length;
    await expect(failedActor.wake(failed.fence, failed.origin)).rejects.toThrow(
      "preview_backup_outcome_unknown",
    );
    expect(failed.backupTarget.abortUpload).toHaveBeenCalledWith("synthetic-upload");
    expect(failedCore.closeUsage).toHaveBeenCalledOnce();
    expect(
      commands
        .slice(previousCommands)
        .some((call) => call.argv.includes("/opt/ohmyho/apps/preview-runtime/container/serve.mjs")),
    ).toBe(false);
    expect(failed.entries.get("preview-directory-backup-v1")).toMatchObject({
      pending: { kind: "unknown" },
    });

    // Funding can expire during the durable completion intent, before any provider call.
    const undispatched = sandboxFixture();
    undispatched.setRecord({
      ...undispatched.record(),
      state: "cold",
      appliedSource: null as never,
    });
    const undispatchedCore = {
      ...undispatched.core,
      reserveUsage: vi.fn(async () => ({ preview: undispatched.record() })),
      readNativePreparation: vi.fn(async () => ({ state: "succeeded" })),
      recordAppliedSource: vi.fn(async () => undispatched.record()),
      closeUsage: vi.fn(async () => {}),
      recordStopped: vi.fn(async () => {}),
    };
    const undispatchedContainer = {
      ...container,
      running: false,
      start: vi.fn(() => {
        undispatchedContainer.running = true;
      }),
      destroy: vi.fn(async () => {
        undispatchedContainer.running = false;
      }),
    };
    let expireCompletion = true;
    const undispatchedStorage = {
      ...undispatched.context.storage,
      async put(key: string, value: unknown) {
        await undispatched.context.storage.put(key, value);
        if (
          expireCompletion &&
          key === "preview-backup-transfer-grant-v1" &&
          (value as { completionDispatched?: boolean }).completionDispatched
        ) {
          expireCompletion = false;
          now += 45_000;
        }
      },
    };
    const undispatchedActor = new PreviewSandbox(
      {
        ...undispatched.context,
        storage: undispatchedStorage,
        container: undispatchedContainer,
      } as never,
      { ...env, PREVIEW_AUTHORITY: undispatchedCore } as never,
    );
    undispatched.setBackupActor(undispatchedActor);
    await expect(undispatchedActor.wake(undispatched.fence, undispatched.origin)).rejects.toThrow();
    expect(undispatched.backupTarget.completeUpload).not.toHaveBeenCalled();
    expect(undispatched.entries.get("preview-backup-transfer-grant-v1")).toMatchObject({
      completionDispatched: false,
      completionOutcome: null,
    });
    expect(undispatchedContainer.running).toBe(false);
    undispatched.setRecord({ ...undispatched.record(), retirement: "destroying" });
    await undispatchedActor.cleanupScope(undispatched.fence);
    expect(undispatched.backupTarget.abortUpload).toHaveBeenCalledWith("synthetic-upload");
    expect(undispatched.backupTarget.deleteObject).toHaveBeenCalled();

    // A lost provider reply must leave the original cleanup identity available for recovery.
    for (const blocked of ["abortUpload", "deleteObject"] as const) {
      const timed = sandboxFixture();
      timed.container.running = false;
      const pending = {
        current: null,
        records: [],
        pendingDelete: [],
        deleted: [],
        pending: {
          kind: "unknown",
          generation: 1,
          objectKey: `preview-backups/${timed.id}/01234567-89ab-cdef-0123-456789abcdef.tar.zst`,
          uploadId: "timed-upload",
        },
      };
      timed.entries.set("preview-directory-backup-v1", pending);
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      timed.backupTarget[blocked].mockImplementationOnce(() => {
        entered();
        return new Promise<void>(() => {});
      });
      const timedActor = new PreviewSandbox(timed.context as never, timed.env as never);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const waking = timedActor.wake(timed.fence, timed.origin);
        void waking.catch(() => undefined);
        await waiting;
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(waking).rejects.toThrow("preview_backup_multipart_outcome_unknown");
        expect(timed.entries.get("preview-directory-backup-v1")).toEqual(pending);
      } finally {
        vi.useRealTimers();
      }
    }

    const retry = sandboxFixture();
    retry.previewDiff.mockRejectedValueOnce(new Error("source temporarily unavailable"));
    const retryActor = new PreviewSandbox(retry.context as never, retry.env as never);
    await retryActor.sourceChanged(1);
    await retry.flush();
    expect(retry.core.queueNativePreparation).not.toHaveBeenCalled();
    expect(await retry.context.storage.getAlarm()).not.toBeNull();
    retry.previewDiff.mockRejectedValueOnce(new Error("source still unavailable"));
    await retryActor.alarm();
    await retry.flush();
    expect(retry.core.queueNativePreparation).not.toHaveBeenCalled();
    expect(await retry.context.storage.getAlarm()).not.toBeNull();
    await retryActor.alarm();
    await retry.flush();
    expect(retry.core.queueNativePreparation).toHaveBeenCalledOnce();
    expect(retry.nativePrepare).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
});
