import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProviderTarget } from "@ohmyhost/database";
import { projectSqlRoleName, type DatabaseMigrationClient } from "@ohmyhost/platform";
import { PgcfConnectionHandle } from "@ohmyhost/provider-pgcf";
import { startTestPostgres, type TestPostgres } from "../../control-api/test/postgres.js";
import { createPgcfDatabaseTables, parseDatabaseTableCall } from "../src/pgcf-database-tables.js";
import { createPgcfDatabaseWatches } from "../src/pgcf-database-watches.js";

// The PGCF capture function is a stand-in with the real signature and grants (PUBLIC execute, schema USAGE to
// PUBLIC). PGCF's own lab tests and the live acceptance prove the real function.
const PHYSICAL = "00000000000000000000000003";
const PGCF_PROJECT = "prj_abcdefghij0123456789";
const DB = "aaaaaaaaaaaaaaaaaaaa";
const ENVELOPE = {
  organizationId: "01J5ABCDEFGHJKMNPQRSTVWXYZ",
  projectId: "01J7ABCDEFGHJKMNPQRSTVWXYZ",
  environment: "dev" as const,
};

const databases: TestPostgres[] = [];
const clients: Client[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.end().catch(() => undefined);
  for (const database of databases.splice(0)) await database.stop();
});

async function fixture() {
  const database = await startTestPostgres();
  databases.push(database);
  const owner = projectSqlRoleName(PHYSICAL, "migration");
  const runtime = projectSqlRoleName(PHYSICAL, "runtime");
  const readonly = projectSqlRoleName(PHYSICAL, "readonly");
  await database.pool.query(
    `CREATE ROLE ${owner} LOGIN NOBYPASSRLS;
     CREATE ROLE ${runtime} LOGIN NOBYPASSRLS;
     CREATE ROLE ${readonly} LOGIN NOBYPASSRLS;
     GRANT CREATE ON DATABASE postgres TO ${owner};
     GRANT USAGE, CREATE ON SCHEMA public TO ${owner};
     GRANT USAGE ON SCHEMA public TO ${runtime}, ${readonly};
     CREATE SCHEMA pgcf;
     GRANT USAGE ON SCHEMA pgcf TO PUBLIC;
     CREATE FUNCTION pgcf.capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
     REVOKE ALL ON FUNCTION pgcf.capture() FROM PUBLIC;
     GRANT EXECUTE ON FUNCTION pgcf.capture() TO PUBLIC;`,
  );
  const uriFor = (role: string) => {
    const url = new URL(String(database.pool.options.connectionString));
    url.username = role;
    return url.toString();
  };
  async function open(role: string) {
    const client = new Client({ connectionString: uriFor(role), options: "-c search_path=public" });
    await client.connect();
    clients.push(client);
    return client;
  }
  return { database, owner, runtime, readonly, uriFor, open };
}

/** The table service as production builds it, with a real provider handle and a real migration-role session. */
function tablesFor(
  scope: { readonly target: DatabaseProviderTarget | null },
  uriFor: (role: string) => string,
) {
  const connect = vi.fn(async (uri: string) => {
    const client = new Client({ connectionString: uri, options: "-c search_path=public" });
    await client.connect();
    return {
      client: client as unknown as DatabaseMigrationClient,
      close: () => client.end(),
    };
  });
  const tables = createPgcfDatabaseTables({
    readScope: async () => ({ physicalEnvironmentId: PHYSICAL, target: scope.target }),
    provider: {
      projectId: PGCF_PROJECT,
      readConnection: async (databaseId: string, role: string) =>
        new PgcfConnectionHandle(uriFor(role), "localhost", databaseId, role),
    },
    connect,
  });
  return { tables, connect };
}

/** The table watch service as production builds it, the same way its integration test does. */
function watchesFor(
  scope: { readonly target: DatabaseProviderTarget | null },
  uriFor: (role: string) => string,
) {
  const connect = vi.fn(async (uri: string) => {
    const client = new Client({ connectionString: uri, options: "-c search_path=public" });
    await client.connect();
    return {
      client: client as unknown as DatabaseMigrationClient,
      close: () => client.end(),
    };
  });
  return createPgcfDatabaseWatches({
    readScope: async () => ({ physicalEnvironmentId: PHYSICAL, target: scope.target }),
    provider: {
      projectId: PGCF_PROJECT,
      readConnection: async (databaseId: string, role: string) =>
        new PgcfConnectionHandle(uriFor(role), "localhost", databaseId, role),
    },
    connect,
  });
}

const pgcfTarget = {
  provider: "pgcf",
  providerProjectId: PGCF_PROJECT,
  databaseId: DB,
} as unknown as DatabaseProviderTarget;

const create = (table = "orders") =>
  parseDatabaseTableCall({
    ...ENVELOPE,
    operation: "table.create",
    table,
    columns: [
      { name: "id", type: "bigint", identity: true },
      { name: "placed_at", type: "timestamptz", default: "now" },
      { name: "note", type: "text" },
    ],
    primaryKey: ["id"],
  });

const ORDERS_COLUMNS = [
  { name: "id", type: "bigint", nullable: false, identity: true, default: null },
  { name: "placed_at", type: "timestamptz", nullable: true, identity: false, default: "now" },
  { name: "note", type: "text", nullable: true, identity: false, default: null },
];

describe("the table service creates tables the migration role owns and the runtime role uses", () => {
  it("creates the table as the migration role, and the runtime role can write and read it", async () => {
    const { database, owner, runtime, readonly, uriFor, open } = await fixture();
    const { tables } = tablesFor({ target: pgcfTarget }, uriFor);

    await expect(tables.run(create())).resolves.toEqual({
      status: "ok",
      value: {
        table: { schema: "public", table: "orders", columns: ORDERS_COLUMNS, primaryKey: ["id"] },
        created: true,
      },
    });

    const owned = await database.pool.query<{ owner: string }>(
      "SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid='public.orders'::regclass",
    );
    expect(owned.rows[0]?.owner).toBe(owner);

    const app = await open(runtime);
    const inserted = await app.query<{ id: string }>(
      "INSERT INTO orders(note) VALUES ('first') RETURNING id",
    );
    expect(inserted.rows[0]?.id).toBe("1");
    await app.query("UPDATE orders SET note='changed' WHERE id=$1", [1]);
    await expect(app.query("SELECT note FROM orders")).resolves.toMatchObject({
      rows: [{ note: "changed" }],
    });
    await app.query("DELETE FROM orders");

    const reader = await open(readonly);
    await expect(reader.query("SELECT count(*)::int AS n FROM orders")).resolves.toMatchObject({
      rows: [{ n: 0 }],
    });
    await expect(reader.query("INSERT INTO orders(note) VALUES ('denied')")).rejects.toThrow(
      /permission denied/u,
    );
  });

  it("answers an identical second create as created false, and a different definition as a conflict", async () => {
    const { database, uriFor } = await fixture();
    const { tables } = tablesFor({ target: pgcfTarget }, uriFor);
    await tables.run(create());

    await expect(tables.run(create())).resolves.toMatchObject({
      status: "ok",
      value: { created: false },
    });
    const different = parseDatabaseTableCall({
      ...ENVELOPE,
      operation: "table.create",
      table: "orders",
      columns: [
        { name: "id", type: "bigint", identity: true },
        { name: "placed_at", type: "timestamptz", default: "now" },
        { name: "note", type: "integer" },
      ],
      primaryKey: ["id"],
    });
    await expect(tables.run(different)).resolves.toEqual({
      status: "rejected",
      code: "table_conflict",
    });
    const column = await database.pool.query<{ type: string }>(
      "SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid='public.orders'::regclass AND attname='note'",
    );
    expect(column.rows[0]?.type).toBe("text");
  });

  it("refuses a view of the same name, which is not an ordinary table", async () => {
    const { database, uriFor } = await fixture();
    await database.pool.query("CREATE VIEW public.reports AS SELECT 1 AS id");
    const { tables } = tablesFor({ target: pgcfTarget }, uriFor);
    await expect(tables.run(create("reports"))).resolves.toEqual({
      status: "rejected",
      code: "table_conflict",
    });
  });

  it("refuses the 101st table of the public schema, and still answers an existing one", async () => {
    const { database, uriFor } = await fixture();
    const { tables } = tablesFor({ target: pgcfTarget }, uriFor);
    for (let index = 0; index < 100; index += 1) {
      const table = `t${index}`;
      await expect(
        tables.run(
          parseDatabaseTableCall({
            ...ENVELOPE,
            operation: "table.create",
            table,
            columns: [{ name: "id", type: "integer" }],
          }),
        ),
      ).resolves.toMatchObject({ status: "ok", value: { created: true } });
    }
    await expect(
      tables.run(
        parseDatabaseTableCall({
          ...ENVELOPE,
          operation: "table.create",
          table: "t100",
          columns: [{ name: "id", type: "integer" }],
        }),
      ),
    ).resolves.toEqual({ status: "rejected", code: "table_limit" });
    const count = await database.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
    );
    expect(count.rows[0]?.n).toBe(100);
    await expect(tables.run(create("t0"))).resolves.toMatchObject({
      status: "rejected",
      code: "table_conflict",
    });
  }, 120_000);

  it("answers pending while another session holds the migrations lock, with no table created", async () => {
    const { database, owner, uriFor, open } = await fixture();
    const { tables } = tablesFor({ target: pgcfTarget }, uriFor);
    const holder = await open(owner);
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('ohmyhost:migrations', 0))");
    try {
      await expect(tables.run(create())).resolves.toEqual({ status: "rejected", code: "pending" });
      const exists = await database.pool.query("SELECT 1 FROM pg_tables WHERE tablename='orders'");
      expect(exists.rows).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
    }
  }, 30_000);

  it("refuses an identifier that would need quoting before any connection is opened", async () => {
    const { uriFor } = await fixture();
    const { connect } = tablesFor({ target: pgcfTarget }, uriFor);
    for (const table of [
      'orders"; DROP TABLE public.orders; --',
      "Orders",
      "order items",
      "user",
    ]) {
      expect(() =>
        parseDatabaseTableCall({
          ...ENVELOPE,
          operation: "table.create",
          table,
          columns: [{ name: "id", type: "integer" }],
        }),
      ).toThrow(TypeError);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("lets the existing table watch attach to a table created this way", async () => {
    const { database, uriFor } = await fixture();
    const { tables } = tablesFor({ target: pgcfTarget }, uriFor);
    await tables.run(create());

    const watches = watchesFor({ target: pgcfTarget }, uriFor);
    await expect(
      watches.run({
        ...ENVELOPE,
        operation: "watch.create",
        schema: "public",
        table: "orders",
        columns: ["id", "note"],
        operations: ["insert", "update", "delete"],
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { table: "orders", event_type: "data.orders", columns: ["id", "note"] },
    });
    const triggers = await database.pool.query(
      "SELECT tgname FROM pg_trigger WHERE tgrelid='public.orders'::regclass AND NOT tgisinternal",
    );
    expect(triggers.rows).toHaveLength(1);
  });
});
