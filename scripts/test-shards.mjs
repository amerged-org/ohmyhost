#!/usr/bin/env node
/* global process, setInterval, clearInterval, setTimeout, clearTimeout, AbortController */
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { testPostgresEnvironment } from "./test-postgres-path.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(repositoryRoot, "scripts/vitest-shards.mjs");
const SYSV_POLL_MS = 500;
const MINIMUM_FREE_SYSV_SEGMENTS = 4;

export function parseTestShardsArgs(argv) {
  let shards = 2;
  let output;
  let timings;
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    if (name === "--shards") {
      shards = Number(value);
      if (shards !== 1 && shards !== 2)
        throw new Error("Local shard pilot permits only one or two serial-per-shard processes");
    } else if (name === "--output") {
      if (!isAbsolute(value)) throw new Error("Shard output must be an absolute path");
      output = resolve(value);
    } else if (name === "--timings") {
      if (!isAbsolute(value)) throw new Error("Shard timings must be an absolute path");
      timings = resolve(value);
    } else {
      throw new Error(`Unknown test:shards option ${name}`);
    }
  }
  return { shards, output, timings };
}

export function selectTimingsPath({ root = repositoryRoot, timings, exists = existsSync } = {}) {
  if (timings !== undefined) return timings;
  const measured = join(root, "scripts/ci-test-durations.json");
  return exists(measured) ? measured : undefined;
}

export function parseSysvSegmentIds(text) {
  const ids = new Set();
  for (const line of text.split(/\r?\n/u)) {
    const mac = /^m\s+(\d+)\s+0x[0-9a-f]+\s/u.exec(line);
    const linux = /^0x[0-9a-f]+\s+(\d+)\s+\S+\s+\d+\s+\d+/u.exec(line);
    const id = mac?.[1] ?? linux?.[1];
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

function sysvSegments() {
  try {
    return parseSysvSegmentIds(execFileSync("ipcs", ["-m"], { encoding: "utf8" }));
  } catch {
    return null;
  }
}

function sysvLimit() {
  try {
    const value =
      process.platform === "darwin"
        ? execFileSync("sysctl", ["-n", "kern.sysv.shmmni"], { encoding: "utf8" })
        : existsSync("/proc/sys/kernel/shmmni")
          ? readFileSync("/proc/sys/kernel/shmmni", "utf8")
          : "";
    const limit = Number(value.trim());
    return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
  } catch {
    return null;
  }
}

async function wait(milliseconds) {
  await new Promise((done) => setTimeout(done, milliseconds));
}

export async function monitorSysvSegments({
  sample = sysvSegments,
  limit = sysvLimit(),
  pause = wait,
} = {}) {
  const before = sample();
  if (before === null || limit === null) return { stop: async () => ({ available: false, limit }) };
  let highWater = before.size;
  let peakNewSegments = 0;
  let missedSample = false;
  let sampling = false;
  const poll = () => {
    if (sampling) return;
    sampling = true;
    try {
      const current = sample();
      if (current === null) missedSample = true;
      else {
        highWater = Math.max(highWater, current.size);
        peakNewSegments = Math.max(
          peakNewSegments,
          [...current].filter((id) => !before.has(id)).length,
        );
      }
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(poll, SYSV_POLL_MS);
  return {
    async stop() {
      clearInterval(timer);
      let after = sample();
      if (after !== null) {
        highWater = Math.max(highWater, after.size);
        peakNewSegments = Math.max(
          peakNewSegments,
          [...after].filter((id) => !before.has(id)).length,
        );
      }
      for (let attempt = 0; attempt < 20 && after !== null; attempt++) {
        if ([...after].every((id) => before.has(id))) break;
        await pause(SYSV_POLL_MS);
        after = sample();
      }
      if (after === null || missedSample)
        return { available: false, limit, before: before.size, highWater, peakNewSegments };
      const newIds = [...after].filter((id) => !before.has(id));
      return {
        available: true,
        limit,
        samplingIntervalMs: SYSV_POLL_MS,
        before: before.size,
        highWater,
        peakNewSegments,
        headroomAtPeak: limit - highWater,
        after: after.size,
        newSegmentIds: newIds,
      };
    },
  };
}

function killGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child has already exited.
    }
  }
}

function groupAlive(child) {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export async function executeShardCommand(command, args, { cwd, logPath, signal, environment }) {
  if (signal?.aborted) throw new Error(`${command} was interrupted before it started`);
  const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
  await new Promise((done, reject) => {
    log.once("open", done);
    log.once("error", reject);
  });
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: environment ?? process.env,
    stdio: ["ignore", log, log],
  });
  let killTimer;
  const abort = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 30_000);
    killTimer.unref();
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let exitCode;
  let lingering = false;
  try {
    exitCode = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code) => done(code));
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    // A completed supervisor has no legitimate background descendants.
    // Its direct exit alone does not prove the detached process group is gone.
    lingering = groupAlive(child);
    if (lingering) killGroup(child, "SIGKILL");
    clearTimeout(killTimer);
    await new Promise((done) => log.end(done));
  }
  if (lingering) throw new Error(`${command} left a background process; inspect ${logPath}`);
  if (signal?.aborted) throw new Error(`${command} was interrupted; inspect ${logPath}`);
  if (exitCode !== 0) throw new Error(`${command} exited ${String(exitCode)}; inspect ${logPath}`);
}

export async function runTestShards({
  shards = 2,
  output,
  timings,
  root = repositoryRoot,
  execute = executeShardCommand,
  monitor = monitorSysvSegments,
  resolveEnvironment = testPostgresEnvironment,
  signal,
  now = () => new Date(),
} = {}) {
  if (shards !== 1 && shards !== 2) throw new Error("Local shard pilot permits one or two shards");
  const destination = output ?? (await mkdtemp(join(tmpdir(), "ohmyhost-test-shards-")));
  if (output !== undefined) await mkdir(destination, { mode: 0o700 });
  const startedAt = now().toISOString();
  const receipt = { schemaVersion: 1, status: "failed", startedAt, shards, destination };
  const inventory = join(destination, "inventory.json");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let environment;
  let measurement;
  let monitorHandle;
  try {
    environment = resolveEnvironment();
    const selectedTimings = selectTimingsPath({ root, timings });
    receipt.timingsPath = selectedTimings ?? null;
    if (shards > 1 && environment.TEST_DATABASE_URL?.trim())
      throw new Error("Two-shard local runs require independent PostgreSQL clusters");
    await execute("pnpm", ["build"], {
      cwd: root,
      logPath: join(destination, "build.log"),
      signal: controller.signal,
      environment,
    });
    await execute(
      process.execPath,
      [
        core,
        "inventory",
        "--output",
        inventory,
        "--shards",
        String(shards),
        ...(selectedTimings ? ["--timings", selectedTimings] : []),
      ],
      {
        cwd: root,
        logPath: join(destination, "inventory.log"),
        signal: controller.signal,
        environment,
      },
    );
    monitorHandle = await monitor();
    const runs = Array.from({ length: shards }, (_, index) =>
      execute(
        process.execPath,
        [
          core,
          "run",
          "--inventory",
          inventory,
          "--shard",
          String(index + 1),
          "--output",
          join(destination, `shard-${index + 1}`),
        ],
        {
          cwd: root,
          logPath: join(destination, `run-${index + 1}.log`),
          signal: controller.signal,
          environment,
        },
      ).catch((error) => {
        controller.abort();
        throw error;
      }),
    );
    const settled = await Promise.allSettled(runs);
    measurement = await monitorHandle.stop();
    monitorHandle = undefined;
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    if (!measurement.available)
      throw new Error("Local SysV shared-memory observation is unavailable");
    if (
      !Number.isSafeInteger(measurement.headroomAtPeak) ||
      measurement.headroomAtPeak < MINIMUM_FREE_SYSV_SEGMENTS
    )
      throw new Error("Local shard run exhausted its shared-memory safety margin");
    if (measurement.available && measurement.newSegmentIds.length > 0)
      throw new Error("Local shard run left new SysV shared-memory segments after cleanup");
    await execute(
      process.execPath,
      [
        core,
        "merge",
        "--inventory",
        inventory,
        "--input",
        destination,
        "--output",
        join(destination, "merged"),
      ],
      {
        cwd: root,
        logPath: join(destination, "merge.log"),
        signal: controller.signal,
        environment,
      },
    );
    const summary = JSON.parse(await readFile(join(destination, "merged", "summary.json"), "utf8"));
    if (
      summary.status !== "passed" ||
      summary.shards !== shards ||
      !Number.isSafeInteger(summary.files) ||
      summary.files < 1 ||
      !Number.isSafeInteger(summary.tests) ||
      summary.tests < 1 ||
      !Number.isSafeInteger(summary.functions?.total) ||
      summary.functions.total < 1 ||
      summary.functions?.covered !== summary.functions?.total ||
      summary.functions?.skipped !== 0 ||
      summary.functions?.pct !== 100
    )
      throw new Error("Merged Vitest summary is incomplete or failed");
    receipt.summary = summary;
    receipt.status = "passed";
    return receipt;
  } catch (error) {
    controller.abort();
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (monitorHandle !== undefined) measurement = await monitorHandle.stop();
    receipt.finishedAt = now().toISOString();
    if (measurement !== undefined) receipt.sharedMemory = measurement;
    await writeFile(
      join(destination, "orchestration.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await runTestShards({
      ...parseTestShardsArgs(process.argv.slice(2)),
      signal: stop.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
