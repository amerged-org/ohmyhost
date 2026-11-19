import type { TransactionClient } from "./transaction.js";

export interface StripeInboxEvent {
  id: string;
  type: string;
  objectId: string;
  accountId: string;
  mode: "test" | "live";
}

/** Called only after raw Stripe signature verification. Store identity, never the raw body. */
export declare function recordStripeInboxEvent(
  c: TransactionClient,
  input: {
    inboxEventId: string;
    event: StripeInboxEvent;
    receivedAt: string;
  },
): Promise<"created" | "existing">;

export declare function claimStripeInboxEvent(
  c: TransactionClient,
  input: {
    accountId: string;
    mode: "test" | "live";
    claimId: string;
    now: string;
  },
): Promise<{
  inbox_event_id: string;
  payload: StripeInboxEvent;
} | null>;

export declare function finishStripeInboxEvent(
  c: TransactionClient,
  input: {
    inboxEventId: string;
    claimId: string;
    now: string;
    errorCode: string | null;
  },
): Promise<{ finished: boolean; parked: boolean }>;

export declare function recoverExpiredStripeInboxClaims(
  c: TransactionClient,
  input: {
    accountId: string;
    mode: "test" | "live";
    now: string;
  },
): Promise<{ count: number; parkedIds: string[] }>;
