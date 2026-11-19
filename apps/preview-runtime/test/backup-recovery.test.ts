import { expect, it, vi } from "vitest";
import {
  BACKUP_RETENTION_MS,
  PreviewBackups,
  type BackupStorage,
  type DirectoryBackupPort,
} from "../src/backup.js";

it("reconciles a known failed upload but never claims an unknown multipart upload was deleted", async () => {
  const entries = new Map<string, unknown>();
  const storage: BackupStorage = {
    async get<T>(key: string) {
      return entries.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      entries.set(key, structuredClone(value));
    },
  };
  const source = {
    sourceConnectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceGeneration: 1,
    sequence: 1,
    commitSha: "a".repeat(40),
  };
  let captureId = true;
  const sdk: DirectoryBackupPort = {
    async backup() {
      await journal.captureObjectKey("preview-backups/own/object.tar.zst");
      if (captureId)
        await journal.captureUploadId("preview-backups/own/object.tar.zst", "known-upload");
      throw new Error("reply lost");
    },
    async restore() {},
    async delete() {},
  };
  const journal = new PreviewBackups(storage, sdk);
  await expect(journal.checkpoint(source, 1, async () => {})).rejects.toThrow(
    "preview_backup_outcome_unknown",
  );
  const discard = vi.fn(async () => {});
  await journal.reconcileUnknown(discard);
  expect(discard).toHaveBeenCalledWith("preview-backups/own/object.tar.zst", "known-upload");
  captureId = false;
  await expect(journal.checkpoint(source, 2, async () => {})).rejects.toThrow(
    "preview_backup_outcome_unknown",
  );
  await expect(journal.reconcileUnknown(discard)).rejects.toThrow(
    "preview_backup_multipart_outcome_unknown",
  );
  await expect(journal.deleteAll(async () => {})).rejects.toThrow(
    "preview_backup_reconciliation_required",
  );
  expect(discard).toHaveBeenCalledTimes(1);
});

it("recovers backup handoff, renews inactivity retention and deletes exact old handles", async () => {
  const entries = new Map<string, unknown>();
  const storage: BackupStorage = {
    async get<T>(key: string) {
      return entries.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      entries.set(key, structuredClone(value));
    },
  };
  const source = {
    sourceConnectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceGeneration: 1,
    sequence: 1,
    commitSha: "a".repeat(40),
  };
  let index = 0;
  const deleted: string[] = [],
    restored: string[] = [];
  const sdk: DirectoryBackupPort = {
    async backup() {
      return {
        id: `backup-${++index}`,
        dir: "/workspace/app",
        size: 1,
        sha256: "b".repeat(64),
        format: "tar+zstd/1",
      };
    },
    async restore(record) {
      restored.push(record.id);
    },
    async delete(record) {
      deleted.push(record.id);
    },
  };
  const backups = new PreviewBackups(storage, sdk);
  await backups.checkpoint(source, 1_000, async () => {});
  await backups.restore(1_001);
  expect(restored).toEqual(["backup-1"]);
  await backups.renew(2_000, async () => {});
  expect(await backups.expire(1_000 + BACKUP_RETENTION_MS, 1, async () => {})).toBe(false);
  await expect(
    backups.checkpoint(source, 2_000, async () => {
      throw new Error("handoff interrupted");
    }),
  ).rejects.toThrow();
  await backups.reconcileHandoff(async () => 3_000 + BACKUP_RETENTION_MS);
  expect((await backups.selected())?.expiresAt).toBe(3_000 + BACKUP_RETENTION_MS);
  expect(deleted).toEqual(["backup-1"]);
  expect(await backups.deletedHandles()).toEqual(["backup-1"]);
  await backups.acknowledgeDeleted("backup-1");
  expect(await backups.expire(3_000 + BACKUP_RETENTION_MS, 2, async () => {})).toBe(true);
  expect(deleted).toEqual(["backup-1", "backup-2"]);
  await backups.acknowledgeDeleted("backup-2");
  await backups.checkpoint(source, 4_000, async () => {});
  await backups.deleteAll(async () => {});
  expect(deleted).toEqual(["backup-1", "backup-2", "backup-3"]);
  expect(await backups.deletedHandles()).toEqual(["backup-3"]);
});
