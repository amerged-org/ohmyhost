import { type Ulid } from "@ohmyhost/platform";

import type { TransactionClient } from "./transaction.js";

export interface SourceArchiveReceiptInput {
  readonly provider?: "github" | "managed";
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly billingEpochId: Ulid;
  readonly sourceConnectionId: Ulid;
  readonly externalRepositoryId: string;
  readonly requestedCommitSha: string;
  readonly resolvedCommitSha: string;
  readonly archiveFormat: "tar.gz";
  readonly sha256: Uint8Array;
  readonly byteLength: number;
  readonly objectRef: string;
  readonly acquiredAt: string;
}

export interface StoredSourceArchiveReceipt extends SourceArchiveReceiptInput {
  readonly provider: "github" | "managed";
}

export declare class GithubSourceConnectionConflictError extends Error {
  readonly code: "github_source_connection_conflict";
  constructor();
}

export class SourceArchiveReconciliationConflictError extends Error {
  readonly code = "source_archive_reconciliation_required" as const;

  constructor() {
    super("Source archive receipt conflicts with immutable persisted evidence");
    this.name = "SourceArchiveReconciliationConflictError";
  }
}

export declare function observeSourceArchiveReceipt(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<StoredSourceArchiveReceipt | null>;
