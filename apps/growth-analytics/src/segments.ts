import { subjectSuppressionKey, type GrowthD1 } from "./event-store.js";
export type Segment = "test" | "non_test" | "unknown";
export type SegmentFilter = "all" | Segment;
export type SegmentEntity = "account" | "organization";
export interface SegmentChange {
  entityType: SegmentEntity;
  entityId: string;
  segment: Segment;
  operator: string;
}
/** Both writes run in one D1 transaction; tombstoned accounts cannot be retagged. */
export async function setSegment(db: GrowthD1, input: SegmentChange): Promise<void> {
  if (
    !(input.entityType === "account" || input.entityType === "organization") ||
    !["test", "non_test", "unknown"].includes(input.segment) ||
    !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,199}$/.test(input.entityId) ||
    !input.operator
  )
    throw new Error("Invalid segment change");
  const digest = await subjectSuppressionKey(input.entityId);
  const at = new Date().toISOString();
  const result = await db.batch([
    db
      .prepare(
        "INSERT INTO growth_segment_tags(entity_type,entity_id,segment,updated_at) SELECT ?,?,?,? WHERE ? <> 'account' OR NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET segment=excluded.segment,updated_at=excluded.updated_at",
      )
      .bind(input.entityType, input.entityId, input.segment, at, input.entityType, digest),
    db
      .prepare(
        "INSERT INTO growth_segment_audit(operator_id,entity_type,subject_digest,segment,changed_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM growth_segment_tags WHERE entity_type=? AND entity_id=? AND updated_at=?)",
      )
      .bind(
        input.operator,
        input.entityType,
        digest,
        input.segment,
        at,
        input.entityType,
        input.entityId,
        at,
      ),
  ]);
  if (!result[0]?.meta.changes || !result[1]?.meta.changes)
    throw new Error("Segment update unavailable");
}
