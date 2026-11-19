import { expect, test } from "vitest";
import { listConnectionCatalog } from "../src/management.js";
import { sealGrantTokens } from "../src/grant-vault.js";
const hex = (v: string) =>
  Array.from(atob(v), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
test("discovery validates the selected organization and team before listing connection metadata", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    registration = "make-development-2";
  let storedRegistration = registration;
  let workspaceGrant = false;
  let sealed = await sealGrantTokens(
    {
      environment: "development",
      workspace: "org",
      human: "human",
      provider: "make",
      registration,
      grantId,
      generation: 1,
      keyVersion: "1",
    },
    { accessToken: "token", refreshToken: "refresh" },
    key,
  );
  const core = {
    async readActiveConnectionGrant() {
      return {
        grantId,
        organizationId: "org",
        ...(workspaceGrant ? {} : { projectId: "project", environmentId: "env" }),
        principalId: "human",
        registration: storedRegistration,
        generation: 1,
        encryptedTokens: {
          nonce: hex(sealed.nonce),
          ciphertext: hex(sealed.ciphertext),
          keyVersion: 1,
        },
      };
    },
  };
  const visited: string[] = [],
    origins: string[] = [];
  let unknownZone = false;
  const fetcher = async (url: string | URL | Request) => {
    const parsed = new URL(String(url)),
      path = parsed.pathname;
    visited.push(path);
    origins.push(parsed.origin);
    if (path.endsWith("/organizations"))
      return Response.json({
        organizations: [
          { id: 1, name: "Org", zone: "eu1.make.com" },
          { id: 4, name: "WE Org", zone: unknownZone ? "foreign.example" : "we.make.com" },
        ],
        pg: { total: 2 },
      });
    if (path.endsWith("/teams"))
      return Response.json({
        teams: [
          {
            id: 2,
            name: "Team",
            organizationId: Number(parsed.searchParams.get("organizationId")),
          },
        ],
      });
    return Response.json({ connections: [{ id: 3, name: "CRM" }] });
  };
  const workspaceInput = {
    organizationId: "org",
    principalId: "human",
    grantId,
    providerOrganizationId: 1,
    teamId: 2,
  };
  const input = { ...workspaceInput, projectId: "project", environmentId: "env" };
  const deps = {
    environment: "development" as const,
    key,
    registration: "make-development-3",
    core,
    fetcher,
  };
  expect(await listConnectionCatalog(input, deps)).toMatchObject({
    connections: [{ id: 3, name: "CRM" }],
  });
  expect(visited.at(-1)).toBe("/api/v2/connections");
  origins.length = 0;
  expect(await listConnectionCatalog({ ...input, providerOrganizationId: 4 }, deps)).toMatchObject({
    organizations: expect.arrayContaining([{ id: 4, name: "WE Org", zone: "we" }]),
    connections: [{ id: 3, name: "CRM" }],
  });
  expect(origins).toContain("https://we.make.com");
  unknownZone = true;
  origins.length = 0;
  await expect(listConnectionCatalog(input, deps)).rejects.toThrow("make_discovery_invalid");
  expect(origins).toEqual(["https://eu1.make.com"]);
  unknownZone = false;
  visited.length = 0;
  await expect(listConnectionCatalog({ ...input, teamId: 99 }, deps)).rejects.toThrow(
    "make_team_unavailable",
  );
  expect(visited).not.toContain("/api/v2/connections");
  visited.length = 0;
  await expect(listConnectionCatalog({ ...input, projectId: "foreign" }, deps)).rejects.toThrow(
    "connection_authority_denied",
  );
  expect(visited).toEqual([]);
  workspaceGrant = true;
  expect(await listConnectionCatalog(workspaceInput, deps)).toMatchObject({
    connections: [{ id: 3 }],
  });
  await expect(listConnectionCatalog(input, deps)).rejects.toThrow("connection_authority_denied");
  await expect(
    listConnectionCatalog({ ...workspaceInput, projectId: "project" }, deps),
  ).rejects.toThrow("connection_authority_denied");
  await expect(
    listConnectionCatalog({ ...workspaceInput, principalId: "other" }, deps),
  ).rejects.toThrow("connection_authority_denied");
  await expect(
    listConnectionCatalog({ ...workspaceInput, organizationId: "other" }, deps),
  ).rejects.toThrow("connection_authority_denied");
  workspaceGrant = false;
  storedRegistration = "make-development-1";
  sealed = await sealGrantTokens(
    {
      environment: "development",
      workspace: "org",
      human: "human",
      provider: "make",
      registration: storedRegistration,
      grantId,
      generation: 1,
      keyVersion: "1",
    },
    { accessToken: "token", refreshToken: "refresh" },
    key,
  );
  expect(await listConnectionCatalog(input, deps)).toMatchObject({ connections: [{ id: 3 }] });
  storedRegistration = "make-production-1";
  await expect(listConnectionCatalog(input, deps)).rejects.toThrow("connection_authority_denied");
  storedRegistration = "make-development-1";
  sealed = await sealGrantTokens(
    {
      environment: "development",
      workspace: "org",
      human: "human",
      provider: "make",
      registration: storedRegistration,
      grantId,
      generation: 1,
      keyVersion: "1",
    },
    { accessToken: "token", refreshToken: "refresh", expiresAt: "2020-01-01T00:00:00.000Z" },
    key,
  );
  await expect(
    listConnectionCatalog(input, {
      ...deps,
      refresh: async () => {
        storedRegistration = registration;
        return "refreshed";
      },
    }),
  ).rejects.toThrow("connection_authority_denied");
});
