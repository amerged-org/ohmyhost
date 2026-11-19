import { describe, expect, it } from "vitest";
import type { AuthenticatedPrincipal } from "../src/contracts.js";
import { createCurrentSessionRevocationPort } from "../src/session-revocation.js";

const principal: AuthenticatedPrincipal = {
  actorId: "user:user_current",
  credentialId: "workos_session:session_current",
  authorizationPrincipal: { kind: "user", subjectId: "user:user_current" },
  organizationIds: [],
};

function fixture(status: number, body: unknown) {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const port = createCurrentSessionRevocationPort({
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

describe("current session revocation port", () => {
  it("revokes exactly the authenticated user's own session", async () => {
    const { port, requests } = fixture(200, { revoked: true });
    await expect(port.revoke(principal)).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        url: "https://auth-status.internal/session-revoke",
        method: "POST",
        body: { userId: "user_current", sessionId: "session_current" },
      },
    ]);
  });

  it("refuses a non-user principal or a non-session credential without calling WorkOS", async () => {
    const { port, requests } = fixture(200, { revoked: true });
    for (const caller of [
      { ...principal, authorizationPrincipal: { kind: "m2m_service", subjectId: "service:svc" } },
      { ...principal, actorId: "service:svc" },
      { ...principal, credentialId: "api_key:current" },
    ] as AuthenticatedPrincipal[])
      await expect(port.revoke(caller)).rejects.toThrow("Current user session is required");
    expect(requests).toEqual([]);
  });

  it("fails unless WorkOS confirms the revocation with exactly the revoked flag", async () => {
    for (const [status, body] of [
      [503, { revoked: true }],
      [200, { revoked: false }],
      [200, { revoked: true, extra: 1 }],
      [200, null],
      [200, ["revoked"]],
    ] as const)
      await expect(fixture(status, body).port.revoke(principal)).rejects.toThrow(
        "Session revocation is unavailable",
      );
  });
});
