import { expect, it } from "vitest";
import { resolveProductPreviewAuthority } from "../src/preview-product-authority.js";

it("derives preview auth scope from the current capability and rejects old or changing fences", async () => {
  const previewId = "01J00000000000000000000001";
  const projectId = "01J00000000000000000000002";
  const environmentId = "01J00000000000000000000003";
  const fence = { previewId, runtimeGeneration: 1, tokenGeneration: 1 };
  const source = {
    sourceConnectionId: previewId,
    sourceGeneration: 1,
    sequence: 3,
    commitSha: "a".repeat(40),
  };
  let preview = {
    ...fence,
    organizationId: previewId,
    projectId,
    environmentId,
    authGeneration: 7,
    targetSource: source,
    appliedSource: source,
    region: "eu",
    retirement: "none",
  };
  const authority = {
    organizationId: previewId,
    realm: {
      projectId,
      environmentId,
      canonicalOrigin: null,
      realmGeneration: 2,
      configurationRevision: 1,
    },
    ownerEnabled: true,
    storageReady: true,
    paidAllowed: true,
    runtimeAllowed: true,
    revocationEpoch: 2,
    applicationName: "App",
    signupPolicy: "open",
    allowedRedirectPaths: ["/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
  const core = {
    resolveTokenHash: async () => preview,
    resolveNative: async () => ({ preview, authority, registration: {}, launchAllowed: true }),
  };
  const publicOrigin = `https://${"a".repeat(52)}.preview.dev.omh.st`;
  const resolved = await resolveProductPreviewAuthority(core as never, {
    fence,
    publicOrigin,
    hostSuffix: "preview.dev.omh.st",
    region: "eu",
  });
  expect(resolved.preview).toEqual({ previewId, authGeneration: 7 });
  expect(resolved.realm.canonicalOrigin).toBe(publicOrigin);
  preview = { ...preview, tokenGeneration: 2 };
  await expect(
    resolveProductPreviewAuthority(core as never, {
      fence,
      publicOrigin,
      hostSuffix: "preview.dev.omh.st",
      region: "eu",
    }),
  ).rejects.toThrow("auth_unavailable");
  preview = { ...preview, tokenGeneration: 1, targetSource: { ...source, sequence: 4 } };
  await expect(
    resolveProductPreviewAuthority(core as never, {
      fence,
      publicOrigin,
      hostSuffix: "preview.dev.omh.st",
      region: "eu",
    }),
  ).rejects.toThrow("auth_unavailable");
});
