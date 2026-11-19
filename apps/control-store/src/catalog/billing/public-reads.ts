import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { storedTimestamp } from "../../timestamps.js";
import {
  publicTimestamp,
  routeOrganization,
  rowsOf,
  ulid,
  type CatalogContext,
} from "../common.js";
import {
  ACCOUNT_SELECT,
  accountView,
  monthPeriod,
  nextMonthStart,
  type AccountRow,
} from "../credit/account.js";
import { OrganizationCreditError } from "./errors.js";

/** An instant the caller names: canonical ISO with milliseconds, normalised to the stored form. */
const publicNow = z
  .string()
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  })
  .transform(storedTimestamp);
export const publicCreditInput = z.strictObject({ organizationId: ulid, now: publicNow });
export const publicBudgetInput = publicCreditInput.extend({ projectId: ulid });

interface OrganizationRow {
  readonly workos_organization_id: string | null;
  readonly name: string | null;
}

/** The account of the organization as it stands at `now`, read in one batch with its display identity. */
async function readOrganizationAccount(db: D1Database, organizationId: string, now: string) {
  const [account, organization] = await db.batch([
    db.prepare(ACCOUNT_SELECT).bind(organizationId),
    db
      .prepare(
        `SELECT o.workos_organization_id,
           (SELECT name FROM onboarding_requests r WHERE r.organization_id = o.organization_id AND r.completed_at IS NOT NULL LIMIT 1) AS name
         FROM organizations o WHERE o.organization_id = ?1`,
      )
      .bind(organizationId),
  ]);
  const [identity] = rowsOf<OrganizationRow>(organization);
  if (identity === undefined)
    throw new OrganizationCreditError("organization_credit_scope_missing");
  return {
    identity,
    account: accountView(organizationId, rowsOf<AccountRow>(account)[0] ?? null, now),
  };
}

/** The plan, the monthly and the one-time credit of the account, and the reservations that hold part of it. */
export async function readCreditAccount(context: CatalogContext, raw: unknown) {
  const input = publicCreditInput.parse(raw);
  const db = (await routeOrganization(context, input.organizationId)).db;
  const { identity, account } = await readOrganizationAccount(db, input.organizationId, input.now);
  return {
    organization_id: input.organizationId,
    name: identity.name ?? "Workspace",
    workos_organization_id: identity.workos_organization_id ?? "",
    plan: account.paid ? ("paid" as const) : ("free" as const),
    plan_source: account.paid ? (account.paidSource ?? "manual") : ("free" as const),
    paid_until:
      account.paid && account.paidUntil !== null ? publicTimestamp(account.paidUntil) : null,
    available_micros: account.availableMicros.toString(),
    monthly_micros: account.monthlyMicros.toString(),
    one_time_micros: account.onetimeMicros.toString(),
    reserved_micros: account.reservedMicros.toString(),
    next_expiry: account.monthlyMicros > 0 ? publicTimestamp(account.monthlyEndsAt) : null,
    as_of: publicTimestamp(input.now),
  };
}

/** The credit balance of the organization: what it may spend, what is reserved and the grace after exhaustion. */
export async function readCreditOrganization(context: CatalogContext, raw: unknown) {
  const input = publicCreditInput.parse(raw);
  const db = (await routeOrganization(context, input.organizationId)).db;
  const { account } = await readOrganizationAccount(db, input.organizationId, input.now);
  return {
    organization_id: input.organizationId,
    unit: "microcredits" as const,
    as_of: publicTimestamp(input.now),
    available_micros: account.availableMicros.toString(),
    reserved_micros: account.reservedMicros.toString(),
    grace_started_at: account.exhaustedAt === null ? null : publicTimestamp(account.exhaustedAt),
    grace_expires_at: account.graceEndsAt === null ? null : publicTimestamp(account.graceEndsAt),
  };
}

export interface ProjectCreditRow {
  readonly period: string;
  readonly used_micros: number;
  readonly budget_micros: number | null;
  readonly budget_mode: "continue" | "stop" | null;
  readonly reserved_micros: number;
}

/** The project's budget row and its open reservations, selected by `?1` organization and `?2` project. */
export const PROJECT_BUDGET_SELECT = `SELECT period, used_micros, budget_micros, budget_mode,
    (SELECT COALESCE(SUM(amount_micros), 0) FROM credit_reservation WHERE organization_id = ?1 AND project_id = ?2) AS reserved_micros
  FROM project_credit WHERE organization_id = ?1 AND project_id = ?2`;

/** The wire form of a project's budget for the UTC month of `now`; the use of an older month does not count. */
export function publicBudgetBody(
  projectId: string,
  now: string,
  row: ProjectCreditRow | undefined,
  replacement?: { readonly amountMicros: number | null; readonly mode: "continue" | "stop" },
) {
  const current = row !== undefined && row.period === monthPeriod(now);
  const amount = replacement ? replacement.amountMicros : (row?.budget_micros ?? null);
  return {
    project_id: projectId,
    amount_micros: amount === null ? null : String(amount),
    mode: replacement?.mode ?? row?.budget_mode ?? ("continue" as const),
    used_micros: String(current ? row.used_micros : 0),
    reserved_micros: String(row?.reserved_micros ?? 0),
    period_start: `${monthPeriod(now)}-01T00:00:00.000Z`,
    period_end: publicTimestamp(nextMonthStart(now)),
    as_of: publicTimestamp(now),
  };
}

/** The monthly budget of one project of the organization, with its use this UTC month and its open reservations. */
export async function readProjectCreditBudgetPublic(context: CatalogContext, raw: unknown) {
  const input = publicBudgetInput.parse(raw);
  const db = (await routeOrganization(context, input.organizationId)).db;
  const [project, budget] = await db.batch([
    db
      .prepare("SELECT 1 AS found FROM projects WHERE organization_id = ?1 AND project_id = ?2")
      .bind(input.organizationId, input.projectId),
    db.prepare(PROJECT_BUDGET_SELECT).bind(input.organizationId, input.projectId),
  ]);
  if (rowsOf(project).length === 0)
    throw new OrganizationCreditError("organization_credit_scope_missing");
  return publicBudgetBody(input.projectId, input.now, rowsOf<ProjectCreditRow>(budget)[0]);
}
