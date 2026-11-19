import type { TransactionClient } from "./transaction.js";

interface Scope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
}

export class ProjectRecoveryDailyLimitError extends Error {
  readonly code = "project_recovery_daily_limit";
  constructor(readonly retryAt: string) {
    super("One export per project is allowed in a rolling 24-hour period");
    this.name = "ProjectRecoveryDailyLimitError";
  }
}

/** Owner API projection without queued ciphertext, provider credentials or storage locators. */
export declare function readProjectExportStatus(
  client: TransactionClient,
  input: Scope,
): Promise<{
  state: "failed" | "queued" | "succeeded" | "running" | "cancelled";
  requestedAt: string;
  nextRequestAt: string;
  failureCode: string | null;
  archive: {
    bytes: number;
    sha256: string;
    sqlFiles: string[];
    capturedAt: string;
    expiresAt: string;
  } | null;
} | null>;
