import { parseUsageLogRecord, type UsageLogRecord } from "@ohmyhost/contracts/usage-log";
import { subjectSuppressionKey, type GrowthD1 } from "./event-store.js";

/** The adapter checks the R2 object size and enforces this bound while streaming. */
export interface UsageReadBucket {
  read(key: string, maxBytes: number): Promise<string | null>;
}
export interface UsageCallsPage {
  rows: Array<UsageLogRecord & { result: string }>;
  partial: boolean;
  nextCursor?: string | null;
}
interface Cursor {
  hot: number;
  archive: string;
}
const PAGE_RECORDS = 100;
const MAX_BYTES = 2_000_000;
const archiveKey =
  /^usage\/v1\/subject=(?:anonymous|[a-f0-9]{64})\/day=\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.ndjson$/u;
export function parseUsageCursor(input: string | null | undefined): Cursor {
  if (!input) return { hot: Number.MAX_SAFE_INTEGER, archive: "" };
  if (input.length > 1024) throw new TypeError("usage_cursor_invalid");
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new TypeError("usage_cursor_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("usage_cursor_invalid");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 2 ||
    !Number.isSafeInteger(v["hot"]) ||
    (v["hot"] as number) < 0 ||
    typeof v["archive"] !== "string" ||
    (v["archive"] !== "" && !archiveKey.test(v["archive"]))
  )
    throw new TypeError("usage_cursor_invalid");
  return { hot: v["hot"] as number, archive: v["archive"] };
}

/** Bounded pages of one UTC receipt day; every hot row and archived shard is reachable. */
export async function readUsageCalls(
  db: GrowthD1,
  bucket: UsageReadBucket | undefined,
  input: { day: string; accountId: string | null; cursor?: string | null },
): Promise<UsageCallsPage> {
  const cursor = parseUsageCursor(input.cursor);
  const subject = input.accountId ? await subjectSuppressionKey(input.accountId) : null;
  const filter = subject ? " AND r.subject_key=?" : "";
  const bind = subject ? [input.day, subject] : [input.day];
  const hot = await db
    .prepare(
      `SELECT r.seq,r.subject_key,r.body FROM growth_usage_records r WHERE r.received_day=?${filter} AND r.seq<? AND NOT EXISTS (SELECT 1 FROM growth_subject_suppression s WHERE s.subject_key=r.subject_key) ORDER BY r.seq DESC LIMIT ?`,
    )
    .bind(...bind, cursor.hot, PAGE_RECORDS + 1)
    .all<{ seq: number; subject_key: string; body: string }>();
  const indexes = await db
    .prepare(
      `SELECT r.object_key,r.subject_key FROM growth_usage_archive_index r WHERE r.received_day=?${filter} AND r.object_key>? AND NOT EXISTS (SELECT 1 FROM growth_subject_suppression s WHERE s.subject_key=r.subject_key) ORDER BY r.object_key LIMIT 2`,
    )
    .bind(...bind, cursor.archive)
    .all<{ object_key: string; subject_key: string }>();
  let partial = false;
  const records = new Map<string, UsageLogRecord>();
  const subjects = new Map<string, string>();
  const add = (body: string, subjectKey: string) => {
    try {
      const r = parseUsageLogRecord(JSON.parse(body));
      if (!input.accountId || r.account_id === input.accountId) {
        records.set(r.record_id, r);
        subjects.set(r.record_id, subjectKey);
      }
    } catch {
      partial = true;
    }
  };
  const hotPage = hot.results.slice(0, PAGE_RECORDS);
  for (const row of hotPage) add(row.body, row.subject_key);
  let after = cursor.archive;
  const entry = indexes.results[0];
  let retryArchive = false;
  if (entry) {
    try {
      const body = bucket ? await bucket.read(entry.object_key, MAX_BYTES) : null;
      if (body === null || new TextEncoder().encode(body).byteLength > MAX_BYTES) {
        partial = true;
        retryArchive = true;
      } else {
        const lines = body.split("\n").filter(Boolean);
        // Exported immutable shards contain at most PAGE_RECORDS observations.
        if (lines.length > PAGE_RECORDS) {
          partial = true;
          retryArchive = true;
        } else {
          for (const line of lines) add(line, entry.subject_key);
          after = entry.object_key;
        }
      }
    } catch {
      partial = true;
      retryArchive = true;
    }
  }
  // Recheck at the end, so a deletion during object I/O also suppresses buffered rows.
  const uniqueSubjects = [...new Set(subjects.values())];
  const deleted = uniqueSubjects.length
    ? (
        await db
          .prepare(
            "SELECT subject_key FROM growth_subject_suppression WHERE subject_key IN (SELECT value FROM json_each(?))",
          )
          .bind(JSON.stringify(uniqueSubjects))
          .all<{ subject_key: string }>()
      ).results
    : [];
  const suppressed = new Set(deleted.map((row) => row.subject_key));
  const folded = new Map<string, UsageLogRecord>();
  for (const r of records.values()) {
    const subjectKey = subjects.get(r.record_id);
    if (!subjectKey || suppressed.has(subjectKey)) continue;
    const previous = folded.get(r.invocation_id);
    if (
      !previous ||
      (r.phase === "finished" && previous.phase === "started") ||
      (r.phase === previous.phase && r.occurred_at > previous.occurred_at)
    )
      folded.set(r.invocation_id, r);
  }
  const rows = [...folded.values()].sort(
    (a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.record_id.localeCompare(a.record_id),
  );
  const moreHot = hot.results.length > PAGE_RECORDS;
  const moreArchive = indexes.results.length > 1 || retryArchive;
  const nextCursor =
    moreHot || moreArchive
      ? JSON.stringify({ hot: moreHot ? (hotPage.at(-1)?.seq ?? 0) : 0, archive: after })
      : null;
  return {
    rows: rows.map((r) => ({
      ...r,
      result:
        r.phase === "started"
          ? "Completion unobserved in this page/day"
          : r.outcome === "accepted"
            ? "Accepted"
            : r.outcome,
    })),
    partial,
    nextCursor,
  };
}
