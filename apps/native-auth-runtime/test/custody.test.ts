import { expect, it } from "vitest";
import { createEnvironmentSecretCipher } from "@ohmyhost/platform";
import { nativeCustody, type NativeCustodyBindings } from "../src/custody.js";

const oldKey = Buffer.alloc(32, 0x61).toString("base64");
const newKey = Buffer.alloc(32, 0x7a).toString("base64");
const scope = {
  organizationId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
  projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
  environmentId: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
};
const bindings = (key: string, version: number, additional?: string): NativeCustodyBindings => ({
  NATIVE_AUTH_CUSTODY_KEY_BASE64: key,
  NATIVE_AUTH_CUSTODY_KEY_VERSION: version,
  ...(additional === undefined ? {} : { NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON: additional }),
});

it("retains legacy URI and engine readers while the sole current writer labels its actual key", async () => {
  const legacy = nativeCustody(bindings(oldKey, 1));
  const current = nativeCustody(bindings(newKey, 20261106, JSON.stringify({ 1: oldKey })));
  const identity = { ...scope, name: "NATIVE_AUTH_ENGINE_SECRET" };
  const old = await legacy.encrypt({ ...identity, value: "stable-inner-engine-secret" });
  expect(await current.decrypt({ ...identity, ...old })).toBe("stable-inner-engine-secret");
  expect(old.keyVersion).toBe(1);
  const next = await current.encrypt({ ...identity, value: "current-private-credential" });
  expect(next.keyVersion).toBe(20261106);
  const newOnly = createEnvironmentSecretCipher({
    keyBase64: newKey,
    keyVersion: 20261106,
    crypto,
  });
  expect(await newOnly.decrypt({ ...identity, ...next })).toBe("current-private-credential");
  await expect(legacy.decrypt({ ...identity, ...next })).rejects.toThrow();
  const late = await legacy.encrypt({ ...identity, value: "late-old-invocation-result" });
  expect(await current.decrypt({ ...identity, ...late })).toBe("late-old-invocation-result");
  expect(current.additionalReceiptKeys()).toEqual([oldKey]);
  const dedup = nativeCustody(
    bindings(newKey, 20261106, JSON.stringify({ 1: oldKey, 2: oldKey, 3: newKey })),
  );
  expect(dedup.additionalReceiptKeys()).toEqual([oldKey]);
  expect(JSON.stringify(current)).toBe("{}");
});

it("distinguishes mail/invitation format version from key version and authenticates exact scope and bytes", async () => {
  const legacy = nativeCustody(bindings(oldKey, 1));
  const current = nativeCustody(bindings(newKey, 20261106, JSON.stringify({ 1: oldKey })));
  for (const name of ["NATIVE_AUTH_MAIL_MESSAGE", "NATIVE_AUTH_INVITATION_MESSAGE"]) {
    const encrypted = await legacy.encrypt({
      ...scope,
      name,
      value: '{"token":"public-fixture-value"}',
    });
    const envelope = {
      version: 1,
      name,
      keyVersion: encrypted.keyVersion,
      ciphertext: [...encrypted.ciphertext],
      nonce: [...encrypted.nonce],
      valueSha256: [...encrypted.valueSha256],
    };
    const decoded = {
      ...scope,
      name: envelope.name,
      keyVersion: envelope.keyVersion,
      ciphertext: Uint8Array.from(envelope.ciphertext),
      nonce: Uint8Array.from(envelope.nonce),
      valueSha256: Uint8Array.from(envelope.valueSha256),
    };
    expect(envelope.version).toBe(1);
    expect(await current.decrypt(decoded)).toBe('{"token":"public-fixture-value"}');
    await expect(current.decrypt({ ...decoded, projectId: scope.environmentId })).rejects.toThrow();
    await expect(
      current.decrypt({ ...decoded, name: "NATIVE_AUTH_FOREIGN_PURPOSE" }),
    ).rejects.toThrow();
    await expect(current.decrypt({ ...decoded, keyVersion: 3 })).rejects.toThrow();
    const broken = Uint8Array.from(encrypted.ciphertext);
    broken[0] = (broken[0] ?? 0) ^ 1;
    await expect(current.decrypt({ ...decoded, ciphertext: broken })).rejects.toThrow();
    const next = await current.encrypt({ ...scope, name, value: "current-envelope-fixture" });
    expect(next.keyVersion).toBe(20261106);
    expect(await current.decrypt({ ...scope, name, ...next })).toBe("current-envelope-fixture");
  }
});

it("rejects malformed, colliding and unbounded custody maps without accepting a string writer version", () => {
  for (const json of [
    "{",
    "null",
    "[]",
    JSON.stringify({ 0: oldKey }),
    JSON.stringify({ "01": oldKey }),
    JSON.stringify({ 20261106: newKey }),
    JSON.stringify({ 1: 123 }),
    JSON.stringify({ 1: "not-base64" }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, oldKey]))),
    " ".repeat(4097),
  ]) {
    expect(() => nativeCustody(bindings(newKey, 20261106, json))).toThrow();
  }
  for (const version of [0, -1, 1.5, NaN, 1_000_000_000])
    expect(() => nativeCustody(bindings(newKey, version))).toThrow();
  expect(() =>
    nativeCustody({
      ...bindings(newKey, 1),
      NATIVE_AUTH_CUSTODY_KEY_VERSION: "1",
    } as unknown as NativeCustodyBindings),
  ).toThrow();
  expect(() => nativeCustody(bindings("invalid-key", 1))).toThrow();
});
