import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ROTATION_MEMORY_BUDGET,
  ROTATION_PAGE,
  manifestKey,
  planGroups,
  rotateCreditLog,
  rowLine,
  shardKey,
  shardOf,
} from "../src/rotation.js";
import { world, type World } from "./doubles.js";

const expectedShard = (organizationId: string) =>
  createHash("sha256").update(organizationId).digest("hex").slice(0, 2);
const THROUGH_TODAY = "2026-10-30T09:00:00.000Z";

/** Three organizations, rows on two days before today and two rows of today that must stay in the Core. */
function seeded(): World {
  const w = world();
  for (const source of ["wfp", "pgcf", "r2", "resources"])
    w.core.cursors.set(source, THROUGH_TODAY);
  const orgs = ["org_1", "org_2", "org_3"];
  w.core.addRow("org_1", "2026-10-28T23:59:59.999Z", "grant");
  for (let index = 0; index < 6; index++)
    w.core.addRow(
      orgs[index % 3] as string,
      `2026-10-29T${String(index + 1).padStart(2, "0")}:00:00.000Z`,
      "usage",
    );
  w.core.addRow("org_2", "2026-10-30T08:00:00.000Z", "reserve");
  w.core.addRow("org_3", "2026-10-30T08:30:00.000Z", "settle");
  return w;
}
const bytesOf = (w: World, key: string): Uint8Array => {
  const object = w.creditLog.objects.get(key);
  if (object === undefined) throw new Error(`missing object ${key}`);
  return object.bytes;
};
const sameBytes = (left: World, right: World, key: string): boolean =>
  Buffer.from(bytesOf(left, key)).equals(Buffer.from(bytesOf(right, key)));
const plain = (w: World, key: string) => {
  const bytes = bytesOf(w, key);
  return (key.endsWith(".gz") ? gunzipSync(bytes) : Buffer.from(bytes)).toString("utf8");
};
const archived = (w: World) =>
  [...w.creditLog.objects.keys()].filter((key) => key.endsWith(".ndjson.gz")).sort();

describe("shards", () => {
  it("name an organization's shard by the first byte of SHA-256 of its id", async () => {
    for (const id of ["org_1", "org_2", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "ünïcode"])
      expect(await shardOf(id)).toBe(expectedShard(id));
    expect(shardKey("2026-10-29", "ab")).toBe("credit-log/2026-10-29/ab.ndjson.gz");
    expect(manifestKey("2026-10-29")).toBe("credit-log/2026-10-29/manifest.json");
    expect(ROTATION_PAGE).toBeGreaterThan(0);
    expect(ROTATION_MEMORY_BUDGET).toBeGreaterThan(1024 * 1024);
  });

  it("serializes a row with a fixed field order", () => {
    expect(
      rowLine({
        seq: 7,
        key: "grant:1",
        at: "2026-10-29T01:00:00.000Z",
        organizationId: "org_1",
        kind: "grant",
        deltaMicros: 5,
        balanceMicros: 9,
        detail: undefined,
      }),
    ).toBe(
      '{"seq":7,"key":"grant:1","at":"2026-10-29T01:00:00.000Z","organizationId":"org_1","kind":"grant","deltaMicros":5,"balanceMicros":9,"detail":null}',
    );
  });

  it("packs groups into passes of at most the budget, a larger group standing alone", () => {
    const sizes = new Map([
      ["d/00", 40],
      ["d/01", 40],
      ["d/02", 150],
      ["d/03", 10],
    ]);
    expect(planGroups(sizes, 100)).toEqual([["d/00", "d/01"], ["d/02"], ["d/03"]]);
    expect(planGroups(new Map(), 100)).toEqual([]);
  });
});

describe("rotateCreditLog", () => {
  it("waits while a usage source has not billed up to today's midnight", async () => {
    const w = seeded();
    w.core.cursors.set("wfp", "2026-10-29T23:00:00.000Z");
    const report = await rotateCreditLog(w.deps);
    expect(report).toMatchObject({ status: "waiting", blocking: ["wfp"] });
    expect(w.core.calls).not.toContain("readLogPage");
    expect(w.creditLog.objects.size).toBe(0);
    expect(w.core.rows).toHaveLength(9);
  });

  it("archives every row before today in per-day shards with a manifest, then deletes them", async () => {
    const w = seeded();
    const before = structuredClone(w.core.rows);

    const report = await rotateCreditLog(w.deps);

    expect(report).toMatchObject({
      status: "rotated",
      days: ["2026-10-28", "2026-10-29"],
      rows: 7,
      deleted: 7,
      problems: [],
    });
    expect(w.core.rows.map((row) => row.at)).toEqual([
      "2026-10-30T08:00:00.000Z",
      "2026-10-30T08:30:00.000Z",
    ]);

    const shards29 = ["org_1", "org_2", "org_3"].map((org) => expectedShard(org));
    expect(archived(w)).toEqual(
      [...new Set([expectedShard("org_1"), ...shards29].map((shard) => shard))]
        .flatMap((shard) => [
          `credit-log/2026-10-28/${shard}.ndjson.gz`,
          `credit-log/2026-10-29/${shard}.ndjson.gz`,
        ])
        .filter((key) => w.creditLog.objects.has(key))
        .sort(),
    );
    // Every archived line is the original row, in sequence order, in the shard of its organization.
    const lines = archived(w).flatMap((key) =>
      plain(w, key)
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => ({ key, row: JSON.parse(line) as (typeof before)[number] })),
    );
    expect(lines.map(({ row }) => row).sort((a, b) => a.seq - b.seq)).toEqual(before.slice(0, 7));
    for (const { key, row } of lines) {
      expect(key).toBe(
        `credit-log/${row.at.slice(0, 10)}/${expectedShard(row.organizationId)}.ndjson.gz`,
      );
    }

    const manifest = JSON.parse(plain(w, manifestKey("2026-10-29"))) as {
      version: number;
      day: string;
      rows: number;
      shards: Record<string, { count: number; sha256: string }>;
    };
    expect(w.creditLog.objects.has(manifestKey("2026-10-28"))).toBe(true);
    expect(manifest).toMatchObject({ version: 1, day: "2026-10-29", rows: 6 });
    for (const [shard, entry] of Object.entries(manifest.shards)) {
      const text = plain(w, shardKey("2026-10-29", shard));
      expect(entry.count).toBe(text.split("\n").length - 1);
      expect(entry.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    }
    // Delete is the very last Core call.
    expect(w.core.calls.at(-1)).toBe("deleteLogThrough");
  });

  it("writes identical bytes for identical rows", async () => {
    const first = seeded();
    const second = seeded();
    await rotateCreditLog(first.deps);
    await rotateCreditLog(second.deps);
    expect([...first.creditLog.objects.keys()].sort()).toEqual(
      [...second.creditLog.objects.keys()].sort(),
    );
    for (const key of first.creditLog.objects.keys())
      expect(sameBytes(second, first, key)).toBe(true);
  });

  it("has nothing to do once the log is rotated", async () => {
    const w = seeded();
    await rotateCreditLog(w.deps);
    const puts = w.creditLog.puts.length;
    expect(await rotateCreditLog(w.deps)).toMatchObject({ status: "empty", rows: 0 });
    expect(w.creditLog.puts).toHaveLength(puts);
  });

  it("resumes a crashed rotation without duplicate or lost rows", async () => {
    const clean = seeded();
    await rotateCreditLog(clean.deps);

    const w = seeded();
    let puts = 0;
    w.creditLog.failPut = () => ++puts === 3;
    await expect(rotateCreditLog(w.deps)).rejects.toThrow("put failed");
    expect(w.core.rows).toHaveLength(9);
    expect(w.core.calls).not.toContain("deleteLogThrough");
    expect(w.creditLog.objects.size).toBe(2);

    w.creditLog.failPut = undefined;
    const resumed = await rotateCreditLog(w.deps);

    expect(resumed).toMatchObject({ status: "rotated", existing: 2, rows: 7, deleted: 7 });
    expect([...w.creditLog.objects.keys()].sort()).toEqual(
      [...clean.creditLog.objects.keys()].sort(),
    );
    for (const key of clean.creditLog.objects.keys()) expect(sameBytes(w, clean, key)).toBe(true);
    expect(w.core.rows).toHaveLength(2);
  });

  it("resumes when only the delete failed", async () => {
    const w = seeded();
    w.core.failOn = (method) => method === "deleteLogThrough";
    await expect(rotateCreditLog(w.deps)).rejects.toThrow("deleteLogThrough failed");
    const objects = w.creditLog.objects.size;

    w.core.failOn = undefined;
    const resumed = await rotateCreditLog(w.deps);

    expect(resumed).toMatchObject({ status: "rotated", created: 0, deleted: 7 });
    expect(resumed.existing).toBe(objects);
    expect(w.core.rows).toHaveLength(2);
  });

  it("stops before deleting when an existing object holds different content", async () => {
    const w = seeded();
    const shard = expectedShard("org_1");
    w.creditLog.seed(shardKey("2026-10-29", shard), gzipSync("something else\n"));
    await expect(rotateCreditLog(w.deps)).rejects.toThrow(
      `credit_log_object_conflict:${shardKey("2026-10-29", shard)}`,
    );
    expect(w.core.rows).toHaveLength(9);

    const manifestConflict = seeded();
    manifestConflict.creditLog.seed(manifestKey("2026-10-29"), "{}");
    await expect(rotateCreditLog(manifestConflict.deps)).rejects.toThrow(
      "credit_log_object_conflict",
    );
    expect(manifestConflict.core.rows).toHaveLength(9);
  });

  it("fails the read-back before deleting when a stored shard does not match its manifest", async () => {
    const w = seeded();
    w.creditLog.tamper = (key, bytes) =>
      key.endsWith(".ndjson.gz") && key.includes("2026-10-29") ? gzipSync("{}\n") : bytes;
    await expect(rotateCreditLog(w.deps)).rejects.toThrow("credit_log_readback_mismatch");
    expect(w.core.rows).toHaveLength(9);

    const vanished = seeded();
    const get = vanished.creditLog.get.bind(vanished.creditLog);
    let reads = 0;
    vanished.creditLog.get = async (key) => (++reads > 0 && key.endsWith(".gz") ? null : get(key));
    await expect(rotateCreditLog(vanished.deps)).rejects.toThrow("credit_log_object_missing");
  });

  it("rotates a log larger than the memory budget in several passes with the same result", async () => {
    const single = seeded();
    await rotateCreditLog(single.deps);

    const w = seeded();
    const report = await rotateCreditLog(w.deps, { memoryBudget: 300, pageSize: 2 });

    expect(report).toMatchObject({ status: "rotated", rows: 7, deleted: 7 });
    // The scan plus one pass per group.
    expect(w.core.calls.filter((call) => call === "readLogPage").length).toBeGreaterThan(8);
    for (const key of single.creditLog.objects.keys()) expect(sameBytes(w, single, key)).toBe(true);
  });

  it("never archives or deletes rows that appear after the scan", async () => {
    const w = seeded();
    let pages = 0;
    w.core.failOn = (method) => {
      if (method === "readLogPage" && ++pages === 5)
        w.core.addRow("org_9", "2026-10-29T23:00:00.000Z", "usage", "usage:late");
      return false;
    };
    const report = await rotateCreditLog(w.deps, { memoryBudget: 300, pageSize: 2 });
    expect(report).toMatchObject({ rows: 7, deleted: 7, problems: [] });
    expect(w.core.rows.map((row) => row.key)).toContain("usage:late");
    const text = [...w.creditLog.objects.keys()]
      .map((key) => (key.endsWith(".gz") ? plain(w, key) : ""))
      .join("");
    expect(text).not.toContain("usage:late");
  });

  it("keeps a window of today that was posted before a late window of yesterday", async () => {
    const w = seeded();
    const line = {
      projectId: "prj_1",
      environmentId: "env_prod",
      meter: "wfp.requests",
      quantity: "1",
      unit: "request",
      rateCardId: "usage-test",
      chargeMicros: 1,
    };
    // seq is the order of posting: the first window of today gets a lower seq than the last window of yesterday,
    // which the slow PGCF rollup posts after it
    await w.core.postUsage({
      organizationId: "org_1",
      source: "wfp",
      window: "2026-10-30T00:00:00.000Z",
      lines: [line],
    });
    await w.core.postUsage({
      organizationId: "org_1",
      source: "pgcf",
      window: "2026-10-29T23:00:00.000Z",
      lines: [line],
    });
    let deletion: unknown;
    w.core.failOn = (method, input) => {
      if (method === "deleteLogThrough") deletion = input;
      return false;
    };
    const report = await rotateCreditLog(w.deps);
    expect(report).toMatchObject({ status: "rotated", rows: 8, deleted: 8, problems: [] });
    expect(deletion).toEqual({ seq: expect.any(Number), beforeAt: "2026-10-30T00:00:00.000Z" });
    expect(w.core.rows.map((row) => row.key)).toContain("usage:wfp:org_1:2026-10-30T00:00:00.000Z");
    expect(w.core.rows).toHaveLength(3);
    // and the window of yesterday is archived under yesterday
    const text = plain(w, shardKey("2026-10-29", expectedShard("org_1")));
    expect(text).toContain("usage:pgcf:org_1:2026-10-29T23:00:00.000Z");
    expect(text).not.toContain("usage:wfp:org_1:2026-10-30T00:00:00.000Z");
  });

  it("reports a delete that removed another number of rows than were archived", async () => {
    const w = seeded();
    w.core.deleteLogThrough = async () => ({ deleted: 9 });
    expect((await rotateCreditLog(w.deps)).problems).toEqual(["credit_log_deleted:9/7"]);
  });

  it("refuses corrupt input instead of guessing", async () => {
    const badRow = seeded();
    badRow.core.addRow("org_1", "yesterday", "usage", "usage:bad");
    const last = badRow.core.rows.at(-1);
    if (last !== undefined) last.at = "2026-10-29";
    await expect(rotateCreditLog(badRow.deps)).rejects.toThrow("credit_log_row_invalid");

    const stalled = seeded();
    stalled.core.readLogPage = async (i) => ({
      rows: stalled.core.rows.slice(0, 2),
      lastSeq: i.afterSeq,
    });
    await expect(rotateCreditLog(stalled.deps, { pageSize: 2 })).rejects.toThrow(
      "credit_log_page_stalled",
    );

    const vanishing = seeded();
    const read = vanishing.core.readLogPage.bind(vanishing.core);
    let calls = 0;
    vanishing.core.readLogPage = async (i) =>
      ++calls > 4 ? { rows: [], lastSeq: i.afterSeq } : read(i);
    await expect(
      rotateCreditLog(vanishing.deps, { memoryBudget: 300, pageSize: 2 }),
    ).rejects.toThrow("credit_log_scan_changed");

    const badCursor = seeded();
    badCursor.core.cursors.set("wfp", "garbage");
    await expect(rotateCreditLog(badCursor.deps)).rejects.toThrow(
      "credit_service_boundary_invalid",
    );
  });
});
