import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

/** Sends go only through Resend; earlier `aws-ses-v2` requests stay readable as history. */
export interface MailSendClaimInput {
  readonly provider: "resend";
  readonly environmentId: Ulid;
  readonly requestId: Ulid;
  readonly reservationEntryId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly idempotencyKey: string;
  readonly requestSha256: Uint8Array;
  readonly recipientSha256: Uint8Array;
  readonly contentSha256: Uint8Array;
  readonly requestedAt: string;
  /** New runtime requests hash explicit inputs separately from their persisted defaults. */
  readonly requestInputSha256?: Uint8Array;
  readonly sender?: Readonly<{ from?: string; replyTo?: string }>;
}

export interface MailSendSenderSnapshot {
  readonly domainId: Ulid;
  readonly bindingRevision: number;
  readonly from: string;
  readonly replyTo: string | null;
}

export type MailSendClaimResult =
  | Readonly<{
      outcome: "claimed";
      requestId: Ulid;
      remainingCreditMicros: bigint;
      sender?: MailSendSenderSnapshot;
    }>
  | Readonly<{ outcome: "accepted"; requestId: Ulid; providerMessageId: string }>
  | Readonly<{
      outcome: "uncertain";
      requestId: Ulid;
      requestedAt: string;
      providerStarted: boolean;
      sender?: MailSendSenderSnapshot;
    }>
  | Readonly<{ outcome: "rejected"; requestId: Ulid }>;

export declare function claimMailSend(
  client: TransactionClient,
  input: MailSendClaimInput,
): Promise<MailSendClaimResult>;

export declare function completeMailSend(
  client: TransactionClient,
  input: Readonly<{
    organizationId: Ulid;
    projectId: Ulid;
    requestId: Ulid;
    providerMessageId: string;
    completedAt: string;
  }>,
): Promise<"completed" | "existing">;

export declare function rejectMailSend(
  client: TransactionClient,
  input: Readonly<{
    organizationId: Ulid;
    projectId: Ulid;
    requestId: Ulid;
    rejectedAt: string;
  }>,
): Promise<"released" | "existing">;

/**
 * Settles one provider attempt of a started send without reversing another attempt or a provider
 * event: a definite refusal releases the reservation only while the send is still reserved, i.e.
 * before any replay or uncertain outcome; otherwise the send stays uncertain, and a send settled
 * meanwhile keeps and reports its stored outcome.
 */
export declare function settleMailSendAttempt(
  client: TransactionClient,
  input: Readonly<{
    organizationId: Ulid;
    projectId: Ulid;
    requestId: Ulid;
    observedAt: string;
    refused: boolean;
  }>,
): Promise<
  | Readonly<{
      state: "accepted";
      providerMessageId: string;
    }>
  | Readonly<{
      state: "uncertain" | "rejected";
    }>
>;
