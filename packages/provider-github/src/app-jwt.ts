import { GithubProviderInputError } from "./errors.js";

export interface CreateGithubAppJwtInput {
  readonly clientId: string;
  readonly privateKey: CryptoKey;
  readonly now: Date;
  readonly crypto?: SubtleCrypto;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeJson(value: Readonly<Record<string, string | number>>): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function createGithubAppJwt(input: CreateGithubAppJwtInput): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,255}$/u.test(input.clientId)) {
    throw new GithubProviderInputError("invalid_app_client_id");
  }
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new GithubProviderInputError("invalid_clock");
  }
  const algorithm = input.privateKey.algorithm as KeyAlgorithm & { readonly hash?: KeyAlgorithm };
  if (
    input.privateKey.extractable ||
    input.privateKey.type !== "private" ||
    algorithm.name !== "RSASSA-PKCS1-v1_5" ||
    algorithm.hash?.name !== "SHA-256" ||
    !input.privateKey.usages.includes("sign")
  ) {
    throw new GithubProviderInputError("invalid_app_private_key");
  }

  const nowSeconds = Math.floor(input.now.getTime() / 1_000);
  const encodedHeader = encodeJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = encodeJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: input.clientId,
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let signature: ArrayBuffer;
  try {
    signature = await (input.crypto ?? globalThis.crypto.subtle).sign(
      "RSASSA-PKCS1-v1_5",
      input.privateKey,
      new TextEncoder().encode(signingInput),
    );
  } catch {
    throw new GithubProviderInputError("invalid_app_private_key");
  }
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}
