import { parseUlid } from "@ohmyhost/platform";

import type { AuthenticatedPrincipal } from "../src/contracts.js";
import { expect, test } from "vitest";
import { createIntegrationManagement } from "../src/integrations.js";

test("a consent link preserves the original scoped key and never stores the opaque link", async () => {
  const organizationId = "01K00000000000000000000001",
    projectId = "01K00000000000000000000002",
    environmentId = "01K00000000000000000000003";
  let created: Record<string, unknown> = {};
  const store = {
    async createIntegrationPortalHandoff(value: unknown) {
      created = value as Record<string, unknown>;
      return "created" as const;
    },
    async readIntegrationPortalHandoff() {
      return {
        userId: "user_owner",
        organizationId,
        projectId,
        environmentId,
        registration: "make-development-1",
        expiresAt: "2030-01-01T00:00:00Z",
      };
    },
    async consumeIntegrationPortalHandoff() {
      return null;
    },
    async readIntegrationPortalStatus() {
      return null;
    },
  };
  const port = createIntegrationManagement({
    origin: "https://dev.app.ohmyho.st",
    secret: "x".repeat(32),
    registration: "make-development-1",
    resolveOrganization: async () => organizationId,
    store,
    readiness: async () => true,
    delegation: async () => null,
  });
  const principal = {
    actorId: "user:user_owner",
    authorizationPrincipal: { kind: "user" },
    credentialId: "api_key_owner",
    userApiKey: {
      id: "api_key_owner",
      userId: "user_owner",
      organizationId: "org_owner",
      permissions: ["integrations:manage"],
      expiresAt: null,
    },
  } as unknown as AuthenticatedPrincipal;
  const result = await port.begin({
    organizationId,
    projectId,
    environmentId,
    principal,
    idempotencyKey: "same",
  });
  expect(created).toMatchObject({
    principalId: "user:user_owner",
    originatingCredential: { kind: "api_key", keyId: "api_key_owner" },
  });
  expect(JSON.stringify(created)).not.toContain(new URL(result.url).searchParams.get("request"));
  await expect(
    port.begin({
      organizationId,
      projectId,
      environmentId,
      principal: { ...principal, authorizationRestriction: { projectIds: [parseUlid(projectId)] } },
      idempotencyKey: "same",
    }),
  ).rejects.toThrow("integration_origin_denied");
});

test("management returns bounded metadata, preserves caller authority and never returns provider secrets", async () => {
  const organizationId = "01K00000000000000000000001",
    projectId = "01K00000000000000000000002",
    environmentId = "01K00000000000000000000003",
    grantId = "01K00000000000000000000004";
  const principal = {
    actorId: "user:user_owner",
    authorizationPrincipal: { kind: "user" },
    session: {
      sessionId: "session_owner",
      userId: "user_owner",
      organizationId: "org_context",
      tokenExpiresAt: 2000000000,
    },
  } as unknown as AuthenticatedPrincipal;
  let observed: unknown;
  let observedCatalog: unknown;
  let observedImport: unknown;
  let observedAction: unknown;
  const importId = "01K00000000000000000000005";
  const store = {
    async createMakeActionBinding(value: unknown) {
      observedAction = value;
      return { bindingId: (value as { bindingId: string }).bindingId };
    },
    async createConnectionImport(value: unknown) {
      observedImport = value;
      return { importId };
    },
    async createIntegrationPortalHandoff() {
      return "created" as const;
    },
    async readIntegrationPortalHandoff() {
      return null;
    },
    async consumeIntegrationPortalHandoff() {
      return null;
    },
    async readIntegrationPortalStatus() {
      return {
        organizationId,
        userId: "user_owner",
        state: "pending",
        expiresAt: "2030-01-01T00:00:00Z",
      };
    },
    async listConnectionGrantMetadata() {
      return [
        {
          grantId,
          provider: "make",
          state: "active",
          createdAt: "2030-01-01T00:00:00Z",
          token: "private",
        },
      ];
    },
  };
  const broker = {
    async listConnectionCatalog(value: unknown) {
      observedCatalog = value;
      return {
        organizations: [{ id: 1, name: "Org", token: "private" }],
        teams: [{ id: 2, name: "Team" }],
        connections: [{ id: 3, name: "CRM", token: "private" }],
      };
    },
    async disconnectConnectionGrant(input: unknown) {
      observed = input;
      return { state: "disconnected" as const };
    },
  };
  const port = createIntegrationManagement({
    origin: "https://dev.app.ohmyho.st",
    secret: "x".repeat(32),
    registration: "make-development-1",
    resolveOrganization: async () => organizationId,
    store,
    broker,
    readiness: async () => true,
    catalogReadiness: async () => true,
    delegation: async () => null,
  });
  expect(await port.availability()).toEqual({ available: true, catalogAvailable: true });
  if (!port.list || !port.catalog || !port.disconnect || !port.importConnection)
    throw new Error("Missing management methods");
  if (!port.bindMakeAction) throw new Error("Missing action binding");
  const bind = {
    organizationId,
    principal,
    projectId,
    environmentId,
    importId,
    idempotencyKey: "bind-mail",
    action: {
      kind: "endpoint" as const,
      appName: "microsoft-email",
      appVersion: 2,
      endpointName: "listMessages",
    },
  };
  const binding = await port.bindMakeAction(bind);
  expect(binding?.execution_key).toMatch(/^omh_make_v1\./u);
  expect(await port.bindMakeAction(bind)).toEqual(binding);
  expect(observedAction).toMatchObject({
    projectId,
    importId,
    environmentId,
    action: bind.action,
    capabilityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  expect(JSON.stringify(observedAction)).not.toContain(binding?.execution_key);
  const listed = await port.list({ organizationId, principal });
  expect(listed.connections).toEqual([
    { id: grantId, provider: "make", state: "active", created_at: "2030-01-01T00:00:00Z" },
  ]);
  expect(
    JSON.stringify(
      await port.catalog({
        organizationId,
        projectId,
        environmentId,
        grantId,
        principalId: principal.actorId,
      }),
    ),
  ).not.toContain("private");
  const selection = {
    organizationId,
    principal,
    grantId,
    projectId,
    environmentId,
    providerOrganizationId: 1,
    teamId: 2,
    connectionId: 3,
    idempotencyKey: "import-one",
  };
  expect(await port.importConnection({ ...selection, connectionId: 404 })).toBeNull();
  expect(observedImport).toBeUndefined();
  expect(await port.importConnection(selection)).toEqual({
    id: importId,
    grant_id: grantId,
    project_id: projectId,
    environment_id: environmentId,
    provider_organization_id: 1,
    team_id: 2,
    connection_id: 3,
  });
  expect(observedCatalog).toEqual({
    organizationId,
    principalId: principal.actorId,
    grantId,
    providerOrganizationId: 1,
    teamId: 2,
  });
  expect(observedImport).toMatchObject({
    organizationId,
    principalId: principal.actorId,
    grantId,
    projectId,
    environmentId,
    connectionId: 3,
    mutationAuthority: { kind: "session", sessionId: "session_owner" },
  });
  expect(await port.status({ organizationId, requestId: "a".repeat(64), principal })).toEqual({
    state: "pending",
    expires_at: "2030-01-01T00:00:00Z",
  });
  expect(
    await port.disconnect({ organizationId, principal, grantId, idempotencyKey: "one" }),
  ).toEqual({ state: "disconnected" });
  expect(observed).toMatchObject({
    principalId: "user:user_owner",
    mutationAuthority: { kind: "session", sessionId: "session_owner" },
  });
});
