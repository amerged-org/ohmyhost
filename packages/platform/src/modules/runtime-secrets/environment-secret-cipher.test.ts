import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EnvironmentSecretCipherInputError,
  createEnvironmentSecretCipher,
  createEnvironmentSecretCipherKeyring,
} from "./environment-secret-cipher.js";

const scope = {
  organizationId: "01J00000000000000000000001",
  projectId: "01J00000000000000000000002",
  environmentId: "01J00000000000000000000003",
  name: "DATABASE_URL",
} as const;

const keyBase64 = Buffer.alloc(32, 0x41).toString("base64");
const secondKeyBase64 = Buffer.alloc(32, 0x42).toString("base64");

describe("environment secret cipher", () => {
  it("encrypts and decrypts only under the exact tenant/environment/name scope", async () => {
    const cipher = createEnvironmentSecretCipher({
      keyBase64,
      keyVersion: 3,
      crypto: webcrypto as unknown as Crypto,
    });

    const encrypted = await cipher.encrypt({ ...scope, value: "postgres://user:pass@db/app" });

    expect(encrypted).toMatchObject({
      keyVersion: 3,
      nonce: expect.any(Uint8Array),
      ciphertext: expect.any(Uint8Array),
      valueSha256: expect.any(Uint8Array),
    });
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.valueSha256).toHaveLength(32);
    expect(new TextDecoder().decode(encrypted.ciphertext)).not.toContain("postgres://");
    await expect(cipher.decrypt({ ...scope, ...encrypted })).resolves.toBe(
      "postgres://user:pass@db/app",
    );
    await expect(
      cipher.decrypt({ ...scope, projectId: "01J00000000000000000000004", ...encrypted }),
    ).rejects.toMatchObject({ code: "environment_secret_decryption_failed" });
    const authorization = {
      scope: "organization-authorization" as const,
      organizationId: scope.organizationId,
      authorizationId: scope.projectId,
      name: "GITHUB_CONNECTION",
    };
    const encryptedState = await cipher.encrypt({
      ...authorization,
      value: "csrf-state-and-verifier",
    });
    await expect(cipher.decrypt({ ...authorization, ...encryptedState })).resolves.toBe(
      "csrf-state-and-verifier",
    );
    await expect(
      cipher.decrypt({
        ...authorization,
        organizationId: "01J00000000000000000000009",
        ...encryptedState,
      }),
    ).rejects.toMatchObject({ code: "environment_secret_decryption_failed" });
    await expect(cipher.decrypt({ ...scope, ...encryptedState })).rejects.toMatchObject({
      code: "environment_secret_decryption_failed",
    });
  });

  it("uses a fresh nonce while preserving the plaintext digest for replay detection", async () => {
    let next = 0;
    const cipher = createEnvironmentSecretCipher({
      keyBase64,
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
      randomBytes: (length) => new Uint8Array(length).fill(++next),
    });

    const first = await cipher.encrypt({ ...scope, value: "same-secret" });
    const second = await cipher.encrypt({ ...scope, value: "same-secret" });

    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.valueSha256).toEqual(second.valueSha256);
  });

  it("keys each user digest by purpose and key version, so the stored digest is not a plaintext SHA-256 oracle", async () => {
    const cipher = createEnvironmentSecretCipher({
      keyBase64,
      keyVersion: 3,
      crypto: webcrypto as unknown as Crypto,
    });
    const value = new TextEncoder().encode("low-entropy-user-secret");
    const plain = (await cipher.encrypt({ ...scope, value: "low-entropy-user-secret" }))
      .valueSha256;
    const keyed = await cipher.keyedDigest("value", value);

    expect(keyed).toHaveLength(32);
    expect(keyed).not.toEqual(plain);
    expect(await cipher.keyedDigest("value", value)).toEqual(keyed);
    expect(await cipher.keyedDigest("request", value)).not.toEqual(keyed);
    const nextVersion = createEnvironmentSecretCipher({
      keyBase64,
      keyVersion: 4,
      crypto: webcrypto as unknown as Crypto,
    });
    expect(await nextVersion.keyedDigest("value", value)).not.toEqual(keyed);
    const otherKey = createEnvironmentSecretCipher({
      keyBase64: secondKeyBase64,
      keyVersion: 3,
      crypto: webcrypto as unknown as Crypto,
    });
    expect(await otherKey.keyedDigest("value", value)).not.toEqual(keyed);
    await expect(cipher.keyedDigest("plain" as never, value)).rejects.toBeInstanceOf(
      EnvironmentSecretCipherInputError,
    );
  });

  it("opens a user envelope under its keyed digest, which the plaintext digest check would refuse", async () => {
    const cipher = createEnvironmentSecretCipher({
      keyBase64,
      keyVersion: 2,
      crypto: webcrypto as unknown as Crypto,
    });
    const encrypted = await cipher.encrypt({ ...scope, value: "user-chosen-value" });
    const keyed = await cipher.keyedDigest("value", new TextEncoder().encode("user-chosen-value"));
    const stored = { ...scope, ...encrypted, valueSha256: keyed };

    await expect(cipher.openEnvironmentSecret(stored)).resolves.toBe("user-chosen-value");
    await expect(cipher.decrypt(stored)).rejects.toMatchObject({
      code: "environment_secret_decryption_failed",
    });
    await expect(
      cipher.openEnvironmentSecret({ ...stored, projectId: "01J00000000000000000000004" }),
    ).rejects.toMatchObject({ code: "environment_secret_decryption_failed" });
    await expect(
      cipher.openEnvironmentSecret({
        ...stored,
        ciphertext: new Uint8Array(encrypted.ciphertext).fill(0),
      }),
    ).rejects.toMatchObject({ code: "environment_secret_decryption_failed" });
  });

  it("keys digests and opens user envelopes through the keyring's current version", async () => {
    const keyring = createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: keyBase64,
      currentKeyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });
    const value = new TextEncoder().encode("ring-value");
    const keyed = await keyring.keyedDigest("value", value);
    const single = createEnvironmentSecretCipher({
      keyBase64,
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });
    expect(keyed).toEqual(await single.keyedDigest("value", value));
    const encrypted = await keyring.encrypt({ ...scope, value: "ring-value" });
    await expect(
      keyring.openEnvironmentSecret({ ...scope, ...encrypted, valueSha256: keyed }),
    ).resolves.toBe("ring-value");
  });

  it("rejects malformed keys, names, versions, and empty or oversized values", async () => {
    expect(() =>
      createEnvironmentSecretCipher({
        keyBase64: "not-base64",
        keyVersion: 1,
        crypto: webcrypto as unknown as Crypto,
      }),
    ).toThrow(EnvironmentSecretCipherInputError);
    expect(() =>
      createEnvironmentSecretCipher({
        keyBase64,
        keyVersion: 0,
        crypto: webcrypto as unknown as Crypto,
      }),
    ).toThrow(EnvironmentSecretCipherInputError);
    const cipher = createEnvironmentSecretCipher({
      keyBase64,
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });
    await expect(
      cipher.encrypt({ ...scope, name: "lowercase", value: "secret" }),
    ).rejects.toBeInstanceOf(EnvironmentSecretCipherInputError);
    await expect(cipher.encrypt({ ...scope, value: "" })).rejects.toBeInstanceOf(
      EnvironmentSecretCipherInputError,
    );
    await expect(cipher.encrypt({ ...scope, value: "x".repeat(5_121) })).rejects.toBeInstanceOf(
      EnvironmentSecretCipherInputError,
    );
  });

  it("encrypts with the current key while retaining explicit previous-version decryption", async () => {
    const previousCipher = createEnvironmentSecretCipher({
      keyBase64,
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });
    const previous = await previousCipher.encrypt({ ...scope, value: "previous-secret" });
    const keyring = createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: keyBase64,
      additionalKeysJson: JSON.stringify({ 2: secondKeyBase64 }),
      currentKeyVersion: 2,
      crypto: webcrypto as unknown as Crypto,
    });

    const current = await keyring.encrypt({ ...scope, value: "current-secret" });
    expect(current.keyVersion).toBe(2);
    await expect(keyring.decrypt({ ...scope, ...previous })).resolves.toBe("previous-secret");
    await expect(keyring.decrypt({ ...scope, ...current })).resolves.toBe("current-secret");
  });

  it("rejects malformed, duplicate, missing-current, and unbounded additional keyrings", () => {
    const base = {
      primaryKeyBase64: keyBase64,
      currentKeyVersion: 2,
      crypto: webcrypto as unknown as Crypto,
    };
    for (const additionalKeysJson of [
      "not-json",
      JSON.stringify({ 1: secondKeyBase64 }),
      JSON.stringify({ 2: "not-a-key" }),
      JSON.stringify(
        Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 2, secondKeyBase64])),
      ),
    ]) {
      expect(() => createEnvironmentSecretCipherKeyring({ ...base, additionalKeysJson })).toThrow(
        EnvironmentSecretCipherInputError,
      );
    }
    expect(() =>
      createEnvironmentSecretCipherKeyring({
        ...base,
        additionalKeysJson: JSON.stringify({ 3: secondKeyBase64 }),
      }),
    ).toThrow(EnvironmentSecretCipherInputError);
  });

  it("preloads an allocated dated reader and retains it when rolling the writer back", async () => {
    const datedVersion = 20261106;
    const primary = createEnvironmentSecretCipher({
      keyBase64,
      keyVersion: 1,
      crypto: webcrypto as unknown as Crypto,
    });
    const oldCiphertext = await primary.encrypt({ ...scope, value: "retained-version-one" });
    const readers = {
      primaryKeyBase64: keyBase64,
      additionalKeysJson: JSON.stringify({ [datedVersion]: secondKeyBase64 }),
      crypto: webcrypto as unknown as Crypto,
    };
    const preloaded = createEnvironmentSecretCipherKeyring({ ...readers, currentKeyVersion: 1 });
    const writer = createEnvironmentSecretCipherKeyring({
      ...readers,
      currentKeyVersion: datedVersion,
    });
    const newCiphertext = await writer.encrypt({ ...scope, value: "allocated-dated-writer" });
    expect(newCiphertext.keyVersion).toBe(datedVersion);
    await expect(writer.decrypt({ ...scope, ...oldCiphertext })).resolves.toBe(
      "retained-version-one",
    );
    await expect(preloaded.decrypt({ ...scope, ...newCiphertext })).resolves.toBe(
      "allocated-dated-writer",
    );
    const rollbackWrite = await preloaded.encrypt({ ...scope, value: "rollback-writer-one" });
    expect(rollbackWrite.keyVersion).toBe(1);
    await expect(preloaded.decrypt({ ...scope, ...newCiphertext })).resolves.toBe(
      "allocated-dated-writer",
    );
    await expect(primary.decrypt({ ...scope, ...newCiphertext })).rejects.toBeInstanceOf(
      EnvironmentSecretCipherInputError,
    );
  });
});
