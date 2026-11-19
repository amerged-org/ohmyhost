import type { PgcfUsageRow } from "@ohmyhost/provider-pgcf";
import { describe, expect, it } from "vitest";

import { readPgcfRollups } from "../src/pgcf-rollups.js";

const PROJECT = "prj_abcdefghij0123456789",
  DB_A = "aaaaaaaaaaaaaaaaaaaa",
  DB_B = "bbbbbbbbbbbbbbbbbbbb",
  HOUR = 3_600_000,
  // The newest final hour ended at 10:00: two hours before the clock's hour.
  NOW = new Date("2026-10-30T12:30:00.000Z"),
  FROM = "2026-10-30T06:00:00.000Z",
  TO = "2026-10-30T10:00:00.000Z";
const hour = (offset: number) => new Date(Date.parse(FROM) + offset * HOUR).toISOString();
const row = (databaseId: string, offset: number, overrides: Partial<PgcfUsageRow> = {}) => ({
  databaseId,
  projectId: PROJECT,
  start: hour(offset),
  end: hour(offset + 1),
  final: true,
  metrics: { memory_mib_seconds: 512 * 3600, cpu_seconds: 3 },
  gaps: [] as string[],
  ...overrides,
});

type ReadUsage = (input: {
  from: string;
  to: string;
  cursor?: string;
  signal?: AbortSignal;
}) => Promise<{ rows: readonly PgcfUsageRow[]; nextCursor: string | null }>;
/** Serves the given pages in order; the cursor of page n is `p<n>`. */
function pages(...served: (readonly PgcfUsageRow[])[]) {
  const calls: Parameters<ReadUsage>[0][] = [];
  const readUsage: ReadUsage = async (input) => {
    calls.push(input);
    const index = input.cursor === undefined ? 0 : Number(input.cursor.slice(1));
    return {
      rows: served[index] ?? [],
      nextCursor: index + 1 < served.length ? `p${index + 1}` : null,
    };
  };
  return { calls, provider: { readUsage } };
}
const read = (
  provider: { readUsage: ReadUsage },
  overrides: Partial<Parameters<typeof readPgcfRollups>[0]> = {},
) =>
  readPgcfRollups({
    provider,
    providerProjectId: PROJECT,
    from: FROM,
    to: TO,
    now: NOW,
    ...overrides,
  });

describe("readPgcfRollups", () => {
  it("returns the final memory hours of every page in hour and database order and reports the rest", async () => {
    const served = pages(
      [row(DB_B, 1, { metrics: { memory_mib_seconds: 256 * 3600 } }), row(DB_A, 1)],
      [
        row(DB_B, 0, { metrics: { memory_mib_seconds: 1.5 } }),
        row(DB_A, 0, { metrics: { memory_mib_seconds: 0 } }),
        row(DB_A, 2, { final: false }),
      ],
      [
        row(DB_B, 3, { final: false }),
        // Unrelated gaps are evidence only; blocking gaps and a missing quantity are skipped, never zero.
        row(DB_B, 2, { gaps: ["storage_gib_seconds", "traffic"] }),
        row(DB_A, 3, { gaps: ["lifecycle"] }),
      ],
    );
    expect(await read(served.provider)).toEqual({
      from: FROM,
      to: TO,
      rollups: [
        { databaseId: DB_A, hourStart: hour(0), memoryMibMilliseconds: "0" },
        { databaseId: DB_B, hourStart: hour(0), memoryMibMilliseconds: "1500" },
        { databaseId: DB_A, hourStart: hour(1), memoryMibMilliseconds: "1843200000" },
        { databaseId: DB_B, hourStart: hour(1), memoryMibMilliseconds: "921600000" },
        { databaseId: DB_B, hourStart: hour(2), memoryMibMilliseconds: "1843200000" },
      ],
      pending: [
        { databaseId: DB_A, hourStart: hour(2) },
        { databaseId: DB_B, hourStart: hour(3) },
      ],
      unbillableHours: 1,
    });
    expect(served.calls.map((call) => call.cursor)).toEqual([undefined, "p1", "p2"]);
    for (const call of served.calls) {
      expect([call.from, call.to]).toEqual([FROM, TO]);
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("skips final hours without a usable memory quantity and counts them", async () => {
    const served = pages([
      row(DB_A, 0, { metrics: { memory_mib_seconds: null } }),
      row(DB_A, 1, { metrics: { cpu_seconds: 3 } }),
      row(DB_A, 2, { gaps: ["memory_mib_seconds"] }),
      row(DB_A, 3, { gaps: ["resource_snapshot"] }),
      row(DB_B, 3),
    ]);
    expect(await read(served.provider)).toEqual({
      from: FROM,
      to: TO,
      rollups: [{ databaseId: DB_B, hourStart: hour(3), memoryMibMilliseconds: "1843200000" }],
      pending: [],
      unbillableHours: 4,
    });
  });

  it("reports every unfinalized row sorted by hour and database whatever the page order and accepts an empty window", async () => {
    const unfinished = pages(
      [row(DB_B, 3, { final: false }), row(DB_A, 3, { final: false })],
      [row(DB_B, 1, { final: false })],
    );
    expect(await read(unfinished.provider)).toMatchObject({
      rollups: [],
      pending: [
        { databaseId: DB_B, hourStart: hour(1) },
        { databaseId: DB_A, hourStart: hour(3) },
        { databaseId: DB_B, hourStart: hour(3) },
      ],
    });
    expect(await read(pages().provider)).toEqual({
      from: FROM,
      to: TO,
      rollups: [],
      pending: [],
      unbillableHours: 0,
    });
  });

  it("lists a retired database that never finalizes next to the final rows of the live ones", async () => {
    const retired = "rcm9bvrgrcm9bvrgrcm9";
    const never = (offset: number) =>
      row(retired, offset, { final: false, metrics: {}, gaps: ["rollup_pending"] });
    const served = pages(
      [row(DB_A, 0), row(DB_A, 1), never(1)],
      [never(0), row(DB_B, 0), row(DB_B, 2), never(3), never(2)],
      [row(DB_A, 2), row(DB_A, 3), row(DB_B, 1), row(DB_B, 3)],
    );
    const result = await read(served.provider);
    expect(result.pending).toEqual(
      [0, 1, 2, 3].map((n) => ({ databaseId: retired, hourStart: hour(n) })),
    );
    expect(result.rollups.map((rollup) => [rollup.hourStart, rollup.databaseId])).toEqual(
      [0, 1, 2, 3].flatMap((n) => [
        [hour(n), DB_A],
        [hour(n), DB_B],
      ]),
    );
    // A row that is not final is pending, whatever its gaps say; it is never an unbillable final hour.
    expect(result.unbillableHours).toBe(0);
  });

  it("refuses more unfinalized rows than one day of a thousand databases instead of dropping any", async () => {
    const day = (databases: number) =>
      Array.from({ length: 24 }, (_, offset) =>
        Array.from({ length: databases }, (_unused, index) =>
          row(String(index).padStart(20, "d"), offset - 20, { final: false }),
        ),
      ).flat();
    const window = { from: "2026-10-29T10:00:00.000Z" };
    expect((await read(pages(day(1000)).provider, window)).pending).toHaveLength(24_000);
    await expect(read(pages(day(1001)).provider, window)).rejects.toThrow(
      "PGCF usage has too many unfinalized rows",
    );
  });

  it("counts one hour reported twice with the same content once and refuses a changed report", async () => {
    const base = row(DB_A, 0, { metrics: { memory_mib_seconds: 10, cpu_seconds: 1 } });
    const same = pages([base], [{ ...base, metrics: { cpu_seconds: 1, memory_mib_seconds: 10 } }]);
    expect((await read(same.provider)).rollups).toHaveLength(1);
    for (const changed of [
      { ...base, final: false },
      { ...base, metrics: { ...base.metrics, memory_mib_seconds: 11 } },
      { ...base, gaps: ["lifecycle"] },
    ])
      await expect(read(pages([base], [changed]).provider)).rejects.toThrow(
        "PGCF usage changed within one read",
      );
  });

  it.each([
    ["below the millisecond quantum", 0.0004],
    ["not a finite number", Number.NaN],
    ["negative", -1],
    ["more than a full hour of the largest size", 4096 * 3600 + 1],
  ])("rejects a memory quantity that is %s", async (_label, seconds) => {
    await expect(
      read(pages([row(DB_A, 0, { metrics: { memory_mib_seconds: seconds } })]).provider),
    ).rejects.toThrow("exact millisecond quantum");
  });

  it("accepts the largest hour exactly", async () => {
    const result = await read(
      pages([row(DB_A, 0, { metrics: { memory_mib_seconds: 4096 * 3600 } })]).provider,
    );
    expect(result.rollups[0]?.memoryMibMilliseconds).toBe((4096n * 3_600_000n).toString());
  });

  it.each([
    ["another project", { projectId: "prj_zzzzzzzzzzzzzzzzzzzz" }],
    ["an hour before the window", { start: hour(-1), end: hour(0) }],
    ["an hour after the window", { start: hour(4), end: hour(5) }],
    ["an unaligned hour", { start: hour(0).replace(":00:00", ":30:00"), end: hour(1) }],
    ["a span other than one hour", { end: hour(2) }],
  ])("refuses a row of %s", async (_label, overrides) => {
    await expect(read(pages([row(DB_A, 0, overrides)]).provider)).rejects.toThrow(
      "PGCF usage page returned foreign scope",
    );
  });

  it("refuses a repeated cursor", async () => {
    const loop: ReadUsage = async () => ({ rows: [], nextCursor: "again" });
    await expect(read({ readUsage: loop })).rejects.toThrow("PGCF usage cursor repeated");
  });

  describe("window and budget validation", () => {
    it.each([
      ["a start that is not on the hour", "2026-10-30T06:30:00.000Z", TO],
      ["an end that is not on the hour", FROM, "2026-10-30T09:59:00.000Z"],
      ["a timestamp without milliseconds", "2026-10-30T06:00:00Z", TO],
      ["a timestamp that is no time", "yesterday", TO],
      ["an empty window", FROM, FROM],
      ["a reversed window", TO, FROM],
      ["a window longer than 24 hours", "2026-10-29T08:00:00.000Z", TO],
      ["an end that is not yet final", FROM, "2026-10-30T11:00:00.000Z"],
    ])("refuses %s without asking the provider", async (_label, from, to) => {
      const served = pages([row(DB_A, 0)]);
      await expect(read(served.provider, { from, to })).rejects.toThrow(TypeError);
      expect(served.calls).toEqual([]);
    });

    it("refuses an invalid clock", async () => {
      await expect(read(pages().provider, { now: new Date(Number.NaN) })).rejects.toThrow(
        TypeError,
      );
    });

    it("accepts exactly 24 hours ending exactly two hours before the clock hour", async () => {
      const served = pages();
      expect(await read(served.provider, { from: "2026-10-29T10:00:00.000Z" })).toMatchObject({
        from: "2026-10-29T10:00:00.000Z",
        to: TO,
      });
      expect(served.calls).toHaveLength(1);
    });

    it.each([0, -1, 1.5, 45_001])("refuses the budget %s", async (budgetMs) => {
      const served = pages();
      await expect(read(served.provider, { budgetMs })).rejects.toThrow(
        "Invalid PGCF usage budget",
      );
      expect(served.calls).toEqual([]);
    });
  });

  describe("time budget and cancellation", () => {
    /** A provider that only ends when its signal aborts, like a hanging connection. */
    const hanging: ReadUsage = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    it("does not call the provider after the caller aborted", async () => {
      const served = pages();
      await expect(read(served.provider, { signal: AbortSignal.abort() })).rejects.toThrow(
        "exceeded its budget or was aborted",
      );
      expect(served.calls).toEqual([]);
    });

    it("ends a hanging page with the remaining budget", async () => {
      await expect(read({ readUsage: hanging }, { budgetMs: 20 })).rejects.toMatchObject({
        name: "TimeoutError",
      });
    });

    it("hands the caller's abort to the page in flight", async () => {
      const controller = new AbortController(),
        reason = new Error("caller gave up");
      setTimeout(() => controller.abort(reason), 5);
      await expect(read({ readUsage: hanging }, { signal: controller.signal })).rejects.toBe(
        reason,
      );
    });

    it("stops before the next page once the budget is spent", async () => {
      let calls = 0;
      const slow: ReadUsage = async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { rows: [], nextCursor: `p${calls}` };
      };
      await expect(read({ readUsage: slow }, { budgetMs: 5 })).rejects.toThrow(
        "exceeded its budget or was aborted",
      );
      expect(calls).toBe(1);
    });

    it("stops before the next page once the caller aborted meanwhile", async () => {
      const controller = new AbortController();
      let calls = 0;
      const page: ReadUsage = async () => {
        calls++;
        controller.abort();
        return { rows: [], nextCursor: `p${calls}` };
      };
      await expect(read({ readUsage: page }, { signal: controller.signal })).rejects.toThrow(
        "exceeded its budget or was aborted",
      );
      expect(calls).toBe(1);
    });
  });
});
