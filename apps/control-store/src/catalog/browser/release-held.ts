import { guard, classifyFailure } from "../../guards.js";
import type { D1Database } from "../../d1-types.js";
import { releaseReservation } from "../credit/index.js";
import { isDuplicate } from "../credit/spend.js";
import { reservationParameters, type BrowserReservationScope } from "./common.js";

/** The credit release and its durable outcome are committed together. */
export async function releaseHeldBrowser(
  db: D1Database,
  scope: BrowserReservationScope,
  reservationId: string,
  now: string,
  state: "released" | "swept",
  reason: string,
): Promise<boolean> {
  const values = reservationParameters(scope, reservationId);
  const plan = releaseReservation(db, {
    organizationId: scope.organizationId,
    reservationId,
    now,
    detail: { kind: "browser", reason, environmentId: scope.environmentId },
  });
  try {
    await db.batch([
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS(SELECT 1 FROM browser_gateway_reservations WHERE reservation_id=?1 AND organization_id=?2 AND project_id=?3 AND environment_id=?4 AND state='open')",
        values,
      ),
      ...plan.statements,
      db
        .prepare(
          "UPDATE browser_gateway_reservations SET state=?5 WHERE reservation_id=?1 AND organization_id=?2 AND project_id=?3 AND environment_id=?4 AND state='open'",
        )
        .bind(...values, state),
    ]);
    return true;
  } catch (error) {
    const failure = classifyFailure(error);
    if (isDuplicate(error) || (failure.kind === "guard" && failure.code === "precondition_changed"))
      return false;
    throw error;
  }
}
