import { z } from "zod";
import {
  aiCreditMicros,
  AI_METER,
  AI_METER_UNIT,
  type AiKeyScope,
  type AiSettleResult,
} from "@ohmyhost/platform/shared";
import { type CatalogContext, routeOrganization } from "../common.js";
import { runChargeOrg, runSettleReservation } from "../credit/index.js";
import type { D1Database } from "../../d1-types.js";
import {
  AiPriceUnavailable,
  aiInput,
  aiModel,
  aiReservationId,
  aiScope,
  coreClock,
  readAiPrice,
  reservationState,
  type AiPrice,
} from "./common.js";
import { aiSettlementDetail, aiUsdMicroQuantity } from "./credit.js";

const usageCounters = z
  .record(
    z.string().regex(/^[a-z_]{1,40}$/u),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  )
  .refine((usage) => Object.keys(usage).length <= 16);

const settleInput = z.strictObject({
  scope: aiScope,
  reservationId: aiReservationId,
  model: aiModel,
  costNanoUsd: z.bigint().nonnegative(),
  usage: usageCounters,
  // A header the gateway cannot store is dropped or cut, never refused: a refused settlement would lose the charge.
  traceId: z
    .string()
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value.slice(0, 256))),
});

/**
 * Settles one AI call at its measured cost: the charge is the cost priced with the card that is active now, the rest of
 * the reservation is given back by the credit core. A reservation that is not open for this organization and project is
 * `unknown_reservation`; one that was already settled or released is `already_resolved`, except a call the sweep released
 * after it was delivered: that one is charged once, late, under the same settle key. A card that is withdrawn leaves the
 * reservation open for the sweep, because a call cannot be priced without a card.
 */
export async function settleAi(context: CatalogContext, raw: unknown): Promise<AiSettleResult> {
  const input = aiInput(settleInput, raw),
    { scope } = input,
    { db } = await routeOrganization(context, scope.organizationId),
    state = await reservationState(db, scope, input.reservationId);
  if (state === "unknown") return { settled: false, reason: "unknown_reservation" };
  const now = await coreClock(db),
    price = await readAiPrice(db, now);
  if (state === "resolved") {
    return settleSweptCall(db, { ...input, scope, now, price });
  }
  if (price === null) throw new AiPriceUnavailable();
  const chargedMicros = aiCreditMicros(input.costNanoUsd, price.rate),
    outcome = await runSettleReservation(db, {
      organizationId: scope.organizationId,
      reservationId: input.reservationId,
      chargedMicros,
      now,
      detail: aiSettlementDetail({ ...input, price }),
    });
  // The sweep may release the hold between the state read and this batch. A delivered call still owes its charge.
  if (!outcome.settled) return settleSweptCall(db, { ...input, scope, now, price });
  return { settled: true, chargedMicros };
}

interface LateSettlement {
  readonly scope: AiKeyScope;
  readonly reservationId: string;
  readonly model: string;
  readonly costNanoUsd: bigint;
  readonly usage: Readonly<Record<string, number>>;
  readonly traceId: string | null;
  readonly now: string;
  readonly price: AiPrice | null;
}

/**
 * The late charge of a call the sweep released: the reservation is gone, but the call was delivered and orq was paid.
 * Only a release of this project that the sweep made is charged; the settle key makes a second attempt a no-op. The
 * charge is a usage posting, so the usage report reads it per project, day and meter like any other AI charge.
 */
async function settleSweptCall(db: D1Database, input: LateSettlement): Promise<AiSettleResult> {
  const release = await db
    .prepare(
      "SELECT json_extract(detail, '$.reason') AS reason, json_extract(detail, '$.projectId') AS project_id, json_extract(detail, '$.environmentId') AS environment_id FROM credit_log WHERE key = 'release:' || ?1 AND organization_id = ?2",
    )
    .bind(input.reservationId, input.scope.organizationId)
    .first<{ reason: string | null; project_id: string | null; environment_id: string | null }>();
  if (
    release === null ||
    release.reason !== "swept" ||
    release.project_id !== input.scope.projectId ||
    release.environment_id !== input.scope.environmentId
  ) {
    return { settled: false, reason: "already_resolved" };
  }
  if (input.price === null) throw new AiPriceUnavailable();
  const chargedMicros = aiCreditMicros(input.costNanoUsd, input.price.rate),
    posted = await runChargeOrg(db, {
      organizationId: input.scope.organizationId,
      key: `settle:${input.reservationId}`,
      amountMicros: chargedMicros,
      now: input.now,
      detail: {
        ...aiSettlementDetail({ ...input, price: input.price }),
        lateAfterSweep: true,
        lines: [
          {
            projectId: input.scope.projectId,
            environmentId: input.scope.environmentId,
            meter: AI_METER,
            unit: AI_METER_UNIT,
            rateCardId: input.price.card,
            quantity: aiUsdMicroQuantity(input.costNanoUsd),
            chargeMicros: chargedMicros,
          },
        ],
      },
      projects: [{ projectId: input.scope.projectId, amountMicros: chargedMicros }],
    });
  return posted.posted
    ? { settled: true, chargedMicros }
    : { settled: false, reason: "already_resolved" };
}
