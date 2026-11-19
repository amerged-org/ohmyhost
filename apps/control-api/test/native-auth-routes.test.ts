import { describe, expect, it, vi } from "vitest";
import { createControlApi } from "../src/app.js";
import type { NativeAuthManagementPort } from "../src/native-auth-management.js";
import {
  API,
  BEARER,
  ENVIRONMENT_ID,
  JSON_BEARER,
  PROJECT_ID,
  PRINCIPAL,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

const base = `${API}/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/auth`;
const config = {
  enabled: true,
  configurationRevision: 1,
  revocationEpoch: 1,
  signupPolicy: "open" as const,
  applicationName: "Example",
  allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
  resetPasswordPath: "/reset-password",
  invitationPath: "/accept-invitation",
  canonicalOrigin: "https://app.example.test",
  readiness: { paid: true, sender: true, origin: true, storage: true },
};
const provider = {
  provider: "google" as const,
  enabled: true,
  configured: true,
  clientId: "client",
  secretPresent: true,
  callbackUrl: "https://app.example.test/api/auth/v1/callback/google",
  scopes: ["openid", "email", "profile"],
  lastSuccessfulFlowAt: null,
};

describe("Native Auth owner routes", () => {
  it("passes the authenticated environment and idempotency proof to the private port and never echoes a submitted secret", async () => {
    const updateProvider = vi.fn(async () => provider);
    const port = {
      getConfiguration: async () => config,
      updateProvider,
    } as unknown as NativeAuthManagementPort;
    const app = createControlApi(routeDependencies({ nativeAuthManagement: port }));
    expect(await (await app.request(base, { headers: BEARER })).json()).toEqual(config);
    const response = await app.request(`${base}/providers/google`, {
      method: "PUT",
      headers: { ...JSON_BEARER, "Idempotency-Key": "request-1" },
      body: JSON.stringify({
        configurationRevision: 1,
        enabled: true,
        clientId: "c".repeat(1024),
        clientSecret: "s".repeat(5120),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("s".repeat(5120));
    expect(updateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        principalId: "user:user_1",
        idempotencyKey: "request-1",
        provider: "google",
        body: expect.objectContaining({ clientId: "c".repeat(1024) }),
      }),
    );
    for (const invalid of [
      { clientId: "c".repeat(1025) },
      { clientSecret: "s".repeat(5121) },
      { clientSecret: "ä".repeat(2561) },
    ]) {
      const rejected = await app.request(`${base}/providers/google`, {
        method: "PUT",
        headers: { ...JSON_BEARER, "Idempotency-Key": "oversized-provider" },
        body: JSON.stringify({ configurationRevision: 1, enabled: true, ...invalid }),
      });
      expect(rejected.status).toBe(400);
    }
    expect(updateProvider).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated, denied, malformed and secret-bearing responses without disclosing data", async () => {
    const read = vi.fn(async () => ({ ...provider, clientSecret: "must-not-escape" }));
    const port = { getProvider: read } as unknown as NativeAuthManagementPort;
    const app = createControlApi(routeDependencies({ nativeAuthManagement: port }));
    expect((await app.request(`${base}/providers/google`)).status).toBe(401);
    const denied = createControlApi(
      routeDependencies({
        nativeAuthManagement: port,
        authorization: { check: async () => "deny" },
      }),
    );
    expect((await denied.request(`${base}/providers/google`, { headers: BEARER })).status).toBe(
      404,
    );
    expect(read).not.toHaveBeenCalled();
    const response = await app.request(`${base}/providers/google`, { headers: BEARER });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("must-not-escape");
    expect((await app.request(`${base}/providers/other`, { headers: BEARER })).status).toBe(400);
    expect(
      (
        await app.request(base, {
          method: "PUT",
          headers: JSON_BEARER,
          body: JSON.stringify(config),
        })
      ).status,
    ).toBe(400);
  });

  it("does not call the private port for a foreign environment", async () => {
    const read = vi.fn(async () => config);
    const port = { getConfiguration: read } as unknown as NativeAuthManagementPort;
    const app = createControlApi(
      routeDependencies({
        nativeAuthManagement: port,
        authorization: {
          check: async ({ resource }) =>
            resource.kind === "project" && resource.environmentId === ENVIRONMENT_ID
              ? "allow"
              : "deny",
        },
      }),
    );
    const foreign = `${API}/v1/projects/${PROJECT_ID}/environments/00000000000000000000000006/auth`;
    expect((await app.request(foreign, { headers: BEARER })).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects unsafe configured application paths before a private write", async () => {
    const updateConfiguration = vi.fn(async () => config);
    const app = createControlApi(
      routeDependencies({
        nativeAuthManagement: { updateConfiguration } as unknown as NativeAuthManagementPort,
      }),
    );
    for (const invitationPath of [
      "//evil.example",
      "/a/../login",
      "/%2e%2e/login",
      "/login?token=x",
      "/a\\b",
    ]) {
      const response = await app.request(base, {
        method: "PUT",
        headers: { ...JSON_BEARER, "Idempotency-Key": "config-key" },
        body: JSON.stringify({
          configurationRevision: 1,
          enabled: true,
          signupPolicy: "open",
          applicationName: "Example",
          invitationPath,
        }),
      });
      expect(response.status).toBe(400);
    }
    const invalidOrigin = await app.request(base, {
      method: "PUT",
      headers: { ...JSON_BEARER, "Idempotency-Key": "config-key" },
      body: JSON.stringify({
        configurationRevision: 1,
        enabled: true,
        signupPolicy: "open",
        applicationName: "Example",
        canonicalOrigin: "not-a-url",
      }),
    });
    expect(invalidOrigin.status).toBe(400);
    expect(updateConfiguration).not.toHaveBeenCalled();
  });

  it("returns created user and empty delete only after the scoped private operation succeeds", async () => {
    const user = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "user@example.test",
      status: "pending" as const,
      recoveryAvailable: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const createUser = vi.fn(async () => user),
      deleteUser = vi.fn(async () => {});
    const app = createControlApi(
      routeDependencies({
        nativeAuthManagement: { createUser, deleteUser } as unknown as NativeAuthManagementPort,
      }),
    );
    const created = await app.request(`${base}/users`, {
      method: "POST",
      headers: { ...JSON_BEARER, "Idempotency-Key": "invite-key" },
      body: JSON.stringify({ email: user.email }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(user);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENVIRONMENT_ID, idempotencyKey: "invite-key" }),
    );
    const deleted = await app.request(`${base}/users/${user.id.toUpperCase()}`, {
      method: "DELETE",
      headers: { ...BEARER, "Idempotency-Key": "delete-key" },
    });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(deleteUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        environmentId: ENVIRONMENT_ID,
        idempotencyKey: "delete-key",
      }),
    );
  });

  it("enforces action restrictions independently for Native reads and writes", async () => {
    const getConfiguration = vi.fn(async () => config),
      updateConfiguration = vi.fn(async () => config);
    const authentication = {
      authenticate: async (token: string) =>
        token === "secret-only"
          ? {
              ...PRINCIPAL,
              authorizationRestriction: { actions: ["secrets:read", "secrets:write"] as const },
            }
          : token === "auth-read"
            ? { ...PRINCIPAL, authorizationRestriction: { actions: ["auth:read"] as const } }
            : token === "owner"
              ? PRINCIPAL
              : null,
    };
    const app = createControlApi(
      routeDependencies({
        authentication,
        nativeAuthManagement: {
          getConfiguration,
          updateConfiguration,
        } as unknown as NativeAuthManagementPort,
      }),
    );
    const put = (token: string) =>
      app.request(base, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "key",
        },
        body: JSON.stringify({
          configurationRevision: 1,
          enabled: true,
          signupPolicy: "open",
          applicationName: "Example",
        }),
      });
    expect(
      (await app.request(base, { headers: { Authorization: "Bearer secret-only" } })).status,
    ).toBe(404);
    expect((await put("secret-only")).status).toBe(404);
    expect(
      (await app.request(base, { headers: { Authorization: "Bearer auth-read" } })).status,
    ).toBe(200);
    expect((await put("auth-read")).status).toBe(404);
    expect((await put("owner")).status).toBe(200);
    expect(updateConfiguration).toHaveBeenCalledOnce();
  });
});
