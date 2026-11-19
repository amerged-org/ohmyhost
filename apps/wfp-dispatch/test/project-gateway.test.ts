import { WFP_DISPATCH_LIMITS } from "@ohmyhost/contracts/wfp-dispatch";
import {
  digestDevAccessPublicJwk,
  signDevAccessSession,
  type DevAccessPublicJwk,
} from "@ohmyhost/dev-access-tokens";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createProjectIsolatedGatewayWorker,
  projectScriptName,
  type DispatchNamespaceBinding,
} from "../src/index.js";
import gatewayEntrypoint from "../src/gateway-worker-main.js";

const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OTHER_PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ENVIRONMENT_NAME = "prod" as const;
const HANDLE = "calm-river-studio";
const PUBLIC_ORIGIN = `https://${HANDLE}.dev.check.omh.st`;
const DEV_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const DEV_ORIGIN = `https://dev-${HANDLE}.dev.check.omh.st`;
const NOW = "2026-08-25T12:00:00.000Z";
const EXPIRES_AT = "2026-08-26T00:00:00.000Z";
let privateJwk: JsonWebKey;
let publicJwk: DevAccessPublicJwk;
let keyId: `sha256:${string}`;

function exactPublicJwk(value: JsonWebKey): DevAccessPublicJwk {
  if (typeof value.x !== "string" || typeof value.y !== "string") {
    throw new TypeError("Expected an exported P-256 public JWK");
  }
  return { crv: "P-256", kty: "EC", x: value.x, y: value.y };
}

beforeAll(async () => {
  const pair = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
  const exportedPublicJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk = exactPublicJwk(exportedPublicJwk);
  keyId = await digestDevAccessPublicJwk(globalThis.crypto, publicJwk);
});

function gatewayBinding(fetch: (request: Request) => Promise<Response>) {
  const workerFetch = vi.fn(fetch);
  const get = vi.fn(() => ({ fetch: workerFetch }));
  return {
    environment: {
      DISPATCHER: { get } satisfies DispatchNamespaceBinding,
      PROJECT_ID,
      PROJECT_HANDLE: HANDLE,
      ENVIRONMENT_NAME,
      PUBLIC_ORIGIN,
    },
    get,
    workerFetch,
  };
}

async function signedDevSession(overrides: Readonly<Record<string, unknown>> = {}) {
  return signDevAccessSession(globalThis.crypto, privateJwk, {
    projectId: PROJECT_ID,
    environmentId: DEV_ENVIRONMENT_ID,
    handle: HANDLE,
    origin: DEV_ORIGIN,
    kid: keyId,
    devAccessEpoch: 1,
    subjectId: "user:user_1",
    issuedAt: NOW,
    expiresAt: EXPIRES_AT,
    ...overrides,
  });
}

function devGatewayBinding(fetch: (request: Request) => Promise<Response>) {
  const binding = gatewayBinding(fetch);
  const redeem = vi.fn();
  const authorize = vi.fn(async ({ sessionToken }: { sessionToken: string | null }) => ({
    authorized: sessionToken !== null,
  }));
  return {
    ...binding,
    redeem,
    authorize,
    environment: {
      ...binding.environment,
      DEV_ACCESS: { redeem, authorize },
      ENVIRONMENT_NAME: "dev" as const,
      PUBLIC_ORIGIN: DEV_ORIGIN,
    },
    worker: createProjectIsolatedGatewayWorker({
      environmentId: DEV_ENVIRONMENT_ID,
      keyId,
      publicJwk,
      now: () => new Date(NOW),
    }),
  };
}

describe("project-isolated WFP gateway", () => {
  it("exports the tested fixed-target behavior from its Cloudflare entrypoint", async () => {
    const { environment, get } = gatewayBinding(async () => new Response("gateway"));

    const response = await gatewayEntrypoint.fetch(new Request(`${PUBLIC_ORIGIN}/`), environment);

    expect(await response.text()).toBe("gateway");
    expect(get).toHaveBeenCalledWith(
      projectScriptName(PROJECT_ID, ENVIRONMENT_NAME),
      {},
      {
        limits: WFP_DISPATCH_LIMITS,
        outbound: {
          EGRESS_CONTEXT: { version: 1, projectId: PROJECT_ID, allowedOrigins: [] },
        },
      },
    );
  });

  it("dispatches to the configured project and never derives a target from caller input", async () => {
    const { environment, get, workerFetch } = gatewayBinding(async (request) => {
      expect(new URL(request.url).origin).toBe(PUBLIC_ORIGIN);
      expect(new URL(request.url).pathname).toBe("/api/session");
      expect(request.headers.get("origin")).toBe(PUBLIC_ORIGIN);
      expect(request.headers.get("cookie")).toBe("session=project-a");
      return new Response("ok", {
        headers: { "x-ohmyhost-runtime": "edge-v1" },
      });
    });

    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request(`${PUBLIC_ORIGIN}/api/session`, {
        method: "POST",
        headers: { cookie: "session=project-a", origin: PUBLIC_ORIGIN },
      }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(
      projectScriptName(PROJECT_ID, ENVIRONMENT_NAME),
      {},
      {
        limits: WFP_DISPATCH_LIMITS,
        outbound: {
          EGRESS_CONTEXT: { version: 1, projectId: PROJECT_ID, allowedOrigins: [] },
        },
      },
    );
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it("accepts an explicitly routed Paid hostname only in production", async () => {
    const { environment, get } = gatewayBinding(async () => new Response("paid"));

    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request("https://poc.tenant-fixture.com/"),
      environment,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("paid");
    // HSTS never reaches the subdomains of a customer's apex, which the customer controls.
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(get).toHaveBeenCalledWith(
      projectScriptName(PROJECT_ID, ENVIRONMENT_NAME),
      {},
      expect.any(Object),
    );
    const invalid = await createProjectIsolatedGatewayWorker().fetch(
      new Request("http://poc.tenant-fixture.com/"),
      environment,
    );
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("keeps production public but rejects dev-ticket parameters before customer dispatch", async () => {
    const { environment, get } = gatewayBinding(async () => new Response("public"));
    const worker = createProjectIsolatedGatewayWorker();

    await expect(
      worker.fetch(new Request(`${PUBLIC_ORIGIN}/`), environment),
    ).resolves.toMatchObject({
      status: 200,
    });
    const denied = await worker.fetch(
      new Request(`${PUBLIC_ORIGIN}/?stage=dev&ticket=${"A".repeat(43)}`),
      environment,
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe("");
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(get).toHaveBeenCalledOnce();
  });

  it("keeps dev private without a valid session and never dispatches denial", async () => {
    const { environment, get, worker } = devGatewayBinding(async () => new Response("private"));

    const response = await worker.fetch(new Request(`${DEV_ORIGIN}/dashboard`), environment);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(get).not.toHaveBeenCalled();
  });

  it("allows public Dev through private mode authorization without a cookie", async () => {
    const { environment, worker, authorize, get } = devGatewayBinding(
      async () => new Response("public"),
    );
    authorize.mockResolvedValueOnce({ authorized: true });
    const response = await worker.fetch(new Request(`${DEV_ORIGIN}/dashboard`), environment);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("public");
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ sessionToken: null, projectId: PROJECT_ID }),
    );
    expect(get).toHaveBeenCalledOnce();
  });

  it("redeems one exact ticket privately and redirects without any query", async () => {
    const { environment, get, redeem, worker } = devGatewayBinding(
      async () => new Response("unexpected"),
    );
    const sessionToken = await signedDevSession();
    redeem.mockResolvedValueOnce({ sessionToken, expiresAt: EXPIRES_AT });
    const ticket = "A".repeat(43);

    const response = await worker.fetch(
      new Request(`${DEV_ORIGIN}/dashboard?stage=dev&ticket=${ticket}`),
      environment,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${DEV_ORIGIN}/dashboard`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.getSetCookie()).toEqual([
      `__Host-ohmyhost_dev_access=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`,
    ]);
    expect(redeem).toHaveBeenCalledWith({
      ticket,
      projectId: PROJECT_ID,
      environmentId: DEV_ENVIRONMENT_ID,
      handle: HANDLE,
      origin: DEV_ORIGIN,
      clientAddress: "unknown",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("returns the same denial when redemption returns a mismatched session", async () => {
    const { environment, get, redeem, worker } = devGatewayBinding(
      async () => new Response("unexpected"),
    );
    redeem.mockResolvedValueOnce({ sessionToken: "invalid.session", expiresAt: EXPIRES_AT });

    const response = await worker.fetch(
      new Request(`${DEV_ORIGIN}/?stage=dev&ticket=${"A".repeat(43)}`),
      environment,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects redemption responses with any extra field before setting a cookie", async () => {
    const { environment, get, redeem, worker } = devGatewayBinding(
      async () => new Response("unexpected"),
    );
    const sessionToken = await signedDevSession();
    redeem.mockResolvedValueOnce({ sessionToken, expiresAt: EXPIRES_AT, extra: true });

    const response = await worker.fetch(
      new Request(`${DEV_ORIGIN}/?stage=dev&ticket=${"A".repeat(43)}`),
      environment,
    );

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("redacts an unexpected customer Worker failure", async () => {
    const { environment, get } = gatewayBinding(async () => {
      throw new Error("customer secret and stack");
    });

    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request(`${PUBLIC_ORIGIN}/`),
      environment,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Upstream unavailable");
    expect(get).toHaveBeenCalledOnce();
  });

  it("verifies dev locally and strips only the reserved platform cookie before dispatch", async () => {
    const sessionToken = await signedDevSession();
    const { environment, worker, workerFetch, redeem, authorize } = devGatewayBinding(
      async (request) => {
        expect(request.headers.get("cookie")).toBe("app_session=customer");
        return new Response("private");
      },
    );

    const response = await worker.fetch(
      new Request(`${DEV_ORIGIN}/dashboard?customer=visible`, {
        headers: {
          cookie: `app_session=customer; __Host-ohmyhost_dev_access=${sessionToken}`,
        },
      }),
      environment,
    );

    expect(await response.text()).toBe("private");
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(redeem).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith({
      sessionToken,
      projectId: PROJECT_ID,
      environmentId: DEV_ENVIRONMENT_ID,
      handle: HANDLE,
      origin: DEV_ORIGIN,
    });
  });

  it.each([
    ["stale epoch", async () => ({ authorized: false })],
    ["authorization service failure", async () => Promise.reject(new Error("unavailable"))],
  ])("denies %s before customer dispatch", async (_label, authorizeResult) => {
    const sessionToken = await signedDevSession();
    const { environment, worker, authorize, get } = devGatewayBinding(
      async () => new Response("unexpected"),
    );
    authorize.mockImplementationOnce(authorizeResult);

    const response = await worker.fetch(
      new Request(`${DEV_ORIGIN}/`, {
        headers: { cookie: `__Host-ohmyhost_dev_access=${sessionToken}` },
      }),
      environment,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate ticket", `stage=dev&ticket=${"A".repeat(43)}&ticket=${"B".repeat(43)}`],
    ["missing stage", `ticket=${"A".repeat(43)}`],
    ["noncanonical ticket", "stage=dev&ticket=secret"],
  ])("returns the same empty 404 for %s", async (_label, query) => {
    const { environment, worker, redeem, get } = devGatewayBinding(
      async () => new Response("unexpected"),
    );

    const response = await worker.fetch(new Request(`${DEV_ORIGIN}/?${query}`), environment);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(redeem).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate platform cookies", `__Host-ohmyhost_dev_access=a; __Host-ohmyhost_dev_access=b`],
    ["oversized platform cookie", `__Host-ohmyhost_dev_access=${"a".repeat(4097)}`],
    ["oversized cookie header", `app=${"a".repeat(8190)}`],
  ])("rejects %s without service or customer dispatch", async (_label, cookie) => {
    const { environment, worker, redeem, get } = devGatewayBinding(
      async () => new Response("unexpected"),
    );

    const response = await worker.fetch(
      new Request(`${DEV_ORIGIN}/`, { headers: { cookie } }),
      environment,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(redeem).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("redirects revoked browser access without retaining the Dev path or token", async () => {
    const sessionToken = await signedDevSession();
    const { environment, worker, authorize, redeem } = devGatewayBinding(
      async () => new Response("unexpected"),
    );
    authorize.mockResolvedValueOnce({ authorized: false });
    const session = await worker.fetch(
      new Request(`${DEV_ORIGIN}/private?source=secret`, {
        headers: {
          cookie: `__Host-ohmyhost_dev_access=${sessionToken}`,
          "sec-fetch-mode": "navigate",
        },
      }),
      environment,
    );
    expect(session.status).toBe(303);
    expect(session.headers.get("location")).toBe("https://ohmyho.st/");
    redeem.mockRejectedValueOnce(new Error("revoked"));
    const oldLink = await worker.fetch(
      new Request(`${DEV_ORIGIN}/.ohmyhost/dev-access/redeem?stage=dev&ticket=${"A".repeat(43)}`),
      environment,
    );
    expect(oldLink.status).toBe(303);
    expect(oldLink.headers.get("location")).toBe("https://ohmyho.st/");
  });

  it("forwards a customer-owned /p path unchanged", async () => {
    const { environment } = gatewayBinding(async (request) => {
      expect(new URL(request.url).pathname).toBe("/p/arbitrary/customer-route");
      return new Response("customer-route");
    });

    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request(`${PUBLIC_ORIGIN}/p/arbitrary/customer-route`),
      environment,
    );

    expect(await response.text()).toBe("customer-route");
  });

  it("assigns a safe MIME type when customer output omits it", async () => {
    const { environment } = gatewayBinding(async () => new Response(new Uint8Array([1])));

    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request(`${PUBLIC_ORIGIN}/asset.js`),
      environment,
    );

    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("forwards the root path and query unchanged without using them for dispatch identity", async () => {
    const { environment, get } = gatewayBinding(async (request) => {
      expect(request.url).toBe(`${PUBLIC_ORIGIN}/?project=${OTHER_PROJECT_ID}`);
      return new Response("root");
    });

    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request(`${PUBLIC_ORIGIN}/?project=${OTHER_PROJECT_ID}`),
      environment,
    );

    expect(await response.text()).toBe("root");
    expect(get).toHaveBeenCalledWith(
      projectScriptName(PROJECT_ID, ENVIRONMENT_NAME),
      {},
      expect.any(Object),
    );
  });

  it.each([
    [
      "foreign origin with an ambient cookie",
      { cookie: "session=project-a", origin: "https://evil.example" },
    ],
    ["missing origin with an ambient cookie", { cookie: "session=project-a" }],
    [
      "foreign preflight",
      { origin: "https://evil.example", "access-control-request-method": "POST" },
    ],
  ])("rejects %s before dispatch", async (_name, headers) => {
    const { environment, get } = gatewayBinding(async () => new Response("unexpected"));

    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request(`${PUBLIC_ORIGIN}/api/mutate`, {
        method: "POST",
        headers,
      }),
      environment,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(get).not.toHaveBeenCalled();
  });

  it("allows a credential-free server API call without a browser Origin header", async () => {
    const { environment, get } = gatewayBinding(
      async () => new Response("created", { status: 201 }),
    );

    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request(`${PUBLIC_ORIGIN}/api/agent`, {
        method: "POST",
        headers: { authorization: "Bearer product-token" },
      }),
      environment,
    );

    expect(response.status).toBe(201);
    expect(get).toHaveBeenCalledOnce();
  });

  it("removes customer CORS authority and applies the edge browser policy", async () => {
    const upstreamHeaders = new Headers({
      "access-control-allow-credentials": "true",
      "access-control-allow-origin": "https://evil.example",
      "x-ohmyhost-runtime": "edge-v1",
    });
    upstreamHeaders.append("set-cookie", "host_session=allowed; Path=/; Secure; HttpOnly");
    upstreamHeaders.append(
      "set-cookie",
      "__Host-ohmyhost_dev_access=customer-forged; Path=/; Secure; HttpOnly",
    );
    upstreamHeaders.append(
      "set-cookie",
      "__Host-ohmyhost_dev_access =customer-forged; Path=/; Secure; HttpOnly",
    );
    upstreamHeaders.append(
      "set-cookie",
      "__Host-ohmyhost_dev_access\t=customer-forged; Path=/; Secure; HttpOnly",
    );
    upstreamHeaders.append(
      "set-cookie",
      "shared_session=blocked; Domain=poc.aixyte.com; Path=/; Secure; HttpOnly",
    );
    const { environment } = gatewayBinding(
      async () =>
        new Response("edge", {
          headers: upstreamHeaders,
        }),
    );

    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request(`${PUBLIC_ORIGIN}/dashboard`),
      environment,
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("x-ohmyhost-runtime")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(response.headers.get("content-security-policy")).toContain("worker-src 'none'");
    expect(response.headers.get("origin-agent-cluster")).toBe("?1");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.getSetCookie()).toEqual([
      "host_session=allowed; Path=/; Secure; HttpOnly",
    ]);
  });

  it.each([
    [
      "missing project",
      {
        DISPATCHER: gatewayBinding(async () => new Response()).environment.DISPATCHER,
        PROJECT_HANDLE: HANDLE,
        PUBLIC_ORIGIN,
      },
    ],
    [
      "lowercase project",
      {
        ...gatewayBinding(async () => new Response()).environment,
        PROJECT_ID: PROJECT_ID.toLowerCase(),
      },
    ],
    [
      "path-bearing origin",
      {
        ...gatewayBinding(async () => new Response()).environment,
        PUBLIC_ORIGIN: `${PUBLIC_ORIGIN}/nested`,
      },
    ],
    [
      "missing environment name",
      {
        DISPATCHER: gatewayBinding(async () => new Response()).environment.DISPATCHER,
        PROJECT_ID,
        PROJECT_HANDLE: HANDLE,
        PUBLIC_ORIGIN,
      },
    ],
  ])("fails closed for %s configuration", async (_name, environment) => {
    const response = await createProjectIsolatedGatewayWorker().fetch(
      new Request(`${PUBLIC_ORIGIN}/`),
      environment as never,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Service unavailable");
  });
});
