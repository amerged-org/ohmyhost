import { describe, expect, it } from "vitest";
import { WFP_MAX_WINDOWS, runWfp } from "../src/wfp.js";
import {
  NOW,
  OWNER,
  SCRIPT_A,
  SCRIPT_B,
  SCRIPT_C,
  logObject,
  objectKey,
  world,
  type World,
} from "./doubles.js";

const CURSOR = "2026-10-30T08:00:00.000Z";

function ready(): World {
  const w = world();
  w.core.cursors.set("wfp", CURSOR);
  w.core.scripts.set(SCRIPT_A, OWNER(SCRIPT_A));
  w.core.scripts.set(SCRIPT_B, { ...OWNER(SCRIPT_B), organizationId: "org_2", projectId: "prj_2" });
  return w;
}
const usageRows = (w: World) => w.core.rows.filter((row) => row.kind === "usage");

describe("runWfp", () => {
  it("bills the finished window per organization and advances the cursor after all of them", async () => {
    const w = ready();
    w.usageLogs.seed(
      objectKey(8, 15, 0, "one"),
      logObject([{ cpu: 3 }, { cpu: 4, outcome: "exception" }, { script: SCRIPT_B, cpu: 9 }]),
    );
    w.usageLogs.seed(
      objectKey(8, 40, 0, "two"),
      logObject([{ cpu: 5 }, { cpu: 50, type: "alarm" }]),
    );

    const report = await runWfp(w.deps);

    expect(report).toMatchObject({
      source: "wfp",
      status: "advanced",
      windows: 1,
      posted: 2,
      duplicates: 0,
    });
    expect(report.counters).toMatchObject({ objects: 2 });
    expect(w.core.cursors.get("wfp")).toBe("2026-10-30T09:00:00.000Z");
    const rows = usageRows(w);
    expect(rows.map((row) => row.key)).toEqual([
      "usage:wfp:org_1:2026-10-30T08:00:00.000Z",
      "usage:wfp:org_2:2026-10-30T08:00:00.000Z",
    ]);
    const first = rows[0]?.detail as {
      lines: { meter: string; quantity: string; chargeMicros: number }[];
    };
    expect(first.lines.map((line) => [line.meter, line.quantity, line.chargeMicros])).toEqual([
      ["wfp.cpu", "12", 79],
      ["wfp.requests", "3", 296],
    ]);
    expect(rows[0]?.deltaMicros).toBe(-375);
    // advanceCursor is the last Core call of the window, after every posting.
    const calls = w.core.calls;
    expect(calls.lastIndexOf("postUsage")).toBeLessThan(calls.lastIndexOf("advanceCursor"));
  });

  it("assigns an object to the hour of the time in its name", async () => {
    const w = ready();
    w.usageLogs.seed(objectKey(8, 59, 40, "inside"), logObject([{}]));
    w.usageLogs.seed(objectKey(9, 0, 10, "next"), logObject([{ cpu: 100 }]));
    await runWfp(w.deps);
    expect((usageRows(w)[0]?.detail as { lines: { quantity: string }[] }).lines[1]?.quantity).toBe(
      "1",
    );
    expect(w.core.cursors.get("wfp")).toBe("2026-10-30T09:00:00.000Z");

    // The next hour bills the object that arrived with a later name, once the window has aged out.
    w.clock.now = Date.UTC(2026, 9, 30, 10, 20);
    const next = await runWfp(w.deps);
    expect(next.windows).toBe(1);
    expect(usageRows(w).map((row) => row.key.slice(-24))).toEqual([
      "2026-10-30T08:00:00.000Z",
      "2026-10-30T09:00:00.000Z",
    ]);
  });

  it("is idempotent: a rerun of a billed window books nothing twice", async () => {
    const w = ready();
    w.usageLogs.seed(objectKey(8, 15, 0, "one"), logObject([{}, { script: SCRIPT_B }]));
    await runWfp(w.deps);
    const before = structuredClone(w.core.rows);
    w.core.cursors.set("wfp", CURSOR);

    const again = await runWfp(w.deps);

    expect(again).toMatchObject({ posted: 0, duplicates: 2, windows: 1 });
    expect(w.core.rows).toEqual(before);
    expect(w.core.cursors.get("wfp")).toBe("2026-10-30T09:00:00.000Z");
  });

  it("resumes after a partial failure without duplicate or lost rows", async () => {
    const w = ready();
    w.usageLogs.seed(objectKey(8, 15, 0, "one"), logObject([{}, { script: SCRIPT_B }]));
    let failed = false;
    w.core.failOn = (method, input) => {
      if (method !== "postUsage" || failed) return false;
      failed = (input as { organizationId: string }).organizationId === "org_2";
      return failed;
    };

    await expect(runWfp(w.deps)).rejects.toThrow("postUsage failed");

    expect(usageRows(w).map((row) => row.organizationId)).toEqual(["org_1"]);
    expect(w.core.cursors.get("wfp")).toBe(CURSOR);

    const resumed = await runWfp(w.deps);

    expect(resumed).toMatchObject({ posted: 1, duplicates: 1 });
    expect(usageRows(w).map((row) => row.organizationId)).toEqual(["org_1", "org_2"]);
    expect(w.core.cursors.get("wfp")).toBe("2026-10-30T09:00:00.000Z");
  });

  it("bills a batch delivered under two names once", async () => {
    const w = ready();
    const batch = logObject([{ cpu: 2 }, { cpu: 2 }]);
    w.usageLogs.seed(objectKey(8, 15, 0, "orig"), batch);
    w.usageLogs.seed(objectKey(8, 15, 5, "copy"), batch);
    const report = await runWfp(w.deps);
    expect(report.counters).toMatchObject({ objects: 1, objects_duplicate: 1 });
    expect((usageRows(w)[0]?.detail as { lines: { quantity: string }[] }).lines[1]?.quantity).toBe(
      "2",
    );
  });

  it("skips an unreadable object, bills the rest and reports the object as a problem", async () => {
    const w = ready();
    w.usageLogs.seed(objectKey(8, 15, 0, "good"), logObject([{}]));
    w.usageLogs.seed(objectKey(8, 16, 0, "bad"), "this is not gzip");
    w.usageLogs.seed(objectKey(8, 17, 0, "foreign"), logObject([{ namespace: "other" }]));
    const report = await runWfp(w.deps);
    expect(report.problems).toEqual([
      `wfp_object_rejected:${objectKey(8, 16, 0, "bad")}:gzip`,
      `wfp_object_rejected:${objectKey(8, 17, 0, "foreign")}:values`,
    ]);
    expect(report.counters).toMatchObject({ objects: 1, objects_rejected: 2 });
    expect(usageRows(w)).toHaveLength(1);
    expect(w.core.cursors.get("wfp")).toBe("2026-10-30T09:00:00.000Z");
  });

  it("does not bill scripts without an owner or an activated meter, and reads no rates for nothing", async () => {
    const w = ready();
    w.usageLogs.seed(
      objectKey(8, 15, 0, "one"),
      logObject([{ script: SCRIPT_C }, { script: "gateway" }]),
    );
    const unowned = await runWfp(w.deps);
    expect(unowned.counters).toMatchObject({ requests_unowned: 1, events_foreign: 1 });
    expect(w.core.calls).not.toContain("readRates");
    expect(usageRows(w)).toHaveLength(0);
    expect(w.core.cursors.get("wfp")).toBe("2026-10-30T09:00:00.000Z");

    w.core.cursors.set("wfp", CURSOR);
    w.usageLogs.seed(objectKey(8, 20, 0, "two"), logObject([{}]));
    w.core.rates = [];
    const unpriced = await runWfp(w.deps);
    expect(unpriced.counters).toMatchObject({ "unpriced:wfp.requests": 1, "unpriced:wfp.cpu": 1 });
    expect(usageRows(w)).toHaveLength(0);
  });

  it("treats an object that vanished after listing as missing", async () => {
    const w = ready();
    w.usageLogs.seed(objectKey(8, 15, 0, "gone"), logObject([{}]));
    w.usageLogs.seed(objectKey(8, 16, 0, "kept"), logObject([{}]));
    const get = w.usageLogs.get.bind(w.usageLogs);
    w.usageLogs.get = async (key) => (key.includes("gone") ? null : get(key));
    const report = await runWfp(w.deps);
    expect(report.counters).toMatchObject({ objects: 1, objects_missing: 1 });
  });

  it("stops at an infrastructure failure instead of billing a partial window", async () => {
    const w = ready();
    w.usageLogs.seed(objectKey(8, 15, 0, "one"), logObject([{}]));
    w.usageLogs.get = async () => {
      throw new Error("R2 unavailable");
    };
    await expect(runWfp(w.deps)).rejects.toThrow("R2 unavailable");
    expect(w.core.cursors.get("wfp")).toBe(CURSOR);
    expect(usageRows(w)).toHaveLength(0);
  });

  it("resolves script names in chunks of 100", async () => {
    const w = ready();
    const names = Array.from(
      { length: 150 },
      (_, index) => `p-${String(index).padStart(26, "0")}-prod-${"x".repeat(26)}`,
    );
    w.usageLogs.seed(objectKey(8, 15, 0, "wide"), logObject(names.map((script) => ({ script }))));
    await runWfp(w.deps);
    expect(w.core.calls.filter((call) => call === "resolveScripts")).toHaveLength(2);
  });

  it("does nothing without a cursor, before the first window is due, or beyond the lag", async () => {
    const w = world();
    expect(await runWfp(w.deps)).toMatchObject({ status: "skipped", windows: 0 });
    expect(w.core.calls).toEqual(["readCursor"]);

    w.core.cursors.set("wfp", "2026-10-30T09:00:00.000Z");
    expect(await runWfp(w.deps)).toMatchObject({ status: "idle", windows: 0 });

    // 09:03 is inside the five minute lag of the 08:00 to 09:00 window.
    w.core.cursors.set("wfp", CURSOR);
    w.clock.now = Date.UTC(2026, 9, 30, 9, 3);
    expect(await runWfp(w.deps)).toMatchObject({ status: "idle", windows: 0 });
    w.clock.now = NOW;
    expect(await runWfp(w.deps)).toMatchObject({ status: "advanced", windows: 1 });
  });

  it("catches up an outage in bounded passes", async () => {
    const w = world();
    w.core.cursors.set("wfp", "2026-10-29T00:00:00.000Z");
    const first = await runWfp(w.deps);
    expect(first.windows).toBe(WFP_MAX_WINDOWS);
    expect(w.core.cursors.get("wfp")).toBe("2026-10-29T12:00:00.000Z");
    const second = await runWfp(w.deps);
    expect(second.windows).toBe(WFP_MAX_WINDOWS);
    expect(w.core.cursors.get("wfp")).toBe("2026-10-30T00:00:00.000Z");
  });

  it("refuses a corrupt cursor", async () => {
    const w = world();
    w.core.cursors.set("wfp", "2026-10-30T08:30:00.000Z");
    await expect(runWfp(w.deps)).rejects.toThrow("credit_service_boundary_invalid");
  });
});
