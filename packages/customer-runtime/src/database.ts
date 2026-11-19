import { CustomerDatabaseError, CustomerRuntimeError } from "./errors.js";
import { normalizeRlsIdentity, type CustomerDatabaseRlsIdentity } from "./database-rls.js";

export type { CustomerDatabaseRlsIdentity } from "./database-rls.js";

const MAX_QUERY_BYTES = 64 * 1024;
const MAX_PARAMETERS = 100;
const MAX_PARAMETER_BYTES = 1024 * 1024;
const MAX_JSON_PARAMETER_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 128;
const MAX_TRANSACTION_QUERIES = 25;
const MAX_RESULT_ROWS = 1_000;
const MAX_RESULT_NODES = 10_000;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_VALUE_DEPTH = 8;

export type CustomerDatabaseJson =
  | string
  | number
  | boolean
  | null
  | readonly CustomerDatabaseJson[]
  | Readonly<{ [key: string]: CustomerDatabaseJson }>;

export type CustomerDatabaseParameter = CustomerDatabaseJson | Date | Uint8Array;

export interface CustomerDatabaseQuery {
  readonly text: string;
  readonly values: readonly CustomerDatabaseParameter[];
}

export interface CustomerDatabaseQueryResult {
  readonly command: string;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}

export interface CustomerDatabaseBinding {
  query(input: unknown): Promise<unknown>;
  transaction(input: unknown): Promise<unknown>;
  open?(): Promise<CustomerDatabaseConnectionStub>;
  openRls?(
    identity: CustomerDatabaseRlsIdentity | null,
  ): Promise<CustomerDatabaseRlsConnectionStub>;
}

/** Private lifecycle RPC. Only query is exposed to the application callback. */
export interface CustomerDatabaseRlsConnectionStub extends CustomerDatabaseConnectionStub {
  commit(): Promise<unknown>;
}

/** An existing identity-scoped transaction owned by withRls. */
export interface CustomerDatabaseRlsTransaction {
  query(input: CustomerDatabaseQuery): Promise<CustomerDatabaseQueryResult>;
}

/** The server-side held connection, reached through a stub. Never handed to customer code raw. */
export interface CustomerDatabaseConnectionStub {
  query(input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** What a callback may do inside a held connection: one statement at a time, including BEGIN. */
export interface CustomerDatabaseConnection {
  query(input: CustomerDatabaseQuery): Promise<CustomerDatabaseQueryResult>;
}

export interface CustomerDatabaseClient {
  /** Authenticate in application code first; null explicitly selects anonymous policies. */
  withRls<Result>(
    identity: CustomerDatabaseRlsIdentity | null,
    run: (transaction: CustomerDatabaseRlsTransaction) => Promise<Result>,
  ): Promise<Result>;
  /**
   * Run a read, a decision and a write on one connection. The callback shape is deliberate: the
   * connection is always released, including when the callback throws, so a customer cannot leak
   * one and pin a database connection their whole project shares.
   */
  withConnection<Result>(
    run: (connection: CustomerDatabaseConnection) => Promise<Result>,
  ): Promise<Result>;
  query(input: CustomerDatabaseQuery): Promise<CustomerDatabaseQueryResult>;
  transaction(
    queries: readonly CustomerDatabaseQuery[],
  ): Promise<readonly CustomerDatabaseQueryResult[]>;
}

export function createPrivateDatabaseClient(
  binding: CustomerDatabaseBinding,
): CustomerDatabaseClient {
  if (
    typeof binding !== "object" ||
    binding === null ||
    typeof binding.query !== "function" ||
    typeof binding.transaction !== "function"
  ) {
    throw new CustomerRuntimeError(
      "database_binding_missing",
      false,
      "pass the OHMYHOST_DATABASE binding from the Worker env (Next.js: getCloudflareContext({ async: true }).env), not process.env. It exists only in server code of a deployment whose ohmyhost.yaml sets database.enabled: true.",
    );
  }
  return Object.freeze({
    withRls<Result>(
      identity: CustomerDatabaseRlsIdentity | null,
      run: (transaction: CustomerDatabaseRlsTransaction) => Promise<Result>,
    ): Promise<Result> {
      return runRlsTransaction(binding, identity, run);
    },
    async withConnection<Result>(
      run: (connection: CustomerDatabaseConnection) => Promise<Result>,
    ): Promise<Result> {
      if (typeof binding.open !== "function") throw unavailable();
      let stub: CustomerDatabaseConnectionStub;
      try {
        stub = await binding.open();
      } catch {
        throw unavailable();
      }
      try {
        return await run(
          Object.freeze({
            async query(input: CustomerDatabaseQuery) {
              const parsed = validateQuery(input, undefined, true);
              let raw: unknown;
              try {
                raw = await stub.query(parsed);
              } catch {
                throw unavailable();
              }
              throwStatementFailure(raw);
              return validateResult(raw);
            },
          }),
        );
      } finally {
        // Ending the connection rolls back anything uncommitted and frees the project's slot.
        await stub.close().catch(() => undefined);
      }
    },
    async query(input: CustomerDatabaseQuery) {
      const parsed = validateQuery(input);
      let raw: unknown;
      try {
        raw = await binding.query(parsed);
      } catch {
        throw unavailable();
      }
      throwStatementFailure(raw);
      return validateResult(raw);
    },
    async transaction(queries: readonly CustomerDatabaseQuery[]) {
      const parsed = validateTransaction(queries);
      let raw: unknown;
      try {
        raw = await binding.transaction(parsed);
      } catch {
        throw unavailable();
      }
      throwStatementFailure(raw);
      if (!Array.isArray(raw) || raw.length !== parsed.length) invalidResponse();
      return Object.freeze(raw.map(validateResult));
    },
  });
}

async function runRlsTransaction<Result>(
  binding: CustomerDatabaseBinding,
  identity: CustomerDatabaseRlsIdentity | null,
  run: (transaction: CustomerDatabaseRlsTransaction) => Promise<Result>,
): Promise<Result> {
  let wireIdentity: CustomerDatabaseRlsIdentity | null;
  try {
    const normalized = normalizeRlsIdentity(identity);
    const sub = normalized.sub;
    const claims: Record<string, CustomerDatabaseJson> = { ...normalized };
    delete claims["sub"];
    delete claims["role"];
    wireIdentity = sub === null ? null : { subject: sub, claims };
  } catch {
    throw new CustomerRuntimeError("database_rls_identity_invalid", false);
  }
  if (typeof binding.openRls !== "function") throw unavailable();
  let stub: CustomerDatabaseRlsConnectionStub;
  try {
    stub = await binding.openRls(wireIdentity);
  } catch {
    throw unavailable();
  }
  let state: "active" | "closing" | "closed" = "active";
  let poisoned = false;
  let pending: Promise<void> = Promise.resolve();
  const transaction: CustomerDatabaseRlsTransaction = Object.freeze({
    query(input: CustomerDatabaseQuery): Promise<CustomerDatabaseQueryResult> {
      // Validate and snapshot immediately, before the caller can change a queued query.
      let parsed: CustomerDatabaseQuery;
      try {
        if (state !== "active" || poisoned) throw rlsTransactionFailed();
        parsed = validateQuery(input, undefined, false, true);
      } catch (error) {
        if (state === "active") poisoned = true;
        const failed = Promise.reject<CustomerDatabaseQueryResult>(error);
        // A fire-and-forget query must still roll the scope back without an unhandled rejection.
        void failed.catch(() => undefined);
        return failed;
      }
      const operation = pending.then(async () => {
        if (poisoned) throw rlsTransactionFailed();
        let raw: unknown;
        try {
          raw = await stub.query(parsed);
        } catch {
          throw unavailable();
        }
        throwRlsFailure(raw);
        throwStatementFailure(raw);
        return validateResult(raw);
      });
      pending = operation.then(
        () => undefined,
        () => {
          poisoned = true;
        },
      );
      return operation;
    },
  });
  try {
    const result = await run(transaction);
    state = "closing";
    await pending;
    if (poisoned) throw rlsTransactionFailed();
    let committed: unknown;
    try {
      committed = await stub.commit();
    } catch {
      throw new CustomerRuntimeError("database_transaction_outcome_unknown", false);
    }
    throwRlsFailure(committed, true);
    if (
      !isRecord(committed) ||
      Object.keys(committed).join(",") !== "type" ||
      committed["type"] !== "ohmyhost.database-rls-commit/v1"
    ) {
      throw new CustomerRuntimeError("database_transaction_outcome_unknown", false);
    }
    return result;
  } finally {
    state = "closing";
    await pending;
    state = "closed";
    await stub.close().catch(() => undefined);
  }
}

function rlsTransactionFailed(): CustomerRuntimeError {
  return new CustomerRuntimeError("database_rls_transaction_failed", false);
}

function throwRlsFailure(value: unknown, duringCommit = false): void {
  if (!isRecord(value) || value["type"] !== "ohmyhost.database-rls-error/v1") return;
  const code = value["code"];
  if (
    Object.keys(value).sort().join(",") !== "code,type" ||
    (code !== "database_rls_transaction_failed" && code !== "database_transaction_outcome_unknown")
  ) {
    if (duringCommit) throw new CustomerRuntimeError("database_transaction_outcome_unknown", false);
    invalidResponse();
  }
  throw new CustomerRuntimeError(code, false);
}

function throwStatementFailure(value: unknown): void {
  if (!isRecord(value) || value["type"] !== "ohmyhost.database-error/v1") return;
  const sqlstate = value["sqlstate"];
  if (
    Object.keys(value).sort().join(",") !== "sqlstate,type" ||
    typeof sqlstate !== "string" ||
    !/^[0-9A-Z]{5}$/u.test(sqlstate)
  )
    invalidResponse();
  throw new CustomerDatabaseError(sqlstate);
}

function validateQuery(
  value: unknown,
  aggregateBudget?: { nodes: number; bytes: number },
  inConnection = false,
  inRls = false,
): CustomerDatabaseQuery {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "text,values") invalidQuery();
  const text = value["text"];
  const values = value["values"];
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    new TextEncoder().encode(text).byteLength > MAX_QUERY_BYTES ||
    !Array.isArray(values) ||
    values.length > MAX_PARAMETERS
  ) {
    invalidQuery();
  }
  validateSql(text, inConnection, inRls);
  const budget = aggregateBudget ?? { nodes: 1, bytes: 2 };
  const parsedValues = values.map((parameter, index) => {
    if (index > 0) consume(budget, 1, MAX_PARAMETER_BYTES, invalidQuery);
    const parsed = validateStructured(parameter, budget, 0, MAX_PARAMETER_BYTES, invalidQuery);
    if (
      (Array.isArray(parsed) ||
        (isRecord(parsed) && !(parsed instanceof Date) && !(parsed instanceof Uint8Array))) &&
      workerJsonParameterBytes(parsed) > MAX_JSON_PARAMETER_BYTES
    )
      invalidQuery();
    return parsed;
  });
  return Object.freeze({
    text,
    values: Object.freeze(parsedValues as CustomerDatabaseParameter[]),
  });
}

function validateTransaction(value: unknown): readonly CustomerDatabaseQuery[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRANSACTION_QUERIES) {
    invalidQuery();
  }
  const budget = { nodes: 1, bytes: 2 };
  const queries = value.map((query, index) => {
    if (index > 0) consume(budget, 1, MAX_PARAMETER_BYTES, invalidQuery);
    budget.nodes += 1;
    if (budget.nodes > MAX_RESULT_NODES) invalidQuery();
    consume(budget, 2, MAX_PARAMETER_BYTES, invalidQuery);
    return validateQuery(query, budget);
  });
  return Object.freeze(queries);
}

function validateSql(text: string, inConnection = false, inRls = false): void {
  let visible = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index] as string;
    const next = text[index + 1];
    if (character === "'") {
      const consumed = quotedEnd(text, index, "'");
      visible += " ".repeat(consumed - index);
      index = consumed;
      continue;
    }
    if (character === '"') {
      const consumed = quotedEnd(text, index, '"');
      visible += " ".repeat(consumed - index);
      index = consumed;
      continue;
    }
    if (character === "-" && next === "-") {
      const end = text.indexOf("\n", index + 2);
      const consumed = end === -1 ? text.length : end;
      visible += " ".repeat(consumed - index);
      index = consumed;
      continue;
    }
    if (character === "/" && next === "*") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < text.length && depth > 0) {
        if (text.slice(cursor, cursor + 2) === "/*") {
          depth += 1;
          cursor += 2;
        } else if (text.slice(cursor, cursor + 2) === "*/") {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      if (depth !== 0) invalidQuery();
      visible += " ".repeat(cursor - index);
      index = cursor;
      continue;
    }
    if (character === "$") {
      const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(text.slice(index));
      if (match !== null) {
        const tag = match[0];
        const end = text.indexOf(tag, index + tag.length);
        if (end === -1) invalidQuery();
        const consumed = end + tag.length;
        visible += " ".repeat(consumed - index);
        index = consumed;
        continue;
      }
    }
    visible += character;
    index += 1;
  }
  const statements = visible
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const semicolonCount = [...visible].filter((character) => character === ";").length;
  const statement = statements[0] as string;
  if (
    statements.length !== 1 ||
    semicolonCount > 1 ||
    (inRls && /^call\b/iu.test(statement)) ||
    (inConnection
      ? // Transaction control is the whole point of holding a connection; session-wide state and a
        // chained transaction, which the database Worker refuses among the first six words, are not.
        /^(?:set|reset|discard|prepare\s+transaction)\b/iu.test(statement) ||
        (/^(?:commit|end|abort|rollback)\b/iu.test(statement) &&
          !/^rollback(?:\s+[a-z_]+)?\s+to\b/iu.test(statement) &&
          /^(?:[a-z_]+\s+){1,5}chain\b/iu.test(statement))
      : /^(?:begin|start(?:\s+transaction)?|commit|end|abort|rollback|savepoint|release|set|reset|discard|prepare)\b/iu.test(
          statement,
        ))
  ) {
    invalidQuery();
  }
}

function quotedEnd(text: string, start: number, quote: "'" | '"'): number {
  const escapedString =
    quote === "'" &&
    (text[start - 1] === "E" || text[start - 1] === "e") &&
    (start < 2 || !/[A-Za-z0-9_$]/u.test(text[start - 2] as string));
  let index = start + 1;
  while (index < text.length) {
    if (escapedString && text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] !== quote) {
      index += 1;
      continue;
    }
    if (text[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return invalidQuery();
}

function validateResult(value: unknown): CustomerDatabaseQueryResult {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "command,rowCount,rows") {
    return invalidResponse();
  }
  const command = value["command"];
  const rowCount = value["rowCount"];
  const rows = value["rows"];
  if (
    typeof command !== "string" ||
    !/^[A-Z][A-Z ]{0,31}$/u.test(command) ||
    (rowCount !== null && (!Number.isSafeInteger(rowCount) || Number(rowCount) < 0)) ||
    !Array.isArray(rows) ||
    rows.length > MAX_RESULT_ROWS ||
    rows.some((row) => !isRecord(row))
  )
    return invalidResponse();
  const budget = { nodes: 0, bytes: 0 };
  // Count the complete envelope, but start each row's value depth at zero like the server.
  // Rows still share the envelope's byte/node budgets, including their separating commas.
  validateStructured({ command, rows: [], rowCount }, budget, 0, MAX_RESULT_BYTES, invalidResponse);
  const clonedRows: Readonly<Record<string, unknown>>[] = [];
  for (const [index, row] of rows.entries()) {
    if (index > 0) consume(budget, 1, MAX_RESULT_BYTES, invalidResponse);
    const cloned = validateStructured(row, budget, 0, MAX_RESULT_BYTES, invalidResponse);
    if (!isRecord(cloned)) return invalidResponse();
    clonedRows.push(cloned);
  }
  return Object.freeze({
    command,
    rows: Object.freeze(clonedRows),
    rowCount: rowCount === null ? null : Number(rowCount),
  });
}

function validateStructured(
  value: unknown,
  budget: { nodes: number; bytes: number },
  depth: number,
  maximumBytes: number,
  invalid: () => never,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_RESULT_NODES || depth > MAX_VALUE_DEPTH) invalid();
  if (value === null || typeof value === "boolean") {
    consume(budget, value === null ? 4 : value ? 4 : 5, maximumBytes, invalid);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    consume(budget, new TextEncoder().encode(String(value)).byteLength, maximumBytes, invalid);
    return value;
  }
  if (typeof value === "string") {
    consume(budget, jsonStringBytes(value), maximumBytes, invalid);
    return value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) invalid();
    consume(budget, jsonStringBytes(value.toISOString()), maximumBytes, invalid);
    return new Date(value.getTime());
  }
  if (value instanceof Uint8Array) {
    consume(budget, value.byteLength + 2, maximumBytes, invalid);
    return Uint8Array.from(value);
  }
  if (Array.isArray(value)) {
    consume(budget, 2, maximumBytes, invalid);
    return Object.freeze(
      value.map((item, index) => {
        if (index > 0) consume(budget, 1, maximumBytes, invalid);
        return validateStructured(item, budget, depth + 1, maximumBytes, invalid);
      }),
    );
  }
  if (!isRecord(value)) return invalid();
  consume(budget, 2, maximumBytes, invalid);
  // RPC rejects null-prototype objects. The forbidden keys below keep a normal object safe
  // while allowing JSON parameters to cross a real Worker Service Binding. Any other key the
  // database Worker accepts is valid: 1-128 UTF-8 bytes without control characters.
  const output: Record<string, unknown> = {};
  for (const [index, [key, item]] of Object.entries(value).entries()) {
    const keyBytes = new TextEncoder().encode(key).byteLength;
    if (
      keyBytes < 1 ||
      keyBytes > MAX_KEY_BYTES ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/u.test(key) ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      invalid();
    }
    if (index > 0) consume(budget, 1, maximumBytes, invalid);
    consume(budget, jsonStringBytes(key) + 1, maximumBytes, invalid);
    output[key] = validateStructured(item, budget, depth + 1, maximumBytes, invalid);
  }
  return Object.freeze(output);
}

/**
 * The database Worker's own measure of one JSON parameter: text and key bytes, eight bytes per
 * number and 24 per date. Mirroring it lets the client refuse what the Worker would refuse.
 */
function workerJsonParameterBytes(value: unknown): number {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (typeof value === "number") return 8;
  if (value instanceof Date) return 24;
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value))
    return value.reduce<number>((total, item) => total + workerJsonParameterBytes(item), 0);
  if (!isRecord(value)) return 0;
  return Object.entries(value).reduce(
    (total, [key, item]) =>
      total + new TextEncoder().encode(key).byteLength + workerJsonParameterBytes(item),
    0,
  );
}

function unavailable(): CustomerRuntimeError {
  return new CustomerRuntimeError("database_unavailable", true);
}

function consume(
  budget: { bytes: number },
  bytes: number,
  maximum: number,
  invalid: () => never,
): void {
  budget.bytes += bytes;
  if (budget.bytes > maximum) invalid();
}

function jsonStringBytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function invalidQuery(): never {
  throw new CustomerRuntimeError("database_query_invalid", false);
}

function invalidResponse(): never {
  throw new CustomerRuntimeError("database_response_invalid", false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
