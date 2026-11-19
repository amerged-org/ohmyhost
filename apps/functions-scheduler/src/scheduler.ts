import { isCronDue } from "@ohmyhost/contracts";
import type { DueFunctionRun, EnvironmentFunctionSchedule } from "@ohmyhost/database";

import { deterministicUlid } from "./deterministic-ulid.js";

/** The run identity preimage: one run per environment, cron and UTC minute. */
export function functionRunIdentity(
  schedule: Pick<EnvironmentFunctionSchedule, "organizationId" | "environmentId">,
  cron: string,
  scheduledAt: string,
): string {
  return `function-run:${schedule.organizationId}:${schedule.environmentId}:${cron}:${scheduledAt}`;
}

/** Truncates a tick time to the UTC minute the crons are evaluated against. */
export function scheduledMinute(at: Date): string {
  const minute = new Date(at.getTime());
  minute.setUTCSeconds(0, 0);
  return minute.toISOString();
}

/** Every (schedule, cron) that fires in the minute of `at`, as insertable runs. */
export async function planDueRuns(
  schedules: readonly EnvironmentFunctionSchedule[],
  at: Date,
): Promise<readonly DueFunctionRun[]> {
  const scheduledAt = scheduledMinute(at);
  const minute = new Date(scheduledAt);
  const runs: DueFunctionRun[] = [];
  for (const schedule of schedules) {
    for (const cron of schedule.crons) {
      if (!isCronDue(cron, minute)) continue;
      runs.push(
        Object.freeze({
          runId: await deterministicUlid(functionRunIdentity(schedule, cron, scheduledAt)),
          organizationId: schedule.organizationId,
          projectId: schedule.projectId,
          environmentId: schedule.environmentId,
          deploymentId: schedule.deploymentId,
          immutableScriptName: schedule.immutableScriptName,
          cron,
          scheduledAt,
          egressAllowedOrigins: schedule.egressAllowedOrigins,
        }),
      );
    }
  }
  return Object.freeze(runs);
}
