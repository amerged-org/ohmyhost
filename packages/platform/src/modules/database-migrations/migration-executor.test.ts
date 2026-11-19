import { describe, expect, it, vi } from "vitest";

import {
  DatabaseMigrationExecutionError,
  executeExpandOnlyMigrations,
  type DatabaseMigrationClient,
} from "./migration-executor.js";

const encoder = new TextEncoder();

type ExtendedStatement = {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly queryMode: "extended";
};

function sqlText(statement: string | ExtendedStatement): string {
  return typeof statement === "string" ? statement : statement.text;
}

async function migration(path: string, sql: string) {
  const body = encoder.encode(sql);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return Object.freeze({
    path,
    body,
    size: body.byteLength,
    digest:
      `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as const,
  });
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu) ?? [], (value) => Number.parseInt(value, 16));
}

function client(input: {
  ledger?: readonly { path: string; sha256: Uint8Array }[];
  catalogs?: readonly (readonly { identity: string; definition: string }[])[];
  captureRow?: { oid: string; eligible: boolean; found: number };
  failSql?: string;
  failError?: unknown;
  failCommit?: boolean;
  failRollback?: boolean;
  insertRowCount?: number;
}) {
  let catalogIndex = 0;
  const ledger = [...(input.ledger ?? [])];
  const query = vi.fn(
    async (statement: string | ExtendedStatement, parameters?: readonly unknown[]) => {
      const sql = sqlText(statement);
      if (sql === input.failSql) throw input.failError ?? new Error("secret database error");
      if (sql === "COMMIT" && input.failCommit)
        throw Object.assign(new Error("lost commit response"), { code: "42P01" });
      if (sql === "ROLLBACK" && input.failRollback) throw new Error("lost rollback response");
      if (sql.startsWith("SELECT path,sha256")) {
        return { rows: [...ledger], rowCount: ledger.length };
      }
      if (sql.startsWith("WITH namespaces AS")) {
        const rows = input.catalogs?.[catalogIndex] ?? [];
        catalogIndex += 1;
        return { rows: [...rows], rowCount: rows.length };
      }
      if (sql.startsWith("SELECT c.oid::text AS oid")) {
        return { rows: [input.captureRow ?? { oid: "42", eligible: true, found: 2 }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO ohmyhost.schema_migrations")) {
        if ((input.insertRowCount ?? 1) === 1)
          ledger.push({ path: String(parameters?.[0]), sha256: bytes(String(parameters?.[1])) });
        return { rows: [], rowCount: input.insertRowCount ?? 1 };
      }
      if (sql === "SELECT clock_timestamp() completed_at") {
        return { rows: [{ completed_at: new Date("2026-08-21T20:00:00.000Z") }], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    },
  );
  return { query, port: { query } as unknown as DatabaseMigrationClient };
}

describe("transactional expand-only migration executor", () => {
  it("applies new files, preserves the baseline catalog, and commits a credential-free receipt", async () => {
    const first = await migration(
      "20260821090000_foundation.sql",
      "create table public.accounts(id bigint);",
    );
    const second = await migration(
      "20260821100000_expand.sql",
      "alter table public.accounts add column name text;",
    );
    const baseline = [{ identity: "relation:public.existing", definition: "r:p:" }];
    const expanded = [...baseline, { identity: "relation:public.accounts", definition: "r:p:" }];
    // One catalog snapshot before the first new file and one after each applied file.
    const runtime = client({ catalogs: [baseline, expanded, expanded] });

    await expect(executeExpandOnlyMigrations(runtime.port, [first, second])).resolves.toEqual({
      appliedPaths: [first.path, second.path],
      replayedPaths: [],
      completedAt: "2026-08-21T20:00:00.000Z",
    });
    expect(runtime.query).toHaveBeenCalledWith("BEGIN");
    expect(runtime.query).toHaveBeenCalledWith({
      text: new TextDecoder().decode(first.body),
      values: [],
      queryMode: "extended",
    });
    expect(
      runtime.query.mock.calls.find(([sql]) => sqlText(sql).startsWith("WITH namespaces AS"))?.[0],
    ).toContain("c.relkind::text");
    expect(runtime.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("replays an exact ledger prefix without executing SQL again", async () => {
    const file = await migration(
      "20260821090000_foundation.sql",
      "create table public.accounts(id bigint);",
    );
    const runtime = client({
      ledger: [{ path: file.path, sha256: bytes(file.digest.slice(7)) }],
      catalogs: [[], []],
    });

    await expect(executeExpandOnlyMigrations(runtime.port, [file])).resolves.toMatchObject({
      appliedPaths: [],
      replayedPaths: [file.path],
    });
    expect(runtime.query).not.toHaveBeenCalledWith({
      text: new TextDecoder().decode(file.body),
      values: [],
      queryMode: "extended",
    });
  });

  it("rolls back ledger drift, catalog mutation, SQL failure, and stale insert claims", async () => {
    const file = await migration(
      "20260821090000_foundation.sql",
      "create table public.accounts(id bigint);",
    );
    const cases = [
      [
        client({ ledger: [{ path: file.path, sha256: new Uint8Array(32).fill(9) }] }),
        "ledger_conflict",
        file.path,
      ],
      [
        client({
          ledger: [
            { path: file.path, sha256: bytes(file.digest.slice(7)) },
            { path: "20260821100000_removed.sql", sha256: new Uint8Array(32).fill(9) },
          ],
        }),
        "ledger_conflict",
        "20260821100000_removed.sql",
      ],
      [
        client({
          catalogs: [
            [{ identity: "column:public.existing.id", definition: "bigint:false::" }],
            [{ identity: "column:public.existing.id", definition: "text:false::" }],
          ],
        }),
        "catalog_changed",
        file.path,
      ],
      [client({ failSql: new TextDecoder().decode(file.body) }), "uncertain", null],
      [client({ catalogs: [[], []], insertRowCount: 0 }), "ledger_conflict", file.path],
      [client({ failSql: "SET LOCAL lock_timeout = '5s'" }), "uncertain", null],
    ] as const;
    for (const [runtime, reason, path] of cases) {
      const error = await executeExpandOnlyMigrations(runtime.port, [file]).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DatabaseMigrationExecutionError);
      expect(error).toMatchObject({ reason, path });
      expect(JSON.stringify(error)).not.toContain("secret database error");
      expect(runtime.query).toHaveBeenCalledWith("ROLLBACK");
    }
  });

  it("names the file static admission refuses and opens no transaction for a structural refusal", async () => {
    const foundation = await migration(
      "20260821090000_foundation.sql",
      "create table public.accounts(id bigint);",
    );
    const destructive = await migration(
      "20260821100000_cleanup.sql",
      "drop table public.accounts;",
    );
    // The SQL policy is decided under the migrations lock, against the ledger, so the refusal rolls back.
    const fresh = client({});
    await expect(
      executeExpandOnlyMigrations(fresh.port, [foundation, destructive]),
    ).rejects.toMatchObject({ reason: "not_admitted", path: destructive.path });
    expect(fresh.query).toHaveBeenCalledWith("ROLLBACK");
    expect(fresh.query).not.toHaveBeenCalledWith("COMMIT");
    // A repeated or reordered file is admissible on its own; only the set is refused, so no file is named.
    const runtime = client({});
    await expect(
      executeExpandOnlyMigrations(runtime.port, [foundation, foundation]),
    ).rejects.toMatchObject({ reason: "not_admitted", path: null });
    await expect(
      executeExpandOnlyMigrations(runtime.port, [destructive, foundation]),
    ).rejects.toMatchObject({ reason: "not_admitted", path: null });
    expect(runtime.query).not.toHaveBeenCalled();
  });

  it("replays an applied file today's SQL policy would refuse, but admits only the pending files by policy", async () => {
    const historical = await migration(
      "20260821090000_historical.sql",
      "drop table public.accounts;",
    );
    const pending = await migration(
      "20260821100000_expand.sql",
      "alter table public.accounts add column name text;",
    );
    const refused = await migration("20260821110000_cleanup.sql", "drop table public.accounts;");
    const applied = [{ path: historical.path, sha256: bytes(historical.digest.slice(7)) }];

    const replay = client({ ledger: applied });
    await expect(
      executeExpandOnlyMigrations(replay.port, [historical, pending]),
    ).resolves.toMatchObject({ appliedPaths: [pending.path], replayedPaths: [historical.path] });
    expect(replay.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "drop table public.accounts;" }),
    );
    expect(replay.query).toHaveBeenLastCalledWith("COMMIT");

    // A pending file keeps the current policy, names its own path and leaves nothing applied.
    const policy = client({ ledger: applied });
    await expect(
      executeExpandOnlyMigrations(policy.port, [historical, refused]),
    ).rejects.toMatchObject({ reason: "not_admitted", path: refused.path });
    expect(policy.query).toHaveBeenCalledWith("ROLLBACK");
    expect(policy.query).not.toHaveBeenCalledWith(expect.stringMatching(/^INSERT INTO/u));

    // The bypass needs the exact ledger file: an edited, dropped or newly inserted earlier file is a conflict.
    const edited = await migration(historical.path, "drop table public.accounts; -- edited");
    const earlier = await migration("20260821080000_earlier.sql", "create table public.a(id int);");
    for (const [bundle, path] of [
      [[edited, pending], historical.path],
      [[pending], historical.path],
      [[earlier, historical, pending], historical.path],
    ] as const) {
      const drift = client({ ledger: applied });
      await expect(executeExpandOnlyMigrations(drift.port, bundle)).rejects.toMatchObject({
        reason: "ledger_conflict",
        path,
      });
      expect(drift.query).toHaveBeenCalledWith("ROLLBACK");
    }
  });

  it("reports a lost COMMIT response as uncertain without issuing rollback", async () => {
    const file = await migration(
      "20260821090000_foundation.sql",
      "create table public.accounts(id bigint);",
    );
    const runtime = client({ catalogs: [[], []], failCommit: true });

    await expect(executeExpandOnlyMigrations(runtime.port, [file])).rejects.toMatchObject({
      reason: "uncertain",
    });
    expect(runtime.query).not.toHaveBeenCalledWith("ROLLBACK");
  });

  it("reports only a safe SQLSTATE and the one-based failed statement of the customer file", async () => {
    const first = "create table public.accounts(id bigint);";
    const second = "alter table public.missing add column name text;";
    const file = await migration("20260821090000_foundation.sql", `${first}\n${second}`);
    for (const [code, expected] of [
      ["42P01", true],
      ["42p01", false],
      ["42P01 private data", false],
      ["08007", false],
      ["57P01", false],
      ["EPIPE", false],
      ["ECONNRESET", false],
      [undefined, false],
    ] as const) {
      const runtime = client({
        failSql: second,
        failError: Object.assign(new Error("secret SQL and parameters"), {
          code,
          ...(code === "EPIPE" || code === "ECONNRESET" || code === undefined
            ? {}
            : { name: "error", severity: "ERROR" }),
        }),
      });
      const error = await executeExpandOnlyMigrations(runtime.port, [file]).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DatabaseMigrationExecutionError);
      if (!(error instanceof DatabaseMigrationExecutionError)) throw new Error("unexpected result");
      expect(error).toMatchObject(
        expected
          ? { reason: "execution_failed", path: file.path, statementIndex: 2, sqlstate: "42P01" }
          : { reason: "uncertain", path: null },
      );
      if (!expected) {
        expect(error.sqlstate).toBeUndefined();
        expect(error.statementIndex).toBeUndefined();
      }
      expect(JSON.stringify(error)).not.toMatch(/secret|alter table|parameters/iu);
      expect(runtime.query).toHaveBeenCalledWith("ROLLBACK");
    }
    const lostRollback = client({
      failSql: second,
      failError: Object.assign(new Error("server error"), {
        code: "42P01",
        name: "error",
        severity: "ERROR",
      }),
      failRollback: true,
    });
    await expect(executeExpandOnlyMigrations(lostRollback.port, [file])).rejects.toMatchObject({
      reason: "uncertain",
      path: null,
    });
  });

  it.each([
    ["column:42:2", "text:true:::"],
    ["column:42:2", "text:false:::now()"],
    ["constraint:42:99", "CHECK (value > 0)"],
    ["trigger:42:99", "CREATE TRIGGER changed"],
    ["index:99", "parent=42|CREATE UNIQUE INDEX changed ON existing(value)"],
  ])("rejects breaking new catalog attachment %s", async (identity, definition) => {
    const file = await migration(
      "20260821090000_foundation.sql",
      "create table public.additive(id bigint);",
    );
    const baseline = [{ identity: "relation:42", definition: "public.existing:r:p:" }];
    const runtime = client({ catalogs: [baseline, [...baseline, { identity, definition }]] });

    await expect(executeExpandOnlyMigrations(runtime.port, [file])).rejects.toMatchObject({
      reason: "catalog_changed",
      path: file.path,
    });
    expect(runtime.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("names the first new file whose change breaks the existing catalog", async () => {
    const additive = await migration(
      "20260821090000_additive.sql",
      "create table public.additive(id bigint);",
    );
    const breaking = await migration(
      "20260821100000_breaking.sql",
      "alter table public.existing add column flag boolean not null default false;",
    );
    const baseline = [{ identity: "relation:42", definition: "public.existing:r:p:" }];
    const added = [...baseline, { identity: "relation:43", definition: "public.additive:r:p:" }];
    const broken = [...added, { identity: "column:42:2", definition: "boolean:true:::false" }];
    const runtime = client({ catalogs: [baseline, added, broken] });

    await expect(
      executeExpandOnlyMigrations(runtime.port, [additive, breaking]),
    ).rejects.toMatchObject({ reason: "catalog_changed", path: breaking.path });
  });

  it("rejects invalid clients and changed verified digests before BEGIN", async () => {
    const file = await migration(
      "20260821090000_foundation.sql",
      "create table public.accounts(id bigint);",
    );
    await expect(executeExpandOnlyMigrations({} as never, [file])).rejects.toThrow(
      "Migration client is invalid",
    );
    const runtime = client({});
    await expect(
      executeExpandOnlyMigrations(runtime.port, [{ ...file, digest: `sha256:${"0".repeat(64)}` }]),
    ).rejects.toThrow("Verified migration digest is invalid");
    expect(runtime.query).not.toHaveBeenCalledWith("BEGIN");
  });
});

describe("PGCF capture trigger execution", () => {
  const capture =
    "CREATE TRIGGER orders_capture AFTER INSERT OR UPDATE OR DELETE ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'total');";
  const orders = [{ identity: "relation:42", definition: "public.orders:r:p:" }];
  const captured = [
    ...orders,
    {
      identity: "trigger:42:77",
      definition:
        "CREATE TRIGGER orders_capture AFTER INSERT OR DELETE OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'total')",
    },
  ];

  it("verifies the target before running the capture trigger and then admits exactly that trigger", async () => {
    const file = await migration("20261101090000_capture.sql", capture);
    const runtime = client({ catalogs: [orders, captured] });

    await executeExpandOnlyMigrations(runtime.port, [file]);

    const calls = runtime.query.mock.calls.map(([sql]) => sqlText(sql));
    const verification = calls.findIndex((sql) => sql.startsWith("SELECT c.oid::text AS oid"));
    expect(verification).toBeGreaterThanOrEqual(0);
    expect(verification).toBeLessThan(calls.findIndex((sql) => sql.startsWith("CREATE TRIGGER")));
    expect(runtime.query.mock.calls[verification]?.[1]).toEqual([
      "public",
      "orders",
      ["id", "total"],
    ]);
    expect(calls).not.toContain("ROLLBACK");
  });

  it("refuses a target that is not eligible or lacks a column before the trigger runs", async () => {
    const file = await migration("20261101090000_capture.sql", capture);
    for (const captureRow of [
      { oid: "42", eligible: false, found: 2 },
      { oid: "42", eligible: true, found: 1 },
    ]) {
      const runtime = client({ catalogs: [orders, captured], captureRow });
      await expect(executeExpandOnlyMigrations(runtime.port, [file])).rejects.toMatchObject({
        reason: "not_admitted",
        path: file.path,
      });
      expect(runtime.query).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringMatching(/^CREATE TRIGGER/u) }),
      );
      expect(runtime.query).toHaveBeenCalledWith("ROLLBACK");
    }
  });

  it("refuses a capture trigger that lands on another existing relation", async () => {
    const file = await migration("20261101090000_capture.sql", capture);
    const runtime = client({
      catalogs: [
        [...orders, { identity: "relation:43", definition: "public.other:r:p:" }],
        [
          ...orders,
          { identity: "relation:43", definition: "public.other:r:p:" },
          { identity: "trigger:43:77", definition: captured[1]?.definition ?? "" },
        ],
      ],
    });
    await expect(executeExpandOnlyMigrations(runtime.port, [file])).rejects.toMatchObject({
      reason: "catalog_changed",
      path: file.path,
    });
  });

  it("refuses a trigger on the verified relation whose definition is not the capture form", async () => {
    const file = await migration("20261101090000_capture.sql", capture);
    const runtime = client({
      catalogs: [
        orders,
        [
          ...orders,
          {
            identity: "trigger:42:77",
            definition:
              "CREATE TRIGGER orders_capture BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION public.f()",
          },
        ],
      ],
    });
    await expect(executeExpandOnlyMigrations(runtime.port, [file])).rejects.toMatchObject({
      reason: "catalog_changed",
      path: file.path,
    });
  });

  it("keeps an ordinary trigger on an existing relation refused, now driven by a real statement", async () => {
    const file = await migration(
      "20261101090000_audit.sql",
      "create trigger audit after insert on public.orders for each row execute function public.audit();",
    );
    const runtime = client({
      catalogs: [
        orders,
        [...orders, { identity: "trigger:42:88", definition: "CREATE TRIGGER audit ..." }],
      ],
    });
    await expect(executeExpandOnlyMigrations(runtime.port, [file])).rejects.toMatchObject({
      reason: "catalog_changed",
      path: file.path,
    });
  });

  it("keeps constraints on an existing relation refused even when the capture target is allowed", async () => {
    const file = await migration("20261101090000_capture.sql", capture);
    const runtime = client({
      catalogs: [
        orders,
        [...orders, { identity: "constraint:42:99", definition: "CHECK (total > 0)" }],
      ],
    });
    await expect(executeExpandOnlyMigrations(runtime.port, [file])).rejects.toMatchObject({
      reason: "catalog_changed",
      path: file.path,
    });
  });
});
