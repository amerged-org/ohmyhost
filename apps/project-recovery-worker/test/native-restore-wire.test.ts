import { expect, it } from "vitest";
import {
  createRecoveryControlHandler,
  sha256Hex,
} from "../../recovery-container/src/control-mediator.js";
import { createRecoveryControlClient } from "../src/control-client.js";
import type { NativeRestoreControl } from "../src/native-restore-job.js";

it("mediates the scoped Native restore lifecycle and refuses foreign realms and stale generations", async () => {
  const token = "t".repeat(43),
    org = "00000000000000000000000001",
    project = "00000000000000000000000002",
    restore = "00000000000000000000000003",
    environmentId = "00000000000000000000000004",
    exportId = "00000000000000000000000005",
    claimId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    bucket = "ohmyho-development-backups",
    sha256 = "ab".repeat(32);
  const scope = { organizationId: org, projectId: project, restoreId: restore },
    pin = {
      bucket,
      key: `restore-pins/${org}/${project}/${restore}.zip`,
      bytes: 20,
      sha256,
      state: "verified",
    };
  const realm = {
    environmentId,
    revocationEpoch: 2,
    configurationRevision: 3,
    canonicalOrigin: "https://fixture.example",
  };
  let phase: "preflight" | "restoring" = "preflight",
    pinned = false,
    imported = false,
    realmImported = false,
    offline = false,
    sanitized = false,
    removed = false,
    completed = false;
  const check = (value: unknown) => expect(value).toMatchObject({ ...scope, claimId });
  const current = () =>
    completed
      ? { scope, completed: true, pin }
      : {
          scope,
          completed: false,
          phase,
          inputState: imported ? "consumed" : "claimed",
          imported,
          pin: pinned ? pin : null,
          archive: {
            bucket,
            key: `native-exports/${org}/${project}/${exportId}.zip`,
            bytes: 20,
            sha256,
            nativeManifest: '{"version":1}',
            nativeManifestSha256: sha256,
            capturedAt: "2026-11-04T00:00:00.000Z",
          },
          target: {
            organizationId: org,
            projectId: project,
            databaseId: "a1234567890123456789",
            providerProjectId: "prj_12345678901234567890",
            regionId: "eu-dev",
          },
          realms: phase === "preflight" ? [] : [realm],
        };
  const authority = {
    async readClaim(value: unknown) {
      check(value);
      return current();
    },
    async readInput(value: unknown) {
      check(value);
      return {
        ciphertext: new Uint8Array(17).fill(9),
        nonce: new Uint8Array(12).fill(2),
        keyVersion: 1,
      };
    },
    async reservePin(value: unknown) {
      check(value);
      return { ...pin, state: "reserved", created: true };
    },
    async recordPin(value: unknown) {
      check(value);
      pinned = true;
      return { status: "recorded" };
    },
    async beginRestore(value: unknown) {
      check(value);
      if (!pinned) throw new Error("no pin");
      phase = "restoring";
      return current();
    },
    async assertImportAllowed(value: unknown) {
      check(value);
      if (!offline) throw new Error("online");
      return { allowed: true };
    },
    async isAcknowledged(value: { kind: string }) {
      check(value);
      return { acknowledged: value.kind === "offline" ? offline : sanitized };
    },
    async acknowledge(value: { kind: string }) {
      check(value);
      if (value.kind === "offline") offline = true;
      else sanitized = true;
      return { acknowledged: true };
    },
    async isRealmImported(value: unknown) {
      check(value);
      return { imported: realmImported };
    },
    async markRealmImported(value: unknown) {
      check(value);
      if (!offline) throw new Error("online");
      realmImported = true;
      return { imported: true };
    },
    async markImported(value: unknown) {
      check(value);
      if (!realmImported) throw new Error("not imported");
      imported = true;
      return { status: "consumed" };
    },
    async finish(value: unknown) {
      check(value);
      if (!imported || !sanitized) throw new Error("not sanitized");
      completed = true;
      return { status: "complete" };
    },
    async recordPinAbsent(value: unknown) {
      check(value);
      if (!completed) throw new Error("not complete");
      removed = true;
      return { status: "recorded" };
    },
  };
  const handler = createRecoveryControlHandler<object>({
    clock: { now: () => new Date("2026-11-04T00:00:00.000Z") },
    dependencies: () => ({
      store: {} as never,
      restore: {
        store: authority as never,
        admin: () => ({
          applyRealmPolicy: async (value: unknown) => {
            expect(value).toMatchObject({
              organizationId: org,
              projectId: project,
              environmentId,
              enabled: false,
            });
            return { outcome: "applied" };
          },
          sanitizeRestore: async () => ({
            status: "sanitized",
            revocationEpoch: 2,
            configurationRevision: 3,
          }),
        }),
        preparation: () => ({ prepare: async () => ({ status: "verified" }) }),
      },
    }),
  });
  const grant = {
    containerId: "fixture-container",
    action: "restore",
    organizationId: org,
    projectId: project,
    operationId: restore,
    claimId,
    tokenSha256: await sha256Hex(token),
    expiresAtMs: Date.parse("2026-11-04T01:00:00.000Z"),
  };
  const client = createRecoveryControlClient({
    token,
    attempts: 1,
    fetch: (async (url: string | URL | Request, init?: RequestInit) =>
      handler(
        new Request(url, init),
        {},
        { containerId: "fixture-container", className: "RecoverySandbox", params: grant },
      )) as typeof fetch,
  }) as unknown as NativeRestoreControl;
  expect((await client.readRestoreInput()).ciphertext).toEqual(new Uint8Array(17).fill(9));
  expect((await client.readRestoreClaim()).completed).toBe(false);
  expect((await client.reserveRestorePin()).created).toBe(true);
  await client.recordRestorePin();
  await client.beginRestore();
  await expect(client.isRestoreRealmImported({ environmentId: exportId })).rejects.toThrow();
  await expect(client.applyRestoreOffline({ ...realm, revocationEpoch: 1 })).rejects.toThrow();
  await client.applyRestoreOffline(realm);
  await client.acknowledgeRestore({
    environmentId,
    revocationEpoch: 2,
    configurationRevision: 3,
    kind: "offline",
  });
  expect(
    (await client.isRestoreAcknowledged({ environmentId, kind: "offline" })).acknowledged,
  ).toBe(true);
  await client.assertRestoreImportAllowed();
  expect((await client.isRestoreRealmImported({ environmentId })).imported).toBe(false);
  await client.markRestoreRealmImported({ environmentId });
  await client.markRestoreImported();
  await client.revalidateRestore({ environmentId });
  await client.sanitizeRestore({ environmentId });
  await client.acknowledgeRestore({
    environmentId,
    revocationEpoch: 2,
    configurationRevision: 3,
    kind: "sanitized",
  });
  await client.completeRestore();
  expect((await client.readRestoreClaim()).completed).toBe(true);
  await client.recordRestorePinAbsent();
  expect(removed).toBe(true);
});
