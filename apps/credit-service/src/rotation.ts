import { bytesOf, gunzip, gzip, sha256Hex, streamOf } from "./bytes.js";
import type { Dependencies, LogRow } from "./port.js";
import { floorDay, isoOf } from "./time.js";

/** Rows per `readLogPage` call. */
export const ROTATION_PAGE = 500;
/** Serialized rows held in memory at once; a larger log is rotated in several passes over the Core log. */
export const ROTATION_MEMORY_BUDGET = 32 * 1024 * 1024;
const MAX_SHARD_BYTES = 64 * 1024 * 1024;
const DAY_PATTERN = /^(\d{4}-\d{2}-\d{2})T/u;

export const shardKey = (day: string, shard: string): string =>
  `credit-log/${day}/${shard}.ndjson.gz`;
export const manifestKey = (day: string): string => `credit-log/${day}/manifest.json`;

/** The shard of an organization: the first byte of SHA-256(organizationId) as two hex digits (256 shards). */
export async function shardOf(organizationId: string): Promise<string> {
  const digest = await sha256Hex(bytesOf(organizationId));
  return digest.slice(0, 2);
}

/** One archived row exactly as it is written, with a fixed field order so reruns produce identical bytes. */
export const rowLine = (row: LogRow): string =>
  JSON.stringify({
    seq: row.seq,
    key: row.key,
    at: row.at,
    organizationId: row.organizationId,
    kind: row.kind,
    deltaMicros: row.deltaMicros,
    balanceMicros: row.balanceMicros,
    detail: row.detail ?? null,
  });

export interface RotationReport {
  status: "waiting" | "empty" | "rotated";
  /** Sources whose cursor has not reached today 00:00Z (status "waiting"). */
  blocking: string[];
  days: string[];
  rows: number;
  shards: number;
  created: number;
  existing: number;
  deleted: number;
  /** Anything an operator must look at, such as a delete that removed more rows than were archived. */
  problems: string[];
}

export interface RotationOptions {
  readonly memoryBudget?: number;
  readonly pageSize?: number;
}

interface Archive {
  readonly lastSeq: number;
  readonly rows: number;
  /** Serialized bytes per `day/shard` group. */
  readonly sizes: Map<string, number>;
  /** The lines per group when everything fit the budget in the first pass, else null. */
  readonly kept: Map<string, string[]> | null;
}

const byKey = (left: readonly [string, unknown], right: readonly [string, unknown]): number =>
  left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;

const append = (groups: Map<string, string[]>, group: string, line: string): void => {
  const lines = groups.get(group);
  if (lines === undefined) groups.set(group, [line]);
  else lines.push(line);
};

const groupOf = async (row: LogRow): Promise<string> => {
  const day = DAY_PATTERN.exec(row.at)?.[1];
  if (day === undefined) throw new TypeError("credit_log_row_invalid");
  return `${day}/${await shardOf(row.organizationId)}`;
};

/** Pages through the rows before `beforeAt`, oldest first, until `until` (inclusive) or the end of the log. */
async function* pages(
  deps: Dependencies,
  beforeAt: string,
  pageSize: number,
  until: number,
): AsyncGenerator<LogRow[]> {
  let afterSeq = 0;
  for (;;) {
    const page = await deps.core.readLogPage({ beforeAt, afterSeq, limit: pageSize });
    const rows = page.rows.filter((row) => row.seq <= until);
    if (rows.length > 0) yield rows;
    if (page.rows.length < pageSize || rows.length < page.rows.length) return;
    if (page.lastSeq <= afterSeq) throw new Error("credit_log_page_stalled");
    afterSeq = page.lastSeq;
  }
}

/** First pass: measures every group and keeps the lines while they fit the memory budget. */
async function scan(
  deps: Dependencies,
  beforeAt: string,
  pageSize: number,
  budget: number,
): Promise<Archive> {
  const sizes = new Map<string, number>();
  let kept: Map<string, string[]> | null = new Map();
  let keptBytes = 0;
  let lastSeq = 0;
  let rows = 0;
  for await (const page of pages(deps, beforeAt, pageSize, Number.MAX_SAFE_INTEGER)) {
    for (const row of page) {
      const group = await groupOf(row);
      const line = rowLine(row);
      const bytes = bytesOf(line).byteLength + 1;
      sizes.set(group, (sizes.get(group) ?? 0) + bytes);
      keptBytes += bytes;
      if (kept !== null && keptBytes > budget) kept = null;
      if (kept !== null) append(kept, group, line);
      lastSeq = row.seq;
      rows++;
    }
  }
  return { lastSeq, rows, sizes, kept };
}

/** Later passes: only the lines of the wanted groups, never beyond the sequence the first pass ended at. */
async function collect(
  deps: Dependencies,
  beforeAt: string,
  pageSize: number,
  until: number,
  wanted: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const lines = new Map<string, string[]>();
  for await (const page of pages(deps, beforeAt, pageSize, until))
    for (const row of page) {
      const group = await groupOf(row);
      if (wanted.has(group)) append(lines, group, rowLine(row));
    }
  return lines;
}

/** Groups of `day/shard` keys whose serialized size fits the budget together (a larger single group stands alone). */
export function planGroups(sizes: ReadonlyMap<string, number>, budget: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const key of [...sizes.keys()].sort()) {
    const size = sizes.get(key) as number;
    if (current.length > 0 && bytes + size > budget) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(key);
    bytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

interface ShardRecord {
  count: number;
  sha256: string;
}

/**
 * Creates the object unless it exists. An object that exists must hold the same plain content: a rerun of a
 * crashed rotation writes identical bytes, anything else is a conflict that stops the rotation before it deletes.
 */
async function createOnce(
  deps: Dependencies,
  key: string,
  plain: Uint8Array,
  stored: Uint8Array,
  contentType: string,
): Promise<"created" | "existing"> {
  const written = await deps.creditLog.put(key, stored, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType },
  });
  if (written !== null) return "created";
  const existing = await readObject(deps, key);
  if ((await sha256Hex(existing)) !== (await sha256Hex(plain)))
    throw new Error(`credit_log_object_conflict:${key}`);
  return "existing";
}

/** The plain bytes of an object that is stored gzipped or, for the manifest, as is. */
async function readObject(deps: Dependencies, key: string): Promise<Uint8Array> {
  const object = await deps.creditLog.get(key);
  if (object === null) throw new Error(`credit_log_object_missing:${key}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  return key.endsWith(".gz") ? gunzip(streamOf(bytes), MAX_SHARD_BYTES) : bytes;
}

const linesOf = (plain: Uint8Array): number => {
  let lines = 0;
  for (const byte of plain) if (byte === 10) lines++;
  return lines;
};

/**
 * Moves every credit-log row before today 00:00Z to R2 and deletes it from the Core afterwards. Each step can be
 * repeated: objects are created once, an existing object must be byte-identical in content, the read-back checks
 * run before the delete, and the delete is the last step.
 */
export async function rotateCreditLog(
  deps: Dependencies,
  options: RotationOptions = {},
): Promise<RotationReport> {
  const budget = options.memoryBudget ?? ROTATION_MEMORY_BUDGET;
  const pageSize = options.pageSize ?? ROTATION_PAGE;
  const report: RotationReport = {
    status: "waiting",
    blocking: [],
    days: [],
    rows: 0,
    shards: 0,
    created: 0,
    existing: 0,
    deleted: 0,
    problems: [],
  };
  const today = floorDay(deps.now());
  for (const cursor of await deps.core.cursorsThrough()) {
    const through = Date.parse(cursor.through);
    if (!Number.isFinite(through)) throw new TypeError("credit_service_boundary_invalid");
    if (through < today) report.blocking.push(cursor.source);
  }
  if (report.blocking.length > 0) return report;
  const beforeAt = isoOf(today);
  const archive = await scan(deps, beforeAt, pageSize, budget);
  if (archive.rows === 0) {
    report.status = "empty";
    return report;
  }
  const records = new Map<string, Map<string, ShardRecord>>();
  for (const keys of planGroups(archive.sizes, budget)) {
    const lines =
      archive.kept ?? (await collect(deps, beforeAt, pageSize, archive.lastSeq, new Set(keys)));
    for (const group of keys) {
      const [day, shard] = group.split("/") as [string, string];
      const rows = lines.get(group);
      if (rows === undefined || rows.length === 0) throw new Error("credit_log_scan_changed");
      const plain = bytesOf(`${rows.join("\n")}\n`);
      const stored = await gzip(plain);
      report[await createOnce(deps, shardKey(day, shard), plain, stored, "application/gzip")]++;
      const dayRecords = records.get(day) ?? new Map<string, ShardRecord>();
      dayRecords.set(shard, { count: rows.length, sha256: await sha256Hex(plain) });
      records.set(day, dayRecords);
    }
  }
  for (const [day, shards] of [...records].sort(byKey)) {
    const manifest = bytesOf(
      JSON.stringify({
        version: 1,
        day,
        rows: [...shards.values()].reduce((sum, shard) => sum + shard.count, 0),
        shards: Object.fromEntries([...shards].sort(byKey)),
      }),
    );
    report[await createOnce(deps, manifestKey(day), manifest, manifest, "application/json")]++;
    for (const [shard, expected] of shards) {
      const plain = await readObject(deps, shardKey(day, shard));
      if (linesOf(plain) !== expected.count || (await sha256Hex(plain)) !== expected.sha256)
        throw new Error(`credit_log_readback_mismatch:${shardKey(day, shard)}`);
      report.shards++;
    }
    report.days.push(day);
  }
  if (report.shards !== archive.sizes.size) throw new Error("credit_log_readback_mismatch:shards");
  const archived = [...records.values()].reduce(
    (sum, shards) => sum + [...shards.values()].reduce((inner, shard) => inner + shard.count, 0),
    0,
  );
  if (archived !== archive.rows) throw new Error("credit_log_readback_mismatch:rows");
  report.rows = archived;
  report.deleted = (await deps.core.deleteLogThrough({ seq: archive.lastSeq, beforeAt })).deleted;
  if (report.deleted !== archived)
    report.problems.push(`credit_log_deleted:${report.deleted}/${archived}`);
  report.status = "rotated";
  return report;
}
