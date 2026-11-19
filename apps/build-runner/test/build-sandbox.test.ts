import { parseBuildFailureExcerpt, type BuildStartCommand } from "@ohmyhost/build-broker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryR2Bucket, SandboxPlatformDouble } from "./doubles.js";

vi.mock("@cloudflare/containers", async () => ({
  Container: (await import("./doubles.js")).ContainerBaseDouble,
}));

const BUCKET = "ohmyho-builds-test";
const BUCKET_EU = "ohmyho-builds-test-eu";
const OPERATION_ID = "01J00000000000000000000003";
const START = new Date("2026-09-17T12:00:00.000Z");
const SOURCE = new TextEncoder().encode("source archive bytes");
const BUNDLE = new Uint8Array(5000).fill(7);
const outputs = {
  bundleKey: `runs/p/e/${OPERATION_ID}/output/bundle.tar.gz`,
  failureKey: `logs/p/e/${OPERATION_ID}.failure.json`,
  logKey: `logs/p/e/${OPERATION_ID}.log`,
};
const environment = [
  { name: "BUILD_INPUT_FINGERPRINT", value: `sha256:${"f".repeat(64)}` },
  { name: "BUILD_ID", value: `test-build:${OPERATION_ID}` },
  { name: "EXPECTED_SOURCE_SHA256", value: "a".repeat(64) },
  { name: "BUILD_PLAN_SHA256", value: "b".repeat(64) },
  { name: "APPLICATION_ROOT", value: "." },
  { name: "INSTALL_COMMAND", value: "pnpm install --frozen-lockfile" },
  { name: "BUILD_COMMAND", value: "pnpm run build" },
  { name: "BUILD_OUTPUT_DIRECTORY", value: "dist" },
  { name: "FRAMEWORK_ADAPTER", value: "vite-static" },
  { name: "FRAMEWORK_RUNTIME", value: "static" },
  { name: "SERVER_ENTRYPOINT", value: "" },
  { name: "SOURCE_COMMIT_SHA", value: "c".repeat(40) },
  { name: "PROJECT_ID", value: "01J00000000000000000000001" },
  { name: "ENVIRONMENT_ID", value: "01J00000000000000000000002" },
  { name: "DEPLOYMENT_ID", value: "01J00000000000000000000004" },
  { name: "OPERATION_ID", value: OPERATION_ID },
];

function setup() {
  const bucket = new MemoryR2Bucket();
  const source = bucket.seed(`runs/p/e/${OPERATION_ID}/input/source.tar.gz`, SOURCE);
  const command: BuildStartCommand = {
    buildProject: "test-build",
    buildId: `test-build:${OPERATION_ID}`,
    idempotencyToken: `oh-${OPERATION_ID}-${"b".repeat(32)}`,
    environment,
    source: {
      bucket: BUCKET,
      key: `runs/p/e/${OPERATION_ID}/input/source.tar.gz`,
      versionId: source.version,
      sha256: "a".repeat(64),
      byteLength: SOURCE.byteLength,
    },
    outputs,
  };
  const platform = new SandboxPlatformDouble();
  return { bucket, command, platform };
}

async function sandboxOver(
  platform: SandboxPlatformDouble,
  bucket: MemoryR2Bucket,
  region: "us" | "eu" = "us",
  otherBucket = new MemoryR2Bucket(),
) {
  const { BuildSandbox, BuildSandboxEu } = await import("../src/build-sandbox.js");
  const [us, eu] = region === "us" ? [bucket, otherBucket] : [otherBucket, bucket];
  return new (region === "us" ? BuildSandbox : BuildSandboxEu)(platform.context as never, {
    BUILD_OBJECTS_US: us,
    BUILD_OBJECTS_EU: eu,
    BUILD_OBJECTS_BUCKET_US: BUCKET,
    BUILD_OBJECTS_BUCKET_EU: BUCKET_EU,
  });
}

/** Starts the build and runs the launch tick: the agent has the source and is running. */
async function running() {
  const context = setup();
  const sandbox = await sandboxOver(context.platform, context.bucket);
  await expect(sandbox.startBuild(context.command)).resolves.toMatchObject({ ok: true });
  await context.platform.fire(sandbox);
  const agent = context.platform.agent;
  if (agent === null) throw new Error("the sandbox was not started");
  return { ...context, sandbox, agent };
}

function advance(milliseconds: number): void {
  vi.setSystemTime(new Date(Date.now() + milliseconds));
}

describe("build sandbox object", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds: source in, bundle and log out, measured usage, sandbox destroyed", async () => {
    const { bucket, command, platform } = setup();
    const sandbox = await sandboxOver(platform, bucket);

    await expect(sandbox.readBuild()).resolves.toBeNull();
    await expect(sandbox.startBuild(command)).resolves.toEqual({
      ok: true,
      buildId: command.buildId,
      projectName: "test-build",
    });
    expect(platform.scheduled).toEqual([{ seconds: 0, callback: "poll" }]);
    expect(platform.running).toBe(false);

    advance(1_000);
    await platform.fire(sandbox);
    const agent = platform.agent;
    if (agent === null) throw new Error("the sandbox was not started");
    expect(platform.startOptions).toEqual([
      {
        ports: [8080],
        startOptions: { envVars: { BUILD_AGENT_TOKEN: agent.token }, enableInternet: true },
      },
    ]);
    expect(agent.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(agent.source).toEqual(SOURCE);
    expect(agent.environment).toEqual(
      Object.fromEntries(environment.map(({ name, value }) => [name, value])),
    );
    expect(JSON.stringify(agent.environment)).not.toContain(agent.token);
    expect(platform.scheduled).toEqual([{ seconds: 5, callback: "poll" }]);
    await expect(sandbox.readBuild()).resolves.toEqual({
      buildId: command.buildId,
      projectName: "test-build",
      status: "IN_PROGRESS",
      startTime: START,
      operationId: OPERATION_ID,
      inputFingerprint: `sha256:${"f".repeat(64)}`,
      usage: null,
    });

    advance(5_000);
    await platform.fire(sandbox);
    expect(agent.requests.slice(-1)).toEqual(["GET /status"]);
    expect(platform.destroyed).toBe(0);

    agent.succeed(BUNDLE, "install\nbuild\n", "2026-09-17T12:01:30.000Z");
    advance(5_000);
    await platform.fire(sandbox);

    expect(bucket.objects.get(outputs.bundleKey)?.bytes).toEqual(BUNDLE);
    expect(bucket.contentType(outputs.bundleKey)).toBe("application/gzip");
    expect(bucket.text(outputs.logKey)).toBe("install\nbuild\n");
    expect(bucket.contentType(outputs.logKey)).toBe("text/plain; charset=utf-8");
    expect(bucket.objects.has(outputs.failureKey)).toBe(false);
    await expect(sandbox.readBuild()).resolves.toMatchObject({
      status: "SUCCEEDED",
      usage: {
        runner: "cloudflare-build-sandbox",
        instanceType: "standard-3",
        status: "SUCCEEDED",
        startedAt: "2026-09-17T12:00:00.000Z",
        provisioningStartedAt: "2026-09-17T12:00:01.000Z",
        // The observation clock (12:00:11), not the agent's 12:01:30: the agent's end is never billed.
        completedAt: "2026-09-17T12:00:11.000Z",
      },
    });
    expect(platform.destroyed).toBe(1);
    expect(platform.running).toBe(false);
    expect(platform.scheduled).toEqual([]);
    expect(platform.renewed).toBeGreaterThanOrEqual(3);
  });

  it("fails: the excerpt document and the log are stored, no bundle", async () => {
    const { agent, bucket, platform, sandbox } = await running();
    const failure = {
      schemaVersion: "ohmyhost.build-failure/v1",
      operationId: OPERATION_ID,
      excerpt: "error TS2304: Cannot find name 'x'.",
      truncated: false,
      logBytes: 35,
    };
    agent.fail(failure, "error TS2304: Cannot find name 'x'.", "2026-09-17T12:00:40.000Z");

    await platform.fire(sandbox);

    const stored = bucket.objects.get(outputs.failureKey)?.bytes;
    if (stored === undefined) throw new Error("the failure document was not stored");
    expect(parseBuildFailureExcerpt(stored, OPERATION_ID)).toEqual({
      excerpt: "error TS2304: Cannot find name 'x'.",
      truncated: false,
    });
    expect(bucket.contentType(outputs.failureKey)).toBe("application/json");
    expect(bucket.text(outputs.logKey)).toBe("error TS2304: Cannot find name 'x'.");
    expect(bucket.objects.has(outputs.bundleKey)).toBe(false);
    await expect(sandbox.readBuild()).resolves.toMatchObject({
      status: "FAILED",
      usage: { status: "FAILED", completedAt: "2026-09-17T12:00:00.000Z" },
    });
    expect(platform.destroyed).toBe(1);
    expect(platform.scheduled).toEqual([]);
  });

  it("fails without an excerpt or a log when the customer build printed nothing", async () => {
    const { agent, bucket, platform, sandbox } = await running();
    agent.fail(null, null, "2026-09-17T12:00:05.000Z");

    await platform.fire(sandbox);

    expect([...bucket.objects.keys()]).toEqual([`runs/p/e/${OPERATION_ID}/input/source.tar.gz`]);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "FAILED" });
    expect(platform.destroyed).toBe(1);
  });

  it("succeeds with a bundle and no log object when a silent build wrote an empty log", async () => {
    const { agent, bucket, platform, sandbox } = await running();
    agent.succeed(BUNDLE, "", "2026-09-17T12:01:30.000Z");

    await platform.fire(sandbox);

    expect(bucket.objects.get(outputs.bundleKey)?.bytes).toEqual(BUNDLE);
    expect(bucket.objects.has(outputs.logKey)).toBe(false);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(platform.destroyed).toBe(1);
  });

  it("fails, not faults, when a failing build wrote an empty log", async () => {
    const { agent, bucket, platform, sandbox } = await running();
    agent.fail(null, "", "2026-09-17T12:00:05.000Z");

    await platform.fire(sandbox);

    expect(bucket.objects.has(outputs.logKey)).toBe(false);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "FAILED" });
    expect(platform.destroyed).toBe(1);
  });

  it("times out a build that never reaches running and bills nothing", async () => {
    const { bucket, command, platform } = setup();
    const sandbox = await sandboxOver(platform, bucket);
    platform.startFailures = Number.POSITIVE_INFINITY;
    await sandbox.startBuild(command);

    await platform.fire(sandbox);
    expect(platform.scheduled).toEqual([{ seconds: 5, callback: "poll" }]);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "IN_PROGRESS" });

    advance(5 * 60_000 + 1);
    await platform.fire(sandbox);

    await expect(sandbox.readBuild()).resolves.toMatchObject({
      status: "TIMED_OUT",
      usage: {
        status: "TIMED_OUT",
        startedAt: "2026-09-17T12:00:00.000Z",
        provisioningStartedAt: null,
        completedAt: "2026-09-17T12:05:00.001Z",
      },
    });
    expect(platform.destroyed).toBe(1);
    expect(platform.scheduled).toEqual([]);
  });

  it("times out a build that runs longer than eight minutes and destroys its sandbox", async () => {
    const { bucket, platform, sandbox } = await running();

    advance(8 * 60_000);
    await platform.fire(sandbox);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "IN_PROGRESS" });

    advance(1);
    await platform.fire(sandbox);

    await expect(sandbox.readBuild()).resolves.toMatchObject({
      status: "TIMED_OUT",
      usage: {
        provisioningStartedAt: "2026-09-17T12:00:00.000Z",
        completedAt: "2026-09-17T12:08:00.001Z",
      },
    });
    expect(bucket.objects.has(outputs.bundleKey)).toBe(false);
    expect(platform.destroyed).toBe(1);
    expect(platform.running).toBe(false);
  });

  it("reports a crashed sandbox as a fault, never as a success", async () => {
    const { agent, bucket, platform, sandbox } = await running();
    agent.succeed(BUNDLE, null, "2026-09-17T12:00:30.000Z");
    platform.crash();

    advance(5_000);
    await platform.fire(sandbox);

    await expect(sandbox.readBuild()).resolves.toMatchObject({
      status: "FAULT",
      usage: { status: "FAULT", completedAt: "2026-09-17T12:00:05.000Z" },
    });
    expect(bucket.objects.has(outputs.bundleKey)).toBe(false);
    // The crashed sandbox is never started a second time.
    expect(platform.startOptions).toHaveLength(1);
    expect(platform.scheduled).toEqual([]);
  });

  it.each([
    [
      "an agent that lost its build",
      (agent: { statusBody: string | null }) => {
        agent.statusBody = JSON.stringify({
          state: "idle",
          startedAt: null,
          completedAt: null,
          failure: null,
        });
      },
      "sandbox_restarted",
    ],
    [
      "a status document with unknown members",
      (agent: { statusBody: string | null }) => {
        agent.statusBody = JSON.stringify({
          state: "succeeded",
          startedAt: "2026-09-17T12:00:01.000Z",
          completedAt: "2026-09-17T12:00:02.000Z",
          failure: null,
          extra: true,
        });
      },
      "status_unreadable",
    ],
    [
      "a completion before the start",
      (agent: { statusBody: string | null }) => {
        agent.statusBody = JSON.stringify({
          state: "succeeded",
          startedAt: "2026-09-17T12:00:02.000Z",
          completedAt: "2026-09-17T12:00:01.000Z",
          failure: null,
        });
      },
      "status_unreadable",
    ],
    [
      "an unknown state",
      (agent: { statusBody: string | null }) => {
        agent.statusBody = JSON.stringify({
          state: "paused",
          startedAt: null,
          completedAt: null,
          failure: null,
        });
      },
      "status_unreadable",
    ],
    [
      "a failure that is not a document",
      (agent: { statusBody: string | null }) => {
        agent.statusBody = JSON.stringify({
          state: "failed",
          startedAt: "2026-09-17T12:00:01.000Z",
          completedAt: "2026-09-17T12:00:02.000Z",
          failure: "text",
        });
      },
      "status_unreadable",
    ],
    [
      "a status that is not JSON",
      (agent: { statusBody: string | null }) => {
        agent.statusBody = "<html>";
      },
      "status_unreadable",
    ],
  ])("faults on %s", async (_name, corrupt, reason) => {
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const { agent, platform, sandbox } = await running();
    corrupt(agent);

    await platform.fire(sandbox);

    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "FAULT" });
    expect(platform.destroyed).toBe(1);
    // The operator has to tell a lost sandbox from an unreadable answer, not just see "FAULT".
    expect(warn).toHaveBeenCalledWith("build_sandbox_fault", {
      buildId: `test-build:${OPERATION_ID}`,
      reason,
    });
  });

  it("faults when another sandbox answers, when the bundle is empty and when it is too large", async () => {
    const foreign = await running();
    foreign.agent.refusals.set("GET /status", [401]);
    await foreign.platform.fire(foreign.sandbox);
    await expect(foreign.sandbox.readBuild()).resolves.toMatchObject({ status: "FAULT" });

    const empty = await running();
    empty.agent.succeed(new Uint8Array(0), null, "2026-09-17T12:00:30.000Z");
    await empty.platform.fire(empty.sandbox);
    await expect(empty.sandbox.readBuild()).resolves.toMatchObject({ status: "FAULT" });
    expect(empty.bucket.objects.has(outputs.bundleKey)).toBe(false);

    const large = await running();
    large.agent.succeed(new Uint8Array(30 * 1024 * 1024 + 1), null, "2026-09-17T12:00:30.000Z");
    await large.platform.fire(large.sandbox);
    await expect(large.sandbox.readBuild()).resolves.toMatchObject({ status: "FAULT" });
    expect(large.bucket.objects.has(outputs.bundleKey)).toBe(false);
    expect(large.platform.destroyed).toBe(1);

    const log = await running();
    log.agent.succeed(BUNDLE, "x".repeat(5 * 1024 * 1024 + 1), "2026-09-17T12:00:30.000Z");
    await log.platform.fire(log.sandbox);
    await expect(log.sandbox.readBuild()).resolves.toMatchObject({ status: "FAULT" });
  });

  it("keeps polling through an unreachable agent and unavailable outputs", async () => {
    const { agent, bucket, platform, sandbox } = await running();

    platform.unreachable = true;
    await platform.fire(sandbox);
    platform.unreachable = false;
    agent.refusals.set("GET /status", [503]);
    await platform.fire(sandbox);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "IN_PROGRESS" });

    agent.succeed(BUNDLE, "log", "2026-09-17T12:00:30.000Z");
    agent.refusals.set("GET /bundle", [500]);
    await platform.fire(sandbox);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "IN_PROGRESS" });
    expect(platform.destroyed).toBe(0);

    agent.refusals.set("GET /log", [500]);
    await platform.fire(sandbox);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "IN_PROGRESS" });
    expect(bucket.objects.get(outputs.bundleKey)?.bytes).toEqual(BUNDLE);

    // The bundle is already stored; the repeated tick leaves it and completes the build.
    const stored = bucket.objects.get(outputs.bundleKey)?.head.version;
    await platform.fire(sandbox);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(bucket.objects.get(outputs.bundleKey)?.head.version).toBe(stored);
    expect(bucket.text(outputs.logKey)).toBe("log");
    expect(platform.destroyed).toBe(1);
  });

  it("retries the launch until the agent has the source and accepted the start", async () => {
    const { bucket, command, platform } = setup();
    const sandbox = await sandboxOver(platform, bucket);
    await sandbox.startBuild(command);
    platform.startFailures = 1;
    await platform.fire(sandbox);
    expect(platform.agent).toBeNull();

    await platform.fire(sandbox);
    const agent = platform.agent;
    if (agent === null) throw new Error("the sandbox was not started");
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "IN_PROGRESS" });
    expect(agent.requests).toEqual(["PUT /source", "POST /start"]);

    const lost = setup();
    const second = await sandboxOver(lost.platform, lost.bucket);
    await second.startBuild(lost.command);
    lost.platform.startFailures = 0;
    await lost.platform.startAndWaitForPorts({
      startOptions: { envVars: { BUILD_AGENT_TOKEN: "t".repeat(64) } },
    });
    // The sandbox answers with another token until the object's own sandbox is up: a 401.
    await lost.platform.fire(second);
    await expect(second.readBuild()).resolves.toMatchObject({ status: "IN_PROGRESS" });
    expect(lost.platform.agent?.source).toBeNull();
  });

  it("replays a start whose answer was lost: the agent refuses the source and confirms the start", async () => {
    const { bucket, command, platform } = setup();
    const sandbox = await sandboxOver(platform, bucket);
    await sandbox.startBuild(command);
    await platform.startAndWaitForPorts({
      startOptions: {
        envVars: {
          BUILD_AGENT_TOKEN: (platform.stored.get("build") as { token: string }).token,
        },
      },
    });
    const agent = platform.agent;
    if (agent === null) throw new Error("the sandbox was not started");
    agent.refusals.set("PUT /source", [503]);
    await platform.fire(sandbox);
    expect(agent.requests).toEqual(["PUT /source"]);

    agent.refusals.set("POST /start", [502]);
    await platform.fire(sandbox);
    expect(agent.requests.slice(1)).toEqual(["PUT /source", "POST /start"]);
    expect(
      (platform.stored.get("build") as { runningSince: string | null }).runningSince,
    ).toBeNull();

    await platform.fire(sandbox);
    await platform.fire(sandbox);
    expect(agent.requests.slice(3)).toEqual(["PUT /source", "POST /start", "GET /status"]);
    expect(
      (platform.stored.get("build") as { runningSince: string | null }).runningSince,
    ).not.toBeNull();
  });

  it("faults when the source object is not the exact version or the agent refuses the input", async () => {
    const replaced = setup();
    replaced.bucket.seed(replaced.command.source.key, new TextEncoder().encode("another archive"));
    const first = await sandboxOver(replaced.platform, replaced.bucket);
    await first.startBuild(replaced.command);
    await replaced.platform.fire(first);
    await expect(first.readBuild()).resolves.toMatchObject({
      status: "FAULT",
      usage: { provisioningStartedAt: null },
    });
    expect(replaced.platform.agent?.source).toBeNull();
    expect(replaced.platform.destroyed).toBe(1);

    const missing = setup();
    missing.bucket.objects.clear();
    const second = await sandboxOver(missing.platform, missing.bucket);
    await second.startBuild(missing.command);
    await missing.platform.fire(second);
    await expect(second.readBuild()).resolves.toMatchObject({ status: "FAULT" });

    const refusedSource = setup();
    const third = await sandboxOver(refusedSource.platform, refusedSource.bucket);
    await third.startBuild(refusedSource.command);
    await refusedSource.platform.startAndWaitForPorts({
      startOptions: {
        envVars: {
          BUILD_AGENT_TOKEN: (refusedSource.platform.stored.get("build") as { token: string })
            .token,
        },
      },
    });
    refusedSource.platform.agent?.refusals.set("PUT /source", [413]);
    await refusedSource.platform.fire(third);
    await expect(third.readBuild()).resolves.toMatchObject({ status: "FAULT" });

    const refusedStart = setup();
    const invalid: BuildStartCommand = {
      ...refusedStart.command,
      environment: environment.filter(({ name }) => name !== "INSTALL_COMMAND"),
    };
    const fourth = await sandboxOver(refusedStart.platform, refusedStart.bucket);
    await fourth.startBuild(invalid);
    await refusedStart.platform.fire(fourth);
    await expect(fourth.readBuild()).resolves.toMatchObject({ status: "FAULT" });
    expect(refusedStart.platform.destroyed).toBe(1);
  });

  it("stops a running build, destroys the sandbox and keeps the first terminal status", async () => {
    const { agent, platform, sandbox, command } = await running();
    advance(20_000);

    await expect(sandbox.stopBuild()).resolves.toEqual({
      ok: true,
      buildId: command.buildId,
      status: "STOPPED",
    });
    expect(platform.destroyed).toBe(1);
    await expect(sandbox.readBuild()).resolves.toMatchObject({
      status: "STOPPED",
      usage: {
        status: "STOPPED",
        provisioningStartedAt: "2026-09-17T12:00:00.000Z",
        completedAt: "2026-09-17T12:00:20.000Z",
      },
    });
    await expect(sandbox.stopBuild()).resolves.toEqual({ ok: false, code: "BuildNotRunning" });

    // The tick that was still armed finds a terminal build and only stops polling.
    agent.succeed(BUNDLE, null, "2026-09-17T12:00:30.000Z");
    await platform.fire(sandbox);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "STOPPED" });
    expect(platform.scheduled).toEqual([]);
    expect(platform.destroyed).toBe(1);

    const unknown = setup();
    const never = await sandboxOver(unknown.platform, unknown.bucket);
    await expect(never.stopBuild()).resolves.toEqual({ ok: false, code: "BuildNotFound" });
  });

  it("reports a build that ended while the stop arrived as not running and keeps its status", async () => {
    const { platform, sandbox } = await running();
    const read = platform.storage.get;
    let reads = 0;
    platform.storage.get = async <T>(key: string): Promise<T | undefined> => {
      const value = await read<T>(key);
      reads += 1;
      // The tick that was in flight records its terminal status right after the stop's first read.
      if (reads === 1) platform.stored.set(key, { ...value, status: "FAILED" });
      return value;
    };

    await expect(sandbox.stopBuild()).resolves.toEqual({ ok: false, code: "BuildNotRunning" });

    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "FAILED" });
    expect(platform.destroyed).toBe(1);
  });

  it("repeats an identical start and refuses a different or malformed one", async () => {
    const { bucket, command, platform, sandbox } = await running();
    const record = structuredClone(platform.stored.get("build"));

    advance(30_000);
    await expect(sandbox.startBuild(structuredClone(command))).resolves.toEqual({
      ok: true,
      buildId: command.buildId,
      projectName: "test-build",
    });
    expect(platform.stored.get("build")).toEqual(record);
    expect(platform.startOptions).toHaveLength(1);
    expect(platform.scheduled).toEqual([{ seconds: 0, callback: "poll" }]);

    await expect(
      sandbox.startBuild({
        ...command,
        source: { ...command.source, versionId: "another-version" },
      }),
    ).resolves.toEqual({ ok: false, code: "BuildConflict" });
    expect(platform.stored.get("build")).toEqual(record);

    const fresh = await sandboxOver(new SandboxPlatformDouble(), bucket);
    const malformed: unknown[] = [
      null,
      { ...command, environment: "OPERATION_ID" },
      { ...command, environment: [{ name: "OPERATION_ID", value: 3 }] },
      { ...command, environment: environment.filter(({ name }) => name !== "OPERATION_ID") },
      {
        ...command,
        environment: [...environment, { name: "SSG_CACHE_MAX_BYTES", value: "33554432" }],
      },
      { ...command, environment: [...environment, { name: "NEXT_REVALIDATE_PATH", value: "1" }] },
      ...["true", "0", ""].map((value) => ({
        ...command,
        environment: [
          ...environment.filter(({ name }) => name !== "FRAMEWORK_ADAPTER"),
          { name: "FRAMEWORK_ADAPTER", value: "nextjs" },
          { name: "NEXT_REVALIDATE_PATH", value },
        ],
      })),
      ...["0", "01048576", "67108865", "68157440", "1048577", "not-a-limit"].map((value) => ({
        ...command,
        environment: [
          ...environment.filter(({ name }) => name !== "FRAMEWORK_ADAPTER"),
          { name: "FRAMEWORK_ADAPTER", value: "nextjs" },
          { name: "SSG_CACHE_MAX_BYTES", value },
        ],
      })),
      { ...command, buildId: "test-build:01J00000000000000000000009" },
      { ...command, buildProject: 7 },
      { ...command, idempotencyToken: undefined },
      { ...command, source: { ...command.source, bucket: "another-bucket" } },
      { ...command, source: { ...command.source, versionId: "" } },
      { ...command, source: { ...command.source, byteLength: 0 } },
      { ...command, source: null },
      { ...command, outputs: { ...outputs, logKey: "" } },
      { ...command, outputs: [] },
    ];
    for (const value of malformed) {
      await expect(fresh.startBuild(value as never)).resolves.toEqual({
        ok: false,
        code: "InvalidCommand",
      });
    }
    await expect(fresh.readBuild()).resolves.toBeNull();
    const nextCommand = {
      ...command,
      environment: [
        ...environment.filter(({ name }) => name !== "FRAMEWORK_ADAPTER"),
        { name: "FRAMEWORK_ADAPTER", value: "nextjs" },
        { name: "SSG_CACHE_MAX_BYTES", value: "67108864" },
        { name: "NEXT_REVALIDATE_PATH", value: "1" },
      ],
    };
    await expect(fresh.startBuild(nextCommand)).resolves.toMatchObject({ ok: true });

    // A terminal build answers an identical start without arming another poll.
    await sandbox.stopBuild();
    platform.scheduled.length = 0;
    await expect(sandbox.startBuild(command)).resolves.toMatchObject({ ok: true });
    expect(platform.scheduled).toEqual([]);
  });

  it("runs the EU object over the EU bucket only and refuses a command for the US bucket", async () => {
    const { bucket, command, platform } = setup();
    const usBucket = new MemoryR2Bucket();
    const sandbox = await sandboxOver(platform, bucket, "eu", usBucket);
    const euCommand = { ...command, source: { ...command.source, bucket: BUCKET_EU } };

    await expect(sandbox.startBuild(command)).resolves.toEqual({
      ok: false,
      code: "InvalidCommand",
    });
    await expect(sandbox.startBuild(euCommand)).resolves.toMatchObject({ ok: true });
    advance(1_000);
    await platform.fire(sandbox);
    const agent = platform.agent;
    if (agent === null) throw new Error("the sandbox was not started");
    expect(agent.source).toEqual(SOURCE);

    agent.succeed(BUNDLE, "build\n", "2026-09-17T12:01:30.000Z");
    advance(5_000);
    await platform.fire(sandbox);
    expect(bucket.objects.get(outputs.bundleKey)?.bytes).toEqual(BUNDLE);
    expect(bucket.text(outputs.logKey)).toBe("build\n");
    expect(usBucket.calls).toEqual([]);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("resumes after an eviction from what it stored", async () => {
    const { agent, bucket, platform } = await running();

    const resumed = await sandboxOver(platform, bucket);
    await platform.fire(resumed);
    await expect(resumed.readBuild()).resolves.toMatchObject({ status: "IN_PROGRESS" });
    expect(platform.startOptions).toHaveLength(1);

    agent.succeed(BUNDLE, null, "2026-09-17T12:00:45.000Z");
    const again = await sandboxOver(platform, bucket);
    await platform.fire(again);

    const last = await sandboxOver(platform, bucket);
    await expect(last.readBuild()).resolves.toMatchObject({
      status: "SUCCEEDED",
      startTime: START,
      usage: { completedAt: "2026-09-17T12:00:00.000Z" },
    });
    expect(bucket.objects.get(outputs.bundleKey)?.bytes).toEqual(BUNDLE);
    expect(platform.destroyed).toBe(1);
  });

  it("bills the Durable Object's clock, never the instants the sandbox reports", async () => {
    // The sandbox reports zero execution (startedAt equal to completedAt): the billed end is this object's clock.
    const first = await running();
    advance(60_000);
    first.agent.succeed(BUNDLE, null, "2026-09-17T12:00:30.000Z");
    first.agent.statusBody = JSON.stringify({
      state: "succeeded",
      startedAt: "2026-09-17T12:00:30.000Z",
      completedAt: "2026-09-17T12:00:30.000Z",
      failure: null,
    });
    await first.platform.fire(first.sandbox);
    await expect(first.sandbox.readBuild()).resolves.toMatchObject({
      status: "SUCCEEDED",
      usage: {
        startedAt: "2026-09-17T12:00:00.000Z",
        provisioningStartedAt: "2026-09-17T12:00:00.000Z",
        completedAt: "2026-09-17T12:01:00.000Z",
      },
    });

    // The sandbox reports a far-past instant: the launch at 12:01:00 and the observation at 12:02:00 are billed.
    const second = await running();
    advance(60_000);
    second.agent.succeed(BUNDLE, null, "2026-09-17T12:00:30.000Z");
    second.agent.statusBody = JSON.stringify({
      state: "succeeded",
      startedAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:00:00.000Z",
      failure: null,
    });
    await second.platform.fire(second.sandbox);
    await expect(second.sandbox.readBuild()).resolves.toMatchObject({
      status: "SUCCEEDED",
      usage: {
        startedAt: "2026-09-17T12:01:00.000Z",
        provisioningStartedAt: "2026-09-17T12:01:00.000Z",
        completedAt: "2026-09-17T12:02:00.000Z",
      },
    });
  });

  it("retries a failed destroy until the sandbox is gone", async () => {
    const { agent, platform, sandbox } = await running();
    agent.succeed(BUNDLE, null, "2026-09-17T12:00:30.000Z");
    platform.destroyFailures = 1;

    await platform.fire(sandbox);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(platform.running).toBe(true);
    expect(platform.scheduled).toEqual([{ seconds: 5, callback: "poll" }]);

    await platform.fire(sandbox);
    expect(platform.running).toBe(false);
    expect(platform.destroyed).toBe(1);
    expect(platform.scheduled).toEqual([]);

    const stopped = await running();
    stopped.platform.destroyFailures = 1;
    await expect(stopped.sandbox.stopBuild()).resolves.toMatchObject({ ok: true });
    expect(stopped.platform.scheduled).toEqual([{ seconds: 5, callback: "poll" }]);
    await stopped.platform.fire(stopped.sandbox);
    expect(stopped.platform.destroyed).toBe(1);
  });

  it("keeps the poll armed when a tick fails and stops it when nothing was ever started", async () => {
    const { agent, bucket, platform, sandbox } = await running();
    agent.succeed(BUNDLE, null, "2026-09-17T12:00:30.000Z");
    bucket.failNext("put", new Error("We encountered an internal error. (10001)"));

    await expect(platform.fire(sandbox)).rejects.toThrow("(10001)");
    expect(platform.scheduled).toEqual([{ seconds: 5, callback: "poll" }]);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "IN_PROGRESS" });

    await platform.fire(sandbox);
    await expect(sandbox.readBuild()).resolves.toMatchObject({ status: "SUCCEEDED" });

    const empty = new SandboxPlatformDouble();
    const idle = await sandboxOver(empty, bucket);
    await idle.poll();
    expect(empty.scheduled).toEqual([]);
  });

  it("destroys a sandbox whose activity expired and declares the sandbox defaults", async () => {
    const { platform, sandbox } = await running();

    await sandbox.onActivityExpired();

    expect(platform.destroyed).toBe(1);
    expect(sandbox).toMatchObject({
      defaultPort: 8080,
      requiredPorts: [8080],
      enableInternet: true,
      sleepAfter: "15m",
    });
  });
});
