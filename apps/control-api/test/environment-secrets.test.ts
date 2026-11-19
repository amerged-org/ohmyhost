import { parseUlid, type AuthorizationCheck } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import {
  IdempotencyKeyReusedError,
  EnvironmentSecretMutationBlockedError,
  EnvironmentSecretNotInstalledError,
  EnvironmentSecretsUnavailableError,
  createControlApi,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProviderReconciliationPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  type ControlApiDependencies,
  type EnvironmentSecretsPort,
} from "../src/index.js";
import { createRemoteOhmyhostMcpHandler } from "../src/remote-mcp.js";
import type { McpPortalAccess } from "../src/remote-mcp-access.js";
import { runtimeSecretDeliveryMetadata } from "../src/environment-secrets.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const ENVIRONMENT_ID = parseUlid("00000000000000000000000003");
const EVENT_ID = parseUlid("00000000000000000000000004");
const NOW = "2026-08-20T12:00:00.000Z";
const metadata = Object.freeze({
  name: "DATABASE_URL",
  revision: 2,
  keyVersion: 1,
  createdAt: "2026-08-20T11:00:00.000Z",
  updatedAt: NOW,
});
const delivery = Object.freeze({
  desiredGeneration: 2,
  appliedGeneration: 1,
  state: "pending" as const,
  runtimeProvider: "wfp" as const,
  appliedSecretCount: 1,
  lastError: null,
});
const deliveryBody = Object.freeze({
  desired_generation: 2,
  applied_generation: 1,
  delivery_state: "pending",
  runtime_provider: "wfp",
  applied_secret_count: 1,
  last_error: null,
});

describe("runtime secret delivery metadata", () => {
  const applied = Object.freeze({
    desiredGeneration: 5,
    appliedGeneration: 5,
    runtimeProvider: "wfp" as const,
    manifestSecretCount: 3,
  });

  it("keeps applied secrets ready without a stale error after a later candidate delivery failure", () => {
    // Customers read ready plus an error as a degraded secret; a ready secret reports no error.
    expect(
      runtimeSecretDeliveryMetadata({
        ...applied,
        lastFailureCode: "WFP_RUNTIME_SECRET_RESULT_UNCERTAIN",
      }),
    ).toEqual({
      desiredGeneration: 5,
      appliedGeneration: 5,
      state: "ready",
      runtimeProvider: "wfp",
      appliedSecretCount: 3,
      lastError: null,
    });
  });

  it("reports pending and failed only while a newer generation is undelivered", () => {
    expect(runtimeSecretDeliveryMetadata({ ...applied, desiredGeneration: 6 })).toMatchObject({
      state: "pending",
      lastError: null,
    });
    expect(
      runtimeSecretDeliveryMetadata({
        ...applied,
        desiredGeneration: 6,
        lastFailureCode: "WFP_RUNTIME_SECRET_RESULT_UNCERTAIN",
      }),
    ).toMatchObject({ state: "failed", lastError: "WFP_RUNTIME_SECRET_RESULT_UNCERTAIN" });
    expect(runtimeSecretDeliveryMetadata(undefined)).toEqual({
      desiredGeneration: 0,
      appliedGeneration: 0,
      state: "not_deployed",
      runtimeProvider: null,
      appliedSecretCount: 0,
      lastError: null,
    });
    expect(runtimeSecretDeliveryMetadata({ ...applied, runtimeProvider: undefined })).toMatchObject(
      { state: "not_deployed" },
    );
  });
});

describe("Control API function runs", () => {
  const run = Object.freeze({
    id: parseUlid("00000000000000000000000021"),
    deployment_id: parseUlid("00000000000000000000000022"),
    cron: "*/5 * * * *",
    scheduled_at: "2026-09-15T14:30:00.000Z",
    state: "succeeded" as const,
    attempt: 1,
    status_code: 204,
    started_at: "2026-09-15T14:30:32.306Z",
    finished_at: "2026-09-15T14:30:34.262Z",
  });
  const url = `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/function-runs`;

  it("lists the newest runs of one environment through the logs authorization", async () => {
    const list = vi.fn(async () => ({ items: [run] }));
    const checks: AuthorizationCheck[] = [];
    const app = createControlApi(
      dependencies({
        authorization: {
          async check(input) {
            checks.push(input);
            return "allow";
          },
        },
        functionRuns: { list },
      }),
    );

    const response = await app.request(url, { headers: { Authorization: "Bearer valid" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [run] });
    expect(checks).toContainEqual({
      principal: { kind: "user", subjectId: "user:user_1" },
      resource: {
        kind: "project",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
      },
      action: "logs:read",
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        limit: 50,
      }),
    );
  });

  it("reports canonical authorized results but never a denied request", async () => {
    const results: Array<{ accountId: string | null; organizationId: string; status: number }> = [];
    const app = createControlApi(
      dependencies({
        growthProductResult: (result) => results.push(result),
        functionRuns: { list: async () => ({ items: [] }) },
      }),
    );
    expect((await app.request(url, { headers: { Authorization: "Bearer valid" } })).status).toBe(
      200,
    );
    expect(results).toEqual([
      { accountId: "user_1", organizationId: ORGANIZATION_ID, status: 200 },
    ]);
    const denied = createControlApi(
      dependencies({
        growthProductResult: (result) => results.push(result),
        authorization: { check: async () => "deny" },
        functionRuns: { list: async () => ({ items: [] }) },
      }),
    );
    expect((await denied.request(url, { headers: { Authorization: "Bearer valid" } })).status).toBe(
      404,
    );
    expect(results).toHaveLength(1);
    const connected = {
      actorId: "user:user_1",
      credentialId: "workos_connect:test",
      authorizationPrincipal: { kind: "user" as const, subjectId: "user:user_1" as const },
      organizationIds: [ORGANIZATION_ID],
      connectUser: {
        issuer: "https://issuer.test",
        audience: ["https://api.test/mcp"],
        clientId: "unmapped",
        userId: "user_1",
        workosOrganizationId: null,
        consentId: "consent",
        tokenId: null,
        tokenExpiresAt: 2_000_000_000,
      },
    };
    const remote = createControlApi(
      dependencies({
        growthProductResult: (result) => results.push(result),
        internalAuthentication: {
          resolve: async () => connected,
          revalidate: async () => connected,
        },
        remoteAuthorization: async () => true,
        functionRuns: {
          list: async () => {
            throw new Error("unavailable");
          },
        },
      }),
    );
    expect((await remote.request(url)).status).toBe(503);
    expect(results.at(-1)).toEqual({
      accountId: "user_1",
      organizationId: ORGANIZATION_ID,
      status: 503,
    });
    const priorResults = results.length;
    const handler = createRemoteOhmyhostMcpHandler({
      endpoint: "https://api.test/mcp",
      authorizationServers: ["https://issuer.test"],
      access: { origin: "https://api.test" } as McpPortalAccess,
      authenticate: async () => connected,
      dispatch: async (request) => remote.fetch(request),
    });
    try {
      const response = await handler.fetch(
        new Request("https://api.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: "Bearer signed-test",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "project_status", arguments: { project_id: PROJECT_ID } },
          }),
        }),
      );
      expect(response?.status).toBe(200);
      expect(await response?.text()).toContain("isError");
      expect(results).toHaveLength(priorResults + 1);
      expect(results.at(-1)).toEqual({
        accountId: "user_1",
        organizationId: ORGANIZATION_ID,
        status: 404,
      });
    } finally {
      await handler.close();
    }
  });

  it("accepts only a bounded limit and fails closed without the port", async () => {
    const list = vi.fn(async () => ({ items: [] }));
    const app = createControlApi(dependencies({ functionRuns: { list } }));
    const headers = { Authorization: "Bearer valid" };

    expect((await app.request(`${url}?limit=2`, { headers })).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 2 }));
    for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?cursor=x", "?limit=1&limit=2"]) {
      expect((await app.request(`${url}${query}`, { headers })).status).toBe(400);
    }
    expect(list).toHaveBeenCalledTimes(1);

    const unavailable = createControlApi(dependencies());
    expect((await unavailable.request(url, { headers })).status).toBe(503);
  });

  it("denies a foreign principal without disclosing the environment", async () => {
    const list = vi.fn(async () => ({ items: [run] }));
    const app = createControlApi(
      dependencies({ authorization: { check: async () => "deny" }, functionRuns: { list } }),
    );

    const response = await app.request(url, { headers: { Authorization: "Bearer valid" } });

    expect(response.status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("Control API environment secrets", () => {
  it("fails closed when the environment-secret storage port is unavailable", async () => {
    const unavailable = createUnavailableEnvironmentSecretsPort();

    await expect(
      unavailable.list({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        principalId: "user:user_1",
        requestId: "req_unavailable",
      }),
    ).rejects.toBeInstanceOf(EnvironmentSecretsUnavailableError);
  });

  it("lists metadata through an exact environment-scoped authorization check", async () => {
    const list = vi.fn(async () => ({ items: [metadata], delivery }));
    const checks: AuthorizationCheck[] = [];
    const app = createControlApi(
      dependencies({
        authorization: {
          async check(input) {
            checks.push(input);
            return "allow";
          },
        },
        environmentSecrets: { ...createUnavailableEnvironmentSecretsPort(), list },
      }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets`,
      { headers: { Authorization: "Bearer valid" } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      items: [
        {
          name: "DATABASE_URL",
          revision: 2,
          key_version: 1,
          created_at: "2026-08-20T11:00:00.000Z",
          updated_at: NOW,
          ...deliveryBody,
        },
      ],
      ...deliveryBody,
    });
    expect(checks).toContainEqual({
      principal: { kind: "user", subjectId: "user:user_1" },
      resource: {
        kind: "project",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
      },
      action: "secrets:read",
    });
    expect(JSON.stringify(body)).not.toContain("ciphertext");
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
      }),
    );
  });

  it("stores a write-only value with an idempotency digest and returns metadata only", async () => {
    const put = vi.fn(async () => ({ ...metadata, ...delivery, name: "API_KEY" }));
    const app = createControlApi(
      dependencies({ environmentSecrets: { ...createUnavailableEnvironmentSecretsPort(), put } }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets/API_KEY`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "secret-database-url-1",
        },
        body: JSON.stringify({ value: "postgres://private" }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      name: "API_KEY",
      revision: 2,
      key_version: 1,
      created_at: "2026-08-20T11:00:00.000Z",
      updated_at: NOW,
      ...deliveryBody,
    });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "API_KEY",
        value: "postgres://private",
        idempotencyKey: "secret-database-url-1",
        canonicalRequestDigest: expect.any(Uint8Array),
      }),
    );
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("returns a stable retryable conflict while a deployment owns the project mutation fence", async () => {
    const put = vi.fn(async () => {
      throw new EnvironmentSecretMutationBlockedError();
    });
    const app = createControlApi(
      dependencies({ environmentSecrets: { ...createUnavailableEnvironmentSecretsPort(), put } }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets/API_KEY`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "blocked-during-deploy",
        },
        body: JSON.stringify({ value: "must-not-leak" }),
      },
    );

    expect(response.status).toBe(409);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      code: "environment_secret_mutation_blocked",
      retryable: true,
    });
    expect(body).not.toContain("must-not-leak");
  });

  it.each([
    "DATABASE_URL",
    "HYPERDRIVE",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "OHMYHOST_MAIL_KEY",
    "OHMYHOST_MAIL_GATEWAY_URL",
    "OHMYHOST_AI_KEY",
    "OHMYHOST_AI_BASE_URL",
    "OHMYHOST_STORAGE_KEY",
    "OHMYHOST_PROJECT_ID",
    "OHMYHOST_CUSTOM_COLLISION",
    "ASSETS",
  ])("rejects setting reserved platform secret %s before storage", async (name) => {
    const put = vi.fn();
    const remove = vi.fn();
    const app = createControlApi(
      dependencies({
        environmentSecrets: { ...createUnavailableEnvironmentSecretsPort(), put, remove },
      }),
    );
    for (const method of ["PUT"]) {
      const response = await app.request(
        `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets/${name}`,
        {
          method,
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/json",
            "Idempotency-Key": `reserved-${name}-${method}`,
          },
          ...(method === "PUT" ? { body: JSON.stringify({ value: "forbidden" }) } : {}),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ detail: "Secret name is reserved." });
    }
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns an indistinguishable 404 for denied environment access without invoking storage", async () => {
    const put = vi.fn();
    const app = createControlApi(
      dependencies({
        authorization: {
          check: async (input) => (input.action === "secrets:write" ? "deny" : "allow"),
        },
        environmentSecrets: { ...createUnavailableEnvironmentSecretsPort(), put },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets/API_KEY`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "secret-api-key-1",
        },
        body: JSON.stringify({ value: "private" }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "resource_not_found" });
    expect(put).not.toHaveBeenCalled();
  });

  it("validates names and values and maps idempotency conflicts without leaking input", async () => {
    const put = vi.fn(async () => {
      throw new IdempotencyKeyReusedError();
    });
    const app = createControlApi(
      dependencies({ environmentSecrets: { ...createUnavailableEnvironmentSecretsPort(), put } }),
    );
    const base = `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets`;
    const invalid = await app.request(`${base}/lowercase`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
        "Idempotency-Key": "invalid-name",
      },
      body: JSON.stringify({ value: "private" }),
    });
    expect(invalid.status).toBe(400);
    expect(put).not.toHaveBeenCalled();

    const oversizedUtf8 = await app.request(`${base}/API_KEY`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
        "Idempotency-Key": "oversized-value",
      },
      body: JSON.stringify({ value: "€".repeat(1_707) }),
    });
    expect(oversizedUtf8.status).toBe(400);
    expect(put).not.toHaveBeenCalled();

    const conflict = await app.request(`${base}/API_KEY`, {
      method: "PUT",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
        "Idempotency-Key": "same-key",
      },
      body: JSON.stringify({ value: "must-not-leak" }),
    });
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.text();
    expect(JSON.parse(conflictBody)).toMatchObject({ code: "idempotency_key_reused" });
    expect(conflictBody).not.toContain("must-not-leak");
  });

  it("rotates an installed platform key through its own route and returns metadata only", async () => {
    const rotate = vi.fn(async () => ({ ...metadata, ...delivery, name: "OHMYHOST_AI_KEY" }));
    const app = createControlApi(
      dependencies({
        environmentSecrets: { ...createUnavailableEnvironmentSecretsPort(), rotate },
      }),
    );
    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets/OHMYHOST_AI_KEY/rotate`,
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": "rotate-ai-key-1" },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      name: "OHMYHOST_AI_KEY",
      revision: 2,
      key_version: 1,
      created_at: "2026-08-20T11:00:00.000Z",
      updated_at: NOW,
      ...deliveryBody,
    });
    expect(rotate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "OHMYHOST_AI_KEY",
        idempotencyKey: "rotate-ai-key-1",
        canonicalRequestDigest: expect.any(Uint8Array),
      }),
    );
    expect(JSON.stringify(body)).not.toContain("ciphertext");
  });

  it("refuses to rotate a name that is not an installed platform key, and reports an absent one as not found", async () => {
    const rotate = vi.fn(async () => {
      throw new EnvironmentSecretNotInstalledError();
    });
    const app = createControlApi(
      dependencies({
        environmentSecrets: { ...createUnavailableEnvironmentSecretsPort(), rotate },
      }),
    );
    const base = `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets`;
    for (const name of ["API_KEY", "OHMYHOST_AI_BASE_URL", "DATABASE_URL"]) {
      const refused = await app.request(`${base}/${name}/rotate`, {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": `refuse-${name}` },
      });
      expect(refused.status, name).toBe(400);
    }
    expect(rotate).not.toHaveBeenCalled();

    const absent = await app.request(`${base}/OHMYHOST_MAIL_KEY/rotate`, {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Idempotency-Key": "rotate-absent" },
    });
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ code: "resource_not_found" });
  });

  it("returns an idempotent deletion result and advertises PUT through CORS", async () => {
    const remove = vi.fn(async ({ name }: { name: string }) => ({
      name,
      status: "absent" as const,
      ...delivery,
    }));
    const app = createControlApi(
      dependencies({
        environmentSecrets: { ...createUnavailableEnvironmentSecretsPort(), remove },
      }),
    );
    const path = `/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets/API_KEY`;
    const response = await app.request(`https://api.test${path}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer valid", "Idempotency-Key": "delete-api-key-1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "API_KEY",
      status: "absent",
      ...deliveryBody,
    });

    const preflight = await app.request(`https://api.test${path}`, {
      method: "OPTIONS",
      headers: { Origin: "https://app.ohmyho.st" },
    });
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
    const base = `https://api.test/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/secrets/`;
    for (const name of [
      "DATABASE_URL",
      "OHMYHOST_ASSETS",
      "OHMYHOST_CUSTOM_COLLISION",
      "OHMYHOST_AI_BASE_URL",
    ]) {
      const cleared = await app.request(base + name, {
        method: "DELETE",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": `cleanup-${name}` },
      });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({ name, status: "absent" });
    }
    expect(remove).toHaveBeenCalledTimes(5);
    for (const name of [
      "BETTER_AUTH_SECRET",
      "OHMYHOST_STORAGE_KEY",
      "OHMYHOST_MAIL_KEY",
      "OHMYHOST_AI_KEY",
    ]) {
      const protectedSecret = await app.request(base + name, {
        method: "DELETE",
        headers: { Authorization: "Bearer valid", "Idempotency-Key": `protected-${name}` },
      });
      expect(protectedSecret.status).toBe(400);
      expect(await protectedSecret.json()).toMatchObject({ detail: "Secret name is reserved." });
    }
    expect(remove).toHaveBeenCalledTimes(5);
  });
});

function dependencies(overrides: Partial<ControlApiDependencies> = {}): ControlApiDependencies {
  const environmentSecrets: EnvironmentSecretsPort = createUnavailableEnvironmentSecretsPort();
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
    environmentSecrets,
    projectMailDomains: createUnavailableProjectMailDomainsPort(),
    devAccessTickets: overrides.devAccessTickets ?? {
      issue: async () => {
        throw new Error("unused");
      },
    },
    clock: { now: () => new Date(NOW) },
    ids: { next: () => EVENT_ID },
    allowedOrigins: new Set(["https://app.ohmyho.st"]),
    applicationId: "control-api-test",
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    requestId: () => "req_environment_secrets",
    ...overrides,
  };
}
