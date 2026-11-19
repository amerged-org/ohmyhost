import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const vitestVersion = "4.1.12";
const require = createRequire(import.meta.url);
// Decode the pinned reporter's cyclic format using its own installed dependency.
const { parse: parseBlob } = createRequire(require.resolve("vitest/package.json"))("flatted");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const cancellationHandlers = new WeakMap();

function relativeFile(root, filename) {
  const relative = path.relative(root, filename).split(path.sep).join("/");
  assert(
    relative && !relative.startsWith("../") && !path.isAbsolute(relative),
    "Path outside checkout",
  );
  return relative;
}

export function describeFiles(files, root, completed = false) {
  const result = files
    .map((file) => {
      const tests = [];
      const ids = new Set();
      function visit(task, ancestors = []) {
        assert(
          ["run", "skip", "todo"].includes(task.mode),
          "Unexpected test mode (including only)",
        );
        if (completed) {
          const expected = task.mode === "run" ? "pass" : task.mode;
          assert(
            (task.mode !== "run" && task.result === undefined) ||
              task.result?.state === expected ||
              (expected === "todo" && task.result?.state === "skip"),
            "Non-passing or incomplete test result",
          );
        } else assert(task.result?.state !== "fail", "Test collection failed");
        if (task.type === "test") {
          assert(typeof task.id === "string" && !ids.has(task.id), "Duplicate or missing test ID");
          ids.add(task.id);
          tests.push({ id: task.id, name: [...ancestors, task.name].join(" > "), mode: task.mode });
        } else {
          assert(task.type === "suite" && Array.isArray(task.tasks), "Invalid test tree");
          for (const child of task.tasks)
            visit(child, task === file ? [] : [...ancestors, task.name]);
        }
      }
      visit(file);
      assert(tests.length > 0, "Empty test file");
      return {
        path: relativeFile(root, file.filepath),
        project: file.projectName || "",
        pool: file.pool,
        tests,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  assert(new Set(result.map((file) => file.path)).size === result.length, "Duplicate test file");
  return result;
}

export function partitionFiles(files, count, timings = {}) {
  assert(Number.isSafeInteger(count) && count > 0 && count <= files.length, "Invalid shard count");
  assert(new Set(files.map((file) => file.path)).size === files.length, "Duplicate test file");
  for (const duration of Object.values(timings))
    assert(Number.isFinite(duration) && duration >= 0, "Invalid timing");
  // A file missing from the timings (new, or not yet refreshed) weighs like the median
  // known file; weighing it 1 ms would pile every new file onto one shard.
  const known = files
    .map((file) => timings[file.path])
    .filter((duration) => duration > 0)
    .sort((a, b) => a - b);
  const fallback = known.length
    ? Math.round(
        (known[Math.floor((known.length - 1) / 2)] + known[Math.floor(known.length / 2)]) / 2,
      )
    : 1;
  const weight = (file) => Math.max(timings[file.path] ?? fallback, 1);
  const shards = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    files: [],
    estimatedDurationMs: 0,
  }));
  const ordered = [...files].sort(
    (a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path, "en"),
  );
  for (const file of ordered) {
    const shard = [...shards].sort(
      (a, b) =>
        a.estimatedDurationMs - b.estimatedDurationMs ||
        a.files.length - b.files.length ||
        a.index - b.index,
    )[0];
    shard.files.push(file.path);
    shard.estimatedDurationMs += weight(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

export function sourceIdentity(root) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const filename of new Set(files)) {
    const absolute = path.join(root, filename);
    let record;
    try {
      const stat = lstatSync(absolute);
      assert(stat.isFile() || stat.isSymbolicLink(), "Unsupported source input");
      record = stat.isSymbolicLink()
        ? { path: filename, type: "symlink", target: readlinkSync(absolute) }
        : {
            path: filename,
            type: "file",
            mode: stat.mode & 0o777,
            digest: digest(readFileSync(absolute)),
          };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      record = { path: filename, type: "deleted" };
    }
    hash.update(json(record));
  }
  return { commit, sourceDigest: hash.digest("hex") };
}

function assertInventory(inventory) {
  assert(
    inventory.schemaVersion === 1 && inventory.vitestVersion === vitestVersion,
    "Unsupported inventory",
  );
  assert(Array.isArray(inventory.files) && inventory.files.length > 0, "Missing test inventory");
  assert(
    Array.isArray(inventory.coverageFiles) && inventory.coverageFiles.length > 0,
    "Missing coverage source inventory",
  );
  equal(
    inventory.coverageFiles,
    [...new Set(inventory.coverageFiles)].sort(),
    "Invalid coverage source inventory",
  );
  const paths = inventory.files.map((file) => file.path).sort();
  assert(new Set(paths).size === paths.length, "Duplicate inventory file");
  equal(
    inventory.shards.map((shard) => shard.index),
    Array.from({ length: inventory.shards.length }, (_, index) => index + 1),
    "Invalid shard IDs",
  );
  assert(
    inventory.shards.length > 0 && inventory.shards.every((shard) => shard.files.length > 0),
    "Empty shard",
  );
  equal(
    inventory.shards.flatMap((shard) => shard.files).sort(),
    paths,
    "Incomplete or duplicate partition",
  );
}

function assertCoverageMap(coverage, inventory) {
  assert(
    coverage && typeof coverage === "object" && Object.keys(coverage).length > 0,
    "Missing coverage map",
  );
  equal(
    Object.keys(coverage)
      .map((filename) => relativeFile(inventory.root, filename))
      .sort(),
    inventory.coverageFiles,
    "Incomplete coverage source inventory",
  );
  for (const [filename, value] of Object.entries(coverage)) {
    assert(value.path === filename, "Coverage path mismatch");
    for (const property of ["statementMap", "fnMap", "branchMap", "s", "f", "b"])
      assert(value[property] && typeof value[property] === "object", "Invalid coverage map");
    equal(
      Object.keys(value.fnMap).sort(),
      Object.keys(value.f).sort(),
      "Invalid function counters",
    );
    for (const hits of Object.values(value.f))
      assert(Number.isSafeInteger(hits) && hits >= 0, "Invalid function hit count");
  }
}

function validateShard(inventory, inventoryDigest, { evidence, blob }) {
  assert(
    evidence.schemaVersion === 1 && evidence.vitestVersion === vitestVersion,
    "Unsupported shard evidence",
  );
  assert(evidence.inventoryDigest === inventoryDigest, "Different inventory");
  equal(evidence.identity, inventory.identity, "Different source identity");
  assert(
    evidence.root === inventory.root,
    "Different checkout root; native blobs cannot be rebased",
  );
  assert(
    evidence.status === "passed" && evidence.exitCode === 0,
    "Failed or incomplete shard process",
  );
  const shard = inventory.shards.find((entry) => entry.index === evidence.shard);
  assert(shard, "Unknown shard");
  assert(
    Array.isArray(blob) && blob.length === 6 && blob[0] === vitestVersion,
    "Invalid blob version or shape",
  );
  assert(Array.isArray(blob[2]) && blob[2].length === 0, "Unhandled shard errors");
  const files = describeFiles(blob[1], inventory.root, true);
  equal(
    files,
    inventory.files.filter((file) => shard.files.includes(file.path)),
    "Shard test inventory mismatch",
  );
  assertCoverageMap(blob[3], inventory);
  return files;
}

export function validateReports({ inventory, inventoryDigest, reports }) {
  assertInventory(inventory);
  assert(reports.length === inventory.shards.length, "Missing or extra shard report");
  equal(
    reports.map((report) => report.evidence.shard).sort((a, b) => a - b),
    inventory.shards.map((shard) => shard.index),
    "Duplicate or missing shard report",
  );
  const files = reports.flatMap((report) => validateShard(inventory, inventoryDigest, report));
  equal(
    files.map((file) => file.path).sort(),
    inventory.files.map((file) => file.path).sort(),
    "Incomplete test union",
  );
  return {
    files: files.length,
    tests: files.reduce((total, file) => total + file.tests.length, 0),
  };
}

export function assertGlobalCoverage(summary) {
  const functions = summary?.total?.functions;
  assert(
    functions &&
      Number.isSafeInteger(functions.total) &&
      functions.total > 0 &&
      functions.covered === functions.total &&
      functions.skipped === 0 &&
      functions.pct === 100,
    "Global function coverage must be exactly 100%",
  );
  return functions;
}

// Only the inventory stage collects without executing, so only it may import test
// modules in parallel; run and merge keep one worker for the measured serial gates.
export function workerLimit(stage, available = availableParallelism()) {
  return stage === "inventory" ? Math.max(1, Math.min(4, available)) : 1;
}

async function createContext(root, output, stage, config = path.join(root, "vitest.config.mts")) {
  const { createVitest, version } = await import("vitest/node");
  assert(version === vitestVersion, "Unexpected Vitest version");
  const signals = ["SIGINT", "SIGTERM"];
  const previousListeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
  const workers = workerLimit(stage);
  const ctx = await createVitest(
    "test",
    {
      root,
      config,
      watch: false,
      cache: false,
      allowOnly: false,
      passWithNoTests: false,
      maxWorkers: workers,
      fileParallelism: workers > 1,
      reporters:
        stage === "run"
          ? ["default", ["blob", { outputFile: path.join(output, "blob.json") }]]
          : [],
      coverage: {
        enabled: true,
        reportsDirectory: path.join(output, "coverage"),
        reporter: stage === "merge" ? ["text-summary", "json-summary"] : [],
      },
    },
    { cacheDir: path.join(output, "vite-cache") },
  );
  // The pinned logger installs immediate process.exit() handlers. This process
  // owns cancellation, so replace only handlers added by createVitest, preserving
  // any caller handlers and Vitest's ordinary onClose terminal cleanup.
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!previousListeners.get(signal).includes(listener)) process.off(signal, listener);
    }
  }
  let interrupted = false;
  const interrupt = () => {
    process.exitCode = 1;
    if (interrupted) return;
    interrupted = true;
    // Cancel scheduling, then let the current test and its afterAll hooks close
    // their resources. The caller retains a bounded process-group kill fallback.
    void ctx.cancelCurrentRun("keyboard-input").catch((error) => ctx.logger.error(error));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  cancellationHandlers.set(ctx, interrupt);
  try {
    assert(
      ctx.config.coverage.provider === "v8" && ctx.config.coverage.thresholds.functions === 100,
      "Original global100% V8 coverage gate is required",
    );
    if (stage !== "merge") {
      // This partial-run stage only transports coverage. The original threshold is
      // enforced by the separate mandatory merge, never treated as shard success.
      ctx.config.coverage.thresholds = undefined;
    }
    await ctx.standalone();
    assert(ctx.coverageProvider.version === vitestVersion, "Unexpected coverage provider version");
    return ctx;
  } catch (error) {
    await closeContext(ctx);
    throw error;
  }
}

async function closeContext(ctx) {
  // Vitest 4.1.12 logs rejected global teardown/pool close promises without
  // throwing or setting an exit code. A release shard must reject those too.
  const original = ctx.logger.error;
  let failed = false;
  ctx.logger.error = function (...args) {
    failed = true;
    return original.apply(this, args);
  };
  try {
    await ctx.close();
  } finally {
    ctx.logger.error = original;
    const interrupt = cancellationHandlers.get(ctx);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    cancellationHandlers.delete(ctx);
  }
  assert(!failed, "Vitest cleanup failed");
}

async function coverageFiles(ctx, root) {
  // Public BaseCoverageProvider API: includes uncovered source files too.
  return (await ctx.coverageProvider.getUntestedFiles([]))
    .map((filename) => relativeFile(root, filename))
    .sort();
}

function collectionDiagnostics(root, specifications, collected) {
  const knownPaths = new Set(specifications.map((spec) => relativeFile(root, spec.moduleId)));
  const knownNames = new Set([
    "Error",
    "TypeError",
    "SyntaxError",
    "ReferenceError",
    "RangeError",
    "AggregateError",
  ]);
  const knownCodes = new Set([
    "MODULE_NOT_FOUND",
    "ENOENT",
    "ERR_MODULE_NOT_FOUND",
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "ERR_UNKNOWN_BUILTIN_MODULE",
    "ERR_WORKER_OUT_OF_MEMORY",
    "ERR_WORKER_NOT_RUNNING",
    "ERR_IPC_CHANNEL_CLOSED",
  ]);
  const names = (errors) => [
    ...new Set(errors.map((error) => (knownNames.has(error?.name) ? error.name : "OtherError"))),
  ];
  const codes = (errors) => [
    ...new Set(errors.flatMap((error) => (knownCodes.has(error?.code) ? [error.code] : []))),
  ];
  const failed = [];
  for (const module of collected.testModules) {
    const errors = [...module.errors()];
    const visit = (task) => {
      errors.push(...(task.result?.errors ?? []));
      for (const child of task.tasks ?? []) visit(child);
    };
    visit(module.task);
    if (module.state() !== "failed" && module.task.result?.state !== "fail" && errors.length === 0)
      continue;
    const candidate = relativeFile(root, module.moduleId);
    failed.push({
      path: knownPaths.has(candidate) ? candidate : "[unrecognized module]",
      errorNames: names(errors),
      errorCodes: codes(errors),
    });
  }
  return {
    phase: "inventory",
    specifications: specifications.length,
    modules: collected.testModules.length,
    processExitCode: process.exitCode ?? 0,
    unhandledErrorCount: collected.unhandledErrors.length,
    unhandledErrorNames: names(collected.unhandledErrors),
    unhandledErrorCodes: codes(collected.unhandledErrors),
    failedModuleCount: failed.length,
    failedModules: failed.slice(0, 20),
    omittedFailedModules: Math.max(0, failed.length - 20),
  };
}

export async function createInventory({
  root = repositoryRoot,
  output,
  shards,
  timings = {},
  config,
}) {
  const identity = sourceIdentity(root);
  await mkdir(path.dirname(output), { recursive: true });
  const ctx = await createContext(root, `${output}.work`, "inventory", config);
  let inventory;
  try {
    const specifications = await ctx.globTestSpecifications();
    assert(!process.exitCode, "Test inventory interrupted");
    const collected = await ctx.collectTests(specifications);
    const diagnostics = collectionDiagnostics(root, specifications, collected);
    if (collected.unhandledErrors.length || process.exitCode || diagnostics.failedModuleCount)
      process.stderr.write(`Inventory collection diagnostics: ${JSON.stringify(diagnostics)}\n`);
    assert(collected.unhandledErrors.length === 0 && !process.exitCode, "Test collection failed");
    const files = describeFiles(
      collected.testModules.map((module) => module.task),
      root,
    );
    equal(
      files.map((file) => file.path).sort(),
      specifications.map((spec) => relativeFile(root, spec.moduleId)).sort(),
      "Incomplete test collection",
    );
    inventory = {
      schemaVersion: 1,
      vitestVersion,
      root,
      identity,
      files,
      coverageFiles: await coverageFiles(ctx, root),
      shards: partitionFiles(files, shards, timings),
    };
    assertInventory(inventory);
  } finally {
    await closeContext(ctx);
  }
  equal(sourceIdentity(root), identity, "Source changed during inventory");
  await writeFile(output, json(inventory), { flag: "wx" });
  return inventory;
}

async function readInventory(filename, root) {
  const bytes = await readFile(filename);
  const inventory = JSON.parse(bytes);
  assertInventory(inventory);
  assert(inventory.root === root, "Different checkout root");
  equal(sourceIdentity(root), inventory.identity, "Source changed since inventory");
  return { inventory, inventoryDigest: digest(bytes) };
}

export async function executeShard({ inventory, shard, output, root = repositoryRoot, config }) {
  const ctx = await createContext(root, output, "run", config);
  try {
    equal(
      await coverageFiles(ctx, root),
      inventory.coverageFiles,
      "Coverage source inventory changed",
    );
    const specifications = await ctx.globTestSpecifications();
    equal(
      specifications.map((spec) => relativeFile(root, spec.moduleId)).sort(),
      inventory.files.map((file) => file.path).sort(),
      "Test file inventory changed",
    );
    const selected = inventory.shards.find((entry) => entry.index === shard);
    assert(selected, "Invalid shard");
    assert(!process.exitCode, "Shard interrupted");
    const result = await ctx.runTestSpecifications(
      specifications.filter((spec) => selected.files.includes(relativeFile(root, spec.moduleId))),
      true,
    );
    assert(result.unhandledErrors.length === 0, "Unhandled shard errors");
    describeFiles(
      result.testModules.map((module) => module.task),
      root,
      true,
    );
  } finally {
    await closeContext(ctx);
  }
}

async function superviseShard({ inventoryFile, shard, output, root = repositoryRoot }) {
  const { inventory, inventoryDigest } = await readInventory(inventoryFile, root);
  assert(
    inventory.shards.some((entry) => entry.index === shard),
    "Invalid shard",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const started = Date.now();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        "execute",
        "--inventory",
        inventoryFile,
        "--shard",
        String(shard),
        "--output",
        output,
      ],
      { cwd: root, stdio: "inherit" },
    );
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code) => {
      cleanup();
      resolve(interrupted ? 1 : (code ?? 1));
    });
  });
  const evidence = {
    schemaVersion: 1,
    vitestVersion,
    root,
    identity: inventory.identity,
    inventoryDigest,
    shard,
    exitCode,
    status: "failed",
    durationMs: Date.now() - started,
  };
  try {
    assert(exitCode === 0, "Shard process failed");
    equal(sourceIdentity(root), inventory.identity, "Source changed during shard");
    const bytes = await readFile(path.join(output, "blob.json"));
    const blob = parseBlob(bytes.toString());
    const files = validateShard(inventory, inventoryDigest, {
      evidence: { ...evidence, status: "passed" },
      blob,
    });
    Object.assign(evidence, {
      status: "passed",
      blobDigest: digest(bytes),
      files: files.length,
      tests: files.reduce((total, file) => total + file.tests.length, 0),
      perFile: blob[1].map((file) => ({
        path: relativeFile(root, file.filepath),
        durationMs: file.result.duration,
        tests: files.find((entry) => entry.path === relativeFile(root, file.filepath)).tests.length,
      })),
    });
  } finally {
    await writeFile(path.join(output, "evidence.json"), json(evidence), { flag: "wx" });
  }
  return evidence;
}

export async function mergeShards({ inventoryFile, input, output, root = repositoryRoot, config }) {
  const { inventory, inventoryDigest } = await readInventory(inventoryFile, root);
  const names = (await readdir(input)).filter((name) => name.startsWith("shard-"));
  equal(
    names.sort(),
    inventory.shards.map((shard) => `shard-${shard.index}`).sort(),
    "Missing or extra shard directory",
  );
  const reports = [];
  for (const shard of inventory.shards) {
    const directory = path.join(input, `shard-${shard.index}`);
    const evidence = JSON.parse(await readFile(path.join(directory, "evidence.json"), "utf8"));
    const bytes = await readFile(path.join(directory, "blob.json"));
    assert(digest(bytes) === evidence.blobDigest, "Blob digest mismatch");
    reports.push({ evidence, blob: parseBlob(bytes.toString()), bytes });
  }
  const totals = validateReports({ inventory, inventoryDigest, reports });
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const blobs = path.join(output, "blobs");
  await mkdir(blobs);
  for (const report of reports) {
    await writeFile(path.join(blobs, `shard-${report.evidence.shard}.json`), report.bytes, {
      flag: "wx",
    });
    delete report.bytes;
  }
  const ctx = await createContext(root, output, "merge", config);
  try {
    equal(
      await coverageFiles(ctx, root),
      inventory.coverageFiles,
      "Coverage source inventory changed",
    );
    assert(!process.exitCode, "Merge interrupted");
    await ctx.mergeReports(blobs);
    assert(!process.exitCode, "Native Vitest merge failed");
  } finally {
    await closeContext(ctx);
  }
  const functions = assertGlobalCoverage(
    JSON.parse(await readFile(path.join(output, "coverage", "coverage-summary.json"), "utf8")),
  );
  equal(sourceIdentity(root), inventory.identity, "Source changed during merge");
  const summary = {
    schemaVersion: 1,
    status: "passed",
    identity: inventory.identity,
    inventoryDigest,
    ...totals,
    functions,
    shards: inventory.shards.length,
  };
  await writeFile(path.join(output, "summary.json"), json(summary), { flag: "wx" });
  return summary;
}

async function main(args) {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      output: { type: "string" },
      inventory: { type: "string" },
      input: { type: "string" },
      shards: { type: "string" },
      shard: { type: "string" },
      timings: { type: "string" },
    },
    strict: true,
  });
  const output = path.resolve(values.output || ".ohmyhost/test-shards");
  const inventoryFile = values.inventory && path.resolve(values.inventory);
  if (command === "inventory")
    return createInventory({
      output,
      shards: Number(values.shards),
      timings: values.timings ? JSON.parse(await readFile(values.timings, "utf8")) : {},
    });
  assert(inventoryFile, "--inventory is required");
  if (command === "run")
    return superviseShard({ inventoryFile, shard: Number(values.shard), output });
  if (command === "merge") {
    assert(values.input, "--input is required");
    return mergeShards({ inventoryFile, input: path.resolve(values.input), output });
  }
  if (command === "execute") {
    const { inventory } = await readInventory(inventoryFile, repositoryRoot);
    return executeShard({ inventory, shard: Number(values.shard), output });
  }
  throw new Error("Expected inventory, run or merge");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2))
    .then((result) => {
      assert(!process.exitCode, "Vitest process did not finish successfully");
      if (!result) return;
      process.stdout.write(
        json({
          status: "passed",
          files: Array.isArray(result.files) ? result.files.length : result.files,
          tests: Array.isArray(result.files)
            ? result.files.reduce((count, file) => count + file.tests.length, 0)
            : result.tests,
          shards: Array.isArray(result.shards) ? result.shards.length : result.shards,
        }),
      );
    })
    .catch((error) => {
      process.stderr.write(`Vitest shard gate failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
