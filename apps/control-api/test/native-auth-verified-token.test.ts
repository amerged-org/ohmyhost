import { expect, it, vi } from "vitest";
import { createControlApi } from "../src/app.js";
import { createWorkosConnectUserAuthenticator } from "../src/workos-authenticator.js";
import { createRemoteOhmyhostMcpHandler } from "../src/remote-mcp.js";
import type { McpPortalAccess } from "../src/remote-mcp-access.js";
import type { AuthenticatedPrincipal } from "../src/contracts.js";
import type { NativeAuthManagementPort } from "../src/native-auth-management.js";
import {
  API,
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

it("enforces Native scopes from a verified signed Connect token at real HTTP routes", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("Missing fixture key");
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    alg: "RS256",
    use: "sig",
    kid: "fixture",
  };
  const time = Date.parse("2026-08-18T10:00:00Z") / 1000;
  const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
  const token = async (actions?: string[]) => {
    const header = encode(
      new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "fixture", typ: "JWT" })),
    );
    const body = encode(
      new TextEncoder().encode(
        JSON.stringify({
          iss: "https://connect.example.test",
          aud: "https://app.ohmyho.st/mcp",
          sub: "user_1",
          client_id: "client_chat",
          org_id: "org_1",
          sid: "app_consent_1",
          jti: "token_1",
          scope: "openid",
          iat: time,
          exp: time + 300,
          ...(actions === undefined ? {} : { ohmyhost_authorization: { actions } }),
        }),
      ),
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${header}.${body}`),
    );
    return `${header}.${body}.${encode(new Uint8Array(signature))}`;
  };
  const verifier = createWorkosConnectUserAuthenticator({
    policy: {
      kind: "connect_user",
      issuer: "https://connect.example.test",
      audience: "https://app.ohmyho.st/mcp",
    },
    verifier: {
      jwks: { load: async () => ({ keys: [jwk] }) },
      clock: { now: () => new Date(time * 1000) },
    },
    organizations: { resolve: async () => ORGANIZATION_ID },
  });
  const config = {
    enabled: true,
    configurationRevision: 1,
    revocationEpoch: 1,
    signupPolicy: "open" as const,
    applicationName: "Example",
    canonicalOrigin: "https://app.example.test",
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
    readiness: { paid: true, sender: true, origin: true, storage: true },
  };
  const getConfiguration = vi.fn(async () => config),
    updateConfiguration = vi.fn(async () => config);
  const internal = new WeakMap<Request, AuthenticatedPrincipal>();
  const app = createControlApi(
    routeDependencies({
      internalAuthentication: {
        resolve: async (request) =>
          internal.get(request) ??
          verifier.authenticate(
            request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "",
          ),
        revalidate: async (principal) => principal,
      },
      remoteAuthorization: async () => true,
      remoteDelegation: async () => ({
        grantId: "00000000-0000-4000-8000-000000000001",
        clientId: "client_chat",
        consentHash: "a".repeat(64),
      }),
      nativeAuthManagement: {
        getConfiguration,
        updateConfiguration,
      } as unknown as NativeAuthManagementPort,
    }),
  );
  const base = `${API}/v1/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/auth`;
  const request = (bearer: string, method: "GET" | "PUT") =>
    app.request(base, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(method === "PUT"
          ? { "Content-Type": "application/json", "Idempotency-Key": "key" }
          : {}),
      },
      ...(method === "PUT"
        ? {
            body: JSON.stringify({
              configurationRevision: 1,
              enabled: true,
              signupPolicy: "open",
              applicationName: "Example",
            }),
          }
        : {}),
    });
  const secretOnly = await token(["secrets:read", "secrets:write"]),
    authRead = await token(["auth:read"]),
    owner = await token();
  const verifiedSecretOnly = await verifier.authenticate(secretOnly);
  expect(verifiedSecretOnly).not.toBeNull();
  expect(verifiedSecretOnly?.authorizationRestriction).toEqual({
    actions: ["secrets:read", "secrets:write"],
  });
  expect((await request(secretOnly, "GET")).status).toBe(404);
  expect((await request(secretOnly, "PUT")).status).toBe(404);
  expect((await request(authRead, "GET")).status).toBe(200);
  expect((await request(authRead, "PUT")).status).toBe(404);
  expect((await request(owner, "PUT")).status).toBe(200);
  expect(updateConfiguration).toHaveBeenCalledOnce();

  const mcp = createRemoteOhmyhostMcpHandler({
    endpoint: "https://app.ohmyho.st/mcp",
    authorizationServers: ["https://connect.example.test"],
    authenticate: (value) => verifier.authenticate(value),
    access: { origin: "https://app.ohmyho.st" } as McpPortalAccess,
    dispatch: async (apiRequest, principal) => {
      internal.set(apiRequest, principal);
      return app.fetch(apiRequest);
    },
  });
  const call = async (bearer: string, name: string, arguments_: unknown) => {
    const response = await mcp.fetch(
      new Request("https://app.ohmyho.st/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: arguments_ },
        }),
      }),
    );
    if (!response) throw new Error("Missing MCP response");
    const text = await response.text();
    const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6)
      : text;
    return JSON.parse(payload ?? "{}") as { result: { isError?: boolean } };
  };
  try {
    const scope = { project_id: PROJECT_ID, environment_id: ENVIRONMENT_ID };
    expect((await call(secretOnly, "native_auth_config_get", scope)).result.isError).toBe(true);
    expect((await call(authRead, "native_auth_config_get", scope)).result.isError).not.toBe(true);
    const update = {
      ...scope,
      configuration_revision: 1,
      enabled: true,
      signup_policy: "open",
      application_name: "Example",
      idempotency_key: "key",
    };
    expect((await call(authRead, "native_auth_config_set", update)).result.isError).toBe(true);
    expect((await call(owner, "native_auth_config_set", update)).result.isError).not.toBe(true);
    expect(updateConfiguration).toHaveBeenCalledTimes(2);
  } finally {
    await mcp.close();
  }
});
