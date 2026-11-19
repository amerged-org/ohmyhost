import type { D1Database, D1PreparedStatement, D1Result } from "../../d1-types.js";
import { storedTimestamp } from "../../timestamps.js";
import {
  ACCOUNT_SELECT,
  OVERRUN_CEILING_MICROS,
  accountView,
  micros,
  monthPeriod,
  type AccountRow,
  type AccountView,
  type CreditPlan,
} from "./account.js";
import { addMilliseconds, publicTimestamp, rowsOf } from "../common.js";

/** The lifetime of a decision handed to the gateway. */
export const DECISION_TTL_MS = 900_000;

export type RuntimeDenial =
  | "project_unavailable"
  | "insufficient_organization_credits"
  | "project_budget_exceeded";

/** The budget and the month's use of one project; `usedMicros` counts for `period` only. */
export interface ProjectBudget {
  readonly budgetMicros: number | null;
  readonly budgetMode: "continue" | "stop" | null;
  readonly period: string;
  readonly usedMicros: number;
  /** The open reservations of the project. */
  readonly reservedMicros: number;
}

export interface RuntimeFacts {
  readonly now: string;
  /** The organization, the project and the environment are all active. */
  readonly active: boolean;
  readonly account: AccountView;
  readonly project: ProjectBudget | null;
  /** The project carries the powered-by flag, which opens custom domains without Paid. */
  readonly poweredBy: boolean;
}

export interface RuntimeDecision {
  readonly allowed: boolean;
  readonly reason: RuntimeDenial | null;
  /** Paid compute sizes and the mail framework: the organization is Paid and its credit is not exhausted. */
  readonly paidAllowed: boolean;
  /** Custom domains need Paid or the powered-by flag. */
  readonly customDomainAllowed: boolean;
}

/**
 * The serving decision of the gateway, pure over the facts of one instant. In order: something not active is
 * `project_unavailable`; no available credit after the 7-day grace, or the month's platform overrun at its ceiling, is
 * `insufficient_organization_credits`; a `stop`
 * budget whose use of the month plus the open reservations reached the budget is `project_budget_exceeded`. A budget
 * stop leaves the Paid features alone, an exhausted credit takes them too.
 */
export function runtimeDecision(facts: RuntimeFacts): RuntimeDecision {
  const now = storedTimestamp(facts.now);
  const { account, project } = facts;
  const used = project !== null && project.period === monthPeriod(now) ? project.usedMicros : 0;
  const reason: RuntimeDenial | null = !facts.active
    ? "project_unavailable"
    : account.availableMicros === 0 &&
        (account.graceLapsed || account.overrunMonthMicros >= OVERRUN_CEILING_MICROS)
      ? "insufficient_organization_credits"
      : project !== null &&
          project.budgetMode === "stop" &&
          project.budgetMicros !== null &&
          used + project.reservedMicros >= project.budgetMicros
        ? "project_budget_exceeded"
        : null;
  const operable = facts.active && reason !== "insufficient_organization_credits";
  return {
    allowed: reason === null,
    reason,
    paidAllowed: operable && account.paid,
    customDomainAllowed: operable && (account.paid || facts.poweredBy),
  };
}

export interface RuntimeDecisionInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly now: string;
}

interface ScopeRow {
  readonly org_state: string | null;
  readonly lifecycle_state: string | null;
  readonly owner_state: string | null;
  readonly environment_exists: number;
  readonly environment_name: string | null;
  readonly powered_by: number;
}

interface ProjectCreditRow {
  readonly period: string;
  readonly used_micros: number;
  readonly budget_micros: number | null;
  readonly budget_mode: "continue" | "stop" | null;
  readonly reserved_micros: number;
}

/** Composable copies of the original credit reads, for a caller-owned transactional snapshot. */
export function runtimeDecisionStatements(
  db: D1Database,
  input: RuntimeDecisionInput,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `SELECT (SELECT state FROM organizations WHERE organization_id = ?1) AS org_state,
           (SELECT lifecycle_state FROM projects WHERE organization_id = ?1 AND project_id = ?2) AS lifecycle_state,
           (SELECT owner_state FROM projects WHERE organization_id = ?1 AND project_id = ?2) AS owner_state,
           EXISTS (SELECT 1 FROM environments WHERE organization_id = ?1 AND project_id = ?2 AND environment_id = ?3) AS environment_exists,
           (SELECT name FROM environments WHERE organization_id = ?1 AND project_id = ?2 AND environment_id = ?3) AS environment_name,
           EXISTS (SELECT 1 FROM project_powered_by_flag_periods WHERE organization_id = ?1 AND project_id = ?2 AND disabled_at IS NULL) AS powered_by`,
      )
      .bind(input.organizationId, input.projectId, input.environmentId),
    db.prepare(ACCOUNT_SELECT).bind(input.organizationId),
    db
      .prepare(
        `SELECT period, used_micros, budget_micros, budget_mode,
           (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_reservation WHERE organization_id = ?1 AND project_id = ?2) AS reserved_micros
         FROM project_credit WHERE organization_id = ?1 AND project_id = ?2`,
      )
      .bind(input.organizationId, input.projectId),
  ];
}

/** Decode the exact original credit policy over results of the three ordered reads. */
export function runtimeDecisionFromResults(
  input: RuntimeDecisionInput,
  results: readonly D1Result[],
): RuntimeDecision & { readonly checkedAt: string; readonly expiresAt: string } {
  if (results.length !== 3 || results.some((result) => !result.success))
    throw new Error("auth_unavailable");
  const [scope, account, project] = results;
  if (!scope || !account || !project) throw new Error("auth_unavailable");
  const now = storedTimestamp(input.now);
  const [facts] = rowsOf<ScopeRow>(scope) as [ScopeRow];
  const [budget] = rowsOf<ProjectCreditRow>(project);
  const creditAccount = accountView(
    input.organizationId,
    rowsOf<AccountRow>(account)[0] ?? null,
    now,
  );
  const decision = runtimeDecision({
    now,
    active:
      facts.org_state === "active" &&
      facts.owner_state === "active" &&
      facts.lifecycle_state === "active" &&
      facts.environment_exists === 1 &&
      (facts.environment_name === "dev" || facts.environment_name === "prod"),
    account: creditAccount,
    project:
      budget === undefined
        ? null
        : {
            budgetMicros: budget.budget_micros,
            budgetMode: budget.budget_mode,
            period: budget.period,
            usedMicros: budget.used_micros,
            reservedMicros: budget.reserved_micros,
          },
    poweredBy: facts.powered_by === 1,
  });
  return {
    ...decision,
    checkedAt: publicTimestamp(now),
    expiresAt: publicTimestamp(addMilliseconds(now, DECISION_TTL_MS)),
  };
}

/** One read batch (a consistent snapshot) of everything the decision needs, then the pure decision. */
export async function readRuntimeDecision(
  db: D1Database,
  input: RuntimeDecisionInput,
): Promise<RuntimeDecision & { readonly checkedAt: string; readonly expiresAt: string }> {
  const captured = { ...input, now: storedTimestamp(input.now) };
  return runtimeDecisionFromResults(
    captured,
    await db.batch(runtimeDecisionStatements(db, captured)),
  );
}

export interface ProjectBudgetInput {
  readonly organizationId: string;
  readonly projectId: string;
  /** Null removes the budget. */
  readonly budgetMicros: number | null;
  readonly mode: "continue" | "stop";
  readonly now: string;
}

/** Sets the monthly budget of a project; a `stop` budget needs an amount, and the use of the month is kept. */
export function setProjectBudget(
  db: D1Database,
  input: ProjectBudgetInput,
): CreditPlan<{ readonly changed: boolean }> {
  const now = storedTimestamp(input.now);
  const budget = input.budgetMicros === null ? null : micros(input.budgetMicros, "budget");
  if (budget === null && input.mode === "stop") {
    throw new TypeError("a stop budget needs an amount");
  }
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO project_credit(project_id, organization_id, period, used_micros, budget_micros, budget_mode)
         VALUES (?1, ?2, ?3, 0, CAST(?4 AS INTEGER), ?5)
         ON CONFLICT(project_id) DO UPDATE SET organization_id = excluded.organization_id,
           budget_micros = excluded.budget_micros, budget_mode = excluded.budget_mode`,
      )
      .bind(input.projectId, input.organizationId, monthPeriod(now), budget, input.mode),
  ];
  return { statements, read: (results) => ({ changed: (results[0]?.meta.changes ?? 0) === 1 }) };
}
