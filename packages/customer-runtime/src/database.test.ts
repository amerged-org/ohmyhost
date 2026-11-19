import { describe, expect, it, vi } from "vitest";

import {
  createPrivateDatabaseClient,
  type CustomerDatabaseJson,
  type CustomerDatabaseRlsTransaction,
} from "./database.js";
import { CustomerDatabaseError, CustomerRuntimeError } from "./errors.js";

const result = (rows: readonly Record<string, unknown>[] = [{ id: "row-1" }]) => ({
  command: "SELECT",
  rows,
  rowCount: rows.length,
});

describe("private customer database client", () => {
  it("owns RLS scope completion, serializes pending queries and refuses commits after any failure", async () => {
    const statement = { text: "select 1", values: [] };
    const success = { type: "ohmyhost.database-rls-commit/v1" };
    const query = vi.fn(async (input: unknown): Promise<unknown> => {
      void input;
      return result();
    });
    const commit = vi.fn(async (): Promise<unknown> => success);
    const close = vi.fn(async () => undefined);
    const openRls = vi.fn(async (identity: unknown) => {
      void identity;
      return { query, commit, close };
    });
    const binding = { openRls, query: vi.fn(), transaction: vi.fn() };
    const database = createPrivateDatabaseClient(binding);
    let captured: CustomerDatabaseRlsTransaction | undefined;
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    query.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const completed = database.withRls(
      { subject: "user_A", claims: { team: "one" } },
      async (tx) => {
        captured = tx;
        expect(Object.keys(tx)).toEqual(["query"]);
        void tx.query(statement);
        void tx.query(statement);
        return "done";
      },
    );
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    expect(commit).not.toHaveBeenCalled();
    first.resolve(result());
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(commit).not.toHaveBeenCalled();
    await expect(captured?.query(statement)).rejects.toMatchObject({
      code: "database_rls_transaction_failed",
      retryable: false,
    });
    second.resolve(result());
    await expect(completed).resolves.toBe("done");
    expect(commit).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(openRls).toHaveBeenCalledWith({ subject: "user_A", claims: { team: "one" } });
    await expect(captured?.query(statement)).rejects.toMatchObject({
      code: "database_rls_transaction_failed",
    });
    await expect(database.withRls(null, (tx) => tx.query(statement))).resolves.toEqual(result());
    expect(openRls).toHaveBeenLastCalledWith(null);
    for (const text of [
      "begin",
      "start transaction",
      "commit",
      "rollback",
      "savepoint one",
      "release one",
      "set role admin",
      "reset all",
      "discard all",
      "prepare transaction 'one'",
      "call mutate()",
      "/* nested /* comment */ */ commit",
      "select 1; commit",
    ]) {
      const commits = commit.mock.calls.length;
      await expect(
        database.withRls({ subject: "user" }, async (tx) => {
          await expect(tx.query({ text, values: [] })).rejects.toMatchObject({
            code: "database_query_invalid",
          });
          await expect(tx.query(statement)).rejects.toMatchObject({
            code: "database_rls_transaction_failed",
          });
          return "caught";
        }),
      ).rejects.toMatchObject({ code: "database_rls_transaction_failed", retryable: false });
      expect(commit).toHaveBeenCalledTimes(commits);
    }
    for (const response of [
      { type: "ohmyhost.database-error/v1", sqlstate: "23505" },
      { type: "ohmyhost.database-rls-error/v1", code: "database_rls_transaction_failed" },
      { type: "ohmyhost.database-rls-error/v1", code: "private-unknown-code" },
      result(new Array(1_001).fill({ value: "too much" })),
      { secret: "must-not-leak" },
    ]) {
      const commits = commit.mock.calls.length;
      query.mockResolvedValueOnce(response);
      await expect(
        database.withRls({ subject: "user" }, async (tx) => {
          await tx.query(statement).catch(() => undefined);
          return "caught";
        }),
      ).rejects.toMatchObject({ code: "database_rls_transaction_failed", retryable: false });
      expect(commit).toHaveBeenCalledTimes(commits);
    }
    query.mockRejectedValueOnce(new Error("private SQL"));
    const beforeIgnored = query.mock.calls.length;
    await expect(
      database.withRls(null, async (tx) => {
        void tx.query(statement);
        void tx.query(statement);
      }),
    ).rejects.toMatchObject({ code: "database_rls_transaction_failed", retryable: false });
    // A queued write must never be dispatched after the preceding statement failed.
    expect(query).toHaveBeenCalledTimes(beforeIgnored + 1);
    query.mockResolvedValueOnce({ type: "ohmyhost.database-error/v1", sqlstate: "23505" });
    await expect(database.withRls(null, (tx) => tx.query(statement))).rejects.toMatchObject({
      code: "23505",
    });
    const held = Promise.withResolvers<unknown>();
    query.mockImplementationOnce(() => held.promise);
    const cleanupCount = close.mock.calls.length;
    const thrown = database.withRls(null, async (tx) => {
      void tx.query(statement);
      throw new Error("callback failed");
    });
    const rejected = expect(thrown).rejects.toThrow("callback failed");
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(cleanupCount);
    held.resolve(result());
    await rejected;
    expect(close).toHaveBeenCalledTimes(cleanupCount + 1);
    for (const response of [
      undefined,
      {},
      { ...success, extra: true },
      { type: "ohmyhost.database-rls-error/v1", code: "database_transaction_outcome_unknown" },
      {
        type: "ohmyhost.database-rls-error/v1",
        code: "database_rls_transaction_failed",
        extra: true,
      },
    ]) {
      commit.mockResolvedValueOnce(response);
      await expect(database.withRls(null, async () => "done")).rejects.toMatchObject({
        code: "database_transaction_outcome_unknown",
        retryable: false,
      });
    }
    commit.mockRejectedValueOnce(new Error("private commit"));
    await expect(database.withRls(null, async () => "done")).rejects.toMatchObject({
      code: "database_transaction_outcome_unknown",
      retryable: false,
    });
    commit.mockResolvedValueOnce({
      type: "ohmyhost.database-rls-error/v1",
      code: "database_rls_transaction_failed",
    });
    await expect(database.withRls(null, async () => "done")).rejects.toMatchObject({
      code: "database_rls_transaction_failed",
      retryable: false,
    });
    close.mockRejectedValueOnce(new Error("private close"));
    await expect(database.withRls(null, async () => "done")).resolves.toBe("done");
    const opens = openRls.mock.calls.length;
    for (const identity of [
      undefined,
      { subject: "" },
      { subject: "user", claims: { role: "admin" } },
    ]) {
      await expect(database.withRls(identity as never, async () => "done")).rejects.toMatchObject({
        code: "database_rls_identity_invalid",
        retryable: false,
      });
    }
    expect(openRls).toHaveBeenCalledTimes(opens);
    await expect(
      createPrivateDatabaseClient({ query: vi.fn(), transaction: vi.fn() }).withRls(
        null,
        async () => "done",
      ),
    ).rejects.toMatchObject({ code: "database_unavailable" });
    openRls.mockRejectedValueOnce(new Error("private open"));
    await expect(database.withRls(null, async () => "done")).rejects.toMatchObject({
      code: "database_unavailable",
    });
    await Promise.all(
      ["user_A", "user_B"].map((subject) =>
        database.withRls({ subject }, (tx) => tx.query(statement)),
      ),
    );
    expect(openRls.mock.calls.slice(-2).map(([identity]) => identity)).toEqual([
      { subject: "user_A", claims: {} },
      { subject: "user_B", claims: {} },
    ]);
    expect(binding.query).not.toHaveBeenCalled();
    expect(binding.transaction).not.toHaveBeenCalled();
  });

  it("uses only the private RPC binding and validates one query result", async () => {
    const binding = {
      query: vi.fn(async () => result([{ id: "row-1", at: new Date(0) }])),
      transaction: vi.fn(),
      providerCredential: "must-not-leak",
    };
    Object.defineProperty(binding.query, "bind", {
      value: () => {
        throw new Error("native RPC methods cannot be rebound");
      },
    });
    const database = createPrivateDatabaseClient(binding);

    await expect(
      database.query({ text: "select $1::text id", values: ["row-1"] }),
    ).resolves.toEqual(result([{ id: "row-1", at: new Date(0) }]));
    expect(binding.query).toHaveBeenCalledWith({
      text: "select $1::text id",
      values: ["row-1"],
    });
    expect(Object.keys(database).sort()).toEqual([
      "query",
      "transaction",
      "withConnection",
      "withRls",
    ]);
    expect(JSON.stringify(database)).not.toContain("must-not-leak");
    expect(Object.isFrozen(database)).toBe(true);
  });

  it("holds one connection for a read-decide-write and always releases it", async () => {
    // The callback shape is the point: a customer cannot leak a connection their whole project
    // shares, so it is released when the callback throws just as when it returns.
    const close = vi.fn(async () => undefined);
    const query = vi.fn(async () => result([{ n: 1 }]));
    const open = vi.fn(async () => ({ query, close }));
    const database = createPrivateDatabaseClient({ query: vi.fn(), transaction: vi.fn(), open });

    await expect(
      database.withConnection(async (connection) => {
        await connection.query({ text: "begin", values: [] });
        const read = await connection.query({ text: "select 1 n", values: [] });
        return read.rows[0]?.["n"];
      }),
    ).resolves.toBe(1);
    expect(close).toHaveBeenCalledOnce();
    // Transaction control belongs inside a connection; session-wide state still does not.
    await expect(
      database.withConnection((connection) =>
        connection.query({ text: "set statement_timeout = 0", values: [] }),
      ),
    ).rejects.toMatchObject({ code: "database_query_invalid" });
    expect(close).toHaveBeenCalledTimes(2);
    await expect(
      database.withConnection(() => {
        throw new Error("customer failure");
      }),
    ).rejects.toThrow("customer failure");
    expect(close).toHaveBeenCalledTimes(3);
    // A connection that cannot be closed must not turn a finished callback into a failure; the
    // database ends the connection and releases the slot when the Worker goes away regardless.
    const stubborn = vi.fn(async () => ({
      query: vi.fn(async () => result([])),
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    }));
    await expect(
      createPrivateDatabaseClient({
        query: vi.fn(),
        transaction: vi.fn(),
        open: stubborn,
      }).withConnection(async () => "done"),
    ).resolves.toBe("done");
    // A binding without the capability says so rather than pretending.
    await expect(
      createPrivateDatabaseClient({ query: vi.fn(), transaction: vi.fn() }).withConnection(
        async () => 1,
      ),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("executes one ordered transaction through the binding", async () => {
    const transaction = vi.fn(async (queries: readonly unknown[]) => queries.map(() => result([])));
    const database = createPrivateDatabaseClient({ query: vi.fn(), transaction });
    const queries = [
      { text: "insert into item(id) values($1)", values: ["row-1"] },
      { text: "select id from item", values: [] },
    ] as const;

    await expect(database.transaction(queries)).resolves.toHaveLength(2);
    expect(transaction).toHaveBeenCalledWith(queries);
  });

  it("rejects malformed queries and manual transaction control before RPC", async () => {
    const binding = { query: vi.fn(), transaction: vi.fn() };
    const database = createPrivateDatabaseClient(binding);

    await expect(database.query({ text: "", values: [] })).rejects.toMatchObject({
      code: "database_query_invalid",
      retryable: false,
    });
    await expect(database.query({ text: "BEGIN", values: [] })).rejects.toMatchObject({
      code: "database_query_invalid",
      retryable: false,
    });
    await expect(
      database.query({ text: "SET statement_timeout=0; SELECT 1", values: [] }),
    ).rejects.toMatchObject({ code: "database_query_invalid", retryable: false });
    for (const text of [
      "START TRANSACTION",
      "START",
      "END",
      "ABORT",
      "PREPARE TRANSACTION 'x'",
      "PREPARE item AS SELECT 1",
      "COMMIT PREPARED 'x'",
      "ROLLBACK PREPARED 'x'",
    ]) {
      await expect(database.query({ text, values: [] })).rejects.toMatchObject({
        code: "database_query_invalid",
        retryable: false,
      });
    }
    await expect(
      database.transaction([{ text: "/* guarded */ BEGIN", values: [] }]),
    ).rejects.toMatchObject({ code: "database_query_invalid", retryable: false });
    await expect(
      database.transaction([{ text: "prepare item as select 1", values: [] }]),
    ).rejects.toMatchObject({ code: "database_query_invalid", retryable: false });
    expect(binding.query).not.toHaveBeenCalled();
    expect(binding.transaction).not.toHaveBeenCalled();

    // A held connection refuses a chained transaction like the database Worker, but a savepoint
    // that happens to be named chain is ordinary transaction control.
    const held = { query: vi.fn(async () => result([])), close: vi.fn(async () => undefined) };
    const connected = createPrivateDatabaseClient({ ...binding, open: vi.fn(async () => held) });
    for (const text of [
      "COMMIT AND CHAIN",
      "rollback work /* note */ and chain",
      "END AND NO CHAIN",
    ]) {
      await expect(
        connected.withConnection((connection) => connection.query({ text, values: [] })),
      ).rejects.toMatchObject({ code: "database_query_invalid", retryable: false });
    }
    await connected.withConnection((connection) =>
      connection.query({ text: "ROLLBACK TO SAVEPOINT chain", values: [] }),
    );
    expect(held.query).toHaveBeenCalledOnce();
  });

  it("names a missing OHMYHOST_DATABASE binding instead of blaming the query", () => {
    for (const binding of [undefined, null, "postgres://not-a-binding", { query: vi.fn() }]) {
      let caught: unknown;
      try {
        createPrivateDatabaseClient(binding as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CustomerRuntimeError);
      expect(caught).toMatchObject({
        code: "database_binding_missing",
        retryable: false,
        message:
          "database_binding_missing: pass the OHMYHOST_DATABASE binding from the Worker env (Next.js: getCloudflareContext({ async: true }).env), not process.env. It exists only in server code of a deployment whose ohmyhost.yaml sets database.enabled: true.",
      });
      expect(String(caught)).not.toContain("postgres://");
    }
  });

  it("accepts every JSON key the database Worker accepts and still rejects unsafe or oversized keys", async () => {
    const keys = [
      "2026-09-27",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "user.email",
      "@type",
      "größe",
      "ö".repeat(64),
    ];
    const document = Object.fromEntries(keys.map((key) => [key, key]));
    const query = vi.fn(async () => result([{ document }]));
    const database = createPrivateDatabaseClient({ query, transaction: vi.fn() });
    const statement = { text: "select $1::jsonb document", values: [document] };

    await expect(database.query(statement)).resolves.toEqual(result([{ document }]));
    expect(query).toHaveBeenCalledWith(statement);
    for (const key of ["__proto__", "constructor", "ö".repeat(65), "line\nbreak", ""]) {
      const unsafe = Object.fromEntries([[key, "value"]]);
      await expect(database.query({ text: "select $1", values: [unsafe] })).rejects.toMatchObject({
        code: "database_query_invalid",
        retryable: false,
      });
      query.mockResolvedValueOnce(result([unsafe]));
      await expect(database.query({ text: "select 1", values: [] })).rejects.toMatchObject({
        code: "database_response_invalid",
        retryable: false,
      });
    }
    expect(query).toHaveBeenCalledTimes(6);
  });

  it("allows semicolons inside SQL lexical constructs but rejects real extra statements", async () => {
    const binding = { query: vi.fn(async () => result()), transaction: vi.fn() };
    const database = createPrivateDatabaseClient(binding);
    for (const text of [
      "select ';' value",
      'select ";" value',
      "select $$;$$ value",
      "select $tag$;$tag$ value",
      String.raw`select E'it\'s;safe' value`,
      "select 1 /* ; /* nested ; */ ; */",
      "select 1 -- ;\n",
      "select 1;",
    ]) {
      await expect(database.query({ text, values: [] })).resolves.toMatchObject({
        command: "SELECT",
      });
    }
    for (const text of ["select 1; select 2", "select 1;;", "select 'unterminated"]) {
      await expect(database.query({ text, values: [] })).rejects.toMatchObject({
        code: "database_query_invalid",
      });
    }
  });

  it("rejects extra, unsafe, and oversized response shapes", async () => {
    for (const response of [
      { ...result(), secret: "must-not-leak" },
      result([Object.fromEntries([["__proto__", "blocked"]])]),
      result(new Array(1_001).fill({ id: "row" })),
      { command: "SELECT", rows: [], rowCount: Number.NaN },
    ]) {
      const database = createPrivateDatabaseClient({
        query: vi.fn(async () => response),
        transaction: vi.fn(),
      });
      const error = await database
        .query({ text: "select 1", values: [] })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "database_response_invalid", retryable: false });
      expect(String(error)).not.toContain("must-not-leak");
    }
  });

  it("maps binding failures to one redacted retryable error", async () => {
    const database = createPrivateDatabaseClient({
      query: vi.fn(async () => {
        throw Object.assign(new Error("secret SQL and value"), { code: "23505" });
      }),
      transaction: vi.fn(),
    });

    const error = await database
      .query({ text: "insert secret", values: ["secret"] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "database_unavailable", retryable: true });
    expect(String(error)).not.toContain("secret");

    const forged = createPrivateDatabaseClient({
      query: vi.fn(async () => {
        throw new CustomerRuntimeError("database_response_invalid", false);
      }),
      transaction: vi.fn(),
    });
    await expect(forged.query({ text: "select 1", values: [] })).rejects.toMatchObject({
      code: "database_unavailable",
      retryable: true,
    });
  });

  it("preserves only verified SQLSTATE failures for query, transaction and held connections", async () => {
    const failure = (sqlstate: string) => ({ type: "ohmyhost.database-error/v1", sqlstate });
    const close = vi.fn(async () => undefined);
    const database = createPrivateDatabaseClient({
      query: vi.fn(async () => failure("23505")),
      transaction: vi.fn(async () => failure("23P01")),
      open: vi.fn(async () => ({ query: vi.fn(async () => failure("P0002")), close })),
    });
    const statement = { text: "select $1", values: ["private value"] };
    for (const [work, code] of [
      [() => database.query(statement), "23505"],
      [() => database.transaction([statement]), "23P01"],
      [() => database.withConnection((connection) => connection.query(statement)), "P0002"],
    ] as const) {
      const error = await work().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CustomerDatabaseError);
      expect(error).toMatchObject({
        code,
        message: `database_statement_failed: SQLSTATE ${code}`,
        retryable: false,
      });
      expect(JSON.stringify(error)).not.toContain("private");
      expect(error).not.toHaveProperty("constraint");
    }
    expect(close).toHaveBeenCalledOnce();
    for (const code of ["40001", "40P01"])
      expect(new CustomerDatabaseError(code)).toMatchObject({ code, retryable: true });
    for (const raw of [
      { ...failure("23505"), constraint: "private_constraint" },
      failure("bad"),
      { type: "ohmyhost.database-error/v2", sqlstate: "23505" },
    ]) {
      const malformed = createPrivateDatabaseClient({
        query: vi.fn(async () => raw),
        transaction: vi.fn(),
      });
      await expect(malformed.query(statement)).rejects.toMatchObject({
        code: "database_response_invalid",
      });
    }
  });

  it("enforces exact aggregate result serialization boundaries", async () => {
    const empty = result([{ value: "" }]);
    const baseBytes = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
    const exact = "x".repeat(1024 * 1024 - baseBytes);
    const accepted = createPrivateDatabaseClient({
      query: vi.fn(async () => result([{ value: exact }])),
      transaction: vi.fn(),
    });
    await expect(accepted.query({ text: "select value", values: [] })).resolves.toMatchObject({
      rowCount: 1,
    });

    const rejected = createPrivateDatabaseClient({
      query: vi.fn(async () => result([{ value: `${exact}x` }])),
      transaction: vi.fn(),
    });
    await expect(rejected.query({ text: "select value", values: [] })).rejects.toMatchObject({
      code: "database_response_invalid",
    });
  });

  it("counts aggregate parameter strings, bytes, nodes, depth, and invalid dates", async () => {
    const binding = { query: vi.fn(async () => result()), transaction: vi.fn() };
    const database = createPrivateDatabaseClient(binding);
    await expect(
      database.query({ text: "select $1", values: ["x".repeat(1024 * 1024 - 4)] }),
    ).resolves.toMatchObject({ command: "SELECT" });
    await expect(
      database.query({ text: "select $1", values: ["x".repeat(1024 * 1024 - 3)] }),
    ).rejects.toMatchObject({ code: "database_query_invalid" });
    await expect(
      database.query({
        text: "select $1",
        values: [new Uint8Array(1024 * 1024 - 4)],
      }),
    ).resolves.toMatchObject({ command: "SELECT" });
    await expect(
      database.query({
        text: "select $1",
        values: [new Uint8Array(1024 * 1024 - 3)],
      }),
    ).rejects.toMatchObject({ code: "database_query_invalid" });
    await expect(
      database.query({ text: "select $1", values: [new Date(Number.NaN)] }),
    ).rejects.toMatchObject({ code: "database_query_invalid" });
    // The database Worker bounds each JSON parameter to 64 KiB of text and key bytes plus eight
    // bytes per number; a plain string parameter keeps the aggregate budget above.
    await expect(
      database.query({ text: "select $1::jsonb", values: [{ note: "x".repeat(65_536 - 4) }] }),
    ).resolves.toMatchObject({ command: "SELECT" });
    for (const oversized of [{ note: "x".repeat(65_536 - 3) }, new Array(8_193).fill(0)]) {
      await expect(
        database.query({ text: "select $1::jsonb", values: [oversized] }),
      ).rejects.toMatchObject({ code: "database_query_invalid", retryable: false });
    }
    await expect(
      database.query({ text: "select $1", values: [new Array(8_192).fill(0)] }),
    ).resolves.toMatchObject({ command: "SELECT" });

    let deep: unknown = "leaf";
    for (let depth = 0; depth < 9; depth += 1) deep = [deep];
    await expect(
      database.query({ text: "select $1", values: [deep as never] }),
    ).rejects.toMatchObject({
      code: "database_query_invalid",
    });
    await expect(
      database.query({
        text: "select values",
        values: new Array(100).fill(null).map(() => new Array(100).fill(null)),
      }),
    ).rejects.toMatchObject({ code: "database_query_invalid" });
  });

  it("uses one aggregate parameter budget across an entire transaction", async () => {
    const transaction = vi.fn(async () => []);
    const database = createPrivateDatabaseClient({ query: vi.fn(), transaction });
    const individuallyValid = "x".repeat(50_000);
    const queries = new Array(25).fill(null).map((_, index) => ({
      text: `select $1::text value_${String(index)}`,
      values: [individuallyValid],
    }));
    await expect(database.transaction(queries)).rejects.toMatchObject({
      code: "database_query_invalid",
      retryable: false,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("counts result keys, containers, dates, bytes, nodes, and depth", async () => {
    let depthEightRow: Readonly<Record<string, CustomerDatabaseJson>> = { value: "leaf" };
    for (let depth = 1; depth < 8; depth += 1) depthEightRow = { nested: depthEightRow };
    const query = vi.fn(async () => result([depthEightRow]));
    const database = createPrivateDatabaseClient({ query, transaction: vi.fn() });
    await expect(database.query({ text: "select value", values: [] })).resolves.toEqual(
      result([depthEightRow]),
    );
    query.mockResolvedValueOnce(result([{ nested: depthEightRow }]));
    await expect(database.query({ text: "select value", values: [] })).rejects.toMatchObject({
      code: "database_response_invalid",
    });
    // Parameter depth still starts at the parameter itself and retains its existing limit.
    await expect(
      database.query({ text: "select $1", values: [depthEightRow] }),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      database.query({ text: "select $1", values: [{ nested: depthEightRow }] }),
    ).rejects.toMatchObject({ code: "database_query_invalid" });
    expect(query).toHaveBeenCalledTimes(3);
    // Four envelope nodes plus one row and its array leave exactly 9,994 value nodes.
    query.mockResolvedValueOnce(result([{ values: new Array(9_994).fill(null) }]));
    await expect(database.query({ text: "select value", values: [] })).resolves.toMatchObject({
      rowCount: 1,
    });
    query.mockResolvedValueOnce(result([{ values: new Array(9_995).fill(null) }]));
    await expect(database.query({ text: "select value", values: [] })).rejects.toMatchObject({
      code: "database_response_invalid",
    });
    for (const rows of [
      [{ nested: [[[[[[[[["too-deep"]]]]]]]]] }],
      new Array(1_000).fill(null).map((_, index) => ({
        [`key_${String(index).padStart(120, "x")}`]: new Array(10).fill(index),
      })),
      [{ invalid: new Date(Number.NaN) }],
      [{ bytes: new Uint8Array(1024 * 1024) }],
    ]) {
      const database = createPrivateDatabaseClient({
        query: vi.fn(async () => result(rows)),
        transaction: vi.fn(),
      });
      await expect(database.query({ text: "select value", values: [] })).rejects.toMatchObject({
        code: "database_response_invalid",
      });
    }
  });
});
