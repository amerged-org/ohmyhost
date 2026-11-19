import { z } from "zod";
import {
  BUILD_METER,
  BUILD_UNIT,
  creditMicros,
  evaluateRateCard,
  usdMicros,
} from "@ohmyhost/platform";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { releaseReservation, settleReservation } from "../credit/index.js";
import { publicTimestamp } from "../common.js";
import type { UsageInput } from "./contracts.js";

const quote = z.object({
  rate_card_version: z.string(),
  reserved_seconds: z.string(),
  provider_cost_micros: z.string(),
  credit_micros: z.string(),
});

/**
 * Settles the build reservation of an accepted deployment against the measured build seconds: the actual cost is
 * charged at the rate the plan quoted, the rest of the reservation is released and its row is deleted. It composes with
 * the immutable usage INSERT in the caller's ONE batch. A build whose sandbox never started (no provisioning instant)
 * releases its reservation in full instead. A build without an open reservation or without an accepted plan is durable
 * evidence only and is never back-billed.
 */
export function buildSettlement(
  db: D1Database,
  reserved: boolean,
  input: UsageInput,
  accepted: {
    organizationId: string;
    planCreatedAt: string | null;
    costEstimate: string | null;
  },
  observedAt: string,
): D1PreparedStatement[] {
  if (!reserved || accepted.planCreatedAt === null || accepted.costEstimate === null) return [];
  if (input.usage.instanceType !== "standard-3")
    throw new Error("Measured build has no published price");
  // A sandbox that never started (no provisioning instant) ran nothing: its reservation returns in full, uncharged.
  if (input.usage.provisioningStartedAt === null)
    return releaseReservation(db, {
      organizationId: accepted.organizationId,
      reservationId: input.receipt.scope.operationId,
      now: observedAt,
      detail: { operationId: input.receipt.scope.operationId, reason: "build_not_started" },
    }).statements;
  const q = quote.parse(JSON.parse(accepted.costEstimate) as unknown);
  const quantity =
    (BigInt(Date.parse(input.usage.completedAt) - Date.parse(input.usage.provisioningStartedAt)) +
      999n) /
    1000n;
  const priced = evaluateRateCard(
    [
      {
        id: q.rate_card_version,
        currency: "USD",
        publishedAt: publicTimestamp(accepted.planCreatedAt),
        effectiveFrom: publicTimestamp(accepted.planCreatedAt),
        rates: [
          {
            meter: BUILD_METER,
            unit: BUILD_UNIT,
            unitsPerCharge: BigInt(q.reserved_seconds),
            providerCostPerCharge: usdMicros(BigInt(q.provider_cost_micros)),
            creditsPerCharge: creditMicros(BigInt(q.credit_micros)),
            minimumCreditCharge: creditMicros(0n),
            roundingMode: "ceil",
          },
        ],
      },
    ],
    { eventTime: new Date(input.usage.startedAt), meter: BUILD_METER, unit: BUILD_UNIT, quantity },
  );
  return settleReservation(db, {
    organizationId: accepted.organizationId,
    reservationId: input.receipt.scope.operationId,
    chargedMicros: Number(priced.creditCharge),
    now: observedAt,
    detail: {
      operationId: input.receipt.scope.operationId,
      meter: BUILD_METER,
      seconds: quantity.toString(),
      rateCardId: priced.rateCardId,
    },
  }).statements;
}
