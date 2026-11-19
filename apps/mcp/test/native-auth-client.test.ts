import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { GeneratedSdkLocalMcpClient } from "../src/local-client.js";
import { createLocalOhmyhostMcpHandler } from "../src/local-server.js";

const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const foreignEnvironmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = `/v1/projects/${projectId}/environments/${environmentId}/auth`;
const scope = { project_id: projectId, environment_id: environmentId };

async function nativeFixture() {
  const configuration = {
    enabled: true,
    configurationRevision: 2,
    revocationEpoch: 1,
    signupPolicy: "invite-only",
    canonicalOrigin: "https://app.example.test",
    applicationName: "Application",
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
    readiness: { paid: true, sender: true, origin: true, storage: true },
  };
  const provider = {
    provider: "google",
    enabled: false,
    configured: false,
    clientId: null,
    secretPresent: false,
    callbackUrl: "https://app.example.test/api/auth/v1/callback/google",
    scopes: ["openid", "email", "profile"],
    lastSuccessfulFlowAt: null,
  };
  const user = {
    id: userId,
    email: "invited@example.test",
    status: "pending",
    recoveryAvailable: false,
    createdAt: "2026-11-05T00:00:00.000Z",
  };
  const calls: Array<{
    path: string;
    method: string | undefined;
    authorization: string | undefined;
    idempotency: string | undefined;
    body: unknown;
  }> = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const path = request.url ?? "/";
    const body: unknown = text ? JSON.parse(text) : null;
    calls.push({
      path,
      method: request.method,
      authorization: request.headers.authorization,
      idempotency: request.headers["idempotency-key"] as string | undefined,
      body,
    });
    response.setHeader("content-type", "application/json");
    if (path === base) response.end(JSON.stringify(configuration));
    else if (path === `${base}/providers/google`) response.end(JSON.stringify(provider));
    else if (path === `${base}/users` && request.method === "POST") {
      response.statusCode = 201;
      response.end(JSON.stringify(user));
    } else if (path === `${base}/users/${userId}`) response.end(JSON.stringify(user));
    else if (path === `/v1/projects/${projectId}`)
      response.end(
        JSON.stringify({
          id: projectId,
          organization_id: organizationId,
          name: "Application",
          handle: "native-client",
          data_mode: "shared",
          region: "us",
          created_at: user.createdAt,
        }),
      );
    else if (path === "/v1/me")
      response.end(
        JSON.stringify({
          actor_id: "user:user_01M0CUSTOMER",
          email: "owner@example.test",
          organization_ids: [organizationId],
          organizations: [{ id: organizationId, name: "Workspace" }],
        }),
      );
    else {
      response.statusCode = 404;
      response.end(
        JSON.stringify({
          type: "https://ohmyho.st/problems/resource_not_found",
          title: "Resource not found",
          status: 404,
          code: "resource_not_found",
          request_id: "native-owner-denied",
          retryable: false,
          suggested_action: "Check the selected project and environment.",
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture port");
  const handler = createLocalOhmyhostMcpHandler({
    authenticatedClient: async () =>
      new GeneratedSdkLocalMcpClient(`http://127.0.0.1:${address.port}`, "owner-token", fetch),
  });
  return {
    calls,
    configuration,
    provider,
    user,
    async call(name: string, input: Record<string, unknown>) {
      const response = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: input },
          }),
        }),
      );
      const raw = await response.text();
      const serialized = response.headers.get("content-type")?.startsWith("text/event-stream")
        ? raw
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
        : raw;
      if (!serialized) throw new Error("Missing MCP result");
      const result = JSON.parse(serialized).result as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      return { result, text: result.content?.[0]?.text ?? "" };
    },
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it("carries an Owner's Native configuration and invitation workflow through MCP and the generated REST SDK", async () => {
  const fixture = await nativeFixture();
  try {
    const configuration = await fixture.call("native_auth_config_get", scope);
    expect(configuration.result.isError).not.toBe(true);
    expect(JSON.parse(configuration.text)).toEqual(fixture.configuration);
    const changed = await fixture.call("native_auth_config_set", {
      ...scope,
      configuration_revision: 2,
      enabled: true,
      signup_policy: "invite-only",
      application_name: "Application",
      canonical_origin: "https://app.example.test",
      allowed_redirect_paths: ["/", "/reset-password", "/accept-invitation"],
      reset_password_path: "/reset-password",
      invitation_path: "/accept-invitation",
      idempotency_key: "native-configuration",
    });
    expect(changed.result.isError).not.toBe(true);
    expect(fixture.calls.at(-1)).toMatchObject({
      path: base,
      method: "PUT",
      idempotency: "native-configuration",
      body: {
        configurationRevision: 2,
        enabled: true,
        signupPolicy: "invite-only",
        applicationName: "Application",
        canonicalOrigin: "https://app.example.test",
        allowedRedirectPaths: ["/", "/reset-password", "/accept-invitation"],
        resetPasswordPath: "/reset-password",
        invitationPath: "/accept-invitation",
      },
    });
    const beforeInvalid = fixture.calls.length;
    const invalidOrigin = await fixture.call("native_auth_config_set", {
      ...scope,
      configuration_revision: 2,
      enabled: true,
      signup_policy: "open",
      application_name: "Application",
      canonical_origin: "http://app.example.test",
      idempotency_key: "invalid-origin",
    });
    expect(invalidOrigin.result.isError).toBe(true);
    const duplicate = await fixture.call("native_auth_config_set", {
      ...scope,
      configuration_revision: 2,
      enabled: true,
      signup_policy: "open",
      application_name: "Application",
      allowed_redirect_paths: ["/", "/"],
      idempotency_key: "duplicate-paths",
    });
    expect(duplicate.result.isError).toBe(true);
    const outside = await fixture.call("native_auth_config_set", {
      ...scope,
      configuration_revision: 2,
      enabled: true,
      signup_policy: "open",
      application_name: "Application",
      allowed_redirect_paths: ["/"],
      invitation_path: "/accept-invitation",
      idempotency_key: "outside-path",
    });
    expect(outside.result.isError).toBe(true);
    expect(fixture.calls).toHaveLength(beforeInvalid);
    const provider = await fixture.call("native_auth_provider_get", {
      ...scope,
      provider: "google",
    });
    expect(provider.result.isError).not.toBe(true);
    expect(JSON.parse(provider.text)).toEqual(fixture.provider);
    const updated = await fixture.call("native_auth_provider_set", {
      ...scope,
      provider: "google",
      configuration_revision: 2,
      enabled: false,
      client_id: "customer-client-id",
      idempotency_key: "native-provider",
    });
    expect(updated.result.isError).not.toBe(true);
    expect(fixture.calls.at(-1)).toMatchObject({
      path: `${base}/providers/google`,
      method: "PUT",
      idempotency: "native-provider",
      body: { configurationRevision: 2, enabled: false, clientId: "customer-client-id" },
    });
    const invited = await fixture.call("native_auth_user_create", {
      ...scope,
      email: fixture.user.email,
      idempotency_key: "native-invitation",
    });
    expect(invited.result.isError).not.toBe(true);
    expect(JSON.parse(invited.text)).toEqual(fixture.user);
    expect(fixture.calls.at(-1)).toMatchObject({
      path: `${base}/users`,
      method: "POST",
      idempotency: "native-invitation",
      body: { email: fixture.user.email },
    });
    const user = await fixture.call("native_auth_user_get", { ...scope, user_id: userId });
    expect(user.result.isError).not.toBe(true);
    expect(JSON.parse(user.text)).toEqual(fixture.user);
    const denied = await fixture.call("native_auth_user_get", {
      ...scope,
      environment_id: foreignEnvironmentId,
      user_id: userId,
    });
    expect(denied.result.isError).toBe(true);
    expect(JSON.parse(denied.text).error).toMatchObject({ code: "resource_not_found" });
    expect(denied.text).not.toContain(fixture.user.email);
    expect(fixture.calls.map(({ authorization }) => authorization)).toEqual(
      fixture.calls.map(() => "Bearer owner-token"),
    );
    expect(fixture.calls.filter(({ method }) => method === "GET").map(({ path }) => path)).toEqual([
      base,
      `${base}/providers/google`,
      `${base}/users/${userId}`,
      `/v1/projects/${projectId}/environments/${foreignEnvironmentId}/auth/users/${userId}`,
    ]);
  } finally {
    await fixture.close();
  }
});

it("hands Native provider secret input to the verified token account without sending a secret or mutation", async () => {
  const fixture = await nativeFixture();
  try {
    const handoff = await fixture.call("native_auth_provider_secret_input_request", {
      ...scope,
      provider: "google",
      configuration_revision: 2,
      enabled: true,
      client_id: "customer-client-id",
      idempotency_key: "native-secret-handoff",
    });
    expect(handoff.result.isError).not.toBe(true);
    const answer = JSON.parse(handoff.text);
    expect(answer.command).toContain("auth provider set");
    expect(answer.command).toContain(`--project '${projectId}' --environment '${environmentId}'`);
    expect(answer.command).toContain("--token-user 'user_01M0CUSTOMER'");
    expect(answer.command).toContain(`--token-organization '${organizationId}'`);
    expect(answer.command).toContain("--stdin --json");
    expect(handoff.text).not.toContain("owner-token");
    expect(fixture.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: `/v1/projects/${projectId}` },
      { method: "GET", path: "/v1/me" },
    ]);
    expect(
      fixture.calls.every(({ body, idempotency }) => body === null && idempotency === undefined),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});
