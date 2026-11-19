import { describe, expect, it } from "vitest";

import { DatabaseMigrationAdmissionError, admitExpandOnlyMigrations } from "./sql-admission.js";

const encoder = new TextEncoder();

function migration(path: string, sql: string) {
  return Object.freeze({ path, body: encoder.encode(sql) });
}

function admissionError(sql: string): unknown {
  try {
    admitExpandOnlyMigrations([migration("20260821090000_candidate.sql", sql)]);
    return null;
  } catch (error) {
    return error;
  }
}

describe("expand-only database migration admission", () => {
  it("accepts ordered additive PostgreSQL statements without splitting quoted semicolons", () => {
    const result = admitExpandOnlyMigrations([
      migration(
        "20260821090000_foundation.sql",
        `-- additive schema
create schema if not exists extensions;
create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists unaccent with schema extensions;
set check_function_bodies = false;
create table public.accounts(id uuid primary key, note text default ';');
create function public.account_label(value text) returns text language plpgsql security definer set search_path to '' as $$
begin
  return value || ';';
end;
$$;
create constraint trigger accounts_label_guard after insert or update on public.accounts deferrable initially deferred for each row execute function public.account_label();
`,
      ),
      migration(
        "20260821100000_expand.sql",
        `/* semicolon ; inside a comment */
alter table public.accounts add column display_name text;
create index accounts_display_name_idx on public.accounts(display_name);
create unique index accounts_note_uidx on public.accounts(note);
comment on table public.accounts is 'portable';
`,
      ),
    ]);

    expect(result).toEqual({
      files: [
        { path: "20260821090000_foundation.sql", statementCount: 8 },
        { path: "20260821100000_expand.sql", statementCount: 4 },
      ],
      statementCount: 12,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.files)).toBe(true);
  });

  it.each([
    "drop table public.accounts;",
    "alter table public.accounts drop column note;",
    "alter table public.accounts rename column note to memo;",
    "alter table public.accounts alter column note type varchar(20);",
    "alter table public.accounts alter column note set not null;",
    "alter type public.status add value 'archived';",
    "truncate public.accounts;",
    "delete from public.accounts;",
    "update public.accounts set note='x';",
    "insert into public.accounts(id) values (1);",
    "create or replace function public.f() returns void language sql as $$ select 1 $$;",
    "begin; create table public.x(id int); commit;",
    "copy public.accounts to program 'cat';",
    "do $$ begin perform 1; end $$;",
    "call public.refresh_all();",
    "grant select on public.accounts to app;",
    "revoke all on public.accounts from public;",
    "set search_path=public;",
    "create function public.native() returns void language plpython3u as $$ pass $$;",
    "create function public.unsafe() returns void language sql security definer as $$ select 1 $$;",
    "alter table ohmyhost.schema_migrations add column forged text;",
    "create schema if not exists customer_private;",
  ])("rejects destructive or executor-controlled SQL: %s", (sql) => {
    expect(() =>
      admitExpandOnlyMigrations([migration("20260821090000_change.sql", sql)]),
    ).toThrowError(DatabaseMigrationAdmissionError);
  });

  it.each([
    "select auth.uid();",
    "select * from storage.objects;",
    "grant select on public.accounts to authenticated;",
    "revoke all on public.accounts from service_role;",
    "grant select on public.accounts to anon;",
  ])("rejects Supabase-specific identity or authorization SQL: %s", (sql) => {
    const error = admissionError(sql);
    expect(error).toBeInstanceOf(DatabaseMigrationAdmissionError);
    expect(error).toMatchObject({ reason: "provider_specific" });
  });

  it.each([
    "select 'unterminated;",
    'create table "unterminated(id int);',
    "/* unterminated",
    "create function public.f() returns void language sql as $body$ select 1;",
  ])("rejects malformed lexical boundaries: %s", (sql) => {
    expect(admissionError(sql)).toMatchObject({ reason: "invalid" });
  });

  it("rejects unordered, duplicate, noncanonical, empty, and oversized migration inventories", () => {
    const valid = migration("20260821090000_valid.sql", "create table public.valid(id int);\n");
    for (const input of [
      [migration("20260821100000_second.sql", "create table public.b(id int);\n"), valid],
      [valid, valid],
      [migration("invalid.sql", "create table public.invalid(id int);\n")],
      [migration("20260821090000_empty.sql", "")],
      [migration("20260821090000_crlf.sql", "create table public.x(id int);\r\n")],
      [
        Object.freeze({
          path: "20260821090000_large.sql",
          body: new Uint8Array(256 * 1024 + 1).fill(97),
        }),
      ],
    ]) {
      expect(() => admitExpandOnlyMigrations(input)).toThrowError(DatabaseMigrationAdmissionError);
    }
  });
});
