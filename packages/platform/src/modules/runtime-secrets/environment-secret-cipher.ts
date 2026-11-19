/// <reference lib="dom" />

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAXIMUM_SECRET_BYTES = 5_120;

interface ProjectSecretIdentity {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly name: string;
}

type EnvironmentSecretIdentity =
  | ProjectSecretIdentity
  | {
      readonly scope: "organization-authorization";
      readonly organizationId: string;
      readonly authorizationId: string;
      readonly name: string;
    };

/** What a keyed digest is for: a user secret's value, or the canonical request that wrote it. */
export type DigestPurpose = "value" | "request";

export interface EncryptedEnvironmentSecret {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly valueSha256: Uint8Array;
  readonly keyVersion: number;
}

export class EnvironmentSecretCipherInputError extends Error {
  public constructor() {
    super("Environment secret cipher input is invalid");
    this.name = "EnvironmentSecretCipherInputError";
  }
}

export class EnvironmentSecretDecryptionError extends Error {
  public readonly code = "environment_secret_decryption_failed";

  public constructor() {
    super("Environment secret decryption failed");
    this.name = "EnvironmentSecretDecryptionError";
  }
}

export function createEnvironmentSecretCipher(input: {
  readonly keyBase64: string;
  readonly keyVersion: number;
  readonly crypto: Crypto;
  readonly randomBytes?: (length: number) => Uint8Array;
}) {
  const keyBytes = decodeKey(input.keyBase64);
  if (
    !Number.isSafeInteger(input.keyVersion) ||
    input.keyVersion <= 0 ||
    typeof input.crypto?.subtle?.importKey !== "function" ||
    typeof input.crypto?.getRandomValues !== "function"
  ) {
    throw new EnvironmentSecretCipherInputError();
  }
  const key = input.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  // The digest subkeys derive from the same key material; the import copies it before the wipe below.
  const digestBase = input.crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveKey"]);
  keyBytes.fill(0);
  const randomBytes =
    input.randomBytes ??
    ((length: number) => {
      const output = new Uint8Array(length);
      input.crypto.getRandomValues(output);
      return output;
    });
  return Object.freeze({
    async encrypt(
      secret: EnvironmentSecretIdentity & Readonly<{ value: string }>,
    ): Promise<EncryptedEnvironmentSecret> {
      validateIdentity(secret);
      if (typeof secret.value !== "string") throw new EnvironmentSecretCipherInputError();
      const plaintext = ownedBytes(new TextEncoder().encode(secret.value));
      if (plaintext.byteLength === 0 || plaintext.byteLength > MAXIMUM_SECRET_BYTES) {
        plaintext.fill(0);
        throw new EnvironmentSecretCipherInputError();
      }
      const nonce = ownedBytes(randomBytes(12));
      if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 12) {
        plaintext.fill(0);
        throw new EnvironmentSecretCipherInputError();
      }
      try {
        const [ciphertext, digest] = await Promise.all([
          input.crypto.subtle.encrypt(
            {
              name: "AES-GCM",
              iv: nonce,
              additionalData: additionalData(secret, input.keyVersion),
            },
            await key,
            plaintext,
          ),
          input.crypto.subtle.digest("SHA-256", plaintext),
        ]);
        return Object.freeze({
          ciphertext: new Uint8Array(ciphertext),
          nonce: new Uint8Array(nonce),
          valueSha256: new Uint8Array(digest),
          keyVersion: input.keyVersion,
        });
      } finally {
        plaintext.fill(0);
      }
    },

    /**
     * The stored digest of a user secret: HMAC-SHA-256 under a subkey of this key version and purpose. It still
     * replays and detects changes, but without the key it is not a guessing oracle for a low-entropy value.
     */
    async keyedDigest(purpose: DigestPurpose, bytes: Uint8Array): Promise<Uint8Array> {
      if (purpose !== "value" && purpose !== "request")
        throw new EnvironmentSecretCipherInputError();
      const subkey = await input.crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: new TextEncoder().encode(
            `ohmyhost-environment-secret-digest-v1\n${purpose}\n${String(input.keyVersion)}`,
          ),
        },
        await digestBase,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
      return new Uint8Array(await input.crypto.subtle.sign("HMAC", subkey, ownedBytes(bytes)));
    },

    async decrypt(secret: EnvironmentSecretIdentity & EncryptedEnvironmentSecret): Promise<string> {
      return open(secret, true);
    },

    /**
     * Opens a user secret by its AES-GCM tag and scope alone. Its stored digest is keyed, so it cannot be compared to
     * the plaintext here, and legacy rows carry a cleared digest; the tag still authenticates the value.
     */
    openEnvironmentSecret(
      secret: EnvironmentSecretIdentity & EncryptedEnvironmentSecret,
    ): Promise<string> {
      return open(secret, false);
    },
  });

  async function open(
    secret: EnvironmentSecretIdentity & EncryptedEnvironmentSecret,
    verifyDigest: boolean,
  ): Promise<string> {
    validateIdentity(secret);
    if (
      secret.keyVersion !== input.keyVersion ||
      !(secret.ciphertext instanceof Uint8Array) ||
      secret.ciphertext.byteLength < 17 ||
      secret.ciphertext.byteLength > MAXIMUM_SECRET_BYTES + 16 ||
      !(secret.nonce instanceof Uint8Array) ||
      secret.nonce.byteLength !== 12 ||
      !(secret.valueSha256 instanceof Uint8Array) ||
      secret.valueSha256.byteLength !== 32
    ) {
      throw new EnvironmentSecretCipherInputError();
    }
    try {
      const plaintext = new Uint8Array(
        await input.crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: ownedBytes(secret.nonce),
            additionalData: additionalData(secret, secret.keyVersion),
          },
          await key,
          ownedBytes(secret.ciphertext),
        ),
      );
      try {
        if (verifyDigest) {
          const digest = new Uint8Array(await input.crypto.subtle.digest("SHA-256", plaintext));
          if (!constantTimeEqual(digest, secret.valueSha256)) {
            throw new EnvironmentSecretDecryptionError();
          }
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (error instanceof EnvironmentSecretDecryptionError) throw error;
      throw new EnvironmentSecretDecryptionError();
    }
  }
}

export function createEnvironmentSecretCipherKeyring(input: {
  readonly primaryKeyBase64: string;
  readonly additionalKeysJson?: string;
  readonly currentKeyVersion: number;
  readonly crypto: Crypto;
  readonly randomBytes?: (length: number) => Uint8Array;
}) {
  if (!Number.isSafeInteger(input.currentKeyVersion) || input.currentKeyVersion <= 0) {
    throw new EnvironmentSecretCipherInputError();
  }
  const ciphers = new Map<number, ReturnType<typeof createEnvironmentSecretCipher>>();
  ciphers.set(
    1,
    createEnvironmentSecretCipher({
      keyBase64: input.primaryKeyBase64,
      keyVersion: 1,
      crypto: input.crypto,
      ...(input.randomBytes === undefined ? {} : { randomBytes: input.randomBytes }),
    }),
  );
  let additional: unknown = {};
  if (input.additionalKeysJson !== undefined) {
    try {
      additional = JSON.parse(input.additionalKeysJson) as unknown;
    } catch {
      throw new EnvironmentSecretCipherInputError();
    }
  }
  if (
    typeof additional !== "object" ||
    additional === null ||
    Array.isArray(additional) ||
    Object.keys(additional).length > 8
  ) {
    throw new EnvironmentSecretCipherInputError();
  }
  for (const [rawVersion, keyBase64] of Object.entries(additional)) {
    if (!/^[2-9][0-9]{0,8}$/u.test(rawVersion) || typeof keyBase64 !== "string") {
      throw new EnvironmentSecretCipherInputError();
    }
    const keyVersion = Number(rawVersion);
    if (!Number.isSafeInteger(keyVersion) || ciphers.has(keyVersion)) {
      throw new EnvironmentSecretCipherInputError();
    }
    ciphers.set(
      keyVersion,
      createEnvironmentSecretCipher({
        keyBase64,
        keyVersion,
        crypto: input.crypto,
        ...(input.randomBytes === undefined ? {} : { randomBytes: input.randomBytes }),
      }),
    );
  }
  const current = ciphers.get(input.currentKeyVersion);
  if (current === undefined) throw new EnvironmentSecretCipherInputError();
  return Object.freeze({
    encrypt: current.encrypt,
    keyedDigest: current.keyedDigest,
    decrypt(secret: EnvironmentSecretIdentity & EncryptedEnvironmentSecret): Promise<string> {
      const cipher = ciphers.get(secret.keyVersion);
      if (cipher === undefined) throw new EnvironmentSecretCipherInputError();
      return cipher.decrypt(secret);
    },
    openEnvironmentSecret(
      secret: EnvironmentSecretIdentity & EncryptedEnvironmentSecret,
    ): Promise<string> {
      const cipher = ciphers.get(secret.keyVersion);
      if (cipher === undefined) throw new EnvironmentSecretCipherInputError();
      return cipher.openEnvironmentSecret(secret);
    },
  });
}

function validateIdentity(input: EnvironmentSecretIdentity): void {
  if (
    !ULID_PATTERN.test(input.organizationId) ||
    ("scope" in input
      ? input.scope !== "organization-authorization" || !ULID_PATTERN.test(input.authorizationId)
      : !ULID_PATTERN.test(input.projectId) || !ULID_PATTERN.test(input.environmentId)) ||
    !SECRET_NAME_PATTERN.test(input.name)
  ) {
    throw new EnvironmentSecretCipherInputError();
  }
}

function additionalData(
  input: EnvironmentSecretIdentity,
  keyVersion: number,
): Uint8Array<ArrayBuffer> {
  return ownedBytes(
    new TextEncoder().encode(
      ("scope" in input
        ? [
            "ohmyhost-organization-authorization-v1",
            input.organizationId,
            input.authorizationId,
            input.name,
            String(keyVersion),
          ]
        : [
            "ohmyhost-environment-secret-v1",
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.name,
            String(keyVersion),
          ]
      ).join("\n"),
    ),
  );
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  try {
    if (!BASE64_PATTERN.test(value)) throw new TypeError();
    const decoded = atob(value);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== 32 || btoa(decoded) !== value) throw new TypeError();
    return ownedBytes(bytes);
  } catch {
    throw new EnvironmentSecretCipherInputError();
  }
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(new ArrayBuffer(value.byteLength));
  owned.set(value);
  return owned;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
