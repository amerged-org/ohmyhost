import type {
  ClaimedFunctionRun,
  DueFunctionRun,
  EnvironmentFunctionSchedule,
} from "@ohmyhost/database";

type FunctionRunState = "succeeded" | "retry" | "failed";
interface ClaimInput {
  readonly now: string;
  readonly limit: number;
  /** Lease of the i-th claimed run in claim order; absent entries take the default lease. */
  readonly leaseMilliseconds?: readonly number[];
}
interface FinishInput {
  readonly runId: string;
  readonly attempt: number;
  readonly outcome: "succeeded" | "failed" | "rejected";
  readonly statusCode: number | null;
  readonly now: string;
}
interface PurgeInput {
  readonly before: string;
}

/** The scheduler's five complete transaction boundaries. Dispatch stays outside them. */
export interface SchedulerPersistence {
  readSchedules(): Promise<readonly EnvironmentFunctionSchedule[]>;
  insertDueRuns(input: {
    readonly runs: readonly DueFunctionRun[];
    readonly now: string;
  }): Promise<number>;
  claimRuns(input: ClaimInput): Promise<readonly ClaimedFunctionRun[]>;
  finishRun(input: FinishInput): Promise<FunctionRunState | null>;
  purgeFinishedRuns(input: PurgeInput): Promise<number>;
}

/** Private fixed capability. No customer, schedule mutation, provider, finance or SQL command. */
export interface FunctionsSchedulerRuntimeBinding {
  readSchedules(
    input: Readonly<Record<string, never>>,
  ): Promise<readonly EnvironmentFunctionSchedule[]>;
  insertDueRuns(input: Parameters<SchedulerPersistence["insertDueRuns"]>[0]): Promise<number>;
  claimRuns(input: ClaimInput): Promise<readonly ClaimedFunctionRun[]>;
  finishRun(input: FinishInput): Promise<FunctionRunState | null>;
  purgeFinishedRuns(input: PurgeInput): Promise<number>;
}

/** Invoke each RPC method on its binding; method.bind would name another remote method. */
export function createCoreSchedulerPersistence(
  binding: FunctionsSchedulerRuntimeBinding,
): SchedulerPersistence {
  return Object.freeze<SchedulerPersistence>({
    readSchedules: () => binding.readSchedules({}),
    insertDueRuns: (input) => binding.insertDueRuns(input),
    claimRuns: (input) => binding.claimRuns(input),
    finishRun: (input) => binding.finishRun(input),
    purgeFinishedRuns: (input) => binding.purgeFinishedRuns(input),
  });
}
