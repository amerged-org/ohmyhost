import { describe, expect, it } from "vitest";
import { createControlApi } from "../src/app.js";
import {
  createD1NativeAuthManagementPort,
  type NativeAuthManagementDependencies,
} from "../src/d1-native-auth-management.js";
import { createNativeAuthManagementComposition } from "../src/native-auth-composition.js";
import {
  NativeAuthManagementError,
  type NativeAuthManagementPort,
} from "../src/native-auth-management.js";
import {
  API,
  ENVIRONMENT_ID,
  JSON_BEARER,
  ORGANIZATION_ID,
  PROJECT_ID,
  recordingReporter,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

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
const provider = {
  provider: "google" as const,
  enabled: true,
  clientId: "client",
  secretPresent: true,
  configurationRevision: 2,
  lastSuccessfulFlowAt: null,
};
const write = {
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  principalId: "user:user_1",
  requestId: "request",
  idempotencyKey: "key",
  canonicalRequestDigest: new Uint8Array(),
};
const unused = () => {
  throw new Error("unused");
};

/** Core refusals reach the Control API as plain errors whose message is the Core code. */
function portWithCoreRefusal(code: string) {
  return createD1NativeAuthManagementPort({
    catalog: {
      proveNativeAuthUnprovisionedPolicy: async () => false,
      readNativeAuthConfig: async () => config,
      updateNativeAuthConfig: async () => {
        throw new Error(code);
      },
      readNativeAuthProvider: async () => provider,
      updateNativeAuthProvider: async () => {
        throw new Error(code);
      },
    },
    cipher: {} as NativeAuthManagementDependencies["cipher"],
    applyRealmPolicy: async () => ({ outcome: "applied" }),
    applyProviderPolicy: async () => ({ outcome: "applied" }),
    readReadiness: async () => ({
      canonicalOrigin: null,
      readiness: { paid: true, sender: true, origin: true, storage: true },
    }),
    privateManagement: {} as Omit<
      NativeAuthManagementPort,
      "getConfiguration" | "updateConfiguration"
    >,
  });
}

describe("Core Native Auth refusals become typed management refusals", () => {
  it.each([
    ["native_auth_launch_unavailable", "launch_unavailable"],
    ["native_auth_origin_unapproved", "origin_unapproved"],
    ["native_auth_paths_invalid", "paths_invalid"],
    ["native_auth_epoch_exhausted", "epoch_exhausted"],
  ])("maps the configuration refusal %s to %s", async (core, refusal) => {
    const port = portWithCoreRefusal(core);
    const error = await port
      .updateConfiguration({
        ...write,
        body: {
          configurationRevision: 1,
          enabled: true,
          signupPolicy: "open",
          applicationName: "Example",
        },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAuthManagementError);
    expect(error).toMatchObject({ code: refusal });
  });

  it("maps a provider refusal to a typed provider_unavailable refusal", async () => {
    const port = portWithCoreRefusal("native_auth_provider_unavailable");
    const error = await port
      .updateProvider({
        ...write,
        provider: "google",
        body: { configurationRevision: 1, enabled: true },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAuthManagementError);
    expect(error).toMatchObject({ code: "provider_unavailable" });
  });

  it("answers a launch refusal as a non-retryable 409 problem, never a 503 secret-storage failure", async () => {
    const recorded = recordingReporter();
    const port = {
      updateProvider: async () => {
        throw new NativeAuthManagementError("provider_unavailable");
      },
    } as unknown as NativeAuthManagementPort;
    const app = createControlApi(
      routeDependencies({ nativeAuthManagement: port, reporter: recorded.reporter }),
    );
    const response = await app.request(
      `${API}/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/auth/providers/google`,
      {
        method: "PUT",
        headers: { ...JSON_BEARER, "Idempotency-Key": "provider-refusal" },
        body: JSON.stringify({ configurationRevision: 1, enabled: true }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "native_auth_provider_unavailable",
      retryable: false,
    });
    expect(recorded.reports).toEqual([]);
  });

  it("maps Native Auth user-management runtime refusals by their stable message codes", async () => {
    const composition = createNativeAuthManagementComposition({
      catalog: {
        proveNativeAuthUnprovisionedPolicy: async () => false,
        readNativeAuthConfig: async () => config,
        updateNativeAuthConfig: unused,
        readNativeAuthProvider: async () => provider,
        updateNativeAuthProvider: unused,
        readNativeAuthReadiness: async () => ({
          paid: true,
          sender: true,
          origin: true,
          storage: true,
        }),
        acceptNativeUserOperation: async () => ({ outcome: "accepted" as const }),
      },
      admin: {
        applyRealmPolicy: async () => ({ outcome: "applied" as const }),
        applyProviderPolicy: async () => ({ outcome: "applied" as const }),
        listUsers: async () => [],
        getUser: async () => {
          throw new Error("native_user_not_found");
        },
        mutateUser: async () => {
          throw new Error("native_user_email_exists");
        },
        deliverInvitation: async () => ({ status: "accepted" as const }),
      },
      cipher: {} as NativeAuthManagementDependencies["cipher"],
    });
    const userId = "00000000-0000-4000-8000-000000000001";
    await expect(composition.getUser({ ...write, userId })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      composition.createUser({
        ...write,
        canonicalRequestDigest: new Uint8Array(32),
        email: "user@example.test",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("answers an unknown user as 404 and a duplicate invitation as a 409 conflict problem", async () => {
    const port = {
      userAction: async () => {
        throw new NativeAuthManagementError("not_found");
      },
      createUser: async () => {
        throw new NativeAuthManagementError("conflict");
      },
    } as unknown as NativeAuthManagementPort;
    const app = createControlApi(routeDependencies({ nativeAuthManagement: port }));
    const base = `${API}/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/auth/users`;
    const suspended = await app.request(`${base}/00000000-0000-4000-8000-000000000001/suspend`, {
      method: "POST",
      headers: { ...JSON_BEARER, "Idempotency-Key": "suspend" },
      body: "{}",
    });
    expect(suspended.status).toBe(404);
    expect(await suspended.json()).toMatchObject({ code: "resource_not_found" });
    const invited = await app.request(base, {
      method: "POST",
      headers: { ...JSON_BEARER, "Idempotency-Key": "invite" },
      body: JSON.stringify({ email: "user@example.test" }),
    });
    expect(invited.status).toBe(409);
    expect(await invited.json()).toMatchObject({ code: "native_user_conflict", retryable: false });
  });

  it("answers a stale configurationRevision as a non-retryable 409 revision conflict, never a 400", async () => {
    const port = {
      updateConfiguration: async () => {
        throw new NativeAuthManagementError("revision");
      },
      updateProvider: async () => {
        throw new NativeAuthManagementError("revision");
      },
    } as unknown as NativeAuthManagementPort;
    const app = createControlApi(routeDependencies({ nativeAuthManagement: port }));
    const base = `${API}/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/auth`;
    const configuration = await app.request(base, {
      method: "PUT",
      headers: { ...JSON_BEARER, "Idempotency-Key": "stale-configuration" },
      body: JSON.stringify({
        configurationRevision: 1,
        enabled: false,
        signupPolicy: "open",
        applicationName: "Example",
      }),
    });
    expect(configuration.status).toBe(409);
    expect(await configuration.json()).toMatchObject({
      code: "native_auth_revision_conflict",
      retryable: false,
    });
    const provider = await app.request(`${base}/providers/google`, {
      method: "PUT",
      headers: { ...JSON_BEARER, "Idempotency-Key": "stale-provider" },
      body: JSON.stringify({ configurationRevision: 1, enabled: false }),
    });
    expect(provider.status).toBe(409);
    expect(await provider.json()).toMatchObject({
      code: "native_auth_revision_conflict",
      retryable: false,
    });
  });

  it("answers an enable without its client secret as a non-retryable 409 provider-incomplete conflict", async () => {
    const error = await portWithCoreRefusal("native_auth_provider_incomplete")
      .updateProvider({
        ...write,
        provider: "google",
        body: { configurationRevision: 1, enabled: true },
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "provider_incomplete" });
    const app = createControlApi(
      routeDependencies({
        nativeAuthManagement: {
          updateProvider: async () => {
            throw new NativeAuthManagementError("provider_incomplete");
          },
        } as unknown as NativeAuthManagementPort,
      }),
    );
    const response = await app.request(
      `${API}/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/auth/providers/google`,
      {
        method: "PUT",
        headers: { ...JSON_BEARER, "Idempotency-Key": "incomplete-provider" },
        body: JSON.stringify({ configurationRevision: 1, enabled: true }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "native_auth_provider_incomplete",
      retryable: false,
    });
  });
});
