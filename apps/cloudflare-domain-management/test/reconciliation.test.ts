import { parseUlid } from "@ohmyhost/platform";
import type { CloudflareDesiredDnsRecord } from "@ohmyhost/provider-cloudflare";
import { describe, expect, it, vi } from "vitest";

import {
  CloudflareDomainReconciliationConflictError,
  CloudflareDomainReconciliationUnavailableError,
  createCloudflareDomainReconciliation,
  type CloudflareDomainReconciliationPersistence,
} from "../src/reconciliation.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const ENVIRONMENT_ID = parseUlid("00000000000000000000000003");
const OPERATION_ID = parseUlid("00000000000000000000000004");
const DEPLOYMENT_ID = parseUlid("00000000000000000000000006");
const NOW = "2026-08-29T12:00:00.000Z";
const PROBED_AT = "2026-08-29T12:00:01.000Z";

describe("Cloudflare project-domain provider reconciliation", () => {
  it("verifies shared wildcard DNS and route without creating project resources", async () => {
    const fixture = setup();

    await expect(fixture.reconciliation.ensureEnvironment(request())).resolves.toEqual({
      status: "ready",
      environmentName: "dev",
      hostname: "dev-calm-otter-waves.dev.check.omh.st",
      dnsRecordId: "c".repeat(32),
      routeId: "d".repeat(32),
      publicUrl: "https://dev-calm-otter-waves.dev.check.omh.st",
      observedAt: NOW,
      probe: {
        url: expect.stringMatching(
          /^https:\/\/gateway-probe-[a-f0-9]{24}\.dev\.check\.omh\.st\/health$/u,
        ),
        status: 404,
        observedAt: NOW,
      },
    });

    expect(fixture.dns.observeGatewayWildcard).toHaveBeenCalledWith({
      zoneId: "a".repeat(32),
      zoneName: "omh.st",
      hostname: "*.dev.check.omh.st",
      target: "dev.check.omh.st",
    });
    expect(fixture.routes.observePlatformWildcardRoute).toHaveBeenCalledWith({
      pattern: "*.dev.check.omh.st/*",
      scriptName: "ohmyho-gateway-poc-private-fullstack",
    });
    expect(fixture.dns.reconcileRecords).not.toHaveBeenCalled();
    expect(fixture.routes.createRoute).not.toHaveBeenCalled();
    expect(fixture.providers.probe).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      operationId: OPERATION_ID,
      deploymentId: DEPLOYMENT_ID,
      environmentName: "dev",
      handle: "calm-otter-waves",
      origin: expect.stringMatching(/^https:\/\/gateway-probe-[a-f0-9]{24}\.dev\.check\.omh\.st$/u),
      path: "/health",
      method: "GET",
      url: expect.stringMatching(
        /^https:\/\/gateway-probe-[a-f0-9]{24}\.dev\.check\.omh\.st\/health$/u,
      ),
    });
    expect(fixture.customHostnames.createHostname).not.toHaveBeenCalled();
    expect(fixture.oauth.refreshAccessToken).not.toHaveBeenCalled();
    expect(fixture.cipher.open).not.toHaveBeenCalled();
    expect(Object.keys(fixture.reconciliation).sort()).toEqual(["ensureEnvironment"]);
  });

  it("proves the wildcard while an old exact customer route still serves the address", async () => {
    const fixture = setup();
    fixture.providers.probe.mockImplementation(async ({ origin }) => ({
      status: origin === "https://dev-calm-otter-waves.dev.check.omh.st" ? 200 : 404,
    }));

    await expect(fixture.reconciliation.ensureEnvironment(request())).resolves.toMatchObject({
      status: "ready",
      publicUrl: "https://dev-calm-otter-waves.dev.check.omh.st",
      probe: { status: 404 },
    });
    expect(fixture.providers.probe.mock.calls[0]?.[0].origin).toMatch(
      /^https:\/\/gateway-probe-[a-f0-9]{24}\.dev\.check\.omh\.st$/u,
    );
  });

  it("does not require certificate-pack read authority before the real HTTPS probe", async () => {
    const fixture = setup();

    await expect(fixture.reconciliation.ensureEnvironment(request())).resolves.toMatchObject({
      status: "ready",
      probe: { status: 404 },
    });
    expect(fixture.dns.observeGatewayWildcard).toHaveBeenCalledOnce();
    expect(fixture.routes.observePlatformWildcardRoute).toHaveBeenCalledOnce();
    expect(fixture.providers.probe).toHaveBeenCalledOnce();
  });

  it("keeps a real non-200 platform-origin probe pending with its exact facts", async () => {
    const fixture = setup({ probeStatus: 503 });

    await expect(fixture.reconciliation.ensureEnvironment(request())).resolves.toEqual({
      status: "pending",
      environmentName: "dev",
      hostname: "dev-calm-otter-waves.dev.check.omh.st",
      dnsRecordId: "c".repeat(32),
      routeId: "d".repeat(32),
      publicUrl: "https://dev-calm-otter-waves.dev.check.omh.st",
      observedAt: NOW,
      probe: {
        url: expect.stringMatching(
          /^https:\/\/gateway-probe-[a-f0-9]{24}\.dev\.check\.omh\.st\/health$/u,
        ),
        status: 503,
        observedAt: NOW,
      },
    });
  });

  it("keeps a transient platform-origin probe transport failure pending without fake facts", async () => {
    const fixture = setup({ probeFailure: true });

    await expect(fixture.reconciliation.ensureEnvironment(request())).resolves.toMatchObject({
      status: "pending",
      probe: null,
    });
  });

  it("does not read or refresh customer OAuth authority before platform DNS mutation", async () => {
    const fixture = setup();

    await fixture.reconciliation.ensureEnvironment(request());

    expect(fixture.oauth.refreshAccessToken).not.toHaveBeenCalled();
    expect(fixture.persistence.rotateGrant).not.toHaveBeenCalled();
    expect(fixture.cipher.open).not.toHaveBeenCalled();
  });

  it("rejects a caller-selected route script before decrypting or mutating", async () => {
    const fixture = setup();

    await expect(
      fixture.reconciliation.ensureEnvironment({ ...request(), gatewayScriptName: "attacker" }),
    ).rejects.toBeInstanceOf(CloudflareDomainReconciliationConflictError);

    expect(fixture.cipher.open).not.toHaveBeenCalled();
    expect(fixture.customHostnames.createHostname).not.toHaveBeenCalled();
  });

  it("fails closed when no authorized durable reconciliation state exists", async () => {
    const fixture = setup();
    fixture.persistence.read.mockResolvedValueOnce(null as never);
    await expect(fixture.reconciliation.ensureEnvironment(request())).rejects.toBeInstanceOf(
      CloudflareDomainReconciliationUnavailableError,
    );
  });
});

function setup(
  options: {
    probeStatus?: number;
    probeFailure?: boolean;
  } = {},
) {
  const state = domainState();
  const read = vi.fn(async () => state);
  const rotateGrant = vi.fn(async () => null);
  const persistence = {
    read,
    rotateGrant,
  } satisfies CloudflareDomainReconciliationPersistence;
  const cipher = {
    open: vi.fn(async ({ associatedData }: { associatedData: string }) =>
      associatedData.endsWith(":refresh") ? "refresh-token-secret" : "access-token-secret",
    ),
    seal: vi.fn(async (plaintext: string) => ({
      ciphertext: Buffer.from(`cipher:${plaintext}`).toString("base64"),
      nonce: Buffer.alloc(12, plaintext.startsWith("refreshed-access") ? 1 : 2).toString("base64"),
      keyVersion: 1,
    })),
  };
  const customHostnames = { createHostname: vi.fn() };
  const dns = {
    observeGatewayWildcard: vi.fn(async () => ({ recordId: "c".repeat(32) })),
    reconcileRecords: vi.fn(async (input: { records: readonly CloudflareDesiredDnsRecord[] }) => ({
      status: "applied" as const,
      records: input.records.map((record, index) => ({
        ...record,
        id:
          record.type === "CNAME"
            ? "c".repeat(32)
            : String(index + 1)
                .repeat(32)
                .slice(0, 32),
        proxied: record.proxied,
      })),
    })),
  };
  const routeReceipt = {
    routeId: "d".repeat(32),
    hostname: "dev.check.omh.st",
    scriptName: "ohmyho-gateway-poc-private-fullstack",
    pattern: "*.dev.check.omh.st/*",
    observedAt: new Date(NOW),
  };
  const routes = {
    observePlatformWildcardRoute: vi.fn(async () => routeReceipt),
    createRoute: vi.fn(async () => ({ outcome: "created" as const, receipt: routeReceipt })),
  };
  const oauth = {
    refreshAccessToken: vi.fn(async () => ({
      accessToken: "refreshed-access-token",
      refreshToken: "refreshed-refresh-token",
      expiresInSeconds: 3600,
      scopes: ["dns.write", "zone.read"] as const,
    })),
  };
  const providers = {
    oauth,
    dns,
    customHostnames,
    routes,
    probe: vi.fn(async (input: { origin: string }) => {
      if (!input.origin.startsWith("https://")) throw new TypeError("Invalid probe origin");
      if (options.probeFailure) throw new TypeError("transport unavailable");
      return { status: options.probeStatus ?? 404 };
    }),
  };
  const now = vi
    .fn<() => Date>()
    .mockReturnValueOnce(new Date(NOW))
    .mockReturnValue(new Date(PROBED_AT));
  return {
    persistence,
    cipher,
    customHostnames,
    dns,
    routes,
    oauth,
    providers,
    reconciliation: createCloudflareDomainReconciliation({
      clock: { now },
      platform: {
        zoneId: "a".repeat(32),
        zoneName: "omh.st",
        trafficCnameTarget: "dev.check.omh.st",
      },
      persistence,
      providers: providers as never,
    }),
  };
}

function request() {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    operationId: OPERATION_ID,
    deploymentId: DEPLOYMENT_ID,
    environmentName: "dev",
    gatewayScriptName: "ohmyho-gateway-poc-private-fullstack",
    healthCheckPath: "/health",
  };
}

function domainState() {
  return {
    domains: {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      operationId: OPERATION_ID,
      handle: "calm-otter-waves",
      zoneName: "omh.st" as const,
      productionDomain: "calm-otter-waves.dev.check.omh.st",
      developmentDomain: "dev-calm-otter-waves.dev.check.omh.st",
      mailDomain: "notifications.customer.example",
      configuredByPrincipalId: "user:user_1",
      configuredAt: NOW,
      deletedAt: null,
    },
  };
}
