import { describe, expect, it } from "vitest";

import {
  DatabaseMigrationAdmissionError,
  admitExpandOnlyMigrations,
  parseDatabaseMigrationStatements,
} from "../src/database-migration-admission.js";

const encoder = new TextEncoder();

function migration(path: string, sql: string) {
  return Object.freeze({ path, body: encoder.encode(sql) });
}

function admissionOutcome(sql: string): DatabaseMigrationAdmissionError | "admitted" {
  try {
    admitExpandOnlyMigrations([migration("20260825090000_candidate.sql", sql)]);
    return "admitted";
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseMigrationAdmissionError);
    return error as DatabaseMigrationAdmissionError;
  }
}

function captureAdmissionError(sql: string): DatabaseMigrationAdmissionError {
  try {
    admitExpandOnlyMigrations([migration("20260825090000_candidate.sql", sql)]);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseMigrationAdmissionError);
    return error as DatabaseMigrationAdmissionError;
  }
  throw new Error("Expected database migration admission to fail");
}

describe("database migration admission public contract", () => {
  it("admits opt-in case-insensitive text and tree paths only in the extensions schema", () => {
    const sql =
      "CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA extensions;";
    expect(parseDatabaseMigrationStatements(sql)).toHaveLength(2);
    expect(
      captureAdmissionError("CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA public;"),
    ).toMatchObject({ reason: "unsupported" });
    expect(captureAdmissionError("CREATE EXTENSION IF NOT EXISTS citext;")).toMatchObject({
      reason: "unsupported",
    });
  });

  it("admits opt-in trigram search in the controlled extensions schema", () => {
    const sql = `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE INDEX product_name_trgm ON public.products USING gin (name extensions.gin_trgm_ops);`;

    expect(parseDatabaseMigrationStatements(sql)).toHaveLength(2);
    for (const declaration of [
      "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;",
      "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
      "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions CASCADE;",
    ]) {
      expect(captureAdmissionError(declaration)).toMatchObject({ reason: "unsupported" });
    }
  });

  it("admits native application policies and preserves SQL and exact policy targets", () => {
    const statements = [
      `/* outer /* nested ; */ comment */ create policy "own; rows" on public."Account" as permissive for select to public using (owner_id = ohmyhost.user_id() and (ohmyhost.claims()->>'role') = 'member; -- literal');`,
      `create policy insert_own on private.accounts as restrictive for insert with check (owner_id = ohmyhost.user_id());`,
      `create policy update_own on public.accounts for update using (owner_id = ohmyhost.user_id()) with check ((ohmyhost.claims()->>'tenant') = tenant_id);`,
      `create policy delete_own on public.accounts for delete using (owner_id = ohmyhost.user_id());`,
      `create policy all_rows on public.accounts for all using (note = E'it\\'s ; fine' or note = $value$ohmyhost; auth.uid()$value$);`,
      `create policy defaults on public.accounts;`,
      `alter policy update_own on public.accounts to public using (owner_id = "ohmyhost"."user_id"()) with check (true);`,
      `alter policy insert_own on private.accounts with check (true);`,
      `drop policy if exists "own; rows" on public."Account" restrict;`,
      `drop policy defaults on public.accounts;`,
      `alter table public.accounts enable row level security;`,
      `alter table private.accounts force row level security;`,
    ];
    const sql = `${statements.join("\n")}\n-- trailing comment`;
    const parsed = parseDatabaseMigrationStatements(sql);

    expect(parsed.map((statement) => statement.sql)).toEqual(statements);
    expect(parsed.map((statement) => statement.rlsTarget)).toEqual([
      { schema: "public", table: "Account", policy: "own; rows", action: "create" },
      { schema: "private", table: "accounts", policy: "insert_own", action: "create" },
      { schema: "public", table: "accounts", policy: "update_own", action: "create" },
      { schema: "public", table: "accounts", policy: "delete_own", action: "create" },
      { schema: "public", table: "accounts", policy: "all_rows", action: "create" },
      { schema: "public", table: "accounts", policy: "defaults", action: "create" },
      { schema: "public", table: "accounts", policy: "update_own", action: "alter" },
      { schema: "private", table: "accounts", policy: "insert_own", action: "alter" },
      { schema: "public", table: "Account", policy: "own; rows", action: "drop" },
      { schema: "public", table: "accounts", policy: "defaults", action: "drop" },
      { schema: "public", table: "accounts", action: "enable" },
      { schema: "private", table: "accounts", action: "force" },
    ]);
    for (const continuation of ["\n", " -- same escape mode\n"]) {
      const continuedSql = `create table public.escape_notes(note text default E'first'${continuation}'it\\'s ; safe'\n'last');`;
      expect(parseDatabaseMigrationStatements(continuedSql)).toEqual([{ sql: continuedSql }]);
    }
    expect(
      admitExpandOnlyMigrations([migration("20261008090000_native_rls.sql", sql)]),
    ).toMatchObject({ statementCount: statements.length });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    expect(Object.isFrozen(parsed[0]?.rlsTarget)).toBe(true);
    expect(
      parseDatabaseMigrationStatements(
        `-- generated by Supabase\ncreate table public.notes(note text default 'auth.uid(); ohmyhost');`,
      ),
    ).toEqual([
      {
        sql: `-- generated by Supabase\ncreate table public.notes(note text default 'auth.uid(); ohmyhost');`,
      },
    ]);
  });

  it("rejects RLS weakening, unsupported policy forms, reserved objects and malformed lexical input", () => {
    for (const sql of [
      "alter table public.accounts disable row level security;",
      "alter table public.accounts no force row level security;",
      "alter table public.accounts enable row level security, add column x text;",
      "alter table only public.accounts enable row level security;",
      "create policy p on accounts using (true);",
      'create policy p on auth."user" using (true);',
      'create policy p on auth."rateLimit" using (true);',
      "create policy p on extensions.accounts using (true);",
      "create policy p on public.accounts to custom_role using (true);",
      "create policy p on public.accounts to public, custom_role using (true);",
      "create policy p on public.accounts as invalid using (true);",
      "create policy p on public.accounts for truncate using (true);",
      "alter policy p on public.accounts rename to q;",
      "alter policy p on public.accounts to public;",
      "drop policy p on public.accounts cascade;",
      "create policy p on public.accounts using (ohmyhost.user_id(1) = owner_id);",
      "create policy p on public.accounts using (ohmyhost.claims = claims);",
      "create policy p on public.accounts using (ohmyhost.other() = owner_id);",
      "create policy p on public.accounts using (exists(select 1 from ohmyhost.schema_migrations));",
      "create policy p on ohmyhost.schema_migrations using (true);",
      "create function ohmyhost.user_id() returns text language sql as $$ select 'x' $$;",
      "create function public.f() returns void language sql as $$ delete from ohmyhost.schema_migrations $$;",
      "create function public.f() returns text language sql as $$ select auth.uid() $$;",
      'create function public.f() returns text language sql as $$ select "auth".uid() $$;',
      'create function public.f() returns text language sql as $$ select U&"ohmy\\0068ost".user_id() $$;',
      "create function public.f() returns void language plpgsql as $$ begin alter table public.accounts disable row level security; end $$;",
      'create policy p on public.accounts using (U&"ohmy\\0068ost".user_id() = owner_id);',
      "create policy p on public.accounts using ();",
      "create policy p on public.accounts using ((true);",
      "create policy p on public.accounts using (true));",
      "create policy p on public.accounts using ('unterminated);",
      "create policy p on public.accounts using ($tag$unterminated);",
      "create policy p on public.accounts using (true /* nested /* open */);",
      `create policy p on public."${"a".repeat(64)}" using (true);`,
      "create policy p on public.accounts using (true); commit;",
      "CREATE TABLE public.escape_probe(note text DEFAULT E''\n'\\')'); COMMIT; -- '\n;",
      "CREATE TABLE public.escape_probe(note text DEFAULT E'' -- continued\n'\\')'); COMMIT; -- '\n;",
    ]) {
      expect(() => parseDatabaseMigrationStatements(sql), sql).toThrow(
        DatabaseMigrationAdmissionError,
      );
    }
    // PostgreSQL truncates an unquoted name to 63 bytes as it does a quoted one, so the lexer refuses it as invalid,
    // counting UTF-8 bytes; 63 bytes is still a word.
    expect(captureAdmissionError(`create table public.t (${"a".repeat(64)} int);`)).toMatchObject({
      reason: "invalid",
    });
    expect(captureAdmissionError(`create table public.t (${"é".repeat(32)} int);`)).toMatchObject({
      reason: "invalid",
    });
    expect(() =>
      parseDatabaseMigrationStatements(`create table public.t (${"a".repeat(63)} int);`),
    ).not.toThrow();
    for (const sql of [
      "create policy p on public.accounts using (auth.uid() = owner_id);",
      'create policy p on public.accounts using ("auth".uid() = owner_id);',
      'create policy p on public.accounts using (auth."uid"() = owner_id);',
      "create policy p on public.accounts using (auth.jwt()->>'sub' = owner_id);",
      "create policy p on public.accounts using (exists(select 1 from storage.objects));",
      "create policy p on public.accounts to authenticated using (true);",
    ])
      expect(captureAdmissionError(sql)).toMatchObject({ reason: "provider_specific" });
    expect(() => parseDatabaseMigrationStatements("; -- only a comment")).toThrow(
      DatabaseMigrationAdmissionError,
    );
  });

  it("refuses a whitespace-filled quoted identifier within bounded time", () => {
    const started = performance.now();
    const outcome = admissionOutcome(`create table "${" ".repeat(250_000)}" (a int);`);
    const elapsed = performance.now() - started;
    expect(outcome).toMatchObject({ reason: "invalid" });
    expect(elapsed).toBeLessThan(200);
  });

  it("reads non-ASCII dollar tags and whitespace as PostgreSQL does, so no statement hides behind them", () => {
    for (const sql of [
      "create table public.t as select $é$ -- $é$; delete from public.accounts;\n",
      "create table public.t as select $ $ -- $ $; delete from public.accounts;\n",
    ]) {
      expect(captureAdmissionError(sql)).toMatchObject({ reason: "destructive" });
    }
  });

  it("admits additive ALTER TABLE names the way CREATE TABLE does, and refuses every other action", () => {
    for (const sql of [
      "alter table if exists public.accounts add column note text;",
      'alter table public."user-data" add column note text;',
      "alter table größe add column note text;",
      "alter table public.accounts add column tags text[] default array['a','b'];",
      "alter table public.accounts add column grid int[] default array[1,2];",
    ]) {
      expect(() => parseDatabaseMigrationStatements(sql), sql).not.toThrow();
    }
    for (const sql of [
      "alter table public.accounts drop column if exists note;",
      "alter table public.accounts add column x text, drop column y;",
      "alter table public.accounts add column x text, alter column y type int;",
      "alter table public.accounts add column x int), drop column y;",
      "alter table public.accounts add column x int], drop column y;",
      "alter table public.accounts add column x int [, drop column y;",
    ]) {
      expect(captureAdmissionError(sql), sql).toMatchObject({ reason: "destructive" });
    }
  });

  it("admits ordered expand-only PostgreSQL while preserving semicolons inside SQL literals", () => {
    const admission = admitExpandOnlyMigrations([
      migration(
        "20260825090000_auth_foundation.sql",
        `-- portable Better Auth schema
create schema if not exists auth;
/* additive table */
create table auth."user" (
  id uuid primary key,
  note text default ';'
);
create table auth."rateLimit" ("id" uuid primary key, "count" integer);
create function public.normalize_note(value text) returns text
language plpgsql
security definer
set search_path to ''
as $body$
begin
  return value || ';';
end;
$body$;
`,
      ),
      migration(
        "20260825100000_auth_expand.sql",
        `alter table auth."user" add column if not exists display_name text;
create unique index auth_user_display_name_uidx on auth."user"(display_name);
comment on table auth."user" is 'portable auth table';
`,
      ),
    ]);

    expect(admission).toEqual({
      files: [
        { path: "20260825090000_auth_foundation.sql", statementCount: 4 },
        { path: "20260825100000_auth_expand.sql", statementCount: 3 },
      ],
      statementCount: 7,
    });
    expect(Object.isFrozen(admission)).toBe(true);
    expect(Object.isFrozen(admission.files)).toBe(true);
  });

  it("rejects Supabase-specific SQL with stable provider-specific error details", () => {
    const error = captureAdmissionError(
      "create policy tenant_read on public.accounts for select using (auth.uid() = owner_id);",
    );

    expect(error).toMatchObject({
      name: "DatabaseMigrationAdmissionError",
      message: "Database migration is not admitted",
      code: "database_migration_not_admitted",
      reason: "provider_specific",
    });
  });

  it("rejects destructive SQL with stable destructive error details", () => {
    const error = captureAdmissionError("drop table public.accounts;");

    expect(error).toMatchObject({
      code: "database_migration_not_admitted",
      reason: "destructive",
    });
  });

  it("rejects unsafe security-definer functions with stable unsupported error details", () => {
    const error = captureAdmissionError(
      "create function public.lookup() returns integer language sql security definer as $$ select 1 $$;",
    );

    expect(error).toMatchObject({
      code: "database_migration_not_admitted",
      reason: "unsupported",
    });
  });

  it("refuses a security-definer function when any of its search_path settings is unpinned, and names the required value", () => {
    const error = captureAdmissionError(
      "create function public.lookup() returns integer language sql security definer set search_path to '' set search_path = public as $$ select 1 $$;",
    );

    expect(error).toMatchObject({
      code: "database_migration_not_admitted",
      reason: "unsupported",
    });
    expect(error.message).toContain("pg_catalog");
    expect(error.message).toContain("''");
  });

  it.each([
    ["no search_path at all", "security definer as $$ select 1 $$"],
    [
      "a search_path the session can change",
      "security definer set search_path to public as $$ select 1 $$",
    ],
    [
      "a quoted user-controlled path first",
      `security definer set search_path = "$user", public as $$ select 1 $$`,
    ],
    [
      "a search_path that starts with a customer schema",
      "security definer set search_path = public, pg_catalog as $$ select 1 $$",
    ],
    [
      "a pg_catalog name only inside a longer identifier",
      "security definer set search_path = pg_catalog_shadow as $$ select 1 $$",
    ],
  ])("rejects a security-definer function with %s", (_label, options) => {
    const error = captureAdmissionError(
      `create function public.lookup() returns integer language sql ${options};`,
    );

    expect(error).toMatchObject({
      code: "database_migration_not_admitted",
      reason: "unsupported",
    });
  });

  it.each([
    ["an empty pinned path", "set search_path to ''"],
    ["an equals-sign empty pinned path", "set search_path = ''"],
    ["a pg_catalog-first pinned path", "set search_path = pg_catalog, public"],
    ["a quoted pg_catalog-first pinned path", "set search_path to 'pg_catalog'"],
  ])("admits a security-definer function with %s", (_label, setting) => {
    expect(() =>
      admitExpandOnlyMigrations([
        migration(
          "20260825090000_definer.sql",
          `create function public.lookup() returns integer language sql security definer ${setting} as $$ select 1 $$;`,
        ),
      ]),
    ).not.toThrow();
  });
});

describe("PGCF capture trigger admission", () => {
  const canonical = `CREATE TRIGGER orders_capture AFTER INSERT OR UPDATE OR DELETE ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'total');`;
  const target = {
    trigger: "orders_capture",
    schema: "public",
    table: "orders",
    operations: ["insert", "update", "delete"],
    columns: ["id", "total"],
  };

  it.each([
    ["the canonical form", canonical, target],
    [
      "lower-case keywords",
      `create trigger orders_capture after insert or update or delete on public.orders for each row execute function pgcf.capture('id', 'total');`,
      target,
    ],
    [
      "quoted names",
      `CREATE TRIGGER "Orders_Capture" AFTER INSERT ON public."Order Items" FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
      {
        trigger: "Orders_Capture",
        schema: "public",
        table: "Order Items",
        operations: ["insert"],
        columns: ["id"],
      },
    ],
    [
      "reordered events",
      `CREATE TRIGGER t AFTER DELETE OR INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
      { ...target, trigger: "t", operations: ["insert", "delete"], columns: ["id"] },
    ],
    [
      "a one-event subset",
      `CREATE TRIGGER t AFTER UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
      { ...target, trigger: "t", operations: ["update"], columns: ["id"] },
    ],
    [
      "the private schema",
      `CREATE TRIGGER t AFTER INSERT ON private.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
      { ...target, trigger: "t", schema: "private", operations: ["insert"], columns: ["id"] },
    ],
    [
      "the auth schema, with a quoted table",
      `CREATE TRIGGER t AFTER INSERT ON auth."user" FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
      {
        ...target,
        trigger: "t",
        schema: "auth",
        table: "user",
        operations: ["insert"],
        columns: ["id"],
      },
    ],
    [
      "comments between tokens",
      `CREATE TRIGGER t /* a */ AFTER INSERT -- b\nON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
      { ...target, trigger: "t", operations: ["insert"], columns: ["id"] },
    ],
  ])("admits %s", (_name, sql, expected) => {
    const [statement] = parseDatabaseMigrationStatements(sql);
    expect(statement?.captureTrigger).toEqual(expected);
    expect(() =>
      admitExpandOnlyMigrations([migration("20261101090000_capture.sql", sql)]),
    ).not.toThrow();
  });

  it("admits 32 columns and two capture statements in one file", () => {
    const columns = Array.from({ length: 32 }, (_, index) => `'c${index}'`).join(", ");
    const statements = parseDatabaseMigrationStatements(
      `CREATE TRIGGER a AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION pgcf.capture(${columns});\nCREATE TRIGGER b AFTER DELETE ON public.u FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]?.captureTrigger?.columns).toHaveLength(32);
    expect(statements[1]?.captureTrigger?.table).toBe("u");
  });

  it.each([
    [
      "BEFORE INSERT",
      "CREATE TRIGGER t BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "INSTEAD OF",
      "CREATE TRIGGER t INSTEAD OF INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "FOR EACH STATEMENT",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH STATEMENT EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "a WHEN clause",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW WHEN (new.id > 1) EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "UPDATE OF",
      "CREATE TRIGGER t AFTER UPDATE OF total ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "REFERENCING",
      "CREATE TRIGGER t AFTER INSERT ON public.orders REFERENCING NEW TABLE AS n FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "EXECUTE PROCEDURE",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE PROCEDURE pgcf.capture('id');",
    ],
    [
      "another pgcf function",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.emit('id');",
    ],
    [
      "no arguments",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture();",
    ],
    [
      "an unquoted argument",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture(id);",
    ],
    [
      "a numeric argument",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture(1);",
    ],
    [
      "an escape-string argument",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture(E'id');",
    ],
    [
      "a dollar-quoted argument",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture($$id$$);",
    ],
    [
      "an argument with a space",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('a b');",
    ],
    [
      "an argument with a quote",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('a\"b');",
    ],
    [
      "an argument starting with a digit",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('1x');",
    ],
    [
      "a duplicate argument",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'id');",
    ],
    [
      "33 arguments",
      `CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture(${Array.from({ length: 33 }, (_, index) => `'c${index}'`).join(", ")});`,
    ],
    [
      "an unqualified table",
      "CREATE TRIGGER t AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "a pgcf table",
      "CREATE TRIGGER t AFTER INSERT ON pgcf.outbox FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "an information_schema table",
      "CREATE TRIGGER t AFTER INSERT ON information_schema.tables FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "a pg_catalog table",
      "CREATE TRIGGER t AFTER INSERT ON pg_catalog.pg_class FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "an ohmyhost table",
      "CREATE TRIGGER t AFTER INSERT ON ohmyhost.schema_migrations FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "CONSTRAINT",
      "CREATE CONSTRAINT TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "OR REPLACE",
      "CREATE OR REPLACE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
    ],
    [
      "a PGCF quoted schema",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION \"PGCF\".capture('id');",
    ],
    [
      "a capture name in other case",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.\"Capture\"('id');",
    ],
    [
      "tokens after the argument list",
      "CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id') WHEN (true);",
    ],
    [
      "a function body",
      "CREATE FUNCTION pgcf.capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;",
    ],
    ["a function drop", "DROP FUNCTION pgcf.emit(text, jsonb);"],
    ["a function owner change", "ALTER FUNCTION pgcf.capture() OWNER TO ohmyho_m_x;"],
    ["a schema rename", "ALTER SCHEMA pgcf RENAME TO p;"],
    ["a schema grant", "GRANT USAGE ON SCHEMA pgcf TO PUBLIC;"],
    ["a table in pgcf", "CREATE TABLE pgcf.t(id int);"],
    ["an index on pgcf", "CREATE INDEX i ON pgcf.outbox(seq);"],
    ["a comment on pgcf", "COMMENT ON FUNCTION pgcf.emit(text, jsonb) IS 'x';"],
    ["a policy calling pgcf", "CREATE POLICY p ON public.t USING (pgcf.emit('a', '{}') > 0);"],
  ])("refuses %s", (_name, sql) => {
    expect(() => parseDatabaseMigrationStatements(sql)).toThrow(DatabaseMigrationAdmissionError);
    expect(captureAdmissionError(sql).reason).toBe("unsupported");
  });

  it("refuses a customer migration under the watch service's reserved trigger name", () => {
    const sql =
      "CREATE TRIGGER pgcf_watch_deadbeef AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');";
    expect(parseDatabaseMigrationStatements(sql)[0]?.captureTrigger?.trigger).toBe(
      "pgcf_watch_deadbeef",
    );
    expect(captureAdmissionError(sql)).toMatchObject({ reason: "unsupported" });
  });

  it("keeps ordinary triggers exactly as before", () => {
    const sql =
      "CREATE TRIGGER t AFTER INSERT ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.audit();";
    expect(parseDatabaseMigrationStatements(sql)).toEqual([{ sql }]);
  });

  it("applies the Supabase reference rules to the capture header", () => {
    expect(
      captureAdmissionError(
        "CREATE TRIGGER t AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');",
      ).reason,
    ).toBe("provider_specific");
  });
});
