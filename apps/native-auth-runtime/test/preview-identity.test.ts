import { getCookies } from "better-auth/cookies";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createNativeAuthEngineOptions } from "../src/engine.js";
import { nativePreviewSecret, readNativePreviewIdentity } from "../src/preview-identity.js";

it("keeps preview cookies stable across source edits and wake, isolated by persisted Auth generation", () => {
  const preview = { previewId: "a".repeat(32), authGeneration: 7 };
  const secret = "s".repeat(48);
  expect(readNativePreviewIdentity(preview)).toEqual(preview);
  const derived = nativePreviewSecret(secret, preview);
  expect(derived).toHaveLength(64);
  expect(nativePreviewSecret(secret, { ...preview })).toBe(derived);
  expect(nativePreviewSecret(secret, { ...preview, authGeneration: 8 })).not.toBe(derived);
  expect(nativePreviewSecret(secret, { ...preview, previewId: "b".repeat(32) })).not.toBe(derived);
  const product = { previewId: "01J00000000000000000000001", authGeneration: 7 };
  expect(readNativePreviewIdentity(product)).toEqual(product);
  expect(nativePreviewSecret(secret, product)).toBe(nativePreviewSecret(secret, { ...product }));
  expect(nativePreviewSecret(secret, { ...product, authGeneration: 8 })).not.toBe(
    nativePreviewSecret(secret, product),
  );
  expect(derived).not.toBe(secret);
  const cookies = getCookies(
    createNativeAuthEngineOptions({
      canonicalOrigin: `https://${preview.previewId}-${"a".repeat(24)}.preview.dev.omh.st`,
      applicationName: "Native Auth",
      secret: derived,
      previewId: preview.previewId,
      database: new Pool({ connectionString: "postgres://127.0.0.1:1/unused" }),
      sendMail: async () => undefined,
    }),
  );
  for (const cookie of Object.values(cookies)) {
    expect(cookie.name).toMatch(new RegExp(`^__Host-omh_native_preview_${preview.previewId}\\.`));
    expect(cookie.attributes).toMatchObject({ secure: true, path: "/" });
    expect(cookie.attributes.domain).toBeUndefined();
  }
  expect(cookies.sessionToken.attributes).toMatchObject({ httpOnly: true, sameSite: "lax" });
  for (const invalid of [
    null,
    { ...preview, commit: "a".repeat(40) },
    { ...preview, expiresAt: "2099-01-01T00:00:00Z" },
    { ...preview, authGeneration: 0 },
    { ...preview, authGeneration: 2_147_483_648 },
    { ...preview, previewId: "A".repeat(32) },
  ])
    expect(() => readNativePreviewIdentity(invalid)).toThrow();
});
