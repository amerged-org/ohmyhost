import { expect, it } from "vitest";
import { createCreditWarningRecipients } from "../src/credit-warning-recipients.js";

const organizationId = "01M21T9VB6J0P0QWQJ4J3086ZJ";
const workosId = "org_cwarn12";
const at = (second: number) => `2026-10-28T12:00:${String(second).padStart(2, "0")}.000Z`;
const admins = Array.from(
  { length: 12 },
  (_, index) => `user_cwarn${String(index).padStart(2, "0")}`,
);

/** Twelve active admins in one WorkOS organization, each with a verified address. */
function provider(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === `/organizations/${workosId}`)
    return Promise.resolve(
      Response.json({ id: workosId, name: "Warned", created_at: at(0), updated_at: at(0) }),
    );
  if (url.pathname === "/user_management/organization_memberships")
    return Promise.resolve(
      Response.json({
        object: "list",
        data: admins.map((userId, index) => ({
          id: `om_cwarn${index}`,
          organization_id: workosId,
          user_id: userId,
          status: "active",
          roles: [{ slug: "admin" }],
          created_at: at(0),
          updated_at: at(0),
        })),
        list_metadata: { before: null, after: null },
      }),
    );
  const user = /^\/user_management\/users\/(user_cwarn\d{2})$/u.exec(url.pathname);
  if (user)
    return Promise.resolve(
      Response.json({
        id: user[1],
        object: "user",
        email: `${user[1]}@example.test`,
        email_verified: true,
      }),
    );
  return Promise.reject(new Error(`unexpected ${url.pathname}`));
}

function resolverFor(localOwners: readonly string[]) {
  return createCreditWarningRecipients({
    credential: "test-workos-management",
    fetcher: provider,
    clock: { now: () => new Date("2026-10-28T12:00:00.000Z") },
    persistence: {
      readScope: async () => workosId,
      isOwner: async (_organization, userId) => localOwners.includes(userId),
    },
  });
}

it("warns at most ten verified owners of an organization with more than ten admins, in user order", async () => {
  // An organization with more than ten admins used to fail the whole warning, so no owner was told.
  const resolved = await resolverFor(admins).resolve({
    organizationId,
    exhaustedAt: "2026-10-28T10:00:00.000Z",
  });
  expect(resolved.recipients.map((recipient) => recipient.userId)).toEqual(admins.slice(0, 10));
});

it("warns the local owners of an organization with more than ten admins even when they come last", async () => {
  const owners = [admins[3], admins[9]] as string[];
  const resolved = await resolverFor(owners).resolve({
    organizationId,
    exhaustedAt: "2026-10-28T10:00:00.000Z",
  });
  expect(resolved.recipients.map((recipient) => recipient.userId)).toEqual(owners);
});
