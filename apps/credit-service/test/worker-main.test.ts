import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env: unknown;
    public constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const main = await import("../src/worker-main.js");
const { OWNER, SCRIPT_A, objectKey, world } = await import("./doubles.js");
type World = ReturnType<typeof world>;

const environmentOf = (w: World, overrides: Record<string, unknown> = {}) => ({
  CREDIT_ENVIRONMENT: "development",
  WFP_USAGE_NAMESPACE: "ohmyho-test",
  USAGE_LOGS: w.usageLogs,
  CREDIT_LOG: w.creditLog,
  CREDIT_RUNTIME: w.core,
  NEON_USAGE: w.neon,
  R2_USAGE: w.r2,
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe("readEnvironment", () => {
  it("accepts the complete set of bindings", () => {
    const w = world();
    expect(main.readEnvironment(environmentOf(w))).toMatchObject({
      CREDIT_ENVIRONMENT: "development",
      WFP_USAGE_NAMESPACE: "ohmyho-test",
      CREDIT_RUNTIME: w.core,
    });
  });

  it("refuses a NEON_USAGE binding without stopSchedules", () => {
    const w = world();
    expect(() =>
      main.readEnvironment(environmentOf(w, { NEON_USAGE: { collectUsage: () => null } })),
    ).toThrow("credit_service_configuration_invalid");
  });

  it("refuses a Worker without every binding or with an unknown environment", () => {
    const w = world();
    const invalid = "credit_service_configuration_invalid";
    expect(() => main.readEnvironment(undefined)).toThrow(invalid);
    for (const change of [
      { CREDIT_ENVIRONMENT: "staging" },
      { WFP_USAGE_NAMESPACE: "Bad Namespace" },
      { WFP_USAGE_NAMESPACE: 5 },
      { USAGE_LOGS: undefined },
      { USAGE_LOGS: {} },
      { CREDIT_LOG: { get: () => null } },
      { CREDIT_RUNTIME: { postUsage: () => null } },
      { NEON_USAGE: null },
      { NEON_USAGE: { collectUsage: () => null } },
      { CREDIT_RUNTIME: withoutSweep(w) },
      { R2_USAGE: {} },
    ])
      expect(() => main.readEnvironment(environmentOf(w, change))).toThrow(invalid);
  });
});

/** A Core that offers every method but the budget sweep's listing. */
function withoutSweep(w: World) {
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w.core)).filter(
    (name) => name !== "constructor" && name !== "listStopBudgetProjects",
  );
  return Object.fromEntries(methods.map((name) => [name, () => null]));
}

describe("runUsage", () => {
  it("runs every source and then the rotation attempt", async () => {
    const w = world();
    w.core.cursors.set("wfp", "2026-10-30T09:00:00.000Z");
    w.core.cursors.set("pgcf", "2026-10-30T07:00:00.000Z");
    w.core.cursors.set("r2", "2026-10-30T00:00:00.000Z");
    w.core.cursors.set("resources", "2026-10-30T00:00:00.000Z");
    await main.runUsage(w.deps);
    expect(w.events.map((event) => [event["event"], event["source"] ?? event["status"]])).toEqual([
      ["credit_usage_source", "wfp"],
      ["credit_usage_source", "pgcf"],
      ["credit_usage_source", "r2"],
      ["credit_usage_source", "resources"],
      ["credit_log_rotation", "empty"],
    ]);
  });

  it("isolates a failing source, still runs the others and fails the invocation", async () => {
    const w = world();
    for (const source of ["pgcf", "r2", "resources"])
      w.core.cursors.set(source, "2026-10-29T00:00:00.000Z");
    w.core.cursors.set("wfp", "2026-10-30T08:00:00.000Z");
    w.core.scripts.set(SCRIPT_A, OWNER(SCRIPT_A));
    w.usageLogs.seed(objectKey(8, 10, 0, "bad"), "not gzip");
    w.core.failOn = (method, input) => method === "readCursor" && input === "pgcf";

    await expect(main.runUsage(w.deps)).rejects.toThrow("credit_service_incomplete:wfp,pgcf");

    const sources = w.events.filter((event) => event["event"] === "credit_usage_source");
    expect(sources.map((event) => [event["source"], event["level"]])).toEqual([
      ["wfp", "error"],
      ["pgcf", "error"],
      ["r2", "info"],
      ["resources", "info"],
    ]);
    expect(w.core.cursors.get("r2")).toBe("2026-10-30T00:00:00.000Z");
    expect(sources[1]).toMatchObject({ error: "readCursor failed" });
    // The rotation attempt still ran: the cursors of the failed sources are behind midnight, so it waits.
    expect(w.events.at(-1)).toMatchObject({
      event: "credit_log_rotation",
      status: "waiting",
    });
  });

  it("fails the invocation for a stop that failed only after every source and the rotation ran", async () => {
    const w = world();
    w.core.cursors.set("wfp", "2026-10-30T09:00:00.000Z");
    w.core.cursors.set("pgcf", "2026-10-30T09:00:00.000Z");
    w.core.cursors.set("r2", "2026-10-30T00:00:00.000Z");
    w.core.cursors.set("resources", "2026-10-30T00:00:00.000Z");
    w.core.stopBudgetProjects = [{ organizationId: "org_1", projectId: "prj_1" }];
    w.neon.stopAnswer = () => {
      throw new Error("provider down");
    };

    await expect(main.runUsage(w.deps)).rejects.toThrow("credit_service_incomplete:pgcf");

    const pgcf = w.events.find(
      (event) => event["event"] === "credit_usage_source" && event["source"] === "pgcf",
    );
    expect(pgcf).toMatchObject({
      level: "error",
      problems: ["schedule_stop_failed:prj_1"],
    });
    expect(w.events.map((event) => event["event"] ?? event["source"])).toEqual([
      "credit_usage_source",
      "credit_usage_source",
      "credit_usage_source",
      "credit_usage_source",
      "credit_log_rotation",
    ]);
  });

  it("reports an error of the rotation itself", async () => {
    const w = world();
    w.core.failOn = (method) => method === "cursorsThrough";
    await expect(main.runUsage(w.deps)).rejects.toThrow("credit_service_incomplete:rotation");
    expect(w.events.at(-1)).toMatchObject({ event: "credit_log_rotation", level: "error" });
  });
});

describe("runRotation", () => {
  it("logs a rotation that waits for the cursors without failing", async () => {
    const w = world();
    w.core.cursors.set("wfp", "2026-10-29T23:00:00.000Z");
    expect(await main.runRotation(w.deps)).toMatchObject({ status: "waiting", blocking: ["wfp"] });
    expect(w.events).toEqual([
      expect.objectContaining({ event: "credit_log_rotation", level: "info" }),
    ]);
  });

  it("fails the invocation when the rotation reports a problem", async () => {
    const w = world();
    w.core.cursors.set("wfp", "2026-10-30T09:00:00.000Z");
    w.core.addRow("org_1", "2026-10-29T10:00:00.000Z");
    w.core.deleteLogThrough = async () => ({ deleted: 3 });
    await expect(main.runRotation(w.deps)).rejects.toThrow("credit_service_rotation_problem");
    expect(w.events.at(-1)).toMatchObject({ level: "error", problems: ["credit_log_deleted:3/1"] });
  });
});

/** The cron list of a checked-in profile, read the way the deployable configuration tests read it. */
async function declaredCrons(file: string): Promise<string[]> {
  const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
  return [...config.triggers.crons].sort();
}

describe("the Worker", () => {
  it("dispatches exactly the crons that the three checked-in profiles declare", async () => {
    expect([main.USAGE_CRON, main.ROTATION_CRON]).toEqual(["27,57 * * * *", "0 0 * * *"]);
    const expected = [main.ROTATION_CRON, main.USAGE_CRON].sort();
    for (const file of [
      "wrangler.jsonc",
      "wrangler.development.jsonc",
      "wrangler.production.jsonc",
    ]) {
      expect(await declaredCrons(file), file).toEqual(expected);
    }
  });

  it("dispatches scheduled() on the cron text", async () => {
    const w = world();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const env = environmentOf(w);

    await main.default.scheduled({ cron: main.USAGE_CRON }, env);
    expect(
      info.mock.calls.map(([line]) => (JSON.parse(String(line)) as { event: string }).event),
    ).toEqual([
      "credit_usage_source",
      "credit_usage_source",
      "credit_usage_source",
      "credit_usage_source",
      "credit_log_rotation",
    ]);

    info.mockClear();
    await main.default.scheduled({ cron: main.ROTATION_CRON }, env);
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      event: "credit_log_rotation",
      status: "empty",
    });

    await expect(main.default.scheduled({ cron: "* * * * *" }, env)).rejects.toThrow(
      "credit_service_cron_unknown",
    );
    await expect(main.default.scheduled({ cron: main.USAGE_CRON }, {})).rejects.toThrow(
      "credit_service_configuration_invalid",
    );
  });

  it("writes failures to the error log and has no public route", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    main.consoleLog({ event: "x", level: "error" });
    main.consoleLog({ event: "y" });
    expect(error).toHaveBeenCalledWith('{"event":"x","level":"error"}');
    expect(info).toHaveBeenCalledWith('{"event":"y"}');

    const response = main.default.fetch();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found" });
  });

  it("serves the usage report through CreditServiceRuntime", async () => {
    const w = world();
    w.core.addRow("org_1", "2026-10-30T08:00:00.000Z", "settle", "settle:today");
    const runtime = new main.CreditServiceRuntime({}, environmentOf(w) as never);
    const rows = await runtime.readUsage({
      organizationId: "org_1",
      from: "2026-10-30T00:00:00.000Z",
      to: "2026-10-30T12:00:00.000Z",
    });
    expect(rows.map((row) => row.key)).toEqual(["settle:today"]);
    await expect(runtime.readUsage({})).rejects.toThrow("credit_service_usage_query_invalid");
  });

  it("builds dependencies from the bindings", () => {
    const w = world();
    const deps = main.dependenciesOf(main.readEnvironment(environmentOf(w)));
    expect(deps).toMatchObject({ core: w.core, namespace: "ohmyho-test", neon: w.neon, r2: w.r2 });
    expect(typeof deps.now()).toBe("number");
  });
});
