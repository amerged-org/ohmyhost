import {
  DATABASE_PAGE_MAX_ITEMS,
  DATABASE_WATCH_OPERATIONS,
  assertDatabaseWatch,
  assertDatabaseWatchDeleted,
  assertDatabaseWatchPage,
  dataEventTopic,
  isDatabaseWatchIdentifier,
  isDatabaseWatchSchema,
  parseDatabaseWatchCreateRequest,
  parseDatabaseWatchTarget,
  type DatabaseWatch,
  type DatabaseWatchDeleted,
  type DatabaseWatchOperation,
  type DatabaseWatchPage,
  type DatabaseWatchRequest,
  type DatabaseWatchTarget,
} from "@ohmyhost/contracts/database-events";
import type { DatabaseMigrationClient } from "@ohmyhost/platform";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import {
  parseDatabaseRequest,
  resolveDatabaseScope,
  sha256Hex,
  type DatabaseRequestEnvelope,
  type DatabaseRequestShapes,
  type DatabaseScope,
  type ReadDatabaseScope,
} from "./pgcf-database-request.js";
import { migrationSession, migrationTransaction } from "./pgcf-migration-session.js";
import type { PgcfManagementDependencies } from "./pgcf-runtime.js";

type WatchOperation = "watch.create" | "watch.list" | "watch.delete";

/** A parsed watch request; the database comes from the product scope, never from the caller. */
export type DatabaseWatchCall = DatabaseRequestEnvelope &
  (
    | ({ readonly operation: "watch.create" } & DatabaseWatchRequest)
    | { readonly operation: "watch.list" }
    | ({ readonly operation: "watch.delete" } & DatabaseWatchTarget)
  );

export type DatabaseWatchRejection =
  | "watch_table_unavailable"
  | "watch_column_unavailable"
  | "watch_events_unavailable"
  | "watch_conflict"
  | "watch_limit"
  | "pending";

export type DatabaseWatchOutcome =
  | {
      readonly status: "ok";
      readonly value: DatabaseWatch | DatabaseWatchPage | DatabaseWatchDeleted;
    }
  | { readonly status: "absent" }
  | { readonly status: "rejected"; readonly code: DatabaseWatchRejection };

const SHAPES: DatabaseRequestShapes<WatchOperation> = {
  "watch.create": [
    ["table", "columns"],
    ["schema", "operations"],
  ],
  "watch.list": [[], []],
  "watch.delete": [["table"], ["schema"]],
};

const OPERATION_BITS: Readonly<Record<DatabaseWatchOperation, number>> = {
  insert: 4,
  delete: 8,
  update: 16,
};

/** Operations that name a watch use the watch prefix; any other operation belongs to the event port. */
export function isDatabaseWatchOperation(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const operation = (input as Record<string, unknown>)["operation"];
  return typeof operation === "string" && operation.startsWith("watch.");
}

export function parseDatabaseWatchRequest(value: unknown): DatabaseWatchCall {
  const { operation, envelope, input } = parseDatabaseRequest(value, SHAPES);
  switch (operation) {
    case "watch.create":
      return {
        ...envelope,
        operation,
        ...parseDatabaseWatchCreateRequest({
          schema: input["schema"],
          table: input["table"],
          columns: input["columns"],
          operations: input["operations"],
        }),
      };
    case "watch.list":
      return { ...envelope, operation };
    case "watch.delete":
      return {
        ...envelope,
        operation,
        ...parseDatabaseWatchTarget({ schema: input["schema"], table: input["table"] }),
      };
  }
}

/** The platform-owned trigger name of one table: the same name for the same table, in every environment. */
export async function watchTriggerName(schema: string, table: string): Promise<string> {
  return `pgcf_watch_${(await sha256Hex(`${schema}.${table}`)).slice(0, 8)}`;
}

/**
 * The DDL of the watch trigger. Identifiers are checked and quoted; column names are inlined as checked literals
 * because DDL takes no parameters. The admission reader reads this exact form back (see the round-trip test).
 */
export function watchTriggerSql(trigger: string, request: DatabaseWatchRequest): string {
  const operations = canonicalOperations(request.operations)
    .map((operation) => operation.toUpperCase())
    .join(" OR ");
  const columns = request.columns.map((column) => literal(column)).join(", ");
  return `CREATE TRIGGER ${quoted(trigger)} AFTER ${operations} ON ${quoted(request.schema)}.${quoted(request.table)} FOR EACH ROW EXECUTE FUNCTION pgcf.capture(${columns})`;
}

function quoted(identifier: string): string {
  if (!isDatabaseWatchIdentifier(identifier))
    throw new TypeError("Invalid database watch identifier");
  return `"${identifier}"`;
}

function literal(identifier: string): string {
  if (!isDatabaseWatchIdentifier(identifier))
    throw new TypeError("Invalid database watch identifier");
  return `'${identifier}'`;
}

type TableRow = {
  oid: string;
  eligible: boolean;
  columns: string[];
};

type TriggerRow = {
  name: string;
  capture: boolean | null;
  type: number;
  args: string | null;
};

type WatchRow = TriggerRow & {
  schema: string;
  table: string;
};

/** The watches of the migration role. Migrations cannot create watch-named triggers, so this count is exact. */
const WATCH_TRIGGERS = `FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND t.tgfoid=to_regprocedure('pgcf.capture()')
  AND t.tgname ~ '^pgcf_watch_[0-9a-f]{8}$' AND c.relowner=current_user::regrole`;

const LIST_SQL = `SELECT t.tgname::text AS name, n.nspname::text AS schema, c.relname::text AS "table",
  t.tgtype::int AS type, encode(t.tgargs,'escape') AS args
${WATCH_TRIGGERS}
ORDER BY n.nspname, c.relname LIMIT ${DATABASE_PAGE_MAX_ITEMS + 1}`;

const COUNT_SQL = `SELECT count(*)::int AS total ${WATCH_TRIGGERS}`;

/** The migration role is the table owner; this is the one session that may attach or detach a watch trigger. */
export function createPgcfDatabaseWatches(dependencies: {
  readonly readScope: ReadDatabaseScope;
  readonly provider: Pick<PgcfProjectProvider, "projectId" | "readConnection">;
  readonly connect: PgcfManagementDependencies["connect"];
}) {
  const { readScope, provider, connect } = dependencies;
  const ABSENT: DatabaseWatchOutcome = { status: "absent" };
  const refused = (code: DatabaseWatchRejection): DatabaseWatchOutcome => ({
    status: "rejected",
    code,
  });

  function session<T>(
    scope: DatabaseScope,
    work: (client: DatabaseMigrationClient) => Promise<T>,
  ): Promise<T> {
    return migrationSession({ provider, connect }, scope, work);
  }

  /** A busy migrations lock answers pending: the watch changes nothing and the caller retries. */
  function transaction(
    client: DatabaseMigrationClient,
    work: () => Promise<DatabaseWatchOutcome>,
  ): Promise<DatabaseWatchOutcome> {
    return migrationTransaction(client, work, refused("pending"));
  }

  async function tableOf(
    client: DatabaseMigrationClient,
    schema: string,
    table: string,
  ): Promise<TableRow | null> {
    const result = await client.query<TableRow>(
      `SELECT c.oid::text AS oid,
        (c.relkind='r' AND NOT c.relispartition AND c.relpersistence='p' AND c.relowner=current_user::regrole) AS eligible,
        ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=$2`,
      [schema, table],
    );
    return result.rows.length === 1 ? (result.rows[0] ?? null) : null;
  }

  async function watchCount(client: DatabaseMigrationClient): Promise<number> {
    const result = await client.query<{ total: number }>(COUNT_SQL);
    return result.rows[0]?.total ?? 0;
  }

  async function triggersOf(
    client: DatabaseMigrationClient,
    relation: string,
  ): Promise<readonly TriggerRow[]> {
    const result = await client.query<TriggerRow>(
      `SELECT t.tgname::text AS name, t.tgfoid = to_regprocedure('pgcf.capture()') AS capture,
        t.tgtype::int AS type, encode(t.tgargs,'escape') AS args
       FROM pg_trigger t WHERE t.tgrelid=$1::oid AND NOT t.tgisinternal`,
      [relation],
    );
    return result.rows;
  }

  async function create(
    scope: DatabaseScope,
    request: DatabaseWatchRequest,
  ): Promise<DatabaseWatchOutcome> {
    const name = await watchTriggerName(request.schema, request.table);
    return session(scope, (client) =>
      transaction(client, async () => {
        const installed = await client.query<{ installed: boolean }>(
          "SELECT to_regprocedure('pgcf.capture()') IS NOT NULL AS installed",
        );
        if (installed.rows[0]?.installed !== true) return refused("watch_events_unavailable");
        const table = await tableOf(client, request.schema, request.table);
        if (table === null || !table.eligible) return refused("watch_table_unavailable");
        if (!request.columns.every((column) => table.columns.includes(column)))
          return refused("watch_column_unavailable");
        const triggers = await triggersOf(client, table.oid);
        const ours = triggers.find((trigger) => trigger.name === name);
        if (
          triggers.some((trigger) => trigger.capture === true && trigger.name !== name) ||
          (ours !== undefined && ours.capture !== true)
        )
          return refused("watch_conflict");
        if (ours === undefined && (await watchCount(client)) >= DATABASE_PAGE_MAX_ITEMS)
          return refused("watch_limit");
        if (ours === undefined || !sameWatch(ours, request)) {
          if (ours !== undefined)
            await client.query(`DROP TRIGGER ${quoted(name)} ON ${qualified(request)}`);
          await client.query(watchTriggerSql(name, request));
        }
        return { status: "ok", value: watchValue(scope, name, request) };
      }),
    );
  }

  async function remove(
    scope: DatabaseScope,
    target: DatabaseWatchTarget,
  ): Promise<DatabaseWatchOutcome> {
    const name = await watchTriggerName(target.schema, target.table);
    return session(scope, (client) =>
      transaction(client, async () => {
        const found = await client.query(
          `SELECT 1 AS found FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname=$1 AND c.relname=$2 AND t.tgname=$3 AND NOT t.tgisinternal
             AND t.tgfoid=to_regprocedure('pgcf.capture()') AND c.relowner=current_user::regrole`,
          [target.schema, target.table, name],
        );
        if (found.rows.length !== 1) return ABSENT;
        await client.query(`DROP TRIGGER ${quoted(name)} ON ${qualified(target)}`);
        const value: unknown = { id: name, deleted: true };
        assertDatabaseWatchDeleted(value);
        return { status: "ok", value };
      }),
    );
  }

  async function list(scope: DatabaseScope): Promise<DatabaseWatchPage> {
    const result = await session(scope, (client) => client.query<WatchRow>(LIST_SQL));
    if (result.rows.length > DATABASE_PAGE_MAX_ITEMS)
      throw new Error("Database watch list exceeded its page limit");
    const value: unknown = {
      items: result.rows.map((row) =>
        watchValue(scope, row.name, {
          ...row,
          columns: argsOf(row.args),
          operations: operationsOf(row.type),
        }),
      ),
    };
    assertDatabaseWatchPage(value);
    return value;
  }

  async function run(request: DatabaseWatchCall): Promise<DatabaseWatchOutcome> {
    const scope = await resolveDatabaseScope({ readScope, provider }, request);
    if (scope === null) return ABSENT;
    switch (request.operation) {
      case "watch.list":
        return { status: "ok", value: await list(scope) };
      case "watch.create":
        if (!isDatabaseWatchSchema(request.schema)) return refused("watch_table_unavailable");
        return create(scope, request);
      case "watch.delete":
        if (!isDatabaseWatchSchema(request.schema)) return refused("watch_table_unavailable");
        return remove(scope, request);
    }
  }

  return { run };
}

function watchValue(
  scope: DatabaseScope,
  id: string,
  watch: Pick<DatabaseWatchRequest, "schema" | "table" | "columns" | "operations">,
): DatabaseWatch {
  const topic = dataEventTopic(watch.table);
  const value: unknown = {
    id,
    environment: scope.environment,
    schema: watch.schema,
    table: watch.table,
    columns: [...watch.columns],
    operations: canonicalOperations(watch.operations),
    topic,
    event_type: `data.${topic}`,
  };
  assertDatabaseWatch(value);
  return value;
}

/** The trigger matches the request when it is an AFTER ROW trigger of the same events and columns, in order. */
function sameWatch(trigger: TriggerRow, request: DatabaseWatchRequest): boolean {
  return (
    (trigger.type & 1) === 1 &&
    (trigger.type & 2) === 0 &&
    (trigger.type & 64) === 0 &&
    operationsOf(trigger.type).join(",") === canonicalOperations(request.operations).join(",") &&
    argsOf(trigger.args).join(",") === request.columns.join(",")
  );
}

/** The contract order insert, update, delete, whatever order the caller used. */
function canonicalOperations(
  operations: readonly DatabaseWatchOperation[],
): DatabaseWatchOperation[] {
  return DATABASE_WATCH_OPERATIONS.filter((operation) => operations.includes(operation));
}

function qualified(target: { readonly schema: string; readonly table: string }): string {
  return `${quoted(target.schema)}.${quoted(target.table)}`;
}

function operationsOf(type: number): DatabaseWatchOperation[] {
  return DATABASE_WATCH_OPERATIONS.filter((operation) => (type & OPERATION_BITS[operation]) !== 0);
}

/** pg_trigger.tgargs as escaped text: each argument followed by a NUL, shown as the four characters \000. */
function argsOf(args: string | null): string[] {
  return (args ?? "").split("\\000").filter((column) => column.length > 0);
}
