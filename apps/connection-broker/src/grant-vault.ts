import { encodeBytes } from "./encoding.js";
export interface GrantIdentity {
  environment: string;
  workspace: string;
  human: string;
  provider: string;
  registration: string;
  grantId: string;
  generation: number;
  keyVersion: string;
}
export interface AttemptIdentity {
  environment: string;
  workspace: string;
  actor: string;
  attemptId: string;
  registration: string;
  expiresAt: string;
  keyVersion: string;
}
export interface GrantTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: readonly string[];
}
export interface AttemptSecrets {
  verifier: string;
}
export interface Ciphertext {
  nonce: string;
  ciphertext: string;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function encode(bytes: Uint8Array): string {
  return encodeBytes(bytes);
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function bounded(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\p{Cc}]/u.test(value)
  );
}
function grantAad(i: GrantIdentity): Uint8Array {
  if (
    !i ||
    !["development", "production"].includes(i.environment) ||
    ![i.workspace, i.human, i.provider, i.registration, i.grantId, i.keyVersion].every(bounded) ||
    !Number.isSafeInteger(i.generation) ||
    i.generation < 1
  )
    throw new Error("invalid_grant_identity");
  return encoder.encode(
    JSON.stringify([
      "ohmyhost-grant-v1",
      i.environment,
      i.workspace,
      i.human,
      i.provider,
      i.registration,
      i.grantId,
      i.generation,
      i.keyVersion,
    ]),
  );
}
function attemptAad(i: AttemptIdentity): Uint8Array {
  if (
    !i ||
    !["development", "production"].includes(i.environment) ||
    ![i.workspace, i.actor, i.attemptId, i.registration, i.keyVersion].every(bounded) ||
    typeof i.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(i.expiresAt) ||
    !Number.isFinite(Date.parse(i.expiresAt))
  )
    throw new Error("invalid_attempt_identity");
  return encoder.encode(
    JSON.stringify([
      "ohmyhost-attempt-v1",
      i.environment,
      i.workspace,
      i.actor,
      i.attemptId,
      i.registration,
      i.expiresAt,
      i.keyVersion,
    ]),
  );
}
async function keyFor(key: Uint8Array, usage: "encrypt" | "decrypt") {
  if (key.byteLength !== 32) throw new Error("invalid_vault_key");
  return crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [usage]);
}
async function seal(value: object, aad: Uint8Array, key: Uint8Array): Promise<Ciphertext> {
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.byteLength > 256 * 1024) throw new Error("vault_payload_too_large");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: new Uint8Array(aad) },
    await keyFor(key, "encrypt"),
    plaintext,
  );
  return { nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
}
async function open(value: Ciphertext, aad: Uint8Array, key: Uint8Array): Promise<unknown> {
  if (value.ciphertext.length > Math.ceil((256 * 1024 + 16) / 3) * 4)
    throw new Error("invalid_ciphertext");
  const nonce = decode(value.nonce);
  if (nonce.byteLength !== 12) throw new Error("invalid_ciphertext");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: new Uint8Array(aad) },
    await keyFor(key, "decrypt"),
    new Uint8Array(decode(value.ciphertext)),
  );
  return JSON.parse(decoder.decode(plaintext)) as unknown;
}
export async function sealGrantTokens(
  identity: GrantIdentity,
  tokens: GrantTokens,
  key: Uint8Array,
): Promise<Ciphertext> {
  if (
    !tokens ||
    typeof tokens.accessToken !== "string" ||
    !tokens.accessToken ||
    tokens.accessToken.length > 16384 ||
    (tokens.refreshToken !== undefined &&
      (typeof tokens.refreshToken !== "string" ||
        !tokens.refreshToken ||
        tokens.refreshToken.length > 16384)) ||
    (tokens.scopes !== undefined &&
      (!Array.isArray(tokens.scopes) ||
        tokens.scopes.length > 128 ||
        !tokens.scopes.every(
          (scope) => typeof scope === "string" && /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/u.test(scope),
        ))) ||
    (tokens.expiresAt !== undefined &&
      (typeof tokens.expiresAt !== "string" || !Number.isFinite(Date.parse(tokens.expiresAt))))
  )
    throw new Error("invalid_grant_tokens");
  return seal(tokens, grantAad(identity), key);
}
export async function openGrantTokens(
  identity: GrantIdentity,
  value: Ciphertext,
  key: Uint8Array,
): Promise<GrantTokens> {
  const result = await open(value, grantAad(identity), key);
  if (
    !result ||
    typeof result !== "object" ||
    !("accessToken" in result) ||
    typeof result.accessToken !== "string" ||
    !result.accessToken ||
    ("refreshToken" in result &&
      (typeof result.refreshToken !== "string" || !result.refreshToken)) ||
    ("scopes" in result &&
      (!Array.isArray(result.scopes) ||
        result.scopes.length > 128 ||
        !result.scopes.every(
          (scope: unknown) =>
            typeof scope === "string" && /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/u.test(scope),
        )))
  )
    throw new Error("invalid_grant_tokens");
  return result as GrantTokens;
}
export async function sealAttemptSecrets(
  identity: AttemptIdentity,
  secrets: AttemptSecrets,
  key: Uint8Array,
): Promise<Ciphertext> {
  if (
    !secrets ||
    typeof secrets.verifier !== "string" ||
    !/^[A-Za-z0-9._~-]{43,128}$/u.test(secrets.verifier)
  )
    throw new Error("invalid_attempt_secrets");
  return seal(secrets, attemptAad(identity), key);
}
export async function openAttemptSecrets(
  identity: AttemptIdentity,
  value: Ciphertext,
  key: Uint8Array,
): Promise<AttemptSecrets> {
  const result = await open(value, attemptAad(identity), key);
  if (
    !result ||
    typeof result !== "object" ||
    !("verifier" in result) ||
    typeof result.verifier !== "string" ||
    !result.verifier
  )
    throw new Error("invalid_attempt_secrets");
  return result as AttemptSecrets;
}
