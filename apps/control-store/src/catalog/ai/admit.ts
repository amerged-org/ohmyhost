import { z } from "zod";
import { AI_MAX_OPEN_CALLS, type AiAdmitResult } from "@ohmyhost/platform/shared";
import { type CatalogContext, routeOrganization } from "../common.js";
import { readAccount, readProjectBudget, reserve, stopBudgetGuard } from "../credit/index.js";
import { isDuplicate } from "../credit/spend.js";
import { classifyFailure, guard } from "../../guards.js";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import {
  activeScope,
  aiInput,
  aiModel,
  aiReservationId,
  aiScope,
  coreClock,
  readAiPrice,
} from "./common.js";
import { aiAdmissionDenial, aiReservationMicros } from "./credit.js";

const admitInput = z.strictObject({
  scope: aiScope,
  reservationId: aiReservationId,
  model: aiModel,
  estimateNanoUsd: z.bigint().nonnegative(),
});

/**
 * Admits one AI call: the active price, the Paid and budget rules, then a credit reservation of the upper bound of its
 * cost, refused when the organization already holds its cap of unresolved calls. A reservation id that is already open
 * answers with the amount it holds, so a retry of the same call never reserves twice; one that was settled or released,
 * or that belongs to another project, is `unavailable`.
 */
export async function admitAi(context: CatalogContext, raw: unknown): Promise<AiAdmitResult> {
  const input = aiInput(admitInput, raw),
    { scope } = input,
    { db } = await routeOrganization(context, scope.organizationId),
    now = await coreClock(db),
    price = await readAiPrice(db, now);
  if (price === null) return { admitted: false, denial: "unavailable" };
  if (!(await activeScope(db, scope))) return { admitted: false, denial: "unavailable" };
  const account = await readAccount(db, scope.organizationId, now),
    project = await readProjectBudget(db, scope),
    denial = aiAdmissionDenial(account, project, now);
  if (denial !== null) return { admitted: false, denial };
  const reservedMicros = aiReservationMicros(input.estimateNanoUsd, price.rate),
    plan = reserve(db, {
      organizationId: scope.organizationId,
      reservationId: input.reservationId,
      projectId: scope.projectId,
      amountMicros: reservedMicros,
      now,
      detail: { kind: "ai", model: input.model, environmentId: scope.environmentId },
    });
  try {
    // One batch: the Stop budget is checked against the reservations as they are when this batch runs, the call's own
    // estimate included, so concurrent calls cannot each pass the same stale read. The marker lets the sweep find the call.
    await db.batch([
      // Detect an existing call before its own hold can trip the budget, credit or concurrency guards. A duplicate
      // aborts this batch and reads the original hold; a new marker rolls back if any later guard refuses the call.
      db
        .prepare(
          "INSERT INTO ai_gateway_reservations(reservation_id, organization_id, project_id, environment_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(input.reservationId, scope.organizationId, scope.projectId, scope.environmentId, now),
      stopBudgetGuard(db, scope, now, reservedMicros),
      openCallsGuard(db, scope),
      ...plan.statements,
    ]);
    return { admitted: true, reservedMicros };
  } catch (error) {
    const failure = classifyFailure(error);
    if (failure.kind === "guard" && failure.code === "precondition_changed") {
      return { admitted: false, denial: "project_budget_exceeded" };
    }
    if (failure.kind === "guard" && failure.code === "ai_open_calls_exceeded") {
      return { admitted: false, denial: "too_many_open_calls" };
    }
    if (failure.kind === "guard" && failure.code === "insufficient_credits") {
      return { admitted: false, denial: "insufficient_organization_credits" };
    }
    if (
      failure.kind === "unique" &&
      (isDuplicate(error) || failure.table === "ai_gateway_reservations")
    ) {
      return replayOpenReservation(db, scope, input.reservationId);
    }
    throw error;
  }
}

/**
 * The open-call cap of the organization, in the batch that reserves: the markers whose credit reservation is still open
 * are the unresolved calls. A settled or released call stops counting at once, though its marker waits for the sweep.
 */
export function openCallsGuard(
  db: D1Database,
  scope: { readonly organizationId: string },
): D1PreparedStatement {
  return guard(
    db,
    "ai_open_calls_exceeded",
    `(SELECT COUNT(*) FROM ai_gateway_reservations m JOIN credit_reservation r ON r.reservation_id = m.reservation_id
       WHERE m.organization_id = ?1) >= ?2`,
    [scope.organizationId, AI_MAX_OPEN_CALLS],
  );
}

/** The answer to a reservation id that already exists: its open amount for the same project, otherwise refused. */
async function replayOpenReservation(
  db: D1Database,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
  },
  reservationId: string,
): Promise<AiAdmitResult> {
  const row = await db
    .prepare(
      `SELECT r.amount_micros, r.project_id FROM credit_reservation r JOIN ai_gateway_reservations m ON m.reservation_id = r.reservation_id
       WHERE r.reservation_id = ?1 AND r.organization_id = ?2 AND m.organization_id = ?2 AND m.project_id = ?3 AND m.environment_id = ?4`,
    )
    .bind(reservationId, scope.organizationId, scope.projectId, scope.environmentId)
    .first<{ amount_micros: number; project_id: string | null }>();
  if (row !== null && row.project_id === scope.projectId) {
    return { admitted: true, reservedMicros: row.amount_micros };
  }
  return { admitted: false, denial: "unavailable" };
}
