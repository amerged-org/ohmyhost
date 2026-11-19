import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProviderTarget } from "@ohmyhost/database";
import type { DatabaseMigrationClient } from "@ohmyhost/platform";
import { projectSqlRoleName } from "@ohmyhost/platform";
import { PgcfConnectionHandle, PgcfProviderError } from "@ohmyhost/provider-pgcf";
import { createPgcfDatabaseTables, parseDatabaseTableCall } from "../src/pgcf-database-tables.js";

const host = vi.hoisted(() => ({ env: undefined as unknown }));
/** Only the `cloudflare:workers` base class is replaced; the entrypoint and the parsers are production code. */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));

afterEach(() => vi.restoreAllMocks());

const PGCF_PROJECT = "prj_abcdefghij0123456789",
  OMH_PROJECT = "01J7ABCDEFGHJKMNPQRSTVWXYZ",
  ORG = "01J5ABCDEFGHJKMNPQRSTVWXYZ",
  PHYSICAL = "01J6ABCDEFGHJKMNPQRSTVWXYZ",
  DB = "aaaaaaaaaaaaaaaaaaaa",
  MIGRATION_ROLE = projectSqlRoleName(PHYSICAL, "migration"),
  RUNTIME_ROLE = projectSqlRoleName(PHYSICAL, "runtime"),
  READONLY_ROLE = projectSqlRoleName(PHYSICAL, "readonly"),
  HOST_NAME = "pgcf-db.example.com",
  URI = `postgresql://${MIGRATION_ROLE}:not-a-real-password@${HOST_NAME}/${DB}`,
  envelope = { organizationId: ORG, projectId: OMH_PROJECT, environment: "dev" as const };

type Row = Record<string, unknown>;

/** A scripted database: each answer is the row set of the statement the table service sends, keyed by its marker. */
interface Db {
  /** Undefined: no relation of that name; otherwise the relation, ordinary or not. */
  table?: { oid: string; eligible: boolean } | undefined;
  /** The catalog columns of the existing table, in attribute order. */
  columns?: Row[] | undefined;
  /** The primary key columns of the existing table, in key order. */
  primaryKey?: Row[] | undefined;
  /** The number of ordinary and partitioned tables of the public schema. */
  count?: number | undefined;
  /** The identity sequence of the table, as pg_get_serial_sequence names it. */
  sequence?: string | null | undefined;
  lock?: Error | undefined;
  failOn?: string | undefined;
}

function answer(rows: Row[]) {
  return { rows, rowCount: rows.length };
}

function session(db: Db = {}) {
  const sql: string[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    sql.push(text);
    if (db.failOn !== undefined && text.includes(db.failOn))
      throw new Error("secret database detail");
    if (text.includes("current_user=$1 AND session_user=$1"))
      return answer([
        {
          rolname: values?.[0],
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          member_of_any_role: false,
        },
      ]);
    if (text.includes("pg_advisory_xact_lock")) {
      if (db.lock !== undefined) throw db.lock;
      return answer([]);
    }
    if (text.includes("AS eligible")) return answer(db.table === undefined ? [] : [db.table]);
    if (text.includes("AS total")) return answer([{ total: db.count ?? 0 }]);
    if (text.includes("AS nullable")) return answer(db.columns ?? []);
    if (text.includes("AS key_column")) return answer(db.primaryKey ?? []);
    if (text.includes("AS sequence")) return answer([{ sequence: db.sequence ?? null }]);
    return answer([]);
  });
  const close = vi.fn(async () => {});
  const client = { query } as unknown as DatabaseMigrationClient;
  return { client, close, sql, query };
}

function harness(db: Db = {}, scope?: { target: DatabaseProviderTarget | null }) {
  const connection = session(db);
  const connect = vi.fn(async () => ({ client: connection.client, close: connection.close }));
  const readConnection = vi.fn(
    async (databaseId: string, role: string) =>
      new PgcfConnectionHandle(URI, HOST_NAME, databaseId, role),
  );
  const readScope = vi.fn(async () => ({
    physicalEnvironmentId: PHYSICAL,
    target: scope === undefined ? target() : scope.target,
  }));
  const tables = createPgcfDatabaseTables({
    readScope,
    provider: { projectId: PGCF_PROJECT, readConnection },
    connect,
  });
  return { connection, connect, readConnection, readScope, tables };
}

function target(databaseId = DB, providerProjectId = PGCF_PROJECT): DatabaseProviderTarget {
  return {
    provider: "pgcf",
    organizationId: ORG,
    projectId: OMH_PROJECT,
    physicalEnvironmentId: PHYSICAL,
    targetVersion: 1,
    providerProjectId,
    regionId: "eu-dev",
    runtimeRole: RUNTIME_ROLE,
    credentialReference: "pgcf-dev",
    databaseId,
  } as unknown as DatabaseProviderTarget;
}

/** The catalog answer of the orders table the create request below describes. */
const ORDER_COLUMNS: Row[] = [
  { name: "id", type: "bigint", nullable: false, identity: "a", default: null },
  {
    name: "created_at",
    type: "timestamp with time zone",
    nullable: true,
    identity: "",
    default: "now()",
  },
  { name: "note", type: "text", nullable: true, identity: "", default: null },
];
const ORDER_KEY: Row[] = [{ key_column: "id" }];

const create = {
  ...envelope,
  operation: "table.create" as const,
  table: "orders",
  columns: [
    { name: "id", type: "bigint", identity: true },
    { name: "created_at", type: "timestamptz", default: "now" },
    { name: "note", type: "text" },
  ],
  primaryKey: ["id"],
};

const ORDERS_STATEMENT = `CREATE TABLE "public"."orders" ("id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY, "created_at" timestamptz DEFAULT now(), "note" text, PRIMARY KEY ("id"))`;

describe("table create request", () => {
  it("parses the envelope and the table, and normalizes the columns", () => {
    expect(parseDatabaseTableCall(create)).toEqual({
      ...envelope,
      operation: "table.create",
      table: "orders",
      columns: [
        { name: "id", type: "bigint", nullable: false, identity: true, default: null },
        {
          name: "created_at",
          type: "timestamptz",
          nullable: true,
          identity: false,
          default: "now",
        },
        { name: "note", type: "text", nullable: true, identity: false, default: null },
      ],
      primaryKey: ["id"],
    });
  });

  it("refuses an unknown operation, an unknown member and a schema, which is never a request field", () => {
    expect(() => parseDatabaseTableCall({ ...create, operation: "table.drop" })).toThrow(TypeError);
    expect(() => parseDatabaseTableCall({ ...create, schema: "public" })).toThrow(TypeError);
    expect(() => parseDatabaseTableCall({ ...create, environment: "staging" })).toThrow(TypeError);
  });
});

describe("table create", () => {
  it("runs the whole creation in one transaction as the migration role and closes the connection", async () => {
    const { connection, connect, readConnection, tables } = harness({
      table: undefined,
      count: 0,
      sequence: "public.orders_id_seq",
    });
    const outcome = await tables.run(parseDatabaseTableCall(create));
    expect(outcome).toEqual({
      status: "ok",
      value: {
        table: {
          schema: "public",
          table: "orders",
          columns: [
            { name: "id", type: "bigint", nullable: false, identity: true, default: null },
            {
              name: "created_at",
              type: "timestamptz",
              nullable: true,
              identity: false,
              default: "now",
            },
            { name: "note", type: "text", nullable: true, identity: false, default: null },
          ],
          primaryKey: ["id"],
        },
        created: true,
      },
    });
    expect(readConnection).toHaveBeenCalledWith(DB, MIGRATION_ROLE);
    expect(connect).toHaveBeenCalledWith(URI, {
      provider: "pgcf",
      host: HOST_NAME,
      databaseId: DB,
      role: MIGRATION_ROLE,
    });
    const order = [
      "BEGIN",
      "SET LOCAL statement_timeout = '10s'",
      "SET LOCAL lock_timeout = '5s'",
      "SET LOCAL idle_in_transaction_session_timeout = '15s'",
      "pg_advisory_xact_lock",
      "AS eligible",
      "AS total",
      "CREATE TABLE",
      "GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE",
      "GRANT USAGE,SELECT,UPDATE ON SEQUENCE",
      "COMMIT",
    ];
    let cursor = -1;
    for (const marker of order) {
      const index = connection.sql.findIndex(
        (text, position) => position > cursor && text.includes(marker),
      );
      expect(index, marker).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(connection.sql).toContain(ORDERS_STATEMENT);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("grants the runtime role the table and identity sequence, and the read-only role a read", async () => {
    const { connection, tables } = harness({
      table: undefined,
      count: 0,
      sequence: "public.orders_id_seq",
    });
    await tables.run(parseDatabaseTableCall(create));
    expect(connection.sql).toEqual(
      expect.arrayContaining([
        `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "public"."orders" TO ${RUNTIME_ROLE}`,
        `GRANT SELECT ON TABLE "public"."orders" TO ${READONLY_ROLE}`,
        `GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.orders_id_seq TO ${RUNTIME_ROLE}`,
        `GRANT SELECT ON SEQUENCE public.orders_id_seq TO ${READONLY_ROLE}`,
      ]),
    );
  });

  it("grants no sequence when the table has no identity column", async () => {
    const { connection, tables } = harness({ table: undefined, count: 0 });
    await tables.run(
      parseDatabaseTableCall({
        ...create,
        columns: [{ name: "note", type: "text" }],
        primaryKey: undefined,
      }),
    );
    expect(connection.sql.some((text) => text.includes("pg_get_serial_sequence"))).toBe(false);
    expect(connection.sql.some((text) => text.includes("ON SEQUENCE"))).toBe(false);
    expect(connection.sql).toContain('CREATE TABLE "public"."orders" ("note" text)');
  });

  it("answers an identical existing table as created false, with no DDL and no grant", async () => {
    const { connection, tables } = harness({
      table: { oid: "42", eligible: true },
      columns: ORDER_COLUMNS,
      primaryKey: ORDER_KEY,
      count: 100,
    });
    await expect(tables.run(parseDatabaseTableCall(create))).resolves.toMatchObject({
      status: "ok",
      value: { created: false, table: { table: "orders", primaryKey: ["id"] } },
    });
    expect(connection.sql.some((text) => text.startsWith("CREATE TABLE"))).toBe(false);
    expect(connection.sql.some((text) => text.startsWith("GRANT"))).toBe(false);
    expect(connection.sql).toContain("COMMIT");
  });

  it("refuses an existing table whose definition differs in any detail, with nothing changed", async () => {
    const [id, createdAt, note] = ORDER_COLUMNS as [Row, Row, Row];
    const variants: Array<{ label: string; columns: Row[]; primaryKey: Row[] }> = [
      {
        label: "type",
        columns: [{ ...id, type: "integer" }, createdAt, note],
        primaryKey: ORDER_KEY,
      },
      {
        label: "nullability",
        columns: [{ ...id }, createdAt, { ...note, nullable: false }],
        primaryKey: ORDER_KEY,
      },
      {
        label: "identity",
        columns: [{ ...id, identity: "" }, createdAt, note],
        primaryKey: ORDER_KEY,
      },
      {
        label: "default removed",
        columns: [id, { ...createdAt, default: null }, note],
        primaryKey: ORDER_KEY,
      },
      {
        label: "default changed",
        columns: [id, { ...createdAt, default: "CURRENT_TIMESTAMP" }, note],
        primaryKey: ORDER_KEY,
      },
      { label: "primary key missing", columns: ORDER_COLUMNS, primaryKey: [] },
      { label: "column order", columns: [createdAt, id, note], primaryKey: ORDER_KEY },
      {
        label: "extra column",
        columns: [
          ...ORDER_COLUMNS,
          { name: "extra", type: "text", nullable: true, identity: "", default: null },
        ],
        primaryKey: ORDER_KEY,
      },
    ];
    for (const variant of variants) {
      const { connection, tables } = harness({
        table: { oid: "42", eligible: true },
        columns: variant.columns,
        primaryKey: variant.primaryKey,
        count: 1,
      });
      await expect(tables.run(parseDatabaseTableCall(create)), variant.label).resolves.toEqual({
        status: "rejected",
        code: "table_conflict",
      });
      expect(
        connection.sql.some((text) => text.startsWith("CREATE TABLE")),
        variant.label,
      ).toBe(false);
      expect(connection.sql, variant.label).toContain("COMMIT");
    }
  });

  it("refuses a relation of that name that is not an ordinary table owned by the migration role", async () => {
    const { connection, tables } = harness({
      table: { oid: "43", eligible: false },
      columns: ORDER_COLUMNS,
      primaryKey: ORDER_KEY,
    });
    await expect(tables.run(parseDatabaseTableCall(create))).resolves.toEqual({
      status: "rejected",
      code: "table_conflict",
    });
    expect(connection.sql.some((text) => text.startsWith("CREATE TABLE"))).toBe(false);
  });

  it("refuses a new table once the public schema holds 100 tables, and still answers an identical one", async () => {
    const full = harness({ table: undefined, count: 100 });
    await expect(full.tables.run(parseDatabaseTableCall(create))).resolves.toEqual({
      status: "rejected",
      code: "table_limit",
    });
    expect(full.connection.sql.some((text) => text.startsWith("CREATE TABLE"))).toBe(false);
    expect(full.connection.sql).toContain("COMMIT");

    const last = harness({ table: undefined, count: 99, sequence: "public.orders_id_seq" });
    await expect(last.tables.run(parseDatabaseTableCall(create))).resolves.toMatchObject({
      status: "ok",
      value: { created: true },
    });
  });

  it("answers pending while another session holds the migrations lock, with nothing created", async () => {
    const lock = Object.assign(new Error("lock timeout"), { code: "55P03" });
    const { connection, tables } = harness({ table: undefined, count: 0, lock });
    await expect(tables.run(parseDatabaseTableCall(create))).resolves.toEqual({
      status: "rejected",
      code: "pending",
    });
    expect(connection.sql).toContain("ROLLBACK");
    expect(connection.sql.some((text) => text.startsWith("CREATE TABLE"))).toBe(false);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("rolls back and rethrows any other failure, without a database detail in the rejection", async () => {
    const { connection, tables } = harness({
      table: undefined,
      count: 0,
      failOn: "CREATE TABLE",
    });
    await expect(tables.run(parseDatabaseTableCall(create))).rejects.toThrow(
      "secret database detail",
    );
    expect(connection.sql).toContain("ROLLBACK");
    expect(connection.sql).not.toContain("COMMIT");
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("answers absent for an environment without a database, with zero connections", async () => {
    const { connect, readConnection, tables } = harness({}, { target: null });
    await expect(tables.run(parseDatabaseTableCall(create))).resolves.toEqual({
      status: "absent",
    });
    expect(readConnection).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses a database of another PGCF project as a misconfiguration", async () => {
    const { connect, tables } = harness({}, { target: target(DB, "prj_otherprojectxxxxxxxx") });
    await expect(tables.run(parseDatabaseTableCall(create))).rejects.toThrow(
      "Database compute scope unavailable",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("rethrows a provider failure before any connection is opened", async () => {
    const { tables, readConnection } = harness({});
    readConnection.mockRejectedValueOnce(new PgcfProviderError("contract"));
    await expect(tables.run(parseDatabaseTableCall(create))).rejects.toBeInstanceOf(
      PgcfProviderError,
    );
  });
});

describe("NeonManagementService.createDatabaseTable", () => {
  function bindingWith(scope: { target: DatabaseProviderTarget | null }) {
    return new Proxy(
      {},
      {
        get: (_target, method) =>
          method === "readProductComputeScope"
            ? async () => ({ physicalEnvironmentId: PHYSICAL, dataMode: "shared", ...scope })
            : async () => {
                throw new Error("Unexpected product binding call");
              },
      },
    );
  }

  function environment(binding: unknown) {
    host.env = {
      RUNTIME_CONFIGURATION_STATE: "configured",
      CONTROL_STORAGE_PROVIDER: "d1",
      PGCF_API_URL: "https://pgcf-api.aixyte.com",
      PGCF_APPS_PROJECT_ID: PGCF_PROJECT,
      PGCF_APPS_API_KEY: "test-only-integrator-key",
      NEON_TRAFFIC_ENABLED: "false",
      DATABASE_NEW_PROVIDER: "pgcf",
      DATABASE_PRODUCT_RUNTIME: binding,
    };
  }

  it("refuses an invalid table request before any binding is read", async () => {
    environment(bindingWith({ target: target() }));
    const { NeonManagementService } = await import("../src/worker-main.js");
    const service = new NeonManagementService({}, host.env as never);
    await expect(
      service.createDatabaseTable({
        ...envelope,
        operation: "table.create",
        table: "Orders",
        columns: [{ name: "id", type: "text" }],
      }),
    ).rejects.toThrow(TypeError);
  });

  it("answers absent for an environment without a database, without any PGCF request", async () => {
    environment(bindingWith({ target: null }));
    const fetch = vi.spyOn(globalThis, "fetch");
    const { NeonManagementService } = await import("../src/worker-main.js");
    const service = new NeonManagementService({}, host.env as never);
    await expect(service.createDatabaseTable(create)).resolves.toEqual({ status: "absent" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
