import { expect, test } from "vitest";
import { createIntegrationOriginObserver } from "../src/integration-origin-observer.js";

test("original API key and browser session are reobserved for each owner operation", async () => {
  const organizationId = "01K00000000000000000000001";
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
      authorizationRestriction: {
        actions: ["integrations:manage"],
        organizationIds: [organizationId],
      },
    },
  };
  let active = true,
    keyActive = true;
  const observer = createIntegrationOriginObserver({
    sessionStatus: {
      async isActive() {
        return active;
      },
    },
    apiKeyStatus: {
      async observe() {
        return keyActive
          ? {
              id: "api_key_owner",
              userId: "user_owner",
              organizationId: "org_owner",
              permissions: ["integrations:manage"],
              expiresAt: null,
            }
          : null;
      },
    },
    resolveOrganization: async () => organizationId,
    now: () => new Date("2026-11-16T00:00:00Z"),
  } as never);
  await expect(observer.observeConnectionOrigin(actor)).resolves.toBeUndefined();
  await expect(
    observer.observeIntegrationMutation({
      resourceKind: "organization",
      organizationId,
      principalId: actor.principalId,
      mutationAuthority: {
        kind: "mcp",
        grantId: "00000000-0000-4000-8000-000000000001",
        clientId: "client",
        consentHash: "a".repeat(64),
        action: "integrations:manage",
      },
    }),
  ).resolves.toBeUndefined();

  keyActive = false;
  await expect(observer.observeConnectionOrigin(actor)).rejects.toThrow(
    "integration_origin_denied",
  );
  keyActive = true;
  active = false;
  await expect(observer.observeConnectionOrigin(actor)).rejects.toThrow(
    "integration_origin_denied",
  );
});
