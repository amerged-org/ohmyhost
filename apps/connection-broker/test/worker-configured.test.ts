import { expect, test, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      _context: unknown,
      readonly env: unknown,
    ) {}
  },
}));
import worker, { ConnectionBrokerManagementService } from "../src/worker-main.js";
import { sealGrantTokens } from "../src/grant-vault.js";
const hex = (v: string) =>
  Array.from(atob(v), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
test("configured private management forwards current authority while public relay remains gated", async () => {
  const grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    key = crypto.getRandomValues(new Uint8Array(32)),
    vaultKey = btoa(String.fromCharCode(...key));
  const actor = {
    organizationId: "org",
    projectId: "project",
    environmentId: "env",
    principalId: "human",
    sessionId: "session",
    browserSession: {
      sessionId: "session",
      userId: "human",
      organizationId: null,
      tokenExpiresAt: 4102444800,
    },
  };
  const sealed = await sealGrantTokens(
    {
      environment: "development",
      workspace: "org",
      human: "human",
      provider: "make",
      registration: "make-development-2",
      grantId,
      generation: 1,
      keyVersion: "1",
    },
    { accessToken: "token", refreshToken: "refresh", expiresAt: "2020-01-01T00:00:00.000Z" },
    key,
  );
  let grant = {
    grantId,
    organizationId: "org",
    projectId: "project",
    environmentId: "env",
    principalId: "human",
    registration: "make-development-2",
    generation: 1,
    encryptedTokens: {
      nonce: hex(sealed.nonce),
      ciphertext: hex(sealed.ciphertext),
      keyVersion: 1,
    },
  };
  const mutationAuthority = {
      kind: "api_key" as const,
      keyId: "key",
      userId: "human",
      workosOrganizationId: "org",
    },
    observations: string[] = [];
  const core = {
    async createConnectionHandoff() {
      return true;
    },
    async readConnectionConfirmationOrigin() {
      return actor;
    },
    async activateConnectionGrant() {
      return { state: "active", grantId };
    },
    async readActiveConnectionGrant() {
      return grant;
    },
    async claimConnectionRefresh(input: { claimId: string }) {
      return { ...grant, claimId: input.claimId, projectId: "project", environmentId: "env" };
    },
    async markConnectionRefreshDispatched() {
      return true;
    },
    async commitConnectionRefresh(input: { encryptedTokens: typeof grant.encryptedTokens }) {
      grant = { ...grant, generation: 2, encryptedTokens: input.encryptedTokens };
      return true;
    },
    async disconnectConnectionGrant() {
      return true;
    },
    async readConnectionGrantStatus() {
      return { state: "disconnected" };
    },
  };
  const authority = {
    async integrationAuthorityReadiness() {
      return { state: "ready" };
    },
    async observeConnectionOrigin() {
      observations.push("session");
    },
    async observeIntegrationMutation(input: { resourceKind: string }) {
      observations.push(input.resourceKind);
    },
  };
  const maintenance = {
    async listExpiredConnectionGrants() {
      return [];
    },
    async listDisconnectingConnectionGrants() {
      return [];
    },
    async listConnectionOrphans() {
      return [];
    },
    async listConnectionRefreshOrphans() {
      return [];
    },
  };
  const env = {
    PLATFORM_ENVIRONMENT: "development",
    MAKE_CLIENT_ID: "client",
    MAKE_CLIENT_SECRET: "secret",
    GRANT_KEY: vaultKey,
    MAKE_OAUTH_ENABLED: "true",
    MAKE_DISCOVERY_ENABLED: "true",
    CONNECTION_CORE: core,
    CONNECTION_AUTHORITY: authority,
    CONNECTION_MAINTENANCE: maintenance,
  };
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/oauth/v2/token")
      return Response.json({ access_token: "new-token", token_type: "Bearer", expires_in: 300 });
    if (path.endsWith("/organizations"))
      return Response.json({ organizations: [{ id: 1, name: "Org", zone: "eu1.make.com" }] });
    if (path.endsWith("/teams"))
      return Response.json({ teams: [{ id: 2, name: "Team", organizationId: 1 }] });
    return Response.json({ connections: [{ id: 3, name: "Connection" }] });
  });
  try {
    const management = new ConnectionBrokerManagementService({}, env as never);
    const execution = new ConnectionBrokerManagementService({}, {
      ...env,
      MAKE_EXECUTION_ENABLED: "true",
      CONNECTION_CORE: {
        ...core,
        readMakeActionBinding: vi.fn(),
        admitMakeActionExecution: vi.fn(),
        finishMakeActionExecution: vi.fn(),
      },
    } as never);
    await expect(
      execution.executeMakeAction({
        key: "incorrect",
        idempotencyKey: "intent",
        input: {},
      }),
    ).resolves.toEqual({ state: "denied" });

    expect(await management.providerReadiness({ provider: "make" })).toEqual({
      state: "available",
    });
    const unavailableAuthority = new ConnectionBrokerManagementService({}, {
      ...env,
      CONNECTION_AUTHORITY: {
        ...authority,
        async integrationAuthorityReadiness() {
          return { state: "unavailable" };
        },
      },
    } as never);
    expect(await unavailableAuthority.providerReadiness({ provider: "make" })).toEqual({
      state: "provider_unavailable",
    });

    expect(await management.catalogReadiness({ provider: "make" })).toEqual({ state: "available" });
    expect(
      await management.matchesConfirmation({
        result: "invalid",
        principalId: "human",
        sessionId: "session",
        handoffHash: "0".repeat(64),
      }),
    ).toBe(false);
    expect((await management.beginBrowser(actor)).url).toContain("/oauth/start?handoff=");
    expect(
      await management.complete({
        result: "a".repeat(43),
        principalId: "human",
        sessionId: "session",
      }),
    ).toMatchObject({ state: "active", grantId });
    const scope = {
      organizationId: "org",
      projectId: "project",
      environmentId: "env",
      principalId: "human",
      grantId,
      providerOrganizationId: 1,
      teamId: 2,
    };
    expect((await management.listConnectionCatalog(scope)).connections).toEqual([
      { id: 3, name: "Connection" },
    ]);
    expect(
      await management.disconnectConnectionGrant({
        organizationId: "org",
        principalId: "human",
        grantId,
        idempotencyKey: "disconnect",
        mutationAuthority,
      }),
    ).toEqual({ state: "disconnected" });
    expect(observations).toEqual(["session", "session", "organization"]);
    expect(
      (
        await worker.fetch(
          new Request("https://dev.connect.ohmyho.st/v1/execute", { method: "POST" }),
          env as never,
        )
      ).status,
    ).toBe(503);
    await worker.scheduled({}, env as never);
  } finally {
    vi.unstubAllGlobals();
  }
});
