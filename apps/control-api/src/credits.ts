import type { OrganizationCreditUsage } from "@ohmyhost/contracts/credit-pricing";
import type { ProductSurfaceContext, ProductSurfaceMutationContext } from "./contracts.js";

/** The credit balance of an organization: what it may spend now and the grace after it ran out; never what it was spent on. */
export type OrganizationCreditsBody = {
  readonly organization_id: string;
  readonly unit: "microcredits";
  readonly as_of: string;
  readonly available_micros: string;
  readonly reserved_micros: string;
  readonly grace_started_at: string | null;
  readonly grace_expires_at: string | null;
};

/** The plan of an organization and its credit account. */
export type OrganizationAccountBody = {
  readonly organization_id: string;
  readonly name: string;
  readonly workos_organization_id: string;
  readonly plan: "free" | "paid";
  readonly plan_source: "free" | "stripe" | "granted" | "manual";
  readonly paid_until: string | null;
  readonly available_micros: string;
  readonly monthly_micros: string;
  readonly one_time_micros: string;
  readonly reserved_micros: string;
  readonly next_expiry: string | null;
  readonly as_of: string;
};

/** The monthly budget of a project with its use in the current UTC month. */
export type ProjectCreditBudgetBody = {
  readonly project_id: string;
  readonly amount_micros: string | null;
  readonly mode: "continue" | "stop";
  readonly used_micros: string;
  readonly reserved_micros: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly as_of: string;
};

/** The customer credit reads and the project budget; the Core owns the account, the credit service the daily log. */
export interface CreditManagementPort {
  /** The recent credit-log lines of the organization, or of one project, with each project's use this month. */
  readUsage(organizationId: string, projectId?: string): Promise<OrganizationCreditUsage>;
  readOrganization(organizationId: string): Promise<OrganizationCreditsBody>;
  readAccount(organizationId: string): Promise<OrganizationAccountBody>;
  readBudget(
    context: ProductSurfaceContext,
  ): Promise<{ readonly status: 200; readonly body: ProjectCreditBudgetBody }>;
  /** Null when the project is no longer active, so no budget can be set: the route answers it as not found. */
  setBudget(
    context: ProductSurfaceMutationContext & {
      readonly amountMicros: string | null;
      readonly mode: "continue" | "stop";
    },
  ): Promise<{ readonly status: 200; readonly body: ProjectCreditBudgetBody } | null>;
}
