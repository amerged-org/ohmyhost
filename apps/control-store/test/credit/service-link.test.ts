import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CatalogContext } from "../../src/catalog/common.js";
import { createCreditCommands, setProjectBudget } from "../../src/catalog/credit/index.js";
import { bucketOf, SharedCoreRouter } from "../../src/router.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedCandidate } from "../support/provisioning-cleanup-fixtures.js";
import type { CreditCore, Dependencies } from "../../../credit-service/src/port.js";
import { runPgcf } from "../../../credit-service/src/pgcf.js";
import { runR2 } from "../../../credit-service/src/r2.js";
import { readUsage } from "../../../credit-service/src/report.js";
import { runResources } from "../../../credit-service/src/resources.js";
import { rotateCreditLog, shardKey, shardOf } from "../../../credit-service/src/rotation.js";
import { newReport, postOrganizations, splitParts } from "../../../credit-service/src/source.js";
import { runWfp } from "../../../credit-service/src/wfp.js";
import {
  FakeNeon,
  FakeR2,
  MemoryBucket,
  RATE_CARDS,
  logObject,
  objectKey,
} from "../../../credit-service/test/doubles.js";
import { ulidOf } from "../support/platform-fixtures.js";
import { addBucket, addHostname, exec, servePgcf } from "./attribution-fixtures.js";
import { accountOf, all, newOrganization, OCT } from "./support.js";

/*
 * The credit service against the real Core: the service's four usage passes and its log rotation run over the
 * `CreditRuntime` commands on a real D1 database; only the provider side (Logpush bucket, PGCF and R2 collectors,
 * the rotation bucket) is in memory. This is where the two lanes meet: the Core's answers must satisfy the service's
 * port, and the service's calls must leave the Core's log exactly as the rotation expects it.
 */

/** 2026-10-31T03:20Z: the passes see 2026-10-30 as a finished day, three hours into the next one. */
const NOW = Date.UTC(2026, 9, 31, 3, 20, 0);
const CORE_CLOCK = "2026-10-31T03:20:00.000000Z";

let control: TestControl;
let core: CreditCore;
beforeAll(async () => {
  control = await createTestControl();
  const context: CatalogContext = {
    directory: control.core,
    router: new SharedCoreRouter(control.core),
  };
  // the commands ARE the port: this assignment is the compile-time proof that the Core answers in the service's types
  core = createCreditCommands(
    (command) => (input) => command(context, input),
    () => CORE_CLOCK,
  );
}, 120_000);
afterAll(async () => control.dispose());

/** The published cards of the service's tests, with every meter activated before the first window used here. */
async function publishRates(): Promise<void> {
  const published = "2026-09-07T00:00:00.000000Z";
  for (const [index, card] of RATE_CARDS.entries()) {
    await exec(
      control,
      "INSERT INTO published_credit_rate_cards(rate_card_id, published_at, effective_from, rates) VALUES (?1, ?2, ?3, ?4)",
      card.rateCardId,
      published,
      // one card takes effect per second: the effective instant of a card is unique
      `2026-09-07T00:00:0${String(index)}.000000Z`,
      JSON.stringify(card.rates),
    );
    for (const rate of card.rates as { meter: string }[])
      await exec(
        control,
        "INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at) VALUES (?1, ?2, ?3, ?3)",
        rate.meter,
        card.rateCardId,
        published,
      );
  }
}

describe("the credit service over the real Core", () => {
  it("bills every source once, rotates the finished day and loses no row", async () => {
    await publishRates();
    const p = await newOrganization(control);
    const dev = await seedCandidate(p, { stagedAt: "2026-10-28T10:00:00.000000Z" });
    await addBucket(control, p, p.devEnvironmentId);
    await addHostname(
      control,
      p,
      `shop-${p.projectId.toLowerCase()}.example.com`,
      "2026-10-29T09:00:00.000000Z",
    );
    const database = await servePgcf(control, p, { activatedAt: "2026-10-30T09:20:00.000000Z" });
    // a database that stopped serving before the window; the provider never finalizes its rows
    const retired = await servePgcf(control, p, {
      activatedAt: "2026-10-30T09:20:00.000000Z",
      endedAt: "2026-10-30T20:30:00.000000Z",
      assigned: [],
    });

    // provider side: Logpush objects of the last hour of 2026-10-30 and of the first of 2026-10-31, the collectors
    const usageLogs = new MemoryBucket();
    usageLogs.seed(
      objectKey(23, 5, 0, "late", "20261030"),
      logObject([{ script: dev.script, cpu: 4 }, { script: dev.script }]),
    );
    usageLogs.seed(
      objectKey(24, 5, 0, "early", "20261031"),
      logObject([{ script: dev.script, cpu: 6 }]),
    );
    const neon = new FakeNeon();
    neon.answer = ({ from, to }) => ({
      from,
      to,
      rollups: ["2026-10-30T23:00:00.000Z", "2026-10-31T00:00:00.000Z"].flatMap((hourStart) => [
        { databaseId: database.databaseId, hourStart, memoryMibMilliseconds: "1843200000" },
        { databaseId: "dstrangerstrangerstr", hourStart, memoryMibMilliseconds: "5" },
      ]),
      pending: ["2026-10-30T23:00:00.000Z", "2026-10-31T00:00:00.000Z"].map((hourStart) => ({
        databaseId: retired.databaseId,
        hourStart,
      })),
      unbillableHours: 0,
    });
    const r2 = new FakeR2();
    r2.answer = ({ day, buckets }) => ({
      day,
      buckets: buckets.map((bucket) => ({
        ...bucket,
        storagePeakBytes: "5000000000",
        classA: "2000",
        classB: "30000",
        inexactHours: 0,
      })),
    });
    const creditLog = new MemoryBucket();
    const events: Record<string, unknown>[] = [];
    const deps: Dependencies = {
      core,
      usageLogs,
      creditLog,
      neon,
      r2,
      namespace: "ohmyho-test",
      now: () => NOW,
      log: (event) => events.push(event),
    };
    for (const [source, through] of [
      ["wfp", "2026-10-30T23:00:00.000Z"],
      ["pgcf", "2026-10-30T23:00:00.000Z"],
      ["r2", "2026-10-30T00:00:00.000Z"],
      ["resources", "2026-10-30T00:00:00.000Z"],
    ] as const)
      await core.advanceCursor({ source, through });

    // the hourly pass: the sources in the order of the cron, the wfp window of today before the pgcf window of yesterday
    const reports = [
      await runWfp(deps),
      await runPgcf(deps),
      await runR2(deps),
      await runResources(deps),
    ];
    expect(
      reports.map((report) => [report.source, report.windows, report.posted, report.problems]),
    ).toEqual([
      ["wfp", 4, 2, []],
      ["pgcf", 2, 2, []],
      ["r2", 1, 1, []],
      ["resources", 1, 1, []],
    ]);
    expect(reports[1]?.counters["databases_unowned"]).toBe(2);
    expect(reports[1]?.counters["pending_ignored"]).toBe(2);
    expect(await core.cursorsThrough()).toEqual([
      { source: "pgcf", through: "2026-10-31T01:00:00.000Z" },
      { source: "r2", through: "2026-10-31T00:00:00.000Z" },
      { source: "resources", through: "2026-10-31T00:00:00.000Z" },
      { source: "wfp", through: "2026-10-31T03:00:00.000Z" },
    ]);

    // what the Core holds now: the renewal of the Core's clock and six postings, each under its window
    const before = await core.readLogsToday({ organizationId: p.organizationId });
    expect(before.map((row) => [row.kind, row.at]).sort()).toEqual(
      [
        ["renew", "2026-10-31T03:20:00.000Z"],
        ["usage", "2026-10-30T23:00:00.000Z"],
        ["usage", "2026-10-31T00:00:00.000Z"],
        ["usage", "2026-10-30T23:00:00.000Z"],
        ["usage", "2026-10-31T00:00:00.000Z"],
        ["usage", "2026-10-30T00:00:00.000Z"],
        ["usage", "2026-10-30T00:00:00.000Z"],
      ].sort(),
    );
    for (const row of before) expect(new Date(row.at).toISOString()).toBe(row.at);
    const charged = before
      .filter((row) => row.kind === "usage")
      .reduce((sum, row) => sum + row.deltaMicros, 0);
    expect(charged).toBeLessThan(0);
    // the account started with the monthly 200 credits; the last posting leaves what all of them cost
    expect(before.at(-1)?.balanceMicros).toBe(200_000_000 + charged);
    const usage = Object.fromEntries(
      before
        .filter((row) => row.kind === "usage")
        .map((row) => [row.key.split(":")[1] + row.at, row]),
    );
    const meters = (source: string, at: string) =>
      (usage[source + at]?.detail as { lines: { meter: string }[] }).lines
        .map((line) => line.meter)
        .sort();
    expect(meters("wfp", "2026-10-30T23:00:00.000Z")).toEqual(["wfp.cpu", "wfp.requests"]);
    expect(meters("pgcf", "2026-10-30T23:00:00.000Z")).toEqual(["pgcf.memory.active"]);
    expect(meters("r2", "2026-10-30T00:00:00.000Z")).toEqual([
      "r2.class_a",
      "r2.class_b",
      "r2.storage.standard",
    ]);
    expect(meters("resources", "2026-10-30T00:00:00.000Z")).toEqual([
      "domain.custom_hostname",
      "wfp.script",
    ]);
    // the script of the dev environment is billed to the dev environment, the PGCF database of a shared data
    // environment to its physical environment, the hostname to prod
    const lineOf = (source: string, at: string, meter: string) =>
      (
        usage[source + at]?.detail as { lines: { meter: string; environmentId: string }[] }
      ).lines.find((line) => line.meter === meter);
    expect(lineOf("wfp", "2026-10-30T23:00:00.000Z", "wfp.requests")?.environmentId).toBe(
      p.devEnvironmentId,
    );
    expect(lineOf("pgcf", "2026-10-30T23:00:00.000Z", "pgcf.memory.active")?.environmentId).toBe(
      database.physical,
    );
    expect(
      lineOf("resources", "2026-10-30T00:00:00.000Z", "domain.custom_hostname")?.environmentId,
    ).toBe(p.prodEnvironmentId);
    expect(lineOf("resources", "2026-10-30T00:00:00.000Z", "wfp.script")?.environmentId).toBe(
      p.devEnvironmentId,
    );
    expect(lineOf("r2", "2026-10-30T00:00:00.000Z", "r2.storage.standard")?.environmentId).toBe(
      p.devEnvironmentId,
    );

    // the window of 00:00 was posted BEFORE the window of 23:00 of the day before: its seq is lower
    const seqOf = (source: string, at: string) => usage[source + at]?.seq ?? 0;
    expect(seqOf("wfp", "2026-10-31T00:00:00.000Z")).toBeLessThan(
      seqOf("pgcf", "2026-10-30T23:00:00.000Z"),
    );

    // the rotation at the start of 2026-10-31: the four postings of 2026-10-30 go to R2, the others stay
    const rotation = await rotateCreditLog(deps);
    expect(rotation).toMatchObject({
      status: "rotated",
      days: ["2026-10-30"],
      rows: 4,
      deleted: 4,
      problems: [],
    });
    const kept = await core.readLogsToday({ organizationId: p.organizationId });
    expect(kept.map((row) => row.key).sort()).toEqual(
      before
        .filter((row) => row.at >= "2026-10-31T00:00:00.000Z")
        .map((row) => row.key)
        .sort(),
    );
    expect(kept.map((row) => row.kind).sort()).toEqual(["renew", "usage", "usage"]);
    expect(
      await all<{ n: number }>(
        control.core,
        "SELECT count(*) AS n FROM credit_log WHERE at < ?",
        "2026-10-31T00:00:00.000000Z",
      ),
    ).toEqual([{ n: 0 }]);
    expect(creditLog.objects.has(shardKey("2026-10-30", await shardOf(p.organizationId)))).toBe(
      true,
    );
    expect(await rotateCreditLog(deps)).toMatchObject({ status: "empty" });

    // the usage report: the rotated postings from R2 and the rows the Core still holds, each exactly once
    const report = await readUsage(deps, {
      organizationId: p.organizationId,
      from: "2026-10-30T00:00:00.000Z",
      to: "2026-10-31T04:00:00.000Z",
    });
    expect(report.map((row) => row.key).sort()).toEqual(before.map((row) => row.key).sort());
    expect(report.map((row) => row.at)).toEqual([...report.map((row) => row.at)].sort());

    // a second hourly pass has nothing left to do and posts nothing twice
    const again = [
      await runWfp(deps),
      await runPgcf(deps),
      await runR2(deps),
      await runResources(deps),
    ];
    expect(again.map((row) => [row.windows, row.posted, row.duplicates])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(events.filter((event) => event["level"] === "error")).toEqual([]);
  });

  it("holds an unknown Native creation across hours and charges its original hour after recovery", async () => {
    const p = await newOrganization(control),
      databaseId = "d1234567890123456789";
    await exec(
      control,
      `INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state,dispatched_at)
      VALUES(?1,?2,?3,'operation','claim','provider','name','eu-dev','r256-s500m','original-key','dispatched','2026-10-31T01:20:00.000000Z')`,
      p.organizationId,
      p.projectId,
      p.devEnvironmentId,
    );
    const neon = new FakeNeon();
    neon.answer = ({ from, to }) => ({
      from,
      to,
      rollups: [
        { databaseId, hourStart: "2026-10-31T01:00:00.000Z", memoryMibMilliseconds: "921600000" },
      ],
      pending: [],
      unbillableHours: 0,
    });
    const deps = {
      core,
      usageLogs: new MemoryBucket(),
      creditLog: new MemoryBucket(),
      neon,
      r2: new FakeR2(),
      namespace: "ohmyho-test",
      now: () => NOW + 2 * 60 * 60 * 1000,
      log: () => undefined,
    };
    expect(await runPgcf(deps)).toMatchObject({ status: "waiting", posted: 0 });
    expect(await core.readCursor("pgcf")).toBe("2026-10-31T01:00:00.000Z");
    await exec(
      control,
      `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from)
      VALUES(?1,?2,'provider',?3,'provider-operation','eu-dev','r256-s500m',1,'2026-10-31T01:20:00.000000Z','2026-10-31T01:00:00.000000Z')`,
      p.organizationId,
      p.projectId,
      databaseId,
    );
    await exec(
      control,
      "UPDATE native_auth_database_operations SET state='observed',database_id=?3,provider_operation_id='provider-operation' WHERE organization_id=?1 AND project_id=?2",
      p.organizationId,
      p.projectId,
      databaseId,
    );
    const result = await runPgcf(deps);
    expect(result.problems).toEqual([]);
    const rows = await core.readLogsToday({ organizationId: p.organizationId });
    const usage = rows.find((row) => row.kind === "usage");
    expect(usage).toMatchObject({
      deltaMicros: -10_000_000,
      detail: {
        lines: [
          expect.objectContaining({
            projectId: p.projectId,
            environmentId: null,
            resourceKind: "native_auth_database",
          }),
        ],
      },
    });
    expect(
      await all<{ used_micros: number }>(
        control.core,
        "SELECT used_micros FROM project_credit WHERE organization_id=?1 AND project_id=?2",
        p.organizationId,
        p.projectId,
      ),
    ).toEqual([{ used_micros: 10_000_000 }]);
  });
});

describe("a window beyond the Core's input cap over the real Core", () => {
  it("is booked in the layout it began with, with real ids, whichever side of 2000 lines a retry falls", async () => {
    const p = await newOrganization(control);
    const lineOf = (index: number) => ({
      projectId: p.projectId,
      environmentId: ulidOf("window-environment", index),
      meter: "wfp.requests",
      quantity: "1",
      unit: "request",
      rateCardId: "usage-2026-10-v1",
      chargeMicros: 2,
    });
    const lines = (count: number) => Array.from({ length: count }, (_, index) => lineOf(index + 1));
    const deps = (commands: CreditCore): Dependencies => ({
      core: commands,
      usageLogs: new MemoryBucket(),
      creditLog: new MemoryBucket(),
      neon: new FakeNeon(),
      r2: new FakeR2(),
      namespace: "ohmyho-test",
      now: () => NOW,
      log: () => undefined,
    });
    const post = (commands: CreditCore, window: string, count: number) =>
      postOrganizations(
        deps(commands),
        newReport("wfp"),
        window,
        new Map([[p.organizationId, lines(count)]]),
      );
    const usageOf = async (window: string) =>
      (await core.readLogsToday({ organizationId: p.organizationId })).filter(
        (row) => row.kind === "usage" && row.at === window,
      );
    const booked = (rows: { detail: unknown }[]) =>
      rows.flatMap((row) => (row.detail as { lines: { environmentId: string }[] }).lines);

    // Split, then fewer lines: the last part fails once; the retry follows the booked layout and books it.
    const split = "2026-10-30T10:00:00.000Z";
    const last = Math.max(...splitParts(lines(2001)).map((part) => part.part));
    let lost = true;
    const flaky: CreditCore = {
      ...core,
      postUsage: async (input) => {
        if (lost && input.part === last) throw new Error("lost");
        return core.postUsage(input);
      },
    };
    await expect(post(flaky, split, 2001)).rejects.toThrow("lost");
    lost = false;
    await post(flaky, split, 2000);
    const parts = await usageOf(split);
    const environments = booked(parts).map((line) => line.environmentId);
    expect(new Set(environments).size).toBe(environments.length);
    for (const line of lines(2000)) expect(environments).toContain(line.environmentId);
    expect(parts.every((row) => (row.detail as { split?: boolean }).split === true)).toBe(true);
    expect(await all(control.core, "SELECT 1 FROM usage_post_failure")).toEqual([]);
    expect(parts.every((row) => row.key.startsWith(`usage:wfp:${p.organizationId}:`))).toBe(true);
    expect((await accountOf(control.core, p.organizationId)).monthly_micros).toBe(
      200_000_000 - 2 * environments.length,
    );
    const again = newReport("wfp");
    await postOrganizations(deps(core), again, split, new Map([[p.organizationId, lines(2000)]]));
    expect(again).toMatchObject({ posted: 0, duplicates: parts.length });

    // Whole, then one more line: the window stays what it was, and the extra line is a late line of a booked key.
    const whole = "2026-10-30T11:00:00.000Z";
    await post(core, whole, 2000);
    await post(core, whole, 2001);
    const one = await usageOf(whole);
    expect(one).toHaveLength(1);
    expect(booked(one)).toHaveLength(2000);
    expect(one[0]?.key).toBe(`usage:wfp:${p.organizationId}:2026-10-30T11:00:00.000000Z`);
  });
});

describe("a posting the Core cannot book, over the real Core", () => {
  it("dead-letters a refused posting at once even when only the message of its error crosses the binding, and holds one the network lost", async () => {
    const p = await newOrganization(control);
    const good = {
      projectId: p.projectId,
      environmentId: ulidOf("refused-environment", 1),
      meter: "wfp.requests",
      quantity: "1",
      unit: "request",
      rateCardId: "usage-2026-10-v1",
      chargeMicros: 2,
    };
    const window = "2026-10-30T12:00:00.000Z";
    const post = (commands: CreditCore, lines: unknown[]) =>
      postOrganizations(
        {
          core: commands,
          usageLogs: new MemoryBucket(),
          creditLog: new MemoryBucket(),
          neon: new FakeNeon(),
          r2: new FakeR2(),
          namespace: "ohmyho-test",
          now: () => NOW,
          log: () => undefined,
        },
        newReport("wfp"),
        window,
        new Map([[p.organizationId, lines as (typeof good)[]]]),
      );
    // what a Workers RPC hop leaves of a validation error: a plain Error that carries the message
    const plain: CreditCore = {
      ...core,
      postUsage: (input) =>
        core.postUsage(input).catch((error: unknown) => {
          throw new Error(error instanceof Error ? error.message : "unknown");
        }),
    };
    const kept = () =>
      all<{ attempts: number }>(control.core, "SELECT attempts FROM usage_post_failure");

    // a line the Core rejects: dead at once, the window completes, the lines are kept for the replay
    const report = newReport("wfp");
    await postOrganizations(
      {
        core: plain,
        usageLogs: new MemoryBucket(),
        creditLog: new MemoryBucket(),
        neon: new FakeNeon(),
        r2: new FakeR2(),
        namespace: "ohmyho-test",
        now: () => NOW,
        log: () => undefined,
      },
      report,
      window,
      new Map([[p.organizationId, [{ ...good, projectId: "not-a-ulid" }]]]),
    );
    expect(report.problems).toEqual([
      `usage_post_failed:${p.organizationId}:${window}`,
      `usage_post_dead_lettered:${p.organizationId}:${window}`,
    ]);
    expect(await kept()).toEqual([{ attempts: 4 }]);
    await control.core.prepare("DELETE FROM usage_post_failure").run();

    // a network failure of a good posting is not a refusal: the window is held and the failure counted once
    const lost: CreditCore = {
      ...core,
      postUsage: () => Promise.reject(new Error("connect failed: connection refused")),
    };
    await expect(post(lost, [good])).rejects.toThrow("connection refused");
    expect(await kept()).toEqual([{ attempts: 1 }]);
  });

  it("records the failure of an organization whose bucket is fenced, so that it cannot hold the cursor of the others", async () => {
    const fenced = await newOrganization(control);
    let other = await newOrganization(control);
    while ((await bucketOf(other.organizationId)) === (await bucketOf(fenced.organizationId)))
      other = await newOrganization(control);
    const lineOf = (p: { projectId: string; devEnvironmentId: string }) => ({
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      meter: "wfp.requests",
      quantity: "1",
      unit: "request",
      rateCardId: "usage-2026-10-v1",
      chargeMicros: 2,
    });
    const window = "2026-10-30T13:00:00.000Z";
    const attempt = async () => {
      const report = newReport("wfp");
      await postOrganizations(
        {
          core,
          usageLogs: new MemoryBucket(),
          creditLog: new MemoryBucket(),
          neon: new FakeNeon(),
          r2: new FakeR2(),
          namespace: "ohmyho-test",
          now: () => NOW,
          log: () => undefined,
        },
        report,
        window,
        new Map([
          [fenced.organizationId, [lineOf(fenced)]],
          [other.organizationId, [lineOf(other)]],
        ]),
      );
      return report;
    };
    const kept = () =>
      all<{ attempts: number }>(
        control.core,
        "SELECT attempts FROM usage_post_failure WHERE organization_id = ?1",
        fenced.organizationId,
      );
    // an operator quarantines the bucket of one organization
    await exec(
      control,
      "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?1, 'moving', ?2, '2026-10-30T00:00:00.000000Z')",
      await bucketOf(fenced.organizationId),
      ulidOf("bucket-move", 1),
    );
    try {
      // its posting is refused by the fence and kept (the write of the failure is not behind the fence); the other
      // organization is billed; the window holds like for any failed posting, and then it completes
      for (const attempts of [1, 2, 3]) {
        await expect(attempt()).rejects.toThrow("fenced");
        expect(await kept()).toEqual([{ attempts }]);
      }
      expect((await attempt()).problems).toEqual([
        `usage_post_failed:${fenced.organizationId}:${window}`,
        `usage_post_dead_lettered:${fenced.organizationId}:${window}`,
      ]);
      expect(await kept()).toEqual([{ attempts: 4 }]);
      const billed = await core.readLogsToday({ organizationId: other.organizationId });
      expect(billed.filter((row) => row.kind === "usage")).toHaveLength(1);
      // the fence is lifted: the replay books the kept posting, so nothing of the fenced organization was lost
      await exec(control, "DELETE FROM bucket_fences");
      expect(await core.replayUsageFailures({ minAttempts: 4, limit: 20 })).toMatchObject({
        replayed: 1,
      });
      const replayed = await core.readLogsToday({ organizationId: fenced.organizationId });
      expect(replayed.filter((row) => row.kind === "usage")).toHaveLength(1);
      expect(await kept()).toEqual([]);
    } finally {
      await exec(control, "DELETE FROM bucket_fences");
    }
  });
});

describe("the budget sweep over the real Core", () => {
  it("disables only the stop budgets that the pass reached, again on the next pass, and nothing next month", async () => {
    const reached = await newOrganization(control);
    const continued = await newOrganization(control);
    const room = await newOrganization(control);
    const budget = (
      p: { organizationId: string; projectId: string },
      budgetMicros: number,
      mode: "continue" | "stop",
    ) =>
      control.core.batch(
        setProjectBudget(control.core, {
          organizationId: p.organizationId,
          projectId: p.projectId,
          budgetMicros,
          mode,
          now: OCT,
        }).statements,
      );
    await budget(reached, 1_000_000, "stop");
    await budget(continued, 1_000_000, "continue");
    await budget(room, 10_000_000, "stop");
    const use = (
      p: { organizationId: string; projectId: string; devEnvironmentId: string },
      chargeMicros: number,
    ) =>
      core.postUsage({
        organizationId: p.organizationId,
        source: "wfp",
        window: "2026-10-30T09:00:00.000Z",
        lines: [
          {
            projectId: p.projectId,
            environmentId: p.devEnvironmentId,
            meter: "wfp.requests",
            quantity: "1",
            unit: "request",
            rateCardId: "usage-2026-10-v1",
            chargeMicros,
          },
        ],
      });
    await use(reached, 1_000_000);
    await use(continued, 5_000_000);
    await use(room, 1_000_000);

    const neon = new FakeNeon();
    const passWith = (commands: CreditCore) =>
      runPgcf({
        core: commands,
        usageLogs: new MemoryBucket(),
        creditLog: new MemoryBucket(),
        neon,
        r2: new FakeR2(),
        namespace: "ohmyho-test",
        now: () => NOW,
        log: () => undefined,
      });
    const reachedOnly = [{ organizationId: reached.organizationId, projectId: reached.projectId }];

    expect((await passWith(core)).problems).toEqual([]);
    expect(neon.stopRequests).toEqual(reachedOnly);
    await passWith(core);
    expect(neon.stopRequests).toEqual([...reachedOnly, ...reachedOnly]);

    // the next month: the use of October no longer counts, so nobody is asked
    const context: CatalogContext = {
      directory: control.core,
      router: new SharedCoreRouter(control.core),
    };
    const november = createCreditCommands(
      (command) => (input) => command(context, input),
      () => "2026-11-01T00:07:00.000000Z",
    );
    await passWith(november);
    expect(neon.stopRequests).toHaveLength(2);
  });
});
