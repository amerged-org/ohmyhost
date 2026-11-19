import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  FOCUSED_TEST,
  RELEASE_TOOL_VITEST_READERS,
  classifyFastChanges,
  diagnoseAuditFailure,
  explainShardAbort,
  findFastChanges,
  findFocusedTests,
  inspectPreviewWorkerState,
  isNodeTest,
  isReleaseTool,
  parseGitChanges,
  parseVerifyFastArgs,
  runFastVerification,
} from "../scripts/verify-fast.mjs";

const stableSource = () => ({ commit: "a".repeat(40), sourceDigest: "b".repeat(64) });

test("fast verification requires a real change baseline and parses Git rename/deletion records", () => {
  assert.deepEqual(parseVerifyFastArgs([]), {});
  assert.deepEqual(parseVerifyFastArgs(["--base", "origin/main"]), { base: "origin/main" });
  assert.throws(() => parseVerifyFastArgs(["--base", "--evil"]));
  assert.deepEqual(parseVerifyFastArgs(["--shards", "1"]), { shards: 1 });
  assert.deepEqual(parseVerifyFastArgs(["--base", "origin/main", "--shards", "2"]), {
    base: "origin/main",
    shards: 2,
  });
  assert.deepEqual(parseVerifyFastArgs(["--shards", "1", "--base", "origin/main"]), {
    base: "origin/main",
    shards: 1,
  });
  for (const args of [
    ["--shards"],
    ["--shards", "0"],
    ["--shards", "3"],
    ["--shards", "01"],
    ["--shards", "1", "--shards", "2"],
    ["--base", "x", "--base", "y"],
    ["--shards", "1;evil"],
  ])
    assert.throws(() => parseVerifyFastArgs(args));
  assert.deepEqual(parseGitChanges("M\0apps/control-api/src/app.ts\0"), {
    paths: ["apps/control-api/src/app.ts"],
    broad: false,
  });
  assert.deepEqual(parseGitChanges("R100\0old.ts\0new.ts\0D\0removed.ts\0"), {
    paths: ["old.ts", "new.ts", "removed.ts"],
    broad: true,
  });
  const head = "a".repeat(40);
  const parent = "b".repeat(40);
  const commands = [];
  const runGit = (...args) => {
    commands.push(args);
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD") return head;
    if (args[0] === "rev-parse" && args.at(-1) === "refs/remotes/origin/main") return head;
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD^") return parent;
    if (args[0] === "diff" && args.at(-1) === "HEAD") return "";
    if (args[0] === "diff") return "M\0packages/customer-runtime/src/storage.ts\0";
    return "";
  };
  assert.deepEqual(findFastChanges({ runGit }), {
    head,
    base: parent,
    paths: ["packages/customer-runtime/src/storage.ts"],
    broad: false,
  });
  assert.ok(commands.some((args) => args.includes("HEAD^")));
  assert.throws(() => findFastChanges({ runGit: () => "" }), /base equals HEAD|changed paths/u);
});

test("the first public root verifies the entire tree and rejects a shallow history", () => {
  const head = "a".repeat(40);
  const commands = new Map([
    ["rev-parse HEAD", head],
    [`rev-list --parents --max-count=1 ${head}`, head],
    ["rev-parse --is-shallow-repository", "false"],
    [`diff-tree --root -r --no-commit-id --name-status -z ${head}`, "A\0package.json\0"],
    ["diff --name-status -z HEAD", ""],
    ["ls-files --others --exclude-standard -z", ""],
  ]);
  const read = (...args) => {
    const output = commands.get(args.join(" "));
    assert.notEqual(output, undefined, `Unexpected Git command: ${args.join(" ")}`);
    return output;
  };
  assert.deepEqual(findFastChanges({ runGit: read }), {
    head,
    base: null,
    paths: ["package.json"],
    broad: true,
  });
  commands.set("rev-parse --is-shallow-repository", "true");
  assert.throws(() => findFastChanges({ runGit: read }), /complete Git history/u);
});

test("docs use documentation checks, changed source selects related tests, shared config requires full suite", () => {
  assert.deepEqual(classifyFastChanges({ paths: ["PLAN.md", "docs/quickstart.md"] }), {
    mode: "docs",
    docs: true,
    related: [],
    nodeTests: [],
  });
  assert.deepEqual(classifyFastChanges({ paths: ["packages/customer-runtime/src/storage.ts"] }), {
    mode: "related",
    docs: false,
    related: ["packages/customer-runtime/src/storage.ts"],
    nodeTests: [],
    fullNodeSuite: true,
  });
  assert.equal(classifyFastChanges({ paths: ["vitest.config.mts"] }).mode, "full");
  assert.deepEqual(
    classifyFastChanges({ paths: ["apps/build-runner/sandbox/tests/build-runtime.test.mjs"] })
      .nodeTests,
    ["apps/build-runner/sandbox/tests/build-runtime.test.mjs"],
  );
  assert.deepEqual(
    classifyFastChanges({ paths: ["scripts/preview-spike/worker/test/idle.test.mjs"] }),
    {
      mode: "related",
      docs: false,
      related: [],
      nodeTests: ["scripts/preview-spike/worker/test/idle.test.mjs"],
      fullNodeSuite: false,
    },
  );
  assert.equal(
    classifyFastChanges({ paths: ["scripts/preview-spike/worker/idle.mjs"] }).mode,
    "full",
  );
  // Release tooling is owned by the Node suite; only its Vitest text readers are added.
  assert.deepEqual(classifyFastChanges({ paths: ["scripts/release-pipeline.mjs"] }), {
    mode: "related",
    docs: false,
    related: [],
    nodeTests: [],
    fullNodeSuite: true,
  });
  assert.deepEqual(
    classifyFastChanges({
      paths: ["scripts/platform-release.mjs", "scripts/prepare-npm-client-release.mjs"],
    }).related,
    ["apps/product-cli/test/repository-init.test.ts"],
  );
  assert.equal(
    classifyFastChanges({
      paths: ["scripts/release-train.mjs", "tests/release-pipeline.node-test.mjs"],
    }).mode,
    "related",
  );
  // Any other script is imported or read by Vitest suites, so it keeps the complete run.
  assert.equal(classifyFastChanges({ paths: ["scripts/check-ci-jobs.mjs"] }).mode, "full");
  assert.equal(
    classifyFastChanges({ paths: ["scripts/release-train.mjs", "scripts/check-ci-jobs.mjs"] }).mode,
    "full",
  );
  assert.equal(
    classifyFastChanges({ paths: ["scripts/release-train.mjs"], broad: true }).mode,
    "full",
  );
  assert.equal(classifyFastChanges({ paths: ["PLAN.md"], broad: true }).mode, "full");
  assert.throws(() => classifyFastChanges({ paths: [] }), /nonempty/u);
});

test("docs-only fast verification records scoped checks without silently skipping tests", async () => {
  const calls = [];
  let receipt;
  try {
    receipt = await runFastVerification({
      changes: { head: "a".repeat(40), base: "b".repeat(40), paths: ["ARCHITECTURE.md"] },
      identifySource: stableSource,
      searchFocused: () => "",
      resolveEnvironment: () => ({ PATH: "/validated/postgres/bin" }),
      execute: async (command, args, { environment }) => {
        calls.push([command, ...args]);
        assert.equal(environment.PATH, "/validated/postgres/bin");
      },
    });
    assert.equal(receipt.status, "passed");
    assert.deepEqual(
      receipt.commands.map((command) => command.label),
      [
        "audit",
        "contracts",
        "sdk-ts",
        "tooling-contract",
        "format",
        "lint",
        "build",
        "typecheck",
        "plan",
        "docs-node",
      ],
    );
    assert.equal(
      calls.some((args) => args.includes("test-shards.mjs")),
      false,
    );
    assert.ok(calls.at(-1).includes("tests/check-plan-structure.node-test.mjs"));
    const persisted = JSON.parse(await readFile(`${receipt.reportDirectory}/receipt.json`, "utf8"));
    assert.equal(persisted.status, "passed");
  } finally {
    if (receipt !== undefined) await rm(receipt.reportDirectory, { recursive: true, force: true });
  }
});

test("fast verification runs a changed spike test with Node rather than Vitest", async () => {
  const path = "scripts/preview-spike/worker/test/idle.test.mjs";
  const calls = [];
  let receipt;
  try {
    receipt = await runFastVerification({
      changes: { head: "a".repeat(40), base: "b".repeat(40), paths: [path] },
      identifySource: stableSource,
      hasFixtureDependencies: () => true,
      previewWorkerState: () => "present",
      searchFocused: () => "",
      resolveEnvironment: () => ({}),
      execute: async (command, args) => calls.push([command, ...args]),
    });
    assert.equal(receipt.status, "passed");
    assert.ok(calls.some((args) => args.includes("--test") && args.includes(path)));
    assert.equal(
      calls.some((args) => args.includes("related")),
      false,
    );
  } finally {
    if (receipt !== undefined) await rm(receipt.reportDirectory, { recursive: true, force: true });
  }
});

test("preview worker prerequisite detects absent, incomplete, missing and stale installs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verify-fast-preview-worker-"));
  const worker = join(directory, "scripts/preview-spike/worker");
  const guard = join(directory, "scripts/preview-spike/deployment/deployment.test.mjs");
  const manifest = {
    dependencies: { "@cloudflare/sandbox": "1.0.1" },
    devDependencies: { wrangler: "4.158.0" },
  };
  const lock = {
    packages: {
      "": {
        dependencies: { "@cloudflare/sandbox": "1.0.1" },
        devDependencies: { wrangler: "4.158.0" },
      },
      "node_modules/@cloudflare/sandbox": { version: "1.0.1" },
      "node_modules/wrangler": { version: "4.158.0" },
    },
  };
  try {
    assert.equal(inspectPreviewWorkerState(directory), "absent");
    await mkdir(dirname(guard), { recursive: true });
    await writeFile(guard, "synthetic guard suite\n");
    assert.equal(inspectPreviewWorkerState(directory), "incomplete");
    await mkdir(worker, { recursive: true });
    await writeFile(join(worker, "package.json"), JSON.stringify(manifest));
    assert.equal(inspectPreviewWorkerState(directory), "incomplete");
    await writeFile(join(worker, "package-lock.json"), JSON.stringify(lock));
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    await mkdir(join(worker, "node_modules/wrangler"), { recursive: true });
    await mkdir(join(worker, "node_modules/.bin"), { recursive: true });
    await writeFile(
      join(worker, "node_modules/wrangler/package.json"),
      JSON.stringify({ version: "4.158.0" }),
    );
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    await writeFile(join(worker, "node_modules/.bin/wrangler"), "synthetic binary\n");
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    const sdk = join(worker, "node_modules/@cloudflare/sandbox");
    await mkdir(join(sdk, "dist"), { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({ version: "1.0.1" }));
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    await writeFile(join(sdk, "dist/index.mjs"), "synthetic SDK\n");
    assert.equal(inspectPreviewWorkerState(directory), "present");
    await writeFile(join(sdk, "package.json"), JSON.stringify({ version: "1.0.0" }));
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    await writeFile(join(sdk, "package.json"), JSON.stringify({ version: "1.0.1" }));
    await rm(join(sdk, "dist/index.mjs"));
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    await writeFile(join(sdk, "dist/index.mjs"), "synthetic SDK\n");
    manifest.dependencies["@cloudflare/sandbox"] = "1.0.0";
    await writeFile(join(worker, "package.json"), JSON.stringify(manifest));
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    manifest.dependencies["@cloudflare/sandbox"] = "1.0.1";
    await writeFile(join(worker, "package.json"), JSON.stringify(manifest));
    lock.packages[""].dependencies["@cloudflare/sandbox"] = "1.0.0";
    await writeFile(join(worker, "package-lock.json"), JSON.stringify(lock));
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    lock.packages[""].dependencies["@cloudflare/sandbox"] = "1.0.1";
    lock.packages["node_modules/@cloudflare/sandbox"].version = "1.0.0";
    await writeFile(join(worker, "package-lock.json"), JSON.stringify(lock));
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    lock.packages["node_modules/@cloudflare/sandbox"].version = "1.0.1";
    await writeFile(join(worker, "package-lock.json"), JSON.stringify(lock));
    manifest.dependencies["@cloudflare/sandbox"] = "1.0.2";
    lock.packages[""].dependencies["@cloudflare/sandbox"] = "1.0.2";
    lock.packages["node_modules/@cloudflare/sandbox"].version = "1.0.2";
    await writeFile(join(worker, "package.json"), JSON.stringify(manifest));
    await writeFile(join(worker, "package-lock.json"), JSON.stringify(lock));
    await writeFile(join(sdk, "package.json"), JSON.stringify({ version: "1.0.2" }));
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    manifest.dependencies["@cloudflare/sandbox"] = "1.0.1";
    lock.packages[""].dependencies["@cloudflare/sandbox"] = "1.0.1";
    lock.packages["node_modules/@cloudflare/sandbox"].version = "1.0.1";
    await writeFile(join(worker, "package.json"), JSON.stringify(manifest));
    await writeFile(join(worker, "package-lock.json"), JSON.stringify(lock));
    await writeFile(join(sdk, "package.json"), JSON.stringify({ version: "1.0.1" }));
    assert.equal(inspectPreviewWorkerState(directory), "present");
    await writeFile(
      join(worker, "node_modules/wrangler/package.json"),
      JSON.stringify({ version: "4.145.0" }),
    );
    assert.equal(inspectPreviewWorkerState(directory), "missing");
    await writeFile(join(worker, "package-lock.json"), "invalid lock\n");
    assert.equal(inspectPreviewWorkerState(directory), "missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fast verification installs missing locked preview tooling before running Node suites", async () => {
  const calls = [];
  let directory;
  let state = "missing";
  try {
    await runFastVerification({
      changes: {
        head: "a".repeat(40),
        base: "b".repeat(40),
        paths: ["scripts/preview-spike/deployment/deployment.test.mjs"],
      },
      identifySource: stableSource,
      hasFixtureDependencies: () => true,
      previewWorkerState: () => state,
      searchFocused: () => "",
      report: () => {},
      resolveEnvironment: () => ({}),
      execute: async (command, args, { logPath }) => {
        directory = dirname(logPath);
        calls.push([command, ...args]);
        if (args[0] === "exec" && args[1] === "npm") state = "present";
      },
    });
    assert.deepEqual(calls[0], [
      "pnpm",
      "exec",
      "npm",
      "--prefix",
      "scripts/preview-spike/worker",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    assert.ok(
      calls.some((args) => args.includes("scripts/preview-spike/deployment/deployment.test.mjs")),
    );
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

test("failed or ineffective preview installs stop before audit and tests", async () => {
  for (const failure of ["install", "unavailable"]) {
    const calls = [];
    let directory;
    try {
      await assert.rejects(
        runFastVerification({
          changes: { head: "a".repeat(40), base: "b".repeat(40), paths: ["vitest.config.mts"] },
          identifySource: stableSource,
          hasFixtureDependencies: () => true,
          previewWorkerState: () => "missing",
          searchFocused: () => "",
          report: () => {},
          resolveEnvironment: () => ({}),
          execute: async (command, args, { logPath }) => {
            directory = dirname(logPath);
            calls.push([command, ...args]);
            if (failure === "install") throw new Error("synthetic install failure");
          },
        }),
        failure === "install"
          ? /synthetic install failure/u
          : /Wrangler or Sandbox SDK is unavailable after locked installation/u,
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(0, 3), ["pnpm", "exec", "npm"]);
      const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
      assert.equal(receipt.status, "failed");
      assert.deepEqual(
        receipt.commands.map((entry) => entry.label),
        ["preview-worker-install"],
      );
    } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  }
});

test("shared configuration changes cannot pass without the complete shard and Node suites", async () => {
  for (const selected of [undefined, 1, 2]) {
    const calls = [],
      full = [];
    let receipt;
    try {
      receipt = await runFastVerification({
        ...(selected === undefined ? {} : { shards: selected }),
        changes: { head: "a".repeat(40), base: "b".repeat(40), paths: ["vitest.config.mts"] },
        identifySource: stableSource,
        previewWorkerState: () => "present",
        searchFocused: () => "",
        report: () => {},
        resolveEnvironment: () => ({ PATH: "/validated/postgres/bin" }),
        execute: async (_command, args) => calls.push(args),
        runFullSuite: async (options) => {
          full.push(options);
          return { status: "passed", shards: options.shards };
        },
      });
      assert.equal(full.length, 1);
      assert.equal(full[0].shards, selected ?? 2);
      assert.deepEqual(receipt.commands.find((x) => x.label === "full-vitest").args, [
        "--shards",
        String(selected ?? 2),
      ]);
      assert.equal(full[0].resolveEnvironment().PATH, "/validated/postgres/bin");
      assert.ok(calls.some((args) => args.includes("test:node")));
      assert.equal(
        JSON.parse(await readFile(`${receipt.reportDirectory}/receipt.json`, "utf8")).fullSuite
          .shards,
        selected ?? 2,
      );
    } finally {
      if (receipt !== undefined)
        await rm(receipt.reportDirectory, { recursive: true, force: true });
    }
  }
  for (const shards of [0, 3, "1", null])
    await assert.rejects(runFastVerification({ shards }), /shards/u);
  let failedDirectory;
  const failedCalls = [];
  try {
    await assert.rejects(
      runFastVerification({
        shards: 1,
        changes: { head: "a".repeat(40), base: "b".repeat(40), paths: ["vitest.config.mts"] },
        identifySource: stableSource,
        searchFocused: () => "",
        hasFixtureDependencies: () => true,
        previewWorkerState: () => "present",
        resolveEnvironment: () => ({}),
        execute: async (_command, args, { logPath }) => {
          failedDirectory = dirname(logPath);
          failedCalls.push(args);
        },
        runFullSuite: async () => ({ status: "passed", shards: 2 }),
      }),
      /Full shard suite did not return a passing receipt/u,
    );
    assert.equal(
      failedCalls.some((args) => args.includes("test:node")),
      false,
    );
    const rejected = JSON.parse(await readFile(`${failedDirectory}/receipt.json`, "utf8"));
    assert.equal(rejected.status, "failed");
    assert.deepEqual(rejected.commands.find((x) => x.label === "full-vitest").args, [
      "--shards",
      "1",
    ]);
  } finally {
    if (failedDirectory !== undefined) await rm(failedDirectory, { recursive: true, force: true });
  }
});

test("fast verification refuses source bytes or changed-path selection that move during checks", async () => {
  const selected = { head: "a".repeat(40), base: "b".repeat(40), paths: ["PLAN.md"] };
  for (const drift of ["source", "paths"]) {
    let identityReads = 0;
    let selections = 0;
    let directory;
    try {
      await assert.rejects(
        runFastVerification({
          selectChanges: () => {
            selections++;
            return drift === "paths" && selections > 1
              ? { ...selected, paths: ["ARCHITECTURE.md"] }
              : selected;
          },
          identifySource: () => {
            identityReads++;
            return drift === "source" && identityReads > 2
              ? { commit: selected.head, sourceDigest: "c".repeat(64) }
              : stableSource();
          },
          searchFocused: () => "",
          resolveEnvironment: () => ({ PATH: "/validated/postgres/bin" }),
          execute: async (_command, _args, { logPath }) => {
            directory = dirname(logPath);
          },
        }),
        /drifted during fast verification/u,
      );
    } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  }
});

test("fast verification fails on missing prerequisites and CI-only checks before any long step", async () => {
  const run = async (paths, options = {}) => {
    const calls = [];
    let directory;
    try {
      await runFastVerification({
        changes: { head: "a".repeat(40), base: "b".repeat(40), paths },
        identifySource: stableSource,
        previewWorkerState: () => "present",
        resolveEnvironment: () => ({ PATH: "/validated/postgres/bin" }),
        searchFocused: () => "",
        report: () => {},
        runFullSuite: async () => ({ status: "passed", shards: 2 }),
        execute: async (command, args, { logPath }) => {
          directory = dirname(logPath);
          calls.push([command, ...args].join(" "));
        },
        ...options,
      });
    } catch (error) {
      return { calls, error };
    } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
    return { calls };
  };
  const message = [];
  const missing = await run(["packages/customer-runtime/src/storage.ts"], {
    hasFixtureDependencies: () => false,
    report: (line) => message.push(line),
  });
  assert.equal(
    missing.calls[0],
    "pnpm --dir fixtures/next-edge --ignore-workspace install --frozen-lockfile --ignore-scripts",
  );
  assert.match(message.join("\n"), /fixtures\/next-edge\/node_modules is missing; installing/u);
  // The cheap CI-only gates precede format, lint, build and every test run.
  assert.deepEqual(missing.calls.slice(1, 5), [
    "pnpm audit:moderate",
    "pnpm contracts:check",
    "pnpm sdk-ts:check",
    "pnpm exec vitest run tests/tooling-contract.test.ts",
  ]);
  assert.equal(missing.calls[5], "pnpm format:check");
  const present = await run(["vitest.config.mts"], { hasFixtureDependencies: () => true });
  assert.equal(
    present.calls.some((call) => call.includes("install")),
    false,
  );
  const docs = await run(["PLAN.md"], { hasFixtureDependencies: () => false });
  assert.equal(
    docs.calls.some((call) => call.includes("next-edge")),
    false,
  );
  // A focused test aborts before any command, a failed fixture install names the cause.
  const focused = await run(["packages/customer-runtime/src/storage.ts"], {
    // Built from pieces: this file must not contain what the focused-test gate searches for.
    searchFocused: () => `apps/cli/src/x.test.ts:3:  it${".only"}(\n`,
  });
  assert.deepEqual(focused.calls, []);
  assert.match(focused.error.message, /focused tests.*apps\/cli\/src\/x\.test\.ts:3/su);
  const offline = await run(["PLAN.md"], {
    readLog: async () =>
      "ECONNREFUSED request to https://registry.npmjs.org/-/npm/v1/security/audits",
    execute: async (command, args) => {
      if (args[0] === "audit:moderate") throw new Error("pnpm exited 1; inspect /tmp/x.log");
      if (args[0] === "contracts:check") throw new Error("pnpm exited 1; inspect /tmp/y.log");
    },
  });
  // One run reports every cheap failure, not only the first.
  assert.match(offline.error.message, /network is unreachable.*not an advisory/su);
  assert.match(offline.error.message, /inspect \/tmp\/y\.log/u);
  assert.equal(diagnoseAuditFailure("2 vulnerabilities found\nSeverity: 2 moderate"), "advisory");
  assert.equal(diagnoseAuditFailure("ERR_PNPM_FETCH_503 registry down"), "network");
  assert.deepEqual(findFocusedTests({ search: () => "" }), []);
  assert.deepEqual(findFocusedTests({ search: () => "a.test.ts:1:x\nb.test.ts:2:y\n" }), [
    "a.test.ts:1:x",
    "b.test.ts:2:y",
  ]);
});

test("the focused-test pattern finds focused tests and nothing else with the host's git grep", async () => {
  // Built from pieces so that this file does not contain what the gate searches for.
  const focused = [
    `  it${".only"}("a", () => {});`,
    `describe${".only"}("b", () => {});`,
    `test${".only"}.each([])("c", () => {});`,
    `suite${".only"}("d", () => {});`,
    `f${"it"}("e", () => {});`,
    `f${"describe"}("f", () => {});`,
  ];
  const lookalikes = [
    "identity.only(1);",
    "const profit(2);",
    "tests.only(3);",
    "it.onlyX(4);",
    "await_it.only(5);",
  ];
  const directory = await mkdtemp(join(tmpdir(), "verify-fast-focused-"));
  try {
    await writeFile(join(directory, "focused.test.ts"), `${focused.join("\n")}\n`);
    await writeFile(join(directory, "clean.test.ts"), `${lookalikes.join("\n")}\n`);
    const matches = execFileSync(
      "git",
      ["grep", "--no-index", "-nE", FOCUSED_TEST, "--", "*.test.ts"],
      { cwd: directory, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    assert.equal(matches.length, focused.length, matches.join("\n"));
    assert.ok(
      matches.every((line) => line.startsWith("focused.test.ts:")),
      matches.join("\n"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // The committed tests contain no focused test, and none of them matches by quoting the pattern.
  assert.deepEqual(findFocusedTests(), []);
});

test("an aborted sibling shard names the real failure instead of only 'interrupted'", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verify-fast-shards-"));
  try {
    for (const name of ["run-1.log", "run-2.log", "build.log"])
      await writeFile(join(directory, name), "");
    const aborted = new Error(`node was interrupted; inspect ${join(directory, "run-1.log")}`);
    const explained = await explainShardAbort(aborted, { interrupted: false });
    assert.match(explained.message, /sibling shard failed first, not by an interrupt/u);
    assert.ok(explained.message.includes(join(directory, "run-2.log")));
    assert.equal(explained.message.includes(`${join(directory, "run-1.log")},`), false);
    assert.equal(explained.cause, aborted);
    // A real Ctrl-C, other failures and a missing log keep their own message.
    assert.equal(await explainShardAbort(aborted, { interrupted: true }), aborted);
    const failed = new Error(`node exited 1; inspect ${join(directory, "run-2.log")}`);
    assert.equal(await explainShardAbort(failed, { interrupted: false }), failed);
    const early = new Error("node was interrupted before it started");
    assert.equal(await explainShardAbort(early, { interrupted: false }), early);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release tooling keeps its Vitest readers: every Vitest file that names a release script is mapped", async () => {
  const files = execFileSync("git", ["ls-files", "-z", "scripts"], { encoding: "utf8" })
    .split("\0")
    .filter((path) => /^scripts\/[^/]+\.mjs$/u.test(path));
  const tools = files.filter((path) => isReleaseTool(path));
  assert.ok(tools.length >= 13, "release tooling must be recognized");
  assert.equal(isReleaseTool("scripts/check-ci-jobs.mjs"), false);
  assert.equal(isReleaseTool("scripts/prepare-web-inputs.mjs"), false);
  assert.equal(isNodeTest("scripts/preview-spike/auth/native-config.test.mjs"), true);
  assert.equal(isNodeTest("apps/build-runner/sandbox/tests/build-runtime.test.mjs"), true);
  assert.equal(isNodeTest("apps/product-cli/test/repository-init.test.ts"), false);
  const names = tools.map((path) => path.slice("scripts/".length));
  const pattern = names.map((name) => name.replace(/\./gu, "\\.")).join("|");
  let matches = "";
  try {
    matches = execFileSync(
      "git",
      ["grep", "-lE", pattern, "--", "*.test.ts", "*.test.mts", "*.test.tsx", "*.test.mjs"],
      { encoding: "utf8" },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const readers = new Map();
  for (const path of matches.split("\n").filter((path) => path && !isNodeTest(path))) {
    const text = await readFile(path, "utf8");
    for (const tool of tools)
      if (text.includes(tool.slice("scripts/".length)))
        readers.set(path, [...(readers.get(path) ?? []), tool]);
  }
  for (const [reader, scripts] of readers)
    for (const script of scripts)
      assert.ok(
        RELEASE_TOOL_VITEST_READERS[script]?.includes(reader),
        `${reader} reads ${script}; list it in RELEASE_TOOL_VITEST_READERS`,
      );
  for (const [script, listed] of Object.entries(RELEASE_TOOL_VITEST_READERS))
    for (const reader of listed)
      assert.ok(readers.get(reader)?.includes(script), `${reader} no longer reads ${script}`);
});
