import { expect, it, vi } from "vitest";
import type { PreviewRuntimeRecord } from "@ohmyhost/contracts/previews";
import { createProductPreviewAuthMail } from "../src/product-preview-auth-mail.js";

it("authorizes real product preview mail against the current token and sender and preserves an uncertain send", async () => {
  const scope = {
    organizationId: "00000000000000000000000001",
    projectId: "00000000000000000000000002",
    environmentId: "00000000000000000000000003",
  };
  const preview = {
    ...scope,
    previewId: "00000000000000000000000004",
    runtimeGeneration: 1,
    tokenGeneration: 1,
    authGeneration: 1,
    retirement: "none",
    state: "ready",
  } as unknown as PreviewRuntimeRecord;
  const sender = {
    ...scope,
    domain: "example.test",
    canonicalOrigin: "https://app.example.test",
    applicationName: "App",
    allowedRedirectPaths: ["/", "/reset", "/invite"],
    resetPasswordPath: "/reset",
    invitationPath: "/invite",
  };
  let current = preview;
  const send = vi.fn(async () => ({ status: "accepted" }));
  const dispatch = createProductPreviewAuthMail({
    platform: "development",
    preview: { resolveTokenHash: async () => current, authorizeRuntime: async () => current },
    authorize: async () => sender,
    send,
  });
  const request = {
    ...scope,
    previewId: preview.previewId,
    authGeneration: 1,
    kind: "verification",
    to: "person@example.test",
    url: `https://${"a".repeat(52)}.preview.dev.omh.st/api/auth/v1/verify-email?token=private&callbackURL=%2F`,
    messageId: "00000000-0000-4000-8000-000000000001",
  };
  expect(await dispatch(request)).toEqual({ status: "accepted" });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: `native-preview:${preview.previewId}:1:${request.messageId}`,
    }),
    expect.objectContaining(scope),
  );
  await expect(
    dispatch({ ...request, environmentId: "00000000000000000000000005" }),
  ).rejects.toThrow();
  await expect(
    dispatch({ ...request, url: "https://foreign.test/api/auth/v1/verify-email?token=private" }),
  ).rejects.toThrow();
  expect(send).toHaveBeenCalledOnce();
  send.mockImplementationOnce(async () => {
    current = { ...preview, authGeneration: 2 };
    return { status: "accepted" };
  });
  expect(await dispatch(request)).toEqual({ status: "uncertain" });
  expect(send).toHaveBeenCalledTimes(2);
});
