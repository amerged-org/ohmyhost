/* global process, queueMicrotask, setTimeout */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { APPLICATION_ROOT_CONFORMANCE_CORPUS } from "../packages/contracts/dist/index.js";
import * as proof from "../scripts/application-root-proof.mjs";

import {
  APPLICATION_ROOT_PROOF_FRAMEWORK_PLAN_SCHEMA_VERSION,
  APPLICATION_ROOT_PROOF_PHASES,
  assertProofRuntimeStopped,
  createDeterministicApplicationRootArchive,
  createApplicationRootProofCommands,
  createProofCommandEnvironment,
  runApplicationRootProof,
  stopProofProcess,
  validateProofApplicationRoot,
} from "../scripts/application-root-proof.mjs";

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port reservation failed");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
};

const portIsOpen = (port) =>
  new Promise((resolveConnection) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("error", () => resolveConnection(false));
  });

const startProcessGroupServer = async (port, ignoreTermination = false) => {
  const serverProgram = `
    const { createServer } = require("node:net");
    ${ignoreTermination ? 'process.on("SIGTERM", () => {});' : ""}
    createServer((_request, response) => response.end("ok")).listen(${port}, "127.0.0.1");
  `;
  const parentProgram = `
    const { spawn } = require("node:child_process");
    ${ignoreTermination ? 'process.on("SIGTERM", () => {});' : ""}
    spawn(process.execPath, ["-e", ${JSON.stringify(serverProgram)}], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", parentProgram], {
    detached: true,
    stdio: "ignore",
  });
  child.proofProcessGroupId = child.pid;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !(await portIsOpen(port))) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.equal(await portIsOpen(port), true);
  return child;
};

const createHarness = ({ failAfter } = {}) => {
  const calls = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    calls.push(["kill", signal]);
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  const workspace = {
    root: "/private/proof/repository",
    application: "/private/proof/repository/site",
    generated: "/private/proof/repository/site/.ohmyhost-proof",
    home: "/private/proof/home",
    temporary: "/private/proof/tmp",
  };
  const dependencies = {
    async prepare() {
      calls.push(["prepare"]);
      return workspace;
    },
    async inspect(value) {
      calls.push(["inspect", value]);
      return {
        applicationRoot: "site",
        schemaVersion: APPLICATION_ROOT_PROOF_FRAMEWORK_PLAN_SCHEMA_VERSION,
      };
    },
    async preparePackageManagerEvidence(value) {
      calls.push(["packageManagerEvidence", value]);
      return `${workspace.generated}/package-manager.json`;
    },
    async execute(specification) {
      calls.push(["execute", specification]);
    },
    async patchOpenNext(value) {
      calls.push(["openNextPatch", value]);
    },
    async validateNextCache(value) {
      calls.push(["nextCacheValidate", value]);
    },
    async prepareNextPlatformConfig(value) {
      calls.push(["nextPlatformConfig", value]);
    },
    async populateNextCache(value) {
      calls.push(["nextCachePopulate", value]);
    },
    async verifyArtifact(value) {
      calls.push(["artifact", value]);
      return {
        schemaVersion: "ohmyhost.artifact/v3",
        executedModuleDigest: `sha256:${"a".repeat(64)}`,
      };
    },
    async startWorkerd(specification) {
      calls.push(["start", specification]);
      return child;
    },
    async waitUntilReady(value) {
      calls.push(["ready", value]);
    },
    async probe(value) {
      calls.push(["probe", value]);
      return {
        firstNonce: "one",
        secondNonce: "two",
        apiStatus: 200,
        assetStatus: 200,
        runtimeFileStatus: 200,
        privateFileStatus: 404,
        staticStatuses: { alpha: 200, beta: 200 },
        staticRscStatuses: { alpha: 200, beta: 200 },
        unknownStaticStatus: 404,
        privateCacheStatus: 404,
        themeScriptStatus: 200,
        serializedTheme: "dark",
        runtimeHeader: "edge-v1",
      };
    },
    async stop(process) {
      calls.push(["stop", process]);
    },
    async cleanup(value) {
      calls.push(["cleanup", value]);
    },
    async assertClean(value) {
      calls.push(["assertClean", value]);
    },
  };
  return { calls, child, dependencies, failAfter, workspace };
};

test("creates the exact nested Next proof commands", () => {
  assert.equal(
    proof.rewriteProofPlatformImports(
      'import { defineCloudflareConfig } from "/opt/ohmyhost-platform/lib/node_modules/@opennextjs/cloudflare/dist/api/index.js";\n' +
        'import cache from "/opt/ohmyhost-platform/lib/node_modules/@opennextjs/cloudflare/dist/api/overrides/incremental-cache/static-assets-incremental-cache.js";\n',
      "/private/proof/repository/site",
    ),
    'import { defineCloudflareConfig } from "/private/proof/repository/site/node_modules/@opennextjs/cloudflare/dist/api/index.js";\n' +
      'import cache from "/private/proof/repository/site/node_modules/@opennextjs/cloudflare/dist/api/overrides/incremental-cache/static-assets-incremental-cache.js";\n',
  );
  assert.deepEqual(
    createApplicationRootProofCommands({
      application: "/private/proof/repository/site",
      generated: "/private/proof/repository/site/.ohmyhost-proof",
      port: 8792,
    }),
    {
      install: {
        command: "pnpm",
        arguments: ["install", "--frozen-lockfile", "--ignore-workspace", "--ignore-scripts"],
        cwd: "/private/proof/repository/site",
        environment: {},
      },
      nextBuild: {
        command: "pnpm",
        arguments: ["run", "build", "--webpack"],
        cwd: "/private/proof/repository/site",
        environment: { NEXT_PRIVATE_STANDALONE: "true" },
      },
      openNext: {
        command: "pnpm",
        arguments: [
          "exec",
          "opennextjs-cloudflare",
          "build",
          "--skipNextBuild",
          "--config=.ohmyhost-next-wrangler.jsonc",
          "--openNextConfigPath=.ohmyhost-open-next.config.ts",
        ],
        cwd: "/private/proof/repository/site",
        environment: {},
      },
      wranglerDryRun: {
        command: "pnpm",
        arguments: [
          "exec",
          "wrangler",
          "deploy",
          "--dry-run",
          "--outdir",
          "/private/proof/repository/site/.ohmyhost-worker",
          "--metafile",
          "/private/proof/repository/site/.ohmyhost-next-metafile.json",
          "--config",
          ".ohmyhost-next-wrangler.jsonc",
        ],
        cwd: "/private/proof/repository/site",
        environment: { WRANGLER_SEND_METRICS: "false" },
      },
      dependencyEvidence: {
        command: "pnpm",
        arguments: ["list", "--json", "--depth", "Infinity"],
        cwd: "/private/proof/repository/site",
        environment: {},
        stdoutPath: "/private/proof/repository/site/.ohmyhost-resolved-dependencies.json",
      },
      workerd: {
        command: "pnpm",
        arguments: [
          "--dir",
          "/private/proof/repository/site",
          "exec",
          "wrangler",
          "dev",
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          "8792",
          "--config",
          "/private/proof/repository/site/.ohmyhost-proof/runtime/wrangler.jsonc",
        ],
        cwd: "/private/proof/repository/site/.ohmyhost-proof/runtime",
        environment: { WRANGLER_SEND_METRICS: "false" },
      },
    },
  );
});

test("creates a credential-free command environment inside the proof workspace", () => {
  const environment = createProofCommandEnvironment(
    {
      PATH: "/bin",
      LANG: "C.UTF-8",
      AWS_SECRET_ACCESS_KEY: "secret",
      CLOUDFLARE_API_TOKEN: "secret",
      NPM_TOKEN: "secret",
    },
    { home: "/private/proof/home", temporary: "/private/proof/tmp" },
  );
  assert.deepEqual(environment, {
    PATH: "/bin",
    LANG: "C.UTF-8",
    HOME: "/private/proof/home",
    TMPDIR: "/private/proof/tmp",
    XDG_CACHE_HOME: "/private/proof/home/.cache",
    XDG_CONFIG_HOME: "/private/proof/home/.config",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NO_COLOR: "1",
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_update_notifier: "false",
  });
});

for (const { name, value } of APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted) {
  test(`accepts proof application root: ${name}`, () => {
    assert.equal(validateProofApplicationRoot(value), value);
  });
}

for (const { name, value } of APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected) {
  test(`rejects proof application root: ${name}`, () => {
    assert.throws(
      () => validateProofApplicationRoot(value),
      /APPLICATION_ROOT_PROOF_INVALID_APPLICATION_ROOT/u,
    );
  });
}

test("creates the same full USTAR gzip archive for the same nested repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-proof-archive-test-"));
  try {
    await mkdir(join(root, "site", ".open-next"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "ohmyhost.yaml"), "applicationRoot: site\n"),
      writeFile(join(root, "root-only-sentinel.txt"), "root\n"),
      writeFile(join(root, "site", "package.json"), '{"name":"nested"}\n'),
      writeFile(join(root, "site", ".open-next", "generated.js"), "generated\n"),
      // The customer's OpenNext config is source; only the platform's own config is generated.
      writeFile(join(root, "site", "open-next.config.ts"), "export default {};\n"),
      writeFile(join(root, "site", ".ohmyhost-open-next.config.ts"), "export default {};\n"),
    ]);
    const first = await createDeterministicApplicationRootArchive(root);
    const second = await createDeterministicApplicationRootArchive(root);
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(first.body, second.body);
    assert.deepEqual(first.paths, [
      "ohmyhost.yaml",
      "root-only-sentinel.txt",
      "site/open-next.config.ts",
      "site/package.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs the application-root proof phases in production order", async () => {
  const harness = createHarness();
  const result = await runApplicationRootProof({
    dependencies: harness.dependencies,
    port: 8792,
  });
  assert.deepEqual(
    harness.calls.map(([name]) => name),
    [
      "prepare",
      "inspect",
      "packageManagerEvidence",
      "execute",
      "openNextPatch",
      "execute",
      "nextCacheValidate",
      "nextPlatformConfig",
      "execute",
      "nextCachePopulate",
      "execute",
      "execute",
      "artifact",
      "start",
      "ready",
      "probe",
      "stop",
      "cleanup",
      "assertClean",
    ],
  );
  assert.equal(result.applicationRoot, "site");
  assert.equal(
    result.frameworkPlanSchemaVersion,
    APPLICATION_ROOT_PROOF_FRAMEWORK_PLAN_SCHEMA_VERSION,
  );
  assert.equal(result.artifactSchemaVersion, "ohmyhost.artifact/v3");
  assert.deepEqual(result.probes.staticStatuses, { alpha: 200, beta: 200 });
  assert.deepEqual(result.probes.staticRscStatuses, { alpha: 200, beta: 200 });
  assert.equal(result.probes.unknownStaticStatus, 404);
  assert.equal(result.probes.privateCacheStatus, 404);
  assert.equal(result.probes.serializedTheme, "dark");
});

test("probes generated pages and serialized theme code while denying the private cache", async () => {
  let failure;
  let nonce = 0;
  const privateCachePath = "/cdn-cgi/_next_cache/proof-build/proof-static/alpha.cache";
  const server = createHttpServer((request, response) => {
    response.setHeader("x-ohmyhost-runtime", "edge-v1");
    const path = request.url;
    if (path === "/") {
      response.end(`<main data-request-nonce="${++nonce}"></main>`);
    } else if (path === "/api/status") {
      response.end(JSON.stringify({ requestNonce: String(++nonce) }));
    } else if (path === "/api/runtime-file") {
      response.end(JSON.stringify({ message: "traced runtime content" }));
    } else if (path === "/fixture.txt") {
      response.end("fixture");
    } else if (path === "/proof-static/alpha" || path === "/proof-static/beta") {
      const rsc = request.headers.rsc === "1";
      if (rsc) response.setHeader("content-type", "text/x-component");
      response.statusCode =
        failure === "known-static" || (rsc && failure === "known-rsc") ? 404 : 200;
      response.end(`<main data-proof-static-slug="${path.split("/").at(-1)}"></main>`);
    } else if (path === "/proof-theme") {
      const helper =
        failure === "serialized-helper" ? '__name(normalizeTheme, "normalizeTheme");' : "";
      response.end(
        `<script id="proof-theme-script">(function applyTheme(theme) { function normalizeTheme(value) { return value.toLowerCase(); } ${helper} document.documentElement.setAttribute("data-proof-theme", normalizeTheme(theme)); })("DARK");</script>`,
      );
    } else {
      response.statusCode =
        (path === privateCachePath && failure === "private-cache") ||
        (path === "/proof-static/unknown" && failure === "unknown-static")
          ? 200
          : 404;
      response.end("not found");
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  try {
    const options = { port, artifact: { privateCachePaths: [privateCachePath] } };
    const probes = await proof.probeProofWorkerd(options);
    assert.deepEqual(probes.staticStatuses, { alpha: 200, beta: 200 });
    assert.deepEqual(probes.staticRscStatuses, { alpha: 200, beta: 200 });
    assert.equal(probes.unknownStaticStatus, 404);
    assert.equal(probes.privateCacheStatus, 404);
    assert.equal(probes.themeScriptStatus, 200);
    assert.equal(probes.serializedTheme, "dark");
    for (failure of [
      "known-static",
      "known-rsc",
      "unknown-static",
      "private-cache",
      "serialized-helper",
    ]) {
      await assert.rejects(
        proof.probeProofWorkerd(options),
        failure === "serialized-helper" ? /__name is not defined/u : /200|404/u,
      );
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

for (const phase of APPLICATION_ROOT_PROOF_PHASES) {
  test(`cleans the proof workspace when ${phase} fails`, async () => {
    const harness = createHarness();
    const failure = new Error(`injected-${phase}`);
    await assert.rejects(
      runApplicationRootProof({
        dependencies: harness.dependencies,
        port: 8792,
        afterPhase(completed) {
          if (completed === phase) throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.deepEqual(
      harness.calls.filter(([name]) => name === "cleanup" || name === "assertClean"),
      [
        ["cleanup", harness.workspace],
        ["assertClean", harness.workspace],
      ],
    );
  });
}

test("stops workerd when a post-start assertion fails", async () => {
  const harness = createHarness();
  await assert.rejects(
    runApplicationRootProof({
      dependencies: harness.dependencies,
      port: 8792,
      afterPhase(phase) {
        if (phase === "workerd") throw new Error("injected-workerd");
      },
    }),
    /injected-workerd/u,
  );
  assert.equal(harness.calls.filter(([name]) => name === "stop").length, 1);
});

test("propagates a probe assertion without replacing it during cleanup", async () => {
  const harness = createHarness();
  const assertion = new Error("nonce assertion failed");
  harness.dependencies.probe = async () => {
    throw assertion;
  };
  await assert.rejects(
    runApplicationRootProof({
      dependencies: harness.dependencies,
      port: 8792,
    }),
    (error) => error === assertion,
  );
});

test("stops a proof process gracefully when it exits after SIGTERM", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    calls.push(signal);
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  await stopProofProcess(child, { gracefulTimeoutMs: 10, forcedTimeoutMs: 10 });
  assert.deepEqual(calls, ["SIGTERM"]);
});

test("forces a proof process that ignores SIGTERM", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    calls.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  await stopProofProcess(child, { gracefulTimeoutMs: 1, forcedTimeoutMs: 10 });
  assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
});

test("terminates a real POSIX process group and closes its descendant port", async () => {
  const port = await reservePort();
  const child = await startProcessGroupServer(port);
  await stopProofProcess(child, { gracefulTimeoutMs: 500, forcedTimeoutMs: 500 });
  await assertProofRuntimeStopped(child, port, 1_000);
  assert.equal(await portIsOpen(port), false);
});

test("force-terminates a real process group after an injected workerd failure", async () => {
  const port = await reservePort();
  const child = await startProcessGroupServer(port, true);
  const harness = createHarness();
  harness.dependencies.startWorkerd = async () => child;
  harness.dependencies.waitUntilReady = async () => undefined;
  harness.dependencies.stop = async (process, options) => {
    await stopProofProcess(process, { gracefulTimeoutMs: 20, forcedTimeoutMs: 500 });
    await assertProofRuntimeStopped(process, options.port, 1_000);
  };
  await assert.rejects(
    runApplicationRootProof({
      dependencies: harness.dependencies,
      port,
      afterPhase(phase) {
        if (phase === "workerd") throw new Error("injected-real-workerd");
      },
    }),
    /injected-real-workerd/u,
  );
  assert.equal(await portIsOpen(port), false);
});
