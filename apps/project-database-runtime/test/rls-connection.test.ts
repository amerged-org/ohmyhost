import { Client, Pool, type ClientConfig } from "pg";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import {
  connectRlsProjectDatabase,
  ProjectDatabaseInputError,
  ProjectDatabaseResultError,
  ProjectDatabaseRlsError,
  ProjectDatabaseBusyError,
} from "../src/service.js";
import { pooledClientDependencies } from "../src/connection-pool.js";

it("pins claims to an RLS transaction and never commits after a caught failure or an escape attempt", async () => {
  const db = await startTestPostgres();
  const uri = new URL(db.pool.options.connectionString as string);
  uri.searchParams.set("options", String(db.pool.options.options));
  const dependencies = { createClient: (configuration: ClientConfig) => new Client(configuration) };
  const open = (identity: unknown = { subject: "alice", claims: { team: "green" } }) =>
    connectRlsProjectDatabase(uri.href, dependencies, 8364, identity, async () => undefined);
  try {
    await db.pool.query("CREATE TABLE rls_scope_writes(value int)");
    const first = await open();
    expect(
      await first.query({
        text: "SELECT current_setting('ohmyhost.request_claims')::jsonb AS claims",
        values: [],
      }),
    ).toMatchObject({ rows: [{ claims: { sub: "alice", role: "authenticated", team: "green" } }] });
    await first.query({ text: "INSERT INTO rls_scope_writes VALUES (1)", values: [] });
    await first.commit();
    await first.close();
    const anon = await open(null);
    expect(
      await anon.query({
        text: "SELECT current_setting('ohmyhost.request_claims')::jsonb AS claims",
        values: [],
      }),
    ).toMatchObject({ rows: [{ claims: { sub: null, role: "anon" } }] });
    await anon.close();
    for (const text of [
      "BEGIN",
      "START TRANSACTION",
      "COMMIT",
      "END",
      "ROLLBACK",
      "ABORT",
      "SAVEPOINT x",
      "RELEASE x",
      "PREPARE x AS SELECT 1",
      "SET ROLE postgres",
      "RESET ALL",
      "DISCARD ALL",
      "CALL escape()",
      "DO $$ BEGIN COMMIT; END $$",
      "/* nested /* comment */ */ COMMIT",
      ";COMMIT",
    ]) {
      const scope = await open();
      await scope.query({ text: "INSERT INTO rls_scope_writes VALUES (2)", values: [] });
      await expect(scope.query({ text, values: [] })).rejects.toBeInstanceOf(
        ProjectDatabaseInputError,
      );
      await expect(scope.commit()).rejects.toBeInstanceOf(ProjectDatabaseRlsError);
      await scope.close();
    }
    for (const text of ["SELECT 1; COMMIT", "SELECT 1 / 0", "SELECT * FROM missing_rls_table"]) {
      const scope = await open();
      await scope.query({ text: "INSERT INTO rls_scope_writes VALUES (3)", values: [] });
      await expect(scope.query({ text, values: [] })).rejects.toBeDefined();
      await expect(scope.commit()).rejects.toBeInstanceOf(ProjectDatabaseRlsError);
    }
    const oversized = await open();
    await oversized.query({ text: "INSERT INTO rls_scope_writes VALUES (4)", values: [] });
    await expect(
      oversized.query({
        text: "INSERT INTO rls_scope_writes SELECT generate_series(1,1001) RETURNING value",
        values: [],
      }),
    ).rejects.toBeInstanceOf(ProjectDatabaseResultError);
    await expect(oversized.commit()).rejects.toBeInstanceOf(ProjectDatabaseRlsError);
    const malformed = await open();
    await malformed.query({ text: "INSERT INTO rls_scope_writes VALUES (5)", values: [] });
    await expect(
      malformed.query({ text: "SELECT 1", values: [], extra: true }),
    ).rejects.toBeInstanceOf(ProjectDatabaseInputError);
    await expect(malformed.commit()).rejects.toBeInstanceOf(ProjectDatabaseRlsError);
    const closed = await open();
    await closed.query({ text: "INSERT INTO rls_scope_writes VALUES (6)", values: [] });
    await closed.close();
    await expect(closed.commit()).rejects.toBeInstanceOf(ProjectDatabaseRlsError);
    expect((await db.pool.query("SELECT value FROM rls_scope_writes")).rows).toEqual([
      { value: 1 },
    ]);
    await expect(open({ subject: "alice", claims: { role: "admin" } })).rejects.toBeDefined();
  } finally {
    await db.stop();
  }
}, 60_000);

it("serializes RLS work, rechecks authority, bounds slots and lifetime, and makes a lost commit non-retryable", async () => {
  const db = await startTestPostgres();
  const uri = new URL(db.pool.options.connectionString as string);
  uri.searchParams.set("options", String(db.pool.options.options));
  const direct = { createClient: (configuration: ClientConfig) => new Client(configuration) };
  const identity = { subject: "alice" };
  const authorize = async () => undefined;
  const pool = new Pool({ connectionString: uri.href, max: 2 });
  const pooled = pooledClientDependencies(pool);
  try {
    await db.pool.query("CREATE TABLE rls_bounded_writes(value int)");
    const first = await connectRlsProjectDatabase(uri.href, direct, 8365, identity, authorize);
    const second = await connectRlsProjectDatabase(uri.href, direct, 8365, identity, authorize);
    await expect(
      connectRlsProjectDatabase(uri.href, direct, 8365, identity, authorize),
    ).rejects.toBeInstanceOf(ProjectDatabaseBusyError);
    const separate = await connectRlsProjectDatabase(uri.href, direct, 8366, identity, authorize);
    await separate.close();
    await first.close();
    await second.close();

    const serial = await connectRlsProjectDatabase(uri.href, pooled, 8365, identity, authorize);
    const writes = [
      serial.query({ text: "SELECT pg_sleep(0.02)", values: [] }),
      serial.query({ text: "INSERT INTO rls_bounded_writes VALUES(1)", values: [] }),
      serial.commit(),
    ];
    await Promise.all(writes);
    const clean = await pool.query(
      "SELECT NULLIF(current_setting('ohmyhost.request_claims', true), '') AS claims",
    );
    expect(clean.rows).toEqual([{ claims: null }]);

    let connectedAt = 0;
    const coldStart = await connectRlsProjectDatabase(
      uri.href,
      {
        createClient(configuration) {
          const client = pooled.createClient(configuration);
          return {
            ...client,
            async connect() {
              await client.connect();
              connectedAt = 6_000;
            },
          };
        },
      },
      8365,
      identity,
      authorize,
      () => connectedAt,
    );
    await expect(coldStart.query({ text: "SELECT 1", values: [] })).resolves.toMatchObject({
      rowCount: 1,
    });
    await coldStart.commit();

    let authorized = true;
    const reauthorize = async () => {
      if (!authorized) throw new Error("private scope revoked");
    };
    const revoked = await connectRlsProjectDatabase(uri.href, pooled, 8365, identity, reauthorize);
    await revoked.query({ text: "INSERT INTO rls_bounded_writes VALUES(2)", values: [] });
    authorized = false;
    await expect(revoked.commit()).rejects.toMatchObject({
      code: "database_rls_transaction_failed",
    });
    authorized = true;
    const revokedQuery = await connectRlsProjectDatabase(
      uri.href,
      pooled,
      8365,
      identity,
      reauthorize,
    );
    await revokedQuery.query({ text: "INSERT INTO rls_bounded_writes VALUES(3)", values: [] });
    authorized = false;
    await expect(revokedQuery.query({ text: "SELECT 1", values: [] })).rejects.toThrow();
    await expect(revokedQuery.commit()).rejects.toMatchObject({
      code: "database_rls_transaction_failed",
    });

    for (const expire of [5_000, 30_000]) {
      let now = 0;
      const expired = await connectRlsProjectDatabase(
        uri.href,
        pooled,
        8365,
        identity,
        authorize,
        () => now,
      );
      await expired.query({ text: "INSERT INTO rls_bounded_writes VALUES(4)", values: [] });
      if (expire === 30_000) {
        for (now = 4_000; now < 30_000; now += 4_000)
          await expired.query({ text: "SELECT 1", values: [] });
      }
      now = expire;
      await expect(expired.commit()).rejects.toMatchObject({
        code: "database_rls_transaction_failed",
      });
    }
    const limited = await connectRlsProjectDatabase(uri.href, pooled, 8365, identity, authorize);
    await limited.query({ text: "INSERT INTO rls_bounded_writes VALUES(5)", values: [] });
    for (let count = 1; count < 100; count += 1)
      await limited.query({ text: "SELECT 1", values: [] });
    await expect(limited.query({ text: "SELECT 1", values: [] })).rejects.toBeInstanceOf(
      ProjectDatabaseInputError,
    );
    await expect(limited.commit()).rejects.toMatchObject({
      code: "database_rls_transaction_failed",
    });

    const abandoned = await connectRlsProjectDatabase(uri.href, pooled, 8365, identity, authorize);
    await abandoned.query({ text: "INSERT INTO rls_bounded_writes VALUES(6)", values: [] });
    await abandoned.abort();
    await abandoned.abort();
    await expect(abandoned.commit()).rejects.toMatchObject({
      code: "database_rls_transaction_failed",
    });

    const disconnected = await connectRlsProjectDatabase(
      uri.href,
      direct,
      8365,
      identity,
      authorize,
    );
    const backend = (await disconnected.query({
      text: "SELECT pg_backend_pid() AS pid",
      values: [],
    })) as { rows: { pid: number }[] };
    await db.pool.query("SELECT pg_terminate_backend($1)", [backend.rows[0]?.pid]);
    // Let PostgreSQL deliver the asynchronous socket error while no query is pending.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(disconnected.commit()).rejects.toMatchObject({
      code: "database_rls_transaction_failed",
    });
    await disconnected.close();

    let uncertainBeginPid: unknown;
    const lostBegin = {
      createClient(configuration: ClientConfig) {
        const client = pooled.createClient(configuration);
        return {
          ...client,
          async query(query: Parameters<typeof client.query>[0]) {
            const result = await client.query(query);
            if (query.text === "BEGIN") {
              uncertainBeginPid = (
                await client.query({ text: "SELECT pg_backend_pid() AS pid", values: [] })
              ).rows[0]?.["pid"];
              throw new Error("simulated lost begin acknowledgement");
            }
            return result;
          },
        };
      },
    };
    await expect(
      connectRlsProjectDatabase(uri.href, lostBegin, 8365, identity, authorize),
    ).rejects.toThrow("simulated lost begin acknowledgement");
    expect(
      (
        await db.pool.query("SELECT state FROM pg_stat_activity WHERE pid = $1", [
          uncertainBeginPid,
        ])
      ).rows,
    ).toEqual([{ state: "idle" }]);

    let commitDispatches = 0;
    let destroyed = 0;
    const uncertainDependencies = {
      createClient(configuration: ClientConfig) {
        const client = pooled.createClient(configuration);
        return {
          ...client,
          async query(query: Parameters<typeof client.query>[0]) {
            const result = await client.query(query);
            if (query.text === "COMMIT") {
              commitDispatches += 1;
              throw new Error("simulated lost commit acknowledgement");
            }
            return result;
          },
          async terminate() {
            destroyed += 1;
            await client.terminate?.();
          },
        };
      },
    };
    const uncertain = await connectRlsProjectDatabase(
      uri.href,
      uncertainDependencies,
      8365,
      identity,
      authorize,
    );
    await uncertain.query({ text: "INSERT INTO rls_bounded_writes VALUES(7)", values: [] });
    await expect(uncertain.commit()).rejects.toMatchObject({
      code: "database_transaction_outcome_unknown",
    });
    await expect(uncertain.commit()).rejects.toMatchObject({
      code: "database_transaction_outcome_unknown",
    });
    await uncertain.close();
    expect(commitDispatches).toBe(1);
    expect(destroyed).toBe(1);
    expect(
      (await db.pool.query("SELECT value FROM rls_bounded_writes ORDER BY value")).rows,
    ).toEqual([{ value: 1 }, { value: 7 }]);
  } finally {
    await pool.end();
    await db.stop();
  }
}, 60_000);
