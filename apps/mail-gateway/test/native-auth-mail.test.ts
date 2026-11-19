import { expect, it, vi } from "vitest";
import { createNativeAuthMail } from "../src/native-auth-mail.js";

const scope = {
  organizationId: "00000000000000000000000001",
  projectId: "00000000000000000000000002",
  environmentId: "00000000000000000000000003",
};
const authority = {
  ...scope,
  domain: "example.test",
  canonicalOrigin: "https://app.example.test",
  applicationName: "Example",
  allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
  resetPasswordPath: "/reset-password",
  invitationPath: "/accept-invitation",
};
const invitation = {
  ...scope,
  kind: "invitation" as const,
  to: "user@example.test",
  url: "https://app.example.test/accept-invitation?token=secret",
  messageId: "00000000-0000-4000-8000-000000000001",
};

it("uses the current realm and sender, preserving logical environment and durable message identity", async () => {
  const send = vi.fn(async () => ({ status: "accepted" }));
  const dispatch = createNativeAuthMail({ authorize: async () => authority, send });
  expect(await dispatch(invitation)).toEqual({ status: "accepted" });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: `native-auth:${scope.environmentId}:${invitation.messageId}`,
    }),
    expect.objectContaining(scope),
  );
  expect(JSON.stringify(await dispatch(invitation))).not.toContain("secret");
});

it("fails closed for another realm, origin, path, repeated token or unsafe callback", async () => {
  const send = vi.fn(async () => ({ status: "accepted" }));
  const dispatch = createNativeAuthMail({ authorize: async () => authority, send });
  for (const input of [
    { ...invitation, environmentId: "00000000000000000000000004" },
    { ...invitation, url: "https://evil.example/accept-invitation?token=x" },
    { ...invitation, url: "https://app.example.test/login?token=x" },
    { ...invitation, url: "https://app.example.test/accept-invitation?token=x&token=y" },
    {
      ...invitation,
      kind: "verification",
      url: "https://app.example.test/api/auth/v1/verify-email?token=x&callbackURL=https%3A%2F%2Fevil.example",
    },
  ])
    await expect(dispatch(input)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  await expect(
    dispatch({
      ...invitation,
      kind: "verification",
      url: "https://app.example.test/api/auth/v1/verify-email?token=x&callbackURL=%2F",
    }),
  ).resolves.toEqual({ status: "accepted" });
});
