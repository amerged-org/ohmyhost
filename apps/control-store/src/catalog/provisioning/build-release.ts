import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { releaseReservation } from "../credit/index.js";

export interface AbandonedBuildRelease {
  /** The operation holds an open build reservation. */
  readonly reserved: boolean;
  readonly unstarted: boolean;
}
/** Original lease recovery marks OPERATION_ABANDONED: only a never-claimed build may release its open reservation. */
export async function readAbandonedBuildRelease(
  db: D1Database,
  organizationId: string,
  projectId: string,
  operationId: string,
): Promise<AbandonedBuildRelease> {
  const [reservation, unstarted] = await Promise.all([
    db
      .prepare(
        "SELECT 1 FROM credit_reservation WHERE organization_id=?1 AND project_id=?2 AND reservation_id=?3",
      )
      .bind(organizationId, projectId, operationId)
      .first(),
    db
      .prepare(
        `SELECT 1 WHERE
   NOT EXISTS(SELECT 1 FROM build_input_reservations WHERE operation_id=?1)
   AND NOT EXISTS(SELECT 1 FROM build_receipts WHERE organization_id=?2 AND project_id=?3 AND operation_id=?1)`,
      )
      .bind(operationId, organizationId, projectId)
      .first(),
  ]);
  return { reserved: reservation !== null, unstarted: unstarted !== null };
}
/** Financial release is composed after terminalization in the SAME guarded batch; started/uncertain builds retain custody. */
export function abandonedBuildReleaseStatements(
  db: D1Database,
  snapshot: AbandonedBuildRelease,
  organizationId: string,
  projectId: string,
  operationId: string,
  now: string,
): D1PreparedStatement[] {
  if (!snapshot.reserved)
    return [
      guard(
        db,
        "operation_conflict",
        "EXISTS(SELECT 1 FROM credit_reservation WHERE organization_id=?1 AND project_id=?2 AND reservation_id=?3)",
        [organizationId, projectId, operationId],
      ),
    ];
  if (!snapshot.unstarted) return [];
  return [
    guard(
      db,
      "operation_conflict",
      `EXISTS(SELECT 1 FROM build_input_reservations WHERE operation_id=?1) OR EXISTS(SELECT 1 FROM build_receipts WHERE organization_id=?2 AND project_id=?3 AND operation_id=?1)`,
      [operationId, organizationId, projectId],
    ),
    ...releaseReservation(db, {
      organizationId,
      reservationId: operationId,
      now,
      detail: { operationId, reason: "abandoned" },
    }).statements,
  ];
}
