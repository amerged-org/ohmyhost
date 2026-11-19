import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { releaseReservation } from "../credit/index.js";
const UNSTARTED = `NOT EXISTS(SELECT 1 FROM build_receipts WHERE organization_id=?2 AND project_id=?3 AND operation_id=?1)
 AND(NOT EXISTS(SELECT 1 FROM build_input_reservations WHERE operation_id=?1) OR(?4='BUILD_NOT_STARTED' AND EXISTS(
  SELECT 1 FROM build_input_reservations WHERE organization_id=?2 AND project_id=?3 AND operation_id=?1 AND claim_mode='observe' AND start_allowed_until<=?5)))`;
const OPEN_RESERVATION =
  "EXISTS(SELECT 1 FROM credit_reservation WHERE organization_id=?1 AND project_id=?2 AND reservation_id=?3)";
export interface FailureBuildRelease {
  /** The operation holds an open build reservation. */
  readonly reserved: boolean;
  readonly eligible: boolean;
}
/** Same original absence/verified four-minute launch-window predicate; a started/uncertain build keeps its reservation. */
export async function readFailureBuildRelease(
  db: D1Database,
  scope: { organizationId: string; projectId: string; operationId: string },
  errorCode: string,
  failedAt: string,
): Promise<FailureBuildRelease> {
  const [reservation, eligible] = await Promise.all([
    db
      .prepare(`SELECT 1 WHERE ${OPEN_RESERVATION}`)
      .bind(scope.organizationId, scope.projectId, scope.operationId)
      .first(),
    db
      .prepare(`SELECT 1 WHERE ${UNSTARTED}`)
      .bind(scope.operationId, scope.organizationId, scope.projectId, errorCode, failedAt)
      .first(),
  ]);
  return { reserved: reservation !== null, eligible: eligible !== null };
}
/** Compose release after the failure projection in the parent's ONE batch; launch evidence is fenced. */
export function failureBuildReleaseStatements(
  db: D1Database,
  snapshot: FailureBuildRelease,
  scope: { organizationId: string; projectId: string; operationId: string },
  errorCode: string,
  failedAt: string,
): D1PreparedStatement[] {
  if (!snapshot.reserved)
    return [
      guard(db, "operation_conflict", OPEN_RESERVATION, [
        scope.organizationId,
        scope.projectId,
        scope.operationId,
      ]),
    ];
  if (!snapshot.eligible) return [];
  return [
    guard(
      db,
      "operation_conflict",
      `NOT(${UNSTARTED}) OR NOT EXISTS(SELECT 1 FROM operations WHERE organization_id=?2 AND project_id=?3 AND operation_id=?1 AND state IN('failed','cancelled') AND (NOT EXISTS(SELECT 1 FROM build_input_reservations WHERE operation_id=?1) OR(json_extract(failure,'$.code')='BUILD_NOT_STARTED' AND updated_at>=?5)))`,
      [scope.operationId, scope.organizationId, scope.projectId, errorCode, failedAt],
    ),
    ...releaseReservation(db, {
      organizationId: scope.organizationId,
      reservationId: scope.operationId,
      now: failedAt,
      detail: { operationId: scope.operationId, reason: errorCode },
    }).statements,
  ];
}
