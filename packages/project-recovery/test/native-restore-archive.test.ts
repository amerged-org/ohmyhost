import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { createProjectRecoveryArchiveV2 } from "../src/index.js";
import { readNativeRestoreArchive } from "../src/native-restore-archive.js";

it("opens only the exact encrypted archive and Core-bound Native manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-restore-archive-"));
  try {
    const organizationId = "00000000000000000000000001",
      projectId = "00000000000000000000000002",
      backupId = "00000000000000000000000003",
      environmentId = "00000000000000000000000004",
      prod = "00000000000000000000000005",
      databaseId = "a1234567890123456789";
    const sql = Buffer.from("SELECT 1;\n");
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const manifest = {
      schemaVersion: "ohmyhost.native-auth-inventory/v1" as const,
      organizationId,
      projectId,
      databaseId,
      migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
      migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
      realms: [
        {
          environmentId,
          schemaName: `omh_auth_${environmentId.toLowerCase()}`,
          revocationEpoch: 1,
          configurationRevision: 1,
          dumpOffset: 0,
          dumpBytes: sql.length,
          dumpSha256: digest(sql),
        },
      ],
    };
    await writeFile(join(root, "auth.sql"), sql);
    const resource = { kind: "native_auth_database" as const, databaseId };
    const receipt = await createProjectRecoveryArchiveV2({
      scope: {
        schemaVersion: "ohmyhost.recovery-scope/v2",
        organizationId,
        projectId,
        backupId,
        dataMode: "isolated",
        environments: { dev: environmentId, prod },
        resources: [resource],
        nativeManifest: manifest,
      },
      files: [{ resource, path: "auth.sql", bytes: sql.length, sha256: `sha256:${digest(sql)}` }],
      inputDirectory: root,
      archivePath: join(root, "archive.zip"),
      passphrase: "test1234",
      capturedAt: "2026-09-09T20:00:00.000Z",
      maximumBytes: 4096,
    });
    if (!receipt.nativeManifest || !receipt.nativeManifestSha256)
      throw new Error("missing fixture manifest");
    const archive = await readFile(join(root, "archive.zip"));
    const input = {
      archive,
      archiveSha256: receipt.sha256.slice(7),
      nativeManifest: JSON.stringify(receipt.nativeManifest),
      nativeManifestSha256: receipt.nativeManifestSha256.slice(7),
      passphrase: "test1234",
      maximumBytes: 4096,
    };
    expect(Buffer.from((await readNativeRestoreArchive(input)).sql)).toEqual(sql);
    await expect(readNativeRestoreArchive({ ...input, passphrase: "wrong" })).rejects.toThrow();
    await expect(
      readNativeRestoreArchive({ ...input, archiveSha256: "00".repeat(32) }),
    ).rejects.toThrow();
    await expect(
      readNativeRestoreArchive({
        ...input,
        nativeManifest: input.nativeManifest.replace(databaseId, "other-db"),
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
