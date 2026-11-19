import type { TransactionClient } from "./transaction.js";

interface Scope {
  organizationId: string;
  accountId: string;
  mode: "test" | "live";
  now: string;
}
export interface RechargePolicy {
  organization_id: string;
  account_id: string;
  mode: "test" | "live";
  enabled: boolean;
  revision: number;
  monthly_limit_minor: number;
  status:
    | "off"
    | "setup_required"
    | "on"
    | "payment_required"
    | "monthly_limit"
    | "needs_reconciliation"
    | "tax_required";
  setup_id: string;
  setup_session_id: string | null;
  payment_method_id: string | null;
  updated_at: Date;
  checked_at: Date | null;
}
export declare function readRechargePolicy(
  c: TransactionClient,
  s: Scope,
): Promise<RechargePolicy | null>;
export declare function readRecharge(
  c: TransactionClient,
  s: Scope,
): Promise<{
  organization_id: string;
  portal_available: boolean;
  enabled: boolean;
  revision: number;
  status:
    | "off"
    | "setup_required"
    | "on"
    | "payment_required"
    | "monthly_limit"
    | "needs_reconciliation"
    | "tax_required";
  monthly_limit_minor: number;
  spent_minor: number;
  currency: "usd";
  amount_minor: 900;
  credits: 1000;
  threshold_credits: 100;
  setup_url: string | null;
  invoice_url: string | null;
  billing_issue: import("@ohmyhost/contracts/billing").BillingTaxIssue | null;
}>;
export declare function configureRecharge(
  c: TransactionClient,
  s: Scope & {
    enabled: boolean;
    monthlyLimitMinor: number;
    consent: string | null;
    revision: number;
    actorId: string;
    idempotencyKey: string;
    id: string;
  },
): Promise<{
  organization_id: string;
  portal_available: boolean;
  enabled: boolean;
  revision: number;
  status:
    | "off"
    | "setup_required"
    | "on"
    | "payment_required"
    | "monthly_limit"
    | "needs_reconciliation"
    | "tax_required";
  monthly_limit_minor: number;
  spent_minor: number;
  currency: "usd";
  amount_minor: 900;
  credits: 1000;
  threshold_credits: 100;
  setup_url: string | null;
  invoice_url: string | null;
  billing_issue: import("@ohmyhost/contracts/billing").BillingTaxIssue | null;
}>;
export declare function claimRecharge(
  c: TransactionClient,
  s: Scope & {
    id: string;
  },
): Promise<{
  id: string;
  remainingMinor: number;
} | null>;
