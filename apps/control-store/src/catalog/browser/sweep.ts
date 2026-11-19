import { z } from "zod";
import { addMilliseconds, routeOrganization, type CatalogContext } from "../common.js";
import { releaseHeldBrowser } from "./release-held.js";
import { browserInput, coreClock } from "./common.js";

const sweepInput = z.strictObject({
  olderThanMs: z.number().int().min(60_000).max(86_400_000),
  limit: z.number().int().min(1).max(1000),
});

/**
 * Releases the browser reservations that were never settled or released and are older than the cutoff on the Core clock, at
 * most `limit` per run. Only the reservations the gateway admitted are candidates (their marker in
 * `browser_gateway_reservations`), so build reservations are never touched and the credit log's rotation cannot hide one. A
 * reservation that resolves in the meantime is counted as skipped. Pricing markers remain for idempotent late settlement.
 */
export async function sweepBrowser(
  context: CatalogContext,
  raw: unknown,
): Promise<{ readonly released: number; readonly skipped: number }> {
  const input = browserInput(sweepInput, raw),
    now = await coreClock(context.directory),
    cutoff = addMilliseconds(now, -input.olderThanMs),
    candidates = (
      await context.directory
        .prepare(
          `SELECT m.reservation_id, m.organization_id, m.project_id, m.environment_id FROM browser_gateway_reservations m
 WHERE m.state='open' AND m.created_at < ?1
 ORDER BY m.created_at, m.reservation_id LIMIT ?2`,
        )
        .bind(cutoff, input.limit)
        .all<{
          reservation_id: string;
          organization_id: string;
          project_id: string;
          environment_id: string;
        }>()
    ).results;
  let released = 0,
    skipped = 0;
  for (const row of candidates) {
    const { db } = await routeOrganization(context, row.organization_id);
    const done = await releaseHeldBrowser(
      db,
      {
        organizationId: row.organization_id,
        projectId: row.project_id,
        environmentId: row.environment_id,
      },
      row.reservation_id,
      now,
      "swept",
      "swept",
    );
    if (done) released += 1;
    else skipped += 1;
  }
  return { released, skipped };
}
