import type { D1Database } from "../../d1-types.js";
import { OrganizationCreditError } from "../billing/errors.js";
import {
  OVERRUN_CEILING_MICROS,
  runtimeDecision,
  type AccountView,
  type ProjectBudget,
} from "../credit/index.js";

// What mail needs of the credit account: the price of one unit, and the gate in front of sending and receiving. The
// charge itself is `chargeOrg` / `refundOrg` of the credit core, booked in the batch of the mail row it belongs to.

/** The two mail meters and the unit each is counted in. */
export const MAIL_METERS = {
  "mail.sent": "recipient",
  "mail.received": "message",
} as const;
export type MailMeter = keyof typeof MAIL_METERS;

/** One rate of a published card, as the card stores it (decimal strings). */
export interface MailRate {
  readonly units_per_charge: string;
  readonly credit_micros: string;
}
export interface MailPrice {
  readonly card: string;
  readonly rate: MailRate;
}

/**
 * The price of one unit of a meter at the instant `at` (a SQL expression): the card of the meter's latest activation
 * that started by then, as `{card, rate}` JSON, or NULL when no activation covers the instant. A published card that no
 * activation names prices nothing, and a later activation replaces the earlier from its own start time.
 */
export const mailPriceSql = (meter: MailMeter, at: string): string =>
  `(SELECT json_object('card',c.rate_card_id,'rate',json(r.value)) FROM usage_meter_activations a JOIN published_credit_rate_cards c ON c.rate_card_id=a.rate_card_id,json_each(c.rates) r WHERE a.meter='${meter}' AND a.starts_at<=${at} AND c.published_at<=${at} AND json_extract(r.value,'$.meter')='${meter}' AND json_extract(r.value,'$.unit')='${MAIL_METERS[meter]}' ORDER BY a.starts_at DESC LIMIT 1)`;

/** Micro-credits of one unit: the card's charge per `units_per_charge` units, rounded up; null for a malformed card. */
export function mailChargeMicros(rate: MailRate): number | null {
  const units = BigInt(rate.units_per_charge);
  return units <= 0n ? null : Number((BigInt(rate.credit_micros) + units - 1n) / units);
}

/** The open-ended view of a project's budget, as the runtime decision reads it. */
export async function readMailProjectBudget(
  db: D1Database,
  organizationId: string,
  projectId: string,
): Promise<ProjectBudget | null> {
  const row = await db
    .prepare(
      `SELECT period, used_micros, budget_micros, budget_mode,
         (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_reservation WHERE organization_id = ?1 AND project_id = ?2) AS reserved_micros
       FROM project_credit WHERE organization_id = ?1 AND project_id = ?2`,
    )
    .bind(organizationId, projectId)
    .first<{
      period: string;
      used_micros: number;
      budget_micros: number | null;
      budget_mode: "continue" | "stop" | null;
      reserved_micros: number;
    }>();
  return row === null
    ? null
    : {
        budgetMicros: row.budget_micros,
        budgetMode: row.budget_mode,
        period: row.period,
        usedMicros: row.used_micros,
        reservedMicros: row.reserved_micros,
      };
}

/**
 * Mail needs Paid; an exhausted credit keeps working through its 7-day grace and then refuses, and so does a month whose
 * platform overrun reached its ceiling, inside the grace too (the AI path's rule, `aiAdmissionDenial`).
 */
export function requireMailAccess(account: AccountView): void {
  if (!account.paid) throw new OrganizationCreditError("paid_plan_required");
  if (
    account.availableMicros === 0 &&
    (account.graceLapsed || account.overrunMonthMicros >= OVERRUN_CEILING_MICROS)
  )
    throw new OrganizationCreditError("insufficient_organization_credits");
}

/** A Stop budget whose use of the month is spent refuses the project's mail like its requests. */
export function requireMailBudget(
  account: AccountView,
  project: ProjectBudget | null,
  now: string,
): void {
  if (
    runtimeDecision({ now, active: true, account, project, poweredBy: false }).reason ===
    "project_budget_exceeded"
  )
    throw new OrganizationCreditError("project_budget_exceeded");
}
