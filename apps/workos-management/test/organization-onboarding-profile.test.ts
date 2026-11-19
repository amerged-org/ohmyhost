import { expect, it } from "vitest";
import { createWorkosOrganizationOnboarding } from "../src/organization-onboarding.js";

const userId = "user_profilepages";
const workosIds = Array.from(
  { length: 120 },
  (_, index) => `org_profile${String(index).padStart(3, "0")}`,
);

it("lists every active membership of a user across the provider's pages", async () => {
  // A user with more than one page of memberships used to get the first hundred only. The other workspaces
  // vanished from the portal, and a session selecting one of them was signed out.
  const onboarding = createWorkosOrganizationOnboarding({
    persistence: { isSessionEligible: async () => true } as never,
    credential: "test-workos-management",
    fetcher: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === `/user_management/users/${userId}`)
        return Response.json({
          id: userId,
          email: "member@example.test",
          email_verified: true,
          first_name: "Member",
          last_name: "Test",
        });
      if (url.pathname === "/user_management/organization_memberships") {
        const start = Number(url.searchParams.get("after") ?? "0");
        const next = start + 100 < workosIds.length ? String(start + 100) : null;
        return Response.json({
          object: "list",
          data: workosIds.slice(start, start + 100).map((organizationId, index) => ({
            id: `om_${start + index}`,
            user_id: userId,
            organization_id: organizationId,
            status: "active",
          })),
          list_metadata: { before: null, after: next },
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    },
    clock: { now: () => new Date("2026-10-28T12:00:00.000Z") },
    ids: { next: () => "01M21T9VB6J0P0QWQJ4J3086ZJ" },
  });
  const profile = await onboarding.profile({ userId, sessionId: "session_profilepages" });
  expect(profile.workos_organization_ids).toEqual(workosIds);
});
