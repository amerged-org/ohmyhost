import { z } from "zod";
import { instant, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { OrganizationCreditError } from "./errors.js";
import { readRuntimeDecision } from "../credit/index.js";

const inputSchema = z.strictObject({ organizationId: ulid, projectId: ulid, now: instant });
export type PaidDomainAccessReason =
  | "paid_plan_required"
  | "insufficient_organization_credits"
  | "project_budget_exceeded"
  | null;

/**
 * Whether the project may attach a custom domain now, answered from the serving decision of the gateway: its refusal
 * (credit exhausted past the grace, a budget stop) first, then Paid or the powered-by flag. It only reads; the domain
 * write that follows is a separate command, so no balance is fenced.
 */
export async function admitPaidProjectDomain(
  context: CatalogContext,
  raw: unknown,
): Promise<PaidDomainAccessReason> {
  const input = inputSchema.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    production = await db
      .prepare(
        "SELECT environment_id FROM environments WHERE organization_id=?1 AND project_id=?2 AND name='prod'",
      )
      .bind(input.organizationId, input.projectId)
      .first<{ environment_id: string }>();
  if (production === null) throw new Error("Paid domain environment is unavailable");
  const decision = await readRuntimeDecision(db, {
    ...input,
    environmentId: production.environment_id,
  });
  if (decision.reason === "project_unavailable")
    throw new OrganizationCreditError("organization_credit_scope_missing");
  return decision.reason ?? (decision.customDomainAllowed ? null : "paid_plan_required");
}
