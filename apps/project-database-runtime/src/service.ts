import { DatabaseError, types as postgresTypes, type ClientConfig } from "pg";
import { isWorkerPostgresDatabaseError } from "@ohmyhost/database";
import { normalizeRlsIdentity } from "@ohmyhost/customer-runtime/database-rls";

const MAX_QUERY_BYTES = 64 * 1024;
const MAX_PARAMETERS = 100;
const MAX_TRANSACTION_QUERIES = 25;
const MAX_RESULT_ROWS = 1_000;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_NODES = 10_000;
// pg-types' TypeId enum lists no array types; these are PostgreSQL's date[] and text[] OIDs.
const DATE_ARRAY_OID: number = 1182;
const TEXT_ARRAY_OID: number = 1009;

export class ProjectDatabaseInputError extends Error {
  public readonly code = "project_database_input_invalid";

  public constructor() {
    super("Project database input is invalid");
    this.name = "ProjectDatabaseInputError";
  }
}

export class ProjectDatabaseResultError extends Error {
  public readonly code = "project_database_result_invalid";

  public constructor() {
    super("Project database result is invalid");
    this.name = "ProjectDatabaseResultError";
  }
}

/** PostgreSQL's transaction-resolution-unknown code is already non-retryable in the SDK. */
export class ProjectDatabaseOutcomeUnknownError extends DatabaseError {
  public constructor() {
    super("database_transaction_outcome_unknown", 0, "error");
    this.code = "08007";
  }
}

export interface ProjectDatabaseQuery {
  readonly text: string;
  readonly values: readonly ProjectDatabaseParameter[];
}

export type ProjectDatabaseJson =
  | string
  | number
  | boolean
  | null
  | readonly ProjectDatabaseJson[]
  | Readonly<{ [key: string]: ProjectDatabaseJson }>;
export type ProjectDatabaseParameter = ProjectDatabaseJson | Date | Uint8Array;

export interface ProjectDatabaseQueryResult {
  readonly command: string;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}

export interface ProjectDatabaseClient {
  connect(): Promise<unknown>;
  on?(event: "error", listener: (error: Error) => void): unknown;
  query(input: {
    readonly text: string;
    readonly values: readonly ProjectDatabaseParameter[];
    readonly queryMode?: "extended";
  }): Promise<{
    readonly command: string;
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number | null;
  }>;
  end(): Promise<unknown>;
  terminate?(): Promise<unknown>;
}

export interface ProjectDatabaseServiceDependencies {
  readonly createClient: (configuration: ClientConfig) => ProjectDatabaseClient;
}
export interface DatabaseOperationDeadline {
  run<T>(operation: () => Promise<T>, onTimeout?: () => void): Promise<T>;
}

export interface ConnectedProjectDatabase {
  query(input: unknown): Promise<ProjectDatabaseQueryResult>;
  close(): Promise<void>;
}

export function createProjectDatabaseService(
  connectionString: string,
  dependencies: ProjectDatabaseServiceDependencies,
) {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new ProjectDatabaseInputError();
  }
  return Object.freeze({
    query: async (input: unknown) => {
      const query = readStandaloneQuery(input);
      // A write that returns rows commits only after its result passed the response limits, so a
      // rejected oversized RETURNING never leaves committed rows that a retry would duplicate.
      // Every other statement keeps autocommit, which CREATE INDEX CONCURRENTLY and VACUUM need.
      const first = leadingSqlWords(query.text)[0] ?? "";
      const returnsWrittenRows =
        first === "WITH" ||
        (["INSERT", "UPDATE", "DELETE", "MERGE"].includes(first) &&
          /\breturning\b/iu.test(query.text));
      const [result] = await execute(connectionString, dependencies, [query], returnsWrittenRows);
      return result as ProjectDatabaseQueryResult;
    },
    transaction: async (input: unknown) =>
      execute(connectionString, dependencies, readTransaction(input), true),
  });
}

/** QA operations are always transactional so authority is checked again immediately before commit. */
export async function executeQaDatabase(
  connectionString: string,
  dependencies: ProjectDatabaseServiceDependencies,
  operation: "query" | "transaction",
  input: unknown,
  authorize: () => Promise<void>,
  deadline: DatabaseOperationDeadline,
): Promise<ProjectDatabaseQueryResult | readonly ProjectDatabaseQueryResult[]> {
  if (typeof connectionString !== "string" || connectionString.length === 0)
    throw new ProjectDatabaseInputError();
  const queries = operation === "query" ? [readStandaloneQuery(input)] : readTransaction(input);
  const results = await execute(connectionString, dependencies, queries, true, authorize, deadline);
  return operation === "query" ? (results[0] as ProjectDatabaseQueryResult) : results;
}

/** Preserve ordinary query semantics, with current preview authority at dispatch and commit. */
export async function executePreviewDatabase(
  connectionString: string,
  dependencies: ProjectDatabaseServiceDependencies,
  operation: "query" | "transaction",
  input: unknown,
  authorize: () => Promise<void>,
  deadline: DatabaseOperationDeadline,
): Promise<ProjectDatabaseQueryResult | readonly ProjectDatabaseQueryResult[]> {
  if (!connectionString) throw new ProjectDatabaseInputError();
  const queries = operation === "query" ? [readStandaloneQuery(input)] : readTransaction(input);
  const query = queries[0] as ProjectDatabaseQuery;
  const first = leadingSqlWords(query.text)[0] ?? "";
  const transactional =
    operation === "transaction" ||
    first === "WITH" ||
    ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(first);
  const results = await execute(
    connectionString,
    dependencies,
    queries,
    transactional,
    authorize,
    deadline,
  );
  return operation === "query" ? (results[0] as ProjectDatabaseQueryResult) : results;
}

/**
 * Transaction-scoped advisory slots provide a database-enforced bound in addition to the
 * physical-environment pool. A logical callback never owns a pooled backend session.
 */
const HELD_CONNECTION_SLOTS = 2;
const HELD_CONNECTION_MAX_STATEMENTS = 100;
const HELD_CONNECTION_MAX_LIFETIME_MS = 30_000;
const HELD_CONNECTION_IDLE_TIMEOUT_MS = 5_000;

export class ProjectDatabaseBusyError extends Error {
  public constructor() {
    super("No held database connection is available for this project environment");
    this.name = "ProjectDatabaseBusyError";
  }
}

export interface BoundedProjectDatabaseConnection {
  query(input: unknown): Promise<unknown>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export class ProjectDatabaseRlsError extends Error {
  public constructor(
    public readonly code:
      | "database_rls_transaction_failed"
      | "database_transaction_outcome_unknown" = "database_rls_transaction_failed",
  ) {
    super(code);
    this.name = "ProjectDatabaseRlsError";
  }
}

export interface RlsProjectDatabaseConnection extends BoundedProjectDatabaseConnection {
  commit(): Promise<void>;
}

/** A server-owned transaction: callers receive SQL access, never transaction ownership. */
export async function connectRlsProjectDatabase(
  connectionString: string,
  dependencies: ProjectDatabaseServiceDependencies,
  slotKey: number,
  identity: unknown,
  authorize: () => Promise<unknown>,
  clock: () => number = () => Date.now(),
): Promise<RlsProjectDatabaseConnection> {
  if (typeof connectionString !== "string" || connectionString.length === 0)
    throw new ProjectDatabaseInputError();
  const claims = normalizeRlsIdentity(identity);
  const client = dependencies.createClient(clientConfiguration(connectionString));
  let openedAt = clock();
  let lastUsedAt = openedAt;
  let statements = 0;
  let status: "active" | "failed" | "committed" | "unknown" = "active";
  let transactionOpen = false;
  let released = false;
  const settle = () => undefined;
  const release = async (destroy: boolean) => {
    if (released) return;
    released = true;
    try {
      if (destroy && client.terminate) await client.terminate();
      else await client.end();
    } catch {
      // A failed cleanup can never return an uncertain session to the pool.
      await (client.terminate ? client.terminate() : client.end()).catch(settle);
    }
  };
  const control = (text: string) => executeQuery(client, { text, values: [] });
  const rollback = async () => {
    if (status === "active") status = "failed";
    if (released) return;
    try {
      if (transactionOpen) await control("ROLLBACK");
      transactionOpen = false;
      await release(false);
    } catch {
      transactionOpen = false;
      await release(true);
    }
  };
  client.on?.("error", () => {
    if (status === "active") status = "failed";
    transactionOpen = false;
    void release(true);
  });
  let pending = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work);
    pending = result.then(settle, settle);
    return result;
  };
  const check = () => {
    if (status !== "active" || released)
      throw new ProjectDatabaseRlsError(
        status === "unknown"
          ? "database_transaction_outcome_unknown"
          : "database_rls_transaction_failed",
      );
    const now = clock();
    if (
      now - openedAt >= HELD_CONNECTION_MAX_LIFETIME_MS ||
      now - lastUsedAt >= HELD_CONNECTION_IDLE_TIMEOUT_MS
    )
      throw new ProjectDatabaseInputError();
  };
  try {
    await client.connect();
    openedAt = clock();
    lastUsedAt = openedAt;
    await authorize();
    // Once BEGIN is dispatched its acknowledgement can be lost; cleanup must still roll back.
    transactionOpen = true;
    await control("BEGIN");
    await control(
      `SET LOCAL idle_in_transaction_session_timeout='${HELD_CONNECTION_IDLE_TIMEOUT_MS}ms'`,
    );
    const remaining = HELD_CONNECTION_MAX_LIFETIME_MS - (clock() - openedAt);
    if (remaining <= 0) throw new ProjectDatabaseInputError();
    await control(`SET LOCAL transaction_timeout='${remaining}ms'`);
    let acquired = false;
    for (let slot = 0; slot < HELD_CONNECTION_SLOTS; slot += 1) {
      const result = await executeQuery(client, {
        text: "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
        values: [slotKey, slot],
      });
      if (result.rows[0]?.["held"] === true) {
        acquired = true;
        break;
      }
    }
    if (!acquired) throw new ProjectDatabaseBusyError();
    await executeQuery(client, {
      text: "SELECT set_config('ohmyhost.request_claims', $1, true)",
      values: [JSON.stringify(claims)],
    });
    await authorize();
    lastUsedAt = clock();
    check();
  } catch (error) {
    await rollback();
    throw error;
  }
  return Object.freeze({
    query(input: unknown) {
      return serial(async () => {
        try {
          check();
          await authorize();
          check();
          if (statements >= HELD_CONNECTION_MAX_STATEMENTS) throw new ProjectDatabaseInputError();
          const statement = readStandaloneQuery(input);
          if (["CALL", "DO"].includes(leadingSqlWords(statement.text)[0] ?? ""))
            throw new ProjectDatabaseInputError();
          statements += 1;
          const result = await executeQuery(client, statement);
          if (released) throw new ProjectDatabaseRlsError();
          return result;
        } catch (error) {
          await rollback();
          throw error;
        } finally {
          lastUsedAt = clock();
        }
      });
    },
    commit() {
      return serial(async () => {
        let dispatched = false;
        try {
          check();
          await authorize();
          check();
          dispatched = true;
          const result = await control("COMMIT");
          transactionOpen = false;
          if (result.command !== "COMMIT") {
            status = "failed";
            throw new ProjectDatabaseRlsError();
          }
          status = "committed";
          await release(false);
        } catch (error) {
          if (dispatched) {
            // Once COMMIT was sent, lost acknowledgement is never safe to retry.
            if (status !== "failed" || !(error instanceof ProjectDatabaseRlsError))
              status = "unknown";
            await release(true);
            throw new ProjectDatabaseRlsError(
              status === "unknown"
                ? "database_transaction_outcome_unknown"
                : "database_rls_transaction_failed",
            );
          }
          await rollback();
          throw error instanceof ProjectDatabaseRlsError ? error : new ProjectDatabaseRlsError();
        }
      });
    },
    close: () => serial(rollback),
    async abort() {
      if (status === "active") status = "failed";
      transactionOpen = false;
      await release(true);
    },
  });
}

export async function connectBoundedProjectDatabase(
  connectionString: string,
  dependencies: ProjectDatabaseServiceDependencies,
  slotKey: number,
  clock: () => number = () => Date.now(),
  authorize: () => Promise<unknown> = async () => undefined,
): Promise<BoundedProjectDatabaseConnection> {
  if (typeof connectionString !== "string" || connectionString.length === 0)
    throw new ProjectDatabaseInputError();
  const client = dependencies.createClient(clientConfiguration(connectionString));
  await client.connect();
  const openedAt = clock();
  let lastUsedAt = openedAt;
  let statements = 0;
  let closed = false;
  let transactionOpen = false;
  const settle = () => undefined;
  client.on?.("error", () => {
    // Server-side idle/lifetime expiry may arrive between RPC calls, with no pending query.
    closed = true;
    transactionOpen = false;
    void client.end().catch(settle);
  });
  let pending = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work);
    pending = result.then(settle, settle);
    return result;
  };
  const query = (input: ProjectDatabaseQuery) => executeQuery(client, input, true);
  const control = (text: string) => query({ text, values: [] });
  const rollback = async () => {
    try {
      await control("ROLLBACK");
    } finally {
      transactionOpen = false;
    }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (transactionOpen) await rollback();
    } finally {
      await client.end();
    }
  };
  const acquire = async () => {
    const remaining = HELD_CONNECTION_MAX_LIFETIME_MS - (clock() - openedAt);
    if (remaining <= 0) throw new ProjectDatabaseInputError();
    // These settings stay on the pinned transaction, including when its caller disappears.
    // transaction_timeout is supported by the platform's PostgreSQL 17+ baseline.
    await control(
      `SET LOCAL idle_in_transaction_session_timeout='${HELD_CONNECTION_IDLE_TIMEOUT_MS}ms'`,
    );
    await control(
      `SET LOCAL transaction_timeout='${Math.min(HELD_CONNECTION_MAX_LIFETIME_MS, remaining)}ms'`,
    );
    for (let slot = 0; slot < HELD_CONNECTION_SLOTS; slot += 1) {
      const attempt = await query({
        text: "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS held",
        values: [slotKey, slot],
      });
      if (attempt.rows[0]?.["held"] === true) return;
    }
    throw new ProjectDatabaseBusyError();
  };
  const begin = async (input: ProjectDatabaseQuery) => {
    const result = await query(input);
    transactionOpen = true;
    try {
      await acquire();
    } catch (error) {
      try {
        await rollback();
      } catch {
        await close();
      }
      throw error;
    }
    return result;
  };
  return Object.freeze({
    query(input: unknown) {
      return serial(async () => {
        try {
          const now = clock();
          if (
            statements >= HELD_CONNECTION_MAX_STATEMENTS ||
            now - openedAt > HELD_CONNECTION_MAX_LIFETIME_MS ||
            now - lastUsedAt > HELD_CONNECTION_IDLE_TIMEOUT_MS
          ) {
            await close();
            throw new ProjectDatabaseInputError();
          }
          // Within its limits a closed connection lost its socket; that stays a transient failure.
          if (closed) throw new Error("project_database_connection_closed");
          const statement = readQuery(input);
          await authorize();
          const words = leadingSqlWords(statement.text);
          const first = words[0];
          const starts = first === "BEGIN" || (first === "START" && words[1] === "TRANSACTION");
          const rollsBackTo = first === "ROLLBACK" && (words[1] === "TO" || words[2] === "TO");
          const finishes =
            ["COMMIT", "END", "ROLLBACK", "ABORT"].includes(first ?? "") && !rollsBackTo;
          if (
            ["SET", "RESET", "DISCARD"].includes(first ?? "") ||
            (first === "PREPARE" && words[1] === "TRANSACTION") ||
            (finishes && words.includes("CHAIN"))
          )
            throw new ProjectDatabaseInputError();
          statements += 1;
          if (starts && !transactionOpen) return await begin(statement);
          if (
            transactionOpen ||
            finishes ||
            rollsBackTo ||
            first === "SAVEPOINT" ||
            first === "RELEASE"
          ) {
            const result = await query(statement);
            if (finishes) transactionOpen = false;
            return result;
          }
          // Preserve autocommit: the caller sees success only after this statement is committed.
          await begin({ text: "BEGIN", values: [] });
          try {
            const result = await query(statement);
            await authorize();
            await control("COMMIT");
            transactionOpen = false;
            return result;
          } catch (error) {
            try {
              await rollback();
            } catch {
              await close().catch(settle);
            }
            throw error;
          }
        } finally {
          // Active SQL time is not idle time; the absolute openedAt deadline never moves.
          lastUsedAt = clock();
        }
      });
    },
    close: () => serial(close),
    async abort() {
      if (closed) return;
      closed = true;
      transactionOpen = false;
      await (client.terminate ? client.terminate() : client.end());
    },
  });
}

/** Transaction keywords may follow whitespace and nested PostgreSQL comments. The extended
 * query protocol independently rejects multiple statements before any of them executes. */
function leadingSqlWords(text: string): readonly string[] {
  const words: string[] = [];
  let offset = 0;
  while (offset < text.length && words.length < 6) {
    if (/\s/u.test(text[offset] ?? "")) {
      offset += 1;
      continue;
    }
    if (text.startsWith("--", offset)) {
      const end = text.indexOf("\n", offset + 2);
      offset = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", offset)) {
      let depth = 1;
      offset += 2;
      while (offset < text.length && depth > 0) {
        if (text.startsWith("/*", offset)) {
          depth += 1;
          offset += 2;
        } else if (text.startsWith("*/", offset)) {
          depth -= 1;
          offset += 2;
        } else offset += 1;
      }
      if (depth !== 0) throw new ProjectDatabaseInputError();
      continue;
    }
    if (words.length === 0 && text[offset] === ";") throw new ProjectDatabaseInputError();
    const word = /^[a-z_]+/iu.exec(text.slice(offset))?.[0];
    if (!word) break;
    words.push(word.toUpperCase());
    offset += word.length;
  }
  return words;
}

export async function connectProjectDatabase(
  connectionString: string,
  dependencies: ProjectDatabaseServiceDependencies,
): Promise<ConnectedProjectDatabase> {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new ProjectDatabaseInputError();
  }
  const client = dependencies.createClient(clientConfiguration(connectionString));
  await client.connect();
  let closed = false;
  return Object.freeze({
    async query(input: unknown) {
      if (closed) throw new ProjectDatabaseInputError();
      return executeQuery(client, readQuery(input));
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.end();
    },
  });
}

async function execute(
  connectionString: string,
  dependencies: ProjectDatabaseServiceDependencies,
  queries: readonly ProjectDatabaseQuery[],
  transactional: boolean,
  authorize?: () => Promise<void>,
  deadline?: DatabaseOperationDeadline,
): Promise<readonly ProjectDatabaseQueryResult[]> {
  const client = dependencies.createClient(clientConfiguration(connectionString));
  let connected = false;
  let timedOut = false;
  const terminate = () => {
    timedOut = true;
    void (client.terminate ? client.terminate() : client.end()).catch(() => undefined);
  };
  const run = <T>(work: () => Promise<T>) => (deadline ? deadline.run(work, terminate) : work());
  try {
    await run(() => client.connect());
    connected = true;
    if (authorize) await run(authorize);
    if (transactional) await run(() => executeControl(client, "BEGIN"));
    const results: ProjectDatabaseQueryResult[] = [];
    for (const query of queries) results.push(await run(() => executeQuery(client, query)));
    if (transactional) {
      if (authorize) await run(authorize);
      await run(() => executeControl(client, "COMMIT"));
    }
    return Object.freeze(results);
  } catch (error) {
    if (transactional && connected && !timedOut) {
      try {
        await run(() => executeControl(client, "ROLLBACK"));
      } catch {
        // The original bounded database error remains authoritative.
      }
    }
    throw error;
  } finally {
    if (!timedOut) {
      try {
        await client.end();
      } catch {
        // Preserve the acknowledged result or the original failure. Disposal cannot turn a
        // confirmed commit into an error that would encourage a duplicate business write.
      }
    }
  }
}

function clientConfiguration(connectionString: string): ClientConfig {
  return {
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 12_000,
    statement_timeout: 10_000,
    types: {
      getTypeParser(oid, format) {
        // A SQL calendar day has no timezone. Preserve its wire value instead of creating a Date,
        // including inside a date[] (OID 1182), which is then parsed like a text[] (OID 1009).
        if (oid === 1082 && (format === undefined || format === "text"))
          return (value: string) => value;
        if (oid === DATE_ARRAY_OID && (format === undefined || format === "text"))
          return postgresTypes.getTypeParser(TEXT_ARRAY_OID, format);
        return postgresTypes.getTypeParser(oid, format);
      },
    },
  };
}

async function executeControl(
  client: ProjectDatabaseClient,
  text: "BEGIN" | "COMMIT" | "ROLLBACK",
) {
  await dispatchQuery(client, { text, values: [] });
}

async function dispatchQuery(
  client: ProjectDatabaseClient,
  query: Parameters<ProjectDatabaseClient["query"]>[0],
) {
  try {
    return await client.query(query);
  } catch (error) {
    // BEGIN and ROLLBACK cannot commit customer work. Every other dispatched statement may
    // write (including a SELECT calling a function), and a lost acknowledgement proves nothing.
    if (
      query.text === "BEGIN" ||
      query.text === "ROLLBACK" ||
      (isWorkerPostgresDatabaseError(error) &&
        typeof error.code === "string" &&
        /^[0-9A-Z]{5}$/u.test(error.code))
    ) {
      throw error;
    }
    throw new ProjectDatabaseOutcomeUnknownError();
  }
}

async function executeQuery(
  client: ProjectDatabaseClient,
  query: ProjectDatabaseQuery,
  singleStatement = true,
): Promise<ProjectDatabaseQueryResult> {
  const result = await dispatchQuery(client, {
    text: query.text,
    values: query.values,
    ...(singleStatement ? { queryMode: "extended" as const } : {}),
  });
  if (!/^[A-Z][A-Z ]{0,31}$/u.test(result.command)) throw new ProjectDatabaseResultError();
  if (result.rows.length > MAX_RESULT_ROWS) throw new ProjectDatabaseResultError();
  const budget = { nodes: 0, bytes: 0 };
  const rows = result.rows.map((row) => readResultRecord(row, budget, 0));
  if (budget.bytes > MAX_RESULT_BYTES) throw new ProjectDatabaseResultError();
  return Object.freeze({
    command: result.command,
    rows: Object.freeze(rows),
    rowCount: result.rowCount,
  });
}

function readQuery(input: unknown): ProjectDatabaseQuery {
  if (!isRecord(input) || !hasExactKeys(input, ["text", "values"])) {
    throw new ProjectDatabaseInputError();
  }
  const text = input["text"];
  const values = input["values"];
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    new TextEncoder().encode(text).byteLength > MAX_QUERY_BYTES ||
    !Array.isArray(values) ||
    values.length > MAX_PARAMETERS
  ) {
    throw new ProjectDatabaseInputError();
  }
  return Object.freeze({ text, values: Object.freeze(values.map(readParameter)) });
}

function readStandaloneQuery(input: unknown): ProjectDatabaseQuery {
  const query = readQuery(input);
  const first = leadingSqlWords(query.text)[0];
  if (
    [
      "BEGIN",
      "START",
      "COMMIT",
      "END",
      "ROLLBACK",
      "ABORT",
      "SAVEPOINT",
      "RELEASE",
      "SET",
      "RESET",
      "DISCARD",
      "PREPARE",
    ].includes(first ?? "")
  )
    throw new ProjectDatabaseInputError();
  return query;
}

function readTransaction(input: unknown): readonly ProjectDatabaseQuery[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TRANSACTION_QUERIES) {
    throw new ProjectDatabaseInputError();
  }
  const queries = input.map(readStandaloneQuery);
  if (
    queries.some((query) =>
      /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:begin|commit|rollback|savepoint|release|set|reset|discard)\b/iu.test(
        query.text,
      ),
    )
  ) {
    throw new ProjectDatabaseInputError();
  }
  return Object.freeze(queries);
}

function readParameter(value: unknown): ProjectDatabaseParameter {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    value instanceof Date ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) || isRecord(value)) {
    const budget = { nodes: 0, bytes: 0 };
    try {
      const result = readResultValue(value, budget, 0);
      if (budget.bytes > MAX_QUERY_BYTES) throw new ProjectDatabaseInputError();
      return result as ProjectDatabaseJson;
    } catch {
      throw new ProjectDatabaseInputError();
    }
  }
  throw new ProjectDatabaseInputError();
}

function readResultRecord(
  value: unknown,
  budget: { nodes: number; bytes: number },
  depth: number,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new ProjectDatabaseResultError();
  return readResultValue(value, budget, depth) as Readonly<Record<string, unknown>>;
}

function readResultValue(
  value: unknown,
  budget: { nodes: number; bytes: number },
  depth: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) {
    throw new ProjectDatabaseResultError();
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProjectDatabaseResultError();
    budget.bytes += 8;
    return value;
  }
  if (typeof value === "string") {
    budget.bytes += new TextEncoder().encode(value).byteLength;
    return value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new ProjectDatabaseResultError();
    budget.bytes += 24;
    return new Date(value);
  }
  if (value instanceof Uint8Array) {
    budget.bytes += value.byteLength;
    return Uint8Array.from(value);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => readResultValue(item, budget, depth + 1)));
  }
  if (!isRecord(value)) throw new ProjectDatabaseResultError();
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const keyBytes = new TextEncoder().encode(key).byteLength;
    if (
      keyBytes < 1 ||
      keyBytes > 128 ||
      // Control characters are never valid public result-object keys.
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/u.test(key) ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      throw new ProjectDatabaseResultError();
    }
    budget.bytes += keyBytes;
    output[key] = readResultValue(value[key], budget, depth + 1);
  }
  return Object.freeze(output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}
