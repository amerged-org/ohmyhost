import { describe, expect, it } from "vitest";
import { MAX_DAYS } from "../src/daily.js";
import { parseR2Daily, runR2 } from "../src/r2.js";
import { runResources } from "../src/resources.js";
import { world, type World } from "./doubles.js";

const D29 = "2026-10-29T00:00:00.000Z";
const D30 = "2026-10-30T00:00:00.000Z";
const usageRows = (w: World) => w.core.rows.filter((row) => row.kind === "usage");
const bucket = (index: number, organizationId = "org_1", projectId = "prj_1") => ({
  bucketName: `bucket-${String(index).padStart(4, "0")}`,
  jurisdiction: "eu" as const,
  organizationId,
  projectId,
  environmentId: "env_prod",
});

function r2World(): World {
  const w = world();
  w.core.cursors.set("r2", D29);
  w.core.buckets = [bucket(1), bucket(2, "org_2", "prj_2")];
  w.r2.answer = (i) => ({
    day: i.day,
    buckets: i.buckets.map((entry) => ({
      ...entry,
      storagePeakBytes: entry.bucketName.endsWith("0001") ? "2000000000" : "0",
      classA: entry.bucketName.endsWith("0001") ? "2500" : "0",
      classB: entry.bucketName.endsWith("0001") ? "1" : "30000",
      inexactHours: 2,
    })),
  });
  return w;
}

describe("runR2", () => {
  it("posts the finished day's storage and operations per organization", async () => {
    const w = r2World();

    const report = await runR2(w.deps);

    expect(report).toMatchObject({ source: "r2", status: "advanced", windows: 1, posted: 2 });
    expect(report.counters).toMatchObject({ buckets: 2, hours_inexact: 4 });
    expect(w.r2.requests).toEqual([
      {
        day: D29,
        buckets: [
          { bucketName: "bucket-0001", jurisdiction: "eu" },
          { bucketName: "bucket-0002", jurisdiction: "eu" },
        ],
      },
    ]);
    const rows = usageRows(w);
    expect(rows.map((row) => row.key)).toEqual([`usage:r2:org_1:${D29}`, `usage:r2:org_2:${D29}`]);
    const lines = (
      rows[0]?.detail as { lines: { meter: string; quantity: string; chargeMicros: number }[] }
    ).lines;
    expect(lines.map((line) => [line.meter, line.quantity, line.chargeMicros])).toEqual([
      ["r2.class_a", "2500", 250],
      ["r2.class_b", "1", 1],
      ["r2.storage.standard", "2000000000", 200],
    ]);
    expect(rows[1]?.deltaMicros).toBe(-300);
    expect(w.core.cursors.get("r2")).toBe(D30);
  });

  it("pages through the buckets and asks the collector for 100 at a time", async () => {
    const w = r2World();
    w.core.buckets = Array.from({ length: 450 }, (_, index) => bucket(index + 1));
    await runR2(w.deps);
    expect(w.core.calls.filter((call) => call === "listR2Buckets")).toHaveLength(3);
    expect(w.r2.requests.map((request) => request.buckets.length)).toEqual([
      100, 100, 100, 100, 50,
    ]);
    expect(usageRows(w)).toHaveLength(1);
  });

  it("advances a day without buckets and does not call the collector", async () => {
    const w = r2World();
    w.core.buckets = [];
    expect(await runR2(w.deps)).toMatchObject({ windows: 1, posted: 0 });
    expect(w.r2.requests).toEqual([]);
    expect(w.core.cursors.get("r2")).toBe(D30);
  });

  it("waits an hour after midnight for the provider's last hour", async () => {
    const w = r2World();
    w.clock.now = Date.UTC(2026, 9, 30, 0, 59);
    w.core.cursors.set("r2", "2026-10-29T00:00:00.000Z");
    expect(await runR2(w.deps)).toMatchObject({ status: "idle", windows: 0 });
    w.clock.now = Date.UTC(2026, 9, 30, 1, 7);
    expect(await runR2(w.deps)).toMatchObject({ status: "advanced", windows: 1 });
  });

  it("keeps the day open when the collector fails or answers for other buckets", async () => {
    const w = r2World();
    w.r2.collectUsage = async () => {
      throw new Error("rate limited");
    };
    await expect(runR2(w.deps)).rejects.toThrow("rate limited");
    expect(w.core.cursors.get("r2")).toBe(D29);
    expect(usageRows(w)).toHaveLength(0);

    const swapped = r2World();
    swapped.r2.answer = (i) => ({
      day: i.day,
      buckets: [...i.buckets].reverse().map((entry) => ({
        ...entry,
        storagePeakBytes: "1",
        classA: "1",
        classB: "1",
        inexactHours: 0,
      })),
    });
    await expect(runR2(swapped.deps)).rejects.toThrow("credit_service_r2_usage_invalid");
    expect(swapped.core.cursors.get("r2")).toBe(D29);
  });

  it("is idempotent: billing a day again books nothing", async () => {
    const w = r2World();
    await runR2(w.deps);
    const before = structuredClone(w.core.rows);
    w.core.cursors.set("r2", D29);
    expect(await runR2(w.deps)).toMatchObject({ posted: 0, duplicates: 2 });
    expect(w.core.rows).toEqual(before);
  });

  it("does nothing without a cursor", async () => {
    expect(await runR2(world().deps)).toMatchObject({ status: "skipped" });
  });

  it("bills at most three days per pass", async () => {
    const w = r2World();
    w.core.cursors.set("r2", "2026-10-20T00:00:00.000Z");
    expect(await runR2(w.deps)).toMatchObject({ windows: MAX_DAYS });
    expect(w.core.cursors.get("r2")).toBe("2026-10-23T00:00:00.000Z");
  });
});

describe("parseR2Daily", () => {
  const asked = [{ bucketName: "b1", jurisdiction: "eu" as const }];
  const entry = {
    bucketName: "b1",
    jurisdiction: "eu",
    storagePeakBytes: "1",
    classA: "2",
    classB: "3",
    inexactHours: 0,
  };
  const check = (value: unknown) => () => parseR2Daily(value, D29, asked);

  it("accepts the requested buckets in order and refuses anything else", () => {
    const good = { day: D29, buckets: [entry] };
    expect(parseR2Daily(good, D29, asked)).toBe(good);
    for (const value of [null, [], "x"])
      expect(check(value)).toThrow("credit_service_r2_usage_invalid");
    expect(check({ day: D30, buckets: [entry] })).toThrow("credit_service_r2_usage_invalid");
    expect(check({ day: D29, buckets: [] })).toThrow("credit_service_r2_usage_invalid");
    expect(check({ day: D29, buckets: [null] })).toThrow("credit_service_r2_usage_invalid");
    for (const change of [
      { bucketName: "b2" },
      { jurisdiction: "us" },
      { storagePeakBytes: "-1" },
      { classA: 2 },
      { classB: "1.5" },
      { inexactHours: -1 },
      { inexactHours: "0" },
    ])
      expect(check({ day: D29, buckets: [{ ...entry, ...change }] })).toThrow(
        "credit_service_r2_usage_invalid",
      );
  });
});

describe("runResources", () => {
  function resourceWorld(): World {
    const w = world();
    w.core.cursors.set("resources", D29);
    w.core.resources = [
      {
        organizationId: "org_1",
        projectId: "prj_1",
        environmentId: "env_prod",
        scripts: 2,
        hostnames: 1,
      },
      {
        organizationId: "org_1",
        projectId: "prj_1",
        environmentId: "env_dev",
        scripts: 1,
        hostnames: 0,
      },
      {
        organizationId: "org_2",
        projectId: "prj_2",
        environmentId: "env_prod",
        scripts: 0,
        hostnames: 0,
      },
    ];
    return w;
  }

  it("charges the daily price of every active script and custom hostname", async () => {
    const w = resourceWorld();

    const report = await runResources(w.deps);

    expect(report).toMatchObject({
      source: "resources",
      status: "advanced",
      windows: 1,
      posted: 1,
    });
    expect(report.counters).toMatchObject({ resource_rows: 3 });
    const rows = usageRows(w);
    expect(rows.map((row) => row.key)).toEqual([`usage:resources:org_1:${D29}`]);
    const lines = (
      rows[0]?.detail as {
        lines: {
          projectId: string;
          environmentId: string;
          meter: string;
          quantity: string;
          chargeMicros: number;
        }[];
      }
    ).lines;
    expect(
      lines.map((line) => [line.environmentId, line.meter, line.quantity, line.chargeMicros]),
    ).toEqual([
      ["env_dev", "wfp.script", "86400", 1000],
      ["env_prod", "domain.custom_hostname", "86400", 5000],
      ["env_prod", "wfp.script", "172800", 2000],
    ]);
    expect(rows[0]?.deltaMicros).toBe(-8000);
    expect(w.core.cursors.get("resources")).toBe(D30);
  });

  it("reads all pages and needs no lag after midnight", async () => {
    const w = resourceWorld();
    w.core.resources = Array.from({ length: 1200 }, (_, index) => ({
      organizationId: `org_${String(index % 3)}`,
      projectId: `prj_${String(index)}`,
      environmentId: "env_prod",
      scripts: 1,
      hostnames: 0,
    }));
    w.clock.now = Date.UTC(2026, 9, 30, 0, 0, 1);
    const report = await runResources(w.deps);
    expect(w.core.calls.filter((call) => call === "readResources")).toHaveLength(3);
    expect(report).toMatchObject({ windows: 1, posted: 3 });
  });

  it("advances a day without resources, books nothing twice and skips without a cursor", async () => {
    const empty = resourceWorld();
    empty.core.resources = [];
    expect(await runResources(empty.deps)).toMatchObject({ windows: 1, posted: 0 });
    expect(empty.core.calls).not.toContain("readRates");

    const w = resourceWorld();
    await runResources(w.deps);
    w.core.cursors.set("resources", D29);
    expect(await runResources(w.deps)).toMatchObject({ posted: 0, duplicates: 1 });
    expect(usageRows(w)).toHaveLength(1);

    expect(await runResources(world().deps)).toMatchObject({ status: "skipped" });
  });

  it("does not bill an unactivated meter", async () => {
    const w = resourceWorld();
    w.core.rates = [];
    const report = await runResources(w.deps);
    expect(report.counters).toMatchObject({
      "unpriced:wfp.script": 1,
      "unpriced:domain.custom_hostname": 1,
    });
    expect(usageRows(w)).toHaveLength(0);
    expect(w.core.cursors.get("resources")).toBe(D30);
  });
});
