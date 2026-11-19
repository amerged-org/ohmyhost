import type { GrowthD1 } from "./event-store.js";
import { usageHash } from "./usage-store.js";

export interface UsageArchiveBucket {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType: string } },
  ): Promise<{ size: number } | null>;
  delete(key: string | string[]): Promise<void>;
  list(options: {
    prefix: string;
    limit: number;
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean }>;
}
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const prefix = (subject: string) => `usage/v1/subject=${subject}/`;
async function suppressed(db: GrowthD1, subject: string): Promise<boolean> {
  return !!(await db
    .prepare("SELECT 1 AS found FROM growth_subject_suppression WHERE subject_key=?")
    .bind(subject)
    .first());
}
/** One bounded pass. A frozen window is resumed until drained; new rows wait for the next window. */
export async function archiveUsage(
  db: GrowthD1,
  bucket: UsageArchiveBucket,
  now = new Date(),
): Promise<void> {
  const at = now.toISOString();
  const due = new Date(now.getTime() - 86400000).toISOString();
  await db
    .prepare(
      "UPDATE growth_usage_export SET cutoff_seq=(SELECT MAX(seq) FROM growth_usage_records) WHERE singleton=1 AND cutoff_seq IS NULL AND (completed_at IS NULL OR completed_at<=?) AND EXISTS (SELECT 1 FROM growth_usage_records)",
    )
    .bind(due)
    .run();
  const window = await db
    .prepare("SELECT cutoff_seq FROM growth_usage_export WHERE singleton=1")
    .first<{ cutoff_seq: number | null }>();
  const cutoff = window?.cutoff_seq;
  if (cutoff == null) return;
  for (let page = 0; page < MAX_PAGES; page++) {
    const first = await db
      .prepare(
        "SELECT subject_key,received_day FROM growth_usage_records WHERE seq<=? ORDER BY seq LIMIT 1",
      )
      .bind(cutoff)
      .first<{ subject_key: string; received_day: string }>();
    if (!first) {
      await db
        .prepare(
          "UPDATE growth_usage_export SET cutoff_seq=NULL,completed_at=? WHERE singleton=1 AND cutoff_seq=? AND NOT EXISTS (SELECT 1 FROM growth_usage_records WHERE seq<=?)",
        )
        .bind(at, cutoff, cutoff)
        .run();
      return;
    }
    const rows = (
      await db
        .prepare(
          "SELECT seq,body FROM growth_usage_records WHERE subject_key=? AND received_day=? AND seq<=? ORDER BY seq LIMIT ?",
        )
        .bind(first.subject_key, first.received_day, cutoff, PAGE_SIZE)
        .all<{ seq: number; body: string }>()
    ).results;
    if (!rows.length) continue;
    if (await suppressed(db, first.subject_key)) continue;
    const body = rows.map((row) => row.body).join("\n") + "\n";
    const key = `${prefix(first.subject_key)}day=${first.received_day}/${await usageHash(body)}.ndjson`;
    const stored = await bucket.put(key, body, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    if (!stored || stored.size !== new TextEncoder().encode(body).byteLength)
      throw new Error("usage_archive_unconfirmed");
    if (await suppressed(db, first.subject_key)) {
      await bucket.delete(key);
      continue;
    }
    const placeholders = rows.map(() => "?").join(",");
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO growth_usage_archive_index(object_key,subject_key,received_day,created_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)",
        )
        .bind(key, first.subject_key, first.received_day, at, first.subject_key),
      db
        .prepare(`DELETE FROM growth_usage_records WHERE seq IN (${placeholders})`)
        .bind(...rows.map((row) => row.seq)),
    ]);
  }
}
/** Wait for old scheduled invocations to finish before sweeping tombstoned subject prefixes. */
export async function cleanupErasedUsage(
  db: GrowthD1,
  bucket: UsageArchiveBucket,
  now = new Date(),
): Promise<void> {
  const tasks = (
    await db
      .prepare(
        "SELECT subject_key,not_before FROM growth_usage_erasure WHERE completed_at IS NULL AND not_before<=? ORDER BY not_before LIMIT 10",
      )
      .bind(now.toISOString())
      .all<{ subject_key: string; not_before: string }>()
  ).results;
  for (const task of tasks) {
    const objects = await bucket.list({ prefix: prefix(task.subject_key), limit: 100 });
    if (objects.objects.length) await bucket.delete(objects.objects.map((object) => object.key));
    else if (!objects.truncated)
      await db
        .prepare(
          "UPDATE growth_usage_erasure SET completed_at=? WHERE subject_key=? AND not_before=?",
        )
        .bind(now.toISOString(), task.subject_key, task.not_before)
        .run();
  }
}

/** Backstop for lifecycle expiry, bounded by the archive index. */
export async function expireUsageArchives(
  db: GrowthD1,
  bucket: UsageArchiveBucket,
  now = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - 90 * 86400000).toISOString();
  const rows = (
    await db
      .prepare(
        "SELECT object_key FROM growth_usage_archive_index WHERE created_at<=? ORDER BY created_at LIMIT 100",
      )
      .bind(cutoff)
      .all<{ object_key: string }>()
  ).results;
  if (!rows.length) return;
  await bucket.delete(rows.map((row) => row.object_key));
  await db.batch(
    rows.map((row) =>
      db
        .prepare("DELETE FROM growth_usage_archive_index WHERE object_key=? AND created_at<=?")
        .bind(row.object_key, cutoff),
    ),
  );
}
