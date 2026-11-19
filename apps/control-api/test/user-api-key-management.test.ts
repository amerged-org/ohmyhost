import { describe, expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import type { AuthenticatedPrincipal } from "../src/contracts.js";
import {
  createUserApiKeyManagementPort,
  UserApiKeyServiceError,
} from "../src/user-api-key-management.js";

const organizationId = "00000000000000000000000001";
const session = {
  sessionId: "session_current",
  userId: "user_owner",
  organizationId: "org_workos_owned",
  tokenExpiresAt: 1_900_000_000,
};
const withoutSession: AuthenticatedPrincipal = {
  actorId: "user:user_owner",
  credentialId: "workos_session:session_current",
  authorizationPrincipal: { kind: "user", subjectId: "user:user_owner" },
  organizationIds: [parseUlid(organizationId)],
};
const principal: AuthenticatedPrincipal = { ...withoutSession, session };
const key = {
  id: "api_key_1",
  organization_id: organizationId,
  name: "My agent",
  obfuscated_value: "sk_…cccc",
  permissions: ["projects:read"],
  expires_at: null,
  created_at: "2026-10-30T10:00:00.000Z",
  last_used_at: null,
};
const creation = {
  request_id: "00000000000000000000000009",
  replayed: false,
  key,
  value: `sk_${"c".repeat(46)}`,
};

function fixture(status: number, body: unknown) {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const port = createUserApiKeyManagementPort({
    async fetch(request) {
      requests.push({
        url: request.url,
        method: request.method,
        body: JSON.parse(await request.text()),
      });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
  });
  return { port, requests };
}
const sessionScope = {
  organizationId,
  workosOrganizationId: session.organizationId,
  userId: session.userId,
  sessionId: session.sessionId,
  tokenExpiresAt: session.tokenExpiresAt,
};

describe("user API key management port", () => {
  it("creates a key through the private WorkOS action with the session scope", async () => {
    const { port, requests } = fixture(201, creation);
    expect(
      await port.create({ principal, organizationId, name: "My agent", idempotencyKey: "once" }),
    ).toEqual(creation);
    expect(requests).toEqual([
      {
        url: "https://auth-status.internal/user-api-keys/create",
        method: "POST",
        body: { ...sessionScope, name: "My agent", idempotencyKey: "once" },
      },
    ]);
  });

  it("lists a page and revokes one key", async () => {
    const page = { data: [key], next_cursor: null };
    const listed = fixture(200, page);
    expect(await listed.port.list({ principal, organizationId, after: "api_key_0" })).toEqual(page);
    expect(listed.requests).toEqual([
      {
        url: "https://auth-status.internal/user-api-keys/list",
        method: "POST",
        body: { ...sessionScope, after: "api_key_0" },
      },
    ]);
    const revoked = fixture(200, { revoked: true });
    await expect(
      revoked.port.revoke({ principal, organizationId, keyId: "api_key_1" }),
    ).resolves.toBeUndefined();
    expect(revoked.requests[0]).toMatchObject({
      url: "https://auth-status.internal/user-api-keys/revoke",
      body: { ...sessionScope, keyId: "api_key_1" },
    });
  });

  it("only acts for the principal's own current WorkOS session and sends nothing otherwise", async () => {
    const { port, requests } = fixture(200, { revoked: true });
    for (const caller of [
      withoutSession,
      { ...principal, session: { ...session, organizationId: "" } },
      { ...principal, actorId: "user:user_other" },
      { ...principal, credentialId: "workos_session:session_other" },
    ] as AuthenticatedPrincipal[])
      await expect(
        port.revoke({ principal: caller, organizationId, keyId: "api_key_1" }),
      ).rejects.toMatchObject({ code: "forbidden" });
    expect(requests).toEqual([]);
  });

  it("maps reviewed provider error codes and hides everything else as unavailable", async () => {
    const run = (status: number, body: unknown) =>
      fixture(status, body)
        .port.create({ principal, organizationId, name: "My agent", idempotencyKey: "once" })
        .catch((error: unknown) => error);
    for (const code of [
      "invalid_request",
      "forbidden",
      "resource_not_found",
      "idempotency_key_reused",
      "api_key_creation_uncertain",
      "api_key_permissions_unavailable",
    ]) {
      const error = await run(409, { error: { code } });
      expect(error).toBeInstanceOf(UserApiKeyServiceError);
      expect(error).toMatchObject({ code, message: code });
    }
    for (const body of [{ error: { code: "private_canary" } }, { error: null }, {}, "plain text"])
      expect(await run(500, body)).toMatchObject({ code: "service_unavailable" });
  });

  it("rejects a reply for another organization or in the wrong shape", async () => {
    const foreign = { ...key, id: "api_key_2", organization_id: "00000000000000000000000002" };
    await expect(
      fixture(201, { ...creation, key: foreign }).port.create({
        principal,
        organizationId,
        name: "My agent",
        idempotencyKey: "once",
      }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(
      fixture(200, { data: [key, foreign], next_cursor: null }).port.list({
        principal,
        organizationId,
        after: null,
      }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(
      fixture(201, { ...creation, value: "invalid" }).port.create({
        principal,
        organizationId,
        name: "My agent",
        idempotencyKey: "once",
      }),
    ).rejects.toThrow(TypeError);
    for (const reply of [{ revoked: false }, { revoked: true, extra: 1 }, null])
      await expect(
        fixture(200, reply).port.revoke({ principal, organizationId, keyId: "api_key_1" }),
      ).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("reports a transport failure as unavailable", async () => {
    const port = createUserApiKeyManagementPort({
      fetch: async () => {
        throw new Error("network");
      },
    });
    await expect(port.list({ principal, organizationId, after: null })).rejects.toMatchObject({
      code: "service_unavailable",
    });
  });
});
