import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import { OVERRUN_CEILING_MICROS, monthPeriod, type AccountView } from "./account.js";
import type { ProjectBudget } from "./decision.js";

// The admission rules of the product commands (a build, a Paid feature), pure over an account and a project budget
// that were read before. They only decide: the guard of `reserve` in the writing batch is what keeps the balance exact.

export type AdmissionDenial =
  | "paid_plan_required"
  | "insufficient_organization_credits"
  | "project_budget_exceeded";

/**
 * The budget and the use of the current month of one project, with its open reservations; null when the project has no
 * `project_credit` row (nothing was charged to it and no budget was set).
 */
export async function readProjectBudget(
  db: D1Database,
  input: { readonly organizationId: string; readonly projectId: string },
): Promise<ProjectBudget | null> {
  const row = await db
    .prepare(
      `SELECT period, used_micros, budget_micros, budget_mode,
         (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_reservation WHERE organization_id = ?1 AND project_id = ?2) AS reserved_micros
       FROM project_credit WHERE organization_id = ?1 AND project_id = ?2`,
    )
    .bind(input.organizationId, input.projectId)
    .first<{
      readonly period: string;
      readonly used_micros: number;
      readonly budget_micros: number | null;
      readonly budget_mode: "continue" | "stop" | null;
      readonly reserved_micros: number;
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
 * Paid features (the mail framework, paid compute sizes): the organization is Paid, and once its credit is exhausted the
 * 7-day grace has not lapsed and the month's platform overrun has not reached its ceiling. Without Paid the answer is
 * `paid_plan_required` whatever the credit is.
 */
export function paidDenial(
  account: AccountView,
): "paid_plan_required" | "insufficient_organization_credits" | null {
  if (!account.paid) return "paid_plan_required";
  return account.availableMicros === 0 &&
    (account.graceLapsed || account.overrunMonthMicros >= OVERRUN_CEILING_MICROS)
    ? "insufficient_organization_credits"
    : null;
}

export interface BuildAdmissionInput {
  readonly now: string;
  readonly account: AccountView;
  readonly project: ProjectBudget | null;
  /** The reservation the build asks for: the quote of its plan. */
  readonly amountMicros: number;
  /** The plan enables the mail framework, which is a Paid feature. */
  readonly requirePaid: boolean;
}

/**
 * Whether a build may reserve its quote. In order: a Paid feature needs Paid and a credit that is not exhausted past
 * its grace and below the overrun ceiling; a `stop` budget must still hold the use of the month, the open reservations and the quote; and the
 * available credit must cover the quote. A build has no grace: unlike serving, it never starts on credit that is not
 * there.
 */
export function buildAdmissionDenial(input: BuildAdmissionInput): AdmissionDenial | null {
  if (input.requirePaid) {
    const denied = paidDenial(input.account);
    if (denied !== null) return denied;
  }
  const { project } = input;
  if (project !== null && project.budgetMode === "stop" && project.budgetMicros !== null) {
    const used =
      project.period === monthPeriod(storedTimestamp(input.now)) ? project.usedMicros : 0;
    if (used + project.reservedMicros + input.amountMicros > project.budgetMicros) {
      return "project_budget_exceeded";
    }
  }
  return input.account.availableMicros < input.amountMicros
    ? "insufficient_organization_credits"
    : null;
}

/**
 * The Stop budget of a project, as the batch that reserves must see it. `buildAdmissionDenial` decides on a snapshot read
 * earlier; this repeats its budget rule on the rows as they are when the batch commits: the use of the month, the open
 * reservations of the project and this reservation's own `amountMicros` must fit the budget now in force. A violated
 * budget aborts the batch with `precondition_changed`, so a limit an Owner lowered after the read, or a concurrent
 * reservation of the same project, never lets a reservation above it commit.
 */
export function stopBudgetGuard(
  db: D1Database,
  scope: { readonly organizationId: string; readonly projectId: string },
  now: string,
  amountMicros: number,
): D1PreparedStatement {
  return guard(
    db,
    "precondition_changed",
    `EXISTS (SELECT 1 FROM project_credit p WHERE p.organization_id = ?1 AND p.project_id = ?2
       AND p.budget_mode = 'stop' AND p.budget_micros IS NOT NULL
       AND (CASE WHEN p.period = ?3 THEN p.used_micros ELSE 0 END)
         + (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_reservation WHERE organization_id = ?1 AND project_id = ?2)
         + ?4 > p.budget_micros)`,
    [scope.organizationId, scope.projectId, monthPeriod(storedTimestamp(now)), amountMicros],
  );
}
