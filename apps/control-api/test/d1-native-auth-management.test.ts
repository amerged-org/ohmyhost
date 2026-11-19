import { expect, it, vi } from "vitest";
import {
  createD1NativeAuthManagementPort,
  type NativeAuthManagementDependencies,
} from "../src/d1-native-auth-management.js";
import type { NativeAuthManagementPort } from "../src/native-auth-management.js";
import { ENVIRONMENT_ID, ORGANIZATION_ID, PROJECT_ID } from "./helpers/app-routes-fixture.js";

it("persists owner policy with a stable scoped operation identity and reports actual readiness", async () => {
  const config = {
    configurationRevision: 1,
    revocationEpoch: 1,
    enabled: true,
    signupPolicy: "open" as const,
    appName: "Example",
    canonicalOrigin: null,
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
  const updateNativeAuthConfig = vi.fn(async (input: unknown) => {
    void input;
    return config;
  });
  const port = createD1NativeAuthManagementPort({
    catalog: {
      proveNativeAuthUnprovisionedPolicy: async () => false,
      readNativeAuthConfig: async () => config,
      updateNativeAuthConfig,
      readNativeAuthProvider: async () => null,
      updateNativeAuthProvider: async () => {
        throw new Error("unused");
      },
    },
    cipher: {} as NativeAuthManagementDependencies["cipher"],
    applyRealmPolicy: async () => ({ outcome: "applied" }),
    applyProviderPolicy: async () => ({ outcome: "applied" }),
    readReadiness: async () => ({
      canonicalOrigin: null,
      readiness: { paid: true, sender: false, origin: false, storage: false },
    }),
    privateManagement: {} as Omit<
      NativeAuthManagementPort,
      "getConfiguration" | "updateConfiguration"
    >,
  });
  const input = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    principalId: "user:user_1",
    requestId: "request",
    idempotencyKey: "key",
    canonicalRequestDigest: new Uint8Array(),
    body: {
      configurationRevision: 0,
      enabled: true,
      signupPolicy: "open" as const,
      applicationName: "Example",
    },
  };
  const response = await port.updateConfiguration(input);
  await port.updateConfiguration(input);
  expect(response).toMatchObject({
    enabled: true,
    canonicalOrigin: null,
    readiness: { sender: false },
  });
  expect(updateNativeAuthConfig.mock.calls[0]?.[0]).toMatchObject({
    principalId: input.principalId,
    expectedRevision: 0,
    appName: "Example",
  });
  expect(updateNativeAuthConfig.mock.calls[0]?.[0]).toEqual(
    updateNativeAuthConfig.mock.calls[1]?.[0],
  );
});

it("seals provider secrets for the precise realm and forwards only ciphertext to the catalog", async () => {
  const envelope = {
    ciphertext: new Uint8Array(17),
    nonce: new Uint8Array(12),
    valueSha256: new Uint8Array(32),
    keyVersion: 1,
  };
  const encrypt = vi.fn(async (input: unknown) => {
    void input;
    return envelope;
  });
  const updateNativeAuthProvider = vi.fn(async (input: unknown) => {
    void input;
    return {
      provider: "google" as const,
      enabled: true,
      clientId: "client",
      secretPresent: true,
      configurationRevision: 2,
      lastSuccessfulFlowAt: null,
    };
  });
  const applyProviderPolicy = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ outcome: "applied" });
  const port = createD1NativeAuthManagementPort({
    catalog: {
      proveNativeAuthUnprovisionedPolicy: async () => false,
      readNativeAuthConfig: async () => null,
      updateNativeAuthConfig: async () => {
        throw new Error("unused");
      },
      readNativeAuthProvider: async () => ({
        provider: "google" as const,
        enabled: true,
        clientId: "client",
        secretPresent: true,
        configurationRevision: 2,
        lastSuccessfulFlowAt: "2026-10-01T00:00:00.000Z",
      }),
      updateNativeAuthProvider,
    },
    cipher: { encrypt } as unknown as NativeAuthManagementDependencies["cipher"],
    applyRealmPolicy: async () => ({ outcome: "applied" }),
    applyProviderPolicy,
    readReadiness: async () => ({
      canonicalOrigin: "https://app.example.test",
      readiness: { paid: true, sender: true, origin: true, storage: true },
    }),
    privateManagement: {} as Omit<
      NativeAuthManagementPort,
      "getConfiguration" | "updateConfiguration" | "getProvider" | "updateProvider"
    >,
  });
  const request = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    principalId: "user:user_1",
    requestId: "request",
    idempotencyKey: "key",
    canonicalRequestDigest: new Uint8Array(),
    provider: "google" as const,
    body: {
      configurationRevision: 1,
      enabled: true,
      clientId: "client",
      clientSecret: "private-value",
    },
  };
  expect(
    await port.getProvider({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      principalId: "user:user_1",
      requestId: "request",
      provider: "google",
    }),
  ).toMatchObject({ lastSuccessfulFlowAt: "2026-10-01T00:00:00.000Z" });
  await expect(port.updateProvider(request)).rejects.toThrow("unavailable");
  const result = await port.updateProvider(request);
  expect(encrypt).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
      environmentId: ENVIRONMENT_ID,
      value: "private-value",
    }),
  );
  expect(updateNativeAuthProvider).toHaveBeenCalledWith(
    expect.objectContaining({ encryptedSecret: envelope }),
  );
  expect(JSON.stringify(updateNativeAuthProvider.mock.calls)).not.toContain("private-value");
  expect(updateNativeAuthProvider.mock.calls[0]).toEqual(updateNativeAuthProvider.mock.calls[1]);
  expect(result).toMatchObject({
    secretPresent: true,
    callbackUrl: "https://app.example.test/api/auth/v1/callback/google",
  });
});

it("does not acknowledge a pause until the private realm fence succeeds, and retries the same operation", async () => {
  const config = {
    configurationRevision: 2,
    revocationEpoch: 2,
    enabled: false,
    signupPolicy: "open" as const,
    appName: "Example",
    canonicalOrigin: null,
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
  const updateNativeAuthConfig = vi.fn(async (input: unknown) => {
    void input;
    return config;
  });
  const applyRealmPolicy = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ outcome: "applied" });
  const port = createD1NativeAuthManagementPort({
    catalog: {
      proveNativeAuthUnprovisionedPolicy: async () => false,
      readNativeAuthConfig: async () => config,
      updateNativeAuthConfig,
      readNativeAuthProvider: async () => null,
      updateNativeAuthProvider: async () => {
        throw new Error("unused");
      },
    },
    cipher: {} as NativeAuthManagementDependencies["cipher"],
    applyRealmPolicy,
    applyProviderPolicy: async () => ({ outcome: "applied" }),
    readReadiness: async () => ({
      canonicalOrigin: null,
      readiness: { paid: false, sender: false, origin: false, storage: false },
    }),
    privateManagement: {} as Omit<
      NativeAuthManagementPort,
      "getConfiguration" | "updateConfiguration" | "getProvider" | "updateProvider"
    >,
  });
  const input = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    principalId: "user:user_1",
    requestId: "request",
    idempotencyKey: "pause",
    canonicalRequestDigest: new Uint8Array(),
    body: {
      configurationRevision: 1,
      enabled: false,
      signupPolicy: "open" as const,
      applicationName: "Example",
    },
  };
  await expect(port.updateConfiguration(input)).rejects.toThrow("unavailable");
  await expect(port.updateConfiguration(input)).resolves.toMatchObject({
    enabled: false,
    revocationEpoch: 2,
  });
  expect(updateNativeAuthConfig.mock.calls[0]?.[0]).toEqual(
    updateNativeAuthConfig.mock.calls[1]?.[0],
  );
  expect(applyRealmPolicy).toHaveBeenLastCalledWith({
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    configurationRevision: 2,
    revocationEpoch: 2,
    enabled: false,
    canonicalOrigin: null,
  });
});

it("reconciles current Core policy before returning an older replay receipt", async () => {
  const old = {
    configurationRevision: 2,
    revocationEpoch: 2,
    enabled: false,
    signupPolicy: "open" as const,
    appName: "Example",
    canonicalOrigin: null,
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
  const current = { ...old, configurationRevision: 3, enabled: true };
  const prove = vi.fn(async (input: unknown) => {
    void input;
    return false;
  });
  const applyRealmPolicy = vi.fn(async (input: unknown) => {
    void input;
    return { outcome: "applied" as const };
  });
  const port = createD1NativeAuthManagementPort({
    catalog: {
      proveNativeAuthUnprovisionedPolicy: prove,
      readNativeAuthConfig: async () => current,
      updateNativeAuthConfig: async () => old,
      readNativeAuthProvider: async () => null,
      updateNativeAuthProvider: async () => {
        throw new Error("unused");
      },
    },
    cipher: {} as NativeAuthManagementDependencies["cipher"],
    applyRealmPolicy,
    applyProviderPolicy: async () => ({ outcome: "applied" }),
    readReadiness: async () => ({
      canonicalOrigin: null,
      readiness: { paid: false, sender: false, origin: false, storage: false },
    }),
    privateManagement: {} as Omit<
      NativeAuthManagementPort,
      "getConfiguration" | "updateConfiguration" | "getProvider" | "updateProvider"
    >,
  });
  const request = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    principalId: "user:user_1",
    requestId: "request",
    idempotencyKey: "old-pause",
    canonicalRequestDigest: new Uint8Array(),
    body: {
      configurationRevision: 1,
      enabled: false,
      signupPolicy: "open" as const,
      applicationName: "Example",
    },
  };
  const response = await port.updateConfiguration(request);
  expect(response.enabled).toBe(false);
  expect(applyRealmPolicy).toHaveBeenCalledWith(
    expect.objectContaining({ configurationRevision: 3, revocationEpoch: 2, enabled: true }),
  );
  expect(prove).toHaveBeenCalledWith(
    expect.objectContaining({
      principalId: "user:user_1",
      configurationRevision: 3,
      revocationEpoch: 2,
      enabled: true,
    }),
  );
  prove.mockResolvedValueOnce(true);
  expect((await port.updateConfiguration(request)).enabled).toBe(false);
  expect(applyRealmPolicy).toHaveBeenCalledTimes(1);
  for (const malformed of [null, undefined, 1, "true", {}]) {
    prove.mockResolvedValueOnce(malformed as never);
    await expect(port.updateConfiguration(request)).rejects.toThrow(
      "native_auth_policy_unavailable",
    );
    expect(applyRealmPolicy).toHaveBeenCalledTimes(1);
  }
  prove.mockRejectedValueOnce(new Error("authority_unavailable"));
  await expect(port.updateConfiguration(request)).rejects.toThrow("authority_unavailable");
  expect(applyRealmPolicy).toHaveBeenCalledTimes(1);
  applyRealmPolicy.mockRejectedValueOnce(new Error("native_policy_unavailable"));
  await expect(port.updateConfiguration(request)).rejects.toThrow("native_policy_unavailable");
});
