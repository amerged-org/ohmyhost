import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { startBridge, type Bridge } from "@ohmyhost/postgres-bridge";
import {
  parsePostgresProofConnection,
  parsePgcfProofConnection,
  runPostgresCommand,
  MAX_ARCHIVE_BYTES,
} from "../../../scripts/postgres-tools.mjs";
import {
  createProjectRecoveryArchive,
  createProjectRecoveryArchiveV2,
  parseRecoveryScope,
  parseRecoveryScopeV2,
  resourceKey,
  validateRecoveryPassphrase,
  RecoveryArchiveError,
  type RecoveryScope,
  type RecoveryReceipt,
  type RecoveryReceiptV2,
  type RecoveryScopeV2,
  type RecoveryResource,
} from "./index.js";

/** SQLSTATEs that mean a sleeping database is still waking; every other failure is final. */
const WAKE_REFUSAL_STATES: ReadonlySet<string> = new Set(["57P03", "08006", "53300"]);
const WAKE_RETRY_BUDGET_MS = 90_000;

export interface WakeRetryClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface WakeRetryConnection {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
}

const systemClock: WakeRetryClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};

/**
 * Connects through a fresh connection per attempt. Wake refusals are retried with 1, 2, 4 and then
 * 8 second delays until the next delay would pass the budget (90 seconds unless the caller grants a
 * longer one); the failed connection is handed to `discard` first. Any other error is rethrown at once.
 */
export async function connectWithWakeRetry<T extends WakeRetryConnection>(
  open: () => T,
  discard: (failed: T) => Promise<void>,
  options: {
    readonly signal: AbortSignal;
    readonly clock?: WakeRetryClock;
    readonly budgetMilliseconds?: number;
  },
): Promise<T> {
  const clock = options.clock ?? systemClock;
  const budget = options.budgetMilliseconds ?? WAKE_RETRY_BUDGET_MS;
  const started = clock.now();
  for (let attempt = 0; ; attempt++) {
    options.signal.throwIfAborted();
    const connection = open();
    try {
      await connection.connect();
      return connection;
    } catch (error) {
      await discard(connection);
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      if (!isWakeRefusal(error) || clock.now() - started + delay > budget) throw error;
      await clock.sleep(delay, options.signal);
    }
  }
}

function isWakeRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && WAKE_REFUSAL_STATES.has(error.code);
}

export interface RecoveryDatabaseConnection {
  readonly connectionUrl: string;
  readonly transport?: {
    readonly provider: "pgcf";
    readonly websocketUrl: string;
    readonly databaseId: string;
    readonly role: string;
  };
  /** A longer wake budget granted by the reader for a database that waits for an explicit resume. */
  readonly wakeBudgetMilliseconds?: number;
}

/** Invoke inside the Control project-deletion fence; native tools use private libpq environment only. */
export async function captureProjectRecoveryArchive(input: {
  readonly scope: RecoveryScope;
  readonly databases: readonly (RecoveryDatabaseConnection & { readonly environmentId: string })[];
  readonly passphrase: string;
  readonly archivePath: string;
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
}): Promise<RecoveryReceipt> {
  const scope = parseRecoveryScope(input.scope);
  validateRecoveryPassphrase(input.passphrase);
  if (
    input.databases.length !== scope.databaseEnvironments.length ||
    new Set(input.databases.map((database) => database.environmentId)).size !==
      input.databases.length ||
    input.databases.some((database) => !scope.databaseEnvironments.includes(database.environmentId))
  )
    throw new RecoveryArchiveError("recovery_input_invalid");
  return captureDatabases(
    input,
    input.databases.map((database) => ({ ...database, key: database.environmentId })),
    async (files, directory, capturedAt, signal) =>
      createProjectRecoveryArchive({
        ...input,
        scope,
        files: files.map((file) => ({
          namespaceId: file.key,
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
        })),
        inputDirectory: directory,
        capturedAt,
        signal,
      }),
  );
}

/** Capture explicitly typed project resources under the same sealed recovery fence. */
export async function captureProjectRecoveryArchiveV2(input: {
  readonly scope: RecoveryScopeV2;
  readonly databases: readonly (RecoveryDatabaseConnection & {
    readonly resource: RecoveryResource;
  })[];
  readonly passphrase: string;
  readonly archivePath: string;
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
}): Promise<RecoveryReceiptV2> {
  const scope = parseRecoveryScopeV2(input.scope);
  if (scope.nativeManifest?.realms.some((realm) => realm.dumpOffset !== undefined))
    throw new RecoveryArchiveError("recovery_input_invalid");
  const key = (resource: RecoveryResource) => resourceKey(resource).replace(":", "-");
  const resources = new Map(scope.resources.map((resource) => [key(resource), resource]));
  const databases = input.databases.map((database) => ({
    ...database,
    key: key(database.resource),
    ...(database.resource.kind === "native_auth_database"
      ? { expectedManifest: scope.nativeManifest }
      : {}),
  }));
  if (
    databases.some(
      (database) =>
        database.resource.kind === "native_auth_database" &&
        (database.transport?.provider !== "pgcf" ||
          database.transport.databaseId !== database.resource.databaseId),
    )
  )
    throw new RecoveryArchiveError("recovery_input_invalid");
  if (
    databases.length !== resources.size ||
    new Set(databases.map((database) => database.key)).size !== databases.length ||
    databases.some((database) => !resources.has(database.key))
  )
    throw new RecoveryArchiveError("recovery_input_invalid");
  return captureDatabases(
    input,
    databases,
    async (files, directory, capturedAt, signal, capturedManifest) =>
      createProjectRecoveryArchiveV2({
        ...input,
        scope: {
          ...scope,
          ...(capturedManifest === undefined ? {} : { nativeManifest: capturedManifest }),
        },
        files: files.map((file) => {
          const resource = resources.get(file.key);
          if (resource === undefined) throw new RecoveryArchiveError("recovery_input_invalid");
          return {
            resource,
            path: file.path,
            bytes: file.bytes,
            sha256: file.sha256,
          };
        }),
        inputDirectory: directory,
        capturedAt,
        signal,
      }),
  );
}

async function captureDatabases<T extends RecoveryReceipt | RecoveryReceiptV2>(
  input: {
    readonly passphrase: string;
    readonly archivePath: string;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  },
  databases: readonly (RecoveryDatabaseConnection & {
    readonly key: string;
    readonly expectedManifest?: RecoveryScopeV2["nativeManifest"];
  })[],
  archive: (
    files: readonly {
      readonly key: string;
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
    }[],
    directory: string,
    capturedAt: string,
    signal: AbortSignal,
    manifest?: RecoveryScopeV2["nativeManifest"],
  ) => Promise<T>,
): Promise<T> {
  validateRecoveryPassphrase(input.passphrase);
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    input.maximumBytes > MAX_ARCHIVE_BYTES
  )
    throw new RecoveryArchiveError("recovery_input_invalid");
  const failure = new AbortController();
  const signal = AbortSignal.any([input.signal, failure.signal]);
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "omh-project-capture-"));
  const clients: Client[] = [];
  const discardFailedClient = async (failed: Client) => {
    const index = clients.indexOf(failed);
    if (index !== -1) clients.splice(index, 1);
    await Promise.allSettled([failed.end()]);
  };
  const bridges: Bridge[] = [];
  const snapshots: {
    key: string;
    snapshot: string;
    environment: Readonly<Record<string, string>>;
    expectedManifest?: RecoveryScopeV2["nativeManifest"];
  }[] = [];
  const capturedAt = new Date().toISOString();
  let capturedManifest: RecoveryScopeV2["nativeManifest"];
  let result: T | RecoveryArchiveError;
  try {
    for (const database of databases) {
      signal.throwIfAborted();
      const transport = database.transport;
      let connection: ReturnType<typeof parsePostgresProofConnection>;
      try {
        connection =
          transport === undefined
            ? parsePostgresProofConnection(database.connectionUrl)
            : parsePgcfProofConnection(database.connectionUrl, {
                provider: transport.provider,
                host: new URL(transport.websocketUrl).hostname,
                databaseId: transport.databaseId,
                role: transport.role,
              });
      } catch (error) {
        if (transport !== undefined)
          throw new RecoveryArchiveError("recovery_database_unavailable");
        throw error;
      }
      if (
        transport !== undefined &&
        (transport.provider !== "pgcf" ||
          transport.websocketUrl !== `wss://${connection.identity.host}/` ||
          transport.databaseId !== connection.identity.database ||
          transport.role !== connection.environment["PGUSER"])
      )
        throw new RecoveryArchiveError("recovery_database_unavailable");
      const bridge =
        transport === undefined
          ? null
          : await startBridge({
              endpoint: transport.websocketUrl,
              database: transport.databaseId,
              user: transport.role,
              port: 0,
            });
      if (bridge) bridges.push(bridge);
      const local =
        bridge !== null || ["localhost", "127.0.0.1", "::1"].includes(connection.identity.host);
      const env: Readonly<Record<string, string>> = {
        ...connection.environment,
        ...(bridge
          ? {
              PGHOST: bridge.host,
              PGPORT: String(bridge.port),
              PGSSLMODE: "disable",
              PGCHANNELBINDING: "disable",
              PGGSSENCMODE: "disable",
              PGCONNECT_TIMEOUT: "75",
            }
          : !local
            ? { PGSSLMODE: "verify-full", PGSSLROOTCERT: "system" }
            : {}),
      };
      const open = (): Client => {
        const created = new Client({
          host: env["PGHOST"],
          port: Number(env["PGPORT"]),
          database: env["PGDATABASE"],
          user: env["PGUSER"],
          password: env["PGPASSWORD"],
          connectionTimeoutMillis: bridge ? 75_000 : 10_000,
          query_timeout: 10_000,
          application_name: "ohmyhost-project-recovery",
          ssl: local ? false : { rejectUnauthorized: true },
        });
        created.on("error", () =>
          failure.abort(new RecoveryArchiveError("recovery_database_unavailable")),
        );
        clients.push(created);
        return created;
      };
      let client: Client;
      try {
        client = await connectWithWakeRetry(open, discardFailedClient, {
          signal,
          budgetMilliseconds: database.wakeBudgetMilliseconds ?? WAKE_RETRY_BUDGET_MS,
        });
      } catch (error) {
        if (error instanceof RecoveryArchiveError) throw error;
        throw new RecoveryArchiveError("recovery_database_unavailable");
      }
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        if (database.expectedManifest) {
          const manifest = database.expectedManifest;
          const schemas = await client.query<{ name: string }>(
            "SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'omh\\_auth\\_%' ESCAPE '\\' ORDER BY nspname",
          );
          const available = new Set(schemas.rows.map((row) => row.name));
          // The authorized manifest may omit retired or unavailable Dev. Only its exact schemas are dumped.
          if (manifest.realms.some((realm) => !available.has(realm.schemaName)))
            throw new RecoveryArchiveError("recovery_scope_mismatch");
          for (const realm of manifest.realms) {
            const policy = await client.query<{
              revocation_epoch: string;
              configuration_revision: string;
            }>(
              `SELECT revocation_epoch,configuration_revision FROM ${realm.schemaName}.native_realm_policy WHERE singleton=true`,
            );
            if (
              policy.rows.length !== 1 ||
              Number(policy.rows[0]?.revocation_epoch) !== realm.revocationEpoch ||
              Number(policy.rows[0]?.configuration_revision) !== realm.configurationRevision
            )
              throw new RecoveryArchiveError("recovery_scope_mismatch");
            const migration = await client.query<{ version: number; digest: string }>(
              `SELECT version,digest FROM ${realm.schemaName}.omh_native_migrations WHERE version=$1`,
              [manifest.migrationVersion],
            );
            if (
              migration.rows.length !== 1 ||
              migration.rows[0]?.digest !== manifest.migrationDigest
            )
              throw new RecoveryArchiveError("recovery_scope_mismatch");
          }
        }
        const result = await client.query<{ snapshot: string; superuser: boolean }>(
          "SELECT pg_export_snapshot() snapshot,rolsuper superuser FROM pg_roles WHERE rolname=current_user",
        );
        const row = result.rows[0];
        if (row?.superuser !== false || !/^[A-F0-9]{8}-[A-F0-9]{8}-[0-9]+$/u.test(row.snapshot))
          throw new RecoveryArchiveError("recovery_database_unavailable");
        snapshots.push({
          key: database.key,
          snapshot: row.snapshot,
          environment: env,
          ...(database.expectedManifest === undefined
            ? {}
            : { expectedManifest: database.expectedManifest }),
        });
      } catch (error) {
        if (error instanceof RecoveryArchiveError) throw error;
        throw new RecoveryArchiveError("recovery_database_unavailable");
      }
    }
    const files: { key: string; path: string; bytes: number; sha256: string }[] = [];
    let totalBytes = 0;
    for (const snapshot of snapshots) {
      signal.throwIfAborted();
      const dumpSchema = async (schemaName?: string) =>
        runPostgresCommand(
          "pg_dump",
          [
            "--format=plain",
            "--no-owner",
            "--no-privileges",
            "--no-tablespaces",
            "--no-publications",
            "--no-subscriptions",
            "--no-security-labels",
            // The platform's own schema (the data-event outbox) belongs to the database platform: the
            // tenant role cannot read it, and a restore must not bring it back.
            "--exclude-schema=pgcf",
            ...(schemaName === undefined
              ? []
              : [
                  `--schema=${schemaName}`,
                  `--exclude-table=${schemaName}.native_preview_realm_policy`,
                  `--exclude-table=${schemaName}.native_preview_policy_migrations`,
                ]),
            "--lock-wait-timeout=5000",
            `--snapshot=${snapshot.snapshot}`,
          ],
          {
            ...snapshot.environment,
            PGAPPNAME: "ohmyhost-project-recovery",
            PGOPTIONS: "-c default_transaction_read_only=on",
          },
          { binary: true, maximumBytes: input.maximumBytes, signal },
        );
      let dump: Buffer;
      if (snapshot.expectedManifest) {
        const slices: Buffer[] = [];
        let offset = 0;
        const realms = [];
        for (const realm of snapshot.expectedManifest.realms) {
          const part = await dumpSchema(realm.schemaName);
          if (offset + part.length > input.maximumBytes)
            throw new RecoveryArchiveError("recovery_archive_too_large");
          realms.push({
            environmentId: realm.environmentId,
            schemaName: realm.schemaName,
            revocationEpoch: realm.revocationEpoch,
            configurationRevision: realm.configurationRevision,
            dumpOffset: offset,
            dumpBytes: part.length,
            dumpSha256: digest(part).slice(7),
          });
          slices.push(part);
          offset += part.length;
        }
        dump = Buffer.concat(slices);
        capturedManifest = { ...snapshot.expectedManifest, realms };
      } else dump = await dumpSchema();
      totalBytes += dump.length;
      if (totalBytes > input.maximumBytes)
        throw new RecoveryArchiveError("recovery_archive_too_large");
      const path = `${snapshot.key}.sql`;
      await writeFile(join(directory, path), dump, { mode: 0o600, flag: "wx" });
      files.push({
        key: snapshot.key,
        path,
        bytes: dump.length,
        sha256: digest(dump),
      });
    }
    signal.throwIfAborted();
    result = await archive(files, directory, capturedAt, signal, capturedManifest);
  } catch (error) {
    result = failure.signal.aborted
      ? new RecoveryArchiveError("recovery_database_unavailable")
      : error instanceof RecoveryArchiveError
        ? error
        : new RecoveryArchiveError("recovery_capture_failed");
  } finally {
    const closed = await Promise.allSettled(clients.map((client) => client.end()));
    const bridgeClosed = await Promise.allSettled(bridges.map((bridge) => bridge.close()));
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      result = new RecoveryArchiveError("recovery_capture_failed");
    }
    if ([...closed, ...bridgeClosed].some((entry) => entry.status === "rejected"))
      result = new RecoveryArchiveError("recovery_capture_failed");
  }
  if (result instanceof RecoveryArchiveError) throw result;
  return result;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
