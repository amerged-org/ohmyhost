import { expect, it, vi } from "vitest";
import { PreviewBackupGrantLedger } from "../src/backup-transfer.js";
import type { BackupStorage } from "../src/backup.js";

function storage(): BackupStorage {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, structuredClone(value));
    },
  };
}

it("binds transfer authority to one durable grant and charges retries before forwarding", async () => {
  const ledger = new PreviewBackupGrantLedger(storage());
  const fence = {
    previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runtimeGeneration: 1,
    tokenGeneration: 1,
  };
  const key = `preview-backups/${fence.previewId}/01234567-89ab-cdef-0123-456789abcdef.tar.zst`;
  const grant = await ledger.begin({ fence, intervalId: "run-1", mode: "write" });
  await ledger.bindKey(grant.operationId, key);
  await ledger.bindUpload(grant.operationId, key, "upload-1");
  await expect(
    ledger.assertScope(grant.operationId, {
      fence: { ...fence, tokenGeneration: 2 },
      intervalId: "run-1",
    }),
  ).rejects.toThrow();
  const permitted = async () => true;
  const finish = async (
    ledger: PreviewBackupGrantLedger,
    operationId: string,
    uploadId: string,
    transferId: string,
    partNumber: number,
    etag: string,
  ) => {
    const identity = { operationId, transferId, partNumber };
    await ledger.transfer({ ...identity, kind: "dispatch-upload" }, permitted);
    await ledger.recordPartOutcome({ ...identity, key, uploadId, kind: "uploaded", etag });
    await ledger.transfer({ ...identity, kind: "finish-upload", etag }, permitted);
  };
  const reserve = {
    kind: "reserve-upload" as const,
    operationId: grant.operationId,
    transferId: "01234567-89ab-cdef-0123-456789abc001",
    partNumber: 1,
    bytes: 5,
  };
  await expect(
    ledger.transfer({ ...reserve, operationId: "foreign" }, permitted),
  ).rejects.toThrow();
  await expect(ledger.transfer(reserve, async () => false)).rejects.toThrow();
  const overlapping = await Promise.allSettled([
    ledger.transfer(reserve, permitted),
    ledger.transfer({ ...reserve, transferId: "01234567-89ab-cdef-0123-456789abc002" }, permitted),
  ]);
  expect(overlapping.map((value) => value.status)).toEqual(["fulfilled", "rejected"]);
  await expect(ledger.assertSettled(key, "upload-1")).rejects.toThrow(
    "preview_backup_multipart_outcome_unknown",
  );
  await expect(
    ledger.transfer({ ...reserve, kind: "finish-upload", etag: "unobserved" }, permitted),
  ).rejects.toThrow();
  await finish(ledger, grant.operationId, "upload-1", reserve.transferId, 1, "etag-1");
  await ledger.transfer(
    { ...reserve, transferId: "01234567-89ab-cdef-0123-456789abc002" },
    permitted,
  );
  await finish(
    ledger,
    grant.operationId,
    "upload-1",
    "01234567-89ab-cdef-0123-456789abc002",
    1,
    "etag-2",
  );
  await expect(
    ledger.validateCompletion(grant.operationId, "upload-1", [{ partNumber: 1, etag: "etag-1" }]),
  ).rejects.toThrow();
  await ledger.validateCompletion(grant.operationId, "upload-1", [
    { partNumber: 1, etag: "etag-2" },
  ]);
  await ledger.markCompletionDispatched(grant.operationId, "upload-1");
  await ledger.recordCompletionOutcome(grant.operationId, "upload-1", 5);
  await expect(ledger.confirmCompletion(grant.operationId, "upload-1", 6)).rejects.toThrow();
  await ledger.confirmCompletion(grant.operationId, "upload-1", 5);
  await ledger.revoke(grant.operationId);
  await expect(ledger.transfer(reserve, permitted)).rejects.toThrow();
  const reading = await ledger.begin({ fence, intervalId: "run-1", mode: "read", key, size: 5 });
  await expect(
    ledger.transfer(
      {
        kind: "reserve-download",
        operationId: reading.operationId,
        transferId: "01234567-89ab-cdef-0123-456789abc003",
        offset: 0,
        bytes: 128 * 1024 ** 2 + 1,
      },
      permitted,
    ),
  ).rejects.toThrow();
  await ledger.revoke(reading.operationId);

  // R2 rejects tiny or nonuniform non-final parts, so detect the manifest before dispatch.
  const completionStore = storage();
  const completionLedger = new PreviewBackupGrantLedger(completionStore);
  const completing = await completionLedger.begin({ fence, intervalId: "run-1", mode: "write" });
  await completionLedger.bindKey(completing.operationId, key);
  await completionLedger.bindUpload(completing.operationId, key, "completion-upload");
  const manifest = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `part-${partNumber}` }));
  const putPart = async (partNumber: number, bytes: number) => {
    const transferId = crypto.randomUUID();
    await completionLedger.transfer(
      {
        kind: "reserve-upload",
        operationId: completing.operationId,
        transferId,
        partNumber,
        bytes,
      },
      permitted,
    );
    await finish(
      completionLedger,
      completing.operationId,
      "completion-upload",
      transferId,
      partNumber,
      `part-${partNumber}`,
    );
  };
  await putPart(1, 1);
  await putPart(2, 1);
  await putPart(3, 1);
  await expect(
    completionLedger.validateCompletion(completing.operationId, "completion-upload", manifest),
  ).rejects.toThrow();
  await expect(
    completionLedger.markCompletionDispatched(completing.operationId, "completion-upload"),
  ).rejects.toThrow();
  expect(await completionStore.get("preview-backup-transfer-grant-v1")).toMatchObject({
    completionSize: null,
    completionDispatched: false,
  });
  await putPart(1, 5 * 1024 ** 2);
  await expect(
    completionLedger.validateCompletion(completing.operationId, "completion-upload", manifest),
  ).rejects.toThrow();
  await putPart(2, 6 * 1024 ** 2);
  await expect(
    completionLedger.validateCompletion(completing.operationId, "completion-upload", manifest),
  ).rejects.toThrow();
  await putPart(2, 5 * 1024 ** 2);
  await completionLedger.validateCompletion(completing.operationId, "completion-upload", manifest);
  await completionLedger.markCompletionDispatched(completing.operationId, "completion-upload");
  expect(await completionStore.get("preview-backup-transfer-grant-v1")).toMatchObject({
    completionSize: 10 * 1024 ** 2 + 1,
    completionDispatched: true,
  });

  const budgetStore = storage();
  const budgetLedger = new PreviewBackupGrantLedger(budgetStore);
  const budget = await budgetLedger.begin({ fence, intervalId: "run-1", mode: "write" });
  await budgetLedger.bindKey(budget.operationId, key);
  await budgetLedger.bindUpload(budget.operationId, key, "budget-upload");
  for (let attempt = 1; attempt <= 32; attempt += 1) {
    const attemptId = `01234567-89ab-cdef-0123-${String(attempt).padStart(12, "0")}`;
    await budgetLedger.transfer(
      {
        kind: "reserve-upload",
        operationId: budget.operationId,
        transferId: attemptId,
        partNumber: 1,
        bytes: 128 * 1024 ** 2,
      },
      permitted,
    );
    await finish(budgetLedger, budget.operationId, "budget-upload", attemptId, 1, "etag");
  }
  await expect(
    budgetLedger.transfer(
      {
        kind: "reserve-upload",
        operationId: budget.operationId,
        transferId: "01234567-89ab-cdef-0123-000000000033",
        partNumber: 1,
        bytes: 1,
      },
      permitted,
    ),
  ).rejects.toThrow();

  // A lost completion reply remains unknown after the old transfer deadlines and a restart.
  const lostStore = storage();
  const lostLedger = new PreviewBackupGrantLedger(lostStore);
  const lost = await lostLedger.begin({ fence, intervalId: "run-1", mode: "write" });
  await lostLedger.bindKey(lost.operationId, key);
  await lostLedger.bindUpload(lost.operationId, key, "lost-upload");
  const transferId = "01234567-89ab-cdef-0123-000000000001";
  await lostLedger.transfer(
    { kind: "reserve-upload", operationId: lost.operationId, transferId, partNumber: 1, bytes: 5 },
    permitted,
  );
  await finish(lostLedger, lost.operationId, "lost-upload", transferId, 1, "late-etag");
  await lostLedger.validateCompletion(lost.operationId, "lost-upload", [
    { partNumber: 1, etag: "late-etag" },
  ]);
  await lostLedger.markCompletionDispatched(lost.operationId, "lost-upload");
  await lostLedger.revoke(lost.operationId);
  const persisted = await lostStore.get<Record<string, unknown>>(
    "preview-backup-transfer-grant-v1",
  );
  if (!persisted) throw new Error("missing_test_grant");
  await lostStore.put("preview-backup-transfer-grant-v1", { ...persisted, settleAfter: 0 });
  const restarted = new PreviewBackupGrantLedger(lostStore);
  await restarted.revokeOrphan();
  await expect(restarted.assertSettled(key, "lost-upload")).rejects.toThrow(
    "preview_backup_multipart_outcome_unknown",
  );
  await expect(restarted.begin({ fence, intervalId: "run-1", mode: "write" })).rejects.toThrow();
  await restarted.recordCompletionOutcome(lost.operationId, "lost-upload", 5);
  await restarted.assertSettled(key, "lost-upload");

  // Worst-case part accounting remains within the Durable Object single-value limit.
  const fullStore = storage();
  const fullLedger = new PreviewBackupGrantLedger(fullStore);
  const full = await fullLedger.begin({ fence, intervalId: "run-1", mode: "write" });
  await fullLedger.bindKey(full.operationId, key);
  await fullLedger.bindUpload(full.operationId, key, "upload-2");
  for (let partNumber = 1; partNumber <= 512; partNumber += 1) {
    const transferId = `01234567-89ab-cdef-0123-${String(partNumber).padStart(12, "0")}`;
    await fullLedger.transfer(
      { kind: "reserve-upload", operationId: full.operationId, transferId, partNumber, bytes: 1 },
      permitted,
    );
    await finish(
      fullLedger,
      full.operationId,
      "upload-2",
      transferId,
      partNumber,
      "x".repeat(1024),
    );
  }
  await expect(
    fullLedger.transfer(
      {
        kind: "reserve-upload",
        operationId: full.operationId,
        transferId: "01234567-89ab-cdef-0123-000000000513",
        partNumber: 513,
        bytes: 1,
      },
      permitted,
    ),
  ).rejects.toThrow();
  expect(
    new TextEncoder().encode(
      JSON.stringify(await fullStore.get("preview-backup-transfer-grant-v1")),
    ).byteLength,
  ).toBeLessThan(128 * 1024);
});

it("cancels promptly, journals a late upload ID, and never publishes the late SDK result", async () => {
  const { BoundedDirectoryBackup, PreviewBackups } = await import("../src/backup.js");
  const store = storage();
  const ledger = new PreviewBackupGrantLedger(store);
  const fence = {
    previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runtimeGeneration: 1,
    tokenGeneration: 1,
  };
  const key = `preview-backups/${fence.previewId}/01234567-89ab-cdef-0123-456789abcdef.tar.zst`;
  let keyCaptured!: () => void;
  const capturing = new Promise<void>((resolve) => {
    keyCaptured = resolve;
  });
  let resolveUpload!: () => void;
  const upload = new Promise<void>((resolve) => {
    resolveUpload = resolve;
  });
  let resolveLate!: () => void;
  const late = new Promise<void>((resolve) => {
    resolveLate = resolve;
  });
  const adapter = new BoundedDirectoryBackup(
    (operationId) => ({
      async intercept() {},
      async delete() {},
      async restore() {},
      async backup() {
        adapter.claimControlKey(operationId, key);
        await journal.captureObjectKey(key);
        await adapter.captureObjectKey(key, operationId);
        keyCaptured();
        await upload;
        await journal.captureUploadId(key, "late-upload");
        resolveLate();
        await adapter.captureUploadId(key, "late-upload", operationId);
        return {
          id: "01234567-89ab-cdef-0123-456789abcdef",
          dir: "/workspace/app",
          size: 5,
          sha256: "b".repeat(64),
          format: "tar+zstd/1" as const,
        };
      },
    }),
    ledger,
    {
      previewId: fence.previewId,
      prefix: `preview-backups/${fence.previewId}/`,
      scope: async () => ({ fence, intervalId: "run-1" }),
    },
  );
  const journal = new PreviewBackups(store, adapter);
  let published = false;
  const pending = journal.checkpoint(
    {
      sourceConnectionId: fence.previewId,
      sourceGeneration: 1,
      sequence: 1,
      commitSha: "a".repeat(40),
    },
    1,
    async () => {
      published = true;
    },
  );
  await capturing;
  const cancellation = adapter.cancelActive();
  await expect(pending).rejects.toThrow("preview_backup_outcome_unknown");
  await cancellation;
  await expect(journal.reconcileUnknown(async () => {})).rejects.toThrow(
    "preview_backup_multipart_outcome_unknown",
  );
  resolveUpload();
  await late;
  const discarded: string[] = [];
  await journal.reconcileUnknown(async (_key, id) => {
    discarded.push(id);
  });
  expect(discarded).toEqual(["late-upload"]);
  expect(published).toBe(false);

  // Cancellation also wins if the SDK returned but the grant revocation write is stalled.
  const baseStore = storage();
  let signalWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    signalWrite = resolve;
  });
  let finishWrite!: () => void;
  const writeReleased = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  let stallWrite = true;
  const slowStore: BackupStorage = {
    get: (name) => baseStore.get(name),
    async put<T>(name: string, value: T) {
      if (
        name === "preview-backup-transfer-grant-v1" &&
        typeof value === "object" &&
        value !== null &&
        "revoked" in value &&
        value.revoked &&
        stallWrite
      ) {
        signalWrite();
        await writeReleased;
        stallWrite = false;
      }
      await baseStore.put(name, value);
    },
  };
  const second = new BoundedDirectoryBackup(
    () => ({
      async intercept() {},
      async delete() {},
      async restore() {},
      async backup() {
        return {
          id: "01234567-89ab-cdef-0123-456789abcdef",
          dir: "/workspace/app",
          size: 5,
          sha256: "b".repeat(64),
          format: "tar+zstd/1" as const,
        };
      },
    }),
    new PreviewBackupGrantLedger(slowStore),
    {
      previewId: fence.previewId,
      prefix: `preview-backups/${fence.previewId}/`,
      scope: async () => ({ fence, intervalId: "run-1" }),
    },
  );
  const completedButUnrevoked = second.backup({ dir: "/workspace/app", name: "test", exclude: [] });
  await writeStarted;
  const stopped = second.cancelActive();
  await expect(completedButUnrevoked).rejects.toThrow("preview_backup_cancelled");
  finishWrite();
  await stopped;

  // A restore that never reports completion is externally timed out, even after verification.
  let notifyRestore!: () => void;
  const restoreStarted = new Promise<void>((resolve) => {
    notifyRestore = resolve;
  });
  let finishRestore!: () => void;
  const restoreReleased = new Promise<void>((resolve) => {
    finishRestore = resolve;
  });
  const third = new BoundedDirectoryBackup(
    () => ({
      async intercept() {},
      async delete() {},
      async backup() {
        throw new Error("unexpected_backup");
      },
      async restore() {
        notifyRestore();
        await restoreReleased;
      },
    }),
    new PreviewBackupGrantLedger(storage()),
    {
      previewId: fence.previewId,
      prefix: `preview-backups/${fence.previewId}/`,
      scope: async () => ({ fence, intervalId: "run-1" }),
    },
  );
  vi.useFakeTimers();
  try {
    const restoring = third.restore({
      id: "01234567-89ab-cdef-0123-456789abcdef",
      dir: "/workspace/app",
      size: 5,
      sha256: "b".repeat(64),
      format: "tar+zstd/1",
    });
    const rejected = expect(restoring).rejects.toThrow("preview_backup_deadline");
    await restoreStarted;
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
    finishRestore();
  } finally {
    vi.useRealTimers();
  }
});

it("uses the real Worker entrypoint and SDK/R2 path with stream limits and expiry", async () => {
  const { build } = await import("esbuild");
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const source = `
    import { DurableObject } from 'cloudflare:workers';
    import { PreviewBackupGrantLedger } from './apps/preview-runtime/src/backup-transfer.ts';
    import { PreviewBackupGateway } from './apps/preview-runtime/src/backup-gateway.ts';
    export { PreviewBackupGateway };
    const fence = { previewId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', runtimeGeneration: 1, tokenGeneration: 1 };
    export class LedgerActor extends DurableObject {
      constructor(ctx, env) { super(ctx, env); this.ledger = new PreviewBackupGrantLedger(ctx.storage); this.fence = { ...fence, previewId: ctx.id.name }; }
      reserveBackupTransfer(message) { return this.ledger.transfer(message, async () => true); }
      observeBackupPart(observation) { return this.ledger.recordPartOutcome(observation); }
      async setup(n, expires) {
        const key = 'preview-backups/' + this.fence.previewId + '/01234567-89ab-cdef-0123-' + String(n).padStart(12, '0') + '.tar.zst';
        let grant = await this.ledger.begin({ fence: this.fence, intervalId: 'run-1', mode: 'write' });
        await this.ledger.bindKey(grant.operationId, key);
        const control = this.ctx.exports.PreviewBackupGateway({ props: { protocolVersion: 1, mode: 'control', binding: 'BACKUP_BUCKET', key } });
        const uploadId = await control.createUpload('test');
        await this.ledger.bindUpload(grant.operationId, key, uploadId);
        if (expires) {
          const state = await this.ctx.storage.get('preview-backup-transfer-grant-v1');
          state.expiresAt = Date.now() + expires;
          await this.ctx.storage.put('preview-backup-transfer-grant-v1', state);
          grant = { ...grant, expiresAt: state.expiresAt };
        }
        const gateway = this.ctx.exports.PreviewBackupGateway({ props: { protocolVersion: 1, mode: 'write', binding: 'BACKUP_BUCKET', key, uploadId, ...grant } });
        return { key, grant, control, uploadId, gateway };
      }
      async exercise() {
        const first = await this.setup(1);
        const uploaded = await first.gateway.fetch(new Request('http://backups.sandbox.internal/parts/1', { method: 'PUT', headers: { 'content-length': '5' }, body: 'hello' }));
        if (!uploaded.ok) throw new Error('initial upload ' + uploaded.status + ': ' + await uploaded.text());
        const uploadBody = await uploaded.json();
        await this.ledger.validateCompletion(first.grant.operationId, first.uploadId, [{ partNumber: 1, etag: uploadBody.etag }]);
        await this.ledger.markCompletionDispatched(first.grant.operationId, first.uploadId);
        const completedSize = await first.control.completeUpload(first.uploadId, [{ partNumber: 1, etag: uploadBody.etag }]);
        await this.ledger.recordCompletionOutcome(first.grant.operationId, first.uploadId, completedSize);
        await this.ledger.confirmCompletion(first.grant.operationId, first.uploadId, completedSize);
        await this.ledger.revoke(first.grant.operationId);
        const replay = await first.gateway.fetch(new Request('http://backups.sandbox.internal/parts/2', { method: 'PUT', headers: { 'content-length': '1' }, body: 'x' }));
        const read = await this.ledger.begin({ fence: this.fence, intervalId: 'run-1', mode: 'read', key: first.key, size: 5 });
        const reader = this.ctx.exports.PreviewBackupGateway({ props: { protocolVersion: 1, mode: 'read', binding: 'BACKUP_BUCKET', key: first.key, ...read } });
        const downloaded = await reader.fetch(new Request('http://backups.sandbox.internal/object', { headers: { range: 'bytes=0-99' } }));
        const text = await downloaded.text();
        await this.ledger.revoke(read.operationId);
        const overflow = await this.setup(2);
        const extra = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1,2,3])); controller.close(); } });
        const overflowResponse = await overflow.gateway.fetch(new Request('http://backups.sandbox.internal/parts/1', { method: 'PUT', headers: { 'content-length': '2' }, body: extra }));
        await this.ledger.revoke(overflow.grant.operationId);
        return { upload: uploaded.status, completedSize, replay: replay.status, download: downloaded.status, text, overflow: overflowResponse.status };
      }
      async exerciseStalled() {
        const stalled = await this.setup(3, 500);
        const never = new ReadableStream({ pull() { return new Promise(() => {}); } });
        const start = Date.now();
        const stalledResponse = await stalled.gateway.fetch(new Request('http://backups.sandbox.internal/parts/1', { method: 'PUT', headers: { 'content-length': '1' }, body: never }));
        return { stall: stalledResponse.status, elapsed: Date.now() - start };
      }
    }
    export default { async fetch(request, env) { try { const stalled = new URL(request.url).pathname === '/stall'; const actor = env.PREVIEW_CONTAINERS.getByName(stalled ? '01ARZ3NDEKTSV4RRFFQ69G5FAW' : fence.previewId); return Response.json(await (stalled ? actor.exerciseStalled() : actor.exercise())); } catch (error) { return Response.json({ error: String(error && error.stack || error) }, { status: 500 }); } } };
  `;
  const bundle = await build({
    stdin: { contents: source, loader: "js", resolveDir: process.cwd() },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("backup_test_bundle_missing");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "backup-test",
          compatibilityDate: "2026-09-14",
          compatibilityFlags: ["nodejs_compat"],
          modules: [{ type: "ESModule", path: "backup-test.mjs", contents: output.text }],
          durableObjects: { PREVIEW_CONTAINERS: { className: "LedgerActor", useSQLite: true } },
          r2Buckets: ["BACKUP_BUCKET"],
        },
      ],
    }),
  );
  try {
    const response = await mf.dispatchFetch("http://localhost/test");
    const result = (await response.json()) as Record<string, unknown>;
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({
      upload: 200,
      completedSize: 5,
      replay: 403,
      download: 206,
      text: "hello",
      overflow: 502,
    });
    const stalled = await mf.dispatchFetch("http://localhost/stall");
    const stalledResult = (await stalled.json()) as Record<string, unknown>;
    expect(stalled.status, JSON.stringify(stalledResult)).toBe(200);
    expect(stalledResult).toMatchObject({ stall: 502 });
    expect(stalledResult["elapsed"]).toBeLessThan(5000);
  } finally {
    await mf.dispose();
  }

  // In-process checks exercise the same gateway's exceptional streams for coverage; the
  // workerd exercise above is the evidence for actual entrypoint/RPC/R2 integration.
  vi.doMock("@cloudflare/sandbox", () => ({
    DirectoryBackupGateway: class {
      constructor(
        public ctx: unknown,
        public env: {
          upstream(request: Request): Promise<Response>;
          BACKUP_BUCKET: {
            resumeMultipartUpload(
              key: string,
              uploadId: string,
            ): {
              uploadPart(partNumber: number, body: ReadableStream): Promise<{ etag: string }>;
            };
          };
        },
      ) {}
      async fetch(request: Request) {
        if (request.method !== "PUT") return this.env.upstream(request);
        const props = (this.ctx as { props: { key: string; uploadId: string } }).props;
        const upload = this.env.BACKUP_BUCKET.resumeMultipartUpload(props.key, props.uploadId);
        try {
          const [, response] = await Promise.all([
            upload.uploadPart(
              Number(new URL(request.url).pathname.split("/").at(-1)),
              request.body as ReadableStream,
            ),
            this.env.upstream(request),
          ]);
          return response;
        } catch {
          return new Response(null, { status: 502 });
        }
      }
    },
  }));
  const NativeRequest = globalThis.Request;
  class LocalRequest extends NativeRequest {
    public constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (input instanceof NativeRequest && init?.body) {
        super(input.url, {
          method: input.method,
          headers: input.headers,
          ...init,
          duplex: "half",
        } as RequestInit);
      } else
        super(
          input,
          init?.body instanceof ReadableStream
            ? ({ ...init, duplex: "half" } as RequestInit)
            : init,
        );
    }
  }
  vi.stubGlobal("Request", LocalRequest);
  try {
    const { PreviewBackupGateway } = await import("../src/backup-gateway.js");
    const Gateway = PreviewBackupGateway as unknown as new (
      ctx: unknown,
      env: unknown,
    ) => { fetch(request: Request): Promise<Response> };
    const scope = {
      previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      runtimeGeneration: 1,
      tokenGeneration: 1,
    };
    const key = `preview-backups/${scope.previewId}/01234567-89ab-cdef-0123-456789abcdef.tar.zst`;
    let localLedger = new PreviewBackupGrantLedger(storage());
    const write = await localLedger.begin({ fence: scope, intervalId: "run-1", mode: "write" });
    await localLedger.bindKey(write.operationId, key);
    await localLedger.bindUpload(write.operationId, key, "local-upload");
    let etag = "local-etag";
    let uploadPart = async () => ({ etag: "local-etag" });
    let objectSize = 5;
    let objectBody: () => ReadableStream<Uint8Array> = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      });
    let checks = 0;
    let failChecks = false;
    const observed: Promise<unknown>[] = [];
    const env = {
      BACKUP_BUCKET: {
        resumeMultipartUpload() {
          return { uploadPart: () => uploadPart() };
        },
      },
      async upstream(request: Request) {
        if (request.method === "PUT") {
          await request.arrayBuffer();
          return Response.json({ etag });
        }
        return new Response(objectBody(), {
          status: 206,
          headers: { "content-range": `bytes 0-4/${objectSize}` },
        });
      },
      PREVIEW_CONTAINERS: {
        getByName() {
          return {
            reserveBackupTransfer(message: Parameters<typeof localLedger.transfer>[0]) {
              if (message.kind === "check" && ++checks > 1 && failChecks)
                return Promise.reject(new Error("revoked"));
              return localLedger.transfer(message, async () => true);
            },
            observeBackupPart(observation: Parameters<typeof localLedger.recordPartOutcome>[0]) {
              return localLedger.recordPartOutcome(observation);
            },
          };
        },
      },
    };
    const writeGateway = new Gateway(
      {
        props: {
          protocolVersion: 1,
          mode: "write",
          binding: "BACKUP_BUCKET",
          key,
          uploadId: "local-upload",
          ...write,
        },
        waitUntil(promise: Promise<unknown>) {
          observed.push(promise);
        },
      },
      env,
    );
    expect(
      (await writeGateway.fetch(new Request("http://backups.sandbox.internal/invalid"))).status,
    ).toBe(403);
    let refusedBodyCancelled = false;
    const badBody = new ReadableStream({
      cancel() {
        refusedBodyCancelled = true;
        throw new Error("cancel_failed");
      },
    });
    expect(
      (
        await writeGateway.fetch(
          new Request("http://backups.sandbox.internal/invalid", { method: "POST", body: badBody }),
        )
      ).status,
    ).toBe(403);
    await Promise.resolve();
    expect(refusedBodyCancelled).toBe(true);
    const good = await writeGateway.fetch(
      new Request("http://backups.sandbox.internal/parts/1", {
        method: "PUT",
        headers: { "content-length": "5" },
        body: "hello",
      }),
    );
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ etag });
    etag = "x".repeat(9000);
    const oversizedResponse = await writeGateway.fetch(
      new Request("http://backups.sandbox.internal/parts/2", {
        method: "PUT",
        headers: { "content-length": "1" },
        body: "x",
      }),
    );
    expect(oversizedResponse.status).toBe(502);
    await localLedger.revoke(write.operationId);
    const read = await localLedger.begin({
      fence: scope,
      intervalId: "run-1",
      mode: "read",
      key,
      size: 5,
    });
    const readGateway = new Gateway(
      { props: { protocolVersion: 1, mode: "read", binding: "BACKUP_BUCKET", key, ...read } },
      env,
    );
    const range = () =>
      new Request("http://backups.sandbox.internal/object", { headers: { range: "bytes=0-4" } });
    expect(await (await readGateway.fetch(range())).text()).toBe("hello");
    objectSize = 6;
    expect((await readGateway.fetch(range())).status).toBe(502);
    objectSize = 5;
    objectBody = () =>
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
      });
    const unused = await readGateway.fetch(range());
    await unused.body?.cancel();
    vi.useFakeTimers();
    try {
      failChecks = true;
      const pendingRead = await readGateway.fetch(range());
      const body = pendingRead.text();
      const failed = expect(body).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_001);
      await failed;
      failChecks = false;
      const expiringRead = await readGateway.fetch(range());
      const expired = expect(expiringRead.text()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30_001);
      await expired;
    } finally {
      vi.useRealTimers();
    }
    await localLedger.revoke(read.operationId);

    // SDK body failure can return 502 while the separately dispatched R2 call is still pending.
    vi.useFakeTimers();
    try {
      const unknownStore = storage();
      localLedger = new PreviewBackupGrantLedger(unknownStore);
      const unknown = await localLedger.begin({ fence: scope, intervalId: "run-2", mode: "write" });
      await localLedger.bindKey(unknown.operationId, key);
      await localLedger.bindUpload(unknown.operationId, key, "unknown-upload");
      let uploaded!: (result: { etag: string }) => void;
      const actualPart = new Promise<{ etag: string }>((resolve) => {
        uploaded = resolve;
      });
      uploadPart = () => actualPart;
      const unknownGateway = new Gateway(
        {
          props: {
            protocolVersion: 1,
            mode: "write",
            binding: "BACKUP_BUCKET",
            key,
            uploadId: "unknown-upload",
            ...unknown,
          },
          waitUntil(promise: Promise<unknown>) {
            observed.push(promise);
          },
        },
        env,
      );
      const broken = new ReadableStream({
        start(controller) {
          controller.error(new Error("body_failed"));
        },
      });
      expect(
        (
          await unknownGateway.fetch(
            new Request("http://backups.sandbox.internal/parts/1", {
              method: "PUT",
              headers: { "content-length": "1" },
              body: broken,
            }),
          )
        ).status,
      ).toBe(502);
      await localLedger.revoke(unknown.operationId);
      await vi.advanceTimersByTimeAsync(30_001);
      // Context retention has ended; the persisted unknown marker must still block recovery.
      await Promise.all(observed);
      const restarted = new PreviewBackupGrantLedger(unknownStore);
      await expect(restarted.assertSettled(key, "unknown-upload")).rejects.toThrow(
        "preview_backup_multipart_outcome_unknown",
      );
      await expect(
        restarted.begin({ fence: scope, intervalId: "run-3", mode: "write" }),
      ).rejects.toThrow();
      const unknownState = await unknownStore.get<{
        parts: Record<string, { transferId: string }>;
      }>("preview-backup-transfer-grant-v1");
      const originalPart = unknownState?.parts["1"];
      if (!originalPart) throw new Error("missing_unknown_part");
      await expect(
        restarted.recordPartOutcome({
          kind: "uploaded",
          operationId: unknown.operationId,
          key,
          uploadId: "foreign-upload",
          transferId: originalPart.transferId,
          partNumber: 1,
          etag: "late-provider-etag",
        }),
      ).rejects.toThrow();
      uploaded({ etag: "late-provider-etag" });
      await vi.waitFor(async () => {
        await restarted.assertSettled(key, "unknown-upload");
      });

      // A deadline during the durable dispatch intent must never start R2 later.
      const delayedStore = storage();
      let releaseDispatch!: () => void;
      let dispatchEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        dispatchEntered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      let delayDispatch = true;
      localLedger = new PreviewBackupGrantLedger({
        get: (key) => delayedStore.get(key),
        async put(key, value) {
          await delayedStore.put(key, value);
          if (
            delayDispatch &&
            (value as { parts?: Record<string, { state: string }> }).parts?.["1"]?.state ===
              "pending"
          ) {
            dispatchEntered();
            await held;
          }
        },
      });
      const delayed = await localLedger.begin({ fence: scope, intervalId: "run-4", mode: "write" });
      await localLedger.bindKey(delayed.operationId, key);
      await localLedger.bindUpload(delayed.operationId, key, "delayed-upload");
      const providerUpload = vi.fn(async () => ({ etag: "never-dispatched" }));
      uploadPart = providerUpload;
      const delayedGateway = new Gateway(
        {
          props: {
            protocolVersion: 1,
            mode: "write",
            binding: "BACKUP_BUCKET",
            key,
            uploadId: "delayed-upload",
            ...delayed,
          },
        },
        env,
      );
      const delayedResponse = delayedGateway.fetch(
        new Request("http://backups.sandbox.internal/parts/1", {
          method: "PUT",
          headers: { "content-length": "1" },
          body: "x",
        }),
      );
      await entered;
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await delayedResponse).status).toBe(502);
      delayDispatch = false;
      releaseDispatch();
      await localLedger.revoke(delayed.operationId);
      expect(providerUpload).not.toHaveBeenCalled();
      await localLedger.assertSettled(key, "delayed-upload");
    } finally {
      vi.useRealTimers();
    }
  } finally {
    vi.unstubAllGlobals();
    vi.doUnmock("@cloudflare/sandbox");
  }
}, 20_000);
