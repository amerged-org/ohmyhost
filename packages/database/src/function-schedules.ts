import type { TransactionClient } from "./transaction.js";

/** The crons of the current head of one environment and the Worker script that receives them. */
export interface EnvironmentFunctionSchedule {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly candidateReceiptId: string;
  readonly immutableScriptName: string;
  readonly crons: readonly string[];
  readonly egressAllowedOrigins: readonly string[];
  readonly updatedAt: string;
}

export interface DueFunctionRun {
  readonly runId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly immutableScriptName: string;
  readonly cron: string;
  readonly scheduledAt: string;
  readonly egressAllowedOrigins: readonly string[];
}

export interface ClaimedFunctionRun extends DueFunctionRun {
  readonly attempt: number;
  readonly leaseUntil: string;
}

/** Records the crons of the activated deployment; an empty list removes the environment schedule. */
export declare function recordEnvironmentFunctionSchedule(
  client: TransactionClient,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly deploymentId: string;
    readonly candidateReceiptId: string;
    readonly crons: readonly string[];
    readonly egressAllowedOrigins: readonly string[];
    readonly now: string;
  },
): Promise<{
  readonly scheduled: boolean;
  readonly immutableScriptName: string | null;
}>;

export declare function deleteProjectFunctionSchedules(
  client: TransactionClient,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
  },
): Promise<number>;
