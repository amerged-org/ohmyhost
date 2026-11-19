/* global AbortSignal, fetch, process */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createConnection } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";
import { runInNewContext } from "node:vm";

const PROOF_PROJECT_ID = "01K4A0B1C2D3E4F5G6H7J8K9MN";
const PROOF_ENVIRONMENT_ID = "01K4A0B1C2D3E4F5G6H7J8K9MP";
const PROOF_DEPLOYMENT_ID = "01K4A0B1C2D3E4F5G6H7J8K9MQ";
const PROOF_OPERATION_ID = "01K4A0B1C2D3E4F5G6H7J8K9MR";
const PROOF_SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
// Build ids are deterministic: the build project name and the operation id.
const PROOF_BUILD_ID = `ohmyhost-application-root-proof:${PROOF_OPERATION_ID}`;
const DEFAULT_PORT = 8792;
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_DEPENDENCY_EVIDENCE_BYTES = 32 * 1024 * 1024;
const ARCHIVE_ROOT = "ohmyhost-application-root-proof-0123456789abcdef0123456789abcdef01234567";
const GENERATED_NAMES = new Set([
  ".next",
  ".open-next",
  ".ohmyhost-open-next.config.ts",
  ".ohmyhost-proof",
  ".ohmyhost-worker",
  ".wrangler",
  "node_modules",
  "wrangler.jsonc",
]);

export const APPLICATION_ROOT_PROOF_FRAMEWORK_PLAN_SCHEMA_VERSION = "ohmyhost.framework-plan/v5";

export const APPLICATION_ROOT_PROOF_PHASES = Object.freeze([
  "package-manager-evidence",
  "install",
  "open-next-patch",
  "next-build",
  "next-cache-validate",
  "next-platform-config",
  "open-next",
  "next-cache-populate",
  "wrangler-dry-run",
  "artifact",
  "workerd",
]);

function isMissing(error) {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error, code) {
  return error !== null && typeof error === "object" && error.code === code;
}

function portablePath(value) {
  return value.split(sep).join("/");
}

export function validateProofApplicationRoot(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 64 ||
    !/^(?:\.|[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/u.test(value)
  ) {
    throw new Error("APPLICATION_ROOT_PROOF_INVALID_APPLICATION_ROOT");
  }
  const segments = value === "." ? [] : value.split("/");
  if (segments.length > 8 || segments.some((segment) => Buffer.byteLength(segment, "utf8") > 63)) {
    throw new Error("APPLICATION_ROOT_PROOF_INVALID_APPLICATION_ROOT");
  }
  return value;
}

function contained(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith("/"));
}

export function createProofCommandEnvironment(source, workspace) {
  const environment = {
    ...(typeof source.PATH === "string" ? { PATH: source.PATH } : {}),
    ...(typeof source.LANG === "string" ? { LANG: source.LANG } : {}),
    ...(typeof source.LC_ALL === "string" ? { LC_ALL: source.LC_ALL } : {}),
    HOME: workspace.home,
    TMPDIR: workspace.temporary,
    XDG_CACHE_HOME: join(workspace.home, ".cache"),
    XDG_CONFIG_HOME: join(workspace.home, ".config"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NO_COLOR: "1",
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_update_notifier: "false",
  };
  return Object.freeze(environment);
}

export function createApplicationRootProofCommands({ application, generated, port }) {
  const runtimeRoot = join(generated, "runtime");
  return Object.freeze({
    install: Object.freeze({
      command: "pnpm",
      arguments: Object.freeze([
        "install",
        "--frozen-lockfile",
        "--ignore-workspace",
        "--ignore-scripts",
      ]),
      cwd: application,
      environment: Object.freeze({}),
    }),
    nextBuild: Object.freeze({
      command: "pnpm",
      arguments: Object.freeze(["run", "build", "--webpack"]),
      cwd: application,
      environment: Object.freeze({ NEXT_PRIVATE_STANDALONE: "true" }),
    }),
    openNext: Object.freeze({
      command: "pnpm",
      arguments: Object.freeze([
        "exec",
        "opennextjs-cloudflare",
        "build",
        "--skipNextBuild",
        "--config=.ohmyhost-next-wrangler.jsonc",
        "--openNextConfigPath=.ohmyhost-open-next.config.ts",
      ]),
      cwd: application,
      environment: Object.freeze({}),
    }),
    wranglerDryRun: Object.freeze({
      command: "pnpm",
      arguments: Object.freeze([
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--outdir",
        join(application, ".ohmyhost-worker"),
        "--metafile",
        join(application, ".ohmyhost-next-metafile.json"),
        "--config",
        ".ohmyhost-next-wrangler.jsonc",
      ]),
      cwd: application,
      environment: Object.freeze({ WRANGLER_SEND_METRICS: "false" }),
    }),
    dependencyEvidence: Object.freeze({
      command: "pnpm",
      arguments: Object.freeze(["list", "--json", "--depth", "Infinity"]),
      cwd: application,
      environment: Object.freeze({}),
      stdoutPath: join(application, ".ohmyhost-resolved-dependencies.json"),
    }),
    workerd: Object.freeze({
      command: "pnpm",
      arguments: Object.freeze([
        "--dir",
        application,
        "exec",
        "wrangler",
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--config",
        join(runtimeRoot, "wrangler.jsonc"),
      ]),
      cwd: runtimeRoot,
      environment: Object.freeze({ WRANGLER_SEND_METRICS: "false" }),
    }),
  });
}

export function rewriteProofPlatformImports(config, application) {
  return config.replaceAll(
    "/opt/ohmyhost-platform/lib/node_modules/",
    `${join(application, "node_modules")}/`,
  );
}

function writeAscii(target, offset, length, value) {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.byteLength > length) throw new Error("APPLICATION_ROOT_PROOF_USTAR_FIELD_OVERFLOW");
  target.set(bytes, offset);
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error("APPLICATION_ROOT_PROOF_USTAR_PATH_OVERFLOW");
}

function ustarHeader(path, size, type) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitUstarPath(path);
  writeAscii(header, 0, 100, name);
  writeAscii(header, 100, 8, type === "5" ? "0000755\0" : "0000644\0");
  writeAscii(header, 108, 8, "0000000\0");
  writeAscii(header, 116, 8, "0000000\0");
  writeAscii(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  writeAscii(header, 136, 12, "00000000000\0");
  header.fill(32, 148, 156);
  writeAscii(header, 156, 1, type);
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  writeAscii(header, 265, 32, "ohmyhost");
  writeAscii(header, 297, 32, "ohmyhost");
  writeAscii(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

async function collectArchiveEntries(root, current = root) {
  const entries = [];
  for (const name of (await readdir(current)).sort()) {
    if (GENERATED_NAMES.has(name)) continue;
    const absolute = join(current, name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error("APPLICATION_ROOT_PROOF_UNSAFE_ARCHIVE_ENTRY");
    }
    const path = portablePath(relative(root, absolute));
    if (metadata.isDirectory()) {
      entries.push({ path: `${path}/`, body: Buffer.alloc(0), type: "5" });
      entries.push(...(await collectArchiveEntries(root, absolute)));
    } else {
      entries.push({ path, body: await readFile(absolute), type: "0" });
    }
  }
  return entries;
}

export async function createDeterministicApplicationRootArchive(repository) {
  const entries = await collectArchiveEntries(repository);
  const blocks = [ustarHeader(`${ARCHIVE_ROOT}/`, 0, "5")];
  for (const entry of entries) {
    const path = `${ARCHIVE_ROOT}/${entry.path}`;
    blocks.push(ustarHeader(path, entry.body.byteLength, entry.type), entry.body);
    const padding = (512 - (entry.body.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  const body = gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
  return Object.freeze({
    body: new Uint8Array(body),
    paths: Object.freeze(entries.filter((entry) => entry.type === "0").map((entry) => entry.path)),
    sha256: createHash("sha256").update(body).digest("hex"),
  });
}

async function prepareProofWorkspace(rootDirectory) {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-wp31-proof-"));
  try {
    await chmod(root, 0o700);
    const application = join(root, "repository", "site");
    const repository = dirname(application);
    const generated = join(application, ".ohmyhost-proof");
    const home = join(root, "home");
    const temporary = join(root, "tmp");
    await Promise.all([
      mkdir(repository, { recursive: true, mode: 0o700 }),
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { recursive: true, mode: 0o700 }),
    ]);
    await cp(join(rootDirectory, "fixtures", "next-edge"), application, {
      recursive: true,
      filter: (source) => !GENERATED_NAMES.has(source.split(sep).at(-1)),
    });
    const runtimeInputDirectory = join(application, "runtime-inputs");
    const runtimeFileRoute = join(application, "src", "app", "api", "runtime-file");
    const staticPageRoute = join(application, "src", "app", "proof-static", "[slug]");
    const themePageRoute = join(application, "src", "app", "proof-theme");
    await Promise.all(
      [runtimeInputDirectory, runtimeFileRoute, staticPageRoute, themePageRoute].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await writeFile(
      join(runtimeInputDirectory, "catalog.json"),
      '{"message":"traced runtime content"}\n',
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(staticPageRoute, "page.tsx"),
      `export const dynamicParams = false;
export function generateStaticParams() {
  return [{ slug: "alpha" }, { slug: "beta" }];
}
export default async function StaticProofPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <main data-proof-static-slug={slug}>Generated static page: {slug}</main>;
}
`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(themePageRoute, "page.tsx"),
      `export const dynamic = "force-dynamic";
function applyTheme(theme: string) {
  function normalizeTheme(value: string) {
    return value.toLowerCase();
  }
  document.documentElement.setAttribute("data-proof-theme", normalizeTheme(theme));
}
export default function ThemeProofPage() {
  return <main><script id="proof-theme-script" dangerouslySetInnerHTML={{ __html: \`(\${applyTheme.toString()})("DARK");\` }} /></main>;
}
`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(runtimeFileRoute, "route.ts"),
      `import { readFileSync } from "node:fs";
import { join } from "node:path";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(JSON.parse(readFileSync(join(process.cwd(), "runtime-inputs", "catalog.json"), "utf8")));
}
`,
      { flag: "wx", mode: 0o600 },
    );
    const nestedConfig = await readFile(join(application, "ohmyhost.yaml"), "utf8");
    await rm(join(application, "ohmyhost.yaml"));
    await Promise.all([
      writeFile(
        join(repository, "package.json"),
        `${JSON.stringify(
          {
            name: "thomas-like-wrapper",
            private: true,
            scripts: { build: "cd site && pnpm run build:cloudflare" },
          },
          null,
          2,
        )}\n`,
        { flag: "wx", mode: 0o600 },
      ),
      writeFile(join(repository, "root-only-sentinel.txt"), "must-not-enter-artifact\n", {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(
        join(repository, "ohmyhost.yaml"),
        nestedConfig.replace("project: next-edge\n", "project: next-edge\napplicationRoot: site\n"),
        { flag: "wx", mode: 0o600 },
      ),
    ]);
    return Object.freeze({ root, repository, application, generated, home, temporary });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function inspectProofArchive(workspace) {
  const archive = await createDeterministicApplicationRootArchive(workspace.repository);
  assert(archive.paths.includes("root-only-sentinel.txt"));
  assert(archive.paths.includes("site/package.json"));
  const sourceFetcher = await import(
    pathToFileURL(resolve(workspace.rootDirectory, "apps/source-fetcher/dist/index.js")).href
  );
  const platform = await import(
    pathToFileURL(resolve(workspace.rootDirectory, "packages/platform/dist/index.js")).href
  );
  const inspection = await sourceFetcher.inspectFrameworkArchive(archive.body);
  assert.equal(
    inspection.frameworkPlan.schemaVersion,
    APPLICATION_ROOT_PROOF_FRAMEWORK_PLAN_SCHEMA_VERSION,
  );
  assert.equal(inspection.frameworkPlan.schemaVersion, platform.FRAMEWORK_PLAN_SCHEMA_VERSION);
  assert.equal(inspection.frameworkPlan.applicationRoot, "site");
  assert.equal(inspection.frameworkPlan.adapter, "nextjs");
  assert.equal(inspection.frameworkPlan.runtime, "edge");
  assert.match(inspection.buildPlanSha256, /^[0-9a-f]{64}$/u);
  const canonicalDigest = createHash("sha256")
    .update(platform.serializeNewProductionFrameworkPlanPreimage(inspection.frameworkPlan))
    .digest("hex");
  assert.equal(inspection.buildPlanSha256, canonicalDigest);
  return Object.freeze({
    ...inspection,
    sourceSha256: archive.sha256,
    archivePaths: archive.paths,
  });
}

function boundedOutputCollector(child) {
  const chunks = [];
  let bytes = 0;
  const collect = (chunk) => {
    bytes += chunk.byteLength;
    if (bytes <= MAX_COMMAND_OUTPUT_BYTES) chunks.push(chunk);
    else child.kill("SIGKILL");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return () => Buffer.concat(chunks).toString("utf8");
}

async function executeProofCommand(specification, workspace) {
  if (!contained(workspace.application, specification.cwd)) {
    throw new Error("APPLICATION_ROOT_PROOF_COMMAND_ESCAPE");
  }
  const environment = {
    ...createProofCommandEnvironment(process.env, workspace),
    ...specification.environment,
  };
  await new Promise((resolveCommand, reject) => {
    const child = spawn(specification.command, specification.arguments, {
      cwd: specification.cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutLimit =
      specification.stdoutPath === undefined
        ? MAX_COMMAND_OUTPUT_BYTES
        : MAX_DEPENDENCY_EVIDENCE_BYTES;
    const collectStdout = (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= stdoutLimit) stdout.push(chunk);
      else child.kill("SIGKILL");
    };
    const collectStderr = (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_COMMAND_OUTPUT_BYTES) stderr.push(chunk);
      else child.kill("SIGKILL");
    };
    child.stdout.on("data", collectStdout);
    child.stderr.on("data", collectStderr);
    const timeout = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", async (status, signal) => {
      clearTimeout(timeout);
      if (status !== 0 || signal !== null) {
        const diagnostic = Buffer.concat([...stdout, ...stderr])
          .toString("utf8")
          .slice(-4_096);
        reject(
          new Error(
            `APPLICATION_ROOT_PROOF_COMMAND_FAILED: ${specification.command} ${specification.arguments.join(" ")}\n${diagnostic}`,
          ),
        );
        return;
      }
      try {
        if (specification.stdoutPath !== undefined) {
          if (!contained(workspace.application, specification.stdoutPath)) {
            throw new Error("APPLICATION_ROOT_PROOF_COMMAND_OUTPUT_ESCAPE");
          }
          await writeFile(specification.stdoutPath, Buffer.concat(stdout), {
            flag: "wx",
            mode: 0o600,
          });
        }
        resolveCommand();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function startProofWorkerd(specification, workspace) {
  if (!contained(workspace.application, specification.cwd)) {
    throw new Error("APPLICATION_ROOT_PROOF_COMMAND_ESCAPE");
  }
  const child = spawn(specification.command, specification.arguments, {
    cwd: specification.cwd,
    env: {
      ...createProofCommandEnvironment(process.env, workspace),
      ...specification.environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.proofProcessGroupId = child.pid;
  child.proofStartError = undefined;
  child.once("error", (error) => {
    child.proofStartError = error;
  });
  child.proofOutput = boundedOutputCollector(child);
  return child;
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolveClose) => {
    let settled = false;
    const complete = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("close", onClose);
      resolveClose(closed);
    };
    const onClose = () => complete(true);
    child.once("close", onClose);
    const timeout = setTimeout(() => complete(false), timeoutMs);
  });
}

export async function stopProofProcess(
  child,
  { gracefulTimeoutMs = 2_000, forcedTimeoutMs = 2_000 } = {},
) {
  const groupId = child.proofProcessGroupId;
  if (Number.isSafeInteger(groupId) && groupId > 0) {
    const groupAlive = () => {
      try {
        process.kill(-groupId, 0);
        return true;
      } catch (error) {
        if (hasErrorCode(error, "ESRCH")) return false;
        if (hasErrorCode(error, "EPERM")) return true;
        throw error;
      }
    };
    const signalGroup = (signal) => {
      try {
        process.kill(-groupId, signal);
      } catch (error) {
        if (!hasErrorCode(error, "ESRCH") && !hasErrorCode(error, "EPERM")) {
          throw error;
        }
      }
    };
    const waitForGroup = async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!groupAlive()) return true;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      return !groupAlive();
    };
    signalGroup("SIGTERM");
    if (await waitForGroup(gracefulTimeoutMs)) return;
    signalGroup("SIGKILL");
    if (await waitForGroup(forcedTimeoutMs)) return;
    throw new Error("APPLICATION_ROOT_PROOF_PROCESS_GROUP_DID_NOT_STOP");
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const graceful = waitForClose(child, gracefulTimeoutMs);
  child.kill("SIGTERM");
  if (await graceful) return;
  const forced = waitForClose(child, forcedTimeoutMs);
  child.kill("SIGKILL");
  if (!(await forced)) throw new Error("APPLICATION_ROOT_PROOF_PROCESS_DID_NOT_STOP");
}

function portAcceptsConnections(port) {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const complete = (accepting) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveConnection(accepting);
    };
    socket.once("connect", () => complete(true));
    socket.once("error", () => complete(false));
    const timeout = setTimeout(() => complete(false), 250);
  });
}

export async function assertProofRuntimeStopped(child, port, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let groupAlive = false;
    if (Number.isSafeInteger(child.proofProcessGroupId) && child.proofProcessGroupId > 0) {
      try {
        process.kill(-child.proofProcessGroupId, 0);
        groupAlive = true;
      } catch (error) {
        if (hasErrorCode(error, "EPERM")) {
          groupAlive = true;
        } else if (!hasErrorCode(error, "ESRCH")) {
          throw error;
        }
      }
    }
    if (!groupAlive && !(await portAcceptsConnections(port))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("APPLICATION_ROOT_PROOF_RUNTIME_REMAINS_ACTIVE");
}

async function waitUntilWorkerdReady({ port, child }) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const url = `http://127.0.0.1:${port}/api/status`;
  while (Date.now() < deadline) {
    if (child.proofStartError !== undefined) throw child.proofStartError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`APPLICATION_ROOT_PROOF_WORKERD_EXITED: ${child.proofOutput?.() ?? ""}`);
    }
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // Readiness is bounded by the outer deadline; transient connection errors are expected.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`APPLICATION_ROOT_PROOF_WORKERD_NOT_READY: ${child.proofOutput?.() ?? ""}`);
}

export async function probeProofWorkerd({ port, artifact }) {
  const origin = `http://127.0.0.1:${port}`;
  const request = async (path, headers) =>
    fetch(`${origin}/${path}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  const requestRoot = async () =>
    fetch(`${origin}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  const first = await requestRoot();
  const second = await requestRoot();
  const api = await request("api/status");
  const asset = await request("fixture.txt");
  const runtimeFile = await request("api/runtime-file");
  const privateFile = await request("runtime-inputs/catalog.json");
  const staticPages = await Promise.all(
    ["alpha", "beta"].map(async (slug) => {
      const response = await request(`proof-static/${slug}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(`data-proof-static-slug="${slug}"`, "u"));
      const rsc = await request(`proof-static/${slug}`, { RSC: "1" });
      assert.equal(rsc.status, 200);
      assert.match(rsc.headers.get("content-type") ?? "", /text\/x-component/u);
      assert.match(await rsc.text(), /data-proof-static-slug/u);
      return { slug, htmlStatus: response.status, rscStatus: rsc.status };
    }),
  );
  const unknownStatic = await request("proof-static/unknown");
  assert.equal(unknownStatic.status, 404);
  const privateCachePath = artifact.privateCachePaths[0];
  assert.equal(typeof privateCachePath, "string");
  assert(privateCachePath.startsWith("/cdn-cgi/_next_cache/"));
  const privateCache = await request(privateCachePath.slice(1));
  assert.equal(privateCache.status, 404);
  const themeScript = await request("proof-theme");
  assert.equal(themeScript.status, 200);
  const serializedScript =
    /<script\b[^>]*\bid="proof-theme-script"[^>]*>([\s\S]*?)<\/script>/u.exec(
      await themeScript.text(),
    )?.[1];
  assert.equal(typeof serializedScript, "string");
  const themeAttributes = {};
  runInNewContext(
    serializedScript,
    {
      document: {
        documentElement: {
          setAttribute(name, value) {
            themeAttributes[name] = value;
          },
        },
      },
    },
    { timeout: 1_000 },
  );
  assert.equal(themeAttributes["data-proof-theme"], "dark");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(api.status, 200);
  assert.equal(asset.status, 200);
  assert.equal(runtimeFile.status, 200);
  assert.deepEqual(await runtimeFile.json(), { message: "traced runtime content" });
  assert.equal(privateFile.status, 404);
  assert.equal(first.headers.get("x-ohmyhost-runtime"), "edge-v1");
  assert.equal(second.headers.get("x-ohmyhost-runtime"), "edge-v1");
  assert.equal(api.headers.get("x-ohmyhost-runtime"), "edge-v1");
  assert.equal(asset.headers.get("x-ohmyhost-runtime"), "edge-v1");
  const nonce = /data-request-nonce="([^"]+)"/u;
  const firstNonce = nonce.exec(await first.text())?.[1];
  const secondNonce = nonce.exec(await second.text())?.[1];
  assert.equal(typeof firstNonce, "string");
  assert.equal(typeof secondNonce, "string");
  assert.notEqual(firstNonce, secondNonce);
  const apiBody = await api.json();
  assert.equal(typeof apiBody.requestNonce, "string");
  return Object.freeze({
    firstNonce,
    secondNonce,
    apiStatus: api.status,
    assetStatus: asset.status,
    runtimeFileStatus: runtimeFile.status,
    privateFileStatus: privateFile.status,
    staticStatuses: Object.freeze(
      Object.fromEntries(staticPages.map(({ slug, htmlStatus }) => [slug, htmlStatus])),
    ),
    staticRscStatuses: Object.freeze(
      Object.fromEntries(staticPages.map(({ slug, rscStatus }) => [slug, rscStatus])),
    ),
    unknownStaticStatus: unknownStatic.status,
    privateCachePath,
    privateCacheStatus: privateCache.status,
    themeScriptStatus: themeScript.status,
    serializedTheme: themeAttributes["data-proof-theme"],
    runtimeHeader: "edge-v1",
  });
}

async function verifyProductionArtifact({ workspace, inspection }) {
  const runtime = await import(
    pathToFileURL(resolve(workspace.rootDirectory, "apps/build-runner/sandbox/build-runtime.mjs"))
      .href
  );
  const buildBroker = await import(
    pathToFileURL(resolve(workspace.rootDirectory, "packages/build-broker/dist/index.js")).href
  );
  const wfpManagement = await import(
    pathToFileURL(resolve(workspace.rootDirectory, "apps/wfp-management/dist/index.js")).href
  );
  const bundleRoot = join(workspace.generated, "bundle");
  const compressedWorkerName = ".ohmyhost-next-worker.js.gz";
  const compressedWorkerPath = join(workspace.application, compressedWorkerName);
  const artifactPath = join(workspace.generated, "bundle.tar.gz");
  await Promise.all([
    mkdir(join(bundleRoot, "assets"), { recursive: true, mode: 0o700 }),
    mkdir(join(bundleRoot, "worker"), { recursive: true, mode: 0o700 }),
  ]);
  const workerBody = await readFile(join(workspace.application, ".ohmyhost-worker", "worker.js"));
  await writeFile(compressedWorkerPath, gzipSync(workerBody, { level: 9, mtime: 0 }), {
    flag: "wx",
    mode: 0o600,
  });
  const frameworkPlan = inspection.frameworkPlan;
  const packageManagerReceiptPath = join(workspace.generated, "package-manager.json");
  const buildInputFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: "ohmyhost.application-root-proof-build-input/v1",
        sourceSha256: inspection.sourceSha256,
        buildPlanSha256: inspection.buildPlanSha256,
        commitSha: PROOF_SOURCE_COMMIT,
        applicationRoot: frameworkPlan.applicationRoot,
      }),
    )
    .digest("hex");
  const environment = Object.freeze({
    APPLICATION_ROOT: "site",
    FRAMEWORK_ADAPTER: frameworkPlan.adapter,
    FRAMEWORK_RUNTIME: frameworkPlan.runtime,
    BUILD_OUTPUT_DIRECTORY: frameworkPlan.outputDirectory,
    SERVER_OUTPUT_DIRECTORY: frameworkPlan.serverOutputDirectory,
    SERVER_ENTRYPOINT: frameworkPlan.serverEntryPoint,
    SERVER_CONFIG_PATH: frameworkPlan.serverConfigPath,
    COMPATIBILITY_DATE: frameworkPlan.compatibilityDate,
    COMPATIBILITY_FLAGS: frameworkPlan.compatibilityFlags.join(","),
    PROJECT_ID: PROOF_PROJECT_ID,
    ENVIRONMENT_ID: PROOF_ENVIRONMENT_ID,
    DEPLOYMENT_ID: PROOF_DEPLOYMENT_ID,
    OPERATION_ID: PROOF_OPERATION_ID,
    BUILD_ID: PROOF_BUILD_ID,
    BUILD_INPUT_FINGERPRINT: `sha256:${buildInputFingerprint}`,
    INSTALL_COMMAND: frameworkPlan.installCommand,
    BUILD_COMMAND: frameworkPlan.buildCommand,
    SOURCE_COMMIT_SHA: PROOF_SOURCE_COMMIT,
    EXPECTED_SOURCE_SHA256: inspection.sourceSha256,
    BUILD_PLAN_SHA256: inspection.buildPlanSha256,
    RUNTIME_POLICY_JSON: JSON.stringify(frameworkPlan.runtimePolicy),
    DATABASE_REQUIREMENT_JSON: JSON.stringify(frameworkPlan.database),
    AUTH_REQUIREMENT_JSON: JSON.stringify(frameworkPlan.auth),
    MAIL_REQUIREMENT_JSON: JSON.stringify(frameworkPlan.mail),
    STORAGE_REQUIREMENT_JSON: JSON.stringify(frameworkPlan.storage),
  });
  runtime.validateNextWorkerMetafile({
    applicationRoot: workspace.application,
    metafilePath: ".ohmyhost-next-metafile.json",
  });
  const manifest = runtime.packageBuildArtifact({
    applicationRoot: workspace.application,
    bundleRoot,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath,
    compressedWorkerPath: compressedWorkerName,
    environment,
  });
  const archive = runtime.createBuildArtifactArchive({ bundleRoot, outputPath: artifactPath });
  const body = new Uint8Array(await readFile(artifactPath));
  const scope = Object.freeze({
    projectId: PROOF_PROJECT_ID,
    environmentId: PROOF_ENVIRONMENT_ID,
    operationId: PROOF_OPERATION_ID,
  });
  const expectedProvenance = Object.freeze({
    scope,
    deploymentId: PROOF_DEPLOYMENT_ID,
    buildId: PROOF_BUILD_ID,
    sourceCommit: PROOF_SOURCE_COMMIT,
    sourceDigest: `sha256:${inspection.sourceSha256}`,
    buildPlanDigest: `sha256:${inspection.buildPlanSha256}`,
    applicationRoot: "site",
    frameworkPlanSchemaVersion: frameworkPlan.schemaVersion,
    runtimePolicy: frameworkPlan.runtimePolicy,
    database: frameworkPlan.database,
    auth: frameworkPlan.auth,
    storage: frameworkPlan.storage,
    lifecycleEvidence: manifest.lifecycleEvidence,
    artifactDigest: manifest.artifactDigest,
    output: Object.freeze({
      bucket: "ohmyhost-proof-builds",
      key: `runs/${PROOF_PROJECT_ID}/${PROOF_ENVIRONMENT_ID}/${PROOF_OPERATION_ID}/output/bundle.tar.gz`,
      versionId: "local-proof-version-1",
      eTag: '"local-proof-etag"',
      byteLength: archive.byteLength,
      sha256: archive.sha256.slice("sha256:".length),
    }),
  });
  const parsed = await buildBroker.parseVerifiedArtifactBundle({ body, expectedProvenance });
  const parsedManifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(parsed.manifestBody),
  );
  const sbom = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(parsed.sbomBody));
  assert.equal(parsedManifest.schemaVersion, "ohmyhost.artifact/v3");
  assert.equal(parsedManifest.applicationRoot, "site");
  assert.equal(parsedManifest.frameworkPlanSchemaVersion, frameworkPlan.schemaVersion);
  assert.deepEqual(parsedManifest.runtimePolicy, frameworkPlan.runtimePolicy);
  assert.deepEqual(parsedManifest.database, frameworkPlan.database);
  assert.deepEqual(parsedManifest.storage, frameworkPlan.storage);
  assert.equal(parsedManifest.buildPlanDigest, `sha256:${inspection.buildPlanSha256}`);
  assert.equal(
    parsedManifest.lifecycleEvidence.buildSandbox.projectName,
    "ohmyhost-application-root-proof",
  );
  assert.equal(
    parsedManifest.lifecycleEvidence.configurationDigest,
    createHash("sha256")
      .update(await readFile(join(workspace.repository, "ohmyhost.yaml")))
      .digest("hex"),
  );
  assert.equal(parsed.runtime?.mainModule, "index.js");
  assert.equal(parsed.runtime?.entryWrapperVersion, "nextjs-opennext-wrapper-v1");
  const runtimeFile = parsed.modules.find(
    (module) => module.path === "runtime-inputs/catalog.json",
  );
  assert.equal(runtimeFile?.contentType, "application/octet-stream");
  assert.deepEqual(
    runtimeFile.body,
    new Uint8Array(Buffer.from('{"message":"traced runtime content"}\n')),
  );
  assert(!parsed.files.some((file) => file.path === "/runtime-inputs/catalog.json"));
  assert(parsed.modules.every((module) => !module.path.includes("root-only-sentinel")));
  assert(parsed.files.some((file) => file.path === "/fixture.txt"));
  const privateCachePaths = parsed.files
    .filter((file) => file.path.startsWith("/cdn-cgi/_next_cache/"))
    .map((file) => file.path);
  assert(privateCachePaths.length > 0);
  assert(parsed.files.every((file) => !file.path.includes("root-only-sentinel")));
  assert.equal(sbom.metadata?.component?.name, "ohmyhost-fixture-next-edge");
  assert.notEqual(sbom.metadata?.component?.name, "thomas-like-wrapper");
  assert(!new TextDecoder().decode(parsed.sbomBody).includes("root-only-sentinel"));
  const runtimeRoot = join(workspace.generated, "runtime");
  const runtimeAssets = join(workspace.generated, "runtime-assets");
  await mkdir(runtimeAssets, { recursive: true, mode: 0o700 });
  for (const asset of parsed.files) {
    const relativeAsset = asset.path.slice(1);
    assert(relativeAsset !== "" && !relativeAsset.split("/").includes(".."));
    const target = join(runtimeAssets, ...relativeAsset.split("/"));
    assert(contained(runtimeAssets, target));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, asset.body, { flag: "wx", mode: 0o600 });
    assert.deepEqual(new Uint8Array(await readFile(target)), asset.body);
  }
  const executableModule = parsed.modules.find((module) => module.path === "index.js");
  assert.equal(executableModule.path, "index.js");
  for (const module of parsed.modules) {
    const target = join(runtimeRoot, module.path);
    assert(contained(runtimeRoot, target));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, module.body, { flag: "wx", mode: 0o600 });
    assert.deepEqual(new Uint8Array(await readFile(target)), module.body);
  }
  const executableModulePath = join(runtimeRoot, executableModule.path);
  const executedModuleBody = new Uint8Array(await readFile(executableModulePath));
  assert.deepEqual(executedModuleBody, executableModule.body);
  const wrapperSource = wfpManagement.createEdgeRuntimeWrapperSource(parsed.runtime);
  const wrapperPath = join(runtimeRoot, "ohmyhost-entry.mjs");
  await writeFile(wrapperPath, wrapperSource, { flag: "wx", mode: 0o600 });
  assert.equal(await readFile(wrapperPath, "utf8"), wrapperSource);
  const runtimeConfiguration = Object.freeze({
    name: "ohmyhost-application-root-proof",
    main: "ohmyhost-entry.mjs",
    compatibility_date: parsed.runtime.compatibilityDate,
    compatibility_flags: parsed.runtime.compatibilityFlags,
    no_bundle: true,
    find_additional_modules: true,
    rules: Object.freeze([
      Object.freeze({
        type: "ESModule",
        globs: Object.freeze(
          parsed.modules
            .filter((module) => module.contentType === "application/javascript+module")
            .map((module) => module.path),
        ),
        fallthrough: true,
      }),
      Object.freeze({
        type: "Data",
        globs: Object.freeze(
          parsed.modules
            .filter((module) => module.contentType === "application/octet-stream")
            .map((module) => module.path),
        ),
        fallthrough: true,
      }),
    ]),
    assets: Object.freeze({
      directory: "../runtime-assets",
      binding: "ASSETS",
      run_worker_first: true,
    }),
    images: Object.freeze({ binding: "IMAGES" }),
  });
  await writeFile(
    join(runtimeRoot, "wrangler.jsonc"),
    `${JSON.stringify(runtimeConfiguration, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(runtimeRoot, "wrangler.jsonc"), "utf8")),
    runtimeConfiguration,
  );
  return Object.freeze({
    schemaVersion: parsedManifest.schemaVersion,
    artifactDigest: parsed.provenance.artifactDigest,
    assetCount: parsed.files.length,
    moduleCount: parsed.modules.length,
    sbomPackageName: sbom.metadata.component.name,
    privateCachePaths: Object.freeze(privateCachePaths),
    executedModuleDigest: `sha256:${createHash("sha256").update(executedModuleBody).digest("hex")}`,
  });
}

async function cleanupProofWorkspace(workspace) {
  await rm(workspace.root, { recursive: true, force: true });
}

async function assertProofWorkspaceClean(workspace) {
  try {
    await access(workspace.root, fsConstants.F_OK);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error("APPLICATION_ROOT_PROOF_CLEANUP_FAILED");
}

function createDefaultDependencies(rootDirectory) {
  return Object.freeze({
    async prepare() {
      const workspace = await prepareProofWorkspace(rootDirectory);
      return Object.freeze({ ...workspace, rootDirectory });
    },
    inspect: inspectProofArchive,
    async preparePackageManagerEvidence({ workspace, inspection }) {
      const runtime = await import(
        pathToFileURL(resolve(rootDirectory, "apps/build-runner/sandbox/build-runtime.mjs")).href
      );
      const outputPath = join(workspace.generated, "package-manager.json");
      await mkdir(workspace.generated, { recursive: true, mode: 0o700 });
      runtime.writePackageManagerReceipt({
        applicationRoot: workspace.application,
        installCommand: inspection.frameworkPlan.installCommand,
        buildCommand: inspection.frameworkPlan.buildCommand,
        outputPath,
      });
      return outputPath;
    },
    async prepareNextPlatformConfig({ workspace, inspection }) {
      const runtime = await import(
        pathToFileURL(resolve(rootDirectory, "apps/build-runner/sandbox/build-runtime.mjs")).href
      );
      const framework = inspection.frameworkPlan;
      const environment = {
        FRAMEWORK_ADAPTER: framework.adapter,
        FRAMEWORK_RUNTIME: framework.runtime,
        BUILD_OUTPUT_DIRECTORY: framework.outputDirectory,
        SERVER_OUTPUT_DIRECTORY: framework.serverOutputDirectory,
        SERVER_ENTRYPOINT: framework.serverEntryPoint,
        COMPATIBILITY_DATE: framework.compatibilityDate,
        COMPATIBILITY_FLAGS: framework.compatibilityFlags.join(","),
      };
      runtime.createNextPlatformConfig({
        applicationRoot: workspace.application,
        outputPath: join(workspace.application, ".ohmyhost-next-wrangler.jsonc"),
        environment,
      });
      const configPath = runtime.createOpenNextPlatformConfig({
        applicationRoot: workspace.application,
        outputPath: join(workspace.application, ".ohmyhost-open-next.config.ts"),
        environment,
      });
      // This local proof uses the fixture's identical pinned tool instead of the image's /opt path.
      const config = await readFile(configPath, "utf8");
      await chmod(configPath, 0o600);
      await writeFile(configPath, rewriteProofPlatformImports(config, workspace.application));
      await chmod(configPath, 0o400);
    },
    execute: executeProofCommand,
    async patchOpenNext(workspace) {
      // The build image patches its pinned OpenNext once so it runs Next.js 16.4; the proof installs the
      // same package, so it gets the same reviewed patch. Its store lives under the proof home.
      const patcher = await import(
        pathToFileURL(resolve(rootDirectory, "apps/build-runner/sandbox/open-next-patch.mjs")).href
      );
      patcher.patchOpenNextPackage(
        await realpath(join(workspace.application, "node_modules/@opennextjs/cloudflare")),
      );
    },
    async validateNextCache(workspace) {
      const runtime = await import(
        pathToFileURL(resolve(rootDirectory, "apps/build-runner/sandbox/build-runtime.mjs")).href
      );
      await runtime.validateNextCacheSupport({ applicationRoot: workspace.application });
    },
    async populateNextCache(workspace) {
      const runtime = await import(
        pathToFileURL(resolve(rootDirectory, "apps/build-runner/sandbox/build-runtime.mjs")).href
      );
      await runtime.populateNextStaticCache({
        applicationRoot: workspace.application,
        platformPackageRoot: join(workspace.application, "node_modules/@opennextjs/cloudflare"),
      });
    },
    verifyArtifact: verifyProductionArtifact,
    startWorkerd: startProofWorkerd,
    waitUntilReady: waitUntilWorkerdReady,
    probe: probeProofWorkerd,
    async stop(child, { port }) {
      await stopProofProcess(child);
      await assertProofRuntimeStopped(child, port);
    },
    cleanup: cleanupProofWorkspace,
    assertClean: assertProofWorkspaceClean,
  });
}

export async function runApplicationRootProof({
  rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  port = DEFAULT_PORT,
  dependencies: injectedDependencies = {},
  afterPhase = async () => undefined,
} = {}) {
  validateProofApplicationRoot("site");
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("APPLICATION_ROOT_PROOF_INVALID_PORT");
  }
  const dependencies = { ...createDefaultDependencies(rootDirectory), ...injectedDependencies };
  let workspace;
  let child;
  try {
    workspace = await dependencies.prepare();
    const commands = createApplicationRootProofCommands({
      application: workspace.application,
      generated: workspace.generated,
      port,
    });
    const inspection = await dependencies.inspect(workspace);
    assert.equal(inspection.applicationRoot ?? inspection.frameworkPlan?.applicationRoot, "site");
    assert.equal(
      inspection.schemaVersion ?? inspection.frameworkPlan?.schemaVersion,
      APPLICATION_ROOT_PROOF_FRAMEWORK_PLAN_SCHEMA_VERSION,
    );
    const packageManagerReceiptPath = await dependencies.preparePackageManagerEvidence({
      workspace,
      inspection,
    });
    assert.equal(packageManagerReceiptPath, join(workspace.generated, "package-manager.json"));
    await afterPhase("package-manager-evidence");
    await dependencies.execute(commands.install, workspace);
    await afterPhase("install");
    await dependencies.patchOpenNext(workspace);
    await afterPhase("open-next-patch");
    await dependencies.execute(commands.nextBuild, workspace);
    await afterPhase("next-build");
    await dependencies.validateNextCache(workspace);
    await afterPhase("next-cache-validate");
    await dependencies.prepareNextPlatformConfig({ workspace, inspection });
    await afterPhase("next-platform-config");
    await dependencies.execute(commands.openNext, workspace);
    await afterPhase("open-next");
    await dependencies.populateNextCache(workspace);
    await afterPhase("next-cache-populate");
    await dependencies.execute(commands.wranglerDryRun, workspace);
    await afterPhase("wrangler-dry-run");
    await dependencies.execute(commands.dependencyEvidence, workspace);
    const artifact = await dependencies.verifyArtifact({
      workspace,
      inspection,
      commands,
    });
    assert.equal(artifact.schemaVersion, "ohmyhost.artifact/v3");
    assert.match(artifact.executedModuleDigest, /^sha256:[0-9a-f]{64}$/u);
    await afterPhase("artifact");
    child = await dependencies.startWorkerd(commands.workerd, workspace);
    await dependencies.waitUntilReady({ child, port, workspace });
    await afterPhase("workerd");
    const probes = await dependencies.probe({ child, port, workspace, artifact });
    assert.notEqual(probes.firstNonce, probes.secondNonce);
    assert.equal(probes.apiStatus, 200);
    assert.equal(probes.assetStatus, 200);
    assert.equal(probes.runtimeFileStatus, 200);
    assert.equal(probes.privateFileStatus, 404);
    assert.deepEqual(probes.staticStatuses, { alpha: 200, beta: 200 });
    assert.deepEqual(probes.staticRscStatuses, { alpha: 200, beta: 200 });
    assert.equal(probes.unknownStaticStatus, 404);
    assert.equal(probes.privateCacheStatus, 404);
    assert.equal(probes.themeScriptStatus, 200);
    assert.equal(probes.serializedTheme, "dark");
    assert.equal(probes.runtimeHeader, "edge-v1");
    return Object.freeze({
      applicationRoot: "site",
      frameworkPlanSchemaVersion: APPLICATION_ROOT_PROOF_FRAMEWORK_PLAN_SCHEMA_VERSION,
      artifactSchemaVersion: "ohmyhost.artifact/v3",
      artifactDigest: artifact.artifactDigest,
      artifactAssetCount: artifact.assetCount,
      artifactModuleCount: artifact.moduleCount,
      executedModuleDigest: artifact.executedModuleDigest,
      sbomPackageName: artifact.sbomPackageName,
      sourceSha256: inspection.sourceSha256,
      buildPlanSha256: inspection.buildPlanSha256,
      probes,
    });
  } finally {
    try {
      if (child !== undefined) await dependencies.stop(child, { port });
    } finally {
      if (workspace !== undefined) {
        try {
          await dependencies.cleanup(workspace);
        } finally {
          await dependencies.assertClean(workspace);
        }
      }
    }
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const result = await runApplicationRootProof();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
