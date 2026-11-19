import {
  DATABASE_TABLE_LIMIT,
  DATABASE_TABLE_SCHEMA,
  assertDatabaseTableCreated,
  databaseTableReference,
  parseDatabaseTableCreateRequest,
  renderCreateTableStatement,
  type DatabaseTableCreated,
  type DatabaseTableRequest,
} from "@ohmyhost/contracts/database-tables";
import { projectSqlRoleName, type DatabaseMigrationClient } from "@ohmyhost/platform";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import {
  parseDatabaseRequest,
  resolveDatabaseScope,
  type DatabaseRequestEnvelope,
  type DatabaseRequestShapes,
  type DatabaseScope,
  type ReadDatabaseScope,
} from "./pgcf-database-request.js";
import { migrationSession, migrationTransaction } from "./pgcf-migration-session.js";
import type { PgcfManagementDependencies } from "./pgcf-runtime.js";

const SHAPES: DatabaseRequestShapes<"table.create"> = {
  "table.create": [["table", "columns"], ["primaryKey"]],
};

/** A parsed create request; the database comes from the product scope, never from the caller. */
export type DatabaseTableCall = DatabaseRequestEnvelope &
  DatabaseTableRequest & { readonly operation: "table.create" };

export type DatabaseTableRejection = "table_conflict" | "table_limit" | "pending";

export type DatabaseTableOutcome =
  | { readonly status: "ok"; readonly value: DatabaseTableCreated }
  | { readonly status: "absent" }
  | { readonly status: "rejected"; readonly code: DatabaseTableRejection };

export function parseDatabaseTableCall(value: unknown): DatabaseTableCall {
  const { operation, envelope, input } = parseDatabaseRequest(value, SHAPES);
  return {
    ...envelope,
    operation,
    ...parseDatabaseTableCreateRequest({
      table: input["table"],
      columns: input["columns"],
      primaryKey: input["primaryKey"],
    }),
  };
}

/** A column as the catalog spells it: the type by format_type, the identity by attidentity, the default expression. */
type CatalogColumn = {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly identity: string;
  readonly default: string | null;
};

type TableRow = {
  readonly oid: string;
  readonly eligible: boolean;
};

const CATALOG_TYPE_NAMES: Readonly<Record<string, string>> = {
  "timestamp with time zone": "timestamptz",
};
const CATALOG_DEFAULTS: Readonly<Record<string, string>> = {
  "now()": "now",
  "gen_random_uuid()": "uuid",
};

/** The table of that name in the public schema, ordinary or not; the lock makes the answer hold until commit. */
const TABLE_SQL = `SELECT c.oid::text AS oid,
  (c.relkind='r' AND NOT c.relispartition AND c.relpersistence='p' AND c.relowner=current_user::regrole) AS eligible
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname=$1`;

/** Ordinary and partitioned tables of the public schema, the ones the database limit counts. */
const COUNT_SQL = `SELECT count(*)::int AS total
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')`;

const COLUMNS_SQL = `SELECT a.attname::text AS name, format_type(a.atttypid,a.atttypmod) AS type,
  NOT a.attnotnull AS nullable, a.attidentity::text AS identity, pg_get_expr(d.adbin,d.adrelid) AS "default"
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped
ORDER BY a.attnum`;

const KEY_SQL = `SELECT a.attname::text AS key_column
FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
WHERE i.indrelid=$1::oid AND i.indisprimary
ORDER BY k.ord`;

/**
 * The canonical text of a definition: the request and the catalog compare as one value, columns in attribute order.
 * Identity is "always" or empty; a default is "now", "uuid", or the catalog expression of any other default.
 */
function requestShape(request: DatabaseTableRequest): string {
  return JSON.stringify([
    request.columns.map((column) => [
      column.name,
      column.type,
      column.nullable,
      column.identity ? "always" : "",
      column.default ?? "",
    ]),
    request.primaryKey,
  ]);
}

function catalogShape(columns: readonly CatalogColumn[], primaryKey: readonly string[]): string {
  return JSON.stringify([
    columns.map((column) => [
      column.name,
      CATALOG_TYPE_NAMES[column.type] ?? column.type,
      column.nullable,
      column.identity === "a" ? "always" : column.identity,
      column.default === null ? "" : (CATALOG_DEFAULTS[column.default] ?? column.default),
    ]),
    primaryKey,
  ]);
}

/** Creates a table of the public schema as the migration role, so the table watches and migrations own it. */
export function createPgcfDatabaseTables(dependencies: {
  readonly readScope: ReadDatabaseScope;
  readonly provider: Pick<PgcfProjectProvider, "projectId" | "readConnection">;
  readonly connect: PgcfManagementDependencies["connect"];
}) {
  const { readScope, provider, connect } = dependencies;
  const ABSENT: DatabaseTableOutcome = { status: "absent" };
  const refused = (code: DatabaseTableRejection): DatabaseTableOutcome => ({
    status: "rejected",
    code,
  });

  function created(request: DatabaseTableRequest, isNew: boolean): DatabaseTableOutcome {
    const value: unknown = {
      table: {
        schema: DATABASE_TABLE_SCHEMA,
        table: request.table,
        columns: [...request.columns],
        primaryKey: [...request.primaryKey],
      },
      created: isNew,
    };
    assertDatabaseTableCreated(value);
    return { status: "ok", value };
  }

  async function definitionOf(client: DatabaseMigrationClient, oid: string): Promise<string> {
    const columns = await client.query<CatalogColumn>(COLUMNS_SQL, [oid]);
    const key = await client.query<{ key_column: string }>(KEY_SQL, [oid]);
    return catalogShape(
      columns.rows,
      key.rows.map((row) => row.key_column),
    );
  }

  /** An identical table is answered, even at the limit; a new one is refused once the schema holds the limit. */
  async function change(
    client: DatabaseMigrationClient,
    physicalEnvironmentId: string,
    request: DatabaseTableRequest,
  ): Promise<DatabaseTableOutcome> {
    const existing = (await client.query<TableRow>(TABLE_SQL, [request.table])).rows[0];
    if (existing !== undefined) {
      if (!existing.eligible) return refused("table_conflict");
      const same = (await definitionOf(client, existing.oid)) === requestShape(request);
      return same ? created(request, false) : refused("table_conflict");
    }
    const total = await client.query<{ total: number }>(COUNT_SQL);
    if ((total.rows[0]?.total ?? 0) >= DATABASE_TABLE_LIMIT) return refused("table_limit");
    await client.query(renderCreateTableStatement(request));
    await grantRuntimeAccess(client, physicalEnvironmentId, request);
    return created(request, true);
  }

  /**
   * The grants a migration gives its tables: the runtime role reads and writes the table and draws on its identity
   * sequence, the read-only role reads. Migrations get these from default privileges, which a database that never
   * migrated lacks, so this table receives them explicitly.
   */
  async function grantRuntimeAccess(
    client: DatabaseMigrationClient,
    physicalEnvironmentId: string,
    request: DatabaseTableRequest,
  ): Promise<void> {
    const runtime = projectSqlRoleName(physicalEnvironmentId, "runtime");
    const readonly = projectSqlRoleName(physicalEnvironmentId, "readonly");
    const table = databaseTableReference(request.table);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${table} TO ${runtime}`);
    await client.query(`GRANT SELECT ON TABLE ${table} TO ${readonly}`);
    const identity = request.columns.find((column) => column.identity);
    if (identity === undefined) return;
    // The server returns the sequence name already quoted for SQL; no caller text is part of it.
    const sequence = await client.query<{ sequence: string | null }>(
      "SELECT pg_get_serial_sequence($1, $2) AS sequence",
      [table, identity.name],
    );
    const name = sequence.rows[0]?.sequence;
    if (typeof name !== "string") throw new Error("Created identity column has no sequence");
    await client.query(`GRANT USAGE,SELECT,UPDATE ON SEQUENCE ${name} TO ${runtime}`);
    await client.query(`GRANT SELECT ON SEQUENCE ${name} TO ${readonly}`);
  }

  async function run(call: DatabaseTableCall): Promise<DatabaseTableOutcome> {
    const scope: DatabaseScope | null = await resolveDatabaseScope({ readScope, provider }, call);
    if (scope === null) return ABSENT;
    return migrationSession({ provider, connect }, scope, (client) =>
      migrationTransaction(
        client,
        () => change(client, scope.physicalEnvironmentId, call),
        refused("pending"),
      ),
    );
  }

  return { run };
}
