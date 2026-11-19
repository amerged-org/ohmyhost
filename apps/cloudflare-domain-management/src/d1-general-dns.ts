import { Buffer } from "node:buffer";
import { parseUlid } from "@ohmyhost/platform";
import type { CloudflareProjectDnsGrant } from "@ohmyhost/database";
import type { CloudflareCustomerDnsProvider } from "@ohmyhost/provider-cloudflare";
import type { CustomerDomainDns } from "./paid-domains.js";
import type { CloudflareTokenCipherWithOpen } from "./secrets.js";

type Scope = { organizationId: string; projectId: string };
type Use = Scope & { useId: string; now: string };
export interface GeneralCloudflareDnsBinding {
  readGrant(input: Scope): Promise<unknown>;
  claimGrantUse(input: Use): Promise<unknown>;
  renewGrantUse(input: Use): Promise<void>;
  releaseGrantUse(input: Use): Promise<void>;
  finishGrantUse(
    input: Use & {
      authorizationId: string;
      expectedUpdatedAt: string;
      accessCiphertext: string;
      accessNonce: string;
      refreshCiphertext: string;
      refreshNonce: string;
      keyVersion: number;
      accessExpiresAt: string;
    },
  ): Promise<unknown>;
}
type DnsProvider = Pick<
  CloudflareCustomerDnsProvider,
  "reconcileRecords" | "deleteRecords" | "observeRefreshToken"
>;
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid private Cloudflare DNS response");
  return value as Record<string, unknown>;
}
function blob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (
    Array.isArray(value) &&
    value.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  )
    return Uint8Array.from(value as number[]);
  throw new TypeError("Invalid sealed Cloudflare DNS response");
}
function isReauthorizationRequired(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["status"] === "reauthorization_required"
  );
}

export function decodeGeneralCloudflareGrant(value: unknown): CloudflareProjectDnsGrant | null {
  if (value === null) return null;
  const r = record(value),
    field = (name: string) => {
      const v = r[name];
      if (typeof v !== "string") throw new TypeError("Invalid private Cloudflare DNS field");
      return v;
    };
  // A reply without a declaration (a rotation or restart answer) declares nothing, so it covers no name.
  const declared = r["declaredHostnames"] ?? [];
  if (
    !Array.isArray(declared) ||
    !declared.every((host) => typeof host === "string" && host.length > 0 && host.length <= 253)
  )
    throw new TypeError("Invalid private Cloudflare DNS declaration");
  const base = {
    organizationId: parseUlid(field("organizationId")),
    projectId: parseUlid(field("projectId")),
    authorizationId: parseUlid(field("authorizationId")),
    principalId: field("principalId"),
    zoneId: field("zoneId"),
    zoneName: field("zoneName"),
    accountId: field("accountId"),
    declaredHostnames: declared as string[],
    scopes: ["dns.write", "zone.read"] as const,
    keyVersion: Number(r["keyVersion"]),
    accessExpiresAt: field("accessExpiresAt"),
    connectedAt: field("connectedAt"),
    updatedAt: field("updatedAt"),
  };
  for (const time of [base.accessExpiresAt, base.connectedAt])
    if (new Date(time).toISOString() !== time)
      throw new TypeError("Invalid private Cloudflare DNS time");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(base.updatedAt) ||
    !Number.isFinite(Date.parse(base.updatedAt))
  )
    throw new TypeError("Invalid private Cloudflare DNS version");
  if (
    !/^[0-9a-f]{32}$/u.test(base.zoneId) ||
    !/^[0-9a-f]{32}$/u.test(base.accountId) ||
    !Number.isSafeInteger(base.keyVersion) ||
    base.keyVersion < 1 ||
    JSON.stringify(r["scopes"]) !== '["dns.write","zone.read"]'
  )
    throw new TypeError("Invalid private Cloudflare DNS identity");
  if (r["status"] === "revoked")
    return {
      ...base,
      status: "revoked",
      revokedAt: field("revokedAt"),
      accessCiphertext: null,
      accessNonce: null,
      refreshCiphertext: null,
      refreshNonce: null,
    };
  if (r["status"] !== "active" || r["revokedAt"] !== null)
    throw new TypeError("Invalid private Cloudflare DNS state");
  const access = blob(r["accessCiphertext"]),
    nonce = blob(r["accessNonce"]),
    refresh = blob(r["refreshCiphertext"]),
    refreshNonce = blob(r["refreshNonce"]);
  if (
    access.byteLength < 17 ||
    refresh.byteLength < 17 ||
    nonce.byteLength !== 12 ||
    refreshNonce.byteLength !== 12
  )
    throw new TypeError("Invalid private Cloudflare DNS envelope");
  return {
    ...base,
    status: "active",
    revokedAt: null,
    accessCiphertext: access,
    accessNonce: nonce,
    refreshCiphertext: refresh,
    refreshNonce,
  };
}

type AccessOutcome = Awaited<ReturnType<CustomerDomainDns["loadAccess"]>>;
/** The general project-grant refresh boundary. Only sealed pairs and fixed use identities cross RPC. */
export function createD1CustomerDomainDnsAccess(input: {
  binding: GeneralCloudflareDnsBinding;
  clock: { now(): Date };
  ids: { next(): string };
  tokenCipher: Pick<CloudflareTokenCipherWithOpen, "open" | "seal">;
  providerForUse(beforeRequest: () => Promise<void>): DnsProvider;
}): CustomerDomainDns & {
  /** Renews the stored token of the project's grant without naming any DNS record. */
  refreshAccess(scope: { organizationId: string; projectId: string }): Promise<AccessOutcome>;
} {
  // Exact declared names only: a zone-wide reach would let one declaration write every name of the zone.
  // A null host asks for the token alone (a status refresh), which names no DNS record.
  const covers = (grant: CloudflareProjectDnsGrant | null, host: string | null) =>
    grant?.status === "active" &&
    (host === null ||
      (grant.declaredHostnames.includes(host) &&
        (host === grant.zoneName || host.endsWith("." + grant.zoneName))))
      ? grant
      : null;
  const fresh = (grant: { accessExpiresAt: string }) =>
    Date.parse(grant.accessExpiresAt) > input.clock.now().getTime() + 60000;
  const aad = (grant: CloudflareProjectDnsGrant) =>
    `ohmyhost.cloudflare-project-grant/v1:${grant.organizationId}:${grant.projectId}:${grant.authorizationId}`;
  const open = (
    grant: Extract<CloudflareProjectDnsGrant, { status: "active" }>,
    kind: "access" | "refresh",
  ) =>
    input.tokenCipher.open({
      ciphertext: Buffer.from(
        kind === "access" ? grant.accessCiphertext : grant.refreshCiphertext,
      ).toString("base64"),
      nonce: Buffer.from(kind === "access" ? grant.accessNonce : grant.refreshNonce).toString(
        "base64",
      ),
      keyVersion: grant.keyVersion,
      associatedData: `${aad(grant)}:${kind}`,
    });
  const ready = (grant: CloudflareProjectDnsGrant, accessToken: string) => ({
    status: "ready" as const,
    accessToken,
    zoneId: grant.zoneId,
    zoneName: grant.zoneName,
  });
  const ordinary = input.providerForUse(async () => {});
  const accessFor = async (
    scope: { organizationId: string; projectId: string },
    hostname: string | null,
  ): Promise<AccessOutcome> => {
    {
      const stored = await input.binding.readGrant(scope);
      // Core withholds the grant once its consenting user lost write authority: no token is opened for it.
      if (isReauthorizationRequired(stored)) return { status: "reauthorization_required" as const };
      const grant = covers(decodeGeneralCloudflareGrant(stored), hostname);
      if (!grant) return { status: "absent" as const };
      if (fresh(grant)) return ready(grant, await open(grant, "access"));
      const useId = input.ids.next(),
        use = () => ({ ...scope, useId, now: input.clock.now().toISOString() });
      const claim = record(await input.binding.claimGrantUse(use()));
      // Closed means the project is not active or a re-authorization is pending. The grant still exists and may still
      // write the zone, so nothing is known to be gone: the caller reconciles later instead of treating it as expired.
      if (claim["status"] === "closed") return { status: "reconciliation_required" as const };
      if (claim["status"] === "absent") return { status: "absent" as const };
      if (claim["status"] !== "claimed")
        throw new TypeError("Invalid private Cloudflare grant claim");
      try {
        const current = covers(decodeGeneralCloudflareGrant(claim["grant"]), hostname);
        if (!current) return { status: "absent" as const };
        if (fresh(current)) return ready(current, await open(current, "access"));
        const provider = input.providerForUse(() => input.binding.renewGrantUse(use()));
        const observed = await provider.observeRefreshToken(await open(current, "refresh"));
        if (observed.state === "revoked") return { status: "expired" as const };
        const [access, refresh] = await Promise.all([
          input.tokenCipher.seal(observed.tokens.accessToken, `${aad(current)}:access`),
          input.tokenCipher.seal(observed.tokens.refreshToken, `${aad(current)}:refresh`),
        ]);
        if (access.keyVersion !== refresh.keyVersion)
          throw new Error("Cloudflare DNS authorization key version changed");
        const now = input.clock.now();
        const stored = decodeGeneralCloudflareGrant(
          await input.binding.finishGrantUse({
            ...scope,
            useId,
            now: now.toISOString(),
            authorizationId: current.authorizationId,
            expectedUpdatedAt: current.updatedAt,
            accessCiphertext: access.ciphertext,
            accessNonce: access.nonce,
            refreshCiphertext: refresh.ciphertext,
            refreshNonce: refresh.nonce,
            keyVersion: access.keyVersion,
            accessExpiresAt: new Date(
              now.getTime() + observed.tokens.expiresInSeconds * 1000,
            ).toISOString(),
          }),
        );
        if (
          !stored ||
          stored.status !== "active" ||
          stored.authorizationId !== current.authorizationId
        )
          throw new Error("Cloudflare DNS authorization changed during refresh");
        return ready(stored, observed.tokens.accessToken);
      } finally {
        await input.binding.releaseGrantUse(use()).catch(() => undefined);
      }
    }
  };
  return {
    loadAccess: ({ organizationId, projectId, hostname }) =>
      accessFor({ organizationId, projectId }, hostname),
    refreshAccess: (scope) => accessFor(scope, null),
    reconcileRecords: (accessToken, request, options) =>
      ordinary.reconcileRecords(accessToken, request, {
        adoptExactTrafficCname: options === undefined || !("observeOnly" in options),
        preserveUnrelatedMailRecords: true,
        ...options,
      }),
    deleteRecords: (accessToken, request) => ordinary.deleteRecords(accessToken, request),
  };
}
