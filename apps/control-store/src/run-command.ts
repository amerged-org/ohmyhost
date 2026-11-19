import type { D1Database, D1PreparedStatement, D1Result } from "./d1-types.js";
import { classifyFailure, type GuardCode } from "./guards.js";

/** Every attempt rolled back cleanly: the command is known NOT to have been applied. Retryable. */
export class StoreBusyError extends Error {
  override readonly name = "StoreBusyError";
  readonly code = "store_busy";
}

/** The batch may or may not have committed. Re-send the SAME command; its identity makes that safe. */
export class StoreOutcomeUnknownError extends Error {
  override readonly name = "StoreOutcomeUnknownError";
  readonly code = "store_outcome_unknown";
}

export class CommandConflictError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
  }
}

/**
 * A command id was reused by a different command. Closed: `reason` says whether the stored name or the
 * stored input differs. Nothing was applied by the rejected call.
 */
export class IdempotencyConflictError extends CommandConflictError {
  constructor(
    readonly reason: "command_name" | "input_digest",
    message: string,
  ) {
    super("idempotency_conflict", message);
  }
}

/**
 * Tables with a GLOBAL identity: the epoch / operation / event identity of the operation spine exists once for all
 * organizations. A unique violation on one of them that survives a re-read is a collision with ANOTHER organization's
 * row: the organization-scoped decision cannot see it, so retrying can never succeed and the answer is a typed
 * conflict, not `store_busy`.
 */
const SPINE_CONFLICT = "global_identity_conflict";
const GLOBAL_IDENTITY_TABLES: ReadonlyMap<string, string> = new Map([
  ["billing_epochs", SPINE_CONFLICT],
  ["operations", SPINE_CONFLICT],
  ["operation_events", SPINE_CONFLICT],
  ["outbox_events", SPINE_CONFLICT],
  ["delivery_attempts", SPINE_CONFLICT],
  ["audit_events", SPINE_CONFLICT],
  ["organization_audit_events", SPINE_CONFLICT],
]);

export type Plan<Result> =
  | { readonly replay: Result }
  | { readonly reject: Error }
  | {
      readonly statements: D1PreparedStatement[];
      /** Receives the results of `statements` only, in order; the `command_log` insert is never included. */
      readonly result: (results: D1Result[]) => Result;
      /** What `command_log` stores when the command has a `commandId`. */
      readonly logResult?: unknown;
    };

export interface Command<Snapshot, Result> {
  readonly name: string;
  readonly input: unknown;
  /** Identity of a command without a natural unique key; recorded as the first statement of its batch. */
  readonly commandId?: string;
  readonly now?: number;
  /** One batch of SELECTs: a consistent snapshot of the aggregate. */
  read(db: D1Database): Promise<Snapshot>;
  /** Pure: replay, reject, or the statements of the write batch. */
  decide(snapshot: Snapshot): Plan<Result>;
  /** Guard codes that mean "my snapshot is stale": read and decide again. */
  readonly retryOn?: readonly GuardCode[];
  /** A UNIQUE violation on one of these tables means a twin of this command committed first. */
  readonly naturalKeyTables?: readonly string[];
  /** Resolves an unknown outcome of a command without commandId. */
  lookup?(db: D1Database): Promise<Result | undefined>;
  /** Rebuilds the result from `logResult`. */
  fromLog?(logged: unknown): Result;
}

export interface RunOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly capDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly stats?: { attempts: number; conflicts: number; unknown: number };
}

export async function digestOf(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint"
      ? `${item}n`
      : item !== null && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
        : item,
  );
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface LogRow {
  readonly name: string;
  readonly digest: string;
  readonly result: string;
}

async function readLog(db: D1Database, commandId: string): Promise<LogRow | null> {
  return db
    .prepare("SELECT name, digest, result FROM command_log WHERE command_id = ?")
    .bind(commandId)
    .first<LogRow>();
}

async function answerFromLog<Snapshot, Result>(
  db: D1Database,
  command: Command<Snapshot, Result>,
  row: LogRow | null,
): Promise<Result> {
  if (row === null) {
    throw new StoreOutcomeUnknownError(
      `${command.name}: duplicate command id without a log row: store_outcome_unknown`,
    );
  }
  if (row.name !== command.name) {
    throw new IdempotencyConflictError(
      "command_name",
      `${command.name}: command id already used by command ${row.name}`,
    );
  }
  if (row.digest !== (await digestOf(command.input))) {
    throw new IdempotencyConflictError(
      "input_digest",
      `${command.name}: command id reused with a different request`,
    );
  }
  if (command.fromLog === undefined) {
    throw new TypeError(`${command.name}: a command with an id needs fromLog`);
  }
  return command.fromLog(JSON.parse(row.result) as unknown);
}

/**
 * The retry protocol. Read a snapshot, decide, write under guards; a stale snapshot or a committed twin
 * triggers a jittered re-read, an unreachable database is resolved through the command's identity, and
 * the end of the attempt budget is reported as `store_busy` (known not applied) or
 * `store_outcome_unknown` (re-send the same command).
 */
export async function runCommand<Snapshot, Result>(
  db: D1Database,
  command: Command<Snapshot, Result>,
  options: RunOptions = {},
): Promise<Result> {
  const {
    maxAttempts = 5,
    baseDelayMs = 10,
    capDelayMs = 250,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    stats = { attempts: 0, conflicts: 0, unknown: 0 },
  } = options;
  stats.attempts = 0;
  stats.conflicts = 0;
  stats.unknown = 0;
  let unresolved = false;
  let globalCollision: string | undefined;
  const backoff = (attempt: number) =>
    sleep(Math.floor(random() * Math.min(capDelayMs, baseDelayMs * 2 ** attempt)));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    stats.attempts = attempt;
    // A command that already committed is answered from its log row; deciding it again would reject it.
    if (command.commandId !== undefined) {
      const logged = await readLog(db, command.commandId);
      if (logged !== null) return answerFromLog(db, command, logged);
    }
    const plan = command.decide(await command.read(db));
    if ("replay" in plan) return plan.replay;
    if ("reject" in plan) throw plan.reject;
    const statements =
      command.commandId === undefined
        ? plan.statements
        : [
            db
              .prepare(
                "INSERT INTO command_log(command_id, name, digest, result, applied_at) VALUES (?, ?, ?, ?, ?)",
              )
              .bind(
                command.commandId,
                command.name,
                await digestOf(command.input),
                JSON.stringify(plan.logResult ?? null),
                command.now ?? 0,
              ),
            ...plan.statements,
          ];
    try {
      const results = await db.batch(statements);
      // The log insert is a transport detail: typed commands index only the results of their own effects.
      return plan.result(command.commandId === undefined ? results : results.slice(1));
    } catch (error) {
      const failure = classifyFailure(error);
      if (
        failure.kind === "unique" &&
        failure.table === "command_log" &&
        command.commandId !== undefined
      ) {
        return answerFromLog(db, command, await readLog(db, command.commandId));
      }
      const globalCode =
        failure.kind === "unique" ? GLOBAL_IDENTITY_TABLES.get(failure.table) : undefined;
      if (failure.kind === "unique" && globalCode !== undefined) {
        if (globalCollision === failure.table) {
          throw new CommandConflictError(
            globalCode,
            `${command.name}: an identity is already held by another organization`,
          );
        }
        globalCollision = failure.table;
        stats.conflicts += 1;
        unresolved = false;
        await backoff(attempt);
        continue;
      }
      const staleGuard =
        failure.kind === "guard" && (command.retryOn ?? []).some((code) => code === failure.code);
      const twin =
        failure.kind === "unique" && (command.naturalKeyTables ?? []).includes(failure.table);
      if (staleGuard || twin) {
        stats.conflicts += 1;
        unresolved = false;
        await backoff(attempt);
        continue;
      }
      if (failure.kind === "transient") {
        stats.unknown += 1;
        const known = await resolveUnknown(db, command);
        if (known !== undefined) return known;
        unresolved = true;
        await backoff(attempt);
        continue;
      }
      throw error;
    }
  }
  // The message ends with the wire code: consumers match `: <code>` after the error crosses Workers RPC.
  throw unresolved
    ? new StoreOutcomeUnknownError(
        `${command.name}: outcome unknown after ${maxAttempts} attempts: store_outcome_unknown`,
      )
    : new StoreBusyError(`${command.name}: ${maxAttempts} attempts lost the race: store_busy`);
}

async function resolveUnknown<Snapshot, Result>(
  db: D1Database,
  command: Command<Snapshot, Result>,
): Promise<Result | undefined> {
  if (command.commandId !== undefined) {
    const row = await readLog(db, command.commandId);
    return row === null ? undefined : answerFromLog(db, command, row);
  }
  return command.lookup?.(db);
}
