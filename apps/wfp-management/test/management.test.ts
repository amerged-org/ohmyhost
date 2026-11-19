import type { WfpDeploymentReceipt } from "@ohmyhost/provider-cloudflare";
import type { SharedGatewayReceipt as WfpProjectGatewayReceipt } from "@ohmyhost/platform";
import type { GatewayRegistry } from "../src/gateway-registry.js";
import { APPLICATION_ROOT_CONFORMANCE_CORPUS } from "@ohmyhost/contracts";
import {
  createPinnedStorageGatewayOrigin,
  parsePinnedStorageGatewayOrigin,
} from "@ohmyhost/contracts/platform-origins";
import {
  CloudflareWfpProvider,
  CloudflareWfpSecretSyncUncertainError,
  CloudflareWfpUncertainError,
  WFP_CANDIDATE_LAYOUT_TAG,
  createRuntimeSecretManifest,
  computeBindingSetDigest,
  computeDatabaseBindingDigest,
  computeNativeAuthBindingDigest,
  computeNextCacheBindingDigest,
  computeStorageBindingDigest,
} from "@ohmyhost/provider-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  normalizeBrowserPolicy,
  type BrowserPolicy,
} from "@ohmyhost/contracts/browser-capabilities";

import {
  WfpManagementInputError,
  assetContentType,
  browserPolicyFromAssetHeaders,
  createEdgeRuntimeWrapperSource,
  createWfpManagement,
  type WfpManagementProvider,
} from "../src/index.js";

const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const DEPLOYMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const PROMOTION_ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const PROMOTION_DEPLOYMENT = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const PROVIDER_ID = "c941e51e3e47428e88648ef8304b5c1f";
const DATABASE_REGISTRATION = Object.freeze({
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  physicalEnvironmentId: ENVIRONMENT,
  registrationVersion: 1,
  region: "us" as const,
  provider: "pgcf" as const,
  providerProjectId: "pgcf-project",
  databaseId: "a".repeat(20),
  originHost: "sql.pgcf.example",
  originDatabase: "a".repeat(20),
  originUser: `ohmyho_rw_${ENVIRONMENT.toLowerCase()}`,
  authorizedEnvironmentIds: [ENVIRONMENT, PROMOTION_ENVIRONMENT],
  status: "active" as const,
});
const {
  provider: _provider,
  databaseId: _databaseId,
  ...PHYSICAL_REGISTRATION
} = DATABASE_REGISTRATION;
void _provider;
void _databaseId;
const NEON_REGISTRATION = Object.freeze({
  ...PHYSICAL_REGISTRATION,
  providerProjectId: "neon-project",
  branchId: "br-runtime",
  originHost: "ep-runtime-pooler.c-5.us-east-2.aws.neon.tech",
  originDatabase: "neondb" as const,
});
const STORAGE_BUCKET = `ohmyho-${PROJECT.toLowerCase()}-${ENVIRONMENT.toLowerCase()}`;
const NOW = new Date("2026-08-19T20:00:00.000Z");
const encoder = new TextEncoder();
const SANDBOX_GATEWAY_BINDINGS = {
  DATABASE_SERVICE_US: "ohmyho-project-database-sandbox-us",
  DATABASE_SERVICE_EU: "ohmyho-project-database-sandbox-eu",
  WFP_MAIL_GATEWAY_SERVICE: "ohmyho-mail-gateway-sandbox",
  WFP_MAIL_GATEWAY_ORIGIN: "https://ohmyho-mail-gateway-sandbox.your-omh-account.workers.dev",
  WFP_STORAGE_GATEWAY_ORIGIN: "https://ohmyho-storage-gateway-sandbox.your-omh-account.workers.dev",
  WFP_AI_GATEWAY_ORIGIN: "https://ai.dev.ohmyho.st",
} as const;

function lifecycleEvidence(
  buildId: string,
  runtime: "static" | "edge" | "functions",
  framework: string,
) {
  return {
    configurationDigest: "0".repeat(64),
    frozenInstall: {
      packageManager: "pnpm",
      packageManagerVersion: "10.28.2",
      lockfile: "pnpm-lock.yaml",
      lockfileSha256: "5".repeat(64),
      installCommandSha256: "6".repeat(64),
      dependencyInventorySha256: "7".repeat(64),
    },
    frameworkBuild: {
      framework,
      runtime,
      buildCommandSha256: "8".repeat(64),
      frameworkPlanSha256: "2".repeat(64),
      buildOutputSha256: "9".repeat(64),
    },
    buildSandbox: {
      buildId,
      projectName: "ohmyho-sandbox-build",
      buildInputFingerprint: "a".repeat(64),
      sourceArchiveSha256: "1".repeat(64),
      terminalStatus: "SUCCEEDED" as const,
    },
    credentialScan: {
      scannerSha256: "b".repeat(64),
      rulesSha256: "c".repeat(64),
      findingsCount: 0 as const,
    },
  };
}

it("creates the production root-preserving edge wrapper", () => {
  const source = createEdgeRuntimeWrapperSource({
    kind: "cloudflare-worker",
    mainModule: "index.js",
    compatibilityDate: "2026-08-21",
    compatibilityFlags: ["nodejs_compat"],
    entryWrapperVersion: "nextjs-opennext-wrapper-v1",
  });

  expect(source).toContain('import userWorker from "./index.js"');
  expect(source).not.toContain("basePath");
  expect(source).toContain("userWorker.fetch(request, environment, context)");
  expect(source).toContain('headers.set("x-ohmyhost-runtime", "edge-v1")');
});

it("buffers opted-in Next responses behind request tasks and refuses failure, oversize and timeout", async () => {
  const source = (enabled: boolean) =>
    createEdgeRuntimeWrapperSource({
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "nextjs-opennext-wrapper-v1",
      ...(enabled ? { nextRevalidatePath: true as const } : {}),
    }).replace(
      'import userWorker from "./index.js";',
      "const userWorker = { fetch: (...args) => globalThis.__nextBarrierFixture(...args) };",
    );
  type FixtureContext = {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
    props: { scope: string };
  };
  const global = globalThis as typeof globalThis & {
    __nextBarrierFixture?: (
      request: Request,
      environment: unknown,
      context: FixtureContext,
    ) => Promise<Response>;
  };
  const registrySymbol = Symbol.for("ohmyhost.next.response-tasks/v1");
  const tracker = () =>
    Reflect.get(globalThis, registrySymbol) as WeakMap<object, Set<Promise<unknown>>>;
  const request = new Request("https://example.test/");
  const wrapper = await loadWrapper(source(true));
  try {
    const completion = Promise.withResolvers<undefined>();
    global.__nextBarrierFixture = async (_request, _environment, context) => {
      tracker().get(context)?.add(completion.promise);
      return new Response("complete");
    };
    let settled = false;
    const waiting = wrapper.fetch(request, {}, {}).then((response) => {
      settled = true;
      return response;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    completion.resolve(undefined);
    const successful = await waiting;
    expect(successful.status).toBe(200);
    expect(await successful.text()).toBe("complete");
    let emitted = 0;
    global.__nextBarrierFixture = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (emitted++ === 50_000) controller.close();
            else controller.enqueue(Uint8Array.of(65));
          },
        }),
      );
    const smallChunks = await wrapper.fetch(request, {}, {});
    expect((await smallChunks.arrayBuffer()).byteLength).toBe(50_000);

    const waitUntilGate = Promise.withResolvers<undefined>();
    let boundContext = false;
    const forwarded: Promise<unknown>[] = [];
    global.__nextBarrierFixture = async (_request, _environment, context) => {
      context.waitUntil(waitUntilGate.promise);
      context.passThroughOnException();
      return Response.json({ scope: context.props.scope });
    };
    const originalContext = {
      props: { scope: "same-request" },
      waitUntil(promise: Promise<unknown>) {
        forwarded.push(promise);
      },
      passThroughOnException() {
        boundContext = this === originalContext;
      },
    };
    let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
    const delayedContext = await Promise.race([
      wrapper.fetch(request, {}, originalContext),
      new Promise<never>((_, reject) => {
        backgroundTimer = setTimeout(
          () => reject(new Error("background work blocked response")),
          500,
        );
      }),
    ]);
    clearTimeout(backgroundTimer);
    expect(await delayedContext.json()).toEqual({ scope: "same-request" });
    expect(boundContext).toBe(true);
    expect(forwarded).toEqual([waitUntilGate.promise]);
    waitUntilGate.resolve(undefined);
    global.__nextBarrierFixture = async (_request, _environment, context) => {
      context.waitUntil(Promise.reject(new Error("unrelated analytics failure")));
      return new Response("ok");
    };
    expect((await wrapper.fetch(request, {}, originalContext)).status).toBe(200);

    global.__nextBarrierFixture = async (incoming, _environment, context) => {
      const task =
        incoming.headers.get("x-case") === "fail"
          ? Promise.reject(new Error("one request failed"))
          : Promise.resolve();
      task.catch(() => undefined);
      tracker().get(context)?.add(task);
      return new Response(incoming.headers.get("x-case"));
    };
    const [bad, good] = await Promise.all([
      wrapper.fetch(new Request(request, { headers: { "x-case": "fail" } }), {}, {}),
      wrapper.fetch(new Request(request, { headers: { "x-case": "ok" } }), {}, {}),
    ]);
    expect([bad.status, good.status]).toEqual([503, 200]);
    expect(await good.text()).toBe("ok");

    global.__nextBarrierFixture = async (_request, _environment, context) => {
      const rejected = Promise.reject(new Error("private cache failure"));
      rejected.catch(() => undefined);
      tracker().get(context)?.add(rejected);
      return new Response("private output");
    };
    const failed = await wrapper.fetch(request, {}, {});
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private");

    let cancelled = false;
    global.__nextBarrierFixture = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    expect((await wrapper.fetch(request, {}, {})).status).toBe(503);
    expect(cancelled).toBe(true);

    vi.useFakeTimers();
    cancelled = false;
    global.__nextBarrierFixture = async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => undefined);
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    const slow = wrapper.fetch(request, {}, {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await slow).status).toBe(503);
    expect(cancelled).toBe(true);
    let aborted = false;
    global.__nextBarrierFixture = async (incoming) =>
      new Promise((_resolve, reject) => {
        incoming.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("request aborted"));
        });
      });
    const beforeHeaders = wrapper.fetch(request, {}, {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await beforeHeaders).status).toBe(503);
    expect(aborted).toBe(true);

    cancelled = false;
    global.__nextBarrierFixture = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(0));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    const shortDeadlineSource = source(true).replace(
      "const nextResponseDeadlineMs = 30000;",
      "const nextResponseDeadlineMs = 10;",
    );
    expect(shortDeadlineSource).not.toBe(source(true));
    const emptyStream = (await loadWrapper(shortDeadlineSource)).fetch(request, {}, {});
    await vi.advanceTimersByTimeAsync(10);
    expect((await emptyStream).status).toBe(503);
    expect(cancelled).toBe(true);
    vi.useRealTimers();

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    global.__nextBarrierFixture = async () =>
      new Response(
        new ReadableStream({
          start(value) {
            controller = value;
          },
        }),
      );
    const readonly = await loadWrapper(source(false));
    const streamed = await readonly.fetch(request, {}, {});
    controller?.enqueue(new TextEncoder().encode("streamed"));
    controller?.close();
    expect(await streamed.text()).toBe("streamed");

    const cfSource = source(true).replace(
      "const userWorker = { fetch: (...args) => globalThis.__nextBarrierFixture(...args) };",
      "const userWorker = { fetch(request) { return Response.json({ country: request.cf?.country }); } };",
    );
    const cfWorker = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: "next-cf-fixture",
            modules: [{ type: "ESModule", path: "entry.mjs", contents: cfSource }],
            compatibilityDate: "2026-08-21",
            compatibilityFlags: ["nodejs_compat"],
          },
        ],
      }),
    );
    try {
      const result = await cfWorker.dispatchFetch("https://fixture.test/", {
        cf: { country: "NL" },
      } as never);
      expect(await result.json()).toEqual({ country: "NL" });
    } finally {
      await cfWorker.dispose();
    }
  } finally {
    vi.useRealTimers();
    delete global.__nextBarrierFixture;
    Reflect.deleteProperty(globalThis, registrySymbol);
  }
});

it.each([
  "functions-v1",
  "vite-api-companion-v1",
  "astro-edge-wrapper-v1",
  "tanstack-edge-wrapper-v1",
  "nextjs-opennext-wrapper-v1",
] as const)(
  "refuses private OpenNext cache requests before the %s handler",
  async (entryWrapperVersion) => {
    const source = createEdgeRuntimeWrapperSource({
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2026-08-25",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion,
    }).replace(
      'import userWorker from "./index.js";',
      `const userWorker = { fetch(request, environment) {
      environment.requests.push(request.url);
      return new Response("customer route");
    } };`,
    );
    const wrapper = await loadWrapper(source);
    const environment = { requests: [] as string[] };
    const paths = [
      "/cdn-cgi/_next_cache",
      "/cdn-cgi/_next_cache/build/index.cache",
      "/cdn-cgi/_next_cache/build/about.json?download=1",
      "/cdn-cgi/_next_cache/build/about.rsc",
      "/%63dn-cgi/%5fnext_cache/build/index.cache",
      "/cdn-cgi%2f_next_cache%2fbuild%2findex.cache",
      "/%2fcdn-cgi//_next_cache/build/index.cache",
      "/cdn-cgi/%255fnext_cache/build/index.cache",
      "/cdn-cgi%252f_next_cache%252fbuild%252findex.cache",
      "/cdn-cgi%5c_next_cache%5cbuild%5cindex.cache",
      "/cdn-cgi%255c_next_cache%255cbuild%255cindex.cache",
      "/public/../cdn-cgi/_next_cache/build/index.cache",
      "/public/%2e%2e/cdn-cgi/_next_cache/build/index.cache",
      "/public%2f..%2fcdn-cgi%2f_next_cache%2fbuild%2findex.cache",
      "/public%252f%252e%252e%252fcdn-cgi%252f_next_cache%252fbuild%252findex.cache",
      "/cdn-cgi/child%2f..%2f_next_cache/build/index.cache",
      "/cdn-cgi//_next_cache/build/index.cache",
      "/cdn-cgi/_next_cache/build/invalid%zz.cache",
    ];
    for (const path of paths) {
      for (const method of ["GET", "HEAD", "POST"]) {
        const response = await wrapper.fetch(
          new Request(`https://customer.example.test${path}`, { method }),
          environment,
          {},
        );
        expect(response.status, `${method} ${path}`).toBe(404);
        await expect(response.text()).resolves.toBe("");
      }
    }
    expect(environment.requests).toEqual([]);
    for (const path of [
      "/",
      "/_next/static/chunks/main.js",
      "/_next/image?url=%2Fimages%2Flogo.png&w=640&q=75",
      "/cdn-cgi/_next_cache-public/app.js",
      "/app/_next_cache/about.json",
      "/public/%E0%A4%A",
      "/support?path=/cdn-cgi/_next_cache/build/index.cache",
    ]) {
      const request = new Request(`https://customer.example.test${path}`);
      const response = await wrapper.fetch(request, environment, {});
      expect(response.status, path).toBe(200);
      expect(environment.requests.at(-1)).toBe(request.url);
    }
  },
);

it("keeps private OpenNext cache assets available only through each Worker's internal binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-private-next-cache-"));
  let miniflare: Miniflare | undefined;
  try {
    const workers = await Promise.all(
      ["first", "second"].map(async (tenant) => {
        const assets = join(directory, tenant, "assets");
        await mkdir(join(assets, "cdn-cgi", "_next_cache", "build"), { recursive: true });
        await mkdir(join(assets, "_next", "static"), { recursive: true });
        await writeFile(
          join(assets, "cdn-cgi", "_next_cache", "build", "about.cache"),
          JSON.stringify({ html: `<h1>${tenant}</h1>`, rsc: `private-server-tree-${tenant}` }),
        );
        await writeFile(
          join(assets, "cdn-cgi", "_next_cache", "build", "about.json"),
          JSON.stringify({ privateProps: tenant }),
        );
        await writeFile(
          join(assets, "cdn-cgi", "_next_cache", "build", "about.rsc"),
          `private-server-tree-${tenant}`,
        );
        await writeFile(join(assets, "_next", "static", "main.js"), `/* ${tenant} */`);
        const customer = `export default {
          async fetch(request, environment) {
            if (new URL(request.url).pathname === "/about") {
              const cached = await environment.ASSETS.fetch(new Request("https://other-tenant.example.test/cdn-cgi/_next_cache/build/about.cache"));
              const page = await cached.json();
              return new Response(page.html, { headers: { "content-type": "text/html", "x-customer-entered": "${tenant}" } });
            }
            const asset = await environment.ASSETS.fetch(request);
            const response = new Response(asset.body, asset);
            response.headers.set("x-customer-entered", "${tenant}");
            return response;
          }
        };`;
        return {
          name: tenant,
          routes: [`${tenant}.cache.example.test/*`],
          assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
          modules: [
            {
              type: "ESModule" as const,
              path: join(directory, tenant, "ohmyhost-entry.mjs"),
              contents: createEdgeRuntimeWrapperSource({
                kind: "cloudflare-worker",
                mainModule: "index.js",
                compatibilityDate: "2026-08-25",
                compatibilityFlags: ["nodejs_compat"],
                entryWrapperVersion: "nextjs-opennext-wrapper-v1",
              }),
            },
            {
              type: "ESModule" as const,
              path: join(directory, tenant, "index.js"),
              contents: customer,
            },
          ],
          compatibilityDate: "2026-08-25",
          compatibilityFlags: ["nodejs_compat"],
        };
      }),
    );
    for (const configuration of workers) {
      const tenant = configuration.name;
      // Each deployed user Worker owns its asset collection. Separate native runtimes avoid
      // Miniflare's multi-worker assets conversion sharing its first collection.
      miniflare = new Miniflare(
        convertV4MiniflareOptions({ rootPath: directory, cf: false, workers: [configuration] }),
      );
      const worker = await miniflare.getWorker(tenant);
      const origin = `https://${tenant}.cache.example.test`;
      for (const path of [
        "/cdn-cgi/_next_cache/build/about.cache",
        "/cdn-cgi/_next_cache/build/about.json",
        "/cdn-cgi/_next_cache/build/about.rsc",
        "/%63dn-cgi/%5fnext_cache/build/about.cache",
        "/cdn-cgi%2f_next_cache%2fbuild%2fabout.cache",
        "/cdn-cgi%252f_next_cache%252fbuild%252fabout.cache",
        "//cdn-cgi///_next_cache/build/about.cache",
        "/public%2f..%2fcdn-cgi%2f_next_cache%2fbuild%2fabout.cache",
      ]) {
        const response = await worker.fetch(`${origin}${path}`);
        expect(response.status, `${tenant} ${path}`).toBe(404);
        expect(response.headers.has("x-customer-entered")).toBe(false);
        await expect(response.text()).resolves.toBe("");
      }
      const page = await worker.fetch(`${origin}/about`);
      expect(page.status).toBe(200);
      expect(page.headers.get("x-customer-entered")).toBe(tenant);
      await expect(page.text()).resolves.toBe(`<h1>${tenant}</h1>`);
      const asset = await worker.fetch(`${origin}/_next/static/main.js`);
      expect(asset.status).toBe(200);
      await expect(asset.text()).resolves.toBe(`/* ${tenant} */`);
      expect(asset.headers.get("x-customer-entered")).toBe(tenant);
      await miniflare.dispose();
      miniflare = undefined;
    }
  } finally {
    await miniflare?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("preserves native upgrade and echo through every generated edge entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-edge-wrapper-websocket-"));
  const versions = [
    "functions-v1",
    "vite-api-companion-v1",
    "astro-edge-wrapper-v1",
    "tanstack-edge-wrapper-v1",
    "nextjs-opennext-wrapper-v1",
  ] as const;
  const customer = `export default {
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      const headers = new Headers({ "x-app-proof": "native-customer", "set-cookie": "app-session=host; Path=/; Secure; HttpOnly" });
      if (pathname === "/http") {
        headers.set("content-type", "text/plain; charset=utf-8");
        return new Response("ordinary UTF-8 ✓ response", { status: 201, headers });
      }
      if (pathname === "/html") {
        headers.set("content-type", "text/html; charset=utf-8");
        return new Response('<html><head></head><body><script id="hydrate">hydrate()</script><style id="theme">body{color:black}</style></body></html>', { headers });
      }
      if (request.headers.get("upgrade") !== "websocket") return new Response(null, { status: 426 });
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", event => pair[1].send(event.data));
      pair[1].addEventListener("close", () => { if (pair[1].readyState !== 3) pair[1].close(1000, "closed"); });
      headers.set("upgrade", "websocket");
      return new Response(null, { status: 101, headers, webSocket: pair[0] });
    },
    scheduled() {},
  };`;
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      cf: false,
      workers: [
        {
          name: "direct",
          routes: ["direct.wrapper.example.com/*"],
          modules: [{ type: "ESModule", path: join(directory, "direct.mjs"), contents: customer }],
          compatibilityDate: "2026-08-25",
        },
        ...versions.map((entryWrapperVersion) => ({
          name: entryWrapperVersion,
          routes: [`${entryWrapperVersion}.wrapper.example.com/*`],
          modules: [
            {
              type: "ESModule" as const,
              path: join(directory, entryWrapperVersion, "ohmyhost-entry.mjs"),
              contents: createEdgeRuntimeWrapperSource(
                {
                  kind: "cloudflare-worker",
                  mainModule: "index.js",
                  compatibilityDate: "2026-08-25",
                  compatibilityFlags: ["nodejs_compat"],
                  entryWrapperVersion,
                },
                false,
                { media: true, microphone: true },
              ),
            },
            {
              type: "ESModule" as const,
              path: join(directory, entryWrapperVersion, "index.js"),
              contents: customer,
            },
          ],
          compatibilityDate: "2026-08-25",
          compatibilityFlags: ["nodejs_compat"],
        })),
      ],
    }),
  );
  try {
    for (const name of ["direct", ...versions]) {
      const origin = `https://${name}.wrapper.example.com`;
      const response = await miniflare.dispatchFetch(`${origin}/socket`, {
        headers: { upgrade: "websocket", origin: "https://browser.example.com" },
      });
      expect(response.status, name).toBe(101);
      const socket = response.webSocket;
      expect(socket, name).not.toBeNull();
      if (socket === null) throw new Error("native_wrapper_socket_missing");
      expect(response.headers.get("upgrade"), name).toBe("websocket");
      expect(response.headers.get("x-app-proof"), name).toBe("native-customer");
      expect(response.headers.getSetCookie(), name).toEqual([
        "app-session=host; Path=/; Secure; HttpOnly",
      ]);
      expect(response.headers.get("x-ohmyhost-runtime"), name).toBe(
        name === "direct" ? null : "edge-v1",
      );
      socket.accept();
      const message = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("native_wrapper_echo_timeout")), 2000);
        socket.addEventListener(
          "message",
          (event) => {
            clearTimeout(timer);
            resolve(event.data);
          },
          { once: true },
        );
      });
      socket.send(name);
      await expect(message).resolves.toBe(name);
      socket.close(1000, "proof_complete");
      if (name === "direct") continue;
      const http = await miniflare.dispatchFetch(`${origin}/http`);
      expect(http.status, name).toBe(201);
      expect(http.webSocket, name).toBeNull();
      await expect(http.text()).resolves.toBe("ordinary UTF-8 ✓ response");
      expect(http.headers.get("x-ohmyhost-runtime"), name).toBe("edge-v1");
      expect(http.headers.get("content-security-policy"), name).toBeNull();
      expect(http.headers.get("permissions-policy"), name).toBeNull();
      const nonce = "a".repeat(32);
      const html = await miniflare.dispatchFetch(`${origin}/html`, {
        headers: { "x-nonce": nonce },
      });
      const body = await html.text();
      expect(html.headers.get("content-security-policy"), name).toBe("media-src 'self' blob:");
      expect(html.headers.get("permissions-policy"), name).toBe("microphone=(self)");
      const appliesNonce =
        name === "astro-edge-wrapper-v1" ||
        name === "tanstack-edge-wrapper-v1" ||
        name === "nextjs-opennext-wrapper-v1";
      expect(body.includes(`nonce="${nonce}"`), name).toBe(appliesNonce);
    }
  } finally {
    await miniflare.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("keeps a root-relative OpenNext image source on the public root origin", async () => {
  const source = createEdgeRuntimeWrapperSource({
    kind: "cloudflare-worker",
    mainModule: "index.js",
    compatibilityDate: "2026-08-21",
    compatibilityFlags: ["nodejs_compat"],
    entryWrapperVersion: "nextjs-opennext-wrapper-v1",
  }).replace(
    'import userWorker from "./index.js";',
    "const userWorker = { fetch(request) { return new Response(request.url); } };",
  );
  const executable = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const response = await executable.default.fetch(
    new Request(`https://gateway.example.test/_next/image?url=%2Fimages%2Flogo.png&w=640&q=75`),
    {},
    {},
  );

  await expect(response.text()).resolves.toBe(
    "https://gateway.example.test/_next/image?url=%2Fimages%2Flogo.png&w=640&q=75",
  );
});

it("keeps the TanStack root request at the public root", async () => {
  const source = createEdgeRuntimeWrapperSource({
    kind: "cloudflare-worker",
    mainModule: "index.js",
    compatibilityDate: "2026-08-21",
    compatibilityFlags: ["nodejs_compat"],
    entryWrapperVersion: "tanstack-edge-wrapper-v1",
  }).replace(
    'import userWorker from "./index.js";',
    "const userWorker = { fetch(request) { return new Response(new URL(request.url).pathname); } };",
  );
  const executable = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );

  const response = await executable.default.fetch(
    new Request("https://gateway.example.test/"),
    {},
    {},
  );

  await expect(response.text()).resolves.toBe("/");
});

it.each([
  "astro-edge-wrapper-v1",
  "tanstack-edge-wrapper-v1",
  "nextjs-opennext-wrapper-v1",
] as const)("applies the gateway CSP nonce to %s hydration markup", async (entryWrapperVersion) => {
  const nonce = "a".repeat(32);
  const source = createEdgeRuntimeWrapperSource({
    kind: "cloudflare-worker",
    mainModule: "index.js",
    compatibilityDate: "2026-08-21",
    compatibilityFlags: ["nodejs_compat"],
    entryWrapperVersion,
  }).replace(
    'import userWorker from "./index.js";',
    `globalThis.__nonceEvents = [];
class HTMLRewriter {
  handlers = [];
  on(selector, handler) { this.handlers.push([selector, handler]); return this; }
  transform(response) {
    for (const [selector, handler] of this.handlers) {
      handler.element({
        prepend(value, options) { globalThis.__nonceEvents.push([selector, "prepend", value, options?.html]); },
        setAttribute(name, value) { globalThis.__nonceEvents.push([selector, "setAttribute", name, value]); },
      });
    }
    return response;
  }
}
const userWorker = { fetch() { return new Response("<html><head></head><body><script>hydrate()</script></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }); } };`,
  );
  const executable = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${entryWrapperVersion}`
  );

  await executable.default.fetch(
    new Request("https://gateway.example.test/", { headers: { "x-nonce": nonce } }),
    {},
    {},
  );

  expect((globalThis as typeof globalThis & { __nonceEvents?: unknown[] }).__nonceEvents).toEqual([
    ["head", "prepend", `<meta property="csp-nonce" content="${nonce}">`, true],
    ["script", "setAttribute", "nonce", nonce],
    ["style", "setAttribute", "nonce", nonce],
  ]);
  delete (globalThis as typeof globalThis & { __nonceEvents?: unknown[] }).__nonceEvents;
  expect(source).not.toContain("unsafe-inline");
});

it("keeps Vite companion API routes at the root handler path", async () => {
  const source = createEdgeRuntimeWrapperSource({
    kind: "cloudflare-worker",
    mainModule: "index.js",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    entryWrapperVersion: "vite-api-companion-v1",
  }).replace(
    'import userWorker from "./index.js";',
    "const userWorker = { fetch(request) { return new Response(new URL(request.url).pathname); } };",
  );
  const executable = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );

  const response = await executable.default.fetch(
    new Request(`https://gateway.example.test/api/auth/session`),
    {},
    {},
  );

  await expect(response.text()).resolves.toBe("/api/auth/session");
});

it("carries only an exact global _headers browser opt-in on HTML responses", async () => {
  const policy = browserPolicyFromAssetHeaders(
    encoder.encode(`# Recorder policy
/*
  Content-Security-Policy: default-src 'none'; media-src 'self' blob:; script-src 'self'
  Permissions-Policy: camera=(), geolocation=(), microphone=(self)
`),
  );
  expect(policy).toEqual({ media: true, microphone: true });
  expect(
    browserPolicyFromAssetHeaders(
      encoder.encode(`/private/*
  Content-Security-Policy: media-src 'self' blob:
  Permissions-Policy: microphone=(self)
`),
    ),
  ).toEqual({ media: false, microphone: false });
  expect(
    browserPolicyFromAssetHeaders(
      encoder.encode(`/*
  Content-Security-Policy: media-src *
  Permissions-Policy: microphone=(*)
`),
    ),
  ).toEqual({ media: false, microphone: false });
  // Cloudflare serves an asset with its upload type; HTML must arrive typed for the opt-in.
  expect(assetContentType("/index.html")).toBe("text/html; charset=utf-8");
  expect(assetContentType("/docs/Guide.HTM")).toBe("text/html; charset=utf-8");
  expect(assetContentType("/assets/app.js")).toBe("text/javascript; charset=utf-8");
  expect(assetContentType("/vite.svg")).toBe("image/svg+xml");
  for (const path of ["/_headers", "/.well-known/security", "/archive.unknown", "/assets/.env"])
    expect(assetContentType(path)).toBe("application/null");

  const source = createEdgeRuntimeWrapperSource(
    {
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "vite-api-companion-v1",
    },
    false,
    policy,
  ).replace(
    'import userWorker from "./index.js";',
    `const userWorker = { fetch(request) { return new Response("ok", { headers: { "content-type": new URL(request.url).pathname === "/" ? "text/html" : "application/json" } }); } };`,
  );
  const wrapper = await loadWrapper(source);
  const html = await wrapper.fetch(new Request("https://gateway.example.test/"), {}, {});
  expect(html.headers.get("content-security-policy")).toBe("media-src 'self' blob:");
  expect(html.headers.get("permissions-policy")).toBe("microphone=(self)");
  const api = await wrapper.fetch(new Request("https://gateway.example.test/api"), {}, {});
  expect(api.headers.get("content-security-policy")).toBeNull();
  expect(api.headers.get("permissions-policy")).toBeNull();
});

type ScheduledGlobal = typeof globalThis & {
  __scheduledCalls?: unknown[];
  __workerModuleCron?: string;
};

async function loadWrapper(source: string) {
  const executable = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as {
    default: { fetch(request: Request, environment: unknown, context: unknown): Promise<Response> };
  };
  return executable.default;
}

const SCHEDULED_URL = "https://scheduled.ohmyhost.internal/.ohmyhost/scheduled";

it("dispatches declared crons from the internal scheduler origin to the scheduled handler", async () => {
  const calls: unknown[] = [];
  (globalThis as ScheduledGlobal).__scheduledCalls = calls;
  const wrapper = await loadWrapper(
    createEdgeRuntimeWrapperSource({
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "functions-v1",
    }).replace(
      'import userWorker from "./index.js";',
      `const userWorker = {
  fetch(request) { return new Response(new URL(request.url).pathname); },
  async scheduled(controller, environment, context) {
    globalThis.__scheduledCalls.push([controller.cron, controller.scheduledTime, controller.type, environment.MARK, context.MARK]);
    if (controller.cron === "0 3 * * *") { controller.noRetry(); throw new Error("permanent"); }
    if (controller.cron === "0 4 * * *") throw new Error("transient");
  },
};`,
    ),
  );
  const environment = {
    OHMYHOST_CRONS: '["*/5 * * * *","0 3 * * *","0 4 * * *"]',
    OHMYHOST_IMMUTABLE_SCRIPT_NAME: "p-x-dev-y",
    MARK: "env",
  };
  const invoke = (body: unknown, env: unknown = environment) =>
    wrapper.fetch(new Request(SCHEDULED_URL, { method: "POST", body: JSON.stringify(body) }), env, {
      MARK: "ctx",
    });
  const scheduledTime = Date.UTC(2026, 8, 15, 3, 0, 0);

  const succeeded = await invoke({
    cron: "*/5 * * * *",
    scheduledTime,
    immutableScriptName: "p-x-dev-y",
  });

  expect(succeeded.status).toBe(204);
  expect(calls).toEqual([["*/5 * * * *", scheduledTime, "scheduled", "env", "ctx"]]);
  expect(
    (await invoke({ cron: "0 3 * * *", scheduledTime, immutableScriptName: "p-x-dev-y" })).status,
  ).toBe(422);
  expect(
    (await invoke({ cron: "0 4 * * *", scheduledTime, immutableScriptName: "p-x-dev-y" })).status,
  ).toBe(500);
  expect(
    (await invoke({ cron: "0 5 * * *", scheduledTime, immutableScriptName: "p-x-dev-y" })).status,
  ).toBe(400);
  expect(
    (await invoke({ cron: "*/5 * * * *", scheduledTime, immutableScriptName: "p-x-dev-z" })).status,
  ).toBe(400);
  expect(
    (await invoke({ cron: "*/5 * * * *", scheduledTime: 1.5, immutableScriptName: "p-x-dev-y" }))
      .status,
  ).toBe(400);
  expect(
    (
      await invoke(
        { cron: "*/5 * * * *", scheduledTime, immutableScriptName: "p-x-dev-y" },
        { OHMYHOST_IMMUTABLE_SCRIPT_NAME: "p-x-dev-y" },
      )
    ).status,
  ).toBe(400);
  expect(
    (await wrapper.fetch(new Request(SCHEDULED_URL, { method: "GET" }), environment, {})).status,
  ).toBe(405);
  expect(
    (
      await wrapper.fetch(
        new Request("https://scheduled.ohmyhost.internal/other", { method: "POST" }),
        environment,
        {},
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await wrapper.fetch(
        new Request(SCHEDULED_URL, { method: "POST", body: "{" }),
        environment,
        {},
      )
    ).status,
  ).toBe(400);
  const publicResponse = await wrapper.fetch(
    new Request("https://gateway.example.test/.ohmyhost/scheduled", { method: "POST", body: "{}" }),
    environment,
    {},
  );
  await expect(publicResponse.text()).resolves.toBe("/.ohmyhost/scheduled");
  expect(calls).toHaveLength(3);
  delete (globalThis as ScheduledGlobal).__scheduledCalls;
});

it("answers 501 when declared crons meet a Worker module without a scheduled handler", async () => {
  const wrapper = await loadWrapper(
    createEdgeRuntimeWrapperSource({
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "vite-api-companion-v1",
    }).replace(
      'import userWorker from "./index.js";',
      'const userWorker = { fetch() { return new Response("app"); } };',
    ),
  );
  const response = await wrapper.fetch(
    new Request(SCHEDULED_URL, {
      method: "POST",
      body: JSON.stringify({ cron: "0 3 * * *", scheduledTime: 1, immutableScriptName: "p-a" }),
    }),
    { OHMYHOST_CRONS: '["0 3 * * *"]', OHMYHOST_IMMUTABLE_SCRIPT_NAME: "p-a" },
    {},
  );
  expect(response.status).toBe(501);
});

it("invokes the bundled Worker module's scheduled handler beside a framework module", async () => {
  const source = createEdgeRuntimeWrapperSource(
    {
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "nextjs-opennext-wrapper-v1",
    },
    true,
  );
  expect(source).toContain('import workerModule from "./ohmyhost-worker.js";');
  const wrapper = await loadWrapper(
    source
      .replace(
        'import userWorker from "./index.js";',
        'const userWorker = { fetch() { return new Response("app"); }, scheduled() { throw new Error("wrong module"); } };',
      )
      .replace(
        'import workerModule from "./ohmyhost-worker.js";',
        "const workerModule = { async scheduled(controller) { globalThis.__workerModuleCron = controller.cron; } };",
      ),
  );
  const response = await wrapper.fetch(
    new Request(SCHEDULED_URL, {
      method: "POST",
      body: JSON.stringify({ cron: "0 3 * * *", scheduledTime: 1, immutableScriptName: "p-a" }),
    }),
    { OHMYHOST_CRONS: '["0 3 * * *"]', OHMYHOST_IMMUTABLE_SCRIPT_NAME: "p-a" },
    {},
  );
  expect(response.status).toBe(204);
  expect((globalThis as ScheduledGlobal).__workerModuleCron).toBe("0 3 * * *");
  delete (globalThis as ScheduledGlobal).__workerModuleCron;
  expect(
    createEdgeRuntimeWrapperSource({
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "tanstack-edge-wrapper-v1",
    }),
  ).not.toContain("ohmyhost-worker.js");
});

const sha256 = async (body: Uint8Array): Promise<`sha256:${string}`> => {
  const digest = await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const tombstoneDigest = () =>
  sha256(
    encoder.encode(
      'export default { async fetch() { return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } }); } };\n',
    ),
  );

async function artifact(overrides: Record<string, unknown> = {}, framework = "vite") {
  const index = encoder.encode("<!doctype html><title>ok</title>");
  const javascript = encoder.encode("console.log('ok')");
  const sbomBody = encoder.encode(
    JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components: [] }),
  );
  const assets = [
    { path: "/assets/app.js", digest: await sha256(javascript), size: javascript.byteLength },
    { path: "/index.html", digest: await sha256(index), size: index.byteLength },
  ];
  const applicationRoot = Object.hasOwn(overrides, "applicationRoot")
    ? overrides["applicationRoot"]
    : "site";
  const runtimePolicy = Object.hasOwn(overrides, "runtimePolicy")
    ? overrides["runtimePolicy"]
    : { healthCheckPath: "/", egressAllowedOrigins: [] };
  const planEvidence = {
    applicationRoot: applicationRoot as never,
    frameworkPlanSchemaVersion: "ohmyhost.framework-plan/v5" as const,
    runtimePolicy: runtimePolicy as {
      healthCheckPath: string;
      egressAllowedOrigins: string[];
    },
    database: { enabled: false as const },
    auth: { provider: "none" as const },
    storage: { enabled: false as const },
  };
  const artifactDigest = await sha256(encoder.encode(JSON.stringify({ ...planEvidence, assets })));
  const manifest = {
    schemaVersion: "ohmyhost.artifact/v3",
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    deploymentId: DEPLOYMENT,
    operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    buildId: "ohmyho-sandbox:build-1",
    sourceCommit: "c".repeat(40),
    sourceDigest: `sha256:${"1".repeat(64)}`,
    buildPlanDigest: `sha256:${"2".repeat(64)}`,
    lifecycleEvidence: lifecycleEvidence("ohmyho-sandbox:build-1", "static", framework),
    ...planEvidence,
    artifactDigest,
    sbom: { path: "sbom.cdx.json", digest: await sha256(sbomBody) },
    assets,
    ...overrides,
  };
  const manifestBody = encoder.encode(JSON.stringify(manifest));
  const manifestDigest = await sha256(manifestBody);
  return {
    manifestDigest,
    manifestBody,
    sbomBody,
    files: [
      { path: "/index.html", body: index },
      { path: "/assets/app.js", body: javascript },
    ],
    runtime: null,
    modules: [],
    migrations: [],
    provenance: {
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      },
      deploymentId: DEPLOYMENT,
      buildId: "ohmyho-sandbox:build-1",
      sourceCommit: "c".repeat(40),
      sourceDigest: `sha256:${"1".repeat(64)}`,
      buildPlanDigest: `sha256:${"2".repeat(64)}`,
      lifecycleEvidence: lifecycleEvidence("ohmyho-sandbox:build-1", "static", framework),
      ...planEvidence,
      artifactDigest,
      output: {
        bucket: "ohmyho-sandbox-builds",
        key: `runs/${PROJECT}/${ENVIRONMENT}/01ARZ3NDEKTSV4RRFFQ69G5FAZ/output/bundle.tar.gz`,
        versionId: "version-1",
        eTag: '"etag"',
        byteLength: 1,
        sha256: "f".repeat(64),
      },
    },
  } satisfies import("../src/index.js").VerifiedArtifactBundle;
}

async function artifactWithMigrations() {
  const bundle = await artifact();
  const mutable = bundle as unknown as {
    manifestBody: Uint8Array;
    manifestDigest: `sha256:${string}`;
    migrations: Array<{
      path: string;
      digest: `sha256:${string}`;
      size: number;
      body: Uint8Array;
    }>;
    provenance: Record<string, unknown>;
  };
  const migrationBody = encoder.encode("create table source_bound(id bigint);\n");
  const migration = {
    path: "20260821090000_source_bound.sql",
    digest: await sha256(migrationBody),
    size: migrationBody.byteLength,
  };
  const manifest = JSON.parse(new TextDecoder().decode(bundle.manifestBody)) as Record<
    string,
    unknown
  >;
  const database = { enabled: true, migrations: "supabase/migrations" } as const;
  manifest["database"] = database;
  manifest["migrations"] = [migration];
  manifest["artifactDigest"] = await sha256(
    encoder.encode(
      JSON.stringify({
        applicationRoot: manifest["applicationRoot"],
        frameworkPlanSchemaVersion: manifest["frameworkPlanSchemaVersion"],
        runtimePolicy: manifest["runtimePolicy"],
        database,
        auth: manifest["auth"],
        storage: manifest["storage"],
        migrations: [migration],
        assets: manifest["assets"],
      }),
    ),
  );
  mutable.manifestBody = encoder.encode(JSON.stringify(manifest));
  mutable.manifestDigest = await sha256(mutable.manifestBody);
  mutable.migrations = [{ ...migration, body: migrationBody }];
  mutable.provenance = {
    ...mutable.provenance,
    database,
    artifactDigest: manifest["artifactDigest"] as `sha256:${string}`,
  };
  return bundle;
}

async function artifactWithDuplicateAssetContent() {
  const bundle = await artifact();
  const mutable = bundle as unknown as {
    manifestBody: Uint8Array;
    manifestDigest: `sha256:${string}`;
    files: Array<{ path: string; body: Uint8Array }>;
    provenance: Record<string, unknown>;
  };
  const manifest = JSON.parse(new TextDecoder().decode(bundle.manifestBody)) as Record<
    string,
    unknown
  >;
  const assets = manifest["assets"] as Array<{
    path: string;
    digest: `sha256:${string}`;
    size: number;
  }>;
  const index = assets.find((asset) => asset.path === "/index.html");
  if (index === undefined) throw new Error("Missing index fixture");
  const duplicate = { ...index, path: "/index-copy.html" };
  const nextAssets = [...assets, duplicate].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  manifest["assets"] = nextAssets;
  manifest["artifactDigest"] = await sha256(
    encoder.encode(
      JSON.stringify({
        applicationRoot: manifest["applicationRoot"],
        frameworkPlanSchemaVersion: manifest["frameworkPlanSchemaVersion"],
        runtimePolicy: manifest["runtimePolicy"],
        database: manifest["database"],
        auth: manifest["auth"],
        storage: manifest["storage"],
        assets: nextAssets,
      }),
    ),
  );
  mutable.manifestBody = encoder.encode(JSON.stringify(manifest));
  mutable.manifestDigest = await sha256(mutable.manifestBody);
  const indexBody = mutable.files.find((file) => file.path === "/index.html")?.body;
  if (indexBody === undefined) throw new Error("Missing index body fixture");
  mutable.files.push({ path: duplicate.path, body: indexBody });
  mutable.provenance = {
    ...mutable.provenance,
    artifactDigest: manifest["artifactDigest"],
  };
  return bundle;
}

async function artifactWithCustomerAuth(
  options: {
    readonly entryWrapperVersion?:
      | "astro-edge-wrapper-v1"
      | "tanstack-edge-wrapper-v1"
      | "nextjs-opennext-wrapper-v1"
      | "vite-api-companion-v1";
    readonly deployment?: "embedded" | "companion";
    readonly storage?: boolean;
    readonly databaseBindingName?: "OHMYHOST_DATABASE" | "HYPERDRIVE";
  } = {},
) {
  const entryWrapperVersion = options.entryWrapperVersion ?? "tanstack-edge-wrapper-v1";
  const bundle = await edgeArtifact(
    entryWrapperVersion,
    undefined,
    entryWrapperVersion === "vite-api-companion-v1"
      ? "2025-01-01"
      : entryWrapperVersion === "astro-edge-wrapper-v1"
        ? "2026-10-12"
        : "2026-08-21",
  );
  const mutable = bundle as unknown as {
    manifestBody: Uint8Array;
    manifestDigest: `sha256:${string}`;
    migrations: Array<{
      path: string;
      digest: `sha256:${string}`;
      size: number;
      body: Uint8Array;
    }>;
    provenance: Record<string, unknown>;
  };
  const migrationBody = encoder.encode("create table source_bound(id bigint);\n");
  const migration = {
    path: "20260821090000_source_bound.sql",
    digest: await sha256(migrationBody),
    size: migrationBody.byteLength,
  };
  const manifest = JSON.parse(new TextDecoder().decode(bundle.manifestBody)) as Record<
    string,
    unknown
  >;
  const database = { enabled: true, migrations: "supabase/migrations" } as const;
  const auth = {
    provider: "better-auth",
    version: "1.7.7",
    deployment: options.deployment ?? "embedded",
    routePath: "/api/auth",
    databaseSchema: "auth",
    databaseBindingName: options.databaseBindingName ?? "OHMYHOST_DATABASE",
    authSecretName: "BETTER_AUTH_SECRET",
  } as const;
  manifest["database"] = database;
  manifest["migrations"] = [migration];
  manifest["auth"] = auth;
  const storage = options.storage
    ? { enabled: true, provider: "r2", jurisdiction: "eu", public: false }
    : { enabled: false };
  manifest["storage"] = storage;
  manifest["artifactDigest"] = await sha256(
    encoder.encode(
      JSON.stringify({
        applicationRoot: manifest["applicationRoot"],
        frameworkPlanSchemaVersion: manifest["frameworkPlanSchemaVersion"],
        runtimePolicy: manifest["runtimePolicy"],
        database,
        auth,
        storage,
        ...(manifest["functions"] === undefined ? {} : { functions: manifest["functions"] }),
        migrations: [migration],
        runtime: manifest["runtime"],
        assets: manifest["assets"],
        modules: manifest["modules"],
      }),
    ),
  );
  mutable.manifestBody = encoder.encode(JSON.stringify(manifest));
  mutable.manifestDigest = await sha256(mutable.manifestBody);
  mutable.migrations = [{ ...migration, body: migrationBody }];
  mutable.provenance = {
    ...mutable.provenance,
    database,
    auth,
    storage,
    ...(manifest["functions"] === undefined ? {} : { functions: manifest["functions"] }),
    artifactDigest: manifest["artifactDigest"],
  };
  return bundle;
}

async function edgeArtifact(
  entryWrapperVersion:
    | "astro-edge-wrapper-v1"
    | "tanstack-edge-wrapper-v1"
    | "nextjs-opennext-wrapper-v1"
    | "vite-api-companion-v1"
    | "functions-v1" = "tanstack-edge-wrapper-v1",
  mainBody?: Uint8Array,
  compatibilityDate = "2026-08-21",
  clientBody?: Uint8Array,
  wasmBody?: Uint8Array,
  extraModules: readonly {
    path: string;
    body: Uint8Array;
    contentType?: string;
    digest?: string;
    size?: number;
  }[] = [],
  browser?: BrowserPolicy,
  cacheQuota?: {
    readonly bytes: number;
    readonly assets: readonly { path: string; body: Uint8Array }[];
    readonly sbom?: Uint8Array;
    readonly framework?: string;
    readonly nextRevalidatePath?: boolean;
  },
) {
  const functionsRuntime = entryWrapperVersion === "functions-v1";
  const serverWorker = functionsRuntime || entryWrapperVersion === "vite-api-companion-v1";
  const client = clientBody ?? encoder.encode("console.log('client')");
  const main =
    mainBody ??
    encoder.encode(
      entryWrapperVersion === "vite-api-companion-v1"
        ? 'export default { fetch() { return new Response("vite"); } };\n'
        : functionsRuntime
          ? 'export default { fetch() { return new Response("fn"); }, async scheduled() {} };\n'
          : 'import chunk from "./assets/chunk.js"; export default chunk;\n',
    );
  const chunk = encoder.encode(
    'export default { async fetch() { return new Response("edge"); } };\n',
  );
  const sbomBody =
    cacheQuota?.sbom ??
    encoder.encode(
      JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components: [] }),
    );
  const extraAssets = cacheQuota?.assets ?? [];
  const assets = functionsRuntime
    ? []
    : [
        { path: "/assets/client.js", digest: await sha256(client), size: client.byteLength },
        ...(await Promise.all(
          extraAssets.map(async ({ path, body }) => ({
            path,
            digest: await sha256(body),
            size: body.byteLength,
          })),
        )),
      ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const mainModule = {
    path: "index.js",
    contentType: "application/javascript+module" as const,
    digest: await sha256(main),
    size: main.byteLength,
    body: main,
  };
  const modules: import("../src/index.js").VerifiedArtifactBundle["modules"][number][] =
    serverWorker
      ? [mainModule]
      : [
          {
            path: "assets/chunk.js",
            contentType: "application/javascript+module" as const,
            digest: await sha256(chunk),
            size: chunk.byteLength,
            body: chunk,
          },
          mainModule,
        ];
  if (wasmBody !== undefined) {
    modules.push({
      path: "codec.wasm",
      contentType: "application/wasm",
      digest: await sha256(wasmBody),
      size: wasmBody.byteLength,
      body: wasmBody,
    });
    modules.sort((left, right) => left.path.localeCompare(right.path));
  }
  for (const module of extraModules) {
    modules.push({
      ...module,
      contentType: (module.contentType ??
        "application/javascript+module") as (typeof modules)[number]["contentType"],
      digest: (module.digest ?? (await sha256(module.body))) as `sha256:${string}`,
      size: module.size ?? module.body.byteLength,
    });
  }
  modules.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const runtime = {
    kind: "cloudflare-worker" as const,
    mainModule: "index.js" as const,
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"] as const,
    entryWrapperVersion,
    ...(cacheQuota === undefined ? {} : { ssgCacheMaxBytes: cacheQuota.bytes }),
    ...(cacheQuota?.nextRevalidatePath ? { nextRevalidatePath: true as const } : {}),
  };
  const manifestModules = modules.map((module) => ({
    path: module.path,
    contentType: module.contentType,
    digest: module.digest,
    size: module.size,
  }));
  const planEvidence = {
    applicationRoot: "site" as never,
    frameworkPlanSchemaVersion: "ohmyhost.framework-plan/v5" as const,
    runtimePolicy: {
      healthCheckPath: "/",
      egressAllowedOrigins: [],
      ...(browser === undefined ? {} : { browser }),
    },
    database: { enabled: false as const },
    auth: { provider: "none" as const },
    storage: { enabled: false as const },
    ...(serverWorker ? { functions: { crons: ["*/5 * * * *"] } } : {}),
  };
  const evidence = lifecycleEvidence(
    "ohmyho-sandbox:build-edge",
    functionsRuntime ? "functions" : "edge",
    cacheQuota?.framework ??
      (functionsRuntime
        ? "functions"
        : entryWrapperVersion === "nextjs-opennext-wrapper-v1"
          ? "nextjs"
          : entryWrapperVersion === "vite-api-companion-v1"
            ? "vite"
            : entryWrapperVersion === "astro-edge-wrapper-v1"
              ? "astro"
              : "tanstack-start"),
  );
  const artifactDigest = await sha256(
    encoder.encode(JSON.stringify({ ...planEvidence, runtime, assets, modules: manifestModules })),
  );
  const manifest = {
    schemaVersion: "ohmyhost.artifact/v3",
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    deploymentId: DEPLOYMENT,
    operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    buildId: "ohmyho-sandbox:build-edge",
    sourceCommit: "c".repeat(40),
    sourceDigest: `sha256:${"1".repeat(64)}`,
    buildPlanDigest: `sha256:${"2".repeat(64)}`,
    lifecycleEvidence: evidence,
    ...planEvidence,
    artifactDigest,
    sbom: { path: "sbom.cdx.json", digest: await sha256(sbomBody) },
    runtime,
    assets,
    modules: manifestModules,
  };
  const manifestBody = encoder.encode(JSON.stringify(manifest));
  return {
    manifestDigest: await sha256(manifestBody),
    manifestBody,
    sbomBody,
    files: functionsRuntime ? [] : [{ path: "/assets/client.js", body: client }, ...extraAssets],
    runtime,
    modules,
    migrations: [],
    provenance: {
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      },
      deploymentId: DEPLOYMENT,
      buildId: "ohmyho-sandbox:build-edge",
      sourceCommit: "c".repeat(40),
      sourceDigest: `sha256:${"1".repeat(64)}`,
      buildPlanDigest: `sha256:${"2".repeat(64)}`,
      lifecycleEvidence: evidence,
      ...planEvidence,
      artifactDigest,
      output: {
        bucket: "ohmyho-sandbox-builds",
        key: `runs/${PROJECT}/${ENVIRONMENT}/01ARZ3NDEKTSV4RRFFQ69G5FAZ/output/bundle.tar.gz`,
        versionId: "version-edge",
        eTag: '"edge"',
        byteLength: 1,
        sha256: "e".repeat(64),
      },
    },
  } as import("../src/index.js").VerifiedArtifactBundle;
}

async function artifactWithStorage(
  entryWrapperVersion: Parameters<typeof edgeArtifact>[0] = "tanstack-edge-wrapper-v1",
) {
  const bundle = await edgeArtifact(
    entryWrapperVersion,
    undefined,
    entryWrapperVersion === "vite-api-companion-v1" || entryWrapperVersion === "functions-v1"
      ? "2025-01-01"
      : entryWrapperVersion === "astro-edge-wrapper-v1"
        ? "2026-10-12"
        : "2026-08-21",
  );
  const mutable = bundle as unknown as {
    manifestBody: Uint8Array;
    manifestDigest: `sha256:${string}`;
    provenance: Record<string, unknown>;
  };
  const manifest = JSON.parse(new TextDecoder().decode(bundle.manifestBody)) as Record<
    string,
    unknown
  >;
  const storage = {
    enabled: true,
    provider: "r2",
    jurisdiction: "us",
    public: false,
  } as const;
  manifest["storage"] = storage;
  manifest["artifactDigest"] = await sha256(
    encoder.encode(
      JSON.stringify({
        applicationRoot: manifest["applicationRoot"],
        frameworkPlanSchemaVersion: manifest["frameworkPlanSchemaVersion"],
        runtimePolicy: manifest["runtimePolicy"],
        database: manifest["database"],
        auth: manifest["auth"],
        storage,
        ...(manifest["functions"] === undefined ? {} : { functions: manifest["functions"] }),
        runtime: manifest["runtime"],
        assets: manifest["assets"],
        modules: manifest["modules"],
      }),
    ),
  );
  mutable.manifestBody = encoder.encode(JSON.stringify(manifest));
  mutable.manifestDigest = await sha256(mutable.manifestBody);
  mutable.provenance = {
    ...mutable.provenance,
    storage,
    artifactDigest: manifest["artifactDigest"],
  };
  return bundle;
}

function multipartMetadata(body: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(body);
  const match = /name="metadata"\r\nContent-Type: application\/json\r\n\r\n([^\r]+)\r\n/u.exec(
    text,
  );
  if (match?.[1] === undefined) throw new Error("Missing multipart metadata");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

/** The digest the upload boundary of counter `attempt` derives from, as the first 16 bytes. */
function attemptBoundary(attempt: number): string {
  return `ohmyhost-${(0x10 + attempt).toString(16).repeat(16)}`;
}

/** Replaces the SHA-256 of the boundary input (`<attempt>\n{...`) with the attempt's fixed digest. */
async function withAttemptDigests<T>(run: () => Promise<T>): Promise<T> {
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (algorithm, data: BufferSource) => {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const match = /^(\d)\n\{/u.exec(new TextDecoder().decode(bytes.subarray(0, 3)));
      if (match?.[1] === undefined) return realDigest(algorithm, data);
      return new Uint8Array(32).fill(0x10 + Number(match[1])).buffer;
    });
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

async function contentUpload(content: Uint8Array) {
  const inputArtifact = await edgeArtifact(
    "nextjs-opennext-wrapper-v1",
    undefined,
    "2026-08-21",
    undefined,
    undefined,
    [{ path: "content/article.md", body: content, contentType: "application/octet-stream" }],
  );
  const { management, provider: providerInstance } = harness();
  return {
    providerInstance,
    stage: async () =>
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: inputArtifact,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    publication: () => {
      const artifact = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
      if (artifact === undefined) throw new Error("Expected Worker publication");
      return artifact;
    },
  };
}

describe("verified build artifact provenance", () => {
  it("keeps selected private Next cache capacity separate from the public asset allowance", async () => {
    const mib = 1024 * 1024;
    const check = async (
      bytes: number,
      assets: readonly { path: string; body: Uint8Array }[],
      wrapper: Parameters<typeof edgeArtifact>[0] = "nextjs-opennext-wrapper-v1",
      sbom?: Uint8Array,
      trustedFramework?: string,
    ) => {
      const { management } = harness();
      return management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await edgeArtifact(
          wrapper,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
          undefined,
          {
            bytes,
            assets,
            ...(sbom === undefined ? {} : { sbom }),
            ...(trustedFramework === undefined ? {} : { framework: trustedFramework }),
          },
        ),
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      });
    };
    await expect(
      check(mib, [{ path: "/cdn-cgi/_next_cache/build/page.cache", body: new Uint8Array(mib) }]),
    ).resolves.toMatchObject({ status: "staged" });
    await expect(
      check(mib, [
        { path: "/cdn-cgi/_next_cache/build/page.cache", body: new Uint8Array(mib + 1) },
      ]),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    await expect(
      check(64 * mib, [
        ...[0, 1, 2].map((index) => ({
          path: `/public-${index}.bin`,
          body: new Uint8Array(8 * mib),
        })),
        { path: "/public-over.bin", body: new Uint8Array(mib) },
      ]),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    await expect(check(mib, [], "tanstack-edge-wrapper-v1")).rejects.toBeInstanceOf(
      WfpManagementInputError,
    );
    for (const framework of ["vite", "tanstack-start"]) {
      await expect(
        check(64 * mib, [], "nextjs-opennext-wrapper-v1", undefined, framework),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    await expect(
      check(mib, [], "tanstack-edge-wrapper-v1", undefined, "nextjs"),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    for (const padding of [Array.from({ length: 20_000 }, () => ({})), Array(70_000).fill(0)]) {
      await expect(
        check(
          mib,
          [],
          "nextjs-opennext-wrapper-v1",
          encoder.encode(
            JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, padding }),
          ),
        ),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    await expect(
      check(
        mib,
        [],
        "nextjs-opennext-wrapper-v1",
        encoder.encode(
          `{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"padding":${"[".repeat(65)}0${"]".repeat(65)}}`,
        ),
      ),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    await expect(
      check(
        mib,
        [],
        "nextjs-opennext-wrapper-v1",
        encoder.encode(
          JSON.stringify({
            bomFormat: "CycloneDX",
            specVersion: "1.6",
            version: 1,
            padding: '["quoted"],{"data":":"}'.repeat(20_000),
          }),
        ),
      ),
    ).resolves.toMatchObject({ status: "staged" });
  });

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted)(
    "accepts current publish application root: $name",
    async ({ value }) => {
      const { management } = harness();
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: await artifact({ applicationRoot: value }),
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).resolves.toMatchObject({ status: "staged" });
    },
  );

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected)(
    "rejects current publish application root: $name",
    async ({ value }) => {
      const { management } = harness();
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: await artifact({ applicationRoot: value }),
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    },
  );

  it.each([
    "applicationRoot",
    "frameworkPlanSchemaVersion",
    "runtimePolicy",
    "database",
    "auth",
    "storage",
  ] as const)("rejects current publish without provenance %s before mutation", async (field) => {
    const providerInstance = provider();
    const { management, fetch } = harness({ provider: providerInstance });
    const bundle = await artifact();
    (bundle as unknown as { provenance: Record<string, unknown> }).provenance = Object.fromEntries(
      Object.entries(bundle.provenance).filter(([key]) => key !== field),
    );
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: bundle,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.observeCandidate).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("independently accepts exact current root/schema evidence", async () => {
    const { management } = harness();
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await artifact(),
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).resolves.toMatchObject({ status: "staged" });
  });

  it("revalidates migration bytes without forwarding SQL to Cloudflare", async () => {
    const providerInstance = provider();
    const { management } = harness({ provider: providerInstance });
    const bundle = await artifactWithMigrations();

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: bundle,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        databaseRegistration: DATABASE_REGISTRATION,
        databaseOriginHost: DATABASE_REGISTRATION.originHost,
      }),
    ).resolves.toMatchObject({ status: "staged" });

    const published = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    expect(new TextDecoder().decode(published?.body)).not.toContain("create table source_bound");
    if (published === undefined) throw new Error("Expected database publication");
    // The PGCF database service answers over its own transport: no placement hint is sent.
    expect(multipartMetadata(published.body)["placement"]).toBeUndefined();
    expect(multipartMetadata(published.body)["bindings"]).toEqual([
      { type: "assets", name: "ASSETS" },
      {
        type: "service",
        name: "OHMYHOST_DATABASE",
        service: "ohmyho-project-database-sandbox-us",
        entrypoint: "ProjectDatabaseService",
        props: {
          organizationId: ORGANIZATION,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          physicalEnvironmentId: ENVIRONMENT,
          registrationVersion: 1,
          region: "us",
        },
      },
      // The database service answers only requests that name their own project, so an
      // application that has neither mail nor storage still needs to know which project it is.
      { type: "plain_text", name: "OHMYHOST_PROJECT_ID", text: PROJECT },
    ]);
    vi.mocked(providerInstance.stageCandidate).mockClear();
    for (const databaseRegistration of [
      { ...DATABASE_REGISTRATION, organizationId: OTHER_PROJECT },
      { ...DATABASE_REGISTRATION, projectId: OTHER_PROJECT },
      { ...DATABASE_REGISTRATION, authorizedEnvironmentIds: [PROMOTION_ENVIRONMENT] },
      { ...DATABASE_REGISTRATION, registrationVersion: 0 },
      { ...DATABASE_REGISTRATION, status: "revoked" },
      { ...DATABASE_REGISTRATION, originUser: "database_owner" },
      { ...DATABASE_REGISTRATION, connectionString: "postgres://private" },
      // A Neon registration can no longer back a database artifact.
      NEON_REGISTRATION,
    ]) {
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: bundle,
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
          databaseRegistration: databaseRegistration as never,
          databaseOriginHost: databaseRegistration.originHost,
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("rejects changed migration bytes before any Cloudflare mutation", async () => {
    const providerInstance = provider();
    const { management, fetch } = harness({ provider: providerInstance });
    const bundle = await artifactWithMigrations();
    const firstMigration = bundle.migrations[0];
    if (firstMigration === undefined) throw new Error("Expected migration fixture");
    (firstMigration as { body: Uint8Array }).body = encoder.encode("drop table source_bound;\n");

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: bundle,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("rejects a customer secret that collides with the project Hyperdrive binding", async () => {
    const providerInstance = provider();
    const { management, fetch } = harness({ provider: providerInstance });
    const value = "must-not-shadow-hyperdrive";
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await artifactWithMigrations(),
        knownDeployments: [],
        databaseRegistration: DATABASE_REGISTRATION,
        databaseOriginHost: DATABASE_REGISTRATION.originHost,
        runtimeSecretManifest: await createRuntimeSecretManifest([
          {
            name: "HYPERDRIVE",
            value,
            revision: 1,
            valueSha256: await sha256(encoder.encode(value)),
          },
        ]),
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("binds storage only through the authenticated private gateway", async () => {
    const providerInstance = provider();
    const { management } = harness({ provider: providerInstance });
    const value = "storage-gateway-key";

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await artifactWithStorage(),
        knownDeployments: [],
        runtimeSecretManifest: await createRuntimeSecretManifest([
          {
            name: "OHMYHOST_STORAGE_KEY",
            value,
            revision: 1,
            valueSha256: await sha256(encoder.encode(value)),
          },
        ]),
        storageBucketName: STORAGE_BUCKET,
        storageDataEnvironmentId: ENVIRONMENT,
      }),
    ).resolves.toMatchObject({ status: "staged" });

    expect(providerInstance.gatewayRegistry.activate).not.toHaveBeenCalled();
    const published = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (published === undefined) throw new Error("Expected storage publication");
    expect(multipartMetadata(published.body)["bindings"]).toEqual([
      {
        type: "service",
        name: "OHMYHOST_STORAGE_GATEWAY",
        service: "ohmyho-storage-gateway-sandbox",
        props: {
          organizationId: ORGANIZATION,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          dataEnvironmentId: ENVIRONMENT,
        },
      },
      {
        type: "plain_text",
        name: "OHMYHOST_STORAGE_GATEWAY_URL",
        text: createPinnedStorageGatewayOrigin(
          SANDBOX_GATEWAY_BINDINGS.WFP_STORAGE_GATEWAY_ORIGIN,
          {
            organizationId: ORGANIZATION,
            environmentId: ENVIRONMENT,
            dataEnvironmentId: ENVIRONMENT,
          },
        ),
      },
      { type: "plain_text", name: "OHMYHOST_ENVIRONMENT_ID", text: ENVIRONMENT },
      { type: "plain_text", name: "OHMYHOST_PROJECT_ID", text: PROJECT },
      { type: "secret_text", name: "OHMYHOST_STORAGE_KEY", text: value },
    ]);
  });

  it("freezes the trusted data area on every framework and never infers it from customer source", async () => {
    const dataEnvironmentId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
    const props = {
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      dataEnvironmentId,
    };
    const manifest = await createRuntimeSecretManifest([
      {
        name: "OHMYHOST_STORAGE_KEY",
        value: "s".repeat(43),
        revision: 1,
        valueSha256: await sha256(encoder.encode("s".repeat(43))),
      },
    ]);
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    for (const framework of [
      "vite-api-companion-v1",
      "nextjs-opennext-wrapper-v1",
      "astro-edge-wrapper-v1",
      "tanstack-edge-wrapper-v1",
      "functions-v1",
    ] as const) {
      const artifact = await artifactWithStorage(framework);
      const { management, provider: api } = harness();
      const result = await management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope,
        deploymentId: DEPLOYMENT,
        artifact,
        knownDeployments: [],
        runtimeSecretManifest: manifest,
        storageBucketName: STORAGE_BUCKET,
        storageDataEnvironmentId: dataEnvironmentId,
      });
      expect(result.status).toBe("staged");
      if (result.status !== "staged") throw new Error("Expected pinned storage publication");
      const pinnedOrigin = createPinnedStorageGatewayOrigin(
        SANDBOX_GATEWAY_BINDINGS.WFP_STORAGE_GATEWAY_ORIGIN,
        props,
      );
      expect(result.activationRuntimePolicy.egressAllowedOrigins).toContain(pinnedOrigin);
      expect(result.activationRuntimePolicy.egressAllowedOrigins).not.toContain(
        SANDBOX_GATEWAY_BINDINGS.WFP_STORAGE_GATEWAY_ORIGIN,
      );
      expect(parsePinnedStorageGatewayOrigin(pinnedOrigin)).toEqual({
        baseOrigin: SANDBOX_GATEWAY_BINDINGS.WFP_STORAGE_GATEWAY_ORIGIN,
        organizationId: ORGANIZATION,
        environmentId: ENVIRONMENT,
        dataEnvironmentId,
      });
      const published = vi.mocked(api.stageCandidate).mock.calls[0]?.[0].artifact;
      if (published === undefined) throw new Error("Expected scoped publication");
      expect(published.digest).toBe(artifact.provenance.artifactDigest);
      expect(published.platformBindings.storage?.props).toEqual(props);
      expect(multipartMetadata(published.body)["bindings"]).toContainEqual({
        type: "plain_text",
        name: "OHMYHOST_STORAGE_GATEWAY_URL",
        text: pinnedOrigin,
      });
      expect(multipartMetadata(published.body)["bindings"]).toContainEqual({
        type: "service",
        name: "OHMYHOST_STORAGE_GATEWAY",
        service: "ohmyho-storage-gateway-sandbox",
        props,
      });
      expect(multipartMetadata(published.body)["tags"]).toContain(
        `storage:${await sha256(encoder.encode(JSON.stringify(published.platformBindings.storage)))}`,
      );
    }
    const { management, fetch, provider: api } = harness();
    const artifact = await artifactWithStorage();
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope,
        deploymentId: DEPLOYMENT,
        artifact,
        knownDeployments: [],
        runtimeSecretManifest: manifest,
        storageBucketName: STORAGE_BUCKET,
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(fetch).not.toHaveBeenCalled();
    expect(api.stageCandidate).not.toHaveBeenCalled();
  });

  it("rejects missing, foreign, disabled-plan, keyless, and secret-colliding storage bindings", async () => {
    const value = "must-not-shadow-storage";
    const cases = [
      {
        artifact: await artifactWithStorage(),
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      },
      // A server Worker reaches storage only through the gateway key; no raw bucket binding exists.
      {
        artifact: await artifactWithStorage("vite-api-companion-v1"),
        storageBucketName: STORAGE_BUCKET,
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      },
      {
        artifact: await artifactWithStorage("functions-v1"),
        storageBucketName: STORAGE_BUCKET,
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      },
      {
        artifact: await artifactWithStorage(),
        storageBucketName: "ohmyho-foreign",
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      },
      {
        artifact: await artifactWithStorage(),
        storageBucketName: STORAGE_BUCKET,
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      },
      {
        artifact: await edgeArtifact(),
        storageBucketName: STORAGE_BUCKET,
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      },
      {
        artifact: await artifactWithStorage(),
        storageBucketName: STORAGE_BUCKET,
        runtimeSecretManifest: await createRuntimeSecretManifest([
          {
            name: "STORAGE",
            value,
            revision: 1,
            valueSha256: await sha256(encoder.encode(value)),
          },
        ]),
      },
    ];
    for (const input of cases) {
      const providerInstance = provider();
      const { management, fetch } = harness({ provider: providerInstance });
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          knownDeployments: [],
          ...input,
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
      expect(fetch).not.toHaveBeenCalled();
      expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
    }
  });

  it.each([
    { schemaVersion: "ohmyhost.artifact/v1" },
    { schemaVersion: "ohmyhost.artifact/v2" },
    { applicationRoot: "../site" },
    { frameworkPlanSchemaVersion: "ohmyhost.framework-plan/v1" },
    { auth: { provider: "better-auth", version: "latest" } },
    { auth: { provider: "better-auth", version: "1.7.7", deployment: "central" } },
    { auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" } },
    { storage: { enabled: true, provider: "r2", jurisdiction: "default", public: false } },
    { storage: { enabled: true, provider: "r2", jurisdiction: "eu", public: true } },
    { runtimePolicy: { healthCheckPath: "ready", egressAllowedOrigins: [] } },
    ...["mail", "storage"].map((gateway) => ({
      runtimePolicy: {
        healthCheckPath: "/ready",
        egressAllowedOrigins: [`https://ohmyho-${gateway}-gateway-decoy.test.workers.dev`],
      },
    })),
    {
      runtimePolicy: {
        healthCheckPath: "/ready",
        egressAllowedOrigins: ["https://127.0.0.1"],
      },
    },
    {
      runtimePolicy: {
        healthCheckPath: "/ready",
        egressAllowedOrigins: ["https://b.example.test", "https://a.example.test"],
      },
    },
  ])("rejects invalid current root/schema evidence %#", async (override) => {
    const { management, provider: providerInstance, fetch } = harness();
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await artifact(override),
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
    expect(providerInstance.syncRuntimeSecrets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a manifest without the immutable build identity", async () => {
    const instance = provider();
    const management = createWfpManagement({
      bindings: {
        WFP_ACCOUNT_ID: "a".repeat(32),
        WFP_DISPATCH_NAMESPACE: "ohmyho-sandbox",
        WFP_API_TOKEN: "token",
        WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
        ...SANDBOX_GATEWAY_BINDINGS,
      },
      provider: instance,
      gatewayRegistry: instance.gatewayRegistry,
      fetch: vi.fn(),
    });
    const bundle = await artifact({ operationId: undefined });
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: bundle,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
  });

  it("rejects cross-scope, build, source, plan, artifact and output-version provenance", async () => {
    const management = createWfpManagement({
      bindings: {
        WFP_ACCOUNT_ID: "a".repeat(32),
        WFP_DISPATCH_NAMESPACE: "ohmyho-sandbox",
        WFP_API_TOKEN: "token",
        WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
        ...SANDBOX_GATEWAY_BINDINGS,
      },
      provider: provider(),
      gatewayRegistry: provider().gatewayRegistry,
      fetch: vi.fn(),
    });
    const mutations = [
      (bundle: Awaited<ReturnType<typeof artifact>>) => {
        (bundle.provenance.scope as { projectId: string }).projectId = OTHER_PROJECT;
      },
      (bundle: Awaited<ReturnType<typeof artifact>>) => {
        (bundle.provenance as { buildId: string }).buildId = "other:build";
      },
      (bundle: Awaited<ReturnType<typeof artifact>>) => {
        (bundle.provenance as { sourceDigest: string }).sourceDigest = `sha256:${"e".repeat(64)}`;
      },
      (bundle: Awaited<ReturnType<typeof artifact>>) => {
        (bundle.provenance as { buildPlanDigest: string }).buildPlanDigest =
          `sha256:${"e".repeat(64)}`;
      },
      (bundle: Awaited<ReturnType<typeof artifact>>) => {
        (bundle.provenance as { artifactDigest: string }).artifactDigest =
          `sha256:${"e".repeat(64)}`;
      },
      (bundle: Awaited<ReturnType<typeof artifact>>) => {
        (bundle.provenance as { runtimePolicy: { healthCheckPath: string } }).runtimePolicy = {
          healthCheckPath: "/other",
        };
      },
      (bundle: Awaited<ReturnType<typeof artifact>>) => {
        (bundle.provenance.output as { versionId: string }).versionId = "";
      },
    ];
    for (const mutate of mutations) {
      const bundle = await artifact();
      mutate(bundle);
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: bundle,
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
  });
});

function receipt(overrides: Partial<WfpDeploymentReceipt> = {}): WfpDeploymentReceipt {
  return {
    provider: "cloudflare-wfp",
    namespace: "ohmyho-sandbox",
    scriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    productDeploymentId: DEPLOYMENT,
    providerTag: PROVIDER_ID,
    artifactDigest: `sha256:${"a".repeat(64)}`,
    buildReused: false,
    deployedAt: NOW,
    ...overrides,
  };
}

function gatewayReceipt(
  overrides: Partial<WfpProjectGatewayReceipt> = {},
): WfpProjectGatewayReceipt {
  return {
    provider: "ohmyhost-shared-gateway",
    organizationId: ORGANIZATION,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    environmentName: "dev",
    handle: "calm-river-studio",
    hostname: "dev-calm-river-studio.dev.check.omh.st",
    publicOrigin: "https://dev-calm-river-studio.dev.check.omh.st",
    targetScriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
    targetDeploymentId: DEPLOYMENT,
    targetArtifactDigest: `sha256:${"a".repeat(64)}`,
    targetProviderTag: PROVIDER_ID,
    egressPolicyDigest: `sha256:${"e".repeat(64)}`,
    egressAllowedOrigins: [],
    candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    revision: 1,
    predecessorRevision: null,
    operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    active: true,
    observedAt: NOW,
    ...overrides,
  };
}

type TestProvider = WfpManagementProvider & { gatewayRegistry: GatewayRegistry };

function provider(): TestProvider {
  return {
    stageCandidate: vi.fn(async (input) => {
      const bindings = input.artifact.platformBindings;
      const next = await computeNextCacheBindingDigest(
        bindings.nextCache,
        input.scope,
        input.artifact.deploymentId,
        "ohmyho-sandbox",
      );
      const combined = await computeBindingSetDigest(
        bindings.crons.length ? await sha256(encoder.encode(JSON.stringify(bindings.crons))) : null,
        await computeDatabaseBindingDigest(bindings.database, input.scope),
        await computeStorageBindingDigest(bindings.storage, input.scope, bindings.database),
        await computeNativeAuthBindingDigest(
          bindings.nativeAuth,
          input.scope,
          input.artifact.deploymentId,
          "ohmyho-sandbox",
        ),
        next,
      );
      return receipt({
        scriptName: `p-${input.scope.projectId.toLowerCase()}-${input.scope.environmentName}-${input.artifact.deploymentId.toLowerCase()}`,
        environmentId: input.scope.environmentId,
        productDeploymentId: input.artifact.deploymentId,
        artifactDigest: input.artifact.digest,
        buildReused: input.buildReused === true,
        ...(combined === null ? {} : { bindingSetDigest: combined }),
      });
    }),
    observeCandidate: vi.fn(async (input) => ({
      state:
        input.knownDeployment === undefined ? ("metadata_absent" as const) : ("ready" as const),
      scriptName: `p-${input.scope.projectId.toLowerCase()}-${input.scope.environmentName}-${input.deploymentId.toLowerCase()}`,
      providerTag: input.knownDeployment?.providerTag ?? null,
      productDeploymentId: input.knownDeployment?.productDeploymentId ?? null,
      artifactDigest: input.knownDeployment?.artifactDigest ?? null,
      observedAt: NOW,
    })),
    removeCandidate: vi.fn(async (input) => ({
      state: "metadata_absent" as const,
      namespace: "ohmyho-sandbox",
      scriptName: input.expectedDeployment.scriptName,
      projectId: input.scope.projectId,
      environmentId: input.scope.environmentId,
      expectedProviderTag: input.expectedDeployment.providerTag,
      observedAt: NOW,
    })),
    syncRuntimeSecrets: vi.fn(async (input) => ({
      provider: "cloudflare-wfp" as const,
      namespace: "ohmyho-sandbox",
      scriptName: input.deployment.scriptName,
      projectId: input.scope.projectId,
      environmentId: input.scope.environmentId,
      manifestDigest: input.manifest.digest,
      secretNames: input.manifest.secrets.map((secret: { readonly name: string }) => secret.name),
      providerTag: input.deployment.providerTag,
      observedAt: NOW,
    })),
    gatewayRegistry: {
      activate: vi.fn(async () => gatewayReceipt()),
      observe: vi.fn(async () => gatewayReceipt()),
      compensate: vi.fn(async () =>
        gatewayReceipt({ active: false, revision: 2, predecessorRevision: 1 }),
      ),
      remove: vi.fn(async () =>
        gatewayReceipt({ active: false, revision: 2, predecessorRevision: 1 }),
      ),
      authorizeCandidateRemoval: vi.fn(async () => ({ authorized: true })),
    },
  };
}

const emptyRuntimeSecretManifest = () => createRuntimeSecretManifest([]);

function candidateObservation(
  candidate: WfpDeploymentReceipt,
  overrides: Partial<Awaited<ReturnType<TestProvider["observeCandidate"]>>> = {},
) {
  return {
    state: "ready" as const,
    scriptName: candidate.scriptName,
    providerTag: candidate.providerTag,
    productDeploymentId: candidate.productDeploymentId,
    artifactDigest: candidate.artifactDigest,
    observedAt: NOW,
    ...overrides,
  };
}

function envelope(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(input?: {
  provider?: TestProvider;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  systemClock?: boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  trace?: (phase: string) => void;
  removalPollMilliseconds?: number;
  removalDeadlineMilliseconds?: number;
  nativeAuthAuthority?: {
    readRegistration(input: { projectId: string; environmentId: string }): Promise<unknown>;
  };
  nextCacheAuthority?: {
    registerNextCacheScope(input: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      deploymentId: string;
    }): Promise<unknown>;
  };
}) {
  const providerInstance = input?.provider ?? provider();
  const fetch =
    input?.fetch ??
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope({ jwt: "upload.jwt", buckets: [] }))
      .mockResolvedValue(new Response("missing", { status: 404 }));
  const management = createWfpManagement({
    bindings: {
      WFP_ACCOUNT_ID: "00000000000000000000000000000001",
      WFP_DISPATCH_NAMESPACE: "ohmyho-sandbox",
      WFP_API_TOKEN: "secret-token",
      WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
      ...SANDBOX_GATEWAY_BINDINGS,
      NATIVE_AUTH_SERVICE_US: "ohmyho-native-auth-development-us",
      NATIVE_AUTH_SERVICE_EU: "ohmyho-native-auth-development-eu",
    },
    provider: providerInstance,
    gatewayRegistry: providerInstance.gatewayRegistry,
    ...(input?.nextCacheAuthority === undefined
      ? {}
      : { nextCacheAuthority: input.nextCacheAuthority }),
    ...(input?.nativeAuthAuthority === undefined
      ? {}
      : { nativeAuthAuthority: input.nativeAuthAuthority }),
    fetch,
    ...(input?.systemClock ? {} : { now: input?.now ?? (() => NOW) }),
    sleep: input?.sleep ?? (async () => undefined),
    ...(input?.trace === undefined ? {} : { trace: input.trace }),
    removalPollMilliseconds: input?.removalPollMilliseconds ?? 1,
    removalDeadlineMilliseconds:
      input?.removalDeadlineMilliseconds ?? (input?.systemClock ? 10_000 : 3),
  });
  return { management, provider: providerInstance, fetch };
}

function absentRemovalProvider(): TestProvider {
  const result = provider();
  vi.mocked(result.observeCandidate).mockResolvedValue({
    state: "metadata_absent",
    scriptName: receipt().scriptName,
    providerTag: null,
    productDeploymentId: null,
    artifactDigest: null,
    observedAt: NOW,
  });
  return result;
}

function removalInput() {
  return {
    operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    organizationId: ORGANIZATION,
    scope: {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    },
    deploymentId: DEPLOYMENT,
    expectedGateway: gatewayReceipt(),
  };
}

describe("WFP management", () => {
  it("binds a verified Native server candidate to its exact deployment and rejects missing authority", async () => {
    const bundle = await edgeArtifact();
    const mutable = bundle as unknown as {
      manifestBody: Uint8Array;
      manifestDigest: `sha256:${string}`;
      provenance: Record<string, unknown>;
    };
    const manifest = JSON.parse(new TextDecoder().decode(bundle.manifestBody)) as Record<
      string,
      unknown
    >;
    const auth = {
      provider: "omh-native",
      routePath: "/api/auth/v1",
      bindingName: "OHMYHOST_AUTH",
    };
    manifest["auth"] = auth;
    manifest["artifactDigest"] = await sha256(
      encoder.encode(
        JSON.stringify({
          applicationRoot: manifest["applicationRoot"],
          frameworkPlanSchemaVersion: manifest["frameworkPlanSchemaVersion"],
          runtimePolicy: manifest["runtimePolicy"],
          database: manifest["database"],
          auth,
          storage: manifest["storage"],
          runtime: manifest["runtime"],
          assets: manifest["assets"],
          modules: manifest["modules"],
        }),
      ),
    );
    mutable.manifestBody = encoder.encode(JSON.stringify(manifest));
    mutable.manifestDigest = await sha256(mutable.manifestBody);
    mutable.provenance = {
      ...mutable.provenance,
      auth,
      artifactDigest: manifest["artifactDigest"],
    };
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const candidate = {
      organizationId: ORGANIZATION,
      scope,
      deploymentId: DEPLOYMENT,
      artifact: bundle,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    };
    await expect(harness().management.stageVerifiedArtifact(candidate)).rejects.toBeInstanceOf(
      WfpManagementInputError,
    );
    const receipt = {
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      operationId: DEPLOYMENT,
      claimId: DEPLOYMENT,
      providerProjectId: "prj_12345678901234567890",
      databaseId: "a1234567890123456789",
      regionId: "eu-dev",
      originHost: "db.example.test",
      schema: `omh_auth_${ENVIRONMENT.toLowerCase()}`,
      role: `omh_ar_${ENVIRONMENT.toLowerCase()}`,
      targetVersion: 1,
      registryVersion: 1,
      registryReference: `${PROJECT}:${ENVIRONMENT}`,
      status: "active",
    };
    await expect(
      harness({
        nativeAuthAuthority: {
          readRegistration: vi.fn().mockResolvedValue({ ...receipt, projectId: ENVIRONMENT }),
        },
      }).management.stageVerifiedArtifact(candidate),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    const { management, provider: instance } = harness({
      nativeAuthAuthority: { readRegistration: vi.fn().mockResolvedValue(receipt) },
    });
    expect((await management.stageVerifiedArtifact(candidate)).status).toBe("staged");
    const artifactValue = vi.mocked(instance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (!artifactValue) throw new Error("Native server candidate was not staged");
    expect(artifactValue?.platformBindings.nativeAuth).toEqual({
      service: "ohmyho-native-auth-development-eu",
      props: {
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        deploymentId: DEPLOYMENT,
      },
    });
    expect(multipartMetadata(artifactValue.body)["bindings"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "OHMYHOST_AUTH",
          entrypoint: "NativeSessionService",
          props: {
            organizationId: ORGANIZATION,
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            deploymentId: DEPLOYMENT,
          },
        }),
      ]),
    );
    const staticBundle = await artifact();
    const staticMutable = staticBundle as unknown as {
      manifestBody: Uint8Array;
      manifestDigest: `sha256:${string}`;
      provenance: Record<string, unknown>;
    };
    const staticManifest = JSON.parse(
      new TextDecoder().decode(staticBundle.manifestBody),
    ) as Record<string, unknown>;
    staticManifest["auth"] = auth;
    staticManifest["artifactDigest"] = await sha256(
      encoder.encode(
        JSON.stringify({
          applicationRoot: staticManifest["applicationRoot"],
          frameworkPlanSchemaVersion: staticManifest["frameworkPlanSchemaVersion"],
          runtimePolicy: staticManifest["runtimePolicy"],
          database: staticManifest["database"],
          auth,
          storage: staticManifest["storage"],
          assets: staticManifest["assets"],
        }),
      ),
    );
    staticMutable.manifestBody = encoder.encode(JSON.stringify(staticManifest));
    staticMutable.manifestDigest = await sha256(staticMutable.manifestBody);
    staticMutable.provenance = {
      ...staticMutable.provenance,
      auth,
      artifactDigest: staticManifest["artifactDigest"],
    };
    const staticHarness = harness({
      nativeAuthAuthority: { readRegistration: vi.fn().mockResolvedValue(receipt) },
    });
    expect(
      (
        await staticHarness.management.stageVerifiedArtifact({
          ...candidate,
          artifact: staticBundle,
        })
      ).status,
    ).toBe("staged");
    const staticArtifact = vi.mocked(staticHarness.provider.stageCandidate).mock.calls[0]?.[0]
      .artifact;
    if (!staticArtifact) throw new Error("Native static candidate was not staged");
    expect(staticArtifact.platformBindings.nativeAuth).toBeUndefined();
    expect(multipartMetadata(staticArtifact.body)["bindings"]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "OHMYHOST_AUTH" })]),
    );
  });
  it("keeps outdated candidate layouts unreconciled at replay, settlement, uncertain upload and preparation frontiers", async () => {
    const source = await artifact();
    const target = receipt({ artifactDigest: source.provenance.artifactDigest });
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const manifest = await emptyRuntimeSecretManifest();
    const fixed = "candidate_bindings_outdated" as const;
    for (const frontier of ["replay", "settle", "uncertain-upload", "prepare"] as const) {
      const api = provider();
      const outdated = candidateObservation(target, { state: "unknown", reason: fixed });
      if (frontier === "uncertain-upload")
        vi.mocked(api.stageCandidate).mockRejectedValueOnce(
          new CloudflareWfpUncertainError(
            target.providerTag,
            DEPLOYMENT,
            target.artifactDigest,
            fixed,
          ),
        );
      else vi.mocked(api.observeCandidate).mockResolvedValueOnce(outdated);
      const { management, fetch } = harness({ provider: api });
      const result =
        frontier === "prepare"
          ? await management.prepareExistingCandidate({
              organizationId: ORGANIZATION,
              scope,
              candidate: target,
              artifact: source,
              artifactSourceDeploymentId: DEPLOYMENT,
              runtimeSecretManifest: manifest,
            })
          : await management.stageVerifiedArtifact({
              organizationId: ORGANIZATION,
              scope,
              deploymentId: DEPLOYMENT,
              artifact: source,
              knownDeployments: frontier === "replay" ? [target] : [],
              runtimeSecretManifest: manifest,
            });
      expect.soft(result, frontier).toEqual({
        status: "reconciliation_required",
        reconciliationPhase: "candidate",
        currentProviderTag: target.providerTag,
        currentProductDeploymentId: DEPLOYMENT,
        reason: fixed,
      });
      expect
        .soft(vi.mocked(api.stageCandidate).mock.calls.length, frontier)
        .toBe(frontier === "uncertain-upload" || frontier === "settle" ? 1 : 0);
      expect.soft(api.syncRuntimeSecrets, frontier).not.toHaveBeenCalled();
      expect.soft(api.gatewayRegistry.activate, frontier).not.toHaveBeenCalled();
      if (frontier === "replay" || frontier === "prepare")
        expect.soft(fetch, frontier).not.toHaveBeenCalled();
    }
    // A provider's free-form reason must never become an internal/public diagnostic token.
    for (const frontier of ["observation", "uncertain-upload"] as const) {
      const api = provider();
      const privateReason = "private-provider-detail-must-not-leak";
      if (frontier === "uncertain-upload")
        vi.mocked(api.stageCandidate).mockRejectedValueOnce(
          Object.assign(new CloudflareWfpUncertainError(target.providerTag, DEPLOYMENT), {
            reason: privateReason,
          }),
        );
      else
        vi.mocked(api.observeCandidate).mockResolvedValueOnce({
          ...candidateObservation(target, { state: "unknown" }),
          reason: privateReason,
        } as never);
      const { management } = harness({ provider: api });
      const result =
        frontier === "observation"
          ? await management.prepareExistingCandidate({
              organizationId: ORGANIZATION,
              scope,
              candidate: target,
              artifact: source,
              artifactSourceDeploymentId: DEPLOYMENT,
              runtimeSecretManifest: manifest,
            })
          : await management.stageVerifiedArtifact({
              organizationId: ORGANIZATION,
              scope,
              deploymentId: DEPLOYMENT,
              artifact: source,
              knownDeployments: [],
              runtimeSecretManifest: manifest,
            });
      expect
        .soft(result, frontier)
        .toMatchObject({ status: "reconciliation_required", reconciliationPhase: "candidate" });
      expect.soft(result, frontier).not.toHaveProperty("reason");
      expect.soft(JSON.stringify(result), frontier).not.toContain(privateReason);
    }
  });

  it("fences activation and returns an outdated active route only as an exact scoped predecessor", async () => {
    const target = receipt();
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const runtimePolicy = { healthCheckPath: "/ready", egressAllowedOrigins: [] };
    const fixed = "candidate_bindings_outdated" as const;
    for (const [label, observation] of [
      ["outdated", candidateObservation(target, { state: "unknown", reason: fixed })],
      ["foreign tag", candidateObservation(target, { providerTag: "foreign-tag" })],
      [
        "foreign deployment",
        candidateObservation(target, { productDeploymentId: PROMOTION_DEPLOYMENT }),
      ],
      [
        "foreign script",
        candidateObservation(target, {
          scriptName: `p-${OTHER_PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
        }),
      ],
      [
        "foreign artifact",
        candidateObservation(target, { artifactDigest: `sha256:${"f".repeat(64)}` }),
      ],
    ] as const) {
      const api = provider();
      vi.mocked(api.observeCandidate).mockResolvedValueOnce(observation);
      const { management, fetch } = harness({ provider: api });
      const result = await management.activateCandidate({
        organizationId: ORGANIZATION,
        scope,
        candidate: target,
        runtimePolicy,
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      });
      expect
        .soft(result, label)
        .toMatchObject({ status: "reconciliation_required", reconciliationPhase: "candidate" });
      expect.soft(result, label).not.toHaveProperty("gateway");
      if (label === "outdated") expect.soft(result, label).toHaveProperty("reason", fixed);
      expect.soft(api.gatewayRegistry.activate, label).not.toHaveBeenCalled();
      expect.soft(fetch, label).not.toHaveBeenCalled();
    }
    const expectedGateway = gatewayReceipt();
    const rows: readonly [string, WfpProjectGatewayReceipt | null, boolean][] = [
      ["exact active predecessor", expectedGateway, true],
      ["no route", null, false],
      ["inactive route", gatewayReceipt({ active: false }), false],
      ["foreign organization", gatewayReceipt({ organizationId: OTHER_PROJECT }), false],
      [
        "foreign project",
        gatewayReceipt({
          projectId: OTHER_PROJECT,
          targetScriptName: `p-${OTHER_PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
        }),
        false,
      ],
      ["foreign environment", gatewayReceipt({ environmentId: PROMOTION_ENVIRONMENT }), false],
      [
        "foreign policy",
        gatewayReceipt({ egressAllowedOrigins: ["https://foreign.example.test"] }),
        false,
      ],
      [
        "foreign browser policy",
        gatewayReceipt({
          browserPolicy: normalizeBrowserPolicy({ connect: ["https://foreign.example.test"] }),
        }),
        false,
      ],
      ["wrong revision", gatewayReceipt({ revision: 2, predecessorRevision: 1 }), false],
      [
        "foreign target",
        gatewayReceipt({
          targetDeploymentId: PROMOTION_DEPLOYMENT,
          targetScriptName: `p-${PROJECT.toLowerCase()}-dev-${PROMOTION_DEPLOYMENT.toLowerCase()}`,
        }),
        false,
      ],
    ];
    for (const [label, gateway, keep] of rows) {
      const api = provider();
      vi.mocked(api.observeCandidate).mockResolvedValueOnce(
        candidateObservation(target, { state: "unknown", reason: fixed }),
      );
      vi.mocked(api.gatewayRegistry.observe).mockResolvedValueOnce(gateway);
      const { management, fetch } = harness({ provider: api });
      const result = await management.observeActivation({
        organizationId: ORGANIZATION,
        scope,
        candidate: target,
        runtimePolicy,
        expectedGateway,
      });
      expect.soft(result, label).toMatchObject({
        status: "reconciliation_required",
        reconciliationPhase: "candidate",
        reason: fixed,
      });
      if (keep) expect.soft(result, label).toHaveProperty("gateway", expectedGateway);
      else expect.soft(result, label).not.toHaveProperty("gateway");
      expect.soft(api.gatewayRegistry.activate, label).not.toHaveBeenCalled();
      expect.soft(fetch, label).not.toHaveBeenCalled();
    }
  });

  it("authorizes exact outdated cleanup and uses an outdated head only to build a fresh candidate", async () => {
    const source = await artifact();
    const target = receipt({ artifactDigest: source.provenance.artifactDigest });
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const fixed = "candidate_bindings_outdated" as const;
    const outdated = candidateObservation(target, { state: "unknown", reason: fixed });
    const removal = {
      organizationId: ORGANIZATION,
      scope,
      candidate: target,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    };
    for (const [label, observation, authorized] of [
      ["exact authorized", outdated, true],
      ["exact unauthorized", outdated, false],
      ["foreign tag", { ...outdated, providerTag: "foreign-tag" }, true],
      [
        "foreign script",
        {
          ...outdated,
          scriptName: `p-${OTHER_PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
        },
        true,
      ],
      ["foreign deployment", { ...outdated, productDeploymentId: PROMOTION_DEPLOYMENT }, true],
      [
        "foreign artifact",
        { ...outdated, artifactDigest: `sha256:${"f".repeat(64)}` as const },
        true,
      ],
    ] as const) {
      const api = provider();
      vi.mocked(api.observeCandidate)
        .mockResolvedValueOnce(observation)
        .mockResolvedValueOnce(
          candidateObservation(target, {
            state: "metadata_absent",
            providerTag: null,
            productDeploymentId: null,
            artifactDigest: null,
          }),
        );
      vi.mocked(api.gatewayRegistry.authorizeCandidateRemoval).mockResolvedValueOnce({
        authorized,
      });
      const { management } = harness({ provider: api });
      const result = await management.removeCandidate(removal).catch((error: unknown) => error);
      if (label === "exact authorized") {
        expect.soft(result, label).toMatchObject({ status: "removed", outcome: "removed" });
        expect.soft(api.gatewayRegistry.authorizeCandidateRemoval, label).toHaveBeenCalledOnce();
        expect
          .soft(api.removeCandidate, label)
          .toHaveBeenCalledExactlyOnceWith({ scope, expectedDeployment: target });
        expect
          .soft(
            vi.mocked(api.gatewayRegistry.authorizeCandidateRemoval).mock.invocationCallOrder[0],
            label,
          )
          .toBeLessThan(vi.mocked(api.removeCandidate).mock.invocationCallOrder[0] ?? 0);
      } else {
        if (!authorized) expect.soft(result, label).toBeInstanceOf(WfpManagementInputError);
        else
          expect
            .soft(result, label)
            .toMatchObject({ status: "reconciliation_required", reconciliationPhase: "candidate" });
        expect.soft(api.removeCandidate, label).not.toHaveBeenCalled();
      }
    }
    const manifest = await emptyRuntimeSecretManifest();
    const fresh = receipt({
      productDeploymentId: PROMOTION_DEPLOYMENT,
      scriptName: `p-${PROJECT.toLowerCase()}-dev-${PROMOTION_DEPLOYMENT.toLowerCase()}`,
      artifactDigest: target.artifactDigest,
      buildReused: true,
    });
    for (const mode of [
      "fresh target",
      "same immutable target",
      "outdated target replay",
      "foreign source",
    ] as const) {
      const api = provider();
      vi.mocked(api.observeCandidate).mockResolvedValueOnce(
        mode === "foreign source" ? { ...outdated, providerTag: "foreign-tag" } : outdated,
      );
      if (mode === "outdated target replay")
        vi.mocked(api.observeCandidate).mockResolvedValueOnce(
          candidateObservation(fresh, { state: "unknown", reason: fixed }),
        );
      const { management, fetch } = harness({ provider: api });
      const result = await management
        .stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope,
          deploymentId: mode === "same immutable target" ? DEPLOYMENT : PROMOTION_DEPLOYMENT,
          artifact: source,
          artifactReuse: "binding-refresh",
          knownDeployments: mode === "outdated target replay" ? [target, fresh] : [target],
          previousGateway: gatewayReceipt({ targetArtifactDigest: target.artifactDigest }),
          runtimeSecretManifest: manifest,
        })
        .catch((error: unknown) => error);
      if (mode === "fresh target") {
        expect.soft(result, mode).toMatchObject({
          status: "staged",
          candidate: { productDeploymentId: PROMOTION_DEPLOYMENT, buildReused: true },
        });
        expect.soft(api.stageCandidate, mode).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            artifact: expect.objectContaining({ deploymentId: PROMOTION_DEPLOYMENT }),
            buildReused: true,
          }),
        );
      } else {
        if (mode === "outdated target replay")
          expect.soft(result, mode).toMatchObject({
            status: "reconciliation_required",
            reconciliationPhase: "candidate",
            reason: fixed,
          });
        else expect.soft(result, mode).toBeInstanceOf(WfpManagementInputError);
        expect.soft(api.stageCandidate, mode).not.toHaveBeenCalled();
        expect.soft(fetch, mode).not.toHaveBeenCalled();
      }
      expect.soft(api.stageCandidate, mode).not.toHaveBeenCalledWith(
        expect.objectContaining({
          artifact: expect.objectContaining({ deploymentId: DEPLOYMENT }),
        }),
      );
    }
  });

  it("publishes a verified artifact through the official three-step asset flow", async () => {
    const inputArtifact = await artifact();
    const missingHash = "f".repeat(32);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope({ jwt: "upload.jwt", buckets: [[missingHash]] }))
      .mockResolvedValueOnce(envelope({ jwt: "complete.jwt" }, 201));
    const { management, provider: providerInstance } = harness({ fetch });

    // Cloudflare returns hashes from the submitted manifest. Replace its first hash with that value.
    fetch.mockReset();
    fetch.mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        manifest: Record<string, { hash: string }>;
      };
      const hash = request.manifest["/index.html"]?.hash;
      return envelope({ jwt: "upload.jwt", buckets: [[hash]] });
    });
    fetch.mockResolvedValueOnce(envelope({ jwt: "complete.jwt" }, 201));

    const result = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: inputArtifact,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });

    expect(result.status).toBe("staged");
    expect(result).toMatchObject({
      candidate: { productDeploymentId: DEPLOYMENT },
      deploymentUrl: "https://dev-calm-river-studio.dev.check.omh.st",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      `/scripts/p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}/assets-upload-session`,
    );
    expect(String(fetch.mock.calls[1]?.[0])).toContain("/workers/assets/upload?base64=true");
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer upload.jwt",
    );
    const publish = vi.mocked(providerInstance.stageCandidate);
    expect(providerInstance.gatewayRegistry.activate).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    const final = publish.mock.calls[0]?.[0].artifact;
    expect(final?.contentType).toMatch(/^multipart\/form-data; boundary=/u);
    expect(final?.bodyDigest).toBe(await sha256(final?.body ?? new Uint8Array()));
    const body = new TextDecoder().decode(final?.body);
    // A Vite build answers a path that matches no file with its app shell, so a reload works.
    expect(multipartMetadata(final?.body ?? new Uint8Array())["assets"]).toEqual({
      jwt: "complete.jwt",
      config: {
        html_handling: "auto-trailing-slash",
        not_found_handling: "single-page-application",
        run_worker_first: true,
      },
    });
    expect(body).toContain(
      `"tags":["project:${PROJECT}","environment:${ENVIRONMENT}","deployment:${DEPLOYMENT}","artifact:${final?.digest}","${WFP_CANDIDATE_LAYOUT_TAG}"]`,
    );
    expect(body).toContain('"bindings":[{"type":"assets","name":"ASSETS"}]');
    expect(body).toContain("env.ASSETS.fetch(request)");
    expect(final?.platformBindings).toEqual({
      immutableScriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
      crons: [],
    });
    expect(body).not.toContain("OHMYHOST_CRONS");
    expect(body).not.toContain("OHMYHOST_IMMUTABLE_SCRIPT_NAME");
    expect(body).not.toContain("nodejs_compat");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("publishes a verified Dev artifact to Prod without rebinding its immutable build proof", async () => {
    const inputArtifact = await artifact();
    const { management, provider: providerInstance } = harness();

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: PROMOTION_ENVIRONMENT,
          environmentName: "prod",
          handle: "calm-river-studio",
        },
        deploymentId: PROMOTION_DEPLOYMENT,
        artifact: inputArtifact,
        artifactReuse: "promotion",
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).resolves.toMatchObject({
      status: "staged",
      candidate: {
        environmentId: PROMOTION_ENVIRONMENT,
        productDeploymentId: PROMOTION_DEPLOYMENT,
        buildReused: true,
      },
    });

    expect(providerInstance.stageCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ environmentId: PROMOTION_ENVIRONMENT }),
        artifact: expect.objectContaining({ deploymentId: PROMOTION_DEPLOYMENT }),
        buildReused: true,
      }),
    );
  });

  it("refreshes bindings in a new candidate only from the exact active immutable source", async () => {
    const manifest = await createRuntimeSecretManifest([
      {
        name: "OHMYHOST_STORAGE_KEY",
        value: "s".repeat(43),
        revision: 1,
        valueSha256: await sha256(encoder.encode("s".repeat(43))),
      },
    ]);
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    for (const framework of [
      "vite-api-companion-v1",
      "nextjs-opennext-wrapper-v1",
      "astro-edge-wrapper-v1",
      "tanstack-edge-wrapper-v1",
      "functions-v1",
    ] as const) {
      const source = await artifactWithStorage(framework);
      const original = receipt({ artifactDigest: source.provenance.artifactDigest });
      const previousGateway = gatewayReceipt({ targetArtifactDigest: original.artifactDigest });
      const { management, provider: api } = harness();
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope,
          deploymentId: PROMOTION_DEPLOYMENT,
          artifact: source,
          artifactReuse: "binding-refresh",
          knownDeployments: [original],
          previousGateway,
          runtimeSecretManifest: manifest,
          storageBucketName: STORAGE_BUCKET,
          storageDataEnvironmentId: ENVIRONMENT,
        } as never),
      ).resolves.toMatchObject({
        status: "staged",
        candidate: {
          productDeploymentId: PROMOTION_DEPLOYMENT,
          artifactDigest: original.artifactDigest,
          buildReused: true,
        },
      });
      const published = vi.mocked(api.stageCandidate).mock.calls[0]?.[0];
      expect(published?.artifact.deploymentId).toBe(PROMOTION_DEPLOYMENT);
      expect(published?.artifact.digest).toBe(source.provenance.artifactDigest);
      expect(published?.buildReused).toBe(true);
      const modules = source.modules;
      expect(modules.length).toBeGreaterThan(0);
      for (const file of modules)
        expect(Buffer.from(published?.artifact.body ?? []).includes(Buffer.from(file.body))).toBe(
          true,
        );
      expect(api.observeCandidate).toHaveBeenCalledWith({
        scope,
        deploymentId: original.productDeploymentId,
        knownDeployment: original,
      });
      expect(api.stageCandidate).not.toHaveBeenCalledWith(
        expect.objectContaining({
          artifact: expect.objectContaining({ deploymentId: DEPLOYMENT }),
        }),
      );
    }
    const source = await artifactWithStorage("functions-v1");
    const original = receipt({ artifactDigest: source.provenance.artifactDigest });
    const prodScope = {
      ...scope,
      environmentId: PROMOTION_ENVIRONMENT,
      environmentName: "prod" as const,
    };
    const promoted = receipt({
      environmentId: PROMOTION_ENVIRONMENT,
      productDeploymentId: PROMOTION_DEPLOYMENT,
      scriptName: `p-${PROJECT.toLowerCase()}-prod-${PROMOTION_DEPLOYMENT.toLowerCase()}`,
      artifactDigest: original.artifactDigest,
      buildReused: true,
    });
    const prodHead = gatewayReceipt({
      environmentId: PROMOTION_ENVIRONMENT,
      environmentName: "prod",
      hostname: "calm-river-studio.dev.check.omh.st",
      publicOrigin: "https://calm-river-studio.dev.check.omh.st",
      targetScriptName: promoted.scriptName,
      targetDeploymentId: promoted.productDeploymentId,
      targetArtifactDigest: promoted.artifactDigest,
    });
    const refreshedProd = harness();
    await expect(
      refreshedProd.management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: prodScope,
        deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        artifact: source,
        artifactReuse: "binding-refresh",
        knownDeployments: [promoted],
        previousGateway: prodHead,
        runtimeSecretManifest: manifest,
        storageBucketName: `ohmyho-${PROJECT.toLowerCase()}-${PROMOTION_ENVIRONMENT.toLowerCase()}`,
        storageDataEnvironmentId: PROMOTION_ENVIRONMENT,
      } as never),
    ).resolves.toMatchObject({
      status: "staged",
      candidate: {
        environmentId: PROMOTION_ENVIRONMENT,
        artifactDigest: source.provenance.artifactDigest,
        buildReused: true,
      },
    });
    expect(source.provenance.scope.environmentId).toBe(ENVIRONMENT);
    expect(
      vi.mocked(refreshedProd.provider.stageCandidate).mock.calls[0]?.[0].artifact.platformBindings
        .storage?.props,
    ).toEqual({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: PROMOTION_ENVIRONMENT,
      dataEnvironmentId: PROMOTION_ENVIRONMENT,
    });
    const input = {
      organizationId: ORGANIZATION,
      scope,
      deploymentId: PROMOTION_DEPLOYMENT,
      artifact: source,
      artifactReuse: "binding-refresh",
      knownDeployments: [original],
      previousGateway: gatewayReceipt({ targetArtifactDigest: original.artifactDigest }),
      runtimeSecretManifest: manifest,
      storageBucketName: STORAGE_BUCKET,
      storageDataEnvironmentId: ENVIRONMENT,
    };
    for (const override of [
      { previousGateway: undefined },
      { knownDeployments: [] },
      { deploymentId: DEPLOYMENT },
      {
        previousGateway: {
          ...input.previousGateway,
          targetArtifactDigest: `sha256:${"f".repeat(64)}`,
        },
      },
    ]) {
      const { management, provider: api, fetch } = harness();
      await expect(
        management.stageVerifiedArtifact({ ...input, ...override } as never),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
      expect(api.stageCandidate).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
    const { management, provider: api } = harness();
    vi.mocked(api.observeCandidate).mockResolvedValueOnce({
      state: "unknown",
      scriptName: original.scriptName,
      providerTag: "b".repeat(32),
      productDeploymentId: DEPLOYMENT,
      artifactDigest: original.artifactDigest,
      observedAt: NOW,
    });
    await expect(management.stageVerifiedArtifact(input as never)).rejects.toBeInstanceOf(
      WfpManagementInputError,
    );
    expect(api.stageCandidate).not.toHaveBeenCalled();
  });

  it("deduplicates identical asset bodies while preserving every manifest path", async () => {
    const inputArtifact = await artifactWithDuplicateAssetContent();
    const fetch = vi.fn<typeof globalThis.fetch>();
    let sharedHash = "";
    fetch.mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        manifest: Record<string, { hash: string }>;
      };
      sharedHash = request.manifest["/index.html"]?.hash ?? "";
      expect(request.manifest["/index-copy.html"]?.hash).toBe(sharedHash);
      return envelope({ jwt: "upload.jwt", buckets: [[sharedHash]] });
    });
    fetch.mockResolvedValueOnce(envelope({ jwt: "complete.jwt" }, 201));
    const { management } = harness({ fetch });

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: inputArtifact,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).resolves.toMatchObject({ status: "staged" });
    const upload = fetch.mock.calls[1]?.[1]?.body;
    expect(upload).toBeInstanceOf(ReadableStream);
    const uploadHeaders = fetch.mock.calls[1]?.[1]?.headers;
    const form = await new Response(upload, {
      ...(uploadHeaders === undefined ? {} : { headers: uploadHeaders }),
    }).formData();
    expect(Array.from(form.keys())).toEqual([sharedHash]);
  });

  it("activates only the exact staged candidate and returns its gateway", async () => {
    const inputArtifact = await artifact({
      runtimePolicy: {
        healthCheckPath: "/ready",
        egressAllowedOrigins: ["https://api.example.test"],
      },
    });
    const { management, provider: providerInstance } = harness();
    const staged = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: inputArtifact,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });
    if (staged.status !== "staged") throw new Error("expected staged candidate");
    vi.mocked(providerInstance.gatewayRegistry.activate).mockResolvedValue(
      gatewayReceipt({
        targetScriptName: staged.candidate.scriptName,
        targetDeploymentId: staged.candidate.productDeploymentId,
        targetArtifactDigest: staged.candidate.artifactDigest,
        targetProviderTag: staged.candidate.providerTag,
        egressAllowedOrigins: staged.activationRuntimePolicy.egressAllowedOrigins,
      }),
    );
    await expect(
      management.activateCandidate({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: staged.candidate,
        runtimePolicy: staged.activationRuntimePolicy,
      }),
    ).resolves.toMatchObject({ status: "activated", candidate: staged.candidate });

    // A first deployment after a failed one: Control roots the new revision past that history.
    const retry = {
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
      candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev" as const,
        handle: "calm-river-studio",
      },
      candidate: staged.candidate,
      runtimePolicy: staged.activationRuntimePolicy,
    };
    const rooted = gatewayReceipt({
      targetScriptName: staged.candidate.scriptName,
      targetDeploymentId: staged.candidate.productDeploymentId,
      targetArtifactDigest: staged.candidate.artifactDigest,
      targetProviderTag: staged.candidate.providerTag,
      egressAllowedOrigins: staged.activationRuntimePolicy.egressAllowedOrigins,
      operationId: retry.operationId,
      candidateReceiptId: retry.candidateReceiptId,
      revision: 3,
      predecessorRevision: null,
    });
    vi.mocked(providerInstance.gatewayRegistry.activate).mockResolvedValue(rooted);
    const activated = await management.activateCandidate(retry);
    expect(activated).toMatchObject({ status: "activated", gateway: rooted });
    expect(await management.activateCandidate(retry)).toEqual(activated);
    expect(providerInstance.gatewayRegistry.activate).toHaveBeenLastCalledWith(
      expect.objectContaining({ operationId: retry.operationId, expectedRevision: null }),
    );
    // Control refuses the claim that lost the route race; that attempt never activates.
    vi.mocked(providerInstance.gatewayRegistry.activate).mockRejectedValueOnce(
      new Error("Gateway routing is unavailable"),
    );
    await expect(management.activateCandidate(retry)).rejects.toThrow(
      "WFP provider request failed",
    );
    vi.mocked(providerInstance.gatewayRegistry.activate).mockResolvedValueOnce({
      ...rooted,
      organizationId: OTHER_PROJECT,
    });
    await expect(management.activateCandidate(retry)).rejects.toMatchObject({
      code: "cloudflare_contract_invalid",
    });
  });

  it("observes only an exact immutable candidate and exact active gateway", async () => {
    const candidate = receipt();
    const providerInstance = provider();
    const gateway = gatewayReceipt();
    vi.mocked(providerInstance.observeCandidate).mockResolvedValue({
      state: "ready",
      scriptName: candidate.scriptName,
      providerTag: candidate.providerTag,
      productDeploymentId: candidate.productDeploymentId,
      artifactDigest: candidate.artifactDigest,
      observedAt: NOW,
    });
    vi.mocked(providerInstance.gatewayRegistry.observe).mockResolvedValue(gateway);
    const { management } = harness({ provider: providerInstance });
    const input = {
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev" as const,
        handle: "calm-river-studio",
      },
      candidate,
      runtimePolicy: { healthCheckPath: "/ready", egressAllowedOrigins: [] },
    };

    await expect(management.observeActivation(input)).resolves.toEqual({
      status: "observed",
      candidate,
      gateway,
      deploymentUrl: gateway.publicOrigin,
    });
    expect(providerInstance.gatewayRegistry.observe).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
    });
    vi.mocked(providerInstance.gatewayRegistry.observe).mockResolvedValueOnce(null);
    await expect(management.observeActivation(input)).resolves.toEqual({ status: "absent" });
    vi.mocked(providerInstance.gatewayRegistry.observe).mockResolvedValueOnce(
      gatewayReceipt({
        targetDeploymentId: PROMOTION_DEPLOYMENT,
        targetScriptName: `p-${PROJECT.toLowerCase()}-dev-${PROMOTION_DEPLOYMENT.toLowerCase()}`,
        targetArtifactDigest: `sha256:${"f".repeat(64)}`,
      }),
    );
    await expect(management.observeActivation(input)).resolves.toEqual({
      status: "reconciliation_required",
      reconciliationPhase: "gateway",
      currentProviderTag: gateway.targetProviderTag,
      currentProductDeploymentId: null,
    });
  });

  it("rejects gateway receipts with foreign organizations or noncanonical origins", async () => {
    const providerInstance = provider();
    const { management } = harness({ provider: providerInstance });
    const input = {
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev" as const,
        handle: "calm-river-studio",
      },
      candidate: receipt(),
      runtimePolicy: { healthCheckPath: "/ready", egressAllowedOrigins: [] },
    };
    for (const previousGateway of [
      gatewayReceipt({ organizationId: OTHER_PROJECT }),
      gatewayReceipt({
        publicOrigin: "https://dev-calm-river-studio.your-omh-account.workers.dev",
      }),
    ]) {
      await expect(
        management.activateCandidate({
          operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          ...input,
          previousGateway,
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    expect(providerInstance.gatewayRegistry.activate).not.toHaveBeenCalled();
  });

  it("prepares existing candidates and distinguishes retained from removed compensation", async () => {
    // A retained artifact may predate the denylist; reject before observing or changing its Worker.
    for (const gateway of ["mail", "storage"]) {
      const forbidden = await artifact({
        runtimePolicy: {
          healthCheckPath: "/ready",
          egressAllowedOrigins: [`https://ohmyho-${gateway}-gateway-decoy.test.workers.dev`],
        },
      });
      const forbiddenDigest = JSON.parse(new TextDecoder().decode(forbidden.manifestBody))
        .artifactDigest as `sha256:${string}`;
      const denied = harness();
      await expect(
        denied.management.prepareExistingCandidate({
          artifactSourceDeploymentId: DEPLOYMENT,
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          candidate: receipt({ artifactDigest: forbiddenDigest }),
          artifact: forbidden,
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
      expect(denied.provider.observeCandidate).not.toHaveBeenCalled();
      expect(denied.provider.stageCandidate).not.toHaveBeenCalled();
      expect(denied.provider.syncRuntimeSecrets).not.toHaveBeenCalled();
      expect(denied.fetch).not.toHaveBeenCalled();
    }
    const inputArtifact = await artifact();
    const digest = JSON.parse(new TextDecoder().decode(inputArtifact.manifestBody))
      .artifactDigest as `sha256:${string}`;
    const target = receipt({ artifactDigest: digest });
    const providerInstance = provider();
    vi.mocked(providerInstance.observeCandidate).mockResolvedValue({
      state: "ready",
      scriptName: target.scriptName,
      providerTag: target.providerTag,
      productDeploymentId: target.productDeploymentId,
      artifactDigest: target.artifactDigest,
      observedAt: NOW,
    });
    const { management, fetch } = harness({ provider: providerInstance });
    const secrets = await emptyRuntimeSecretManifest();
    await expect(
      management.prepareExistingCandidate({
        artifactSourceDeploymentId: DEPLOYMENT,
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: target,
        artifact: inputArtifact,
        runtimeSecretManifest: secrets,
      }),
    ).resolves.toMatchObject({ status: "prepared", candidate: target });
    expect(fetch).not.toHaveBeenCalled();
    const refreshed = receipt({
      productDeploymentId: PROMOTION_DEPLOYMENT,
      scriptName: `p-${PROJECT.toLowerCase()}-dev-${PROMOTION_DEPLOYMENT.toLowerCase()}`,
      artifactDigest: digest,
      buildReused: true,
    });
    const rollback = {
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev" as const,
        handle: "calm-river-studio",
      },
      candidate: refreshed,
      artifact: inputArtifact,
      runtimeSecretManifest: secrets,
      artifactSourceDeploymentId: DEPLOYMENT,
    };
    vi.mocked(providerInstance.observeCandidate).mockResolvedValueOnce({
      state: "ready",
      scriptName: refreshed.scriptName,
      providerTag: refreshed.providerTag,
      productDeploymentId: refreshed.productDeploymentId,
      artifactDigest: refreshed.artifactDigest,
      observedAt: NOW,
    });
    await expect(management.prepareExistingCandidate(rollback)).resolves.toMatchObject({
      status: "prepared",
      candidate: refreshed,
    });
    for (const artifactSourceDeploymentId of [undefined, "invalid", PROMOTION_DEPLOYMENT]) {
      const before = vi.mocked(providerInstance.observeCandidate).mock.calls.length;
      await expect(
        management.prepareExistingCandidate({ ...rollback, artifactSourceDeploymentId } as never),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
      expect(providerInstance.observeCandidate).toHaveBeenCalledTimes(before);
    }
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
    await expect(
      management.prepareExistingCandidate({
        artifactSourceDeploymentId: DEPLOYMENT,
        organizationId: ORGANIZATION,
        scope: {
          projectId: OTHER_PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: target,
        artifact: inputArtifact,
        runtimeSecretManifest: secrets,
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    await expect(
      management.prepareExistingCandidate({
        artifactSourceDeploymentId: DEPLOYMENT,
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: { ...target, artifactDigest: `sha256:${"f".repeat(64)}` },
        artifact: inputArtifact,
        runtimeSecretManifest: secrets,
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    vi.mocked(providerInstance.observeCandidate).mockResolvedValueOnce({
      state: "unknown",
      scriptName: target.scriptName,
      providerTag: "foreign-tag",
      productDeploymentId: target.productDeploymentId,
      artifactDigest: target.artifactDigest,
      observedAt: NOW,
    });
    await expect(
      management.prepareExistingCandidate({
        artifactSourceDeploymentId: DEPLOYMENT,
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: target,
        artifact: inputArtifact,
        runtimeSecretManifest: secrets,
      }),
    ).resolves.toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
      currentProviderTag: "foreign-tag",
    });
    await expect(
      management.compensateGatewayActivation({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: target,
        expectedGateway: gatewayReceipt({
          targetArtifactDigest: target.artifactDigest,
          targetProviderTag: target.providerTag,
        }),
      }),
    ).resolves.toMatchObject({ status: "compensated", candidateRetained: true });
    expect(providerInstance.removeCandidate).not.toHaveBeenCalled();
    // The route is restored under the operation's provider-mutation claim and the candidate removed
    // under its cleanup claim; the shared gateway authorizes each against its own record.
    const compensation = {
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev" as const,
        handle: "calm-river-studio",
      },
      candidate: target,
      expectedGateway: gatewayReceipt({
        targetArtifactDigest: target.artifactDigest,
        targetProviderTag: target.providerTag,
      }),
    };
    await expect(management.compensateActivation(compensation as never)).rejects.toBeInstanceOf(
      WfpManagementInputError,
    );
    await expect(
      management.compensateActivation({
        ...compensation,
        cleanupClaimId: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
      }),
    ).resolves.toMatchObject({ status: "compensated" });
    expect(providerInstance.gatewayRegistry.compensate).toHaveBeenLastCalledWith(
      expect.objectContaining({ claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" }),
    );
    expect(providerInstance.gatewayRegistry.authorizeCandidateRemoval).toHaveBeenLastCalledWith(
      expect.objectContaining({ claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB9" }),
    );
    vi.mocked(providerInstance.observeCandidate)
      .mockResolvedValueOnce({
        state: "ready",
        scriptName: target.scriptName,
        providerTag: target.providerTag,
        productDeploymentId: target.productDeploymentId,
        artifactDigest: target.artifactDigest,
        observedAt: NOW,
      })
      .mockResolvedValueOnce({
        state: "metadata_absent",
        scriptName: target.scriptName,
        providerTag: null,
        productDeploymentId: null,
        artifactDigest: null,
        observedAt: NOW,
      });
    await expect(
      management.removeCandidate({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: target,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      outcome: "removed",
      receipt: { state: "metadata_absent" },
    });

    vi.mocked(providerInstance.observeCandidate).mockResolvedValue({
      state: "metadata_absent",
      scriptName: target.scriptName,
      providerTag: null,
      productDeploymentId: null,
      artifactDigest: null,
      observedAt: NOW,
    });
    await expect(
      management.removeCandidate({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: target,
      }),
    ).resolves.toMatchObject({ status: "removed", outcome: "not_found" });

    vi.mocked(providerInstance.observeCandidate).mockResolvedValueOnce({
      state: "ready",
      scriptName: target.scriptName,
      providerTag: target.providerTag,
      productDeploymentId: target.productDeploymentId,
      artifactDigest: target.artifactDigest,
      observedAt: NOW,
    });
    vi.mocked(providerInstance.removeCandidate).mockRejectedValueOnce(
      Object.assign(new Error("lost response detail"), {
        code: "cloudflare_result_uncertain",
        currentProviderTag: target.providerTag,
        currentProductDeploymentId: target.productDeploymentId,
      }),
    );
    await expect(
      management.removeCandidate({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: target,
      }),
    ).resolves.toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
      currentProviderTag: target.providerTag,
    });
  });

  it("fails closed on a conflicting exact gateway cleanup", async () => {
    const providerInstance = provider();
    vi.mocked(providerInstance.gatewayRegistry.remove).mockRejectedValueOnce(
      Object.assign(new Error("private detail"), {
        code: "cloudflare_deployment_conflict",
        currentProviderTag: "foreign-tag",
      }),
    );
    const { management } = harness({ provider: providerInstance });
    await expect(
      management.finalizeRemoval({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        expectedGateway: { ...gatewayReceipt(), observedAt: NOW.toISOString() } as never,
      }),
    ).resolves.toMatchObject({
      status: "reconciliation_required",
      reason: "provider_conflict",
      currentProviderTag: "foreign-tag",
    });
  });

  it("requires durable cleanup authorization before deleting an immutable candidate", async () => {
    const providerInstance = provider();
    const { management } = harness({ provider: providerInstance });
    const input = {
      organizationId: ORGANIZATION,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev" as const,
        handle: "calm-river-studio",
      },
      candidate: receipt(),
    };
    vi.mocked(providerInstance.gatewayRegistry.authorizeCandidateRemoval).mockResolvedValueOnce({
      authorized: false,
    });
    await expect(management.removeCandidate(input)).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(providerInstance.removeCandidate).not.toHaveBeenCalled();
    expect(providerInstance.gatewayRegistry.authorizeCandidateRemoval).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      operationId: input.operationId,
      claimId: input.claimId,
      candidateReceiptId: input.candidateReceiptId,
      productDeploymentId: DEPLOYMENT,
      scriptName: input.candidate.scriptName,
      providerTag: input.candidate.providerTag,
    });
  });

  it("rejects the retired database-only WFP removal contract", async () => {
    const providerInstance = provider();
    const { management } = harness({ provider: providerInstance });
    await expect(
      management.finalizeRemoval({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        databaseRegistration: DATABASE_REGISTRATION,
      } as never),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(providerInstance.gatewayRegistry.remove).not.toHaveBeenCalled();
    expect(providerInstance.removeCandidate).not.toHaveBeenCalled();
  });

  it("redacts candidate-removal and final-observation provider failures", async () => {
    const providerInstance = provider();
    vi.mocked(providerInstance.removeCandidate).mockRejectedValueOnce(
      Object.assign(new Error("secret response body"), {
        code: "cloudflare_request_failed",
        status: 502,
      }),
    );
    const { management } = harness({ provider: providerInstance });
    const compensationError = await management
      .compensateActivation({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        cleanupClaimId: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: receipt(),
        expectedGateway: gatewayReceipt(),
      })
      .catch((error: unknown) => error);
    expect(compensationError).toMatchObject({
      code: "cloudflare_request_failed",
      providerStatus: 502,
    });
    expect(String(compensationError)).not.toContain("secret response body");

    vi.mocked(providerInstance.observeCandidate).mockRejectedValueOnce(
      Object.assign(new Error("secret observation body"), {
        code: "cloudflare_request_failed",
        status: 503,
      }),
    );
    const observationError = await management
      .finalizeRemoval({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        expectedGateway: gatewayReceipt(),
      })
      .catch((error: unknown) => error);
    expect(observationError).toMatchObject({
      code: "cloudflare_request_failed",
      providerStatus: 503,
    });
    expect(String(observationError)).not.toContain("secret observation body");
  });

  it("returns a terminal rejection when the provider rejects the candidate script", async () => {
    const inputArtifact = await edgeArtifact();
    const providerInstance = provider();
    vi.mocked(providerInstance.stageCandidate).mockRejectedValueOnce(
      Object.assign(new Error("secret rejection body"), {
        code: "cloudflare_script_rejected",
        status: 400,
        providerCode: 10021,
      }),
    );
    const { management } = harness({ provider: providerInstance });

    const result = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: inputArtifact,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "script_rejected",
      providerStatus: 400,
      providerCode: 10021,
    });
    expect(JSON.stringify(result)).not.toContain("secret rejection body");
    expect(providerInstance.observeCandidate).not.toHaveBeenCalled();
  });

  it.each(["tanstack-edge-wrapper-v1", "astro-edge-wrapper-v1"] as const)(
    "publishes the verified %s graph behind the platform prefix wrapper",
    async (version) => {
      const inputArtifact = await edgeArtifact(
        version,
        undefined,
        version === "astro-edge-wrapper-v1" ? "2026-10-12" : "2026-08-21",
      );
      const { management, provider: providerInstance } = harness();

      const result = await management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: inputArtifact,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      });

      expect(result.status).toBe("staged");
      const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
      const body = new TextDecoder().decode(publication?.body);
      expect(body).toContain('"main_module":"ohmyhost-entry.mjs"');
      expect(body).toContain('"compatibility_flags":["nodejs_compat"]');
      expect(body).toContain('name="index.js"; filename="index.js"');
      expect(body).toContain('name="assets/chunk.js"; filename="assets/chunk.js"');
      expect(body).toContain('import userWorker from "./index.js"');
      expect(body).not.toContain(`/p/${PROJECT}/`);
      expect(body).toContain('headers.set("x-ohmyhost-runtime", "edge-v1")');
      if (version === "astro-edge-wrapper-v1")
        expect(multipartMetadata(publication?.body as Uint8Array)).toMatchObject({
          assets: { config: { run_worker_first: true } },
          bindings: expect.arrayContaining([{ type: "assets", name: "ASSETS" }]),
        });
      expect(multipartMetadata(publication?.body as Uint8Array)["bindings"]).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "OHMYHOST_MAIL_GATEWAY" })]),
      );
    },
  );

  it("publishes the Vite API companion with Better Auth, regional database, and private storage gateway", async () => {
    const inputArtifact = await artifactWithCustomerAuth({
      entryWrapperVersion: "vite-api-companion-v1",
      deployment: "companion",
      storage: true,
    });
    const { management, provider: providerInstance } = harness();
    const secret = "fixture-better-auth-secret-value";
    const storageKey = "fixture-storage-gateway-key";

    const result = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: inputArtifact,
      knownDeployments: [],
      runtimeSecretManifest: await createRuntimeSecretManifest([
        {
          name: "BETTER_AUTH_SECRET",
          value: secret,
          revision: 1,
          valueSha256: await sha256(encoder.encode(secret)),
        },
        {
          name: "OHMYHOST_STORAGE_KEY",
          value: storageKey,
          revision: 1,
          valueSha256: await sha256(encoder.encode(storageKey)),
        },
      ]),
      databaseRegistration: DATABASE_REGISTRATION,
      databaseOriginHost: DATABASE_REGISTRATION.originHost,
      storageBucketName: STORAGE_BUCKET,
      storageDataEnvironmentId: ENVIRONMENT,
    });

    expect(result.status).toBe("staged");
    if (result.status !== "staged") throw new Error("Expected staged Vite companion");
    expect(result.activationRuntimePolicy.egressAllowedOrigins).toContain(
      "https://00000000000000000000000000000001.eu.r2.cloudflarestorage.com",
    );
    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected Vite companion publication");
    const metadata = multipartMetadata(publication.body);
    expect(metadata["assets"]).toEqual({
      jwt: "upload.jwt",
      config: {
        html_handling: "auto-trailing-slash",
        not_found_handling: "single-page-application",
        run_worker_first: true,
      },
    });
    expect(metadata["bindings"]).toEqual([
      { type: "assets", name: "ASSETS" },
      {
        type: "service",
        name: "OHMYHOST_DATABASE",
        service: "ohmyho-project-database-sandbox-us",
        entrypoint: "ProjectDatabaseService",
        props: {
          organizationId: ORGANIZATION,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          physicalEnvironmentId: ENVIRONMENT,
          registrationVersion: 1,
          region: "us",
        },
      },
      {
        type: "service",
        name: "OHMYHOST_STORAGE_GATEWAY",
        service: "ohmyho-storage-gateway-sandbox",
        props: {
          organizationId: ORGANIZATION,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          dataEnvironmentId: ENVIRONMENT,
        },
      },
      { type: "plain_text", name: "OHMYHOST_CRONS", text: '["*/5 * * * *"]' },
      {
        type: "plain_text",
        name: "OHMYHOST_IMMUTABLE_SCRIPT_NAME",
        text: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
      },
      {
        type: "plain_text",
        name: "BETTER_AUTH_URL",
        text: "https://dev-calm-river-studio.dev.check.omh.st",
      },
      {
        type: "plain_text",
        name: "OHMYHOST_STORAGE_GATEWAY_URL",
        text: createPinnedStorageGatewayOrigin(
          SANDBOX_GATEWAY_BINDINGS.WFP_STORAGE_GATEWAY_ORIGIN,
          {
            organizationId: ORGANIZATION,
            environmentId: ENVIRONMENT,
            dataEnvironmentId: ENVIRONMENT,
          },
        ),
      },
      { type: "plain_text", name: "OHMYHOST_ENVIRONMENT_ID", text: ENVIRONMENT },
      { type: "plain_text", name: "OHMYHOST_PROJECT_ID", text: PROJECT },
      { type: "secret_text", name: "BETTER_AUTH_SECRET", text: secret },
      { type: "secret_text", name: "OHMYHOST_STORAGE_KEY", text: storageKey },
    ]);
    expect(metadata).not.toHaveProperty("triggers");
    expect(metadata).not.toHaveProperty("queues");
    expect(metadata).not.toHaveProperty("workflows");
    expect(publication.platformBindings).toEqual({
      immutableScriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
      crons: ["*/5 * * * *"],
      database: {
        service: "ohmyho-project-database-sandbox-us",
        props: {
          organizationId: ORGANIZATION,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          physicalEnvironmentId: ENVIRONMENT,
          registrationVersion: 1,
          region: "us",
        },
      },
      storage: {
        service: "ohmyho-storage-gateway-sandbox",
        props: {
          organizationId: ORGANIZATION,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          dataEnvironmentId: ENVIRONMENT,
        },
      },
    });
    expect(metadata["tags"]).toContainEqual(expect.stringMatching(/^crons:sha256:[a-f0-9]{64}$/u));
    expect(new TextDecoder().decode(publication.body)).toContain("scheduled.ohmyhost.internal");
    expect(new TextDecoder().decode(publication.body)).toContain('name="index.js"');
  });

  it("binds the exact project gateway as Better Auth's non-secret public origin", async () => {
    const { management, provider: providerInstance } = harness();
    const key = "mail-key";
    await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: await artifactWithCustomerAuth(),
      knownDeployments: [],
      runtimeSecretManifest: await createRuntimeSecretManifest([
        {
          name: "OHMYHOST_MAIL_KEY",
          value: key,
          revision: 1,
          valueSha256: await sha256(encoder.encode(key)),
        },
      ]),
      databaseRegistration: DATABASE_REGISTRATION,
      databaseOriginHost: DATABASE_REGISTRATION.originHost,
    });

    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected Better Auth publication");
    expect(multipartMetadata(publication.body)["bindings"]).toEqual([
      {
        type: "service",
        name: "OHMYHOST_DATABASE",
        service: "ohmyho-project-database-sandbox-us",
        entrypoint: "ProjectDatabaseService",
        props: {
          organizationId: ORGANIZATION,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          physicalEnvironmentId: ENVIRONMENT,
          registrationVersion: 1,
          region: "us",
        },
      },
      {
        type: "service",
        name: "OHMYHOST_MAIL_GATEWAY",
        service: "ohmyho-mail-gateway-sandbox",
      },
      {
        type: "plain_text",
        name: "BETTER_AUTH_URL",
        text: "https://dev-calm-river-studio.dev.check.omh.st",
      },
      {
        type: "plain_text",
        name: "OHMYHOST_MAIL_GATEWAY_URL",
        text: "https://ohmyho-mail-gateway-sandbox.your-omh-account.workers.dev",
      },
      {
        type: "plain_text",
        name: "OHMYHOST_PROJECT_ID",
        text: PROJECT,
      },
      { type: "secret_text", name: "OHMYHOST_MAIL_KEY", text: key },
    ]);
  });

  it("binds mail gateway identity for a mail-only edge project", async () => {
    const { management, provider: providerInstance } = harness();
    const key = "mail-only-key";
    const artifact = await edgeArtifact("nextjs-opennext-wrapper-v1");
    await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact,
      knownDeployments: [],
      runtimeSecretManifest: await createRuntimeSecretManifest([
        {
          name: "OHMYHOST_MAIL_KEY",
          value: key,
          revision: 1,
          valueSha256: await sha256(encoder.encode(key)),
        },
      ]),
    });
    expect(providerInstance.gatewayRegistry.activate).not.toHaveBeenCalled();
    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected mail-only publication");
    expect(multipartMetadata(publication.body)["bindings"]).toEqual(
      expect.arrayContaining([
        {
          type: "service",
          name: "OHMYHOST_MAIL_GATEWAY",
          service: "ohmyho-mail-gateway-sandbox",
        },
        { type: "secret_text", name: "OHMYHOST_MAIL_KEY", text: key },
        {
          type: "plain_text",
          name: "OHMYHOST_MAIL_GATEWAY_URL",
          text: "https://ohmyho-mail-gateway-sandbox.your-omh-account.workers.dev",
        },
        { type: "plain_text", name: "OHMYHOST_PROJECT_ID", text: PROJECT },
      ]),
    );
    expect(multipartMetadata(publication.body)["bindings"]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "BETTER_AUTH_URL" })]),
    );
  });

  it("binds the AI key, base URL and egress origin for an AI-enabled edge project", async () => {
    const { management, provider: providerInstance } = harness();
    const key = "ai-only-key";
    const artifact = await edgeArtifact("nextjs-opennext-wrapper-v1");
    const result = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact,
      knownDeployments: [],
      runtimeSecretManifest: await createRuntimeSecretManifest([
        {
          name: "OHMYHOST_AI_KEY",
          value: key,
          revision: 1,
          valueSha256: await sha256(encoder.encode(key)),
        },
      ]),
    });
    if (result.status !== "staged") throw new Error("Expected AI-only publication");
    expect(result.activationRuntimePolicy.egressAllowedOrigins).toEqual([
      "https://ai.dev.ohmyho.st",
    ]);
    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected AI-only publication");
    const bindings = multipartMetadata(publication.body)["bindings"];
    expect(bindings).toEqual(
      expect.arrayContaining([
        { type: "secret_text", name: "OHMYHOST_AI_KEY", text: key },
        { type: "plain_text", name: "OHMYHOST_AI_BASE_URL", text: "https://ai.dev.ohmyho.st/v1" },
      ]),
    );
    expect(bindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "OHMYHOST_PROJECT_ID" })]),
    );
    expect(bindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "service", name: "OHMYHOST_AI" })]),
    );
  });

  it("uses only Core-registered deployment and region for an opted-in Next cache binding", async () => {
    const registerNextCacheScope = vi.fn(async () => ({ region: "eu" }));
    const { management, provider: providerInstance } = harness({
      nextCacheAuthority: { registerNextCacheScope },
    });
    const artifact = await edgeArtifact(
      "nextjs-opennext-wrapper-v1",
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      { bytes: 32 * 1024 * 1024, assets: [], nextRevalidatePath: true },
    );
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const result = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope,
      deploymentId: DEPLOYMENT,
      artifact,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });
    expect(result.status).toBe("staged");
    expect(registerNextCacheScope).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      deploymentId: DEPLOYMENT,
    });
    const published = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (published === undefined) throw new Error("Expected a staged cache candidate");
    const metadata = multipartMetadata(published.body);
    expect(metadata["bindings"]).toEqual(
      expect.arrayContaining([
        {
          type: "service",
          name: "OHMYHOST_NEXT_CACHE",
          service: "ohmyho-next-cache-sandbox",
          entrypoint: "NextCacheRuntime",
          props: {
            organizationId: ORGANIZATION,
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            deploymentId: DEPLOYMENT,
            region: "eu",
          },
        },
      ]),
    );
    const tags = metadata["tags"] as string[];
    expect(tags.length).toBeLessThanOrEqual(8);
    expect(tags.filter((tag) => tag.startsWith("bindings:"))).toHaveLength(1);
    const denied = harness({ nextCacheAuthority: { registerNextCacheScope: async () => null } });
    await expect(
      denied.management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope,
        deploymentId: DEPLOYMENT,
        artifact,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(denied.provider.stageCandidate).not.toHaveBeenCalled();
  });

  it("stages and activates only the independently attested Next binding set through the real provider", async () => {
    const artifact = await edgeArtifact(
      "nextjs-opennext-wrapper-v1",
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      { bytes: 32 * 1024 * 1024, assets: [], nextRevalidatePath: true },
    );
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const scriptName = `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`;
    const cache = {
      service: "ohmyho-next-cache-sandbox",
      props: {
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        deploymentId: DEPLOYMENT,
        region: "eu",
      },
    };
    const cacheDigest = await sha256(encoder.encode(JSON.stringify(cache)));
    const expectedDigest = await sha256(
      encoder.encode(JSON.stringify([null, null, null, null, cacheDigest])),
    );
    let metadata: Record<string, unknown> | undefined;
    let tags: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/assets-upload-session"))
        return envelope({ jwt: "upload.jwt", buckets: [] });
      if (pathname.endsWith("/secrets")) return envelope([]);
      if (pathname.endsWith("/bindings")) {
        if (!Array.isArray(metadata?.["bindings"])) throw new Error("missing staged bindings");
        return envelope(
          metadata["bindings"].map((value: Record<string, unknown>) => ({
            type: value["type"],
            name: value["name"],
            ...(typeof value["service"] === "string" ? { service: value["service"] } : {}),
            ...(typeof value["entrypoint"] === "string" ? { entrypoint: value["entrypoint"] } : {}),
          })),
        );
      }
      if (pathname.endsWith(`/${scriptName}`) && init?.method === "PUT") {
        metadata = multipartMetadata(new Uint8Array(await new Response(init.body).arrayBuffer()));
        tags = [...(metadata["tags"] as string[])];
        return envelope({ id: scriptName, tag: PROVIDER_ID });
      }
      if (pathname.endsWith(`/${scriptName}`) && init?.method === "DELETE") {
        metadata = undefined;
        return envelope(null);
      }
      if (pathname.endsWith(`/${scriptName}`) && init?.method === "GET") {
        if (metadata === undefined)
          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 10007 }],
              messages: [],
              result: null,
            }),
            { status: 404 },
          );
        return envelope({
          modified_on: NOW.toISOString(),
          script: { id: scriptName, tag: PROVIDER_ID, deployment_id: PROVIDER_ID, tags },
        });
      }
      throw new Error("unexpected Cloudflare test route");
    });
    const providerInstance = new CloudflareWfpProvider({
      accountId: "00000000000000000000000000000001",
      namespace: "ohmyho-sandbox",
      apiToken: "synthetic-test-token",
      fetch,
      now: () => NOW,
    });
    const registry = provider().gatewayRegistry;
    const expectedGateway = gatewayReceipt({
      targetArtifactDigest: artifact.provenance.artifactDigest,
    });
    vi.mocked(registry.activate).mockResolvedValue(expectedGateway);
    vi.mocked(registry.observe).mockResolvedValue(expectedGateway);
    const management = createWfpManagement({
      bindings: {
        WFP_ACCOUNT_ID: "00000000000000000000000000000001",
        WFP_DISPATCH_NAMESPACE: "ohmyho-sandbox",
        WFP_API_TOKEN: "synthetic-test-token",
        WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
        ...SANDBOX_GATEWAY_BINDINGS,
      },
      provider: providerInstance,
      gatewayRegistry: registry,
      nextCacheAuthority: { registerNextCacheScope: async () => ({ region: "eu" }) },
      fetch,
      now: () => NOW,
      sleep: async () => undefined,
    });
    const staged = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope,
      deploymentId: DEPLOYMENT,
      artifact,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });
    if (staged.status !== "staged") throw new Error("Expected staged Next candidate");
    expect(tags).toContain(`bindings:${expectedDigest}`);
    const unsettledProvider = provider();
    vi.mocked(unsettledProvider.observeCandidate).mockResolvedValueOnce(
      candidateObservation(staged.candidate, { state: "unknown" }),
    );
    const unsettled = harness({
      provider: unsettledProvider,
      nextCacheAuthority: { registerNextCacheScope: async () => ({ region: "eu" }) },
    });
    expect(
      await unsettled.management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope,
        deploymentId: DEPLOYMENT,
        artifact,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).toMatchObject({ status: "reconciliation_required", reconciliationPhase: "candidate" });
    const activation = {
      organizationId: ORGANIZATION,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      scope,
      candidate: staged.candidate,
      runtimePolicy: staged.activationRuntimePolicy,
    };
    expect(await management.activateCandidate(activation)).toMatchObject({ status: "activated" });
    expect(staged.candidate).toMatchObject({ bindingSetDigest: expectedDigest });
    expect(await management.observeActivation(activation)).toMatchObject({ status: "observed" });
    const replayed = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope,
      deploymentId: DEPLOYMENT,
      artifact,
      knownDeployments: [staged.candidate],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });
    expect(replayed).toMatchObject({
      status: "replayed",
      candidate: { bindingSetDigest: expectedDigest },
    });
    expect(
      await management.prepareExistingCandidate({
        organizationId: ORGANIZATION,
        scope,
        candidate: staged.candidate,
        artifactSourceDeploymentId: DEPLOYMENT,
        artifact,
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).toMatchObject({ status: "prepared", candidate: { bindingSetDigest: expectedDigest } });
    await expect(
      providerInstance.syncRuntimeSecrets({
        scope,
        deployment: staged.candidate,
        manifest: await emptyRuntimeSecretManifest(),
      }),
    ).resolves.toMatchObject({ providerTag: PROVIDER_ID });
    const { bindingSetDigest: _digest, ...legacy } = staged.candidate;
    expect(_digest).toBe(expectedDigest);
    expect(await management.activateCandidate({ ...activation, candidate: legacy })).toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
    });
    expect(await management.observeActivation({ ...activation, candidate: legacy })).toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
    });
    const inherited = Object.assign(
      Object.create({ bindingSetDigest: expectedDigest }) as WfpDeploymentReceipt,
      legacy,
    );
    expect(
      await management.activateCandidate({ ...activation, candidate: inherited }),
    ).toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
    });
    expect(
      await management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope,
        deploymentId: DEPLOYMENT,
        artifact,
        knownDeployments: [legacy],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).toMatchObject({ status: "reconciliation_required", reconciliationPhase: "candidate" });
    expect(
      await management.prepareExistingCandidate({
        organizationId: ORGANIZATION,
        scope,
        candidate: legacy,
        artifactSourceDeploymentId: DEPLOYMENT,
        artifact,
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).toMatchObject({ status: "reconciliation_required", reconciliationPhase: "candidate" });
    const wrongReceipt: WfpDeploymentReceipt = {
      ...staged.candidate,
      bindingSetDigest: `sha256:${"e".repeat(64)}`,
    };
    expect(
      await management.prepareExistingCandidate({
        organizationId: ORGANIZATION,
        scope,
        candidate: wrongReceipt,
        artifactSourceDeploymentId: DEPLOYMENT,
        artifact,
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).toMatchObject({ status: "reconciliation_required", reconciliationPhase: "candidate" });
    expect(
      await management.activateCandidate({ ...activation, candidate: wrongReceipt }),
    ).toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
    });
    expect(
      await management.observeActivation({ ...activation, candidate: wrongReceipt }),
    ).toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
    });
    await expect(
      providerInstance.syncRuntimeSecrets({
        scope,
        deployment: wrongReceipt,
        manifest: await emptyRuntimeSecretManifest(),
      }),
    ).rejects.toMatchObject({ code: "cloudflare_deployment_conflict" });
    for (const invalid of [undefined, null, "sha256:bad"]) {
      await expect(
        management.activateCandidate({
          ...activation,
          candidate: { ...staged.candidate, bindingSetDigest: invalid } as WfpDeploymentReceipt,
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    const exactTags = [...tags];
    for (const replacement of [`bindings:sha256:${"f".repeat(64)}`, null]) {
      tags = exactTags.filter((tag) => !tag.startsWith("bindings:"));
      if (replacement !== null) tags.push(replacement);
      expect(await management.activateCandidate(activation)).toMatchObject({
        status: "reconciliation_required",
        reconciliationPhase: "candidate",
      });
      expect(await management.observeActivation(activation)).toMatchObject({
        status: "reconciliation_required",
        reconciliationPhase: "candidate",
      });
      await expect(
        providerInstance.syncRuntimeSecrets({
          scope,
          deployment: staged.candidate,
          manifest: await emptyRuntimeSecretManifest(),
        }),
      ).rejects.toMatchObject({ code: "cloudflare_deployment_conflict" });
      await expect(
        providerInstance.removeCandidate({ scope, expectedDeployment: staged.candidate }),
      ).rejects.toMatchObject({ code: "cloudflare_deployment_conflict" });
    }
    tags = exactTags.map((tag) =>
      tag === `project:${PROJECT}` ? `project:${OTHER_PROJECT}` : tag,
    );
    await expect(management.activateCandidate(activation)).rejects.toMatchObject({
      code: "cloudflare_contract_invalid",
    });
    expect(registry.activate).toHaveBeenCalledTimes(1);
    tags = exactTags;
    expect(
      await management.removeCandidate({
        organizationId: ORGANIZATION,
        operationId: activation.operationId,
        claimId: activation.claimId,
        candidateReceiptId: activation.candidateReceiptId,
        scope,
        candidate: staged.candidate,
      }),
    ).toMatchObject({ status: "removed", outcome: "removed" });
  });

  it("installs the Browser key and public gateway URL without giving the customer a Browser binding", async () => {
    const { management, provider: providerInstance } = harness();
    const key = "browser-only-key";
    const artifact = await edgeArtifact("nextjs-opennext-wrapper-v1");
    const result = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact,
      knownDeployments: [],
      runtimeSecretManifest: await createRuntimeSecretManifest([
        {
          name: "OHMYHOST_BROWSER_KEY",
          value: key,
          revision: 1,
          valueSha256: await sha256(encoder.encode(key)),
        },
      ]),
    });
    if (result.status !== "staged") throw new Error("Expected browser publication");
    expect(result.activationRuntimePolicy.egressAllowedOrigins).toEqual([
      "https://browser.dev.ohmyho.st",
    ]);
    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected browser publication");
    const bindings = multipartMetadata(publication.body)["bindings"];
    expect(bindings).toEqual(
      expect.arrayContaining([
        { type: "secret_text", name: "OHMYHOST_BROWSER_KEY", text: key },
        {
          type: "plain_text",
          name: "OHMYHOST_BROWSER_BASE_URL",
          text: "https://browser.dev.ohmyho.st/v1",
        },
      ]),
    );
    expect(bindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "browser" })]),
    );
  });

  it("omits the AI identity when the manifest carries no AI key", async () => {
    const { management, provider: providerInstance } = harness();
    const artifact = await edgeArtifact("nextjs-opennext-wrapper-v1");
    const result = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });
    if (result.status !== "staged") throw new Error("Expected plain edge publication");
    expect(result.activationRuntimePolicy.egressAllowedOrigins).not.toContain(
      "https://ai.dev.ohmyho.st",
    );
    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected plain edge publication");
    expect(multipartMetadata(publication.body)["bindings"]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "OHMYHOST_AI_KEY" }),
        expect.objectContaining({ name: "OHMYHOST_AI_BASE_URL" }),
      ]),
    );
  });

  it("keeps the AI origin on a rollback only while the manifest carries the AI key", async () => {
    const withKey = await createRuntimeSecretManifest([
      {
        name: "OHMYHOST_AI_KEY",
        value: "ai-rollback-key",
        revision: 1,
        valueSha256: await sha256(encoder.encode("ai-rollback-key")),
      },
    ]);
    const inputArtifact = await edgeArtifact("nextjs-opennext-wrapper-v1");
    const digest = JSON.parse(new TextDecoder().decode(inputArtifact.manifestBody))
      .artifactDigest as `sha256:${string}`;
    const target = receipt({ artifactDigest: digest });
    for (const [manifest, expected] of [
      [withKey, ["https://ai.dev.ohmyho.st"]],
      [await emptyRuntimeSecretManifest(), []],
    ] as const) {
      const providerInstance = provider();
      vi.mocked(providerInstance.observeCandidate).mockResolvedValue({
        state: "ready",
        scriptName: target.scriptName,
        providerTag: target.providerTag,
        productDeploymentId: target.productDeploymentId,
        artifactDigest: target.artifactDigest,
        observedAt: NOW,
      });
      const { management } = harness({ provider: providerInstance });
      const result = await management.prepareExistingCandidate({
        artifactSourceDeploymentId: DEPLOYMENT,
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: target,
        artifact: inputArtifact,
        runtimeSecretManifest: manifest,
      });
      expect(result).toMatchObject({ status: "prepared" });
      if (result.status !== "prepared") throw new Error("Expected prepared rollback");
      expect(result.activationRuntimePolicy.egressAllowedOrigins).toEqual(expected);
    }
  });

  it.each(["OHMYHOST_AI_BASE_URL"])(
    "rejects a customer %s collision with AI enabled before provider mutation",
    async (name) => {
      const providerInstance = provider();
      const { management } = harness({ provider: providerInstance });
      const value = "https://evil.example";
      const runtimeSecretManifest = await createRuntimeSecretManifest([
        {
          name: "OHMYHOST_AI_KEY",
          value: "ai-collision-key",
          revision: 1,
          valueSha256: await sha256(encoder.encode("ai-collision-key")),
        },
        {
          name,
          value,
          revision: 1,
          valueSha256: await sha256(encoder.encode(value)),
        },
      ]);
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: await edgeArtifact("nextjs-opennext-wrapper-v1"),
          knownDeployments: [],
          runtimeSecretManifest,
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
      expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
    },
  );

  it("refuses an AI origin that does not belong to the dispatch namespace", () => {
    const base = {
      WFP_ACCOUNT_ID: "00000000000000000000000000000001",
      WFP_API_TOKEN: "token",
      WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
      DATABASE_SERVICE_US: "ohmyho-project-database-sandbox-us",
      DATABASE_SERVICE_EU: "ohmyho-project-database-sandbox-eu",
      WFP_MAIL_GATEWAY_SERVICE: "ohmyho-mail-gateway-sandbox",
      WFP_MAIL_GATEWAY_ORIGIN: SANDBOX_GATEWAY_BINDINGS.WFP_MAIL_GATEWAY_ORIGIN,
      WFP_STORAGE_GATEWAY_ORIGIN: SANDBOX_GATEWAY_BINDINGS.WFP_STORAGE_GATEWAY_ORIGIN,
    };
    expect(() =>
      createWfpManagement({
        bindings: {
          ...base,
          WFP_DISPATCH_NAMESPACE: "ohmyho-sandbox",
          WFP_AI_GATEWAY_ORIGIN: "https://ai.ohmyho.st",
        },
        provider: provider(),
        gatewayRegistry: provider().gatewayRegistry,
        fetch: vi.fn(),
      }),
    ).toThrow(WfpManagementInputError);
    expect(() =>
      createWfpManagement({
        bindings: {
          ...base,
          DATABASE_SERVICE_US: "ohmyho-project-database-production-us",
          DATABASE_SERVICE_EU: "ohmyho-project-database-production-eu",
          WFP_MAIL_GATEWAY_SERVICE: "ohmyho-mail-gateway-production",
          WFP_MAIL_GATEWAY_ORIGIN:
            "https://ohmyho-mail-gateway-production.your-omh-account.workers.dev",
          WFP_STORAGE_GATEWAY_ORIGIN:
            "https://ohmyho-storage-gateway-production.your-omh-account.workers.dev",
          WFP_DISPATCH_NAMESPACE: "ohmyho-production",
          WFP_AI_GATEWAY_ORIGIN: "https://ai.dev.ohmyho.st",
        },
        provider: provider(),
        gatewayRegistry: provider().gatewayRegistry,
        fetch: vi.fn(),
      }),
    ).toThrow(WfpManagementInputError);
  });

  it("refuses an activation whose egress list would exceed the 16-origin cap", async () => {
    const providerInstance = provider();
    const { management } = harness({ provider: providerInstance });
    const customerOrigins = Array.from(
      { length: 15 },
      (_, index) => `https://api${String(index).padStart(2, "0")}.example.test`,
    );
    const runtimeSecretManifest = await createRuntimeSecretManifest([
      {
        name: "OHMYHOST_MAIL_KEY",
        value: "mail-cap-key",
        revision: 1,
        valueSha256: await sha256(encoder.encode("mail-cap-key")),
      },
      {
        name: "OHMYHOST_AI_KEY",
        value: "ai-cap-key",
        revision: 1,
        valueSha256: await sha256(encoder.encode("ai-cap-key")),
      },
    ]);
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await artifact({
          runtimePolicy: { healthCheckPath: "/ready", egressAllowedOrigins: customerOrigins },
        }),
        knownDeployments: [],
        runtimeSecretManifest,
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("rejects a customer BETTER_AUTH_URL collision before provider mutation", async () => {
    const providerInstance = provider();
    const { management } = harness({ provider: providerInstance });
    const value = "https://evil.example";
    const runtimeSecretManifest = await createRuntimeSecretManifest([
      {
        name: "BETTER_AUTH_URL",
        value,
        revision: 1,
        valueSha256: await sha256(encoder.encode(value)),
      },
    ]);
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await artifactWithCustomerAuth(),
        knownDeployments: [],
        runtimeSecretManifest,
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it.each(["OHMYHOST_MAIL_GATEWAY_URL", "OHMYHOST_MAIL_GATEWAY"])(
    "rejects a customer %s collision before provider mutation",
    async (name) => {
      const providerInstance = provider();
      const { management } = harness({ provider: providerInstance });
      const value = "https://evil.example";
      const runtimeSecretManifest = await createRuntimeSecretManifest([
        {
          name,
          value,
          revision: 1,
          valueSha256: await sha256(encoder.encode(value)),
        },
      ]);
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: await artifactWithCustomerAuth(),
          knownDeployments: [],
          runtimeSecretManifest,
          databaseRegistration: DATABASE_REGISTRATION,
          databaseOriginHost: DATABASE_REGISTRATION.originHost,
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
      expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
    },
  );

  it.each(["OHMYHOST_CRONS", "OHMYHOST_IMMUTABLE_SCRIPT_NAME", "OHMYHOST_NEXT_CACHE"])(
    "rejects customer collision with reserved platform binding %s",
    async (name) => {
      const providerInstance = provider();
      const { management } = harness({ provider: providerInstance });
      const value = "must-not-shadow-platform-binding";
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: await edgeArtifact("vite-api-companion-v1"),
          knownDeployments: [],
          runtimeSecretManifest: await createRuntimeSecretManifest([
            {
              name,
              value,
              revision: 1,
              valueSha256: await sha256(encoder.encode(value)),
            },
          ]),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
      expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
    },
  );

  it("rejects a static Better Auth artifact until its executable companion is present", async () => {
    const providerInstance = provider();
    const { management } = harness({ provider: providerInstance });
    const inputArtifact = await artifactWithMigrations();
    const mutable = inputArtifact as unknown as {
      manifestBody: Uint8Array;
      manifestDigest: `sha256:${string}`;
      provenance: Record<string, unknown>;
    };
    const manifest = JSON.parse(new TextDecoder().decode(inputArtifact.manifestBody)) as Record<
      string,
      unknown
    >;
    const auth = {
      provider: "better-auth",
      version: "1.7.7",
      deployment: "companion",
      routePath: "/api/auth",
      databaseSchema: "auth",
      databaseBindingName: "OHMYHOST_DATABASE",
      authSecretName: "BETTER_AUTH_SECRET",
    } as const;
    manifest["auth"] = auth;
    manifest["artifactDigest"] = await sha256(
      encoder.encode(
        JSON.stringify({
          applicationRoot: manifest["applicationRoot"],
          frameworkPlanSchemaVersion: manifest["frameworkPlanSchemaVersion"],
          runtimePolicy: manifest["runtimePolicy"],
          database: manifest["database"],
          auth,
          migrations: manifest["migrations"],
          assets: manifest["assets"],
        }),
      ),
    );
    mutable.manifestBody = encoder.encode(JSON.stringify(manifest));
    mutable.manifestDigest = await sha256(mutable.manifestBody);
    mutable.provenance = Object.freeze({
      ...inputArtifact.provenance,
      auth,
      artifactDigest: manifest["artifactDigest"] as `sha256:${string}`,
    });

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: inputArtifact,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(providerInstance.gatewayRegistry.activate).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("rejects the superseded customer-facing Hyperdrive auth binding", async () => {
    const { management, provider: providerInstance } = harness();

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await artifactWithCustomerAuth({ databaseBindingName: "HYPERDRIVE" }),
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        databaseRegistration: DATABASE_REGISTRATION,
        databaseOriginHost: DATABASE_REGISTRATION.originHost,
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("stages an asset-free functions runtime with ESM and WASM modules without an upload session", async () => {
    const { management, provider: providerInstance, fetch } = harness();

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await edgeArtifact(
          "functions-v1",
          encoder.encode(
            'import "./codec.mjs"; export default { fetch(){return new Response("fn")}, scheduled(){} };',
          ),
          "2025-01-01",
          undefined,
          new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
          [
            {
              path: "codec.mjs",
              body: encoder.encode('import wasm from "./codec.wasm"; export default wasm;'),
            },
          ],
          normalizeBrowserPolicy({ connect: ["https://browser.example.test"] }),
        ),
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).resolves.toMatchObject({ status: "staged" });

    expect(fetch).not.toHaveBeenCalled();
    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected functions publication");
    const metadata = multipartMetadata(publication.body);
    expect(metadata).not.toHaveProperty("assets");
    expect(metadata["bindings"]).toEqual([
      { type: "plain_text", name: "OHMYHOST_CRONS", text: '["*/5 * * * *"]' },
      {
        type: "plain_text",
        name: "OHMYHOST_IMMUTABLE_SCRIPT_NAME",
        text: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
      },
    ]);
    expect(metadata["tags"]).toEqual([
      `project:${PROJECT}`,
      `environment:${ENVIRONMENT}`,
      `deployment:${DEPLOYMENT}`,
      `artifact:${publication.digest}`,
      WFP_CANDIDATE_LAYOUT_TAG,
      "runtime:edge",
      expect.stringMatching(/^crons:sha256:[a-f0-9]{64}$/u),
    ]);
    expect(metadata["compatibility_date"]).toBe("2025-01-01");
    expect(publication.platformBindings).toEqual({
      immutableScriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
      crons: ["*/5 * * * *"],
    });
    const text = new TextDecoder().decode(publication.body);
    expect(text).toContain('name="ohmyhost-entry.mjs"');
    expect(text).toContain('name="index.js"');
    expect(text).toContain('name="codec.mjs"');
    expect(text).toContain('name="codec.wasm"');
    expect(text).toContain("scheduled.ohmyhost.internal");
    expect(text).not.toContain("ohmyhost-worker.js");
  });

  it("publishes OpenNext assets worker-first with the reserved assets binding and sorted secrets", async () => {
    const inputArtifact = await edgeArtifact(
      "nextjs-opennext-wrapper-v1",
      undefined,
      "2026-08-21",
      undefined,
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    const betaValue = "beta-secret";
    const alphaValue = "alpha-secret";
    const runtimeSecretManifest = await createRuntimeSecretManifest([
      {
        name: "ZETA_TOKEN",
        value: betaValue,
        revision: 1,
        valueSha256: await sha256(encoder.encode(betaValue)),
      },
      {
        name: "ALPHA_TOKEN",
        value: alphaValue,
        revision: 1,
        valueSha256: await sha256(encoder.encode(alphaValue)),
      },
    ]);
    const { management, provider: providerInstance } = harness();

    await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: inputArtifact,
      knownDeployments: [],
      runtimeSecretManifest,
    });

    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected OpenNext publication");
    expect(multipartMetadata(publication.body)).toEqual({
      main_module: "ohmyhost-entry.mjs",
      logpush: true,
      assets: {
        jwt: "upload.jwt",
        config: {
          html_handling: "auto-trailing-slash",
          not_found_handling: "404-page",
          run_worker_first: true,
        },
      },
      bindings: [
        { type: "assets", name: "ASSETS" },
        { type: "secret_text", name: "ALPHA_TOKEN", text: alphaValue },
        { type: "secret_text", name: "ZETA_TOKEN", text: betaValue },
      ],
      tags: [
        `project:${PROJECT}`,
        `environment:${ENVIRONMENT}`,
        `deployment:${DEPLOYMENT}`,
        `artifact:${publication.digest}`,
        WFP_CANDIDATE_LAYOUT_TAG,
        "runtime:edge",
      ],
      compatibility_date: "2026-08-21",
      compatibility_flags: ["nodejs_compat"],
    });
    const text = new TextDecoder().decode(publication.body);
    expect(text).toContain(
      'name="codec.wasm"; filename="codec.wasm"\r\nContent-Type: application/wasm',
    );
    expect(text).toContain('import userWorker from "./index.js"');
    expect(text).not.toContain(`/p/${PROJECT}/`);
    expect(text).toContain('headers.set("x-ohmyhost-runtime", "edge-v1")');
  });

  it("publishes traced Next.js data as private binary multipart modules without changing bytes", async () => {
    const data = [
      { path: "content/article.md", body: encoder.encode("# Public article\n") },
      { path: "data/binary.bin", body: new Uint8Array([0, 255, 13, 10, 42]) },
      {
        path: "node_modules/@scope/package/package.json",
        body: encoder.encode('{"name":"@scope/package"}'),
      },
      { path: "public/empty.txt", body: new Uint8Array() },
      { path: `${"a".repeat(147)}/${"b".repeat(95)}.json`, body: encoder.encode("{}") },
      { path: "node_modules/.pnpm/@scope+package@1.0.0/LICENSE", body: encoder.encode("License") },
    ];
    const inputArtifact = await edgeArtifact(
      "nextjs-opennext-wrapper-v1",
      encoder.encode(`import { readFileSync } from "node:fs";
export default { fetch(request) {
  if (new URL(request.url).pathname !== "/") return new Response("Not Found", { status: 404 });
  return Response.json({ article: readFileSync("/bundle/content/article.md", "utf8"), binary: [...readFileSync("/bundle/data/binary.bin")] });
} };`),
      "2026-08-21",
      undefined,
      undefined,
      data.map((module) => ({ ...module, contentType: "application/octet-stream" })),
    );
    const { management, provider: providerInstance, fetch } = harness();
    await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: inputArtifact,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });
    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected data module publication");
    const form = await new Response(new Uint8Array(publication.body), {
      headers: { "content-type": publication.contentType },
    }).formData();
    for (const module of data) {
      const part = form.get(module.path);
      if (!(part instanceof File)) throw new Error("Expected binary file part");
      expect(part.type).toBe("application/octet-stream");
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(module.body);
    }
    const uploadSession = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)) as {
      manifest: Record<string, unknown>;
    };
    expect(Object.keys(uploadSession.manifest)).toEqual(["/assets/client.js"]);
    expect(multipartMetadata(publication.body)["main_module"]).toBe("ohmyhost-entry.mjs");
    expect((form.get("index.js") as File).type).toBe("application/javascript+module");
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-data-modules-"));
    const modules = await Promise.all(
      [...form.entries()]
        .filter(([name]) => name !== "metadata")
        .map(async ([name, part]) => {
          if (!(part instanceof File)) throw new Error("Expected Worker file part");
          return {
            type:
              part.type === "application/octet-stream" ? ("Data" as const) : ("ESModule" as const),
            path: join(directory, name),
            contents: new Uint8Array(await part.arrayBuffer()),
          };
        }),
    );
    // The production multipart is decoded into the same module types that Cloudflare runs.
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        rootPath: directory,
        modulesRoot: directory,
        cf: false,
        modules,
        compatibilityDate: "2026-08-21",
        compatibilityFlags: ["nodejs_compat"],
      }),
    );
    try {
      const response = await miniflare.dispatchFetch("https://data.example.com/");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        article: "# Public article\n",
        binary: [0, 255, 13, 10, 42],
      });
      const privateFile = await miniflare.dispatchFetch(
        "https://data.example.com/content/article.md",
      );
      expect(privateFile.status).toBe(404);
    } finally {
      await miniflare.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a smuggled upload boundary and metadata part inside the customer module bytes", async () => {
    const smuggled = encoder.encode(
      `# Article\r\n--ohmyhost-${DEPLOYMENT.toLowerCase()}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{"main_module":"forged.mjs"}\r\n`,
    );
    const inputArtifact = await edgeArtifact(
      "nextjs-opennext-wrapper-v1",
      undefined,
      "2026-08-21",
      undefined,
      undefined,
      [{ path: "content/article.md", body: smuggled, contentType: "application/octet-stream" }],
    );
    const { management, provider: providerInstance } = harness();
    await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: inputArtifact,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });
    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected Worker publication");
    expect(publication.contentType).toMatch(
      /^multipart\/form-data; boundary=ohmyhost-[0-9a-f]{32}$/u,
    );
    const form = await new Response(new Uint8Array(publication.body), {
      headers: { "content-type": publication.contentType },
    }).formData();
    expect(form.getAll("metadata")).toHaveLength(1);
    expect(multipartMetadata(publication.body)["main_module"]).toBe("ohmyhost-entry.mjs");
    const part = form.get("content/article.md");
    if (!(part instanceof File)) throw new Error("Expected binary file part");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(smuggled);
  });

  it("moves to the next boundary counter when the module bytes contain the first boundary", async () => {
    const forged = encoder.encode(
      `# Article\r\n--${attemptBoundary(0)}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{"main_module":"forged.mjs"}\r\n`,
    );
    const upload = await contentUpload(forged);
    await withAttemptDigests(upload.stage);
    const publication = upload.publication();
    expect(publication.contentType).toBe(`multipart/form-data; boundary=${attemptBoundary(1)}`);
    const form = await new Response(new Uint8Array(publication.body), {
      headers: { "content-type": publication.contentType },
    }).formData();
    expect(form.getAll("metadata")).toHaveLength(1);
    const part = form.get("content/article.md");
    if (!(part instanceof File)) throw new Error("Expected binary file part");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(forged);
  });

  it("fails the upload without a provider call when every boundary counter is present in the module bytes", async () => {
    const forged = encoder.encode(
      Array.from({ length: 8 }, (_, attempt) => `--${attemptBoundary(attempt)}\r\n`).join(""),
    );
    const upload = await contentUpload(forged);
    await expect(withAttemptDigests(upload.stage)).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(upload.providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("encodes the same upload byte for byte and derives the boundary from the module bytes", async () => {
    const first = await contentUpload(encoder.encode("# Article"));
    const repeated = await contentUpload(encoder.encode("# Article"));
    const other = await contentUpload(encoder.encode("# Other article"));
    await first.stage();
    await repeated.stage();
    await other.stage();
    expect(repeated.publication().body).toEqual(first.publication().body);
    expect(repeated.publication().contentType).toBe(first.publication().contentType);
    expect(other.publication().contentType).not.toBe(first.publication().contentType);
  });

  it("rejects forged data paths, types, integrity and executable roles before provider mutation", async () => {
    const data = {
      path: "content/article.md",
      contentType: "application/octet-stream",
      body: encoder.encode("# Article"),
    };
    const cases = [
      ...[
        "/absolute.json",
        "../outside.json",
        "content/../outside.json",
        "content//data.json",
        "content/./data.json",
        "C:\\data.json",
        "content/data\n.json",
        `${"a".repeat(244)}.json`,
        "addon.node",
        "addon.NODE",
        "worker.js",
        "worker.mjs",
        "worker.cjs",
        "module.wasm",
        "index.js",
        "ohmyhost-worker.js",
        "ohmyhost-entry.mjs",
        "metadata",
        "content/METADATA",
      ].map((path) => ({ module: { ...data, path } })),
      { module: { ...data, contentType: "text/plain" } },
      { module: { ...data, contentType: "application/javascript+module" } },
      {
        module: {
          path: "empty.js",
          contentType: "application/javascript+module",
          body: new Uint8Array(),
        },
      },
      ...["ohmyhost-entry.mjs", "Ohmyhost-Entry.mjs"].map((path) => ({
        module: {
          path,
          contentType: "application/javascript+module",
          body: encoder.encode("export default {};"),
        },
      })),
      { module: { ...data, digest: "sha256:bad" } },
      { module: { ...data, digest: `sha256:${"f".repeat(64)}` } },
      { module: { ...data, size: data.body.byteLength + 1 } },
      { module: { ...data, size: -1 } },
      { module: { ...data, size: 0.5 } },
      { module: { ...data, size: 5 * 1024 * 1024 + 1 } },
      { module: data, entryWrapperVersion: "tanstack-edge-wrapper-v1" as const },
      { module: data, entryWrapperVersion: "vite-api-companion-v1" as const },
      { module: data, entryWrapperVersion: "functions-v1" as const },
    ];
    const { management, provider: providerInstance, fetch } = harness();
    for (const candidate of cases) {
      const inputArtifact = await edgeArtifact(
        "entryWrapperVersion" in candidate
          ? candidate.entryWrapperVersion
          : "nextjs-opennext-wrapper-v1",
        undefined,
        "2026-08-21",
        undefined,
        undefined,
        [candidate.module],
      );
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: inputArtifact,
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
        JSON.stringify(candidate),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("revalidates delivered private data against the already verified manifest", async () => {
    const inputArtifact = await edgeArtifact(
      "nextjs-opennext-wrapper-v1",
      undefined,
      "2026-08-21",
      undefined,
      undefined,
      [
        {
          path: "content/article.md",
          body: encoder.encode("# Article"),
          contentType: "application/octet-stream",
        },
      ],
    );
    const overrides = [
      { body: encoder.encode("# Altered") },
      { path: "content/other.md" },
      { contentType: "application/javascript+module" as const },
      { digest: `sha256:${"f".repeat(64)}` as const },
      { size: 0 },
    ];
    const { management, provider: providerInstance, fetch } = harness();
    for (const override of overrides) {
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: {
            ...inputArtifact,
            modules: inputArtifact.modules.map((module) =>
              module.path === "content/article.md" ? { ...module, ...override } : module,
            ),
          },
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("includes private data in Next.js compressed, raw, and count budgets", async () => {
    const data = new Uint8Array(4 * 1024 * 1024);
    for (let offset = 0; offset < data.length; offset += 65536)
      crypto.getRandomValues(data.subarray(offset, offset + 65536));
    const cases = [
      [0, 1, 2].map((index) => ({
        path: `data/${index}.bin`,
        body: data,
        contentType: "application/octet-stream",
      })),
      [0, 1, 2, 3].map((index) => ({
        path: `data/${index}.bin`,
        body: new Uint8Array(4 * 1024 * 1024),
        contentType: "application/octet-stream",
      })),
      Array.from({ length: 999 }, (_, index) => ({
        path: `data/${String(index).padStart(4, "0")}.bin`,
        body: new Uint8Array(),
        contentType: "application/octet-stream",
      })),
    ];
    const { management, provider: providerInstance, fetch } = harness();
    for (const modules of cases) {
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: await edgeArtifact(
            "nextjs-opennext-wrapper-v1",
            undefined,
            "2026-08-21",
            undefined,
            undefined,
            modules,
          ),
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("checks compressed module sizes through bounded views of the exact verified byte ranges", async () => {
    const backing = new Uint8Array(2 * 65_536 + 77).fill(255);
    const body = backing.subarray(17, backing.length - 23);
    for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
    const artifact = await edgeArtifact(
      "nextjs-opennext-wrapper-v1",
      undefined,
      "2026-08-21",
      undefined,
      undefined,
      [{ path: "data/private.bin", contentType: "application/octet-stream", body }],
    );
    const NativeCompressionStream = globalThis.CompressionStream;
    const chunks: Uint8Array[] = [];
    vi.stubGlobal(
      "CompressionStream",
      class {
        readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
        readonly writable: WritableStream<Uint8Array<ArrayBuffer>>;
        constructor(format: CompressionFormat) {
          const native = new NativeCompressionStream(format);
          const writer = native.writable.getWriter();
          this.readable = native.readable;
          this.writable = new WritableStream({
            write(chunk) {
              chunks.push(chunk);
              return writer.write(chunk);
            },
            close: () => writer.close(),
            abort: (reason: unknown) => writer.abort(reason),
          });
        }
      },
    );
    try {
      const { management } = harness();
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact,
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).resolves.toMatchObject({ status: "staged" });
      const dataChunks = chunks.filter((chunk) => chunk.buffer === backing.buffer);
      expect(dataChunks.map((chunk) => [chunk.byteOffset, chunk.byteLength])).toEqual([
        [17, 65_536],
        [17 + 65_536, 65_536],
        [17 + 2 * 65_536, 37],
      ]);
      expect(chunks.every((chunk) => chunk.byteLength <= 65_536)).toBe(true);
      expect(backing.subarray(0, 17).every((byte) => byte === 255)).toBe(true);
      expect(backing.subarray(backing.length - 23).every((byte) => byte === 255)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // TanStack Start prerenders every route to its own file, so its static build keeps the 404 page.
  it("keeps the 404 page for a prerendered TanStack static artifact", async () => {
    const { management, provider: providerInstance } = harness();

    await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: await artifact({}, "tanstack-start"),
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });

    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected TanStack static publication");
    expect(multipartMetadata(publication.body)["assets"]).toEqual({
      jwt: "upload.jwt",
      config: {
        html_handling: "auto-trailing-slash",
        not_found_handling: "404-page",
        run_worker_first: true,
      },
    });
  });

  it("keeps TanStack edge asset metadata free of OpenNext-only routing and bindings", async () => {
    const { management, provider: providerInstance } = harness();

    await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: await edgeArtifact(),
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });

    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    if (publication === undefined) throw new Error("Expected TanStack publication");
    const metadata = multipartMetadata(publication.body);
    expect(metadata["bindings"]).toEqual([]);
    expect(metadata["assets"]).toEqual({
      jwt: "upload.jwt",
      config: { html_handling: "auto-trailing-slash", not_found_handling: "404-page" },
    });
  });

  it("gives a Next.js tenant the assets binding and never the raw Images binding", async () => {
    const { management, provider: providerInstance } = harness();
    await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: await edgeArtifact("nextjs-opennext-wrapper-v1"),
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });
    const published = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    const bindings = multipartMetadata(published?.body as Uint8Array)["bindings"];
    expect(bindings).toEqual([{ type: "assets", name: "ASSETS" }]);
  });

  it("rejects reserved OpenNext binding names before publishing", async () => {
    for (const name of ["ASSETS", "IMAGES"] as const) {
      const secret = "must-not-be-published";
      const { management, fetch, provider: providerInstance } = harness();

      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: await edgeArtifact("nextjs-opennext-wrapper-v1"),
          knownDeployments: [],
          runtimeSecretManifest: await createRuntimeSecretManifest([
            {
              name,
              value: secret,
              revision: 1,
              valueSha256: await sha256(encoder.encode(secret)),
            },
          ]),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
      expect(fetch).not.toHaveBeenCalled();
      expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
    }
  });

  it("rejects unknown edge wrappers and generated configuration modules", async () => {
    const unknownWrapper = await edgeArtifact();
    const unknownManifest = JSON.parse(new TextDecoder().decode(unknownWrapper.manifestBody)) as {
      runtime: { entryWrapperVersion: string };
    };
    unknownManifest.runtime.entryWrapperVersion = "unknown-wrapper-v1";
    const mutableUnknownWrapper = unknownWrapper as unknown as {
      manifestBody: Uint8Array;
      manifestDigest: `sha256:${string}`;
    };
    mutableUnknownWrapper.manifestBody = encoder.encode(JSON.stringify(unknownManifest));
    mutableUnknownWrapper.manifestDigest = await sha256(mutableUnknownWrapper.manifestBody);

    const generatedConfig = await edgeArtifact("nextjs-opennext-wrapper-v1");
    const mutableModules = generatedConfig.modules as unknown as Array<
      (typeof generatedConfig.modules)[number]
    >;
    const firstModule = mutableModules[0];
    if (firstModule === undefined) throw new Error("Expected edge module");
    mutableModules[0] = { ...firstModule, path: "wrangler.json" };

    const { management, fetch, provider: providerInstance } = harness();
    for (const candidate of [unknownWrapper, generatedConfig]) {
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: candidate,
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("rejects a raw edge module above the 15 MiB publication boundary", async () => {
    const oversizedMain = new Uint8Array(15 * 1024 * 1024 + 1).fill(97);
    const { management, fetch, provider: providerInstance } = harness();

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await edgeArtifact("nextjs-opennext-wrapper-v1", oversizedMain),
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).rejects.toBeInstanceOf(WfpManagementInputError);
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("accepts a Worker plus static assets above 25 MiB when every provider limit is respected", async () => {
    const main = new Uint8Array(8 * 1024 * 1024).fill(97);
    const client = new Uint8Array(9 * 1024 * 1024).fill(98);
    const { management } = harness();

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await edgeArtifact(
          "nextjs-opennext-wrapper-v1",
          main,
          "2026-08-21",
          client,
          undefined,
          [],
          undefined,
          {
            bytes: 32 * 1024 * 1024,
            assets: [{ path: "/assets/second-client.js", body: client }],
          },
        ),
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).resolves.toMatchObject({ status: "staged" });
  });

  it("enforces wrapper-specific minimum compatibility dates", async () => {
    const accepted = [
      await edgeArtifact("nextjs-opennext-wrapper-v1", undefined, "2024-09-23"),
      await edgeArtifact("tanstack-edge-wrapper-v1", undefined, "2025-04-01"),
      await edgeArtifact("vite-api-companion-v1", undefined, "2025-01-01"),
      await edgeArtifact("functions-v1", undefined, "2025-01-01"),
    ];
    for (const candidate of accepted) {
      const { management } = harness();
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: candidate,
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).resolves.toMatchObject({ status: "staged" });
    }

    const rejected = [
      await edgeArtifact("nextjs-opennext-wrapper-v1", undefined, "2024-09-22"),
      await edgeArtifact("tanstack-edge-wrapper-v1", undefined, "2025-03-31"),
      await edgeArtifact("vite-api-companion-v1", undefined, "2025-01-02"),
      await edgeArtifact("functions-v1", undefined, "2025-01-02"),
    ];
    for (const candidate of rejected) {
      const { management, fetch, provider: providerInstance } = harness();
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: candidate,
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
      expect(fetch).not.toHaveBeenCalled();
      expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
    }
  });

  it("publishes runtime secrets in the same atomic User Worker multipart without returning them", async () => {
    const inputArtifact = await artifact();
    const secretValue = "postgres://runtime-only";
    const valueSha256 = await sha256(encoder.encode(secretValue));
    const manifestDigest = await sha256(
      encoder.encode(`ohmyhost-runtime-secret-manifest-v1\nDATABASE_URL\t2\t${valueSha256}\n`),
    );
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        manifest: Record<string, { hash: string }>;
      };
      return envelope({
        jwt: "upload.jwt",
        buckets: [[request.manifest["/index.html"]?.hash]],
      });
    });
    fetch.mockResolvedValueOnce(envelope({ jwt: "complete.jwt" }, 201));
    const { management, provider: providerInstance } = harness({ fetch });
    const settledProviderTag = "d".repeat(32);
    const artifactDigest = (
      JSON.parse(new TextDecoder().decode(inputArtifact.manifestBody)) as {
        artifactDigest: `sha256:${string}`;
      }
    ).artifactDigest;
    vi.mocked(providerInstance.observeCandidate).mockResolvedValueOnce({
      state: "unknown",
      scriptName: receipt().scriptName,
      providerTag: settledProviderTag,
      productDeploymentId: DEPLOYMENT,
      artifactDigest,
      observedAt: NOW,
    });

    const result = await management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: inputArtifact,
      knownDeployments: [],
      runtimeSecretManifest: {
        digest: manifestDigest,
        secrets: [{ name: "DATABASE_URL", value: secretValue, revision: 2, valueSha256 }],
      },
    } as never);

    const publication = vi.mocked(providerInstance.stageCandidate).mock.calls[0]?.[0].artifact;
    const body = new TextDecoder().decode(publication?.body);
    expect(body).toContain(
      `"bindings":[{"type":"assets","name":"ASSETS"},{"type":"secret_text","name":"DATABASE_URL","text":"${secretValue}"}]`,
    );
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(JSON.stringify(result)).toContain(manifestDigest);
    expect(result).toMatchObject({ candidate: { providerTag: settledProviderTag } });
    expect(providerInstance.syncRuntimeSecrets).not.toHaveBeenCalled();
  });

  it("requires reconciliation when a replayed candidate runtime-secret result is uncertain", async () => {
    const inputArtifact = await artifact();
    const parsed = JSON.parse(new TextDecoder().decode(inputArtifact.manifestBody)) as {
      artifactDigest: `sha256:${string}`;
    };
    const providerInstance = provider();
    vi.mocked(providerInstance.syncRuntimeSecrets).mockRejectedValueOnce(
      new CloudflareWfpSecretSyncUncertainError(null),
    );
    const { management } = harness({ provider: providerInstance });

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: inputArtifact,
        knownDeployments: [receipt({ artifactDigest: parsed.artifactDigest })],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).resolves.toEqual({
      status: "reconciliation_required",
      reconciliationPhase: "secrets",
      currentProviderTag: PROVIDER_ID,
      currentProductDeploymentId: DEPLOYMENT,
    });
  });

  it("synchronizes rotations and deletions through one redacted provider result", async () => {
    const secretValue = "rotated-runtime-value";
    const manifest = await createRuntimeSecretManifest([
      {
        name: "API_TOKEN",
        value: secretValue,
        revision: 3,
        valueSha256: await sha256(encoder.encode(secretValue)),
      },
    ]);
    const providerInstance = provider();
    const { management } = harness({ provider: providerInstance });

    const result = await management.syncRuntimeSecrets({
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      expectedDeployment: receipt(),
      runtimeSecretManifest: manifest,
    });

    expect(providerInstance.syncRuntimeSecrets).toHaveBeenCalledWith({
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deployment: receipt(),
      manifest,
    });
    expect(result).toMatchObject({
      status: "synchronized",
      receipt: { manifestDigest: manifest.digest, secretNames: ["API_TOKEN"] },
    });
    expect(JSON.stringify(result)).not.toContain(secretValue);
    const uncertain = harness({
      provider: {
        ...providerInstance,
        async syncRuntimeSecrets() {
          throw new CloudflareWfpSecretSyncUncertainError([
            { name: "RETIRED_SECRET", type: "secret_text" },
            { name: "API_TOKEN", type: "secret_text" },
          ]);
        },
      },
    }).management;
    await expect(
      uncertain.syncRuntimeSecrets({
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        expectedDeployment: receipt(),
        runtimeSecretManifest: manifest,
      }),
    ).resolves.toEqual({
      status: "reconciliation_required",
      currentSecretNames: ["API_TOKEN", "RETIRED_SECRET"],
    });
  });

  it("uploads multiple Cloudflare asset buckets with one session JWT and accepts intermediate 202", async () => {
    const inputArtifact = await artifact();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const trace = vi.fn();
    fetch.mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        manifest: Record<string, { hash: string }>;
      };
      return new Response(
        JSON.stringify({
          success: true,
          errors: null,
          messages: null,
          result: {
            jwt: "upload.jwt",
            buckets: [
              [request.manifest["/assets/app.js"]?.hash],
              [request.manifest["/index.html"]?.hash],
            ],
          },
        }),
        { status: 200 },
      );
    });
    fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, errors: [], messages: [], result: null }), {
          status: 202,
        }),
      )
      .mockResolvedValueOnce(envelope({ jwt: "complete.jwt" }, 201));
    const { management } = harness({ fetch, trace });

    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: inputArtifact,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).resolves.toMatchObject({ status: "staged" });
    expect(fetch).toHaveBeenCalledTimes(3);
    const uploaded = new Map<string, File>();
    for (const call of fetch.mock.calls.slice(1)) {
      expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer upload.jwt");
      const body = call[1]?.body;
      expect(body).toBeInstanceOf(ReadableStream);
      const headers = call[1]?.headers;
      const form = await new Response(body, {
        ...(headers === undefined ? {} : { headers }),
      }).formData();
      for (const [hash, value] of form.entries()) {
        expect(value).toBeInstanceOf(File);
        uploaded.set(hash, value as File);
      }
    }
    // Each part carries the served type; an untyped part would be served without Content-Type.
    const parts = [...uploaded.values()];
    expect(parts.map((part) => part.type).sort()).toEqual([
      "text/html; charset=utf-8",
      "text/javascript; charset=utf-8",
    ]);
    for (const part of parts) expect(part.name).toMatch(/^[a-f0-9]{32}$/u);
    const html = parts.find((part) => part.type.startsWith("text/html"));
    if (html === undefined) throw new Error("HTML asset part is missing");
    expect(Buffer.from(await html.text(), "base64").toString("utf8")).toBe(
      "<!doctype html><title>ok</title>",
    );
    expect(trace.mock.calls.map(([phase]) => phase)).toEqual([
      "artifact-validated",
      "upload-session-start",
      "upload-session-complete",
      "asset-bucket-start",
      "asset-bucket-complete",
      "asset-bucket-start",
      "asset-bucket-complete",
      "candidate-stage-start",
      "candidate-stage-complete",
    ]);
  });

  it("rejects malformed, cross-scope, traversal, digest tampering and malformed SBOM before mutation", async () => {
    const cases = [
      await artifact({ projectId: OTHER_PROJECT }),
      await artifact({
        assets: [{ path: "/../secret", digest: `sha256:${"1".repeat(64)}`, size: 1 }],
      }),
      {
        ...(await artifact()),
        manifestDigest: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
      },
      { ...(await artifact()), sbomBody: encoder.encode("not-json") },
    ];
    const { management, fetch, provider: providerInstance } = harness();
    for (const candidate of cases) {
      await expect(
        management.stageVerifiedArtifact({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          deploymentId: DEPLOYMENT,
          artifact: candidate,
          knownDeployments: [],
          runtimeSecretManifest: await emptyRuntimeSecretManifest(),
        }),
      ).rejects.toBeInstanceOf(WfpManagementInputError);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("fails closed on invalid bucket hashes and provider timeout-after-commit without leaking secrets", async () => {
    const inputArtifact = await artifact();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope({ jwt: "upload.jwt", buckets: [["0".repeat(32)]] }));
    const { management, provider: providerInstance } = harness({ fetch });
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: inputArtifact,
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      }),
    ).rejects.toMatchObject({ code: "cloudflare_contract_invalid" });
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();

    const timedOut = provider();
    vi.mocked(timedOut.stageCandidate).mockRejectedValueOnce(
      Object.assign(new Error("secret-token"), {
        name: "CloudflareWfpUncertainError",
        code: "cloudflare_result_uncertain",
        currentProviderTag: PROVIDER_ID,
        currentProductDeploymentId: DEPLOYMENT,
      }),
    );
    const second = harness({ provider: timedOut });
    const result = await second.management.stageVerifiedArtifact({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact: inputArtifact,
      knownDeployments: [],
      runtimeSecretManifest: await emptyRuntimeSecretManifest(),
    });
    expect(result).toEqual({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
      currentProviderTag: PROVIDER_ID,
      currentProductDeploymentId: DEPLOYMENT,
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("redacts ordinary provider failures", async () => {
    const providerInstance = provider();
    vi.mocked(providerInstance.stageCandidate).mockRejectedValueOnce(
      Object.assign(new Error("secret-token"), {
        code: "cloudflare_request_failed",
        status: 400,
        providerCode: 10021,
        providerPointer: "/bindings/2/id",
      }),
    );
    const { management } = harness({ provider: providerInstance });
    const error = await management
      .stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: await artifact(),
        knownDeployments: [],
        runtimeSecretManifest: await emptyRuntimeSecretManifest(),
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "cloudflare_request_failed",
      providerStatus: 400,
      providerCode: 10021,
      providerPointer: "/bindings/2/id",
    });
    expect(String(error)).not.toContain("secret-token");
  });

  it("returns the active known deployment on replay without provider mutation", async () => {
    const inputArtifact = await artifact();
    const parsed = JSON.parse(new TextDecoder().decode(inputArtifact.manifestBody)) as {
      artifactDigest: string;
    };
    const runtimeSecretManifest = await emptyRuntimeSecretManifest();
    const known = {
      ...receipt({ artifactDigest: parsed.artifactDigest as `sha256:${string}` }),
      runtimeSecretManifestDigest: runtimeSecretManifest.digest,
    };
    const providerInstance = provider();
    vi.mocked(providerInstance.observeCandidate).mockResolvedValueOnce({
      state: "ready",
      scriptName: known.scriptName,
      providerTag: known.providerTag,
      productDeploymentId: DEPLOYMENT,
      artifactDigest: known.artifactDigest,
      observedAt: NOW,
    });
    const { management, fetch } = harness({ provider: providerInstance });
    await expect(
      management.stageVerifiedArtifact({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifact: inputArtifact,
        knownDeployments: [known],
        runtimeSecretManifest,
      }),
    ).resolves.toMatchObject({
      status: "replayed",
      candidate: known,
      priorGateway: null,
      deploymentUrl: "https://dev-calm-river-studio.dev.check.omh.st",
      runtimeSecretManifestDigest: runtimeSecretManifest.digest,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(providerInstance.stageCandidate).not.toHaveBeenCalled();
  });

  it("finalizes a propagated tombstone with provider CAS and post-delete public 404 proof", async () => {
    const providerInstance = provider();
    const expectedTombstoneDigest = await tombstoneDigest();
    vi.mocked(providerInstance.observeCandidate)
      .mockResolvedValueOnce({
        state: "unknown",
        scriptName: receipt().scriptName,
        providerTag: PROVIDER_ID,
        productDeploymentId: DEPLOYMENT,
        artifactDigest: expectedTombstoneDigest,
        observedAt: NOW,
      })
      .mockResolvedValueOnce({
        state: "metadata_absent",
        scriptName: receipt().scriptName,
        providerTag: null,
        productDeploymentId: null,
        artifactDigest: null,
        observedAt: NOW,
      });
    vi.mocked(providerInstance.observeCandidate).mockReset();
    vi.mocked(providerInstance.observeCandidate).mockResolvedValue({
      state: "metadata_absent",
      scriptName: receipt().scriptName,
      providerTag: null,
      productDeploymentId: null,
      artifactDigest: null,
      observedAt: NOW,
    });
    const edge = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("gone", { status: 404 }));
    const { management } = harness({ provider: providerInstance, fetch: edge, systemClock: true });

    await expect(
      management.finalizeRemoval({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        expectedGateway: gatewayReceipt(),
      }),
    ).resolves.toMatchObject({
      status: "removed",
      consecutive404s: 3,
      metadata: { state: "metadata_absent", expectedProviderTag: PROVIDER_ID },
    });
    expect(edge).toHaveBeenCalledTimes(3);
    expect(providerInstance.removeCandidate).toHaveBeenCalledWith({
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      expectedDeployment: expect.objectContaining({
        providerTag: PROVIDER_ID,
        artifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      }),
    });
  });

  it("deactivates the shared route before deleting the candidate and proves public absence", async () => {
    const providerInstance = provider();
    const expectedTombstoneDigest = await tombstoneDigest();
    vi.mocked(providerInstance.observeCandidate)
      .mockResolvedValueOnce({
        state: "unknown",
        scriptName: receipt().scriptName,
        providerTag: PROVIDER_ID,
        productDeploymentId: DEPLOYMENT,
        artifactDigest: expectedTombstoneDigest,
        observedAt: NOW,
      })
      .mockResolvedValueOnce({
        state: "metadata_absent",
        scriptName: receipt().scriptName,
        providerTag: null,
        productDeploymentId: null,
        artifactDigest: null,
        observedAt: NOW,
      });
    vi.mocked(providerInstance.observeCandidate).mockReset();
    vi.mocked(providerInstance.observeCandidate).mockResolvedValue({
      state: "metadata_absent",
      scriptName: receipt().scriptName,
      providerTag: null,
      productDeploymentId: null,
      artifactDigest: null,
      observedAt: NOW,
    });
    const edge = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("gone", { status: 404 }));
    const { management } = harness({ provider: providerInstance, fetch: edge });

    await expect(
      management.finalizeRemoval({
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        expectedGateway: gatewayReceipt(),
      }),
    ).resolves.toMatchObject({
      status: "removed",
      consecutive404s: 3,
      gateway: {
        active: false,
        revision: 2,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        observedAt: NOW,
      },
    });
    expect(edge).toHaveBeenCalledTimes(3);
    expect(providerInstance.gatewayRegistry.remove).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      expectedRevision: 1,
    });
    expect(
      vi.mocked(providerInstance.gatewayRegistry.remove).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(providerInstance.removeCandidate).mock.invocationCallOrder[0] ?? 0);
    expect(edge.mock.calls.map(([target]) => String(target))).toEqual(
      Array.from({ length: 3 }, () => `${gatewayReceipt().publicOrigin}/`),
    );
  });

  it("proves an already removed candidate through route 404s that take 1500ms", async () => {
    const providerInstance = absentRemovalProvider();
    const edge = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
      const signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(null, { status: 404 })), 1500);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const { management } = harness({ provider: providerInstance, fetch: edge, systemClock: true });
    await expect(management.finalizeRemoval(removalInput())).resolves.toMatchObject({
      status: "removed",
      consecutive404s: 3,
    });
    expect(edge).toHaveBeenCalledTimes(3);
    expect(providerInstance.gatewayRegistry.remove).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(providerInstance.gatewayRegistry.authorizeCandidateRemoval).toHaveBeenCalledOnce();
  });

  it("retries transient route failures for three fresh 404s and keeps incomplete proof uncertain", async () => {
    for (const statuses of [
      [null, 404, 404, 404],
      [404, 404, null, 404, 404, 404],
    ]) {
      let elapsed = 0;
      let call = 0;
      const edge = vi.fn<typeof globalThis.fetch>(async () => {
        const status = statuses[call++];
        if (status === null) throw new TypeError("private transport detail");
        if (status === undefined) throw new Error("Unexpected extra route probe");
        return new Response(null, { status });
      });
      const { management } = harness({
        provider: absentRemovalProvider(),
        fetch: edge,
        now: () => new Date(NOW.getTime() + elapsed),
        sleep: async (milliseconds) => {
          elapsed += milliseconds;
        },
        removalDeadlineMilliseconds: 10,
      });
      await expect(management.finalizeRemoval(removalInput())).resolves.toMatchObject({
        status: "removed",
        consecutive404s: 3,
      });
      expect(edge).toHaveBeenCalledTimes(statuses.length);
    }
    // Persistent errors, non-404s and a late 404 never become absence; only bounded evidence leaves this check.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const status of [null, 503, 404]) {
        let elapsed = 0;
        const edge = vi.fn<typeof globalThis.fetch>(async () => {
          if (status === null) throw new Error("private URL and credential detail");
          if (status === 404) elapsed = 4; // Even an actual 404 that arrives after the total deadline is insufficient.
          return new Response(null, { status });
        });
        const { management } = harness({
          provider: absentRemovalProvider(),
          fetch: edge,
          now: () => new Date(NOW.getTime() + elapsed),
          sleep: async (milliseconds) => {
            elapsed += milliseconds;
          },
        });
        await expect(management.finalizeRemoval(removalInput())).resolves.toMatchObject({
          status: "reconciliation_required",
          reason: "stale_edge",
        });
        const samples = status === 404 ? 1 : 3;
        expect(edge).toHaveBeenCalledTimes(samples);
        expect(warning).toHaveBeenLastCalledWith("wfp-management:removal-proof-uncertain", {
          reason: status === null ? "transport_failure" : status === 404 ? "deadline" : "non_404",
          samples,
          lastStatus: status,
          transportFailures: status === null ? 3 : 0,
        });
      }
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(
        /private|https?:|credential|calm-river/u,
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps fetch private and rejects invalid binding inventories", async () => {
    const { management } = harness();
    await expect(management.fetch()).resolves.toMatchObject({
      status: 404,
    });
    const production = createWfpManagement({
      bindings: {
        WFP_ACCOUNT_ID: "00000000000000000000000000000001",
        WFP_DISPATCH_NAMESPACE: "ohmyho-production",
        DATABASE_SERVICE_US: "ohmyho-project-database-production-us",
        DATABASE_SERVICE_EU: "ohmyho-project-database-production-eu",
        WFP_API_TOKEN: "token",
        WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
        WFP_MAIL_GATEWAY_SERVICE: "ohmyho-mail-gateway-production",
        WFP_MAIL_GATEWAY_ORIGIN:
          "https://ohmyho-mail-gateway-production.your-omh-account.workers.dev",
        WFP_STORAGE_GATEWAY_ORIGIN:
          "https://ohmyho-storage-gateway-production.your-omh-account.workers.dev",
        WFP_AI_GATEWAY_ORIGIN: "https://ai.ohmyho.st",
      },
      provider: provider(),
      gatewayRegistry: provider().gatewayRegistry,
      fetch: vi.fn(),
    });
    await expect(production.fetch()).resolves.toMatchObject({ status: 404 });
    expect(() =>
      createWfpManagement({
        bindings: {
          WFP_ACCOUNT_ID: "bad",
          WFP_DISPATCH_NAMESPACE: "bad namespace",
          WFP_API_TOKEN: "",
          WFP_WORKERS_DEV_SUBDOMAIN: "invalid subdomain",
          ...SANDBOX_GATEWAY_BINDINGS,
        },
        provider: provider(),
        gatewayRegistry: provider().gatewayRegistry,
        fetch: vi.fn(),
      }),
    ).toThrow(WfpManagementInputError);
    expect(() =>
      createWfpManagement({
        bindings: {
          WFP_ACCOUNT_ID: "00000000000000000000000000000001",
          WFP_DISPATCH_NAMESPACE: "ohmyho-poc-private-fullstack",
          WFP_API_TOKEN: "token",
          WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
          ...SANDBOX_GATEWAY_BINDINGS,
        },
        provider: provider(),
        gatewayRegistry: provider().gatewayRegistry,
        fetch: vi.fn(),
      }),
    ).toThrow(WfpManagementInputError);
  });
});
