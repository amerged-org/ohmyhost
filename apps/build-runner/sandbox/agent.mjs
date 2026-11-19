import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

import {
  PACKAGING_LINE_PREFIX,
  readBuildFailureExcerpt,
  validateApplicationRoot,
} from "./build-runtime.mjs";

// The platform's source archive limit (SOURCE_ARCHIVE_MAX_BYTES of the source fetcher).
const MAXIMUM_SOURCE_BYTES = 25_000_000;
const MAXIMUM_START_BYTES = 64 * 1024;
const MAXIMUM_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAXIMUM_LOG_BYTES = 5 * 1024 * 1024;
const MAXIMUM_PACKAGING_OUTPUT_BYTES = 64 * 1024;
const MAXIMUM_PACKAGING_LINE_CHARACTERS = 1024;
const PLATFORM_FAILURE_ACTION =
  "Report this operation ID through feedback; change source only when diagnostics identify a source error or output limit.";
const PACKAGING_FAILURE_LINES = Object.freeze({
  recheck: `ohmyho.st platform: the build's re-check of the planned package manager and build script failed before any dependency was installed. ${PLATFORM_FAILURE_ACTION}`,
  package: `ohmyho.st platform: the application build completed, but validating and packaging its output failed. ${PLATFORM_FAILURE_ACTION}`,
  archive: `ohmyho.st platform: the application build completed, but creating the deployment archive failed. ${PLATFORM_FAILURE_ACTION}`,
  sweep:
    "ohmyho.st platform: a process started by the application build was still running after the build ended and could not be stopped, so its output was not packaged. Remove background and detached processes from the build commands, or report this operation ID through feedback if you start none.",
});
const MINIMUM_TOKEN_CHARACTERS = 32;
const BUILD_USER = "10001";
// A process that was killed after its parent ended stays a zombie under this agent (PID 1 reaps none), so the
// survivor check counts only the states in which something can still run.
const LIVE_PROCESS_STATES = "D,R,S,T,t,W,X,I";
const MAXIMUM_SWEEP_ROUNDS = 10;
const SWEEP_ROUND_MILLISECONDS = 100;
const BUILD_USER_HOME = "/home/ohmyho-build";
const RUNTIME_PATH = fileURLToPath(new URL("./build-runtime.mjs", import.meta.url));
const OPERATION_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/** Every name a start request may carry; anything else is refused. */
export const BUILD_ENVIRONMENT_NAMES = Object.freeze([
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
const REQUIRED_ENVIRONMENT_NAMES = Object.freeze([
  "EXPECTED_SOURCE_SHA256",
  "BUILD_PLAN_SHA256",
  "APPLICATION_ROOT",
  "INSTALL_COMMAND",
  "FRAMEWORK_ADAPTER",
  "FRAMEWORK_RUNTIME",
  "SOURCE_COMMIT_SHA",
  "OPERATION_ID",
  "BUILD_ID",
  "PROJECT_ID",
  "ENVIRONMENT_ID",
  "DEPLOYMENT_ID",
]);
// The only start values the customer's process sees; identifiers and digests stay with root.
const USER_BUILD_ENVIRONMENT_NAMES = Object.freeze([
  "INSTALL_COMMAND",
  "BUILD_COMMAND",
  "FRAMEWORK_ADAPTER",
  "FRAMEWORK_RUNTIME",
  "BUILD_OUTPUT_DIRECTORY",
  "SERVER_OUTPUT_DIRECTORY",
  "SERVER_ENTRYPOINT",
  "SERVER_CONFIG_PATH",
  "COMPATIBILITY_DATE",
  "COMPATIBILITY_FLAGS",
  "FUNCTIONS_REQUIREMENT_JSON",
  "NEXT_REVALIDATE_PATH",
  "SSG_CACHE_MAX_BYTES",
]);

/** Runs one command with exactly `env`; resolves to its exit code (128 when a signal ended it). */
export function executeCommand({ file, args, cwd, env, stdoutPath, mergeStderr = false }) {
  return new Promise((resolve, reject) => {
    let output = "inherit";
    try {
      if (stdoutPath !== undefined) output = fs.openSync(stdoutPath, "wx", 0o600);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", output, mergeStderr ? output : "inherit"],
    });
    if (output !== "inherit") fs.closeSync(output);
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 128));
  });
}

async function sha256OfFile(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

/**
 * The phases of one customer build. `execute` starts every process, so the order, arguments and
 * environments are observable without a sandbox; the production executor is `executeCommand`.
 */
export async function runBuildPhases({ environment, workRoot, toolPath, execute }) {
  const at = (...segments) => path.join(workRoot, ...segments);
  const rootEnvironment = { PATH: toolPath, ...environment };
  const run = async (command, { tolerateFailure = false } = {}) => {
    const exitCode = await execute({ cwd: workRoot, env: rootEnvironment, ...command });
    if (exitCode !== 0 && !tolerateFailure) {
      const name = command.file === "node" ? command.args[1] : path.basename(command.file);
      throw new Error(`build command failed: ${name}`);
    }
    return exitCode;
  };
  const runtime = (args, options = {}) => ({
    file: "node",
    args: [RUNTIME_PATH, ...args],
    ...options,
  });
  // Kill-and-check: pgrep exits 1 once no live process of the customer's user remains. Fails closed, and tells
  // the customer why a green build ended failed.
  const endCustomerProcesses = async () => {
    for (let round = 1; round <= MAXIMUM_SWEEP_ROUNDS; round += 1) {
      await run({ file: "pkill", args: ["-9", "-u", BUILD_USER] }, { tolerateFailure: true });
      const remaining = await run(
        { file: "pgrep", args: ["-u", BUILD_USER, "-r", LIVE_PROCESS_STATES] },
        { tolerateFailure: true },
      );
      if (remaining === 1) return;
      if (round < MAXIMUM_SWEEP_ROUNDS) await sleep(SWEEP_ROUND_MILLISECONDS);
    }
    appendPackagingLines(at("sweep.log"), at("user-build.log"), "sweep");
    throw new Error("customer processes did not end");
  };

  if ((await sha256OfFile(at("source.tar.gz"))) !== environment.EXPECTED_SOURCE_SHA256) {
    throw new Error("source archive digest does not match");
  }
  for (const directory of ["source", "bundle/assets", "bundle/worker"]) {
    fs.mkdirSync(at(directory), { recursive: true });
  }
  await run(runtime(["write-user-build-script", at("user-build.sh")]));
  await run(runtime(["write-root-package-script", at("root-package.sh")]));
  await run(runtime(["validate-archive", at("source.tar.gz")]));
  await run({
    file: "tar",
    args: [
      "-xzf",
      at("source.tar.gz"),
      "-C",
      at("source"),
      "--no-same-owner",
      "--no-same-permissions",
    ],
  });
  const extracted = fs.readdirSync(at("source"), { withFileTypes: true });
  if (extracted.length !== 1 || !extracted[0].isDirectory()) {
    throw new Error("source archive must contain exactly one root directory");
  }
  const repositoryRoot = fs.realpathSync(at("source", extracted[0].name));
  await run(
    runtime(["resolve-root", repositoryRoot, environment.APPLICATION_ROOT], {
      stdoutPath: at("application-root"),
    }),
  );
  const applicationRoot = fs.readFileSync(at("application-root"), "utf8");
  // Root output stays private. Preserve customer-safe limit details, or report only the fixed
  // failed platform phase, so neither a successful application build nor silence is the excerpt.
  const packaging = async (command, logName, phase) => {
    try {
      await run({ ...command, stdoutPath: at(logName), mergeStderr: true });
    } catch (error) {
      appendPackagingLines(at(logName), at("user-build.log"), phase);
      throw error;
    }
  };
  await run(runtime(["snapshot-migrations", at("migration-snapshot")], { cwd: applicationRoot }));
  // Planning admitted this package manager and build script with the same shared rules.
  await packaging(
    runtime(["write-package-manager", applicationRoot, at("package-manager.json")]),
    "package-manager.log",
    "recheck",
  );
  await run({ file: "chown", args: ["-R", `${BUILD_USER}:${BUILD_USER}`, at("source")] });
  try {
    try {
      // setpriv, not runuser: runuser ends a build whose tooling tears down its process group.
      await run({
        file: "setpriv",
        args: [
          "--no-new-privs",
          `--reuid=${BUILD_USER}`,
          `--regid=${BUILD_USER}`,
          "--clear-groups",
          "env",
          "-i",
          `HOME=${BUILD_USER_HOME}`,
          `PATH=${toolPath}`,
          "CI=true",
          "NEXT_TELEMETRY_DISABLED=1",
          ...USER_BUILD_ENVIRONMENT_NAMES.filter(
            (name) =>
              !["SSG_CACHE_MAX_BYTES", "NEXT_REVALIDATE_PATH"].includes(name) ||
              environment.FRAMEWORK_ADAPTER === "nextjs",
          ).map(
            (name) =>
              `${name}=${environment[name] ?? (name === "SSG_CACHE_MAX_BYTES" ? "33554432" : "")}`,
          ),
          at("user-build.sh"),
          applicationRoot,
        ],
        env: { PATH: toolPath },
        stdoutPath: at("user-build.log"),
        mergeStderr: true,
      });
    } finally {
      // Nothing of the customer's may still run while root packages the output.
      await endCustomerProcesses();
    }
    // A survivor that dodged the sweep must not be able to create or swap paths in the tree: root owns it, and
    // nothing in it stays writable for group or others.
    await run({ file: "chown", args: ["-R", "root:root", at("source")] });
    await run({ file: "chmod", args: ["-R", "go-w", at("source")] });
    await packaging({ file: at("root-package.sh"), args: [] }, "root-package.log", "package");
  } finally {
    for (const cleanup of ["cleanup-tanstack-platform-config", "cleanup-next-platform-config"]) {
      await run(runtime([cleanup, applicationRoot]), { tolerateFailure: true });
    }
  }
  await packaging(
    runtime(["archive", at("bundle"), at("bundle.tar.gz")]),
    "archive.log",
    "archive",
  );
}

/**
 * Appends existing safe limit lines or a fixed platform-phase failure to the customer's log.
 * Raw root output still goes only to operator stderr; it never supplies the fallback wording.
 */
export function appendPackagingLines(rootLogPath, userLogPath, phase = "package") {
  if (!Object.hasOwn(PACKAGING_FAILURE_LINES, phase))
    throw new TypeError("Packaging failure phase is invalid");
  const output = readLogTail(rootLogPath, MAXIMUM_PACKAGING_OUTPUT_BYTES);
  if (output !== null) process.stderr.write(output);
  const lines = (output?.toString("utf8") ?? "")
    .split("\n")
    .filter(
      (line) =>
        line.startsWith(PACKAGING_LINE_PREFIX) &&
        line.length > PACKAGING_LINE_PREFIX.length &&
        line.length <= MAXIMUM_PACKAGING_LINE_CHARACTERS &&
        !/\p{Cc}/u.test(line),
    );
  if (lines.length === 0) lines.push(PACKAGING_FAILURE_LINES[phase]);
  // The customer's last line may lack its newline; the packaging line must start a line of its own.
  const descriptor = fs.openSync(userLogPath, "a+", 0o600);
  try {
    const size = fs.fstatSync(descriptor).size;
    const last = Buffer.alloc(1);
    const unterminated = size > 0 && fs.readSync(descriptor, last, 0, 1, size - 1) === 1;
    const separator = unterminated && last[0] !== 0x0a ? "\n" : "";
    fs.writeSync(descriptor, `${separator}${lines.join("\n")}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseStartEnvironment(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isRecord(parsed) || Object.keys(parsed).join() !== "environment") return null;
  const entries = isRecord(parsed.environment) ? Object.entries(parsed.environment) : [];
  const environment = Object.fromEntries(entries);
  const functionsRuntime = environment.FRAMEWORK_RUNTIME === "functions";
  const hasBuildOutput =
    Boolean(environment.BUILD_COMMAND) && Boolean(environment.BUILD_OUTPUT_DIRECTORY);
  const hasNoBuildOutput = !environment.BUILD_COMMAND && !environment.BUILD_OUTPUT_DIRECTORY;
  const ssgCacheBytes = environment.SSG_CACHE_MAX_BYTES;
  const revalidatePath = environment.NEXT_REVALIDATE_PATH;
  if (
    entries.some(
      ([name, value]) =>
        !BUILD_ENVIRONMENT_NAMES.includes(name) ||
        typeof value !== "string" ||
        value.includes("\0"),
    ) ||
    REQUIRED_ENVIRONMENT_NAMES.some((name) => !environment[name]) ||
    !/^[0-9a-f]{64}$/u.test(environment.EXPECTED_SOURCE_SHA256) ||
    !OPERATION_ID_PATTERN.test(environment.OPERATION_ID) ||
    (revalidatePath !== undefined &&
      (environment.FRAMEWORK_ADAPTER !== "nextjs" || revalidatePath !== "1")) ||
    (ssgCacheBytes !== undefined &&
      (environment.FRAMEWORK_ADAPTER !== "nextjs" ||
        !/^[1-9][0-9]{6,7}$/u.test(ssgCacheBytes) ||
        Number(ssgCacheBytes) < 1048576 ||
        Number(ssgCacheBytes) > 67108864 ||
        Number(ssgCacheBytes) % 1048576 !== 0)) ||
    (functionsRuntime
      ? environment.FRAMEWORK_ADAPTER !== "functions" || !hasNoBuildOutput
      : !hasBuildOutput)
  ) {
    return null;
  }
  try {
    validateApplicationRoot(environment.APPLICATION_ROOT);
  } catch {
    return null;
  }
  return environment;
}

function readLogTail(logPath, maximumBytes = MAXIMUM_LOG_BYTES) {
  let descriptor;
  try {
    descriptor = fs.openSync(logPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(descriptor).size;
    const tail = Buffer.alloc(Math.min(size, maximumBytes));
    let read = 0;
    while (read < tail.length) {
      const count = fs.readSync(
        descriptor,
        tail,
        read,
        tail.length - read,
        size - tail.length + read,
      );
      if (count === 0) break;
      read += count;
    }
    let start = 0;
    // A cut inside a UTF-8 sequence leaves continuation bytes that belong to no character.
    if (size > tail.length) while (start < read && (tail[start] & 0xc0) === 0x80) start += 1;
    return tail.subarray(start, read);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * The sandbox agent protocol: PUT /source, POST /start, GET /status, GET /bundle, GET /log.
 * `runPhases({ environment, workRoot })` performs the build and leaves `bundle.tar.gz` and
 * `user-build.log` in `workRoot`.
 */
export function createBuildAgent({ token, workRoot, runPhases, now = () => new Date() }) {
  const expectedAuthorization = crypto.createHash("sha256").update(`Bearer ${token}`).digest();
  const sourcePath = path.join(workRoot, "source.tar.gz");
  const bundlePath = path.join(workRoot, "bundle.tar.gz");
  const logPath = path.join(workRoot, "user-build.log");
  let state = "idle";
  let startedAt = null;
  let completedAt = null;
  let failure = null;
  let acceptedStart = null;
  let sourceReceived = false;
  let receivingSource = false;

  const sendJson = (response, status, body, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };
  const sendEmpty = (response, status, headers = {}) => {
    response.writeHead(status, headers);
    response.end();
  };
  /** Refuses a declared oversize without reading it; the connection ends with the response. */
  const refuseDeclaredOversize = (request, response, maximumBytes) => {
    if (!(Number(request.headers["content-length"] ?? 0) > maximumBytes)) return false;
    response.once("finish", () => request.destroy());
    sendJson(response, 413, { error: "request body is too large" }, { connection: "close" });
    return true;
  };

  async function build(environment) {
    try {
      await runPhases({ environment, workRoot });
      const bundleBytes = fs.statSync(bundlePath).size;
      if (bundleBytes < 1 || bundleBytes > MAXIMUM_BUNDLE_BYTES) {
        throw new Error("bundle size is invalid");
      }
      state = "succeeded";
    } catch (error) {
      process.stderr.write(`build ${environment.BUILD_ID} failed: ${error.message}\n`);
      try {
        failure = readBuildFailureExcerpt({ logPath, operationId: environment.OPERATION_ID });
      } catch {
        failure = null;
      }
      state = "failed";
    }
    completedAt = now().toISOString();
  }

  async function receiveSource(request, response) {
    if (state !== "idle" || receivingSource) {
      sendJson(response, 409, { error: "source is no longer accepted" }, { connection: "close" });
      return;
    }
    if (refuseDeclaredOversize(request, response, MAXIMUM_SOURCE_BYTES)) return;
    receivingSource = true;
    const partPath = `${sourcePath}.part`;
    let bytes = 0;
    try {
      await pipeline(
        request,
        new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(null, bytes > MAXIMUM_SOURCE_BYTES ? undefined : chunk);
          },
        }),
        fs.createWriteStream(partPath, { mode: 0o600 }),
      );
      if (bytes < 1 || bytes > MAXIMUM_SOURCE_BYTES) {
        const oversize = bytes > MAXIMUM_SOURCE_BYTES;
        sendJson(response, oversize ? 413 : 400, {
          error: oversize ? "request body is too large" : "source is empty",
        });
        return;
      }
      fs.renameSync(partPath, sourcePath);
      sourceReceived = true;
      sendEmpty(response, 204);
    } finally {
      fs.rmSync(partPath, { force: true });
      receivingSource = false;
    }
  }

  async function start(request, response) {
    if (refuseDeclaredOversize(request, response, MAXIMUM_START_BYTES)) return;
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes <= MAXIMUM_START_BYTES) chunks.push(chunk);
    }
    if (bytes > MAXIMUM_START_BYTES) {
      sendJson(response, 413, { error: "request body is too large" });
      return;
    }
    const environment = parseStartEnvironment(Buffer.concat(chunks));
    if (environment === null) {
      sendJson(response, 400, { error: "start request is invalid" });
      return;
    }
    const requestedStart = JSON.stringify(Object.entries(environment).sort());
    if (acceptedStart !== null) {
      if (acceptedStart === requestedStart) sendEmpty(response, 202);
      else sendJson(response, 409, { error: "a different build was already started" });
      return;
    }
    if (!sourceReceived || receivingSource) {
      sendJson(response, 409, { error: "source is missing" });
      return;
    }
    acceptedStart = requestedStart;
    state = "running";
    startedAt = now().toISOString();
    void build(environment);
    sendEmpty(response, 202);
  }

  function sendBundle(response) {
    if (state !== "succeeded") {
      sendJson(response, 409, { error: "bundle is not available" });
      return;
    }
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": fs.statSync(bundlePath).size,
    });
    fs.createReadStream(bundlePath).pipe(response);
  }

  function sendLog(response) {
    const tail = readLogTail(logPath);
    if (tail === null) {
      sendJson(response, 404, { error: "log is not available" });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": tail.byteLength,
    });
    response.end(tail);
  }

  async function handleRequest(request, response) {
    try {
      const provided = crypto
        .createHash("sha256")
        .update(request.headers.authorization ?? "")
        .digest();
      if (!crypto.timingSafeEqual(provided, expectedAuthorization)) {
        sendEmpty(response, 401, { "www-authenticate": "Bearer", connection: "close" });
        return;
      }
      const route = `${request.method} ${new URL(request.url, "http://sandbox").pathname}`;
      if (route === "PUT /source") await receiveSource(request, response);
      else if (route === "POST /start") await start(request, response);
      else if (route === "GET /status") {
        sendJson(response, 200, { state, startedAt, completedAt, failure });
      } else if (route === "GET /bundle") sendBundle(response);
      else if (route === "GET /log") sendLog(response);
      else sendJson(response, 404, { error: "not found" });
    } catch (error) {
      process.stderr.write(`request failed: ${error.message}\n`);
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: "request failed" }, { connection: "close" });
    }
  }

  return Object.freeze({ handleRequest });
}

/** Starts the agent of one sandbox; the token never reaches a child process. */
export function startBuildAgent({ environment, port, workRoot }) {
  const token = environment.BUILD_AGENT_TOKEN;
  if (typeof token !== "string" || token.length < MINIMUM_TOKEN_CHARACTERS) {
    throw new Error(
      `BUILD_AGENT_TOKEN is required and has at least ${MINIMUM_TOKEN_CHARACTERS} characters`,
    );
  }
  delete environment.BUILD_AGENT_TOKEN;
  const toolPath = environment.PATH;
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o755 });
  const agent = createBuildAgent({
    token,
    workRoot,
    runPhases: (input) => runBuildPhases({ ...input, toolPath, execute: executeCommand }),
  });
  return http.createServer(agent.handleRequest).listen(port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBuildAgent({ environment: process.env, port: 8080, workRoot: "/tmp/ohmyho" });
}
