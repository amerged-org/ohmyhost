import { type FeedbackStatus, type FeedbackSubmission } from "@ohmyhost/contracts/feedback";

export interface SubmitFeedbackInput {
  readonly report: FeedbackSubmission;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: Uint8Array;
  readonly feedbackId: string;
  readonly submittedAt: string;
}

export class FeedbackPersistenceError extends Error {
  public constructor(public readonly code: "resource_not_found" | "idempotency_key_reused") {
    super(code);
    this.name = "FeedbackPersistenceError";
  }
}

export interface CustomerFeedbackStatusRecord {
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  /** Null when the cursor is not a customer-visible update of this report. */
  readonly status: FeedbackStatus | null;
}
