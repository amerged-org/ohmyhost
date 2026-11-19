import type { TransactionClient } from "./transaction.js";

export interface CreditWarningScope {
  organizationId: string;
  exhaustedAt: string;
}
export declare function claimCreditWarningPeriods(
  c: TransactionClient,
  now: string,
): Promise<
  {
    organizationId: string;
    exhaustedAt: string;
    leaseUntil: string;
  }[]
>;

export declare function finishCreditWarningPeriod(
  c: TransactionClient,
  input: CreditWarningScope & {
    leaseUntil: string;
    now: string;
    errorCode: "CREDIT_WARNING_RECIPIENTS_UNAVAILABLE" | "CREDIT_WARNING_SEND_UNRESOLVED" | null;
  },
): Promise<boolean>;

export declare function claimCreditWarning(
  c: TransactionClient,
  input: CreditWarningScope & {
    noticeId: string;
    ownerId: string;
    now: string;
  },
): Promise<{
  noticeId: string;
  attempt: number;
} | null>;

export declare function finishCreditWarning(
  c: TransactionClient,
  input: {
    noticeId: string;
    attempt: number;
    now: string;
    result:
      | {
          messageId: string;
        }
      | {
          errorCode:
            | "CREDIT_WARNING_NOT_SENT"
            | "CREDIT_WARNING_REJECTED"
            | "CREDIT_WARNING_UNCERTAIN";
        };
  },
): Promise<void>;
