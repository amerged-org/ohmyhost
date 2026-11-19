import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { instant, ulid } from "../common.js";

/** A unique, stable accepted-publication or verified-delivery identity, scoped to its project. */
export const acceptedPreviewSourceInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  eventId: z.string().min(1).max(256),
  sourceConnectionId: ulid,
  sourceGeneration: z.number().int().positive().safe(),
  commitSha: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
  now: instant,
});
export type AcceptedPreviewSource = z.input<typeof acceptedPreviewSourceInput>;

/**
 * Include these statements in the source acceptance batch after its binding/grant guards.
 * Event replay cannot reuse an identity with different contents. A Core sequence is assigned in
 * the insert transaction; a later accepted source wins even when an old request is replayed.
 */
export function acceptedPreviewSourceStatements(
  db: D1Database,
  raw: AcceptedPreviewSource,
): D1PreparedStatement[] {
  const i = acceptedPreviewSourceInput.parse(raw);
  const values = [
    i.organizationId,
    i.projectId,
    i.eventId,
    i.sourceConnectionId,
    i.sourceGeneration,
    i.commitSha,
    i.now,
  ];
  return [
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM project_preview_source_events
      WHERE organization_id=?1 AND project_id=?2 AND event_id=?3
        AND (source_connection_id<>?4 OR source_generation<>?5 OR commit_sha<>?6))`,
      values.slice(0, 6),
    ),
    db
      .prepare(
        `INSERT INTO project_preview_source_events
      (organization_id,project_id,event_id,sequence,source_connection_id,source_generation,commit_sha,accepted_at)
      SELECT ?1,?2,?3,COALESCE(MAX(sequence),0)+1,?4,?5,?6,?7
      FROM project_preview_source_events WHERE organization_id=?1 AND project_id=?2
      HAVING NOT EXISTS(SELECT 1 FROM project_preview_source_events WHERE organization_id=?1 AND project_id=?2 AND event_id=?3)`,
      )
      .bind(...values),
    db
      .prepare(
        `INSERT INTO project_preview_source_heads
      (organization_id,project_id,sequence,source_connection_id,source_generation,commit_sha,accepted_at)
      SELECT organization_id,project_id,sequence,source_connection_id,source_generation,commit_sha,accepted_at
      FROM project_preview_source_events WHERE organization_id=?1 AND project_id=?2 AND event_id=?3
      ON CONFLICT(organization_id,project_id) DO UPDATE SET sequence=excluded.sequence,
        source_connection_id=excluded.source_connection_id,source_generation=excluded.source_generation,
        commit_sha=excluded.commit_sha,accepted_at=excluded.accepted_at
      WHERE excluded.sequence>project_preview_source_heads.sequence`,
      )
      .bind(...values.slice(0, 3)),
    db
      .prepare(
        `UPDATE project_previews SET
      target_connection_id=(SELECT source_connection_id FROM project_preview_source_heads WHERE organization_id=?1 AND project_id=?2),
      target_generation=(SELECT source_generation FROM project_preview_source_heads WHERE organization_id=?1 AND project_id=?2),
      target_sequence=(SELECT sequence FROM project_preview_source_heads WHERE organization_id=?1 AND project_id=?2),
      target_commit=(SELECT commit_sha FROM project_preview_source_heads WHERE organization_id=?1 AND project_id=?2),
      backup_expires_at=CASE WHEN backup_handle IS NOT NULL AND backup_expires_at>?3 AND last_activity_at<?3 THEN strftime('%Y-%m-%dT%H:%M:%f',?3,'+30 days')||'000Z' ELSE backup_expires_at END,
      last_activity_at=MAX(last_activity_at,?3),row_version=row_version+1,updated_at=MAX(updated_at,?3)
      WHERE organization_id=?1 AND project_id=?2 AND retirement='none'
        AND COALESCE(target_sequence,0)<(SELECT sequence FROM project_preview_source_heads WHERE organization_id=?1 AND project_id=?2)`,
      )
      .bind(i.organizationId, i.projectId, i.now),
    db
      .prepare(
        `INSERT INTO project_preview_source_pending(preview_id,sequence,updated_at)
      SELECT preview_id,target_sequence,?3 FROM project_previews
      WHERE organization_id=?1 AND project_id=?2 AND retirement='none' AND target_sequence IS NOT NULL
      ON CONFLICT(preview_id) DO UPDATE SET sequence=excluded.sequence,updated_at=excluded.updated_at
      WHERE excluded.sequence>project_preview_source_pending.sequence`,
      )
      .bind(i.organizationId, i.projectId, i.now),
  ];
}
