import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import {
  digestDevAccessPublicJwk,
  signDevAccessSession,
  signDevRuntimeProbe,
} from "@ohmyhost/dev-access-tokens";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSharedGatewayWorker,
  type SharedGatewayEnvironment,
  type SharedGatewayTarget,
} from "../src/shared-gateway.js";
import { createProjectIsolatedGatewayWorker } from "../src/dispatch.js";
import sharedEntrypoint from "../src/shared-gateway-main.js";
import { poweredByFlagMarkup } from "../src/powered-by-flag.js";

const NOW = "2026-09-22T12:00:00.000Z";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const ACCESS_GUIDANCE =
  "This page is unavailable or requires access. For a protected Dev app, ask the project owner for a current Dev share link from project status (ohmyhost project dev-share link). Help: https://docs.ohmyho.st/";
const target: SharedGatewayTarget = {
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  environmentName: "prod",
  handle: "calm-river-studio",
  hostname: "calm-river-studio.check.omh.st",
  publicOrigin: "https://calm-river-studio.check.omh.st",
  targetDeploymentId: DEPLOYMENT_ID,
  targetScriptName: `p-${PROJECT_ID.toLowerCase()}-prod-${DEPLOYMENT_ID.toLowerCase()}`,
  egressAllowedOrigins: ["https://api.example.com"],
  devAccess: null,
  poweredBy: false,
};

/** Test double with workerd's contract: append() inserts before the end of the element. */
class TestHtmlRewriter {
  private readonly appended: string[] = [];
  public on(selector: string, handlers: { element(element: unknown): void }) {
    if (selector === "body")
      handlers.element({ append: (content: string) => this.appended.push(content) });
    return this;
  }
  public transform(response: Response): Response {
    const appended = this.appended.join("");
    return new Response(
      new ReadableStream({
        async start(controller) {
          const html = await response.text();
          controller.enqueue(
            new TextEncoder().encode(html.replace("</body>", `${appended}</body>`)),
          );
          controller.close();
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  }
}
afterEach(() => vi.unstubAllGlobals());

/** Deterministic boundary adapter; it can only be constructed in this test module. */
class GatewayAdapter {
  public target: unknown = target;
  public resolved: string[] = [];
  public requests: Request[] = [];
  public dispatches: unknown[] = [];
  // Undici may collect an intermediate response and cancel the reusable template's body.
  // Retain every clone for this adapter's lifetime while the gateway wraps its stream.
  private readonly retainedResponses: Response[] = [];
  public response = new Response("ok", { headers: { "x-ohmyhost-runtime": "edge-v1" } });
  public dispatchError: Error | null = null;
  public creditReads = 0;
  public allowed = true;
  public reason = "project_budget_exceeded";
  public paidAllowed = true;
  public creditError = false;
  public creditNeverCompletes = false;
  public creditCheckedAt = NOW;
  public creditScope: unknown = null;
  public authorized = true;
  public authorizeError = false;
  public redeemError = false;
  public redeemRateLimited = false;
  public publicDev = false;
  public sessionToken = "";
  public authorizations: unknown[] = [];
  public redemptions: unknown[] = [];

  public readonly environment: SharedGatewayEnvironment = {
    GATEWAY_ROUTING: {
      resolve: async ({ hostname }) => {
        this.resolved.push(hostname);
        return this.target;
      },
    },
    DISPATCHER: {
      get: (...args) => {
        this.dispatches.push(args);
        return {
          fetch: async (request) => {
            this.requests.push(request);
            if (this.dispatchError !== null) throw this.dispatchError;
            // Static assets revalidate a matching validator, compared weakly, with 304.
            const etag = this.response.headers.get("etag");
            const validator = request.headers.get("if-none-match");
            if (
              etag !== null &&
              validator !== null &&
              validator.replace(/^W\//u, "") === etag.replace(/^W\//u, "")
            )
              return new Response(null, { status: 304, headers: { etag } });
            const response = this.response.clone();
            this.retainedResponses.push(response);
            return response;
          },
        };
      },
    },
    CREDIT_ADMISSION: {
      read: async (scope) => {
        this.creditReads++;
        this.creditScope = scope;
        if (this.creditError) throw new Error("sensitive provider failure");
        if (this.creditNeverCompletes) return new Promise<never>(() => undefined);
        return {
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          allowed: this.allowed,
          paidAllowed: this.paidAllowed,
          reason: this.allowed ? null : this.reason,
          checkedAt: this.creditCheckedAt,
          expiresAt: new Date(Date.parse(this.creditCheckedAt) + 900000).toISOString(),
        };
      },
    },
    DEV_ACCESS: {
      redeem: async (input) => {
        this.redemptions.push(input);
        if (this.redeemRateLimited) throw new Error("Dev access rate limit exceeded");
        if (this.redeemError) throw new Error("Dev access ticket is not redeemable");
        return { sessionToken: this.sessionToken, expiresAt: "2026-09-23T00:00:00.000Z" };
      },
      authorize: async (input) => {
        this.authorizations.push(input);
        if (this.authorizeError) throw new Error("Dev access rate limit exceeded");
        return { authorized: this.authorized && (input.sessionToken !== null || this.publicDev) };
      },
    },
    DIAGNOSTIC_MARKER_SIGNING_KEY_BASE64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
}

// Every call gets a fresh isolate so these cases observe Control state without cached reads.
const worker = {
  fetch: (request: Request, environment: SharedGatewayEnvironment) =>
    createSharedGatewayWorker({ now: () => new Date(NOW) }).fetch(request, environment),
};

describe("shared project gateway", () => {
  it.each(["https://app.localhost", "https://intranet", "https://api.example.com:8443"])(
    "refuses a route whose declared egress origin %s fails the shared DNS rule, before any dispatch",
    async (origin) => {
      const adapter = new GatewayAdapter();
      adapter.target = { ...target, egressAllowedOrigins: [origin] };
      const response = await worker.fetch(new Request(target.publicOrigin), adapter.environment);
      expect(response.status).toBe(503);
      expect(adapter.dispatches).toEqual([]);
    },
  );

  it("gives identical non-enumerating access guidance for unknown and inaccessible Dev targets", async () => {
    const unknown = new GatewayAdapter();
    unknown.target = null;
    const missing = await worker.fetch(
      new Request("https://unknown.check.omh.st/"),
      unknown.environment,
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(ACCESS_GUIDANCE);
    const denied = new GatewayAdapter();
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
    if (typeof exported.x !== "string" || typeof exported.y !== "string")
      throw new Error("Test public key coordinates are missing");
    const publicJwk = { kty: "EC", crv: "P-256", x: exported.x, y: exported.y };
    denied.target = {
      ...target,
      environmentName: "dev",
      hostname: "dev-calm-river-studio.check.omh.st",
      publicOrigin: "https://dev-calm-river-studio.check.omh.st",
      targetScriptName: `p-${PROJECT_ID.toLowerCase()}-dev-${DEPLOYMENT_ID.toLowerCase()}`,
      devAccess: { keyId: await digestDevAccessPublicJwk(crypto, publicJwk), publicJwk },
    };
    denied.authorized = false;
    for (const cookie of [
      undefined,
      "__Host-ohmyhost_dev_access=invalid",
      "__Host-ohmyhost_dev_access=expired",
    ]) {
      const response = await worker.fetch(
        new Request(
          "https://dev-calm-river-studio.check.omh.st/",
          cookie === undefined ? {} : { headers: { cookie } },
        ),
        denied.environment,
      );
      expect(response.status).toBe(missing.status);
      expect(await response.text()).toBe(ACCESS_GUIDANCE);
      expect([...response.headers]).toEqual([...missing.headers]);
    }
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(unknown.dispatches).toEqual([]);
    expect(denied.dispatches).toEqual([]);
  });
  it("measures only the exact trusted Dev request without changing admission or waiting on denied credit", async () => {
    const adapter = new GatewayAdapter();
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
    if (exported.x === undefined || exported.y === undefined)
      throw new Error("Missing test key coordinates");
    const publicJwk = { kty: "EC" as const, crv: "P-256" as const, x: exported.x, y: exported.y };
    const keyId = await digestDevAccessPublicJwk(crypto, publicJwk);
    const projectId = "01M6PG6R7A0B8YJ9PBMZ9AB565",
      environmentId = "01M6PG6R7A0B8YJ9PBMZ9AB56A";
    const origin = "https://dev-slimy-cases-thank.dev.check.omh.st";
    adapter.target = {
      ...target,
      projectId,
      environmentId,
      environmentName: "dev",
      handle: "slimy-cases-thank",
      hostname: "dev-slimy-cases-thank.dev.check.omh.st",
      publicOrigin: origin,
      targetScriptName: `p-${projectId.toLowerCase()}-dev-${DEPLOYMENT_ID.toLowerCase()}`,
      devAccess: { keyId, publicJwk },
    };
    adapter.publicDev = true;
    const env: SharedGatewayEnvironment = {
      ...adapter.environment,
      DEV_AUTH_ATOMIC_MODE: "v1",
      NATIVE_GATEWAY_LATENCY_PROFILE: "c5-development-v1",
      CREDIT_ADMISSION: {
        read: async (scope) => ({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          allowed: true,
          paidAllowed: true,
          reason: null,
          checkedAt: NOW,
          expiresAt: new Date(Date.parse(NOW) + 900000).toISOString(),
        }),
      },
    };
    let ticks = 0;
    const events: string[] = [];
    const gateway = createSharedGatewayWorker({
      now: () => new Date(NOW),
      latencyClock: () => ++ticks,
      latencySink: (event) => events.push(event),
    });
    const response = await gateway.fetch(new Request(origin + "/protected"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(adapter.authorizations.at(-1)).toMatchObject({ organizationHint: ORGANIZATION_ID });
    expect(events).toHaveLength(1);
    const firstEvent = events[0];
    if (firstEvent === undefined) throw new Error("Missing gateway timing event");
    const event = JSON.parse(firstEvent);
    expect(event).toMatchObject({
      kind: "native_gateway_latency_v1",
      outcome: "response",
      status: 200,
      timingsAreNonAdditive: true,
    });
    expect(Object.keys(event.durations).sort()).toEqual(
      [
        "creditAdmissionMs",
        "devAuthorizationMs",
        "localDevVerificationMs",
        "routeLookupMs",
        "totalUntilHeadersMs",
        "workerDispatchMs",
      ].sort(),
    );
    expect(JSON.stringify(event)).not.toContain(projectId);
    await gateway.fetch(new Request(origin + "/protected"), env);
    const secondEvent = events[1];
    if (secondEvent === undefined) throw new Error("Missing cached gateway timing event");
    expect(JSON.parse(secondEvent).durations.routeLookupMs).toBeNull();
    await gateway.fetch(new Request(origin + "/other"), env);
    expect(events).toHaveLength(2);
    let release!: () => void;
    const denied = new GatewayAdapter();
    denied.target = adapter.target;
    const deniedEnv: SharedGatewayEnvironment = {
      ...env,
      ...denied.environment,
      DEV_AUTH_ATOMIC_MODE: "v1",
      NATIVE_GATEWAY_LATENCY_PROFILE: "c5-development-v1",
      CREDIT_ADMISSION: {
        read: () =>
          new Promise((resolve) => {
            release = () => resolve({});
          }),
      },
    };
    const earlyEvents: string[] = [];
    const early = createSharedGatewayWorker({
      now: () => new Date(NOW),
      latencyClock: () => ++ticks,
      latencySink: (event) => earlyEvents.push(event),
    });
    expect((await early.fetch(new Request(origin + "/protected"), deniedEnv)).status).toBe(404);
    const earlyEvent = earlyEvents[0];
    if (earlyEvent === undefined) throw new Error("Missing early gateway timing event");
    expect(JSON.parse(earlyEvent).durations.creditAdmissionMs).toBeNull();
    release();
    const defaultLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const standard = createSharedGatewayWorker({ now: () => new Date(NOW) });
      expect((await standard.fetch(new Request(origin + "/protected"), env)).status).toBe(200);
      expect(JSON.parse(String(defaultLog.mock.calls[0]?.[0])).kind).toBe(
        "native_gateway_latency_v1",
      );
    } finally {
      defaultLog.mockRestore();
    }
    const failureSink = createSharedGatewayWorker({
      now: () => new Date(NOW),
      latencyClock: () => {
        throw Error("clock");
      },
      latencySink: () => {
        throw Error("logger");
      },
    });
    expect((await failureSink.fetch(new Request(origin + "/protected"), env)).status).toBe(200);
  });
  it("mounts only the Native public routes with trusted scope, current authority and Paid admission", async () => {
    const adapter = new GatewayAdapter();
    adapter.target = {
      ...target,
      poweredBy: true,
      nativeAuth: { region: "us", realmGeneration: 4, configurationRevision: 7 },
    };
    let enabled = true;
    const calls: { request: Request; scope: unknown; client: unknown }[] = [];
    const env: SharedGatewayEnvironment = {
      ...adapter.environment,
      NATIVE_AUTH_US: {
        fetchPublic: async (request, scope, client) => {
          calls.push({ request, scope, client });
          return enabled
            ? new Response("session", {
                headers: { "cache-control": "public", "referrer-policy": "unsafe-url" },
              })
            : new Response("", { status: 403 });
        },
      },
    };
    const nativeService = env.NATIVE_AUTH_US;
    if (!nativeService) throw new Error("missing Native gateway fixture service");
    const gateway = createSharedGatewayWorker({ now: () => new Date(NOW) });
    const invoke = (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("cf-connecting-ip", "192.0.2.44");
      return gateway.fetch(new Request(`${target.publicOrigin}${path}`, { ...init, headers }), env);
    };
    const response = await invoke("/api/auth/v1/get-session", {
      headers: { "x-ohmyhost-project-id": "forged" },
    });
    expect(await response.text()).toBe("session");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(calls[0]?.scope).toEqual({
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      deploymentId: DEPLOYMENT_ID,
      canonicalOrigin: target.publicOrigin,
      realmGeneration: 4,
      configurationRevision: 7,
    });
    expect(calls[0]?.request.headers.has("x-ohmyhost-project-id")).toBe(false);
    expect(calls[0]?.client).toEqual({ clientAddress: "192.0.2.44" });
    for (const [path, init] of [
      ["/api/auth/v1/admin/list-users", undefined],
      ["/api/auth/v1/get-session", { method: "POST", headers: { origin: target.publicOrigin } }],
      ["/api/auth/v1/callback/google", { headers: { origin: "https://evil.example" } }],
    ] as const)
      expect((await invoke(path, init)).status).toBe(404);
    expect((await invoke("/api/auth/v1/callback/github?code=secret")).status).toBe(200);
    expect((await invoke("/api/auth/v1-other")).status).toBe(200);
    enabled = false;
    expect((await invoke("/api/auth/v1/get-session")).status).toBe(403);
    expect(adapter.resolved).toHaveLength(1);
    const unpaid = new GatewayAdapter();
    unpaid.target = adapter.target;
    unpaid.paidAllowed = false;
    expect(
      (
        await worker.fetch(new Request(`${target.publicOrigin}/api/auth/v1/get-session`), {
          ...unpaid.environment,
          NATIVE_AUTH_US: nativeService,
        })
      ).status,
    ).toBe(402);

    const custom = new GatewayAdapter();
    const customOrigin = "https://accounts.customer.example";
    custom.target = {
      ...(adapter.target as SharedGatewayTarget),
      hostname: new URL(customOrigin).hostname,
    };
    const customWorker = createSharedGatewayWorker({ now: () => new Date(NOW) });
    const customResponse = await customWorker.fetch(
      new Request(`${customOrigin}/api/auth/v1/sign-in/email`, {
        method: "POST",
        headers: {
          origin: customOrigin,
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.44",
        },
        body: JSON.stringify({ email: "user@example.test", password: "test-only" }),
      }),
      { ...custom.environment, NATIVE_AUTH_US: nativeService },
    );
    expect(customResponse.status).toBe(403); // The private runtime's current disabled state still wins.
    expect(calls.at(-1)?.scope).toMatchObject({ canonicalOrigin: customOrigin });
    const callCount = calls.length;
    expect(
      (
        await customWorker.fetch(
          new Request(`${customOrigin}/api/auth/v1/sign-in/email`, {
            method: "POST",
            headers: { origin: target.publicOrigin },
          }),
          { ...custom.environment, NATIVE_AUTH_US: nativeService },
        )
      ).status,
    ).toBe(404);
    expect(calls).toHaveLength(callCount);
    const missingAddress = await customWorker.fetch(
      new Request(`${customOrigin}/api/auth/v1/get-session`, {
        headers: { "x-ohmyhost-client-address": "192.0.2.44" },
      }),
      { ...custom.environment, NATIVE_AUTH_US: nativeService },
    );
    expect(missingAddress.status).toBe(503);
    expect(calls).toHaveLength(callCount);
    const eu = new GatewayAdapter();
    eu.target = {
      ...target,
      nativeAuth: { region: "eu", realmGeneration: 1, configurationRevision: 1 },
    };
    let euCalls = 0;
    const euWorker = createSharedGatewayWorker({ now: () => new Date(NOW) });
    const euResponse = await euWorker.fetch(
      new Request(`${target.publicOrigin}/api/auth/v1/get-session`, {
        headers: { "cf-connecting-ip": "2001:db8::44" },
      }),
      {
        ...eu.environment,
        NATIVE_AUTH_US: {
          fetchPublic: async () => {
            throw new Error("wrong region");
          },
        },
        NATIVE_AUTH_EU: {
          fetchPublic: async (_request, _scope, client) => {
            expect(client.clientAddress).toBe("2001:db8::44");
            euCalls++;
            return new Response("eu");
          },
        },
      },
    );
    expect(euResponse.status).toBe(200);
    expect(euCalls).toBe(1);
  });

  it("allows same-origin Native browser calls from static content and fails closed without the private service", async () => {
    const adapter = new GatewayAdapter();
    adapter.target = {
      ...target,
      nativeAuth: { region: "us", realmGeneration: 1, configurationRevision: 1 },
    };
    adapter.response = new Response("<html></html>", { headers: { "content-type": "text/html" } });
    const page = await worker.fetch(new Request(`${target.publicOrigin}/`), adapter.environment);
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const unavailable = await worker.fetch(
      new Request(`${target.publicOrigin}/api/auth/v1/get-session`),
      adapter.environment,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "auth_unavailable" });
    const pendingAdapter = new GatewayAdapter();
    pendingAdapter.target = {
      ...target,
      nativeAuth: { region: "us", realmGeneration: null, configurationRevision: null },
    };
    pendingAdapter.response = new Response("<html>setup</html>", {
      headers: { "content-type": "text/html" },
    });
    const pendingWorker = createSharedGatewayWorker({ now: () => new Date(NOW) });
    expect(
      (await pendingWorker.fetch(new Request(target.publicOrigin), pendingAdapter.environment))
        .status,
    ).toBe(200);
    const pendingAuth = await pendingWorker.fetch(
      new Request(`${target.publicOrigin}/api/auth/v1/get-session`),
      pendingAdapter.environment,
    );
    expect(pendingAuth.status).toBe(503);
    expect(await pendingAuth.json()).toEqual({ error: "auth_unavailable" });
    expect(pendingAdapter.requests).toHaveLength(1); // Only the public asset reached customer code.
    adapter.target = {
      ...target,
      nativeAuth: { region: "us", realmGeneration: 0, configurationRevision: 1 },
    };
    expect((await worker.fetch(new Request(target.publicOrigin), adapter.environment)).status).toBe(
      503,
    );
    adapter.target = target;
    expect(
      (
        await worker.fetch(
          new Request(`${target.publicOrigin}/api/auth/v1/get-session`),
          adapter.environment,
        )
      ).status,
    ).toBe(200);
  });

  it("blocks public cutover requests before routing, credits, Dev access or candidate execution", async () => {
    const adapter = new GatewayAdapter(),
      env = { ...adapter.environment, OMH_DATABASE_CUTOVER_MAINTENANCE: "on" };
    const isolated = createProjectIsolatedGatewayWorker();
    for (const method of ["GET", "HEAD", "POST"]) {
      const request = new Request(`${target.publicOrigin}/health`, {
        method,
        headers: { "x-ohmyhost-runtime-probe": "untrusted-bypass" },
      });
      const responses = [
        await worker.fetch(request, env),
        await isolated.fetch(request, {
          DISPATCHER: env.DISPATCHER,
          PROJECT_ID,
          PROJECT_HANDLE: target.handle,
          ENVIRONMENT_NAME: "prod",
          PUBLIC_ORIGIN: target.publicOrigin,
          OMH_DATABASE_CUTOVER_MAINTENANCE: "on",
        }),
      ];
      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("60");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe(
          method === "HEAD" ? "" : "Temporarily unavailable. Please retry shortly.",
        );
      }
    }
    expect(adapter.resolved).toEqual([]);
    expect(adapter.dispatches).toEqual([]);
    expect(adapter.creditReads).toBe(0);
    expect(adapter.authorizations).toEqual([]);
    expect((await worker.fetch(new Request(target.publicOrigin), adapter.environment)).status).toBe(
      200,
    );
  });

  it("refuses private OpenNext cache paths for every tenant before routing or dispatch", async () => {
    const adapter = new GatewayAdapter();
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
    for (const origin of [target.publicOrigin, "https://other-tenant.check.omh.st"]) {
      for (const path of paths) {
        for (const method of ["GET", "HEAD", "POST"]) {
          const response = await worker.fetch(
            new Request(`${origin}${path}`, { method }),
            adapter.environment,
          );
          expect(response.status, `${method} ${origin}${path}`).toBe(404);
          await expect(response.text()).resolves.toBe(ACCESS_GUIDANCE);
        }
      }
    }
    expect(adapter.resolved).toEqual([]);
    expect(adapter.creditReads).toBe(0);
    expect(adapter.authorizations).toEqual([]);
    expect(adapter.dispatches).toEqual([]);
    expect(adapter.requests).toEqual([]);
    for (const path of [
      "/",
      "/_next/static/chunks/main.js",
      "/_next/image?url=%2Fimages%2Flogo.png&w=640&q=75",
      "/cdn-cgi/_next_cache-public/app.js",
      "/app/_next_cache/about.json",
      "/public/%E0%A4%A",
      "/support?path=/cdn-cgi/_next_cache/build/index.cache",
    ]) {
      const request = new Request(`${target.publicOrigin}${path}`);
      const response = await worker.fetch(request, adapter.environment);
      expect(response.status, path).toBe(200);
      expect(adapter.requests.at(-1)?.url).toBe(request.url);
    }
  });

  it("applies exact resource origins and controlled workers without granting server egress", async () => {
    const adapter = new GatewayAdapter();
    const browserPolicy = normalizeBrowserPolicy({
      connect: ["https://api.browser.example.com", "wss://events.example.com"],
      scripts: ["https://scripts.example.com"],
      styles: ["https://styles.example.com"],
      images: ["https://images.example.com"],
      fonts: ["https://fonts.example.com"],
      frames: ["https://frames.example.com"],
      frameAncestors: ["https://portal.example.com"],
      workers: { self: true, blob: true },
    });
    adapter.target = { ...target, browserPolicy };
    adapter.response = new Response("<html>app</html>", {
      headers: { "x-ohmyhost-runtime": "edge-v1", "content-type": "text/html" },
    });
    const response = await worker.fetch(new Request(target.publicOrigin), adapter.environment);
    expect(response.status).toBe(200);
    const policy = response.headers.get("content-security-policy") ?? "";
    for (const [directive, origin] of [
      ["connect-src", "wss://events.example.com"],
      ["script-src", "https://scripts.example.com"],
      ["style-src", "https://styles.example.com"],
      ["img-src", "https://images.example.com"],
      ["font-src", "https://fonts.example.com"],
      ["frame-src", "https://frames.example.com"],
      ["frame-ancestors", "https://portal.example.com"],
    ]) {
      expect(policy.split(";").find((part) => part.trim().startsWith(`${directive} `))).toContain(
        origin,
      );
    }
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(response.headers.has("x-frame-options")).toBe(false);
    expect(adapter.requests[0]?.headers.get("content-security-policy")).toBe(policy);
    expect(adapter.dispatches[0]).toMatchObject({
      2: { outbound: { EGRESS_CONTEXT: { allowedOrigins: target.egressAllowedOrigins } } },
    });

    adapter.response = new Response("static", { headers: { "content-type": "text/html" } });
    const staticResponse = await worker.fetch(
      new Request(target.publicOrigin),
      adapter.environment,
    );
    expect(staticResponse.headers.get("content-security-policy")).toContain(
      "connect-src https://api.browser.example.com wss://events.example.com",
    );
    expect(staticResponse.headers.get("content-security-policy")).not.toContain("'nonce-");
  });

  it("preserves omitted defaults and rejects noncanonical browser routing grants", async () => {
    const adapter = new GatewayAdapter();
    const omitted = await worker.fetch(new Request(target.publicOrigin), adapter.environment);
    adapter.target = { ...target, browserPolicy: normalizeBrowserPolicy(undefined) };
    const explicit = await worker.fetch(new Request(target.publicOrigin), adapter.environment);
    const removeNonce = (response: Response) =>
      response.headers.get("content-security-policy")?.replaceAll(/'nonce-[a-f0-9]+'/gu, "'nonce'");
    expect(removeNonce(explicit)).toBe(removeNonce(omitted));
    expect(explicit.headers.get("x-frame-options")).toBe("DENY");
    for (const browserPolicy of [
      {},
      { ...normalizeBrowserPolicy(undefined), scripts: ["https://*.example.com"] },
      {
        ...normalizeBrowserPolicy(undefined),
        connect: ["wss://b.example.com", "wss://a.example.com"],
      },
    ]) {
      adapter.target = { ...target, browserPolicy };
      expect(
        (await worker.fetch(new Request(target.publicOrigin), adapter.environment)).status,
      ).toBe(503);
    }
  });

  it("keeps application CORS only for the configured actual origin and explicit credentials", async () => {
    const adapter = new GatewayAdapter();
    const origin = "https://frontend.example.com";
    const browserPolicy = normalizeBrowserPolicy({
      cors: { origins: [origin], credentials: true },
    });
    adapter.target = { ...target, browserPolicy };
    const applicationResponse = (allowOrigin: string) =>
      new Response("cors", {
        headers: {
          "x-ohmyhost-runtime": "edge-v1",
          "access-control-allow-origin": allowOrigin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-expose-headers": "X-Request-Id",
          "access-control-max-age": "600",
          vary: "Accept-Encoding",
        },
      });
    adapter.response = applicationResponse(origin);
    const request = (method: string, cookies = false, requestOrigin = origin) =>
      new Request(`${target.publicOrigin}/api/write`, {
        method,
        headers: {
          origin: requestOrigin,
          ...(cookies ? { cookie: "session=customer" } : { authorization: "Bearer customer" }),
        },
      });
    const preflight = new Request(`${target.publicOrigin}/api/write`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "Authorization, Content-Type",
      },
    });
    for (const incoming of [request("POST", true), preflight]) {
      const response = await worker.fetch(incoming, adapter.environment);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "Authorization, Content-Type",
      );
      expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
    }
    for (const allowOrigin of ["*", "https://other.example.com"]) {
      adapter.response = applicationResponse(allowOrigin);
      const response = await worker.fetch(request("GET"), adapter.environment);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(response.headers.has("access-control-allow-credentials")).toBe(false);
    }
    adapter.response = applicationResponse(origin);
    adapter.target = {
      ...target,
      browserPolicy: normalizeBrowserPolicy({ cors: { origins: [origin] } }),
    };
    expect((await worker.fetch(request("POST", true), adapter.environment)).status).toBe(403);
    const bearer = await worker.fetch(request("POST"), adapter.environment);
    expect(bearer.status).toBe(200);
    expect(bearer.headers.get("access-control-allow-origin")).toBe(origin);
    expect(bearer.headers.has("access-control-allow-credentials")).toBe(false);
    adapter.response.headers.set("access-control-allow-headers", "*");
    adapter.response.headers.set("access-control-allow-methods", "*");
    adapter.response.headers.set("access-control-expose-headers", "*");
    adapter.response.headers.set("access-control-allow-private-network", "true");
    const bounded = await worker.fetch(request("OPTIONS"), adapter.environment);
    for (const name of [
      "access-control-allow-headers",
      "access-control-allow-methods",
      "access-control-expose-headers",
      "access-control-allow-private-network",
    ])
      expect(bounded.headers.has(name)).toBe(false);
    expect(
      (await worker.fetch(request("POST", false, "https://evil.example.com"), adapter.environment))
        .status,
    ).toBe(403);
  });

  it("admits a WebSocket upgrade only from its own origin, or without cookies and without an Origin header", async () => {
    const adapter = new GatewayAdapter();
    adapter.target = target;
    const upgrade = (headers: Record<string, string>) =>
      new Request(`${target.publicOrigin}/socket`, {
        headers: { upgrade: "websocket", ...headers },
      });
    for (const headers of [
      { origin: "https://attacker.example", cookie: "session=customer" },
      { origin: "https://attacker.example" },
      { origin: "https://calm-river-studio.check.omh.st.attacker.example" },
      { cookie: "session=customer" },
    ]) {
      const refused = await worker.fetch(upgrade(headers), adapter.environment);
      expect(refused.status, JSON.stringify(headers)).toBe(403);
    }
    expect(adapter.requests).toEqual([]);
    const sameOrigin = await worker.fetch(
      upgrade({ origin: target.publicOrigin, cookie: "session=customer" }),
      adapter.environment,
    );
    expect(sameOrigin.status).not.toBe(403);
    expect(adapter.requests).toHaveLength(1);
  });

  it.each([
    ["wrangler.shared.jsonc", "ohmyho-gateway-poc-private-fullstack"],
    ["wrangler.production.shared.jsonc", "ohmyho-gateway-production"],
  ])("stages %s privately before the exact wildcard route switch", async (filename, name) => {
    const source = await readFile(resolve(import.meta.dirname, "..", filename), "utf8");
    const config = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1"));
    expect(config).toMatchObject({
      name,
      main: "src/shared-gateway-main.ts",
      workers_dev: false,
      preview_urls: false,
      logpush: false,
      observability: {
        logs: { enabled: filename === "wrangler.shared.jsonc", invocation_logs: false },
        traces: { enabled: false },
      },
    });
    expect(config.routes).toBeUndefined();
  });
  it("resolves each exact host afresh, scopes immutable dispatch and preserves browser and budget controls", async () => {
    const adapter = new GatewayAdapter();
    adapter.response.headers.append("set-cookie", "session=yes; Secure; HttpOnly; Path=/");
    adapter.response.headers.append("set-cookie", "cross=bad; Domain=check.omh.st; Path=/");
    adapter.response.headers.append("set-cookie", "__Host-ohmyhost_dev_access=forged; Path=/");
    adapter.response.headers.append("set-cookie", "__Host-ohmyhost_dev_access =forged; Path=/");
    adapter.response.headers.append("set-cookie", "__Host-ohmyhost_dev_access\t=forged; Path=/");
    adapter.response.headers.append("set-cookie", "__Host-ohmyhost_dev_access; Path=/");
    adapter.response.headers.set("access-control-allow-origin", "*");
    const response = await worker.fetch(
      new Request(`${target.publicOrigin}/`),
      adapter.environment,
    );
    expect(response.status).toBe(200);
    expect(adapter.resolved).toEqual([target.hostname]);
    expect(adapter.dispatches).toEqual([
      [
        target.targetScriptName,
        {},
        {
          limits: { cpuMs: 50, subRequests: 10 },
          outbound: {
            EGRESS_CONTEXT: {
              version: 1,
              projectId: PROJECT_ID,
              allowedOrigins: target.egressAllowedOrigins,
            },
          },
        },
      ],
    ]);
    expect(adapter.creditScope).toEqual({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      includePaidPlan: true,
    });
    expect(response.headers.getSetCookie()).toEqual(["session=yes; Secure; HttpOnly; Path=/"]);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain(
      `'nonce-${adapter.requests[0]?.headers.get("x-nonce")}'`,
    );
    expect(response.headers.has("x-ohmyhost-runtime")).toBe(false);
    for (const headers of [{ origin: "https://attacker.example" }, { cookie: "session=yes" }]) {
      const denied = await worker.fetch(
        new Request(`${target.publicOrigin}/write`, { method: "POST", headers }),
        adapter.environment,
      );
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe(
        "Forbidden: ohmyho.st refuses a request other than GET or HEAD whose Origin header names another origin, or that carries cookies without an Origin header. Send it from a page on this origin, or without cookies.",
      );
    }
    for (const invalid of [
      null,
      { ...target, projectId: ORGANIZATION_ID },
      { ...target, hostname: "attacker.example" },
      { ...target, extra: "unexpected" },
    ]) {
      adapter.target = invalid;
      expect(
        (await worker.fetch(new Request(`${target.publicOrigin}/`), adapter.environment)).status,
      ).toBe(invalid === null ? 404 : 503);
    }
    adapter.target = target;
    adapter.allowed = false;
    expect(
      (await worker.fetch(new Request(`${target.publicOrigin}/`), adapter.environment)).status,
    ).toBe(402);
    adapter.allowed = true;
    adapter.paidAllowed = false;
    adapter.target = { ...target, hostname: "customer.example.com" };
    expect(
      (await worker.fetch(new Request("https://customer.example.com/"), adapter.environment))
        .status,
    ).toBe(402);
    adapter.paidAllowed = true;
    const customDomain = await worker.fetch(
      new Request("https://customer.example.com/"),
      adapter.environment,
    );
    expect(customDomain.status).toBe(200);
    // HSTS never reaches the subdomains of a customer's apex, which the customer controls.
    expect(customDomain.headers.get("strict-transport-security")).toBe("max-age=31536000");
    adapter.target = null;
    const unknownHost = await worker.fetch(
      new Request("https://customer.example.com/"),
      adapter.environment,
    );
    expect(unknownHost.status).toBe(404);
    expect(unknownHost.headers.get("strict-transport-security")).toBe("max-age=31536000");
    adapter.target = { ...target, hostname: "customer.example.com" };
    adapter.creditError = true;
    expect(
      (await worker.fetch(new Request("https://customer.example.com/"), adapter.environment))
        .status,
    ).toBe(503);
    expect(adapter.dispatches).toHaveLength(2);
    const live = new GatewayAdapter();
    live.creditCheckedAt = new Date().toISOString();
    expect(
      (await sharedEntrypoint.fetch(new Request(target.publicOrigin), live.environment)).status,
    ).toBe(200);
    live.creditNeverCompletes = true;
    expect((await worker.fetch(new Request(target.publicOrigin), live.environment)).status).toBe(
      503,
    );
    expect(live.requests).toHaveLength(1);
  });

  it("honors only an exact app media and microphone request on an edge HTML document", async () => {
    const adapter = new GatewayAdapter();
    adapter.response = new Response("<html></html>", {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-ohmyhost-runtime": "edge-v1",
        "content-security-policy": "default-src *; media-src 'self' blob:; script-src *",
        "permissions-policy": "camera=(*), geolocation=(*), microphone=(self)",
      },
    });
    const enabled = await worker.fetch(new Request(`${target.publicOrigin}/`), adapter.environment);
    expect(enabled.headers.get("content-security-policy")).toContain("media-src 'self' blob:");
    expect(enabled.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(enabled.headers.get("content-security-policy")).toContain("worker-src 'none'");
    expect(enabled.headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=(self)",
    );

    adapter.response = new Response("<html></html>", {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-ohmyhost-runtime": "edge-v1",
        "content-security-policy": "media-src *",
        "permissions-policy": "microphone=(*)",
      },
    });
    const denied = await worker.fetch(new Request(`${target.publicOrigin}/`), adapter.environment);
    expect(denied.headers.get("content-security-policy")).not.toContain("media-src 'self' blob:");
    expect(denied.headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=()",
    );

    adapter.response = new Response("<html></html>", {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "media-src 'self' blob:",
        "permissions-policy": "microphone=(self)",
      },
    });
    const unmarked = await worker.fetch(
      new Request(`${target.publicOrigin}/`),
      adapter.environment,
    );
    expect(unmarked.headers.get("content-security-policy")).not.toContain("media-src 'self' blob:");
    expect(unmarked.headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=()",
    );
  });

  it("keeps Dev tickets, current authorization and signed deployment probes scoped and private", async () => {
    const adapter = new GatewayAdapter();
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
    if (exported.x === undefined || exported.y === undefined)
      throw new Error("Missing test key coordinates");
    const publicJwk = { kty: "EC" as const, crv: "P-256" as const, x: exported.x, y: exported.y };
    const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
    const keyId = await digestDevAccessPublicJwk(crypto, publicJwk);
    const dev = {
      ...target,
      environmentName: "dev" as const,
      hostname: "dev-calm-river-studio.check.omh.st",
      publicOrigin: "https://dev-calm-river-studio.check.omh.st",
      targetScriptName: `p-${PROJECT_ID.toLowerCase()}-dev-${DEPLOYMENT_ID.toLowerCase()}`,
      devAccess: { keyId, publicJwk },
    };
    adapter.target = dev;
    const scope = {
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      handle: target.handle,
      origin: dev.publicOrigin,
    };
    adapter.sessionToken = await signDevAccessSession(crypto, privateJwk, {
      ...scope,
      kid: keyId,
      devAccessEpoch: 1,
      subjectId: "user:user_1",
      issuedAt: NOW,
      expiresAt: "2026-09-23T00:00:00.000Z",
    });
    adapter.target = {
      ...dev,
      nativeAuth: { region: "us", realmGeneration: 1, configurationRevision: 1 },
    };
    const nativeCalls: Request[] = [];
    const nativeEnvironment: SharedGatewayEnvironment = {
      ...adapter.environment,
      NATIVE_AUTH_US: {
        fetchPublic: async (request) => {
          nativeCalls.push(request);
          return new Response("ok");
        },
      },
    };
    const callback = `${dev.publicOrigin}/api/auth/v1/callback/google?code=sensitive`;
    const cleanCallback = await worker.fetch(new Request(callback), nativeEnvironment);
    expect(cleanCallback.status).toBe(404);
    expect(cleanCallback.headers.get("location")).toBeNull();
    expect(nativeCalls).toHaveLength(0);
    expect(
      (
        await worker.fetch(
          new Request(callback, {
            headers: {
              cookie: `__Host-ohmyhost_dev_access=${adapter.sessionToken}; native=session`,
              "cf-connecting-ip": "192.0.2.44",
            },
          }),
          nativeEnvironment,
        )
      ).status,
    ).toBe(200);
    expect(nativeCalls[0]?.headers.get("cookie")).toBe("native=session");
    adapter.target = dev;
    expect((await worker.fetch(new Request(dev.publicOrigin), adapter.environment)).status).toBe(
      404,
    );
    const publicAdapter = new GatewayAdapter();
    publicAdapter.target = dev;
    publicAdapter.publicDev = true;
    expect(
      (await worker.fetch(new Request(dev.publicOrigin), publicAdapter.environment)).status,
    ).toBe(200);
    const redeemed = await worker.fetch(
      new Request(
        `${dev.publicOrigin}/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
        { headers: { "cf-connecting-ip": "203.0.113.9" } },
      ),
      adapter.environment,
    );
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get("location")).toBe(`${dev.publicOrigin}/`);
    expect(adapter.redemptions.at(-1)).toMatchObject({ clientAddress: "203.0.113.9" });
    expect(redeemed.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax");
    const authenticated = new Request(dev.publicOrigin, {
      headers: { cookie: `__Host-ohmyhost_dev_access=${adapter.sessionToken}; customer=one` },
    });
    expect((await worker.fetch(authenticated, adapter.environment)).status).toBe(200);
    expect(adapter.requests[0]?.headers.get("cookie")).toBe("customer=one");
    // Only the exact redemption path redeems: an app's own stage or ticket query reaches the app.
    for (const path of ["/events?stage=final", `/?stage=dev&ticket=${"A".repeat(43)}`]) {
      const own = await worker.fetch(
        new Request(`${dev.publicOrigin}${path}`, {
          headers: { cookie: `__Host-ohmyhost_dev_access=${adapter.sessionToken}` },
        }),
        adapter.environment,
      );
      expect(own.status).toBe(200);
      expect(adapter.requests.at(-1)?.url).toBe(`${dev.publicOrigin}${path}`);
    }
    expect(adapter.redemptions).toHaveLength(1);
    // A large customer Cookie header keeps both the Dev session and the app's own cookies.
    const large = `customer=${"c".repeat(9216)}`;
    const largeCookie = await worker.fetch(
      new Request(dev.publicOrigin, {
        headers: { cookie: `${large}; __Host-ohmyhost_dev_access=${adapter.sessionToken}` },
      }),
      adapter.environment,
    );
    expect(largeCookie.status).toBe(200);
    expect(adapter.requests.at(-1)?.headers.get("cookie")).toBe(large);
    adapter.authorized = false;
    expect((await worker.fetch(authenticated, adapter.environment)).status).toBe(404);
    const revoked = await worker.fetch(
      new Request(dev.publicOrigin, {
        headers: {
          cookie: `__Host-ohmyhost_dev_access=${adapter.sessionToken}`,
          "sec-fetch-mode": "navigate",
        },
      }),
      adapter.environment,
    );
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("location")).toBe("https://ohmyho.st/");
    const token = await signDevRuntimeProbe(crypto, privateJwk, {
      ...scope,
      organizationId: ORGANIZATION_ID,
      operationId: DEPLOYMENT_ID,
      deploymentId: DEPLOYMENT_ID,
      path: "/health",
      method: "GET",
      kid: keyId,
      issuedAt: NOW,
      expiresAt: "2026-09-22T12:01:00.000Z",
    });
    adapter.response.headers.set("set-cookie", "session=probe; Path=/");
    adapter.allowed = false;
    const probe = await worker.fetch(
      new Request(`${dev.publicOrigin}/health`, { headers: { "x-ohmyhost-runtime-probe": token } }),
      adapter.environment,
    );
    expect(probe.status).toBe(200);
    expect(probe.headers.has("set-cookie")).toBe(false);
    expect(adapter.requests.at(-1)?.headers.has("x-ohmyhost-runtime-probe")).toBe(false);
    for (const request of [
      new Request(`${dev.publicOrigin}/wrong`, { headers: { "x-ohmyhost-runtime-probe": token } }),
      new Request(`${dev.publicOrigin}/health`, {
        headers: { "x-ohmyhost-runtime-probe": token, cookie: "session=bad" },
      }),
      new Request(`${dev.publicOrigin}/health?leak=1`, {
        headers: { "x-ohmyhost-runtime-probe": token },
      }),
    ])
      expect((await worker.fetch(request, adapter.environment)).status).toBe(404);
    adapter.target = {
      ...dev,
      targetDeploymentId: ORGANIZATION_ID,
      targetScriptName: `p-${PROJECT_ID.toLowerCase()}-dev-${ORGANIZATION_ID.toLowerCase()}`,
    };
    expect(
      (
        await worker.fetch(
          new Request(`${dev.publicOrigin}/health`, {
            headers: { "x-ohmyhost-runtime-probe": token },
          }),
          adapter.environment,
        )
      ).status,
    ).toBe(404);
    expect(adapter.dispatches).toHaveLength(5);
  });

  it("shares one Core lookup among concurrent requests for a hot hostname whose route expired", async () => {
    let clock = Date.parse(NOW);
    const gateway = createSharedGatewayWorker({ now: () => new Date(clock) });
    const adapter = new GatewayAdapter();
    expect(
      (await gateway.fetch(new Request(target.publicOrigin), adapter.environment)).status,
    ).toBe(200);
    clock += 31_000;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const resolved: string[] = [];
    adapter.environment.GATEWAY_ROUTING.resolve = async ({ hostname }) => {
      resolved.push(hostname);
      await gate;
      return adapter.target;
    };
    const burst = Array.from({ length: 40 }, () =>
      gateway.fetch(new Request(target.publicOrigin), adapter.environment),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toEqual([target.hostname]);
    open();
    expect((await Promise.all(burst)).map((response) => response.status)).toEqual(
      Array(40).fill(200),
    );
  });

  it("keeps a hot hostname's lookup admitted while a random-hostname flood fills its own budget", async () => {
    let clock = Date.parse(NOW);
    const gateway = createSharedGatewayWorker({ now: () => new Date(clock) });
    const adapter = new GatewayAdapter();
    expect(
      (await gateway.fetch(new Request(target.publicOrigin), adapter.environment)).status,
    ).toBe(200);
    clock += 31_000;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const resolved: string[] = [];
    adapter.environment.GATEWAY_ROUTING.resolve = async ({ hostname }) => {
      resolved.push(hostname);
      await gate;
      return hostname === target.hostname ? adapter.target : null;
    };
    const flood = Array.from({ length: 40 }, (_, index) =>
      gateway.fetch(new Request(`https://r${index}.unknown.example/`), adapter.environment),
    );
    const hot = gateway.fetch(new Request(target.publicOrigin), adapter.environment);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved.filter((hostname) => hostname === target.hostname)).toHaveLength(1);
    open();
    const floodStatuses = (await Promise.all(flood)).map((response) => response.status);
    expect(floodStatuses.filter((status) => status === 503)).toHaveLength(24);
    expect((await hot).status).toBe(200);
  });

  it("answers unknown hostnames from a short negative cache and bounds concurrent Core lookups", async () => {
    let clock = Date.parse(NOW);
    const gateway = createSharedGatewayWorker({ now: () => new Date(clock) });
    const adapter = new GatewayAdapter();
    adapter.target = null;
    for (let attempt = 0; attempt < 3; attempt++)
      expect(
        (await gateway.fetch(new Request("https://ghost.unknown.example/"), adapter.environment))
          .status,
      ).toBe(404);
    expect(adapter.resolved).toEqual(["ghost.unknown.example"]);
    clock += 16_000;
    await gateway.fetch(new Request("https://ghost.unknown.example/"), adapter.environment);
    expect(adapter.resolved).toHaveLength(2);

    // Concurrent misses for distinct unknown hostnames share at most 32 Core lookups per isolate.
    const pending: (() => void)[] = [];
    adapter.environment.GATEWAY_ROUTING.resolve = async ({ hostname }) => {
      adapter.resolved.push(hostname);
      await new Promise<void>((resolve) => pending.push(resolve));
      return null;
    };
    const burst = Array.from({ length: 40 }, (_, index) =>
      gateway.fetch(new Request(`https://n${index}.unknown.example/`), adapter.environment),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.resolved.length - 2).toBe(16);
    while (pending.length > 0) pending.shift()?.();
    const statuses = (await Promise.all(burst)).map((response) => response.status);
    expect(statuses.filter((status) => status === 503)).toHaveLength(24);
  });

  it("reuses bounded routes and credits while checking Dev revocation on every request", async () => {
    let clock = Date.parse(NOW);
    const cached = createSharedGatewayWorker({ now: () => new Date(clock) });
    const adapter = new GatewayAdapter();
    let releaseCredit: () => void = () => undefined;
    const read = adapter.environment.CREDIT_ADMISSION.read;
    const order: string[] = [];
    adapter.environment.CREDIT_ADMISSION.read = async (scope) => {
      order.push("credit:start");
      await new Promise<void>((resolve) => (releaseCredit = resolve));
      return read(scope);
    };
    const first = cached.fetch(new Request(target.publicOrigin), adapter.environment);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["credit:start"]);
    releaseCredit();
    expect((await first).status).toBe(200);
    adapter.environment.CREDIT_ADMISSION.read = read;
    adapter.allowed = false;
    adapter.target = null;
    clock += 29_999;
    expect((await cached.fetch(new Request(target.publicOrigin), adapter.environment)).status).toBe(
      200,
    );
    expect([adapter.resolved.length, adapter.creditReads]).toEqual([1, 1]);
    clock += 1;
    expect((await cached.fetch(new Request(target.publicOrigin), adapter.environment)).status).toBe(
      404,
    );
    adapter.target = target;
    clock = Date.parse(NOW) + 299_999;
    expect((await cached.fetch(new Request(target.publicOrigin), adapter.environment)).status).toBe(
      200,
    );
    clock += 1;
    adapter.creditCheckedAt = new Date(clock).toISOString();
    expect((await cached.fetch(new Request(target.publicOrigin), adapter.environment)).status).toBe(
      402,
    );
    expect(adapter.creditReads).toBe(2);
    // A decision is never reused past its own expiry, even inside the 5-minute window.
    adapter.allowed = true;
    adapter.creditCheckedAt = new Date(clock - 60_000).toISOString();
    clock += 300_000;
    adapter.creditCheckedAt = new Date(clock - 60_000).toISOString();
    expect((await cached.fetch(new Request(target.publicOrigin), adapter.environment)).status).toBe(
      200,
    );
    adapter.allowed = false;
    clock += 840_000;
    adapter.creditCheckedAt = new Date(clock).toISOString();
    expect((await cached.fetch(new Request(target.publicOrigin), adapter.environment)).status).toBe(
      402,
    );
    // A replaced deployment evicts its cached route instead of staying unreachable.
    adapter.dispatchError = new Error("Worker not found");
    adapter.allowed = true;
    clock += 300_000;
    adapter.creditCheckedAt = new Date(clock).toISOString();
    expect((await cached.fetch(new Request(target.publicOrigin), adapter.environment)).status).toBe(
      404,
    );
    const resolvedBefore = adapter.resolved.length;
    adapter.dispatchError = null;
    await cached.fetch(new Request(target.publicOrigin), adapter.environment);
    expect(adapter.resolved.length).toBe(resolvedBefore + 1);

    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const publicJwk = {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: String(exported.x),
      y: String(exported.y),
    };
    const keyId = await digestDevAccessPublicJwk(crypto, publicJwk);
    const dev = {
      ...target,
      environmentName: "dev" as const,
      hostname: "dev-calm-river-studio.check.omh.st",
      publicOrigin: "https://dev-calm-river-studio.check.omh.st",
      targetScriptName: `p-${PROJECT_ID.toLowerCase()}-dev-${DEPLOYMENT_ID.toLowerCase()}`,
      devAccess: { keyId, publicJwk },
    };
    adapter.target = dev;
    const issuedAt = new Date(clock).toISOString();
    const session = await signDevAccessSession(
      crypto,
      await crypto.subtle.exportKey("jwk", keys.privateKey),
      {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        handle: target.handle,
        origin: dev.publicOrigin,
        kid: keyId,
        devAccessEpoch: 1,
        subjectId: "user:user_1",
        issuedAt,
        expiresAt: new Date(clock + 43_200_000).toISOString(),
      },
    );
    const authenticated = () =>
      new Request(dev.publicOrigin, {
        headers: { cookie: `__Host-ohmyhost_dev_access=${session}` },
      });
    expect((await cached.fetch(authenticated(), adapter.environment)).status).toBe(200);
    adapter.authorized = false;
    clock += 119_999;
    adapter.creditCheckedAt = new Date(clock).toISOString();
    expect((await cached.fetch(authenticated(), adapter.environment)).status).toBe(404);
    expect(adapter.authorizations).toHaveLength(2);
    clock += 1;
    expect((await cached.fetch(authenticated(), adapter.environment)).status).toBe(404);
    expect(adapter.authorizations).toHaveLength(3);
  });

  it("applies a Dev access mode change on the next request and answers 503 when authorization is unavailable", async () => {
    const adapter = new GatewayAdapter();
    // One isolate and a frozen clock: no cache window may hide a mode change.
    const isolate = createSharedGatewayWorker({ now: () => new Date(NOW) });
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const publicJwk = {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: String(exported.x),
      y: String(exported.y),
    };
    const dev = {
      ...target,
      environmentName: "dev" as const,
      hostname: "dev-calm-river-studio.check.omh.st",
      publicOrigin: "https://dev-calm-river-studio.check.omh.st",
      targetScriptName: `p-${PROJECT_ID.toLowerCase()}-dev-${DEPLOYMENT_ID.toLowerCase()}`,
      devAccess: { keyId: await digestDevAccessPublicJwk(crypto, publicJwk), publicJwk },
    };
    adapter.target = dev;
    const anonymous = () =>
      isolate.fetch(new Request(`${dev.publicOrigin}/app.js`), adapter.environment);
    // A Control outage or rate limit is not a denial: no 404 and no revoked redirect.
    adapter.authorizeError = true;
    expect((await anonymous()).status).toBe(503);
    adapter.authorizeError = false;
    // protected -> public and public -> protected apply on the first request after the change.
    expect((await anonymous()).status).toBe(404);
    adapter.publicDev = true;
    expect((await anonymous()).status).toBe(200);
    expect((await anonymous()).status).toBe(200);
    adapter.publicDev = false;
    expect((await anonymous()).status).toBe(404);
    expect(adapter.authorizations).toHaveLength(5);
    expect(
      adapter.authorizations.every((input) => Reflect.get(Object(input), "sessionToken") === null),
    ).toBe(true);
    // A session outage is never shown as a revoked link, even for a browser navigation.
    const session = await signDevAccessSession(
      crypto,
      await crypto.subtle.exportKey("jwk", keys.privateKey),
      {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        handle: target.handle,
        origin: dev.publicOrigin,
        kid: dev.devAccess.keyId,
        devAccessEpoch: 1,
        subjectId: `share:${PROJECT_ID}`,
        issuedAt: NOW,
        expiresAt: "2026-09-23T00:00:00.000Z",
      },
    );
    adapter.authorizeError = true;
    const unavailable = await isolate.fetch(
      new Request(dev.publicOrigin, {
        headers: {
          cookie: `__Host-ohmyhost_dev_access=${session}`,
          "sec-fetch-mode": "navigate",
        },
      }),
      adapter.environment,
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.has("location")).toBe(false);
    // Switching to public revokes the share link; its old URL then opens the public Dev URL.
    adapter.redeemError = true;
    const oldLink = () =>
      isolate.fetch(
        new Request(
          `${dev.publicOrigin}/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
        ),
        adapter.environment,
      );
    adapter.authorizeError = false;
    adapter.publicDev = true;
    const opened = await oldLink();
    expect([opened.status, opened.headers.get("location")]).toEqual([303, `${dev.publicOrigin}/`]);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
    expect(opened.headers.has("set-cookie")).toBe(false);
    adapter.publicDev = false;
    const revoked = await oldLink();
    expect([revoked.status, revoked.headers.get("location")]).toEqual([303, "https://ohmyho.st/"]);
    adapter.authorizeError = true;
    expect((await oldLink()).status).toBe(503);
    // A limited redemption is not a refused ticket: the share link stays valid and answers 503.
    adapter.authorizeError = false;
    adapter.publicDev = false;
    adapter.redeemRateLimited = true;
    const limited = await oldLink();
    expect([limited.status, limited.headers.has("location")]).toEqual([503, false]);
    adapter.redeemRateLimited = false;
  });

  it("publishes at most one diagnostic marker per deployment and window for each isolate", async () => {
    let clock = Date.parse(NOW);
    const adapter = new GatewayAdapter();
    const diagnostics: unknown[] = [];
    const gateway = createSharedGatewayWorker({
      now: () => new Date(clock),
      diagnosticSink: (value) => diagnostics.push(value),
    });
    adapter.response = new Response("failed", { status: 500 });
    for (let index = 0; index < 200; index++)
      expect(
        (await gateway.fetch(new Request(target.publicOrigin), adapter.environment)).status,
      ).toBe(500);
    expect(diagnostics).toHaveLength(1);
    clock += 61_000;
    await gateway.fetch(new Request(target.publicOrigin), adapter.environment);
    expect(diagnostics).toHaveLength(2);
  });

  it("signs scoped diagnostics without returning provider failures and rejects public probe authority", async () => {
    const adapter = new GatewayAdapter();
    const diagnostics: unknown[] = [];
    const diagnosticWorker = createSharedGatewayWorker({
      now: () => new Date(NOW),
      diagnosticSink: (value) => diagnostics.push(value),
    });
    adapter.response = new Response("failed", { status: 500 });
    expect(
      (await diagnosticWorker.fetch(new Request(target.publicOrigin), adapter.environment)).status,
    ).toBe(500);
    for (const [message, expected, text] of [
      ["Worker not found", 404, ACCESS_GUIDANCE],
      [
        "CPU time limit exceeded",
        429,
        "Runtime limit exceeded: this request used more than 50 ms of CPU time. This is not a rate limit; reduce the work per request.",
      ],
      [
        "password=provider-secret",
        502,
        "Upstream unavailable: this app threw an exception or did not answer the request.",
      ],
    ] as const) {
      adapter.dispatchError = new Error(message);
      const response = await diagnosticWorker.fetch(
        new Request(target.publicOrigin),
        adapter.environment,
      );
      expect(response.status).toBe(expected);
      expect(await response.text()).toBe(text);
    }
    // One marker per deployment and window: the first failure answers for the others.
    expect(diagnostics).toHaveLength(1);
    const signed = diagnostics[0] as Record<string, unknown>;
    expect(signed).toMatchObject({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      deploymentId: DEPLOYMENT_ID,
      source: "runtime",
      code: "RUNTIME_FAILED",
      occurredAt: NOW,
    });
    const { markerSignature, ...marker } = signed;
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "HMAC",
        key,
        Uint8Array.from(Buffer.from(String(markerSignature), "base64url")),
        new TextEncoder().encode(JSON.stringify(marker)),
      ),
    ).toBe(true);
    for (const request of [
      new Request(target.publicOrigin, { headers: { "x-ohmyhost-runtime-probe": "forged" } }),
      new Request(
        `${target.publicOrigin}/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`,
      ),
      new Request(`http://${target.hostname}/`),
      new Request(`${target.publicOrigin}:8443/`),
    ]) {
      expect((await diagnosticWorker.fetch(request, adapter.environment)).status).toBe(404);
    }
    // Production refuses only the redemption path: an app's own ticket query reaches the app.
    adapter.dispatchError = null;
    adapter.response = new Response("support");
    const support = await diagnosticWorker.fetch(
      new Request(`${target.publicOrigin}/support?ticket=42`),
      adapter.environment,
    );
    expect(support.status).toBe(200);
    expect(adapter.requests.at(-1)?.url).toBe(`${target.publicOrigin}/support?ticket=42`);
  });

  it("samples runtime diagnostics per environment and never changes the customer response when the limiter is absent or fails", async () => {
    const adapter = new GatewayAdapter();
    adapter.response = new Response("failed", { status: 500 });
    const counts = new Map<string, number>();
    const keys: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        const used = (counts.get(key) ?? 0) + 1;
        counts.set(key, used);
        return { success: used <= 3 };
      },
    };
    const limited: SharedGatewayEnvironment = {
      ...adapter.environment,
      DIAGNOSTIC_LIMITER: limiter,
    };
    // Each request sits in its own window, so every marker reaches the limiter.
    let windowClock = Date.parse(NOW);
    const limitedDiagnostics: unknown[] = [];
    const limitedWorker = createSharedGatewayWorker({
      now: () => new Date(windowClock),
      diagnosticSink: (value) => limitedDiagnostics.push(value),
    });
    for (let index = 0; index < 20; index++) {
      adapter.creditCheckedAt = new Date(windowClock).toISOString();
      const response = await limitedWorker.fetch(new Request(target.publicOrigin), limited);
      expect(response.status).toBe(500);
      windowClock += 61_000;
      adapter.creditCheckedAt = new Date(windowClock).toISOString();
    }
    expect(limitedDiagnostics).toHaveLength(3);
    expect(keys).toEqual(Array.from({ length: 20 }, () => ENVIRONMENT_ID));

    const unboundDiagnostics: unknown[] = [];
    windowClock = Date.parse(NOW);
    const unboundWorker = createSharedGatewayWorker({
      now: () => new Date(windowClock),
      diagnosticSink: (value) => unboundDiagnostics.push(value),
    });
    for (let index = 0; index < 20; index++) {
      adapter.creditCheckedAt = new Date(windowClock).toISOString();
      await unboundWorker.fetch(new Request(target.publicOrigin), adapter.environment);
      windowClock += 61_000;
      adapter.creditCheckedAt = new Date(windowClock).toISOString();
    }
    expect(unboundDiagnostics).toHaveLength(20);

    const brokenDiagnostics: unknown[] = [];
    const brokenWorker = createSharedGatewayWorker({
      now: () => new Date(NOW),
      diagnosticSink: (value) => brokenDiagnostics.push(value),
    });
    const broken: SharedGatewayEnvironment = {
      ...adapter.environment,
      DIAGNOSTIC_LIMITER: {
        limit: async () => {
          throw new Error("limiter unavailable");
        },
      },
    };
    adapter.creditCheckedAt = NOW;
    const brokenResponse = await brokenWorker.fetch(new Request(target.publicOrigin), broken);
    expect(brokenResponse.status).toBe(500);
    expect(brokenDiagnostics).toHaveLength(1);
  });

  it("shows the owner's flag only on production HTML documents, styled with the response nonce", async () => {
    vi.stubGlobal("HTMLRewriter", TestHtmlRewriter);
    const adapter = new GatewayAdapter();
    adapter.target = { ...target, poweredBy: true };
    const page = "<html><body><main>Shop</main></body></html>";
    const html = (headers: Record<string, string> = {}, status = 200) =>
      new Response(page, {
        status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(page.length),
          etag: '"v1"',
          ...headers,
        },
      });
    const document = (init: RequestInit = {}) =>
      new Request(`${target.publicOrigin}/`, {
        ...init,
        headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      });

    adapter.response = html({ "x-ohmyhost-runtime": "edge-v1" });
    const edge = await worker.fetch(document(), adapter.environment);
    const nonce = adapter.requests.at(-1)?.headers.get("x-nonce") ?? "";
    const body = await edge.text();
    expect(body).toBe(
      page.replace("</body>", `${poweredByFlagMarkup({ projectId: PROJECT_ID, nonce })}</body>`),
    );
    expect(body.match(/<ohmyhost-flag>/gu)).toHaveLength(1);
    expect(body).toContain(`<style nonce="${nonce}">`);
    expect(body).toContain(
      `href="https://ohmyho.st/?r=flag-${PROJECT_ID.toLowerCase()}" target="_blank" rel="sponsored noopener"`,
    );
    expect(body).not.toMatch(/<script|src=|url\(/u);
    expect(edge.headers.get("content-security-policy")).toContain(
      `style-src 'self' 'nonce-${nonce}'`,
    );
    expect(edge.headers.has("content-length")).toBe(false);
    expect(edge.headers.get("etag")).toBe('W/"v1"');

    // A static site's policy gains the nonce only for the flag's own style.
    adapter.response = html();
    const staticSite = await worker.fetch(document(), adapter.environment);
    const staticNonce = adapter.requests.at(-1)?.headers.get("x-nonce") ?? "";
    expect(await staticSite.text()).toContain(`<style nonce="${staticNonce}">`);
    expect(staticSite.headers.get("content-security-policy")).toContain(
      `style-src 'self' 'nonce-${staticNonce}'; img-src 'self' data:`,
    );
    expect(staticSite.headers.get("content-security-policy")).toContain("script-src 'self';");

    const untouched = [
      [document({ method: "POST" }), html()],
      [new Request(`${target.publicOrigin}/`, { headers: { "sec-fetch-dest": "empty" } }), html()],
      [document(), html({}, 404)],
      [
        document(),
        new Response('{"body":"</body>"}', { headers: { "content-type": "application/json" } }),
      ],
    ] as const;
    for (const [request, response] of untouched) {
      adapter.response = response;
      const result = await worker.fetch(request, adapter.environment);
      expect(await result.text()).not.toContain("ohmyhost-flag");
      if (!response.headers.get("content-type")?.startsWith("text/html")) continue;
      expect(result.headers.get("content-security-policy")).toContain("style-src 'self';");
    }
    adapter.target = target;
    adapter.response = html();
    expect(await (await worker.fetch(document(), adapter.environment)).text()).toBe(page);
    // A returning visitor's validator never revalidates a production document, so a changed
    // flag state is shown at once; other requests keep their conditional revalidation.
    const revisit = (validator: string, destination = "document") =>
      worker.fetch(
        new Request(`${target.publicOrigin}/`, {
          headers: {
            "sec-fetch-dest": destination,
            "sec-fetch-mode": "navigate",
            "if-none-match": validator,
            "if-modified-since": "Tue, 22 Sep 2026 12:00:00 GMT",
          },
        }),
        adapter.environment,
      );
    adapter.target = { ...target, poweredBy: true };
    const flagged = await revisit('"v1"');
    const revisitNonce = adapter.requests.at(-1)?.headers.get("x-nonce") ?? "";
    expect(flagged.status).toBe(200);
    expect(await flagged.text()).toContain(`<style nonce="${revisitNonce}">`);
    expect(flagged.headers.get("content-security-policy")).toContain(`'nonce-${revisitNonce}'`);
    expect(adapter.requests.at(-1)?.headers.has("if-none-match")).toBe(false);
    expect(adapter.requests.at(-1)?.headers.has("if-modified-since")).toBe(false);
    adapter.target = target;
    const unflagged = await revisit('W/"v1"');
    expect(unflagged.status).toBe(200);
    expect(await unflagged.text()).toBe(page);
    expect((await revisit('"v1"', "script")).status).toBe(304);
    // Dev never shows the flag: Control cannot mark a Dev route.
    adapter.target = { ...target, environmentName: "dev", poweredBy: true };
    expect((await worker.fetch(document(), adapter.environment)).status).toBe(503);
    expect(() => poweredByFlagMarkup({ projectId: PROJECT_ID, nonce: '"><script>' })).toThrow(
      "Invalid powered-by flag input",
    );
  });

  it("decodes a gzip production document before it adds the owner's flag", async () => {
    vi.stubGlobal("HTMLRewriter", TestHtmlRewriter);
    const adapter = new GatewayAdapter();
    adapter.target = { ...target, poweredBy: true };
    const page = "<html><body><main>Shop</main></body></html>";
    adapter.response = new Response(
      new Blob([page]).stream().pipeThrough(new CompressionStream("gzip")),
      { headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" } },
    );
    const result = await worker.fetch(
      new Request(`${target.publicOrigin}/`, {
        headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      }),
      adapter.environment,
    );
    expect(result.headers.get("content-encoding")).toBeNull();
    expect(await result.text()).toContain("ohmyhost-flag");
  });

  it("fails closed with a platform text when the flag must be added to an encoding it cannot decode", async () => {
    vi.stubGlobal("HTMLRewriter", TestHtmlRewriter);
    const adapter = new GatewayAdapter();
    adapter.target = { ...target, poweredBy: true };
    const page = "<html><body><main>Shop</main></body></html>";
    const request = () =>
      new Request(`${target.publicOrigin}/`, {
        headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      });
    for (const encoding of ["br", "zstd", "gzip, br"]) {
      adapter.response = new Response(page, {
        headers: { "content-type": "text/html; charset=utf-8", "content-encoding": encoding },
      });
      const result = await worker.fetch(request(), adapter.environment);
      expect(result.status, encoding).toBe(502);
      const text = await result.text();
      expect(text, encoding).not.toContain("Shop");
      expect(text, encoding).not.toContain("ohmyhost-flag");
    }
  });

  it("fails closed with the same platform text when the refused body also cannot be cancelled", async () => {
    vi.stubGlobal("HTMLRewriter", TestHtmlRewriter);
    const adapter = new GatewayAdapter();
    adapter.target = { ...target, poweredBy: true };
    // An errored body refuses cancellation; the gateway still answers the platform text, never the body.
    adapter.response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("body refused"));
        },
      }),
      { headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "br" } },
    );
    const result = await worker.fetch(
      new Request(`${target.publicOrigin}/`, {
        headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      }),
      adapter.environment,
    );
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("body refused");
  });

  it("fails closed when a gzip production document decodes past the 16 MiB limit", async () => {
    vi.stubGlobal("HTMLRewriter", TestHtmlRewriter);
    const adapter = new GatewayAdapter();
    adapter.target = { ...target, poweredBy: true };
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
    oversized.fill(0x61);
    adapter.response = new Response(
      new Blob([oversized]).stream().pipeThrough(new CompressionStream("gzip")),
      { headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" } },
    );
    const result = await worker.fetch(
      new Request(`${target.publicOrigin}/`, {
        headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      }),
      adapter.environment,
    );
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("aaaa");
  });

  it("fails closed when a gzip production document is corrupt", async () => {
    vi.stubGlobal("HTMLRewriter", TestHtmlRewriter);
    const adapter = new GatewayAdapter();
    adapter.target = { ...target, poweredBy: true };
    adapter.response = new Response("<html><body>not gzip</body></html>", {
      headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" },
    });
    const result = await worker.fetch(
      new Request(`${target.publicOrigin}/`, {
        headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      }),
      adapter.environment,
    );
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("not gzip");
  });

  it("serves a Free custom domain only while the owner shows the flag and refuses a target without the flag", async () => {
    const adapter = new GatewayAdapter();
    adapter.paidAllowed = false;
    const customer = () =>
      worker.fetch(new Request("https://customer.example.com/"), adapter.environment);
    adapter.target = { ...target, hostname: "customer.example.com", poweredBy: true };
    expect((await customer()).status).toBe(200);
    adapter.target = { ...target, hostname: "customer.example.com" };
    // Each pause names its cause and the owner's way out.
    const paid = await customer();
    expect([paid.status, await paid.text()]).toEqual([
      402,
      "Project execution paused: a custom domain needs Paid access or the project's powered-by flag (paid_plan_required); the project's check.omh.st address still serves.",
    ]);
    adapter.allowed = false;
    adapter.target = { ...target, hostname: "customer.example.com", poweredBy: true };
    const budget = await customer();
    expect([budget.status, await budget.text()]).toEqual([
      402,
      "Project execution paused: this project's Stop budget is used up (project_budget_exceeded). Raise the budget or switch it to continue; the app serves again within about five minutes.",
    ]);
    adapter.reason = "insufficient_organization_credits";
    const credits = await customer();
    expect([credits.status, await credits.text()]).toEqual([
      402,
      "Project execution paused: the organization's credits are used up (insufficient_organization_credits). Add credits; the app serves again within about five minutes.",
    ]);
    adapter.reason = "project_budget_exceeded";
    adapter.allowed = true;
    const preFlag: Record<string, unknown> = { ...target };
    delete preFlag["poweredBy"];
    adapter.target = preFlag;
    expect(
      (await worker.fetch(new Request(`${target.publicOrigin}/`), adapter.environment)).status,
    ).toBe(503);
    adapter.target = { ...target, poweredBy: "yes" };
    expect(
      (await worker.fetch(new Request(`${target.publicOrigin}/`), adapter.environment)).status,
    ).toBe(503);
  });
});
