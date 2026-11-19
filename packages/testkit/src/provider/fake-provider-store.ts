import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ProviderResource } from "@ohmyhost/platform";

export type FakeObservedState = "ready" | "failed" | "removed";

export interface FakeStaticResourceRecord {
  readonly operationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
  readonly resource: ProviderResource<"static-hosting">;
  readonly observedState: FakeObservedState;
  readonly removal?: FakeRemovalMutation;
}

export interface FakeRemovalMutation {
  readonly operationId: string;
  readonly idempotencyKey: string;
}

export interface FakeCreateOrReplayResult {
  readonly record: FakeStaticResourceRecord;
  readonly created: boolean;
}

export class FakeProviderStoreConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FakeProviderStoreConflictError";
  }
}

interface PersistedStore {
  readonly version: 1;
  readonly resources: readonly PersistedResourceRecord[];
}

interface PersistedResourceRecord {
  readonly operationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
  readonly resource: {
    readonly capability: "static-hosting";
    readonly provider: string;
    readonly externalId: string;
    readonly createdAt: string;
  };
  readonly observedState: FakeObservedState;
  readonly removal?: FakeRemovalMutation;
}

const WRITE_QUEUES = new Map<string, Promise<void>>();
const LOCK_RETRY_DELAY_MS = 5;
const LOCK_MAX_ATTEMPTS = 400;
const LOCK_STALE_AFTER_MS = 30_000;

interface HeldFileLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly device: number;
  readonly inode: number;
}

interface LockMetadata {
  readonly pid: number;
  readonly createdAtMs: number;
  readonly token: string;
}

export class FakeProviderStore {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  public async list(): Promise<readonly FakeStaticResourceRecord[]> {
    const persisted = await this.read();
    return persisted.resources.map(fromPersisted);
  }

  public async getByMutation(
    operationId: string,
    idempotencyKey: string,
  ): Promise<FakeStaticResourceRecord | undefined> {
    return (await this.list()).find(
      (record) => record.operationId === operationId && record.idempotencyKey === idempotencyKey,
    );
  }

  public async getByExternalId(externalId: string): Promise<FakeStaticResourceRecord | undefined> {
    return (await this.list()).find(({ resource }) => resource.externalId === externalId);
  }

  public async put(record: FakeStaticResourceRecord): Promise<void> {
    await this.runSerialized(() =>
      withCrossProcessLock(this.filePath, () => this.putUnlocked(record)),
    );
  }

  public async createOrReplay(
    candidate: FakeStaticResourceRecord,
    beforeCreate?: () => void,
  ): Promise<FakeCreateOrReplayResult> {
    return this.runSerialized(() =>
      withCrossProcessLock(this.filePath, async () => {
        const persistedCandidate = toPersisted(candidate);
        validateRecord(persistedCandidate);
        const current = await this.read();
        const existing = current.resources.find(
          ({ operationId, idempotencyKey }) =>
            operationId === candidate.operationId && idempotencyKey === candidate.idempotencyKey,
        );
        if (existing !== undefined) {
          if (existing.inputFingerprint !== candidate.inputFingerprint) {
            throw new FakeProviderStoreConflictError(
              "Idempotency key was already used with different input",
            );
          }
          return { record: fromPersisted(existing), created: false };
        }
        if (
          current.resources.some(
            ({ resource }) => resource.externalId === candidate.resource.externalId,
          )
        ) {
          throw new FakeProviderStoreConflictError(
            "Provider external ID already belongs to another mutation",
          );
        }

        beforeCreate?.();
        const resources = [...current.resources, persistedCandidate];
        resources.sort(comparePersistedRecords);
        const next = validateStore({
          version: 1,
          resources,
        });
        await this.write(next);
        return { record: fromPersisted(persistedCandidate), created: true };
      }),
    );
  }

  private async putUnlocked(record: FakeStaticResourceRecord): Promise<void> {
    validateRecord(toPersisted(record));
    const current = await this.read();
    const resources = current.resources.filter(
      ({ operationId, idempotencyKey }) =>
        operationId !== record.operationId || idempotencyKey !== record.idempotencyKey,
    );
    resources.push(toPersisted(record));
    resources.sort(comparePersistedRecords);
    await this.write(validateStore({ version: 1, resources }));
  }

  private async runSerialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = WRITE_QUEUES.get(this.filePath) ?? Promise.resolve();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => barrier);
    WRITE_QUEUES.set(this.filePath, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (WRITE_QUEUES.get(this.filePath) === queued) {
        WRITE_QUEUES.delete(this.filePath);
      }
    }
  }

  private async read(): Promise<PersistedStore> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return { version: 1, resources: [] };
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new TypeError("Fake provider store contains invalid JSON");
    }
    return validateStore(value);
  }

  private async write(store: PersistedStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(store, undefined, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function withCrossProcessLock<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock(`${filePath}.lock`);
  try {
    return await work();
  } finally {
    await releaseFileLock(lock);
  }
}

async function acquireFileLock(lockPath: string): Promise<HeldFileLock> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await createFileLock(lockPath);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (await recoverStaleLock(lockPath)) {
        continue;
      }
      if (attempt === LOCK_MAX_ATTEMPTS - 1) {
        throw new Error("Timed out waiting for fake provider store lock");
      }
      await delay(LOCK_RETRY_DELAY_MS);
    }
  }
  throw new Error("Timed out waiting for fake provider store lock");
}

async function createFileLock(lockPath: string): Promise<HeldFileLock> {
  const handle = await open(
    lockPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    const metadata: LockMetadata = {
      pid: process.pid,
      createdAtMs: Date.now(),
      token: randomUUID(),
    };
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error("Fake provider lock must be a regular file");
    }
    return { path: lockPath, handle, device: stats.dev, inode: stats.ino };
  } catch (error) {
    await handle.close();
    try {
      await unlink(lockPath);
    } catch (cleanupError) {
      if (!hasErrorCode(cleanupError, "ENOENT")) {
        throw cleanupError;
      }
    }
    throw error;
  }
}

async function recoverStaleLock(lockPath: string): Promise<boolean> {
  const pathStats = await readLockStatsOrAbsent(lockPath);
  if (pathStats === undefined) {
    return true;
  }
  assertSafeLockStats(pathStats);

  let handle: FileHandle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
  try {
    const descriptorStats = await handle.stat();
    if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) {
      return true;
    }
    const content = await handle.readFile("utf8");
    const metadata = parseLockMetadata(content);
    const lockAge = Date.now() - Math.max(pathStats.mtimeMs, metadata?.createdAtMs ?? 0);
    if (lockAge <= LOCK_STALE_AFTER_MS) {
      return false;
    }
    if (metadata !== null && isProcessAlive(metadata.pid)) {
      return false;
    }
  } finally {
    await handle.close();
  }

  const currentStats = await readLockStatsOrAbsent(lockPath);
  if (currentStats === undefined) {
    return true;
  }
  assertSafeLockStats(currentStats);
  if (currentStats.dev !== pathStats.dev || currentStats.ino !== pathStats.ino) {
    return true;
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  return true;
}

async function readLockStatsOrAbsent(lockPath: string): Promise<Stats | undefined> {
  try {
    return await lstat(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function releaseFileLock(lock: HeldFileLock): Promise<void> {
  await lock.handle.close();
  let currentStats;
  try {
    currentStats = await lstat(lock.path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  assertSafeLockStats(currentStats);
  if (currentStats.dev === lock.device && currentStats.ino === lock.inode) {
    await unlink(lock.path);
  }
}

function assertSafeLockStats(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Fake provider lock must be a regular file");
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stats.uid !== currentUid) {
    throw new Error("Fake provider lock must belong to the current user");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("Fake provider lock permissions must be owner-only");
  }
}

function parseLockMetadata(content: string): LockMetadata | null {
  try {
    const value: unknown = JSON.parse(content);
    if (
      !isRecord(value) ||
      typeof value["pid"] !== "number" ||
      !Number.isSafeInteger(value["pid"]) ||
      value["pid"] <= 0 ||
      typeof value["createdAtMs"] !== "number" ||
      !Number.isFinite(value["createdAtMs"]) ||
      typeof value["token"] !== "string" ||
      value["token"].length === 0
    ) {
      return null;
    }
    return {
      pid: value["pid"],
      createdAtMs: value["createdAtMs"],
      token: value["token"],
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EPERM")) {
      return true;
    }
    if (hasErrorCode(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}

function validateStore(value: unknown): PersistedStore {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["resources"])) {
    throw new TypeError("Fake provider store has an invalid envelope");
  }
  for (const record of value["resources"]) {
    validateRecord(record);
  }
  const mutationKeys = new Set<string>();
  const externalIds = new Set<string>();
  for (const record of value["resources"] as readonly PersistedResourceRecord[]) {
    const mutationKey = `${record.operationId}\u0000${record.idempotencyKey}`;
    if (mutationKeys.has(mutationKey)) {
      throw new TypeError("Fake provider store contains duplicate operation and idempotency key");
    }
    if (externalIds.has(record.resource.externalId)) {
      throw new TypeError("Fake provider store contains duplicate external ID");
    }
    mutationKeys.add(mutationKey);
    externalIds.add(record.resource.externalId);
  }
  return { version: 1, resources: value["resources"] as readonly PersistedResourceRecord[] };
}

function comparePersistedRecords(
  left: PersistedResourceRecord,
  right: PersistedResourceRecord,
): number {
  return `${left.operationId}:${left.idempotencyKey}`.localeCompare(
    `${right.operationId}:${right.idempotencyKey}`,
  );
}

function validateRecord(value: unknown): asserts value is PersistedResourceRecord {
  if (
    !isRecord(value) ||
    typeof value["operationId"] !== "string" ||
    !isUlid(value["operationId"]) ||
    typeof value["projectId"] !== "string" ||
    !isUlid(value["projectId"]) ||
    typeof value["environmentId"] !== "string" ||
    !isUlid(value["environmentId"]) ||
    typeof value["idempotencyKey"] !== "string" ||
    !isTrimmedNonEmpty(value["idempotencyKey"]) ||
    typeof value["inputFingerprint"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value["inputFingerprint"]) ||
    !isRecord(value["resource"]) ||
    value["resource"]["capability"] !== "static-hosting" ||
    value["resource"]["provider"] !== "fake-static" ||
    typeof value["resource"]["externalId"] !== "string" ||
    !isTrimmedNonEmpty(value["resource"]["externalId"]) ||
    typeof value["resource"]["createdAt"] !== "string" ||
    !isIsoDate(value["resource"]["createdAt"]) ||
    !isObservedState(value["observedState"])
  ) {
    throw new TypeError("Fake provider store contains an invalid record");
  }
  if (value["removal"] !== undefined) {
    validateRemoval(value["removal"]);
  }
}

function validateRemoval(value: unknown): asserts value is FakeRemovalMutation {
  if (
    !isRecord(value) ||
    typeof value["operationId"] !== "string" ||
    !isUlid(value["operationId"]) ||
    typeof value["idempotencyKey"] !== "string" ||
    !isTrimmedNonEmpty(value["idempotencyKey"])
  ) {
    throw new TypeError("Fake provider store contains an invalid removal mutation");
  }
}

function toPersisted(record: FakeStaticResourceRecord): PersistedResourceRecord {
  return {
    ...record,
    resource: { ...record.resource, createdAt: record.resource.createdAt.toISOString() },
  };
}

function fromPersisted(record: PersistedResourceRecord): FakeStaticResourceRecord {
  return {
    ...record,
    resource: { ...record.resource, createdAt: new Date(record.resource.createdAt) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isObservedState(value: unknown): value is FakeObservedState {
  return value === "ready" || value === "failed" || value === "removed";
}

function isUlid(value: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value);
}

function isTrimmedNonEmpty(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}
