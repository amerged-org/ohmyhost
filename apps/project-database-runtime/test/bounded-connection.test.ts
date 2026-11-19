import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { startTestPostgres } from "../../control-api/test/postgres.js";
import {
  ProjectDatabaseBusyError,
  ProjectDatabaseInputError,
  ProjectDatabaseResultError,
  connectBoundedProjectDatabase,
  createProjectDatabaseService,
} from "../src/service.js";

const dependencies = {
  createClient: (configuration: unknown) => new Client(configuration as never),
};

describe("bounded held project database connection", () => {
  it("holds two active transactions per project environment and releases slots at commit", async () => {
    // A project environment has a small pooled connection budget that Better Auth draws from as
    // well, so a held connection that is not capped turns one slow request into a project-wide
    // outage. Transaction advisory locks are released by COMMIT/ROLLBACK even when the pooled
    // backend session outlives the logical client.
    const database = await startTestPostgres();
    const options = (
      database.pool as unknown as { options: { connectionString: string; options: string } }
    ).options;
    const url = new URL(options.connectionString);
    url.searchParams.set("options", options.options);
    const connectionString = url.toString();
    try {
      const first = await connectBoundedProjectDatabase(connectionString, dependencies, 4242);
      const second = await connectBoundedProjectDatabase(connectionString, dependencies, 4242);
      const third = await connectBoundedProjectDatabase(connectionString, dependencies, 4242);
      await first.query({ text: "BEGIN", values: [] });
      await second.query({ text: "BEGIN", values: [] });
      await expect(third.query({ text: "BEGIN", values: [] })).rejects.toBeInstanceOf(
        ProjectDatabaseBusyError,
      );
      // A different project environment has its own two slots.
      const other = await connectBoundedProjectDatabase(connectionString, dependencies, 4343);
      await other.query({ text: "BEGIN", values: [] });
      await other.close();
      await first.query({ text: "COMMIT", values: [] });
      await third.query({ text: "BEGIN", values: [] });
      expect(
        await third.query({
          text: "SELECT DATE '2030-06-01' AS day, ARRAY[DATE '2030-06-01', NULL]::date[] AS days, TIMESTAMPTZ '2030-06-01 12:00:00+00' AS instant",
          values: [],
        }),
      ).toMatchObject({
        rows: [
          {
            day: "2030-06-01",
            days: ["2030-06-01", null],
            instant: new Date("2030-06-01T12:00:00Z"),
          },
        ],
      });
      expect(
        ((await third.query({ text: "SELECT 1 AS ok", values: [] })) as { rows: { ok: number }[] })
          .rows[0]?.ok,
      ).toBe(1);
      await third.query({ text: "COMMIT", values: [] });
      await expect(first.query({ text: "SELECT 1; COMMIT", values: [] })).rejects.toBeDefined();
      expect(await first.query({ text: "SELECT 3 AS n", values: [] })).toMatchObject({
        rows: [{ n: 3 }],
      });
      await first.close();
      await third.close();
      await second.close();
    } finally {
      await database.stop();
    }
  }, 60_000);

  it("keeps transaction control and refuses session-wide state and an expired lifetime", async () => {
    const database = await startTestPostgres();
    const options = (
      database.pool as unknown as { options: { connectionString: string; options: string } }
    ).options;
    const url = new URL(options.connectionString);
    url.searchParams.set("options", options.options);
    let now = 1_000;
    try {
      const connection = await connectBoundedProjectDatabase(
        url.toString(),
        dependencies,
        5252,
        () => now,
      );
      // Read, decide, write in one transaction is the whole point of holding a connection.
      await connection.query({ text: "BEGIN", values: [] });
      await connection.query({ text: "CREATE TEMP TABLE t(n int)", values: [] });
      await connection.query({ text: "INSERT INTO t(n) VALUES($1)", values: [7] });
      const read = (await connection.query({ text: "SELECT n FROM t", values: [] })) as {
        rows: { n: number }[];
      };
      expect(read.rows[0]?.n).toBe(7);
      await connection.query({ text: "COMMIT", values: [] });
      await connection.query({ text: "CREATE TABLE public.bounded_autocommit(n int)", values: [] });
      await connection.query({
        text: "INSERT INTO public.bounded_autocommit VALUES(1)",
        values: [],
      });
      await connection.query({ text: "BEGIN", values: [] });
      await connection.query({
        text: "INSERT INTO public.bounded_autocommit VALUES(2)",
        values: [],
      });
      // Session-wide state outlives the request and stays refused.
      await expect(
        connection.query({ text: "SET statement_timeout = 0", values: [] }),
      ).rejects.toBeInstanceOf(ProjectDatabaseInputError);
      now += 31_000;
      await expect(connection.query({ text: "SELECT 1", values: [] })).rejects.toBeInstanceOf(
        ProjectDatabaseInputError,
      );
      await connection.close();
      expect(
        (await database.pool.query("SELECT n FROM public.bounded_autocommit ORDER BY n")).rows,
      ).toEqual([{ n: 1 }]);
    } finally {
      await database.stop();
    }
  }, 60_000);

  it("rolls back a standalone write whose RETURNING rows exceed the response limit", async () => {
    const database = await startTestPostgres();
    const options = (
      database.pool as unknown as { options: { connectionString: string; options: string } }
    ).options;
    const url = new URL(options.connectionString);
    url.searchParams.set("options", options.options);
    try {
      await database.pool.query("CREATE TABLE public.standalone_limit(n int)");
      const service = createProjectDatabaseService(url.toString(), dependencies);
      const insert = (rows: number) =>
        service.query({
          text: "INSERT INTO public.standalone_limit SELECT generate_series(1, $1::int) RETURNING n",
          values: [rows],
        });
      const count = async () =>
        (await database.pool.query("SELECT count(*)::int AS count FROM public.standalone_limit"))
          .rows;
      await expect(insert(1_001)).rejects.toBeInstanceOf(ProjectDatabaseResultError);
      expect(await count()).toEqual([{ count: 0 }]);
      await expect(insert(1_000)).resolves.toMatchObject({ command: "INSERT", rowCount: 1_000 });
      expect(await count()).toEqual([{ count: 1_000 }]);
    } finally {
      await database.stop();
    }
  }, 60_000);

  it("releases idle transaction slots at the server without another handle query", async () => {
    const database = await startTestPostgres();
    const options = (
      database.pool as unknown as { options: { connectionString: string; options: string } }
    ).options;
    const url = new URL(options.connectionString);
    url.searchParams.set("options", options.options);
    const connectionString = url.toString();
    try {
      const first = await connectBoundedProjectDatabase(connectionString, dependencies, 6262);
      const second = await connectBoundedProjectDatabase(connectionString, dependencies, 6262);
      const blocked = await connectBoundedProjectDatabase(connectionString, dependencies, 6262);
      const pids: number[] = [];
      for (const connection of [first, second]) {
        await connection.query({ text: "BEGIN", values: [] });
        const result = (await connection.query({
          text: `SELECT pg_backend_pid() AS pid,
            (extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)*1000)::int AS idle_ms,
            (extract(epoch FROM current_setting('transaction_timeout')::interval)*1000)::int AS transaction_ms`,
          values: [],
        })) as { rows: { pid: number; idle_ms: number; transaction_ms: number }[] };
        const settings = result.rows[0];
        if (!settings) throw new Error("Expected transaction settings");
        expect(settings.idle_ms).toBe(5_000);
        expect(settings.transaction_ms).toBeGreaterThan(0);
        expect(settings.transaction_ms).toBeLessThanOrEqual(30_000);
        pids.push(settings.pid);
      }
      await expect(blocked.query({ text: "BEGIN", values: [] })).rejects.toBeInstanceOf(
        ProjectDatabaseBusyError,
      );
      await blocked.close();
      // Do not touch either holder: the server, rather than our next-query guard, must release it.
      await new Promise((resolve) => setTimeout(resolve, 5_300));
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND pid=ANY($1::int[])",
            [pids],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      const replacement = await connectBoundedProjectDatabase(connectionString, dependencies, 6262);
      await expect(replacement.query({ text: "BEGIN", values: [] })).resolves.toMatchObject({
        command: "BEGIN",
      });
      await replacement.close();
      await expect(first.query({ text: "SELECT 1", values: [] })).rejects.toBeInstanceOf(
        ProjectDatabaseInputError,
      );
      await first.close();
      await second.close();
    } finally {
      await database.stop();
    }
  }, 60_000);
});
