import { describe, expect, it, vi } from "vitest";
import {
  CloudflareAuthorizationClosedError,
  CloudflareProjectDomainConflictError,
  OrganizationCreditError,
  SharedMailDomainError,
} from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";
import { CloudflareCustomerDnsConflictError } from "@ohmyhost/provider-cloudflare";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = undefined;
  },
}));

import {
  createCloudflareDomainManagementEntrypoint,
  CloudflareDomainManagementService,
} from "../src/worker-main.js";
import { createCloudflareDomainProviderPorts, workerFetch } from "../src/d1-runtime.js";
import {
  PaidDomainAlreadyConfiguredError,
  PaidDomainDeletingError,
  PaidDomainHostnameTakenError,
  PaidDomainKeyConflictError,
  PaidDomainProductionDeploymentRequiredError,
} from "../src/paid-domains.js";
import { CloudflareZoneNotBoundError } from "../src/runtime.js";
import { ScopedDnsConflictError } from "../src/scoped-dns-authorization.js";

class ProbeRecorder {
  requests: unknown[] = [];
  async beginProbe(input: unknown) {
    this.requests.push(input);
    return { expiresAt: new Date(Date.now() + 180000).toISOString() };
  }
}

const bindings = () => ({
  RUNTIME_CONFIGURATION_STATE: "configured" as const,
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_PLATFORM_ZONE_ID: "c".repeat(32),
  CLOUDFLARE_SAAS_ZONE_ID: "b".repeat(32),
  CLOUDFLARE_SAAS_CNAME_TARGET: "customers.omh.st" as const,
  CLOUDFLARE_SAAS_API_TOKEN: "saas-domain-token-value",
  CLOUDFLARE_OAUTH_CLIENT_ID: "oauth-client-id",
  CLOUDFLARE_OAUTH_CLIENT_SECRET: "oauth-client-secret-value",
  CLOUDFLARE_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/cloudflare/oauth/callback" as const,
  CLOUDFLARE_OAUTH_STATE_FORMAT: "json-v1" as const,
  CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: Buffer.alloc(32, 0x41).toString("base64"),
  CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "1",
  CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: "platform-web-domain-token-value",
  DEV_ACCESS: {
    issueRuntimeProbe: vi.fn(async () => ({
      probeToken: "payload.signature",
      expiresAt: "2026-08-29T12:01:00.000Z",
    })),
  },
  RUNTIME_PROBES: new ProbeRecorder(),
  GENERAL_CF_RUNTIME: {},
  NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: vi.fn() },
  NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: vi.fn() },
  SCOPED_DNS_RUNTIME: {},
  APPLICATION_IDENTITY_RUNTIME: {},
  MAIL_DNS_RUNTIME: {},
});

describe("private Cloudflare domain-management Worker", () => {
  it("is route-free and refuses every RPC without its exact bindings", async () => {
    const entrypoint = createCloudflareDomainManagementEntrypoint({ runtimeFactory: vi.fn() });
    const response = await entrypoint.fetch();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const unconfigured = new CloudflareDomainManagementService({} as never, {} as never);
    for (const method of [
      "beginAuthorization",
      "getStatus",
      "configureDomains",
      "completeAuthorization",
      "ensureEnvironment",
      "deleteMailRecords",
      "ensureMailRecords",
      "ensureWorkspaceMailRecords",
      "retireWorkspaceMailRecords",
      "deleteProject",
      "planPaidDomain",
      "applyPaidDomain",
      "getPaidDomain",
      "deletePaidDomain",
      "readApplicationDomainIdentity",
      "revalidateApplicationDomainIdentity",
      "declareApplicationDomainIdentity",
      "verifyApplicationDomainIdentity",
      "revokeApplicationDomainIdentity",
      "beginApplicationIdentityAuthorization",
      "getApplicationIdentityAuthorizationStatus",
      "beginWorkspaceMailAuthorization",
      "getWorkspaceMailAuthorizationStatus",
      "revokeApplicationIdentityAuthorization",
      "revokeWorkspaceMailAuthorization",
      "sweepRevokedGrants",
    ] as const) {
      await expect(unconfigured[method]({})).rejects.toThrow(TypeError);
    }
  });

  it("sweeps revoked grants through the same bindings check as every other RPC", async () => {
    const sweepRevokedGrants = vi.fn(async () => ({ attempted: 0, wiped: 0, failed: 0 }));
    const entrypoint = createCloudflareDomainManagementEntrypoint({
      runtimeFactory: vi.fn(async () => ({ sweepRevokedGrants }) as never),
    });
    const environment = bindings();
    await expect(entrypoint.sweepRevokedGrants(environment, {})).resolves.toEqual({
      attempted: 0,
      wiped: 0,
      failed: 0,
    });
    expect(sweepRevokedGrants).toHaveBeenCalledWith({});
    await expect(
      entrypoint.sweepRevokedGrants({ ...environment, SCOPED_DNS_RUNTIME: undefined }, {}),
    ).rejects.toThrow("bindings are invalid");
  });

  it("answers a configure whose project domains belong to another handle with its own closed conflict", async () => {
    const entrypoint = createCloudflareDomainManagementEntrypoint({
      runtimeFactory: vi.fn(async () => ({
        configureDomains: vi.fn(async () => {
          throw new CloudflareProjectDomainConflictError();
        }),
      })) as never,
    });
    await expect(entrypoint.configureDomains(bindings(), {})).resolves.toEqual({
      status: "conflict",
      code: "project_domains_conflict",
    });
  });

  it("validates bindings and invokes one RPC", async () => {
    const beginAuthorization = vi.fn(async () => ({ authorizationId: "result" }));
    const runtimeFactory = vi.fn(async () => ({ beginAuthorization }) as never);
    const entrypoint = createCloudflareDomainManagementEntrypoint({ runtimeFactory });
    const input = { projectId: "opaque" };
    const environment = bindings();

    await expect(entrypoint.beginAuthorization(environment, input)).resolves.toEqual({
      authorizationId: "result",
    });
    expect(runtimeFactory).toHaveBeenCalledWith(environment);
    expect(beginAuthorization).toHaveBeenCalledWith(input);
    await expect(
      entrypoint.beginAuthorization({ ...environment, GENERAL_CF_RUNTIME: undefined }, input),
    ).rejects.toThrow("bindings are invalid");
    expect(runtimeFactory).toHaveBeenCalledOnce();
    await expect(entrypoint.getStatus(environment, input)).rejects.toThrow(
      "Domain operation unavailable",
    );
  });

  it("maps closed failures of the authorization RPC and never exposes a route fallback", async () => {
    let failure: Error = new Error("private provider failure");
    const entrypoint = createCloudflareDomainManagementEntrypoint({
      runtimeFactory: vi.fn(async () => ({
        beginAuthorization: vi.fn(async () => {
          throw failure;
        }),
      })) as never,
    });

    await expect(entrypoint.beginAuthorization(bindings(), {})).rejects.toThrow(
      "private provider failure",
    );
    failure = new CloudflareAuthorizationClosedError();
    await expect(entrypoint.beginAuthorization(bindings(), {})).resolves.toEqual({
      status: "authorization_closed",
    });
    failure = new CloudflareProjectDomainConflictError();
    await expect(entrypoint.beginAuthorization(bindings(), {})).resolves.toEqual({
      status: "conflict",
      code: "idempotency_key_reused",
    });
    failure = new CloudflareZoneNotBoundError();
    await expect(entrypoint.beginAuthorization(bindings(), {})).resolves.toEqual({
      status: "conflict",
      code: "cloudflare_zone_not_bound",
    });
  });

  it("maps scoped DNS, shared mail and payment failures to their closed results", async () => {
    let failure: Error = new ScopedDnsConflictError("dns_authority_revoked");
    const fail = vi.fn(async () => {
      throw failure;
    });
    const entrypoint = createCloudflareDomainManagementEntrypoint({
      runtimeFactory: vi.fn(async () => ({
        verifyApplicationDomainIdentity: fail,
        applyPaidDomain: fail,
      })) as never,
    });

    await expect(entrypoint.verifyApplicationDomainIdentity(bindings(), {})).resolves.toEqual({
      status: "conflict",
      code: "dns_authority_revoked",
    });
    failure = new SharedMailDomainError("mail_domain_mismatch");
    await expect(entrypoint.verifyApplicationDomainIdentity(bindings(), {})).resolves.toEqual({
      status: "conflict",
      code: "mail_domain_mismatch",
    });
    failure = new OrganizationCreditError("paid_plan_required");
    await expect(entrypoint.applyPaidDomain(bindings(), {})).resolves.toEqual({
      status: "payment_required",
      code: "paid_plan_required",
    });
    await expect(entrypoint.verifyApplicationDomainIdentity(bindings(), {})).rejects.toBe(failure);
  });

  it("delegates every credential-free RPC to the composed runtime", async () => {
    const runtime = {
      beginAuthorization: vi.fn(async () => ({ method: "beginAuthorization" })),
      getStatus: vi.fn(async () => ({ method: "getStatus" })),
      configureDomains: vi.fn(async () => ({ method: "configureDomains" })),
      completeAuthorization: vi.fn(async () => ({ method: "completeAuthorization" })),
      ensureMailRecords: vi.fn(async () => ({ method: "ensureMailRecords" })),
      deleteMailRecords: vi.fn(async () => ({ method: "deleteMailRecords" })),
      ensureEnvironment: vi.fn(async () => ({ method: "ensureEnvironment" })),
      deleteProject: vi.fn(async () => ({ method: "deleteProject" })),
      planPaidDomain: vi.fn(async () => ({ method: "planPaidDomain" })),
      applyPaidDomain: vi.fn(async () => ({ method: "applyPaidDomain" })),
      getPaidDomain: vi.fn(async () => ({ method: "getPaidDomain" })),
      deletePaidDomain: vi.fn(async () => ({ method: "deletePaidDomain" })),
    };
    const entrypoint = createCloudflareDomainManagementEntrypoint({
      runtimeFactory: vi.fn(async () => runtime) as never,
    });
    for (const method of [
      "beginAuthorization",
      "getStatus",
      "configureDomains",
      "completeAuthorization",
      "ensureMailRecords",
      "ensureEnvironment",
      "deleteMailRecords",
      "deleteProject",
      "planPaidDomain",
      "applyPaidDomain",
      "getPaidDomain",
      "deletePaidDomain",
    ] as const) {
      await expect(entrypoint[method](bindings(), { method })).resolves.toEqual({ method });
      expect(runtime[method]).toHaveBeenCalledWith({ method });
    }
    for (const method of ["applyPaidDomain", "deletePaidDomain"] as const) {
      runtime[method].mockRejectedValueOnce(new PaidDomainKeyConflictError("key-conflict-detail"));
      await expect(entrypoint[method](bindings(), {})).resolves.toEqual({
        status: "conflict",
        code: "idempotency_key_reused",
      });
      // A fresh key meets another hostname's connection, or a connection being deleted: each names itself.
      runtime[method].mockRejectedValueOnce(
        new PaidDomainAlreadyConfiguredError("already-configured-detail"),
      );
      await expect(entrypoint[method](bindings(), {})).resolves.toEqual({
        status: "conflict",
        code: "domain_already_configured",
      });
      runtime[method].mockRejectedValueOnce(new PaidDomainDeletingError("deleting-detail"));
      await expect(entrypoint[method](bindings(), {})).resolves.toEqual({
        status: "conflict",
        code: "domain_deleting",
      });
    }
    // Another project's live connection of the hostname is a closed conflict, not an outage.
    runtime.applyPaidDomain.mockRejectedValueOnce(
      new PaidDomainHostnameTakenError("hostname-taken-detail"),
    );
    await expect(entrypoint.applyPaidDomain(bindings(), {})).resolves.toEqual({
      status: "conflict",
      code: "domain_hostname_taken",
    });
    for (const method of ["planPaidDomain", "applyPaidDomain"] as const) {
      runtime[method].mockRejectedValueOnce(
        new PaidDomainProductionDeploymentRequiredError("prerequisite-detail"),
      );
      await expect(entrypoint[method](bindings(), {})).resolves.toEqual({
        status: "conflict",
        code: "production_deployment_required",
      });
    }
    runtime.getPaidDomain.mockRejectedValueOnce(
      new PaidDomainProductionDeploymentRequiredError("prerequisite-detail"),
    );
    await expect(entrypoint.getPaidDomain(bindings(), {})).rejects.toThrow("prerequisite-detail");
    for (const method of ["applyPaidDomain", "deletePaidDomain"] as const) {
      runtime[method].mockRejectedValueOnce(new CloudflareCustomerDnsConflictError());
      await expect(entrypoint[method](bindings(), {})).resolves.toEqual({
        status: "conflict",
        code: "domain_dns_conflict",
      });
    }
  });

  it("wires every production provider call through its narrow adapter", async () => {
    const provider = {
      exchangeAuthorizationCode: vi.fn(async () => ({ exchange: true })),
      observeZone: vi.fn(async () => ({
        state: "found" as const,
        zoneName: "aixyte.com",
        zoneId: "a".repeat(32),
        accountId: "account_1",
      })),
      refreshAccessToken: vi.fn(async () => ({ refresh: true })),
      reconcileRecords: vi.fn(async () => ({ reconcile: true })),
      deleteRecords: vi.fn(async () => ({ delete: true })),
      revokeRefreshToken: vi.fn(async () => undefined),
      observeRefreshToken: vi.fn(async () => ({ state: "revoked" as const })),
    };
    const platformRoutes = {
      createRoute: vi.fn(),
      observePlatformWildcardRoute: vi.fn(),
      deleteRoute: vi.fn(),
    };
    const platformDomains = {
      observeGatewayWildcard: vi.fn(async () => ({ recordId: "c".repeat(32) })),
      reconcileRecords: vi.fn(async () => ({ reconcile: "platform" })),
      deleteRecords: vi.fn(async () => ({ delete: "platform" })),
    };
    const fetcher = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, { status: 404, headers: { "x-ohmyhost-gateway": "shared-v1" } }),
    );
    const runtimeProbes = new ProbeRecorder();
    const runtimeProbeIssuer = {
      issueRuntimeProbe: vi.fn(async () => ({
        probeToken: "payload.signature",
        expiresAt: "2026-08-29T12:01:00.000Z",
      })),
    };
    const ports = createCloudflareDomainProviderPorts({
      provider: provider as never,
      clientId: "oauth-client-id",
      redirectUri: bindings().CLOUDFLARE_OAUTH_REDIRECT_URI,
      platformDomains: platformDomains as never,
      platformZoneId: "c".repeat(32),
      platformRoutes: platformRoutes as never,
      fetcher,
      runtimeProbes,
      runtimeProbeIssuer,
    });

    expect(ports.authorization.authorizationUrl({ state: "s".repeat(32) })).toContain(
      "dash.cloudflare.com/oauth2/auth",
    );
    await expect(ports.authorization.exchangeAuthorizationCode("provider-code")).resolves.toEqual({
      exchange: true,
    });
    await ports.authorization.revokeRefreshToken("refresh-token-of-a-revoked-grant");
    expect(provider.revokeRefreshToken).toHaveBeenCalledWith("refresh-token-of-a-revoked-grant");
    await expect(
      ports.authorization.observeZone("access-token", "aixyte.com"),
    ).resolves.toMatchObject({
      state: "found",
      zoneName: "aixyte.com",
    });
    await expect(ports.reconciliation.dns.reconcileRecords({} as never)).resolves.toEqual({
      reconcile: "platform",
    });
    const wildcard = {
      zoneId: "c".repeat(32),
      zoneName: "omh.st",
      hostname: "*.dev.check.omh.st",
      target: "dev.check.omh.st",
    } as const;
    await expect(ports.reconciliation.dns.observeGatewayWildcard(wildcard)).resolves.toEqual({
      recordId: "c".repeat(32),
    });
    expect(platformDomains.observeGatewayWildcard).toHaveBeenCalledWith(wildcard);
    expect(provider.reconcileRecords).not.toHaveBeenCalled();
    const probeInput = {
      organizationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAA"),
      projectId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAB"),
      environmentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAC"),
      operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAD"),
      deploymentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAE"),
      environmentName: "dev" as const,
      handle: "calm-otter-waves",
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      path: "/health",
      method: "GET" as const,
      url: "https://dev-calm-otter-waves.dev.check.omh.st/health",
    };
    const devProbeResult = await ports.reconciliation.probe(probeInput);
    expect(devProbeResult).toEqual({ status: 404 });
    expect(runtimeProbeIssuer.issueRuntimeProbe).not.toHaveBeenCalled();
    expect(runtimeProbes.requests).toEqual([]);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("x-ohmyhost-runtime-probe")).toBe(
      false,
    );
    await expect(
      ports.reconciliation.probe({
        ...probeInput,
        environmentName: "prod",
        origin: "https://calm-otter-waves.dev.check.omh.st",
        url: "https://calm-otter-waves.dev.check.omh.st/health",
      }),
    ).resolves.toEqual({ status: 404 });
    await expect(ports.deletion.oauth.refreshAccessToken("refresh-token")).resolves.toEqual({
      refresh: true,
    });
    await expect(
      ports.deletion.oauth.revokeRefreshToken("refresh-token-value"),
    ).resolves.toBeUndefined();
    await expect(ports.deletion.oauth.observeRefreshToken("refresh-token-value")).resolves.toEqual({
      state: "revoked",
    });
    await expect(ports.deletion.dns.deleteRecords("access-token", {} as never)).resolves.toEqual({
      delete: true,
    });
    expect(platformDomains.reconcileRecords).toHaveBeenCalledOnce();
    expect(ports.reconciliation).not.toHaveProperty("mailDns");
    expect(() =>
      ports.deletion.platformDns.deleteRecords({ zoneId: "a".repeat(32) } as never),
    ).toThrow("platform DNS zone is invalid");
    await expect(
      ports.deletion.platformDns.deleteRecords({ zoneId: "c".repeat(32) } as never),
    ).resolves.toEqual({ delete: "platform" });
    expect(() =>
      ports.deletion.platformRoutes.deleteRoute({
        zoneId: "a".repeat(32),
        routeId: "old-web-route",
      } as never),
    ).toThrow("platform route zone is invalid");
    await ports.deletion.platformRoutes.deleteRoute({
      zoneId: "c".repeat(32),
      routeId: "new-web-route",
    } as never);
    expect(platformRoutes.deleteRoute).toHaveBeenCalledWith({ routeId: "new-web-route" });
    expect(() =>
      ports.deletion.platformRoutes.deleteRoute({ zoneId: "f".repeat(32) } as never),
    ).toThrow("platform route zone is invalid");
    expect(ports.deletion).not.toHaveProperty("customHostnames");
    expect(Object.keys(ports.deletion.platformRoutes)).toEqual(["deleteRoute"]);
    expect(platformRoutes.deleteRoute).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("invokes the runtime fetcher with the global receiver", async () => {
    const runtimeProbeIssuer = {
      issueRuntimeProbe: vi.fn(async () => ({
        probeToken: "payload.signature",
        expiresAt: "2026-08-29T12:01:00.000Z",
      })),
    };
    const fetcherMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect this reference");
      }
      return Promise.resolve(
        new Response(null, { status: 404, headers: { "x-ohmyhost-gateway": "shared-v1" } }),
      );
    });
    const fetcher = fetcherMock as typeof globalThis.fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ports = createCloudflareDomainProviderPorts({
      provider: {} as never,
      clientId: "oauth-client-id",
      redirectUri: bindings().CLOUDFLARE_OAUTH_REDIRECT_URI,
      platformRoutes: {} as never,
      fetcher,
      runtimeProbes: new ProbeRecorder(),
      runtimeProbeIssuer,
    });
    const probeInput = {
      organizationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAA"),
      projectId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAB"),
      environmentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAC"),
      operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAD"),
      deploymentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAE"),
      environmentName: "dev" as const,
      handle: "calm-otter-waves",
      origin: "https://dev-calm-otter-waves.dev.check.omh.st",
      path: "/health",
      method: "GET" as const,
      url: "https://dev-calm-otter-waves.dev.check.omh.st/health",
    };

    await expect(ports.reconciliation.probe(probeInput)).resolves.toEqual({ status: 404 });
    expect(fetcherMock.mock.contexts).toEqual([globalThis]);
    expect(fetcherMock).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("accepts only the shared ingress marker and redacts a transport failure", async () => {
    const address = "https://dev-calm-otter-waves.dev.check.omh.st";
    const input = {
      organizationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAA"),
      projectId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAB"),
      environmentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAC"),
      operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAD"),
      deploymentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAE"),
      environmentName: "dev" as const,
      handle: "calm-otter-waves",
      origin: address,
      path: "/health",
      method: "GET" as const,
      url: `${address}/health`,
    };
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 503,
          headers: { "x-ohmyhost-gateway": "shared-v1" },
        }),
      )
      .mockRejectedValueOnce(new Error(`private transport ${address}`));
    const ports = createCloudflareDomainProviderPorts({
      provider: {} as never,
      clientId: "oauth-client-id",
      redirectUri: bindings().CLOUDFLARE_OAUTH_REDIRECT_URI,
      platformRoutes: {} as never,
      fetcher,
      runtimeProbes: new ProbeRecorder(),
      runtimeProbeIssuer: { issueRuntimeProbe: vi.fn() } as never,
    });
    for (let index = 0; index < 2; index += 1)
      await expect(ports.reconciliation.probe(input)).rejects.toThrow(
        "Shared gateway ingress is not ready",
      );
    await expect(ports.reconciliation.probe(input)).rejects.toThrow(
      "Shared gateway ingress is unavailable",
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, options] of fetcher.mock.calls)
      expect(new Headers(options?.headers).has("x-ohmyhost-runtime-probe")).toBe(false);
  });

  it("hands providers a fetch that also works when they call it as a method", async () => {
    const original = globalThis.fetch;
    // Workers reject the global fetch unless it is called on globalThis or unbound.
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis)
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
      return Promise.resolve(new Response("ok"));
    } as typeof globalThis.fetch;
    try {
      const dependencies = { fetch: workerFetch };
      await expect((await dependencies.fetch("https://api.cloudflare.com/")).text()).resolves.toBe(
        "ok",
      );
      const raw = { fetch: globalThis.fetch };
      expect(() => raw.fetch("https://api.cloudflare.com/")).toThrow("Illegal invocation");
    } finally {
      globalThis.fetch = original;
    }
  });
});
