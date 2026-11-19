import { expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedDevAccessProject } from "../../control-store/test/support/dev-access-fixture.js";
import { seedProductRuntimeFixture } from "../../control-store/test/support/product-runtime-fixture.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { gatewayFixture } from "../../control-store/test/gateway/gateway-fixture.js";

// The Worker host binds env through its constructor; the private classes run unchanged over the real Core.
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

it("opens and reads a project preview through the public Worker and Core", async () => {
  const control = await createTestControl();
  try {
    const project = await seedProductRuntimeFixture(control);
    await control.core
      .prepare(
        "INSERT INTO credit_account(organization_id,monthly_micros,monthly_ends_at,onetime_micros,reserved_micros,overrun_micros,paid_until,paid_source,updated_at) VALUES(?1,100000000,'2099-01-01T00:00:00.000000Z',0,0,0,'2099-01-01T00:00:00.000000Z','manual','2026-10-28T10:00:00.000000Z')",
      )
      .bind(project.organizationId)
      .run();
    const organization = await control.core
      .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?")
      .bind(project.organizationId)
      .first<{ workos_organization_id: string }>();
    if (!organization) throw new Error("Fixture organization is missing");
    const entry = await import("../../control-store/src/worker-main.js");
    const { createControlApiWorkerEntrypoint } = await import("../src/worker-main.js");
    const worker = createControlApiWorkerEntrypoint({
      fetcher: async () => {
        throw new Error("Unexpected provider request");
      },
    });
    const bindings = {
      CONTROL_API_PUBLIC_ORIGIN: "https://dev.app.ohmyho.st",
      CONTROL_RUNTIME: new entry.ControlRuntime({} as never, control.bindings),
      PREVIEW_API_RUNTIME: new entry.ProductApiPreviewRuntime({} as never, control.bindings),
      PREVIEW_EXECUTION: { fence: async () => undefined },
      SOURCE_INSPECTOR: {},
      ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x43).toString("base64"),
      ENVIRONMENT_SECRET_KEY_VERSION: "1",
      AUTH_STATUS: {
        fetch: async () =>
          Response.json(
            {
              key: {
                id: "api_key_fixture",
                userId: "user_consent",
                organizationId: organization.workos_organization_id,
                permissions: ["projects:read", "projects:write"],
                expiresAt: null,
              },
            },
            { headers: { "cache-control": "no-store" } },
          ),
      },
      CONTROL_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
      OPERATION_PUBLISHER: { wake: async () => undefined },
      WORKOS_JWKS_URL: "https://fixture.authkit.app/jwks",
      WORKOS_ISSUER: "https://api.workos.com/user_management/client_fixture",
      WORKOS_CLIENT_ID: "client_fixture",
      WORKOS_AUDIENCE: "control-api",
    };
    const url = `https://dev.app.ohmyho.st/v1/projects/${project.projectId}/preview?environment=dev`;
    const request = (method: "GET" | "POST") =>
      worker.fetch(
        new Request(url, {
          method,
          headers: { authorization: "Bearer sk_aaaaaaaaaaaaaaaaaaaaaaaa" },
        }),
        bindings as never,
        { waitUntil: () => undefined },
      );
    const opened = await request("POST");
    expect(opened.status, await opened.clone().text()).toBe(200);
    const preview = await opened.json();
    expect(preview).toMatchObject({ project_id: project.projectId, environment: "dev" });
    const fetched = await request("GET");
    expect(fetched.status, await fetched.clone().text()).toBe(200);
    expect(await fetched.json()).toEqual(preview);
  } finally {
    await control.dispose();
  }
}, 120_000);

it("serves Dev access sessions and probes through the private DevAccessService on the Core", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      { project, origin, principalId } = await seedDevAccessProject(control, {
        handle: "calm-otter-waves",
      }),
      pair = (await globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair,
      exported = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey),
      environment = {
        DEV_ACCESS_RUNTIME: store.devAccess,
        PUBLIC_ENTRY_RATE_LIMITER: { limit: async () => ({ success: true }) },
        CONTROL_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
        DEV_ACCESS_SESSION_PRIVATE_JWK: JSON.stringify(
          await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey),
        ),
        DEV_ACCESS_SESSION_PUBLIC_JWK: JSON.stringify({
          crv: exported.crv,
          kty: exported.kty,
          x: exported.x,
          y: exported.y,
        }),
      },
      { DevAccessService } = await import("../src/worker-main.js"),
      { createD1DevAccessTicketsPort } = await import("../src/d1-dev-access.js"),
      service = new DevAccessService({} as never, environment as never),
      page = {
        projectId: parseUlid(project.projectId),
        environmentId: parseUlid(project.devEnvironmentId),
        handle: project.handle,
        origin,
      },
      issued = await createD1DevAccessTicketsPort({
        runtime: store.devAccess,
        clock: { now: () => new Date() },
        ids: { next: () => parseUlid(newUlid()) },
        crypto: globalThis.crypto,
      }).issue({
        organizationId: parseUlid(project.organizationId),
        projectId: parseUlid(project.projectId),
        principalId,
        requestId: "req_service",
      }),
      ticket = new URL(issued.redeemUrl).searchParams.get("ticket") as string;

    const session = await service.redeem({ ...page, ticket, clientAddress: "198.51.100.7" });
    expect(await service.authorize({ ...page, sessionToken: session.sessionToken })).toEqual({
      authorized: true,
    });
    expect(await service.authorize({ ...page, sessionToken: null })).toEqual({ authorized: false });
    // Without a deployment that holds the provider claim, the Core refuses the probe.
    await expect(
      service.issueRuntimeProbe({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.devEnvironmentId,
        operationId: newUlid(),
        deploymentId: newUlid(),
        handle: project.handle,
        origin,
        path: "/healthz",
        method: "GET",
      }),
    ).rejects.toThrow("Dev runtime probe issuance is unavailable");
    // A Worker without the Core capability fails closed instead of opening another store.
    await expect(
      new DevAccessService(
        {} as never,
        { ...environment, DEV_ACCESS_RUNTIME: undefined } as never,
      ).redeem({ ...page, ticket, clientAddress: "198.51.100.7" }),
    ).rejects.toThrow("Dev access redemption is unavailable");
  } finally {
    await control.dispose();
  }
});

it("runs the managed source processor over the Core and fails closed without it", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      entry = await import("../../control-store/src/worker-main.js"),
      { ManagedSourceProcessor } = await import("../src/worker-main.js"),
      environment = {
        MANAGED_SOURCE_RUNTIME: store.managedSource,
        CONTROL_RUNTIME: new (entry.ControlRuntime as unknown as new (
          context: unknown,
          environment: unknown,
        ) => object)({}, control.bindings),
        MANAGED_ARTIFACTS_NAMESPACE_US: "artifacts-us",
        MANAGED_ARTIFACTS_NAMESPACE_EU: "artifacts-eu",
        SOURCE_INSPECTOR: { managedGit: async () => ({}), managedBlob: async () => ({}) },
        OPERATION_PUBLISHER: { wake: async () => undefined },
      },
      scope = { organizationId: newUlid(), projectId: newUlid(), operationId: newUlid() };

    // No initialization is recorded for this scope, so the processor has nothing to run.
    await expect(
      new ManagedSourceProcessor({} as never, environment as never).initialize(scope),
    ).rejects.toThrow("Managed source initialization is unavailable");
    await expect(
      new ManagedSourceProcessor(
        {} as never,
        { ...environment, MANAGED_SOURCE_RUNTIME: undefined } as never,
      ).initialize(scope),
    ).rejects.toThrow("Managed source processor is unavailable");
    // A publication that the Core does not know is refused instead of being pushed.
    await expect(
      new ManagedSourceProcessor({} as never, environment as never).process(scope),
    ).rejects.toThrow("Managed source operation is unavailable");
    await expect(
      new ManagedSourceProcessor({} as never, environment as never).process({
        ...scope,
        extra: true,
      }),
    ).rejects.toThrow("Managed source service returned an invalid scoped result");
  } finally {
    await control.dispose();
  }
}, 120_000);

it("opens the runtime probe accounting window on the Core and fails closed for foreign scopes and throttled callers", async () => {
  const control = await createTestControl();
  try {
    const fixture = await gatewayFixture(control),
      { RuntimeCreditService } = await import("../src/worker-main.js"),
      scope = { ...fixture.scope, deploymentId: fixture.deploymentId },
      environment = (success: boolean) =>
        ({
          RUNTIME_PROBE_RUNTIME: fixture.store.gateway.probe,
          PUBLIC_ENTRY_RATE_LIMITER: { limit: async () => ({ success: true }) },
          CONTROL_API_RATE_LIMITER: { limit: async () => ({ success }) },
        }) as never;

    const opened = await new RuntimeCreditService({} as never, environment(true)).beginProbe(scope);
    expect(Number.isFinite(Date.parse((opened as { expiresAt: string }).expiresAt))).toBe(true);
    const unavailable = "Runtime probe accounting is unavailable";
    await expect(
      new RuntimeCreditService({} as never, environment(false)).beginProbe(scope),
    ).rejects.toThrow(unavailable);
    await expect(
      new RuntimeCreditService({} as never, environment(true)).beginProbe({
        ...scope,
        deploymentId: newUlid(),
      }),
    ).rejects.toThrow(unavailable);
    await expect(
      new RuntimeCreditService({} as never, environment(true)).beginProbe({
        ...scope,
        allowed: true,
      }),
    ).rejects.toThrow(unavailable);
  } finally {
    await control.dispose();
  }
}, 120000);

it("serves the remote MCP endpoint and the interactive account profile from the Core", async () => {
  const control = await createTestControl();
  try {
    const entry = await import("../../control-store/src/worker-main.js"),
      { createControlApiWorkerEntrypoint } = await import("../src/worker-main.js"),
      construct = <T>(runtime: unknown) =>
        new (runtime as new (context: unknown, environment: unknown) => T)({}, control.bindings),
      project = await seedProject(control),
      userId = "user_mcpnative",
      issuer = "https://connect.example.test",
      origin = "https://dev.app.ohmyho.st",
      workosJwksUrl = "https://api.workos.com/sso/jwks/client_host",
      workosIssuer = "https://api.workos.com/user_management/client_host",
      workosOrganizationId = String(
        (
          await control.core
            .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?")
            .bind(project.organizationId)
            .first<{ workos_organization_id: string }>()
        )?.workos_organization_id,
      );
    await control.core.batch([
      control.core
        .prepare(
          "UPDATE organizations SET beta_admitted_at='2026-10-28T10:00:00.000000Z' WHERE organization_id=?",
        )
        .bind(project.organizationId),
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,?2,'owner','active',1,zeroblob(32),'2026-10-28T10:00:00.000000Z','event_mcp')",
        )
        .bind(project.organizationId, userId),
    ]);

    let browserSessionToken = "";
    const keys = (await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair,
      jwks = {
        keys: [
          {
            ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
            kid: "connect-test",
            alg: "RS256",
            use: "sig",
          },
        ],
      },
      encode = (value: string | Uint8Array) => Buffer.from(value).toString("base64url"),
      header = encode(JSON.stringify({ alg: "RS256", kid: "connect-test", typ: "JWT" })),
      token = async (extra: Record<string, unknown>) => {
        const seconds = Math.floor(Date.now() / 1000),
          payload = encode(
            JSON.stringify({
              iss: issuer,
              aud: `${origin}/mcp`,
              sub: userId,
              client_id: "client_chat",
              sid: "app_consent_connected",
              scope: "openid",
              iat: seconds,
              exp: seconds + 300,
              ...extra,
            }),
          );
        return `${header}.${payload}.${encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`))))}`;
      },
      worker = createControlApiWorkerEntrypoint({
        // The provider boundary: Connect discovery and its signing keys.
        fetcher: async (request) => {
          if (request.url === "https://api.workos.com/user_management/authenticate")
            return Response.json({
              access_token: browserSessionToken,
              refresh_token: "refresh-browser",
            });
          if (request.url.endsWith("oauth-authorization-server")) return Response.json({ issuer });
          if (request.url.endsWith("openid-configuration"))
            return Response.json({ issuer, jwks_uri: `${issuer}/oauth2/jwks` });
          if (request.url.endsWith("oauth2/jwks") || request.url === workosJwksUrl)
            return Response.json(jwks);
          throw new Error("Unexpected discovery request");
        },
      }),
      bindings = {
        CONTROL_API_PUBLIC_ORIGIN: origin,
        BROWSER_LOGIN_ENABLED: "true" as const,
        PORTAL_SESSION_PASSWORD: "test-only-portal-password-32-characters",
        CONTROL_RUNTIME: construct(entry.ControlRuntime),
        ACCOUNT_METADATA_RUNTIME: construct(entry.AccountMetadataRuntime),
        // The auth-status Service Binding: session liveness, the provider profile and the identity directory.
        AUTH_STATUS: {
          fetch: async (request: Request) => {
            const headers = { "cache-control": "no-store" };
            if (request.url.endsWith("/session-status"))
              return Response.json({ active: true }, { headers });
            if (request.url.endsWith("/user-profile"))
              return Response.json(
                {
                  user_id: userId,
                  name: "MCP user",
                  email: "mcp@example.invalid",
                  email_verified: true,
                  workos_organization_ids: [workosOrganizationId],
                },
                { headers },
              );
            return Response.json(
              {
                user_id: userId,
                email: "mcp@example.invalid",
                organizations: [{ workos_id: workosOrganizationId, name: "Chat workspace" }],
              },
              { headers },
            );
          },
        },
        PUBLIC_ENTRY_RATE_LIMITER: { limit: async () => ({ success: true }) },
        CONTROL_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
        OPERATION_PUBLISHER: { wake: async () => undefined },
        WORKOS_JWKS_URL: workosJwksUrl,
        WORKOS_ISSUER: workosIssuer,
        WORKOS_CLIENT_ID: "client_host",
        WORKOS_AUDIENCE: "client_host",
        WORKOS_CONNECT_ISSUER: issuer,
        WORKOS_CONNECT_JWKS_URL: `${issuer}/oauth2/jwks`,
      },
      identity = async (bearer: string) => {
        const response = await worker.fetch(
          new Request(`${origin}/mcp`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "identity_get", arguments: {} },
            }),
          }),
          bindings as never,
          { waitUntil: () => undefined },
        );
        expect(response.status).toBe(200);
        const text = await response.text(),
          json = JSON.parse(
            response.headers.get("content-type")?.startsWith("text/event-stream")
              ? (text
                  .split("\n")
                  .find((line) => line.startsWith("data: "))
                  ?.slice(6) ?? "{}")
              : text,
          ) as { result: { content: { text: string }[]; isError?: boolean } };
        expect(json.result.isError === true, text).toBe(false);
        return JSON.parse(json.result.content[0]?.text ?? "{}");
      },
      expected = {
        actor_id: `user:${userId}`,
        email: "mcp@example.invalid",
        organization_ids: [project.organizationId],
        organizations: [{ id: project.organizationId, name: "Chat workspace" }],
      };

    expect(await identity(await token({}))).toEqual(expected);
    // A token that names its organization is resolved to the platform organization through the Core.
    expect(await identity(await token({ org_id: workosOrganizationId }))).toEqual(expected);

    // An interactive session records its first signup source once, through the Core.
    const seconds = Math.floor(Date.now() / 1000),
      sessionPayload = encode(
        JSON.stringify({
          iss: workosIssuer,
          sub: userId,
          client_id: "client_host",
          org_id: workosOrganizationId,
          sid: "session_mcp",
          iat: seconds,
          exp: seconds + 300,
        }),
      ),
      sessionToken = `${header}.${sessionPayload}.${encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${sessionPayload}`))))}`;
    browserSessionToken = sessionToken;
    const start = await worker.fetch(
      new Request(`${origin}/login/start?r=campaign`, { method: "POST", headers: { origin } }),
      bindings as never,
      { waitUntil: () => undefined },
    );
    expect(start.status).toBe(303);
    const state = new URL(
      start.headers.get("location") ?? "https://missing.invalid",
    ).searchParams.get("state");
    const pendingCookie = start.headers.get("set-cookie")?.split(";")[0];
    expect(state).toBeTruthy();
    expect(pendingCookie).toBeTruthy();
    const callback = await worker.fetch(
      new Request(`${origin}/login/callback?code=fixture&state=${state}`, {
        headers: { cookie: pendingCookie ?? "" },
      }),
      bindings as never,
      { waitUntil: () => undefined },
    );
    expect(callback.status, await callback.clone().text()).toBe(303);
    expect(callback.headers.get("location")).toBe("/");
    expect(callback.headers.get("set-cookie")).toContain("HttpOnly");
    const profileAfterLogin = await worker.fetch(
      new Request(`${origin}/v1/me/profile`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      }),
      bindings as never,
      { waitUntil: () => undefined },
    );
    expect(await profileAfterLogin.json()).toMatchObject({
      user_id: userId,
      signup_source: "campaign",
    });
  } finally {
    await control.dispose();
  }
}, 120_000);
