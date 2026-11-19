import { expect, it, vi } from "vitest";
import type { DueFunctionRun } from "@ohmyhost/database";
import { claimLeaseMilliseconds, runSchedulerTick } from "../../functions-scheduler/src/tick.js";
import { createCoreSchedulerPersistence } from "../../functions-scheduler/src/persistence.js";
import { planDueRuns } from "../../functions-scheduler/src/scheduler.js";
import type { ScheduledDispatchPort } from "../../functions-scheduler/src/dispatch.js";
import type { D1Database } from "../src/d1-types.js";
import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { functionScheduleStatements } from "../src/catalog/gateway/function-schedules.js";
import { runChargeOrg, setProjectBudget } from "../src/catalog/credit/index.js";
import { createTestControl, losingNthResponse } from "./support/control-d1.js";
import { gatewayFixture } from "./gateway/gateway-fixture.js";
import { credits } from "./credit/support.js";
import { seedProject } from "./support/platform-fixtures.js";

const now = "2026-10-29T00:00:00.000Z";
function scheduled(r: Awaited<ReturnType<typeof gatewayFixture>>) {
  return {
    ...r.scope,
    deploymentId: r.deploymentId,
    candidateReceiptId: r.candidateReceiptId,
    crons: ["0 3 * * *", "*/5 * * * *"],
    egressAllowedOrigins: [
      "https://z.example.test",
      "https://a.example.test",
      "https://a.example.test",
    ],
    now,
  };
}
function due(
  r: Awaited<ReturnType<typeof gatewayFixture>>,
  time: string,
  cron = "0 4 * * *",
): DueFunctionRun {
  return {
    ...r.scope,
    runId: newUlid(),
    deploymentId: r.deploymentId,
    immutableScriptName: r.script,
    cron,
    scheduledAt: time,
    egressAllowedOrigins: [],
  };
}

it("reads normalized schedules and runs real ticks with retries, lease boundaries, stale completion and retention on the Core", async () => {
  const c = await createTestControl();
  try {
    const r = await gatewayFixture(c);
    await r.db.batch(functionScheduleStatements(r.db, scheduled(r)));
    const core = createCoreSchedulerPersistence(r.store.functionsScheduler);
    expect(await core.readSchedules()).toEqual([
      {
        ...r.scope,
        deploymentId: r.deploymentId,
        candidateReceiptId: r.candidateReceiptId,
        immutableScriptName: r.script,
        crons: ["*/5 * * * *", "0 3 * * *"],
        egressAllowedOrigins: [
          "https://a.example.test",
          "https://a.example.test",
          "https://z.example.test",
        ],
        updatedAt: now,
      },
    ]);
    const dispatch: ScheduledDispatchPort = {
      execute: async (run) =>
        run.cron === "0 3 * * *"
          ? { outcome: "failed", statusCode: 500 }
          : { outcome: "succeeded", statusCode: 204 },
    };
    const tick = (minute: string) => {
      const at = new Date(`2026-10-29T${minute}:00.000Z`);
      return runSchedulerTick({ persistence: core, dispatch, at, now: () => at });
    };
    expect(await tick("03:00")).toEqual({
      scheduledAt: "2026-10-29T03:00:00.000Z",
      inserted: 2,
      claimed: 2,
      succeeded: 1,
      retried: 1,
      failed: 0,
      purged: 0,
    });
    expect(await tick("03:01")).toMatchObject({ inserted: 0, claimed: 1, retried: 1, failed: 0 });
    expect(await tick("03:02")).toMatchObject({ inserted: 0, claimed: 1, retried: 0, failed: 1 });
    expect(await tick("03:03")).toMatchObject({ inserted: 0, claimed: 0, retried: 0, failed: 0 });
    // A replayed tick inside a minute that was already inserted creates nothing new.
    const replayAt = new Date("2026-10-29T03:00:59.000Z");
    expect(
      await runSchedulerTick({ persistence: core, dispatch, at: replayAt, now: () => replayAt }),
    ).toMatchObject({ inserted: 0, claimed: 0 });
    const run = due(r, "2026-10-29T04:00:00.000Z");
    expect(await core.insertDueRuns({ runs: [run], now })).toBe(1);
    // The lease is 150 s; it expires exclusively after its boundary and every expiry starts the next attempt.
    for (const [time, count, attempt, leaseUntil] of [
      ["04:00:00.000", 1, 1, "2026-10-29T04:02:30.000Z"],
      ["04:02:30.000", 0, 0, ""],
      ["04:02:30.001", 1, 2, "2026-10-29T04:05:00.001Z"],
      ["04:05:00.002", 1, 3, "2026-10-29T04:07:30.002Z"],
      ["04:07:30.003", 0, 0, ""],
    ] as const) {
      const input = { now: `2026-10-29T${time}Z`, limit: 10 };
      const claimed = await core.claimRuns(input);
      expect(claimed).toHaveLength(count);
      if (count) expect(claimed[0]).toMatchObject({ attempt, leaseUntil, runId: run.runId });
      if (attempt === 2)
        expect(
          await core.finishRun({
            runId: run.runId,
            attempt: 1,
            outcome: "succeeded",
            statusCode: 204,
            now: input.now,
          }),
        ).toBeNull();
    }
    const finished = async () =>
      (
        await c.core
          .prepare(
            "SELECT cron,state,attempt,lease_until,started_at,finished_at,status_code,updated_at FROM function_runs ORDER BY scheduled_at,cron",
          )
          .all()
      ).results;
    expect(await finished()).toEqual([
      {
        cron: "*/5 * * * *",
        state: "succeeded",
        attempt: 1,
        lease_until: null,
        started_at: "2026-10-29T03:00:00.000000Z",
        finished_at: "2026-10-29T03:00:00.000000Z",
        status_code: 204,
        updated_at: "2026-10-29T03:00:00.000000Z",
      },
      {
        cron: "0 3 * * *",
        state: "failed",
        attempt: 3,
        lease_until: null,
        started_at: "2026-10-29T03:00:00.000000Z",
        finished_at: "2026-10-29T03:02:00.000000Z",
        status_code: 500,
        updated_at: "2026-10-29T03:02:00.000000Z",
      },
      {
        cron: "0 4 * * *",
        state: "failed",
        attempt: 3,
        lease_until: null,
        started_at: "2026-10-29T04:00:00.000000Z",
        finished_at: "2026-10-29T04:07:30.003000Z",
        status_code: null,
        updated_at: "2026-10-29T04:07:30.003000Z",
      },
    ]);
    expect(await core.purgeFinishedRuns({ before: "2026-11-06T00:00:00.000Z" })).toBe(3);
    expect(await finished()).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 120000);

it("keeps whole-batch rollback and exclusive claims, refuses ambiguous attempts and never re-decides an uncertain lease", async () => {
  const c = await createTestControl();
  try {
    const r = await gatewayFixture(c),
      port = createCoreSchedulerPersistence(r.store.functionsScheduler);
    await r.db.batch(functionScheduleStatements(r.db, scheduled(r)));
    const runs = await planDueRuns(
      await port.readSchedules(),
      new Date("2026-10-29T03:00:00.000Z"),
    );
    const [firstDue, secondDue] = runs;
    if (!firstDue || !secondDue) throw new Error("Missing fixture due runs");
    // Original function_runs intentionally has no environment FK; use its genuine global run-id collision.
    const bad = { ...secondDue, runId: firstDue.runId };
    await expect(port.insertDueRuns({ runs: [firstDue, bad], now })).rejects.toThrow();
    expect(await c.core.prepare("SELECT count(*) n FROM function_runs").first()).toEqual({ n: 0 });
    await expect(
      port.insertDueRuns({
        runs: [{ ...firstDue, egressAllowedOrigins: ["http://bad.test"] }],
        now,
      }),
    ).rejects.toThrow("Egress");
    await expect(
      port.insertDueRuns({ runs: [{ ...firstDue, cron: "* * * * *" }], now }),
    ).rejects.toThrow();
    expect(await port.insertDueRuns({ runs: [], now })).toBe(0);
    expect(await port.insertDueRuns({ runs, now })).toBe(2);
    expect(await port.insertDueRuns({ runs, now })).toBe(0);
    const time = "2026-10-29T03:00:01.000Z";
    const [a, b] = await Promise.all([
      port.claimRuns({ now: time, limit: 1 }),
      port.claimRuns({ now: time, limit: 1 }),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.runId).not.toBe(b[0]?.runId);
    const first = a[0];
    if (!first) throw new Error("Missing claimed fixture run");
    expect(
      await port.finishRun({
        runId: first.runId,
        attempt: first.attempt,
        outcome: "rejected",
        statusCode: 400,
        now: time,
      }),
    ).toBe("failed");
    await expect(
      port.finishRun({
        runId: first.runId,
        attempt: 1,
        outcome: "succeeded",
        statusCode: 99,
        now: time,
      }),
    ).rejects.toThrow();
    await expect(port.claimRuns({ now: time, limit: 0 })).rejects.toThrow();
    await expect(
      port.insertDueRuns({ runs: [], now: "2026-10-29T00:00:00.000000Z" }),
    ).rejects.toThrow();
    await r.db.batch(functionScheduleStatements(r.db, { ...scheduled(r), crons: ["0 4 * * *"] }));
    let dispatched = 0;
    const at = new Date("2026-10-29T04:00:00.000Z");
    const tickLosing = (nth: number) =>
      runSchedulerTick({
        persistence: createCoreSchedulerPersistence(
          createControlStore({ CONTROL_CORE: losingNthResponse(c.core, nth) }).functionsScheduler,
        ),
        dispatch: {
          execute: async () => {
            dispatched++;
            return { outcome: "succeeded", statusCode: 204 };
          },
        },
        at,
        now: () => at,
      });
    const openRun = () =>
      c.core.prepare("SELECT attempt,state FROM function_runs WHERE cron='0 4 * * *'").all();
    // The serving decision is read before the claim is written: a lost decision fails closed, nothing is leased.
    await expect(tickLosing(2)).rejects.toThrow("Network connection lost");
    expect(dispatched).toBe(0);
    expect((await openRun()).results).toEqual([{ attempt: 0, state: "due" }]);
    // The lost reply of the claim write itself is an unknown outcome, which never decides another lease.
    await expect(tickLosing(3)).rejects.toThrow("store_outcome_unknown");
    expect(dispatched).toBe(0);
    expect((await openRun()).results).toEqual([{ attempt: 1, state: "running" }]);
    expect(await port.claimRuns({ now: at.toISOString(), limit: 10 })).toHaveLength(0);
    expect(await port.purgeFinishedRuns({ before: now })).toBe(0);
    const uncertainRun = due(r, "2026-10-29T07:00:00.000Z", "20 4 * * *");
    const uncertainInsert = createCoreSchedulerPersistence(
      createControlStore({ CONTROL_CORE: losingNthResponse(c.core, 1) }).functionsScheduler,
    );
    await expect(uncertainInsert.insertDueRuns({ runs: [uncertainRun], now })).rejects.toThrow(
      "store_outcome_unknown",
    );
    expect(await port.insertDueRuns({ runs: [uncertainRun], now })).toBe(0);
    const beforeFence = (await c.core.prepare("SELECT * FROM function_runs ORDER BY run_id").all())
      .results;
    await c.core
      .prepare(
        "INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES(0,'moving',?1,'2026-10-29T00:00:00.000000Z')",
      )
      .bind(newUlid())
      .run();
    for (const action of [
      () => port.insertDueRuns({ runs: [due(r, "2026-10-29T08:00:00.000Z")], now }),
      () => port.claimRuns({ now: "2026-10-29T08:00:00.000Z", limit: 10 }),
      () =>
        port.finishRun({
          runId: first.runId,
          attempt: 1,
          outcome: "succeeded",
          statusCode: 204,
          now,
        }),
      () => port.purgeFinishedRuns({ before: "2026-11-29T00:00:00.000Z" }),
    ])
      await expect(action()).rejects.toThrow();
    expect(
      (await c.core.prepare("SELECT * FROM function_runs ORDER BY run_id").all()).results,
    ).toEqual(beforeFence);
    await c.core.prepare("DELETE FROM bucket_fences").run();
    // Imported rows may hold array-valued origins whose contents the executor cannot use. A decoding
    // failure must also roll back the expired-attempt finalization of the same claim batch.
    const malformed = due(r, "2026-10-29T05:00:00.000Z", "15 4 * * *");
    await port.insertDueRuns({ runs: [malformed], now });
    await c.core.batch([
      c.core
        .prepare("UPDATE function_runs SET egress_allowed_origins='[null]' WHERE run_id=?")
        .bind(malformed.runId),
      c.core
        .prepare(
          "UPDATE function_runs SET state='running',attempt=3,lease_until='2026-10-29T03:00:00.000000Z',finished_at=NULL WHERE run_id=?",
        )
        .bind(first.runId),
    ]);
    await expect(port.claimRuns({ now: "2026-10-29T06:00:00.000Z", limit: 10 })).rejects.toThrow();
    expect(
      await c.core
        .prepare("SELECT state,attempt FROM function_runs WHERE run_id=?")
        .bind(first.runId)
        .first(),
    ).toEqual({ state: "running", attempt: 3 });
    const unactivated = await createTestControl(2, { activated: false });
    try {
      await expect(
        createControlStore(unactivated.bindings).functionsScheduler.readSchedules({}),
      ).rejects.toThrow("activation");
    } finally {
      await unactivated.dispose();
    }
  } finally {
    await c.dispose();
  }
}, 120000);

/** A due run of an environment that needs no deployment fixture: the claim never reads the deployment. */
let distinctCrons = 0;
/** A distinct valid cron per call: the open-run guard queues one occurrence per cron, so a backlog needs its own crons. */
function distinctCron(): string {
  distinctCrons += 1;
  return `${distinctCrons % 60} ${Math.floor(distinctCrons / 60) % 24} * * *`;
}
function runOf(
  scope: { organizationId: string; projectId: string; environmentId: string },
  scheduledAt: string,
): DueFunctionRun {
  return {
    ...scope,
    runId: newUlid(),
    deploymentId: newUlid(),
    immutableScriptName: `p-${scope.projectId.toLowerCase()}-prod-${newUlid().toLowerCase()}`,
    cron: distinctCron(),
    scheduledAt,
    egressAllowedOrigins: [],
  };
}

/** A second, active project in an existing organization, so one organization holds a paused and a live environment. */
async function addProject(db: D1Database, organizationId: string) {
  const projectId = newUlid(),
    environmentId = newUlid(),
    epochId = newUlid(),
    at = "2026-10-28T10:00:00.000000Z";
  await db.batch([
    db
      .prepare(
        "INSERT INTO projects(organization_id, project_id, created_organization_id, name, created_event_id, handle, handle_version, handle_attempt, lifecycle_state, lifecycle_version, owner_state, ownership_version, active_billing_epoch_id, data_mode, region, dev_access_mode, created_at, updated_at) VALUES (?1, ?2, ?1, 'Sibling', ?3, ?4, 'customer-chosen-v1', 0, 'active', 1, 'active', 1, ?5, 'shared', 'eu', 'protected', ?6, ?6)",
      )
      .bind(
        organizationId,
        projectId,
        newUlid(),
        `sibling-${projectId.toLowerCase()}`,
        epochId,
        at,
      ),
    db
      .prepare(
        "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, 'user:fixture')",
      )
      .bind(organizationId, epochId, projectId, at),
    db
      .prepare(
        "INSERT INTO environments(organization_id, environment_id, project_id, name, desired_state, head_version, dev_access_epoch, created_at, updated_at) VALUES (?1, ?2, ?3, 'prod', '{}', 0, 1, ?4, ?4)",
      )
      .bind(organizationId, environmentId, projectId, at),
  ]);
  return { organizationId, projectId, environmentId };
}

it("shares one tick's claim between organizations instead of serving the oldest backlog first", async () => {
  const c = await createTestControl();
  try {
    const port = createCoreSchedulerPersistence(createControlStore(c.bindings).functionsScheduler);
    const noisy = await seedProject(c),
      quiet = await seedProject(c);
    const scope = (p: typeof noisy) => ({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.prodEnvironmentId,
    });
    // The noisy tenant holds 22 older runs, the quiet one a single newer run.
    const backlog = Array.from({ length: 22 }, (_, minute) =>
      runOf(scope(noisy), `2026-10-29T03:${String(minute).padStart(2, "0")}:00.000Z`),
    );
    const single = runOf(scope(quiet), "2026-10-29T03:30:00.000Z");
    const ids = (runs: readonly { runId: string }[]) => runs.map((run) => run.runId);
    const time = "2026-10-29T03:31:00.000Z";
    expect(await port.insertDueRuns({ runs: backlog, now })).toBe(22);
    // Alone, a tenant is served oldest first up to the whole limit.
    expect(ids(await port.claimRuns({ now: time, limit: 10 }))).toEqual(ids(backlog.slice(0, 10)));
    expect(await port.insertDueRuns({ runs: [single], now })).toBe(1);
    // With a second tenant, its single run comes after the noisy tenant's first run but before its second.
    expect(ids(await port.claimRuns({ now: time, limit: 10 }))).toEqual([
      backlog[10]?.runId,
      single.runId,
      ...ids(backlog.slice(11, 19)),
    ]);
    expect(ids(await port.claimRuns({ now: time, limit: 10 }))).toEqual(ids(backlog.slice(19)));
  } finally {
    await c.dispose();
  }
}, 120000);

it("pauses crons exactly where the shared gateway pauses HTTP, never lets paused runs crowd out live ones and resumes without catching up", async () => {
  const c = await createTestControl();
  try {
    const port = createCoreSchedulerPersistence(createControlStore(c.bindings).functionsScheduler);
    const stopped = await gatewayFixture(c),
      broke = await seedProject(c),
      frozen = await seedProject(c),
      live = await seedProject(c);
    const scope = (p: typeof broke) => ({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.prodEnvironmentId,
    });
    const month = "2026-11-02T10:00:00.000Z";
    // A reached Stop budget, credit used up past the 7-day grace and a security freeze all pause HTTP.
    await c.core.batch(
      setProjectBudget(c.core, {
        organizationId: stopped.scope.organizationId,
        projectId: stopped.scope.projectId,
        budgetMicros: credits(10),
        mode: "stop",
        now: month,
      }).statements,
    );
    await runChargeOrg(c.core, {
      organizationId: stopped.scope.organizationId,
      key: "cron-stop",
      amountMicros: credits(10),
      now: month,
      projects: [{ projectId: stopped.scope.projectId, amountMicros: credits(10) }],
    });
    await runChargeOrg(c.core, {
      organizationId: broke.organizationId,
      key: "cron-drain",
      amountMicros: credits(200),
      now: month,
    });
    await c.core
      .prepare("UPDATE projects SET owner_state='security_frozen' WHERE project_id=?")
      .bind(frozen.projectId)
      .run();
    // The stopped project keeps a cron schedule and more open runs than one claim returns.
    await c.core.batch(
      functionScheduleStatements(c.core, { ...scheduled(stopped), crons: ["*/5 * * * *"] }),
    );
    const backlog = Array.from({ length: 12 }, (_, minute) =>
      runOf(stopped.scope, `2026-11-09T09:${String(minute).padStart(2, "0")}:00.000Z`),
    );
    const others = [broke, frozen, live].map((p) => runOf(scope(p), "2026-11-09T09:30:00.000Z"));
    expect(await port.insertDueRuns({ runs: [...backlog, ...others], now })).toBe(15);
    await c.core
      .prepare("UPDATE function_runs SET state='retry',attempt=1 WHERE run_id=?")
      .bind(backlog[0]?.runId)
      .run();
    const dispatched: string[] = [];
    const dispatch: ScheduledDispatchPort = {
      execute: async (run) => {
        dispatched.push(run.runId);
        return { outcome: "succeeded", statusCode: 204 };
      },
    };
    const tick = (time: string) => {
      const at = new Date(time);
      return runSchedulerTick({ persistence: port, dispatch, at, now: () => at });
    };
    // The cron fires once more at 10:00 while paused; that run ends with the rest of the environment.
    expect(await tick("2026-11-09T10:00:00.000Z")).toMatchObject({
      inserted: 1,
      claimed: 1,
      succeeded: 1,
    });
    expect(dispatched).toEqual([others[2]?.runId]);
    const rows = async (organizationId: string) =>
      (
        await c.core
          .prepare(
            "SELECT state,attempt,status_code,lease_until,finished_at IS NOT NULL AS finished FROM function_runs WHERE organization_id=? ORDER BY scheduled_at",
          )
          .bind(organizationId)
          .all()
      ).results;
    // A paused run is failed with the gateway's status, finished and unleased; its attempt count stays.
    const paused = (statusCode: number, attempt = 0) => ({
      state: "failed",
      attempt,
      status_code: statusCode,
      lease_until: null,
      finished: 1,
    });
    // Every open run of the paused environment ends in the same tick, so none waits to burst later.
    expect(await rows(stopped.scope.organizationId)).toEqual([
      paused(402, 1),
      ...Array.from({ length: 12 }, () => paused(402)),
    ]);
    expect(await rows(broke.organizationId)).toEqual([paused(402)]);
    expect(await rows(frozen.organizationId)).toEqual([paused(404)]);
    expect(await rows(live.organizationId)).toMatchObject([{ state: "succeeded", attempt: 1 }]);
    // The schedule stays, so the cron resumes at its next occurrence after the Stop budget is raised.
    await c.core.batch(
      setProjectBudget(c.core, {
        organizationId: stopped.scope.organizationId,
        projectId: stopped.scope.projectId,
        budgetMicros: null,
        mode: "continue",
        now: month,
      }).statements,
    );
    dispatched.length = 0;
    expect(await tick("2026-11-09T10:05:00.000Z")).toMatchObject({ inserted: 1, claimed: 1 });
    expect(dispatched).toHaveLength(1);
    expect(await tick("2026-11-09T10:06:00.000Z")).toMatchObject({ inserted: 0, claimed: 0 });
    // Exactly one run after the resume: the 13 paused runs stay failed and nothing was caught up.
    expect(
      (
        await c.core
          .prepare(
            "SELECT state,attempt,scheduled_at FROM function_runs WHERE environment_id=? AND state<>'failed'",
          )
          .bind(stopped.scope.environmentId)
          .all()
      ).results,
    ).toEqual([{ state: "succeeded", attempt: 1, scheduled_at: "2026-11-09T10:05:00.000000Z" }]);
    expect(await rows(stopped.scope.organizationId)).toHaveLength(14);
    // Pausing one environment leaves another environment of the same organization alone: the frozen project's
    // organization also holds a live project. Its run is open but outside this claim's single lease.
    const sibling = await addProject(c.core, frozen.organizationId);
    const frozenRuns = Array.from({ length: 3 }, (_, minute) =>
      runOf(scope(frozen), `2026-11-09T10:0${minute}:00.000Z`),
    );
    const siblingRun = runOf(sibling, "2026-11-09T10:09:00.000Z");
    const liveRun = runOf(scope(live), "2026-11-09T10:09:30.000Z");
    expect(await port.insertDueRuns({ runs: [...frozenRuns, siblingRun, liveRun], now })).toBe(5);
    const claimedOne = await port.claimRuns({ now: "2026-11-09T10:10:00.000Z", limit: 1 });
    expect(claimedOne.map((run) => run.runId)).toEqual([liveRun.runId]);
    const environmentRows = async (environmentId: string) =>
      (
        await c.core
          .prepare(
            "SELECT state,attempt,status_code,finished_at IS NOT NULL AS finished FROM function_runs WHERE environment_id=? ORDER BY scheduled_at",
          )
          .bind(environmentId)
          .all()
      ).results;
    expect(await environmentRows(sibling.environmentId)).toEqual([
      { state: "due", attempt: 0, status_code: null, finished: 0 },
    ]);
    expect(
      (await environmentRows(frozen.prodEnvironmentId)).filter((row) => row["finished"] === 1),
    ).toHaveLength(4);
    expect(
      (await port.claimRuns({ now: "2026-11-09T10:10:00.000Z", limit: 10 })).map(
        (run) => run.runId,
      ),
    ).toEqual([siblingRun.runId]);
    // Twelve paused organizations with older runs than a live organization's must not crowd it out of the tick.
    const hogs = [];
    for (let index = 0; index < 12; index++) hogs.push(await seedProject(c));
    await c.core
      .prepare(
        `UPDATE projects SET owner_state='security_frozen' WHERE project_id IN (${hogs.map(() => "?").join(",")})`,
      )
      .bind(...hogs.map((hog) => hog.projectId))
      .run();
    const hogRuns = hogs.flatMap((hog) => [
      runOf(scope(hog), "2026-11-09T10:07:00.000Z"),
      runOf(scope(hog), "2026-11-09T10:08:00.000Z"),
    ]);
    const nextLive = runOf(scope(live), "2026-11-09T10:10:30.000Z");
    expect(await port.insertDueRuns({ runs: [...hogRuns, nextLive], now })).toBe(25);
    dispatched.length = 0;
    expect(await tick("2026-11-09T10:11:00.000Z")).toMatchObject({ inserted: 0, claimed: 1 });
    expect(dispatched).toEqual([nextLive.runId]);
    expect(
      (
        await c.core
          .prepare(
            `SELECT state,status_code,count(*) n FROM function_runs WHERE organization_id IN (${hogs.map(() => "?").join(",")}) GROUP BY state,status_code`,
          )
          .bind(...hogs.map((hog) => hog.organizationId))
          .all()
      ).results,
    ).toEqual([{ state: "failed", status_code: 404, n: 24 }]);
  } finally {
    await c.dispose();
  }
}, 120000);

it("keeps one tenant's dispatch failure from aborting the tick for the runs of other tenants behind it", async () => {
  const c = await createTestControl();
  try {
    const port = createCoreSchedulerPersistence(createControlStore(c.bindings).functionsScheduler);
    const scope = (p: Awaited<ReturnType<typeof seedProject>>) => ({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.prodEnvironmentId,
    });
    // The poisoned tenant's run is the oldest. Four other tenants fill the first batch of five; the healthy run waits in the second.
    const poisoned = await seedProject(c);
    const others = [
      await seedProject(c),
      await seedProject(c),
      await seedProject(c),
      await seedProject(c),
    ];
    const healthy = await seedProject(c);
    const poisonRun = runOf(scope(poisoned), "2026-10-29T03:00:00.000Z");
    const otherRuns = others.map((p, index) =>
      runOf(scope(p), `2026-10-29T03:00:0${index + 1}.000Z`),
    );
    const healthyRun = runOf(scope(healthy), "2026-10-29T03:00:05.000Z");
    expect(await port.insertDueRuns({ runs: [poisonRun, ...otherRuns, healthyRun], now })).toBe(6);
    const executed: string[] = [];
    const dispatch: ScheduledDispatchPort = {
      execute: async (run) => {
        // The poisoned tenant's immutable script cannot be resolved, so its dispatch throws before any request.
        if (run.runId === poisonRun.runId) throw new Error("script not found");
        executed.push(run.runId);
        return { outcome: "succeeded", statusCode: 204 };
      },
    };
    const at = "2026-10-29T03:01:00.000Z";
    await expect(
      runSchedulerTick({ persistence: port, dispatch, at: new Date(at), now: () => new Date(at) }),
    ).resolves.toMatchObject({ claimed: 6, succeeded: 5, retried: 1, failed: 0 });
    expect(executed).toContain(healthyRun.runId);
    expect(executed).toHaveLength(5);
  } finally {
    await c.dispose();
  }
}, 120000);

it("counts a run whose outcome cannot be recorded as failed and logs it, without stopping the other runs of its batch", async () => {
  const c = await createTestControl();
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const port = createCoreSchedulerPersistence(createControlStore(c.bindings).functionsScheduler);
    const scope = (p: Awaited<ReturnType<typeof seedProject>>) => ({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.prodEnvironmentId,
    });
    const unrecorded = await seedProject(c),
      recorded = await seedProject(c);
    const unrecordedRun = runOf(scope(unrecorded), "2026-10-29T03:00:00.000Z");
    const recordedRun = runOf(scope(recorded), "2026-10-29T03:00:01.000Z");
    expect(await port.insertDueRuns({ runs: [unrecordedRun, recordedRun], now })).toBe(2);
    const failing = {
      ...port,
      finishRun: async (input: Parameters<typeof port.finishRun>[0]) => {
        if (input.runId === unrecordedRun.runId) throw new Error("store unavailable");
        return port.finishRun(input);
      },
    };
    const dispatch: ScheduledDispatchPort = {
      execute: async () => ({ outcome: "succeeded", statusCode: 204 }),
    };
    const at = "2026-10-29T03:01:00.000Z";
    await expect(
      runSchedulerTick({
        persistence: failing,
        dispatch,
        at: new Date(at),
        now: () => new Date(at),
      }),
    ).resolves.toMatchObject({ claimed: 2, succeeded: 1, failed: 1 });
    expect(errors).toHaveBeenCalledWith("function_run_outcome_unrecorded", "store unavailable");
  } finally {
    errors.mockRestore();
    await c.dispose();
  }
}, 120000);

it("never queues a second occurrence of a cron while its earlier run is still open", async () => {
  const c = await createTestControl();
  try {
    const port = createCoreSchedulerPersistence(createControlStore(c.bindings).functionsScheduler);
    const p = await seedProject(c);
    const scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.prodEnvironmentId,
    };
    const open = { ...runOf(scope, "2026-10-29T03:00:00.000Z"), cron: "*/5 * * * *" };
    const next = { ...runOf(scope, "2026-10-29T03:01:00.000Z"), cron: "*/5 * * * *" };
    expect(await port.insertDueRuns({ runs: [open], now })).toBe(1);
    // The earlier occurrence is still due: the next minute's occurrence of the same cron is not queued behind it.
    expect(await port.insertDueRuns({ runs: [next], now: "2026-10-29T03:01:00.000Z" })).toBe(0);
    const rows = await c.core
      .prepare(
        "SELECT run_id,state FROM function_runs WHERE organization_id=?1 AND cron=?2 ORDER BY scheduled_at",
      )
      .bind(p.organizationId, "*/5 * * * *")
      .all<{ run_id: string; state: string }>();
    expect(rows.results).toEqual([{ run_id: open.runId, state: "due" }]);
  } finally {
    await c.dispose();
  }
}, 120000);

it("leases each claimed run for the batch it waits in, and a tick claims a backlog of fifty runs", async () => {
  const c = await createTestControl();
  try {
    const port = createCoreSchedulerPersistence(createControlStore(c.bindings).functionsScheduler);
    const p = await seedProject(c);
    const scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.prodEnvironmentId,
    };
    const time = "2026-10-29T03:31:00.000Z";
    const runs = Array.from({ length: 12 }, (_, minute) =>
      runOf(scope, `2026-10-29T03:${String(minute).padStart(2, "0")}:00.000Z`),
    );
    expect(await port.insertDueRuns({ runs, now })).toBe(12);
    // Runs of the second and third batch are leased until their batch can have finished.
    const claimed = await port.claimRuns({
      now: time,
      limit: 3,
      leaseMilliseconds: [150_000, 285_000, 285_000],
    });
    expect(claimed.map((run) => run.leaseUntil)).toEqual([
      "2026-10-29T03:33:30.000Z",
      "2026-10-29T03:35:45.000Z",
      "2026-10-29T03:35:45.000Z",
    ]);
    const stored = await c.core
      .prepare("SELECT lease_until FROM function_runs WHERE run_id=?1")
      .bind(claimed[2]?.runId)
      .first<{ lease_until: string }>();
    expect(stored).toEqual({ lease_until: "2026-10-29T03:35:45.000000Z" });

    // A tick takes the whole backlog of fifty, not ten, when no other tenant is waiting.
    const more = Array.from({ length: 50 }, (_, index) =>
      runOf(scope, `2026-10-29T04:${String(index % 60).padStart(2, "0")}:00.000Z`),
    );
    expect(await port.insertDueRuns({ runs: more, now })).toBe(50);
    const at = "2026-10-29T05:00:00.000Z";
    const tick = await runSchedulerTick({
      persistence: port,
      dispatch: { execute: async () => ({ outcome: "succeeded", statusCode: 204 }) },
      at: new Date(at),
      now: () => new Date(at),
    });
    expect(tick.claimed).toBe(50);
  } finally {
    await c.dispose();
  }
}, 120000);

it("sizes each run's lease from its batch: the first batch keeps the 150 s lease, the last of fifty ends after ten batches", () => {
  const leases = claimLeaseMilliseconds(50);
  expect(leases).toHaveLength(50);
  expect(leases[0]).toBe(150_000);
  expect(leases[4]).toBe(150_000);
  expect(leases[5]).toBe(285_000);
  expect(leases[49]).toBe(1_365_000);
});

it("records a due run more than an hour overdue as skipped without dispatching it, and still claims a run exactly an hour overdue", async () => {
  const c = await createTestControl();
  try {
    const port = createCoreSchedulerPersistence(createControlStore(c.bindings).functionsScheduler);
    const p = await seedProject(c);
    const scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.prodEnvironmentId,
    };
    const stale = runOf(scope, "2026-10-29T01:30:00.000Z"),
      edge = runOf(scope, "2026-10-29T02:00:00.000Z"),
      fresh = runOf(scope, "2026-10-29T02:50:00.000Z");
    expect(await port.insertDueRuns({ runs: [stale, edge, fresh], now })).toBe(3);
    const time = "2026-10-29T03:00:00.000Z";
    const claimed = await port.claimRuns({ now: time, limit: 10 });
    expect(claimed.map((run) => run.runId).sort()).toEqual([edge.runId, fresh.runId].sort());
    expect(
      await c.core
        .prepare("SELECT state,attempt,finished_at,lease_until FROM function_runs WHERE run_id=?1")
        .bind(stale.runId)
        .first(),
    ).toEqual({
      state: "skipped",
      attempt: 0,
      finished_at: "2026-10-29T03:00:00.000000Z",
      lease_until: null,
    });
  } finally {
    await c.dispose();
  }
}, 120000);
