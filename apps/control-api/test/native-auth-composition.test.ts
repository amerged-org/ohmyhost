import { expect, it, vi } from "vitest";
import { createNativeAuthManagementComposition } from "../src/native-auth-composition.js";
import type { NativeAuthManagementDependencies } from "../src/d1-native-auth-management.js";
import { ENVIRONMENT_ID, ORGANIZATION_ID, PROJECT_ID } from "./helpers/app-routes-fixture.js";

it("composes scoped Core readiness and private administration without treating uncertain delivery as success", async () => {
  const config = {
    configurationRevision: 1,
    revocationEpoch: 1,
    enabled: true,
    signupPolicy: "open" as const,
    appName: "Example",
    canonicalOrigin: "https://app.example.test",
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
  const readNativeAuthReadiness = vi.fn(async (input: unknown) => {
    void input;
    return {
      paid: true,
      sender: true,
      origin: true,
      storage: false,
    };
  });
  const applyRealmPolicy = vi.fn(async () => ({ outcome: "applied" as const }));
  const applyProviderPolicy = vi.fn(async () => ({ outcome: "applied" as const }));
  const acceptNativeUserOperation = vi.fn(async () => ({ outcome: "accepted" as const }));
  const provider = {
    provider: "google" as const,
    enabled: true,
    clientId: "client",
    secretPresent: true,
    configurationRevision: 2,
    lastSuccessfulFlowAt: null,
  };
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "user@example.test",
    status: "active" as const,
    recoveryAvailable: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const port = createNativeAuthManagementComposition({
    catalog: {
      proveNativeAuthUnprovisionedPolicy: async () => false,
      readNativeAuthConfig: async () => config,
      updateNativeAuthConfig: async () => config,
      readNativeAuthProvider: async () => provider,
      updateNativeAuthProvider: async () => provider,
      readNativeAuthReadiness,
      acceptNativeUserOperation,
    },
    admin: {
      applyRealmPolicy,
      applyProviderPolicy,
      listUsers: async () => [user],
      getUser: async () => user,
      mutateUser: async () => ({
        userId: "00000000-0000-4000-8000-000000000001",
        action: "create-invite",
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          email: "user@example.test",
          status: "pending",
          recoveryAvailable: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
      deliverInvitation: async () => ({ status: "uncertain" }),
    },
    cipher: {} as NativeAuthManagementDependencies["cipher"],
  });
  const scope = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    principalId: "user:user_1",
    requestId: "request",
  };
  expect(await port.getConfiguration(scope)).toMatchObject({
    readiness: { storage: false },
    canonicalOrigin: config.canonicalOrigin,
  });
  expect(readNativeAuthReadiness).toHaveBeenCalledWith({
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    principalId: scope.principalId,
  });
  expect(await port.listUsers({ ...scope, limit: 1 })).toMatchObject({
    items: [user],
    nextCursor: null,
  });
  expect(await port.getUser({ ...scope, userId: user.id })).toMatchObject(user);
  const write = { ...scope, idempotencyKey: "config", canonicalRequestDigest: new Uint8Array(32) };
  await port.updateConfiguration({
    ...write,
    body: {
      configurationRevision: 0,
      enabled: true,
      signupPolicy: "open",
      applicationName: "Example",
    },
  });
  expect(applyRealmPolicy).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      revocationEpoch: 1,
    }),
  );
  await port.updateProvider({
    ...write,
    provider: "google",
    body: { configurationRevision: 1, enabled: true },
  });
  expect(applyProviderPolicy).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      provider: "google",
      configurationRevision: 2,
    }),
  );
  await expect(
    port.createUser({
      ...scope,
      email: "user@example.test",
      idempotencyKey: "key",
      canonicalRequestDigest: new Uint8Array(32),
    }),
  ).rejects.toThrow("native_mail_unavailable");
  acceptNativeUserOperation.mockRejectedValueOnce(new Error("idempotency_key_reused"));
  await expect(
    port.createUser({
      ...scope,
      email: "user@example.test",
      idempotencyKey: "key",
      canonicalRequestDigest: new Uint8Array(32),
    }),
  ).rejects.toMatchObject({ code: "idempotency" });
});
