import { z } from "zod";
import type { Ulid } from "@ohmyhost/platform";

export interface D1GatewayCreditRuntime {
  read(input: unknown): Promise<unknown>;
}
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
  instant = z
    .string()
    .refine(
      (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    ),
  decision = z.strictObject({
    organizationId: id,
    projectId: id,
    environmentId: id,
    allowed: z.boolean(),
    paidAllowed: z.boolean(),
    reason: z
      .enum(["insufficient_organization_credits", "project_budget_exceeded", "project_unavailable"])
      .nullable(),
    checkedAt: instant,
    expiresAt: instant,
  });

/** One private read capability; no mutation or financial primitive. */
export async function readD1RuntimeCreditDecision(
  bindings: Record<string, unknown>,
  scope: { organizationId: Ulid; projectId: Ulid; environmentId: Ulid },
  now: string,
) {
  const runtime = bindings["GATEWAY_CREDIT_RUNTIME"] as D1GatewayCreditRuntime | undefined;
  if (typeof runtime?.read !== "function") throw new Error("gateway_credit_binding_required");
  const result = decision.parse(await runtime.read({ ...scope, now }));
  if (
    result.organizationId !== scope.organizationId ||
    result.projectId !== scope.projectId ||
    result.environmentId !== scope.environmentId ||
    result.checkedAt !== now ||
    result.expiresAt !== new Date(Date.parse(now) + 900_000).toISOString() ||
    result.allowed !== (result.reason === null) ||
    ((result.reason === "insufficient_organization_credits" ||
      result.reason === "project_unavailable") &&
      result.paidAllowed)
  )
    throw new Error("gateway_credit_response_invalid");
  return result;
}
