import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProviderTarget } from "@ohmyhost/database";
import { parseDatabaseMigrationStatements } from "@ohmyhost/contracts/database-migration-admission";
import {
  executeExpandOnlyMigrations,
  projectSqlRoleName,
  type DatabaseMigrationClient,
} from "@ohmyhost/platform";
import { PgcfConnectionHandle } from "@ohmyhost/provider-pgcf";
import { startTestPostgres, type TestPostgres } from "../../control-api/test/postgres.js";
import {
  createPgcfDatabaseWatches,
  watchTriggerName,
  watchTriggerSql,
  type DatabaseWatchCall,
} from "../src/pgcf-database-watches.js";
import { createHash } from "node:crypto";

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

function migration(sequence: number, sql: string) {
  const body = new TextEncoder().encode(sql);
  return {
    path: `20261101${String(sequence).padStart(6, "0")}_capture.sql`,
    body,
    size: body.byteLength,
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}` as const,
  };
}

const ORDERS = `CREATE TABLE public.orders(id integer PRIMARY KEY, total numeric);`;
const CAPTURE = `CREATE TRIGGER orders_capture AFTER INSERT OR UPDATE OR DELETE ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'total');`;

async function fixture() {
  const database = await startTestPostgres();
  databases.push(database);
  const owner = projectSqlRoleName(PHYSICAL, "migration");
  await database.pool.query(
    `CREATE ROLE ${owner} LOGIN NOBYPASSRLS;
     GRANT CREATE ON DATABASE postgres TO ${owner};
     GRANT USAGE, CREATE ON SCHEMA public TO ${owner};
     CREATE SCHEMA pgcf;
     GRANT USAGE ON SCHEMA pgcf TO PUBLIC;
     CREATE FUNCTION pgcf.capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
     REVOKE ALL ON FUNCTION pgcf.capture() FROM PUBLIC;
     GRANT EXECUTE ON FUNCTION pgcf.capture() TO PUBLIC;
     CREATE FUNCTION public.audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;`,
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
  const migrator = await open(owner);
  return {
    database,
    owner,
    uriFor,
    open,
    migrator,
    port: migrator as unknown as DatabaseMigrationClient,
  };
}

/** The watch service as production builds it, with a real provider handle and a real migration-role session. */
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
  const watches = createPgcfDatabaseWatches({
    readScope: async () => ({ physicalEnvironmentId: PHYSICAL, target: scope.target }),
    provider: {
      projectId: PGCF_PROJECT,
      readConnection: async (databaseId: string, role: string) =>
        new PgcfConnectionHandle(uriFor(role), "localhost", databaseId, role),
    },
    connect,
  });
  return { watches, connect };
}

const pgcfTarget = {
  provider: "pgcf",
  providerProjectId: PGCF_PROJECT,
  databaseId: DB,
} as unknown as DatabaseProviderTarget;

const create = (
  columns: string[] = ["id", "total"],
): Extract<DatabaseWatchCall, { operation: "watch.create" }> => ({
  ...ENVELOPE,
  operation: "watch.create",
  schema: "public",
  table: "orders",
  columns,
  operations: ["insert", "update", "delete"],
});

async function triggerOf(database: TestPostgres, name: string) {
  const result = await database.pool.query<{
    oid: string;
    type: number;
    args: string;
    definition: string;
  }>(
    `SELECT t.oid::text AS oid, t.tgtype::int AS type, encode(t.tgargs,'escape') AS args,
       pg_get_triggerdef(t.oid,true) AS definition
     FROM pg_trigger t WHERE t.tgname=$1`,
    [name],
  );
  return result.rows[0];
}

describe("the expand-only executor admits exactly the capture trigger on an existing table", () => {
  it("applies the capture trigger on an existing table, whose real PostgreSQL definition the executor accepts", async () => {
    const { port, migrator } = await fixture();
    const first = migration(1, ORDERS);
    const second = migration(2, CAPTURE);
    await executeExpandOnlyMigrations(port, [first]);
    await expect(executeExpandOnlyMigrations(port, [first, second])).resolves.toMatchObject({
      appliedPaths: [second.path],
    });
    const trigger = await migrator.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE tgname='orders_capture'",
    );
    expect(trigger.rows).toHaveLength(1);
  });

  it("refuses a second capture trigger on the same table", async () => {
    const { port } = await fixture();
    const first = migration(1, ORDERS);
    const second = migration(2, CAPTURE);
    const third = migration(
      3,
      `CREATE TRIGGER orders_capture_again AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
    );
    await executeExpandOnlyMigrations(port, [first]);
    await executeExpandOnlyMigrations(port, [first, second]);
    await expect(executeExpandOnlyMigrations(port, [first, second, third])).rejects.toMatchObject({
      reason: "not_admitted",
      path: third.path,
    });
  });

  it("refuses an ordinary customer trigger on an existing table", async () => {
    const { port } = await fixture();
    const first = migration(1, ORDERS);
    const audit = migration(
      2,
      `CREATE TRIGGER orders_audit AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.audit();`,
    );
    await executeExpandOnlyMigrations(port, [first]);
    await expect(executeExpandOnlyMigrations(port, [first, audit])).rejects.toMatchObject({
      reason: "catalog_changed",
      path: audit.path,
    });
  });

  it("refuses a capture trigger that names a missing column", async () => {
    const { port } = await fixture();
    const first = migration(1, ORDERS);
    const missing = migration(
      2,
      `CREATE TRIGGER orders_capture AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'missing');`,
    );
    await executeExpandOnlyMigrations(port, [first]);
    await expect(executeExpandOnlyMigrations(port, [first, missing])).rejects.toMatchObject({
      reason: "not_admitted",
      path: missing.path,
    });
  });

  it("refuses a capture trigger on a table that another role owns", async () => {
    const { port, database } = await fixture();
    await database.pool.query("CREATE TABLE public.foreign_items(id integer PRIMARY KEY)");
    const foreign = migration(
      1,
      `CREATE TRIGGER items_capture AFTER INSERT ON public.foreign_items FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
    );
    await expect(executeExpandOnlyMigrations(port, [foreign])).rejects.toMatchObject({
      reason: "not_admitted",
      path: foreign.path,
    });
  });
});

describe("the watch service attaches and detaches the trigger through the migration role", () => {
  it("creates, keeps, replaces, lists and deletes the watch on a real table", async () => {
    const { port, uriFor, database } = await fixture();
    await executeExpandOnlyMigrations(port, [migration(1, ORDERS)]);
    const { watches } = watchesFor({ target: pgcfTarget }, uriFor);
    const name = await watchTriggerName("public", "orders");

    const first = await watches.run(create());
    expect(first).toEqual({
      status: "ok",
      value: expect.objectContaining({
        id: name,
        topic: "orders",
        event_type: "data.orders",
        columns: ["id", "total"],
        operations: ["insert", "update", "delete"],
      }),
    });
    const attached = await triggerOf(database, name);
    expect(attached?.type).toBe(29);
    expect(attached?.args).toBe("id\\000total\\000");
    expect(attached?.definition).toMatch(
      /^CREATE TRIGGER pgcf_watch_[0-9a-f]{8} AFTER INSERT OR DELETE OR UPDATE ON (?:public\.)?orders FOR EACH ROW EXECUTE FUNCTION pgcf\.capture\('id', 'total'\)$/u,
    );

    await watches.run(create());
    expect((await triggerOf(database, name))?.oid).toBe(attached?.oid);

    await watches.run(create(["id"]));
    const replaced = await triggerOf(database, name);
    expect(replaced?.oid).not.toBe(attached?.oid);
    expect(replaced?.args).toBe("id\\000");

    await expect(watches.run({ ...ENVELOPE, operation: "watch.list" })).resolves.toMatchObject({
      status: "ok",
      value: { items: [expect.objectContaining({ id: name, columns: ["id"] })] },
    });

    await expect(
      watches.run({ ...ENVELOPE, operation: "watch.delete", schema: "public", table: "orders" }),
    ).resolves.toEqual({ status: "ok", value: { id: name, deleted: true } });
    expect(await triggerOf(database, name)).toBeUndefined();
    await expect(
      watches.run({ ...ENVELOPE, operation: "watch.delete", schema: "public", table: "orders" }),
    ).resolves.toEqual({ status: "absent" });
  });

  it("refuses a migration's own capture trigger under another name, with nothing changed", async () => {
    const { port, uriFor, database } = await fixture();
    await executeExpandOnlyMigrations(port, [migration(1, ORDERS), migration(2, CAPTURE)]);
    const { watches } = watchesFor({ target: pgcfTarget }, uriFor);
    await expect(watches.run(create())).resolves.toEqual({
      status: "rejected",
      code: "watch_conflict",
    });
    expect(await triggerOf(database, await watchTriggerName("public", "orders"))).toBeUndefined();
  });

  it("answers pending while another session holds the migrations lock", async () => {
    const { port, uriFor, open, database } = await fixture();
    await executeExpandOnlyMigrations(port, [migration(1, ORDERS)]);
    const holder = await open(projectSqlRoleName(PHYSICAL, "migration"));
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('ohmyhost:migrations', 0))");
    try {
      const { watches } = watchesFor({ target: pgcfTarget }, uriFor);
      await expect(watches.run(create())).resolves.toEqual({
        status: "rejected",
        code: "pending",
      });
      expect(await triggerOf(database, await watchTriggerName("public", "orders"))).toBeUndefined();
    } finally {
      await holder.query("ROLLBACK");
    }
  }, 30_000);

  it("refuses a migration-created watch trigger name on a quoted table, so the watch count stays exact", async () => {
    const { port } = await fixture();
    const first = migration(1, `CREATE TABLE public."Order Items"(id integer PRIMARY KEY);`);
    const forged = migration(
      2,
      `CREATE TRIGGER pgcf_watch_deadbeef AFTER INSERT ON public."Order Items" FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');`,
    );
    await executeExpandOnlyMigrations(port, [first]);
    await expect(executeExpandOnlyMigrations(port, [first, forged])).rejects.toMatchObject({
      reason: "not_admitted",
      path: forged.path,
    });
  });

  it("refuses a table another role owns, with nothing attached", async () => {
    const { uriFor, database } = await fixture();
    await database.pool.query("CREATE TABLE public.foreign_orders(id integer PRIMARY KEY)");
    const { watches } = watchesFor({ target: pgcfTarget }, uriFor);
    await expect(
      watches.run({ ...create(), table: "foreign_orders", columns: ["id"] }),
    ).resolves.toEqual({ status: "rejected", code: "watch_table_unavailable" });
    expect(
      await triggerOf(database, await watchTriggerName("public", "foreign_orders")),
    ).toBeUndefined();
  });

  it("replaces the watch when only the operations change, and lists the new subset", async () => {
    const { port, uriFor, database } = await fixture();
    await executeExpandOnlyMigrations(port, [migration(1, ORDERS)]);
    const { watches } = watchesFor({ target: pgcfTarget }, uriFor);
    const name = await watchTriggerName("public", "orders");
    await watches.run(create());
    const all = await triggerOf(database, name);
    await expect(watches.run({ ...create(), operations: ["insert"] })).resolves.toMatchObject({
      status: "ok",
      value: { operations: ["insert"] },
    });
    const insertOnly = await triggerOf(database, name);
    expect(insertOnly?.oid).not.toBe(all?.oid);
    expect(insertOnly?.type).toBe(5);
    await expect(watches.run({ ...ENVELOPE, operation: "watch.list" })).resolves.toMatchObject({
      status: "ok",
      value: { items: [expect.objectContaining({ id: name, operations: ["insert"] })] },
    });
  });

  it("leaves a customer trigger that holds the watch name alone, and does not list it", async () => {
    const { port, uriFor, database } = await fixture();
    const name = await watchTriggerName("public", "orders");
    await executeExpandOnlyMigrations(port, [
      migration(
        1,
        `${ORDERS}\nCREATE TRIGGER ${name} AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.audit();`,
      ),
    ]);
    const { watches } = watchesFor({ target: pgcfTarget }, uriFor);
    await expect(
      watches.run({ ...ENVELOPE, operation: "watch.delete", schema: "public", table: "orders" }),
    ).resolves.toEqual({ status: "absent" });
    expect((await triggerOf(database, name))?.type).toBe(5);
    await expect(watches.run({ ...ENVELOPE, operation: "watch.list" })).resolves.toEqual({
      status: "ok",
      value: { items: [] },
    });
  });

  it("refuses the 101st watch of a database, and the list still answers its first page", async () => {
    const { port, uriFor } = await fixture();
    const tables = Array.from({ length: 101 }, (_, index) => `t${index}`);
    await executeExpandOnlyMigrations(port, [
      migration(1, tables.map((table) => `CREATE TABLE public.${table}(id integer);`).join("\n")),
    ]);
    const { watches } = watchesFor({ target: pgcfTarget }, uriFor);
    const watchOf = (table: string) => ({
      ...ENVELOPE,
      operation: "watch.create" as const,
      schema: "public",
      table,
      columns: ["id"],
      operations: ["insert"] as const,
    });
    for (const table of tables.slice(0, 100))
      await expect(watches.run(watchOf(table))).resolves.toMatchObject({ status: "ok" });
    await expect(watches.run(watchOf("t100"))).resolves.toEqual({
      status: "rejected",
      code: "watch_limit",
    });
    const page = await watches.run({ ...ENVELOPE, operation: "watch.list" });
    if (page.status !== "ok" || !("items" in page.value)) throw new Error("Expected a watch page");
    expect(page.value.items).toHaveLength(100);
  }, 120_000);

  it("refuses reserved schemas with zero connections", async () => {
    const { uriFor } = await fixture();
    const { watches, connect } = watchesFor({ target: pgcfTarget }, uriFor);
    for (const schema of ["pgcf", "pg_catalog", "information_schema", "ohmyhost"]) {
      await expect(watches.run({ ...create(), schema })).resolves.toEqual({
        status: "rejected",
        code: "watch_table_unavailable",
      });
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("round-trips the generated DDL through the migration admission to the same request", async () => {
    const request = {
      schema: "public",
      table: "orders",
      columns: ["id", "total"],
      operations: ["delete", "insert"] as const,
    };
    const name = await watchTriggerName(request.schema, request.table);
    const [statement] = parseDatabaseMigrationStatements(watchTriggerSql(name, request));
    expect(statement?.captureTrigger).toEqual({
      trigger: name,
      schema: "public",
      table: "orders",
      operations: ["insert", "delete"],
      columns: ["id", "total"],
    });
  });
});
