import type { ClaimedFunctionRun } from "@ohmyhost/database";

import {
  SCHEDULED_TIMEOUT_MILLISECONDS,
  type DispatchOutcome,
  type ScheduledDispatchPort,
} from "./dispatch.js";
import { planDueRuns } from "./scheduler.js";
import type { SchedulerPersistence } from "./persistence.js";

/** At most this many runs execute per minute tick, five at a time. */
export const TICK_CLAIM_LIMIT = 50;
export const TICK_CONCURRENCY = 5;
/** Slack after each batch's dispatch timeout for the outcome write. */
const BATCH_SLACK_MILLISECONDS = 15_000;

/**
 * The lease of each claimed run, in claim order. A run waits for the batches before it, and each batch ends within its
 * dispatch timeout plus slack, so the lease of batch k (from one) covers k batches and the slack of its own outcome.
 */
export function claimLeaseMilliseconds(limit: number): readonly number[] {
  const batch = SCHEDULED_TIMEOUT_MILLISECONDS + BATCH_SLACK_MILLISECONDS;
  return Object.freeze(
    Array.from(
      { length: limit },
      (_, index) => (Math.floor(index / TICK_CONCURRENCY) + 1) * batch + BATCH_SLACK_MILLISECONDS,
    ),
  );
}
/** Finished runs stay readable for seven days. */
export const RUN_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60_000;

export interface TickResult {
  readonly scheduledAt: string;
  readonly inserted: number;
  readonly claimed: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly failed: number;
  readonly purged: number;
}

/**
 * One scheduler minute: materialize due runs, claim leased attempts, invoke the customer
 * Worker, record each outcome and purge old evidence. Overlapping ticks coordinate through
 * the run leases, so a slow tick never duplicates an execution.
 */
export async function runSchedulerTick(input: {
  readonly persistence: SchedulerPersistence;
  readonly dispatch: ScheduledDispatchPort;
  readonly at: Date;
  readonly now?: () => Date;
}): Promise<TickResult> {
  const now = input.now ?? (() => new Date());
  const { persistence } = input;
  const tickNow = canonical(now());
  const due = await planDueRuns(await persistence.readSchedules(), input.at);
  const inserted = await persistence.insertDueRuns({ runs: due, now: tickNow });
  const claimed = await persistence.claimRuns({
    now: canonical(now()),
    limit: TICK_CLAIM_LIMIT,
    leaseMilliseconds: claimLeaseMilliseconds(TICK_CLAIM_LIMIT),
  });
  const counts = { succeeded: 0, retried: 0, failed: 0 };
  for (let index = 0; index < claimed.length; index += TICK_CONCURRENCY) {
    const batch = claimed.slice(index, index + TICK_CONCURRENCY);
    // Every run of the batch settles on its own: one run that cannot be dispatched or recorded never stops the others.
    const settled = await Promise.allSettled(
      batch.map((run) => executeRun(persistence, input.dispatch, run, now)),
    );
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        // The run's outcome was not recorded: its lease lapses and the attempt limit ends its retries.
        counts.failed += 1;
        console.error(
          "function_run_outcome_unrecorded",
          outcome.reason instanceof Error ? outcome.reason.message : "unknown",
        );
        continue;
      }
      const state = outcome.value;
      if (state === "succeeded") counts.succeeded += 1;
      else if (state === "retry") counts.retried += 1;
      else if (state === "failed") counts.failed += 1;
    }
  }
  const purged = await persistence.purgeFinishedRuns({
    before: new Date(now().getTime() - RUN_RETENTION_MILLISECONDS).toISOString(),
  });
  return Object.freeze({
    scheduledAt: due[0]?.scheduledAt ?? new Date(input.at.getTime()).toISOString(),
    inserted,
    claimed: claimed.length,
    ...counts,
    purged,
  });
}

async function executeRun(
  persistence: SchedulerPersistence,
  dispatch: ScheduledDispatchPort,
  run: ClaimedFunctionRun,
  now: () => Date,
): Promise<"succeeded" | "retry" | "failed" | null> {
  // A dispatch that throws is this run's failed attempt. The attempt limit of the run ends its retries.
  const result = await dispatch
    .execute(run)
    .catch((): DispatchOutcome => Object.freeze({ outcome: "failed", statusCode: null }));
  const state = await persistence.finishRun({
    runId: run.runId,
    attempt: run.attempt,
    outcome: result.outcome,
    statusCode: result.statusCode,
    now: canonical(now()),
  });
  console.info(
    JSON.stringify({
      event: "function_run_attempt",
      runId: run.runId,
      projectId: run.projectId,
      environmentId: run.environmentId,
      cron: run.cron,
      scheduledAt: run.scheduledAt,
      attempt: run.attempt,
      outcome: result.outcome,
      statusCode: result.statusCode,
      state,
    }),
  );
  return state;
}

function canonical(date: Date): string {
  return new Date(date.getTime()).toISOString();
}
