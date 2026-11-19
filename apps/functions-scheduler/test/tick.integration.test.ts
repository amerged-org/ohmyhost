import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { newUlid } from "../../control-store/src/catalog/common.js";
import { functionScheduleStatements } from "../../control-store/src/catalog/gateway/function-schedules.js";
import { gatewayFixture } from "../../control-store/test/gateway/gateway-fixture.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { createScheduledDispatch } from "../src/dispatch.js";
import { createCoreSchedulerPersistence, type SchedulerPersistence } from "../src/persistence.js";
import { runSchedulerTick } from "../src/tick.js";
import worker from "../src/worker-main.js";

const SEEDED_AT = "2026-09-15T02:00:00.000Z";

let control: TestControl;
let fixture: Awaited<ReturnType<typeof gatewayFixture>>;
let persistence: SchedulerPersistence;

class FakeDispatch {
  readonly requests: { scriptName: string; options: unknown; body: unknown }[] = [];
  readonly statuses: number[] = [];
  get(scriptName: string, _args: Record<string, never>, options: unknown) {
    return {
      fetch: async (request: Request) => {
        this.requests.push({ scriptName, options, body: await request.json() });
        return new Response(null, { status: this.statuses.shift() ?? 204 });
      },
    };
  }
}

// The real Core: one local D1 database with the checked-in migrations behind the real store.
beforeAll(async () => {
  control = await createTestControl();
  fixture = await gatewayFixture(control);
  persistence = createCoreSchedulerPersistence(fixture.store.functionsScheduler);
}, 90_000);

afterAll(async () => {
  await control?.dispose();
}, 60_000);

async function schedule(crons: readonly string[], origins: readonly string[] = []) {
  await fixture.db.batch(
    functionScheduleStatements(fixture.db, {
      ...fixture.scope,
      deploymentId: fixture.deploymentId,
      candidateReceiptId: fixture.candidateReceiptId,
      crons,
      egressAllowedOrigins: origins,
      now: SEEDED_AT,
    }),
  );
}

async function runStates(): Promise<readonly { cron: string; state: string; attempt: number }[]> {
  const result = await fixture.db
    .prepare("SELECT cron,state,attempt FROM function_runs ORDER BY scheduled_at,cron")
    .all<{ cron: string; state: string; attempt: number }>();
  return result.results;
}

describe("functions scheduler tick", () => {
  it("runs each due cron once per minute through Dynamic Dispatch and records the outcome", async () => {
    await schedule(["0 3 * * *", "*/5 * * * *"], ["https://api.example.test"]);
    const dispatchBinding = new FakeDispatch();
    const dispatch = createScheduledDispatch(dispatchBinding);
    const clock = ["2026-09-15T03:00:01.000Z", "2026-09-15T03:00:02.000Z"].map(
      (value) => new Date(value),
    );
    const now = () => clock.shift() ?? new Date("2026-09-15T03:00:09.000Z");

    const first = await runSchedulerTick({
      persistence,
      dispatch,
      at: new Date("2026-09-15T03:00:40.000Z"),
      now,
    });

    expect(first).toEqual({
      scheduledAt: "2026-09-15T03:00:00.000Z",
      inserted: 2,
      claimed: 2,
      succeeded: 2,
      retried: 0,
      failed: 0,
      purged: 0,
    });
    expect(dispatchBinding.requests).toHaveLength(2);
    // Claim order follows the hash-derived run ids, so the request is picked by its cron.
    expect(
      dispatchBinding.requests.find(
        ({ body }) => (body as { cron: string }).cron === "*/5 * * * *",
      ),
    ).toEqual({
      scriptName: fixture.script,
      options: {
        limits: { cpuMs: 50, subRequests: 10 },
        outbound: {
          EGRESS_CONTEXT: {
            version: 1,
            projectId: fixture.scope.projectId,
            allowedOrigins: ["https://api.example.test"],
          },
        },
      },
      body: {
        cron: "*/5 * * * *",
        scheduledTime: Date.UTC(2026, 8, 15, 3, 0, 0),
        immutableScriptName: fixture.script,
      },
    });
    await expect(runStates()).resolves.toEqual([
      { cron: "*/5 * * * *", state: "succeeded", attempt: 1 },
      { cron: "0 3 * * *", state: "succeeded", attempt: 1 },
    ]);

    const replay = await runSchedulerTick({
      persistence,
      dispatch,
      at: new Date("2026-09-15T03:00:59.000Z"),
      now: () => new Date("2026-09-15T03:00:59.500Z"),
    });
    expect(replay).toMatchObject({ inserted: 0, claimed: 0, succeeded: 0 });
    expect(dispatchBinding.requests).toHaveLength(2);

    const quiet = await runSchedulerTick({
      persistence,
      dispatch,
      at: new Date("2026-09-15T03:01:00.000Z"),
      now: () => new Date("2026-09-15T03:01:00.500Z"),
    });
    expect(quiet).toMatchObject({ scheduledAt: "2026-09-15T03:01:00.000Z", inserted: 0 });
  });

  it("retries provider failures up to three attempts, fails a refused invocation at once and purges old evidence", async () => {
    await schedule(["30 3 * * *", "45 3 * * *"]);
    const dispatchBinding = new FakeDispatch();
    dispatchBinding.statuses.push(500, 503, 500);
    const dispatch = createScheduledDispatch(dispatchBinding);
    const tick = (at: string) =>
      runSchedulerTick({ persistence, dispatch, at: new Date(at), now: () => new Date(at) });

    await expect(tick("2026-09-15T03:30:00.000Z")).resolves.toMatchObject({
      inserted: 1,
      claimed: 1,
      retried: 1,
    });
    await expect(tick("2026-09-15T03:31:00.000Z")).resolves.toMatchObject({
      inserted: 0,
      claimed: 1,
      retried: 1,
    });
    await expect(tick("2026-09-15T03:32:00.000Z")).resolves.toMatchObject({
      claimed: 1,
      failed: 1,
    });
    await expect(tick("2026-09-15T03:33:00.000Z")).resolves.toMatchObject({ claimed: 0 });
    expect(dispatchBinding.requests.map(({ body }) => body)).toHaveLength(3);

    dispatchBinding.statuses.push(400);
    await expect(tick("2026-09-15T03:45:00.000Z")).resolves.toMatchObject({
      inserted: 1,
      claimed: 1,
      failed: 1,
      retried: 0,
    });
    await expect(runStates()).resolves.toEqual(
      expect.arrayContaining([
        { cron: "30 3 * * *", state: "failed", attempt: 3 },
        { cron: "45 3 * * *", state: "failed", attempt: 1 },
      ]),
    );

    // A persisted run with a foreign script is terminally rejected without stopping its peer.
    const badRun = newUlid();
    const goodRun = newUlid();
    const scheduledAt = "2026-09-15T04:00:00.000Z";
    await schedule(["0 4 * * *", "*/5 * * * *"]);
    const due = {
      ...fixture.scope,
      deploymentId: fixture.deploymentId,
      scheduledAt,
      egressAllowedOrigins: [],
    };
    await persistence.insertDueRuns({
      runs: [
        {
          ...due,
          runId: badRun,
          immutableScriptName: `p-${newUlid().toLowerCase()}-dev-${fixture.deploymentId.toLowerCase()}`,
          cron: "0 4 * * *",
        },
        { ...due, runId: goodRun, immutableScriptName: fixture.script, cron: "*/5 * * * *" },
      ],
      now: scheduledAt,
    });
    const earlierRequests = dispatchBinding.requests.length;
    await expect(tick(scheduledAt)).resolves.toMatchObject({
      inserted: 0,
      claimed: 2,
      succeeded: 1,
      failed: 1,
      retried: 0,
    });
    expect(dispatchBinding.requests.slice(earlierRequests)).toHaveLength(1);
    expect(dispatchBinding.requests.at(-1)?.scriptName).toBe(fixture.script);
    expect(
      (
        await fixture.db
          .prepare(
            "SELECT run_id,state,attempt,status_code FROM function_runs WHERE run_id IN (?1,?2) ORDER BY run_id",
          )
          .bind(badRun, goodRun)
          .all()
      ).results.sort((left, right) =>
        String(left["run_id"]).localeCompare(String(right["run_id"])),
      ),
    ).toEqual(
      [
        { run_id: badRun, state: "failed", attempt: 1, status_code: 400 },
        { run_id: goodRun, state: "succeeded", attempt: 1, status_code: 204 },
      ].sort((left, right) => left.run_id.localeCompare(right.run_id)),
    );
    await expect(tick("2026-09-15T04:01:00.000Z")).resolves.toMatchObject({ claimed: 0 });
    await schedule(["30 3 * * *", "45 3 * * *"]);

    await expect(tick("2026-09-23T04:00:00.000Z")).resolves.toMatchObject({ purged: 6 });
    await expect(runStates()).resolves.toEqual([]);
  });

  it("serves the Worker entrypoint from the exact bindings", async () => {
    await schedule(["0 5 * * *"]);
    const dispatchBinding = new FakeDispatch();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    // The Worker reads the wall clock: the cron fires one second after its occurrence, so the run is not overdue.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 15, 5, 0, 1));
    try {
      await expect(
        worker.scheduled(
          { scheduledTime: Date.UTC(2026, 8, 15, 5, 0, 0) },
          {
            RUNTIME_CONFIGURATION_STATE: "configured",
            CONTROL_FUNCTIONS_RUNTIME: fixture.store.functionsScheduler,
            CUSTOMER_DISPATCH: dispatchBinding,
          },
        ),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(dispatchBinding.requests.map(({ body }) => body)).toEqual([
      {
        cron: "0 5 * * *",
        scheduledTime: Date.UTC(2026, 8, 15, 5, 0, 0),
        immutableScriptName: fixture.script,
      },
    ]);
    expect(info.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual([
      "function_run_attempt",
      "functions_scheduler_tick",
    ]);
    info.mockRestore();
    await expect(
      worker.scheduled({ scheduledTime: 0 }, { RUNTIME_CONFIGURATION_STATE: "disabled" }),
    ).rejects.toThrow("not configured");
    const response = await worker.fetch();
    expect(response.status).toBe(404);
  });
});
