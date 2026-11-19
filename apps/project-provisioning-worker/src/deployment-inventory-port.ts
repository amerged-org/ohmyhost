/* v8 ignore file -- closed typed persistence contract, no runtime behavior */
import type {
  readWfpProjectDeletionEvidence,
  readCandidateCleanupResources,
  recordCleanupAttempt,
  startProjectDataChangeCleanup,
  appendAuditedProjectDataChangeAssignments,
  deleteProjectFunctionSchedules,
  readManagedSourceDeletionInventory,
} from "@ohmyhost/database/provisioning-persistence";

/** Only original inventory/data-change groups; no SQL, connection or provider transport crosses this port. */
export interface DeploymentInventoryPort {
  listNextCacheRetirementScopes(input: {
    organizationId: string;
    projectId: string;
    operationId: string;
    cleanupRunId: string;
    cursor?: string;
    limit: 100;
  }): Promise<{
    scopes: readonly { environmentId: string; deploymentId: string }[];
    nextCursor: string | null;
  } | null>;
  recordNextCacheRetired(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    deploymentId: string;
    operationId: string;
    cleanupRunId: string;
  }): Promise<"recorded" | "existing" | null>;
  readManagedSourceInventory(
    input: Parameters<typeof readManagedSourceDeletionInventory>[1],
  ): ReturnType<typeof readManagedSourceDeletionInventory>;
  readDeletionEvidence(
    input: Parameters<typeof readWfpProjectDeletionEvidence>[1],
  ): ReturnType<typeof readWfpProjectDeletionEvidence>;
  readCleanupResources(
    input: Parameters<typeof readCandidateCleanupResources>[1],
  ): ReturnType<typeof readCandidateCleanupResources>;
  recordCleanupAttempt(
    input: Parameters<typeof recordCleanupAttempt>[1],
  ): ReturnType<typeof recordCleanupAttempt>;
  startDataChange(
    input: Parameters<typeof startProjectDataChangeCleanup>[1],
  ): ReturnType<typeof startProjectDataChangeCleanup>;
  switchAssignments(
    input: Parameters<typeof appendAuditedProjectDataChangeAssignments>[1],
  ): ReturnType<typeof appendAuditedProjectDataChangeAssignments>;
  deleteSchedules(
    input: Parameters<typeof deleteProjectFunctionSchedules>[1],
  ): ReturnType<typeof deleteProjectFunctionSchedules>;
}
