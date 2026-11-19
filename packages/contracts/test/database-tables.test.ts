import { expect, it } from "vitest";
import { admitExpandOnlyMigrations } from "../src/database-migration-admission.js";
import { PROBLEM_POLICY } from "../src/problem-policy.js";
import {
  DATABASE_TABLE_COLUMN_TYPES,
  assertDatabaseTableCreated,
  isDatabaseTableIdentifier,
  parseDatabaseTableCreateRequest,
  renderCreateTableStatement,
} from "../src/database-tables.js";

const encoder = new TextEncoder();

function column(overrides: Record<string, unknown>) {
  return { name: "value", type: "text", ...overrides };
}

function request(overrides: Record<string, unknown> = {}) {
  return { table: "orders", columns: [column({ name: "id", type: "bigint" })], ...overrides };
}

it("parses a minimal request into normalized columns with an empty primary key", () => {
  expect(parseDatabaseTableCreateRequest(request())).toEqual({
    table: "orders",
    columns: [{ name: "id", type: "bigint", nullable: true, identity: false, default: null }],
    primaryKey: [],
  });
});

it("accepts every closed column type and nothing else", () => {
  expect(DATABASE_TABLE_COLUMN_TYPES).toEqual([
    "text",
    "integer",
    "bigint",
    "boolean",
    "numeric",
    "double precision",
    "timestamptz",
    "date",
    "uuid",
    "jsonb",
  ]);
  for (const type of DATABASE_TABLE_COLUMN_TYPES) {
    expect(() =>
      parseDatabaseTableCreateRequest(request({ columns: [column({ type })] })),
    ).not.toThrow();
  }
  expect(() =>
    parseDatabaseTableCreateRequest(request({ columns: [column({ type: "varchar" })] })),
  ).toThrow(TypeError);
});

it("renders one CREATE TABLE statement with quoted identifiers for every type", () => {
  const sql = renderCreateTableStatement({
    table: "everything",
    columns: DATABASE_TABLE_COLUMN_TYPES.map((type, index) => ({
      name: `c${index}`,
      type,
      nullable: true,
      identity: false,
      default: null,
    })),
    primaryKey: [],
  });
  expect(sql).toBe(
    'CREATE TABLE "public"."everything" ("c0" text, "c1" integer, "c2" bigint, "c3" boolean, "c4" numeric, "c5" double precision, "c6" timestamptz, "c7" date, "c8" uuid, "c9" jsonb)',
  );
  expect(() =>
    admitExpandOnlyMigrations([
      { path: "20261101090000_everything.sql", body: encoder.encode(sql) },
    ]),
  ).not.toThrow();
});

it("renders identity columns as NOT NULL GENERATED ALWAYS AS IDENTITY", () => {
  const parsed = parseDatabaseTableCreateRequest(
    request({ columns: [column({ name: "id", type: "integer", identity: true })] }),
  );
  expect(parsed.columns[0]).toMatchObject({ nullable: false, identity: true, default: null });
  expect(renderCreateTableStatement(parsed)).toBe(
    'CREATE TABLE "public"."orders" ("id" integer NOT NULL GENERATED ALWAYS AS IDENTITY)',
  );
});

it("renders the now and uuid defaults and keeps nullable columns nullable", () => {
  const parsed = parseDatabaseTableCreateRequest(
    request({
      columns: [
        column({ name: "created_at", type: "timestamptz", default: "now", nullable: false }),
        column({ name: "token", type: "uuid", default: "uuid" }),
      ],
    }),
  );
  expect(renderCreateTableStatement(parsed)).toBe(
    'CREATE TABLE "public"."orders" ("created_at" timestamptz NOT NULL DEFAULT now(), "token" uuid DEFAULT gen_random_uuid())',
  );
});

it("renders a composite primary key in request order and forces its columns NOT NULL", () => {
  const parsed = parseDatabaseTableCreateRequest(
    request({
      columns: [column({ name: "a", type: "text" }), column({ name: "b", type: "date" })],
      primaryKey: ["b", "a"],
    }),
  );
  expect(parsed.columns.map((item) => item.nullable)).toEqual([false, false]);
  expect(renderCreateTableStatement(parsed)).toBe(
    'CREATE TABLE "public"."orders" ("a" text NOT NULL, "b" date NOT NULL, PRIMARY KEY ("b","a"))',
  );
});

it("renders only validated identifiers, so a hostile identifier cannot reach the statement", () => {
  for (const name of ['a"b', "a b", "Orders", "1orders", "pg_hidden", "select", "x;drop"]) {
    expect(isDatabaseTableIdentifier(name)).toBe(false);
    expect(() =>
      renderCreateTableStatement({
        table: name,
        columns: [{ name: "id", type: "text", nullable: true, identity: false, default: null }],
        primaryKey: [],
      }),
    ).toThrow(TypeError);
  }
});

it("accepts identifiers of the documented shape only", () => {
  expect(isDatabaseTableIdentifier("a")).toBe(true);
  expect(isDatabaseTableIdentifier("_order_2")).toBe(true);
  expect(isDatabaseTableIdentifier("a".repeat(63))).toBe(true);
  expect(isDatabaseTableIdentifier("a".repeat(64))).toBe(false);
  expect(isDatabaseTableIdentifier("pg_catalog")).toBe(false);
  expect(isDatabaseTableIdentifier("user")).toBe(false);
  expect(isDatabaseTableIdentifier(42)).toBe(false);
});

it("refuses every malformed request with a closed TypeError", () => {
  const invalid: unknown[] = [
    null,
    "orders",
    [],
    request({ schema: "public" }),
    request({ table: "Orders" }),
    request({ table: "pg_orders" }),
    request({ table: 7 }),
    request({ columns: [] }),
    request({ columns: Array.from({ length: 65 }, (_, index) => column({ name: `c${index}` })) }),
    request({ columns: [column({ name: "id" }), column({ name: "id" })] }),
    request({ columns: [column({ name: "id", extra: true })] }),
    request({ columns: [column({ name: "id", nullable: "yes" })] }),
    request({ columns: [column({ name: "id", identity: "yes" })] }),
    request({ columns: [column({ name: "id", default: "current" })] }),
    request({ columns: [column({ name: "id", type: "text", identity: true })] }),
    request({
      columns: [
        column({ name: "a", type: "integer", identity: true }),
        column({ name: "b", type: "bigint", identity: true }),
      ],
    }),
    request({ columns: [column({ name: "n", type: "integer", default: "now" })] }),
    request({ columns: [column({ name: "t", type: "timestamptz", default: "uuid" })] }),
    request({ columns: [column({ name: "id", type: "integer", identity: true, default: "now" })] }),
    request({ columns: [column({ name: "id", type: "integer", identity: true, nullable: true })] }),
    request({ primaryKey: [] }),
    request({ primaryKey: ["missing"] }),
    request({ primaryKey: ["id", "id"] }),
    request({ primaryKey: "id" }),
    request({
      columns: Array.from({ length: 9 }, (_, index) => column({ name: `c${index}` })),
      primaryKey: Array.from({ length: 9 }, (_, index) => `c${index}`),
    }),
    request({ columns: [column({ name: "id", nullable: true })], primaryKey: ["id"] }),
  ];
  for (const value of invalid) {
    expect(() => parseDatabaseTableCreateRequest(value)).toThrow(TypeError);
  }
  try {
    parseDatabaseTableCreateRequest(request({ table: "secret-table-name" }));
  } catch (error) {
    expect((error as Error).message).not.toContain("secret-table-name");
  }
});

it("reads a created-table answer as its exact shape", () => {
  const answer = {
    table: {
      schema: "public",
      table: "orders",
      columns: [{ name: "id", type: "bigint", nullable: false, identity: true, default: null }],
      primaryKey: ["id"],
    },
    created: true,
  };
  expect(() => assertDatabaseTableCreated(answer)).not.toThrow();
  expect(() =>
    assertDatabaseTableCreated({ ...answer, table: { ...answer.table, schema: "private" } }),
  ).toThrow(TypeError);
  expect(() => assertDatabaseTableCreated({ ...answer, extra: true })).toThrow(TypeError);
});

it("publishes the table problem codes as 409 and never retryable", () => {
  for (const code of ["database_table_conflict", "database_table_limit"] as const) {
    const policy = PROBLEM_POLICY[code];
    expect(policy).toMatchObject({ status: 409, retryable: false });
    expect(policy.title.length).toBeGreaterThan(0);
    expect(policy.title.length).toBeLessThanOrEqual(160);
    expect(policy.action.length).toBeGreaterThan(0);
    expect(policy.action.length).toBeLessThanOrEqual(480);
  }
});
