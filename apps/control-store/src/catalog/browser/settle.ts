import { z } from "zod";
import {
  BROWSER_METER,
  BROWSER_METER_UNIT,
  browserCreditMicros,
  type BrowserSettleResult,
  type BrowserBillingScope,
  normalizeBrowserDuration,
} from "@ohmyhost/platform/shared";
import { guard, classifyFailure } from "../../guards.js";
import { type CatalogContext, routeOrganization } from "../common.js";
import { chargeOrg, settleReservation } from "../credit/index.js";
import { isDuplicate } from "../credit/spend.js";
import {
  browserInput,
  browserReservationId,
  browserBillingScope,
  coreClock,
  readPinnedBrowserPrice,
  reservationParameters,
  reservationState,
  type BrowserPrice,
} from "./common.js";
const schema = z.strictObject({
  scope: browserBillingScope,
  reservationId: browserReservationId,
  browserMs: z
    .string()
    .refine((value) => normalizeBrowserDuration(value) === value)
    .nullable(),
});
function detail(scope: BrowserBillingScope, browserMs: string | null, price: BrowserPrice) {
  return {
    kind: "browser",
    meter: BROWSER_METER,
    unit: BROWSER_METER_UNIT,
    rateCardId: price.card,
    activationStart: price.activationStart,
    providerCostMicros: price.providerCostMicros.toString(),
    unitsPerCharge: price.rate.unitsPerCharge.toString(),
    creditMicrosPerCharge: price.rate.creditMicros.toString(),
    environmentId: scope.environmentId,
    quantity: String(browserMs ?? 0),
    measurement: browserMs === null ? "missing" : "provider",
    browserMs,
  };
}
/** The pinned charge and durable state transition commit in one batch, including after an orphan sweep. */
export async function settleBrowser(
  context: CatalogContext,
  raw: unknown,
): Promise<BrowserSettleResult> {
  const input = browserInput(schema, raw),
    { scope } = input,
    { db } = await routeOrganization(context, scope.organizationId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await reservationState(db, scope, input.reservationId);
    if (state === "unknown") return { settled: false, reason: "unknown_reservation" };
    if (state === "settled" || state === "released")
      return { settled: false, reason: "already_resolved" };
    const now = await coreClock(db),
      price = await readPinnedBrowserPrice(db, scope, input.reservationId);
    if (price === null) throw new Error("browser_price_unavailable");
    const chargedMicros = browserCreditMicros(input.browserMs ?? "0", price.rate),
      values = reservationParameters(scope, input.reservationId);
    const plan =
      state === "open"
        ? settleReservation(db, {
            organizationId: scope.organizationId,
            reservationId: input.reservationId,
            chargedMicros,
            now,
            detail: detail(scope, input.browserMs, price),
          })
        : chargeOrg(db, {
            organizationId: scope.organizationId,
            key: `settle:${input.reservationId}`,
            amountMicros: chargedMicros,
            now,
            detail: {
              ...detail(scope, input.browserMs, price),
              lateAfterSweep: true,
              lines: [
                {
                  projectId: scope.projectId,
                  environmentId: scope.environmentId,
                  meter: BROWSER_METER,
                  unit: BROWSER_METER_UNIT,
                  rateCardId: price.card,
                  quantity: String(input.browserMs ?? "0"),
                  chargeMicros: chargedMicros,
                },
              ],
            },
            projects: [{ projectId: scope.projectId, amountMicros: chargedMicros }],
          });
    try {
      await db.batch([
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS(SELECT 1 FROM browser_gateway_reservations WHERE reservation_id=?1 AND organization_id=?2 AND project_id=?3 AND environment_id=?4 AND state=?5)",
          [...values, state],
        ),
        ...plan.statements,
        db
          .prepare(
            "UPDATE browser_gateway_reservations SET state='settled' WHERE reservation_id=?1 AND organization_id=?2 AND project_id=?3 AND environment_id=?4 AND state=?5",
          )
          .bind(...values, state),
      ]);
      return { settled: true, chargedMicros };
    } catch (error) {
      const failure = classifyFailure(error);
      if (isDuplicate(error)) return { settled: false, reason: "already_resolved" };
      if (failure.kind !== "guard" || failure.code !== "precondition_changed") throw error;
    }
  }
  return { settled: false, reason: "already_resolved" };
}
