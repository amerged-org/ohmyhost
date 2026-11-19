import { CommandConflictError } from "../../run-command.js";

/** Codes of the PostgreSQL `OrganizationCreditError` plus the ones the D1 ledger adds. */
export type CreditErrorCode =
  | "organization_credit_scope_missing"
  | "insufficient_organization_credits"
  | "credit_request_conflict"
  | "paid_plan_required"
  | "project_budget_exceeded"
  | "billing_epoch_mismatch"
  | "credit_hold_not_settled"
  | "credit_refund_exceeds_charge"
  | "credit_bucket_moving"
  | "credit_ledger_unavailable"
  | "credit_wallet_unavailable";

/** A deterministic refusal; nothing was applied. */
export class OrganizationCreditError extends CommandConflictError {
  constructor(readonly creditCode: CreditErrorCode) {
    super(creditCode, creditCode);
  }
}
