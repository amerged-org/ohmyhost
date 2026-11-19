import { parseUlid } from "@ohmyhost/platform";
import {
  ScopedDnsConflictError,
  parseScopedDnsDelegation,
  timestamp,
  type Authorization,
  type Grant,
  type Resource,
} from "./scoped-dns-authorization.js";
import type {
  DisplacedGrantToken,
  ScopedDnsCleanup,
  ScopedDnsPersistence,
  ScopedDnsSealedTokens,
  ScopedDnsStatus,
  ScopedDnsRevocationStatus,
  ScopedDnsUse,
} from "./scoped-dns-persistence.js";

interface ScopedDnsRuntimeBinding {
  readAuthorization(input: unknown): Promise<unknown>;
  issue(input: unknown): Promise<unknown>;
  status(input: unknown): Promise<unknown>;
  revoke(input: unknown): Promise<unknown>;
  listRevokedGrants(input: unknown): Promise<unknown>;
  wipeRevokedGrantTokens(input: unknown): Promise<unknown>;
  listDisplacedTokens(input: unknown): Promise<unknown>;
  completeDisplacedToken(input: unknown): Promise<unknown>;
  consume(input: unknown): Promise<unknown>;
  saveGrant(input: unknown): Promise<unknown>;
  claimUse(input: unknown): Promise<unknown>;
  renewUse(input: unknown): Promise<unknown>;
  authorizeUse(input: unknown): Promise<unknown>;
  finishUse(input: unknown): Promise<unknown>;
  releaseUse(input: unknown): Promise<unknown>;
  readCleanup(input: unknown): Promise<unknown>;
  completeEmptyCleanup(input: unknown): Promise<unknown>;
}
function invalid(): never {
  throw new TypeError("scoped_dns_response_invalid");
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]) {
  const row = object(value);
  if (Object.keys(row).sort().join(",") !== [...keys].sort().join(",")) return invalid();
  return row;
}
function text(value: unknown) {
  return typeof value === "string" ? value : invalid();
}
function integer(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : invalid();
}
function blob(value: unknown, size?: number) {
  const v = text(value);
  if (!/^(?:[a-f0-9]{2})*$/u.test(v) || (size !== undefined && v.length !== size * 2))
    return invalid();
  return Buffer.from(v, "hex");
}
function time(value: unknown) {
  const v = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(v) || !Number.isFinite(Date.parse(v)))
    return invalid();
  return timestamp(v);
}
function array(value: unknown): unknown[] {
  if (typeof value !== "string") return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid();
  }
  return Array.isArray(parsed) ? parsed : invalid();
}
const AUTH_KEYS = [
  "organizationId",
  "purpose",
  "resourceId",
  "resourceRevision",
  "authorizationId",
  "principalId",
  "zoneName",
  "idempotencyKeySha256",
  "requestSha256",
  "stateSha256",
  "issuedAt",
  "expiresAt",
  "delegation",
];
function authKeys(raw: unknown): string[] {
  return typeof raw === "object" && raw !== null && Object.hasOwn(raw, "signedDelegation")
    ? [...AUTH_KEYS, "signedDelegation"]
    : AUTH_KEYS;
}
function auth(raw: unknown, parseDelegation: typeof parseScopedDnsDelegation): Authorization {
  const row = exact(raw, authKeys(raw)),
    purpose = row["purpose"];
  if (purpose !== "application_identity" && purpose !== "workspace_mail") return invalid();
  return {
    organizationId: parseUlid(text(row["organizationId"])),
    purpose,
    resourceId: parseUlid(text(row["resourceId"])),
    resourceRevision: integer(row["resourceRevision"]),
    authorizationId: parseUlid(text(row["authorizationId"])),
    principalId: text(row["principalId"]),
    zoneName: text(row["zoneName"]),
    idempotencyKeySha256: blob(row["idempotencyKeySha256"], 32),
    requestSha256: blob(row["requestSha256"], 32),
    stateSha256: blob(row["stateSha256"], 32),
    issuedAt: time(row["issuedAt"]),
    expiresAt: time(row["expiresAt"]),
    delegation: row["delegation"] === null ? null : parseDelegation(row["delegation"]),
    ...(Object.hasOwn(row, "signedDelegation")
      ? {
          signedDelegation:
            row["signedDelegation"] === null ? null : parseDelegation(row["signedDelegation"]),
        }
      : {}),
  };
}
function grant(raw: unknown, parseDelegation: typeof parseScopedDnsDelegation): Grant {
  const row = exact(raw, [
      ...authKeys(raw),
      "zoneId",
      "accountId",
      "accessCiphertext",
      "accessNonce",
      "refreshCiphertext",
      "refreshNonce",
      "keyVersion",
      "accessExpiresAt",
      "connectedAt",
      "revokedAt",
      "dnsReceipts",
    ]),
    base = auth(Object.fromEntries(authKeys(raw).map((key) => [key, row[key]])), parseDelegation);
  if (
    !/^[a-f0-9]{32}$/u.test(text(row["zoneId"])) ||
    !/^[a-f0-9]{32}$/u.test(text(row["accountId"]))
  )
    return invalid();
  return {
    ...base,
    zoneId: text(row["zoneId"]),
    accountId: text(row["accountId"]),
    accessCiphertext: blob(row["accessCiphertext"]),
    accessNonce: blob(row["accessNonce"], 12),
    refreshCiphertext: blob(row["refreshCiphertext"]),
    refreshNonce: blob(row["refreshNonce"], 12),
    keyVersion: integer(row["keyVersion"]),
    accessExpiresAt: time(row["accessExpiresAt"]),
    connectedAt: time(row["connectedAt"]),
    revokedAt: row["revokedAt"] === null ? null : time(row["revokedAt"]),
    dnsReceipts: array(row["dnsReceipts"]) as Grant["dnsReceipts"],
  };
}
function displacedToken(value: unknown): DisplacedGrantToken {
  const row = exact(value, [
    "displacedId",
    "organizationId",
    "purpose",
    "resourceId",
    "resourceRevision",
    "authorizationId",
    "keyVersion",
    "refreshCiphertext",
    "refreshNonce",
  ]);
  return {
    displacedId: text(row["displacedId"]),
    organizationId: text(row["organizationId"]),
    purpose: text(row["purpose"]) as Grant["purpose"],
    resourceId: text(row["resourceId"]),
    resourceRevision: integer(row["resourceRevision"]),
    authorizationId: text(row["authorizationId"]),
    keyVersion: integer(row["keyVersion"]),
    refreshCiphertext: blob(row["refreshCiphertext"]),
    refreshNonce: blob(row["refreshNonce"], 12),
  };
}
function responseTime(value: unknown) {
  const v = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/u.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    return invalid();
  return timestamp(v);
}
function status(raw: unknown): ScopedDnsStatus {
  const row = exact(raw, ["status", "zone", "scopes", "expiresAt"]),
    kind = text(row["status"]);
  if (kind === "not_authorized") {
    if (
      row["zone"] !== null ||
      row["expiresAt"] !== null ||
      !Array.isArray(row["scopes"]) ||
      row["scopes"].length !== 0
    )
      return invalid();
    return { status: "not_authorized", zone: null, scopes: [], expiresAt: null };
  }
  if (
    !["pending", "authorized", "expired", "revoked"].includes(kind) ||
    !Array.isArray(row["scopes"]) ||
    row["scopes"].join(",") !== "dns.write,zone.read"
  )
    return invalid();
  const zone = text(row["zone"]),
    expiresAt = responseTime(row["expiresAt"]),
    scopes = ["dns.write", "zone.read"] as const;
  if (kind === "authorized") return { status: "authorized", zone, scopes, expiresAt };
  return { status: kind as "pending" | "expired" | "revoked", zone, scopes, expiresAt };
}
function revocation(raw: unknown): ScopedDnsRevocationStatus {
  const value = status(raw);
  if (value.status !== "revoked" && value.status !== "not_authorized") return invalid();
  return { ...value, status: value.status };
}
function cleanup(raw: unknown): ScopedDnsCleanup {
  const row = exact(raw, ["records", "zoneId", "zoneName", "cleanup", "receipt"]);
  if (!Array.isArray(row["records"])) return invalid();
  let settled: ScopedDnsCleanup["cleanup"] = null;
  if (row["cleanup"] !== null) {
    const c = exact(row["cleanup"], ["status", "recordIds"]);
    if (
      c["status"] !== "deleted" ||
      !Array.isArray(c["recordIds"]) ||
      c["recordIds"].some((id) => typeof id !== "string")
    )
      return invalid();
    settled = { status: "deleted", recordIds: c["recordIds"] as string[] };
  }
  return {
    records: row["records"] as ScopedDnsCleanup["records"],
    ...(row["zoneId"] === undefined ? {} : { zoneId: text(row["zoneId"]) }),
    ...(row["zoneName"] === undefined ? {} : { zoneName: text(row["zoneName"]) }),
    cleanup: settled,
    receipt: text(row["receipt"]),
  };
}
const empty = (value: unknown) => (value === undefined ? undefined : invalid());
const boolean = (value: unknown) => (typeof value === "boolean" ? value : invalid());
const wireAuth = (value: Authorization) => ({
  organizationId: value.organizationId,
  purpose: value.purpose,
  resourceId: value.resourceId,
  resourceRevision: value.resourceRevision,
  authorizationId: value.authorizationId,
  principalId: value.principalId,
  zoneName: value.zoneName,
  idempotencyKeySha256: value.idempotencyKeySha256.toString("hex"),
  requestSha256: value.requestSha256.toString("hex"),
  stateSha256: value.stateSha256.toString("hex"),
  issuedAt: value.issuedAt,
  expiresAt: value.expiresAt,
  delegation: value.delegation,
});
const wireTokens = (value: ScopedDnsSealedTokens) => ({
  accessCiphertext: Buffer.from(value.accessCiphertext).toString("hex"),
  accessNonce: Buffer.from(value.accessNonce).toString("hex"),
  refreshCiphertext: Buffer.from(value.refreshCiphertext).toString("hex"),
  refreshNonce: Buffer.from(value.refreshNonce).toString("hex"),
  keyVersion: value.keyVersion,
  accessExpiresAt: value.accessExpiresAt,
});
const useScope = (value: ScopedDnsUse) => ({
  organizationId: value.resource.organizationId,
  purpose: value.resource.purpose,
  resourceId: value.resource.resourceId,
  leaseToken: value.leaseToken,
});
async function invoke<T>(call: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let result;
  try {
    result = await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    for (const code of [
      "dns_resource_unavailable",
      "dns_resource_stale",
      "dns_authority_revoked",
      "authorization_closed",
      "authorization_pending",
      "idempotency_key_reused",
      "mail_retirement_unavailable",
      "mail_dns_receipt_changed",
      "mail_dns_authorization_required",
      "dns_use_lease_lost",
      "store_busy",
      "store_outcome_unknown",
    ]) {
      if (message !== code && !message.endsWith(`: ${code}`)) continue;
      if (code === "store_busy" || code === "store_outcome_unknown")
        throw Object.assign(new Error(code), { code });
      throw new ScopedDnsConflictError(code);
    }
    throw new Error("scoped_dns_core_unavailable");
  }
  return parse(result);
}
/** A fixed purpose-bound metadata capability. No SQL, callback, access token or reconstructed grant crosses RPC. */
export async function createD1ScopedDnsPersistence(
  raw: unknown,
  parseDelegation: typeof parseScopedDnsDelegation = parseScopedDnsDelegation,
): Promise<ScopedDnsPersistence> {
  const methods = [
    "readAuthorization",
    "issue",
    "status",
    "revoke",
    "listRevokedGrants",
    "wipeRevokedGrantTokens",
    "listDisplacedTokens",
    "completeDisplacedToken",
    "consume",
    "saveGrant",
    "claimUse",
    "renewUse",
    "authorizeUse",
    "finishUse",
    "releaseUse",
    "readCleanup",
    "completeEmptyCleanup",
  ];
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    methods.some((name) => typeof Reflect.get(raw, name) !== "function")
  )
    throw new Error("scoped_dns_binding_required");
  const binding = raw as ScopedDnsRuntimeBinding;
  const readAuth = (value: unknown) => auth(value, parseDelegation);
  const nullableAuth = (value: unknown) => (value === null ? null : readAuth(value));
  await invoke(
    () => binding.readAuthorization({ authorizationId: "00000000000000000000000000" }),
    nullableAuth,
  );
  return {
    issue: (input) => invoke(() => binding.issue(wireAuth(input)), readAuth),
    status: (input, now) => invoke(() => binding.status({ ...input, now: now() }), status),
    revoke: (input, now) =>
      invoke(
        () =>
          binding.revoke({
            ...input,
            idempotencyKeySha256: input.idempotencyKeySha256.toString("hex"),
            requestSha256: input.requestSha256.toString("hex"),
            now: now(),
          }),
        revocation,
      ),
    listRevokedGrants: (limit) =>
      invoke(
        () => binding.listRevokedGrants({ limit }),
        (value) =>
          Array.isArray(value) ? value.map((item) => grant(item, parseDelegation)) : invalid(),
      ),
    listDisplacedTokens: (limit) =>
      invoke(
        () => binding.listDisplacedTokens({ limit }),
        (value) => (Array.isArray(value) ? value.map(displacedToken) : invalid()),
      ),
    completeDisplacedToken: (input) =>
      invoke(
        () =>
          binding.completeDisplacedToken({
            organizationId: input.organizationId,
            purpose: input.purpose,
            resourceId: input.resourceId,
            displacedId: input.displacedId,
            refreshCiphertext: input.refreshCiphertext.toString("hex"),
          }),
        boolean,
      ),
    wipeRevokedGrantTokens: (input) =>
      invoke(
        () =>
          binding.wipeRevokedGrantTokens({
            organizationId: input.organizationId,
            purpose: input.purpose,
            resourceId: input.resourceId,
            authorizationId: input.authorizationId,
            refreshCiphertext: input.refreshCiphertext.toString("hex"),
          }),
        boolean,
      ),
    consume: (id, digest, principalId, now) =>
      invoke(
        () =>
          binding.consume({
            authorizationId: id,
            stateSha256: Buffer.from(digest).toString("hex"),
            principalId,
            now: now(),
          }),
        nullableAuth,
      ),
    saveGrant: (input) =>
      invoke(
        () =>
          binding.saveGrant({
            ...wireAuth(input),
            ...wireTokens(input),
            zoneId: input.zoneId,
            accountId: input.accountId,
            connectedAt: input.connectedAt,
          }),
        empty,
      ),
    claimUse: (input, leaseToken, clean, now) =>
      invoke(
        () => binding.claimUse({ ...input, leaseToken, cleanup: clean, now: now() }),
        (value) => {
          if (value === null) return null;
          const row = exact(value, ["leaseToken", "resource", "grant"]),
            r = exact(row["resource"], [
              "organizationId",
              "purpose",
              "resourceId",
              "revision",
              "hostname",
              "challengeName",
              "challengeValue",
            ]),
            g = grant(row["grant"], parseDelegation);
          if (
            r["purpose"] !== input.purpose ||
            r["organizationId"] !== input.organizationId ||
            r["resourceId"] !== input.resourceId ||
            row["leaseToken"] !== leaseToken ||
            g.organizationId !== input.organizationId ||
            g.purpose !== input.purpose ||
            g.resourceId !== input.resourceId
          )
            return invalid();
          const resource: Resource = {
            ...input,
            revision: integer(r["revision"]),
            hostname: text(r["hostname"]),
            challengeName: r["challengeName"] === null ? null : text(r["challengeName"]),
            challengeValue: r["challengeValue"] === null ? null : text(r["challengeValue"]),
          };
          return { leaseToken, resource, grant: g };
        },
      ),
    renewUse: (input) => invoke(() => binding.renewUse(useScope(input)), empty),
    authorizeUse: (input) => invoke(() => binding.authorizeUse(useScope(input)), boolean),
    finishUse: (input, result) =>
      invoke(
        () =>
          binding.finishUse({
            ...useScope(input),
            result:
              result.kind === "applied"
                ? { ...result, tokens: result.tokens === null ? null : wireTokens(result.tokens) }
                : result,
          }),
        empty,
      ),
    releaseUse: (input) => invoke(() => binding.releaseUse(useScope(input)), empty),
    readCleanup: (input) => invoke(() => binding.readCleanup(input), cleanup),
    completeEmptyCleanup: (input, expectedReceipt, now) =>
      invoke(
        () => binding.completeEmptyCleanup({ ...input, expectedReceipt, now: now() }),
        (value) => {
          const row = exact(value, ["status", "recordIds"]);
          if (
            row["status"] !== "deleted" ||
            !Array.isArray(row["recordIds"]) ||
            row["recordIds"].length !== 0
          )
            return invalid();
          return { status: "deleted", recordIds: [] };
        },
      ),
  };
}
