#!/usr/bin/env node
/* global process, AbortController */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { executeShardCommand, runTestShards } from "./test-shards.mjs";
import { testPostgresEnvironment } from "./test-postgres-path.mjs";
import { sourceIdentity } from "./vitest-shards.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST_TEST = /\.test\.(?:js|mjs|ts|mts|tsx)$/u;
const NODE_TEST =
  /(?:\.node-test\.mjs$|^apps\/build-runner\/sandbox\/tests\/.*\.test\.mjs$|^scripts\/preview-spike\/.*\.test\.mjs$)/u;
const CODE = /^(?:apps|packages)\/[^/]+\/(?:src|test)\/.*\.(?:js|mjs|ts|mts|tsx)$/u;
const DOC =
  /^(?:docs\/|skills\/|plan\/evidence\/|PLAN\.md$|ARCHITECTURE\.md$|PRICING\.md$|ohmyhost\.md$)/u;

/**
 * Release tooling is owned by the Node suite (tests/*.node-test.mjs): no source under apps/ or
 * packages/ imports these scripts, so a change limited to them and to Node tests selects the
 * targeted mode (pnpm test:node plus the Vitest files below) instead of the 17-minute full run.
 * Every other script under scripts/ is imported or read by Vitest suites and keeps the full run.
 * The Vitest files that read a release script as text are listed here, and
 * tests/verify-fast.node-test.mjs fails when a Vitest file names a release script it does not list.
 */
const RELEASE_TOOL =
  /^scripts\/(?:release-[^/]+|platform-release|platform-container-release|publish-[^/]+|prepare-[^/]*release[^/]*)\.mjs$/u;
export const RELEASE_TOOL_VITEST_READERS = {
  "scripts/prepare-npm-client-release.mjs": ["apps/product-cli/test/repository-init.test.ts"],
};

export function isReleaseTool(path) {
  return RELEASE_TOOL.test(path);
}

export function isNodeTest(path) {
  return NODE_TEST.test(path);
}

// The CI fixture install, run locally when its dependency tree is missing.
const FIXTURE_DIRECTORY = "fixtures/next-edge";
const FIXTURE_INSTALL = [
  "--dir",
  FIXTURE_DIRECTORY,
  "--ignore-workspace",
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
];
const PREVIEW_WORKER_DIRECTORY = "scripts/preview-spike/worker";
const PREVIEW_WORKER_INSTALL = [
  "exec",
  "npm",
  "--prefix",
  PREVIEW_WORKER_DIRECTORY,
  "ci",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
];

/** A present package or guard suite needs its locked Wrangler and Sandbox SDK. */
export function inspectPreviewWorkerState(directory) {
  const worker = join(directory, PREVIEW_WORKER_DIRECTORY);
  const manifest = join(worker, "package.json");
  const lock = join(worker, "package-lock.json");
  const guard = join(directory, "scripts/preview-spike/deployment/deployment.test.mjs");
  const hasManifest = existsSync(manifest);
  const hasLock = existsSync(lock);
  if (!hasManifest && !hasLock && !existsSync(guard)) return "absent";
  if (!hasManifest || !hasLock) return "incomplete";
  try {
    const manifestData = JSON.parse(readFileSync(manifest, "utf8"));
    const wanted = manifestData?.devDependencies?.wrangler;
    const sdkWanted = manifestData?.dependencies?.["@cloudflare/sandbox"];
    const lockData = JSON.parse(readFileSync(lock, "utf8"));
    const lockDeclared = lockData?.packages?.[""]?.devDependencies?.wrangler;
    const locked = lockData?.packages?.["node_modules/wrangler"]?.version;
    const sdkLockDeclared = lockData?.packages?.[""]?.dependencies?.["@cloudflare/sandbox"];
    const sdkLocked = lockData?.packages?.["node_modules/@cloudflare/sandbox"]?.version;
    const installed = JSON.parse(
      readFileSync(join(worker, "node_modules/wrangler/package.json"), "utf8"),
    )?.version;
    const sdkInstalled = JSON.parse(
      readFileSync(join(worker, "node_modules/@cloudflare/sandbox/package.json"), "utf8"),
    )?.version;
    if (
      typeof wanted === "string" &&
      /^\d+\.\d+\.\d+$/u.test(wanted) &&
      wanted === lockDeclared &&
      wanted === locked &&
      locked === installed &&
      existsSync(join(worker, "node_modules/.bin/wrangler")) &&
      sdkWanted === "1.0.1" &&
      sdkWanted === sdkLockDeclared &&
      sdkWanted === sdkLocked &&
      sdkWanted === sdkInstalled &&
      statSync(join(worker, "node_modules/@cloudflare/sandbox/dist/index.mjs")).isFile()
    )
      return "present";
  } catch {
    // npm ci will validate any malformed package or lock and fail rather than skip the suite.
  }
  return "missing";
}
// POSIX ERE without \b: git grep -E on macOS uses BSD regex, where \b is not a word boundary,
// so a \b pattern would silently never match on a developer's machine.
export const FOCUSED_TEST = String.raw`(^|[^[:alnum:]_])(describe|it|test|suite)\.only([^[:alnum:]_]|$)|(^|[^[:alnum:]_])(fit|fdescribe)\(`;
const NETWORK_FAILURE =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|FetchError|ERR_PNPM_FETCH|ERR_PNPM_AUDIT_BAD_RESPONSE/u;

export function parseVerifyFastArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index],
      value = argv[index + 1];
    if (
      flag === "--base" &&
      result.base === undefined &&
      typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/u.test(value)
    )
      result.base = value;
    else if (flag === "--shards" && result.shards === undefined && (value === "1" || value === "2"))
      result.shards = Number(value);
    else throw new Error("usage: verify-fast [--base COMMIT_OR_REF] [--shards 1|2]");
  }
  return result;
}

export function parseGitChanges(text) {
  const parts = text.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const paths = [];
  let broad = false;
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    if (!/^[ACDMRTUXB][0-9]*$/u.test(status)) throw new Error("Git change record is invalid");
    const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    if (count === 2 || status.startsWith("D")) broad = true;
    for (let item = 0; item < count; item++) {
      const path = parts[index++];
      if (path === undefined || !path || path.startsWith("/") || path.split("/").includes(".."))
        throw new Error("Git changed path is invalid");
      paths.push(path);
    }
  }
  return { paths, broad };
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trimEnd();
}

export function findFastChanges({ explicitBase, runGit = git } = {}) {
  const head = runGit("rev-parse", "HEAD");
  const initialRoot =
    explicitBase === undefined &&
    head &&
    runGit("rev-list", "--parents", "--max-count=1", head) === head;
  let base = null;
  let committed;
  if (initialRoot) {
    if (runGit("rev-parse", "--is-shallow-repository") !== "false")
      throw new Error("verify:fast requires complete Git history to verify a root commit");
    committed = parseGitChanges(
      runGit("diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "-z", head),
    );
    committed.broad = true;
  } else {
    if (explicitBase !== undefined) {
      base = runGit("rev-parse", "--verify", `${explicitBase}^{commit}`);
    } else {
      const remote = runGit("rev-parse", "--verify", "refs/remotes/origin/main");
      base = remote === head ? runGit("rev-parse", "--verify", "HEAD^") : remote;
    }
    if (base === head)
      throw new Error("verify:fast base equals HEAD; select an earlier reviewed commit");
    runGit("merge-base", "--is-ancestor", base, head);
    committed = parseGitChanges(runGit("diff", "--name-status", "-z", base, head));
  }
  const working = parseGitChanges(runGit("diff", "--name-status", "-z", "HEAD"));
  const untracked = runGit("ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean);
  const paths = [...new Set([...committed.paths, ...working.paths, ...untracked])].sort();
  if (paths.length === 0)
    throw new Error("verify:fast found no changed paths; provide --base for the reviewed change");
  return { head, base, paths, broad: committed.broad || working.broad };
}

export function classifyFastChanges({ paths, broad = false }) {
  if (paths.length === 0) throw new Error("verify:fast requires an explicit nonempty change set");
  const docs = paths.filter((path) => DOC.test(path));
  const code = paths.filter(
    (path) => CODE.test(path) && !VITEST_TEST.test(path) && !isNodeTest(path),
  );
  const vitestTests = paths.filter((path) => VITEST_TEST.test(path) && !isNodeTest(path));
  const nodeTests = paths.filter((path) => isNodeTest(path));
  const releaseTools = paths.filter((path) => isReleaseTool(path));
  const understood = new Set([...docs, ...code, ...vitestTests, ...nodeTests, ...releaseTools]);
  const full = broad || paths.some((path) => !understood.has(path) || /\/generated\//u.test(path));
  if (full) return { mode: "full", docs: docs.length > 0, related: [], nodeTests: [] };
  if (
    code.length === 0 &&
    vitestTests.length === 0 &&
    nodeTests.length === 0 &&
    releaseTools.length === 0
  )
    return { mode: "docs", docs: true, related: [], nodeTests: [] };
  const readers = releaseTools.flatMap((path) => RELEASE_TOOL_VITEST_READERS[path] ?? []);
  return {
    mode: "related",
    docs: docs.length > 0,
    related: [...new Set([...code, ...vitestTests, ...readers])].sort(),
    nodeTests: [...new Set(nodeTests)].sort(),
    fullNodeSuite: code.length > 0 || releaseTools.length > 0,
  };
}

/** Lines such as `path:line:text` for focused tests that would silently narrow a whole run. */
export function findFocusedTests({
  search = () => {
    try {
      return execFileSync(
        "git",
        [
          "grep",
          "--untracked",
          "-nE",
          FOCUSED_TEST,
          "--",
          "*.test.ts",
          "*.test.mts",
          "*.test.tsx",
          "*.test.mjs",
          "*.node-test.mjs",
        ],
        { cwd: root, encoding: "utf8" },
      );
    } catch (error) {
      if (error?.status === 1) return "";
      throw error;
    }
  },
} = {}) {
  return search().split("\n").filter(Boolean);
}

/** Tell an advisory from an unreachable registry; pnpm audit retries for about 70 s offline. */
export function diagnoseAuditFailure(logText) {
  return NETWORK_FAILURE.test(logText) ? "network" : "advisory";
}

/**
 * test-shards aborts the sibling shard when one fails, so the error that surfaces first can be
 * the aborted sibling's "was interrupted". Point at the sibling logs, where the real failure is.
 */
export async function explainShardAbort(error, { interrupted, list = readdir } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^.* was interrupted; inspect (.+[\\/](run-\d+\.log))$/u.exec(message);
  if (interrupted || match === null) return error;
  const directory = dirname(match[1]);
  const siblings = (await list(directory))
    .filter((name) => /^run-\d+\.log$/u.test(name) && name !== match[2])
    .sort()
    .map((name) => join(directory, name));
  if (siblings.length === 0) return error;
  return new Error(
    `A shard was aborted because a sibling shard failed first, not by an interrupt (${message}). Read the failure in ${siblings.join(", ")}.`,
    { cause: error },
  );
}

export async function runFastVerification({
  changes,
  explicitBase,
  shards = 2,
  selectChanges,
  identifySource = sourceIdentity,
  execute = executeShardCommand,
  runFullSuite = runTestShards,
  resolveEnvironment = testPostgresEnvironment,
  hasFixtureDependencies = (directory) =>
    existsSync(join(directory, FIXTURE_DIRECTORY, "node_modules/next/package.json")) &&
    existsSync(join(directory, FIXTURE_DIRECTORY, "node_modules/@opennextjs/cloudflare")),
  previewWorkerState = inspectPreviewWorkerState,
  searchFocused,
  readLog = (path) => readFile(path, "utf8"),
  report = (line) => process.stderr.write(`${line}\n`),
  cwd = root,
  signal,
  now = () => new Date(),
} = {}) {
  if (shards !== 1 && shards !== 2) throw new Error("verify-fast shards must be 1 or 2");
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-verify-fast-"));
  const receipt = {
    schemaVersion: 1,
    status: "failed",
    startedAt: now().toISOString(),
    reportDirectory: directory,
    commands: [],
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let environment;
  const run = async (label, command, args, diagnose) => {
    receipt.commands.push({ label, command, args });
    const logPath = join(directory, `${receipt.commands.length}-${label}.log`);
    try {
      await execute(command, args, { cwd, logPath, signal: controller.signal, environment });
    } catch (error) {
      throw diagnose === undefined ? error : await diagnose(error, logPath);
    }
  };
  const explainAudit = async (error, logPath) => {
    if (controller.signal.aborted) return error;
    const text = await readLog(logPath).catch(() => "");
    if (diagnoseAuditFailure(text) !== "network") return error;
    return new Error(
      `pnpm audit:moderate could not reach the npm registry: the network is unreachable, which is not an advisory finding. Reconnect and rerun (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  };
  try {
    const choose =
      selectChanges ??
      (changes === undefined ? () => findFastChanges({ explicitBase }) : () => changes);
    const identity = identifySource(cwd);
    const selected = choose();
    if (!isDeepStrictEqual(identifySource(cwd), identity))
      throw new Error("Source changed while selecting fast verification tests");
    const plan = classifyFastChanges(selected);
    Object.assign(receipt, {
      head: selected.head,
      base: selected.base,
      changedPaths: selected.paths,
      mode: plan.mode,
      sourceIdentity: identity,
    });
    environment = resolveEnvironment();
    // Prerequisites and the cheap CI-only gates come first: each used to fail only after a
    // long run (a missing fixture install after the full Vitest run, an audit or pin in CI).
    const focused =
      searchFocused === undefined
        ? findFocusedTests()
        : findFocusedTests({ search: searchFocused });
    if (focused.length > 0)
      throw new Error(`Remove focused tests before verifying: ${focused.join("; ")}`);
    if (plan.mode !== "docs" && !hasFixtureDependencies(cwd)) {
      report(
        `${FIXTURE_DIRECTORY}/node_modules is missing; installing it as CI does (frozen lockfile).`,
      );
      await run("fixture-install", "pnpm", FIXTURE_INSTALL);
    }
    if (plan.mode !== "docs") {
      const state = previewWorkerState(cwd);
      if (state === "incomplete")
        throw new Error("Preview worker package or lockfile is missing; Wrangler tests cannot run");
      if (state === "missing") {
        report(
          `${PREVIEW_WORKER_DIRECTORY}/node_modules is missing or stale; installing its locked dependencies.`,
        );
        await run("preview-worker-install", "pnpm", PREVIEW_WORKER_INSTALL);
        if (previewWorkerState(cwd) !== "present")
          throw new Error(
            "Preview worker Wrangler or Sandbox SDK is unavailable after locked installation",
          );
      } else if (state !== "present" && state !== "absent")
        throw new Error("Preview worker prerequisite state is invalid");
    }
    // They run together and all finish, so one run reports every CI-only failure at once.
    const cheap = await Promise.allSettled([
      run("audit", "pnpm", ["audit:moderate"], explainAudit),
      run("contracts", "pnpm", ["contracts:check"]),
      run("sdk-ts", "pnpm", ["sdk-ts:check"]),
      run("tooling-contract", "pnpm", ["exec", "vitest", "run", "tests/tooling-contract.test.ts"]),
    ]);
    const rejected = cheap.filter((result) => result.status === "rejected");
    if (rejected.length > 0)
      throw new Error(
        rejected
          .map(({ reason }) => (reason instanceof Error ? reason.message : String(reason)))
          .join("; "),
        { cause: rejected[0].reason },
      );
    await run("format", "pnpm", ["format:check"]);
    await run("lint", "pnpm", ["lint"]);
    await run("build", "pnpm", ["build"]);
    await run("typecheck", "pnpm", ["typecheck"]);
    if (plan.docs) {
      await run("plan", "pnpm", ["plan:check"]);
      await run("docs-node", process.execPath, [
        "--test",
        "--test-concurrency=1",
        "tests/check-plan-structure.node-test.mjs",
        "tests/documentation-coverage.node-test.mjs",
        "tests/surface-documentation.node-test.mjs",
        "tests/prepare-web-inputs.node-test.mjs",
      ]);
    }
    if (plan.mode === "full") {
      receipt.commands.push({
        label: "full-vitest",
        command: "test:shards",
        args: ["--shards", String(shards)],
      });
      try {
        receipt.fullSuite = await runFullSuite({
          shards,
          root: cwd,
          signal: controller.signal,
          resolveEnvironment: () => environment,
        });
      } catch (error) {
        throw await explainShardAbort(error, { interrupted: controller.signal.aborted });
      }
      if (receipt.fullSuite?.status !== "passed" || receipt.fullSuite?.shards !== shards)
        throw new Error("Full shard suite did not return a passing receipt");
      await run("node", "pnpm", ["test:node"]);
    } else if (plan.mode === "related") {
      if (plan.related.length > 0)
        await run("related", "pnpm", [
          "exec",
          "vitest",
          "related",
          ...plan.related,
          "--run",
          "--no-file-parallelism",
        ]);
      if (plan.fullNodeSuite) await run("node", "pnpm", ["test:node"]);
      else if (plan.nodeTests.length > 0)
        await run("changed-node", process.execPath, [
          "--test",
          "--test-concurrency=1",
          ...plan.nodeTests,
        ]);
    }
    if (!isDeepStrictEqual(identifySource(cwd), identity) || !isDeepStrictEqual(choose(), selected))
      throw new Error("Source or changed-test selection drifted during fast verification");
    receipt.status = "passed";
    return receipt;
  } catch (error) {
    controller.abort();
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    receipt.finishedAt = now().toISOString();
    await writeFile(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { base, shards } = parseVerifyFastArgs(process.argv.slice(2));
    const receipt = await runFastVerification({
      explicitBase: base,
      shards,
      signal: stop.signal,
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
