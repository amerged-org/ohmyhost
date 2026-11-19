import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    public readonly env = undefined;
  },
}));

import type { D1ProjectRuntime } from "../src/d1-project-persistence.js";
import {
  ConnectionAuthorityService,
  CONTROL_API_POC_ORIGIN,
  createRemoteWorkosJwksSource,
  createWorkosTokenPolicies,
  createControlApiWorkerEntrypoint,
  wakeAcceptedOperation,
  fetchGlobally,
  reportComposeFailure,
  type ControlApiWorkerBindings,
} from "../src/worker-main.js";

/** Every Core method exists; a request that reaches one fails the test that expected to stop earlier. */
const coreRuntime = (onCall: () => void = () => undefined) =>
  new Proxy(
    {},
    {
      get: () => async () => {
        onCall();
        throw new Error("The Core must not be reached");
      },
    },
  ) as unknown as D1ProjectRuntime;

const bindings = (): ControlApiWorkerBindings => ({
  AUTH_STATUS: { fetch: vi.fn() },
  OPERATION_PUBLISHER: { wake: async () => undefined },
  CONTROL_RUNTIME: coreRuntime(),
  CONTROL_API_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  CONTROL_API_PUBLIC_ORIGIN: CONTROL_API_POC_ORIGIN,
  GITHUB_WEBHOOK_INGRESS: { fetch: vi.fn() },
  WORKOS_WEBHOOK_INGRESS: { fetch: vi.fn() },
  SOURCE_INSPECTOR: {
    beginOrganizationAuthorization: vi.fn(),
    completeOrganizationAuthorization: vi.fn(),
    observeOrganizationInstallation: vi.fn(),
    validateOrganizationRepository: vi.fn(),
    validateRepositoryLink: vi.fn(),
    inspectExact: vi.fn(),
    beginRepositoryAuthorization: async () => {
      throw new Error("No consent in entrypoint fixture");
    },
    completeRepositoryAuthorization: async () => {
      throw new Error("No consent in entrypoint fixture");
    },
  },
  PROVIDER_RECONCILIATION: { reconcile: vi.fn() },
  NEON_MANAGEMENT: {
    queryProject: vi.fn(),
    writeProject: vi.fn(),
    readCompute: vi.fn(),
    changeCompute: vi.fn(),
    runComputeChange: vi.fn(),
    issueDatabaseAccess: vi.fn(),
    revokeDatabaseAccess: vi.fn(),
    databaseEvents: vi.fn(),
    createDatabaseTable: vi.fn(),
  },
  CLOUDFLARE_DOMAIN_MANAGEMENT: {
    beginAuthorization: vi.fn(),
    getStatus: vi.fn(),
    configureDomains: vi.fn(),
    completeAuthorization: vi.fn(),
    planPaidDomain: vi.fn(),
    applyPaidDomain: vi.fn(),
    getPaidDomain: vi.fn(),
    deletePaidDomain: vi.fn(),
  },
  ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x41).toString("base64"),
  ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: JSON.stringify({
    2: Buffer.alloc(32, 0x42).toString("base64"),
  }),
  ENVIRONMENT_SECRET_KEY_VERSION: "2",
  WORKOS_JWKS_URL: "https://sandbox.authkit.app/oauth2/jwks",
  WORKOS_ISSUER: "https://api.workos.com/user_management/client_sandbox",
  WORKOS_CLIENT_ID: "client_sandbox",
  WORKOS_AUDIENCE: "control-api",
});

const CORE_BINDINGS = [
  "ACCOUNT_METADATA_RUNTIME",
  "CONNECTION_CONTROL",
  "CONTROL_MAINTENANCE_RUNTIME",
  "CONTROL_RUNTIME",
  "CUSTOMER_FEEDBACK_RUNTIME",
  "DATABASE_PRODUCT_RUNTIME",
  "DEV_ACCESS_RUNTIME",
  "GATEWAY_CREDIT_RUNTIME",
  "GATEWAY_LOOKUP_RUNTIME",
  "GATEWAY_MANAGEMENT_RUNTIME",
  "GITHUB_RUNTIME",
  "MAIL_MANAGEMENT_RUNTIME",
  "MANAGED_SOURCE_RUNTIME",
  "NATIVE_AUTH_PROVIDER_RUNTIME",
  "PREVIEW_API_RUNTIME",
  "PRODUCT_API_RUNTIME",
  "PUBLIC_CREDIT_RUNTIME",
  "PUBLIC_ENTRY_RETENTION_RUNTIME",
  "PUBLIC_ENTRY_RUNTIME",
  "RUNTIME_PROBE_RUNTIME",
  "SHARED_MAIL_RUNTIME",
];
const coreBindings = (services: unknown, core: string) =>
  (services as { binding: string; service: string }[])
    .filter(({ service }) => service === core)
    .map(({ binding }) => binding)
    .sort();

describe("public Control API Worker composition", () => {
  it("fences public cutover ingress before database, login, webhook and publisher work", async () => {
    const fetcher = vi.fn();
    const worker = createControlApiWorkerEntrypoint({ fetcher });
    const env = {
      ...bindings(),
      OMH_DATABASE_CUTOVER_MAINTENANCE: "on",
      BROWSER_LOGIN_ENABLED: "true" as const,
    };
    for (const [path, method] of [
      ["/v1/projects", "POST"],
      ["/webhooks/workos", "POST"],
      ["/webhooks/github", "POST"],
      ["/mcp", "POST"],
      ["/login", "GET"],
      ["/", "HEAD"],
    ] as const) {
      const response = await worker.fetch(
        new Request(`${CONTROL_API_POC_ORIGIN}${path}`, { method }),
        env,
        { waitUntil: vi.fn() },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe(
        method === "HEAD" ? "" : "Temporarily unavailable. Please retry shortly.",
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(env.WORKOS_WEBHOOK_INGRESS.fetch).not.toHaveBeenCalled();
    expect(env.GITHUB_WEBHOOK_INGRESS.fetch).not.toHaveBeenCalled();
    expect(
      (
        await worker.fetch(
          new Request(`${CONTROL_API_POC_ORIGIN}/favicon.svg`),
          { ...env, OMH_DATABASE_CUTOVER_MAINTENANCE: undefined },
          { waitUntil: vi.fn() },
        )
      ).status,
    ).toBe(200);
  });

  it("wakes durable accepted operations without delaying or replacing their response", async () => {
    const pending: Promise<unknown>[] = [];
    const context = { waitUntil: (work: Promise<unknown>) => pending.push(work) };
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const publisher = {
      wake: async () => {
        calls += 1;
        await work;
      },
    };
    const response = new Response("accepted", { status: 202 });
    expect(
      wakeAcceptedOperation(
        new Request(`${CONTROL_API_POC_ORIGIN}/v1/projects`, { method: "POST" }),
        response,
        publisher,
        context,
      ),
    ).toBe(response);
    expect(await response.text()).toBe("accepted");
    expect(calls).toBe(1);
    expect(pending).toHaveLength(1);
    finish();
    await pending[0];
    for (const [path, method, status] of [
      ["/v1/projects", "GET", 200],
      ["/v1/projects", "POST", 401],
      ["/webhooks/github", "POST", 202],
    ] as const)
      wakeAcceptedOperation(
        new Request(`${CONTROL_API_POC_ORIGIN}${path}`, { method }),
        new Response(null, { status }),
        publisher,
        context,
      );
    expect(pending).toHaveLength(1);
    wakeAcceptedOperation(
      new Request(`${CONTROL_API_POC_ORIGIN}/v1/github/oauth/callback?code=private`),
      new Response(null, { status: 303, headers: { location: "/github/authorized" } }),
      publisher,
      context,
    );
    await pending[1];
    expect(calls).toBe(2);
    wakeAcceptedOperation(
      new Request(`${CONTROL_API_POC_ORIGIN}/v1/github/oauth/callback`),
      new Response(null, { status: 303, headers: { location: "/github/authorization-pending" } }),
      publisher,
      context,
    );
    expect(pending).toHaveLength(2);
    const accepted = new Response("accepted", { status: 202 });
    expect(
      wakeAcceptedOperation(
        new Request(`${CONTROL_API_POC_ORIGIN}/v1/projects`, { method: "POST" }),
        accepted,
        {
          wake: () => {
            throw new Error("private connection details");
          },
        },
        context,
      ),
    ).toBe(accepted);
    await expect(pending[2]).rejects.toThrow("Operation publisher wake failed");
    expect(await accepted.text()).toBe("accepted");
  });

  it("fails the scheduled GitHub push consumer closed when runtime bindings are incomplete", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });
    await expect(worker.scheduled({ cron: "* * * * *", scheduledTime: 0 }, {})).resolves.toEqual({
      ok: false,
      error: "unavailable",
    });
  });
  it("reports the scheduled GitHub push drain as failed when its inbox cannot be claimed", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });
    // The GitHub, Core and maintenance runtimes are present by name and fail on use, so the drain's claims fail,
    // not its wiring; the database products tick is idle, so the settlement reports the drain.
    const result = await worker.scheduled({ cron: "* * * * *", scheduledTime: 0 }, {
      CONTROL_API_PUBLIC_ORIGIN: CONTROL_API_POC_ORIGIN,
      GITHUB_RUNTIME: coreRuntime(),
      CONTROL_RUNTIME: coreRuntime(),
      CONTROL_MAINTENANCE_RUNTIME: coreRuntime(),
      PRODUCT_API_RUNTIME: coreRuntime(),
      NEON_MANAGEMENT: { maintainDatabaseProducts: async () => ({ status: "idle" }) },
      DATABASE_PRODUCT_RUNTIME: {
        acknowledgeProductComputeOutbox: async () => true,
        readDueProductCompute: async () => [],
      },
    } as unknown as Partial<ControlApiWorkerBindings>);
    expect(result).toMatchObject({
      ok: false,
      settlement: { githubAutoDeploy: { status: "failed", processed: 0, failed: 3 } },
    });
  });
  it("accepts 365-day interactive tokens while retaining the one-hour M2M age ceiling", () => {
    expect(createWorkosTokenPolicies(bindings())).toEqual([
      {
        kind: "session",
        issuer: "https://api.workos.com/user_management/client_sandbox",
        clientId: "client_sandbox",
        maximumTokenAgeSeconds: 365 * 24 * 60 * 60,
      },
      {
        kind: "m2m",
        issuer: "https://api.workos.com/user_management/client_sandbox",
        audience: "control-api",
      },
    ]);
  });

  it("forwards exact WorkOS webhook bytes and headers before API composition", async () => {
    const body = new Uint8Array([0, 255, 10, 123, 34, 120, 34, 58, 49, 125]);
    const forwarded: {
      body?: Uint8Array;
      signature?: string | null;
      authorization?: string | null;
    } = {};
    const webhookFetch = vi.fn(async (request: Request) => {
      forwarded.body = new Uint8Array(await request.arrayBuffer());
      forwarded.signature = request.headers.get("workos-signature");
      forwarded.authorization = request.headers.get("authorization");
      return new Response("accepted", { status: 202, headers: { "x-ingress": "private" } });
    });
    const oidcFetcher = vi.fn();
    const worker = createControlApiWorkerEntrypoint({ fetcher: oidcFetcher });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/webhooks/workos`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "workos-signature": "t=1700000000,v1=reviewed-signature",
          "x-request-id": "request-1",
        },
        body,
      }),
      { ...bindings(), WORKOS_WEBHOOK_INGRESS: { fetch: webhookFetch } },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("x-ingress")).toBe("private");
    expect(await response.text()).toBe("accepted");
    expect(forwarded.body).toEqual(body);
    expect(forwarded.signature).toBe("t=1700000000,v1=reviewed-signature");
    expect(forwarded.authorization).toBeNull();
    expect(webhookFetch).toHaveBeenCalledOnce();
    expect(oidcFetcher).not.toHaveBeenCalled();
  });

  it("forwards exact GitHub webhook bytes and signature headers before API composition", async () => {
    const body = new Uint8Array([123, 34, 114, 101, 102, 34, 58, 34, 109, 97, 105, 110, 34, 125]);
    const webhookFetch = vi.fn(async (request: Request) => {
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(body);
      expect(request.headers.get("x-hub-signature-256")).toBe("sha256=reviewed-signature");
      expect(request.headers.get("x-github-delivery")).toBe("123e4567-e89b-42d3-a456-426614174000");
      expect(request.headers.get("authorization")).toBeNull();
      return Response.json({ accepted: true, duplicate: false }, { status: 202 });
    });
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/webhooks/github`, {
        method: "POST",
        headers: {
          "x-github-delivery": "123e4567-e89b-42d3-a456-426614174000",
          "x-github-event": "push",
          "x-hub-signature-256": "sha256=reviewed-signature",
        },
        body,
      }),
      { ...bindings(), GITHUB_WEBHOOK_INGRESS: { fetch: webhookFetch } },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, duplicate: false });
    expect(webhookFetch).toHaveBeenCalledOnce();
  });

  it("passes through duplicate and provider responses without rewriting them", async () => {
    const privateResponse = Response.json(
      { code: "duplicate_webhook", providerEventId: "evt_sandbox" },
      { status: 409, headers: { "cache-control": "private, no-store", "x-ingress": "duplicate" } },
    );
    const webhookFetch = vi.fn().mockResolvedValue(privateResponse);
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/webhooks/workos`, {
        method: "POST",
        body: "{}",
      }),
      { ...bindings(), WORKOS_WEBHOOK_INGRESS: { fetch: webhookFetch } },
      { waitUntil: vi.fn() },
    );

    expect(response).toBe(privateResponse);
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-ingress")).toBe("duplicate");
    await expect(response.json()).resolves.toEqual({
      code: "duplicate_webhook",
      providerEventId: "evt_sandbox",
    });
  });

  it("forwards the WorkOS rotation marker to Webhook Ingress with the query intact", async () => {
    const webhookFetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });
    const marker = "0123456789abcdef0123456789abcdef";

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/webhooks/workos?omh_rotation=${marker}`, {
        method: "POST",
        body: "{}",
      }),
      { ...bindings(), WORKOS_WEBHOOK_INGRESS: { fetch: webhookFetch } },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(202);
    expect(webhookFetch).toHaveBeenCalledOnce();
    const forwarded = webhookFetch.mock.calls[0]?.[0] as Request;
    expect(new URL(forwarded.url).search).toBe(`?omh_rotation=${marker}`);
  });

  it.each([
    ["short marker", "/webhooks/workos?omh_rotation=0123", "POST"],
    [
      "extra parameter",
      "/webhooks/workos?omh_rotation=0123456789abcdef0123456789abcdef&retry=1",
      "POST",
    ],
    [
      "duplicated marker",
      "/webhooks/workos?omh_rotation=0123456789abcdef0123456789abcdef&omh_rotation=0123456789abcdef0123456789abcdef",
      "POST",
    ],
    ["marker on GitHub", "/webhooks/github?omh_rotation=0123456789abcdef0123456789abcdef", "POST"],
  ])("does not forward a %s", async (_name, path, method) => {
    const webhookFetch = vi.fn();
    const githubFetch = vi.fn();
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}${path}`, { method }),
      {
        ...bindings(),
        WORKOS_WEBHOOK_INGRESS: { fetch: webhookFetch },
        GITHUB_WEBHOOK_INGRESS: { fetch: githubFetch },
      },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(404);
    expect(webhookFetch).not.toHaveBeenCalled();
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong method", `${CONTROL_API_POC_ORIGIN}/webhooks/workos`, "GET"],
    ["query string", `${CONTROL_API_POC_ORIGIN}/webhooks/workos?retry=1`, "POST"],
    ["wrong path", `${CONTROL_API_POC_ORIGIN}/webhooks/workos/`, "POST"],
    ["unreviewed origin", "https://preview.example/webhooks/workos", "POST"],
  ])("does not forward a WorkOS webhook with %s", async (_name, url, method) => {
    const webhookFetch = vi.fn();
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(url, { method }),
      { ...bindings(), WORKOS_WEBHOOK_INGRESS: { fetch: webhookFetch } },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(webhookFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["malformed", { fetch: "not-a-function" }],
  ])("fails closed when the private webhook binding is %s", async (_name, binding) => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/webhooks/workos`, {
        method: "POST",
        body: "{}",
      }),
      { ...bindings(), WORKOS_WEBHOOK_INGRESS: binding } as Partial<ControlApiWorkerBindings>,
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      type: "https://docs.ohmyho.st/errors/service-unavailable",
      title: "Service unavailable",
      status: 503,
      code: "service_unavailable",
      detail:
        "The Control API is temporarily unavailable. Retry later; contact the operator if the problem persists.",
      request_id: expect.stringMatching(/^req_/u),
      retryable: true,
      suggested_action: expect.any(String),
    });
  });

  it("redacts private webhook binding failures", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/webhooks/workos`, {
        method: "POST",
        body: "{}",
      }),
      {
        ...bindings(),
        WORKOS_WEBHOOK_INGRESS: {
          fetch: vi.fn().mockRejectedValue(new Error("secret ingress credential")),
        },
      },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("secret");
  });

  it("declares only the reviewed public origin and exact private service inventory", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const productionSource = await readFile(
      resolve(packageRoot, "wrangler.production.jsonc"),
      "utf8",
    );
    const production = JSON.parse(
      productionSource.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"),
    );
    expect(production).toMatchObject({
      name: "ohmyho-control-api-production",
      workers_dev: false,
      preview_urls: false,
      triggers: { crons: ["* * * * *"] },
      vars: { CONTROL_API_PUBLIC_ORIGIN: "https://app.ohmyho.st" },
    });
    expect(
      (production.services as { binding: string }[]).filter(({ binding }) =>
        binding.startsWith("NATIVE_AUTH_"),
      ),
    ).toEqual([
      {
        binding: "NATIVE_AUTH_PROVIDER_RUNTIME",
        service: "ohmyho-control-store-production",
        entrypoint: "NativeAuthRuntime",
      },
      {
        binding: "NATIVE_AUTH_ADMIN_US",
        service: "ohmyho-native-auth-production-us",
        entrypoint: "NativeAdminService",
      },
      {
        binding: "NATIVE_AUTH_ADMIN_EU",
        service: "ohmyho-native-auth-production-eu",
        entrypoint: "NativeAdminService",
      },
    ]);
    // The Core is the only Control authority: no Hyperdrive, one private Core Worker.
    expect(production.hyperdrive).toBeUndefined();
    expect(coreBindings(production.services, "ohmyho-control-store-production")).toEqual(
      CORE_BINDINGS,
    );
    expect(production.services).toContainEqual({
      binding: "PREVIEW_API_RUNTIME",
      service: "ohmyho-control-store-production",
      entrypoint: "ProductApiPreviewRuntime",
    });
    expect(production.services).toContainEqual({
      binding: "PREVIEW_EXECUTION",
      service: "ohmyho-live-preview-production",
      entrypoint: "PreviewExecution",
    });
    expect(production.services).toContainEqual({
      binding: "RECOVERY_SERVICE",
      service: "ohmyho-recovery-container-production",
      entrypoint: "RecoveryContainerService",
    });
    expect(production.services).toContainEqual({
      binding: "CREDIT_SERVICE",
      service: "ohmyho-credit-service-production",
      entrypoint: "CreditServiceRuntime",
    });
    const source = await readFile(resolve(packageRoot, "wrangler.jsonc"), "utf8");
    const configuration = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1")) as {
      workers_dev?: unknown;
      preview_urls?: unknown;
      vars?: Record<string, unknown>;
      services?: unknown;
    };

    expect(configuration).toMatchObject({
      name: "ohmyho-control-api-poc-private-fullstack",
      workers_dev: false,
      vars: {
        CONTROL_API_PUBLIC_ORIGIN: "https://dev.app.ohmyho.st",
        ENVIRONMENT_SECRET_KEY_VERSION: "20261106",
      },
      routes: [{ pattern: "dev.app.ohmyho.st", custom_domain: true }],
      tail_consumers: [{ service: "ohmyho-diagnostic-tail-poc-private-fullstack" }],
    });
    expect(configuration.preview_urls).toBe(false);
    expect(Reflect.get(configuration, "hyperdrive")).toBeUndefined();
    expect(
      coreBindings(configuration.services, "ohmyho-control-store-poc-private-fullstack"),
    ).toEqual(CORE_BINDINGS);
    expect(configuration.services).toContainEqual({
      binding: "PREVIEW_API_RUNTIME",
      service: "ohmyho-control-store-poc-private-fullstack",
      entrypoint: "ProductApiPreviewRuntime",
    });
    expect(configuration.services).toContainEqual({
      binding: "NATIVE_AUTH_PROVIDER_RUNTIME",
      service: "ohmyho-control-store-poc-private-fullstack",
      entrypoint: "NativeAuthRuntime",
    });
    expect(configuration.vars).toEqual({
      BROWSER_LOGIN_ENABLED: "true",
      CONTROL_API_PUBLIC_ORIGIN: "https://dev.app.ohmyho.st",
      ENVIRONMENT_SECRET_KEY_VERSION: "20261106",
      WORKOS_AUDIENCE: "control-api",
      WORKOS_CLIENT_ID: "client_00000000000000000000000017",
      WORKOS_ISSUER: "https://api.workos.com/user_management/client_00000000000000000000000017",
      WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client_00000000000000000000000017",
      WORKOS_CONNECT_ISSUER: "https://orderly-laugh-73-staging.authkit.app",
      WORKOS_CONNECT_JWKS_URL: "https://orderly-laugh-73-staging.authkit.app/oauth2/jwks",
      MANAGED_ARTIFACTS_NAMESPACE_US: "ohmyhost-development-us",
      MANAGED_ARTIFACTS_NAMESPACE_EU: "ohmyhost-development-eu",
    });
    expect(
      (configuration.services as { service: string }[]).filter(
        ({ service }) => service !== "ohmyho-control-store-poc-private-fullstack",
      ),
    ).toEqual([
      {
        binding: "CONNECTION_BROKER",
        service: "ohmyho-connection-broker-development",
        entrypoint: "ConnectionBrokerManagementService",
      },
      {
        binding: "PREVIEW_EXECUTION",
        service: "ohmyho-live-preview-poc-private-fullstack",
        entrypoint: "PreviewExecution",
      },
      {
        binding: "GROWTH_ANALYTICS",
        service: "ohmyho-growth-analytics-poc-private-fullstack",
        entrypoint: "GrowthCollectRuntime",
      },
      {
        binding: "NATIVE_AUTH_ADMIN_US",
        service: "ohmyho-native-auth-development-us",
        entrypoint: "NativeAdminService",
      },
      {
        binding: "NATIVE_AUTH_ADMIN_EU",
        service: "ohmyho-native-auth-development-eu",
        entrypoint: "NativeAdminService",
      },
      {
        binding: "MAIL_DELIVERY",
        service: "ohmyho-mail-gateway-poc-private-fullstack",
        entrypoint: "ResendMailDeliveryService",
      },
      {
        binding: "OPERATION_PUBLISHER",
        entrypoint: "OperationPublisherService",
        service: "ohmyho-project-provisioning-publisher-poc-private-fullstack",
      },
      {
        binding: "MAIL_DOMAIN_OBSERVER",
        service: "ohmyho-ses-management-poc-private-fullstack",
        entrypoint: "ResendMailManagementService",
      },
      {
        binding: "RECOVERY_SERVICE",
        service: "ohmyho-recovery-container-poc-private-fullstack",
        entrypoint: "RecoveryContainerService",
      },
      { binding: "BILLING", service: "ohmyho-billing-poc-private-fullstack" },
      { binding: "AUTH_STATUS", service: "ohmyhost-workos-management-poc-private-fullstack" },
      { binding: "WORKOS_WEBHOOK_INGRESS", service: "ohmyho-workos-webhook-poc-private-fullstack" },
      { binding: "GITHUB_WEBHOOK_INGRESS", service: "ohmyho-workos-webhook-poc-private-fullstack" },
      {
        binding: "SOURCE_INSPECTOR",
        service: "ohmyho-source-fetcher-poc-private-fullstack",
        entrypoint: "SourceFetcherService",
      },
      {
        binding: "PROVIDER_RECONCILIATION",
        service: "ohmyho-deployment-workflow-poc-private-fullstack",
        entrypoint: "ProductProviderReconciliationService",
      },
      {
        binding: "NEON_MANAGEMENT",
        service: "ohmyho-neon-management-poc-private-fullstack",
        entrypoint: "NeonManagementService",
      },
      {
        binding: "CLOUDFLARE_DOMAIN_MANAGEMENT",
        service: "ohmyho-cloudflare-domain-management-poc-private-fullstack",
        entrypoint: "CloudflareDomainManagementService",
      },
      {
        binding: "CREDIT_SERVICE",
        service: "ohmyho-credit-service-poc-private-fullstack",
        entrypoint: "CreditServiceRuntime",
      },
    ]);
  });

  it("keeps Workers Logs invocation logs off in the full and observer Control API profiles", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of [
      "wrangler.production.jsonc",
      "wrangler.jsonc",
      "wrangler.observer.production.jsonc",
      "wrangler.observer.development.jsonc",
    ]) {
      const source = await readFile(resolve(packageRoot, file), "utf8");
      const configuration = JSON.parse(
        source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"),
      ) as { observability?: { logs?: { invocation_logs?: unknown; persist?: unknown } } };
      expect(configuration.observability?.logs?.invocation_logs, file).toBe(false);
      expect(configuration.observability?.logs?.persist, file).toBe(true);
    }
  });

  it("pins the owned development origin and routes through the real Hono API", async () => {
    const waitUntil = vi.fn();
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/v1/projects`, { method: "POST" }),
      bindings(),
      { waitUntil },
    );

    expect(CONTROL_API_POC_ORIGIN).toBe("https://dev.app.ohmyho.st");
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("accepts only the exact namespace-bound POC origin", async () => {
    expect(CONTROL_API_POC_ORIGIN).toBe("https://dev.app.ohmyho.st");
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });
    const pocBindings = { ...bindings(), CONTROL_API_PUBLIC_ORIGIN: CONTROL_API_POC_ORIGIN };
    const landing = await worker.fetch(new Request(`${CONTROL_API_POC_ORIGIN}/`), pocBindings, {
      waitUntil: vi.fn(),
    });
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Your workspace");
    const logo = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/favicon.svg`),
      pocBindings,
      { waitUntil: vi.fn() },
    );
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(await logo.text()).toContain("<svg");

    await expect(
      worker.fetch(new Request(`${CONTROL_API_POC_ORIGIN}/v1/projects`), pocBindings, {
        waitUntil: vi.fn(),
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      worker.fetch(
        new Request("https://ohmyho-control-api-sandbox.your-omh-account.workers.dev/v1/projects"),
        pocBindings,
        {
          waitUntil: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ status: 404 });
    for (const origin of [
      "https://app.ohmyho.st",
      "https://ohmyho-control-api-poc-private-fullstack.your-omh-account.workers.dev",
    ]) {
      await expect(
        worker.fetch(new Request(`${origin}/v1/projects`), pocBindings, {
          waitUntil: vi.fn(),
        }),
      ).resolves.toMatchObject({ status: 404 });
    }
    for (const origin of [
      "https://attacker.example",
      "https://ohmyho-control-api-sandbox.your-omh-account.workers.dev",
      "https://ohmyho-control-api-poc-private-fullstack.your-omh-account.workers.dev",
    ])
      await expect(
        worker.fetch(
          new Request(`${CONTROL_API_POC_ORIGIN}/v1/projects`),
          { ...pocBindings, CONTROL_API_PUBLIC_ORIGIN: origin },
          { waitUntil: vi.fn() },
        ),
      ).resolves.toMatchObject({ status: 503 });
  });

  it("does not grant browser CORS authority to the retired shared dispatcher", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/v1/projects`, {
        headers: { origin: "https://ohmyho-sandbox.your-omh-account.workers.dev" },
      }),
      bindings(),
      { waitUntil: vi.fn() },
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves the configured production origin with its own rate-limit namespace", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });
    const production = { ...bindings(), CONTROL_API_PUBLIC_ORIGIN: "https://app.ohmyho.st" };
    const context = { waitUntil: vi.fn() };
    const landing = await worker.fetch(new Request("https://app.ohmyho.st/"), production, context);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Ready when you are.");
    const onboarding = await worker.fetch(
      new Request("https://app.ohmyho.st/v1/organizations", { method: "POST" }),
      production,
      context,
    );
    expect(onboarding.status).toBe(401);
    expect(production.AUTH_STATUS.fetch).not.toHaveBeenCalled();
    const denied = await worker.fetch(
      new Request("https://app.ohmyho.st/v1/projects"),
      production,
      context,
    );
    expect(denied.status).toBe(401);
    expect(production.CONTROL_API_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: "application:control-api-production:ip:unknown",
    });
    const wrongOrigin = await worker.fetch(
      new Request("https://dev.app.ohmyho.st/v1/projects"),
      production,
      context,
    );
    expect(wrongOrigin.status).toBe(404);
  });

  it.each([
    [
      "export key without its private service",
      { RECOVERY_INPUT_KEY_BASE64: Buffer.alloc(32, 1).toString("base64") },
    ],
    ["missing Core runtime", { CONTROL_RUNTIME: undefined }],
    ["missing private auth-status binding", { AUTH_STATUS: undefined }],
    ["plain HTTP JWKS", { WORKOS_JWKS_URL: "http://sandbox.authkit.app/jwks" }],
    [
      "plain HTTP issuer",
      { WORKOS_ISSUER: "http://api.workos.com/user_management/client_sandbox" },
    ],
    ["missing rate limiter", { CONTROL_API_RATE_LIMITER: undefined }],
    ["missing canonical public origin", { CONTROL_API_PUBLIC_ORIGIN: undefined }],
  ])("fails closed for %s", async (_name, override) => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/v1/projects`),
      { ...bindings(), ...override } as ControlApiWorkerBindings,
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      type: "https://docs.ohmyho.st/errors/service-unavailable",
      title: "Service unavailable",
      status: 503,
      code: "service_unavailable",
      detail:
        "The Control API is temporarily unavailable. Retry later; contact the operator if the problem persists.",
      request_id: expect.stringMatching(/^req_/u),
      retryable: true,
      suggested_action: expect.any(String),
    });
  });

  it("does not serve the API on preview or unreviewed hosts", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request("https://preview.example/v1/projects", { method: "POST" }),
      bindings(),
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(404);
  });

  it("returns a redacted 503 when runtime composition is unavailable", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(
        `${CONTROL_API_POC_ORIGIN}/v1/projects/00000000000000000000000002/environments/00000000000000000000000003/secrets`,
      ),
      { ...bindings(), ENVIRONMENT_SECRET_KEY_BASE64: "secret://not-a-key@database.invalid" },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(503);
    expect(await response.clone().text()).not.toContain("secret");
    expect(await response.json()).toMatchObject({
      code: "service_unavailable",
      status: 503,
      retryable: true,
      request_id: expect.stringMatching(/^req_/u),
      suggested_action: expect.any(String),
    });
  });

  it("answers a database event route with a redacted 503 while the management binding lacks databaseEvents", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });
    const incomplete = bindings();
    const management = { ...incomplete.NEON_MANAGEMENT };
    delete (management as { databaseEvents?: unknown }).databaseEvents;

    const response = await worker.fetch(
      new Request(
        `${CONTROL_API_POC_ORIGIN}/v1/projects/00000000000000000000000002/database/webhooks?environment=dev`,
      ),
      { ...incomplete, NEON_MANAGEMENT: management },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "service_unavailable", retryable: true });
  });

  it("answers a database watch route with the same redacted 503 while the management binding lacks databaseEvents", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });
    const incomplete = bindings();
    const management = { ...incomplete.NEON_MANAGEMENT };
    delete (management as { databaseEvents?: unknown }).databaseEvents;

    const response = await worker.fetch(
      new Request(
        `${CONTROL_API_POC_ORIGIN}/v1/projects/00000000000000000000000002/database/watches?environment=dev`,
      ),
      { ...incomplete, NEON_MANAGEMENT: management },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "service_unavailable", retryable: true });
  });

  it("answers a database event route with a redacted 503 while CONTROL_RUNTIME lacks readProjectDatabaseAdmission", async () => {
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });
    const incomplete = bindings();
    const runtime = new Proxy(incomplete.CONTROL_RUNTIME as object, {
      get: (target, method) =>
        method === "readProjectDatabaseAdmission" ? undefined : Reflect.get(target, method),
    }) as unknown as typeof incomplete.CONTROL_RUNTIME;

    const response = await worker.fetch(
      new Request(
        `${CONTROL_API_POC_ORIGIN}/v1/projects/00000000000000000000000002/database/webhooks?environment=dev`,
      ),
      { ...incomplete, CONTROL_RUNTIME: runtime },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "service_unavailable", retryable: true });
  });

  it("reports admission failures without logging secrets", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });

    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/v1/projects`, { method: "POST" }),
      {
        ...bindings(),
        CONTROL_API_RATE_LIMITER: {
          limit: vi.fn().mockRejectedValue(new Error("secret database detail")),
        },
      },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(503);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).not.toContain("secret");
    error.mockRestore();
  });

  it("adapts Cloudflare rate-limit decisions and namespaces every dimension", async () => {
    const { createCloudflareRateLimitPort } = await import("../src/worker-main.js");
    const limit = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });
    const port = createCloudflareRateLimitPort({ limit });

    await expect(
      port.consume({ dimension: "application", key: "control-api-sandbox" }),
    ).resolves.toEqual({ allowed: true });
    await expect(port.consume({ dimension: "credential", key: "credential-1" })).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    await expect(
      port.consume({ dimension: "application", key: "control-api-sandbox:ip:203.0.113.7" }),
    ).resolves.toEqual({ allowed: true });
    expect(limit).toHaveBeenNthCalledWith(1, { key: "application:control-api-sandbox" });
    expect(limit).toHaveBeenNthCalledWith(2, { key: "credential:credential-1" });
    expect(limit).toHaveBeenNthCalledWith(3, {
      key: "application:control-api-sandbox:ip:203.0.113.7",
    });
  });

  it("loads WorkOS signing keys only through bounded HTTPS JSON requests", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ keys: [workosTestRsaKey("sandbox")] }));
    const source = createRemoteWorkosJwksSource("https://sandbox.authkit.app/oauth2/jwks", fetcher);

    await expect(source.load()).resolves.toEqual({ keys: [workosTestRsaKey("sandbox")] });
    const request = fetcher.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://sandbox.authkit.app/oauth2/jwks");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.signal.aborted).toBe(false);

    const unavailable = createRemoteWorkosJwksSource(
      "https://sandbox.authkit.app/oauth2/jwks",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(unavailable.load()).rejects.toThrow("WorkOS JWKS is unavailable");
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '{"level":"error","service":"control-api","code":"WORKOS_JWKS_HTTP_UNAVAILABLE"}',
    );
    error.mockRestore();

    const oversizedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const oversized = createRemoteWorkosJwksSource(
      "https://sandbox.authkit.app/oauth2/jwks",
      vi
        .fn()
        .mockResolvedValue(
          new Response("{}", { headers: { "content-length": String(64 * 1024 + 1) } }),
        ),
    );
    await expect(oversized.load()).rejects.toThrow("WorkOS JWKS is too large");
    expect(oversizedError).toHaveBeenCalledExactlyOnceWith(
      '{"level":"error","service":"control-api","code":"WORKOS_JWKS_BODY_INVALID"}',
    );
    oversizedError.mockRestore();
  });

  it("aborts a WorkOS JWKS request after five seconds", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const source = createRemoteWorkosJwksSource(
        "https://sandbox.authkit.app/oauth2/jwks",
        vi.fn(
          (request: Request) =>
            new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        ),
      );
      const load = expect(source.load()).rejects.toThrow("aborted");

      await vi.advanceTimersByTimeAsync(5_000);

      await load;
      expect(error).toHaveBeenCalledExactlyOnceWith(
        '{"level":"error","service":"control-api","code":"WORKOS_JWKS_FETCH_UNAVAILABLE"}',
      );
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it("composes global fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetcher);
    const request = new Request("https://example.test");
    await expect(fetchGlobally(request)).resolves.toHaveProperty("status", 200);
    expect(fetcher).toHaveBeenCalledWith(request);
    vi.unstubAllGlobals();
  });
});

it("serves the explicitly enabled browser login before database composition and rate-limits its authorization start", async () => {
  const worker = createControlApiWorkerEntrypoint({
    async fetcher(request) {
      expect(request.url).toBe("https://api.workos.com/user_management/authenticate");
      return Response.json({ access_token: "test-access-token" });
    },
  });
  const enabled = {
    ...bindings(),
    BROWSER_LOGIN_ENABLED: "true" as const,
    PORTAL_SESSION_PASSWORD: "test-only-portal-password-32-characters",
  };
  const context = {
    waitUntil(work: Promise<unknown>) {
      void work.catch(() => undefined);
    },
  };
  const login = await worker.fetch(
    new Request(`${CONTROL_API_POC_ORIGIN}/login`),
    enabled,
    context,
  );
  expect(login.status).toBe(200);
  expect(await login.text()).toContain("Development · Welcome to ohmyho.st");
  const start = await worker.fetch(
    new Request(`${CONTROL_API_POC_ORIGIN}/login/start`, {
      method: "POST",
      headers: { origin: CONTROL_API_POC_ORIGIN },
    }),
    enabled,
    context,
  );
  expect(start.status).toBe(303);
  expect(
    new URL(start.headers.get("location") ?? "https://missing.invalid").searchParams.get(
      "redirect_uri",
    ),
  ).toBe(`${CONTROL_API_POC_ORIGIN}/login/callback`);
  const authorize = new URL(start.headers.get("location") ?? "https://missing.invalid");
  const cookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
  const callback = await worker.fetch(
    new Request(
      `${CONTROL_API_POC_ORIGIN}/login/callback?code=test&state=${authorize.searchParams.get("state")}`,
      { headers: { cookie } },
    ),
    enabled,
    context,
  );
  expect(callback.status).toBe(503);
  expect(await callback.text()).not.toContain("You are signed in");
  const authenticatedProvider = createControlApiWorkerEntrypoint({
    async fetcher() {
      return Response.json({
        access_token: "invalid-access-token",
        refresh_token: "refresh-secret",
      });
    },
  });
  const secondStart = await authenticatedProvider.fetch(
    new Request(`${CONTROL_API_POC_ORIGIN}/login/start`, {
      method: "POST",
      headers: { origin: CONTROL_API_POC_ORIGIN },
    }),
    enabled,
    context,
  );
  const secondLocation = new URL(secondStart.headers.get("location") ?? "https://missing.invalid");
  const rejectedCallback = await authenticatedProvider.fetch(
    new Request(
      `${CONTROL_API_POC_ORIGIN}/login/callback?code=test&state=${secondLocation.searchParams.get("state")}`,
      { headers: { cookie: secondStart.headers.get("set-cookie")?.split(";")[0] ?? "" } },
    ),
    enabled,
    context,
  );
  expect(rejectedCallback.status).toBe(503);
  expect(rejectedCallback.headers.get("set-cookie") ?? "").not.toContain("refresh-secret");
  const denied = {
    ...enabled,
    CONTROL_API_RATE_LIMITER: {
      async limit() {
        return { success: false };
      },
    },
  };
  expect(
    (
      await worker.fetch(
        new Request(`${CONTROL_API_POC_ORIGIN}/login/start`, {
          method: "POST",
          headers: { origin: CONTROL_API_POC_ORIGIN },
        }),
        denied,
        context,
      )
    ).status,
  ).toBe(429);
  const api = createControlApiWorkerEntrypoint({
    async fetcher() {
      throw new Error("Unexpected provider request before authentication");
    },
  });
  const keyRequest = () =>
    new Request(
      `${CONTROL_API_POC_ORIGIN}/v1/organizations/00000000000000000000000001/user-api-keys`,
    );
  expect((await api.fetch(keyRequest(), bindings(), context)).status).toBe(401);
});

it("limits anonymous roadmap reads and writes before Core access", async () => {
  let coreCalls = 0;
  const worker = createControlApiWorkerEntrypoint({
    async fetcher() {
      throw new Error("Unexpected roadmap provider fetch");
    },
  });
  const limited = {
    ...bindings(),
    CONTROL_RUNTIME: coreRuntime(() => {
      coreCalls += 1;
    }),
    PUBLIC_ENTRY_RATE_LIMITER: {
      async limit() {
        return { success: false };
      },
    },
  };
  const context = {
    waitUntil() {
      throw new Error("Unexpected roadmap background job");
    },
  };
  for (const method of ["GET", "POST"]) {
    const response = await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/v1/site/feature-interests`, { method }),
      limited,
      context,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect((await response.json()).code).toBe("rate_limited");
  }
  const missing = await worker.fetch(
    new Request(`${CONTROL_API_POC_ORIGIN}/v1/site/feature-interests`),
    bindings(),
    context,
  );
  expect(missing.status).toBe(503);
  expect(coreCalls).toBe(0);
});

describe("the D1 request path reports why it answered 503", () => {
  const runtimeMethods = [
    "admitCustomerProject",
    "readTakenProjectHandles",
    "listCustomerProjects",
    "getCustomerProject",
    "resolveWorkosOrganization",
    "resolveM2mOrganization",
    "authorizeOrganizationAction",
  ];
  const d1Bindings = (accountMetadata: unknown) => ({
    CONTROL_API_PUBLIC_ORIGIN: CONTROL_API_POC_ORIGIN,
    CONTROL_RUNTIME: Object.fromEntries(runtimeMethods.map((method) => [method, vi.fn()])),
    ACCOUNT_METADATA_RUNTIME: accountMetadata,
    AUTH_STATUS: { fetch: vi.fn() },
    CONTROL_API_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    OPERATION_PUBLISHER: { wake: async () => undefined },
    WORKOS_JWKS_URL: "https://sandbox.authkit.app/oauth2/jwks",
    WORKOS_ISSUER: "https://api.workos.com/user_management/client_sandbox",
    WORKOS_CLIENT_ID: "client_sandbox",
    WORKOS_AUDIENCE: "control-api",
  });
  const worker = (report: (input: unknown) => void | Promise<void>) =>
    createControlApiWorkerEntrypoint({ fetcher: vi.fn(), reporter: { report } });
  const request = () => new Request(`${CONTROL_API_POC_ORIGIN}/v1/me`);

  it("names the missing binding, as a token and never as a message", async () => {
    const report = vi.fn();
    const response = await worker(report).fetch(
      request(),
      d1Bindings({}) as unknown as ControlApiWorkerBindings,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(503);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^req_/u),
      code: "D1_REQUEST_FAILED:Error:account_metadata_core_binding_required",
      route: "d1-request",
    });
  });

  it("reports only the class of an error whose message is prose, and survives a failing reporter", async () => {
    const calls: unknown[] = [];
    const secretive = {
      readCurrentIdentityMappings: async () => {
        throw new TypeError("secret sk_live_hidden credential rejected");
      },
      readAccountProfileFacts: vi.fn(),
      recordAccountSignupSource: vi.fn(),
    };
    const response = await worker((input) => void calls.push(input)).fetch(
      request(),
      d1Bindings(secretive) as unknown as ControlApiWorkerBindings,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(503);
    expect(calls).toEqual([
      {
        requestId: expect.stringMatching(/^req_/u),
        code: "D1_REQUEST_FAILED:TypeError",
        route: "d1-request",
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("sk_live");
    for (const failing of [
      () => {
        throw new Error("reporter down");
      },
      () => Promise.reject(new Error("reporter down")),
    ])
      expect(
        (
          await worker(failing).fetch(
            request(),
            d1Bindings({}) as unknown as ControlApiWorkerBindings,
            { waitUntil: vi.fn() },
          )
        ).status,
      ).toBe(503);
  });

  it("uses the own code of an error when it is a token and the class name for anything else", () => {
    const seen: string[] = [];
    const reporter = { report: (input: { code: string }) => void seen.push(input.code) };
    reportComposeFailure(
      reporter,
      Object.assign(new Error("Visible prose."), { code: "store_busy" }),
    );
    reportComposeFailure(
      reporter,
      Object.assign(new Error("Visible prose."), { code: "SQLITE ERROR 5" }),
    );
    reportComposeFailure(reporter, "a thrown string with sk_live_hidden");
    reportComposeFailure(reporter, Object.assign(new Error("x"), { name: "Bad Name!" }));
    expect(seen).toEqual([
      "D1_REQUEST_FAILED:Error:store_busy",
      "D1_REQUEST_FAILED:Error",
      "D1_REQUEST_FAILED:NonError",
      "D1_REQUEST_FAILED:Error",
    ]);
  });
});

/**
 * Counts the Connect discovery documents; `up` false makes every provider answer 503. The cache is module state, so
 * each test below uses an issuer of its own.
 */
const connectDiscoveryProvider = (state: { up: boolean; calls: string[] }) =>
  vi.fn(async (request: Request) => {
    state.calls.push(request.url);
    if (!state.up) return new Response("unavailable", { status: 503 });
    const issuer = new URL(request.url).origin;
    return request.url.endsWith("/.well-known/oauth-authorization-server")
      ? Response.json({ issuer })
      : Response.json({ issuer, jwks_uri: `${issuer}/oauth2/jwks` });
  });

/** Remote composition needs one account read; every other account method is unreachable here. */
const remoteConnectBindings = (issuer: string) => ({
  ...bindings(),
  CONTROL_RUNTIME: coreRuntime(),
  ACCOUNT_METADATA_RUNTIME: {
    readCurrentIdentityMappings: async () => [],
    readAccountProfileFacts: async () => {
      throw new Error("The account profile must not be read");
    },
    recordAccountSignupSource: async () => {
      throw new Error("The signup source must not be recorded");
    },
  },
  WORKOS_CONNECT_ISSUER: issuer,
});

it("reuses one Connect discovery fill for concurrent and repeated remote MCP requests", async () => {
  const state = { up: true, calls: [] as string[] };
  const clock = { now: 1_000_000 };
  const worker = createControlApiWorkerEntrypoint({
    fetcher: connectDiscoveryProvider(state),
    now: () => clock.now,
    reporter: { report: vi.fn() },
  });
  const env = remoteConnectBindings("https://discovery-fill.authkit.app");
  const context = { waitUntil() {} };
  const responses = await Promise.all(
    Array.from({ length: 50 }, () =>
      worker.fetch(
        new Request(`${CONTROL_API_POC_ORIGIN}/.well-known/oauth-protected-resource/mcp`),
        env,
        context,
      ),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual(Array(50).fill(200));
  expect(state.calls).toHaveLength(2);
});

it("serves the last good Connect discovery for up to an hour while a refresh fails", async () => {
  const state = { up: true, calls: [] as string[] };
  const clock = { now: 2_000_000 };
  const worker = createControlApiWorkerEntrypoint({
    fetcher: connectDiscoveryProvider(state),
    now: () => clock.now,
    reporter: { report: vi.fn() },
  });
  const env = remoteConnectBindings("https://discovery-stale.authkit.app");
  const context = { waitUntil() {} };
  const metadata = () =>
    worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/.well-known/oauth-protected-resource/mcp`),
      env,
      context,
    );
  expect((await metadata()).status).toBe(200);
  expect(state.calls).toHaveLength(2);
  clock.now += 11 * 60_000;
  state.up = false;
  expect((await metadata()).status).toBe(200);
  expect(state.calls).toHaveLength(3);
  clock.now += 5_000;
  expect((await metadata()).status).toBe(200);
  expect(state.calls).toHaveLength(3);
});

const workosTestRsaKey = (kid: string) => ({
  alg: "RS256",
  kty: "RSA",
  use: "sig",
  e: "AQAB",
  kid,
  n: "vjKdORfJ7v_ZMjNZWzWHKB5GAEN8huADjBRRJT30Pj4Y6C9ZeZ2k_Fd77VjlMtIv9o5ja8O0ZLYLnxoLUcwhCdzS3Om-mUziu2LqbESpQ_-1ZjlWG1PVggx8EaOotqsjcljEXPs2ndGbSvirCy4i3reF67hLBvAg8nu7llZ5FIsC73wc5SfHb0XdEuz9rXt06uiZSKN6ALSv-6xLA-sJS33kOrQ0yFirCnKcvssZgw2K_FiYBu_87Z-kSDB0gTRuZLzuyRSEcWGZBFVmE7ALd1MKt85nrPvsQ5Atide6Nk5vzsFLgtV5ShlQjAdf8q-r3Z1kMCOTMEkN-rvSg6pbsw",
});

it("refetches WorkOS JWKS for a rotated kid only after the cooldown and keeps the last good keys on a garbage 200", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const url = "https://sandbox.authkit.app/oauth2/jwks-rotation";
    let body: unknown = { keys: [workosTestRsaKey("old")] };
    const fetcher = vi.fn(async () => Response.json(body));
    const source = () => createRemoteWorkosJwksSource(url, fetcher);
    await expect(source().load()).resolves.toEqual({ keys: [workosTestRsaKey("old")] });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // WorkOS rotates its signing keys; a token with the new kid arrives inside the cooldown.
    body = { keys: [workosTestRsaKey("old"), workosTestRsaKey("new")] };
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(source().load({ kid: "new" })).resolves.toEqual({
      keys: [workosTestRsaKey("old")],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // After the cooldown the unknown kid refetches once and the rotated set is served.
    await vi.advanceTimersByTimeAsync(21_000);
    await expect(source().load({ kid: "new" })).resolves.toEqual({
      keys: [workosTestRsaKey("old"), workosTestRsaKey("new")],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Random kids cannot force a fetch per request: at most one per cooldown.
    for (let attempt = 0; attempt < 50; attempt++)
      await source().load({ kid: `random-${attempt}` });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31_000);
    await source().load({ kid: "random-a" });
    await source().load({ kid: "random-b" });
    expect(fetcher).toHaveBeenCalledTimes(3);

    // A 200 with no signing keys never replaces the last good set, even on a refetch.
    body = { keys: [] };
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(source().load({ kid: "garbage" })).resolves.toEqual({
      keys: [workosTestRsaKey("old"), workosTestRsaKey("new")],
    });
    body = { keys: [{ kid: "not-a-key" }] };
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await expect(source().load()).resolves.toEqual({
      keys: [workosTestRsaKey("old"), workosTestRsaKey("new")],
    });
  } finally {
    error.mockRestore();
    vi.useRealTimers();
  }
});

it("reuses one WorkOS JWKS fill per isolate and serves the last good keys while a refresh fails", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const url = "https://sandbox.authkit.app/oauth2/jwks-cache";
    const state = { up: true };
    const fetcher = vi.fn(async () =>
      state.up
        ? Response.json({ keys: [workosTestRsaKey("cached")] })
        : new Response(null, { status: 503 }),
    );
    for (let request = 0; request < 50; request++) {
      await expect(createRemoteWorkosJwksSource(url, fetcher).load()).resolves.toEqual({
        keys: [workosTestRsaKey("cached")],
      });
    }
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    state.up = false;
    await expect(createRemoteWorkosJwksSource(url, fetcher).load()).resolves.toEqual({
      keys: [workosTestRsaKey("cached")],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    error.mockRestore();
    vi.useRealTimers();
  }
});

it("charges one site-entry bucket to every address inside one IPv6 /64", async () => {
  const keys: string[] = [];
  const worker = createControlApiWorkerEntrypoint({
    fetcher: vi.fn(),
    reporter: { report: vi.fn() },
  });
  const env = {
    ...bindings(),
    PUBLIC_ENTRY_RATE_LIMITER: {
      limit: vi.fn(async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      }),
    },
  };
  for (const ip of ["2001:db8::1", "2001:db8:0:0:ffff:ffff:ffff:ffff"]) {
    await worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/v1/site/contact`, {
        headers: { "cf-connecting-ip": ip },
      }),
      env,
      { waitUntil() {} },
    );
  }
  expect(keys).toEqual(["site-entry:2001:db8:0:0::/64", "site-entry:2001:db8:0:0::/64"]);
});

it("does not run Connect discovery or account reads for a remote MCP request the visitor limit refuses", async () => {
  const state = { up: true, calls: [] as string[] };
  const accountRead = vi.fn(async () => []);
  const worker = createControlApiWorkerEntrypoint({
    fetcher: connectDiscoveryProvider(state),
    now: () => 1_000_000,
    reporter: { report: vi.fn() },
  });
  const env = {
    ...remoteConnectBindings("https://discovery-limited.authkit.app"),
    CONTROL_API_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) },
    ACCOUNT_METADATA_RUNTIME: {
      readCurrentIdentityMappings: accountRead,
      readAccountProfileFacts: async () => {
        throw new Error("The account profile must not be read");
      },
      recordAccountSignupSource: async () => {
        throw new Error("The signup source must not be recorded");
      },
    },
  };
  const response = await worker.fetch(
    new Request(`${CONTROL_API_POC_ORIGIN}/.well-known/oauth-protected-resource/mcp`),
    env,
    { waitUntil() {} },
  );
  expect(response.status).toBe(429);
  expect(state.calls).toEqual([]);
  expect(accountRead).not.toHaveBeenCalled();
});

it("retries a failed Connect discovery after fifteen seconds when no good result exists", async () => {
  const state = { up: false, calls: [] as string[] };
  const clock = { now: 3_000_000 };
  const worker = createControlApiWorkerEntrypoint({
    fetcher: connectDiscoveryProvider(state),
    now: () => clock.now,
    reporter: { report: vi.fn() },
  });
  const env = remoteConnectBindings("https://discovery-retry.authkit.app");
  const context = { waitUntil() {} };
  const metadata = () =>
    worker.fetch(
      new Request(`${CONTROL_API_POC_ORIGIN}/.well-known/oauth-protected-resource/mcp`),
      env,
      context,
    );
  expect((await metadata()).status).toBe(503);
  expect(state.calls).toHaveLength(1);
  clock.now += 14_000;
  expect((await metadata()).status).toBe(503);
  expect(state.calls).toHaveLength(1);
  clock.now += 2_000;
  state.up = true;
  expect((await metadata()).status).toBe(200);
  expect(state.calls).toHaveLength(3);
});

it("exposes the observer before the Broker exists and rechecks its original provider key", async () => {
  const organizationId = "01K00000000000000000000001";
  let keyActive = true,
    coreAvailable = true,
    coreStalled = false;
  const auth = {
    async fetch(request: Request) {
      const headers = { "cache-control": "no-store", "content-type": "application/json" };
      if (new URL(request.url).pathname === "/session-status")
        return Response.json({ active: true }, { headers });
      return Response.json(
        {
          key: keyActive
            ? {
                id: "api_key_owner",
                userId: "user_owner",
                organizationId: "org_owner",
                permissions: ["integrations:manage"],
                expiresAt: "2099-01-01T00:00:00.000Z",
              }
            : null,
        },
        { headers },
      );
    },
  };
  const service = new ConnectionAuthorityService({} as never, {} as never);
  Object.defineProperty(service, "env", {
    value: {
      AUTH_STATUS: auth,
      CONTROL_API_RATE_LIMITER: { limit: async () => ({ success: false }) },
      CONTROL_RUNTIME: {
        async resolveWorkosOrganization() {
          if (coreStalled) return await new Promise<string>(() => {});
          if (!coreAvailable) throw new Error("unavailable");
          return organizationId;
        },
      },
    },
  });
  expect(await service.integrationAuthorityReadiness({})).toEqual({ state: "ready" });
  coreAvailable = false;
  expect(await service.integrationAuthorityReadiness({})).toEqual({ state: "unavailable" });
  coreAvailable = true;
  vi.useFakeTimers();
  try {
    coreStalled = true;
    const stalled = service.integrationAuthorityReadiness({});
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stalled).toEqual({ state: "unavailable" });
    coreStalled = false;
  } finally {
    vi.useRealTimers();
  }
  await expect(
    service.observeIntegrationMutation({
      organizationId,
      principalId: "user:user_owner",
      resourceKind: "organization",
      mutationAuthority: {
        kind: "api_key",
        keyId: "api_key_owner",
        userId: "user_owner",
        workosOrganizationId: "org_owner",
      },
    }),
  ).resolves.toBeUndefined();
  expect(await service.rateLimitConnectionRequest({ clientAddress: "192.0.2.1" })).toBe(false);
  const actor = {
    organizationId,
    projectId: "01K00000000000000000000002",
    environmentId: "01K00000000000000000000003",
    principalId: "user:user_owner",
    sessionId: "session_owner",
    browserSession: {
      sessionId: "session_owner",
      userId: "user_owner",
      organizationId: null,
      tokenExpiresAt: 2000000000,
    },
    originatingCredential: {
      kind: "api_key",
      keyId: "api_key_owner",
      userId: "user_owner",
      workosOrganizationId: "org_owner",
    },
  };
  await expect(service.observeConnectionOrigin(actor)).resolves.toBeUndefined();
  keyActive = false;
  await expect(service.observeConnectionOrigin(actor)).rejects.toThrow("integration_origin_denied");
});

it("rate-limits connection portal visitors before any broker or identity lookup", async () => {
  const worker = createControlApiWorkerEntrypoint({ fetcher: vi.fn() });
  const runtime = coreRuntime();
  const limiter = { limit: vi.fn(async () => ({ success: false })) };
  const response = await worker.fetch(
    new Request(`${CONTROL_API_POC_ORIGIN}/connections/authorize?request=${"a".repeat(43)}`),
    { ...bindings(), CONTROL_RUNTIME: runtime, CONTROL_API_RATE_LIMITER: limiter } as never,
    { waitUntil: vi.fn() },
  );
  expect(response.status).toBe(429);
  expect(limiter.limit).toHaveBeenCalledOnce();

  const allowed = { limit: vi.fn(async () => ({ success: true })) };
  const resume = await worker.fetch(
    new Request(`${CONTROL_API_POC_ORIGIN}/connections/authorize?request=${"a".repeat(43)}`),
    {
      ...bindings(),
      CONTROL_RUNTIME: runtime,
      CONTROL_API_RATE_LIMITER: allowed,
      BROWSER_LOGIN_ENABLED: "true",
      PORTAL_SESSION_PASSWORD: "test-only-portal-password-32-characters",
      CONNECTION_BROKER: {},
      CONNECTION_CONTROL: {},
    } as never,
    { waitUntil: vi.fn() },
  );
  expect(resume.status).toBe(303);
  expect(resume.headers.get("location")).toMatch(/^\/login\?resume=/u);
  expect(resume.headers.get("set-cookie")).toContain("__Host-omh-login-resume=");
});
