import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  type TransactionSettings,
} from "kysely";

import {
  createPrivateDatabaseClient,
  type CustomerDatabaseBinding,
  type CustomerDatabaseClient,
  type CustomerDatabaseParameter,
  type CustomerDatabaseRlsTransaction,
} from "./database.js";

interface Lease {
  readonly release: () => void;
  readonly closed: Promise<void>;
}

/** Compile Kysely queries inside an already-open withRls callback. The callback owns completion. */
export function createRlsTransactionDialect(transaction: CustomerDatabaseRlsTransaction): Dialect {
  return Object.freeze({
    createAdapter: () => new PostgresAdapter(),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createIntrospector: (kysely: Kysely<unknown>) => new PostgresIntrospector(kysely),
    createDriver: () => new RlsTransactionDriver(transaction),
  });
}

class RlsTransactionDriver implements Driver {
  readonly #connections = new Set<DatabaseConnection>();
  #destroyed = false;

  public async init(): Promise<void> {}

  public async acquireConnection(): Promise<DatabaseConnection> {
    if (this.#destroyed) throw new TypeError("The RLS database dialect is destroyed");
    const connection: DatabaseConnection = Object.freeze({
      executeQuery: async <Row>(query: CompiledQuery): Promise<QueryResult<Row>> => {
        if (!this.#connections.has(connection))
          throw new TypeError("The RLS database connection is released");
        const result = await this.transaction.query({
          text: query.sql,
          values: query.parameters as readonly CustomerDatabaseParameter[],
        });
        return {
          rows: [...result.rows] as Row[],
          ...(["INSERT", "UPDATE", "DELETE", "MERGE"].includes(result.command) &&
          result.rowCount !== null
            ? { numAffectedRows: BigInt(result.rowCount) }
            : {}),
        };
      },
      streamQuery<Row>(): AsyncIterableIterator<QueryResult<Row>> {
        throw new TypeError("RLS database streaming is not supported");
      },
    });
    this.#connections.add(connection);
    return connection;
  }

  public async beginTransaction(): Promise<void> {
    throw new TypeError("RLS transaction lifecycle belongs to withRls");
  }

  public async commitTransaction(): Promise<void> {
    throw new TypeError("RLS transaction lifecycle belongs to withRls");
  }

  public async rollbackTransaction(): Promise<void> {
    throw new TypeError("RLS transaction lifecycle belongs to withRls");
  }

  public async releaseConnection(connection: DatabaseConnection): Promise<void> {
    this.#connections.delete(connection);
  }

  public async destroy(): Promise<void> {
    this.#destroyed = true;
    this.#connections.clear();
  }

  public constructor(private readonly transaction: CustomerDatabaseRlsTransaction) {}
}

/** Kysely's supported 0.29 patch line, from 0.29.5, over the private RPC binding. */
export function createPrivateDatabaseDialect(binding: CustomerDatabaseBinding): Dialect {
  const database = createPrivateDatabaseClient(binding);
  return Object.freeze({
    createAdapter: () => new PostgresAdapter(),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createIntrospector: (kysely: Kysely<unknown>) => new PostgresIntrospector(kysely),
    createDriver: () => new PrivateDatabaseDriver(database),
  });
}

class PrivateDatabaseDriver implements Driver {
  readonly #leases = new Map<DatabaseConnection, Lease>();
  readonly #pending = new Set<Promise<void>>();
  #destroyed = false;

  public async init(): Promise<void> {}

  public async acquireConnection(): Promise<DatabaseConnection> {
    if (this.#destroyed) throw new TypeError("The private database dialect is destroyed");
    const acquired = Promise.withResolvers<DatabaseConnection>();
    const released = Promise.withResolvers<undefined>();
    const closed = this.database.withConnection(async (held) => {
      if (this.#destroyed) throw new TypeError("The private database dialect is destroyed");
      const connection: DatabaseConnection = Object.freeze({
        executeQuery: async <Row>(query: CompiledQuery): Promise<QueryResult<Row>> => {
          if (!this.#leases.has(connection)) {
            throw new TypeError("The private database connection is released");
          }
          const result = await held.query({
            text: query.sql,
            values: query.parameters as readonly CustomerDatabaseParameter[],
          });
          return {
            rows: [...result.rows] as Row[],
            ...(["INSERT", "UPDATE", "DELETE", "MERGE"].includes(result.command) &&
            result.rowCount !== null
              ? { numAffectedRows: BigInt(result.rowCount) }
              : {}),
          };
        },
        streamQuery<Row>(): AsyncIterableIterator<QueryResult<Row>> {
          throw new TypeError("Private database streaming is not supported");
        },
      });
      this.#leases.set(connection, { release: () => released.resolve(undefined), closed });
      acquired.resolve(connection);
      await released.promise;
    });
    this.#pending.add(closed);
    void closed.then(
      () => {
        this.#pending.delete(closed);
      },
      (error: unknown) => {
        this.#pending.delete(closed);
        acquired.reject(error);
      },
    );
    return acquired.promise;
  }

  public async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    let text = "begin";
    if (settings.isolationLevel !== undefined || settings.accessMode !== undefined) {
      text = "start transaction";
      if (settings.isolationLevel !== undefined)
        text += ` isolation level ${settings.isolationLevel}`;
      if (settings.accessMode !== undefined) text += ` ${settings.accessMode}`;
    }
    await connection.executeQuery(CompiledQuery.raw(text));
  }

  public async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  public async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  public async releaseConnection(connection: DatabaseConnection): Promise<void> {
    const lease = this.#leases.get(connection);
    if (lease === undefined) return;
    this.#leases.delete(connection);
    lease.release();
    await lease.closed;
  }

  public async destroy(): Promise<void> {
    this.#destroyed = true;
    await Promise.all(
      [...this.#leases.keys()].map((connection) => this.releaseConnection(connection)),
    );
    await Promise.allSettled([...this.#pending]);
  }

  public constructor(private readonly database: CustomerDatabaseClient) {}
}
