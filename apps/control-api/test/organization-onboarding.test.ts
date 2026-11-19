import { describe, expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import type { AuthenticatedPrincipal } from "../src/contracts.js";
import {
  createOrganizationOnboardingPort,
  OrganizationCreationError,
} from "../src/organization-onboarding.js";

const principal: AuthenticatedPrincipal = {
  actorId: "user:user_new",
  credentialId: "workos_session:session_new",
  authorizationPrincipal: { kind: "user", subjectId: "user:user_new" },
  organizationIds: [],
};
const input = { name: "Acme", signupSource: "cli", idempotencyKey: "create-once" };
const created = { id: "01K2F3G4H5J6K7M8N9P0QRSTVW", name: "Acme" };

function fixture(status: number, body: unknown) {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const port = createOrganizationOnboardingPort({
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

describe("organization onboarding port", () => {
  it("creates the first organization for a user without memberships", async () => {
    const { port, requests } = fixture(201, created);
    expect(await port.create({ principal, ...input })).toEqual(created);
    expect(requests).toEqual([
      {
        url: "https://auth-status.internal/organizations",
        method: "POST",
        body: { initial: true, userId: "user_new", sessionId: "session_new", ...input },
      },
    ]);
  });

  it("marks a further organization as not initial", async () => {
    const { port, requests } = fixture(201, created);
    const member = { ...principal, organizationIds: [parseUlid("01K2F3G4H5J6K7M8N9P0QRSTVX")] };
    await port.create({ principal: member, ...input });
    expect(requests[0]?.body).toMatchObject({ initial: false });
  });

  it("refuses a non-user principal or a non-session credential without calling WorkOS", async () => {
    const { port, requests } = fixture(201, created);
    for (const caller of [
      { ...principal, authorizationPrincipal: { kind: "m2m_service", subjectId: "service:svc" } },
      { ...principal, actorId: "service:svc" },
      { ...principal, credentialId: "api_key:new" },
    ] as AuthenticatedPrincipal[])
      await expect(port.create({ principal: caller, ...input })).rejects.toMatchObject({
        code: "forbidden",
      });
    expect(requests).toEqual([]);
  });

  it("maps the reviewed refusals and hides every other failure as unavailable", async () => {
    const run = (status: number, body: unknown) =>
      fixture(status, body)
        .port.create({ principal, ...input })
        .catch((error: unknown) => error);
    for (const [status, code] of [
      [400, "invalid_request"],
      [403, "forbidden"],
      [409, "idempotency_key_reused"],
    ] as const) {
      const error = await run(status, { error: { code } });
      expect(error).toBeInstanceOf(OrganizationCreationError);
      expect(error).toMatchObject({ code, message: code });
    }
    for (const [status, body] of [
      [403, { error: { code: "invalid_request" } }],
      [500, { error: { code: "forbidden" } }],
      [500, {}],
      [400, "plain text"],
      [400, ["not", "an", "object"]],
    ] as const)
      expect(await run(status, body)).toMatchObject({ code: "service_unavailable" });
  });

  it("rejects a created organization that is malformed", async () => {
    for (const body of [
      { ...created, extra: 1 },
      { id: created.id },
      { id: 7, name: "Acme" },
      { id: created.id, name: "" },
      { id: created.id, name: "n".repeat(129) },
      { id: "not-a-ulid", name: "Acme" },
    ])
      await expect(fixture(201, body).port.create({ principal, ...input })).rejects.toMatchObject({
        code: "service_unavailable",
      });
  });

  it("reports a transport failure as unavailable", async () => {
    const port = createOrganizationOnboardingPort({
      fetch: async () => {
        throw new Error("network");
      },
    });
    await expect(port.create({ principal, ...input })).rejects.toMatchObject({
      code: "service_unavailable",
    });
  });
});
