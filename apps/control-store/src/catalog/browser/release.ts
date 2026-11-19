import { z } from "zod";
import { type CatalogContext, routeOrganization } from "../common.js";
import { releaseHeldBrowser } from "./release-held.js";
import {
  browserInput,
  browserReservationId,
  browserBillingScope,
  coreClock,
  reservationState,
} from "./common.js";
const schema = z.strictObject({
  scope: browserBillingScope,
  reservationId: browserReservationId,
  reason: z.enum(["provider_error", "client_aborted"]),
});
export async function releaseBrowser(
  context: CatalogContext,
  raw: unknown,
): Promise<{ released: boolean }> {
  const input = browserInput(schema, raw),
    { scope } = input,
    { db } = await routeOrganization(context, scope.organizationId);
  if ((await reservationState(db, scope, input.reservationId)) !== "open")
    return { released: false };
  return {
    released: await releaseHeldBrowser(
      db,
      scope,
      input.reservationId,
      await coreClock(db),
      "released",
      input.reason,
    ),
  };
}
