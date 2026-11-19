import { parseUlid, type Ulid } from "@ohmyhost/platform";
import {
  parseProjectHandle,
  projectEnvironmentAddress,
  type ProjectHandle,
} from "@ohmyhost/project-handles";

/** One hour, so an owner can reopen Dev while reviewing without minting a new ticket (D312). */
export const DEV_ACCESS_TICKET_TTL_SECONDS = 3_600;
export const DEV_ACCESS_SESSION_TTL_SECONDS = 43_200;
export const DEV_ACCESS_SESSION_CLOCK_SKEW_SECONDS = 30;
export const DEV_ACCESS_SESSION_MAX_TOKEN_LENGTH = 2_048;
export const DEV_ACCESS_SESSION_VERSION = "ohmyhost.dev-access/v1" as const;
export const DEV_ACCESS_SESSION_ISSUER = "ohmyhost" as const;
export const DEV_ACCESS_SESSION_AUDIENCE = "ohmyhost:dev-gateway" as const;
export const DEV_RUNTIME_PROBE_TTL_SECONDS = 60;
export const DEV_RUNTIME_PROBE_VERSION = "ohmyhost.dev-runtime-probe/v1" as const;
export const DEV_RUNTIME_PROBE_AUDIENCE = "ohmyhost:dev-runtime-probe" as const;

export interface DevAccessScope {
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly handle: ProjectHandle;
  readonly origin: string;
}

export interface DevAccessSessionClaims extends DevAccessScope {
  readonly version: typeof DEV_ACCESS_SESSION_VERSION;
  readonly issuer: typeof DEV_ACCESS_SESSION_ISSUER;
  readonly audience: typeof DEV_ACCESS_SESSION_AUDIENCE;
  readonly kid: `sha256:${string}`;
  readonly devAccessEpoch: number;
  readonly subjectId: string;
  readonly path: "/";
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface DevRuntimeProbeScope extends DevAccessScope {
  readonly organizationId: Ulid;
  readonly operationId: Ulid;
  readonly deploymentId: Ulid;
  readonly path: string;
  readonly method: "GET" | "HEAD";
}

export interface DevRuntimeProbeClaims extends DevRuntimeProbeScope {
  readonly version: typeof DEV_RUNTIME_PROBE_VERSION;
  readonly issuer: typeof DEV_ACCESS_SESSION_ISSUER;
  readonly audience: typeof DEV_RUNTIME_PROBE_AUDIENCE;
  readonly kid: `sha256:${string}`;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface DevAccessPublicJwk {
  readonly crv: "P-256";
  readonly kty: "EC";
  readonly x: string;
  readonly y: string;
}

type CryptoProvider = Pick<Crypto, "getRandomValues" | "subtle">;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const KEY_PAIR_PROOF = encoder.encode("ohmyhost.dev-access/key-pair-proof/v1");

export async function createDevAccessTicket(
  cryptoProvider: CryptoProvider,
): Promise<Readonly<{ token: string; digest: Uint8Array }>> {
  requireCrypto(cryptoProvider);
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(32));
  const token = encodeBase64Url(bytes);
  return Object.freeze({ token, digest: await digestDevAccessTicket(cryptoProvider, token) });
}

export async function digestDevAccessTicket(
  cryptoProvider: Pick<Crypto, "subtle">,
  token: unknown,
): Promise<Uint8Array> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new TypeError("Dev access ticket is invalid");
  }
  const bytes = decodeBase64Url(token);
  if (bytes.byteLength !== 32) throw new TypeError("Dev access ticket is invalid");
  return new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", arrayBuffer(bytes)));
}

export async function signDevAccessSession(
  cryptoProvider: Pick<Crypto, "subtle">,
  privateJwk: JsonWebKey,
  value: unknown,
): Promise<string> {
  const claims = parseUnsignedClaims(value);
  const payload = encoder.encode(JSON.stringify(claims));
  const key = await importSigningKey(cryptoProvider, privateJwk, "sign");
  const signature = await cryptoProvider.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    payload,
  );
  return `${encodeBase64Url(payload)}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function signDevRuntimeProbe(
  cryptoProvider: Pick<Crypto, "subtle">,
  privateJwk: JsonWebKey,
  value: unknown,
): Promise<string> {
  const claims = parseUnsignedRuntimeProbeClaims(value);
  const payload = encoder.encode(JSON.stringify(claims));
  const key = await importSigningKey(cryptoProvider, privateJwk, "sign");
  const signature = await cryptoProvider.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    payload,
  );
  return `${encodeBase64Url(payload)}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function digestDevAccessPublicJwk(
  cryptoProvider: Pick<Crypto, "subtle">,
  publicJwk: JsonWebKey,
): Promise<`sha256:${string}`> {
  const canonical = await validateDevAccessPublicJwk(cryptoProvider, publicJwk);
  return digestCanonicalPublicJwk(cryptoProvider, canonical);
}

async function digestCanonicalPublicJwk(
  cryptoProvider: Pick<Crypto, "subtle">,
  canonical: DevAccessPublicJwk,
): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(
    await cryptoProvider.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical))),
  );
  return `sha256:${hex(digest)}`;
}

export async function validateDevAccessPublicJwk(
  cryptoProvider: Pick<Crypto, "subtle">,
  publicJwk: JsonWebKey,
): Promise<Readonly<DevAccessPublicJwk>> {
  return (await validateAndImportPublicJwk(cryptoProvider, publicJwk)).jwk;
}

export async function proveDevAccessSigningKeyPair(
  cryptoProvider: Pick<Crypto, "subtle">,
  privateJwk: JsonWebKey,
  publicJwk: JsonWebKey,
): Promise<`sha256:${string}`> {
  const privateKey = await importSigningKey(cryptoProvider, privateJwk, "sign");
  const validatedPublic = await validateAndImportPublicJwk(cryptoProvider, publicJwk);
  const signature = await cryptoProvider.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    KEY_PAIR_PROOF,
  );
  const matches = await cryptoProvider.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    validatedPublic.key,
    signature,
    KEY_PAIR_PROOF,
  );
  if (!matches) throw new TypeError("Dev access signing key pair is invalid");
  return digestCanonicalPublicJwk(cryptoProvider, validatedPublic.jwk);
}

export async function verifyDevAccessSession(
  cryptoProvider: Pick<Crypto, "subtle">,
  publicJwk: JsonWebKey,
  token: unknown,
  expectedScope: DevAccessScope,
  now: string,
): Promise<DevAccessSessionClaims | null> {
  if (
    typeof token !== "string" ||
    token.length > DEV_ACCESS_SESSION_MAX_TOKEN_LENGTH ||
    !SESSION_TOKEN_PATTERN.test(token)
  )
    return null;
  let parts: readonly [Uint8Array, Uint8Array];
  try {
    const [payloadPart, signaturePart] = token.split(".");
    if (
      payloadPart === undefined ||
      signaturePart === undefined ||
      payloadPart.length > 1_500 ||
      signaturePart.length > 128
    )
      return null;
    parts = [decodeBase64Url(payloadPart), decodeBase64Url(signaturePart)];
  } catch {
    return null;
  }
  let validatedPublic: Readonly<{ jwk: Readonly<DevAccessPublicJwk>; key: CryptoKey }>;
  try {
    validatedPublic = await validateAndImportPublicJwk(cryptoProvider, publicJwk);
  } catch {
    return null;
  }
  if (
    !(await cryptoProvider.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      validatedPublic.key,
      arrayBuffer(parts[1]),
      arrayBuffer(parts[0]),
    ))
  ) {
    return null;
  }
  let claims: DevAccessSessionClaims;
  try {
    claims = parseSignedClaims(JSON.parse(decoder.decode(parts[0])));
  } catch {
    return null;
  }
  const scope = parseScope(expectedScope);
  const nowMillis = canonicalTimestamp(now, "Dev access verification time");
  let expectedKid: `sha256:${string}`;
  try {
    expectedKid = await digestCanonicalPublicJwk(cryptoProvider, validatedPublic.jwk);
  } catch {
    return null;
  }
  if (
    claims.projectId !== scope.projectId ||
    claims.environmentId !== scope.environmentId ||
    claims.handle !== scope.handle ||
    claims.origin !== scope.origin ||
    claims.kid !== expectedKid ||
    nowMillis + DEV_ACCESS_SESSION_CLOCK_SKEW_SECONDS * 1000 < Date.parse(claims.issuedAt) ||
    nowMillis >= Date.parse(claims.expiresAt)
  ) {
    return null;
  }
  return claims;
}

export async function verifyDevRuntimeProbe(
  cryptoProvider: Pick<Crypto, "subtle">,
  publicJwk: JsonWebKey,
  token: unknown,
  expectedScope: DevRuntimeProbeScope,
  now: string,
): Promise<DevRuntimeProbeClaims | null> {
  if (
    typeof token !== "string" ||
    token.length > DEV_ACCESS_SESSION_MAX_TOKEN_LENGTH ||
    !SESSION_TOKEN_PATTERN.test(token)
  ) {
    return null;
  }
  let parts: readonly [Uint8Array, Uint8Array];
  try {
    const [payloadPart, signaturePart] = token.split(".");
    if (
      payloadPart === undefined ||
      signaturePart === undefined ||
      payloadPart.length > 1_500 ||
      signaturePart.length > 128
    ) {
      return null;
    }
    parts = [decodeBase64Url(payloadPart), decodeBase64Url(signaturePart)];
  } catch {
    return null;
  }
  let validatedPublic: Readonly<{ jwk: Readonly<DevAccessPublicJwk>; key: CryptoKey }>;
  try {
    validatedPublic = await validateAndImportPublicJwk(cryptoProvider, publicJwk);
  } catch {
    return null;
  }
  if (
    !(await cryptoProvider.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      validatedPublic.key,
      arrayBuffer(parts[1]),
      arrayBuffer(parts[0]),
    ))
  ) {
    return null;
  }
  let claims: DevRuntimeProbeClaims;
  try {
    claims = parseSignedRuntimeProbeClaims(JSON.parse(decoder.decode(parts[0])));
  } catch {
    return null;
  }
  let scope: DevRuntimeProbeScope;
  let expectedKid: `sha256:${string}`;
  let nowMillis: number;
  try {
    scope = parseRuntimeProbeScope(expectedScope);
    expectedKid = await digestCanonicalPublicJwk(cryptoProvider, validatedPublic.jwk);
    nowMillis = canonicalTimestamp(now, "Dev runtime probe verification time");
  } catch {
    return null;
  }
  if (
    claims.organizationId !== scope.organizationId ||
    claims.projectId !== scope.projectId ||
    claims.environmentId !== scope.environmentId ||
    claims.operationId !== scope.operationId ||
    claims.deploymentId !== scope.deploymentId ||
    claims.handle !== scope.handle ||
    claims.origin !== scope.origin ||
    claims.path !== scope.path ||
    claims.method !== scope.method ||
    claims.kid !== expectedKid ||
    nowMillis + DEV_ACCESS_SESSION_CLOCK_SKEW_SECONDS * 1_000 < Date.parse(claims.issuedAt) ||
    nowMillis >= Date.parse(claims.expiresAt)
  ) {
    return null;
  }
  return claims;
}

function parseUnsignedClaims(value: unknown): Omit<
  DevAccessSessionClaims,
  "version" | "issuer" | "audience" | "path"
> & {
  readonly version: typeof DEV_ACCESS_SESSION_VERSION;
  readonly issuer: typeof DEV_ACCESS_SESSION_ISSUER;
  readonly audience: typeof DEV_ACCESS_SESSION_AUDIENCE;
  readonly path: "/";
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "environmentId",
      "devAccessEpoch",
      "expiresAt",
      "handle",
      "issuedAt",
      "kid",
      "origin",
      "projectId",
      "subjectId",
    ])
  ) {
    throw new TypeError("Dev access session claims are invalid");
  }
  const scope = parseScope(value);
  const subjectId = value["subjectId"];
  const issuedAt = value["issuedAt"];
  const expiresAt = value["expiresAt"];
  const kid = value["kid"];
  const devAccessEpoch = value["devAccessEpoch"];
  if (
    typeof subjectId !== "string" ||
    subjectId.length < 1 ||
    subjectId.length > 256 ||
    typeof issuedAt !== "string" ||
    typeof expiresAt !== "string" ||
    typeof kid !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(kid) ||
    typeof devAccessEpoch !== "number" ||
    !Number.isSafeInteger(devAccessEpoch) ||
    devAccessEpoch < 1 ||
    canonicalTimestamp(expiresAt, "Dev access session expiry") -
      canonicalTimestamp(issuedAt, "Dev access session issue time") !==
      DEV_ACCESS_SESSION_TTL_SECONDS * 1000
  ) {
    throw new TypeError("Dev access session claims are invalid");
  }
  return Object.freeze({
    ...scope,
    subjectId,
    kid: kid as `sha256:${string}`,
    devAccessEpoch,
    version: DEV_ACCESS_SESSION_VERSION,
    issuer: DEV_ACCESS_SESSION_ISSUER,
    audience: DEV_ACCESS_SESSION_AUDIENCE,
    path: "/",
    issuedAt,
    expiresAt,
  });
}

function parseSignedClaims(value: unknown): DevAccessSessionClaims {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "environmentId",
      "devAccessEpoch",
      "expiresAt",
      "handle",
      "audience",
      "issuer",
      "issuedAt",
      "kid",
      "origin",
      "path",
      "projectId",
      "subjectId",
      "version",
    ]) ||
    value["version"] !== DEV_ACCESS_SESSION_VERSION ||
    value["issuer"] !== DEV_ACCESS_SESSION_ISSUER ||
    value["audience"] !== DEV_ACCESS_SESSION_AUDIENCE ||
    value["path"] !== "/"
  ) {
    throw new TypeError("Dev access session claims are invalid");
  }
  return parseUnsignedClaims({
    projectId: value["projectId"],
    environmentId: value["environmentId"],
    devAccessEpoch: value["devAccessEpoch"],
    handle: value["handle"],
    origin: value["origin"],
    subjectId: value["subjectId"],
    kid: value["kid"],
    issuedAt: value["issuedAt"],
    expiresAt: value["expiresAt"],
  });
}

function parseUnsignedRuntimeProbeClaims(value: unknown): DevRuntimeProbeClaims {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "deploymentId",
      "environmentId",
      "expiresAt",
      "handle",
      "issuedAt",
      "kid",
      "method",
      "operationId",
      "organizationId",
      "origin",
      "path",
      "projectId",
    ])
  ) {
    throw new TypeError("Dev runtime probe claims are invalid");
  }
  const scope = parseRuntimeProbeScope(value);
  const issuedAt = value["issuedAt"];
  const expiresAt = value["expiresAt"];
  const kid = value["kid"];
  if (
    typeof issuedAt !== "string" ||
    typeof expiresAt !== "string" ||
    typeof kid !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(kid) ||
    canonicalTimestamp(expiresAt, "Dev runtime probe expiry") -
      canonicalTimestamp(issuedAt, "Dev runtime probe issue time") !==
      DEV_RUNTIME_PROBE_TTL_SECONDS * 1_000
  ) {
    throw new TypeError("Dev runtime probe claims are invalid");
  }
  return Object.freeze({
    ...scope,
    version: DEV_RUNTIME_PROBE_VERSION,
    issuer: DEV_ACCESS_SESSION_ISSUER,
    audience: DEV_RUNTIME_PROBE_AUDIENCE,
    kid: kid as `sha256:${string}`,
    issuedAt,
    expiresAt,
  });
}

function parseSignedRuntimeProbeClaims(value: unknown): DevRuntimeProbeClaims {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "audience",
      "deploymentId",
      "environmentId",
      "expiresAt",
      "handle",
      "issuedAt",
      "issuer",
      "kid",
      "method",
      "operationId",
      "organizationId",
      "origin",
      "path",
      "projectId",
      "version",
    ]) ||
    value["version"] !== DEV_RUNTIME_PROBE_VERSION ||
    value["issuer"] !== DEV_ACCESS_SESSION_ISSUER ||
    value["audience"] !== DEV_RUNTIME_PROBE_AUDIENCE
  ) {
    throw new TypeError("Dev runtime probe claims are invalid");
  }
  return parseUnsignedRuntimeProbeClaims({
    organizationId: value["organizationId"],
    projectId: value["projectId"],
    environmentId: value["environmentId"],
    operationId: value["operationId"],
    deploymentId: value["deploymentId"],
    handle: value["handle"],
    origin: value["origin"],
    path: value["path"],
    method: value["method"],
    kid: value["kid"],
    issuedAt: value["issuedAt"],
    expiresAt: value["expiresAt"],
  });
}

function parseRuntimeProbeScope(value: unknown): DevRuntimeProbeScope {
  if (!isRecord(value)) throw new TypeError("Dev runtime probe scope is invalid");
  const base = parseScope(value);
  const organizationId = value["organizationId"];
  const operationId = value["operationId"];
  const deploymentId = value["deploymentId"];
  const path = value["path"];
  const method = value["method"];
  if (
    typeof organizationId !== "string" ||
    typeof operationId !== "string" ||
    typeof deploymentId !== "string" ||
    typeof path !== "string" ||
    !validRuntimeProbePath(path) ||
    (method !== "GET" && method !== "HEAD")
  ) {
    throw new TypeError("Dev runtime probe scope is invalid");
  }
  return Object.freeze({
    ...base,
    organizationId: parseUlid(organizationId),
    operationId: parseUlid(operationId),
    deploymentId: parseUlid(deploymentId),
    path,
    method,
  });
}

function validRuntimeProbePath(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    /^\/(?!\/)[^?#]*$/u.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function parseScope(value: unknown): DevAccessScope {
  if (!isRecord(value)) throw new TypeError("Dev access scope is invalid");
  const projectId = value["projectId"];
  const environmentId = value["environmentId"];
  const origin = value["origin"];
  if (typeof projectId !== "string" || typeof environmentId !== "string") {
    throw new TypeError("Dev access scope is invalid");
  }
  const handle = parseProjectHandle(value["handle"]);
  const parsedProjectId = parseUlid(projectId);
  const parsedEnvironmentId = parseUlid(environmentId);
  const expectedOrigins = (["development", "production"] as const).map(
    (platform) =>
      projectEnvironmentAddress({ projectId, handle, environmentName: "dev", platform }).origin,
  );
  if (typeof origin !== "string" || !expectedOrigins.includes(origin))
    throw new TypeError("Dev access scope is invalid");
  return Object.freeze({
    projectId: parsedProjectId,
    environmentId: parsedEnvironmentId,
    handle,
    origin,
  });
}

async function importSigningKey(
  cryptoProvider: Pick<Crypto, "subtle">,
  jwk: JsonWebKey,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return cryptoProvider.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    [usage],
  );
}

async function validateAndImportPublicJwk(
  cryptoProvider: Pick<Crypto, "subtle">,
  value: JsonWebKey,
): Promise<Readonly<{ jwk: Readonly<DevAccessPublicJwk>; key: CryptoKey }>> {
  const jwk = canonicalPublicJwk(value);
  const key = await cryptoProvider.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return Object.freeze({ jwk, key });
}

function canonicalPublicJwk(value: JsonWebKey): Readonly<DevAccessPublicJwk> {
  if (
    !hasExactOwnKeys(value, ["crv", "kty", "x", "y"]) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.x) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.y)
  ) {
    throw new TypeError("Dev access public JWK is invalid");
  }
  return Object.freeze({ crv: "P-256", kty: "EC", x: value.x, y: value.y });
}

function requireCrypto(value: CryptoProvider): void {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.getRandomValues !== "function" ||
    typeof value.subtle?.digest !== "function"
  ) {
    throw new TypeError("Dev access crypto provider is invalid");
  }
}

function canonicalTimestamp(value: string, label: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
  return millis;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new TypeError("Base64url value is invalid");
  return bytes;
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.every((key): key is string => typeof key === "string") &&
    actual.sort().join(",") === [...keys].sort().join(",")
  );
}
