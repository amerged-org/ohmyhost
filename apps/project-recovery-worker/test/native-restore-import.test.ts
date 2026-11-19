import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { parsePostgresProofConnection } from "../../../scripts/postgres-tools.mjs";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import {
  runNativeRestoreTransaction,
  splitNativeRestoreDumps,
  validateNativeRestoreDump,
} from "../src/native-restore-import.js";

const run = promisify(execFile);
it("imports a real pg_dump transactionally and rolls back if restore authority is lost", async () => {
  const db = await startTestPostgres();
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_fixture_database");
  try {
    const environmentId = "00000000000000000000000004",
      schema = `omh_auth_${environmentId.toLowerCase()}`,
      migrator = `omh_am_${environmentId.toLowerCase()}`;
    await db.pool.query(
      `CREATE ROLE ${migrator} LOGIN; CREATE SCHEMA ${schema}; GRANT USAGE,CREATE ON SCHEMA ${schema} TO ${migrator}; SET ROLE ${migrator}; CREATE TABLE ${schema}.users(id integer PRIMARY KEY, name text); INSERT INTO ${schema}.users VALUES (1,'snapshot'); RESET ROLE`,
    );
    const output = await run(
      "pg_dump",
      ["--format=plain", "--no-owner", "--no-privileges", `--schema=${schema}`, connectionString],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const sql = Buffer.from(output.stdout);
    validateNativeRestoreDump(sql);
    const frame = {
      environmentId,
      schemaName: schema,
      dumpOffset: 0,
      dumpBytes: sql.length,
      dumpSha256: createHash("sha256").update(sql).digest("hex"),
    };
    const [slice] = splitNativeRestoreDumps(sql, [frame]);
    if (!slice) throw new Error("missing fixture realm");
    const secondEnvironment = "00000000000000000000000005",
      secondSchema = `omh_auth_${secondEnvironment.toLowerCase()}`;
    await db.pool.query(
      `CREATE SCHEMA ${secondSchema}; CREATE TABLE ${secondSchema}.users(id integer PRIMARY KEY); INSERT INTO ${secondSchema}.users VALUES (2)`,
    );
    const second = Buffer.from(
      (
        await run(
          "pg_dump",
          [
            "--format=plain",
            "--no-owner",
            "--no-privileges",
            `--schema=${secondSchema}`,
            connectionString,
          ],
          { maxBuffer: 8 * 1024 * 1024 },
        )
      ).stdout,
    );
    const secondFrame = {
      environmentId: secondEnvironment,
      schemaName: secondSchema,
      dumpOffset: sql.length,
      dumpBytes: second.length,
      dumpSha256: createHash("sha256").update(second).digest("hex"),
    };
    const combined = Buffer.concat([sql, second]);
    expect(
      splitNativeRestoreDumps(combined, [frame, secondFrame]).map((item) => item.environmentId),
    ).toEqual([environmentId, secondEnvironment]);
    expect(() =>
      splitNativeRestoreDumps(combined, [frame, { ...secondFrame, dumpOffset: sql.length + 1 }]),
    ).toThrow();
    expect(() =>
      splitNativeRestoreDumps(sql, [{ ...frame, dumpSha256: "0".repeat(64) }]),
    ).toThrow();
    expect(() => validateNativeRestoreDump(Buffer.from("\\! echo bad\n"))).toThrow();
    const environment = parsePostgresProofConnection(connectionString).environment;
    const input = {
      environment: { ...environment, PGOPTIONS: "-c client_min_messages=warning" },
      sql,
      drops: `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
      signal: AbortSignal.timeout(60000),
      lockScope: {
        organizationId: "00000000000000000000000001",
        projectId: "00000000000000000000000002",
        databaseId: "a1234567890123456789",
      },
    };
    await db.pool.query(
      `SET ROLE ${migrator}; UPDATE ${schema}.users SET name='current'; RESET ROLE`,
    );
    await expect(
      runNativeRestoreTransaction({
        ...input,
        authorize: async () => {
          throw new Error("owner revoked");
        },
      }),
    ).rejects.toThrow();
    expect((await db.pool.query(`SELECT name FROM ${schema}.users`)).rows[0]?.name).toBe("current");
    // A real psql error after the lock closes the child before its ready marker;
    // the transaction must roll back and leave the current row untouched.
    await expect(
      runNativeRestoreTransaction({
        ...input,
        drops: `UPDATE ${schema}.users SET name='partial'; SELECT 1/0;`,
        authorize: async () => {},
      }),
    ).rejects.toThrow("native_restore_failed");
    expect((await db.pool.query(`SELECT name FROM ${schema}.users`)).rows[0]?.name).toBe("current");
    // A blocked database statement is terminated by the restore watchdog; the pending update rolls back.
    const nativeSetTimeout = globalThis.setTimeout;
    const watchdog = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        nativeSetTimeout(callback, delay === 900000 ? 300 : delay, ...args)) as typeof setTimeout);
    try {
      await expect(
        runNativeRestoreTransaction({
          ...input,
          drops: `UPDATE ${schema}.users SET name='waiting'; SELECT pg_sleep(2);`,
          authorize: async () => {},
        }),
      ).rejects.toThrow("native_restore_failed");
    } finally {
      watchdog.mockRestore();
    }
    expect((await db.pool.query(`SELECT name FROM ${schema}.users`)).rows[0]?.name).toBe("current");
    // A child that exits on SQL error while the producer is still writing must not commit a partial restore.
    await expect(
      runNativeRestoreTransaction({
        ...input,
        sql: Buffer.concat([Buffer.from("SELECT 1/0;\n"), Buffer.alloc(8 * 1024 * 1024, 32)]),
        drops: `UPDATE ${schema}.users SET name='partial';`,
        authorize: async () => {},
      }),
    ).rejects.toThrow("native_restore_failed");
    expect((await db.pool.query(`SELECT name FROM ${schema}.users`)).rows[0]?.name).toBe("current");
    await db.pool.query(
      `DROP SCHEMA ${schema} CASCADE; CREATE SCHEMA ${schema}; GRANT USAGE,CREATE ON SCHEMA ${schema} TO ${migrator}`,
    );
    await runNativeRestoreTransaction({
      ...input,
      environment: { ...environment, PGUSER: migrator },
      sql: slice.sql,
      drops: "",
      authorize: async () => {},
    });
    expect((await db.pool.query(`SELECT name FROM ${schema}.users`)).rows[0]?.name).toBe(
      "snapshot",
    );
    expect(
      (
        await db.pool.query(
          `SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='users'`,
          [schema],
        )
      ).rows[0]?.owner,
    ).toBe(migrator);
  } finally {
    await db.stop();
  }
}, 120000);

it("serializes a sent COMMIT against a new claim and rejects a stale waiter before mutation", async () => {
  const db = await startTestPostgres(),
    connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_fixture_database");
  const lockScope = {
    organizationId: "00000000000000000000000001",
    projectId: "00000000000000000000000002",
    databaseId: "a1234567890123456789",
  };
  const lockName = `ohmyho-native-restore/v1:${lockScope.organizationId}:${lockScope.projectId}:${lockScope.databaseId}`;
  const environment = parsePostgresProofConnection(connectionString).environment;
  const waitFor = async (check: () => Promise<boolean>) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("fixture_wait_timeout");
  };
  let blocker:
    | { query(text: string, values?: unknown[]): Promise<unknown>; release(): void }
    | undefined;
  try {
    await db.pool.query(
      `CREATE SCHEMA restore_lock_fixture; CREATE TABLE restore_lock_fixture.events(id integer PRIMARY KEY); CREATE FUNCTION restore_lock_fixture.delay_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER wait_on_commit AFTER INSERT ON restore_lock_fixture.events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.id=1) EXECUTE FUNCTION restore_lock_fixture.delay_commit()`,
    );
    let activeClaim = "old";
    const runFor = (claim: string, id: number) =>
      runNativeRestoreTransaction({
        environment: { ...environment, PGAPPNAME: `restore-${claim}` },
        lockScope,
        sql: Buffer.from(`INSERT INTO restore_lock_fixture.events VALUES (${id});\n`),
        drops: "",
        signal: AbortSignal.timeout(30000),
        authorize: async () => {
          if (activeClaim !== claim) throw new Error("stale claim");
        },
      });
    const old = runFor("old", 1);
    await waitFor(async () =>
      Boolean(
        (
          await db.pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='restore-old' AND wait_event='PgSleep') AS ready",
          )
        ).rows[0]?.ready,
      ),
    );
    activeClaim = "new";
    const next = runFor("new", 2);
    await waitFor(async () =>
      Boolean(
        (
          await db.pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='restore-new' AND l.locktype='advisory' AND NOT l.granted) AS waiting",
          )
        ).rows[0]?.waiting,
      ),
    );
    await old;
    await next;
    expect(
      (await db.pool.query("SELECT id FROM restore_lock_fixture.events ORDER BY id")).rows,
    ).toEqual([{ id: 1 }, { id: 2 }]);
    const held = await db.pool.connect();
    blocker = held;
    await held.query("BEGIN");
    await held.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockName]);
    activeClaim = "stale";
    const stale = runFor("stale", 3);
    const staleResult = stale.then(
      () => "unexpected",
      () => "rejected",
    );
    await waitFor(async () =>
      Boolean(
        (
          await db.pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='restore-stale' AND l.locktype='advisory' AND NOT l.granted) AS waiting",
          )
        ).rows[0]?.waiting,
      ),
    );
    activeClaim = "new";
    await held.query("COMMIT");
    held.release();
    blocker = undefined;
    expect(await staleResult).toBe("rejected");
    expect(
      (await db.pool.query("SELECT id FROM restore_lock_fixture.events ORDER BY id")).rows,
    ).toEqual([{ id: 1 }, { id: 2 }]);
  } finally {
    if (blocker) {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    await db.stop();
  }
}, 120000);

it("fails closed when the psql executable is missing before it can mutate the database", async () => {
  const previousPath = process.env["PATH"];
  process.env["PATH"] = "/nonexistent-ohmyho-restore-test";
  let authorized = false;
  try {
    await expect(
      runNativeRestoreTransaction({
        environment: {},
        sql: Buffer.from("SELECT 1;"),
        drops: "",
        signal: AbortSignal.timeout(5000),
        lockScope: {
          organizationId: "00000000000000000000000001",
          projectId: "00000000000000000000000002",
          databaseId: "a1234567890123456789",
        },
        authorize: async () => {
          authorized = true;
        },
      }),
    ).rejects.toThrow("native_restore_failed");
    expect(authorized).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  }
});
