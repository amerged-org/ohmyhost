import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createWorkosUserApiKeyValidation } from "../../workos-management/src/user-api-keys.js";
import { createPrivateServiceBindingHandler } from "../../workos-management/src/service-binding.js";
import { createWorkosUserApiKeyClient } from "../src/workos-user-api-keys.js";
import { createWorkosBearerAuthenticator } from "../src/workos-authenticator.js";
import {
  parseWorkosUserApiKeyRequest,
  parseWorkosUserApiKeyResponse,
  parseWorkosUserApiKeyObservationRequest,
} from "../../../packages/workos-auth-contracts/src/user-api-keys.js";

it("validates user keys through private HTTP, preserves permission limits and denies expired or foreign identities", async () => {
  const secret = `sk_${"a".repeat(46)}`;
  const metadata = {
    object: "api_key",
    id: "api_key_01M21N4J2M8YGEY6QQ5DRRMJ6E",
    owner: { type: "user", id: "user_owner", organization_id: "org_owned" },
    permissions: ["projects:read"],
    expires_at: "2026-12-08T00:00:00.000Z",
  };
  let key: unknown = metadata;
  let status = 200;
  const received: { path?: string; authorization?: string; body: string }[] = [];
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    received.push({ path: request.url, authorization: request.headers.authorization, body });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.method === "GET"
          ? {
              object: "list",
              data:
                key === null
                  ? []
                  : [
                      {
                        ...(key as object),
                        name: "Consent key",
                        obfuscated_value: "sk_...abcd",
                        created_at: "2026-09-09T00:00:00.000Z",
                        last_used_at: null,
                      },
                    ],
              list_metadata: { after: null },
            }
          : { api_key: key },
      ),
    );
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No provider fixture port");
  const transport = {
    async fetch(request: Request) {
      expect(request.url).toBe(
        request.method === "GET"
          ? "https://api.workos.com/user_management/users/user_owner/api_keys?organization_id=org_owned&limit=20"
          : "https://api.workos.com/api_keys/validations",
      );
      expect(["GET", "POST"]).toContain(request.method);
      const url = new URL(request.url);
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(request.method === "POST" ? { body: await request.text() } : {}),
      });
    },
  };
  const handler = createPrivateServiceBindingHandler({
    rpc: {} as never,
    userApiKeys: createWorkosUserApiKeyValidation({
      credential: "private-provider-canary",
      fetcher: transport.fetch,
    }),
  });
  const org = parseUlid("00000000000000000000000001");
  const authenticator = createWorkosBearerAuthenticator({
    policies: [{ kind: "session", issuer: "https://auth.example.test", clientId: "client_public" }],
    verifier: {
      clock: { now: () => new Date("2026-09-09T00:00:00.000Z") },
      jwks: { load: async () => ({ keys: [] }) },
    },
    sessionStatus: { isActive: async () => false },
    apiKeys: createWorkosUserApiKeyClient(handler),
    organizations: {
      resolve: async (id) => (id === "org_owned" ? org : null),
      resolveM2m: async () => null,
    },
  });
  try {
    const principal = await authenticator.authenticate(secret);
    expect(principal).toEqual({
      userApiKey: {
        id: metadata.id,
        userId: "user_owner",
        organizationId: "org_owned",
        permissions: ["projects:read"],
        expiresAt: metadata.expires_at,
      },
      actorId: "user:user_owner",
      credentialId: `user_api_key:${metadata.id}`,
      authorizationPrincipal: { kind: "user", subjectId: "user:user_owner" },
      organizationIds: [org],
      authorizationScopeConstraint: ["projects:read"],
    });
    expect(received[0]).toEqual({
      path: "/api_keys/validations",
      authorization: "Bearer private-provider-canary",
      body: JSON.stringify({ value: secret }),
    });
    expect(JSON.stringify(principal)).not.toContain(secret);
    expect(JSON.stringify(principal)).not.toContain("private-provider-canary");
    const client = createWorkosUserApiKeyClient(handler);
    const scope = { keyId: metadata.id, userId: "user_owner", organizationId: "org_owned" };
    expect(parseWorkosUserApiKeyObservationRequest(scope)).toEqual(scope);
    expect(() => parseWorkosUserApiKeyObservationRequest({ ...scope, value: secret })).toThrow();
    expect(await client.observe(scope)).toEqual(principal?.userApiKey);
    expect(received.at(-1)).toMatchObject({
      path: "/user_management/users/user_owner/api_keys?organization_id=org_owned&limit=20",
      body: "",
    });
    expect(await client.observe({ ...scope, keyId: "api_key_absent" })).toBeNull();
    key = null;
    expect(await client.observe(scope)).toBeNull();
    key = { ...metadata, owner: { ...metadata.owner, id: "user_foreign" } };
    await expect(client.observe(scope)).rejects.toThrow("api_key_validation_unavailable");
    for (const invalid of [
      { ...scope, value: secret },
      { ...scope, keyId: "../other" },
      { ...scope, userId: null },
      { ...scope, organizationId: "foreign" },
    ]) {
      const count = received.length;
      const response = await handler.fetch(
        new Request("https://auth-status.internal/api-key-observe", {
          method: "POST",
          body: JSON.stringify(invalid),
        }),
      );
      expect(response.status).toBe(400);
      expect(received).toHaveLength(count);
    }
    key = metadata;
    expect(parseWorkosUserApiKeyRequest({ value: secret })).toEqual({ value: secret });
    expect(parseWorkosUserApiKeyResponse({ key: null })).toEqual({ key: null });
    expect(
      parseWorkosUserApiKeyResponse({
        key: {
          id: metadata.id,
          userId: "user_owner",
          organizationId: "org_owned",
          permissions: ["projects:read"],
          expiresAt: metadata.expires_at,
        },
      }).key?.permissions,
    ).toEqual(["projects:read"]);
    key = { ...metadata, permissions: [] };
    expect((await authenticator.authenticate(secret))?.authorizationScopeConstraint).toEqual([]);
    key = { ...metadata, permissions: ["widgets:users-table:manage"] };
    expect((await authenticator.authenticate(secret))?.authorizationScopeConstraint).toEqual([]);
    for (const invalid of [
      null,
      { ...metadata, expires_at: "2026-09-08T00:00:00.000Z" },
      { ...metadata, owner: { type: "organization", id: "org_owned" } },
      { ...metadata, owner: { ...metadata.owner, organization_id: "org_foreign" } },
    ]) {
      key = invalid;
      expect(await authenticator.authenticate(secret)).toBeNull();
    }
    key = { ...metadata, permissions: [3] };
    await expect(authenticator.authenticate(secret)).rejects.toThrow();
    status = 503;
    await expect(authenticator.authenticate(secret)).rejects.toThrow();
    const count = received.length;
    expect(await authenticator.authenticate("sk_invalid")).toBeNull();
    const invalidRequest = await handler.fetch(
      new Request("https://auth-status.internal/api-key-validate", {
        method: "POST",
        body: JSON.stringify({ value: secret, organizationId: "org_foreign" }),
      }),
    );
    expect(invalidRequest.status).toBe(400);
    expect(received).toHaveLength(count);
  } finally {
    provider.close();
    await once(provider, "close");
  }
});
