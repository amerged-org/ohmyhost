/* global process, setTimeout, AbortController */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { testPostgresEnvironment } from "../scripts/test-postgres-path.mjs";
import {
  executeShardCommand,
  monitorSysvSegments,
  parseSysvSegmentIds,
  parseTestShardsArgs,
  runTestShards,
  selectTimingsPath,
} from "../scripts/test-shards.mjs";

test("local shard arguments enforce the measured two-process limit and private paths", () => {
  assert.deepEqual(parseTestShardsArgs([]), { shards: 2, output: undefined, timings: undefined });
  assert.deepEqual(parseTestShardsArgs(["--shards", "1", "--output", "/tmp/proof"]), {
    shards: 1,
    output: "/tmp/proof",
    timings: undefined,
  });
  for (const argv of [
    ["--shards", "3"],
    ["--shards", "0"],
    ["--output", "relative"],
    ["--timings", "relative"],
    ["--unknown", "value"],
  ])
    assert.throws(() => parseTestShardsArgs(argv));
});

test("local shards use the committed measured map when present and honor an explicit override", () => {
  const root = "/repo";
  const measured = "/repo/scripts/ci-test-durations.json";
  assert.equal(selectTimingsPath({ root, exists: () => false }), undefined);
  assert.equal(selectTimingsPath({ root, exists: (path) => path === measured }), measured);
  assert.equal(
    selectTimingsPath({ root, timings: "/private/override.json", exists: () => true }),
    "/private/override.json",
  );
});

test("shared-memory inventory parses only segment IDs on macOS and Linux", () => {
  const sample = [
    "T ID KEY MODE OWNER GROUP",
    "Shared Memory:",
    "m 316080128 0x0ac4f782 --rw------- owner staff",
    "0x00000000 271515649 postgres 600 56 1",
    "Semaphore Arrays:",
    "s 123 0x00000000 --ra------- owner staff",
  ].join("\n");
  assert.deepEqual(parseSysvSegmentIds(sample), new Set(["316080128", "271515649"]));
});

test("shared-memory monitor records transient new segments and verifies cleanup", async () => {
  const samples = [new Set(["1", "2"]), new Set(["1", "2", "3", "4"]), new Set(["1", "2"])];
  const monitor = await monitorSysvSegments({
    sample: () => samples.shift() ?? new Set(["1", "2"]),
    limit: 32,
    pause: async () => undefined,
  });
  assert.deepEqual(await monitor.stop(), {
    available: true,
    limit: 32,
    samplingIntervalMs: 500,
    before: 2,
    highWater: 4,
    peakNewSegments: 2,
    headroomAtPeak: 28,
    after: 2,
    newSegmentIds: [],
  });
});

test("PostgreSQL test path uses only an explicit or known version-validated directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-postgres-path-test-"));
  try {
    const selected = testPostgresEnvironment({
      environment: { PATH: "/usr/bin" },
      candidates: [directory],
      verify: () => true,
    });
    const physical = await realpath(directory);
    assert.equal(selected.OHMYHOST_TEST_POSTGRES_BIN, physical);
    assert.equal(selected.PATH, `${physical}:/usr/bin`);
    assert.throws(() =>
      testPostgresEnvironment({
        environment: { OHMYHOST_TEST_POSTGRES_BIN: "relative" },
        candidates: [directory],
        verify: () => true,
      }),
    );
    assert.throws(() =>
      testPostgresEnvironment({
        environment: { PATH: "/usr/bin" },
        candidates: [directory],
        verify: () => false,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two shards run concurrently and merge only after all complete without new segments", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-shards-test-"));
  const output = join(parent, "proof");
  const calls = [];
  let active = 0;
  let peak = 0;
  try {
    const receipt = await runTestShards({
      output,
      root: parent,
      resolveEnvironment: () => ({ PATH: "/validated/postgres/bin" }),
      monitor: async () => ({
        stop: async () => ({
          available: true,
          limit: 32,
          before: 5,
          highWater: 7,
          headroomAtPeak: 25,
          after: 5,
          newSegmentIds: [],
        }),
      }),
      execute: async (_command, args, options) => {
        calls.push({ args, options });
        assert.equal(options.environment.PATH, "/validated/postgres/bin");
        await writeFile(options.logPath, "");
        if (args[1] === "run") {
          await mkdir(args[args.indexOf("--output") + 1]);
          active++;
          peak = Math.max(peak, active);
          await new Promise((done) => setTimeout(done, 10));
          active--;
        }
        if (args[1] === "merge") {
          assert.deepEqual(
            (await readdir(output)).filter((name) => name.startsWith("shard-")).sort(),
            ["shard-1", "shard-2"],
          );
          const target = join(output, "merged");
          await mkdir(target);
          await writeFile(
            join(target, "summary.json"),
            '{"status":"passed","shards":2,"files":475,"tests":4419,"functions":{"covered":7981,"total":7981,"skipped":0,"pct":100}}\n',
          );
        }
      },
    });
    assert.equal(peak, 2);
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.summary.tests, 4419);
    assert.deepEqual(
      calls.map(({ args }) => (args[0] === "build" ? "build" : args[1])),
      ["build", "inventory", "run", "run", "merge"],
    );
    assert.equal(
      (await readFile(join(output, "orchestration.json"), "utf8")).includes('"highWater": 7'),
      true,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a red shard aborts its sibling and never merges or approves the run", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-shards-failure-test-"));
  const output = join(parent, "proof");
  const commands = [];
  try {
    await assert.rejects(
      runTestShards({
        output,
        resolveEnvironment: () => ({ PATH: "/validated/postgres/bin" }),
        monitor: async () => ({
          stop: async () => ({
            available: true,
            limit: 32,
            before: 5,
            highWater: 6,
            after: 5,
            newSegmentIds: [],
          }),
        }),
        execute: async (_command, args, { signal }) => {
          commands.push(args[1]);
          if (args[1] !== "run") return;
          if (args[args.indexOf("--shard") + 1] === "1") throw new Error("red shard");
          await new Promise((done) => {
            if (signal.aborted) done();
            else signal.addEventListener("abort", done, { once: true });
          });
          throw new Error("sibling stopped");
        },
      }),
      /red shard/u,
    );
    assert.equal(commands.includes("merge"), false);
    const receipt = JSON.parse(await readFile(join(output, "orchestration.json"), "utf8"));
    assert.equal(receipt.status, "failed");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("persistent new shared-memory segments block merge and leave a failure receipt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-shards-orphan-test-"));
  const output = join(parent, "proof");
  const commands = [];
  try {
    await assert.rejects(
      runTestShards({
        output,
        resolveEnvironment: () => ({ PATH: "/validated/postgres/bin" }),
        monitor: async () => ({
          stop: async () => ({
            available: true,
            limit: 32,
            before: 5,
            highWater: 7,
            headroomAtPeak: 25,
            after: 6,
            newSegmentIds: ["999"],
          }),
        }),
        execute: async (_command, args) => commands.push(args[1]),
      }),
      /shared-memory segments/u,
    );
    assert.equal(commands.includes("merge"), false);
    const receipt = JSON.parse(await readFile(join(output, "orchestration.json"), "utf8"));
    assert.equal(receipt.status, "failed");
    assert.deepEqual(receipt.sharedMemory.newSegmentIds, ["999"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a shared test database and pre-aborted process fail before any shard command starts", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ohmyhost-shards-shared-db-test-"));
  const output = join(parent, "proof");
  let called = false;
  try {
    await assert.rejects(
      runTestShards({
        output,
        resolveEnvironment: () => ({
          PATH: "/validated/postgres/bin",
          TEST_DATABASE_URL: "postgresql://test@localhost/shared_test",
        }),
        execute: async () => {
          called = true;
        },
      }),
      /independent PostgreSQL clusters/u,
    );
    assert.equal(called, false);
    const abort = new AbortController();
    abort.abort();
    const logPath = join(parent, "pre-aborted.log");
    await assert.rejects(
      executeShardCommand("never-execute", [], {
        cwd: parent,
        logPath,
        signal: abort.signal,
      }),
      /interrupted before it started/u,
    );
    await assert.rejects(readFile(logPath), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a completed command cannot leave an unrefed background process behind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-shards-background-test-"));
  try {
    await assert.rejects(
      executeShardCommand(
        process.execPath,
        [
          "-e",
          'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"}).unref()',
        ],
        { cwd: directory, logPath: join(directory, "command.log") },
      ),
      /left a background process/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
