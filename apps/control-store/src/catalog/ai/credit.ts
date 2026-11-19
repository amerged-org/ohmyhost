import {
  AI_METER,
  AI_METER_UNIT,
  aiCreditMicros,
  type AiCardRate,
  type AiKeyScope,
} from "@ohmyhost/platform/shared";
import {
  OVERRUN_CEILING_MICROS,
  paidDenial,
  runtimeDecision,
  type AccountView,
  type ProjectBudget,
} from "../credit/index.js";
import type { AiPrice } from "./common.js";

export type AiDenial =
  | "paid_plan_required"
  | "insufficient_organization_credits"
  | "project_budget_exceeded";

/**
 * What an AI call needs before it reserves: a Paid organization whose credit is not exhausted past its grace, and a Stop
 * budget whose use of the month is not spent. The rules are the mail's (`requireMailAccess`, `requireMailBudget`), read
 * as denials instead of thrown errors. An empty balance is refused by the reservation itself.
 */
export function aiAdmissionDenial(
  account: AccountView,
  project: ProjectBudget | null,
  now: string,
): AiDenial | null {
  const denied = paidDenial(account);
  if (denied !== null) return denied;
  // The month's platform overrun at its ceiling serves no AI call, as for a zero balance (see runtimeDecision).
  if (account.availableMicros === 0 && account.overrunMonthMicros >= OVERRUN_CEILING_MICROS)
    return "insufficient_organization_credits";
  return runtimeDecision({ now, active: true, account, project, poweredBy: false }).reason ===
    "project_budget_exceeded"
    ? "project_budget_exceeded"
    : null;
}

/**
 * The credit micros an upper-bound cost reserves: the card's charge, and never less than one micro-credit, because a
 * reservation of zero is refused by the credit core. The conversion itself is `aiCreditMicros`.
 */
export function aiReservationMicros(estimateNanoUsd: bigint, rate: AiCardRate): number {
  return Math.max(1, aiCreditMicros(estimateNanoUsd, rate));
}

/**
 * The usage-report quantity of a settlement: the measured orq cost in USD micros (the meter's unit), exact to three
 * decimals. The report reads it from the `quantity` key of a settlement together with the `unit` key.
 */
export function aiUsdMicroQuantity(costNanoUsd: bigint): string {
  const whole = costNanoUsd / 1000n;
  const fraction = (costNanoUsd % 1000n).toString().padStart(3, "0").replace(/0+$/u, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** The card the settlement was priced with, for the usage report: a closed structure that holds no prompt text. */
export function aiSettlementDetail(input: {
  readonly scope: AiKeyScope;
  readonly model: string;
  readonly costNanoUsd: bigint;
  readonly usage: Readonly<Record<string, number>>;
  readonly traceId: string | null;
  readonly price: AiPrice;
}): Record<string, unknown> {
  return {
    kind: "ai",
    meter: AI_METER,
    unit: AI_METER_UNIT,
    rateCardId: input.price.card,
    environmentId: input.scope.environmentId,
    model: input.model,
    quantity: aiUsdMicroQuantity(input.costNanoUsd),
    costNanoUsd: input.costNanoUsd.toString(),
    usage: input.usage,
    traceId: input.traceId,
  };
}
