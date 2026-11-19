import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CloudflareTokenDecryptionError, createCloudflareDomainSecrets } from "../src/secrets.js";

const KEY = Buffer.alloc(32, 0x41).toString("base64");

describe("Cloudflare project OAuth secret boundary", () => {
  it("derives a stable opaque state signature without exposing the signing key", async () => {
    const first = createCloudflareDomainSecrets({
      keyBase64: KEY,
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });
    const second = createCloudflareDomainSecrets({
      keyBase64: KEY,
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });

    const signature = await first.stateSigner.sign("authorization-state-input");

    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(second.stateSigner.sign("authorization-state-input")).resolves.toBe(signature);
    expect(signature).not.toContain(KEY);
  });

  it("seals OAuth tokens with random AES-GCM nonces and exact associated data", async () => {
    const { tokenCipher } = createCloudflareDomainSecrets({
      keyBase64: KEY,
      keyVersion: 7,
      crypto: webcrypto as unknown as Crypto,
    });
    const associatedData = "ohmyhost.cloudflare-project-grant/v1:scope:access";
    const first = await tokenCipher.seal("provider-access-token", associatedData);
    const second = await tokenCipher.seal("provider-access-token", associatedData);

    expect(first.keyVersion).toBe(7);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    await expect(tokenCipher.open({ ...first, associatedData })).resolves.toBe(
      "provider-access-token",
    );
    await expect(
      tokenCipher.open({ ...first, associatedData: `${associatedData}:wrong` }),
    ).rejects.toBeInstanceOf(CloudflareTokenDecryptionError);
    await expect(
      tokenCipher.open({ ...first, keyVersion: 8, associatedData }),
    ).rejects.toBeInstanceOf(CloudflareTokenDecryptionError);

    const secondKey = Buffer.alloc(32, 0x42).toString("base64");
    const replacementKey = Buffer.alloc(32, 0x43).toString("base64");
    const productionOld = createCloudflareDomainSecrets({
      keyBase64: KEY,
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });
    const developmentOld = createCloudflareDomainSecrets({
      keyBase64: secondKey,
      keyVersion: 2,
      crypto: webcrypto as unknown as Crypto,
    });
    const rotated = createCloudflareDomainSecrets({
      keyBase64: replacementKey,
      keyVersion: 20261106,
      additionalKeysJson: JSON.stringify({ 1: KEY, 2: secondKey }),
      crypto: webcrypto as unknown as Crypto,
    });
    const oldProductionGrant = await productionOld.tokenCipher.seal(
      "production-grant-token",
      associatedData,
    );
    const oldDevelopmentGrant = await developmentOld.tokenCipher.seal(
      "development-grant-token",
      `${associatedData}:refresh`,
    );
    await expect(rotated.tokenCipher.open({ ...oldProductionGrant, associatedData })).resolves.toBe(
      "production-grant-token",
    );
    await expect(
      rotated.tokenCipher.open({
        ...oldDevelopmentGrant,
        associatedData: `${associatedData}:refresh`,
      }),
    ).resolves.toBe("development-grant-token");
    const current = await rotated.tokenCipher.seal("replacement-grant-token", associatedData);
    expect(current.keyVersion).toBe(20261106);
    const readersFirst = createCloudflareDomainSecrets({
      keyBase64: KEY,
      keyVersion: 1,
      additionalKeysJson: JSON.stringify({ 2: secondKey, 20261106: replacementKey }),
      crypto: webcrypto as unknown as Crypto,
    });
    await expect(readersFirst.tokenCipher.open({ ...current, associatedData })).resolves.toBe(
      "replacement-grant-token",
    );
    expect(
      (await readersFirst.tokenCipher.seal("old-writer-still-active", associatedData)).keyVersion,
    ).toBe(1);
    // An old invocation may finish after the new writer starts. Stored versions remain readable.
    const lateOldGrant = await productionOld.tokenCipher.seal(
      "late-provider-refresh-token",
      associatedData,
    );
    await expect(rotated.tokenCipher.open({ ...lateOldGrant, associatedData })).resolves.toBe(
      "late-provider-refresh-token",
    );
    await expect(
      rotated.tokenCipher.open({ ...oldProductionGrant, keyVersion: 2, associatedData }),
    ).rejects.toBeInstanceOf(CloudflareTokenDecryptionError);
    await expect(
      rotated.tokenCipher.open({ ...current, associatedData: `${associatedData}:foreign-project` }),
    ).rejects.toBeInstanceOf(CloudflareTokenDecryptionError);
    const corrupted = Buffer.from(current.ciphertext, "base64");
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    await expect(
      rotated.tokenCipher.open({
        ...current,
        ciphertext: corrupted.toString("base64"),
        associatedData,
      }),
    ).rejects.toBeInstanceOf(CloudflareTokenDecryptionError);
  });

  it("rejects non-canonical keys and malformed encrypted payloads", async () => {
    expect(() =>
      createCloudflareDomainSecrets({
        keyBase64: "not-base64",
        keyVersion: 1,
        crypto: webcrypto as unknown as Crypto,
      }),
    ).toThrow(TypeError);
    for (const additionalKeysJson of [
      "{",
      "null",
      "[]",
      JSON.stringify({ 0: KEY }),
      JSON.stringify({ "01": KEY }),
      JSON.stringify({ 1: KEY }),
      JSON.stringify({ 2: "invalid-key" }),
      JSON.stringify(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 2, KEY]))),
    ]) {
      expect(() =>
        createCloudflareDomainSecrets({
          keyBase64: KEY,
          keyVersion: 1,
          additionalKeysJson,
          crypto: webcrypto as unknown as Crypto,
        }),
      ).toThrow(TypeError);
    }
    const { tokenCipher } = createCloudflareDomainSecrets({
      keyBase64: KEY,
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });
    await expect(
      tokenCipher.open({
        ciphertext: "AAAA",
        nonce: Buffer.alloc(12).toString("base64"),
        keyVersion: 1,
        associatedData: "ohmyhost.cloudflare-project-grant/v1:scope:access",
      }),
    ).rejects.toBeInstanceOf(CloudflareTokenDecryptionError);
  });
});
