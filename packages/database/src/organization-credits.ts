import type { TransactionClient } from "./transaction.js";

export const ORGANIZATION_CREDIT_GRACE_MILLISECONDS = 604_800_000;

export class OrganizationCreditError extends Error {
  constructor(
    readonly code:
      | "organization_credit_scope_missing"
      | "insufficient_organization_credits"
      | "project_budget_exceeded"
      | "paid_plan_required"
      | "credit_request_conflict",
  ) {
    super(code);
    this.name = "OrganizationCreditError";
  }
}

export declare function readOrganizationPaidPeriod(
  client: TransactionClient,
  input: {
    organizationId: string;
    now: string;
  },
): Promise<{
  grantId: string;
  paidUntil: string;
} | null>;

/** Feature access is separate from Stripe periods and credit allowances. */
export declare function readOrganizationPaidAccess(
  client: TransactionClient,
  input: {
    organizationId: string;
    now: string;
  },
): Promise<
  | {
      source: "stripe";
      revision: string;
      grantId: string;
      paidUntil: string;
    }
  | {
      grantId: null;
      paidUntil: string | null;
      source: "granted" | "manual";
      revision: string;
    }
  | null
>;

/** Observe effective Paid access without changing the financial service period or wallet. */
export declare function requireOrganizationPaidPlan(
  client: TransactionClient,
  input: {
    organizationId: string;
    now: string;
  },
): Promise<
  | {
      source: "stripe";
      revision: string;
      grantId: string;
      paidUntil: string;
    }
  | {
      grantId: null;
      paidUntil: string | null;
      source: "granted" | "manual";
      revision: string;
    }
>;

/** One active monthly allowance. Paid replaces unspent Free funds, never historical usage. */
export declare function ensureMonthlyCredits(
  client: TransactionClient,
  input: {
    readonly organizationId: string;
    readonly grantId: string;
    readonly now: string;
  },
): Promise<string>;

interface CreditScope {
  readonly organizationId: string;
  readonly projectId: string;
}

export declare function readOrganizationCreditBalance(
  client: TransactionClient,
  input: {
    readonly organizationId: string;
    readonly now: string;
  },
): Promise<{
  availableMicros: import("@ohmyhost/platform").CreditMicros;
  monthlyMicros: import("@ohmyhost/platform").CreditMicros;
  oneTimeMicros: import("@ohmyhost/platform").CreditMicros;
  nextExpiry: string | null;
  reservedMicros: import("@ohmyhost/platform").CreditMicros;
  spentMicros: import("@ohmyhost/platform").CreditMicros;
  expiredMicros: import("@ohmyhost/platform").CreditMicros;
  unfundedMicros: import("@ohmyhost/platform").CreditMicros;
}>;

export declare function setProjectCreditBudget(
  client: TransactionClient,
  input: CreditScope & {
    readonly amountMicros: bigint | null;
    readonly mode: "continue" | "stop";
    readonly now: string;
  },
): Promise<{
  amountMicros: import("@ohmyhost/platform").CreditMicros | null;
  mode: "continue" | "stop";
  usedMicros: import("@ohmyhost/platform").CreditMicros;
  reservedMicros: import("@ohmyhost/platform").CreditMicros;
}>;

export declare function readProjectCreditBudget(
  client: TransactionClient,
  input: CreditScope & {
    readonly now: string;
  },
): Promise<{
  amountMicros: import("@ohmyhost/platform").CreditMicros | null;
  mode: "continue" | "stop";
  usedMicros: import("@ohmyhost/platform").CreditMicros;
  reservedMicros: import("@ohmyhost/platform").CreditMicros;
}>;

/** Private serving decision; one durable seven-day grace per continuous org exhaustion. */
export declare function readRuntimeCreditAdmission(
  client: TransactionClient,
  input: CreditScope & {
    environmentId: string;
    grantId: string;
    now: string;
  },
): Promise<{
  organizationId: string;
  projectId: string;
  environmentId: string;
  allowed: boolean;
  paidAllowed: boolean;
  reason: "insufficient_organization_credits" | "project_budget_exceeded" | null;
  checkedAt: string;
  expiresAt: string;
}>;

/**
 * Lock-free, read-only gateway decision. The minute reconciler owns monthly grants and grace
 * transitions, so an exhausted org without a recorded grace start is still inside its grace.
 */
export declare function readRuntimeCreditDecision(
  client: TransactionClient,
  input: CreditScope & {
    environmentId: string;
    now: string;
  },
): Promise<{
  organizationId: string;
  projectId: string;
  environmentId: string;
  allowed: boolean;
  paidAllowed: boolean;
  reason: "insufficient_organization_credits" | "project_budget_exceeded" | null;
  checkedAt: string;
  expiresAt: string;
}>;
