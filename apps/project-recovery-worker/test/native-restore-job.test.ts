import { expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({})),
  import: vi.fn(
    async (input: {
      authorize: () => Promise<void>;
      isRealmImported: (id: string) => Promise<boolean>;
      recordRealmImported: (id: string) => Promise<void>;
    }) => {
      const id = "00000000000000000000000004";
      await input.authorize();
      if (!(await input.isRealmImported(id))) await input.recordRealmImported(id);
    },
  ),
}));
vi.mock("../src/native-restore-import.js", () => ({
  prepareNativeRestore: mocked.prepare,
  importNativeRestore: mocked.import,
}));
import { runNativeRestoreJob } from "../src/native-restore-job.js";

it("resumes terminal pin cleanup without repeating import or OFF effects", async () => {
  const scope = {
      organizationId: "00000000000000000000000001",
      projectId: "00000000000000000000000002",
      restoreId: "00000000000000000000000003",
    },
    environmentId = "00000000000000000000000004";
  const bytes = Buffer.from("ciphertext"),
    sha = "ab".repeat(32),
    bucket = "ohmyho-development-backups",
    key = `restore-pins/${scope.organizationId}/${scope.projectId}/${scope.restoreId}.zip`;
  let phase: "preflight" | "restoring" = "preflight",
    imported = false,
    completed = false,
    offline = false,
    sanitized = false,
    pinState: "reserved" | "verified" = "reserved",
    cleanupAttempts = 0;
  const pin = () => ({ bucket, key, bytes: bytes.length, sha256: sha, state: pinState });
  const control = {
    readRestoreClaim: async () =>
      completed
        ? { scope, completed: true, pin: pin() }
        : {
            scope,
            completed: false,
            phase,
            inputState: imported ? "consumed" : "claimed",
            imported,
            pin: phase === "preflight" ? null : pin(),
            archive: {
              bucket,
              key: `snapshots/${scope.organizationId}/${scope.projectId}/00000000000000000000000005.zip`,
              bytes: bytes.length,
              sha256: sha,
              nativeManifest: "{}",
              nativeManifestSha256: sha,
              capturedAt: "2026-11-04T00:00:00.000Z",
            },
            target: {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              databaseId: "a1234567890123456789",
              providerProjectId: "provider",
              regionId: "eu-dev",
            },
            realms:
              phase === "preflight"
                ? []
                : [
                    {
                      environmentId,
                      revocationEpoch: 2,
                      configurationRevision: 3,
                      canonicalOrigin: null,
                    },
                  ],
          },
    readRestoreInput: async () => ({
      ciphertext: new Uint8Array(17),
      nonce: new Uint8Array(12),
      keyVersion: 1,
    }),
    reserveRestorePin: async () => ({ ...pin(), created: true }),
    recordRestorePin: async () => {
      pinState = "verified";
      return { status: "recorded" };
    },
    beginRestore: async () => {
      phase = "restoring";
    },
    assertRestoreImportAllowed: vi.fn(async () => ({ allowed: true })),
    isRestoreAcknowledged: async ({ kind }: { kind: string }) => ({
      acknowledged: kind === "offline" ? offline : sanitized,
    }),
    applyRestoreOffline: vi.fn(async () => {}),
    acknowledgeRestore: async ({ kind }: { kind: string }) => {
      if (kind === "offline") offline = true;
      else sanitized = true;
    },
    isRestoreRealmImported: vi.fn(async (input: { environmentId: string }) => {
      expect(input).toEqual({ environmentId });
      return { imported: false };
    }),
    markRestoreRealmImported: vi.fn(async (input: { environmentId: string }) => {
      expect(input).toEqual({ environmentId });
      return { imported: true };
    }),
    markRestoreImported: vi.fn(async () => {
      imported = true;
      return { status: "consumed" };
    }),
    revalidateRestore: async () => {},
    sanitizeRestore: async () => ({
      status: "sanitized",
      revocationEpoch: 2,
      configurationRevision: 3,
    }),
    completeRestore: async () => {
      completed = true;
    },
    recordRestorePinAbsent: vi.fn(async () => ({ status: "recorded" })),
  };
  const archives = {
    readVerified: async () => bytes,
    pinVerified: async () => ({}),
    readRestorePin: async () => bytes,
    inspectRestorePin: async () => "verified",
    removeRestorePin: async () => {
      if (++cleanupAttempts === 1) throw new Error("uncertain delete");
    },
  };
  const input = {
    scope,
    control: control as never,
    archives: archives as never,
    provider: {} as never,
    cipher: {
      open: async () =>
        new TextEncoder().encode(JSON.stringify({ version: 1, passphrase: "fixture-passphrase" })),
    },
    signal: AbortSignal.timeout(10000),
  };
  await expect(runNativeRestoreJob(input)).rejects.toThrow("uncertain delete");
  expect(completed).toBe(true);
  await expect(runNativeRestoreJob(input)).resolves.toEqual({
    status: "complete",
    restoreId: scope.restoreId,
  });
  expect(mocked.import).toHaveBeenCalledTimes(1);
  expect(control.assertRestoreImportAllowed).toHaveBeenCalledTimes(2);
  expect(control.isRestoreRealmImported).toHaveBeenCalledTimes(1);
  expect(control.markRestoreRealmImported).toHaveBeenCalledTimes(1);
  const recorded = control.markRestoreRealmImported.mock.invocationCallOrder[0];
  const completedImport = control.markRestoreImported.mock.invocationCallOrder[0];
  if (recorded === undefined || completedImport === undefined)
    throw new Error("Expected per-realm journal before complete import");
  expect(recorded).toBeLessThan(completedImport);
  expect(control.applyRestoreOffline).toHaveBeenCalledTimes(1);
  expect(control.recordRestorePinAbsent).toHaveBeenCalledTimes(1);
});

it("never starts a second PUT for an already reserved uncertain pin", async () => {
  const scope = {
    organizationId: "00000000000000000000000001",
    projectId: "00000000000000000000000002",
    restoreId: "00000000000000000000000003",
  };
  const bucket = "ohmyho-development-backups",
    key = `restore-pins/${scope.organizationId}/${scope.projectId}/${scope.restoreId}.zip`,
    sha = "ab".repeat(32),
    bytes = Buffer.from("ciphertext");
  const pin = { bucket, key, bytes: bytes.length, sha256: sha, state: "reserved", created: false };
  const begin = vi.fn(),
    put = vi.fn();
  const control = {
    readRestoreClaim: async () => ({
      scope,
      completed: false,
      phase: "preflight",
      inputState: "claimed",
      imported: false,
      pin,
      archive: {
        bucket,
        key: `snapshots/${scope.organizationId}/${scope.projectId}/00000000000000000000000005.zip`,
        bytes: bytes.length,
        sha256: sha,
        nativeManifest: "{}",
        nativeManifestSha256: sha,
        capturedAt: "2026-11-04T00:00:00.000Z",
      },
      target: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        databaseId: "a1234567890123456789",
        providerProjectId: "provider",
        regionId: "eu-dev",
      },
      realms: [],
    }),
    readRestoreInput: async () => ({
      ciphertext: new Uint8Array(17),
      nonce: new Uint8Array(12),
      keyVersion: 1,
    }),
    reserveRestorePin: async () => pin,
    beginRestore: begin,
  };
  await expect(
    runNativeRestoreJob({
      scope,
      control: control as never,
      archives: { readVerified: async () => bytes, pinVerified: put } as never,
      provider: {} as never,
      cipher: {
        open: async () =>
          new TextEncoder().encode(
            JSON.stringify({ version: 1, passphrase: "fixture-passphrase" }),
          ),
      },
      signal: AbortSignal.timeout(10000),
    }),
  ).rejects.toThrow("native_restore_pin_reconciliation_required");
  expect(put).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
});
