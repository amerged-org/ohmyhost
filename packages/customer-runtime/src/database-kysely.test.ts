import { betterAuth } from "better-auth";
import { CompiledQuery, Kysely, sql } from "kysely";
import { describe, expect, it, vi } from "vitest";

import { createPrivateDatabaseDialect, createRlsTransactionDialect } from "./database-kysely.js";
import { createPrivateDatabaseClient, type CustomerDatabaseQuery } from "./database.js";

function gateway() {
  const events: Array<{ lease: number; text: string; values?: readonly unknown[] }> = [];
  const close = vi.fn(async (lease: number) => {
    events.push({ lease, text: "close" });
  });
  const open = vi.fn(async () => {
    const lease = open.mock.calls.length;
    return {
      async query({ text, values }: CustomerDatabaseQuery) {
        events.push({ lease, text, values });
        if (values.includes("conflict"))
          return { type: "ohmyhost.database-error/v1", sqlstate: "23505" };
        const command = text.trim().split(/\s/u)[0]?.toUpperCase() ?? "";
        return {
          command,
          rows: command === "SELECT" ? [{ id: "item-1", value: 1, nspname: "public" }] : [],
          rowCount: command === "UPDATE" ? 1 : command === "SELECT" ? 1 : null,
        };
      },
      close: () => close(lease),
    };
  });
  const binding = { open, query: vi.fn(), transaction: vi.fn() };
  return { binding, events, open, close };
}

describe("private Kysely PostgreSQL dialect", () => {
  it("runs Kysely in its owner's RLS transaction without nesting, streaming or closing that owner", async () => {
    const source = gateway();
    const query = vi.fn(async ({ text }: CustomerDatabaseQuery) => ({
      command: text.startsWith("update") ? "UPDATE" : "SELECT",
      rows: [{ id: "item-1", value: 1, nspname: "public" }],
      rowCount: 1,
    }));
    const commit = vi.fn(async () => ({ type: "ohmyhost.database-rls-commit/v1" }));
    const close = vi.fn(async () => undefined);
    const openRls = vi.fn(async () => ({ query, commit, close }));
    const client = createPrivateDatabaseClient({ ...source.binding, openRls });
    let retained: Kysely<{ item: { id: string; value: number } }> | undefined;
    await client.withRls({ subject: "user_A" }, async (tx) => {
      const dialect = createRlsTransactionDialect(tx);
      const database = new Kysely<{ item: { id: string; value: number } }>({ dialect });
      retained = database;
      const row = await database.selectFrom("item").selectAll().executeTakeFirstOrThrow();
      expect(row.id).toBe("item-1");
      expect(
        (
          await database
            .updateTable("item")
            .set({ value: row.value + 1 })
            .executeTakeFirstOrThrow()
        ).numUpdatedRows,
      ).toBe(1n);
      await expect(database.introspection.getSchemas()).resolves.toEqual([{ name: "public" }]);
      await expect(database.transaction().execute(async () => "nested")).rejects.toThrow(
        "RLS transaction lifecycle belongs to withRls",
      );
      await expect(
        (async () => {
          for await (const row of database.selectFrom("item").selectAll().stream()) void row;
        })(),
      ).rejects.toThrow("streaming is not supported");
      const driver = dialect.createDriver();
      await driver.init();
      const connection = await driver.acquireConnection();
      await expect(driver.commitTransaction(connection)).rejects.toThrow(
        "lifecycle belongs to withRls",
      );
      await expect(driver.rollbackTransaction(connection)).rejects.toThrow(
        "lifecycle belongs to withRls",
      );
      await driver.releaseConnection(connection);
      await expect(connection.executeQuery(CompiledQuery.raw("select 1"))).rejects.toThrow(
        "connection is released",
      );
      await driver.destroy();
      await expect(driver.acquireConnection()).rejects.toThrow("dialect is destroyed");
      expect(close).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    const dispatched = query.mock.calls.length;
    await expect(retained?.selectFrom("item").selectAll().execute()).rejects.toMatchObject({
      code: "database_rls_transaction_failed",
    });
    await retained?.destroy();
    expect(query).toHaveBeenCalledTimes(dispatched);
    await client.withRls(null, async (tx) => {
      const database = new Kysely({ dialect: createRlsTransactionDialect(tx) });
      await database.destroy();
      expect(close).toHaveBeenCalledOnce();
      await tx.query({ text: "select 1", values: [] });
    });
    await expect(
      client.withRls(null, async (tx) => {
        const database = new Kysely({ dialect: createRlsTransactionDialect(tx) });
        try {
          await sql`commit`.execute(database);
        } finally {
          await database.destroy();
        }
      }),
    ).rejects.toMatchObject({ code: "database_query_invalid" });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(source.open).not.toHaveBeenCalled();
  });

  it("runs the actual compiler and read-decide-write transaction on one leased RPC connection", async () => {
    const source = gateway();
    const database = new Kysely<{ item: { id: string; value: number } }>({
      dialect: createPrivateDatabaseDialect(source.binding),
    });
    const changed = await database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("item")
        .select(["id", "value"])
        .where("id", "=", "item-1")
        .executeTakeFirstOrThrow();
      const result = await transaction
        .updateTable("item")
        .set({ value: row.value + 1 })
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      return result.numUpdatedRows;
    });
    expect(changed).toBe(1n);
    expect(source.events.map((event) => event.text)).toEqual([
      "begin",
      'select "id", "value" from "item" where "id" = $1',
      'update "item" set "value" = $1 where "id" = $2',
      "commit",
      "close",
    ]);
    expect(new Set(source.events.map((event) => event.lease))).toEqual(new Set([1]));
    expect(source.binding.query).not.toHaveBeenCalled();
    expect(source.binding.transaction).not.toHaveBeenCalled();
    await expect(database.introspection.getSchemas()).resolves.toContainEqual({ name: "public" });
    await database.destroy();
  });

  it("rolls back failures, isolates concurrent leases and rejects unsupported streams without leaking", async () => {
    const source = gateway();
    const database = new Kysely<{ item: { id: string; value: number } }>({
      dialect: createPrivateDatabaseDialect(source.binding),
    });
    await expect(
      database.transaction().execute(async (transaction) => {
        await transaction.insertInto("item").values({ id: "conflict", value: 0 }).execute();
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(source.events.map((event) => event.text)).toEqual([
      "begin",
      'insert into "item" ("id", "value") values ($1, $2)',
      "rollback",
      "close",
    ]);
    await Promise.all(
      [1, 2].map(async (value) =>
        database.transaction().execute(async (transaction) => {
          await sql`select ${value}`.execute(transaction);
          await sql`select ${value + 10}`.execute(transaction);
        }),
      ),
    );
    for (const lease of [2, 3])
      expect(
        source.events.filter((event) => event.lease === lease).map((event) => event.text),
      ).toEqual(["begin", "select $1", "select $1", "commit", "close"]);
    await expect(
      (async () => {
        for await (const row of database.selectFrom("item").selectAll().stream()) void row;
      })(),
    ).rejects.toThrow("streaming is not supported");
    expect(source.close).toHaveBeenCalledTimes(4);
    await database.destroy();
    const unavailable = new Kysely({
      dialect: createPrivateDatabaseDialect({ query: vi.fn(), transaction: vi.fn() }),
    });
    await expect(sql`select 1`.execute(unavailable)).rejects.toMatchObject({
      code: "database_unavailable",
    });
    await unavailable.destroy();
    const driver = createPrivateDatabaseDialect(source.binding).createDriver();
    await driver.init();
    const leased = await driver.acquireConnection();
    await driver.destroy();
    await expect(leased.executeQuery(CompiledQuery.raw("select 1"))).rejects.toThrow(
      "connection is released",
    );
    await expect(driver.acquireConnection()).rejects.toThrow("dialect is destroyed");
    await driver.releaseConnection(leased);
  });

  it("runs caller-owned Better Auth 1.7.7's actual adapter transaction through the same dialect", async () => {
    const source = gateway();
    const database = new Kysely<Record<string, Record<string, unknown>>>({
      dialect: createPrivateDatabaseDialect(source.binding),
    }).withSchema("public");
    const auth = betterAuth({
      baseURL: "https://auth.example.test",
      secret: "a-test-only-secret-with-at-least-32-characters",
      database: { db: database, type: "postgres", transaction: true },
    });
    const context = await auth.$context;
    await expect(
      context.adapter.transaction(async (adapter) =>
        adapter.findOne({ model: "user", where: [{ field: "id", value: "item-1" }] }),
      ),
    ).resolves.toMatchObject({ id: "item-1" });
    // Better Auth validates its schema first, on its own leased connection: the search path and
    // the catalog introspection, both ordinary reads through the same dialect.
    const schemaLease = source.events[0]?.lease;
    const schemaCheck = source.events.filter((event) => event.lease === schemaLease);
    expect(schemaCheck[0]?.text).toContain("pg_catalog.current_schemas");
    expect(schemaCheck[1]?.text).toContain('"pg_catalog"."pg_attribute"');
    expect(schemaCheck.at(-1)?.text).toBe("close");
    const transaction = source.events.filter((event) => event.lease !== schemaLease);
    expect(transaction[0]?.text).toBe("begin");
    expect(transaction[1]?.text).toContain('"public"."user"');
    expect(transaction.slice(-2).map((event) => event.text)).toEqual(["commit", "close"]);
    await expect(
      context.adapter.transaction(async (adapter) => {
        await adapter.findOne({ model: "user", where: [{ field: "id", value: "item-1" }] });
        throw new Error("decision failed");
      }),
    ).rejects.toThrow("decision failed");
    expect(source.events.slice(-2).map((event) => event.text)).toEqual(["rollback", "close"]);
    await database.destroy();
  });
});
