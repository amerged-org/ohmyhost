import type { TransactionClient } from "./transaction.js";

export class ProjectComputeChangeError extends Error {
  constructor(
    readonly code:
      | "compute_change_scope_unavailable"
      | "compute_paid_required"
      | "compute_storage_shrink_requires_migration"
      | "compute_change_pending"
      | "compute_performance_paid_required"
      | "compute_performance_unavailable"
      | "compute_change_conflict",
  ) {
    super(code);
    this.name = "ProjectComputeChangeError";
  }
}

/** Read existing selection/job history for the currently owned physical data environment. */
export declare function readProjectComputeContext(
  client: TransactionClient,
  input: {
    organizationId: string;
    projectId: string;
    environment: "dev" | "prod";
    now: string;
  },
): Promise<{
  provider: "pgcf";
  dataMode: "shared" | "isolated";
  dataEnvironmentId: string;
  effective: {
    memoryMiB: import("@ohmyhost/contracts/database-sizes").DatabaseMemoryMiB;
    sizeClassId: string;
  };
  selected: {
    memoryMiB: number;
    sizeClassId: string;
    operationId: string;
    selectedAt: string | null;
  } | null;
  pendingChange: {
    operationId: string;
    memoryMiB: number;
    state: "failed" | "queued" | "succeeded" | "running" | "cancelled";
    requestedAt: string;
  } | null;
} | null>;
