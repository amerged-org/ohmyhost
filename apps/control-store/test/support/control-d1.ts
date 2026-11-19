import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

import type { D1Database } from "../../src/d1-types.js";
import { bucketOf, SharedCoreRouter } from "../../src/router.js";
import { splitStatements } from "./sql.js";
import { coreBootstrapWorker, initializeCoreFixture } from "./core-bootstrap.js";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const REPOSITORY = fileURLToPath(new URL("../../../../", import.meta.url));

export type MigrationKind = "core" | "directory" | "shard";

export interface TestControl {
  /** The shared-core authority: one real local D1 database migrated with `migrations/core`. */
  readonly core: D1Database;
  /** One Core database plus an explicit local-only Native launch policy for these fixtures. */
  readonly bindings: {
    readonly CONTROL_CORE: D1Database;
    readonly CONTROL_NATIVE_AUTH_LAUNCH_POLICY?: string;
  };
  /** The Directory tables live in the core database. */
  readonly directory: D1Database;
  /**
   * Compatibility aliases of the old organization-shard test vocabulary. Every alias IS the one core database: the
   * production store has no second authority, so tests cannot observe a shard that differs from the core.
   */
  readonly shards: Readonly<Record<string, D1Database>>;
  dispose(): Promise<void>;
}

export function migrationFiles(kind: MigrationKind): { name: string; sql: string }[] {
  const dir = new URL(`${kind}/`, MIGRATIONS);
  // The shared checkout may retain explicitly ignored work from parked branches. Such files
  // are not part of this candidate's schema. Include every tracked migration and every new,
  // non-ignored migration, using the same source boundary as the verification runner.
  return execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      `apps/control-store/migrations/${kind}/`,
    ],
    { cwd: REPOSITORY, encoding: "utf8" },
  )
    .split("\0")
    .map((path) => path.slice(path.lastIndexOf("/") + 1))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
}

/** Applies every migration of one kind statement by statement, the way D1 itself executes them. */
export async function migrate(db: D1Database, kind: MigrationKind): Promise<void> {
  for (const file of migrationFiles(kind)) {
    // one batch per file: a migration file is one transaction, and one round trip instead of hundreds
    await db.batch(splitStatements(file.sql).map((statement) => db.prepare(statement)));
  }
}

/**
 * The `credit_account` table of migration 0600, for a fixture that deliberately runs the current store over an older schema:
 * every organization the store creates has its credit account in the same batch.
 */
export async function createCreditAccountTable(db: D1Database): Promise<void> {
  const file = migrationFiles("core").find((candidate) => candidate.name.startsWith("0600_"));
  const text = splitStatements(file?.sql ?? "").find((statement) =>
    /CREATE TABLE credit_account\s*\(/u.test(statement),
  );
  if (text === undefined) throw new Error("the credit account migration is missing");
  // the statement carries the comment lines that precede it in the file
  await db.prepare(text.slice(text.indexOf("CREATE TABLE credit_account"))).run();
}

/** Explicit LOCAL FIXTURE qualification; never called by production migrations, operator conversion or a Worker. */
export async function activateTestCore(core: D1Database): Promise<void> {
  await core
    .prepare(
      "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,qualification_sha256,runtime_schema_sha256) VALUES(1,'00000000-0000-4000-8000-000000000001','2026-01-01T00:00:00.000000Z',unhex(?),unhex(?))",
    )
    .bind("00".repeat(32), "11".repeat(32))
    .run();
}

/**
 * A real local D1 database (workerd's engine through Miniflare) migrated with the checked-in shared-core SQL. `aliases`
 * only sizes the legacy `shards` view of the same database, for tests written in the old shard vocabulary.
 */
export async function createTestControl(
  aliases = 2,
  options: { readonly activated?: boolean } = {},
): Promise<TestControl> {
  const miniflare = new Miniflare({
    modules: true,
    script: coreBootstrapWorker,
    d1Databases: { CONTROL_CORE: "core" },
  });
  // Import-boundary and converter fixtures opt out until their exact comparisons have completed.
  const core = await initializeCoreFixture(
    miniflare,
    () => migrationFiles("core"),
    options.activated === false ? undefined : activateTestCore,
  );
  return {
    core,
    bindings: {
      CONTROL_CORE: core,
      CONTROL_NATIVE_AUTH_LAUNCH_POLICY: '{"mode":"password-general-availability"}',
    },
    directory: core,
    shards: Object.fromEntries(
      Array.from({ length: aliases }, (_, index) => [shardBinding(index), core]),
    ),
    dispose: () => miniflare.dispose(),
  };
}

export function shardBinding(index: number): string {
  return `CONTROL_SHARD_${String(index).padStart(4, "0")}`;
}

/**
 * The router of a test over the core. `shards` is the old shard-vocabulary map; a test that swaps an alias for a
 * wrapped database (lost responses, a racing writer) swaps the core itself, because there is only one authority;
 * when several aliases are swapped, the first by binding name is the core.
 */
export function coreRouter(
  control: TestControl,
  shards: Readonly<Record<string, D1Database>> = control.shards,
): SharedCoreRouter {
  const swapped = Object.entries(shards)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, db]) => db)
    .find((db) => db !== control.core);
  return new SharedCoreRouter(swapped ?? control.core);
}

/** Crockford base32 ULID-shaped organization ids that land in a chosen bucket parity, for routing tests. */
export async function organizationIdWithShard(
  shardCount: number,
  shardId: number,
  seed: number,
): Promise<string> {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  for (let counter = seed; ; counter += 1) {
    let rest = counter;
    let tail = "";
    for (let position = 0; position < 25; position += 1) {
      tail = alphabet[rest % 32] + tail;
      rest = Math.floor(rest / 32);
    }
    const id = `0${tail}`;
    if ((await bucketOf(id)) % shardCount === shardId) return id;
  }
}

/** Failure injection at the D1 boundary: the batch commits, then the response is lost, `times` times. */
export function losingResponses(db: D1Database, times: number): D1Database {
  let remaining = times;
  return {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      const results = await db.batch(statements);
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("Network connection lost");
      }
      return results;
    },
  };
}

export function shardOf(control: TestControl, index: number): D1Database {
  const db = control.shards[shardBinding(index)];
  if (db === undefined) throw new Error(`test shard ${index} does not exist`);
  return db;
}

/** Like `losingResponses`, but the response of the `nth` batch call (1-based) is the one that is lost. */
export function losingNthResponse(db: D1Database, nth: number): D1Database {
  let calls = 0;
  return {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      calls += 1;
      const results = await db.batch(statements);
      if (calls === nth) throw new Error("Network connection lost");
      return results;
    },
  };
}
