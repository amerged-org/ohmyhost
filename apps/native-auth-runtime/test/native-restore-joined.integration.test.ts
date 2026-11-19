import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { expect, it, vi } from "vitest";
import * as nativeBridge from "../../../packages/postgres-bridge/dist/index.js";
import { startBridge as realStartBridge } from "../../../packages/postgres-bridge/src/bridge.js";
import { postgresProxy } from "../../../packages/postgres-bridge/test/postgres-proxy.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { createProjectRecoveryArchiveV2 } from "../../../packages/project-recovery/src/index.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedDevAccessProject } from "../../control-store/test/support/dev-access-fixture.js";
import { seedOperation } from "../../control-store/test/support/accepted-operation.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  beginNativeAuthRestore,
  acknowledgeNativeRestore,
  readNativeRestore,
} from "../../control-store/src/catalog/identity/native-auth-restore.js";
import {
  reserveNativeRestorePin,
  recordNativeRestorePin,
} from "../../control-store/src/catalog/identity/native-auth-restore-job.js";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { importNativeRestore } from "../../project-recovery-worker/src/native-restore-import.js";
import { runNativeRestoreJob } from "../../project-recovery-worker/src/native-restore-job.js";

const run = promisify(execFile);
it("imports an authenticated encrypted realm snapshot through real D1 authority and PG roles", async () => {
  const control = await createTestControl(),
    pg = await startTestPostgres(),
    root = await mkdtemp(join(tmpdir(), "native-restore-joined-"));
  const base = pg.pool.options.connectionString;
  if (!base) throw new Error("missing_postgres_fixture");
  const proxy = await postgresProxy(Number(new URL(base).port));
  const bridged = vi
    .spyOn(nativeBridge, "startBridge")
    .mockImplementation(async (raw) => realStartBridge(raw, { connect: proxy.connect }));
  let target: Client | undefined;
  try {
    const { project, principalId } = await seedDevAccessProject(control);
    const {
      organizationId,
      projectId,
      devEnvironmentId: environmentId,
      prodEnvironmentId,
    } = project;
    const databaseId = "a1234567890123456789",
      schemaName = `omh_auth_${environmentId.toLowerCase()}`,
      migrator = `omh_am_${environmentId.toLowerCase()}`;
    await pg.pool.query(`CREATE ROLE app LOGIN; CREATE ROLE ${migrator} LOGIN`);
    await pg.pool.query(`CREATE DATABASE ${databaseId} OWNER app`);
    const url = new URL(base);
    url.pathname = `/${databaseId}`;
    target = new Client({ connectionString: url.toString() });
    await target.connect();
    await target.query(
      `SET ROLE app; CREATE SCHEMA ${schemaName}; GRANT USAGE,CREATE ON SCHEMA ${schemaName} TO ${migrator}; RESET ROLE; SET ROLE ${migrator}; CREATE TABLE ${schemaName}.users(id int primary key,name text); INSERT INTO ${schemaName}.users VALUES (1,'snapshot'); RESET ROLE`,
    );
    const dump = Buffer.from(
      (
        await run(
          "pg_dump",
          [
            "--format=plain",
            "--no-owner",
            "--no-privileges",
            `--schema=${schemaName}`,
            url.toString(),
          ],
          { maxBuffer: 8 * 1024 * 1024 },
        )
      ).stdout,
    );
    const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    await writeFile(join(root, "auth.sql"), dump);
    const resource = { kind: "native_auth_database" as const, databaseId };
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
          schemaName,
          revocationEpoch: 1,
          configurationRevision: 1,
          dumpOffset: 0,
          dumpBytes: dump.length,
          dumpSha256: hash(dump),
        },
      ],
    };
    const exportOperationId = await seedOperation(project),
      restoreId = newUlid(),
      jobClaimId = crypto.randomUUID();
    const receipt = await createProjectRecoveryArchiveV2({
      scope: {
        schemaVersion: "ohmyhost.recovery-scope/v2",
        organizationId,
        projectId,
        backupId: exportOperationId,
        dataMode: "isolated",
        environments: { dev: environmentId, prod: prodEnvironmentId },
        resources: [resource],
        nativeManifest: manifest,
      },
      files: [{ resource, path: "auth.sql", bytes: dump.length, sha256: `sha256:${hash(dump)}` }],
      inputDirectory: root,
      archivePath: join(root, "archive.zip"),
      passphrase: "fixture-passphrase",
      capturedAt: "2026-11-04T00:00:00.000Z",
      maximumBytes: 10485760,
    });
    if (!receipt.nativeManifest || !receipt.nativeManifestSha256)
      throw new Error("missing_manifest");
    const archive = await readFile(join(root, "archive.zip")),
      manifestText = JSON.stringify(receipt.nativeManifest),
      manifestSha = receipt.nativeManifestSha256,
      db = control.core,
      context = { directory: db, router: new SharedCoreRouter(db) };
    await db
      .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
      .bind(organizationId)
      .run();
    await db.batch([
      db
        .prepare(
          `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',1,1)`,
        )
        .bind(organizationId, projectId, environmentId),
      db
        .prepare(
          `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'provider',?3,'operation','eu-dev','r256-s500m',1,'2026-01-01T00:00:00.000000Z','2026-01-01T00:00:00.000000Z')`,
        )
        .bind(organizationId, projectId, databaseId),
      db
        .prepare(
          `INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,'claim','provider',?5,'eu-dev','pgcf.example.test',?6,'omh_ar_'||lower(?3),1,1,'reference','active')`,
        )
        .bind(organizationId, projectId, environmentId, exportOperationId, databaseId, schemaName),
      db
        .prepare(
          `INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,native_manifest,native_manifest_sha256,captured_at,archive_expires_at,verified_at,finished_at) VALUES(?1,?2,?3,?4,'2099-01-01T01:00:00.000000Z','2099-01-01T00:00:00.000000Z','ohmyho-development-backups',?5,?6,'["auth.sql"]',?7,?8,'2099-01-01T00:00:00.000000Z','2099-01-08T00:00:00.000000Z','2099-01-01T00:00:00.000000Z','2099-01-01T00:00:00.000000Z')`,
        )
        .bind(
          organizationId,
          exportOperationId,
          projectId,
          environmentId,
          archive.length,
          Buffer.from(receipt.sha256.slice(7), "hex"),
          manifestText,
          Buffer.from(receipt.nativeManifestSha256.slice(7), "hex"),
        ),
    ]);
    await db
      .prepare(
        `INSERT INTO native_auth_restore_jobs(organization_id,project_id,restore_id,export_operation_id,archive_sha256,principal_id,input_ciphertext,input_nonce,input_key_version,input_digest,created_at,input_expires_at,claim_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,'2099-01-01T00:00:00.000000Z','2099-01-01T01:00:00.000000Z',?10,'claimed')`,
      )
      .bind(
        organizationId,
        projectId,
        restoreId,
        exportOperationId,
        Buffer.from(receipt.sha256.slice(7), "hex"),
        principalId,
        new Uint8Array(17),
        new Uint8Array(12),
        new Uint8Array(32),
        jobClaimId,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO native_auth_restore_claims(organization_id,project_id,restore_id,claim_id,input_generation) VALUES(?1,?2,?3,?4,1)",
      )
      .bind(organizationId, projectId, restoreId, jobClaimId)
      .run();
    const scope = { organizationId, projectId, environmentId, restoreId };
    const beginPreflight = vi.fn();
    await expect(
      runNativeRestoreJob({
        scope: { organizationId, projectId, restoreId },
        control: {
          readRestoreClaim: async () => ({
            scope: { organizationId, projectId, restoreId },
            completed: false,
            phase: "preflight",
            inputState: "claimed",
            imported: false,
            realms: [],
            target: {
              organizationId,
              projectId,
              databaseId,
              providerProjectId: "provider",
              regionId: "eu-dev",
            },
            archive: {
              bucket: "ohmyho-development-backups",
              key: "fixture",
              bytes: archive.length,
              sha256: receipt.sha256.slice(7),
              nativeManifest: manifestText,
              nativeManifestSha256: manifestSha.slice(7),
              capturedAt: receipt.capturedAt,
            },
          }),
          readRestoreInput: async () => ({
            ciphertext: new Uint8Array(),
            nonce: new Uint8Array(),
            keyVersion: 1,
          }),
          beginRestore: beginPreflight,
        } as never,
        archives: { readVerified: async () => archive } as never,
        provider: {} as never,
        cipher: {
          open: async () =>
            new TextEncoder().encode(JSON.stringify({ version: 1, passphrase: "wrong-password" })),
        },
        signal: AbortSignal.timeout(60000),
      }),
    ).rejects.toThrow();
    expect(beginPreflight).not.toHaveBeenCalled();
    await reserveNativeRestorePin(context, {
      organizationId,
      projectId,
      restoreId,
      claimId: jobClaimId,
    });
    await recordNativeRestorePin(context, {
      organizationId,
      projectId,
      restoreId,
      claimId: jobClaimId,
    });
    expect(
      await db
        .prepare(
          "SELECT enabled FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(organizationId, projectId, environmentId)
        .first(),
    ).toEqual({ enabled: 1 });
    await beginNativeAuthRestore(context, {
      organizationId,
      projectId,
      principalId,
      restoreId,
      jobClaimId,
      exportOperationId,
      archiveSha256: receipt.sha256.slice(7),
    });
    await acknowledgeNativeRestore(context, {
      ...scope,
      kind: "offline",
      revocationEpoch: 2,
      configurationRevision: 2,
    });
    await target.query(
      `SET ROLE ${migrator}; UPDATE ${schemaName}.users SET name='newer'; RESET ROLE`,
    );
    const provider = {
      projectId: "provider",
      readDatabase: async () => ({
        id: databaseId,
        projectId: "provider",
        regionId: "eu-dev",
        desiredState: "active",
      }),
      readRoles: async () => [
        {
          name: migrator,
          databaseId,
          owner: false,
          bypassRls: false,
          connectionLimit: 2,
          validUntil: null,
          memberOf: [],
        },
      ],
      readConnection: async (_id: string, role: string) => ({
        host: "pgcf.example.test",
        consume: async (fn: (uri: string) => Promise<unknown>) =>
          fn(`postgresql://${role}:fixture-password@pgcf.example.test/${databaseId}`),
      }),
    };
    const importInput = {
      provider: provider as never,
      target: {
        organizationId,
        projectId,
        databaseId,
        providerProjectId: "provider",
        regionId: "eu-dev",
      },
      archive,
      archiveSha256: receipt.sha256.slice(7),
      nativeManifest: manifestText,
      nativeManifestSha256: receipt.nativeManifestSha256.slice(7),
      passphrase: "fixture-passphrase",
      maximumBytes: 10485760,
      signal: AbortSignal.timeout(60000),
      authorize: async () => {
        if (!(await readNativeRestore(context, scope))) throw new Error("fence lost");
      },
      isRealmImported: async () =>
        (await db
          .prepare(
            `SELECT 1 FROM native_auth_restore_import_realms WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND environment_id=?4`,
          )
          .bind(organizationId, projectId, restoreId, environmentId)
          .first()) !== null,
      recordRealmImported: async () => {
        await db
          .prepare(
            `INSERT INTO native_auth_restore_import_realms(organization_id,project_id,restore_id,environment_id,imported_at) VALUES(?1,?2,?3,?4,'2026-11-04T00:00:00.000000Z')`,
          )
          .bind(organizationId, projectId, restoreId, environmentId)
          .run();
      },
    };
    await importNativeRestore(importInput);
    // A lost coordinator response must not replay a realm whose committed import is already journaled.
    await importNativeRestore(importInput);
    expect((await target.query(`SELECT name FROM ${schemaName}.users`)).rows[0]?.name).toBe(
      "snapshot",
    );
    expect(
      (
        await target.query(
          `SELECT pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='users'`,
          [schemaName],
        )
      ).rows[0]?.owner,
    ).toBe(migrator);
  } finally {
    await target?.end();
    bridged.mockRestore();
    await proxy.close();
    await pg.stop();
    await control.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
