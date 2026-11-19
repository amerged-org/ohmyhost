import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { WorkosUserKeyIdentityPort } from "../src/identity-port.js";
import {
  checkWorkosNativeAuthPermissionDefinitions,
  createWorkosUserApiKeyManagement,
} from "../src/user-api-keys.js";
import { createWorkosUserKeyLifecycle } from "../src/user-key-lifecycle.js";

const scope = { userId: "user_owner", organizationId: "org_owned" };
const expiresAt = "2026-12-08T00:00:00.000Z";
const value = `sk_${"a".repeat(46)}`;
const metadata = {
  object: "api_key",
  id: "api_key_created",
  owner: { type: "user", id: scope.userId, organization_id: scope.organizationId },
  name: "Deployment agent",
  obfuscated_value: "sk_…aaaa",
  permissions: ["projects:read"],
  expires_at: expiresAt,
  created_at: "2026-09-09T00:00:00.000Z",
  last_used_at: null,
};

it("fails closed before key issuance unless both Native provider permission definitions are present", async () => {
  const calls: string[] = [];
  let provisioned = false;
  const fetcher = async (request: Request) => {
    calls.push(`${request.method} ${request.url}`);
    const slug = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "");
    if (request.method === "GET")
      return slug === "auth:manage" && !provisioned
        ? new Response(null, { status: 404 })
        : Response.json({ object: "permission", id: "perm_example", slug });
    if (!provisioned) throw new Error("POST must not execute");
    return Response.json(
      {
        ...metadata,
        name: "Native",
        permissions: ["auth:read", "auth:manage"],
        expires_at: null,
        value,
      },
      { status: 201 },
    );
  };
  const configuration = { credential: "private", fetcher };
  expect(await checkWorkosNativeAuthPermissionDefinitions(configuration)).toEqual({
    ready: false,
    missing: ["auth:manage"],
  });
  const client = createWorkosUserApiKeyManagement(configuration);
  await expect(
    client.create({
      ...scope,
      name: "Native",
      permissions: ["auth:read", "auth:manage"],
      expiresAt: null,
    }),
  ).rejects.toMatchObject({ code: "key_permissions_unavailable" });
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  provisioned = true;
  expect(await checkWorkosNativeAuthPermissionDefinitions(configuration)).toEqual({
    ready: true,
    missing: [],
  });
  await expect(
    client.create({
      ...scope,
      name: "Native",
      permissions: ["auth:read", "auth:manage"],
      expiresAt: null,
    }),
  ).resolves.toMatchObject({ key: { permissions: ["auth:read", "auth:manage"] } });
  expect(calls.filter((call) => call.startsWith("POST "))).toHaveLength(1);
  await expect(
    checkWorkosNativeAuthPermissionDefinitions({
      credential: "private",
      fetcher: async () =>
        Response.json({ object: "permission", slug: "wrong", id: "perm_example" }),
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
});

async function fixture() {
  const requests: {
    method: string;
    path: string;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  let responseValue: unknown = metadata;
  let createStatus = 201;
  let deleted = false;
  let next: string | null = null;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const path = request.url ?? "";
    requests.push({
      method: request.method ?? "GET",
      path,
      authorization: request.headers.authorization,
      body: text ? JSON.parse(text) : null,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "DELETE") {
      // WorkOS answers 404 for a key that is already gone.
      if (deleted) response.writeHead(404).end("{}");
      else {
        deleted = true;
        response.writeHead(204).end();
      }
    } else if (request.method === "POST") {
      response.writeHead(createStatus).end(JSON.stringify(responseValue));
    } else if (path.startsWith("/api_keys/")) {
      response.writeHead(404).end("{}");
    } else {
      response.end(
        JSON.stringify({
          object: "list",
          data: deleted ? [] : [responseValue],
          list_metadata: { after: deleted ? null : next },
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No provider fixture port");
  const configuration = {
    credential: "private-management-canary",
    fetcher: async (request: Request) => {
      const url = new URL(request.url);
      expect(url.origin).toBe("https://api.workos.com");
      expect(request.redirect).toBe("manual");
      expect(request.signal).toBeDefined();
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(request.method === "POST" ? { body: await request.text() } : {}),
      });
    },
  };
  const provider = createWorkosUserApiKeyManagement(configuration);
  return {
    provider,
    configuration,
    requests,
    reply(body: unknown, status = 201) {
      responseValue = body;
      createStatus = status;
    },
    cursor(cursor: string | null) {
      next = cursor;
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

it("creates a scoped user key once, lists only metadata and verifies exact-scope revocation through HTTP", async () => {
  const f = await fixture();
  try {
    f.reply({ ...metadata, value });
    const created = await f.provider.create({
      ...scope,
      name: metadata.name,
      permissions: metadata.permissions,
      expiresAt,
    });
    expect(created.value).toBe(value);
    expect(created.key).toEqual({
      id: metadata.id,
      ...scope,
      name: metadata.name,
      obfuscatedValue: metadata.obfuscated_value,
      permissions: metadata.permissions,
      expiresAt,
      createdAt: metadata.created_at,
      lastUsedAt: null,
    });
    expect(f.requests[0]).toEqual({
      method: "POST",
      path: `/user_management/users/${scope.userId}/api_keys`,
      authorization: "Bearer private-management-canary",
      body: {
        name: metadata.name,
        organization_id: scope.organizationId,
        permissions: metadata.permissions,
        expires_at: expiresAt,
      },
    });
    const page = await f.provider.list(scope);
    expect(page).toEqual({ keys: [created.key], nextCursor: null });
    expect(JSON.stringify(page)).not.toContain(value);
    expect(f.requests[1]?.path).toBe(
      `/user_management/users/${scope.userId}/api_keys?organization_id=${scope.organizationId}&limit=20`,
    );
    f.cursor(metadata.id);
    expect((await f.provider.list({ ...scope, after: "api_key_previous" })).nextCursor).toBe(
      metadata.id,
    );
    expect(f.requests.at(-1)?.path).toContain("after=api_key_previous");
    f.reply({ ...metadata, last_used_at: metadata.created_at });
    expect((await f.provider.get({ ...scope, keyId: metadata.id }))?.lastUsedAt).toBe(
      metadata.created_at,
    );
    expect(await f.provider.revoke({ ...scope, keyId: metadata.id })).toEqual({
      status: "revoked",
    });
    expect(await f.provider.revoke({ ...scope, keyId: metadata.id })).toEqual({ status: "absent" });
    expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
    expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    f.reply({ ...metadata, expires_at: null, value });
    const permanent = await f.provider.create({
      ...scope,
      name: metadata.name,
      permissions: metadata.permissions,
      expiresAt: null,
    });
    expect(permanent.key.expiresAt).toBeNull();
    expect(f.requests.at(-1)?.body).not.toHaveProperty("expires_at");
  } finally {
    await f.close();
  }
});

it("rejects foreign provider keys and malformed input, and reports unavailable key permissions without retrying creation", async () => {
  const f = await fixture();
  const request = { ...scope, name: metadata.name, permissions: metadata.permissions, expiresAt };
  try {
    for (const change of [
      { userId: "../other" },
      { organizationId: "org_bad?all=1" },
      { name: "\nsecret" },
      { permissions: ["*"] },
      { permissions: ["projects:read", "projects:read"] },
      { expiresAt: "tomorrow" },
    ]) {
      await expect(f.provider.create({ ...request, ...change })).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    await expect(f.provider.get({ ...scope, keyId: "../other" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(f.provider.list({ ...scope, after: "../other" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(f.requests).toHaveLength(0);
    f.reply(
      {
        message: "Validation failed",
        errors: [{ field: "permissions", code: "Invalid permission slug: projects:read" }],
      },
      422,
    );
    await expect(f.provider.create(request)).rejects.toMatchObject({
      code: "key_permissions_unavailable",
    });
    expect(f.requests).toHaveLength(1);
    for (const invalid of [
      { ...metadata, owner: { ...metadata.owner, organization_id: "org_foreign" } },
      { ...metadata, owner: { ...metadata.owner, id: "user_foreign" } },
      { ...metadata, owner: { type: "organization", id: scope.organizationId } },
      { ...metadata, name: "\ninvalid" },
      { ...metadata, obfuscated_value: value },
      { ...metadata, created_at: "invalid" },
      { ...metadata, last_used_at: "invalid" },
    ]) {
      f.reply(invalid);
      await expect(f.provider.get({ ...scope, keyId: metadata.id })).rejects.toMatchObject({
        code: "unavailable",
      });
    }
    expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    f.reply({ ...metadata, value, expires_at: "2027-01-01T00:00:00.000Z" });
    await expect(f.provider.create(request)).rejects.toMatchObject({ code: "unavailable" });
    f.reply({ ...metadata, value, permissions: ["projects:write"] });
    await expect(f.provider.create(request)).rejects.toMatchObject({ code: "unavailable" });
    f.reply({ ...metadata, value: "invalid" });
    await expect(f.provider.create(request)).rejects.toMatchObject({ code: "unavailable" });
    f.reply(metadata);
    f.cursor("../invalid");
    await expect(f.provider.list(scope)).rejects.toMatchObject({ code: "unavailable" });
    f.reply({ message: "private-management-canary" }, 503);
    await expect(f.provider.create(request)).rejects.toThrow("unavailable");
  } finally {
    await f.close();
  }
});

const notUsedByRevoke = async (): Promise<never> => {
  throw new Error("not used by revoke");
};

it("records the revoked stage on a retry after the provider key is already gone (IDN-30)", async () => {
  const f = await fixture();
  const now = new Date("2026-11-15T10:00:00.000Z");
  const audits: { stage: string; keyId: string }[] = [];
  let failRevokedOnce = true;
  const identity: WorkosUserKeyIdentityPort = {
    authorizeUserApiKeyScope: async () => undefined,
    claimUserApiKeyCreation: notUsedByRevoke,
    finishUserApiKeyCreation: notUsedByRevoke,
    readUserApiKeyNames: async () => new Map([[metadata.id, metadata.name]]),
    recordUserApiKeyRevocationAudit: async (input) => {
      // The audit store fails once, after the provider has already revoked the key.
      if (input.stage === "revoked" && failRevokedOnce) {
        failRevokedOnce = false;
        throw new Error("audit store unavailable");
      }
      audits.push({ stage: input.stage, keyId: input.keyId });
    },
  };
  const lifecycle = createWorkosUserKeyLifecycle({
    identity,
    credential: f.configuration.credential,
    fetcher: f.configuration.fetcher,
    clock: { now: () => now },
    ids: { next: () => "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  });
  const request = {
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    workosOrganizationId: scope.organizationId,
    userId: scope.userId,
    sessionId: "session_idn30",
    tokenExpiresAt: Math.floor(now.getTime() / 1000) + 3600,
    keyId: metadata.id,
  };
  try {
    await expect(lifecycle.revoke(request)).rejects.toThrow("audit store unavailable");
    expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    // The retry deletes again: WorkOS answers absent for the gone key, and the revoked stage is still recorded.
    await expect(lifecycle.revoke(request)).resolves.toEqual({ revoked: true });
    expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
    expect(audits).toEqual([
      { stage: "requested", keyId: metadata.id },
      { stage: "requested", keyId: metadata.id },
      { stage: "revoked", keyId: metadata.id },
    ]);
  } finally {
    await f.close();
  }
});

it("revokes a key that the user's own creation recorded beyond the tenth provider page, without scanning the listing (IDN-36)", async () => {
  const now = new Date("2026-11-15T10:00:00.000Z");
  const keys = Array.from(
    { length: 250 },
    (_, index) => `api_key_${String(index).padStart(3, "0")}`,
  );
  const target = keys[229] ?? "";
  const requests: string[] = [];
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    // Thirteen cursor pages of twenty keys: the key sits beyond the tenth page.
    const after = url.searchParams.get("after");
    const start = after === null ? 0 : keys.indexOf(after) + 1;
    const ids = keys.slice(start, start + 20);
    return Response.json({
      object: "list",
      data: ids.map((id) => ({ ...metadata, id, name: id })),
      list_metadata: { after: start + 20 < keys.length ? (ids.at(-1) ?? null) : null },
    });
  };
  const lifecycle = createWorkosUserKeyLifecycle({
    identity: {
      authorizeUserApiKeyScope: async () => undefined,
      claimUserApiKeyCreation: notUsedByRevoke,
      finishUserApiKeyCreation: notUsedByRevoke,
      readUserApiKeyNames: async () => new Map([[target, "Recorded"]]),
      recordUserApiKeyRevocationAudit: async () => undefined,
    },
    credential: "private-management-canary",
    fetcher,
    clock: { now: () => now },
    ids: { next: () => "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  });
  await expect(
    lifecycle.revoke({
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workosOrganizationId: scope.organizationId,
      userId: scope.userId,
      sessionId: "session_idn36",
      tokenExpiresAt: Math.floor(now.getTime() / 1000) + 3600,
      keyId: target,
    }),
  ).resolves.toEqual({ revoked: true });
  expect(requests).toEqual([`DELETE /api_keys/${target}`]);
});
