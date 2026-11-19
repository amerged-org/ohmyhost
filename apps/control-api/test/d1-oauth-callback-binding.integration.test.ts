import { parseUlid } from "@ohmyhost/platform";
import { afterEach, expect, it, vi } from "vitest";
import {
  CloudflareDomainRuntime,
  ScopedDnsRuntime,
  ApplicationIdentityRuntime,
  MailDnsRuntime,
} from "../../control-store/src/worker-main.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { bytes } from "../../control-store/test/support/platform-fixtures.js";
import { closeBrowserSession } from "../src/browser-session.js";
import { createD1ExtendedPorts } from "../src/d1-extended-ports.js";
import { connect, remoteMcpFixture } from "./helpers/d1-remote-mcp-fixture.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, environment: unknown) {
      this.env = environment;
    }
  },
}));
// The Cloudflare provider is the only fake: the Control API, the management Worker and the Core are real.
// control-api does not depend on the provider package, so the mock names the built entry the management Worker resolves.
vi.mock("../../../packages/provider-cloudflare/dist/index.js", async (original) => {
  const fake = await import("../../cloudflare-domain-management/test/support/cloudflare-fake.js");
  return {
    ...(await original<Record<string, unknown>>()),
    CloudflareCustomerDnsProvider: fake.FakeCustomerDnsProvider,
    createCloudflarePlatformDomainProvider: fake.fakePlatformDomains,
    createCloudflareWorkerRouteProvider: fake.fakeRoutes,
    createCloudflareCustomHostnameProvider: fake.fakeCustomHostnames,
  };
});

const password = "portal-session-password-0123456789abcdef";
const INITIATOR = "user_mcpnative";
const VICTIM = "user_victim";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The real Control API Worker over the real Core, with a sealed portal cookie for any user. `session.mode` controls
 * what the WorkOS session-status check answers: a live session, an ended one, or an outage.
 */
async function harness(control: Awaited<ReturnType<typeof createTestControl>>, extra: object = {}) {
  const f = await remoteMcpFixture(control),
    session = { mode: "live" as "live" | "ended" | "outage" },
    bindings = {
      ...f.bindings,
      AUTH_STATUS: {
        fetch: async (request: Request) =>
          request.url.endsWith("/session-status") && session.mode !== "live"
            ? Response.json(
                { active: false },
                {
                  status: session.mode === "outage" ? 503 : 200,
                  headers: { "cache-control": "no-store" },
                },
              )
            : f.bindings.AUTH_STATUS.fetch(request),
      },
      PRODUCT_API_RUNTIME: f.store.productApi,
      GITHUB_RUNTIME: f.store.github,
      SOURCE_INSPECTOR: {},
      BROWSER_LOGIN_ENABLED: "true",
      PORTAL_SESSION_PASSWORD: password,
      ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x63).toString("base64"),
      ENVIRONMENT_SECRET_KEY_VERSION: "1",
      ...extra,
    },
    fetch = (request: Request) =>
      f.worker.fetch(request, bindings as never, { waitUntil: () => undefined });
  /** A WorkOS session access token, fresh or already expired while the session is live. */
  const accessToken = (userId: string, expired = false) => {
    const now = Math.floor(Date.now() / 1000);
    return f.sign({
      iss: f.workosIssuer,
      sub: userId,
      client_id: "client_host",
      org_id: f.workosOrganizationId,
      sid: `session_${userId}`,
      iat: expired ? now - 3600 : now,
      exp: expired ? now - 1800 : now + 300,
    });
  };
  /** A portal cookie sealing such a token. */
  const cookie = async (userId: string, expired = false) => {
    return (
      (
        await closeBrowserSession(
          {
            accessToken: await accessToken(userId, expired),
            refreshToken: "refresh-token",
            csrf: "c".repeat(43),
            origin: connect.origin,
            createdAt: Date.now() - 1000,
            organizationId: null,
          },
          password,
        )
      ).split(";")[0] ?? ""
    );
  };
  return { f, bindings, fetch, cookie, accessToken, session };
}

it("completes a GitHub organization connection only in the browser of the user who started it", async () => {
  const control = await createTestControl();
  try {
    let exchanges = 0;
    const callbackUri = `${connect.origin}/v1/github/oauth/callback`,
      provider = {
        beginOrganizationAuthorization: async (value: unknown) => {
          const { state, codeChallenge } = value as Record<string, string>;
          return {
            installationUrl: `https://github.com/apps/test-app/installations/new?state=${state}`,
            authorizationUrl: `https://github.com/login/oauth/authorize?client_id=c&code_challenge=${codeChallenge}&code_challenge_method=S256&prompt=select_account&redirect_uri=${encodeURIComponent(callbackUri)}&state=${state}`,
          };
        },
        // The victim's administrator approves; this is the proof an attacker wants bound to tenant A.
        completeOrganizationAuthorization: async () => {
          exchanges += 1;
          return {
            installationId: 42,
            accountId: 7,
            accountLogin: "victim-org",
            accountType: "Organization",
            repositorySelection: "all",
            settingsUrl: "https://github.com/organizations/victim-org/settings/installations/42",
            userId: 5,
            userLogin: "victim-admin",
          };
        },
        observeOrganizationInstallation: async () => ({
          installationId: 42,
          accountId: 7,
          accountType: "Organization",
        }),
        validateOrganizationRepository: async () => ({
          installationId: 42,
          owner: "victim-org",
          name: "private-repo",
          permission: "contents:read",
          externalRepositoryId: "78",
        }),
      },
      { f, fetch, cookie, accessToken, session } = await harness(control, {
        SOURCE_INSPECTOR: provider,
      }),
      organizationId = f.project.organizationId,
      initiator = await cookie(INITIATOR),
      initiatorExpired = await cookie(INITIATOR, true),
      victim = await cookie(VICTIM);

    const begun = await fetch(
      new Request(`${connect.origin}/v1/organizations/${organizationId}/github:connect`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await f.sessionToken()}`,
          "content-type": "application/json",
          "idempotency-key": "connect-1",
        },
        body: "{}",
      }),
    );
    expect(begun.status, await begun.clone().text()).toBe(201);
    const state = new URL(
      ((await begun.json()) as { authorization_url: string }).authorization_url,
    ).searchParams.get("state") as string;
    const callback = (query: string, cookieHeader?: string) =>
      fetch(
        new Request(`${connect.origin}/v1/github/oauth/callback?state=${state}&${query}`, {
          headers: { accept: "text/html", ...(cookieHeader ? { cookie: cookieHeader } : {}) },
        }),
      );
    const stored = () =>
      control.core
        .prepare(
          "SELECT state, installation_id, flow FROM github_connection_authorizations WHERE authorization_id=?",
        )
        .bind(state.slice(0, 26))
        .first<{ state: string; installation_id: string | null; flow: string }>();
    const connections = async () =>
      (
        await control.core
          .prepare("SELECT count(*) n FROM github_organization_connections WHERE organization_id=?")
          .bind(organizationId)
          .first<{ n: number }>()
      )?.n;
    const rejected = "/github/authorization-failed?reason=state_unknown";
    const row = () =>
      control.core
        .prepare("SELECT * FROM github_connection_authorizations WHERE authorization_id=?")
        .bind(state.slice(0, 26))
        .first();
    let before = await row();
    /** A browser that is not the initiator's, signed out or signed in as someone else, changes nothing on any branch. */
    const refuse = async (queries: string[]) => {
      for (const stranger of [undefined, victim])
        for (const query of queries) {
          const response = await callback(query, stranger);
          expect({ status: response.status, to: response.headers.get("location") }).toEqual({
            status: 303,
            to: rejected,
          });
        }
      expect(await row()).toEqual(before);
    };

    // The installation hop, a denial and a request for approval arrive in a browser that is not the initiator's.
    await refuse([
      "installation_id=42&setup_action=install",
      "error=access_denied",
      "setup_action=request",
    ]);
    expect(await stored()).toMatchObject({ state: "pending", installation_id: null });
    // The initiator's own session continues the flow: the rejected attempts consumed nothing.
    const advanced = await callback("installation_id=42&setup_action=install", initiator);
    expect(advanced.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(await stored()).toMatchObject({
      state: "pending",
      installation_id: "42",
      flow: "oauth",
    });
    before = await row();
    await refuse(["code=victim-code", "error=access_denied", "setup_action=request"]);
    expect(await stored()).toMatchObject({ state: "pending" });
    expect(exchanges).toBe(0);
    expect(await connections()).toBe(0);

    // Fail closed: an outage of the session check is a 503 even for the initiator, an ended session is nobody,
    // and neither touches the attempt.
    session.mode = "outage";
    const down = await fetch(
      new Request(`${connect.origin}/v1/github/oauth/callback?state=${state}&code=initiator-code`, {
        headers: { accept: "application/json", cookie: initiator },
      }),
    );
    expect(down.status).toBe(503);
    expect((await callback("code=initiator-code", initiator)).headers.get("location")).toBe(
      "/github/authorization-failed?reason=provider_unavailable",
    );
    session.mode = "ended";
    expect((await callback("code=initiator-code", initiator)).headers.get("location")).toBe(
      rejected,
    );
    session.mode = "live";
    expect(await row()).toEqual(before);
    expect(exchanges).toBe(0);

    // A repository of an installation that was never legitimately bound still cannot be linked.
    const link = await fetch(
      new Request(`${connect.origin}/v1/projects/${f.project.projectId}/source:link`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await f.sessionToken()}`,
          "content-type": "application/json",
          "idempotency-key": "link-1",
        },
        body: JSON.stringify({ repository_owner: "victim-org", repository_name: "private-repo" }),
      }),
    );
    expect(link.status).toBe(409);
    expect(await link.json()).toMatchObject({ code: "github_connection_required" });

    // The initiator finishes, even with an access token that expired while GitHub was open.
    const done = await callback("code=initiator-code", initiatorExpired);
    expect(done.headers.get("location")).toBe("/github/authorized");
    expect(exchanges).toBe(1);
    expect(await connections()).toBe(1);

    // Replays complete nothing again; a stranger learns nothing about the finished state either.
    for (const [who, expected] of [
      [initiator, "/github/authorized"],
      [victim, rejected],
      [undefined, rejected],
    ] as const) {
      const replay = await callback("code=initiator-code", who);
      expect(replay.headers.get("location")).toBe(expected);
    }
    expect(exchanges).toBe(1);
    expect(await connections()).toBe(1);

    // The seven-day session policy belongs to the cookie reader alone: the same expired token is no API credential.
    const api = await fetch(
      new Request(`${connect.origin}/v1/organizations/${organizationId}/github`, {
        headers: { authorization: `Bearer ${await accessToken(INITIATOR, true)}` },
      }),
    );
    expect(api.status).toBe(401);
  } finally {
    await control.dispose();
  }
}, 180_000);

it("completes a project source authorization only in the browser of the user who started it", async () => {
  const control = await createTestControl();
  try {
    let exchanges = 0;
    const callbackUri = `${connect.origin}/v1/github/oauth/callback`,
      provider = {
        beginRepositoryAuthorization: async (value: unknown) => {
          const { state, codeChallenge } = value as Record<string, string>;
          return {
            installationUrl: "https://github.com/apps/test-app/installations/new",
            authorizationUrl: `https://github.com/login/oauth/authorize?client_id=c&code_challenge=${codeChallenge}&code_challenge_method=S256&prompt=select_account&redirect_uri=${encodeURIComponent(callbackUri)}&state=${state}`,
          };
        },
        // The victim reads the repository; this is the consent an attacker wants attached to the project.
        completeRepositoryAuthorization: async () => {
          exchanges += 1;
          return {
            installationId: 42,
            owner: "victim-org",
            permission: "contents:read",
            repository: "private-repo",
            repositoryId: 77,
            userId: 5,
          };
        },
      },
      { f, bindings, fetch, cookie } = await harness(control, { SOURCE_INSPECTOR: provider }),
      initiator = await cookie(INITIATOR),
      victim = await cookie(VICTIM);

    // The project flow is begun through the Core-backed port, as source:link did before organization connections.
    const begun = await createD1ExtendedPorts({
      bindings: bindings as never,
      publicOrigin: connect.origin,
      clock: { now: () => new Date() },
      ids: { next: () => parseUlid(newUlid()) },
    }).githubSourceAuthorization.begin({
      organizationId: f.organizationId,
      projectId: parseUlid(f.project.projectId),
      principalId: `user:${INITIATOR}`,
      requestId: "req_source",
      idempotencyKey: "source-1",
      canonicalRequestDigest: new Uint8Array(32).fill(7),
      repositoryOwner: "victim-org",
      repositoryName: "private-repo",
      session: {
        sessionId: `session_${INITIATOR}`,
        userId: INITIATOR,
        organizationId: f.workosOrganizationId,
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
      },
    });
    expect(begun.status).toBe("pending");
    const state = new URL(begun.authorization_url as string).searchParams.get("state") as string;
    const callback = (query: string, cookieHeader?: string) =>
      fetch(
        new Request(`${connect.origin}/v1/github/oauth/callback?state=${state}&${query}`, {
          headers: { accept: "text/html", ...(cookieHeader ? { cookie: cookieHeader } : {}) },
        }),
      );
    const row = () =>
      control.core
        .prepare("SELECT * FROM github_source_authorizations WHERE authorization_id=?")
        .bind(state.slice(0, 26))
        .first();
    const before = await row();
    expect(before).toMatchObject({ state: "pending", last_failure: null, installation_id: null });
    const rejected = "/github/authorization-failed?reason=state_unknown";

    // A stranger's code, a stranger's denial and a stranger's request for approval: signed out or signed in as
    // someone else, each is answered as an unknown state and the authorization row is byte for byte unchanged.
    for (const stranger of [undefined, victim])
      for (const query of ["code=victim-code", "error=access_denied", "setup_action=request"]) {
        const response = await callback(query, stranger);
        expect({ status: response.status, to: response.headers.get("location") }).toEqual({
          status: 303,
          to: rejected,
        });
        expect(await row()).toEqual(before);
      }
    expect(exchanges).toBe(0);

    // The refusals consumed nothing: the initiator completes, once, and a replay completes nothing again.
    const done = await callback("code=initiator-code", initiator);
    expect(done.headers.get("location")).toBe("/github/authorized");
    expect(exchanges).toBe(1);
    expect(await row()).toMatchObject({ state: "authorized", installation_id: "42" });
    for (const [who, expected] of [
      [initiator, "/github/authorized"],
      [victim, rejected],
      [undefined, rejected],
    ] as const)
      expect((await callback("code=initiator-code", who)).headers.get("location")).toBe(expected);
    expect(exchanges).toBe(1);
  } finally {
    await control.dispose();
  }
}, 180_000);

it("completes a Cloudflare DNS authorization only in the browser of the user who started it", async () => {
  const control = await createTestControl();
  try {
    const { providerLog } = await import(
      "../../cloudflare-domain-management/test/support/cloudflare-fake.js"
    );
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const { CloudflareDomainManagementService } = await import(
      "../../cloudflare-domain-management/src/worker-main.js"
    );
    const service = new CloudflareDomainManagementService(
      {} as never,
      {
        RUNTIME_CONFIGURATION_STATE: "configured" as const,
        CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
        CLOUDFLARE_PLATFORM_ZONE_ID: "c".repeat(32),
        CLOUDFLARE_SAAS_ZONE_ID: "b".repeat(32),
        CLOUDFLARE_SAAS_CNAME_TARGET: "customers.omh.st",
        CLOUDFLARE_SAAS_API_TOKEN: "fixture-saas-domain-token-value",
        CLOUDFLARE_OAUTH_CLIENT_ID: "fixture-oauth-client-id",
        CLOUDFLARE_OAUTH_CLIENT_SECRET: "fixture-oauth-client-secret",
        CLOUDFLARE_OAUTH_REDIRECT_URI: `${connect.origin}/v1/cloudflare/oauth/callback`,
        CLOUDFLARE_OAUTH_STATE_FORMAT: "json-v1",
        CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: Buffer.alloc(32, 0x42).toString("base64"),
        CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "1",
        CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: "fixture-platform-web-domain-token",
        GENERAL_CF_RUNTIME: new CloudflareDomainRuntime({} as never, control.bindings as never),
        NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: async () => ({ outcome: "applied" }) },
        NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: async () => ({ outcome: "applied" }) },
        SCOPED_DNS_RUNTIME: new ScopedDnsRuntime({} as never, control.bindings as never),
        APPLICATION_IDENTITY_RUNTIME: new ApplicationIdentityRuntime(
          {} as never,
          control.bindings as never,
        ),
        MAIL_DNS_RUNTIME: new MailDnsRuntime({} as never, control.bindings as never),
        DEV_ACCESS: { issueRuntimeProbe: async () => ({}) },
        RUNTIME_PROBES: { beginProbe: async () => ({}) },
      } as never,
    );
    const { f, fetch, cookie, session } = await harness(control, {
        CLOUDFLARE_DOMAIN_MANAGEMENT: service,
      }),
      { organizationId, projectId } = f.project,
      initiator = await cookie(INITIATOR),
      victim = await cookie(VICTIM);
    await control.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,'app.victim.test',NULL,'awaiting_deployment',?6,?3,?4,?5,?5,NULL)",
      )
      .bind(
        organizationId,
        projectId,
        bytes(32, 1),
        bytes(32, 2),
        "2026-10-28T10:00:00.000000Z",
        `user:${INITIATOR}`,
      )
      .run();
    const digest = (label: string) => `sha256:${label.padEnd(64, "0")}`;
    const begun = (await service.beginAuthorization({
      organizationId,
      projectId,
      actorId: `user:${INITIATOR}`,
      zone: "victim.test",
      idempotencyKeySha256: digest("a1"),
      requestSha256: digest("b1"),
    })) as { authorizationUrl: string };
    const state = new URL(begun.authorizationUrl).searchParams.get("state") as string;
    const callback = (cookieHeader?: string) =>
      fetch(
        new Request(
          `${connect.origin}/v1/cloudflare/oauth/callback?code=victim-zone-owner-code&state=${state}`,
          { headers: cookieHeader ? { cookie: cookieHeader } : {} },
        ),
      );
    const grants = async () =>
      (
        await control.core
          .prepare("SELECT count(*) n FROM cloudflare_project_dns_grants WHERE project_id=?")
          .bind(projectId)
          .first<{ n: number }>()
      )?.n;

    const consumedAt = async () =>
      (
        await control.core
          .prepare(
            "SELECT consumed_at FROM cloudflare_project_authorization_states WHERE authorization_id=?",
          )
          .bind(state.slice(0, 26))
          .first<{ consumed_at: string | null }>()
      )?.consumed_at;

    // A zone owner who follows the initiator's link in another browser grants nothing.
    providerLog.length = 0;
    for (const stranger of [undefined, victim]) {
      const refused = await callback(stranger);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "confirmation_invalid" });
    }
    expect(providerLog).toEqual([]);
    expect(await grants()).toBe(0);
    expect(await consumedAt()).toBeNull();

    // Fail closed: an outage of the session check is a 503 even for the initiator and an ended session is nobody;
    // neither exchanges a code or consumes the state.
    session.mode = "outage";
    expect((await callback(initiator)).status).toBe(503);
    session.mode = "ended";
    expect((await callback(initiator)).status).toBe(409);
    session.mode = "live";
    expect(providerLog).toEqual([]);
    expect(await consumedAt()).toBeNull();

    // The refusals consumed nothing: the initiator completes, once.
    const done = await callback(initiator);
    expect(done.status, await done.clone().text()).toBe(200);
    expect(providerLog).toEqual(["exchange-code", "observe-zone"]);
    expect(await grants()).toBe(1);
    expect(
      await control.core
        .prepare("SELECT principal_id FROM cloudflare_project_dns_grants WHERE project_id=?")
        .bind(projectId)
        .first(),
    ).toEqual({ principal_id: `user:${INITIATOR}` });
    for (const again of [initiator, victim, undefined]) {
      expect((await callback(again)).status).toBe(409);
    }
    expect(providerLog).toEqual(["exchange-code", "observe-zone"]);
    expect(await grants()).toBe(1);
  } finally {
    await control.dispose();
  }
}, 180_000);
