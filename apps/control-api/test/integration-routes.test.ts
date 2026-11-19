import { expect, it, vi } from "vitest";
import { createControlApi } from "../src/index.js";
import type { IntegrationManagementPort } from "../src/integrations.js";
import {
  API,
  BEARER,
  FOREIGN_ORGANIZATION_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  ENVIRONMENT_ID,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

it("starts only an authorized human handoff when a complete provider port is available", async () => {
  const begin = vi.fn<IntegrationManagementPort["begin"]>(async () => ({
    request_id: "a".repeat(64),
    url: `${API}/connections/authorize?request=${"b".repeat(43)}`,
    expires_at: "2026-11-09T15:00:00Z",
  }));
  const app = createControlApi(
    routeDependencies({
      integrations: {
        availability: async () => ({ available: true }),
        begin,
        status: async () => null,
      },
    }),
  );
  const response = await app.request(
    `${API}/v1/organizations/${ORGANIZATION_ID}/connections/begin`,
    {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json", "idempotency-key": "same-request" },
      body: JSON.stringify({
        provider: "make",
        project_id: PROJECT_ID,
        environment_id: ENVIRONMENT_ID,
      }),
    },
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    request_id: "a".repeat(64),
    url: `${API}/connections/authorize?request=${"b".repeat(43)}`,
    expires_at: "2026-11-09T15:00:00Z",
  });
  expect(begin).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      idempotencyKey: "same-request",
    }),
  );
  const workspace = await app.request(
    `${API}/v1/organizations/${ORGANIZATION_ID}/connections/begin`,
    {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json", "idempotency-key": "workspace" },
      body: JSON.stringify({ provider: "make" }),
    },
  );
  expect(workspace.status).toBe(201);
  const request = begin.mock.lastCall?.[0];
  expect(request).toMatchObject({ organizationId: ORGANIZATION_ID, idempotencyKey: "workspace" });
  expect(request).not.toHaveProperty("projectId");
  expect(request).not.toHaveProperty("environmentId");
  begin.mockRejectedValueOnce(new Error("integration_idempotency_conflict"));
  const conflict = await app.request(
    `${API}/v1/organizations/${ORGANIZATION_ID}/connections/begin`,
    {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json", "idempotency-key": "same-request" },
      body: JSON.stringify({
        provider: "make",
        project_id: PROJECT_ID,
        environment_id: ENVIRONMENT_ID,
      }),
    },
  );
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: "idempotency_key_reused" });
});

it("discovers a workspace grant and authorizes import against the separate destination", async () => {
  const list = vi.fn(async () => ({ connections: [] }));
  const catalog = vi.fn<NonNullable<IntegrationManagementPort["catalog"]>>(async () => ({
    organizations: [],
    teams: [],
    connections: [],
  }));
  const disconnect = vi.fn(async () => ({ state: "disconnected" as const }));
  const grant = "01K00000000000000000000004";
  const selection = {
    project_id: PROJECT_ID,
    environment_id: ENVIRONMENT_ID,
    provider_organization_id: 1,
    team_id: 2,
    connection_id: 3,
  };
  const imported = { id: "01K00000000000000000000005", grant_id: grant, ...selection };
  const importConnection = vi.fn(async () => imported);
  const app = createControlApi(
    routeDependencies({
      integrations: {
        availability: async () => ({ available: true }),
        begin: async () => {
          throw Error();
        },
        status: async () => null,
        list,
        catalog,
        disconnect,
        importConnection,
      },
    }),
  );
  const base = `${API}/v1/organizations/${ORGANIZATION_ID}/connections`;
  expect((await app.request(base, { headers: BEARER })).status).toBe(200);
  expect((await app.request(`${base}?scope=workspace`, { headers: BEARER })).status).toBe(200);
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceOnly: true }));
  expect(
    (
      await app.request(
        `${base}/${grant}/catalog?project_id=${PROJECT_ID}&environment_id=${ENVIRONMENT_ID}&provider_organization_id=1&team_id=2`,
        { headers: BEARER },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(
        `${base}/${grant}/catalog?project_id=${PROJECT_ID}&environment_id=${ENVIRONMENT_ID}&provider_organization_id=0`,
        { headers: BEARER },
      )
    ).status,
  ).toBe(400);
  expect(catalog).toHaveBeenCalledWith(
    expect.objectContaining({ grantId: grant, providerOrganizationId: 1, teamId: 2 }),
  );
  expect(
    (
      await app.request(`${base}/${grant}/catalog?provider_organization_id=1&team_id=2`, {
        headers: BEARER,
      })
    ).status,
  ).toBe(200);
  expect(catalog.mock.lastCall?.[0]).not.toHaveProperty("projectId");
  expect(
    (
      await app.request(`${base}/${grant}/catalog?project_id=${PROJECT_ID}`, {
        headers: BEARER,
      })
    ).status,
  ).toBe(400);
  const importRequest = (body: unknown) =>
    app.request(`${base}/${grant}/imports`, {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json", "idempotency-key": "one-import" },
      body: JSON.stringify(body),
    });
  const write = await importRequest(selection);
  expect(write.status).toBe(201);
  expect(await write.json()).toEqual(imported);
  expect(importConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      grantId: grant,
      connectionId: 3,
    }),
  );
  expect((await importRequest({ ...selection, connection_id: "3" })).status).toBe(400);
  expect(importConnection).toHaveBeenCalledTimes(1);
  expect(
    (
      await app.request(`${base}/${grant}`, {
        method: "DELETE",
        headers: { ...BEARER, "idempotency-key": "disconnect" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`${API}/v1/organizations/${FOREIGN_ORGANIZATION_ID}/connections`, {
        headers: BEARER,
      })
    ).status,
  ).toBe(404);
  expect(list).toHaveBeenCalledTimes(2);
});

it("authorizes a session's other current workspace without widening restricted or non-owner callers", async () => {
  const { PRINCIPAL } = await import("./helpers/app-routes-fixture.js");
  const target = FOREIGN_ORGANIZATION_ID;
  const original = {
    ...PRINCIPAL,
    session: {
      sessionId: "session_1",
      userId: "user_1",
      organizationId: "org_selected",
      tokenExpiresAt: 2000000000,
    },
  };
  const begin = vi.fn(async () => ({
    request_id: "a".repeat(64),
    url: `${API}/connections/authorize?request=${"b".repeat(43)}`,
    expires_at: "2026-11-09T15:00:00Z",
  }));
  const makeApp = (principal: typeof original, organizations: string[], owner: boolean) => {
    const base = routeDependencies();
    return createControlApi(
      routeDependencies({
        authentication: { authenticate: async () => principal },
        accountProfile: { read: async () => ({ organization_ids: organizations }) } as never,
        authorization: {
          check: async ({ action, resource }) =>
            resource.organizationId === target && (action !== "integrations:manage" || owner)
              ? "allow"
              : "deny",
        },
        persistence: {
          ...base.persistence,
          getProject: async (organizationId, projectId) =>
            organizationId === target && projectId === PROJECT_ID
              ? {
                  organizationId,
                  projectId,
                  name: "Target",
                  handle: "target",
                  dataMode: "shared",
                  region: "us",
                  createdAt: "2026-01-01T00:00:00.000Z",
                }
              : null,
        },
        integrations: {
          availability: async () => ({ available: true }),
          begin,
          status: async () => null,
        },
      }),
    );
  };
  const request = () =>
    new Request(`${API}/v1/organizations/${target}/connections/begin`, {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json", "idempotency-key": "one" },
      body: JSON.stringify({
        provider: "make",
        project_id: PROJECT_ID,
        environment_id: ENVIRONMENT_ID,
      }),
    });
  expect((await makeApp(original, [ORGANIZATION_ID, target], true).fetch(request())).status).toBe(
    201,
  );
  expect(
    (
      await makeApp(
        { ...original, authorizationRestriction: { organizationIds: [ORGANIZATION_ID] } },
        [ORGANIZATION_ID, target],
        true,
      ).fetch(request())
    ).status,
  ).toBe(404);
  expect((await makeApp(original, [ORGANIZATION_ID, target], false).fetch(request())).status).toBe(
    404,
  );
  expect((await makeApp(original, [ORGANIZATION_ID], true).fetch(request())).status).toBe(404);
  expect(
    (
      await makeApp(
        {
          ...original,
          userApiKey: {
            id: "api_key_1",
            userId: "user_1",
            organizationId: "org_selected",
            permissions: ["integrations:manage"],
            expiresAt: null,
          },
        },
        [ORGANIZATION_ID, target],
        true,
      ).fetch(request())
    ).status,
  ).toBe(404);
  expect(
    (
      await makeApp(
        { ...original, session: { ...original.session, userId: "user_other" } },
        [ORGANIZATION_ID, target],
        true,
      ).fetch(request())
    ).status,
  ).toBe(503);
  expect(begin).toHaveBeenCalledTimes(1);
});
