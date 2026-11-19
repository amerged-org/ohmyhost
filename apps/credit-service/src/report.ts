import { gunzip, streamOf, textOf } from "./bytes.js";
import type { Dependencies, LogRow } from "./port.js";
import { shardKey, shardOf } from "./rotation.js";
import { DAY_MS, dayOf, floorDay } from "./time.js";

/** The archive keeps 14 days; a report never asks for more. */
export const REPORT_MAX_RANGE_MS = 14 * DAY_MS;
const MAX_SHARD_BYTES = 64 * 1024 * 1024;

export interface UsageQuery {
  readonly organizationId: string;
  /** Inclusive start and exclusive end, canonical ISO instants. */
  readonly from: number;
  readonly to: number;
}

export function parseUsageQuery(input: unknown): UsageQuery {
  const fail = (): never => {
    throw new TypeError("credit_service_usage_query_invalid");
  };
  if (input === null || typeof input !== "object" || Array.isArray(input)) return fail();
  const query = input as Record<string, unknown>;
  const instant = (value: unknown): number => {
    const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : fail();
  };
  const organizationId = query["organizationId"];
  if (
    Object.keys(query).sort().join() !== "from,organizationId,to" ||
    typeof organizationId !== "string" ||
    organizationId.length === 0 ||
    organizationId.length > 128
  )
    return fail();
  const from = instant(query["from"]),
    to = instant(query["to"]);
  if (to <= from || to - from > REPORT_MAX_RANGE_MS) return fail();
  return { organizationId, from, to };
}

function parseRow(line: string): LogRow {
  const row = JSON.parse(line) as Record<string, unknown>;
  if (
    typeof row["seq"] !== "number" ||
    typeof row["key"] !== "string" ||
    typeof row["at"] !== "string" ||
    typeof row["organizationId"] !== "string" ||
    typeof row["kind"] !== "string" ||
    typeof row["deltaMicros"] !== "number" ||
    typeof row["balanceMicros"] !== "number"
  )
    throw new TypeError("credit_log_corrupt");
  return {
    seq: row["seq"],
    key: row["key"],
    at: row["at"],
    organizationId: row["organizationId"],
    kind: row["kind"],
    deltaMicros: row["deltaMicros"],
    balanceMicros: row["balanceMicros"],
    detail: row["detail"] ?? null,
  };
}

/** The organization's rows of one archived day: its single shard object, filtered by organization. */
async function readArchivedDay(
  deps: Dependencies,
  day: string,
  shard: string,
  organizationId: string,
): Promise<LogRow[]> {
  const object = await deps.creditLog.get(shardKey(day, shard));
  if (object === null) return [];
  const plain = await gunzip(streamOf(new Uint8Array(await object.arrayBuffer())), MAX_SHARD_BYTES);
  return textOf(plain)
    .split("\n")
    .filter((line) => line !== "")
    .map(parseRow)
    .filter((row) => row.organizationId === organizationId);
}

/**
 * The organization's credit-log rows in `[from, to)`, oldest first: the rotated days from R2 plus every row the Core
 * still holds. The Core is read first: a rotation that finishes in between has archived its rows before deleting
 * them, so a row is always found in at least one of the two places; rows found in both are merged by key.
 */
export async function readUsage(deps: Dependencies, input: unknown): Promise<LogRow[]> {
  const query = parseUsageQuery(input);
  const rows = new Map<string, LogRow>();
  for (const row of await deps.core.readLogsToday({ organizationId: query.organizationId }))
    rows.set(row.key, row);
  const shard = await shardOf(query.organizationId);
  const today = floorDay(deps.now());
  const days: string[] = [];
  for (let day = floorDay(query.from); day < query.to; day += DAY_MS)
    if (day < today) days.push(dayOf(day));
  const archived = await Promise.all(
    days.map((day) => readArchivedDay(deps, day, shard, query.organizationId)),
  );
  for (const row of archived.flat()) rows.set(row.key, row);
  return [...rows.values()]
    .filter((row) => {
      const at = Date.parse(row.at);
      return at >= query.from && at < query.to;
    })
    .sort((left, right) =>
      left.at < right.at ? -1 : left.at > right.at ? 1 : left.seq - right.seq,
    );
}
