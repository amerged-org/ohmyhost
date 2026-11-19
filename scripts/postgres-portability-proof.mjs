/* global process */

import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_ARCHIVE_BYTES,
  parsePostgresProofConnection,
  runPostgresCommand,
} from "./postgres-tools.mjs";

const CATALOG_SQL = `SELECT json_build_object(
  'schemas',(SELECT count(*)::integer FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'),
  'relations',(SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S','f')),
  'routines',(SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema')
)::text`;
const TARGET_EMPTY_SQL = `SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S','f')`;

export function normalizeLogicalDump(value) {
  if (typeof value !== "string") throw new Error("POSTGRES_PORTABILITY_DUMP_INVALID");
  return value
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !line.startsWith("--") &&
        !line.startsWith("\\restrict ") &&
        !line.startsWith("\\unrestrict "),
    )
    .join("\n")
    .trim();
}

export async function runPostgresPortabilityProof(input, dependencies = productionDependencies()) {
  const source = parsePostgresProofConnection(input.sourceDatabaseUrl);
  const target = parsePostgresProofConnection(input.targetDatabaseUrl);
  if (
    source.identity.host === target.identity.host &&
    source.identity.port === target.identity.port &&
    source.identity.database === target.identity.database
  ) {
    throw new Error("POSTGRES_PORTABILITY_TARGET_EQUALS_SOURCE");
  }
  const workspace = await dependencies.createWorkspace();
  await dependencies.secureWorkspace(workspace);
  const archive = join(workspace, "database.dump");
  const sourceLogical = join(workspace, "source.sql");
  const targetLogical = join(workspace, "target.sql");
  try {
    const clientMajor = parseClientMajor(await dependencies.command("pg_dump", ["--version"], {}));
    const sourceServerMajor = await serverMajor(dependencies, source.environment);
    const targetServerMajor = await serverMajor(dependencies, target.environment);
    if (clientMajor < sourceServerMajor || clientMajor < targetServerMajor) {
      throw new Error("POSTGRES_PORTABILITY_CLIENT_TOO_OLD");
    }
    const targetSuperuser =
      (await scalar(
        dependencies,
        target.environment,
        "SELECT rolsuper::integer FROM pg_roles WHERE rolname=current_user",
      )) === "1";
    if (targetSuperuser && input.allowLocalSuperuserTarget !== true) {
      throw new Error("POSTGRES_PORTABILITY_TARGET_SUPERUSER_FORBIDDEN");
    }
    if ((await scalar(dependencies, target.environment, TARGET_EMPTY_SQL)) !== "0") {
      throw new Error("POSTGRES_PORTABILITY_TARGET_NOT_EMPTY");
    }
    await dependencies.command(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--no-publications",
        "--no-security-labels",
        "--no-subscriptions",
        "--no-tablespaces",
        "--lock-wait-timeout=5000",
        "--file",
        archive,
      ],
      source.environment,
    );
    const archiveSize = await boundedFileSize(dependencies, archive);
    const archiveBody = await dependencies.readBinary(archive);
    if (archiveBody.byteLength !== archiveSize)
      throw new Error("POSTGRES_PORTABILITY_ARCHIVE_INVALID");
    const contents = await dependencies.command("pg_restore", ["--list", archive], {});
    if (contents.trim() === "") throw new Error("POSTGRES_PORTABILITY_ARCHIVE_INVALID");
    await dependencies.command(
      "pg_restore",
      [
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--no-publications",
        "--no-security-labels",
        "--no-subscriptions",
        "--no-tablespaces",
        "--dbname",
        "",
        archive,
      ],
      target.environment,
    );
    await logicalDump(dependencies, source.environment, sourceLogical);
    await logicalDump(dependencies, target.environment, targetLogical);
    const sourceLogicalBody = normalizeLogicalDump(await dependencies.readText(sourceLogical));
    const targetLogicalBody = normalizeLogicalDump(await dependencies.readText(targetLogical));
    const sourceLogicalSha256 = sha256(sourceLogicalBody);
    const targetLogicalSha256 = sha256(targetLogicalBody);
    const sourceCatalog = JSON.parse(await scalar(dependencies, source.environment, CATALOG_SQL));
    const targetCatalog = JSON.parse(await scalar(dependencies, target.environment, CATALOG_SQL));
    if (
      sourceLogicalSha256 !== targetLogicalSha256 ||
      JSON.stringify(sourceCatalog) !== JSON.stringify(targetCatalog)
    ) {
      throw new Error("POSTGRES_PORTABILITY_PARITY_FAILED");
    }
    return Object.freeze({
      schemaVersion: "ohmyhost.postgres-portability-proof/v1",
      clientMajor,
      sourceServerMajor,
      targetServerMajor,
      archiveBytes: archiveSize,
      archiveSha256: sha256(archiveBody),
      logicalSha256: sourceLogicalSha256,
      catalog: Object.freeze(sourceCatalog),
      restored: true,
    });
  } finally {
    await dependencies.cleanup(workspace);
  }
}

async function logicalDump(dependencies, environment, output) {
  await dependencies.command(
    "pg_dump",
    [
      "--format=plain",
      "--no-owner",
      "--no-privileges",
      "--no-comments",
      "--no-publications",
      "--no-security-labels",
      "--no-subscriptions",
      "--no-tablespaces",
      "--rows-per-insert=1",
      "--lock-wait-timeout=5000",
      "--file",
      output,
    ],
    environment,
  );
  await boundedFileSize(dependencies, output);
}

async function serverMajor(dependencies, environment) {
  const version = await scalar(dependencies, environment, "SHOW server_version_num");
  if (!/^\d{6}$/u.test(version)) throw new Error("POSTGRES_PORTABILITY_VERSION_INVALID");
  return Math.floor(Number(version) / 10_000);
}

async function scalar(dependencies, environment, sql) {
  const value = await dependencies.command(
    "psql",
    ["--no-psqlrc", "--no-align", "--tuples-only", "--set=ON_ERROR_STOP=1", "--command", sql],
    environment,
  );
  return value.trim();
}

async function boundedFileSize(dependencies, path) {
  const size = await dependencies.fileSize(path);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ARCHIVE_BYTES) {
    throw new Error("POSTGRES_PORTABILITY_ARCHIVE_INVALID");
  }
  return size;
}

function parseClientMajor(value) {
  const match = /\(PostgreSQL\) (\d+)\./u.exec(value);
  if (match?.[1] === undefined) throw new Error("POSTGRES_PORTABILITY_VERSION_INVALID");
  return Number(match[1]);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function productionDependencies() {
  return Object.freeze({
    createWorkspace: () => mkdtemp(join(tmpdir(), "ohmyhost-postgres-portability-")),
    secureWorkspace: (path) => chmod(path, 0o700),
    cleanup: (path) => rm(path, { recursive: true, force: true }),
    command: runPostgresCommand,
    readBinary: (path) => readFile(path),
    readText: (path) => readFile(path, "utf8"),
    fileSize: async (path) => (await stat(path)).size,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sourceDatabaseUrl = process.env.OHMYHOST_SOURCE_DATABASE_URL;
  const targetDatabaseUrl = process.env.OHMYHOST_TARGET_DATABASE_URL;
  if (sourceDatabaseUrl === undefined || targetDatabaseUrl === undefined)
    throw new Error("POSTGRES_PORTABILITY_CONNECTION_INVALID");
  const report = await runPostgresPortabilityProof({
    sourceDatabaseUrl,
    targetDatabaseUrl,
    allowLocalSuperuserTarget: process.env.OHMYHOST_ALLOW_LOCAL_SUPERUSER_TARGET === "true",
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
