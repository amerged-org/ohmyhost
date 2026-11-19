import { parseUlid } from "@ohmyhost/platform";
import { assertDatabaseSchedulePage } from "@ohmyhost/contracts/database-events";
import type { DatabaseEnvironment } from "@ohmyhost/contracts/database-access";
import type { DatabaseEventOutcome, DatabaseEventRequest } from "./pgcf-database-events.js";

/** The project whose Stop budget is reached: the budget sweep of the credit service names it. */
export interface StopSchedulesRequest {
  readonly organizationId: string;
  readonly projectId: string;
}

const ENVIRONMENTS: readonly DatabaseEnvironment[] = ["dev", "prod"];

export function parseStopSchedulesRequest(input: unknown): StopSchedulesRequest {
  const fail = (): never => {
    throw new TypeError("Invalid stop schedules request");
  };
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "organizationId,projectId"
  )
    return fail();
  const { organizationId, projectId } = input as Record<"organizationId" | "projectId", unknown>;
  if (typeof organizationId !== "string" || typeof projectId !== "string") return fail();
  try {
    return { organizationId: parseUlid(organizationId), projectId: parseUlid(projectId) };
  } catch {
    return fail();
  }
}

/**
 * Disables every enabled schedule of the application's runtime role in each environment of the project. Both
 * environments may share one PGCF database, so the second listing sees the schedules that the first one disabled and
 * counts nothing twice. `events.run` keeps every rule of the database events (ownership of the role, the stored body);
 * the first refusal or failure stops the project, and the next pass resumes it.
 */
export function createPgcfScheduleStopper(events: {
  run(request: DatabaseEventRequest): Promise<DatabaseEventOutcome>;
}) {
  return async (scope: StopSchedulesRequest): Promise<{ stopped: number }> => {
    let stopped = 0;
    for (const environment of ENVIRONMENTS) {
      const listed = await events.run({ ...scope, environment, operation: "schedule.list" });
      // An environment without a database has no schedules to stop.
      if (listed.status === "absent") continue;
      if (listed.status !== "ok") throw new Error("Stop schedules: the schedule list was refused");
      assertDatabaseSchedulePage(listed.value);
      for (const item of listed.value.items) {
        if (!item.enabled) continue;
        const disabled = await events.run({
          ...scope,
          environment,
          operation: "schedule.set",
          name: item.name,
          schedule: {
            cron: item.cron,
            every_seconds: item.every_seconds,
            statements: [...item.statements],
            timeout_ms: item.timeout_ms,
            enabled: false,
          },
        });
        if (disabled.status !== "ok")
          throw new Error("Stop schedules: a schedule could not be disabled");
        stopped += 1;
      }
    }
    return { stopped };
  };
}
