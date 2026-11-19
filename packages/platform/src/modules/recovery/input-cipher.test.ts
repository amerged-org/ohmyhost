import { webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import { createRecoveryInputCipher, parseRecoveryJobInput } from "./input-cipher.js";

const scope = {
  organizationId: "00000000000000000000000001",
  projectId: "00000000000000000000000002",
  operationId: "00000000000000000000000003",
};
const crypto = webcrypto as unknown as Crypto;
const key = new Uint8Array(32).fill(41);

it("seals job input under its exact tenant and operation without retaining the plaintext", async () => {
  const cipher = createRecoveryInputCipher({ key, keyVersion: 1, crypto });
  const input = new TextEncoder().encode(
    JSON.stringify({
      passphrase: "customer-owned password",
      userSecrets: { API_KEY: "private value" },
    }),
  );
  const sealed = await cipher.seal(scope, input);
  const repeated = await cipher.seal(scope, input);
  expect(sealed.nonce).not.toEqual(repeated.nonce);
  expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain("customer-owned password");
  expect(await cipher.open(scope, sealed)).toEqual(input);
  expect(key).toEqual(new Uint8Array(32).fill(41));
  for (const invalidScope of [
    { ...scope, organizationId: "00000000000000000000000009" },
    { ...scope, projectId: "00000000000000000000000009" },
    { ...scope, operationId: "00000000000000000000000009" },
  ])
    await expect(cipher.open(invalidScope, sealed)).rejects.toThrow(
      "recovery_input_decryption_failed",
    );
  const corrupted = new Uint8Array(sealed.ciphertext);
  corrupted[0] = (corrupted[0] ?? 0) ^ 1;
  await expect(cipher.open(scope, { ...sealed, ciphertext: corrupted })).rejects.toThrow(
    "recovery_input_decryption_failed",
  );
  await expect(
    createRecoveryInputCipher({ key: new Uint8Array(32).fill(42), keyVersion: 1, crypto }).open(
      scope,
      sealed,
    ),
  ).rejects.toThrow("recovery_input_decryption_failed");
});

it("rejects malformed identities, key versions, sizes and nonces without exposing secret data", async () => {
  expect(() =>
    createRecoveryInputCipher({ key: new Uint8Array(31), keyVersion: 1, crypto }),
  ).toThrow("recovery_input_invalid");
  const cipher = createRecoveryInputCipher({ key, keyVersion: 1, crypto });
  await expect(
    cipher.seal({ ...scope, operationId: "invalid" }, new Uint8Array([1])),
  ).rejects.toThrow("recovery_input_invalid");
  await expect(cipher.seal(scope, new Uint8Array())).rejects.toThrow("recovery_input_invalid");
  await expect(cipher.seal(scope, new Uint8Array(2 * 1024 * 1024 + 1))).rejects.toThrow(
    "recovery_input_invalid",
  );
  const sealed = await cipher.seal(scope, new Uint8Array([1]));
  await expect(cipher.open(scope, { ...sealed, keyVersion: 2 })).rejects.toThrow(
    "recovery_input_decryption_failed",
  );
  await expect(cipher.open(scope, { ...sealed, nonce: new Uint8Array(11) })).rejects.toThrow(
    "recovery_input_invalid",
  );
});

it("decodes only the bounded archive password and rejects the retired secret payload", () => {
  const payload = { version: 1, passphrase: "test1234" };
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  expect(parseRecoveryJobInput(encode(payload))).toEqual(payload);
  for (const invalid of [
    null,
    [],
    { ...payload, version: 2 },
    { ...payload, providerKey: "private" },
    { ...payload, secrets: [] },
    { ...payload, passphrase: " " },
    { ...payload, passphrase: "a".repeat(1025) },
  ])
    expect(() => parseRecoveryJobInput(encode(invalid))).toThrow("recovery_input_invalid");
  for (const invalid of [new Uint8Array(), new Uint8Array([0xff]), new Uint8Array(8193)])
    expect(() => parseRecoveryJobInput(invalid)).toThrow("recovery_input_invalid");
});
