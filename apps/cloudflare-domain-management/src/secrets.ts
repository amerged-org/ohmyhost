import type { CloudflareOAuthStateSigner, CloudflareTokenCipher } from "./runtime.js";

const encoder = new TextEncoder();
const HKDF_SALT = ownedBytes(encoder.encode("ohmyhost.cloudflare-domain-management/v1"));

export interface CloudflareTokenCipherWithOpen extends CloudflareTokenCipher {
  open(input: {
    readonly ciphertext: string;
    readonly nonce: string;
    readonly keyVersion: number;
    readonly associatedData: string;
  }): Promise<string>;
}

export function createCloudflareDomainSecrets(input: {
  readonly keyBase64: string;
  readonly keyVersion: number;
  readonly additionalKeysJson?: string;
  readonly crypto: Crypto;
}): Readonly<{
  stateSigner: CloudflareOAuthStateSigner;
  tokenCipher: CloudflareTokenCipherWithOpen;
}> {
  const rawKey = ownedBytes(decodeBase64(input.keyBase64));
  if (
    rawKey.byteLength !== 32 ||
    !Number.isSafeInteger(input.keyVersion) ||
    input.keyVersion < 1 ||
    input.keyVersion > 999_999_999 ||
    typeof input.crypto?.subtle !== "object" ||
    typeof input.crypto.getRandomValues !== "function"
  ) {
    throw new TypeError("Cloudflare domain secret configuration is invalid");
  }
  const writerVersion = input.keyVersion;
  const additional = parseAdditionalCloudflareCipherKeys(input.additionalKeysJson, writerVersion);
  const keyMaterial = input.crypto.subtle.importKey("raw", rawKey, "HKDF", false, ["deriveKey"]);
  const writer = deriveAesKey(keyMaterial, input.crypto);
  const aesKeys = new Map<number, Promise<CryptoKey>>([[writerVersion, writer]]);
  for (const [version, key] of additional) {
    const material = input.crypto.subtle.importKey(
      "raw",
      ownedBytes(decodeBase64(key)),
      "HKDF",
      false,
      ["deriveKey"],
    );
    aesKeys.set(version, deriveAesKey(material, input.crypto));
  }
  const hmacKey = keyMaterial.then((material) =>
    input.crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: HKDF_SALT,
        info: ownedBytes(encoder.encode("oauth-state-hmac")),
      },
      material,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    ),
  );
  return Object.freeze({
    stateSigner: Object.freeze({
      async sign(value: string) {
        requireBoundedText(value, 1, 4_096);
        return encodeBase64Url(
          new Uint8Array(
            await input.crypto.subtle.sign(
              "HMAC",
              await hmacKey,
              ownedBytes(encoder.encode(value)),
            ),
          ),
        );
      },
    }),
    tokenCipher: Object.freeze({
      async seal(plaintext: string, associatedData: string) {
        requireBoundedText(plaintext, 16, 4_096);
        requireBoundedText(associatedData, 16, 1_024);
        const nonce = input.crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await input.crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: ownedBytes(nonce),
            additionalData: ownedBytes(encoder.encode(associatedData)),
            tagLength: 128,
          },
          await writer,
          ownedBytes(encoder.encode(plaintext)),
        );
        return Object.freeze({
          ciphertext: encodeBase64(new Uint8Array(ciphertext)),
          nonce: encodeBase64(nonce),
          keyVersion: writerVersion,
        });
      },
      async open(value: Parameters<CloudflareTokenCipherWithOpen["open"]>[0]) {
        const reader = aesKeys.get(value.keyVersion);
        if (reader === undefined) throw new CloudflareTokenDecryptionError();
        requireBoundedText(value.associatedData, 16, 1_024);
        const nonce = ownedBytes(decodeBase64(value.nonce));
        const ciphertext = ownedBytes(decodeBase64(value.ciphertext));
        if (
          nonce.byteLength !== 12 ||
          ciphertext.byteLength < 17 ||
          ciphertext.byteLength > 4_112
        ) {
          throw new CloudflareTokenDecryptionError();
        }
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(
            await input.crypto.subtle.decrypt(
              {
                name: "AES-GCM",
                iv: nonce,
                additionalData: ownedBytes(encoder.encode(value.associatedData)),
                tagLength: 128,
              },
              await reader,
              ciphertext,
            ),
          );
        } catch {
          throw new CloudflareTokenDecryptionError();
        }
      },
    }),
  });
}

/** Validate the optional bounded version map without deriving keys or exposing input text. */
export function parseAdditionalCloudflareCipherKeys(
  value: unknown,
  writerVersion: number,
): ReadonlyMap<number, string> {
  let additional: unknown = {};
  if (value !== undefined) {
    if (typeof value !== "string" || value.length > 4096)
      throw new TypeError("Cloudflare domain secret configuration is invalid");
    try {
      additional = JSON.parse(value) as unknown;
    } catch {
      throw new TypeError("Cloudflare domain secret configuration is invalid");
    }
  }
  if (
    typeof additional !== "object" ||
    additional === null ||
    Array.isArray(additional) ||
    Object.keys(additional).length > 8
  )
    throw new TypeError("Cloudflare domain secret configuration is invalid");
  const keys = new Map<number, string>();
  for (const [rawVersion, key] of Object.entries(additional)) {
    if (
      !/^[1-9][0-9]{0,8}$/u.test(rawVersion) ||
      Number(rawVersion) === writerVersion ||
      typeof key !== "string" ||
      decodeBase64(key).byteLength !== 32
    )
      throw new TypeError("Cloudflare domain secret configuration is invalid");
    keys.set(Number(rawVersion), key);
  }
  return keys;
}

function deriveAesKey(material: Promise<CryptoKey>, crypto: Crypto): Promise<CryptoKey> {
  return material.then((key) =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: HKDF_SALT,
        info: ownedBytes(encoder.encode("oauth-token-aes")),
      },
      key,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
  );
}

export class CloudflareTokenDecryptionError extends Error {
  public constructor() {
    super("Cloudflare project token could not be decrypted");
    this.name = "CloudflareTokenDecryptionError";
  }
}

function requireBoundedText(value: string, minimum: number, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    containsControlCharacter(value)
  ) {
    throw new TypeError("Cloudflare secret input is invalid");
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function decodeBase64(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new TypeError("Cloudflare secret encoding is invalid");
  }
  const decoded = Uint8Array.from(Buffer.from(value, "base64"));
  if (encodeBase64(decoded) !== value) throw new TypeError("Cloudflare secret encoding is invalid");
  return decoded;
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(new ArrayBuffer(value.byteLength));
  output.set(value);
  return output;
}
