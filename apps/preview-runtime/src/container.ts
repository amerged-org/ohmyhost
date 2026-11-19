import type { PreviewContainer, PreviewProcess, PreviewSourceResult } from "./runtime-types.js";
import type { SourceOperation, SourceWriter } from "./source-sync.js";

const DEADLINE_MS = 120_000;
const BASE_ENV = Object.freeze({
  PATH: "/opt/ohmyhost-platform/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: "/workspace/home",
  COREPACK_HOME: "/workspace/home/.cache/node/corepack",
  CI: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  WRANGLER_SEND_METRICS: "false",
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
});

function aborted(): DOMException {
  return new DOMException("Preview operation aborted", "AbortError");
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(aborted());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(aborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface RunningCommand {
  readonly process: PreviewProcess;
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  stop(): void;
  finish(): void;
  keepRunning(): void;
}

/** Native exec runs inside the already-selected project/environment VM. */
async function launch(
  container: PreviewContainer,
  command: readonly string[],
  options: Omit<Parameters<PreviewContainer["exec"]>[1], "signal">,
  parent: AbortSignal | undefined,
  deadlineMs: number,
): Promise<RunningCommand> {
  const operation = new AbortController();
  const execution = new AbortController();
  let running = true;
  let detached = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    parent?.removeEventListener("abort", stop);
  };
  const stop = () => {
    operation.abort();
    // Cloudflare signals only the directly launched process. VM destruction is
    // responsible for stopping the rest of this untrusted execution environment.
    if (running) execution.abort();
  };
  if (parent?.aborted) throw aborted();
  parent?.addEventListener("abort", stop, { once: true });
  timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, deadlineMs);
  try {
    const process = await waitFor(
      container.exec(command, { ...options, signal: execution.signal }),
      operation.signal,
    );
    void process.exitCode.then(
      () => {
        running = false;
        if (detached) dispose();
      },
      () => {
        running = false;
        if (detached) dispose();
      },
    );
    return {
      process,
      signal: operation.signal,
      timedOut: () => timedOut,
      stop,
      finish: dispose,
      keepRunning() {
        detached = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (!running) dispose();
      },
    };
  } catch (error) {
    stop();
    dispose();
    throw error;
  }
}

async function complete(command: RunningCommand): Promise<void> {
  const code = await waitFor(command.process.exitCode, command.signal);
  if (code !== 0) throw new Error("preview_container_command_failed");
}

async function run(
  container: PreviewContainer,
  command: readonly string[],
  options: Omit<Parameters<PreviewContainer["exec"]>[1], "signal">,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<void> {
  const launched = await launch(container, command, options, signal, deadlineMs);
  try {
    await complete(launched);
  } catch (error) {
    launched.stop();
    throw error;
  } finally {
    launched.finish();
  }
}

async function writeInput(command: RunningCommand, bytes?: Uint8Array): Promise<void> {
  if (!command.process.stdin) {
    command.stop();
    throw new Error("preview_input_unavailable");
  }
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  try {
    writer = command.process.stdin.getWriter();
  } catch (error) {
    command.stop();
    throw error;
  }
  try {
    if (bytes) await waitFor(writer.write(bytes), command.signal);
    await waitFor(writer.close(), command.signal);
    await complete(command);
  } catch (error) {
    // Do not wait for a guest-backed stream to acknowledge cancellation.
    try {
      void writer.abort().catch(() => undefined);
    } catch {
      // Process teardown still proceeds if the stream is already closed.
    }
    command.stop();
    throw error;
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // A pending write may still be unwinding after process cancellation.
    }
  }
}

function applicationDirectory(root: string): string {
  if (root === ".") return "/workspace/app";
  // eslint-disable-next-line no-control-regex -- The working directory must reject control characters.
  if (!root || root.length > 2048 || /[\\\x00-\x1f\x7f]/u.test(root))
    throw new Error("preview_configuration_invalid");
  const excluded = new Set([
    "node_modules",
    ".next",
    ".astro",
    ".wrangler",
    ".vite",
    ".tanstack",
    ".git",
  ]);
  if (
    root
      .split("/")
      .some(
        (part) =>
          !part ||
          part.length > 255 ||
          part === "." ||
          part === ".." ||
          excluded.has(part) ||
          part.startsWith(".ohmyhost-preview-"),
      )
  )
    throw new Error("preview_configuration_invalid");
  return `/workspace/app/${root}`;
}

/** Delivery uses private exec; the helper and resulting filesystem remain untrusted VM state. */
export function createSourceWriter(
  container: PreviewContainer,
  signal?: AbortSignal,
): SourceWriter {
  return {
    async apply(operations: readonly SourceOperation[]): Promise<void> {
      for (const operation of operations) {
        const command = await launch(
          container,
          [
            "/usr/local/bin/preview-source",
            operation.kind,
            operation.path,
            ...(operation.kind === "write" ? [operation.executable ? "1" : "0"] : []),
          ],
          { user: "0:0", stdin: "pipe", stdout: "ignore", stderr: "ignore", env: BASE_ENV },
          signal,
          30_000,
        );
        try {
          await writeInput(command, operation.kind === "write" ? operation.bytes : undefined);
        } catch {
          throw new Error("preview_source_outcome_unknown");
        } finally {
          command.finish();
        }
      }
    },
  };
}

/** Only predefined package-manager argv is used; source content is never a shell command. */
export function installArgv(
  install: NonNullable<PreviewSourceResult["install"]>,
): readonly string[] {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(install.version))
    throw new Error("preview_install_configuration_invalid");
  if (install.manager === "pnpm")
    return [
      "/opt/ohmyhost-platform/bin/corepack",
      `pnpm@${install.version}`,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--config.package-import-method=copy",
      "--store-dir=/workspace/home/pnpm-store",
      "--prefer-offline",
    ];
  if (install.manager === "npm")
    return [
      "npm",
      "exec",
      "--cache=/workspace/home/npm-cache",
      "--prefer-offline",
      "--yes",
      "--ignore-scripts",
      `--package=npm@${install.version}`,
      "--",
      "npm",
      "ci",
      "--cache=/workspace/home/npm-cache",
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ];
  if (install.manager === "yarn")
    return [
      "/opt/ohmyhost-platform/bin/corepack",
      `yarn@${install.version}`,
      "install",
      "--immutable",
      "--mode=skip-build",
    ];
  if (install.manager === "bun" && install.version === "1.2.22")
    return ["/opt/ohmyhost-platform/bin/bun", "install", "--frozen-lockfile", "--ignore-scripts"];
  throw new Error("preview_install_configuration_invalid");
}

export async function installDependencies(
  container: PreviewContainer,
  result: PreviewSourceResult,
  signal?: AbortSignal,
): Promise<void> {
  if (!result.install) throw new Error("preview_install_configuration_invalid");
  const cwd = applicationDirectory(result.install.applicationRoot);
  const argv = installArgv(result.install);
  const seed =
    "set -eu; mkdir -p /workspace/home/.cache/node; if [ -d /opt/preview-seed/pnpm-store ] && [ ! -e /workspace/home/pnpm-store ]; then cp -a /opt/preview-seed/pnpm-store /workspace/home/; fi; if [ -d /opt/preview-seed/npm-cache ] && [ ! -e /workspace/home/npm-cache ]; then cp -a /opt/preview-seed/npm-cache /workspace/home/; fi; if [ -d /home/ohmyho-preview/.cache/node/corepack ] && [ ! -e /workspace/home/.cache/node/corepack ]; then cp -a /home/ohmyho-preview/.cache/node/corepack /workspace/home/.cache/node/; fi; chown -R 10001:10001 /workspace/home";
  await run(
    container,
    ["/bin/sh", "-c", seed],
    { user: "0:0", stdout: "ignore", stderr: "ignore", env: BASE_ENV },
    signal,
    DEADLINE_MS,
  );
  await run(
    container,
    argv,
    { user: "10001:10001", cwd, stdout: "ignore", stderr: "ignore", env: BASE_ENV },
    signal,
    DEADLINE_MS,
  );
}

export async function prepareWorkspace(
  container: PreviewContainer,
  signal?: AbortSignal,
): Promise<void> {
  const script =
    "set -eu; mkdir -p /workspace/app/node_modules /workspace/app/.next /workspace/app/.astro /workspace/app/.wrangler /workspace/app/.vite /workspace/app/.tanstack /workspace/home /workspace/runtime/.wrangler /workspace/runtime/source-write; chown -R 10001:10001 /workspace/app /workspace/home /workspace/runtime/.wrangler; chown 0:0 /workspace/runtime/source-write; chmod 700 /workspace/runtime/source-write; chmod 755 /workspace /workspace/app /workspace/runtime";
  await run(
    container,
    ["/bin/sh", "-c", script],
    { user: "0:0", stdout: "ignore", stderr: "ignore", env: BASE_ENV },
    signal,
    30_000,
  );
}
export async function prepareApplicationCaches(
  container: PreviewContainer,
  applicationRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  applicationDirectory(applicationRoot);
  await run(
    container,
    ["/usr/local/bin/preview-source", "prepare-caches", applicationRoot],
    { user: "0:0", stdout: "ignore", stderr: "ignore", env: BASE_ENV },
    signal,
    30_000,
  );
}

/** Configuration contains only source-derived plan and declared customer variables. */
export async function prepareFramework(
  container: PreviewContainer,
  previewId: string,
  publicOrigin: string,
  source: PreviewSourceResult,
  variables: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<void> {
  const plan = source.inspection.frameworkPlan;
  applicationDirectory(plan.applicationRoot);
  const metadata = {
    sessionId: previewId,
    applicationRoot: plan.applicationRoot,
    adapter: plan.adapter,
    runtime: plan.runtime,
    previewOrigin: publicOrigin,
    compatibilityDate: plan.compatibilityDate ?? "2026-08-21",
    compatibilityFlags: plan.compatibilityFlags ?? ["nodejs_compat"],
    capabilityBindings: {
      database: plan.database.enabled,
      auth: plan.auth.provider === "omh-native",
      mail: plan.mail.enabled,
      storage: plan.storage.enabled,
      ai: plan.ai?.enabled === true,
    },
    environment: {},
    runtimeVariables: variables,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (bytes.byteLength > 1024 * 1024) throw new Error("preview_configuration_invalid");
  const command = await launch(
    container,
    ["node", "/opt/ohmyho/apps/preview-runtime/container/prepare.mjs"],
    { user: "0:0", stdin: "pipe", stdout: "ignore", stderr: "ignore", env: BASE_ENV },
    signal,
    30_000,
  );
  try {
    await writeInput(command, bytes);
  } finally {
    command.finish();
  }
}

export async function startFramework(
  container: PreviewContainer,
  publicOrigin: string,
  applicationRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const cwd = applicationDirectory(applicationRoot);
  const target = new URL(publicOrigin);
  target.protocol = "http:";
  target.pathname = "/";
  const command = await launch(
    container,
    ["node", "/opt/ohmyho/apps/preview-runtime/container/serve.mjs"],
    { user: "10001:10001", cwd, stdout: "ignore", stderr: "ignore", env: BASE_ENV },
    signal,
    DEADLINE_MS,
  );
  let exited = false;
  const exit = command.process.exitCode.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  try {
    while (!command.signal.aborted) {
      if (exited) throw new Error("preview_framework_failed");
      const request = new AbortController();
      const abortRequest = () => request.abort();
      command.signal.addEventListener("abort", abortRequest, { once: true });
      const timer = setTimeout(abortRequest, 5_000);
      try {
        const response = await waitFor(
          Promise.race([
            Promise.resolve().then(() =>
              container.getTcpPort(3001).fetch(new Request(target, { signal: request.signal })),
            ),
            exit,
          ]),
          request.signal,
        );
        if (!response) throw new Error("preview_framework_failed");
        if (response.body) void response.body.cancel().catch(() => undefined);
        if (response.status === 200) {
          command.keepRunning();
          return;
        }
      } catch {
        if (command.signal.aborted) throw aborted();
        if (exited) throw new Error("preview_framework_failed");
        // A bounded non-overlapping readiness request may precede server startup.
      } finally {
        request.abort();
        clearTimeout(timer);
        command.signal.removeEventListener("abort", abortRequest);
      }
      await waitFor(new Promise<void>((resolve) => setTimeout(resolve, 250)), command.signal);
    }
    throw aborted();
  } catch (error) {
    command.stop();
    command.finish();
    if (command.timedOut()) throw new Error("preview_framework_not_ready");
    throw error;
  }
}
