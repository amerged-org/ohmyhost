import { describe, expect, it, vi } from "vitest";

import { runR2 } from "../src/r2.js";
import { runResources } from "../src/resources.js";
import type { UsageLine } from "../src/port.js";
import { POST_ATTEMPTS, newReport, splitParts, postOrganizations } from "../src/source.js";
import { runWfp } from "../src/wfp.js";
import {
  NOW,
  OWNER,
  SCRIPT_A,
  SCRIPT_B,
  logObject,
  objectKey,
  world,
  type World,
} from "./doubles.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env: unknown;
    public constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const main = await import("../src/worker-main.js");

const BIG = "org_1";
const SMALL = "org_2";
const usageRows = (w: World) => w.core.rows.filter((row) => row.kind === "usage");
const linesOf = (w: World, organizationId: string): UsageLine[] =>
  usageRows(w)
    .filter((row) => row.organizationId === organizationId)
    .flatMap((row) => (row.detail as { lines: UsageLine[] }).lines);
const id = (index: number) => index.toString(36).padStart(26, "0");
/** Ids sort like their numbers, so that environments with a lower number are the first lines of a window. */
const pad = (index: number) => String(index).padStart(5, "0");

/** One scenario per usage source: an organization whose window exceeds the Core's 2000 lines, and one after it. */
interface Scenario {
  readonly name: string;
  /** Environments of the big organization, the lines each one bills, and how many of the first the second run no longer sees. */
  readonly count: number;
  readonly perEnvironment: number;
  /** Lines the organization after the big one bills. */
  readonly smallLines: number;
  readonly drop: number;
  /** Seeds the environments `first` to `last`. */
  readonly seed: (w: World, first: number, last: number) => void;
  readonly run: (w: World) => Promise<{ posted: number; duplicates: number; windows: number }>;
  /** Puts the cursor of the source back, as a pass that failed after posting would have left it. */
  readonly reset: (w: World) => void;
}

const scriptName = (index: number) => `p-${id(index)}-prod-${id(index)}`;
const bucketOf = (index: number) => ({
  bucketName: `bucket-${pad(index)}`,
  jurisdiction: "eu" as const,
  organizationId: BIG,
  projectId: `prj_${pad(index)}`,
  environmentId: `env_${pad(index)}`,
});
const pgcfLine = (index: number): UsageLine => ({
  projectId: `prj_${pad(index)}`,
  environmentId: `env_${pad(index)}`,
  meter: "pgcf.memory.active",
  quantity: "1",
  unit: "memory_mib_milliseconds",
  rateCardId: "pgcf-test",
  chargeMicros: 7,
});
let pgcfRange: [number, number] = [1, 1];

const scenarios: Scenario[] = [
  {
    name: "wfp: 1101 scripts with two lines each",
    count: 1101,
    perEnvironment: 2,
    smallLines: 2,
    drop: 100,
    seed: (w, first, last) => {
      for (let index = first; index <= last; index++)
        w.core.scripts.set(scriptName(index), {
          scriptName: scriptName(index),
          organizationId: BIG,
          projectId: `prj_${pad(index)}`,
          environmentId: `env_${pad(index)}`,
        });
      w.core.scripts.set(SCRIPT_B, { ...OWNER(SCRIPT_B), organizationId: SMALL });
      w.usageLogs.objects.clear();
      w.usageLogs.seed(
        objectKey(8, 15, 0, "wide"),
        logObject([
          ...Array.from({ length: last - first + 1 }, (_, index) => ({
            script: scriptName(first + index),
          })),
          { script: SCRIPT_B },
        ]),
      );
    },
    run: (w) => runWfp(w.deps),
    reset: (w) => w.core.cursors.set("wfp", "2026-10-30T08:00:00.000Z"),
  },
  {
    name: "resources: 1101 environments with a script and a hostname",
    count: 1101,
    perEnvironment: 2,
    smallLines: 1,
    drop: 100,
    seed: (w, first, last) => {
      w.core.resources = [
        ...Array.from({ length: last - first + 1 }, (_, index) => ({
          organizationId: BIG,
          projectId: `prj_${pad(first + index)}`,
          environmentId: `env_${pad(first + index)}`,
          scripts: 1,
          hostnames: 1,
        })),
        {
          organizationId: SMALL,
          projectId: "prj_s",
          environmentId: "env_s",
          scripts: 1,
          hostnames: 0,
        },
      ];
    },
    run: (w) => runResources(w.deps),
    reset: (w) => w.core.cursors.set("resources", "2026-10-29T00:00:00.000Z"),
  },
  {
    name: "r2: 700 buckets with three lines each",
    count: 700,
    perEnvironment: 3,
    smallLines: 3,
    drop: 20,
    seed: (w, first, last) => {
      w.core.buckets = [
        ...Array.from({ length: last - first + 1 }, (_, index) => bucketOf(first + index)),
        { ...bucketOf(0), organizationId: SMALL, projectId: "prj_s", environmentId: "env_s" },
      ];
      w.r2.answer = (i) => ({
        day: i.day,
        buckets: i.buckets.map((entry) => ({
          ...entry,
          storagePeakBytes: "2000000000",
          classA: "2500",
          classB: "30000",
          inexactHours: 0,
        })),
      });
    },
    run: (w) => runR2(w.deps),
    reset: (w) => w.core.cursors.set("r2", "2026-10-29T00:00:00.000Z"),
  },
  {
    name: "pgcf: 3000 lines of one hour",
    count: 3000,
    perEnvironment: 1,
    smallLines: 1,
    drop: 100,
    seed: (_w, first, last) => {
      pgcfRange = [first, last];
    },
    run: async (w) => {
      const report = newReport("pgcf");
      await postOrganizations(
        w.deps,
        report,
        "2026-10-30T07:00:00.000Z",
        new Map([
          [
            BIG,
            Array.from({ length: pgcfRange[1] - pgcfRange[0] + 1 }, (_, index) =>
              pgcfLine(pgcfRange[0] + index),
            ),
          ],
          [SMALL, [pgcfLine(0)]],
        ]),
      );
      return { posted: report.posted, duplicates: report.duplicates, windows: 1 };
    },
    reset: () => undefined,
  },
];

describe("usage posting", () => {
  it.each(scenarios)(
    "$name: posts in stable parts the Core accepts and never charges a line twice",
    async (scenario) => {
      const w = world();
      scenario.reset(w);
      scenario.seed(w, 1, scenario.count);

      const first = await scenario.run(w);

      // The Core refuses more than 2000 lines in one posting; the service sends parts of at most 1000.
      const sizes = w.core.postings.map((posting) => posting.lines);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
      expect(sizes.length).toBeGreaterThan(2);
      // Every line of the big organization is booked exactly once, and the organization after it is posted too.
      const big = linesOf(w, BIG);
      expect(big).toHaveLength(scenario.count * scenario.perEnvironment);
      expect(
        new Set(big.map((line) => `${line.projectId}|${line.environmentId}|${line.meter}`)).size,
      ).toBe(big.length);
      const charge = (organizationId: string) =>
        usageRows(w)
          .filter((row) => row.organizationId === organizationId)
          .reduce((sum, row) => sum - row.deltaMicros, 0);
      expect(charge(BIG)).toBe(big.reduce((sum, line) => sum + line.chargeMicros, 0));
      expect(linesOf(w, SMALL)).toHaveLength(scenario.smallLines);
      const rows = structuredClone(usageRows(w));
      expect(first).toMatchObject({ posted: rows.length, duplicates: 0 });
      // A window that fits one posting is sent exactly as before parts existed; a part names its layout.
      expect(w.core.postings.find((posting) => posting.organizationId === SMALL)?.sent).toEqual([
        "lines",
        "organizationId",
        "source",
        "window",
      ]);
      expect(
        w.core.postings
          .filter((posting) => posting.organizationId === BIG)
          .every((posting) => posting.sent.includes("split") && posting.sent.includes("part")),
      ).toBe(true);

      // A rerun of the window books nothing again, and neither does one that sees fewer environments.
      scenario.reset(w);
      expect(await scenario.run(w)).toMatchObject({ posted: 0, duplicates: rows.length });
      expect(usageRows(w)).toEqual(rows);
      scenario.reset(w);
      scenario.seed(w, scenario.drop + 1, scenario.count);
      expect(await scenario.run(w)).toMatchObject({ posted: 0 });
      expect(usageRows(w)).toEqual(rows);

      // A pass that books all but the last part and fails, retried after the first environments appeared late: the
      // parts that were booked stay as they are and the last one is booked once, with no line twice.
      const last = Math.max(
        ...w.core.postings.filter((posting) => posting.organizationId === BIG).map((p) => p.part),
      );
      const retried = world();
      scenario.reset(retried);
      scenario.seed(retried, scenario.drop + 1, scenario.count);
      retried.core.failOn = (method, input) =>
        method === "postUsage" &&
        (input as { organizationId: string }).organizationId === BIG &&
        (input as { part: number }).part === last;
      await expect(scenario.run(retried)).rejects.toThrow("postUsage failed");
      retried.core.failOn = undefined;
      scenario.reset(retried);
      scenario.seed(retried, 1, scenario.count);
      await scenario.run(retried);
      const booked = linesOf(retried, BIG).map(
        (line) => `${line.projectId}|${line.environmentId}|${line.meter}`,
      );
      expect(new Set(booked).size).toBe(booked.length);
      expect(booked.length).toBeGreaterThanOrEqual(
        (scenario.count - scenario.drop) * scenario.perEnvironment,
      );
    },
    60_000,
  );

  it("keeps the layout of a window when its line count crosses 2000 between two attempts", async () => {
    const keyOf = (line: UsageLine) => `${line.projectId}|${line.environmentId}|${line.meter}`;
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => pgcfLine(from + index));
    const window = "2026-10-30T07:00:00.000Z";
    const attempt = async (w: World, big: UsageLine[]) => {
      const report = newReport("pgcf");
      await postOrganizations(
        w.deps,
        report,
        window,
        new Map([
          [BIG, big],
          [SMALL, [pgcfLine(0)]],
        ]),
      );
      return report;
    };

    // Whole, then split: org 1 is booked whole while org 2 fails and holds the window; the retry sees one more line.
    const grown = world();
    grown.core.failOn = (method, input) =>
      method === "postUsage" && (input as { organizationId: string }).organizationId === SMALL;
    await expect(attempt(grown, range(1, 2000))).rejects.toThrow("postUsage failed");
    grown.core.failOn = undefined;
    const retry = await attempt(grown, range(1, 2001));
    // the lines the booked window did not take are dropped, and that is counted and logged, not a duplicate
    expect(retry.counters).toMatchObject({ layout_superseded: 1, lines_superseded: 2001 });
    expect(retry.duplicates).toBe(0);
    expect(grown.events).toContainEqual(
      expect.objectContaining({
        event: "credit_usage_layout_superseded",
        organizationId: BIG,
        lines: 2001,
      }),
    );
    expect(usageRows(grown).filter((row) => row.organizationId === BIG)).toHaveLength(1);
    expect(linesOf(grown, BIG).map(keyOf)).toEqual(range(1, 2000).map(keyOf));
    expect(linesOf(grown, SMALL)).toHaveLength(1);

    // Split, then whole: the last part of org 1 fails and holds the window; the retry sees one line less.
    const shrunk = world();
    const last = Math.max(...splitParts(range(1, 2001)).map((part) => part.part));
    shrunk.core.failOn = (method, input) =>
      method === "postUsage" &&
      (input as { organizationId: string; part?: number }).organizationId === BIG &&
      (input as { part?: number }).part === last;
    await expect(attempt(shrunk, range(1, 2001))).rejects.toThrow("postUsage failed");
    shrunk.core.failOn = undefined;
    await attempt(shrunk, range(1, 2000));
    const booked = linesOf(shrunk, BIG).map(keyOf);
    expect(new Set(booked).size).toBe(booked.length);
    for (const wanted of range(1, 2000).map(keyOf)) expect(booked).toContain(wanted);
    expect(
      usageRows(shrunk)
        .filter((row) => row.organizationId === BIG)
        .every((row) => (row.detail as { split?: boolean }).split === true),
    ).toBe(true);
  });

  it("holds the shared cursor for a poison organization once, not once per window", async () => {
    const poisonWorld = (): World => {
      const w = world();
      w.core.cursors.set("wfp", "2026-10-30T06:00:00.000Z");
      w.core.scripts.set(SCRIPT_A, OWNER(SCRIPT_A));
      w.core.scripts.set(SCRIPT_B, {
        ...OWNER(SCRIPT_B),
        organizationId: SMALL,
        projectId: "prj_2",
      });
      for (const hour of [6, 7, 8])
        w.usageLogs.seed(
          objectKey(hour, 15, 0, `h${String(hour)}`),
          logObject([{ script: SCRIPT_A }, { script: SCRIPT_B }]),
        );
      w.core.failOn = (method, input) =>
        method === "postUsage" && (input as { organizationId: string }).organizationId === BIG;
      return w;
    };
    const smallWindows = (w: World) => usageRows(w).filter((row) => row.organizationId === SMALL);

    // An error that may pass holds the first window for the attempt limit; the next windows do not wait again.
    const generic = poisonWorld();
    for (let attempt = 1; attempt < POST_ATTEMPTS; attempt++) {
      await expect(runWfp(generic.deps)).rejects.toThrow("postUsage failed");
      expect(generic.core.cursors.get("wfp")).toBe("2026-10-30T06:00:00.000Z");
    }
    expect(await runWfp(generic.deps)).toMatchObject({ windows: 3 });
    expect(generic.core.cursors.get("wfp")).toBe("2026-10-30T09:00:00.000Z");
    expect(smallWindows(generic)).toHaveLength(3);
    expect(generic.core.failures.size).toBe(3);

    // An error that cannot pass (a refused posting) is dead at once: one pass, no hold.
    const refused = poisonWorld();
    refused.core.errorFor = () => new TypeError("refused: invalid posting");
    expect(await runWfp(refused.deps)).toMatchObject({ windows: 3 });
    expect(refused.core.cursors.get("wfp")).toBe("2026-10-30T09:00:00.000Z");
    expect(smallWindows(refused)).toHaveLength(3);

    // A window that cannot even be laid out in parts (one environment with 9000 lines) fails that organization alone.
    const crowded = world();
    const report = newReport("pgcf");
    await postOrganizations(
      crowded.deps,
      report,
      "2026-10-30T07:00:00.000Z",
      new Map([
        [
          BIG,
          Array.from({ length: 9000 }, (_, index) => ({
            ...pgcfLine(1),
            meter: `m${String(index)}`,
          })),
        ],
        [SMALL, [pgcfLine(0)]],
      ]),
    );
    expect(report.problems).toEqual([
      `usage_post_failed:${BIG}:2026-10-30T07:00:00.000Z`,
      `usage_post_dead_lettered:${BIG}:2026-10-30T07:00:00.000Z`,
    ]);
    expect(usageRows(crowded).map((row) => row.organizationId)).toEqual([SMALL]);

    // A failure of every organization at once (the Core is down for writes) counts no attempt and dead-letters nothing.
    const outage = poisonWorld();
    outage.core.failOn = (method) => method === "postUsage";
    for (let attempt = 1; attempt <= 2 * POST_ATTEMPTS; attempt++)
      await expect(runWfp(outage.deps)).rejects.toThrow("postUsage failed");
    expect(outage.core.failures.size).toBe(0);
    expect(outage.core.cursors.get("wfp")).toBe("2026-10-30T06:00:00.000Z");
    outage.core.failOn = undefined;
    expect(await runWfp(outage.deps)).toMatchObject({ windows: 3 });
    expect(usageRows(outage)).toHaveLength(6);
  });

  it("isolates a failing organization, holds the cursor for the attempt limit, then dead-letters it", async () => {
    const w = world();
    const window = "2026-10-30T08:00:00.000Z";
    w.core.cursors.set("wfp", window);
    w.core.scripts.set(SCRIPT_A, OWNER(SCRIPT_A));
    w.core.scripts.set(SCRIPT_B, { ...OWNER(SCRIPT_B), organizationId: SMALL, projectId: "prj_2" });
    w.usageLogs.seed(objectKey(8, 15, 0, "one"), logObject([{}, { script: SCRIPT_B }]));
    w.core.failOn = (method, input) =>
      method === "postUsage" && (input as { organizationId: string }).organizationId === BIG;

    // Before the limit the other organization is booked, the failure is kept and the cursor holds.
    for (let attempt = 1; attempt < POST_ATTEMPTS; attempt++) {
      await expect(runWfp(w.deps)).rejects.toThrow("postUsage failed");
      expect([...w.core.failures.values()].map((failure) => failure.attempts)).toEqual([attempt]);
      expect(w.core.cursors.get("wfp")).toBe(window);
      expect(usageRows(w).map((row) => row.organizationId)).toEqual([SMALL]);
    }

    // At the limit the posting is dead-lettered with a clear problem and the cursor moves on.
    const last = await runWfp(w.deps);
    expect(last.problems).toEqual([
      `usage_post_failed:${BIG}:${window}`,
      `usage_post_dead_lettered:${BIG}:${window}`,
    ]);
    expect(w.core.cursors.get("wfp")).toBe("2026-10-30T09:00:00.000Z");

    // Later windows of the other organization are billed although the poison is still there.
    w.clock.now = NOW + 3_600_000;
    w.usageLogs.seed(objectKey(9, 15, 0, "next"), logObject([{ script: SCRIPT_B }]));
    expect(await runWfp(w.deps)).toMatchObject({ windows: 1, posted: 1, problems: [] });
    expect(w.core.cursors.get("wfp")).toBe("2026-10-30T10:00:00.000Z");

    // The dead letter fails every invocation until it is replayed, and it is booked exactly once.
    await expect(main.runUsage(w.deps)).rejects.toThrow("credit_service_incomplete:replay");
    w.core.failOn = undefined;
    await main.runUsage(w.deps);
    expect(w.events.at(-2)).toMatchObject({
      event: "credit_usage_replay",
      replayed: 1,
      remaining: 0,
    });
    expect(w.core.failures.size).toBe(0);
    const booked = usageRows(w).filter((row) => row.organizationId === BIG);
    expect(booked.map((row) => row.key)).toEqual([`usage:wfp:${BIG}:${window}`]);
    expect(booked[0]?.at).toBe(new Date(w.clock.now).toISOString());
    await main.runUsage(w.deps);
    expect(usageRows(w).filter((row) => row.organizationId === BIG)).toHaveLength(1);
  });
});
