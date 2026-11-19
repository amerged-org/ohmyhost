import { parseUlid, toAuthorizationPrincipal } from "@ohmyhost/platform";
import { parseSafeProblem } from "../../product-cli/src/runtime-contract.js";
import { describe, expect, it, vi } from "vitest";

import { createD1ProjectAuthorization } from "../src/d1-project-application.js";
import {
  createCloudflareDomainManagementPort,
  createControlApi,
  createUnavailableCloudflareDomainManagementPort,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProductSurfacePort,
  createUnavailableProviderReconciliationPort,
  createUnavailableProjectMailDomainsPort,
  type CloudflareDomainAuthorizationCompletion,
  type ControlApiDependencies,
} from "../src/index.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const AUTHORIZATION_ID = parseUlid("00000000000000000000000003");
const OPERATION_ID = parseUlid("00000000000000000000000004");
const EVENT_ID = parseUlid("00000000000000000000000005");
const NOW = "2026-08-29T12:00:00.000Z";
const EXPIRES_AT = "2026-08-29T12:10:00.000Z";
const AUTHORIZATION_URL =
  "https://dash.cloudflare.com/oauth2/auth?client_id=client_1&state=opaque-state";

describe("Control API Cloudflare project domains", () => {
  it("exposes one owner-controlled Paid domain lifecycle without changing Free domains", async () => {
    const planPaidDomain = vi.fn(async () => ({
      status: "planned" as const,
      hostname: "poc.tenant-fixture.com",
      environment: "prod" as const,
      cnameTarget: "customers.omh.st" as const,
      effects: ["Create custom hostname."],
      risks: ["Traffic becomes public."],
    }));
    const active = {
      status: "active" as const,
      hostname: "poc.tenant-fixture.com",
      environment: "prod" as const,
      cnameTarget: "customers.omh.st" as const,
      customHostnameStatus: "active",
      suspensionReason: null,
      sslStatus: "active",
      validationRecords: [
        {
          type: "CNAME" as const,
          name: "poc.tenant-fixture.com",
          content: "customers.omh.st",
          purpose: "traffic" as const,
        },
      ],
      url: "https://poc.tenant-fixture.com",
    };
    const applyPaidDomain = vi.fn(async () => active);
    const getPaidDomain = vi.fn(async () => active);
    const deletePaidDomain = vi.fn(async () => ({
      ...active,
      status: "deleted" as const,
      url: null,
    }));
    const app = createControlApi(
      dependencies({
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          planPaidDomain,
          applyPaidDomain,
          getPaidDomain,
          deletePaidDomain,
        },
      }),
    );
    const headers = { Authorization: "Bearer valid", "Content-Type": "application/json" };
    const body = JSON.stringify({ hostname: "poc.tenant-fixture.com" });
    const plan = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/paid-domain:plan`, {
      method: "POST",
      headers,
      body,
    });
    const apply = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/paid-domain`, {
      method: "PUT",
      headers: { ...headers, "Idempotency-Key": "paid-apply-1" },
      body,
    });
    const status = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/paid-domain`, {
      headers: { Authorization: "Bearer valid" },
    });
    const deleted = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/paid-domain`, {
      method: "DELETE",
      headers: { ...headers, "Idempotency-Key": "paid-delete-1" },
      body,
    });
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({
      status: "planned",
      hostname: "poc.tenant-fixture.com",
      cname_target: "customers.omh.st",
    });
    expect(apply.status).toBe(200);
    expect(await apply.json()).toMatchObject({
      status: "active",
      url: "https://poc.tenant-fixture.com",
    });
    expect(status.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ status: "deleted", url: null });
    expect(applyPaidDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "poc.tenant-fixture.com",
        idempotencyKey: "paid-apply-1",
      }),
    );
    expect(deletePaidDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "poc.tenant-fixture.com",
        idempotencyKey: "paid-delete-1",
      }),
    );
    const invalid = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/paid-domain:plan`,
      { method: "POST", headers, body: JSON.stringify({ hostname: "own.dev.check.omh.st" }) },
    );
    expect(invalid.status).toBe(400);
  });
  it("starts one owner-only customer-zone authorization without exposing credentials", async () => {
    const beginAuthorization = vi.fn(async () => ({
      authorizationId: AUTHORIZATION_ID,
      authorizationUrl: AUTHORIZATION_URL,
      expiresAt: EXPIRES_AT,
    }));
    const authorization = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      dependencies({
        authorization: { check: authorization },
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          beginAuthorization,
        },
      }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/cloudflare-dns/authorization`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "cloudflare-auth-1",
        },
        body: JSON.stringify({ zone: "tenant-fixture.com" }),
      },
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toEqual({
      authorization_id: AUTHORIZATION_ID,
      authorization_url: AUTHORIZATION_URL,
      expires_at: EXPIRES_AT,
    });
    expect(beginAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        principalId: "user:user_1",
        idempotencyKey: "cloudflare-auth-1",
        canonicalRequestDigest: expect.any(Uint8Array),
        zone: "tenant-fixture.com",
      }),
    );
    expect(authorization).toHaveBeenCalledWith(
      expect.objectContaining({ action: "projects:write" }),
    );
  });

  it.each(["aixyte.com", "customer.example"])("reads DNS status for %s", async (zone) => {
    const getStatus = vi.fn(async () => ({
      status: "authorized" as const,
      zone,
      scopes: ["dns.write", "zone.read"] as const,
      expiresAt: EXPIRES_AT,
    }));
    const beginAuthorization = vi.fn();
    const app = createControlApi(
      dependencies({
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          beginAuthorization,
          getStatus,
        },
      }),
    );

    const status = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/cloudflare-dns`, {
      headers: { Authorization: "Bearer valid" },
    });
    const invalid = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/cloudflare-dns/authorization`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "cloudflare-auth-2",
        },
        body: JSON.stringify({ zone: "attacker.dev.check.omh.st" }),
      },
    );

    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      status: "authorized",
      zone,
      scopes: ["dns.write", "zone.read"],
      expires_at: EXPIRES_AT,
    });
    expect(invalid.status).toBe(400);
    expect(beginAuthorization).not.toHaveBeenCalled();
  });

  it("derives and applies the exact three project domains as a durable operation", async () => {
    const configureDomains = vi.fn(async () => operationResult());
    const app = createControlApi(
      dependencies({
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          configureDomains,
        },
      }),
    );

    const response = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/domains`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer valid",
        "Idempotency-Key": "domain-apply-1",
      },
    });

    expect(response.status, await response.clone().text()).toBe(202);
    expect(response.headers.get("location")).toBe(`/v1/operations/${OPERATION_ID}`);
    expect(configureDomains).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        projectHandle: "calm-otter-waves",
        idempotencyKey: "domain-apply-1",
      }),
    );
  });

  it("reports provider rejection without reflecting callback input or completing authorization", async () => {
    const completeAuthorization = vi.fn();
    const app = createControlApi(
      dependencies({
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          completeAuthorization,
        },
      }),
    );
    const response = await app.request(
      "https://api.test/v1/cloudflare/oauth/callback?error=request_forbidden&error_description=private-provider-detail",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "confirmation_invalid",
      detail:
        "Cloudflare refused authorization. Check that the OAuth application is public and that the selected Cloudflare account permits access, then start a fresh authorization.",
      retryable: false,
    });
    expect(completeAuthorization).not.toHaveBeenCalled();
    const malformed = await app.request(
      "https://api.test/v1/cloudflare/oauth/callback?error=request_forbidden&code=provider-code&state=opaque_state-123",
    );
    expect(await malformed.json()).toMatchObject({ code: "invalid_request" });
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("completes only an exact one-time callback without authenticating a product principal", async () => {
    const completeAuthorization = vi.fn(
      async (): Promise<CloudflareDomainAuthorizationCompletion> => "authorized",
    );
    const authenticate = vi.fn();
    const report = vi.fn();
    const app = createControlApi(
      dependencies({
        authentication: { authenticate },
        reporter: { report },
        portalSessionPrincipal: async () => "user:owner",
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          completeAuthorization,
        },
      }),
    );

    const response = await app.request(
      "https://api.test/v1/cloudflare/oauth/callback?code=provider-code&state=opaque_state-123",
    );
    const scoped = await app.request(
      "https://api.test/v1/cloudflare/oauth/callback?code=provider-code-2&state=opaque_state-456&scope=dns.write%20zone.read%20offline_access",
    );
    completeAuthorization.mockResolvedValueOnce("grant_persist_failed");
    const failed = await app.request(
      "https://api.test/v1/cloudflare/oauth/callback?code=provider-code-3&state=opaque_state-789",
    );
    const malformed = await app.request(
      "https://api.test/v1/cloudflare/oauth/callback?code=provider-code&state=opaque_state-123&extra=1",
    );
    const wrongScope = await app.request(
      "https://api.test/v1/cloudflare/oauth/callback?code=provider-code&state=opaque_state-123&scope=dns.write",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const successBody = await response.text();
    expect(successBody).toContain('class="fbrandrow"');
    expect(successBody).not.toContain("provider-code");
    expect(successBody).not.toContain("opaque_state-123");
    expect(response.headers.get("content-security-policy")).toContain("style-src ");
    expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(failed.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(scoped.status).toBe(200);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "service_unavailable", retryable: true });
    expect(completeAuthorization).toHaveBeenNthCalledWith(1, {
      code: "provider-code",
      state: "opaque_state-123",
      principalId: "user:owner",
    });
    expect(completeAuthorization).toHaveBeenNthCalledWith(2, {
      code: "provider-code-2",
      state: "opaque_state-456",
      principalId: "user:owner",
    });
    expect(completeAuthorization).toHaveBeenNthCalledWith(3, {
      code: "provider-code-3",
      state: "opaque_state-789",
      principalId: "user:owner",
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "CLOUDFLARE_OAUTH_GRANT_PERSIST_FAILED",
        route: "/v1/cloudflare/oauth/callback",
      }),
    );
    expect(authenticate).not.toHaveBeenCalled();
    expect(malformed.status).toBe(400);
    expect(wrongScope.status).toBe(400);
    expect(completeAuthorization).toHaveBeenCalledTimes(3);
  });

  it("validates and redacts every private Service Binding result", async () => {
    const secret = "cloudflare-token-canary";
    const getStatus = vi.fn<() => Promise<unknown>>(async () => ({
      status: "authorized",
      zone: "aixyte.com",
      scopes: ["dns.write", "zone.read"],
      expiresAt: EXPIRES_AT,
    }));
    const binding = {
      beginAuthorization: vi.fn(
        async (): Promise<unknown> => ({
          authorizationId: AUTHORIZATION_ID,
          authorizationUrl: AUTHORIZATION_URL,
          expiresAt: EXPIRES_AT,
        }),
      ),
      getStatus,
      configureDomains: vi.fn(async () => operationResult()),
      completeAuthorization: vi.fn(async () => ({ status: "authorized" })),
      planPaidDomain: vi.fn(),
      applyPaidDomain: vi.fn(),
      getPaidDomain: vi.fn(),
      deletePaidDomain: vi.fn(),
    };
    const port = createCloudflareDomainManagementPort(binding);
    const planInput = {
      requestId: "paid-domain-plan-test",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:user_1",
      hostname: "poc.tenant-fixture.com",
    };
    const plan = {
      status: "planned",
      environment: "prod",
      hostname: planInput.hostname,
      cnameTarget: "customers.omh.st",
      effects: ["Create the verified customer hostname"],
      risks: ["DNS validation is required"],
    };
    binding.planPaidDomain.mockResolvedValueOnce(plan);
    await expect(port.planPaidDomain(planInput)).resolves.toEqual(plan);
    binding.planPaidDomain.mockResolvedValueOnce({ ...plan, accessToken: secret });
    await expect(port.planPaidDomain(planInput)).rejects.toThrow("unavailable");

    const conflictApp = createControlApi(dependencies({ cloudflareDomains: port }));
    const waiting = {
      status: "awaiting_deployment",
      suspensionReason: null,
      hostname: "poc.tenant-fixture.com",
      environment: "prod",
      cnameTarget: "customers.omh.st",
      customHostnameStatus: null,
      sslStatus: null,
      validationRecords: [],
      url: null,
    };
    binding.getPaidDomain.mockResolvedValueOnce(waiting);
    const awaiting = await conflictApp.request(
      `https://api.test/v1/projects/${PROJECT_ID}/paid-domain`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(awaiting.status).toBe(200);
    expect(await awaiting.json()).toMatchObject({
      status: "awaiting_deployment",
      hostname: waiting.hostname,
      custom_hostname_status: null,
      ssl_status: null,
      validation_records: [],
      url: null,
    });
    for (const invalid of [
      { hostname: null },
      { customHostnameStatus: "pending" },
      { sslStatus: "active" },
      { url: `https://${waiting.hostname}` },
      {
        validationRecords: [
          {
            type: "CNAME",
            name: waiting.hostname,
            content: waiting.cnameTarget,
            purpose: "traffic",
          },
        ],
      },
    ]) {
      binding.getPaidDomain.mockResolvedValueOnce({ ...waiting, ...invalid });
      const malformed = await conflictApp.request(
        `https://api.test/v1/projects/${PROJECT_ID}/paid-domain`,
        { headers: { Authorization: "Bearer valid" } },
      );
      expect(malformed.status).toBe(503);
    }
    binding.getPaidDomain.mockResolvedValueOnce({
      status: "suspended",
      suspensionReason: "paid_plan_required",
      hostname: "poc.tenant-fixture.com",
      environment: "prod",
      cnameTarget: "customers.omh.st",
      customHostnameStatus: "active",
      sslStatus: "active",
      validationRecords: [
        {
          type: "CNAME",
          name: "poc.tenant-fixture.com",
          content: "customers.omh.st",
          purpose: "traffic",
        },
      ],
      url: null,
    });
    const suspended = await conflictApp.request(
      `https://api.test/v1/projects/${PROJECT_ID}/paid-domain`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({
      status: "suspended",
      suspension_reason: "paid_plan_required",
      ssl_status: "active",
      url: null,
    });
    binding.applyPaidDomain.mockResolvedValueOnce({
      status: "payment_required",
      code: "project_budget_exceeded",
    });
    const budgetDenied = await conflictApp.request(
      `https://api.test/v1/projects/${PROJECT_ID}/paid-domain`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "budget-denied",
        },
        body: JSON.stringify({ hostname: "poc.tenant-fixture.com" }),
      },
    );
    expect(budgetDenied.status).toBe(402);
    const deniedBody = await budgetDenied.json();
    expect(deniedBody).toMatchObject({ code: "project_budget_exceeded", retryable: false });
    expect(deniedBody.detail).not.toContain("build");
    for (const method of ["PUT", "DELETE"]) {
      binding.applyPaidDomain.mockResolvedValueOnce({
        status: "conflict",
        code: "idempotency_key_reused",
      });
      binding.deletePaidDomain.mockResolvedValueOnce({
        status: "conflict",
        code: "idempotency_key_reused",
      });
      const conflict = await conflictApp.request(
        `https://api.test/v1/projects/${PROJECT_ID}/paid-domain`,
        {
          method,
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/json",
            "Idempotency-Key": "retired-key",
          },
          body: JSON.stringify({ hostname: "poc.tenant-fixture.com" }),
        },
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        code: "idempotency_key_reused",
        retryable: false,
      });
    }
    const paidDomainRequest = (
      app: ReturnType<typeof createControlApi>,
      method: "POST" | "PUT" | "DELETE",
    ) =>
      app.request(
        `https://api.test/v1/projects/${PROJECT_ID}/paid-domain${method === "POST" ? ":plan" : ""}`,
        {
          method,
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/json",
            ...(method === "POST" ? {} : { "Idempotency-Key": `undeployed-${method}` }),
          },
          body: JSON.stringify({ hostname: "poc.tenant-fixture.com" }),
        },
      );
    const undeployed = { status: "conflict", code: "production_deployment_required" };
    for (const mock of [binding.planPaidDomain, binding.applyPaidDomain, binding.deletePaidDomain])
      mock.mockReset();
    binding.planPaidDomain.mockResolvedValueOnce(undeployed);
    binding.applyPaidDomain.mockResolvedValueOnce(undeployed);
    for (const method of ["POST", "PUT"] as const) {
      const response = await paidDomainRequest(conflictApp, method);
      expect(response.status).toBe(409);
      const problem = await response.json();
      expect(problem).toMatchObject({
        code: "production_deployment_required",
        title: "Production deployment required",
        retryable: false,
      });
      expect(problem.suggested_action).toContain("--environment prod");
      expect(problem.suggested_action).toContain("deployment promote plan");
      expect(parseSafeProblem(problem)).toMatchObject({
        code: "production_deployment_required",
        retryable: false,
      });
    }
    for (const method of ["PUT", "DELETE"] as const) {
      const rpc = method === "PUT" ? binding.applyPaidDomain : binding.deletePaidDomain;
      rpc.mockResolvedValueOnce({ status: "conflict", code: "domain_dns_conflict" });
      const response = await paidDomainRequest(conflictApp, method);
      expect(response.status).toBe(409);
      expect(parseSafeProblem(await response.json())).toMatchObject({
        code: "domain_dns_conflict",
        retryable: false,
      });
    }
    // A hostname held by another project, or not yet proven by this one, is a named apply conflict.
    for (const code of [
      "domain_hostname_taken",
      "domain_ownership_required",
      "domain_already_configured",
      "domain_deleting",
    ] as const) {
      binding.applyPaidDomain.mockResolvedValueOnce({ status: "conflict", code });
      const response = await paidDomainRequest(conflictApp, "PUT");
      expect(response.status).toBe(409);
      expect(parseSafeProblem(await response.json())).toMatchObject({ code, retryable: false });
    }
    // A delete meets another connection of the project, or a deletion already running, under its own name.
    for (const code of ["domain_already_configured", "domain_deleting"] as const) {
      binding.deletePaidDomain.mockResolvedValueOnce({ status: "conflict", code });
      const response = await paidDomainRequest(conflictApp, "DELETE");
      expect(response.status).toBe(409);
      expect(parseSafeProblem(await response.json())).toMatchObject({ code, retryable: false });
    }
    // Only plan and apply carry the prerequisite; any other or widened reply stays unavailable.
    binding.deletePaidDomain.mockResolvedValueOnce(undeployed);
    binding.planPaidDomain.mockResolvedValueOnce({ ...undeployed, projectId: PROJECT_ID });
    binding.applyPaidDomain.mockRejectedValueOnce(new Error("Paid domain target is unavailable"));
    for (const method of ["DELETE", "POST", "PUT"] as const) {
      const response = await paidDomainRequest(conflictApp, method);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "service_unavailable" });
    }
    const base = dependencies();
    const foreignApp = createControlApi(
      dependencies({
        cloudflareDomains: port,
        persistence: { ...base.persistence, getProject: async () => null },
      }),
    );
    const calls =
      binding.planPaidDomain.mock.calls.length + binding.applyPaidDomain.mock.calls.length;
    for (const method of ["POST", "PUT"] as const)
      expect((await paidDomainRequest(foreignApp, method)).status).toBe(404);
    expect(
      binding.planPaidDomain.mock.calls.length + binding.applyPaidDomain.mock.calls.length,
    ).toBe(calls);

    await expect(
      port.beginAuthorization({
        ...scope(),
        idempotencyKey: "cloudflare-auth-1",
        canonicalRequestDigest: new Uint8Array(32).fill(1),
        zone: "aixyte.com",
      }),
    ).resolves.toEqual({
      authorizationId: AUTHORIZATION_ID,
      authorizationUrl: AUTHORIZATION_URL,
      expiresAt: EXPIRES_AT,
    });
    const authorizationConflictApp = createControlApi(dependencies({ cloudflareDomains: port }));
    for (const [reply, code] of [
      [{ status: "authorization_closed" }, "cloudflare_authorization_closed"],
      [{ status: "conflict", code: "idempotency_key_reused" }, "idempotency_key_reused"],
      [{ status: "conflict", code: "cloudflare_zone_not_bound" }, "cloudflare_zone_not_bound"],
    ] as const) {
      binding.beginAuthorization.mockResolvedValueOnce(reply);
      const conflict = await authorizationConflictApp.request(
        `https://api.test/v1/projects/${PROJECT_ID}/cloudflare-dns/authorization`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/json",
            "Idempotency-Key": "closed-customer-auth",
          },
          body: JSON.stringify({ zone: "aixyte.com" }),
        },
      );
      expect(conflict.status).toBe(409);
      const problem = await conflict.json();
      expect(problem).toMatchObject({ code, retryable: false });
      expect(parseSafeProblem(problem).code).toBe(code);
      if (code === "cloudflare_authorization_closed")
        expect(problem.suggested_action).toContain("DNS status");
      if (code === "cloudflare_zone_not_bound") {
        expect(problem.suggested_action).toContain("domain paid plan");
        expect(problem.suggested_action).toContain("domain paid apply");
      }
      expect(JSON.stringify(problem)).not.toContain(secret);
    }
    binding.beginAuthorization.mockResolvedValueOnce({
      authorizationId: AUTHORIZATION_ID,
      authorizationUrl:
        "https://user:password@dash.cloudflare.com/oauth2/auth?client_id=client_1&state=opaque-state",
      expiresAt: EXPIRES_AT,
    });
    await expect(
      port.beginAuthorization({
        ...scope(),
        idempotencyKey: "cloudflare-auth-userinfo",
        canonicalRequestDigest: new Uint8Array(32).fill(3),
        zone: "aixyte.com",
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      port.configureDomains({
        ...scope(),
        idempotencyKey: "domain-apply-1",
        canonicalRequestDigest: new Uint8Array(32).fill(2),
        projectHandle: "calm-otter-waves",
      }),
    ).resolves.toEqual(operationResult());
    await expect(
      port.completeAuthorization({
        code: "provider-code",
        state: "opaque_state-123",
        principalId: "user:owner",
      }),
    ).resolves.toBe("authorized");

    await expect(port.getStatus(scope())).resolves.toEqual({
      status: "authorized",
      zone: "aixyte.com",
      scopes: ["dns.write", "zone.read"],
      expiresAt: EXPIRES_AT,
    });
    getStatus.mockResolvedValueOnce({
      status: "authorized",
      zone: "aixyte.com",
      scopes: ["dns.write", "zone.read"],
      expiresAt: EXPIRES_AT,
      token: secret,
    });
    await expect(port.getStatus(scope())).rejects.not.toThrow(secret);
    getStatus.mockRejectedValueOnce(new Error(secret));
    await expect(port.getStatus(scope())).rejects.not.toThrow(secret);
    getStatus.mockResolvedValueOnce({
      status: "not_authorized",
      zone: null,
      scopes: [],
      expiresAt: null,
    });
    const absent = await conflictApp.request(
      `https://api.test/v1/projects/${PROJECT_ID}/cloudflare-dns`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({
      status: "not_authorized",
      zone: null,
      scopes: [],
      expires_at: null,
    });
    getStatus.mockResolvedValueOnce({
      status: "not_authorized",
      zone: "aixyte.com",
      scopes: [],
      expiresAt: null,
    });
    await expect(port.getStatus(scope())).rejects.toThrow("unavailable");
    // The consenting owner lost write authority: the zone is named and nothing stays usable.
    getStatus.mockResolvedValueOnce({
      status: "reauthorization_required",
      zone: "aixyte.com",
      scopes: [],
      expiresAt: null,
    });
    await expect(port.getStatus(scope())).resolves.toEqual({
      status: "reauthorization_required",
      zone: "aixyte.com",
      scopes: [],
      expiresAt: null,
    });
  });

  it("rejects authorization URLs with user information at the HTTP response boundary", async () => {
    const app = createControlApi(
      dependencies({
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          beginAuthorization: async () => ({
            authorizationId: AUTHORIZATION_ID,
            authorizationUrl:
              "https://user:password@dash.cloudflare.com/oauth2/auth?client_id=client_1&state=opaque-state",
            expiresAt: EXPIRES_AT,
          }),
        },
      }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/cloudflare-dns/authorization`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "cloudflare-auth-userinfo",
        },
        body: JSON.stringify({ zone: "aixyte.com" }),
      },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("user:password");
  });

  it("refuses a principal without project write authority before any configure replay can reach the private binding", async () => {
    const configureDomains = vi.fn(async () => operationResult());
    const authorization = vi.fn(async () => "deny" as const);
    const app = createControlApi(
      dependencies({
        authorization: { check: authorization },
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          configureDomains,
        },
      }),
    );
    const response = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/domains`, {
      method: "PUT",
      headers: { Authorization: "Bearer valid", "Idempotency-Key": "domain-replay-stranger" },
    });
    expect(response.status).toBe(404);
    expect(authorization).toHaveBeenCalled();
    expect(configureDomains).not.toHaveBeenCalled();
  });

  it("answers a renamed handle refused by the private binding as its own 409 conflict, never a 503 or an idempotency conflict", async () => {
    const unused = vi.fn();
    const binding = {
      beginAuthorization: unused,
      getStatus: unused,
      completeAuthorization: unused,
      planPaidDomain: unused,
      applyPaidDomain: unused,
      getPaidDomain: unused,
      deletePaidDomain: unused,
      configureDomains: vi.fn(async () => ({
        status: "conflict",
        code: "project_domains_conflict",
      })),
    };
    const port = createCloudflareDomainManagementPort(binding);
    await expect(
      port.configureDomains({
        ...scope(),
        idempotencyKey: "domain-apply-2",
        canonicalRequestDigest: new Uint8Array(32).fill(4),
        projectHandle: "calm-otter-waves",
      }),
    ).rejects.toMatchObject({
      name: "ProductSurfaceConflictError",
      reason: "project_domains_conflict",
    });
    const app = createControlApi(
      dependencies({
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          configureDomains: port.configureDomains,
        },
      }),
    );
    const response = await app.request(`https://api.test/v1/projects/${PROJECT_ID}/domains`, {
      method: "PUT",
      headers: { Authorization: "Bearer valid", "Idempotency-Key": "domain-apply-2" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "project_domains_conflict",
      retryable: false,
    });
  });

  it("keeps the absent private binding fail-closed", async () => {
    await expect(
      createUnavailableCloudflareDomainManagementPort().getStatus(scope()),
    ).rejects.toThrow("unavailable");
  });

  it("refuses a machine principal at every route that begins a Cloudflare authorization", async () => {
    // A callback completes only for the user who started the authorization, so a state started by a machine
    // principal could never be finished. The production authorization adapter denies every non-user principal
    // before the begin ports run, even when the Core would allow the action.
    const machine = {
      actorId: "service:client_1",
      credentialId: "workos_token:token_1",
      authorizationPrincipal: toAuthorizationPrincipal({
        kind: "m2m_service",
        clientId: "client_1",
      }),
      organizationIds: [ORGANIZATION_ID],
      authorizationScopeConstraint: ["projects:write", "mail-domains:admin"] as const,
    };
    const person = {
      actorId: "user:user_1",
      credentialId: "workos_session:session_1",
      authorizationPrincipal: toAuthorizationPrincipal({ kind: "workos_user", userId: "user_1" }),
      organizationIds: [ORGANIZATION_ID],
    };
    const mailDomainId = "01H00000000000000000000602";
    const routes = [
      [
        `/v1/projects/${PROJECT_ID}/cloudflare-dns/authorization`,
        { zone: "aixyte.com" },
        "project",
      ],
      [
        `/v1/projects/${PROJECT_ID}/application-domain-identity/dns-authorization`,
        { expected_revision: 1, zone: "example.com" },
        "identity",
      ],
      [
        `/v1/organizations/${ORGANIZATION_ID}/mail-domains/${mailDomainId}/dns-authorization`,
        { expected_revision: 1, zone: "example.com" },
        "mail",
      ],
    ] as const;
    const attempt = async (principal: typeof machine | typeof person) => {
      const coreDecision = vi.fn(async () => "allow" as const);
      const begun = { project: vi.fn(), identity: vi.fn(), mail: vi.fn() };
      for (const spy of Object.values(begun))
        spy.mockResolvedValue({
          authorizationId: AUTHORIZATION_ID,
          authorizationUrl: AUTHORIZATION_URL,
          expiresAt: EXPIRES_AT,
        });
      const app = createControlApi(
        dependencies({
          authentication: { authenticate: async () => principal },
          authorization: createD1ProjectAuthorization({
            authorizeOrganizationAction: coreDecision,
          } as never),
          cloudflareDomains: {
            ...createUnavailableCloudflareDomainManagementPort(),
            beginAuthorization: begun.project,
          },
          sharedMailIdentity: {
            beginApplicationIdentityAuthorization: begun.identity,
            beginWorkspaceMailAuthorization: begun.mail,
          } as never,
        }),
      );
      const statuses: number[] = [];
      for (const [path, body] of routes) {
        const response = await app.request(`https://api.test${path}`, {
          method: "POST",
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/json",
            "Idempotency-Key": "begin-1",
          },
          body: JSON.stringify(body),
        });
        statuses.push(response.status);
      }
      return { statuses, begun, coreDecision };
    };

    const machineAttempt = await attempt(machine);
    expect(machineAttempt.statuses).toEqual([404, 404, 404]);
    expect(machineAttempt.coreDecision).not.toHaveBeenCalled();
    for (const spy of Object.values(machineAttempt.begun)) expect(spy).not.toHaveBeenCalled();

    // The same requests are valid: a person reaches every begin port.
    const personAttempt = await attempt(person);
    for (const spy of Object.values(personAttempt.begun)) expect(spy).toHaveBeenCalledOnce();
  });
});

function scope() {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    principalId: "user:user_1",
    requestId: "req_cloudflare_domains",
  } as const;
}

function operationResult() {
  return {
    status: 202 as const,
    location: `/v1/operations/${OPERATION_ID}`,
    body: {
      id: OPERATION_ID,
      state: "queued",
      created_at: NOW,
      updated_at: NOW,
    },
  };
}

function dependencies(overrides: Partial<ControlApiDependencies> = {}): ControlApiDependencies {
  return {
    authentication: {
      authenticate: async () => ({
        actorId: "user:user_1",
        credentialId: "workos_session:session_1",
        authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
        organizationIds: [ORGANIZATION_ID],
      }),
    },
    authorization: { check: async () => "allow" },
    persistence: {
      submitFeedback: async () => {
        throw new Error("Unused feedback fixture");
      },
      readFeedbackStatus: async () => {
        throw new Error("Unused feedback fixture");
      },
      listProjects: async () => ({ projects: [], nextCursor: null }),
      takenProjectHandles: async () => new Set<string>(),
      createProject: async () => {
        throw new Error("unused");
      },
      getProject: async (organizationId, projectId) => ({
        dataMode: "shared" as const,
        region: "us" as const,
        organizationId,
        projectId,
        name: "fixture",
        handle: "calm-otter-waves",
        createdAt: NOW,
      }),
      getOperation: async () => null,
      readAuditEvents: async () => ({ events: [], nextCursor: null }),
    },
    productSurface: createUnavailableProductSurfacePort(),
    providerReconciliation: createUnavailableProviderReconciliationPort(),
    environmentSecrets: createUnavailableEnvironmentSecretsPort(),
    projectMailDomains: createUnavailableProjectMailDomainsPort(),
    cloudflareDomains: createUnavailableCloudflareDomainManagementPort(),
    devAccessTickets: {
      issue: async () => {
        throw new Error("unused");
      },
    },
    clock: { now: () => new Date(NOW) },
    ids: { next: () => EVENT_ID },
    allowedOrigins: new Set(),
    applicationId: "control-api-test",
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    requestId: () => "req_cloudflare_domains",
    ...overrides,
  };
}
