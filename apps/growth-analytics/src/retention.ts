import type { GrowthD1 } from "./event-store.js";
/** Run from the Growth Worker's scheduled handler; only measurement-plane records are removed. */
export async function expireGrowthData(db: GrowthD1, now: Date): Promise<void> {
  const cutoff = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
  await db.batch([
    db
      .prepare(
        "DELETE FROM growth_dispute_staging WHERE generation IN (SELECT generation FROM growth_dispute_scans WHERE started_at < ?)",
      )
      .bind(cutoff(1)),
    db.prepare("DELETE FROM growth_dispute_scans WHERE started_at < ?").bind(cutoff(1)),
    db
      .prepare("DELETE FROM growth_events WHERE occurred_at < ? OR received_at < ?")
      .bind(cutoff(30), cutoff(30)),
    db
      .prepare(
        "DELETE FROM growth_facts WHERE COALESCE(occurred_at,json_extract(body,'$.observed_at')) < ?",
      )
      .bind(cutoff(180)),
    db.prepare("DELETE FROM growth_milestones WHERE occurred_at < ?").bind(cutoff(180)),
    db.prepare("DELETE FROM growth_activity WHERE occurred_at < ?").bind(cutoff(180)),
    db.prepare("DELETE FROM growth_identity_audit WHERE accessed_at < ?").bind(cutoff(180)),
    db.prepare("DELETE FROM growth_segment_audit WHERE changed_at < ?").bind(cutoff(180)),
    db.prepare("DELETE FROM growth_campaigns WHERE expires_at < ?").bind(now.toISOString()),
    db.prepare("DELETE FROM growth_flows WHERE expires_at < ?").bind(now.toISOString()),
    db.prepare("DELETE FROM growth_membership_snapshots WHERE observed_at < ?").bind(cutoff(180)),
    db.prepare("DELETE FROM growth_flow_suppression WHERE expires_at < ?").bind(now.toISOString()),
    db.prepare("DELETE FROM growth_diagnostic_slots WHERE minute < ?").bind(cutoff(1).slice(0, 16)),
    db
      .prepare("DELETE FROM growth_replay_suppression WHERE expires_at < ?")
      .bind(now.toISOString()),
    db.prepare("DELETE FROM growth_ingest_budgets WHERE minute < ?").bind(cutoff(1).slice(0, 16)),
  ]);
}
