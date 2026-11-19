/* global process */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Encrypter, Decrypter } from "age-encryption";
import {
  parsePostgresProofConnection,
  parsePgcfProofConnection,
  openPostgresProofConnection,
  runPostgresCommand,
  MAX_ARCHIVE_BYTES,
} from "./postgres-tools.mjs";

const portableFlags = [
  "--no-owner",
  "--no-privileges",
  "--no-publications",
  "--no-security-labels",
  "--no-subscriptions",
  "--no-tablespaces",
];
const maximumCipherBytes = MAX_ARCHIVE_BYTES + 1024 * 1024;

/** Trusted Node job only. Input connections come from the platform, never a customer request or build. */
export async function createEncryptedPostgresBackup({
  sourceDatabaseUrl,
  sourceDatabaseTarget,
  passphrase,
  archivePath,
}) {
  if (typeof passphrase !== "string" || passphrase.trim().length === 0)
    throw new Error("POSTGRES_BACKUP_PASSPHRASE_REQUIRED");
  if (sourceDatabaseTarget === undefined) parsePostgresProofConnection(sourceDatabaseUrl);
  else parsePgcfProofConnection(sourceDatabaseUrl, sourceDatabaseTarget);
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  // Open exclusively before reading customer data; a retry must never replace an earlier backup.
  const file = await open(archivePath, "wx", 0o600);
  let completed = false;
  let source;
  try {
    source = await openPostgresProofConnection(sourceDatabaseUrl, sourceDatabaseTarget);
    const bytes = await runPostgresCommand(
      "pg_dump",
      ["--format=custom", ...portableFlags, "--lock-wait-timeout=5000"],
      {
        ...source.environment,
        PGAPPNAME: "ohmyhost-platform-backup",
        PGOPTIONS: "-c default_transaction_read_only=on",
      },
      { binary: true, maximumBytes: MAX_ARCHIVE_BYTES },
    );
    if (bytes.byteLength < 5 || bytes.subarray(0, 5).toString("ascii") !== "PGDMP")
      throw new Error("POSTGRES_BACKUP_ARCHIVE_INVALID");
    const cipher = await encrypter.encrypt(bytes);
    if (cipher.byteLength > maximumCipherBytes)
      throw new Error("POSTGRES_BACKUP_ARCHIVE_TOO_LARGE");
    await file.writeFile(cipher);
    await file.sync();
    completed = true;
    return {
      format: "age-scrypt-pg-custom",
      bytes: cipher.byteLength,
      sha256: digest(cipher),
      createdAt: new Date().toISOString(),
    };
  } finally {
    try {
      await source?.close();
    } finally {
      await file.close();
      if (!completed) await unlink(archivePath);
    }
  }
}

/** Restore only an authenticated backup receipt into an empty, non-superuser destination. */
export async function restoreEncryptedPostgresBackup({
  targetDatabaseUrl,
  targetDatabaseTarget,
  archivePath,
  passphrase,
  sha256,
}) {
  if (typeof passphrase !== "string" || passphrase.trim().length === 0)
    throw new Error("POSTGRES_BACKUP_PASSPHRASE_REQUIRED");
  if (targetDatabaseTarget === undefined) parsePostgresProofConnection(targetDatabaseUrl);
  else parsePgcfProofConnection(targetDatabaseUrl, targetDatabaseTarget);
  const size = (await stat(archivePath)).size;
  if (size < 1 || size > maximumCipherBytes) throw new Error("POSTGRES_BACKUP_ARCHIVE_TOO_LARGE");
  const cipher = await readFile(archivePath);
  if (
    cipher.byteLength !== size ||
    !/^sha256:[a-f0-9]{64}$/u.test(sha256) ||
    digest(cipher) !== sha256
  )
    throw new Error("POSTGRES_BACKUP_CHECKSUM_MISMATCH");
  let bytes;
  try {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(passphrase);
    bytes = await decrypter.decrypt(cipher);
  } catch {
    throw new Error("POSTGRES_BACKUP_DECRYPTION_FAILED");
  }
  if (
    bytes.byteLength > MAX_ARCHIVE_BYTES ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "PGDMP"
  )
    throw new Error("POSTGRES_BACKUP_ARCHIVE_INVALID");
  const target = await openPostgresProofConnection(targetDatabaseUrl, targetDatabaseTarget);
  try {
    const environment = { ...target.environment, PGAPPNAME: "ohmyhost-platform-restore" };
    const role = await scalar(
      environment,
      "SELECT rolsuper::integer FROM pg_roles WHERE rolname=current_user",
    );
    if (role !== "0") throw new Error("POSTGRES_BACKUP_TARGET_SUPERUSER");
    const objects = await scalar(
      environment,
      `SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S','f')`,
    );
    if (objects !== "0") throw new Error("POSTGRES_BACKUP_TARGET_NOT_EMPTY");
    await runPostgresCommand(
      "pg_restore",
      ["--exit-on-error", "--single-transaction", ...portableFlags, "--dbname", ""],
      environment,
      { input: bytes },
    );
    return { restored: true, sha256 };
  } finally {
    await target.close();
  }
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
async function scalar(environment, sql) {
  return (
    await runPostgresCommand(
      "psql",
      ["--no-psqlrc", "--no-align", "--tuples-only", "--set=ON_ERROR_STOP=1", "--command", sql],
      environment,
    )
  ).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    const common = {
      archivePath: process.env.OHMYHOST_BACKUP_ARCHIVE,
      passphrase: process.env.OHMYHOST_BACKUP_PASSPHRASE,
    };
    let result;
    if (command === "create")
      result = await createEncryptedPostgresBackup({
        ...common,
        sourceDatabaseUrl: process.env.OHMYHOST_SOURCE_DATABASE_URL,
        sourceDatabaseTarget: process.env.OHMYHOST_SOURCE_DATABASE_TARGET,
      });
    else if (command === "restore")
      result = await restoreEncryptedPostgresBackup({
        ...common,
        targetDatabaseUrl: process.env.OHMYHOST_TARGET_DATABASE_URL,
        targetDatabaseTarget: process.env.OHMYHOST_TARGET_DATABASE_TARGET,
        sha256: process.env.OHMYHOST_BACKUP_SHA256,
      });
    else throw new Error("POSTGRES_BACKUP_COMMAND_INVALID");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof Error && /^POSTGRES_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "POSTGRES_BACKUP_FAILED";
    process.stderr.write(`${JSON.stringify({ code })}\n`);
    process.exitCode = 1;
  }
}
