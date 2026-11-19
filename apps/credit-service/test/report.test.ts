import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { REPORT_MAX_RANGE_MS, parseUsageQuery, readUsage } from "../src/report.js";
import { rotateCreditLog, shardKey, shardOf } from "../src/rotation.js";
import { world, type World } from "./doubles.js";

const THROUGH_TODAY = "2026-10-30T09:00:00.000Z";

/** Rows of two organizations over three days, the first two days rotated to R2, today's rows still in the Core. */
async function archive(): Promise<World> {
  const w = world();
  for (const source of ["wfp", "pgcf", "r2", "resources"])
    w.core.cursors.set(source, THROUGH_TODAY);
  w.core.addRow("org_1", "2026-10-28T10:00:00.000Z", "grant", "grant:a");
  w.core.addRow("org_2", "2026-10-28T11:00:00.000Z", "grant", "grant:other");
  w.core.addRow("org_1", "2026-10-29T10:00:00.000Z", "usage", "usage:b");
  w.core.addRow("org_1", "2026-10-29T10:00:00.000Z", "reserve", "reserve:c");
  w.core.addRow("org_2", "2026-10-29T12:00:00.000Z", "usage", "usage:other");
  await rotateCreditLog(w.deps);
  w.core.addRow("org_1", "2026-10-30T08:00:00.000Z", "settle", "settle:today");
  return w;
}
const query = (overrides: Record<string, unknown> = {}) => ({
  organizationId: "org_1",
  from: "2026-10-28T00:00:00.000Z",
  to: "2026-10-30T09:20:00.000Z",
  ...overrides,
});

describe("readUsage", () => {
  it("returns the organization's rotated days and today's rows, oldest first", async () => {
    const w = await archive();
    const rows = await readUsage(w.deps, query());
    expect(rows.map((row) => row.key)).toEqual(["grant:a", "usage:b", "reserve:c", "settle:today"]);
    expect(rows.every((row) => row.organizationId === "org_1")).toBe(true);
    expect(rows[0]).toMatchObject({ kind: "grant", deltaMicros: 5, balanceMicros: 100 });
  });

  it("reads the Core first, then at most one shard object per rotated day", async () => {
    const w = await archive();
    w.core.calls.length = 0;
    const get = w.creditLog.get.bind(w.creditLog);
    const objects: string[] = [];
    w.creditLog.get = async (key) => {
      w.core.calls.push("r2");
      objects.push(key);
      return get(key);
    };
    await readUsage(w.deps, query());
    expect(w.core.calls).toEqual(["readLogsToday", "r2", "r2"]);
    const shard = await shardOf("org_1");
    expect(objects.sort()).toEqual([shardKey("2026-10-28", shard), shardKey("2026-10-29", shard)]);
  });

  it("filters to the half open range", async () => {
    const w = await archive();
    const middle = await readUsage(
      w.deps,
      query({ from: "2026-10-29T10:00:00.000Z", to: "2026-10-30T08:00:00.000Z" }),
    );
    expect(middle.map((row) => row.key)).toEqual(["usage:b", "reserve:c"]);
    expect(await readUsage(w.deps, query({ from: "2026-10-30T00:00:00.000Z" }))).toHaveLength(1);
  });

  it("merges a row that is both archived and still in the Core, as during a rotation", async () => {
    const w = world();
    for (const source of ["wfp", "pgcf", "r2", "resources"])
      w.core.cursors.set(source, THROUGH_TODAY);
    w.core.addRow("org_1", "2026-10-29T10:00:00.000Z", "usage", "usage:b");
    w.core.failOn = (method) => method === "deleteLogThrough";
    await expect(rotateCreditLog(w.deps)).rejects.toThrow();
    const rows = await readUsage(w.deps, query());
    expect(rows.map((row) => row.key)).toEqual(["usage:b"]);
  });

  it("treats a missing shard as an empty day and orders equal times by sequence", async () => {
    const w = world();
    w.core.addRow("org_1", "2026-10-30T01:00:00.000Z", "usage", "usage:2");
    w.core.addRow("org_1", "2026-10-30T01:00:00.000Z", "usage", "usage:1");
    w.core.addRow("org_1", "2026-10-30T00:30:00.000Z", "usage", "usage:0");
    const rows = await readUsage(w.deps, query());
    expect(rows.map((row) => row.key)).toEqual(["usage:0", "usage:2", "usage:1"]);
  });

  it("reads one shard per archived day of a maximal range", async () => {
    const w = world();
    const reads: string[] = [];
    w.creditLog.get = async (key) => {
      reads.push(key);
      return null;
    };
    const to = Date.UTC(2026, 9, 30, 9, 20);
    expect(
      await readUsage(w.deps, query({ from: new Date(to - REPORT_MAX_RANGE_MS).toISOString() })),
    ).toEqual([]);
    expect(reads).toHaveLength(14);
    expect(reads[0]).toContain("credit-log/2026-10-16/");
    expect(reads.at(-1)).toContain("credit-log/2026-10-29/");
  });

  it("refuses an archive line that is not a log row", async () => {
    const w = await archive();
    const shard = await shardOf("org_1");
    w.creditLog.seed(shardKey("2026-10-29", shard), gzipSync('{"seq":1}\n'));
    await expect(readUsage(w.deps, query())).rejects.toThrow("credit_log_corrupt");
  });
});

describe("parseUsageQuery", () => {
  it("accepts a bounded range and refuses everything else", () => {
    expect(parseUsageQuery(query())).toEqual({
      organizationId: "org_1",
      from: Date.UTC(2026, 9, 28),
      to: Date.UTC(2026, 9, 30, 9, 20),
    });
    const invalid = "credit_service_usage_query_invalid";
    for (const value of [null, [], "x", 1]) expect(() => parseUsageQuery(value)).toThrow(invalid);
    for (const change of [
      { organizationId: "" },
      { organizationId: "o".repeat(129) },
      { organizationId: 5 },
      { from: "2026-10-28" },
      { from: "2026-10-28T00:00:00Z" },
      { from: 5 },
      { to: "2026-10-28T00:00:00.000Z" },
      { to: "2026-11-30T00:00:00.000Z" },
      { extra: true },
    ])
      expect(() => parseUsageQuery(query(change))).toThrow(invalid);
    const partial = { organizationId: "org_1", from: "2026-10-28T00:00:00.000Z" };
    expect(() => parseUsageQuery(partial)).toThrow(invalid);
  });
});
