/* global fetch */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";
import { setImmediate } from "node:timers";
import { URL, fileURLToPath } from "node:url";

import {
  BUILD_ENVIRONMENT_NAMES,
  createBuildAgent,
  executeCommand,
  runBuildPhases,
  startBuildAgent,
} from "../agent.mjs";

const TOKEN = "sandbox-agent-token-0123456789abcdef";
const OPERATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SOURCE = Buffer.from("source archive bytes");
const RUNTIME_PATH = fileURLToPath(new URL("../build-runtime.mjs", import.meta.url));
const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ohmyhost-build-agent-"));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function buildEnvironment(overrides = {}) {
  return {
    BUILD_ID: `ohmyho-sandbox-build:${OPERATION_ID}`,
    BUILD_INPUT_FINGERPRINT: `sha256:${"b".repeat(64)}`,
    EXPECTED_SOURCE_SHA256: createHash("sha256").update(SOURCE).digest("hex"),
    BUILD_PLAN_SHA256: "a".repeat(64),
    APPLICATION_ROOT: "apps/site",
    INSTALL_COMMAND: "pnpm install --frozen-lockfile --ignore-scripts",
    BUILD_COMMAND: "pnpm run build",
    BUILD_OUTPUT_DIRECTORY: "dist",
    FRAMEWORK_ADAPTER: "vite-static",
    FRAMEWORK_RUNTIME: "static",
    SOURCE_COMMIT_SHA: "c".repeat(40),
    OPERATION_ID,
    PROJECT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
    ENVIRONMENT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
    DEPLOYMENT_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    RUNTIME_POLICY_JSON: '{"healthCheckPath":"/","egressAllowedOrigins":[]}',
    DATABASE_REQUIREMENT_JSON: '{"enabled":false}',
    AUTH_REQUIREMENT_JSON: '{"provider":"none"}',
    STORAGE_REQUIREMENT_JSON: '{"enabled":false}',
    FUNCTIONS_REQUIREMENT_JSON: "",
    ...overrides,
  };
}

/** Serves one agent on an ephemeral local port; `runPhases` is the deterministic test adapter. */
async function serveAgent(runPhases = () => new Promise(() => {})) {
  const workRoot = temporaryDirectory();
  const invocations = [];
  const agent = createBuildAgent({
    token: TOKEN,
    workRoot,
    now: () => new Date("2026-09-17T12:00:00.000Z"),
    runPhases: (input) => {
      invocations.push(input);
      return runPhases(input);
    },
  });
  const server = http.createServer(agent.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, body, headers = { authorization: `Bearer ${TOKEN}` }) =>
    fetch(`${origin}${route}`, { method, headers, body });
  const start = (environment) => call("POST", "/start", JSON.stringify({ environment }));
  const status = async () => (await call("GET", "/status")).json();
  const settled = async () => {
    for (;;) {
      const current = await status();
      if (current.state !== "running") return current;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { workRoot, invocations, origin, call, start, status, settled };
}

function rawRequest(origin, { method, route, headers, chunks }) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${route}`, { method, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    if (headers["content-length"] === undefined) request.end();
  });
}

test("answers every unauthenticated request with the same 401 and changes nothing", async () => {
  const agent = await serveAgent();
  const responses = [];
  for (const headers of [
    {},
    { authorization: TOKEN },
    { authorization: `Basic ${TOKEN}` },
    { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
    { authorization: `Bearer ${TOKEN}x` },
    { authorization: `Bearer ${"x".repeat(TOKEN.length)}` },
    { authorization: `bearer ${TOKEN}` },
    { authorization: "Bearer " },
  ]) {
    for (const [method, route, body] of [
      ["PUT", "/source", SOURCE],
      ["POST", "/start", JSON.stringify({ environment: buildEnvironment() })],
      ["GET", "/status"],
      ["GET", "/bundle"],
      ["GET", "/log"],
      ["GET", "/unknown"],
    ]) {
      const response = await agent.call(method, route, body, headers);
      responses.push(
        JSON.stringify([
          response.status,
          response.headers.get("www-authenticate"),
          response.headers.get("content-type"),
          await response.text(),
        ]),
      );
    }
  }
  assert.deepEqual([...new Set(responses)], [JSON.stringify([401, "Bearer", null, ""])]);
  assert.deepEqual(fs.readdirSync(agent.workRoot), []);
  assert.deepEqual(await agent.status(), {
    state: "idle",
    startedAt: null,
    completedAt: null,
    failure: null,
  });
  assert.equal((await agent.call("GET", "/unknown")).status, 404);
  assert.equal((await agent.call("POST", "/status")).status, 404);
});

test("bounds the source archive and the start document", async () => {
  const agent = await serveAgent();
  const authorization = `Bearer ${TOKEN}`;
  assert.equal(
    await rawRequest(agent.origin, {
      method: "PUT",
      route: "/source",
      headers: { authorization, "content-length": "25000001" },
      chunks: [Buffer.from("declared larger than the platform's source archive limit")],
    }),
    413,
  );
  assert.equal(
    await rawRequest(agent.origin, {
      method: "PUT",
      route: "/source",
      headers: { authorization },
      chunks: [Buffer.alloc(25_000_001, 1)],
    }),
    413,
  );
  assert.equal((await agent.call("PUT", "/source", Buffer.alloc(0))).status, 400);
  assert.deepEqual(fs.readdirSync(agent.workRoot), []);
  const refused = await agent.start(buildEnvironment());
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "source is missing" });

  assert.equal((await agent.call("PUT", "/source", Buffer.alloc(25_000_000, 1))).status, 204);
  assert.equal(fs.statSync(path.join(agent.workRoot, "source.tar.gz")).size, 25_000_000);
  assert.equal((await agent.call("PUT", "/source", SOURCE)).status, 204);
  assert.deepEqual(fs.readFileSync(path.join(agent.workRoot, "source.tar.gz")), SOURCE);
  assert.deepEqual(fs.readdirSync(agent.workRoot), ["source.tar.gz"]);

  const oversized = JSON.stringify({
    environment: buildEnvironment({ RUNTIME_POLICY_JSON: "x".repeat(64 * 1024) }),
  });
  assert.equal((await agent.call("POST", "/start", oversized)).status, 413);
  assert.equal(
    await rawRequest(agent.origin, {
      method: "POST",
      route: "/start",
      headers: { authorization, "content-length": "65537" },
      chunks: [Buffer.from("{")],
    }),
    413,
  );
  assert.equal(
    await rawRequest(agent.origin, {
      method: "POST",
      route: "/start",
      headers: { authorization },
      chunks: [Buffer.from(oversized)],
    }),
    413,
  );
  assert.equal((await agent.status()).state, "idle");
  assert.equal(agent.invocations.length, 0);
});

test("answers a request it cannot serve with 500 and stays usable", async () => {
  const agent = await serveAgent();
  fs.rmSync(agent.workRoot, { recursive: true });
  const response = await agent.call("PUT", "/source", SOURCE);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "request failed" });
  fs.mkdirSync(agent.workRoot);
  assert.equal((await agent.call("PUT", "/source", SOURCE)).status, 204);
});

test("accepts only the allowlisted, complete build environment", async () => {
  assert.deepEqual([...BUILD_ENVIRONMENT_NAMES].sort(), [
    "APPLICATION_ROOT",
    "AUTH_REQUIREMENT_JSON",
    "BUILD_COMMAND",
    "BUILD_ID",
    "BUILD_INPUT_FINGERPRINT",
    "BUILD_OUTPUT_DIRECTORY",
    "BUILD_PLAN_SHA256",
    "COMPATIBILITY_DATE",
    "COMPATIBILITY_FLAGS",
    "DATABASE_REQUIREMENT_JSON",
    "DEPLOYMENT_ID",
    "ENVIRONMENT_ID",
    "EXPECTED_SOURCE_SHA256",
    "FRAMEWORK_ADAPTER",
    "FRAMEWORK_RUNTIME",
    "FUNCTIONS_REQUIREMENT_JSON",
    "INSTALL_COMMAND",
    "MAIL_REQUIREMENT_JSON",
    "NEXT_REVALIDATE_PATH",
    "OPERATION_ID",
    "PROJECT_ID",
    "RUNTIME_POLICY_JSON",
    "SERVER_CONFIG_PATH",
    "SERVER_ENTRYPOINT",
    "SERVER_OUTPUT_DIRECTORY",
    "SOURCE_COMMIT_SHA",
    "SSG_CACHE_MAX_BYTES",
    "STORAGE_REQUIREMENT_JSON",
  ]);
  const agent = await serveAgent();
  assert.equal((await agent.call("PUT", "/source", SOURCE)).status, 204);
  const withoutOperation = Object.fromEntries(
    Object.entries(buildEnvironment()).filter(([name]) => name !== "OPERATION_ID"),
  );
  for (const body of [
    "",
    "{",
    "null",
    "[]",
    JSON.stringify({}),
    JSON.stringify({ environment: null }),
    JSON.stringify({ environment: [] }),
    JSON.stringify({ environment: buildEnvironment(), token: TOKEN }),
    JSON.stringify({ environment: buildEnvironment({ SOURCE_GET_URL: "https://s3.invalid/a" }) }),
    JSON.stringify({ environment: buildEnvironment({ OUTPUT_PUT_URL: "https://s3.invalid/a" }) }),
    JSON.stringify({ environment: buildEnvironment({ BUILD_AGENT_TOKEN: TOKEN }) }),
    JSON.stringify({ environment: buildEnvironment({ PATH: "/customer/bin" }) }),
    JSON.stringify({ environment: buildEnvironment({ NODE_OPTIONS: "--require=/tmp/x.js" }) }),
    JSON.stringify({ environment: buildEnvironment({ CODEBUILD_BUILD_ID: "project:build" }) }),
    JSON.stringify({ environment: buildEnvironment({ COMPATIBILITY_DATE: 20260821 }) }),
    JSON.stringify({ environment: buildEnvironment({ COMPATIBILITY_DATE: "2026 " }) }),
    JSON.stringify({ environment: withoutOperation }),
    JSON.stringify({ environment: buildEnvironment({ OPERATION_ID: "not-a-ulid" }) }),
    JSON.stringify({ environment: buildEnvironment({ PROJECT_ID: "" }) }),
    JSON.stringify({ environment: buildEnvironment({ EXPECTED_SOURCE_SHA256: "A".repeat(64) }) }),
    JSON.stringify({ environment: buildEnvironment({ APPLICATION_ROOT: "../escape" }) }),
    JSON.stringify({ environment: buildEnvironment({ BUILD_COMMAND: "" }) }),
    JSON.stringify({ environment: buildEnvironment({ BUILD_OUTPUT_DIRECTORY: "" }) }),
    JSON.stringify({ environment: buildEnvironment({ FRAMEWORK_RUNTIME: "functions" }) }),
    JSON.stringify({ environment: buildEnvironment({ SSG_CACHE_MAX_BYTES: "33554432" }) }),
    JSON.stringify({ environment: buildEnvironment({ NEXT_REVALIDATE_PATH: "1" }) }),
    ...["", "true", "0"].map((value) =>
      JSON.stringify({
        environment: buildEnvironment({ FRAMEWORK_ADAPTER: "nextjs", NEXT_REVALIDATE_PATH: value }),
      }),
    ),
    ...["0", "01048576", "67108865", "68157440", "1048577", "not-a-limit"].map((value) =>
      JSON.stringify({
        environment: buildEnvironment({ FRAMEWORK_ADAPTER: "nextjs", SSG_CACHE_MAX_BYTES: value }),
      }),
    ),
    JSON.stringify({
      environment: buildEnvironment({
        FRAMEWORK_ADAPTER: "functions",
        FRAMEWORK_RUNTIME: "functions",
        BUILD_COMMAND: "",
      }),
    }),
  ]) {
    const response = await agent.call("POST", "/start", body);
    assert.equal(response.status, 400, body);
    assert.deepEqual(await response.json(), { error: "start request is invalid" });
  }
  assert.equal((await agent.status()).state, "idle");
  assert.equal(agent.invocations.length, 0);

  const nextAgent = await serveAgent();
  assert.equal((await nextAgent.call("PUT", "/source", SOURCE)).status, 204);
  const nextRuntime = buildEnvironment({
    FRAMEWORK_ADAPTER: "nextjs",
    FRAMEWORK_RUNTIME: "edge",
    NEXT_REVALIDATE_PATH: "1",
  });
  assert.equal((await nextAgent.start(nextRuntime)).status, 202);
  assert.deepEqual(nextAgent.invocations[0].environment, nextRuntime);

  const functionsRuntime = buildEnvironment({
    FRAMEWORK_ADAPTER: "functions",
    FRAMEWORK_RUNTIME: "functions",
    BUILD_COMMAND: "",
    BUILD_OUTPUT_DIRECTORY: "",
  });
  assert.equal((await agent.start(functionsRuntime)).status, 202);
  assert.deepEqual(agent.invocations[0].environment, functionsRuntime);
});

test("repeats an identical start and refuses a different one", async () => {
  const agent = await serveAgent();
  assert.equal((await agent.call("PUT", "/source", SOURCE)).status, 204);
  const environment = buildEnvironment();
  const accepted = await agent.start(environment);
  assert.equal(accepted.status, 202);
  assert.equal(await accepted.text(), "");

  const reordered = Object.fromEntries(Object.entries(environment).reverse());
  assert.equal((await agent.start(reordered)).status, 202);
  const conflicting = await agent.start(buildEnvironment({ BUILD_PLAN_SHA256: "d".repeat(64) }));
  assert.equal(conflicting.status, 409);
  assert.deepEqual(await conflicting.json(), { error: "a different build was already started" });
  const replaced = await agent.call("PUT", "/source", Buffer.from("another archive"));
  assert.equal(replaced.status, 409);
  assert.deepEqual(fs.readFileSync(path.join(agent.workRoot, "source.tar.gz")), SOURCE);

  assert.equal(agent.invocations.length, 1);
  assert.deepEqual(agent.invocations[0], { environment, workRoot: agent.workRoot });
  assert.equal((await agent.status()).state, "running");
});

test("serves the bundle only after the phases succeeded", async () => {
  const bundle = Buffer.from("bundle archive bytes");
  let finish;
  const agent = await serveAgent(
    ({ workRoot }) =>
      new Promise((resolve) => {
        finish = () => {
          fs.writeFileSync(path.join(workRoot, "user-build.log"), "vite build\nbuilt in 2s\n");
          fs.writeFileSync(path.join(workRoot, "bundle.tar.gz"), bundle);
          resolve();
        };
      }),
  );
  const unavailable = await agent.call("GET", "/bundle");
  assert.equal(unavailable.status, 409);
  assert.deepEqual(await unavailable.json(), { error: "bundle is not available" });
  const withoutLog = await agent.call("GET", "/log");
  assert.equal(withoutLog.status, 404);
  assert.deepEqual(await withoutLog.json(), { error: "log is not available" });

  assert.equal((await agent.call("PUT", "/source", SOURCE)).status, 204);
  assert.equal((await agent.start(buildEnvironment())).status, 202);
  assert.deepEqual(await agent.status(), {
    state: "running",
    startedAt: "2026-09-17T12:00:00.000Z",
    completedAt: null,
    failure: null,
  });
  assert.equal((await agent.call("GET", "/bundle")).status, 409);

  finish();
  assert.deepEqual(await agent.settled(), {
    state: "succeeded",
    startedAt: "2026-09-17T12:00:00.000Z",
    completedAt: "2026-09-17T12:00:00.000Z",
    failure: null,
  });
  const served = await agent.call("GET", "/bundle");
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "application/gzip");
  assert.equal(served.headers.get("content-length"), String(bundle.byteLength));
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), bundle);
  const log = await agent.call("GET", "/log");
  assert.equal(log.status, 200);
  assert.equal(log.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await log.text(), "vite build\nbuilt in 2s\n");
  assert.equal((await agent.start(buildEnvironment())).status, 202);
  assert.equal(agent.invocations.length, 1);
});

test("reports a failed build with the excerpt of the customer's own output", async () => {
  const captured = "[31mfailed[0m\r\nsrc/main.ts(1,1): error TS2304\n";
  const agent = await serveAgent(async ({ workRoot }) => {
    fs.writeFileSync(path.join(workRoot, "user-build.log"), captured);
    fs.writeFileSync(path.join(workRoot, "bundle.tar.gz"), "partial");
    throw new Error("build command failed: setpriv");
  });
  assert.equal((await agent.call("PUT", "/source", SOURCE)).status, 204);
  assert.equal((await agent.start(buildEnvironment())).status, 202);
  assert.deepEqual(await agent.settled(), {
    state: "failed",
    startedAt: "2026-09-17T12:00:00.000Z",
    completedAt: "2026-09-17T12:00:00.000Z",
    failure: {
      schemaVersion: "ohmyhost.build-failure/v1",
      operationId: OPERATION_ID,
      excerpt: "failed\nsrc/main.ts(1,1): error TS2304",
      truncated: false,
      logBytes: Buffer.byteLength(captured),
    },
  });
  assert.equal((await agent.call("GET", "/bundle")).status, 409);
  assert.equal(await (await agent.call("GET", "/log")).text(), captured);
  assert.equal((await agent.start(buildEnvironment())).status, 202);
  assert.equal(
    (await agent.start(buildEnvironment({ BUILD_PLAN_SHA256: "d".repeat(64) }))).status,
    409,
  );
});

test("fails a build whose phases left no bounded bundle or no customer output", async () => {
  const missing = await serveAgent(async () => {});
  assert.equal((await missing.call("PUT", "/source", SOURCE)).status, 204);
  assert.equal((await missing.start(buildEnvironment())).status, 202);
  assert.deepEqual(await missing.settled(), {
    state: "failed",
    startedAt: "2026-09-17T12:00:00.000Z",
    completedAt: "2026-09-17T12:00:00.000Z",
    failure: null,
  });

  const oversized = await serveAgent(async ({ workRoot }) => {
    fs.writeFileSync(path.join(workRoot, "user-build.log"), "[0m\n");
    fs.writeFileSync(path.join(workRoot, "bundle.tar.gz"), "");
    fs.truncateSync(path.join(workRoot, "bundle.tar.gz"), 30 * 1024 * 1024 + 1);
  });
  assert.equal((await oversized.call("PUT", "/source", SOURCE)).status, 204);
  assert.equal((await oversized.start(buildEnvironment())).status, 202);
  const settled = await oversized.settled();
  assert.equal(settled.state, "failed");
  assert.equal(settled.failure, null);
  assert.equal((await oversized.call("GET", "/bundle")).status, 409);

  const bounded = await serveAgent(async ({ workRoot }) => {
    fs.writeFileSync(path.join(workRoot, "bundle.tar.gz"), "");
    fs.truncateSync(path.join(workRoot, "bundle.tar.gz"), 30 * 1024 * 1024);
  });
  assert.equal((await bounded.call("PUT", "/source", SOURCE)).status, 204);
  assert.equal((await bounded.start(buildEnvironment())).status, 202);
  assert.equal((await bounded.settled()).state, "succeeded");
});

test("serves only the newest five MiB of the customer build log", async () => {
  const agent = await serveAgent();
  const newest = `${"é".repeat(2)}${"x".repeat(5 * 1024 * 1024 - 3)}`;
  fs.writeFileSync(path.join(agent.workRoot, "user-build.log"), `older output\né${newest}`);
  const response = await agent.call("GET", "/log");
  assert.equal(response.status, 200);
  const body = Buffer.from(await response.arrayBuffer());
  // The cut fell inside the first "é" of the window; its orphaned continuation byte is dropped.
  assert.equal(body.byteLength, 5 * 1024 * 1024 - 1);
  assert.equal(body.toString("utf8"), newest.slice(1));
});

function recordingExecutor(workRoot, { failing = [] } = {}) {
  const commands = [];
  const applicationRoot = path.join(workRoot, "source", "aixyte-site-0123456", "apps", "site");
  const execute = async (command) => {
    commands.push(command);
    const subcommand = command.file === "node" ? command.args[1] : command.file;
    if (subcommand === "tar") fs.mkdirSync(applicationRoot, { recursive: true });
    if (subcommand === "resolve-root") fs.writeFileSync(command.stdoutPath, applicationRoot);
    if (subcommand === "archive") fs.writeFileSync(command.args[3], "bundle");
    // pgrep exits 1 when no process of the customer's user remains.
    if (subcommand === "pgrep") return 1;
    return failing.includes(path.basename(subcommand)) ? 1 : 0;
  };
  return { commands, execute };
}

test("runs the build phases in the order of the retired buildspec without any platform secret", async () => {
  const workRoot = fs.realpathSync(temporaryDirectory());
  fs.writeFileSync(path.join(workRoot, "source.tar.gz"), SOURCE);
  process.env.BUILD_AGENT_TOKEN = TOKEN;
  cleanups.push(() => delete process.env.BUILD_AGENT_TOKEN);
  const environment = buildEnvironment({ COMPATIBILITY_DATE: "2026-08-21" });
  const recorder = recordingExecutor(workRoot);
  await runBuildPhases({
    environment,
    workRoot,
    toolPath: "/usr/local/bin:/usr/bin:/bin",
    execute: recorder.execute,
  });

  const applicationRoot = path.join(workRoot, "source", "aixyte-site-0123456", "apps", "site");
  const rootEnvironment = { PATH: "/usr/local/bin:/usr/bin:/bin", ...environment };
  const runtime = (args, extra = {}) => ({
    file: "node",
    args: [RUNTIME_PATH, ...args],
    cwd: workRoot,
    env: rootEnvironment,
    ...extra,
  });
  assert.deepEqual(recorder.commands, [
    runtime(["write-user-build-script", path.join(workRoot, "user-build.sh")]),
    runtime(["write-root-package-script", path.join(workRoot, "root-package.sh")]),
    runtime(["validate-archive", path.join(workRoot, "source.tar.gz")]),
    {
      file: "tar",
      args: [
        "-xzf",
        path.join(workRoot, "source.tar.gz"),
        "-C",
        path.join(workRoot, "source"),
        "--no-same-owner",
        "--no-same-permissions",
      ],
      cwd: workRoot,
      env: rootEnvironment,
    },
    runtime(["resolve-root", path.join(workRoot, "source", "aixyte-site-0123456"), "apps/site"], {
      stdoutPath: path.join(workRoot, "application-root"),
    }),
    runtime(["snapshot-migrations", path.join(workRoot, "migration-snapshot")], {
      cwd: applicationRoot,
    }),
    runtime(
      ["write-package-manager", applicationRoot, path.join(workRoot, "package-manager.json")],
      { stdoutPath: path.join(workRoot, "package-manager.log"), mergeStderr: true },
    ),
    {
      file: "chown",
      args: ["-R", "10001:10001", path.join(workRoot, "source")],
      cwd: workRoot,
      env: rootEnvironment,
    },
    {
      file: "setpriv",
      args: [
        "--no-new-privs",
        "--reuid=10001",
        "--regid=10001",
        "--clear-groups",
        "env",
        "-i",
        "HOME=/home/ohmyho-build",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "CI=true",
        "NEXT_TELEMETRY_DISABLED=1",
        "INSTALL_COMMAND=pnpm install --frozen-lockfile --ignore-scripts",
        "BUILD_COMMAND=pnpm run build",
        "FRAMEWORK_ADAPTER=vite-static",
        "FRAMEWORK_RUNTIME=static",
        "BUILD_OUTPUT_DIRECTORY=dist",
        "SERVER_OUTPUT_DIRECTORY=",
        "SERVER_ENTRYPOINT=",
        "SERVER_CONFIG_PATH=",
        "COMPATIBILITY_DATE=2026-08-21",
        "COMPATIBILITY_FLAGS=",
        "FUNCTIONS_REQUIREMENT_JSON=",
        path.join(workRoot, "user-build.sh"),
        applicationRoot,
      ],
      cwd: workRoot,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdoutPath: path.join(workRoot, "user-build.log"),
      mergeStderr: true,
    },
    { file: "pkill", args: ["-9", "-u", "10001"], cwd: workRoot, env: rootEnvironment },
    {
      file: "pgrep",
      args: ["-u", "10001", "-r", "D,R,S,T,t,W,X,I"],
      cwd: workRoot,
      env: rootEnvironment,
    },
    {
      file: "chown",
      args: ["-R", "root:root", path.join(workRoot, "source")],
      cwd: workRoot,
      env: rootEnvironment,
    },
    {
      file: "chmod",
      args: ["-R", "go-w", path.join(workRoot, "source")],
      cwd: workRoot,
      env: rootEnvironment,
    },
    {
      file: path.join(workRoot, "root-package.sh"),
      args: [],
      cwd: workRoot,
      env: rootEnvironment,
      stdoutPath: path.join(workRoot, "root-package.log"),
      mergeStderr: true,
    },
    runtime(["cleanup-tanstack-platform-config", applicationRoot]),
    runtime(["cleanup-next-platform-config", applicationRoot]),
    runtime(["archive", path.join(workRoot, "bundle"), path.join(workRoot, "bundle.tar.gz")], {
      stdoutPath: path.join(workRoot, "archive.log"),
      mergeStderr: true,
    }),
  ]);
  assert.doesNotMatch(JSON.stringify(recorder.commands), new RegExp(TOKEN, "u"));
  assert.doesNotMatch(JSON.stringify(recorder.commands), /BUILD_AGENT_TOKEN|_URL/u);
  for (const directory of ["source", "bundle/assets", "bundle/worker"]) {
    assert.equal(fs.statSync(path.join(workRoot, directory)).isDirectory(), true);
  }
});

test("stops at the first failed phase and always ends the customer's processes", async () => {
  const phases = async (failing, prepare = () => {}) => {
    const workRoot = fs.realpathSync(temporaryDirectory());
    fs.writeFileSync(path.join(workRoot, "source.tar.gz"), SOURCE);
    prepare(workRoot);
    const recorder = recordingExecutor(workRoot, { failing });
    const outcome = await runBuildPhases({
      environment: buildEnvironment(),
      workRoot,
      toolPath: "/usr/bin",
      execute: recorder.execute,
    }).then(
      () => "succeeded",
      (error) => error.message,
    );
    return [
      outcome,
      recorder.commands.map(({ file, args }) => (file === "node" ? args[1] : path.basename(file))),
    ];
  };

  assert.deepEqual(
    await phases([], (workRoot) => fs.writeFileSync(path.join(workRoot, "source.tar.gz"), "other")),
    ["source archive digest does not match", []],
  );
  assert.deepEqual(await phases(["validate-archive"]), [
    "build command failed: validate-archive",
    ["write-user-build-script", "write-root-package-script", "validate-archive"],
  ]);
  const beforeBuild = [
    "write-user-build-script",
    "write-root-package-script",
    "validate-archive",
    "tar",
    "resolve-root",
    "snapshot-migrations",
    "write-package-manager",
    "chown",
  ];
  const cleanup = ["cleanup-tanstack-platform-config", "cleanup-next-platform-config"];
  assert.deepEqual(await phases(["write-package-manager"]), [
    "build command failed: write-package-manager",
    beforeBuild.slice(0, -1),
  ]);
  assert.deepEqual(await phases(["setpriv"]), [
    "build command failed: setpriv",
    [...beforeBuild, "setpriv", "pkill", "pgrep", ...cleanup],
  ]);
  assert.deepEqual(await phases(["root-package.sh"]), [
    "build command failed: root-package.sh",
    [...beforeBuild, "setpriv", "pkill", "pgrep", "chown", "chmod", "root-package.sh", ...cleanup],
  ]);
  // Deliberate rewrite: a failed pkill is tolerated only because it exits 1 when nothing matched;
  // pgrep then confirms that no customer process remains, so the build proceeds.
  assert.deepEqual(await phases(["pkill", ...cleanup]), [
    "succeeded",
    [
      ...beforeBuild,
      "setpriv",
      "pkill",
      "pgrep",
      "chown",
      "chmod",
      "root-package.sh",
      ...cleanup,
      "archive",
    ],
  ]);

  const workRoot = fs.realpathSync(temporaryDirectory());
  fs.writeFileSync(path.join(workRoot, "source.tar.gz"), SOURCE);
  const recorder = recordingExecutor(workRoot);
  await assert.rejects(
    runBuildPhases({
      environment: buildEnvironment(),
      workRoot,
      toolPath: "/usr/bin",
      execute: async (command) => {
        const exitCode = await recorder.execute(command);
        if (command.file === "tar") fs.writeFileSync(path.join(workRoot, "source", "stray"), "");
        return exitCode;
      },
    }),
    /source archive must contain exactly one root directory/u,
  );
});

test("fails closed while customer processes survive, and chowns the tree to root once none remain", async () => {
  // pgrep exits 0 while a process of the customer's user is still found, 1 once none is left.
  const sweep = async (survivingRounds) => {
    const workRoot = fs.realpathSync(temporaryDirectory());
    fs.writeFileSync(path.join(workRoot, "source.tar.gz"), SOURCE);
    const recorder = recordingExecutor(workRoot);
    const outcome = await runBuildPhases({
      environment: buildEnvironment(),
      workRoot,
      toolPath: "/usr/bin",
      execute: async (command) => {
        const exitCode = await recorder.execute(command);
        if (command.file !== "pgrep") return exitCode;
        const rounds = recorder.commands.filter(({ file }) => file === "pgrep").length;
        return rounds <= survivingRounds ? 0 : 1;
      },
    }).then(
      () => "succeeded",
      (error) => error.message,
    );
    const names = recorder.commands.map(({ file, args }) =>
      file === "node" ? args[1] : path.basename(file),
    );
    return { outcome, names: names.slice(names.indexOf("setpriv")), recorder, workRoot };
  };

  const survivors = await sweep(Infinity);
  assert.equal(survivors.outcome, "customer processes did not end");
  assert.deepEqual(survivors.names, [
    "setpriv",
    ...Array.from({ length: 10 }, () => ["pkill", "pgrep"]).flat(),
    "cleanup-tanstack-platform-config",
    "cleanup-next-platform-config",
  ]);

  // The customer reads why a green build ended failed.
  assert.match(
    fs.readFileSync(path.join(survivors.workRoot, "user-build.log"), "utf8"),
    /^ohmyho\.st platform: a process started by the application build was still running/mu,
  );

  const cleared = await sweep(1);
  assert.equal(cleared.outcome, "succeeded");
  assert.deepEqual(cleared.names, [
    "setpriv",
    "pkill",
    "pgrep",
    "pkill",
    "pgrep",
    "chown",
    "chmod",
    "root-package.sh",
    "cleanup-tanstack-platform-config",
    "cleanup-next-platform-config",
    "archive",
  ]);
  // A killed orphan stays a zombie under PID 1: the survivor check must not count that state.
  const states = cleared.recorder.commands.find(({ file }) => file === "pgrep").args.at(-1);
  assert.equal(states.split(",").includes("Z"), false);
  const setpriv = cleared.recorder.commands.find(({ file }) => file === "setpriv");
  assert.equal(setpriv.args[0], "--no-new-privs");
  const chown = cleared.recorder.commands.filter(({ file }) => file === "chown").at(-1);
  assert.deepEqual(chown.args.slice(0, 2), ["-R", "root:root"]);
});

test("ends the failure excerpt with root's packaging line and never with its raw output", async () => {
  const packagingLine =
    "ohmyho.st packaging: /videos/hero.mp4 is 14680064 bytes; each static file may be at most 10485760 bytes (25 MiB and 1,000 files in total)";
  const agent = await serveAgent(({ environment, workRoot }) => {
    const recorder = recordingExecutor(workRoot, { failing: ["root-package.sh"] });
    return runBuildPhases({
      environment,
      workRoot,
      toolPath: "/usr/bin",
      execute: async (command) => {
        const name = path.basename(command.file);
        if (name === "setpriv") fs.writeFileSync(command.stdoutPath, "vite build\nbuilt in 2s");
        if (name === "root-package.sh") {
          fs.writeFileSync(
            command.stdoutPath,
            `${packagingLine}\nfile:///opt/ohmyho/build-runtime.mjs:1990\n    at packageBuildArtifact (/opt/ohmyho/build-runtime.mjs:1990:13)\nohmyho.st packaging:\n`,
          );
        }
        return recorder.execute(command);
      },
    });
  });
  assert.equal((await agent.call("PUT", "/source", SOURCE)).status, 204);
  assert.equal((await agent.start(buildEnvironment())).status, 202);
  const settled = await agent.settled();
  assert.equal(settled.state, "failed");
  assert.equal(settled.failure.excerpt, `vite build\nbuilt in 2s\n${packagingLine}`);
  assert.equal(
    fs.readFileSync(path.join(agent.workRoot, "user-build.log"), "utf8"),
    `vite build\nbuilt in 2s\n${packagingLine}\n`,
  );
});

test("reports plain platform packaging and archive failures without exposing root output", async (context) => {
  const operatorOutput = [];
  context.mock.method(process.stderr, "write", (chunk) => {
    operatorOutput.push(String(chunk));
    return true;
  });
  const privateOutput =
    "Error: internal-root-secret-marker\nfile:///opt/ohmyho/private-runtime.mjs:14\n at rootPackaging\n";
  const customerOutput = "OpenNext build complete.\n--dry-run: exiting now.\n";
  // The root re-check before the install fails without customer output; its fixed line is the
  // whole excerpt instead of no reason at all.
  for (const [phase, line, excerptPrefix] of [
    [
      "write-package-manager",
      "ohmyho.st platform: the build's re-check of the planned package manager and build script failed before any dependency was installed. Report this operation ID through feedback; change source only when diagnostics identify a source error or output limit.",
      "",
    ],
    [
      "root-package.sh",
      "ohmyho.st platform: the application build completed, but validating and packaging its output failed. Report this operation ID through feedback; change source only when diagnostics identify a source error or output limit.",
      customerOutput,
    ],
    [
      "archive",
      "ohmyho.st platform: the application build completed, but creating the deployment archive failed. Report this operation ID through feedback; change source only when diagnostics identify a source error or output limit.",
      customerOutput,
    ],
  ]) {
    const agent = await serveAgent(({ environment, workRoot }) => {
      const recorder = recordingExecutor(workRoot, { failing: [phase] });
      return runBuildPhases({
        environment,
        workRoot,
        toolPath: "/usr/bin",
        execute: async (command) => {
          const name = command.file === "node" ? command.args[1] : path.basename(command.file);
          if (name === "setpriv") fs.writeFileSync(command.stdoutPath, customerOutput.trimEnd());
          if (name === phase) fs.writeFileSync(command.stdoutPath, privateOutput);
          return recorder.execute(command);
        },
      });
    });
    assert.equal((await agent.call("PUT", "/source", SOURCE)).status, 204);
    assert.equal((await agent.start(buildEnvironment())).status, 202);
    const settled = await agent.settled();
    assert.equal(settled.state, "failed");
    assert.equal(settled.failure.excerpt, `${excerptPrefix}${line}`);
    assert.equal(settled.failure.truncated, false);
    const customerLog = await (await agent.call("GET", "/log")).text();
    assert.equal(customerLog, `${settled.failure.excerpt}\n`);
    assert.doesNotMatch(customerLog, /internal-root-secret-marker|private-runtime|rootPackaging/u);
    assert.doesNotMatch(customerLog, /ohmyho\.st packaging:/u);
    assert.equal((await agent.call("GET", "/bundle")).status, 409);
  }
  assert.ok(operatorOutput.some((output) => output.includes(privateOutput)));
});

test("reports the packaging phase even when its root log is missing or unusable", async (context) => {
  context.mock.method(process.stderr, "write", () => true);
  const line =
    "ohmyho.st platform: the application build completed, but validating and packaging its output failed. Report this operation ID through feedback; change source only when diagnostics identify a source error or output limit.";
  for (const rootOutput of [
    null,
    "ohmyho.st packaging: internal-secret\tunsafe\nError: root-only-marker\n",
  ]) {
    const agent = await serveAgent(({ environment, workRoot }) => {
      const recorder = recordingExecutor(workRoot);
      return runBuildPhases({
        environment,
        workRoot,
        toolPath: "/usr/bin",
        execute: async (command) => {
          const name = path.basename(command.file);
          if (name === "setpriv")
            fs.writeFileSync(command.stdoutPath, "application build completed\n");
          if (name === "root-package.sh") {
            if (rootOutput !== null) fs.writeFileSync(command.stdoutPath, rootOutput);
            throw new Error("private-root-execution-failure");
          }
          return recorder.execute(command);
        },
      });
    });
    await agent.call("PUT", "/source", SOURCE);
    await agent.start(buildEnvironment());
    const settled = await agent.settled();
    assert.equal(settled.state, "failed");
    assert.equal(settled.failure.excerpt, `application build completed\n${line}`);
    assert.doesNotMatch(
      await (await agent.call("GET", "/log")).text(),
      /internal-secret|root-only-marker|private-root-execution-failure/u,
    );
  }
});

test("runs a command with exactly the given environment and a root-owned output file", async () => {
  const directory = temporaryDirectory();
  process.env.BUILD_AGENT_TOKEN = TOKEN;
  cleanups.push(() => delete process.env.BUILD_AGENT_TOKEN);
  const stdoutPath = path.join(directory, "user-build.log");
  const script =
    'process.stdout.write(JSON.stringify([process.env.BUILD_AGENT_TOKEN ?? null, process.env.MARKER, process.cwd()]) + "\\n"); process.stderr.write("warning\\n"); process.exitCode = 7;';
  const command = {
    file: process.execPath,
    args: ["-e", script],
    cwd: fs.realpathSync(directory),
    env: { PATH: process.env.PATH, MARKER: "given" },
  };
  assert.equal(await executeCommand({ ...command, stdoutPath, mergeStderr: true }), 7);
  assert.equal(
    fs.readFileSync(stdoutPath, "utf8"),
    `${JSON.stringify([null, "given", fs.realpathSync(directory)])}\nwarning\n`,
  );
  assert.equal(fs.statSync(stdoutPath).mode & 0o777, 0o600);
  await assert.rejects(executeCommand({ ...command, stdoutPath }), /EEXIST/u);

  const separatePath = path.join(directory, "application-root");
  assert.equal(await executeCommand({ ...command, stdoutPath: separatePath }), 7);
  assert.equal(
    fs.readFileSync(separatePath, "utf8"),
    `${JSON.stringify([null, "given", fs.realpathSync(directory)])}\n`,
  );
  assert.equal(await executeCommand({ ...command, args: ["-e", ""] }), 0);
  await assert.rejects(
    executeCommand({ ...command, file: path.join(directory, "missing-tool") }),
    /ENOENT/u,
  );
});

test("starts only with a token and removes it from the environment children inherit", async () => {
  const workRoot = path.join(temporaryDirectory(), "ohmyho");
  for (const environment of [{}, { BUILD_AGENT_TOKEN: "" }, { BUILD_AGENT_TOKEN: "short" }]) {
    assert.throws(
      () => startBuildAgent({ environment, port: 0, workRoot }),
      /BUILD_AGENT_TOKEN is required/u,
    );
  }
  assert.equal(fs.existsSync(workRoot), false);
  const refused = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../agent.mjs", import.meta.url))],
    {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    },
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /BUILD_AGENT_TOKEN is required/u);

  const environment = { BUILD_AGENT_TOKEN: TOKEN, PATH: "/usr/bin:/bin" };
  const server = startBuildAgent({ environment, port: 0, workRoot });
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  assert.deepEqual(environment, { PATH: "/usr/bin:/bin" });
  await new Promise((resolve) => server.once("listening", resolve));
  assert.equal(fs.statSync(workRoot).mode & 0o777, 0o755);
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/status`)).status, 401);
  const status = await fetch(`${origin}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual(await status.json(), {
    state: "idle",
    startedAt: null,
    completedAt: null,
    failure: null,
  });

  // The real phase runner refuses an archive other than the one the start names.
  const headers = { authorization: `Bearer ${TOKEN}` };
  const put = await fetch(`${origin}/source`, { method: "PUT", headers, body: "another archive" });
  assert.equal(put.status, 204);
  const started = await fetch(`${origin}/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({ environment: buildEnvironment() }),
  });
  assert.equal(started.status, 202);
  let settled;
  do {
    settled = await (await fetch(`${origin}/status`, { headers })).json();
  } while (settled.state === "running");
  assert.equal(settled.state, "failed");
  assert.equal(settled.failure, null);
  assert.match(settled.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.ok(settled.completedAt >= settled.startedAt);
  assert.deepEqual(fs.readdirSync(workRoot), ["source.tar.gz"]);
});
