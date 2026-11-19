import type { EnvironmentFunctionSchedule } from "@ohmyhost/database";
import { describe, expect, it } from "vitest";

import { functionRunIdentity, planDueRuns, scheduledMinute } from "../src/scheduler.js";

const schedule: EnvironmentFunctionSchedule = {
  organizationId: "01H00000000000000000000701",
  projectId: "01H00000000000000000000702",
  environmentId: "01H00000000000000000000704",
  deploymentId: "01H00000000000000000000707",
  candidateReceiptId: "01H00000000000000000000709",
  immutableScriptName: "p-01h00000000000000000000702-dev-01h00000000000000000000707",
  crons: ["*/5 * * * *", "0 3 * * *", "15 * * * *"],
  egressAllowedOrigins: ["https://api.example.test"],
  updatedAt: "2026-09-15T02:00:00.000Z",
};

describe("functions scheduler planning", () => {
  it("materializes one run per cron that fires in the tick minute", async () => {
    const runs = await planDueRuns([schedule], new Date("2026-09-15T03:00:41.250Z"));

    expect(runs.map(({ cron, scheduledAt }) => ({ cron, scheduledAt }))).toEqual([
      { cron: "*/5 * * * *", scheduledAt: "2026-09-15T03:00:00.000Z" },
      { cron: "0 3 * * *", scheduledAt: "2026-09-15T03:00:00.000Z" },
    ]);
    expect(runs[0]).toMatchObject({
      organizationId: schedule.organizationId,
      projectId: schedule.projectId,
      environmentId: schedule.environmentId,
      deploymentId: schedule.deploymentId,
      immutableScriptName: schedule.immutableScriptName,
      egressAllowedOrigins: ["https://api.example.test"],
    });
    expect(runs[0]?.runId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(runs[0]?.runId).not.toBe(runs[1]?.runId);
  });

  it("derives the same run identity for the same environment, cron and minute", async () => {
    const first = await planDueRuns([schedule], new Date("2026-09-15T03:15:00.000Z"));
    const second = await planDueRuns([schedule], new Date("2026-09-15T03:15:59.999Z"));
    expect(first.map(({ cron }) => cron)).toEqual(["*/5 * * * *", "15 * * * *"]);
    expect(second).toEqual(first);
    expect(functionRunIdentity(schedule, "15 * * * *", "2026-09-15T03:15:00.000Z")).toBe(
      "function-run:01H00000000000000000000701:01H00000000000000000000704:15 * * * *:2026-09-15T03:15:00.000Z",
    );
    expect(scheduledMinute(new Date("2026-09-15T03:15:59.999Z"))).toBe("2026-09-15T03:15:00.000Z");
  });

  it("plans nothing for a minute without due crons or without schedules", async () => {
    await expect(planDueRuns([schedule], new Date("2026-09-15T03:01:00.000Z"))).resolves.toEqual(
      [],
    );
    await expect(planDueRuns([], new Date("2026-09-15T03:00:00.000Z"))).resolves.toEqual([]);
  });
});
