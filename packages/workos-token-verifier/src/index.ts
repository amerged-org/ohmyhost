import {
  parseWorkosJwks,
  parseWorkosJwtHeader,
  parseWorkosTokenClaims,
  type WorkosRsaJwk,
  type WorkosTokenClaims,
  type WorkosConnectUserClaims,
} from "@ohmyhost/workos-auth-contracts/tokens";
import { WorkosContractError } from "@ohmyhost/workos-auth-contracts/parsing";

import {
  InvalidWorkosJwksError,
  InvalidWorkosTokenError,
  WorkosTokenVerifierConfigurationError,
} from "./errors.js";

export {
  InvalidWorkosJwksError,
  InvalidWorkosTokenError,
  WorkosTokenVerifierConfigurationError,
} from "./errors.js";

export interface WorkosJwksSource {
  load(request?: { readonly kid: string }): Promise<unknown>;
}

export interface WorkosTokenVerifierClock {
  now(): Date;
}

interface WorkosTokenPolicyBase {
  readonly issuer: string;
  readonly clockSkewSeconds?: number;
  readonly maximumTokenAgeSeconds?: number;
}

export type WorkosTokenVerificationPolicy =
  | (WorkosTokenPolicyBase & {
      readonly kind: "session";
      readonly clientId: string;
    })
  | (WorkosTokenPolicyBase & {
      readonly kind: "m2m";
      readonly audience: string;
    });

export interface WorkosConnectUserTokenVerificationPolicy extends WorkosTokenPolicyBase {
  readonly kind: "connect_user";
  readonly audience: string;
}

export interface WorkosTokenVerifierDependencies {
  readonly jwks: WorkosJwksSource;
  readonly clock: WorkosTokenVerifierClock;
}

const decodeBase64Url = (value: string, code: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new InvalidWorkosTokenError(code);
  }
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = globalThis.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const canonical = globalThis
      .btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    if (canonical !== value) throw new Error("Non-canonical base64url");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new InvalidWorkosTokenError(code);
  }
};

const decodeJson = (value: string, code: string): unknown => {
  try {
    const bytes = decodeBase64Url(value, code);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof InvalidWorkosTokenError) throw error;
    throw new InvalidWorkosTokenError(code);
  }
};

const validateLimits = (
  policy: WorkosTokenVerificationPolicy | WorkosConnectUserTokenVerificationPolicy,
) => {
  if (
    policy.issuer.length === 0 ||
    (policy.kind === "session" ? policy.clientId.length === 0 : policy.audience.length === 0)
  ) {
    throw new WorkosTokenVerifierConfigurationError("invalid_verification_policy");
  }
  const clockSkewSeconds = policy.clockSkewSeconds ?? 30;
  const maximumTokenAgeSeconds = policy.maximumTokenAgeSeconds ?? 3_600;
  if (
    !Number.isSafeInteger(clockSkewSeconds) ||
    clockSkewSeconds < 0 ||
    !Number.isSafeInteger(maximumTokenAgeSeconds) ||
    maximumTokenAgeSeconds <= 0
  ) {
    throw new WorkosTokenVerifierConfigurationError("invalid_verification_policy");
  }
  return { clockSkewSeconds, maximumTokenAgeSeconds };
};

const verifyRs256 = async (
  key: WorkosRsaJwk,
  signingInput: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> => {
  try {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      toArrayBuffer(signature),
      toArrayBuffer(signingInput),
    );
  } catch {
    throw new InvalidWorkosJwksError("invalid_signing_key");
  }
};

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
};

const parseTokenContract = <Value>(operation: () => Value): Value => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof WorkosContractError) throw new InvalidWorkosTokenError(error.code);
    throw error;
  }
};

const parseJwksContract = (value: unknown): readonly WorkosRsaJwk[] => {
  try {
    return parseWorkosJwks(value);
  } catch (error) {
    if (error instanceof WorkosContractError) throw new InvalidWorkosJwksError(error.code);
    throw error;
  }
};

export function verifyWorkosToken(
  token: string,
  policy: WorkosTokenVerificationPolicy,
  dependencies: WorkosTokenVerifierDependencies,
): Promise<WorkosTokenClaims>;
export function verifyWorkosToken(
  token: string,
  policy: WorkosConnectUserTokenVerificationPolicy,
  dependencies: WorkosTokenVerifierDependencies,
): Promise<WorkosConnectUserClaims>;
export async function verifyWorkosToken(
  token: string,
  policy: WorkosTokenVerificationPolicy | WorkosConnectUserTokenVerificationPolicy,
  dependencies: WorkosTokenVerifierDependencies,
): Promise<WorkosTokenClaims | WorkosConnectUserClaims> {
  const limits = validateLimits(policy);
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new InvalidWorkosTokenError("invalid_jwt");
  }
  const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string];
  const header = parseTokenContract(() =>
    parseWorkosJwtHeader(decodeJson(encodedHeader, "invalid_jwt_header")),
  );
  const claims = parseTokenContract(() =>
    parseWorkosTokenClaims(decodeJson(encodedClaims, "invalid_jwt_claims"), policy.kind),
  );
  if (claims.issuer !== policy.issuer) {
    throw new InvalidWorkosTokenError("invalid_issuer");
  }
  if (policy.kind === "session") {
    if (claims.kind !== "session" || claims.clientId !== policy.clientId) {
      throw new InvalidWorkosTokenError("invalid_client");
    }
  } else if (
    policy.kind === "connect_user"
      ? claims.kind !== "connect_user" ||
        claims.audience.length !== 1 ||
        claims.audience[0] !== policy.audience
      : claims.kind !== "m2m" || !claims.audience.includes(policy.audience)
  ) {
    throw new InvalidWorkosTokenError("invalid_audience");
  }
  const rawJwks = await dependencies.jwks.load({ kid: header.kid });
  const keys = parseJwksContract(rawJwks);
  const key = keys.find((candidate) => candidate.kid === header.kid);
  if (key === undefined) {
    throw new InvalidWorkosTokenError("unknown_signing_key");
  }
  const signatureValid = await verifyRs256(
    key,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    decodeBase64Url(encodedSignature, "invalid_jwt_signature"),
  );
  if (!signatureValid) {
    throw new InvalidWorkosTokenError("invalid_jwt_signature");
  }
  const nowMs = dependencies.clock.now().getTime();
  if (!Number.isFinite(nowMs)) {
    throw new WorkosTokenVerifierConfigurationError("invalid_clock");
  }
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (policy.kind === "connect_user" && claims.expiresAt <= claims.issuedAt) {
    throw new InvalidWorkosTokenError("invalid_token_lifetime");
  }
  const expirySkewSeconds = policy.kind === "connect_user" ? 0 : limits.clockSkewSeconds;
  if (claims.expiresAt <= nowSeconds - expirySkewSeconds) {
    throw new InvalidWorkosTokenError("token_expired");
  }
  if (claims.notBefore !== undefined && claims.notBefore > nowSeconds + limits.clockSkewSeconds) {
    throw new InvalidWorkosTokenError("token_not_active");
  }
  if (claims.issuedAt > nowSeconds + limits.clockSkewSeconds) {
    throw new InvalidWorkosTokenError("token_issued_in_future");
  }
  if (nowSeconds - claims.issuedAt > limits.maximumTokenAgeSeconds + limits.clockSkewSeconds) {
    throw new InvalidWorkosTokenError("token_too_old");
  }
  return claims;
}
