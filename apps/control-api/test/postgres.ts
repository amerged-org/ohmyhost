import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runner } from "node-pg-migrate";
import { Client, Pool } from "pg";

const executeFile = promisify(execFile);
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/database/migrations",
);

export interface TestPostgres {
  readonly pool: Pool;
  migrate(direction: "up" | "down", count?: number | string): Promise<void>;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const explicitUrl = process.env["TEST_DATABASE_URL"];
  if (explicitUrl !== undefined && explicitUrl.trim() !== "") {
    const databaseName = decodeURIComponent(new URL(explicitUrl).pathname.slice(1));
    if (!databaseName.endsWith("_test")) {
      throw new Error("TEST_DATABASE_URL database name must end with _test");
    }
    const schema = schemaName();
    let pool: Pool | undefined;
    try {
      await createSchema(explicitUrl, schema);
      pool = scopedPool(explicitUrl, schema);
      await migrate(explicitUrl, schema, "up");
      const runningPool = pool;
      return {
        pool: runningPool,
        migrate: (direction, count) => migrate(explicitUrl, schema, direction, count),
        stop: () => cleanupTestPostgres(runningPool, explicitUrl, schema),
      };
    } catch (error) {
      const cleanup = await settleCleanup([
        () => pool?.end() ?? Promise.resolve(),
        () => dropSchema(explicitUrl, schema),
      ]);
      throw cleanup.length === 0
        ? error
        : new AggregateError([error, ...cleanup], "Test PostgreSQL setup and cleanup failed", {
            cause: error,
          });
    }
  }

  const directory = await mkdtemp(resolve(tmpdir(), "ohmyhost-control-api-postgres-"));
  const dataDirectory = resolve(directory, "data");
  let started = false;
  let pool: Pool | undefined;
  let connectionString: string | undefined;
  let schema: string | undefined;
  try {
    const port = await availablePort();
    connectionString = `postgresql://postgres@127.0.0.1:${String(port)}/postgres`;
    schema = schemaName();
    // The same locale as the Neon databases this schema runs on (PostgreSQL builtin provider, C.UTF-8): regex
    // classes such as [[:space:]] are Unicode there on every OS, while the libc default differs per host
    // (macOS treats U+00A0 as space, glibc does not).
    await executeFile("initdb", [
      "-D",
      dataDirectory,
      "-A",
      "trust",
      "-U",
      "postgres",
      "-E",
      "UTF8",
      "--locale-provider=builtin",
      "--locale=C.UTF-8",
    ]);
    await executeFile("pg_ctl", [
      "-D",
      dataDirectory,
      "-l",
      resolve(directory, "postgres.log"),
      "-o",
      `-F -p ${String(port)} -h 127.0.0.1 -k ''`,
      "-w",
      "start",
    ]);
    started = true;
    await createSchema(connectionString, schema);
    pool = scopedPool(connectionString, schema);
    await migrate(connectionString, schema, "up");
    const runningPool = pool;
    const runningConnectionString = connectionString;
    const runningSchema = schema;
    return {
      pool: runningPool,
      migrate: (direction, count) =>
        migrate(runningConnectionString, runningSchema, direction, count),
      async stop() {
        const failures = await settleCleanup([
          () => endPool(runningPool),
          () => dropSchema(runningConnectionString, runningSchema),
          () =>
            executeFile("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]).then(
              () => undefined,
            ),
          () => rm(directory, { recursive: true, force: true }),
        ]);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Temporary PostgreSQL cleanup failed");
        }
      },
    };
  } catch (error) {
    const cleanup = await settleCleanup([
      () => (pool === undefined ? Promise.resolve() : endPool(pool)),
      () =>
        connectionString === undefined || schema === undefined
          ? Promise.resolve()
          : dropSchema(connectionString, schema),
      () =>
        started
          ? executeFile("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]).then(
              () => undefined,
            )
          : Promise.resolve(),
      () => rm(directory, { recursive: true, force: true }),
    ]);
    const failure = new Error("Control API contracts require a real temporary PostgreSQL", {
      cause: error,
    });
    throw cleanup.length === 0
      ? failure
      : new AggregateError([failure, ...cleanup], "PostgreSQL setup and cleanup failed", {
          cause: error,
        });
  }
}

async function cleanupTestPostgres(
  pool: Pool,
  connectionString: string,
  schema: string,
): Promise<void> {
  const failures = await settleCleanup([
    () => pool.end(),
    () => dropSchema(connectionString, schema),
  ]);
  if (failures.length > 0) throw new AggregateError(failures, "Test PostgreSQL cleanup failed");
}

/**
 * pg-pool's end() resolves once its sessions are detached, before their sockets close. A fast
 * shutdown right after it can reach a backend that has not yet read its Terminate message, which
 * answers with 57P01 on a pool that no longer listens (CI 36101366109). Each session reports
 * "remove" only after its own connection closed, so this resolves once all of them are gone.
 */
async function endPool(pool: Pool): Promise<void> {
  const open = pool.totalCount;
  const removed = new Set<unknown>();
  const closed = new Promise<void>((done) => {
    if (open === 0) done();
    pool.on("remove", (client) => {
      removed.add(client);
      if (removed.size >= open) done();
    });
  });
  await pool.end();
  await closed;
}

async function settleCleanup(actions: readonly (() => Promise<void>)[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function scopedPool(connectionString: string, schema: string): Pool {
  return new Pool({ connectionString, max: 8, options: `-c search_path=${schema}` });
}

/**
 * Rolls back through the named migration, so a test that proves one migration's downgrade
 * behaviour keeps working when later migrations are added.
 */
export async function migrationsThrough(name: string): Promise<number> {
  const files = (await readdir(migrationsDirectory))
    .filter((entry) => entry.endsWith(".mjs"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const index = files.findIndex((entry) => entry.startsWith(name));
  if (index < 0) throw new Error(`Unknown migration ${name}`);
  return files.length - index;
}

async function migrate(
  connectionString: string,
  schema: string,
  direction: "up" | "down",
  count?: number | string,
): Promise<void> {
  await runner({
    databaseUrl: connectionString,
    dir: migrationsDirectory,
    direction,
    ...(count === undefined ? {} : typeof count === "string" ? { file: count } : { count }),
    migrationsTable: "control_db_migrations",
    schema,
    migrationsSchema: schema,
    log: () => undefined,
  });
}

async function createSchema(connectionString: string, schema: string): Promise<void> {
  await adminStatement(connectionString, `CREATE SCHEMA ${quoteIdentifier(schema)}`);
}

async function dropSchema(connectionString: string, schema: string): Promise<void> {
  await adminStatement(
    connectionString,
    `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
  );
}

/** One statement on its own session, which has closed when this resolves (see endPool). */
async function adminStatement(connectionString: string, statement: string): Promise<void> {
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(statement);
  } finally {
    await admin.end();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaName(): string {
  return `ohmyhost_test_${randomUUID().replaceAll("-", "")}`;
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a PostgreSQL test port"));
        return;
      }
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
}
