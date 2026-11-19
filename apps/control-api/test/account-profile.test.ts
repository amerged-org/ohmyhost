import { expect, it } from "vitest";
import { createAccountProfilePortWithPersistence } from "../src/account-profile.js";

it("reads a profile that lists the largest workspace list the platform allows", async () => {
  // The workspace list may hold up to a thousand memberships of about thirty characters each, which is far above the
  // old four-kilobyte bound. Such a profile then failed and no workspace could be shown.
  const organizationIds = Array.from(
    { length: 1000 },
    (_, index) => `org_01EHZNVPK3SFK441A1RGBF${String(index).padStart(4, "0")}`,
  );
  let readIds: readonly string[] = [];
  const port = createAccountProfilePortWithPersistence(
    {
      read: async (_userId, ids) => {
        readIds = ids;
        return { memberships: [], origin: null, workspace: null };
      },
      recordSource: async () => {},
    },
    {
      fetch: async () =>
        Response.json({
          user_id: "user_profilelist",
          name: "Member",
          email: "member@example.test",
          email_verified: true,
          workos_organization_ids: organizationIds,
        }),
    } as never,
    () => new Date("2026-10-28T12:00:00.000Z"),
  );
  await port.read({
    actorId: "user:user_profilelist",
    credentialId: "workos_session:session_profilelist",
  } as never);
  expect(readIds).toEqual(organizationIds);
});
