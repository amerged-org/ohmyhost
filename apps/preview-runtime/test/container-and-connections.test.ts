import { expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
  createSourceWriter,
  installArgv,
  installDependencies,
  prepareApplicationCaches,
  prepareFramework,
  prepareWorkspace,
  startFramework,
} from "../src/container.js";
import { PreviewConnections } from "../src/connections.js";
import { hashPreviewToken, previewId, unavailable } from "../src/protocol.js";
import { statusPage } from "../src/status-page.js";
import type { PreviewContainer, PreviewSourceResult } from "../src/runtime-types.js";

it("launches pinned commands directly in the selected project VM with bounded context", async () => {
  const calls: {
    command: readonly string[];
    options: Parameters<PreviewContainer["exec"]>[1];
    bytes: Uint8Array[];
  }[] = [];
  const container = {
    async exec(command: readonly string[], options: Parameters<PreviewContainer["exec"]>[1]) {
      const call = { command, options, bytes: [] as Uint8Array[] };
      calls.push(call);
      return {
        stdin: new WritableStream<Uint8Array>({
          write(bytes) {
            call.bytes.push(bytes);
          },
        }),
        exitCode: command.includes("/opt/ohmyho/apps/preview-runtime/container/serve.mjs")
          ? new Promise<number>(() => {})
          : Promise.resolve(0),
      };
    },
    getTcpPort() {
      return {
        fetch: async () =>
          new Response(
            new ReadableStream({
              cancel: async () => {
                throw new Error("guest stream gone");
              },
            }),
          ),
      };
    },
  } as unknown as PreviewContainer;
  const source = {
    to: {
      sourceConnectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceGeneration: 1,
      sequence: 1,
      commitSha: "a".repeat(40),
    },
    install: {
      applicationRoot: "apps/web",
      manager: "pnpm",
      version: "10.28.2",
      lockfile: "pnpm-lock.yaml",
      command: "ignored",
    },
    inspection: {
      frameworkPlan: {
        applicationRoot: "apps/web",
        adapter: "vite-static",
        runtime: "static",
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: false },
        storage: { enabled: false },
      },
    },
  } as unknown as PreviewSourceResult;
  const controller = new AbortController();
  await prepareWorkspace(container, controller.signal);
  await prepareApplicationCaches(container, "apps/web", controller.signal);
  await createSourceWriter(container, controller.signal).apply([
    {
      kind: "write",
      path: "src/tool.sh",
      bytes: new Uint8Array([1, 2]),
      sha256: "a".repeat(64),
      executable: true,
    },
    { kind: "delete", path: "src/old" },
  ]);
  await installDependencies(container, source, controller.signal);
  await prepareFramework(
    container,
    source.to.sourceConnectionId,
    "https://preview.example",
    source,
    { CUSTOMER_VALUE: "allowed" },
    controller.signal,
  );
  await startFramework(container, "https://preview.example", "apps/web", controller.signal);
  expect(
    calls.some(
      (call) => call.command.join(" ") === "/usr/local/bin/preview-source write src/tool.sh 1",
    ),
  ).toBe(true);
  const install = calls.find((call) => call.command.includes("--ignore-pnpmfile"));
  if (!source.install) throw new Error("missing install plan");
  expect(install?.command).toEqual(installArgv(source.install));
  expect(install?.options).toMatchObject({
    user: "10001:10001",
    cwd: "/workspace/app/apps/web",
    stdout: "ignore",
    stderr: "ignore",
  });
  const serve = calls.find((call) =>
    call.command.includes("/opt/ohmyho/apps/preview-runtime/container/serve.mjs"),
  );
  expect(serve?.command).toEqual(["node", "/opt/ohmyho/apps/preview-runtime/container/serve.mjs"]);
  expect(serve?.options).toMatchObject({ user: "10001:10001", cwd: "/workspace/app/apps/web" });
  expect(Object.keys(install?.options.env ?? {}).sort()).toEqual(
    [
      "ASTRO_TELEMETRY_DISABLED",
      "CI",
      "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV",
      "COREPACK_HOME",
      "HOME",
      "NEXT_TELEMETRY_DISABLED",
      "NODE_EXTRA_CA_CERTS",
      "PATH",
      "WRANGLER_SEND_METRICS",
    ].sort(),
  );
  const configure = calls.find((call) =>
    call.command.includes("/opt/ohmyho/apps/preview-runtime/container/prepare.mjs"),
  );
  expect(JSON.parse(new TextDecoder().decode(configure?.bytes[0]))).toMatchObject({
    runtimeVariables: { CUSTOMER_VALUE: "allowed" },
  });
  for (const manager of ["npm", "yarn", "bun"] as const)
    expect(
      installArgv({
        applicationRoot: ".",
        manager,
        version: manager === "bun" ? "1.2.22" : "1.2.3",
        lockfile: "lock",
        command: "ignored",
      }),
    ).toEqual(
      manager === "npm"
        ? [
            "npm",
            "exec",
            "--cache=/workspace/home/npm-cache",
            "--prefer-offline",
            "--yes",
            "--ignore-scripts",
            "--package=npm@1.2.3",
            "--",
            "npm",
            "ci",
            "--cache=/workspace/home/npm-cache",
            "--prefer-offline",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
          ]
        : manager === "yarn"
          ? [
              "/opt/ohmyhost-platform/bin/corepack",
              "yarn@1.2.3",
              "install",
              "--immutable",
              "--mode=skip-build",
            ]
          : ["/opt/ohmyhost-platform/bin/bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    );
  expect(() =>
    installArgv({
      applicationRoot: ".",
      manager: "bun",
      version: "9.9.9",
      lockfile: "lock",
      command: "ignored",
    }),
  ).toThrow("preview_install_configuration_invalid");
  await expect(startFramework(container, "https://preview.example", "../outside")).rejects.toThrow(
    "preview_configuration_invalid",
  );
  controller.abort();
  for (const call of calls) expect(call.options.signal?.aborted).toBe(call === serve);
});

it("reports direct execution failures and cancels pending guest operations", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const source = {
    install: { applicationRoot: ".", manager: "pnpm", version: "10.28.2" },
  } as unknown as PreviewSourceResult;
  try {
    const exec = vi.fn<PreviewContainer["exec"]>(async (command) => ({
      stdin: null,
      stderr: new ReadableStream({
        start: (controller) =>
          controller.enqueue(
            new TextEncoder().encode("preview_containment_unsupported:landlock_abi\nsecret-value"),
          ),
      }),
      exitCode: Promise.resolve(command[0] === "/bin/sh" ? 0 : 125),
    }));
    await expect(
      installDependencies({ exec } as unknown as PreviewContainer, source),
    ).rejects.toThrow("preview_container_command_failed");
    expect(exec.mock.calls[1]?.[1]).toMatchObject({ stdout: "ignore", stderr: "ignore" });
    expect(report).not.toHaveBeenCalled();
    const failing = {
      async exec() {
        return { exitCode: Promise.resolve(125) };
      },
      getTcpPort() {
        return { fetch: async () => new Response(null, { status: 503 }) };
      },
    } as unknown as PreviewContainer;
    vi.useFakeTimers();
    const outcome = expect(startFramework(failing, "https://preview.example", ".")).rejects.toThrow(
      "preview_framework_failed",
    );
    await vi.advanceTimersByTimeAsync(250);
    await outcome;
    const lost = {
      async exec() {
        return { exitCode: Promise.reject(new Error("lost process")) };
      },
      getTcpPort() {
        return { fetch: async () => new Response(null, { status: 503 }) };
      },
    } as unknown as PreviewContainer;
    const lostOutcome = expect(
      startFramework(lost, "https://preview.example", "."),
    ).rejects.toThrow("preview_framework_failed");
    await vi.advanceTimersByTimeAsync(250);
    await lostOutcome;
    const processExit = Promise.withResolvers<number>();
    let orphanedRequest: Request | undefined;
    const exitsDuringReadiness = {
      async exec() {
        return { exitCode: processExit.promise };
      },
      getTcpPort() {
        return {
          fetch(request: Request) {
            orphanedRequest = request;
            return new Promise<Response>(() => {});
          },
        };
      },
    } as unknown as PreviewContainer;
    const exiting = expect(
      startFramework(exitsDuringReadiness, "https://preview.example", "."),
    ).rejects.toThrow("preview_framework_failed");
    for (let i = 0; i < 8 && !orphanedRequest; i++) await Promise.resolve();
    expect(orphanedRequest).toBeDefined();
    processExit.resolve(1);
    await exiting;
    expect(orphanedRequest?.signal.aborted).toBe(true);
    let checks = 0;
    const warming = {
      async exec() {
        return { exitCode: new Promise<number>(() => {}) };
      },
      getTcpPort() {
        return { fetch: async () => new Response(null, { status: ++checks === 1 ? 503 : 200 }) };
      },
    } as unknown as PreviewContainer;
    const ready = startFramework(warming, "https://preview.example", ".");
    await vi.advanceTimersByTimeAsync(250);
    await expect(ready).resolves.toBeUndefined();
    expect(checks).toBe(2);
  } finally {
    vi.useRealTimers();
    report.mockRestore();
  }
  const never = () => new Promise<never>(() => {});
  const abortWrite = vi.fn(() => Promise.reject(new Error("guest stream gone")));
  const releaseLock = vi.fn();
  const signals: AbortSignal[] = [];
  const writing = {
    async exec(_command: readonly string[], options: Parameters<PreviewContainer["exec"]>[1]) {
      if (!options.signal) throw new Error("missing exec signal");
      signals.push(options.signal);
      return {
        stdin: {
          getWriter: () => ({ write: never, close: never, abort: abortWrite, releaseLock }),
        },
        exitCode: never(),
      };
    },
  } as unknown as PreviewContainer;
  const first = new AbortController();
  const writeResult = createSourceWriter(writing, first.signal).apply([
    {
      kind: "write",
      path: "src/a",
      bytes: new Uint8Array([1]),
      sha256: "a".repeat(64),
      executable: false,
    },
  ]);
  await Promise.resolve();
  await Promise.resolve();
  first.abort();
  await expect(writeResult).rejects.toThrow();
  expect(signals[0]?.aborted).toBe(true);
  expect(abortWrite).toHaveBeenCalled();
  expect(releaseLock).toHaveBeenCalled();

  const second = new AbortController();
  const waiting = prepareWorkspace(writing, second.signal);
  await Promise.resolve();
  await Promise.resolve();
  second.abort();
  await expect(waiting).rejects.toThrow();
  expect(signals[1]?.aborted).toBe(true);

  let requestSignal: AbortSignal | undefined;
  const readiness = {
    ...writing,
    getTcpPort() {
      return {
        fetch(request: Request) {
          requestSignal = request.signal;
          return never();
        },
      };
    },
  } as unknown as PreviewContainer;
  const third = new AbortController();
  const starting = startFramework(readiness, "https://preview.example", ".", third.signal);
  for (let i = 0; i < 4 && !requestSignal; i++) await Promise.resolve();
  third.abort();
  await expect(starting).rejects.toThrow();
  expect(requestSignal?.aborted).toBe(true);
  expect(signals[2]?.aborted).toBe(true);

  const fourth = new AbortController();
  fourth.abort();
  await expect(prepareWorkspace(writing, fourth.signal)).rejects.toThrow();
  expect(signals).toHaveLength(3);

  const fifth = new AbortController();
  let pendingSignal: AbortSignal | undefined;
  const pendingExec = {
    exec(_command: readonly string[], options: Parameters<PreviewContainer["exec"]>[1]) {
      pendingSignal = options.signal;
      return never();
    },
  } as unknown as PreviewContainer;
  const pending = prepareWorkspace(pendingExec, fifth.signal);
  fifth.abort();
  await expect(pending).rejects.toThrow();
  expect(pendingSignal?.aborted).toBe(true);

  const sixth = new AbortController();
  const racesAbort = {
    exec() {
      sixth.abort();
      return Promise.reject(new Error("guest launch gone"));
    },
  } as unknown as PreviewContainer;
  await expect(prepareWorkspace(racesAbort, sixth.signal)).rejects.toThrow();
  await expect(
    prepareWorkspace({
      exec: async () => {
        throw new Error("guest launch gone");
      },
    } as unknown as PreviewContainer),
  ).rejects.toThrow();

  vi.useFakeTimers();
  try {
    const timed = expect(prepareWorkspace(writing)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await timed;
    expect(signals.at(-1)?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("relays and closes fenced WebSockets without renewing activity", () => {
  class Socket {
    listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    sent: unknown[] = [];
    closed = false;
    binaryType: BinaryType = "blob";
    acceptedBinaryType: BinaryType | null = null;
    accept() {
      this.acceptedBinaryType = this.binaryType;
    }
    send(value: unknown) {
      this.sent.push(value instanceof Blob ? String(value) : value);
    }
    close() {
      this.closed = true;
    }
    addEventListener(type: string, listener: (event: { data: unknown }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: string, data?: string | ArrayBuffer) {
      const delivered =
        data instanceof ArrayBuffer && this.binaryType === "blob" ? new Blob([data]) : data;
      for (const listener of this.listeners.get(type) ?? []) listener({ data: delivered });
    }
  }
  let pair: [Socket, Socket] = [new Socket(), new Socket()];
  const NativeResponse = globalThis.Response;
  class WebSocketResponse extends NativeResponse {
    public override readonly webSocket: WebSocket | null;
    constructor(
      body: BodyInit | null,
      init: Omit<ResponseInit, "webSocket"> & { webSocket?: Socket },
    ) {
      super(body, {
        status: init.status === 101 ? 200 : (init.status ?? 200),
        ...(init.headers === undefined ? {} : { headers: init.headers }),
      });
      this.webSocket = (init.webSocket as unknown as WebSocket | undefined) ?? null;
      if (init.status === 101) Object.defineProperty(this, "status", { value: 101 });
    }
  }
  vi.stubGlobal("Response", WebSocketResponse);
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0: Socket;
      1: Socket;
      constructor() {
        this[0] = new Socket();
        this[1] = new Socket();
        pair = [this[0], this[1]];
      }
    },
  );
  try {
    const upstream = new Socket(),
      connections = new PreviewConnections();
    const response = {
      status: 101,
      webSocket: upstream,
      headers: new Headers(),
      body: null,
    } as unknown as Response;
    connections.wrap(response, 7);
    pair[1].emit("message", "hello");
    expect(upstream.sent).toEqual(["hello"]);
    upstream.emit("message", "world");
    expect(pair[1].sent).toEqual(["world"]);
    const clientBytes = new Uint8Array([0, 1, 2, 255]).buffer;
    const serverBytes = new Uint8Array([255, 3, 0, 4]).buffer;
    pair[1].emit("message", clientBytes);
    upstream.emit("message", serverBytes);
    expect(upstream.sent[1]).toEqual(clientBytes);
    expect(pair[1].sent[1]).toEqual(serverBytes);
    expect(upstream.acceptedBinaryType).toBe("arraybuffer");
    expect(pair[1].acceptedBinaryType).toBe("arraybuffer");
    connections.closeGeneration(6);
    expect(upstream.closed || pair[1].closed).toBe(false);
    connections.closeGeneration(7);
    expect(upstream.closed && pair[1].closed).toBe(true);
    upstream.emit("message", "late");
    expect(pair[1].sent).toHaveLength(2);
    connections.closeAll();
    expect(upstream.closed && pair[1].closed).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps status and capability identity responses private", async () => {
  expect(previewId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toHaveLength(26);
  expect(await hashPreviewToken("a".repeat(52))).toMatch(/^[a-f0-9]{64}$/u);
  expect(unavailable(404).headers.get("cache-control")).toBe("no-store");
  expect(statusPage("admission").headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  const ready = new PreviewConnections().wrap(new Response("app"), 1);
  expect(ready.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(ready.headers.get("referrer-policy")).toBe("no-referrer");
  const headers = new Headers();
  headers.append("set-cookie", "safe=1; Path=/");
  headers.append("set-cookie", "unsafe=1; Domain=example.test");
  const connections = new PreviewConnections();
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      throw new Error("upstream already gone");
    },
  });
  const response = connections.wrap(new Response(stream, { headers }), 2);
  expect(response.headers.getSetCookie()).toEqual(["safe=1; Path=/"]);
  connections.closeGeneration(2);
  if (!response.body) throw new Error("missing response stream");
  await expect(response.body.getReader().read()).resolves.toMatchObject({ done: true });
});

it("waits for an accepted wake to leave sleep before stopping status polling", async () => {
  async function page(
    phase: "sleeping" | "starting",
    states: { state: string; failure?: string }[],
  ) {
    const html = await statusPage(phase).text();
    const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
    if (!script) throw new Error("missing status script");
    const message = { textContent: "" };
    const timers: (() => void)[] = [];
    let click: (() => Promise<void>) | undefined;
    const button = {
      disabled: false,
      hidden: phase !== "sleeping",
      addEventListener(_name: string, callback: () => Promise<void>) {
        click = callback;
      },
    };
    const reload = vi.fn();
    const fetch = vi.fn(async (path: string, options?: { method?: string }) => {
      if (path === "/__ohmyhost/preview/wake") {
        expect(options?.method).toBe("POST");
        return { ok: true, json: async () => ({ state: "starting" }) };
      }
      expect(path).toBe("/__ohmyhost/preview/status");
      const state = states.shift();
      if (!state) throw new Error("missing status response");
      return { ok: true, json: async () => state };
    });
    runInNewContext(script, {
      document: { getElementById: (name: string) => (name === "status" ? message : button) },
      fetch,
      location: { reload },
      setTimeout(callback: () => void, delay: number) {
        expect(delay).toBe(500);
        timers.push(callback);
      },
    });
    const flush = async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    const poll = async () => {
      const callback = timers.shift();
      if (!callback) throw new Error("missing status poll");
      callback();
      await flush();
    };
    return { button, click: () => click?.(), fetch, flush, message, poll, reload, timers };
  }

  const wake = await page("sleeping", [
    { state: "sleeping" },
    { state: "cold" },
    { state: "starting" },
    { state: "ready" },
  ]);
  await wake.flush();
  expect(wake.fetch).not.toHaveBeenCalled();
  expect(wake.timers).toHaveLength(0);
  await wake.click();
  await wake.flush();
  expect(wake.timers).toHaveLength(1);
  await wake.poll();
  await wake.poll();
  await wake.poll();
  expect(wake.reload).toHaveBeenCalledOnce();
  expect(wake.fetch.mock.calls.map(([path]) => path)).toEqual([
    "/__ohmyhost/preview/wake",
    "/__ohmyhost/preview/status",
    "/__ohmyhost/preview/status",
    "/__ohmyhost/preview/status",
    "/__ohmyhost/preview/status",
  ]);

  const initial = await page("starting", [
    { state: "cold" },
    { state: "starting" },
    { state: "ready" },
  ]);
  await initial.flush();
  await initial.poll();
  await initial.poll();
  expect(initial.reload).toHaveBeenCalledOnce();
  expect(initial.fetch.mock.calls.every(([path]) => path === "/__ohmyhost/preview/status")).toBe(
    true,
  );

  const stopped = await page("starting", [{ state: "starting" }, { state: "sleeping" }]);
  await stopped.flush();
  await stopped.poll();
  expect(stopped.message.textContent).toBe("This preview is sleeping.");
  expect(stopped.button.hidden).toBe(false);
  expect(stopped.timers).toHaveLength(0);

  const failed = await page("starting", [{ state: "cold", failure: "startup" }]);
  await failed.flush();
  expect(failed.message.textContent).toBe("The preview could not start. Try again.");
  expect(failed.button.hidden).toBe(false);
  expect(failed.timers).toHaveLength(0);
});
