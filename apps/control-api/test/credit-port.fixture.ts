import { OrganizationCreditError } from "@ohmyhost/database";
import type { OrganizationCreditUsage } from "@ohmyhost/contracts/credit-pricing";
import type { CreditManagementPort, ProjectCreditBudgetBody } from "../src/credits.js";

/**
 * The credit port for tests that run the REST API on the PostgreSQL harness, which has no Core: one Free workspace
 * (200 credits) and project budgets with the idempotency of the real port. The account, the log
 * and the budget semantics of the real port are tested against the Core in control-store and d1-credits.
 */
export function createFixtureCreditPort(
  now: () => Date,
  options: { readonly usage?: Partial<OrganizationCreditUsage> } = {},
): CreditManagementPort & { readonly budgetWrites: () => number } {
  const budgets = new Map<string, { amount: string | null; mode: "continue" | "stop" }>();
  const receipts = new Map<string, { digest: string; body: ProjectCreditBudgetBody }>();
  let writes = 0;
  const body = (projectId: string): ProjectCreditBudgetBody => {
    const at = now(),
      budget = budgets.get(projectId);
    return {
      project_id: projectId,
      amount_micros: budget?.amount ?? null,
      mode: budget?.mode ?? "continue",
      used_micros: "0",
      reserved_micros: "0",
      period_start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString(),
      period_end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString(),
      as_of: at.toISOString(),
    };
  };
  return {
    budgetWrites: () => writes,
    async readUsage(organizationId) {
      const at = now();
      return {
        organization_id: organizationId,
        as_of: at.toISOString(),
        unit: "microcredits",
        period: at.toISOString().slice(0, 7),
        from: new Date(
          Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - 13),
        ).toISOString(),
        projects: [],
        days: [],
        ...options.usage,
      };
    },
    async readOrganization(organizationId) {
      return {
        organization_id: organizationId,
        unit: "microcredits",
        as_of: now().toISOString(),
        available_micros: "200000000",
        reserved_micros: "0",
        grace_started_at: null,
        grace_expires_at: null,
      };
    },
    async readAccount(organizationId) {
      return {
        organization_id: organizationId,
        name: "Workspace",
        workos_organization_id: `org_${organizationId}`,
        plan: "free",
        plan_source: "free",
        paid_until: null,
        available_micros: "200000000",
        monthly_micros: "200000000",
        one_time_micros: "0",
        reserved_micros: "0",
        next_expiry: "2026-09-01T00:00:00.000Z",
        as_of: now().toISOString(),
      };
    },
    async readBudget(context) {
      return { status: 200, body: body(context.projectId) };
    },
    async setBudget(context) {
      const key = `${context.projectId}:${context.idempotencyKey}`,
        digest = Buffer.from(context.canonicalRequestDigest).toString("hex"),
        original = receipts.get(key);
      if (original !== undefined) {
        if (original.digest !== digest)
          throw new OrganizationCreditError("credit_request_conflict");
        return { status: 200, body: original.body };
      }
      budgets.set(context.projectId, { amount: context.amountMicros, mode: context.mode });
      writes += 1;
      const result = body(context.projectId);
      receipts.set(key, { digest, body: result });
      return { status: 200, body: result };
    },
  };
}
