import { createHash, timingSafeEqual } from "node:crypto";
import {
  AUTHORIZATION_ACTIONS,
  parseUlid,
  type AuthorizationAction,
  type AuthorizationRestriction,
} from "@ohmyhost/platform";
import type { CloudflareCustomerDnsRecord } from "@ohmyhost/provider-cloudflare";
import type { CloudflareOAuthStateSigner } from "./runtime.js";
import type { CloudflareTokenCipherWithOpen } from "./secrets.js";

export type Purpose = "application_identity" | "workspace_mail";
export interface ScopedDnsDelegation {
  grantId: string;
  grantRevision: number;
  clientId: string;
  consentHash: string;
  action?: AuthorizationAction;
  authorizationRestriction?: AuthorizationRestriction;
}
export interface Scope {
  organizationId: string;
  purpose: Purpose;
  resourceId: string;
}
export interface Resource extends Scope {
  revision: number;
  hostname: string;
  challengeName: string | null;
  challengeValue: string | null;
}
export interface Authorization extends Scope {
  authorizationId: string;
  resourceRevision: number;
  principalId: string;
  zoneName: string;
  idempotencyKeySha256: Buffer;
  requestSha256: Buffer;
  stateSha256: Buffer;
  issuedAt: string;
  expiresAt: string;
  delegation: ScopedDnsDelegation | null;
  /** Historical signing input only; authority always uses the current delegation above. */
  signedDelegation?: ScopedDnsDelegation | null;
}
export interface Grant extends Authorization {
  zoneId: string;
  accountId: string;
  accessCiphertext: Buffer;
  accessNonce: Buffer;
  refreshCiphertext: Buffer;
  refreshNonce: Buffer;
  keyVersion: number;
  accessExpiresAt: string;
  connectedAt: string;
  revokedAt: string | null;
  dnsReceipts: readonly CloudflareCustomerDnsRecord[];
}

export class ScopedDnsConflictError extends Error {
  constructor(readonly code: string) {
    super("Scoped DNS authorization conflicts with current resource authority");
  }
}

export function parseRequest(
  raw: unknown,
  purpose: Purpose,
  mutation: boolean,
  zoneRequired = true,
  parseDelegation: typeof parseScopedDnsDelegation = parseScopedDnsDelegation,
) {
  const resourceKey = purpose === "application_identity" ? "projectId" : "mailDomainId";
  const row = exactOptionalDelegation(raw, [
    "actorId",
    "organizationId",
    resourceKey,
    ...(mutation
      ? [
          "expectedRevision",
          "idempotencyKeySha256",
          "requestSha256",
          ...(zoneRequired ? ["zone"] : []),
        ]
      : []),
  ]);
  const actorId = String(row["actorId"]);
  if (actorId.length < 1 || actorId.length > 256 || containsControlCharacter(actorId))
    throw new TypeError("Scoped DNS actor is invalid");
  const expectedRevision = mutation ? Number(row["expectedRevision"]) : 0;
  const zoneName = mutation && zoneRequired ? String(row["zone"]) : "";
  if (
    mutation &&
    (!Number.isSafeInteger(row["expectedRevision"]) ||
      expectedRevision < 1 ||
      (zoneRequired &&
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(zoneName)))
  )
    throw new TypeError("Scoped DNS request is invalid");
  const idempotencyKeySha256 = String(row["idempotencyKeySha256"] ?? ""),
    requestSha256 = String(row["requestSha256"] ?? "");
  if (mutation) {
    bytes(idempotencyKeySha256);
    bytes(requestSha256);
  }
  return {
    organizationId: parseUlid(String(row["organizationId"])),
    purpose,
    resourceId: parseUlid(String(row[resourceKey])),
    actorId,
    expectedRevision,
    zoneName,
    idempotencyKeySha256,
    requestSha256,
    delegation: row["delegation"] === undefined ? null : parseDelegation(row["delegation"]),
  };
}
export async function signedState(auth: Authorization, signer: CloudflareOAuthStateSigner) {
  const authority = auth.signedDelegation === undefined ? auth.delegation : auth.signedDelegation;
  // Converted records retain their exact historical signing input. New proof metadata is
  // represented by a bounded digest; the full immutable restriction remains in Core.
  const signingAuthority =
    auth.signedDelegation !== undefined ||
    authority === null ||
    (authority.action === undefined && authority.authorizationRestriction === undefined)
      ? authority
      : {
          scheme: "authority-sha256",
          digest: sha(
            JSON.stringify([
              authority.grantId,
              authority.grantRevision,
              authority.clientId,
              authority.consentHash,
              authority.action ?? null,
              authority.authorizationRestriction === undefined
                ? null
                : (["actions", "organizationIds", "projectIds", "mailDomainIds"] as const).map(
                    (key) => [
                      key,
                      authority.authorizationRestriction?.[key] === undefined
                        ? null
                        : [...authority.authorizationRestriction[key]].sort(),
                    ],
                  ),
            ]),
          ).toString("hex"),
        };
  const signature = await signer.sign(
    JSON.stringify([
      "ohmyhost.scoped-dns-state/v1",
      auth.authorizationId,
      auth.organizationId,
      auth.purpose,
      auth.resourceId,
      auth.resourceRevision,
      auth.principalId,
      auth.zoneName,
      auth.idempotencyKeySha256.toString("hex"),
      auth.requestSha256.toString("hex"),
      signingAuthority,
    ]),
  );
  if (!/^[A-Za-z0-9_-]{43}$/u.test(signature))
    throw new TypeError("Scoped DNS state signer is invalid");
  return `${auth.authorizationId}.${signature}`;
}
export function aad(
  auth: Pick<
    Authorization,
    "organizationId" | "purpose" | "resourceId" | "resourceRevision" | "authorizationId"
  >,
) {
  return `ohmyhost.scoped-customer-dns-grant/v1:${auth.organizationId}:${auth.purpose}:${auth.resourceId}:${auth.resourceRevision}:${auth.authorizationId}`;
}
/** Opens a displaced refresh token from the fields its AAD names; the same bytes `openToken` opens for a grant. */
export function openRefreshToken(
  cipher: CloudflareTokenCipherWithOpen,
  token: Pick<
    Grant,
    | "organizationId"
    | "purpose"
    | "resourceId"
    | "resourceRevision"
    | "authorizationId"
    | "keyVersion"
    | "refreshCiphertext"
    | "refreshNonce"
  >,
) {
  return cipher.open({
    ciphertext: token.refreshCiphertext.toString("base64"),
    nonce: token.refreshNonce.toString("base64"),
    keyVersion: token.keyVersion,
    associatedData: `${aad(token)}:refresh`,
  });
}
export function openToken(
  cipher: CloudflareTokenCipherWithOpen,
  grant: Grant,
  kind: "access" | "refresh",
) {
  return cipher.open({
    ciphertext: (kind === "access" ? grant.accessCiphertext : grant.refreshCiphertext).toString(
      "base64",
    ),
    nonce: (kind === "access" ? grant.accessNonce : grant.refreshNonce).toString("base64"),
    keyVersion: grant.keyVersion,
    associatedData: `${aad(grant)}:${kind}`,
  });
}
export function sha(value: string) {
  return createHash("sha256").update(value).digest();
}
export function equal(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
export function bytes(value: string) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError("Scoped DNS digest is invalid");
  return Buffer.from(value.slice(7), "hex");
}
export function decode(value: string) {
  return Buffer.from(value, "base64");
}
export function timestamp(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
export function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new TypeError("Scoped DNS input is invalid");
  return raw as Record<string, unknown>;
}

function exactOptionalDelegation(raw: unknown, keys: readonly string[]) {
  const extra =
    typeof raw === "object" && raw !== null && Object.hasOwn(raw, "delegation")
      ? ["delegation"]
      : [];
  return exact(raw, [...keys, ...extra]);
}

const LEGACY_PRODUCTION_ACTIONS = AUTHORIZATION_ACTIONS.filter(
  (action) => action !== "auth:read" && action !== "auth:manage",
);
export function parseScopedDnsDelegation(raw: unknown): ScopedDnsDelegation {
  return parseDelegation(raw, AUTHORIZATION_ACTIONS);
}
/** The deployed pre-Native Production vocabulary; not a customer-selectable parser mode. */
export function parseLegacyProductionScopedDnsDelegation(raw: unknown): ScopedDnsDelegation {
  return parseDelegation(raw, LEGACY_PRODUCTION_ACTIONS);
}
function parseDelegation(
  raw: unknown,
  actions: readonly AuthorizationAction[],
): ScopedDnsDelegation {
  const optionalKeys = ["action", "authorizationRestriction"].filter(
    (key) => typeof raw === "object" && raw !== null && Object.hasOwn(raw, key),
  );
  const row = exact(raw, ["grantId", "grantRevision", "clientId", "consentHash", ...optionalKeys]);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      String(row["grantId"]),
    ) ||
    !/^[a-f0-9]{64}$/u.test(String(row["consentHash"])) ||
    typeof row["clientId"] !== "string" ||
    row["clientId"].length < 1 ||
    row["clientId"].length > 2048 ||
    /\s/u.test(row["clientId"]) ||
    containsControlCharacter(row["clientId"]) ||
    !Number.isSafeInteger(row["grantRevision"]) ||
    Number(row["grantRevision"]) < 1
  )
    throw new TypeError("Scoped DNS delegation is invalid");
  const action = row["action"];
  if (Object.hasOwn(row, "action") && !(actions as readonly unknown[]).includes(action))
    throw new TypeError("Scoped DNS delegation action is invalid");
  return {
    grantId: String(row["grantId"]),
    grantRevision: Number(row["grantRevision"]),
    clientId: row["clientId"],
    consentHash: String(row["consentHash"]),
    ...(action === undefined ? {} : { action: action as AuthorizationAction }),
    ...(Object.hasOwn(row, "authorizationRestriction")
      ? { authorizationRestriction: parseRestriction(row["authorizationRestriction"], actions) }
      : {}),
  };
}

/** Preserve the accepted ceiling, including empty dimensions, across the private DNS boundary. */
function parseRestriction(
  raw: unknown,
  actions: readonly AuthorizationAction[],
): AuthorizationRestriction {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new TypeError("Scoped DNS restriction is invalid");
  const keys = ["actions", "organizationIds", "projectIds", "mailDomainIds"];
  const result: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      !keys.includes(key) ||
      !Array.isArray(value) ||
      value.length > 1000 ||
      !value.every((item) => typeof item === "string")
    )
      throw new TypeError("Scoped DNS restriction is invalid");
    if (key === "actions") {
      if (!value.every((item) => (actions as readonly unknown[]).includes(item)))
        throw new TypeError("Scoped DNS restriction action is invalid");
      result[key] = [...value] as AuthorizationAction[];
    } else {
      result[key] = value.map((item: string) => parseUlid(item));
    }
  }
  return result as AuthorizationRestriction;
}

function containsControlCharacter(value: string) {
  for (const character of value)
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return true;
  return false;
}
