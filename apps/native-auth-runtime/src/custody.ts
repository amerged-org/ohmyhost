import {
  createEnvironmentSecretCipher,
  EnvironmentSecretCipherInputError,
} from "@ohmyhost/platform";

export interface NativeCustodyBindings {
  readonly NATIVE_AUTH_CUSTODY_KEY_BASE64: string;
  readonly NATIVE_AUTH_CUSTODY_KEY_VERSION: number;
  readonly NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON?: string;
}

type Cipher = ReturnType<typeof createEnvironmentSecretCipher>;
/** Worker-only custody. Never expose these methods or their private key results over RPC. */
export function nativeCustody(bindings: NativeCustodyBindings): Readonly<{
  encrypt: Cipher["encrypt"];
  decrypt: Cipher["decrypt"];
  additionalReceiptKeys(): readonly string[];
}> {
  const version = bindings.NATIVE_AUTH_CUSTODY_KEY_VERSION;
  if (!Number.isSafeInteger(version) || version < 1 || version > 999_999_999)
    throw new EnvironmentSecretCipherInputError();
  let additional: unknown = {};
  const raw = bindings.NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON;
  if (raw !== undefined) {
    if (typeof raw !== "string" || raw.length > 4096) throw new EnvironmentSecretCipherInputError();
    try {
      additional = JSON.parse(raw) as unknown;
    } catch {
      throw new EnvironmentSecretCipherInputError();
    }
  }
  if (
    typeof additional !== "object" ||
    additional === null ||
    Array.isArray(additional) ||
    Object.keys(additional).length > 8
  )
    throw new EnvironmentSecretCipherInputError();
  const writer = createEnvironmentSecretCipher({
    keyBase64: bindings.NATIVE_AUTH_CUSTODY_KEY_BASE64,
    keyVersion: version,
    crypto,
  });
  const readers = new Map([[version, writer]]);
  const receiptKeys = new Set<string>();
  for (const [label, key] of Object.entries(additional)) {
    if (!/^[1-9][0-9]{0,8}$/u.test(label) || Number(label) === version || typeof key !== "string")
      throw new EnvironmentSecretCipherInputError();
    readers.set(
      Number(label),
      createEnvironmentSecretCipher({ keyBase64: key, keyVersion: Number(label), crypto }),
    );
    if (key !== bindings.NATIVE_AUTH_CUSTODY_KEY_BASE64) receiptKeys.add(key);
  }
  return Object.freeze({
    encrypt: writer.encrypt,
    async decrypt(secret: Parameters<Cipher["decrypt"]>[0]) {
      const reader = readers.get(secret.keyVersion);
      if (reader === undefined) throw new EnvironmentSecretCipherInputError();
      return reader.decrypt(secret);
    },
    /** PRIVATE exact base64 text: restore receipt HMACs historically used this representation. */
    additionalReceiptKeys(): readonly string[] {
      return [...receiptKeys];
    },
  });
}
