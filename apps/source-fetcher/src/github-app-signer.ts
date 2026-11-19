import { createGitHubAppJwtIssuer, type GitHubAppJwtIssuer } from "@ohmyhost/provider-github";

import { SourceFetcherConfigurationError } from "./source-fetcher.js";

interface CreateBase64GithubAppJwtIssuerInput {
  readonly clientId: string;
  /** PKCS#8 DER encoded with canonical standard base64. */
  readonly privateKeyBase64: string;
  readonly crypto?: SubtleCrypto;
}

const MAXIMUM_KEY_BYTES = 32 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function decodePrivateKey(value: string): Uint8Array<ArrayBuffer> {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAXIMUM_KEY_BYTES / 3) * 4 ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new SourceFetcherConfigurationError();
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new SourceFetcherConfigurationError();
  }
  if (binary.length === 0 || binary.length > MAXIMUM_KEY_BYTES) {
    throw new SourceFetcherConfigurationError();
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function importPrivateKey(value: string, subtle: SubtleCrypto): Promise<CryptoKey> {
  try {
    return await subtle.importKey(
      "pkcs8",
      decodePrivateKey(value),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof SourceFetcherConfigurationError) throw error;
    throw new SourceFetcherConfigurationError();
  }
}

export function createBase64GithubAppJwtIssuer(
  input: CreateBase64GithubAppJwtIssuerInput,
): GitHubAppJwtIssuer {
  if (!/^[A-Za-z0-9._-]{1,255}$/u.test(input.clientId)) {
    throw new SourceFetcherConfigurationError();
  }
  const subtle = input.crypto ?? globalThis.crypto.subtle;
  let imported: Promise<CryptoKey> | undefined;
  return Object.freeze({
    async issue(now: Date): Promise<string> {
      imported ??= importPrivateKey(input.privateKeyBase64, subtle);
      const privateKey = await imported;
      return createGitHubAppJwtIssuer({
        clientId: input.clientId,
        privateKey,
        crypto: subtle,
      }).issue(now);
    },
  });
}
