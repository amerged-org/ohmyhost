import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProviderTarget } from "@ohmyhost/database";
import { parseDatabaseMigrationStatements } from "@ohmyhost/contracts/database-migration-admission";
import type { DatabaseMigrationClient } from "@ohmyhost/platform";
import { projectSqlRoleName } from "@ohmyhost/platform";
import { PgcfConnectionHandle, PgcfProviderError } from "@ohmyhost/provider-pgcf";
import {
  createPgcfDatabaseWatches,
  isDatabaseWatchOperation,
  parseDatabaseWatchRequest,
  watchTriggerName,
  watchTriggerSql,
} from "../src/pgcf-database-watches.js";

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
  HOST_NAME = "pgcf-db.example.com",
  URI = `postgresql://${MIGRATION_ROLE}:not-a-real-password@${HOST_NAME}/${DB}`,
  ORDERS = `pgcf_watch_${createHash("sha256").update("public.orders").digest("hex").slice(0, 8)}`,
  envelope = { organizationId: ORG, projectId: OMH_PROJECT, environment: "dev" as const };

type Row = Record<string, unknown>;

/** A scripted database: each answer is the row set of the statement the watch service sends, keyed by its marker. */
interface Db {
  installed?: boolean | undefined;
  /** Undefined: no such table; otherwise the table row, eligible or not. */
  table?: Row | undefined;
  triggers?: Row[] | undefined;
  /** The number of watch triggers of the migration role, as the count query answers it. */
  count?: number | undefined;
  found?: Row | undefined;
  list?: Row[] | undefined;
  lock?: Error | undefined;
  failOn?: string | undefined;
  rollbackFails?: Error | undefined;
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
    if (text === "ROLLBACK" && db.rollbackFails !== undefined) throw db.rollbackFails;
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
    if (text.includes("AS installed")) return answer([{ installed: db.installed ?? true }]);
    if (text.includes("pg_advisory_xact_lock")) {
      if (db.lock !== undefined) throw db.lock;
      return answer([]);
    }
    if (text.includes("AS eligible")) return answer(db.table === undefined ? [] : [db.table]);
    if (text.includes("AS total")) return answer([{ total: db.count ?? 0 }]);
    if (text.includes("AS capture")) return answer(db.triggers ?? []);
    if (text.includes("AS found")) return answer(db.found ? [db.found] : []);
    if (text.includes("ORDER BY n.nspname, c.relname LIMIT 101")) return answer(db.list ?? []);
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
  const watches = createPgcfDatabaseWatches({
    readScope,
    provider: { projectId: PGCF_PROJECT, readConnection },
    connect,
  });
  return { connection, connect, readConnection, readScope, watches };
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
    runtimeRole: projectSqlRoleName(PHYSICAL, "runtime"),
    credentialReference: "pgcf-dev",
    databaseId,
  } as unknown as DatabaseProviderTarget;
}

const orders = {
  oid: "42",
  eligible: true,
  columns: ["id", "total", "status"],
};

/** PostgreSQL tgtype of an AFTER ROW trigger: ROW is 1, INSERT 4, DELETE 8, UPDATE 16. */
const captureOf = (args: string, type = 1 | 4 | 8 | 16) => ({
  name: ORDERS,
  capture: true,
  type,
  args,
});

const create = {
  operation: "watch.create" as const,
  schema: "public",
  table: "orders",
  columns: ["id", "total"],
  operations: ["insert", "update", "delete"] as const,
};

describe("watch trigger naming and SQL", () => {
  it("names the trigger after the first eight hex digits of sha256(schema.table)", async () => {
    const digest = createHash("sha256").update("public.orders").digest("hex");
    await expect(watchTriggerName("public", "orders")).resolves.toBe(
      `pgcf_watch_${digest.slice(0, 8)}`,
    );
    const names = await Promise.all([
      watchTriggerName("public", "orders"),
      watchTriggerName("private", "orders"),
      watchTriggerName("public", "items"),
    ]);
    expect(new Set(names).size).toBe(3);
  });

  it("builds the trigger DDL with quoted identifiers and inlined column literals", () => {
    expect(
      watchTriggerSql(ORDERS, {
        schema: "public",
        table: "orders",
        columns: ["id", "total"],
        operations: ["insert", "update", "delete"],
      }),
    ).toBe(
      `CREATE TRIGGER "${ORDERS}" AFTER INSERT OR UPDATE OR DELETE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'total')`,
    );
  });

  it("produces SQL that the migration admission reads back to the same request", async () => {
    const request = {
      schema: "public",
      table: "Orders",
      columns: ["id", "total"],
      operations: ["delete", "insert"] as const,
    };
    const name = await watchTriggerName(request.schema, request.table);
    const [statement] = parseDatabaseMigrationStatements(watchTriggerSql(name, request));
    expect(statement?.captureTrigger).toEqual({
      trigger: name,
      schema: "public",
      table: "Orders",
      operations: ["insert", "delete"],
      columns: ["id", "total"],
    });
  });
});

describe("watch create", () => {
  it("runs the whole attachment in one transaction as the migration role and closes the connection", async () => {
    const { connection, connect, readConnection, watches } = harness({
      table: orders,
      triggers: [],
    });
    const outcome = await watches.run({ ...envelope, ...create });
    expect(outcome).toEqual({
      status: "ok",
      value: {
        id: await watchTriggerName("public", "orders"),
        environment: "dev",
        schema: "public",
        table: "orders",
        columns: ["id", "total"],
        operations: ["insert", "update", "delete"],
        topic: "orders",
        event_type: "data.orders",
      },
    });
    expect(readConnection).toHaveBeenCalledWith(DB, MIGRATION_ROLE);
    expect(connect).toHaveBeenCalledWith(URI, {
      provider: "pgcf",
      host: HOST_NAME,
      databaseId: DB,
      role: MIGRATION_ROLE,
    });
    const sql = connection.sql;
    const order = [
      "BEGIN",
      "SET LOCAL statement_timeout = '10s'",
      "SET LOCAL lock_timeout = '5s'",
      "SET LOCAL idle_in_transaction_session_timeout = '15s'",
      "pg_advisory_xact_lock",
      "AS installed",
      "AS eligible",
      "AS capture",
      "CREATE TRIGGER",
      "COMMIT",
    ];
    let cursor = -1;
    for (const marker of order) {
      const index = sql.findIndex((text, position) => position > cursor && text.includes(marker));
      expect(index, marker).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("changes nothing again when the same table and columns are watched twice", async () => {
    const existing = captureOf("id\\000total\\000");
    const { connection, watches } = harness({
      table: orders,
      triggers: [{ ...existing, capture: true, name: ORDERS }],
    });
    await expect(watches.run({ ...envelope, ...create })).resolves.toMatchObject({ status: "ok" });
    expect(connection.sql.some((text) => text.startsWith("CREATE TRIGGER"))).toBe(false);
    expect(connection.sql.some((text) => text.startsWith("DROP TRIGGER"))).toBe(false);
  });

  it("replaces the trigger in the same transaction when the columns change", async () => {
    const { connection, watches } = harness({
      table: orders,
      triggers: [{ name: ORDERS, capture: true, type: 1 | 4 | 8 | 16, args: "id\\000status\\000" }],
    });
    await expect(watches.run({ ...envelope, ...create })).resolves.toMatchObject({ status: "ok" });
    const sql = connection.sql;
    const drop = sql.findIndex((text) => text.startsWith("DROP TRIGGER"));
    const createIndex = sql.findIndex((text) => text.startsWith("CREATE TRIGGER"));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(createIndex);
    expect(sql.indexOf("COMMIT")).toBeGreaterThan(createIndex);
  });

  it("refuses a foreign capture trigger, and a non-capture trigger holding the watch name, with nothing changed", async () => {
    const foreign = harness({
      table: orders,
      triggers: [{ name: "orders_capture", capture: true, type: 4, args: "id\\000" }],
    });
    await expect(foreign.watches.run({ ...envelope, ...create })).resolves.toEqual({
      status: "rejected",
      code: "watch_conflict",
    });
    expect(foreign.connection.sql.some((text) => text.startsWith("CREATE TRIGGER"))).toBe(false);
    expect(foreign.connection.sql).toContain("COMMIT");

    const named = harness({
      table: orders,
      triggers: [{ name: ORDERS, capture: false, type: 2, args: "" }],
    });
    await expect(named.watches.run({ ...envelope, ...create })).resolves.toEqual({
      status: "rejected",
      code: "watch_conflict",
    });
  });

  it("refuses a database whose PGCF schema is not installed yet", async () => {
    const { connection, watches } = harness({ installed: false, table: orders });
    await expect(watches.run({ ...envelope, ...create })).resolves.toEqual({
      status: "rejected",
      code: "watch_events_unavailable",
    });
    expect(connection.sql).toContain("COMMIT");
  });

  it("refuses a missing, ineligible or foreign-owned table", async () => {
    for (const table of [undefined, { ...orders, eligible: false }]) {
      const { watches } = harness({ table });
      await expect(watches.run({ ...envelope, ...create })).resolves.toEqual({
        status: "rejected",
        code: "watch_table_unavailable",
      });
    }
  });

  it("replaces the trigger when the same columns are watched with other operations", async () => {
    const { connection, watches } = harness({
      table: orders,
      triggers: [captureOf("id\\000total\\000", 1 | 4)],
    });
    await expect(watches.run({ ...envelope, ...create })).resolves.toMatchObject({ status: "ok" });
    const drop = connection.sql.findIndex((text) => text.startsWith("DROP TRIGGER"));
    const createIndex = connection.sql.findIndex((text) => text.startsWith("CREATE TRIGGER"));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(createIndex);
  });

  it("refuses a new watch once the database holds a page of watches, and still replaces an own one", async () => {
    const full = harness({ table: orders, triggers: [], count: 100 });
    await expect(full.watches.run({ ...envelope, ...create })).resolves.toEqual({
      status: "rejected",
      code: "watch_limit",
    });
    expect(full.connection.sql.some((text) => text.startsWith("CREATE TRIGGER"))).toBe(false);
    expect(full.connection.sql).toContain("COMMIT");

    const last = harness({ table: orders, triggers: [], count: 99 });
    await expect(last.watches.run({ ...envelope, ...create })).resolves.toMatchObject({
      status: "ok",
    });

    const own = harness({
      table: orders,
      triggers: [captureOf("id\\000status\\000")],
      count: 100,
    });
    await expect(own.watches.run({ ...envelope, ...create })).resolves.toMatchObject({
      status: "ok",
    });
  });

  it("refuses a column the table does not have", async () => {
    const { watches } = harness({ table: orders });
    await expect(
      watches.run({ ...envelope, ...create, columns: ["id", "missing"] }),
    ).resolves.toEqual({ status: "rejected", code: "watch_column_unavailable" });
  });

  it("answers pending when the migrations lock stays busy, and rolls back", async () => {
    const lock = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });
    const { connection, watches } = harness({ table: orders, lock });
    await expect(watches.run({ ...envelope, ...create })).resolves.toEqual({
      status: "rejected",
      code: "pending",
    });
    expect(connection.sql).toContain("ROLLBACK");
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original failure when the rollback fails too, and closes the connection", async () => {
    const { connection, watches } = harness({
      table: orders,
      failOn: "AS capture",
      rollbackFails: new Error("rollback detail"),
    });
    const error = await watches.run({ ...envelope, ...create }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("secret database detail");
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other failure after a rollback and closes the connection", async () => {
    const { connection, watches } = harness({ table: orders, failOn: "AS capture" });
    const error = await watches.run({ ...envelope, ...create }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(connection.sql).toContain("ROLLBACK");
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("refuses identifiers that could reach the DDL unchecked, and issues no DDL for them", async () => {
    const request = {
      schema: "public",
      table: "orders",
      columns: ["id"],
      operations: ["insert"] as const,
    };
    expect(() => watchTriggerSql(ORDERS, { ...request, table: 'a"b' })).toThrow(TypeError);
    expect(() => watchTriggerSql(ORDERS, { ...request, columns: ["x');DROP"] })).toThrow(TypeError);

    const table = harness({});
    await expect(table.watches.run({ ...envelope, ...create, table: 'a"b' })).resolves.toEqual({
      status: "rejected",
      code: "watch_table_unavailable",
    });
    const column = harness({ table: orders });
    await expect(
      column.watches.run({ ...envelope, ...create, columns: ["x');DROP"] }),
    ).resolves.toEqual({ status: "rejected", code: "watch_column_unavailable" });
    for (const { connection } of [table, column])
      expect(connection.sql.some((text) => /^(CREATE|DROP) TRIGGER/u.test(text))).toBe(false);
  });

  it("refuses reserved schemas before any provider or connection call", async () => {
    for (const schema of ["pgcf", "pg_catalog", "information_schema", "ohmyhost"]) {
      const { connect, readConnection, watches } = harness({ table: orders });
      await expect(watches.run({ ...envelope, ...create, schema })).resolves.toEqual({
        status: "rejected",
        code: "watch_table_unavailable",
      });
      expect(readConnection).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    }
  });
});

describe("watch list and delete", () => {
  const listed = {
    name: ORDERS,
    schema: "public",
    table: "orders",
    type: 1 | 4 | 8 | 16,
    args: "id\\000total\\000",
  };

  it("lists the capture triggers of the migration role's tables as DatabaseWatch values", async () => {
    const { connection, watches } = harness({ list: [listed] });
    await expect(watches.run({ ...envelope, operation: "watch.list" })).resolves.toEqual({
      status: "ok",
      value: {
        items: [
          {
            id: ORDERS,
            environment: "dev",
            schema: "public",
            table: "orders",
            columns: ["id", "total"],
            operations: ["insert", "update", "delete"],
            topic: "orders",
            event_type: "data.orders",
          },
        ],
      },
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("returns an empty page when the database has no PGCF schema yet", async () => {
    const { watches } = harness({ list: [] });
    await expect(watches.run({ ...envelope, operation: "watch.list" })).resolves.toEqual({
      status: "ok",
      value: { items: [] },
    });
  });

  it("refuses a list that exceeds one page", async () => {
    const many = Array.from({ length: 101 }, () => listed);
    const { watches } = harness({ list: many });
    await expect(watches.run({ ...envelope, operation: "watch.list" })).rejects.toThrow(
      "Database watch list exceeded its page limit",
    );
  });

  it("drops the watch trigger of the table and answers deleted", async () => {
    const { connection, watches } = harness({
      table: orders,
      found: { name: ORDERS },
    });
    await expect(
      watches.run({ ...envelope, operation: "watch.delete", schema: "public", table: "orders" }),
    ).resolves.toEqual({ status: "ok", value: { id: ORDERS, deleted: true } });
    expect(connection.sql).toContain(`DROP TRIGGER "${ORDERS}" ON "public"."orders"`);
    expect(connection.sql.indexOf(`DROP TRIGGER "${ORDERS}" ON "public"."orders"`)).toBeLessThan(
      connection.sql.indexOf("COMMIT"),
    );
  });

  it("refuses a reserved schema on delete with zero connections", async () => {
    const { connect, readConnection, watches } = harness({ table: orders });
    await expect(
      watches.run({ ...envelope, operation: "watch.delete", schema: "pgcf", table: "orders" }),
    ).resolves.toEqual({ status: "rejected", code: "watch_table_unavailable" });
    expect(readConnection).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("answers absent when no capture trigger of the watch name exists", async () => {
    const { connection, watches } = harness({ found: undefined });
    await expect(
      watches.run({ ...envelope, operation: "watch.delete", schema: "public", table: "orders" }),
    ).resolves.toEqual({ status: "absent" });
    expect(connection.sql.some((text) => text.startsWith("DROP TRIGGER"))).toBe(false);
  });
});

describe("watch request parsing and scope", () => {
  it("parses the three operations and refuses foreign keys and bad identifiers", () => {
    expect(
      parseDatabaseWatchRequest({
        ...envelope,
        operation: "watch.create",
        table: "orders",
        columns: ["id"],
      }),
    ).toMatchObject({
      operation: "watch.create",
      schema: "public",
      table: "orders",
      columns: ["id"],
      operations: ["insert", "update", "delete"],
    });
    expect(parseDatabaseWatchRequest({ ...envelope, operation: "watch.list" })).toMatchObject({
      operation: "watch.list",
    });
    expect(
      parseDatabaseWatchRequest({ ...envelope, operation: "watch.delete", table: "orders" }),
    ).toMatchObject({ operation: "watch.delete", table: "orders" });
    const refused: unknown[] = [
      {
        ...envelope,
        operation: "watch.create",
        table: "orders",
        columns: ["id"],
        databaseIds: ["x"],
      },
      { ...envelope, operation: "watch.create", table: "orders", columns: ["id"], role: "app" },
      {
        ...envelope,
        operation: "watch.create",
        table: "orders",
        columns: ["id"],
        providerProjectId: "p",
      },
      { ...envelope, operation: "watch.create", table: "a.b", columns: ["id"] },
      {
        ...envelope,
        operation: "watch.create",
        table: "orders",
        columns: Array.from({ length: 33 }, (_, index) => `c${index}`),
      },
      { ...envelope, operation: "watch.delete", table: "orders", columns: ["id"] },
      { ...envelope, operation: "watch.unknown", table: "orders" },
    ];
    for (const value of refused) expect(() => parseDatabaseWatchRequest(value)).toThrow(TypeError);
  });

  it("recognises watch operations by their prefix only", () => {
    expect(isDatabaseWatchOperation({ operation: "watch.list" })).toBe(true);
    expect(isDatabaseWatchOperation({ operation: "webhook.list" })).toBe(false);
    expect(isDatabaseWatchOperation(null)).toBe(false);
    expect(isDatabaseWatchOperation(["watch.list"])).toBe(false);
  });

  it("answers absent for an environment without a database, with zero connections", async () => {
    const { connect, readConnection, watches } = harness({}, { target: null });
    await expect(watches.run({ ...envelope, operation: "watch.list" })).resolves.toEqual({
      status: "absent",
    });
    expect(readConnection).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses a database of another PGCF project as a misconfiguration", async () => {
    const { connect, watches } = harness({}, { target: target(DB, "prj_otherprojectxxxxxxxx") });
    await expect(watches.run({ ...envelope, operation: "watch.list" })).rejects.toThrow(
      "Database compute scope unavailable",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("rethrows a provider failure before any connection is opened", async () => {
    const { watches, readConnection } = harness({});
    readConnection.mockRejectedValueOnce(new PgcfProviderError("contract"));
    await expect(watches.run({ ...envelope, operation: "watch.list" })).rejects.toBeInstanceOf(
      PgcfProviderError,
    );
  });
});

describe("NeonManagementService.databaseEvents routes watch operations", () => {
  /** A product binding that answers the compute scope only; every other binding method refuses the test. */
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

  it("refuses an invalid watch request before any binding is read", async () => {
    environment(bindingWith({ target: target() }));
    const { NeonManagementService } = await import("../src/worker-main.js");
    const service = new NeonManagementService({}, host.env as never);
    await expect(
      service.databaseEvents({
        ...envelope,
        operation: "watch.create",
        table: "orders",
        columns: [],
      }),
    ).rejects.toThrow(TypeError);
  });

  it("answers absent for an environment without a database, without any PGCF request", async () => {
    environment(bindingWith({ target: null }));
    const fetch = vi.spyOn(globalThis, "fetch");
    const { NeonManagementService } = await import("../src/worker-main.js");
    const service = new NeonManagementService({}, host.env as never);
    await expect(service.databaseEvents({ ...envelope, operation: "watch.list" })).resolves.toEqual(
      {
        status: "absent",
      },
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists the watches end to end through PGCF's connection answer and the injected connection", async () => {
    environment(bindingWith({ target: target() }));
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe(
        `https://pgcf-api.aixyte.com/v1/databases/${DB}/roles/${MIGRATION_ROLE}/connection-uri`,
      );
      return Response.json({
        database_id: DB,
        database: DB,
        role: MIGRATION_ROLE,
        includes_password: true,
        host: HOST_NAME,
        uri: URI,
      });
    });
    const connection = session();
    const connect = vi.fn(async () => ({ client: connection.client, close: connection.close }));
    const { NeonManagementService } = await import("../src/worker-main.js");
    const service = new NeonManagementService({}, host.env as never, connect);
    await expect(service.databaseEvents({ ...envelope, operation: "watch.list" })).resolves.toEqual(
      {
        status: "ok",
        value: { items: [] },
      },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(URI, {
      provider: "pgcf",
      host: HOST_NAME,
      databaseId: DB,
      role: MIGRATION_ROLE,
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});
