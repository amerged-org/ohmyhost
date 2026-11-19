import type { D1Database, D1PreparedStatement, D1Result } from "./d1-types.js";
import { classifyFailure, guard } from "./guards.js";

/**
 * The shard refused a statement because the bucket of the organization is being moved or has moved away.
 * The caller's cached route is stale: refresh it and route again, never retry blindly on this shard.
 */
export class BucketFencedError extends Error {
  readonly code = "bucket_fenced";
  constructor(readonly bucket: number) {
    super(`bucket ${bucket} is fenced on this shard`);
  }
}

/** The bucket is still fenced after the route was refreshed: a move is in flight. Retry after it settles. */
export class BucketMovingError extends Error {
  readonly code = "bucket_moving";
  constructor(readonly bucket: number) {
    super(`bucket ${bucket} is being moved`);
  }
}

const READ_ONLY = /^\s*select\b/iu;

class FencedStatement implements D1PreparedStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    readonly sql: string,
    readonly fenced: FencedDatabase,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new FencedStatement(this.inner.bind(...values), this.sql, this.fenced);
  }

  async first<Row = Record<string, unknown>>(): Promise<Row | null> {
    const [result] = await this.fenced.batchInner([this]);
    return (result?.results[0] as Row | undefined) ?? null;
  }

  async all<Row = Record<string, unknown>>(): Promise<D1Result<Row>> {
    const [result] = await this.fenced.batchInner([this]);
    return result as D1Result<Row>;
  }

  async run(): Promise<D1Result> {
    const [result] = await this.fenced.batchInner([this]);
    return result as D1Result;
  }
}

/**
 * The authoritative bucket fence. The directory's bucket map is cached in every isolate (60 s), so the map
 * alone cannot stop a command that still routes a moved bucket to its old shard. The shard itself knows:
 * `bucket_fences` holds a row for every bucket that is `moving` (writes refused) or `moved` (reads and writes
 * refused). Every write batch begins with a guard against that table, in the same D1 transaction as the
 * write, so a fence set between routing and committing still aborts the command with nothing applied. A
 * batch of only SELECTs checks the `moved` fence with a plain SELECT and stays read-only.
 */
export class FencedDatabase implements D1Database {
  constructor(
    private readonly db: D1Database,
    private readonly bucket: number,
  ) {}

  prepare(sql: string): D1PreparedStatement {
    return new FencedStatement(this.db.prepare(sql), sql, this);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    return this.batchInner(statements);
  }

  async batchInner(statements: readonly D1PreparedStatement[]): Promise<D1Result[]> {
    const inner = statements.map((statement) => {
      if (!(statement instanceof FencedStatement) || statement.fenced !== this) {
        throw new TypeError("a fenced database accepts only its own statements");
      }
      return statement;
    });
    const writes = inner.some((statement) => !READ_ONLY.test(statement.sql));
    const fence = writes
      ? guard(this.db, "bucket_fenced", "EXISTS (SELECT 1 FROM bucket_fences WHERE bucket = ?1)", [
          this.bucket,
        ])
      : this.db
          .prepare("SELECT 1 AS moved FROM bucket_fences WHERE bucket = ?1 AND state = 'moved'")
          .bind(this.bucket);
    let results: D1Result[];
    try {
      results = await this.db.batch([fence, ...inner.map((statement) => statement.inner)]);
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure.kind === "guard" && failure.code === "bucket_fenced") {
        throw new BucketFencedError(this.bucket);
      }
      throw error;
    }
    if (!writes && (results[0]?.results.length ?? 0) > 0) throw new BucketFencedError(this.bucket);
    return results.slice(1);
  }
}

export function fenceDatabase(db: D1Database, bucket: number): D1Database {
  return new FencedDatabase(db, bucket);
}

/**
 * Runs a command against the cached route; when the shard reports the bucket fenced, the cache is dropped and
 * the command runs once more against the fresh route. The first attempt aborted before applying anything, so
 * the rerun cannot repeat an effect.
 */
export async function withRouteRefresh<Result>(
  router: { invalidate(): void },
  run: () => Promise<Result>,
): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof BucketFencedError)) throw error;
    router.invalidate();
  }
  try {
    return await run();
  } catch (error) {
    if (error instanceof BucketFencedError) throw new BucketMovingError(error.bucket);
    throw error;
  }
}
