import { expect, it, vi } from "vitest";
import { createNativePreviewAuthMail } from "../src/native-preview-auth-mail.js";

const ids = {
  organizationId: "00000000000000000000000001",
  projectId: "00000000000000000000000002",
  environmentId: "00000000000000000000000003",
};
const previewId = "a".repeat(32);
const origin = `https://${previewId}-${"b".repeat(24)}.preview.dev.omh.st`;
const qa = {
  platform: "development",
  ...ids,
  region: "eu",
  previewId,
  previewOrigin: origin,
  authGeneration: 1,
  devAccessEpoch: 2,
  revocationEpoch: 3,
  configurationRevision: 4,
  enabled: true,
  sourceCapable: true,
  paidAllowed: true,
  runtimeAllowed: true,
};
const sender = {
  ...ids,
  domain: "example.test",
  canonicalOrigin: "https://app.example.test",
  applicationName: "QA fixture",
  allowedRedirectPaths: ["/", "/reset-password", "/accept-invitation"],
  resetPasswordPath: "/reset-password",
  invitationPath: "/accept-invitation",
};
const scope = JSON.stringify({
  platform: "development",
  fixture: "next-native-auth",
  ...ids,
  recipients: ["first@example.test", "second@example.test"],
});
const request = {
  ...ids,
  previewId,
  authGeneration: 1,
  kind: "verification",
  to: "first@example.test",
  url: `${origin}/api/auth/v1/verify-email?token=private&callbackURL=%2F`,
  messageId: "00000000-0000-4000-8000-000000000001",
};

it("uses a current QA preview origin and sender, with stable private idempotency and two allowed recipients", async () => {
  const resolve = vi.fn(async () => ({ ...qa }));
  const authorize = vi.fn(async () => ({ ...sender }));
  const send = vi.fn(async () => ({ status: "accepted" }));
  const dispatch = createNativePreviewAuthMail({ scope, resolve, authorize, send });
  expect(await dispatch(request)).toEqual({ status: "accepted" });
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: `native-preview:${previewId}:1:${request.messageId}`,
      to: request.to,
      text: expect.stringContaining(request.url),
    }),
    expect.objectContaining({ ...ids, domain: sender.domain }),
  );
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(authorize).toHaveBeenCalledTimes(3);
  expect(await dispatch({ ...request, to: "second@example.test" })).toEqual({ status: "accepted" });
  expect(
    await dispatch({
      ...request,
      kind: "password-reset",
      url: `${origin}/reset-password?token=private`,
    }),
  ).toEqual({ status: "accepted" });
});

it("fails closed on foreign recipient, scope, origin or stale authority and preserves unknown outcomes", async () => {
  const send = vi.fn(async () => ({ status: "accepted" }));
  const resolve = vi.fn(async () => ({ ...qa }));
  const authorize = vi.fn(async () => ({ ...sender }));
  const dispatch = createNativePreviewAuthMail({ scope, resolve, authorize, send });
  for (const invalid of [
    { ...request, to: "outside@example.test" },
    { ...request, environmentId: "00000000000000000000000004" },
    { ...request, url: "https://app.example.test/api/auth/v1/verify-email?token=x" },
    {
      ...request,
      url: `${origin}/api/auth/v1/verify-email?token=x&callbackURL=https%3A%2F%2Fevil.test`,
    },
    { ...request, kind: "invitation" },
    { ...request, unexpected: true },
  ])
    await expect(dispatch(invalid)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  const changing = createNativePreviewAuthMail({
    scope,
    resolve: vi
      .fn()
      .mockResolvedValueOnce(qa)
      .mockResolvedValue({ ...qa, revocationEpoch: 4 }),
    authorize,
    send,
  });
  await expect(changing(request)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  for (const invalid of [
    { ...qa, previewOrigin: "https://foreign.example.test" },
    { ...qa, projectId: "00000000000000000000000004" },
    { ...qa, platform: "production" },
    { ...qa, enabled: false },
    { ...qa, unexpected: true },
  ]) {
    const invalidAuthority = createNativePreviewAuthMail({
      scope,
      resolve: async () => invalid,
      authorize,
      send,
    });
    await expect(invalidAuthority(request)).rejects.toThrow();
  }
  const senderChanged = createNativePreviewAuthMail({
    scope,
    resolve,
    authorize: vi
      .fn()
      .mockResolvedValueOnce(sender)
      .mockResolvedValue({ ...sender, domain: "other.test" }),
    send,
  });
  await expect(senderChanged(request)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  const duplicateRecipients = createNativePreviewAuthMail({
    scope: JSON.stringify({
      platform: "development",
      fixture: "next-native-auth",
      ...ids,
      recipients: [request.to, request.to],
    }),
    resolve,
    authorize,
    send,
  });
  await expect(duplicateRecipients(request)).rejects.toThrow();
  const lost = createNativePreviewAuthMail({
    scope,
    resolve,
    authorize,
    send: async () => {
      throw new Error("private provider data");
    },
  });
  await expect(lost(request)).resolves.toEqual({ status: "uncertain" });
  const revokedAfterSend = createNativePreviewAuthMail({
    scope,
    resolve: vi.fn().mockResolvedValueOnce(qa).mockResolvedValueOnce(qa).mockResolvedValue(null),
    authorize,
    send,
  });
  await expect(revokedAfterSend(request)).resolves.toEqual({ status: "uncertain" });
});

it("accepts eight explicitly authorized addresses while rejecting duplicate, oversized and unlisted recipients", async () => {
  const recipients = Array.from({ length: 8 }, (_, index) => `qa-${index + 1}@example.test`);
  const resolve = vi.fn(async () => ({ ...qa }));
  const authorize = vi.fn(async () => ({ ...sender }));
  const send = vi.fn(async () => ({ status: "accepted" }));
  const first = "qa-1@example.test";
  const makeDispatch = (addresses: string[]) =>
    createNativePreviewAuthMail({
      scope: JSON.stringify({
        platform: "development",
        fixture: "next-native-auth",
        ...ids,
        recipients: addresses,
      }),
      resolve,
      authorize,
      send,
    });
  const dispatch = makeDispatch(recipients);
  for (const to of recipients)
    await expect(dispatch({ ...request, to })).resolves.toEqual({ status: "accepted" });
  expect(send).toHaveBeenCalledTimes(8);
  send.mockClear();
  for (const invalid of [
    [first],
    [...recipients, "ninth@example.test"],
    [first, first],
    [first, first.toUpperCase()],
  ]) {
    const to = invalid[0];
    if (to === undefined) throw new Error("test_recipient_missing");
    await expect(makeDispatch(invalid)({ ...request, to })).rejects.toThrow();
  }
  await expect(dispatch({ ...request, to: "outside@example.test" })).rejects.toThrow();
  await expect(dispatch({ ...request, to: first.toUpperCase() })).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
