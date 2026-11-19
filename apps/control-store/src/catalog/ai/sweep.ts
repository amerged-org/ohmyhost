import { z } from "zod";
import { addMilliseconds, routeOrganization, type CatalogContext } from "../common.js";
import { runReleaseReservation } from "../credit/index.js";
import { aiInput, coreClock } from "./common.js";

const sweepInput = z.strictObject({
  olderThanMs: z.number().int().min(60_000).max(86_400_000),
  limit: z.number().int().min(1).max(1000),
});
/** The most batches of resolved markers one run removes, so a single run stays bounded; the next run continues. */
const MARKER_BATCHES_PER_RUN = 25;

/**
 * Releases the AI reservations that were never settled or released and are older than the cutoff on the Core clock, at
 * most `limit` per run. Only the reservations the gateway admitted are candidates (their marker in
 * `ai_gateway_reservations`), so build reservations are never touched and the credit log's rotation cannot hide one. A
 * reservation that resolves in the meantime is counted as skipped. The markers of resolved calls are removed after the
 * releases, in batches of `limit` and at most twenty-five batches per run, so a failing marker cleanup never holds back
 * a release.
 */
export async function sweepAi(
  context: CatalogContext,
  raw: unknown,
): Promise<{ readonly released: number; readonly skipped: number }> {
  const input = aiInput(sweepInput, raw),
    now = await coreClock(context.directory),
    cutoff = addMilliseconds(now, -input.olderThanMs),
    candidates = (
      await context.directory
        .prepare(
          `SELECT r.reservation_id, r.organization_id, m.environment_id FROM credit_reservation r
 JOIN ai_gateway_reservations m ON m.reservation_id = r.reservation_id
 WHERE r.created_at < ?1
 ORDER BY r.created_at, r.reservation_id LIMIT ?2`,
        )
        .bind(cutoff, input.limit)
        .all<{ reservation_id: string; organization_id: string; environment_id: string }>()
    ).results;
  let released = 0,
    skipped = 0;
  for (const row of candidates) {
    const { db } = await routeOrganization(context, row.organization_id),
      outcome = await runReleaseReservation(db, {
        organizationId: row.organization_id,
        reservationId: row.reservation_id,
        now,
        detail: { kind: "ai", reason: "swept", environmentId: row.environment_id },
      });
    if (outcome.released) released += 1;
    else skipped += 1;
  }
  for (let batch = 0; batch < MARKER_BATCHES_PER_RUN; batch += 1) {
    const removed = (
      await context.directory
        .prepare(
          `DELETE FROM ai_gateway_reservations WHERE reservation_id IN (
 SELECT m.reservation_id FROM ai_gateway_reservations m
 WHERE NOT EXISTS (SELECT 1 FROM credit_reservation r WHERE r.reservation_id = m.reservation_id) LIMIT ?1)`,
        )
        .bind(input.limit)
        .run()
    ).meta.changes;
    if (removed < input.limit) break;
  }
  return { released, skipped };
}
