import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { ensureStatement } from "../../src/catalog/credit/account.js";
import {
  OVERRUN_CEILING_MICROS,
  createCreditCommands,
  readRuntimeDecision,
  runReserve,
  setProjectBudget,
} from "../../src/catalog/credit/index.js";
import type { CatalogContext } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedCandidate } from "../support/provisioning-cleanup-fixtures.js";
import { beforeFirstWrite, freezeOwnership, ulidOf } from "../support/platform-fixtures.js";
import { accountOf, all, count, credits, first, logOf, newOrganization, OCT } from "./support.js";

/** The credit commands of one control database, on a fixed Core clock. */
function creditOn(db: TestControl["core"]) {
  const context: CatalogContext = { directory: db, router: new SharedCoreRouter(db) };
  return createCreditCommands(
    (command) => (input) => command(context, input),
    () => "2026-10-30T10:07:00.000000Z",
  );
}

let control: TestControl;
let credit: ReturnType<typeof createCreditCommands>;
beforeAll(async () => {
  control = await createTestControl();
  credit = creditOn(control.core);
}, 120_000);
afterAll(async () => control.dispose());

const line = (
  p: { projectId: string; devEnvironmentId: string },
  meter: string,
  chargeMicros: number,
  projectId = p.projectId,
) => ({
  projectId,
  environmentId: p.devEnvironmentId,
  meter,
  quantity: "1234",
  unit: "request",
  rateCardId: "usage-2026-10-v1",
  chargeMicros,
});

describe("postUsage", () => {
  it("accepts project-scoped native Auth usage only for the PGCF memory meter", async () => {
    const p = await newOrganization(control);
    const native = {
      ...line(p, "pgcf.memory.active", credits(10)),
      environmentId: null,
      resourceKind: "native_auth_database",
      unit: "memory_mib_milliseconds",
    };
    const posting = {
      organizationId: p.organizationId,
      source: "pgcf",
      window: "2026-10-30T09:00:00.000Z",
      lines: [native],
    };
    await expect(credit.postUsage({ ...posting, source: "wfp" })).rejects.toThrow();
    await expect(
      credit.postUsage({ ...posting, lines: [{ ...native, meter: "other" }] }),
    ).rejects.toThrow();
    expect(await credit.postUsage(posting)).toEqual({ posted: true, balanceMicros: credits(190) });
    expect(
      JSON.parse((await logOf(control.core, p.organizationId)).at(-1)?.detail ?? ""),
    ).toMatchObject({ lines: [native] });
  });
  it("posts a window once: charges the organization, counts its projects and logs the lines", async () => {
    const p = await newOrganization(control);
    const other = ulidOf("another-project", 1);
    const window = "2026-10-30T09:00:00.000Z";
    const lines = [
      line(p, "wfp.requests", 1_500_000),
      line(p, "wfp.cpu", 500_000),
      line(p, "wfp.requests", 250_000, other),
    ];
    const post = (source: string, at: string = window) =>
      credit.postUsage({ organizationId: p.organizationId, source, window: at, lines });
    expect(await post("wfp")).toEqual({ posted: true, balanceMicros: credits(200) - 2_250_000 });
    expect(await post("wfp")).toEqual({ posted: false, balanceMicros: credits(200) - 2_250_000 });
    // the same window in another spelling is the same window
    expect(await post("wfp", "2026-10-30T09:00Z")).toMatchObject({ posted: false });
    expect(await accountOf(control.core, p.organizationId)).toMatchObject({
      monthly_micros: credits(200) - 2_250_000,
    });
    // another source, or another window, is another posting
    expect(await post("pgcf")).toMatchObject({
      posted: true,
      balanceMicros: credits(200) - 4_500_000,
    });
    expect(await post("wfp", "2026-10-30T10:00:00.000Z")).toMatchObject({ posted: true });

    const log = (await logOf(control.core, p.organizationId)).filter((row) => row.kind === "usage");
    expect(log.map((row) => row.key)).toEqual([
      `usage:wfp:${p.organizationId}:2026-10-30T09:00:00.000000Z`,
      `usage:pgcf:${p.organizationId}:2026-10-30T09:00:00.000000Z`,
      `usage:wfp:${p.organizationId}:2026-10-30T10:00:00.000000Z`,
    ]);
    expect(log[0]).toMatchObject({ at: "2026-10-30T09:00:00.000000Z", delta_micros: -2_250_000 });
    expect(JSON.parse(log[0]?.detail ?? "")).toEqual({
      source: "wfp",
      window,
      lines,
      spent: { monthly: 2_250_000, onetime: 0, overrun: 0 },
    });
    const used = await all<{ project_id: string; used_micros: number; period: string }>(
      control.core,
      "SELECT project_id, used_micros, period FROM project_credit WHERE organization_id = ? ORDER BY used_micros",
      p.organizationId,
    );
    expect(used).toEqual([
      { project_id: other, used_micros: 750_000, period: "2026-10" },
      { project_id: p.projectId, used_micros: 6_000_000, period: "2026-10" },
    ]);
  });

  it("books a window in one layout only, keeps the current lines of a failed posting and ends a kept one when its key is booked", async () => {
    const p = await newOrganization(control);
    const stored = (window: string) => `${window.slice(0, 23)}000Z`;
    const requests = [line(p, "wfp.requests", credits(1))];
    const cpu = [line(p, "wfp.cpu", credits(2))];
    const keyOf = (window: string, part = 0) =>
      `usage:wfp:${p.organizationId}:${stored(window)}${part > 0 ? `:p${String(part)}` : ""}`;
    const usageKeys = async () =>
      (await logOf(control.core, p.organizationId))
        .filter((row) => row.kind === "usage")
        .map((row) => row.key);

    // A window posted whole is the key it always had: no part and no layout in the posting, none in the row.
    const whole = {
      organizationId: p.organizationId,
      source: "wfp",
      window: "2026-10-30T11:00:00.000Z",
    };
    expect(await credit.postUsage({ ...whole, lines: requests })).toMatchObject({ posted: true });
    expect(await credit.postUsage({ ...whole, lines: requests })).toEqual({
      posted: false,
      balanceMicros: credits(199),
    });
    expect(JSON.parse((await logOf(control.core, p.organizationId)).at(-1)?.detail ?? "")).toEqual({
      source: "wfp",
      window: whole.window,
      lines: requests,
      spent: { monthly: 1_000_000, onetime: 0, overrun: 0 },
    });
    // A split posting of that window is refused and tells which layout is booked; nothing is charged.
    expect(await credit.postUsage({ ...whole, split: true, part: 1, lines: cpu })).toEqual({
      posted: false,
      balanceMicros: credits(199),
      layout: "whole",
    });
    expect(await usageKeys()).toEqual([keyOf(whole.window)]);

    // A split window: part 0 keeps the key, a part above 0 adds `:p<part>`, and the whole layout is refused for it.
    const split = {
      organizationId: p.organizationId,
      source: "wfp",
      window: "2026-10-30T12:00:00.000Z",
    };
    const part = (n: number, lines: unknown[]) =>
      credit.postUsage({ ...split, split: true, part: n, lines });
    expect(await part(0, requests)).toMatchObject({ posted: true });
    expect(await part(1, cpu)).toMatchObject({ posted: true });
    expect(await part(1, cpu)).toEqual({ posted: false, balanceMicros: credits(196) });
    expect(await credit.postUsage({ ...split, lines: requests })).toMatchObject({
      posted: false,
      layout: "split",
    });
    expect((await usageKeys()).slice(1)).toEqual([keyOf(split.window), keyOf(split.window, 1)]);
    const rows = (await logOf(control.core, p.organizationId)).slice(-2);
    expect(JSON.parse(rows[0]?.detail ?? "")).toEqual({
      source: "wfp",
      window: split.window,
      split: true,
      part: 0,
      lines: requests,
      spent: { monthly: 1_000_000, onetime: 0, overrun: 0 },
    });
    expect(JSON.parse(rows[1]?.detail ?? "")).toMatchObject({ split: true, part: 1, lines: cpu });
    // A part needs the split layout, stays within 255, and a posting stays within 2000 lines.
    const many = Array.from({ length: 2001 }, () => requests[0]);
    for (const input of [
      { lines: many },
      { part: 1, lines: requests },
      { split: true, part: 256, lines: requests },
      { split: true, part: -1, lines: requests },
      { split: true, part: 1.5, lines: requests },
    ])
      await expect(credit.postUsage({ ...split, ...input })).rejects.toBeInstanceOf(ZodError);

    // A posting that cannot be booked is kept with the lines of its LATEST attempt.
    const failing = {
      organizationId: p.organizationId,
      source: "wfp",
      window: "2026-10-30T13:00:00.000Z",
    };
    const keep = (extra: Record<string, unknown>) =>
      credit.recordUsageFailure({
        ...failing,
        lines: requests,
        reason: "r",
        limit: 3,
        immediate: false,
        ...extra,
      });
    expect(await keep({})).toEqual({ attempts: 1, dead: false });
    expect(await keep({ lines: [], reason: "second" })).toEqual({ attempts: 2, dead: false });
    expect(
      await first<{ attempts: number; reason: string; lines: string }>(
        control.core,
        "SELECT attempts, reason, lines FROM usage_post_failure WHERE key = ?",
        keyOf(failing.window),
      ),
    ).toEqual({ attempts: 2, reason: "second", lines: "[]" });
    expect(await keep({ lines: cpu, reason: "third" })).toEqual({ attempts: 3, dead: true });

    // The Core judges the lines itself: lines it would refuse are dead at once, whatever the caller knows of the error
    // (a name or a message may not survive the binding), and so is every further failure of an organization with a dead one.
    const other = { ...failing, window: "2026-10-30T14:00:00.000Z" };
    const bad = [{ ...cpu[0], projectId: "not-a-ulid" }];
    await expect(credit.postUsage({ ...other, lines: bad })).rejects.toBeInstanceOf(ZodError);
    expect(await keep({ ...other, lines: bad })).toEqual({ attempts: 3, dead: true });
    const later = { ...failing, window: "2026-10-30T15:00:00.000Z" };
    expect(await keep({ ...later })).toEqual({ attempts: 3, dead: true });
    expect(await count(control.core, "usage_post_failure")).toBe(3);

    // A kept posting is settled by booking its key, also through the empty-lines exit; a failure of a booked key is not kept.
    await credit.postUsage({ ...other, lines: [] });
    await credit.postUsage({ ...later, lines: requests });
    expect(await keep({ ...later, reason: "lost answer" })).toEqual({
      attempts: 0,
      dead: false,
      settled: "booked",
    });
    expect(await credit.postUsage({ ...later, lines: requests })).toMatchObject({ posted: false });
    expect(
      await first<{ n: number }>(
        control.core,
        "SELECT count(*) AS n FROM usage_post_failure WHERE key <> ?",
        keyOf(failing.window),
      ),
    ).toEqual({ n: 0 });

    // Replay books the kept posting; it is filed at the Core's clock, not under its window.
    expect(await credit.replayUsageFailures({ minAttempts: 3, limit: 10 })).toEqual({
      replayed: 1,
      remaining: 0,
    });
    const replayed = (await logOf(control.core, p.organizationId)).find(
      (row) => row.key === keyOf(failing.window),
    );
    expect(replayed).toMatchObject({
      at: "2026-10-30T10:07:00.000000Z",
      delta_micros: -credits(2),
    });
    expect(JSON.parse(replayed?.detail ?? "")).toEqual({
      source: "wfp",
      window: failing.window,
      replayed: true,
      lines: cpu,
      spent: { monthly: 2_000_000, onetime: 0, overrun: 0 },
    });
    expect(await count(control.core, "usage_post_failure")).toBe(0);
    // credits: 1 + 1 + 2 (split window) + 1 (later window) + 2 (replay) booked once each
    expect((await accountOf(control.core, p.organizationId)).monthly_micros).toBe(credits(193));
  });

  it("books a window in one layout when postings of two layouts overlap, and keeps no posting of another layout than the booked one", async () => {
    const p = await newOrganization(control);
    const requests = [line(p, "wfp.requests", credits(1))];
    const cpu = [line(p, "wfp.cpu", credits(2))];
    const at = (hour: number) => ({
      organizationId: p.organizationId,
      source: "wfp",
      window: `2026-10-30T${String(hour)}:00:00.000Z`,
    });
    // `other` runs between the read and the write of the posting it races, as a second invocation would
    const racing = (other: () => Promise<unknown>) =>
      creditOn(beforeFirstWrite(control.core, async () => void (await other())));
    const keys = async () =>
      (await logOf(control.core, p.organizationId))
        .filter((row) => row.kind === "usage")
        .map((row) => row.key.split(":").slice(3).join(":"));

    // a whole window books between a split posting's check and its write: only the whole layout is booked
    expect(
      await racing(() => credit.postUsage({ ...at(16), lines: requests })).postUsage({
        ...at(16),
        split: true,
        part: 3,
        lines: cpu,
      }),
    ).toMatchObject({ posted: false, layout: "whole" });
    // and the other way round
    expect(
      await racing(() =>
        credit.postUsage({ ...at(17), split: true, part: 1, lines: cpu }),
      ).postUsage({ ...at(17), lines: requests }),
    ).toMatchObject({ posted: false, layout: "split" });
    expect(await keys()).toEqual(["2026-10-30T16:00:00.000000Z", "2026-10-30T17:00:00.000000Z:p1"]);
    expect((await accountOf(control.core, p.organizationId)).monthly_micros).toBe(credits(197));

    // A kept posting never has another layout than the booked one, so a replay long after the rotation of the
    // window's rows cannot book a second layout: booking supersedes the kept ones, and recording refuses them.
    const keep = (window: ReturnType<typeof at>, extra: Record<string, unknown> = {}) =>
      credit.recordUsageFailure({
        ...window,
        lines: requests,
        reason: "r",
        limit: 3,
        immediate: false,
        ...extra,
      });
    expect(await keep(at(18))).toEqual({ attempts: 1, dead: false });
    await credit.postUsage({ ...at(18), split: true, part: 0, lines: cpu });
    expect(await count(control.core, "usage_post_failure")).toBe(0);
    expect(await keep(at(18))).toEqual({ attempts: 0, dead: false, settled: "superseded" });
    expect(await keep(at(18), { split: true, part: 0 })).toEqual({
      attempts: 0,
      dead: false,
      settled: "booked",
    });
    expect(await count(control.core, "usage_post_failure")).toBe(0);
  });

  it("keeps the failure of a posting that books nothing, which replay leaves for an operator", async () => {
    const p = await newOrganization(control);
    const requests = [line(p, "wfp.requests", credits(1))];
    // an organization without an account: its posting is answered but books nothing
    const ghost = {
      organizationId: ulidOf("ghost", 41),
      source: "wfp",
      window: "2026-10-30T19:00:00.000Z",
    };
    const kept = () =>
      all<{ attempts: number }>(
        control.core,
        "SELECT attempts FROM usage_post_failure WHERE organization_id = ?",
        ghost.organizationId,
      );
    try {
      expect(
        await credit.recordUsageFailure({
          ...ghost,
          lines: requests,
          reason: "r",
          limit: 3,
          immediate: true,
        }),
      ).toEqual({ attempts: 3, dead: true });
      expect(await credit.postUsage({ ...ghost, lines: requests })).toEqual({
        posted: false,
        balanceMicros: 0,
      });
      expect(await kept()).toEqual([{ attempts: 3 }]);
      // the replay answers it without booking: the row stays and is still reported open, for an operator
      const replay = await credit.replayUsageFailures({ minAttempts: 3, limit: 10 });
      expect(replay.remaining).toBeGreaterThanOrEqual(1);
      expect(await kept()).toEqual([{ attempts: 3 }]);
      expect(await logOf(control.core, ghost.organizationId)).toEqual([]);
    } finally {
      await control.core
        .prepare("DELETE FROM usage_post_failure WHERE organization_id = ?")
        .bind(ghost.organizationId)
        .run();
    }
  });

  it("settles a failure kept for a key that an older Worker booked without removing it", async () => {
    const p = await newOrganization(control);
    const posting = {
      organizationId: p.organizationId,
      source: "wfp",
      window: "2026-10-30T20:00:00.000Z",
      lines: [line(p, "wfp.requests", credits(1))],
    };
    const key = `usage:wfp:${p.organizationId}:2026-10-30T20:00:00.000000Z`;
    const kept = async () =>
      (
        await all<{ key: string }>(
          control.core,
          "SELECT key FROM usage_post_failure WHERE organization_id = ?",
          p.organizationId,
        )
      ).length;
    expect(await credit.postUsage(posting)).toMatchObject({ posted: true });
    // the rollout: a Worker without the delete in the booking batch left the kept row behind
    await control.core
      .prepare(
        `INSERT INTO usage_post_failure(key, organization_id, source, window_start, part, attempts, reason, lines, first_failed_at, last_failed_at)
         VALUES (?1, ?2, 'wfp', '2026-10-30T20:00:00.000000Z', 0, 4, 'old', '[]', '2026-10-30T20:30:00.000000Z', '2026-10-30T20:30:00.000000Z')`,
      )
      .bind(key, p.organizationId)
      .run();
    expect(await kept()).toBe(1);
    // a duplicate aborts the batch, so only the delete after it can settle the row
    expect(await credit.postUsage(posting)).toMatchObject({ posted: false });
    expect(await kept()).toBe(0);
  });

  it("replays a healthy kept posting although more than the limit of failing ones were kept before it, and backs the failing ones off", async () => {
    const p = await newOrganization(control);
    const cpu = [line(p, "wfp.cpu", credits(1))];
    const keep = async (hour: number, lines: unknown[], failedAt: string) => {
      const window = `2026-10-30T${String(hour).padStart(2, "0")}:00:00.000000Z`;
      await control.core
        .prepare(
          `INSERT INTO usage_post_failure(key, organization_id, source, window_start, part, attempts, reason, lines, first_failed_at, last_failed_at)
           VALUES (?1, ?2, 'wfp', ?3, 0, 3, 'kept', ?4, ?5, ?5)`,
        )
        .bind(
          `usage:wfp:${p.organizationId}:${window}`,
          p.organizationId,
          window,
          JSON.stringify(lines),
          failedAt,
        )
        .run();
      return window;
    };
    // three postings that fail for good, kept before the healthy one, and a limit of two per call
    const poison = [{ ...cpu[0], projectId: "not-a-ulid" }];
    for (const hour of [1, 2, 3])
      await keep(hour, poison, `2026-10-30T0${String(hour)}:30:00.000000Z`);
    const healthy = await keep(4, cpu, "2026-10-30T04:30:00.000000Z");

    expect(await credit.replayUsageFailures({ minAttempts: 3, limit: 2 })).toEqual({
      replayed: 0,
      remaining: 4,
    });
    // the two that failed are backed off and go behind: the third poisoned one and the healthy one are tried now
    expect(await credit.replayUsageFailures({ minAttempts: 3, limit: 2 })).toEqual({
      replayed: 1,
      remaining: 3,
    });
    expect(
      (await logOf(control.core, p.organizationId))
        .filter((row) => row.kind === "usage")
        .map((row) => row.key),
    ).toEqual([`usage:wfp:${p.organizationId}:${healthy}`]);
    // until their backoff has passed the failing ones are not tried again
    expect(await credit.replayUsageFailures({ minAttempts: 3, limit: 2 })).toEqual({
      replayed: 0,
      remaining: 3,
    });
    expect(
      await all<{ attempts: number }>(
        control.core,
        "SELECT attempts FROM usage_post_failure ORDER BY first_failed_at",
      ),
    ).toEqual([{ attempts: 4 }, { attempts: 4 }, { attempts: 4 }]);
  });

  it("posts a window with no lines or no charge, and for an organization that does not exist", async () => {
    const p = await newOrganization(control);
    const post = (lines: unknown[], window = "2026-10-30T08:00:00.000Z") =>
      credit.postUsage({ organizationId: p.organizationId, source: "r2", window, lines });
    expect(await post([])).toEqual({ posted: false, balanceMicros: credits(200) });
    expect(await logOf(control.core, p.organizationId)).toEqual([]);
    // quantities without a charge are still a posting: the usage report shows them
    expect(await post([line(p, "r2.storage", 0)])).toEqual({
      posted: true,
      balanceMicros: credits(200),
    });
    expect((await logOf(control.core, p.organizationId)).at(-1)).toMatchObject({
      kind: "usage",
      delta_micros: 0,
    });
    expect(
      await credit.postUsage({
        organizationId: ulidOf("ghost", 40),
        source: "r2",
        window: "2026-10-30T08:00:00.000Z",
        lines: [line(p, "r2.storage", 5)],
      }),
    ).toEqual({ posted: false, balanceMicros: 0 });
  });

  it("charges two identical postings that race exactly once", async () => {
    const p = await newOrganization(control);
    const post = () =>
      credit.postUsage({
        organizationId: p.organizationId,
        source: "resources",
        window: "2026-10-29T00:00:00.000Z",
        lines: [line(p, "resources.scripts", credits(3))],
      });
    const results = await Promise.all(Array.from({ length: 6 }, post));
    expect(results.filter((result) => result.posted)).toHaveLength(1);
    expect((await accountOf(control.core, p.organizationId)).monthly_micros).toBe(credits(197));
  });

  it("refuses input that is not exactly a posting", async () => {
    const p = await newOrganization(control);
    const base = {
      organizationId: p.organizationId,
      source: "wfp",
      window: "2026-10-30T09:00:00.000Z",
      lines: [line(p, "wfp.requests", 1)],
    };
    const bad: unknown[] = [
      { ...base, source: "mail" },
      { ...base, organizationId: "not-an-id" },
      { ...base, window: "yesterday" },
      { ...base, extra: true },
      { ...base, lines: [line(p, "wfp.requests", -1)] },
      { ...base, lines: [line(p, "wfp.requests", 1.5)] },
      { ...base, lines: [{ ...line(p, "wfp.requests", 1), quantity: "many" }] },
      { ...base, lines: [{ ...line(p, "wfp.requests", 1), surplus: 1 }] },
    ];
    for (const input of bad) await expect(credit.postUsage(input)).rejects.toThrow();
    expect(await logOf(control.core, p.organizationId)).toEqual([]);
  });

  it("runs on the store with the Core's own clock", async () => {
    const store = createControlStore(control.bindings);
    const p = await newOrganization(control);
    const result = await store.credit.postUsage({
      organizationId: p.organizationId,
      source: "wfp",
      window: "2026-09-15T09:00:00.000Z",
      lines: [line(p, "wfp.requests", 1_000_000)],
    });
    expect(result).toEqual({ posted: true, balanceMicros: credits(199) });
    const rows = await store.credit.readLogsToday({ organizationId: p.organizationId });
    // the renewal is filed under the real day; the usage under its window, which is long past and not rotated yet
    expect(rows.map((row) => row.kind).sort()).toEqual(["renew", "usage"]);
  });
});

describe("cursors", () => {
  it("keeps one cursor per source that only moves forward", async () => {
    expect(await credit.readCursor("wfp")).toBeNull();
    expect(await credit.cursorsThrough()).toEqual([]);
    expect(
      await credit.advanceCursor({ source: "wfp", through: "2026-10-30T09:00:00.000Z" }),
    ).toBeUndefined();
    expect(await credit.readCursor("wfp")).toBe("2026-10-30T09:00:00.000Z");
    // an older or equal instant changes nothing
    await credit.advanceCursor({ source: "wfp", through: "2026-10-30T08:00:00.000Z" });
    await credit.advanceCursor({ source: "wfp", through: "2026-10-30T09:00:00.000Z" });
    expect(await credit.readCursor("wfp")).toBe("2026-10-30T09:00:00.000Z");
    await credit.advanceCursor({ source: "wfp", through: "2026-10-30T10:00:00.000Z" });
    await credit.advanceCursor({ source: "pgcf", through: "2026-10-30T07:00:00.000Z" });
    expect(await credit.cursorsThrough()).toEqual([
      { source: "pgcf", through: "2026-10-30T07:00:00.000Z" },
      { source: "wfp", through: "2026-10-30T10:00:00.000Z" },
    ]);
    await expect(credit.readCursor("mail")).rejects.toBeInstanceOf(ZodError);
    await expect(credit.advanceCursor({ source: "wfp" })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("resolveScripts", () => {
  it("resolves a script to the current owner of its project and environment", async () => {
    const p = await newOrganization(control);
    const q = await newOrganization(control);
    const dev = await seedCandidate(p);
    const prod = await seedCandidate(p, { environmentId: p.prodEnvironmentId });
    const other = await seedCandidate(q);
    const names = [
      dev.script,
      prod.script,
      other.script,
      "p-unknown-dev-unknown",
      "ohmyho-gateway-production",
    ];
    const resolved = await credit.resolveScripts({ scriptNames: [...names, dev.script] });
    expect([...resolved].sort((a, b) => (a.scriptName < b.scriptName ? -1 : 1))).toEqual(
      [
        {
          scriptName: dev.script,
          organizationId: p.organizationId,
          projectId: p.projectId,
          environmentId: p.devEnvironmentId,
        },
        {
          scriptName: prod.script,
          organizationId: p.organizationId,
          projectId: p.projectId,
          environmentId: p.prodEnvironmentId,
        },
        {
          scriptName: other.script,
          organizationId: q.organizationId,
          projectId: q.projectId,
          environmentId: q.devEnvironmentId,
        },
      ].sort((a, b) => (a.scriptName < b.scriptName ? -1 : 1)),
    );
    expect(await credit.resolveScripts({ scriptNames: [] })).toEqual([]);

    // many names are looked up in several statements
    const many = Array.from({ length: 1201 }, (_, index) => `p-${index}`);
    expect(await credit.resolveScripts({ scriptNames: [...many, other.script] })).toEqual([
      {
        scriptName: other.script,
        organizationId: q.organizationId,
        projectId: q.projectId,
        environmentId: q.devEnvironmentId,
      },
    ]);

    // a frozen project still has its owner, a project nobody owns any more has none
    await freezeOwnership(q);
    expect(
      (await credit.resolveScripts({ scriptNames: [other.script] })).map(
        (row) => row.organizationId,
      ),
    ).toEqual([q.organizationId]);
    await control.core.batch([
      control.core
        .prepare(
          "UPDATE billing_epochs SET ended_at = '2026-10-30T10:00:00.000000Z' WHERE project_id = ?",
        )
        .bind(q.projectId),
      control.core
        .prepare("UPDATE projects SET owner_state = 'transferred' WHERE project_id = ?")
        .bind(q.projectId),
    ]);
    expect(await credit.resolveScripts({ scriptNames: [other.script] })).toEqual([]);
    await expect(credit.resolveScripts({ scriptNames: [""] })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("readRates", () => {
  it("returns the cards with an activation in force, with the activated meters only", async () => {
    const rate = (meter: string, credit_micros: string) => ({
      meter,
      unit: "request",
      units_per_charge: "1000",
      provider_cost_micros: null,
      credit_micros,
    });
    const insert = (id: string, publishedAt: string, effectiveFrom: string, rates: unknown[]) =>
      control.core
        .prepare(
          "INSERT INTO published_credit_rate_cards(rate_card_id, published_at, effective_from, rates) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(id, publishedAt, effectiveFrom, JSON.stringify(rates));
    const activate = (meter: string, card: string, startsAt: string) =>
      control.core
        .prepare(
          "INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at) VALUES (?1, ?2, ?3, '2026-10-05T00:00:00.000000Z')",
        )
        .bind(meter, card, startsAt);
    await control.core.batch([
      insert("usage-2026-10-v1", "2026-10-01T00:00:00.000000Z", "2026-10-02T00:00:00.000000Z", [
        rate("wfp.requests", "300"),
        rate("wfp.cpu", "7"),
      ]),
      insert("pgcf-2026-11-v1", "2026-10-20T00:00:00.000000Z", "2026-11-01T00:00:00.000000Z", [
        rate("pgcf.memory.active", "5"),
      ]),
      activate("wfp.requests", "usage-2026-10-v1", "2026-10-10T00:00:00.000000Z"),
      activate("pgcf.memory.active", "pgcf-2026-11-v1", "2026-11-01T00:00:00.000000Z"),
    ]);
    expect(await credit.readRates({ at: "2026-10-05T00:00:00.000Z" })).toEqual([]);
    expect(await credit.readRates({ at: "2026-10-30T00:00:00.000Z" })).toEqual([
      {
        rateCardId: "usage-2026-10-v1",
        rates: [{ ...rate("wfp.requests", "300"), starts_at: "2026-10-10T00:00:00.000Z" }],
      },
    ]);
    expect(await credit.readRates({ at: "2026-11-02T00:00:00.000Z" })).toEqual([
      {
        rateCardId: "pgcf-2026-11-v1",
        rates: [{ ...rate("pgcf.memory.active", "5"), starts_at: "2026-11-01T00:00:00.000Z" }],
      },
      {
        rateCardId: "usage-2026-10-v1",
        rates: [{ ...rate("wfp.requests", "300"), starts_at: "2026-10-10T00:00:00.000Z" }],
      },
    ]);
  });

  it("prices a meter by its latest activation that started, so a later activation changes the price from its start", async () => {
    const rate = (credit_micros: string) => ({
      meter: "wfp.requests",
      unit: "request",
      units_per_charge: "1000",
      provider_cost_micros: null,
      credit_micros,
    });
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO published_credit_rate_cards(rate_card_id, published_at, effective_from, rates) VALUES ('usage-2026-12-v1', '2026-10-20T00:00:00.000000Z', '2026-12-01T00:00:00.000000Z', ?1)",
        )
        .bind(JSON.stringify([rate("330")])),
      control.core.prepare(
        "INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at) VALUES ('wfp.requests', 'usage-2026-12-v1', '2026-12-01T00:00:00.000000Z', '2026-10-21T00:00:00.000000Z')",
      ),
    ]);
    const requests = async (at: string) =>
      (await credit.readRates({ at })).flatMap((card) =>
        (card.rates as { meter: string; credit_micros: string }[])
          .filter((entry) => entry.meter === "wfp.requests")
          .map((entry) => [card.rateCardId, entry.credit_micros]),
      );
    // before the second activation starts the first prices the meter, from its start only the second does
    expect(await requests("2026-11-30T23:59:59.999Z")).toEqual([["usage-2026-10-v1", "300"]]);
    expect(await requests("2026-12-01T00:00:00.000Z")).toEqual([["usage-2026-12-v1", "330"]]);
    expect(await requests("2027-06-01T00:00:00.000Z")).toEqual([["usage-2026-12-v1", "330"]]);
    // the rows of a timeline are never changed
    await expect(
      control.core
        .prepare(
          "UPDATE usage_meter_activations SET rate_card_id = 'usage-2026-10-v1' WHERE meter = 'wfp.requests'",
        )
        .run(),
    ).rejects.toThrow(/append-only/u);
    await expect(
      control.core
        .prepare("DELETE FROM usage_meter_activations WHERE meter = 'wfp.requests'")
        .run(),
    ).rejects.toThrow(/never deleted/u);
    // and one start instant holds one activation of a meter
    await expect(
      control.core
        .prepare(
          "INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at) VALUES ('wfp.requests', 'usage-2026-10-v1', '2026-12-01T00:00:00.000000Z', '2026-10-21T00:00:00.000000Z')",
        )
        .run(),
    ).rejects.toThrow(/UNIQUE|PRIMARY/u);
  });
});

describe("the credit log", () => {
  let log: TestControl;
  let rotation: ReturnType<typeof createCreditCommands>;
  beforeAll(async () => {
    log = await createTestControl();
    rotation = creditOn(log.core);
  }, 120_000);
  afterAll(async () => log.dispose());

  it("pages the rows older than a day boundary and deletes what was rotated", async () => {
    const credit = rotation;
    const control = log;
    const a = await newOrganization(control);
    const b = await newOrganization(control);
    const post = (p: typeof a, window: string, charge: number) =>
      credit.postUsage({
        organizationId: p.organizationId,
        source: "wfp",
        window,
        lines: [line(p, "wfp.requests", charge)],
      });
    for (const p of [a, b])
      for (const [window, charge] of [
        ["2026-10-29T22:00:00.000Z", 1],
        ["2026-10-29T23:00:00.000Z", 2],
        ["2026-10-30T00:00:00.000Z", 3],
        ["2026-10-30T09:00:00.000Z", 4],
      ] as const)
        await post(p, window, charge);

    const midnight = "2026-10-30T00:00:00.000Z";
    const page = (afterSeq: number, limit: number) =>
      credit.readLogPage({ beforeAt: midnight, afterSeq, limit });
    const one = await page(0, 3);
    expect(one.rows).toHaveLength(3);
    expect(one.rows.every((row) => row.at < "2026-10-30T00:00:00.000Z")).toBe(true);
    expect(one.rows[0]).toMatchObject({
      kind: expect.any(String),
      organizationId: expect.any(String),
    });
    expect(one.lastSeq).toBe(one.rows[2]?.seq);
    const two = await page(one.lastSeq, 3);
    expect(two.rows).toHaveLength(1);
    const done = await page(two.lastSeq, 3);
    expect(done).toEqual({ rows: [], lastSeq: two.lastSeq });
    const aRow = one.rows.concat(two.rows).find((row) => row.organizationId === a.organizationId);
    expect(aRow).toMatchObject({
      key: expect.stringContaining("usage:wfp:") as unknown,
      kind: "usage",
      balanceMicros: expect.any(Number) as unknown,
      detail: { source: "wfp", lines: [expect.objectContaining({ meter: "wfp.requests" })] },
    });

    // the Core still holds every row until it is deleted, the old windows as well as the renewal (filed at the clock)
    // and the windows from midnight on, in the order they were posted
    const held = await credit.readLogsToday({ organizationId: a.organizationId });
    expect(held.map((row) => [row.kind, row.at])).toEqual([
      ["renew", "2026-10-30T10:07:00.000Z"],
      ["usage", "2026-10-29T22:00:00.000Z"],
      ["usage", "2026-10-29T23:00:00.000Z"],
      ["usage", "2026-10-30T00:00:00.000Z"],
      ["usage", "2026-10-30T09:00:00.000Z"],
    ]);
    expect(held.every((row) => row.organizationId === a.organizationId)).toBe(true);

    const everything = await all<{ seq: number }>(
      control.core,
      "SELECT max(seq) AS seq FROM credit_log",
    );
    const last = everything[0]?.seq ?? 0;
    const before = (
      await first<{ n: number }>(control.core, "SELECT count(*) AS n FROM credit_log")
    ).n;
    // only rows older than the boundary go, even though their sequence is below the limit
    expect(await credit.deleteLogThrough({ seq: last, beforeAt: midnight })).toEqual({
      deleted: 4,
    });
    expect(
      (await first<{ n: number }>(control.core, "SELECT count(*) AS n FROM credit_log")).n,
    ).toBe(before - 4);
    expect(await credit.deleteLogThrough({ seq: last, beforeAt: midnight })).toEqual({
      deleted: 0,
    });
    expect((await credit.readLogsToday({ organizationId: a.organizationId })).length).toBe(3);
    // a late window of yesterday posted after today's windows has a higher seq than they: a delete through its seq
    // takes only the rows before the boundary and leaves today's rows that have lower sequence numbers
    await post(a, "2026-10-29T21:00:00.000Z", 5);
    const late = (
      await first<{ seq: number }>(control.core, "SELECT max(seq) AS seq FROM credit_log")
    ).seq;
    expect(await credit.deleteLogThrough({ seq: late, beforeAt: midnight })).toEqual({
      deleted: 1,
    });
    expect((await credit.readLogsToday({ organizationId: a.organizationId })).length).toBe(3);
    // the boundary is part of the contract
    await expect(credit.deleteLogThrough({ seq: late })).rejects.toBeInstanceOf(ZodError);
    expect(
      await credit.deleteLogThrough({ seq: late, beforeAt: "2026-10-31T00:00:00.000Z" }),
    ).toEqual({
      deleted: before - 4,
    });
    expect(await credit.readLogsToday({ organizationId: a.organizationId })).toEqual([]);
    await expect(
      credit.readLogPage({ beforeAt: midnight, afterSeq: -1, limit: 10 }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      credit.readLogPage({ beforeAt: midnight, afterSeq: 0, limit: 0 }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe("listStopBudgetProjects", () => {
  let sweep: TestControl;
  let commands: ReturnType<typeof createCreditCommands>;
  const reachedAt = "2026-10-30T10:07:00.000000Z";
  let windows = 0;
  let holds = 0;
  const created: { organizationId: string; projectId: string; devEnvironmentId: string }[] = [];
  beforeAll(async () => {
    sweep = await createTestControl();
    commands = creditOn(sweep.core);
  }, 120_000);
  afterAll(async () => sweep.dispose());

  const setBudget = (
    p: { organizationId: string; projectId: string },
    budgetMicros: number,
    mode: "continue" | "stop" = "stop",
  ) =>
    sweep.core.batch(
      setProjectBudget(sweep.core, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        budgetMicros,
        mode,
        now: OCT,
      }).statements,
    );
  const spend = (
    p: { organizationId: string; projectId: string; devEnvironmentId: string },
    micros: number,
  ) => {
    windows += 1;
    return commands.postUsage({
      organizationId: p.organizationId,
      source: "wfp",
      window: `2026-10-30T09:${String(windows).padStart(2, "0")}:00.000Z`,
      lines: [
        {
          projectId: p.projectId,
          environmentId: p.devEnvironmentId,
          meter: "wfp.requests",
          quantity: "1",
          unit: "request",
          rateCardId: "usage-2026-10-v1",
          chargeMicros: micros,
        },
      ],
    });
  };
  const hold = (p: { organizationId: string; projectId: string }, micros: number) => {
    holds += 1;
    return runReserve(sweep.core, {
      organizationId: p.organizationId,
      reservationId: ulidOf("stop-hold", holds),
      projectId: p.projectId,
      amountMicros: micros,
      now: OCT,
    });
  };
  const project = async (budget: number, mode: "continue" | "stop" = "stop") => {
    const p = await newOrganization(sweep);
    created.push(p);
    await setBudget(p, budget, mode);
    return p;
  };
  const listed = async () => {
    const rows = await commands.listStopBudgetProjects();
    return new Set(rows.map((row) => `${row.organizationId}:${row.projectId}`));
  };
  const key = (p: { organizationId: string; projectId: string }) =>
    `${p.organizationId}:${p.projectId}`;

  it("lists a stop project whose budget is reached by use", async () => {
    const p = await project(1_000_000);
    await spend(p, 1_000_000);
    expect(await listed()).toContain(key(p));
  });

  it("lists a stop project whose budget is reached by its open reservations alone", async () => {
    const p = await project(1_000_000);
    await hold(p, 1_000_000);
    expect(await listed()).toContain(key(p));
  });

  it("counts a budget exactly reached, and not one micro less", async () => {
    const reached = await project(2_000_000);
    await spend(reached, 1_000_000);
    await hold(reached, 1_000_000);
    const below = await project(2_000_000);
    await spend(below, 1_000_000);
    await hold(below, 999_999);
    const current = await listed();
    expect(current).toContain(key(reached));
    expect(current).not.toContain(key(below));
  });

  it("does not list a stop project below its budget, nor a continue project far over its budget", async () => {
    const room = await project(5_000_000);
    await spend(room, 1_000_000);
    const continued = await project(1_000_000, "continue");
    await spend(continued, 5_000_000);
    const current = await listed();
    expect(current).not.toContain(key(room));
    expect(current).not.toContain(key(continued));
  });

  it("counts the use only of the current month, and the open reservations always", async () => {
    const stale = await project(1_000_000);
    await spend(stale, 1_000_000);
    await sweep.core
      .prepare("UPDATE project_credit SET period = '2026-09' WHERE project_id = ?")
      .bind(stale.projectId)
      .run();
    await hold(stale, 500_000);
    expect(await listed()).not.toContain(key(stale));
    await hold(stale, 500_000);
    expect(await listed()).toContain(key(stale));
  });

  it("does not list a deleted project with a reached budget", async () => {
    const gone = await project(1_000_000);
    await spend(gone, 1_000_000);
    expect(await listed()).toContain(key(gone));
    await sweep.core
      .prepare("UPDATE projects SET lifecycle_state = 'deleted' WHERE project_id = ?")
      .bind(gone.projectId)
      .run();
    expect(await listed()).not.toContain(key(gone));
  });

  it("agrees with the serving decision of every project, so the sweep and the guard cannot drift", async () => {
    const current = await listed();
    for (const p of created) {
      const decision = await readRuntimeDecision(sweep.core, {
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.devEnvironmentId,
        now: reachedAt,
      });
      expect(current.has(key(p))).toBe(decision.reason === "project_budget_exceeded");
    }
  });

  it("returns exactly the organization and the project of each row, and at most fifty rows", async () => {
    const rows = await commands.listStopBudgetProjects();
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual(["organizationId", "projectId"]);
    for (let index = 0; index < 51; index += 1) {
      const p = await project(1_000_000);
      await spend(p, 1_000_000);
    }
    const capped = await commands.listStopBudgetProjects();
    expect(capped).toHaveLength(50);
    expect(new Set(capped.map(key)).size).toBe(50);
  });
});

describe("listCreditDeniedProjects", () => {
  // The credit clock of this file is 2026-10-30T10:07:00Z; the grace of 7 days ends 2026-11-06T10:07:00Z.
  const NOW = "2026-10-30T10:07:00.000000Z";
  const DAYS_AGO = (days: number) =>
    new Date(Date.parse(NOW) - days * 86_400_000).toISOString().replace(".000Z", ".000000Z");
  const key = (p: { organizationId: string; projectId: string }) =>
    `${p.organizationId}:${p.projectId}`;
  const listed = async () => new Set((await credit.listCreditDeniedProjects()).map(key));
  const account = async (
    organizationId: string,
    row: {
      monthlyEndsAt?: string;
      monthly?: number;
      onetime?: number;
      reserved?: number;
      exhaustedAt: string | null;
      overrun?: number;
      overrunBase?: number;
    },
  ) => {
    await control.core.batch([ensureStatement(control.core, organizationId, NOW)]);
    await control.core
      .prepare(
        "UPDATE credit_account SET monthly_micros = ?2, monthly_ends_at = ?3, onetime_micros = ?4, reserved_micros = ?5, exhausted_at = ?6, overrun_micros = ?7, overrun_base_micros = ?8 WHERE organization_id = ?1",
      )
      .bind(
        organizationId,
        row.monthly ?? 0,
        row.monthlyEndsAt ?? "2026-11-01T00:00:00.000000Z",
        row.onetime ?? 0,
        row.reserved ?? 0,
        row.exhaustedAt,
        row.overrun ?? 0,
        row.overrunBase ?? 0,
      )
      .run();
  };
  const project = async (row: Parameters<typeof account>[1]) => {
    const p = await newOrganization(control);
    await account(p.organizationId, row);
    return p;
  };

  it("lists a project whose grace lapsed with no credit left and no renewal pending", async () => {
    const p = await project({ exhaustedAt: DAYS_AGO(8) });
    expect(await listed()).toContain(key(p));
  });

  it("lists a project whose grace lapsed exactly seven days after exhaustion", async () => {
    const p = await project({ exhaustedAt: DAYS_AGO(7) });
    expect(await listed()).toContain(key(p));
  });

  it("does not list a project still inside its grace", async () => {
    const p = await project({ exhaustedAt: DAYS_AGO(6) });
    expect(await listed()).not.toContain(key(p));
  });

  it("does not list a project whose monthly renewal is pending", async () => {
    const p = await project({
      exhaustedAt: DAYS_AGO(8),
      monthlyEndsAt: "2026-10-01T00:00:00.000000Z",
    });
    expect(await listed()).not.toContain(key(p));
  });

  it("does not list a project that still has credit, and counts the open reservations against it", async () => {
    const funded = await project({ exhaustedAt: DAYS_AGO(8), monthly: 1_000_000 });
    const reserved = await project({
      exhaustedAt: DAYS_AGO(8),
      monthly: 1_000_000,
      reserved: 1_000_000,
    });
    const current = await listed();
    expect(current).not.toContain(key(funded));
    expect(current).toContain(key(reserved));
  });

  it("lists an organization with no balance at the overrun ceiling of its month, with no grace to wait for", async () => {
    const at = await project({
      exhaustedAt: null,
      overrun: OVERRUN_CEILING_MICROS,
      overrunBase: 0,
    });
    const below = await project({
      exhaustedAt: null,
      overrun: OVERRUN_CEILING_MICROS - 1,
      overrunBase: 0,
    });
    const earlier = await project({
      exhaustedAt: null,
      overrun: OVERRUN_CEILING_MICROS * 2,
      overrunBase: OVERRUN_CEILING_MICROS * 2 - 1,
    });
    const funded = await project({
      exhaustedAt: null,
      monthly: credits(10),
      overrun: OVERRUN_CEILING_MICROS,
      overrunBase: 0,
    });
    const current = await listed();
    expect(current).toContain(key(at));
    expect(current).not.toContain(key(below));
    expect(current).not.toContain(key(earlier));
    expect(current).not.toContain(key(funded));
  });

  it("returns exactly the organization and the project of each row, and at most fifty rows", async () => {
    const rows = await credit.listCreditDeniedProjects();
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual(["organizationId", "projectId"]);
    expect(rows.length).toBeLessThanOrEqual(50);
  });
});
