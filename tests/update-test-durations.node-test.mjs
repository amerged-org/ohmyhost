import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import { buildTimings, compareTimings } from "../scripts/update-test-durations.mjs";

const script = path.resolve(import.meta.dirname, "../scripts/update-test-durations.mjs");

const evidence = (shard, perFile, overrides = {}) => ({
  schemaVersion: 1,
  vitestVersion: "4.1.12",
  identity: { commit: "c".repeat(40), sourceDigest: "d".repeat(64) },
  inventoryDigest: "a".repeat(64),
  shard,
  status: "passed",
  perFile: perFile.map(([file, durationMs]) => ({ path: file, durationMs, tests: 1 })),
  ...overrides,
});
const sixShards = (overrides = {}) =>
  [1, 2, 3, 4, 5, 6]
    .map((shard) =>
      evidence(shard, [[`pkg/${7 - shard}.test.ts`, shard === 1 ? 0.2 : shard * 100.5]]),
    )
    .map((report, index) => (index === 2 ? { ...report, ...overrides } : report));

test("timings are sorted whole milliseconds, at least 1, for exactly the evidenced files", () => {
  const timings = buildTimings(sixShards());
  assert.deepEqual(Object.keys(timings), [
    "pkg/1.test.ts",
    "pkg/2.test.ts",
    "pkg/3.test.ts",
    "pkg/4.test.ts",
    "pkg/5.test.ts",
    "pkg/6.test.ts",
  ]);
  assert.deepEqual(Object.values(timings), [603, 503, 402, 302, 201, 1]);
  assert.deepEqual(
    compareTimings({ ...timings, "old.test.ts": 5 }, ["new.test.ts", "pkg/1.test.ts"]),
    {
      missing: ["new.test.ts"],
      stale: [
        "old.test.ts",
        "pkg/2.test.ts",
        "pkg/3.test.ts",
        "pkg/4.test.ts",
        "pkg/5.test.ts",
        "pkg/6.test.ts",
      ],
    },
  );
});

test("evidence from an incomplete, mixed, failed or malformed run is rejected", () => {
  const [first, ...rest] = sixShards();
  const reject = (reports, message) => assert.throws(() => buildTimings(reports), message);
  reject(rest, /Missing or extra shard evidence/);
  reject(sixShards({ inventoryDigest: "b".repeat(64) }), /different inventories or commits/);
  reject(sixShards({ identity: { commit: "e".repeat(40) } }), /different inventories or commits/);
  reject(sixShards({ status: "failed" }), /did not pass/);
  reject(
    [
      first,
      ...rest.slice(0, 4),
      evidence(6, [
        ["pkg/7.test.ts", 1],
        ["pkg/7.test.ts", 2],
      ]),
    ],
    /Duplicate test file/,
  );
  reject([first, ...rest.slice(0, 4), evidence(6, [["pkg/6.test.ts", 1]])], /Duplicate test file/);
  for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5"])
    reject(
      sixShards({ perFile: [{ path: "x.test.ts", durationMs, tests: 1 }] }),
      /Invalid duration/,
    );
});

test("the command writes the refreshed file and --check --strict fails on drift", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ci-durations-test-"));
  try {
    const input = path.join(directory, "evidence");
    for (const report of sixShards()) {
      await mkdir(path.join(input, `shard-${report.shard}`), { recursive: true });
      await writeFile(
        path.join(input, `shard-${report.shard}`, "evidence.json"),
        JSON.stringify(report),
      );
    }
    const output = path.join(directory, "durations.json");
    const run = (...args) => promisify(execFile)(process.execPath, [script, ...args]);
    await run("--input", input, "--output", output);
    const written = await readFile(output, "utf8");
    assert.equal(written, `${JSON.stringify(buildTimings(sixShards()), null, 2)}\n`);
    assert.match(
      (await run("--input", input, "--output", output, "--check", "--strict")).stdout,
      /0 test files lack a timing, 0 timings are stale/,
    );
    await writeFile(output, JSON.stringify({ "old.test.ts": 1 }));
    await assert.rejects(
      run("--input", input, "--output", output, "--check", "--strict"),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /6 test files lack a timing, 1 timings are stale/);
        return true;
      },
    );
    const lenient = await run("--input", input, "--output", output, "--check");
    assert.match(lenient.stdout, /6 test files lack a timing/);
    await assert.rejects(run("--input", input, "--run", "1"), /exactly one of --run or --input/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
