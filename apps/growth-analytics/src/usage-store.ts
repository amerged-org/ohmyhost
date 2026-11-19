import { parseUsageLogRecord } from "@ohmyhost/contracts/usage-log";
import { subjectSuppressionKey, type GrowthD1, type GrowthD1Statement } from "./event-store.js";

export const ANONYMOUS_SUBJECT = "anonymous";
export async function usageHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function appendUsageRecord(
  db: GrowthD1,
  input: unknown,
  now = new Date(),
): Promise<"inserted" | "duplicate" | "conflict" | "suppressed"> {
  const record = parseUsageLogRecord(input);
  const body = JSON.stringify(record);
  const hash = await usageHash(body);
  const subject = record.account_id
    ? await subjectSuppressionKey(record.account_id)
    : ANONYMOUS_SUBJECT;
  const receivedAt = now.toISOString();
  const results = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO growth_usage_records(record_id,subject_key,received_day,body) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM growth_usage_receipts WHERE record_id=?) AND NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)",
      )
      .bind(record.record_id, subject, receivedAt.slice(0, 10), body, record.record_id, subject),
    db
      .prepare(
        "INSERT OR IGNORE INTO growth_usage_receipts(record_id,subject_key,body_hash,received_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM growth_usage_records WHERE record_id=? AND body=?) AND NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)",
      )
      .bind(record.record_id, subject, hash, receivedAt, record.record_id, body, subject),
  ]);
  if ((results[0]?.meta.changes ?? 0) > 0) return "inserted";
  const receipt = await db
    .prepare("SELECT body_hash FROM growth_usage_receipts WHERE record_id=?")
    .bind(record.record_id)
    .first<{ body_hash: string }>();
  return receipt ? (receipt.body_hash === hash ? "duplicate" : "conflict") : "suppressed";
}
/** Include in the same D1 batch as the subject tombstone, using the current clock. */
export function enqueueUsageErasure(
  db: GrowthD1,
  subjectKey: string,
  now: Date,
): GrowthD1Statement[] {
  const notBefore = new Date(now.getTime() + 3600000).toISOString();
  return [
    db
      .prepare("INSERT OR IGNORE INTO growth_usage_erasure(subject_key,not_before) VALUES(?,?)")
      .bind(subjectKey, notBefore),
    db.prepare("DELETE FROM growth_usage_records WHERE subject_key=?").bind(subjectKey),
    db.prepare("DELETE FROM growth_usage_receipts WHERE subject_key=?").bind(subjectKey),
    db.prepare("DELETE FROM growth_usage_archive_index WHERE subject_key=?").bind(subjectKey),
  ];
}
