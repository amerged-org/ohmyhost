/* global process */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { createProjectRecoveryArchive } from "../packages/project-recovery/dist/index.js";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";
import {
  createEncryptedPostgresBackup,
  restoreEncryptedPostgresBackup,
} from "../scripts/platform-postgres-backup.mjs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  normalizeLogicalDump,
  runPostgresPortabilityProof,
} from "../scripts/postgres-portability-proof.mjs";

import {
  parsePostgresProofConnection,
  parsePgcfProofConnection,
  openPostgresProofConnection,
  runPostgresCommand,
} from "../scripts/postgres-tools.mjs";

const executeFile = promisify(execFile);

test("keeps credentials out of command arguments and rejects pooled or same targets", async () => {
  const source = parsePostgresProofConnection(
    "postgresql://owner:super-secret@ep-direct.example.neon.tech/app?sslmode=require&channel_binding=require",
  );
  assert.equal(source.environment.PGPASSWORD, "super-secret");
  assert.equal(source.environment.PGTZ, "UTC");
  assert.equal(
    parsePostgresProofConnection("postgresql://owner:secret@db.example.com/app?sslmode=verify-full")
      .environment.PGSSLROOTCERT,
    "system",
  );
  assert.equal(JSON.stringify(source.identity).includes("super-secret"), false);
  const pgcfUri = `postgresql://export_reader:super-secret@pgcf.example.test/${"a".repeat(20)}?sslmode=require`;
  const target = {
    provider: "pgcf",
    host: "pgcf.example.test",
    databaseId: "a".repeat(20),
    role: "export_reader",
  };
  await assert.rejects(
    openPostgresProofConnection(pgcfUri, { ...target, databaseId: "b".repeat(20) }),
    /POSTGRES_PORTABILITY_CONNECTION_INVALID/u,
  );
  const noQuery = pgcfUri.replace("?sslmode=require", "");
  assert.throws(
    () => parsePostgresProofConnection(noQuery),
    /POSTGRES_PORTABILITY_CONNECTION_INVALID/u,
  );
  assert.equal(parsePgcfProofConnection(noQuery, target).environment.PGSSLMODE, "require");
  for (const suffix of [
    "?sslmode=disable",
    "?sslmode=require&host=elsewhere",
    "?sslmode=require&sslmode=require",
  ])
    assert.throws(
      () => parsePgcfProofConnection(noQuery + suffix, target),
      /POSTGRES_PORTABILITY_CONNECTION_INVALID/u,
    );
  const bridged = await openPostgresProofConnection(noQuery, JSON.stringify(target));
  try {
    assert.equal(bridged.environment.PGHOST, "127.0.0.1");
    assert.equal(bridged.environment.PGSSLMODE, "disable");
    assert.equal(bridged.environment.PGPASSWORD, "super-secret");
    assert.notEqual(bridged.environment.PGPORT, "0");
  } finally {
    await bridged.close();
  }

  assert.throws(
    () =>
      parsePostgresProofConnection(
        "postgresql://owner:secret@ep-direct-pooler.example.neon.tech/app?sslmode=require",
      ),
    /POSTGRES_PORTABILITY_CONNECTION_INVALID/u,
  );
  await assert.rejects(
    runPostgresPortabilityProof({
      sourceDatabaseUrl: "postgresql://owner@127.0.0.1:5432/app",
      targetDatabaseUrl: "postgresql://owner@127.0.0.1:5432/app",
    }),
    /POSTGRES_PORTABILITY_TARGET_EQUALS_SOURCE/u,
  );
});

test("normalizes only non-semantic dump headers and PostgreSQL restrict keys", () => {
  assert.equal(
    normalizeLogicalDump(
      "-- dump header\n\\restrict abc123\nCREATE TABLE public.example(id integer);\n\\unrestrict abc123\n",
    ),
    "CREATE TABLE public.example(id integer);",
  );
});

test("restores a custom archive between isolated PostgreSQL clusters and proves logical parity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-postgres-portability-test-"));
  const source = await startCluster(join(root, "source"));
  const target = await startCluster(join(root, "target"));
  const proofDirectoriesBefore = await portabilityProofDirectories();
  try {
    await psql(source.url, "ALTER DATABASE postgres SET timezone TO 'UTC'");
    await psql(target.url, "ALTER DATABASE postgres SET timezone TO 'Europe/Amsterdam'");
    await psql(
      source.url,
      `CREATE TYPE public.booking_state AS ENUM ('new','confirmed');
       CREATE TABLE public.booking(
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         guest text NOT NULL,
         state public.booking_state NOT NULL DEFAULT 'new',
         created_at timestamptz NOT NULL
       );
       INSERT INTO public.booking(guest,state,created_at) VALUES
         ('portability-private-guest-Ada-fixture','confirmed','2026-08-22T10:00:00Z'),('Linus','new','2026-08-22T11:00:00Z');
       CREATE VIEW public.confirmed_booking AS SELECT id,guest FROM public.booking WHERE state='confirmed';
       CREATE FUNCTION public.booking_count() RETURNS bigint LANGUAGE sql STABLE AS 'SELECT count(*) FROM public.booking';`,
    );
    const report = await runPostgresPortabilityProof({
      sourceDatabaseUrl: source.url,
      targetDatabaseUrl: target.url,
      allowLocalSuperuserTarget: true,
    });
    assert.equal(report.schemaVersion, "ohmyhost.postgres-portability-proof/v1");
    assert.equal(report.restored, true);
    assert.match(report.archiveSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.match(report.logicalSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(report.catalog, { schemas: 1, relations: 3, routines: 1 });
    assert.equal(await psql(target.url, "SELECT public.booking_count()"), "2");
    assert.equal(JSON.stringify(report).includes(source.url), false);
    assert.equal(JSON.stringify(report).includes(target.url), false);
    assert.deepEqual(await portabilityProofDirectories(), proofDirectoriesBefore);
    const passphrase = randomBytes(32).toString("base64url");
    const archivePath = join(root, "database.dump.age");
    const backup = await createEncryptedPostgresBackup({
      sourceDatabaseUrl: source.url,
      passphrase,
      archivePath,
    });
    assert.equal(backup.format, "age-scrypt-pg-custom");
    await assert.rejects(
      createEncryptedPostgresBackup({
        sourceDatabaseUrl: source.url,
        passphrase: "",
        archivePath: join(root, "empty-password.dump.age"),
      }),
      /POSTGRES_BACKUP_PASSPHRASE_REQUIRED/,
    );
    await assert.rejects(stat(join(root, "empty-password.dump.age")), { code: "ENOENT" });
    assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
    // Random ciphertext can contain a three-byte name by chance. Check the full private value.
    assert.equal(
      (await readFile(archivePath)).includes(Buffer.from("portability-private-guest-Ada-fixture")),
      false,
    );
    assert.equal(JSON.stringify(backup).includes(passphrase), false);
    assert.equal(JSON.stringify(backup).includes(source.url), false);
    await assert.rejects(
      createEncryptedPostgresBackup({ sourceDatabaseUrl: source.url, passphrase, archivePath }),
      /EEXIST/,
    );
    const missingSource = new URL(source.url);
    missingSource.pathname = "/missing_database";
    const failedArchive = join(root, "failed.dump.age");
    await assert.rejects(
      createEncryptedPostgresBackup({
        sourceDatabaseUrl: missingSource.toString(),
        passphrase,
        archivePath: failedArchive,
      }),
      /POSTGRES_PORTABILITY_COMMAND_FAILED/,
    );
    await assert.rejects(stat(failedArchive), { code: "ENOENT" });
    await psql(target.url, "CREATE ROLE restore_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE");
    await psql(target.url, "CREATE DATABASE backup_restore OWNER restore_owner");
    const destination = new URL(target.url);
    destination.username = "restore_owner";
    destination.pathname = "/backup_restore";
    const restore = {
      archivePath,
      passphrase,
      sha256: backup.sha256,
      targetDatabaseUrl: destination.toString(),
    };
    await assert.rejects(
      restoreEncryptedPostgresBackup({
        ...restore,
        passphrase: randomBytes(32).toString("base64url"),
      }),
      /POSTGRES_BACKUP_DECRYPTION_FAILED/,
    );
    await restoreEncryptedPostgresBackup(restore);
    assert.equal(await psql(destination.toString(), "SELECT public.booking_count()"), "2");
    assert.equal(
      await psql(
        destination.toString(),
        "SELECT string_agg(guest,',' ORDER BY id) FROM public.booking",
      ),
      "portability-private-guest-Ada-fixture,Linus",
    );
    await assert.rejects(
      restoreEncryptedPostgresBackup(restore),
      /POSTGRES_BACKUP_TARGET_NOT_EMPTY/,
    );
    await assert.rejects(
      restoreEncryptedPostgresBackup({ ...restore, targetDatabaseUrl: source.url }),
      /POSTGRES_BACKUP_TARGET_SUPERUSER/,
    );
    await psql(
      source.url,
      `CREATE SCHEMA auth;
      CREATE TABLE auth.users(id integer PRIMARY KEY, email text NOT NULL);
      INSERT INTO auth.users VALUES (1,'dev-customer@example.test');
      CREATE ROLE export_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT USAGE ON SCHEMA public,auth TO export_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA public,auth TO export_reader;
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO export_reader`,
    );
    const readonlySource = new URL(source.url);
    readonlySource.username = "export_reader";
    await assert.rejects(
      psql(
        readonlySource.toString(),
        "INSERT INTO public.booking(guest,state,created_at) VALUES ('denied','new',now())",
      ),
    );
    await psql(
      destination.toString(),
      "INSERT INTO public.booking(guest,state,created_at) VALUES ('ProdOnly','new','2026-09-01T00:00:00Z')",
    );
    const stage = join(root, "project-snapshot");
    await mkdir(stage);
    const scope = {
      organizationId: "00000000000000000000000001",
      projectId: "00000000000000000000000002",
      backupId: "00000000000000000000000003",
      dataMode: "isolated",
      databaseEnvironments: ["00000000000000000000000004", "00000000000000000000000005"],
      environments: { dev: "00000000000000000000000004", prod: "00000000000000000000000005" },
    };
    const files = [];
    for (const [environment, url] of [
      ["dev", readonlySource.toString()],
      ["prod", destination.toString()],
    ]) {
      const dump = await runPostgresCommand(
        "pg_dump",
        ["--format=plain", "--no-owner", "--no-privileges"],
        parsePostgresProofConnection(url).environment,
        { binary: true },
      );
      const path = `${environment}.sql`;
      await writeFile(join(stage, path), dump, { mode: 0o600 });
      files.push({
        namespaceId: scope.environments[environment],
        path,
        bytes: dump.length,
        sha256: `sha256:${createHash("sha256").update(dump).digest("hex")}`,
      });
    }
    const projectArchive = join(root, "project.zip");
    const receipt = await createProjectRecoveryArchive({
      scope,
      files,
      inputDirectory: stage,
      archivePath: projectArchive,
      passphrase,
      capturedAt: "2026-09-09T00:00:00.000Z",
      maximumBytes: 16 * 1024 * 1024,
    });
    assert.deepEqual(receipt.sqlFiles, ["dev.sql", "prod.sql"]);
    const recoveredDirectory = join(root, "project-restore");
    await mkdir(recoveredDirectory);
    const reader = new ZipReader(new Uint8ArrayReader(await readFile(projectArchive)), {
      password: passphrase,
      useWebWorkers: false,
    });
    try {
      const entries = await reader.getEntries();
      assert.deepEqual(
        entries.map((entry) => entry.filename),
        receipt.sqlFiles,
      );
      for (const entry of entries) {
        assert.equal(entry.encrypted, true);
        await writeFile(
          join(recoveredDirectory, entry.filename),
          await entry.getData(new Uint8ArrayWriter()),
          { mode: 0o600 },
        );
      }
    } finally {
      await reader.close();
    }
    for (const environment of ["dev", "prod"]) {
      const databaseName = `project_restore_${environment}`;
      await psql(target.url, `CREATE DATABASE ${databaseName} OWNER restore_owner`);
      const restoreUrl = new URL(destination);
      restoreUrl.pathname = `/${databaseName}`;
      await runPostgresCommand(
        "psql",
        [
          "-X",
          "--set=ON_ERROR_STOP=on",
          "--single-transaction",
          "--file",
          join(recoveredDirectory, `${environment}.sql`),
        ],
        parsePostgresProofConnection(restoreUrl.toString()).environment,
      );
      assert.equal(
        await psql(restoreUrl.toString(), "SELECT public.booking_count()"),
        environment === "dev" ? "2" : "3",
      );
      if (environment === "dev")
        assert.equal(
          await psql(restoreUrl.toString(), "SELECT email FROM auth.users"),
          "dev-customer@example.test",
        );
    }
  } finally {
    await Promise.allSettled([source.stop(), target.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

async function startCluster(dataDirectory) {
  const port = await availablePort();
  await executeFile("initdb", ["-D", dataDirectory, "-A", "trust", "-U", "postgres"]);
  await executeFile("pg_ctl", [
    "-D",
    dataDirectory,
    "-l",
    `${dataDirectory}.log`,
    "-o",
    `-F -p ${String(port)} -h 127.0.0.1 -k ''`,
    "-w",
    "start",
  ]).catch(async (error) => {
    throw new Error(await readFile(`${dataDirectory}.log`, "utf8"), { cause: error });
  });
  const url = `postgresql://postgres@127.0.0.1:${String(port)}/postgres`;
  return {
    url,
    stop: () =>
      executeFile("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]).then(
        () => undefined,
      ),
  };
}

async function portabilityProofDirectories() {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("ohmyhost-postgres-portability-"))
    .sort();
}

async function psql(url, sql) {
  const connection = parsePostgresProofConnection(url);
  const result = await executeFile(
    "psql",
    ["--no-psqlrc", "--no-align", "--tuples-only", "--set=ON_ERROR_STOP=1", "--command", sql],
    {
      env: {
        ...(typeof process.env.PATH === "string" ? { PATH: process.env.PATH } : {}),
        ...connection.environment,
      },
    },
  );
  return result.stdout.trim();
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("POSTGRES_PORTABILITY_PORT_UNAVAILABLE"));
        return;
      }
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
}
