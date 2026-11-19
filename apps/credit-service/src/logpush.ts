import { SizeLimitError, bytesOf, gunzip, sha256Hex, textOf } from "./bytes.js";
import { HOUR_MS, dayOf } from "./time.js";
import type { UsageLogsBucket } from "./port.js";

/*
 * Cloudflare Logpush writes the nine WFP metadata fields of every Workers trace event into the private EU bucket
 * `ohmyho-usage-<env>` as `usage/YYYYMMDD/<name>.log.gz` (gzipped NDJSON, one event per line, at most 1000
 * records or 30 seconds per object). Logpush names an object `<start>_<end>_<id>.log.gz` where start and end are
 * the batch interval as `YYYYMMDDTHHMMSSZ`; the repository only proves the `usage/YYYYMMDD/` prefix and the
 * `.log.gz` suffix, so the time parser takes the first such timestamp anywhere in the file name and falls back to
 * the object's upload time when the name carries none.
 */
export const LOGPUSH_FIELDS = Object.freeze([
  "CPUTimeMs",
  "DispatchNamespace",
  "Entrypoint",
  "EventTimestampMs",
  "EventType",
  "Outcome",
  "ScriptName",
  "ScriptVersion",
  "WallTimeMs",
]);

const OBJECT_KEY = /^usage\/(20\d{6})\/([^/]+\.log\.gz)$/u;
const KEY_TIME = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/u;
const SCRIPT_NAME = /^p-[0-9a-z]{26}-(?:dev|prod)-[0-9a-z]{26}$/u;
const LIST_PAGE = 1000;
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_PLAIN_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 5000;

/**
 * Every `fetch` invocation that ran a script is billable, whatever its outcome: canceled and CPU-limited invocations
 * consumed platform compute too. Only `scriptNotFound` never runs the script, so it is the one outcome not billed.
 */
export const isBillableEvent = (eventType: unknown, outcome: unknown): boolean =>
  eventType === "fetch" && outcome !== "scriptNotFound";

/** An object that can never be read as usage (bad gzip, bad JSON, foreign namespace, unexpected fields). */
export class InvalidUsageObject extends Error {
  public constructor(public readonly reason: string) {
    super(`credit_service_invalid_usage_object:${reason}`);
    this.name = "InvalidUsageObject";
  }
}

/** The instant an object belongs to: its batch start from the file name, else its upload time. */
export function objectTime(key: string, uploaded: Date): number | null {
  const match = OBJECT_KEY.exec(key);
  if (match === null) return null;
  const stamp = KEY_TIME.exec(match[2] ?? "");
  const ms =
    stamp === null
      ? uploaded.getTime()
      : Date.UTC(
          Number(stamp[1]),
          Number(stamp[2]) - 1,
          Number(stamp[3]),
          Number(stamp[4]),
          Number(stamp[5]),
          Number(stamp[6]),
        );
  return Number.isFinite(ms) ? ms : null;
}

export interface WindowObject {
  readonly key: string;
  readonly size: number;
}

/**
 * Every object whose time falls in `[start, start + 1 h)`. A batch that ends after midnight can sit in the next
 * day's folder, so the folder of the window's last minute is listed as well.
 */
export async function listWindowObjects(
  bucket: UsageLogsBucket,
  start: number,
): Promise<WindowObject[]> {
  const end = start + HOUR_MS;
  const days = new Set([dayOf(start), dayOf(end + 60_000)]);
  const found: WindowObject[] = [];
  for (const day of days) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({
        prefix: `usage/${day.replaceAll("-", "")}/`,
        limit: LIST_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const object of page.objects) {
        const time = objectTime(object.key, object.uploaded);
        if (time !== null && time >= start && time < end)
          found.push({ key: object.key, size: object.size });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }
  return found.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

export interface ScriptUsage {
  requests: number;
  cpuMs: number;
}

export interface ObjectUsage {
  /** SHA-256 of the decompressed text: the same batch delivered under another name has the same digest. */
  readonly digest: string;
  readonly scripts: ReadonlyMap<string, ScriptUsage>;
  /** Billable events of scripts that are not customer scripts of this platform; they are never charged. */
  readonly foreign: number;
}

/** Reads one object: bounded size, strict fields, only billable events aggregated per script. */
export async function readUsageObject(
  object: { size: number; body: ReadableStream<Uint8Array<ArrayBuffer>> },
  namespace: string,
): Promise<ObjectUsage> {
  if (object.size > MAX_COMPRESSED_BYTES) {
    await object.body.cancel();
    throw new InvalidUsageObject("compressed_limit");
  }
  let bytes: Uint8Array;
  try {
    bytes = await gunzip(object.body, MAX_PLAIN_BYTES);
  } catch (error) {
    throw new InvalidUsageObject(error instanceof SizeLimitError ? "plain_limit" : "gzip");
  }
  let text: string;
  try {
    text = textOf(bytes);
  } catch {
    throw new InvalidUsageObject("utf8");
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length > MAX_RECORDS) throw new InvalidUsageObject("record_limit");
  const scripts = new Map<string, ScriptUsage>();
  let foreign = 0;
  for (const line of lines) {
    const row = parseEvent(line, namespace);
    if (!isBillableEvent(row["EventType"], row["Outcome"])) continue;
    const script = row["ScriptName"] as string;
    if (!SCRIPT_NAME.test(script)) {
      foreign++;
      continue;
    }
    const total = scripts.get(script) ?? { requests: 0, cpuMs: 0 };
    total.requests += 1;
    total.cpuMs += row["CPUTimeMs"] as number;
    scripts.set(script, total);
  }
  return { digest: await sha256Hex(bytesOf(text)), scripts, foreign };
}

function parseEvent(line: string, namespace: string): Record<string, unknown> {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    throw new InvalidUsageObject("json");
  }
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join() !== LOGPUSH_FIELDS.join()
  )
    throw new InvalidUsageObject("fields");
  const event = row as Record<string, unknown>;
  const cpu = event["CPUTimeMs"];
  if (
    event["DispatchNamespace"] !== namespace ||
    typeof event["ScriptName"] !== "string" ||
    typeof event["EventType"] !== "string" ||
    typeof event["Outcome"] !== "string" ||
    typeof cpu !== "number" ||
    !Number.isSafeInteger(cpu) ||
    cpu < 0
  )
    throw new InvalidUsageObject("values");
  return event;
}
