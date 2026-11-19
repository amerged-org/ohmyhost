import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "pg";

import {
  connectProjectDatabase,
  connectBoundedProjectDatabase,
  createProjectDatabaseService,
  ProjectDatabaseBusyError,
  ProjectDatabaseInputError,
  ProjectDatabaseResultError,
  type ProjectDatabaseClient,
} from "../src/service.js";

const heldTimeouts = [
  expect.stringMatching(/^SET LOCAL idle_in_transaction_session_timeout.*5000ms/iu),
  expect.stringMatching(/^SET LOCAL transaction_timeout.*\d+ms/iu),
];

function harness(rows: Record<string, unknown>[] = [{ id: "row-1" }]) {
  const query = vi.fn(async (input: { text: string }) => ({
    command: input.text.trim().split(/\s+/u)[0]?.toUpperCase() ?? "UNKNOWN",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: input.text.includes("pg_try_advisory_xact_lock") ? [{ held: true }] : rows,
  }));
  const client: ProjectDatabaseClient = {
    connect: vi.fn(async () => undefined),
    query,
    end: vi.fn(async () => undefined),
  };
  const createClient = vi.fn(() => client);
  return {
    service: createProjectDatabaseService("postgres://project-database", { createClient }),
    client,
    query,
    createClient,
  };
}

describe("project database runtime", () => {
  it("executes one prepared bounded query and closes its client", async () => {
    const { service, client, query, createClient } = harness([{ id: "row-1", at: new Date(0) }]);
    await expect(service.query({ text: "select $1::text id", values: ["row-1"] })).resolves.toEqual(
      {
        command: "SELECT",
        rows: [{ at: new Date(0), id: "row-1" }],
        rowCount: 1,
      },
    );
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: "postgres://project-database",
        statement_timeout: 10_000,
      }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "select $1::text id",
        values: ["row-1"],
      }),
    );
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("retains one bounded connection across transaction-control queries and closes once", async () => {
    const { client, createClient, query } = harness();
    const connection = await connectProjectDatabase("postgres://project-database", {
      createClient,
    });
    await connection.query({ text: "BEGIN", values: [] });
    await connection.query({ text: "select 1", values: [] });
    await connection.query({ text: "COMMIT", values: [] });
    await connection.close();
    await connection.close();
    expect(query.mock.calls.map(([input]) => input.text)).toEqual(["BEGIN", "select 1", "COMMIT"]);
    expect(client.end).toHaveBeenCalledOnce();
    await expect(connection.query({ text: "select 2", values: [] })).rejects.toBeInstanceOf(
      ProjectDatabaseInputError,
    );
  });

  it("executes a bounded transaction in order and rolls back the original failure", async () => {
    const { service, query } = harness();
    await expect(
      service.transaction([
        { text: "insert into item(id) values($1)", values: ["row-1"] },
        { text: "select id from item", values: [] },
      ]),
    ).resolves.toHaveLength(2);
    expect(query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN",
      "insert into item(id) values($1)",
      "select id from item",
      "COMMIT",
    ]);

    query.mockClear();
    query.mockImplementation(async (input) => {
      if (input.text === "select broken")
        throw Object.assign(new DatabaseError("database unavailable", 0, "error"), {
          code: "42601",
        });
      return {
        command: input.text.trim().split(/\s+/u)[0]?.toUpperCase() ?? "UNKNOWN",
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: [],
      };
    });
    await expect(service.transaction([{ text: "select broken", values: [] }])).rejects.toThrow(
      "database unavailable",
    );
    expect(query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN",
      "select broken",
      "ROLLBACK",
    ]);
  });

  it("acquires bounded transaction slots lazily and commits standalone queries before returning", async () => {
    const { client, createClient, query } = harness();
    const connection = await connectBoundedProjectDatabase(
      "postgres://project-database",
      { createClient },
      4242,
    );
    expect(query).not.toHaveBeenCalled();
    await connection.query({ text: "insert into item(id) values($1)", values: ["row-1"] });
    expect(query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN",
      ...heldTimeouts,
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
      "insert into item(id) values($1)",
      "COMMIT",
    ]);
    await connection.query({ text: "select id from item", values: [] });
    expect(query.mock.calls.slice(6).map(([input]) => input.text)).toEqual([
      "BEGIN",
      ...heldTimeouts,
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
      "select id from item",
      "COMMIT",
    ]);
    expect(
      query.mock.calls.every(
        ([input]) => (input as { queryMode?: string }).queryMode === "extended",
      ),
    ).toBe(true);
    await connection.close();
    await connection.close();
    expect(client.end).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([input]) => input.text === "ROLLBACK")).toBe(false);
  });

  it("preserves explicit transaction options and savepoints, then permits queries after commit", async () => {
    const { createClient, query } = harness();
    const connection = await connectBoundedProjectDatabase(
      "postgres://project-database",
      { createClient },
      4242,
    );
    const statements = [
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SAVEPOINT chain",
      "select 1",
      "ROLLBACK TO SAVEPOINT chain",
      "RELEASE SAVEPOINT chain",
      "COMMIT",
      "select 2",
    ];
    for (const text of statements) await connection.query({ text, values: [] });
    expect(query.mock.calls.map(([input]) => input.text)).toEqual([
      statements[0],
      ...heldTimeouts,
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
      ...statements.slice(1, 6),
      "BEGIN",
      ...heldTimeouts,
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
      "select 2",
      "COMMIT",
    ]);
    for (const text of [";BEGIN", "/* note */ ;COMMIT AND CHAIN"]) {
      await expect(connection.query({ text, values: [] })).rejects.toBeInstanceOf(
        ProjectDatabaseInputError,
      );
    }
    await connection.close();
  });

  it("rolls back a busy slot attempt and never executes the customer statement", async () => {
    const { createClient, query, client } = harness([]);
    query.mockImplementation(async (input) => ({
      command: input.text.trim().split(/\s+/u)[0]?.toUpperCase() ?? "UNKNOWN",
      rows: input.text.includes("pg_try_advisory_xact_lock") ? [{ held: false }] : [],
      rowCount: 0,
      oid: 0,
      fields: [],
    }));
    const connection = await connectBoundedProjectDatabase(
      "postgres://project-database",
      { createClient },
      4242,
    );
    await expect(connection.query({ text: "select 1", values: [] })).rejects.toBeInstanceOf(
      ProjectDatabaseBusyError,
    );
    expect(query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN",
      ...heldTimeouts,
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
      "ROLLBACK",
    ]);
    await connection.close();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("starts the idle clock after active SQL finishes so an immediate commit is not expired", async () => {
    let now = 1_000;
    const { createClient, query, client } = harness();
    const original = query.getMockImplementation();
    if (!original) throw new Error("Expected query harness");
    query.mockImplementation(async (input) => {
      if (input.text === "SELECT active_work") now += 6_000;
      return original(input);
    });
    const connection = await connectBoundedProjectDatabase(
      "postgres://project-database",
      { createClient },
      4242,
      () => now,
    );
    await connection.query({ text: "BEGIN", values: [] });
    await connection.query({ text: "SELECT active_work", values: [] });
    await expect(connection.query({ text: "COMMIT", values: [] })).resolves.toMatchObject({
      command: "COMMIT",
    });
    const completedQueries = query.mock.calls.length;
    now += 5_001;
    await expect(connection.query({ text: "SELECT 1", values: [] })).rejects.toBeInstanceOf(
      ProjectDatabaseInputError,
    );
    expect(query).toHaveBeenCalledTimes(completedQueries);
    expect(client.end).toHaveBeenCalledOnce();

    // A socket lost within the limits is a transient failure, not a refused statement.
    const lost = harness();
    let lose: ((error: Error) => void) | undefined;
    lost.client.on = (_event, listener) => {
      lose = listener;
    };
    const held = await connectBoundedProjectDatabase(
      "postgres://project-database",
      { createClient: lost.createClient },
      4242,
      () => now,
    );
    lose?.(new Error("Connection terminated unexpectedly"));
    const failure = await held
      .query({ text: "SELECT 1", values: [] })
      .catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProjectDatabaseInputError);
    expect(lost.query).not.toHaveBeenCalled();
  });

  it("rolls back failed standalone writes and explicitly rolls back an open transaction on close", async () => {
    const { createClient, query, client } = harness();
    const original = query.getMockImplementation();
    if (!original) throw new Error("Expected query harness");
    query.mockImplementation(async (input) => {
      if (input.text === "insert broken")
        throw Object.assign(new DatabaseError("write failed", 0, "error"), { code: "23505" });
      return original(input);
    });
    const connection = await connectBoundedProjectDatabase(
      "postgres://project-database",
      { createClient },
      4242,
    );
    await expect(connection.query({ text: "insert broken", values: [] })).rejects.toThrow(
      "write failed",
    );
    expect(query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN",
      ...heldTimeouts,
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
      "insert broken",
      "ROLLBACK",
    ]);
    await connection.query({ text: "START TRANSACTION", values: [] });
    await connection.query({ text: "select 1", values: [] });
    await connection.close();
    await connection.close();
    expect(query.mock.calls.slice(6).map(([input]) => input.text)).toEqual([
      "START TRANSACTION",
      ...heldTimeouts,
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
      "select 1",
      "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects malformed, oversized, unsafe transaction, and unsupported parameter inputs", async () => {
    const { service } = harness();
    const invalid = [
      null,
      {},
      { text: "", values: [] },
      { text: "x".repeat(65_537), values: [] },
      { text: "select 1", values: new Array(101).fill(null) },
      { text: "select 1", values: [() => undefined] },
    ];
    for (const input of invalid) {
      await expect(service.query(input)).rejects.toBeInstanceOf(ProjectDatabaseInputError);
    }
    await expect(
      service.transaction([{ text: "/* guarded */ SET statement_timeout=0", values: [] }]),
    ).rejects.toBeInstanceOf(ProjectDatabaseInputError);

    await expect(
      service.query({
        text: "select $1::jsonb",
        values: [{ nested: [true, 1, "value", null] }],
      }),
    ).resolves.toMatchObject({ command: "SELECT" });
  });

  it("commits a standalone write only after its result passes the response limits", async () => {
    // A committed INSERT ... RETURNING reported as failed would be duplicated by a retry.
    const oversized = harness(new Array(1_001).fill({ id: "row" }));
    const write = "insert into item(id) select generate_series(1, 1001) returning id";
    await expect(oversized.service.query({ text: write, values: [] })).rejects.toBeInstanceOf(
      ProjectDatabaseResultError,
    );
    expect(oversized.query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN",
      write,
      "ROLLBACK",
    ]);
    expect(oversized.client.end).toHaveBeenCalledOnce();

    const accepted = harness();
    const statements = [
      "update item set id='row-2' returning id",
      "with moved as (delete from item returning id) select id from moved",
      // A write without RETURNING has no rows to reject and keeps its single round trip; a read
      // and statements PostgreSQL refuses inside a transaction block keep autocommit too.
      "insert into item(id) values('row-3')",
      "select id from item",
      "vacuum item",
    ];
    for (const text of statements) await accepted.service.query({ text, values: [] });
    expect(accepted.query.mock.calls.map(([input]) => input.text)).toEqual([
      "BEGIN",
      statements[0],
      "COMMIT",
      "BEGIN",
      statements[1],
      "COMMIT",
      ...statements.slice(2),
    ]);
  });

  it("rejects unbounded or non-portable result values and still closes the client", async () => {
    const oversized = harness(new Array(1_001).fill({ id: "row" }));
    await expect(oversized.service.query({ text: "select id", values: [] })).rejects.toBeInstanceOf(
      ProjectDatabaseResultError,
    );
    expect(oversized.client.end).toHaveBeenCalledOnce();

    const invalid = harness([{ value: Number.NaN }]);
    await expect(
      invalid.service.query({ text: "select value", values: [] }),
    ).rejects.toBeInstanceOf(ProjectDatabaseResultError);
  });

  it("preserves bounded PostgreSQL column labels without permitting prototype keys", async () => {
    const labels = harness([{ "?column?": 1 }]);
    await expect(labels.service.query({ text: "select 1", values: [] })).resolves.toMatchObject({
      rows: [{ "?column?": 1 }],
    });
    const unsafe = harness([Object.fromEntries([["__proto__", "blocked"]])]);
    await expect(unsafe.service.query({ text: "select 1", values: [] })).rejects.toBeInstanceOf(
      ProjectDatabaseResultError,
    );
  });
});

it("rechecks preview authority after an autocommit write before dispatching COMMIT", async () => {
  const { client, createClient, query } = harness();
  let checks = 0;
  const connection = await connectBoundedProjectDatabase(
    "postgres://project-database",
    { createClient },
    1,
    () => Date.now(),
    async () => {
      if (++checks > 1) throw new Error("revoked");
    },
  );
  await expect(
    connection.query({ text: "insert into item(id) values($1)", values: ["row-1"] }),
  ).rejects.toThrow("revoked");
  expect(query.mock.calls.map(([input]) => input.text)).toContain("ROLLBACK");
  expect(query.mock.calls.map(([input]) => input.text)).not.toContain("COMMIT");
  await connection.close();
  expect(client.end).toHaveBeenCalledOnce();
});
