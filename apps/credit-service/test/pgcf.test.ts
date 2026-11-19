import { describe, expect, it } from "vitest";
import { PGCF_MAX_HOURS, parsePgcfRollups, runPgcf } from "../src/pgcf.js";
import { world, type World } from "./doubles.js";

const H05 = "2026-10-30T05:00:00.000Z";
const H06 = "2026-10-30T06:00:00.000Z";
const H07 = "2026-10-30T07:00:00.000Z";
// One hour of 256 MiB: 10 credits.
const HOUR_OF_256_MIB = "921600000";

interface Pending {
  databaseId: string;
  hourStart: string;
}
const pending = (databaseId: string, hourStart: string): Pending => ({ databaseId, hourStart });

function ready(rollups: unknown[], notFinal: Pending[] = [], unbillableHours = 0): World {
  const w = world();
  w.core.cursors.set("pgcf", H05);
  const owner = (databaseId: string, organizationId: string, projectId: string) => ({
    databaseId,
    organizationId,
    projectId,
    environmentId: "env_prod",
  });
  w.core.pgcfOwners.set("db1", owner("db1", "org_1", "prj_1"));
  w.core.pgcfOwners.set("db2", owner("db2", "org_1", "prj_1"));
  w.core.pgcfOwners.set("db3", owner("db3", "org_2", "prj_3"));
  // Like the real collector, answer only for the requested window.
  w.neon.answer = (i) => ({
    from: i.from,
    to: i.to,
    rollups: (rollups as { hourStart: string }[]).filter(
      (row) => row.hourStart >= i.from && row.hourStart < i.to,
    ),
    pending: notFinal.filter((row) => row.hourStart >= i.from && row.hourStart < i.to),
    unbillableHours,
  });
  return w;
}
const rollup = (
  databaseId: string,
  hourStart: string,
  memoryMibMilliseconds = HOUR_OF_256_MIB,
) => ({
  databaseId,
  hourStart,
  memoryMibMilliseconds,
});
const usageRows = (w: World) => w.core.rows.filter((row) => row.kind === "usage");

describe("runPgcf", () => {
  it("bills the final hours per organization, one posting per organization and hour", async () => {
    const w = ready([
      rollup("db1", H05),
      rollup("db2", H05, "460800000"),
      rollup("db3", H05),
      rollup("db1", H06),
    ]);

    const report = await runPgcf(w.deps);

    expect(w.neon.requests).toEqual([{ from: H05, to: H07 }]);
    expect(report).toMatchObject({ status: "advanced", windows: 2, posted: 3 });
    expect(usageRows(w).map((row) => [row.key, row.deltaMicros])).toEqual([
      [`usage:pgcf:org_1:${H05}`, -15_000_000],
      [`usage:pgcf:org_2:${H05}`, -10_000_000],
      [`usage:pgcf:org_1:${H06}`, -10_000_000],
    ]);
    const merged = usageRows(w)[0]?.detail as { lines: { quantity: string; rateCardId: string }[] };
    expect(merged.lines).toEqual([
      expect.objectContaining({
        meter: "pgcf.memory.active",
        unit: "memory_mib_milliseconds",
        quantity: "1382400000",
        rateCardId: "pgcf-memory-2026-10-26-v1",
      }),
    ]);
    expect(w.core.cursors.get("pgcf")).toBe(H07);
  });

  it("bills the native Auth database to the project without inventing an environment", async () => {
    const w = ready([rollup("db1", H05), rollup("auth", H05)]);
    w.core.pgcfOwners.set("auth", {
      databaseId: "auth",
      organizationId: "org_1",
      projectId: "prj_1",
      resourceKind: "native_auth_database",
    });
    await runPgcf(w.deps);
    expect(usageRows(w)[0]).toMatchObject({ organizationId: "org_1", deltaMicros: -20_000_000 });
    expect((usageRows(w)[0]?.detail as { lines: unknown[] }).lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "prj_1",
          environmentId: null,
          resourceKind: "native_auth_database",
          quantity: HOUR_OF_256_MIB,
        }),
        expect.objectContaining({
          projectId: "prj_1",
          environmentId: "env_prod",
          quantity: HOUR_OF_256_MIB,
        }),
      ]),
    );
  });
  it("holds the billing cursor across a lost Native create reply and bills its original hour after reconciliation", async () => {
    const w = ready([rollup("auth", H05)]);
    w.core.nativeCreateHold = H05;
    expect(await runPgcf(w.deps)).toMatchObject({ status: "waiting", posted: 0 });
    expect(w.core.cursors.get("pgcf")).toBe(H05);
    w.core.pgcfOwners.set("auth", {
      databaseId: "auth",
      organizationId: "org_1",
      projectId: "prj_1",
      resourceKind: "native_auth_database",
    });
    w.core.nativeCreateHold = null;
    expect(await runPgcf(w.deps)).toMatchObject({ status: "advanced", posted: 1 });
    expect(usageRows(w)).toMatchObject([{ at: H05, deltaMicros: -10_000_000 }]);
    expect(w.core.cursors.get("pgcf")).toBe(H07);
  });

  it("stops before the first hour the provider has not finalized and waits when that is the first", async () => {
    const w = ready([rollup("db1", H05), rollup("db1", H06)], [pending("db1", H06)]);
    const report = await runPgcf(w.deps);
    expect(report).toMatchObject({ status: "advanced", windows: 1, posted: 1 });
    expect(w.core.cursors.get("pgcf")).toBe(H06);
    expect(usageRows(w)).toHaveLength(1);

    const waiting = ready([rollup("db1", H05)], [pending("db1", H05)]);
    const stalled = await runPgcf(waiting.deps);
    expect(stalled).toMatchObject({ status: "waiting", windows: 0, posted: 0 });
    expect(waiting.core.cursors.get("pgcf")).toBe(H05);
    expect(waiting.core.calls).not.toContain("advanceCursor");
  });

  it("counts databases without a customer owner and unbillable hours, and moves on", async () => {
    const w = ready([rollup("platform", H05), rollup("db3", H06)], [], 2);
    const report = await runPgcf(w.deps);
    expect(report.counters).toMatchObject({ databases_unowned: 1, hours_unbillable: 2 });
    expect(usageRows(w).map((row) => row.organizationId)).toEqual(["org_2"]);
    expect(w.core.cursors.get("pgcf")).toBe(H07);
  });

  it("does not count unbillable hours of a pass that holds the cursor back", async () => {
    const w = ready([], [pending("db1", H05)], 2);
    const report = await runPgcf(w.deps);
    expect(report).toMatchObject({ status: "waiting" });
    expect(report.counters).not.toHaveProperty("hours_unbillable");
    expect(w.core.cursors.get("pgcf")).toBe(H05);

    // A pass that advances part of its window and holds the rest is not the whole window: it counts nothing.
    const partial = ready([rollup("db1", H05)], [pending("db1", H06)], 2);
    const advanced = await runPgcf(partial.deps);
    expect(advanced).toMatchObject({ status: "advanced", windows: 1 });
    expect(advanced.counters).not.toHaveProperty("hours_unbillable");
    expect(partial.core.cursors.get("pgcf")).toBe(H06);
  });

  it("advances over hours without usage and does not price an unactivated meter", async () => {
    const quiet = ready([]);
    await runPgcf(quiet.deps);
    expect(quiet.core.cursors.get("pgcf")).toBe(H07);
    expect(quiet.core.calls.filter((call) => call === "advanceCursor")).toHaveLength(1);

    const off = ready([rollup("db1", H05)]);
    off.core.rates = [];
    const report = await runPgcf(off.deps);
    expect(report.counters).toMatchObject({ "unpriced:pgcf.memory.active": 1 });
    expect(usageRows(off)).toHaveLength(0);
    expect(off.core.cursors.get("pgcf")).toBe(H07);
  });

  it("is idempotent and resumes after a failure in a later hour", async () => {
    const w = ready([rollup("db1", H05), rollup("db3", H06)]);
    w.core.failOn = (method, input) =>
      method === "postUsage" && (input as { window: string }).window === H06;
    await expect(runPgcf(w.deps)).rejects.toThrow("postUsage failed");
    expect(usageRows(w)).toHaveLength(1);
    expect(w.core.cursors.get("pgcf")).toBe(H06);

    w.core.failOn = undefined;
    const resumed = await runPgcf(w.deps);
    expect(resumed).toMatchObject({ posted: 1, duplicates: 0, windows: 1 });
    expect(usageRows(w)).toHaveLength(2);

    w.core.cursors.set("pgcf", H05);
    const again = await runPgcf(w.deps);
    expect(again).toMatchObject({ posted: 0, duplicates: 2 });
    expect(usageRows(w)).toHaveLength(2);
  });

  it("ignores rollups at or after the stop and bounds a pass to one day", async () => {
    const w = ready([rollup("db1", H06)], [pending("db1", H06)]);
    await runPgcf(w.deps);
    expect(usageRows(w)).toHaveLength(0);
    expect(w.core.cursors.get("pgcf")).toBe(H06);

    const far = ready([]);
    far.core.cursors.set("pgcf", "2026-10-28T00:00:00.000Z");
    await runPgcf(far.deps);
    expect(far.neon.requests).toEqual([
      { from: "2026-10-28T00:00:00.000Z", to: "2026-10-29T00:00:00.000Z" },
    ]);
    expect(PGCF_MAX_HOURS).toBe(24);
  });

  it("does nothing without a cursor or while the next hours are not final yet", async () => {
    const w = world();
    expect(await runPgcf(w.deps)).toMatchObject({ status: "skipped" });
    w.core.cursors.set("pgcf", H07);
    expect(await runPgcf(w.deps)).toMatchObject({ status: "idle" });
    expect(w.neon.requests).toEqual([]);
  });

  it("resolves database owners in chunks", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `db${String(index + 10)}`);
    const w = ready(ids.map((id) => rollup(id, H05)));
    await runPgcf(w.deps);
    expect(w.core.calls.filter((call) => call === "resolvePgcfDatabases")).toHaveLength(2);
  });
});

describe("runPgcf pending rows of databases that no longer bill", () => {
  const retired = "rcm9bvrg";
  const state = (w: World) => ({
    posted: usageRows(w).length,
    cursor: w.core.cursors.get("pgcf"),
  });

  it("is not held back by a retired database that is never final and counts what it ignored", async () => {
    const w = ready(
      [rollup("db1", H05), rollup("db3", H05), rollup("db1", H06)],
      [pending(retired, H05), pending(retired, H06)],
    );
    const report = await runPgcf(w.deps);
    expect(report).toMatchObject({ status: "advanced", windows: 2, posted: 3 });
    expect(report.counters).toMatchObject({ pending_ignored: 2 });
    expect(usageRows(w).map((row) => row.key)).toEqual([
      `usage:pgcf:org_1:${H05}`,
      `usage:pgcf:org_2:${H05}`,
      `usage:pgcf:org_1:${H06}`,
    ]);
    expect(w.core.cursors.get("pgcf")).toBe(H07);
  });

  it("asks for each pending hour separately with that hour as the attribution instant", async () => {
    const w = ready([], [pending(retired, H06), pending("platform", H05), pending(retired, H05)]);
    const asked: unknown[] = [];
    w.core.failOn = (method, input) => {
      if (method === "resolvePgcfDatabases") asked.push(input);
      return false;
    };
    const report = await runPgcf(w.deps);
    expect(asked).toEqual([
      { databaseIds: ["platform", retired], at: H05 },
      { databaseIds: [retired], at: H06 },
    ]);
    expect(report.counters).toMatchObject({ pending_ignored: 3 });
    expect(w.core.cursors.get("pgcf")).toBe(H07);
  });

  it("still waits for a database that bills in its hour and bills nothing past that hour", async () => {
    const first = ready(
      [rollup("db1", H06), rollup("db3", H06)],
      [pending("db2", H05), pending(retired, H05)],
    );
    const waiting = await runPgcf(first.deps);
    expect(waiting).toMatchObject({ status: "waiting", windows: 0, posted: 0 });
    expect(waiting.counters).toMatchObject({ pending_ignored: 1 });
    expect(state(first)).toEqual({ posted: 0, cursor: H05 });
    expect(first.core.calls).not.toContain("advanceCursor");
    expect(first.core.calls).not.toContain("postUsage");

    const later = ready(
      [rollup("db1", H05), rollup("db3", H06)],
      [pending(retired, H05), pending("db2", H06), pending(retired, H06)],
    );
    const report = await runPgcf(later.deps);
    expect(report).toMatchObject({ status: "advanced", windows: 1, posted: 1 });
    expect(report.counters).toMatchObject({ pending_ignored: 2 });
    expect(usageRows(later).map((row) => row.key)).toEqual([`usage:pgcf:org_1:${H05}`]);
    expect(later.core.cursors.get("pgcf")).toBe(H06);
  });

  it("does not ask about hours after the first one that holds the cursor back", async () => {
    const w = ready([], [pending("db1", H06), pending(retired, H06), pending(retired, H05)]);
    w.core.cursors.set("pgcf", "2026-10-30T04:00:00.000Z");
    const asked: string[] = [];
    w.core.failOn = (method, input) => {
      if (method === "resolvePgcfDatabases") asked.push((input as { at: string }).at);
      return false;
    };
    const report = await runPgcf(w.deps);
    expect(asked).toEqual([H05, H06]);
    expect(report.counters).toMatchObject({ pending_ignored: 2 });
    expect(w.core.cursors.get("pgcf")).toBe(H06);

    const blocked = ready([], [pending("db1", H05), pending(retired, H06)]);
    blocked.core.failOn = (method, input) => {
      if (method === "resolvePgcfDatabases") asked.push((input as { at: string }).at);
      return false;
    };
    asked.length = 0;
    await runPgcf(blocked.deps);
    expect(asked).toEqual([H05]);
  });

  it("resolves the pending databases of an hour in chunks of 100", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `old${String(index + 10)}`);
    const w = ready(
      [],
      ids.map((id) => pending(id, H05)),
    );
    const report = await runPgcf(w.deps);
    expect(w.core.calls.filter((call) => call === "resolvePgcfDatabases")).toHaveLength(2);
    expect(report.counters).toMatchObject({ pending_ignored: 120 });
    expect(w.core.cursors.get("pgcf")).toBe(H07);
  });

  it("holds the hour a database still served in and passes the next one only after that hour is final", async () => {
    // db1 stops serving with the start of H06: its H05 hour is billable, its H06 hour is not.
    const lastHour = [rollup("db3", H05), rollup("db3", H06)];
    const open = ready(lastHour, [pending("db1", H05), pending("db1", H06)]);
    open.core.pgcfServingUntil.set("db1", H06);
    const blocked = await runPgcf(open.deps);
    expect(blocked).toMatchObject({ status: "waiting", posted: 0 });
    expect(state(open)).toEqual({ posted: 0, cursor: H05 });

    // The provider finalizes H05 of db1; its H06 row stays pending forever and no longer matters.
    const final = ready([rollup("db1", H05), ...lastHour], [pending("db1", H06)]);
    final.core.pgcfServingUntil.set("db1", H06);
    const report = await runPgcf(final.deps);
    expect(report).toMatchObject({ status: "advanced", windows: 2, posted: 3 });
    expect(report.counters).toMatchObject({ pending_ignored: 1 });
    expect(usageRows(final).map((row) => [row.key, row.deltaMicros])).toEqual([
      [`usage:pgcf:org_1:${H05}`, -10_000_000],
      [`usage:pgcf:org_2:${H05}`, -10_000_000],
      [`usage:pgcf:org_2:${H06}`, -10_000_000],
    ]);
    expect(final.core.cursors.get("pgcf")).toBe(H07);
  });
});

describe("runPgcf budget sweep", () => {
  const A = { organizationId: "org_1", projectId: "prj_1" };
  const B = { organizationId: "org_2", projectId: "prj_3" };

  it("disables the schedules of the projects whose stop budget is reached, after the billing", async () => {
    const w = ready([rollup("db1", H05)]);
    w.core.stopBudgetProjects = [A, B];
    w.neon.stopAnswer = (i) => ({ stopped: i.projectId === "prj_1" ? 2 : 1 });

    const report = await runPgcf(w.deps);

    expect(w.neon.stopRequests).toEqual([A, B]);
    expect(report.counters).toMatchObject({ schedules_stopped: 3 });
    expect(report.problems).toEqual([]);
    expect(usageRows(w)).toHaveLength(1);
    expect(w.core.calls.indexOf("advanceCursor")).toBeLessThan(
      w.core.calls.indexOf("listStopBudgetProjects"),
    );
  });

  it("disables the schedules of organizations past their credit grace, with or without a stop budget", async () => {
    const C = { organizationId: "org_3", projectId: "prj_5" };
    const w = ready([]);
    w.core.stopBudgetProjects = [B];
    w.core.creditDeniedProjects = [C, B];

    const report = await runPgcf(w.deps);

    expect(w.core.calls).toContain("listCreditDeniedProjects");
    expect(w.neon.stopRequests).toEqual([B, C]);
    expect(report.problems).toEqual([]);
  });

  it("still disables the schedules when the credit-denied list is unreadable, and reports it", async () => {
    const w = ready([]);
    w.core.stopBudgetProjects = [A];
    w.core.failOn = (method) => method === "listCreditDeniedProjects";

    const report = await runPgcf(w.deps);

    expect(w.neon.stopRequests).toEqual([A]);
    expect(report.problems).toEqual(["budget_projects_unreadable"]);
  });

  it("runs on a pass without a cursor and on an idle pass", async () => {
    const skipped = world();
    skipped.core.stopBudgetProjects = [A];
    expect(await runPgcf(skipped.deps)).toMatchObject({ status: "skipped" });
    expect(skipped.neon.stopRequests).toEqual([A]);

    const idle = ready([]);
    idle.core.stopBudgetProjects = [A];
    expect(await runPgcf(idle.deps)).toMatchObject({ status: "advanced" });
    expect(idle.neon.stopRequests).toEqual([A]);
  });

  it("does not stop the other projects when one of them fails, and reports each failure", async () => {
    const w = ready([]);
    w.core.stopBudgetProjects = [
      { organizationId: "org_1", projectId: "bad" },
      { organizationId: "org_2", projectId: "malformed" },
      B,
    ];
    w.neon.stopAnswer = (i) => {
      if (i.projectId === "bad") throw new Error("provider down");
      if (i.projectId === "malformed") return { stopped: -1 };
      return { stopped: 1 };
    };

    const report = await runPgcf(w.deps);

    expect(w.neon.stopRequests).toHaveLength(3);
    expect(report.counters).toMatchObject({ schedules_stopped: 1, schedule_stops_failed: 2 });
    expect(report.problems).toEqual(["schedule_stop_failed:bad", "schedule_stop_failed:malformed"]);
  });

  it("bills the pass when the sweep cannot read the projects, and the sweep runs when billing fails", async () => {
    const unreadable = ready([rollup("db1", H05)]);
    unreadable.core.failOn = (method) => method === "listStopBudgetProjects";
    const report = await runPgcf(unreadable.deps);
    expect(report.problems).toEqual(["budget_projects_unreadable"]);
    expect(usageRows(unreadable)).toHaveLength(1);
    expect(unreadable.core.cursors.get("pgcf")).toBe(H07);

    const billingFails = ready([rollup("db1", H05)]);
    billingFails.core.stopBudgetProjects = [A];
    billingFails.core.failOn = (method) => method === "postUsage";
    await expect(runPgcf(billingFails.deps)).rejects.toThrow("postUsage failed");
    expect(billingFails.core.calls).toContain("listStopBudgetProjects");
    expect(billingFails.neon.stopRequests).toEqual([A]);
  });
});

describe("parsePgcfRollups", () => {
  const from = Date.parse(H05);
  const to = Date.parse(H07);
  const good = {
    from: H05,
    to: H07,
    rollups: [rollup("db1", H06)],
    pending: [pending("db1", H06)],
    unbillableHours: 0,
  };
  const bad = (change: Record<string, unknown>) => () =>
    parsePgcfRollups({ ...good, ...change }, from, to);

  it("accepts a well formed answer", () => {
    expect(parsePgcfRollups(good, from, to)).toBe(good);
  });

  it("refuses every malformed answer", () => {
    for (const value of [null, [], "x", 3])
      expect(() => parsePgcfRollups(value, from, to)).toThrow(
        "credit_service_pgcf_rollups_invalid",
      );
    expect(bad({ from: H06 })).toThrow("credit_service_pgcf_rollups_invalid");
    expect(bad({ to: H06 })).toThrow("credit_service_pgcf_rollups_invalid");
    expect(bad({ rollups: "x" })).toThrow("credit_service_pgcf_rollups_invalid");
    expect(bad({ unbillableHours: -1 })).toThrow("credit_service_pgcf_rollups_invalid");
    expect(bad({ unbillableHours: "1" })).toThrow("credit_service_pgcf_rollups_invalid");
    for (const notFinal of [
      undefined,
      null,
      "x",
      [null],
      [pending("db1", H07)],
      [pending("db1", "2026-10-30T04:00:00.000Z")],
      [pending("db1", "2026-10-30T06:30:00.000Z")],
      [{ databaseId: "db1", hourStart: 5 }],
      [{ databaseId: 7, hourStart: H06 }],
      [{ hourStart: H06 }],
      [pending("", H06)],
    ])
      expect(bad({ pending: notFinal })).toThrow("credit_service_pgcf_rollups_invalid");
    expect(bad({ rollups: [null] })).toThrow("credit_service_pgcf_rollups_invalid");
    expect(bad({ rollups: [rollup("db1", "2026-10-30T04:00:00.000Z")] })).toThrow();
    expect(bad({ rollups: [rollup("db1", H06, "1.5")] })).toThrow();
    expect(bad({ rollups: [rollup("db1", H06, "-1")] })).toThrow();
    expect(bad({ rollups: [{ hourStart: H06, memoryMibMilliseconds: "1" }] })).toThrow();
  });
});
