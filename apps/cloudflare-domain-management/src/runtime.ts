import { createHash, timingSafeEqual } from "node:crypto";
import { parseProjectHandle } from "@ohmyhost/project-handles";
import { parseUlid } from "@ohmyhost/platform";

const AUTHORIZATION_TTL_MILLISECONDS = 10 * 60 * 1_000;
const ZONE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

interface CloudflareDomainManagementClock {
  now(): Date;
}

export interface CloudflareDomainManagementIds {
  next(): string;
}

export interface CloudflareOAuthStateSigner {
  sign(input: string): Promise<string>;
}

export interface CloudflareTokenCipher {
  seal(
    plaintext: string,
    associatedData: string,
  ): Promise<{
    readonly ciphertext: string;
    readonly nonce: string;
    readonly keyVersion: number;
  }>;
}

export interface CloudflareCustomerOAuthProvider {
  authorizationUrl(input: { readonly state: string }): string;
  exchangeAuthorizationCode(code: string): Promise<{
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresInSeconds: number;
    readonly scopes: readonly ["dns.write", "zone.read"];
  }>;
  observeZone(
    accessToken: string,
    zone: string,
  ): Promise<
    | { readonly state: "absent"; readonly zoneName: string }
    | {
        readonly state: "found";
        readonly zoneId: string;
        readonly zoneName: string;
        readonly accountId: string;
      }
  >;
  revokeRefreshToken(refreshToken: string): Promise<void>;
}

export interface CloudflareDomainManagementPersistence {
  claimAuthorization(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly authorizationId: string;
    readonly principalId: string;
    readonly zoneName: string;
    readonly idempotencyKeySha256: string;
    readonly requestSha256: string;
    readonly stateSha256: Uint8Array;
    readonly issuedAt: string;
    readonly expiresAt: string;
  }): Promise<{
    readonly organizationId: string;
    readonly projectId: string;
    readonly authorizationId: string;
    readonly principalId: string;
    readonly zoneName: string;
    readonly idempotencyKeySha256: string;
    readonly requestSha256: string;
    readonly stateSha256: Uint8Array;
    readonly issuedAt: string;
    readonly expiresAt: string;
  }>;
  /** Consumes the state only for the user who started it; any other principal leaves it open and gets null. */
  consumeAuthorization(input: {
    readonly authorizationId: string;
    readonly stateSha256: Uint8Array;
    readonly principalId: string;
    readonly consumedAt: string;
  }): Promise<{
    readonly organizationId: string;
    readonly projectId: string;
    readonly authorizationId: string;
    readonly principalId: string;
    readonly zoneName: string;
  } | null>;
  putGrant(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly authorizationId: string;
    readonly principalId: string;
    readonly zoneName: string;
    readonly zoneId: string;
    readonly accountId: string;
    readonly scopes: readonly ["dns.write", "zone.read"];
    readonly accessCiphertext: string;
    readonly accessNonce: string;
    readonly refreshCiphertext: string;
    readonly refreshNonce: string;
    readonly keyVersion: number;
    readonly accessExpiresAt: string;
    readonly connectedAt: string;
  }): Promise<"created" | "existing">;
  readStatus(input: { readonly organizationId: string; readonly projectId: string }): Promise<{
    readonly status: "not_authorized" | "pending" | "authorized" | "expired" | "revoked";
    readonly zone: string | null;
    readonly scopes: readonly ("dns.write" | "zone.read")[];
    readonly expiresAt: string | null;
  }>;
  configureDomains(input: {
    readonly platform: "development" | "production";
    readonly organizationId: string;
    readonly projectId: string;
    readonly principalId: string;
    readonly idempotencyKeySha256: string;
    readonly requestSha256: string;
    readonly projectHandle: string;
    readonly configuredAt: string;
  }): Promise<{
    readonly status: 202;
    readonly location: string;
    readonly body: Readonly<Record<string, unknown>>;
  }>;
}

export function createCloudflareDomainManagementRuntime(dependencies: {
  readonly platform: "development" | "production";
  readonly clock: CloudflareDomainManagementClock;
  readonly ids: CloudflareDomainManagementIds;
  readonly stateSigner: CloudflareOAuthStateSigner;
  readonly tokenCipher: CloudflareTokenCipher;
  readonly oauth: CloudflareCustomerOAuthProvider;
  readonly persistence: CloudflareDomainManagementPersistence;
  readonly grantAccess: {
    refreshAccess(scope: {
      organizationId: string;
      projectId: string;
    }): Promise<{ readonly status: string }>;
  };
}) {
  return Object.freeze({
    async beginAuthorization(rawInput: unknown) {
      const input = parseBeginAuthorizationInput(rawInput);
      const authorizationId = dependencies.ids.next();
      const state = await oauthState(dependencies.stateSigner, authorizationId, input);
      const issuedAt = dependencies.clock.now();
      const expiresAt = new Date(issuedAt.getTime() + AUTHORIZATION_TTL_MILLISECONDS);
      const claimed = await dependencies.persistence.claimAuthorization({
        ...input,
        authorizationId,
        principalId: input.actorId,
        zoneName: input.zone,
        stateSha256: sha256(state),
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      const claimedState = await oauthState(dependencies.stateSigner, claimed.authorizationId, {
        organizationId: claimed.organizationId,
        projectId: claimed.projectId,
        actorId: claimed.principalId,
        idempotencyKeySha256: claimed.idempotencyKeySha256,
        requestSha256: claimed.requestSha256,
        zone: claimed.zoneName,
      });
      if (!equalDigest(claimed.stateSha256, sha256(claimedState))) {
        throw new CloudflareDomainManagementConflictError();
      }
      return Object.freeze({
        authorizationId: claimed.authorizationId,
        authorizationUrl: dependencies.oauth.authorizationUrl({ state: claimedState }),
        expiresAt: claimed.expiresAt,
      });
    },

    async getStatus(rawInput: unknown) {
      const input = parseScope(rawInput, ["actorId", "organizationId", "projectId"]);
      const status = await dependencies.persistence.readStatus(input);
      // An expired access token of a stored grant is renewed first; the grant stays expired only
      // when Cloudflare refuses its refresh token, and a refresh outage stays unavailable.
      if (status.status !== "expired" || status.zone === null) return status;
      const access = await dependencies.grantAccess.refreshAccess({
        organizationId: parseUlid(input.organizationId),
        projectId: parseUlid(input.projectId),
      });
      return access.status === "ready" ? dependencies.persistence.readStatus(input) : status;
    },

    async configureDomains(rawInput: unknown) {
      const input = parseConfigureDomainsInput(rawInput);
      return dependencies.persistence.configureDomains({
        ...input,
        platform: dependencies.platform,
        principalId: input.actorId,
        configuredAt: dependencies.clock.now().toISOString(),
      });
    },

    async completeAuthorization(rawInput: unknown) {
      const input = parseCallbackInput(rawInput);
      const authorizationId = input.state.slice(0, 26);
      const consumed = await dependencies.persistence.consumeAuthorization({
        authorizationId,
        stateSha256: sha256(input.state),
        principalId: input.principalId,
        consumedAt: dependencies.clock.now().toISOString(),
      });
      if (consumed === null) return Object.freeze({ status: "invalid" as const });
      let tokens;
      try {
        tokens = await dependencies.oauth.exchangeAuthorizationCode(input.code);
      } catch {
        return Object.freeze({ status: "token_exchange_failed" as const });
      }
      // A token pair that no grant stores is revoked at Cloudflare, so the account never keeps a live DNS-write
      // grant that nothing can revoke. A failed revoke keeps the status of the callback.
      const abandon = async (
        status: "zone_observe_failed" | "token_encrypt_failed" | "grant_persist_failed",
      ) => {
        try {
          await dependencies.oauth.revokeRefreshToken(tokens.refreshToken);
        } catch {
          /* The status below is the callback's answer; the revoke is best-effort. */
        }
        return Object.freeze({ status });
      };
      let zone;
      try {
        zone = await dependencies.oauth.observeZone(tokens.accessToken, consumed.zoneName);
      } catch {
        return abandon("zone_observe_failed");
      }
      if (zone.state !== "found" || zone.zoneName !== consumed.zoneName) {
        return abandon("zone_observe_failed");
      }
      const connectedAt = dependencies.clock.now();
      const associatedData = grantAssociatedData(consumed);
      let access;
      let refresh;
      try {
        [access, refresh] = await Promise.all([
          dependencies.tokenCipher.seal(tokens.accessToken, `${associatedData}:access`),
          dependencies.tokenCipher.seal(tokens.refreshToken, `${associatedData}:refresh`),
        ]);
      } catch {
        return abandon("token_encrypt_failed");
      }
      if (access.keyVersion !== refresh.keyVersion) {
        return abandon("token_encrypt_failed");
      }
      try {
        await dependencies.persistence.putGrant({
          ...consumed,
          zoneId: zone.zoneId,
          accountId: zone.accountId,
          scopes: tokens.scopes,
          accessCiphertext: access.ciphertext,
          accessNonce: access.nonce,
          refreshCiphertext: refresh.ciphertext,
          refreshNonce: refresh.nonce,
          keyVersion: access.keyVersion,
          accessExpiresAt: new Date(
            connectedAt.getTime() + tokens.expiresInSeconds * 1_000,
          ).toISOString(),
          connectedAt: connectedAt.toISOString(),
        });
      } catch {
        return abandon("grant_persist_failed");
      }
      return Object.freeze({ status: "authorized" as const });
    },
  });
}

export class CloudflareDomainManagementConflictError extends Error {
  public constructor() {
    super("Cloudflare domain-management state conflicts with the requested operation");
    this.name = "CloudflareDomainManagementConflictError";
  }
}

export class CloudflareZoneNotBoundError extends Error {
  public constructor() {
    super(
      "Declare a Paid domain or mail sender in this project's requested zone before authorizing Cloudflare.",
    );
    this.name = "CloudflareZoneNotBoundError";
  }
}

async function oauthState(
  signer: CloudflareOAuthStateSigner,
  authorizationId: string,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly actorId: string;
    readonly idempotencyKeySha256: string;
    readonly requestSha256: string;
    readonly zone: string;
  },
): Promise<string> {
  requireUlid(authorizationId);
  const signature = await signer.sign(
    JSON.stringify([
      "ohmyhost.cloudflare-oauth-state/v1",
      authorizationId,
      input.organizationId,
      input.projectId,
      input.actorId,
      input.idempotencyKeySha256,
      input.requestSha256,
      input.zone,
    ]),
  );
  if (!/^[A-Za-z0-9_-]{43}$/u.test(signature)) {
    throw new TypeError("Cloudflare OAuth state signer returned an invalid signature");
  }
  return `${authorizationId}.${signature}`;
}

function parseBeginAuthorizationInput(value: unknown) {
  const input = exactRecord(value, [
    "actorId",
    "idempotencyKeySha256",
    "organizationId",
    "projectId",
    "requestSha256",
    "zone",
  ]);
  const scope = parseScope(input, [
    "actorId",
    "idempotencyKeySha256",
    "organizationId",
    "projectId",
    "requestSha256",
    "zone",
  ]);
  if (
    typeof input["zone"] !== "string" ||
    !validCustomerZone(input["zone"]) ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(input["idempotencyKeySha256"])) ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(input["requestSha256"]))
  ) {
    throw new TypeError("Cloudflare authorization input is invalid");
  }
  return Object.freeze({
    ...scope,
    idempotencyKeySha256: String(input["idempotencyKeySha256"]),
    requestSha256: String(input["requestSha256"]),
    zone: input["zone"],
  });
}

function validCustomerZone(value: string): boolean {
  return (
    ZONE.test(value) &&
    !value.endsWith(".poc.aixyte.com") &&
    value !== "omh.st" &&
    !value.endsWith(".omh.st") &&
    value !== "ohmyho.st" &&
    !value.endsWith(".ohmyho.st")
  );
}

function parseConfigureDomainsInput(value: unknown) {
  const input = exactRecord(value, [
    "actorId",
    "idempotencyKeySha256",
    "organizationId",
    "projectHandle",
    "projectId",
    "requestSha256",
  ]);
  const scope = parseScope(input, Object.keys(input));
  const handle = parseProjectHandle(input["projectHandle"]);
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(String(input["idempotencyKeySha256"])) ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(input["requestSha256"]))
  ) {
    throw new TypeError("Cloudflare project domains are invalid");
  }
  return Object.freeze({
    ...scope,
    idempotencyKeySha256: String(input["idempotencyKeySha256"]),
    requestSha256: String(input["requestSha256"]),
    projectHandle: handle,
  });
}

function parseCallbackInput(value: unknown) {
  const input = exactRecord(value, ["code", "principalId", "state"]);
  const code = String(input["code"]);
  const state = String(input["state"]);
  const principalId = String(input["principalId"]);
  if (
    !/^[A-Za-z0-9._~-]{8,2048}$/u.test(code) ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}\.[A-Za-z0-9_-]{43}$/u.test(state) ||
    principalId.length < 1 ||
    principalId.length > 256 ||
    containsControlCharacter(principalId)
  ) {
    throw new TypeError("Cloudflare OAuth callback is invalid");
  }
  return Object.freeze({ code, state, principalId });
}

function parseScope(value: unknown, keys: readonly string[]) {
  const input = exactRecord(value, keys);
  const organizationId = String(input["organizationId"]);
  const projectId = String(input["projectId"]);
  const actorId = String(input["actorId"]);
  requireUlid(organizationId);
  requireUlid(projectId);
  if (actorId.length < 1 || actorId.length > 256 || containsControlCharacter(actorId)) {
    throw new TypeError("Cloudflare domain-management scope is invalid");
  }
  return Object.freeze({ organizationId, projectId, actorId });
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function grantAssociatedData(input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly authorizationId: string;
}): string {
  return `ohmyhost.cloudflare-project-grant/v1:${input.organizationId}:${input.projectId}:${input.authorizationId}`;
}

function sha256(value: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}

function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function requireUlid(value: string): void {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)) throw new TypeError("ULID is invalid");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Cloudflare domain-management input is invalid");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Cloudflare domain-management input is invalid");
  }
  return record;
}
