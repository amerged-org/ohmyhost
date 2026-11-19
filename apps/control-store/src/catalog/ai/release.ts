import { z } from "zod";
import { type CatalogContext, routeOrganization } from "../common.js";
import { runReleaseReservation } from "../credit/index.js";
import { aiInput, aiReservationId, aiScope, coreClock, reservationState } from "./common.js";

const releaseInput = z.strictObject({
  scope: aiScope,
  reservationId: aiReservationId,
  reason: z.enum(["upstream_error", "rate_limited", "client_aborted", "invalid_request"]),
});

/**
 * Gives back an AI reservation that was never charged (the call failed before a result). Only an open reservation of
 * the organization and project is released; any other answers `released: false` and changes nothing.
 */
export async function releaseAi(
  context: CatalogContext,
  raw: unknown,
): Promise<{ readonly released: boolean }> {
  const input = aiInput(releaseInput, raw),
    { scope } = input,
    { db } = await routeOrganization(context, scope.organizationId);
  if ((await reservationState(db, scope, input.reservationId)) !== "open") {
    return { released: false };
  }
  const outcome = await runReleaseReservation(db, {
    organizationId: scope.organizationId,
    reservationId: input.reservationId,
    now: await coreClock(db),
    detail: { kind: "ai", reason: input.reason, environmentId: scope.environmentId },
  });
  return { released: outcome.released };
}
