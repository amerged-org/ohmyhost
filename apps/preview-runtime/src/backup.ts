import type { SourceVersion } from "@ohmyhost/contracts/previews";
import {
  BACKUP_LIMITS,
  type BackupGatewayGrant,
  type BackupGrantScope,
  type PreviewBackupGrantLedger,
} from "./backup-transfer.js";

export const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const BACKUP_EXCLUDES = [
  "**/.next/",
  "**/.astro/",
  "**/.wrangler/",
  "**/.tanstack/",
  "**/node_modules/.vite/",
] as const;

export interface DirectoryBackupRecord {
  readonly id: string;
  readonly dir: string;
  readonly size: number;
  readonly sha256: string;
  readonly format: "tar+zstd/1";
  readonly name?: string;
}
export interface DirectoryBackupPort {
  backup(input: {
    dir: string;
    name: string;
    exclude: readonly string[];
  }): Promise<DirectoryBackupRecord>;
  restore(record: DirectoryBackupRecord): Promise<void>;
  delete(record: DirectoryBackupRecord): Promise<void>;
}
export interface BackupMetadata {
  readonly record: DirectoryBackupRecord;
  readonly source: SourceVersion;
  readonly generation: number;
  readonly expiresAt: number;
}
interface BackupState {
  readonly current: string | null;
  readonly records: readonly BackupMetadata[];
  readonly pendingDelete: readonly string[];
  readonly deleted: readonly string[];
  readonly pending: null | {
    readonly kind: "creating" | "unknown" | "handoff";
    readonly generation: number;
    readonly clearing?: boolean;
    readonly objectKey?: string;
    readonly uploadId?: string;
  };
}
export interface BackupStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
type Publish = (record: BackupMetadata | null) => Promise<number | undefined> | Promise<void>;
const KEY = "preview-directory-backup-v1";
const ignoreRejection = () => undefined;
const empty = (): BackupState => ({
  current: null,
  records: [],
  pendingDelete: [],
  deleted: [],
  pending: null,
});

/** Called only from the serialized session actor. The guest never receives backup authority. */
export class PreviewBackups {
  private journalQueue: Promise<void> = Promise.resolve();
  private journal<T>(action: () => Promise<T>): Promise<T> {
    const result = this.journalQueue.then(action, action);
    this.journalQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  public constructor(
    private readonly storage: BackupStorage,
    private readonly sdk: DirectoryBackupPort,
  ) {}

  private async state(): Promise<BackupState> {
    return (await this.storage.get<BackupState>(KEY)) ?? empty();
  }
  private async save(state: BackupState): Promise<void> {
    await this.storage.put(KEY, state);
  }

  /** Preserve identifiers even when their SDK replies arrive after cancellation. */
  public async captureObjectKey(objectKey: string): Promise<void> {
    return this.journal(async () => {
      const state = await this.state();
      const pending = state.pending;
      if (
        !pending ||
        pending.kind === "handoff" ||
        (pending.objectKey && pending.objectKey !== objectKey)
      )
        throw new Error("preview_backup_reconciliation_required");
      await this.save({ ...state, pending: { ...pending, objectKey } });
    });
  }

  public async captureUploadId(objectKey: string, uploadId: string): Promise<void> {
    return this.journal(async () => {
      const state = await this.state();
      const pending = state.pending;
      if (
        !pending ||
        pending.kind === "handoff" ||
        pending.objectKey !== objectKey ||
        !uploadId ||
        (pending.uploadId && pending.uploadId !== uploadId)
      )
        throw new Error("preview_backup_reconciliation_required");
      await this.save({ ...state, pending: { ...pending, uploadId } });
    });
  }

  /** Only after the VM is confirmed stopped. Never infer that an unknown multipart ID vanished. */
  public async reconcileUnknown(
    discard: (objectKey: string, uploadId: string) => Promise<void>,
  ): Promise<void> {
    return this.journal(async () => {
      const state = await this.state();
      const pending = state.pending;
      if (!pending || pending.kind === "handoff") return;
      if (!pending.objectKey) {
        await this.save({ ...state, pending: null });
        return;
      }
      if (!pending.uploadId) throw new Error("preview_backup_multipart_outcome_unknown");
      await discard(pending.objectKey, pending.uploadId);
      await this.save({ ...state, pending: null });
    });
  }

  public async current(now: number): Promise<BackupMetadata | null> {
    const state = await this.state();
    if (state.pending?.kind === "creating" || state.pending?.kind === "unknown")
      throw new Error("preview_backup_reconciliation_required");
    const record = state.records.find((value) => value.record.id === state.current) ?? null;
    return record !== null && record.expiresAt > now ? record : null;
  }

  /** Cleanup may need the previous selected handle even while a later create is uncertain. */
  public async selected(): Promise<BackupMetadata | null> {
    const state = await this.state();
    return state.records.find((value) => value.record.id === state.current) ?? null;
  }

  /** Core renews this expiry atomically with an accepted save, even while asleep. */
  public async synchronizeExpiry(expiresAt: number): Promise<void> {
    if (!Number.isFinite(expiresAt)) throw new Error("preview_backup_expiry_invalid");
    const state = await this.state();
    if (state.pending !== null) throw new Error("preview_backup_reconciliation_required");
    const current = state.records.find((value) => value.record.id === state.current);
    if (!current) return;
    await this.save({
      ...state,
      records: state.records.map((value) =>
        value.record.id === current.record.id ? { ...value, expiresAt } : value,
      ),
    });
  }

  /** Must run before any customer-controlled server/config/binding process starts. */
  public async checkpoint(
    source: SourceVersion,
    now: number,
    publish: Publish,
  ): Promise<BackupMetadata> {
    let state = await this.state();
    if (state.pending !== null) throw new Error("preview_backup_reconciliation_required");
    const generation = Math.max(0, ...state.records.map((value) => value.generation)) + 1;
    state = { ...state, pending: { kind: "creating", generation } };
    await this.save(state);
    let record: DirectoryBackupRecord;
    try {
      record = await this.sdk.backup({
        dir: "/workspace/app",
        name: `preview-dependencies-${generation}`,
        exclude: BACKUP_EXCLUDES,
      });
    } catch {
      await this.journal(async () => {
        const latest = await this.state();
        if (
          !latest.pending ||
          latest.pending.kind === "handoff" ||
          latest.pending.generation !== generation
        )
          throw new Error("preview_backup_reconciliation_required");
        await this.save({ ...latest, pending: { ...latest.pending, kind: "unknown" } });
      });
      throw new Error("preview_backup_outcome_unknown");
    }
    const next = { record, source, generation, expiresAt: now + BACKUP_RETENTION_MS };
    const previous = state.current;
    // Persist the exact returned SDK handle before attempting the cross-service handoff.
    state = {
      ...state,
      current: record.id,
      records: [...state.records, next],
      pendingDelete: previous === null ? state.pendingDelete : [...state.pendingDelete, previous],
      pending: { kind: "handoff", generation },
    };
    await this.save(state);
    const actualExpiry = await publish(next);
    state = {
      ...state,
      records: state.records.map((value) =>
        value.record.id === next.record.id && actualExpiry !== undefined
          ? { ...value, expiresAt: actualExpiry }
          : value,
      ),
      pending: null,
    };
    await this.save(state);
    await this.deletePending();
    return actualExpiry === undefined ? next : { ...next, expiresAt: actualExpiry };
  }

  /** A known returned handle can be published again after an interrupted handoff. */
  public async reconcileHandoff(publish: Publish): Promise<void> {
    const state = await this.state();
    if (state.pending === null) return;
    if (state.pending.kind !== "handoff") throw new Error("preview_backup_reconciliation_required");
    if (state.pending.clearing === true && state.current === null) {
      await publish(null);
      await this.save({ ...state, pending: null });
      await this.deletePending();
      return;
    }
    const current = state.records.find((value) => value.record.id === state.current);
    if (!current || current.generation !== state.pending.generation)
      throw new Error("preview_backup_reconciliation_required");
    const actualExpiry = await publish(current);
    await this.save({
      ...state,
      records: state.records.map((value) =>
        value.record.id === current.record.id && actualExpiry !== undefined
          ? { ...value, expiresAt: actualExpiry }
          : value,
      ),
      pending: null,
    });
    await this.deletePending();
  }

  public async restore(now: number): Promise<BackupMetadata | null> {
    const record = await this.current(now);
    if (record !== null) await this.sdk.restore(record.record);
    return record;
  }

  public async renew(now: number, publish: Publish): Promise<void> {
    const state = await this.state();
    if (state.pending !== null) throw new Error("preview_backup_reconciliation_required");
    const current = state.records.find((value) => value.record.id === state.current);
    if (!current || current.expiresAt <= now) return;
    const next = { ...current, expiresAt: Math.max(current.expiresAt, now + BACKUP_RETENTION_MS) };
    const pending: BackupState = {
      ...state,
      records: state.records.map((value) => (value.record.id === next.record.id ? next : value)),
      pending: { kind: "handoff", generation: next.generation },
    };
    await this.save(pending);
    await publish(next);
    await this.save({ ...pending, pending: null });
  }

  public async expire(now: number, generation: number, publish: Publish): Promise<boolean> {
    const state = await this.state();
    if (state.pending !== null) throw new Error("preview_backup_reconciliation_required");
    const current = state.records.find((value) => value.record.id === state.current);
    if (!current || current.generation !== generation || current.expiresAt > now) return false;
    const pending: BackupState = {
      ...state,
      current: null,
      pendingDelete: [...state.pendingDelete, current.record.id],
      pending: { kind: "handoff", generation, clearing: true },
    };
    await this.save(pending);
    await publish(null);
    await this.save({ ...pending, pending: null });
    await this.deletePending();
    return true;
  }

  private async deletePending(): Promise<void> {
    let state = await this.state();
    for (const id of state.pendingDelete) {
      const record = state.records.find((value) => value.record.id === id);
      if (record) await this.sdk.delete(record.record);
      state = {
        ...state,
        records: state.records.filter((value) => value.record.id !== id),
        pendingDelete: state.pendingDelete.filter((value) => value !== id),
        deleted: [...new Set([...state.deleted, id])],
      };
      await this.save(state);
    }
  }
  public async retryDeletes(): Promise<void> {
    await this.deletePending();
  }

  /** Keep deletion proof durably until Core acknowledges its matching cleanup entry. */
  public async deletedHandles(): Promise<readonly string[]> {
    return (await this.state()).deleted;
  }
  public async acknowledgeDeleted(handle: string): Promise<void> {
    const state = await this.state();
    await this.save({ ...state, deleted: state.deleted.filter((value) => value !== handle) });
  }

  public async deleteAll(publish: Publish): Promise<void> {
    let state = await this.state();
    if (state.pending?.kind === "creating" || state.pending?.kind === "unknown")
      throw new Error("preview_backup_reconciliation_required");
    state = {
      ...state,
      current: null,
      pending: { kind: "handoff", generation: 0, clearing: true },
      pendingDelete: [
        ...new Set([...state.pendingDelete, ...state.records.map((value) => value.record.id)]),
      ],
    };
    await this.save(state);
    await publish(null);
    await this.save({ ...state, pending: null });
    await this.deletePending();
  }
}

interface BoundedSdk {
  backup(input: {
    dir: string;
    name: string;
    exclude: readonly string[];
    signal: AbortSignal;
  }): Promise<DirectoryBackupRecord>;
  restore(record: DirectoryBackupRecord, options: { signal: AbortSignal }): Promise<void>;
  delete(record: DirectoryBackupRecord): Promise<void>;
  intercept(): Promise<void>;
}
interface ActiveBackup {
  readonly controller: AbortController;
  readonly mode: "write" | "read";
  grant: BackupGatewayGrant | null;
  key: string | null;
}

/** Every SDK instance has an immutable operation ID, including callbacks that arrive late. */
export class BoundedDirectoryBackup implements DirectoryBackupPort {
  private active: ActiveBackup | null = null;
  private readonly operations = new Map<string, ActiveBackup>();
  public constructor(
    private readonly makeSdk: (operationId: string | null) => BoundedSdk,
    private readonly ledger: PreviewBackupGrantLedger,
    private readonly options: {
      readonly previewId: string;
      readonly prefix: string;
      readonly scope: () => Promise<BackupGrantScope>;
    },
  ) {}
  public intercept(): Promise<void> {
    return this.makeSdk(null).intercept();
  }
  public async delete(record: DirectoryBackupRecord): Promise<void> {
    await this.makeSdk(null).delete(record);
  }
  public backup(input: {
    dir: string;
    name: string;
    exclude: readonly string[];
  }): Promise<DirectoryBackupRecord> {
    return this.run("write", null, (sdk, signal) => sdk.backup({ ...input, signal }));
  }
  public restore(record: DirectoryBackupRecord): Promise<void> {
    return this.run("read", record, (sdk, signal) => sdk.restore(record, { signal }));
  }
  private async run<T>(
    mode: "write" | "read",
    record: DirectoryBackupRecord | null,
    work: (sdk: BoundedSdk, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.active) throw new Error("preview_backup_operation_busy");
    const entry: ActiveBackup = { controller: new AbortController(), mode, grant: null, key: null };
    this.active = entry;
    const signal = entry.controller.signal;
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
    const timer = setTimeout(
      () => entry.controller.abort(new Error("preview_backup_deadline")),
      BACKUP_LIMITS.operationMs,
    );
    const running = (async () => {
      const scope = await this.options.scope();
      signal.throwIfAborted();
      if (
        scope.fence.previewId !== this.options.previewId ||
        this.options.prefix !== `preview-backups/${this.options.previewId}/`
      )
        throw new Error("preview_backup_transfer_denied");
      const key = record ? `${this.options.prefix}${record.id}.tar.zst` : null;
      const grant = await this.ledger.begin({
        ...scope,
        mode,
        ...(record && key ? { key, size: record.size } : {}),
      });
      entry.grant = grant;
      if (signal.aborted) {
        await this.ledger.revoke(grant.operationId);
        signal.throwIfAborted();
      }
      entry.key = key;
      this.operations.set(grant.operationId, entry);
      const result = await work(this.makeSdk(grant.operationId), signal);
      signal.throwIfAborted();
      return result;
    })();
    // The SDK can remain pending after cancellation, including after restore verification.
    running.catch(ignoreRejection);
    try {
      return await Promise.race([running, aborted]);
    } finally {
      try {
        if (entry.grant) {
          this.operations.delete(entry.grant.operationId);
          const revoking = this.ledger.revoke(entry.grant.operationId);
          if (signal.aborted) void revoking.catch(ignoreRejection);
          else {
            await Promise.race([revoking, aborted]);
            signal.throwIfAborted();
          }
        }
      } finally {
        clearTimeout(timer);
        if (this.active === entry) this.active = null;
      }
    }
  }
  /** Abort synchronously; the separate storage queue performs durable revocation. */
  public async cancelActive(): Promise<void> {
    const entry = this.active;
    if (!entry) return;
    this.active = null;
    entry.controller.abort(new Error("preview_backup_cancelled"));
    if (entry.grant) {
      this.operations.delete(entry.grant.operationId);
      await this.ledger.revoke(entry.grant.operationId);
    }
  }
  private operation(operationId: string | null): ActiveBackup & { grant: BackupGatewayGrant } {
    const entry = operationId ? this.operations.get(operationId) : undefined;
    if (!entry || entry.controller.signal.aborted || entry.grant?.operationId !== operationId)
      throw new Error("preview_backup_transfer_denied");
    return entry as ActiveBackup & { grant: BackupGatewayGrant };
  }
  public claimControlKey(operationId: string | null, key: string): BackupGatewayGrant | null {
    if (operationId === null) return null;
    const entry = this.operation(operationId);
    if (entry.mode !== "write" || entry.key !== null)
      throw new Error("preview_backup_transfer_denied");
    entry.key = key;
    return entry.grant;
  }
  public gatewayGrant(operationId: string | null, key: string): BackupGatewayGrant {
    const entry = this.operation(operationId);
    if (entry.key !== key || !entry.grant) throw new Error("preview_backup_transfer_denied");
    return entry.grant;
  }
  public assertLocalActive(operationId: string | null): void {
    this.operation(operationId);
  }
  public async assertActive(operationId: string | null): Promise<void> {
    const entry = this.operation(operationId);
    await this.ledger.assertActive(entry.grant.operationId);
    entry.controller.signal.throwIfAborted();
  }
  public async assertScope(operationId: string | null, scope: BackupGrantScope): Promise<void> {
    const entry = this.operation(operationId);
    await this.ledger.assertScope(entry.grant.operationId, scope);
    entry.controller.signal.throwIfAborted();
  }
  public async captureObjectKey(key: string, operationId: string | null): Promise<void> {
    const entry = this.operation(operationId);
    if (entry.key !== key || !entry.grant) throw new Error("preview_backup_transfer_denied");
    await this.ledger.bindKey(entry.grant.operationId, key);
    entry.controller.signal.throwIfAborted();
  }
  public async captureUploadId(
    key: string,
    uploadId: string,
    operationId: string | null,
  ): Promise<void> {
    const entry = this.operation(operationId);
    if (entry.key !== key || !entry.grant) throw new Error("preview_backup_transfer_denied");
    await this.ledger.bindUpload(entry.grant.operationId, key, uploadId);
    entry.controller.signal.throwIfAborted();
  }
  public async validateCompletion(
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
    operationId: string | null,
  ): Promise<void> {
    const entry = this.operation(operationId);
    await this.ledger.validateCompletion(entry.grant.operationId, uploadId, parts);
    entry.controller.signal.throwIfAborted();
  }
  public async markCompletionDispatched(
    uploadId: string,
    operationId: string | null,
  ): Promise<void> {
    const entry = this.operation(operationId);
    await this.ledger.markCompletionDispatched(entry.grant.operationId, uploadId);
    entry.controller.signal.throwIfAborted();
  }
  public async confirmCompletion(
    uploadId: string,
    size: number,
    operationId: string | null,
  ): Promise<void> {
    const entry = this.operation(operationId);
    await this.ledger.confirmCompletion(entry.grant.operationId, uploadId, size);
    entry.controller.signal.throwIfAborted();
  }
}
