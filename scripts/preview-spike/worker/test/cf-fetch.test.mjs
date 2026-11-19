/* global AbortSignal, URL, clearTimeout, fetch, setTimeout */
/* No credentials, installs or external requests: exercise the exact locked local toolchain. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const workerRoot = fileURLToPath(new URL("../", import.meta.url));
const hook = fileURLToPath(new URL("./helpers/cf-fetch-hook.mjs", import.meta.url));
const childProgram = fileURLToPath(new URL("./helpers/cf-fetch-child.mjs", import.meta.url));
const wrangler = path.join(workerRoot, "node_modules/wrangler/bin/wrangler.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

async function assertLockedTools() {
  const lock = JSON.parse(await readFile(path.join(workerRoot, "package-lock.json"), "utf8"));
  for (const name of ["wrangler", "miniflare"]) {
    const installed = JSON.parse(
      await readFile(path.join(workerRoot, "node_modules", name, "package.json"), "utf8"),
    );
    assert.equal(installed.version, lock.packages[`node_modules/${name}`].version);
  }
}

async function withCase(run) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "preview-cf-fetch-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function childEnvironment(dir, disabled) {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    TMPDIR: dir,
    XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
    XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_HIDE_BANNER: "true",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    MINIFLARE_CACHE_DIR: path.join(dir, "mf-cache"),
    CF_TEST_MARKER: path.join(dir, "attempts"),
    CF_TEST_TOOLING_ROOT: workerRoot,
    NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
    ...(disabled ? { CLOUDFLARE_CF_FETCH_ENABLED: "false" } : {}),
  };
}
async function attempts(dir) {
  const content = await readFile(path.join(dir, "attempts"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const lines = content.trim().split("\n").filter(Boolean);
  assert.ok(
    lines.every((line) => line === "attempt"),
    "unexpected_network_attempt",
  );
  return lines.length;
}
function launch(args, options) {
  const child = spawn(process.execPath, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    errors = "",
    settled = false;
  child.stdout.on("data", (value) => {
    output = (output + value).slice(-65536);
  });
  child.stderr.on("data", (value) => {
    errors = (errors + value).slice(-65536);
  });
  const ended = new Promise((resolve) => {
    child.once("error", (error) => {
      settled = true;
      resolve({ error });
    });
    child.once("exit", (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
  });
  return { child, ended, output: () => output, errors: () => errors, settled: () => settled };
}
async function stopChild(proc) {
  const pid = proc.child.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) {
    if (!proc.settled()) throw new Error("local_test_process_missing_pid");
    return;
  }
  if (process.platform === "win32") {
    if (proc.settled()) return;
    proc.child.kill("SIGTERM");
    await Promise.race([proc.ended, wait(1500)]);
    if (!proc.settled()) proc.child.kill("SIGKILL");
    await Promise.race([proc.ended, wait(1500)]);
    if (!proc.settled()) throw new Error("local_test_process_did_not_exit");
    return;
  }
  // A detached child owns this process group. The leader can exit before
  // its workerd or esbuild children, so always check the group itself.
  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const waitForGroup = async (ms) => {
    const deadline = performance.now() + ms;
    while (signalGroup(0) && performance.now() < deadline) await wait(25);
    return !signalGroup(0);
  };
  signalGroup("SIGTERM");
  if (!(await waitForGroup(1500))) {
    signalGroup("SIGKILL");
    if (!(await waitForGroup(1500))) throw new Error("local_test_group_did_not_exit");
  }
  if (!proc.settled()) await Promise.race([proc.ended, wait(1500)]);
  if (!proc.settled()) throw new Error("local_test_process_did_not_exit");
}

async function completion(proc, timeoutMs = 25000) {
  let timer;
  try {
    return await Promise.race([
      proc.ended,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("local_test_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function miniflareCase(disabled, cachedCf) {
  return withCase(async (dir) => {
    if (cachedCf) {
      await mkdir(path.join(dir, "mf-cache"));
      await writeFile(path.join(dir, "mf-cache/cf.json"), JSON.stringify(cachedCf));
    }
    const proc = launch([childProgram], { cwd: dir, env: childEnvironment(dir, disabled) });
    try {
      const result = await completion(proc);
      assert.equal(result.code, 0, "miniflare_child_failed");
      const body = JSON.parse(proc.output());
      assert.equal(body.status, 200);
      return { ...body, attempts: await attempts(dir) };
    } finally {
      await stopChild(proc);
    }
  });
}
async function wranglerCase(disabled) {
  return withCase(async (dir) => {
    const base = {
      compatibility_date: "2026-08-21",
      compatibility_flags: ["nodejs_compat"],
      dev: { ip: "127.0.0.1", port: 0, local_protocol: "http" },
      observability: { enabled: false },
    };
    const bindingFile = path.join(dir, "binding.mjs"),
      appFile = path.join(dir, "app.mjs");
    const bindingConfig = path.join(dir, "binding.jsonc"),
      appConfig = path.join(dir, "app.jsonc");
    await writeFile(
      bindingFile,
      `import { WorkerEntrypoint } from 'cloudflare:workers';
export class Database extends WorkerEntrypoint { query() { return { value: 17 }; } }
export default { fetch(request, env) { return env.APP.fetch(request); } };`,
    );
    await writeFile(
      appFile,
      `export default { async fetch(request, env) { return Response.json({ database: await env.DB.query(), cf: request.cf }); } };`,
    );
    await writeFile(
      bindingConfig,
      JSON.stringify({
        ...base,
        name: "spike-bindings",
        main: bindingFile,
        services: [{ binding: "APP", service: "spike-application" }],
      }),
    );
    await writeFile(
      appConfig,
      JSON.stringify({
        ...base,
        name: "spike-application",
        main: appFile,
        services: [{ binding: "DB", service: "spike-bindings", entrypoint: "Database" }],
      }),
    );
    const started = performance.now();
    const proc = launch(
      [
        wrangler,
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        "0",
        "--inspector-port",
        "0",
        "--config",
        bindingConfig,
        "--config",
        appConfig,
        "--log-level",
        "info",
        "--show-interactive-dev-session=false",
      ],
      { cwd: dir, env: childEnvironment(dir, disabled) },
    );
    let measured;
    try {
      let result;
      const deadline = performance.now() + 25000;
      while (performance.now() < deadline && !proc.settled()) {
        const match = /Ready on http:\/\/127\.0\.0\.1:(\d+)/u.exec(proc.output());
        if (match && Number(match[1]) > 0) {
          try {
            const response = await fetch(`http://127.0.0.1:${match[1]}/`, {
              signal: AbortSignal.timeout(1000),
            });
            if (response.ok) {
              result = await response.json();
              break;
            }
          } catch {
            /* The local runtime is still starting. */
          }
        }
        await wait(30);
      }
      assert.ok(result, "wrangler_multiworker_not_ready");
      assert.deepEqual(result.database, { value: 17 });
      measured = {
        cf: result.cf,
        elapsedMs: Math.round(performance.now() - started),
      };
    } finally {
      await stopChild(proc);
    }
    return { ...measured, attempts: await attempts(dir) };
  });
}

async function driverWiringCase(fixture) {
  return withCase(async (dir) => {
    const workspace = path.join(dir, "app");
    const runtime = path.join(dir, "runtime");
    await mkdir(path.join(workspace, "src/ohmyhost"), { recursive: true });
    await mkdir(runtime);
    await writeFile(path.join(workspace, "src/ohmyhost/companion.ts"), "export default {};");
    if (fixture === "tanstack-start")
      await writeFile(
        path.join(workspace, "vite.config.ts"),
        "cloudflare({ viteEnvironment: 'ssr' })",
      );
    for (const name of ["next-request-hook.mjs", "hmr-probe.mjs"])
      await copyFile(path.join(workerRoot, "container", name), path.join(runtime, name));
    let source = await readFile(path.join(workerRoot, "container/driver.mjs"), "utf8");
    for (const [before, after] of [
      ['const workspace = "/workspace/app";', `const workspace = ${JSON.stringify(workspace)};`],
      [
        'const tooling = "/opt/preview-tooling/node_modules/wrangler/bin/wrangler.js";',
        `const tooling = ${JSON.stringify(wrangler)};`,
      ],
      [
        'const runtimeHome = "/opt/preview-spike";',
        `const runtimeHome = ${JSON.stringify(runtime)};`,
      ],
    ]) {
      assert.equal(source.split(before).length, 2, "driver_test_rewrite_changed");
      source = source.replace(before, after);
    }
    const driver = path.join(runtime, "driver.mjs");
    const report = path.join(dir, "spawn-report.json");
    await writeFile(driver, source);
    const spawnHook = fileURLToPath(new URL("./helpers/driver-spawn-hook.mjs", import.meta.url));
    const proc = launch([driver, "serve", fixture, "fixture.preview.test"], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        CI: "1",
        SPIKE_QA_FIXTURE: fixture,
        CF_DRIVER_REPORT: report,
        NODE_OPTIONS: `--import=${pathToFileURL(spawnHook).href}`,
      },
    });
    try {
      const result = await completion(proc);
      assert.equal(result.code, 0, "driver_wiring_child_failed");
      return JSON.parse(await readFile(report, "utf8"));
    } finally {
      await stopChild(proc);
    }
  });
}

test(
  "Miniflare uses the same placeholder after a metadata timeout or the explicit offline flag",
  { timeout: 35000 },
  async (t) => {
    await assertLockedTools();
    const blocked = await miniflareCase(false),
      disabled = await miniflareCase(true);
    assert.equal(blocked.attempts, 1);
    assert.equal(disabled.attempts, 0);
    assert.equal(digest(blocked.cf), digest(disabled.cf));
    t.diagnostic(
      `Controlled local Miniflare startup: timeout ${blocked.elapsedMs} ms; flag ${disabled.elapsedMs} ms`,
    );
  },
);

test(
  "pinned Wrangler multi-worker forwards real workerd RPC with no metadata fetch when flagged",
  { timeout: 60000 },
  async (t) => {
    const blocked = await wranglerCase(false),
      disabled = await wranglerCase(true);
    assert.equal(blocked.attempts, 2);
    assert.equal(disabled.attempts, 0);
    assert.equal(digest(blocked.cf), digest(disabled.cf));
    for (const fixture of ["react-vite", "vanilla-vite", "tanstack-start"]) {
      const records = await driverWiringCase(fixture);
      assert.deepEqual(records, [
        {
          target: "wrangler",
          hasFlag: fixture !== "tanstack-start",
          value: fixture === "tanstack-start" ? null : "false",
        },
        { target: "vite", hasFlag: false, value: null },
      ]);
    }
    t.diagnostic(
      `Controlled local Wrangler startup: timeout ${blocked.elapsedMs} ms; flag ${disabled.elapsedMs} ms`,
    );
  },
);

test(
  "a usable cache is intentionally ignored by the offline flag",
  { timeout: 35000 },
  async () => {
    const cachedCf = { colo: "TST", country: "ZZ", asn: 42 };
    const cached = await miniflareCase(false, cachedCf),
      disabled = await miniflareCase(true, cachedCf);
    assert.equal(cached.attempts, 0);
    assert.equal(disabled.attempts, 0);
    assert.equal(cached.cf.colo, "TST");
    assert.notEqual(digest(cached.cf), digest(disabled.cf));
  },
);
