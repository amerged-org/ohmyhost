import type { PgcfProjectProvider, PgcfUsageRow } from "@ohmyhost/provider-pgcf";

const HOUR = 3_600_000;
/** A provider hour is final only this long after it ended. */
const FINALITY_DELAY = 2 * HOUR;
const MAX_WINDOW = 24 * HOUR;
const MAX_BUDGET_MS = 45_000;
/** One day of a thousand databases; more unfinalized rows fail the read, a row is never dropped. */
const MAX_PENDING_ROWS = 24_000;
/** A final hour with one of these gaps has no trustworthy memory quantity; unrelated storage/backup/traffic gaps do not matter. */
const BLOCKING_GAPS: readonly string[] = [
  "memory_mib_seconds",
  "lifecycle",
  "resource_snapshot",
  "rollup_pending",
];

export interface PgcfHourlyRollup {
  readonly databaseId: string;
  readonly hourStart: string;
  /** Canonical decimal of exact MiB-milliseconds, so no consumer needs a lossy number. */
  readonly memoryMibMilliseconds: string;
}
export interface PgcfPendingRow {
  readonly databaseId: string;
  readonly hourStart: string;
}
export interface PgcfUsageRollups {
  readonly from: string;
  readonly to: string;
  /** Final, gap-free hours with a memory metric, sorted by hour and database. */
  readonly rollups: readonly PgcfHourlyRollup[];
  /**
   * Every row the provider has not finalized yet, sorted by hour and database. The collector does not know which of
   * them still serve: the caller decides which hours they hold back (a retired database may never become final).
   */
  readonly pending: readonly PgcfPendingRow[];
  /** Final hours without a usable memory quantity: skipped, never zero, never a reason to hold a cursor. */
  readonly unbillableHours: number;
}

/**
 * Exact MiB-milliseconds of a native `memory_mib_seconds` value. Copied from the retired
 * `packages/database` ingestion: native lifecycle timestamps have millisecond precision, so
 * only the IEEE tolerance of the arithmetic is accepted and anything else is rejected.
 */
function memoryMilliseconds(seconds: number): bigint {
  const milliseconds = seconds * 1000;
  const rounded = Math.round(milliseconds);
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    !Number.isSafeInteger(rounded) ||
    rounded > 4096 * HOUR ||
    Math.abs(milliseconds - rounded) > Number.EPSILON * Math.max(1, Math.abs(milliseconds)) * 4
  )
    throw new TypeError("PGCF memory usage is outside its exact millisecond quantum");
  return BigInt(rounded);
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Key-order independent text, so two reports of one hour compare by content. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b)))
      : item,
  );

function hourBoundary(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value || time % HOUR !== 0)
    throw new TypeError("PGCF usage window must be hour-aligned ISO timestamps");
  return time;
}

/**
 * Pure provider read: the final hourly memory rollups of one window. It holds no state and
 * writes nothing; the caller prices the rollups and decides which pending rows hold an hour back.
 */
export async function readPgcfRollups(input: {
  provider: Pick<PgcfProjectProvider, "readUsage">;
  providerProjectId: string;
  from: string;
  to: string;
  now: Date;
  signal?: AbortSignal;
  budgetMs?: number;
}): Promise<PgcfUsageRollups> {
  const budget = input.budgetMs ?? 40_000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_BUDGET_MS)
    throw new TypeError("Invalid PGCF usage budget");
  const from = hourBoundary(input.from),
    to = hourBoundary(input.to),
    finalBefore = Math.floor(input.now.getTime() / HOUR) * HOUR - FINALITY_DELAY;
  if (to <= from || to - from > MAX_WINDOW || !(to <= finalBefore))
    throw new TypeError("PGCF usage window is empty, longer than 24 hours or not yet final");
  const started = performance.now(),
    remaining = () => Math.max(0, Math.floor(budget - (performance.now() - started)));
  const rows = new Map<string, PgcfUsageRow>(),
    seen = new Set<string>();
  let cursor: string | undefined;
  do {
    if (input.signal?.aborted || remaining() < 1)
      throw new Error("PGCF usage read exceeded its budget or was aborted");
    const timeout = AbortSignal.timeout(Math.max(1, remaining())),
      page = await input.provider.readUsage({
        from: input.from,
        to: input.to,
        signal: input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]),
        ...(cursor === undefined ? {} : { cursor }),
      });
    for (const row of page.rows) {
      const start = Date.parse(row.start),
        end = Date.parse(row.end);
      if (
        row.projectId !== input.providerProjectId ||
        start < from ||
        end > to ||
        start % HOUR !== 0 ||
        end - start !== HOUR
      )
        throw new Error("PGCF usage page returned foreign scope");
      const key = `${row.databaseId}/${row.start}`,
        known = rows.get(key);
      if (known === undefined) rows.set(key, row);
      else if (
        canonical([known.end, known.final, known.metrics, known.gaps]) !==
        canonical([row.end, row.final, row.metrics, row.gaps])
      )
        throw new Error("PGCF usage changed within one read");
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error("PGCF usage cursor repeated");
      seen.add(cursor);
    }
  } while (cursor !== undefined);

  const rollups: PgcfHourlyRollup[] = [];
  const pending: PgcfPendingRow[] = [];
  let unbillableHours = 0;
  for (const row of rows.values()) {
    if (!row.final) {
      pending.push({ databaseId: row.databaseId, hourStart: row.start });
      continue;
    }
    const metric = row.metrics["memory_mib_seconds"];
    if (
      row.gaps.some((gap) => BLOCKING_GAPS.includes(gap)) ||
      metric === null ||
      metric === undefined
    ) {
      unbillableHours++;
      continue;
    }
    rollups.push({
      databaseId: row.databaseId,
      hourStart: row.start,
      memoryMibMilliseconds: memoryMilliseconds(metric).toString(),
    });
  }
  if (pending.length > MAX_PENDING_ROWS)
    throw new Error("PGCF usage has too many unfinalized rows");
  const order = (a: PgcfPendingRow, b: PgcfPendingRow) =>
    compare(a.hourStart, b.hourStart) || compare(a.databaseId, b.databaseId);
  rollups.sort(order);
  pending.sort(order);
  return { from: input.from, to: input.to, rollups, pending, unbillableHours };
}
