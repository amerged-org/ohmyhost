import type { TransactionClient } from "./transaction.js";

/** Meter receipt time, never customer-webhook attempts. Identity makes settlement replay-safe. */
export declare function billResendReceivedMail(
  client: TransactionClient,
  input: {
    messageId: string;
    valuationId: string;
    now: string;
  },
): Promise<void>;
export declare function listUnbilledReceivedMail(client: TransactionClient): Promise<string[]>;
