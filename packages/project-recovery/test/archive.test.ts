import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { Uint8ArrayReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import {
  createProjectRecoveryArchive,
  createProjectRecoveryArchiveV2,
  parseRecoveryScope,
  parseRecoveryScopeV2,
  type RecoveryScope,
  type RecoveryScopeV2,
} from "../src/index.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
} from "@ohmyhost/contracts/native-auth";

const scope = {
  organizationId: "00000000000000000000000001",
  projectId: "00000000000000000000000002",
  backupId: "00000000000000000000000003",
  dataMode: "isolated" as const,
  databaseEnvironments: ["00000000000000000000000004", "00000000000000000000000005"],
  environments: { dev: "00000000000000000000000004", prod: "00000000000000000000000005" },
};
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

it("exports a Prod-only project in either archive version without an invented Dev mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-prod-only-archive-"));
  const body = Buffer.from(
    "CREATE TABLE interest(email text);\nINSERT INTO interest VALUES ('saved@example.test');\n",
  );
  try {
    await writeFile(join(root, "prod.sql"), body);
    for (const dataMode of ["isolated", "shared"] as const) {
      const productionScope = {
        ...scope,
        dataMode,
        environments: { prod: scope.environments.prod },
        databaseEnvironments: [scope.environments.prod],
      };
      const resource = {
        kind: "application_database" as const,
        environmentId: scope.environments.prod,
      };
      const versionedScope = {
        schemaVersion: "ohmyhost.recovery-scope/v2" as const,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        backupId: scope.backupId,
        dataMode,
        environments: productionScope.environments,
        resources: [resource],
      };
      const file = { path: "prod.sql", bytes: body.length, sha256: digest(body) };
      const common = {
        inputDirectory: root,
        passphrase: "test1234",
        capturedAt: "2026-11-06T14:00:00.000Z",
        maximumBytes: 4096,
      };
      for (const version of [1, 2] as const) {
        const archivePath = join(root, `${dataMode}-${version}.zip`);
        const receipt =
          version === 1
            ? await createProjectRecoveryArchive({
                ...common,
                archivePath,
                scope: productionScope,
                files: [{ ...file, namespaceId: resource.environmentId }],
              })
            : await createProjectRecoveryArchiveV2({
                ...common,
                archivePath,
                scope: versionedScope,
                files: [{ ...file, resource }],
              });
        expect(receipt.sqlFiles).toEqual([dataMode === "shared" ? "shared.sql" : "prod.sql"]);
        const reader = new ZipReader(new Uint8ArrayReader(await readFile(archivePath)), {
          useWebWorkers: false,
        });
        try {
          const entries = await reader.getEntries();
          expect(entries.map((entry) => entry.filename)).toEqual(receipt.sqlFiles);
          const entry = entries[0];
          if (!entry || !("getData" in entry) || !entry.getData)
            throw new Error("Prod SQL missing");
          expect(entry.encrypted).toBe(true);
          expect(await entry.getData(new TextWriter(), { password: "test1234" })).toBe(
            body.toString(),
          );
        } finally {
          await reader.close();
        }
      }
      expect(parseRecoveryScope(productionScope).environments).toEqual({
        prod: scope.environments.prod,
      });
      expect(parseRecoveryScopeV2(versionedScope).environments).toEqual({
        prod: scope.environments.prod,
      });
      for (const environments of [
        {},
        { dev: scope.environments.dev },
        { prod: scope.environments.prod, retired: scope.environments.dev },
        { prod: scope.environments.prod, dev: undefined },
      ]) {
        expect(() =>
          parseRecoveryScope({ ...productionScope, environments } as RecoveryScope),
        ).toThrow();
        expect(() =>
          parseRecoveryScopeV2({ ...versionedScope, environments } as RecoveryScopeV2),
        ).toThrow();
      }
      expect(() =>
        parseRecoveryScope({ ...productionScope, databaseEnvironments: [scope.environments.dev] }),
      ).toThrow();
      expect(() =>
        parseRecoveryScopeV2({
          ...versionedScope,
          resources: [{ ...resource, environmentId: scope.environments.dev }],
        }),
      ).toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("writes a typed Auth-only or three-database archive without inventing an Auth environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-native-auth-archive-"));
  try {
    const resources = [
      { kind: "application_database" as const, environmentId: scope.environments.dev },
      { kind: "application_database" as const, environmentId: scope.environments.prod },
      { kind: "native_auth_database" as const, databaseId: "a1234567890123456789" },
    ];
    const files = await Promise.all(
      resources.map(async (resource, index) => {
        const bytes = Buffer.from(`SELECT ${index};`),
          path = `${index}.sql`;
        await writeFile(join(root, path), bytes);
        return { resource, path, bytes: bytes.length, sha256: digest(bytes) };
      }),
    );
    const authFile = files[2];
    if (!authFile) throw new Error("missing Native archive fixture file");
    const common = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      backupId: scope.backupId,
      dataMode: scope.dataMode,
      environments: scope.environments,
      schemaVersion: "ohmyhost.recovery-scope/v2" as const,
      nativeManifest: {
        schemaVersion: "ohmyhost.native-auth-inventory/v1" as const,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        databaseId: "a1234567890123456789",
        migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
        migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        realms: [
          {
            environmentId: scope.environments.dev,
            schemaName: `omh_auth_${scope.environments.dev.toLowerCase()}`,
            revocationEpoch: 1,
            configurationRevision: 1,
            dumpOffset: 0,
            dumpBytes: authFile.bytes,
            dumpSha256: authFile.sha256.slice(7),
          },
        ],
      },
    };
    const [nativeRealm] = common.nativeManifest.realms;
    if (!nativeRealm) throw new Error("missing Native archive fixture realm");
    for (const selected of [files, files.slice(2)]) {
      const firstFile = selected[0];
      if (!firstFile) throw new Error("missing selected archive fixture file");
      const input = {
        scope: { ...common, resources: selected.map((file) => file.resource) },
        files: selected,
        inputDirectory: root,
        archivePath: join(root, `${selected.length}.zip`),
        passphrase: "test1234",
        capturedAt: "2026-09-09T20:00:00.000Z",
        maximumBytes: 4096,
      };
      const receipt = await createProjectRecoveryArchiveV2(input);
      expect(receipt).toMatchObject({
        format: "zip-aes256-ae2-v2",
        sqlFiles: selected.length === 3 ? ["dev.sql", "prod.sql", "auth.sql"] : ["auth.sql"],
      });
      const reader = new ZipReader(new Uint8ArrayReader(await readFile(input.archivePath)), {
        useWebWorkers: false,
      });
      try {
        const entries = await reader.getEntries();
        expect(entries.map((entry) => [entry.filename, entry.encrypted])).toEqual(
          [...receipt.sqlFiles, "manifest.json"].map((name) => [name, true]),
        );
        const manifest = entries.at(-1);
        if (!manifest || !("getData" in manifest) || !manifest.getData)
          throw new Error("missing manifest");
        const text = await manifest.getData(new TextWriter(), { password: "test1234" });
        expect(text).toBe(JSON.stringify(receipt.nativeManifest));
        expect(receipt.nativeManifestSha256).toBe(digest(Buffer.from(text)));
        await expect(manifest.getData(new TextWriter(), { password: "wrong" })).rejects.toThrow();
      } finally {
        await reader.close();
      }
      await expect(
        createProjectRecoveryArchiveV2({
          ...input,
          archivePath: join(root, "bad.zip"),
          files: [firstFile, firstFile],
        }),
      ).rejects.toThrow();
      await expect(
        createProjectRecoveryArchiveV2({
          ...input,
          scope: {
            ...input.scope,
            nativeManifest: {
              ...common.nativeManifest,
              realms: [{ ...nativeRealm, dumpSha256: "0".repeat(64) }],
            },
          },
          archivePath: join(root, "bad-slice.zip"),
        }),
      ).rejects.toThrow();
      await expect(
        createProjectRecoveryArchiveV2({
          ...input,
          scope: {
            ...input.scope,
            nativeManifest: { ...common.nativeManifest, projectId: scope.organizationId },
          },
          archivePath: join(root, "tampered.zip"),
        }),
      ).rejects.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("writes only encrypted SQL entries with independent contents, checksums and one shared dump", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-sql-zip-"));
  try {
    const files = [];
    for (const [index, namespaceId] of scope.databaseEnvironments.entries()) {
      const bytes = Buffer.from(
        `CREATE TABLE example_${index}(value text);\nINSERT INTO example_${index} VALUES ('private-${index}');\n`,
      );
      const path = `${index}.sql`;
      await writeFile(join(root, path), bytes, { mode: 0o600 });
      files.push({ namespaceId, path, bytes: bytes.length, sha256: digest(bytes) });
    }
    for (const [variant, identities] of [
      ["original", scope.environments],
      ["reassigned", { dev: "00000000000000000000000006", prod: "00000000000000000000000007" }],
    ] as const)
      for (const mode of ["isolated", "shared"] as const) {
        const assignedFiles = files.map((file, index) => ({
          ...file,
          namespaceId: index === 0 ? identities.dev : identities.prod,
        }));
        const selected = mode === "shared" ? assignedFiles.slice(0, 1) : assignedFiles;
        const input = {
          scope: {
            ...scope,
            dataMode: mode,
            environments:
              mode === "shared" ? { dev: identities.dev, prod: identities.dev } : identities,
            databaseEnvironments: selected.map((f) => f.namespaceId),
          },
          files: selected,
          inputDirectory: root,
          archivePath: join(root, `${variant}-${mode}.zip`),
          passphrase: "test1234",
          capturedAt: "2026-09-09T20:00:00.000Z",
          maximumBytes: 4096,
        };
        const receipt = await createProjectRecoveryArchive(input);
        const bytes = await readFile(input.archivePath);
        expect(receipt).toMatchObject({
          format: "zip-aes256-ae2-v1",
          backupId: scope.backupId,
          bytes: bytes.length,
          sha256: digest(bytes),
          sqlFiles: mode === "shared" ? ["shared.sql"] : ["dev.sql", "prod.sql"],
        });
        expect(bytes.includes(Buffer.from("private-"))).toBe(false);
        expect((await stat(input.archivePath)).mode & 0o777).toBe(0o600);
        const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
        try {
          const entries = await reader.getEntries();
          expect(entries.map((e) => e.filename)).toEqual(receipt.sqlFiles);
          for (const [index, entry] of entries.entries()) {
            expect(entry.encrypted).toBe(true);
            if (!("getData" in entry) || !entry.getData) throw new Error("SQL file entry missing");
            const source = selected[index];
            if (!source) throw new Error("SQL source missing");
            expect(await entry.getData(new TextWriter(), { password: "test1234" })).toBe(
              await readFile(join(root, source.path), "utf8"),
            );
          }
          const first = entries[0];
          if (!first || !("getData" in first) || !first.getData)
            throw new Error("SQL file entry missing");
          await expect(
            first.getData(new TextWriter(), { password: "wrong-password" }),
          ).rejects.toThrow();
        } finally {
          await reader.close();
        }
        await expect(createProjectRecoveryArchive(input)).rejects.toMatchObject({
          code: "recovery_destination_exists",
        });
      }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects non-database scopes, changed or linked sources and oversize SQL without retaining an archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-sql-invalid-"));
  try {
    const bytes = Buffer.from("SELECT 'private';\n");
    await writeFile(join(root, "data.sql"), bytes);
    await symlink(join(root, "data.sql"), join(root, "linked.sql"));
    const file = {
      namespaceId: scope.environments.dev,
      path: "data.sql",
      bytes: bytes.length,
      sha256: digest(bytes),
    };
    const input = {
      scope: {
        ...scope,
        dataMode: "shared" as const,
        databaseEnvironments: [scope.environments.dev],
      },
      files: [file],
      inputDirectory: root,
      archivePath: join(root, "archive.zip"),
      passphrase: "test1234",
      capturedAt: "2026-09-09T20:00:00.000Z",
      maximumBytes: 1024,
    };
    for (const change of [
      { scope: { ...input.scope, databaseEnvironments: [] }, files: [] },
      { files: [{ ...file, namespaceId: scope.environments.prod }] },
      { files: [{ ...file, kind: "file" }] },
      { files: [{ ...file, path: "../outside.sql" }] },
      { files: [{ ...file, path: "linked.sql" }] },
      { files: [{ ...file, sha256: `sha256:${"0".repeat(64)}` }] },
      { files: [{ ...file, bytes: file.bytes + 1 }] },
      { maximumBytes: 1 },
      { passphrase: "" },
    ]) {
      await expect(
        createProjectRecoveryArchive({ ...input, ...change } as Parameters<
          typeof createProjectRecoveryArchive
        >[0]),
      ).rejects.toThrow();
      expect(await readdir(root)).not.toContain("archive.zip");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
