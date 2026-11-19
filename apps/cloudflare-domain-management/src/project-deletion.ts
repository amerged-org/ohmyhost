import { createHash } from "node:crypto";
import {
  CloudflareCustomerDnsRejectedError,
  type CloudflareCustomerDnsRecord,
  type CloudflareWorkerRouteReceipt,
} from "@ohmyhost/provider-cloudflare";
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import type {
  CloudflareProjectDomainDeletionState,
  CloudflareProjectDomainReceipt,
  CloudflareProjectDnsGrant,
} from "@ohmyhost/database";

import type { CloudflareTokenCipherWithOpen } from "./secrets.js";

const REFRESH_SKEW_MILLISECONDS = 60_000;

export interface CloudflareProjectDeletionPersistence {
  read(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
  }): Promise<CloudflareProjectDomainDeletionState | null>;
  rotateGrantForDeletion(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly authorizationId: Ulid;
    readonly expectedUpdatedAt: string;
    readonly accessCiphertext: Uint8Array;
    readonly accessNonce: Uint8Array;
    readonly refreshCiphertext: Uint8Array;
    readonly refreshNonce: Uint8Array;
    readonly keyVersion: number;
    readonly accessExpiresAt: string;
    readonly rotatedAt: string;
  }): Promise<CloudflareProjectDnsGrant | null>;
  prepareRevocation(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly authorizationId: Ulid;
    readonly expectedGrantUpdatedAt: string;
    readonly refreshTokenSha256: Uint8Array;
    readonly preparedAt: string;
  }): Promise<"revoke" | "readback" | "blocked">;
  restartRevocationAfterReadback(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly authorizationId: Ulid;
    readonly expectedUpdatedAt: string;
    readonly expectedRefreshTokenSha256: Uint8Array;
    readonly refreshTokenSha256: Uint8Array;
    readonly accessCiphertext: Uint8Array;
    readonly accessNonce: Uint8Array;
    readonly refreshCiphertext: Uint8Array;
    readonly refreshNonce: Uint8Array;
    readonly keyVersion: number;
    readonly accessExpiresAt: string;
    readonly rotatedAt: string;
  }): Promise<CloudflareProjectDnsGrant | null>;
  finalizeDeletion(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly finalizedAt: string;
  }): Promise<boolean>;
  finalizePlatformDeletion(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly finalizedAt: string;
  }): Promise<boolean>;
}

export function createCloudflareProjectDeletion(input: {
  readonly clock: { now(): Date };
  readonly cipher: CloudflareTokenCipherWithOpen;
  readonly persistence: CloudflareProjectDeletionPersistence;
  readonly providers: {
    readonly oauth: {
      refreshAccessToken(refreshToken: string): Promise<{
        readonly accessToken: string;
        readonly refreshToken: string;
        readonly expiresInSeconds: number;
        readonly scopes: readonly ["dns.write", "zone.read"];
      }>;
      revokeRefreshToken(refreshToken: string): Promise<void>;
      observeRefreshToken(refreshToken: string): Promise<
        | { readonly state: "revoked" }
        | {
            readonly state: "active";
            readonly tokens: {
              readonly accessToken: string;
              readonly refreshToken: string;
              readonly expiresInSeconds: number;
              readonly scopes: readonly ["dns.write", "zone.read"];
            };
          }
      >;
    };
    readonly dns: {
      deleteRecords(
        accessToken: string,
        request: {
          readonly zoneId: string;
          readonly zoneName: string;
          readonly records: readonly CloudflareCustomerDnsRecord[];
        },
      ): Promise<{
        readonly status: "deleted" | "replayed";
        readonly recordIds: readonly string[];
      }>;
    };
    readonly platformDns: {
      deleteRecords(request: {
        readonly zoneId: string;
        readonly zoneName: string;
        readonly records: readonly CloudflareCustomerDnsRecord[];
      }): Promise<{
        readonly status: "deleted" | "replayed";
        readonly recordIds: readonly string[];
      }>;
    };
    readonly platformRoutes: {
      deleteRoute(receipt: CloudflareWorkerRouteReceipt & { readonly zoneId: string }): Promise<{
        readonly outcome: "deleted" | "absent";
        readonly routeId: string;
        readonly pattern: string;
        readonly observedAt: Date;
      }>;
    };
  };
}) {
  return Object.freeze({
    async deleteProject(raw: unknown) {
      const request = parseDeleteInput(raw);
      const state = await input.persistence.read(request);
      if (state === null) throw new CloudflareProjectDeletionUnavailableError();
      if (state.domains === null && state.grant === null && state.receipts.length === 0) {
        return result(request.operationId, [], "absent", "absent", input.clock.now());
      }
      if (
        state.receipts.some(
          (receipt) => receipt.kind === "custom_hostname" || receipt.kind === "ssl",
        )
      ) {
        throw new CloudflareProjectDeletionConflictError();
      }
      if (state.domains !== null && state.domains.zoneName !== "omh.st") {
        throw new CloudflareProjectDeletionConflictError();
      }
      if (state.domains === null && state.receipts.length > 0) {
        throw new CloudflareProjectDeletionConflictError();
      }
      if (state.grant !== null && state.grant.status !== "active") {
        if (
          state.grant.status === "revoked" &&
          state.revocation?.state === "confirmed" &&
          state.revocation.authorizationId === state.grant.authorizationId &&
          (state.domains === null || state.domains.deletedAt !== null)
        ) {
          return result(
            request.operationId,
            state.receipts.map((receipt) => ({
              receiptId: receipt.receiptId,
              kind: receipt.kind,
              providerResourceId: deletionProviderResourceId(receipt),
              outcome: "absent",
            })),
            "absent",
            "revoked",
            input.clock.now(),
          );
        }
        throw new CloudflareProjectDeletionConflictError();
      }
      if (
        state.revocation !== null &&
        (state.grant === null ||
          state.revocation.operationId !== request.operationId ||
          state.revocation.authorizationId !== state.grant.authorizationId)
      )
        throw new CloudflareProjectDeletionUnavailableError();
      const outcomes = new Map<string, "deleted" | "absent">();
      let activeGrant = state.grant;
      if (state.revocation === null) {
        // NS receipts are mail delegation records in the customer's own zone; only the project's
        // grant can remove them, and they must be gone before that grant is revoked.
        const delegation = state.receipts
          .filter(isDnsReceipt)
          .filter((receipt) => receipt.type === "NS");
        const grant = activeGrant;
        if (delegation.length > 0) {
          if (
            grant === null ||
            delegation.some(
              (receipt) => receipt.zoneId !== grant.zoneId || receipt.zoneName !== grant.zoneName,
            )
          )
            throw new CloudflareProjectDeletionConflictError();
          const active = await deletionAccessToken(input, request.operationId, grant);
          if (active === null) {
            // A revoked grant cannot remove its delegation records; the grant is revoked below all the same.
            for (const receipt of delegation) outcomes.set(receipt.receiptId, "absent");
          } else {
            activeGrant = active.grant;
            const deleted = await input.providers.dns.deleteRecords(active.accessToken, {
              zoneId: active.grant.zoneId,
              zoneName: active.grant.zoneName,
              records: latestByProviderId(delegation).map(toCustomerDnsReceipt),
            });
            for (const receipt of delegation)
              outcomes.set(receipt.receiptId, deleted.status === "deleted" ? "deleted" : "absent");
          }
        }
        const dnsReceipts = latestDnsReceipts(
          state.receipts.filter(isDnsReceipt).filter((receipt) => receipt.type !== "NS"),
        );
        if (dnsReceipts.length > 0) {
          if (state.domains === null) throw new CloudflareProjectDeletionConflictError();
          const zones = new Map<string, typeof dnsReceipts>();
          for (const receipt of dnsReceipts) {
            const key = `${receipt.zoneId}\0${receipt.zoneName}`;
            const group = zones.get(key) ?? [];
            group.push(receipt);
            zones.set(key, group);
          }
          for (const receipts of zones.values()) {
            const zone = exactPlatformZone(receipts);
            const deleted = await input.providers.platformDns.deleteRecords({
              ...zone,
              records: receipts.map(toCustomerDnsReceipt),
            });
            const outcome = deleted.status === "deleted" ? "deleted" : "absent";
            for (const receipt of state.receipts
              .filter(isDnsReceipt)
              .filter((receipt) => receipt.type !== "NS")) {
              if (receipt.zoneId === zone.zoneId && receipt.zoneName === zone.zoneName) {
                outcomes.set(receipt.receiptId, outcome);
              }
            }
          }
        }
        for (const route of latestByProviderId(state.receipts.filter(isRouteReceipt))) {
          const deleted = await input.providers.platformRoutes.deleteRoute({
            ...toRouteReceipt(route),
            zoneId: route.zoneId,
          });
          for (const receipt of state.receipts.filter(
            (candidate) =>
              candidate.kind === "worker_route" &&
              candidate.providerResourceId === route.providerResourceId,
          )) {
            outcomes.set(receipt.receiptId, deleted.outcome);
          }
        }
      }
      if (activeGrant === null) {
        const observedAt = input.clock.now();
        if (
          !(await input.persistence.finalizePlatformDeletion({
            ...request,
            finalizedAt: observedAt.toISOString(),
          }))
        ) {
          throw new CloudflareProjectDeletionUnavailableError();
        }
        return result(
          request.operationId,
          state.receipts.map((receipt) => ({
            receiptId: receipt.receiptId,
            kind: receipt.kind,
            providerResourceId: deletionProviderResourceId(receipt),
            outcome: outcomes.get(receipt.receiptId) ?? "absent",
          })),
          "deleted",
          "absent",
          observedAt,
        );
      }
      const grant = activeGrant;
      const refreshToken = await openRefreshToken(input.cipher, grant);
      if (
        state.revocation !== null &&
        !sameDigest(tokenDigest(refreshToken), state.revocation.refreshTokenSha256)
      ) {
        throw new CloudflareProjectDeletionConflictError();
      }
      if (state.revocation?.state === "readback_started") {
        await recoverRefreshRevocation(input, request, grant, refreshToken);
      } else {
        const phase = await input.persistence.prepareRevocation({
          ...request,
          authorizationId: grant.authorizationId,
          expectedGrantUpdatedAt: grant.updatedAt,
          refreshTokenSha256: tokenDigest(refreshToken),
          preparedAt: input.clock.now().toISOString(),
        });
        if (phase === "blocked") throw new CloudflareProjectDeletionUnavailableError();
        if (phase === "revoke") {
          try {
            await input.providers.oauth.revokeRefreshToken(refreshToken);
          } catch {
            const readbackPhase = await input.persistence.prepareRevocation({
              ...request,
              authorizationId: grant.authorizationId,
              expectedGrantUpdatedAt: grant.updatedAt,
              refreshTokenSha256: tokenDigest(refreshToken),
              preparedAt: input.clock.now().toISOString(),
            });
            if (readbackPhase !== "readback") {
              throw new CloudflareProjectDeletionUnavailableError();
            }
            await recoverRefreshRevocation(input, request, grant, refreshToken);
          }
        } else {
          await recoverRefreshRevocation(input, request, grant, refreshToken);
        }
      }
      const observedAt = input.clock.now();
      if (
        !(await input.persistence.finalizeDeletion({
          ...request,
          finalizedAt: observedAt.toISOString(),
        }))
      ) {
        throw new CloudflareProjectDeletionUnavailableError();
      }
      const receiptOutcomes = state.receipts.map((receipt) => ({
        receiptId: receipt.receiptId,
        kind: receipt.kind,
        providerResourceId: deletionProviderResourceId(receipt),
        outcome: outcomes.get(receipt.receiptId) ?? "absent",
      }));
      return result(request.operationId, receiptOutcomes, "deleted", "revoked", observedAt);
    },
  });
}

export class CloudflareProjectDeletionConflictError extends Error {
  public constructor() {
    super("Cloudflare project deletion conflicts with durable provider identity");
    this.name = "CloudflareProjectDeletionConflictError";
  }
}

export class CloudflareProjectDeletionUnavailableError extends Error {
  public constructor() {
    super("Cloudflare project deletion is unavailable");
    this.name = "CloudflareProjectDeletionUnavailableError";
  }
}

/**
 * The authorized project-deletion operation's access to its own DNS grant, for removing records it
 * published (mail DNS runs before the grant is revoked). An expired access token is renewed only
 * through the deletion-authorized rotation, and never once revocation owns the refresh token.
 */
export async function openDeletionDnsAccess(
  input: Parameters<typeof createCloudflareProjectDeletion>[0],
  raw: unknown,
): Promise<Readonly<{ accessToken: string; zoneId: string; zoneName: string }> | null> {
  const request = parseDeleteInput(raw);
  const state = await input.persistence.read(request);
  if (state === null) throw new CloudflareProjectDeletionUnavailableError();
  if (state.grant === null || state.grant.status !== "active")
    throw new CloudflareProjectDeletionConflictError();
  if (
    state.revocation !== null &&
    Date.parse(state.grant.accessExpiresAt) <=
      input.clock.now().getTime() + REFRESH_SKEW_MILLISECONDS
  )
    throw new CloudflareProjectDeletionConflictError();
  const active = await deletionAccessToken(input, request.operationId, state.grant);
  if (active === null) return null;
  return Object.freeze({
    accessToken: active.accessToken,
    zoneId: active.grant.zoneId,
    zoneName: active.grant.zoneName,
  });
}

/**
 * The deletion's own grant access for one hostname's records: absent when the project holds no
 * active grant whose zone covers the hostname, since ohmyho.st then wrote no record for it.
 */
export async function openDeletionHostnameDnsAccess(
  input: Parameters<typeof createCloudflareProjectDeletion>[0],
  raw: unknown,
  hostname: string,
): Promise<
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "ready"; accessToken: string; zoneId: string; zoneName: string }>
> {
  const request = parseDeleteInput(raw);
  const state = await input.persistence.read(request);
  if (state === null) throw new CloudflareProjectDeletionUnavailableError();
  const grant = state.grant;
  if (
    grant?.status !== "active" ||
    (hostname !== grant.zoneName && !hostname.endsWith(`.${grant.zoneName}`))
  )
    return Object.freeze({ status: "absent" as const });
  const access = await openDeletionDnsAccess(input, request);
  if (access === null) return Object.freeze({ status: "absent" as const });
  return Object.freeze({ status: "ready" as const, ...access });
}

/** Null when Cloudflare revoked the grant's refresh token: its zone can then no longer be written by ohmyho.st. */
async function deletionAccessToken(
  input: Parameters<typeof createCloudflareProjectDeletion>[0],
  operationId: Ulid,
  grant: Extract<CloudflareProjectDnsGrant, { readonly status: "active" }>,
): Promise<{
  readonly accessToken: string;
  readonly grant: Extract<CloudflareProjectDnsGrant, { readonly status: "active" }>;
} | null> {
  const associatedData = grantAssociatedData(grant);
  const now = input.clock.now();
  if (Date.parse(grant.accessExpiresAt) > now.getTime() + REFRESH_SKEW_MILLISECONDS) {
    const accessToken = await input.cipher.open({
      ciphertext: encodeBase64(grant.accessCiphertext),
      nonce: encodeBase64(grant.accessNonce),
      keyVersion: grant.keyVersion,
      associatedData: `${associatedData}:access`,
    });
    return Object.freeze({ accessToken, grant });
  }
  const refreshToken = await input.cipher.open({
    ciphertext: encodeBase64(grant.refreshCiphertext),
    nonce: encodeBase64(grant.refreshNonce),
    keyVersion: grant.keyVersion,
    associatedData: `${associatedData}:refresh`,
  });
  let refreshed;
  try {
    refreshed = await input.providers.oauth.refreshAccessToken(refreshToken);
  } catch (error) {
    // Only a refresh that Cloudflare refused (invalid_grant) can mean a revoked grant; every other failure keeps its
    // error. An active observation is itself a refresh: the pair it returns already rotated the stored refresh token,
    // so it is stored below exactly like a successful refresh instead of being dropped.
    if (!(error instanceof CloudflareCustomerDnsRejectedError)) throw error;
    const observed = await input.providers.oauth.observeRefreshToken(refreshToken);
    if (observed.state === "revoked") return null;
    refreshed = observed.tokens;
  }
  const [access, refresh] = await Promise.all([
    input.cipher.seal(refreshed.accessToken, `${associatedData}:access`),
    input.cipher.seal(refreshed.refreshToken, `${associatedData}:refresh`),
  ]);
  const rotated = await input.persistence.rotateGrantForDeletion({
    organizationId: grant.organizationId,
    projectId: grant.projectId,
    operationId,
    authorizationId: grant.authorizationId,
    expectedUpdatedAt: grant.updatedAt,
    accessCiphertext: decodeBase64(access.ciphertext),
    accessNonce: decodeBase64(access.nonce),
    refreshCiphertext: decodeBase64(refresh.ciphertext),
    refreshNonce: decodeBase64(refresh.nonce),
    keyVersion: access.keyVersion,
    accessExpiresAt: new Date(now.getTime() + refreshed.expiresInSeconds * 1_000).toISOString(),
    rotatedAt: now.toISOString(),
  });
  if (rotated === null || rotated.status !== "active") {
    throw new CloudflareProjectDeletionUnavailableError();
  }
  return Object.freeze({ accessToken: refreshed.accessToken, grant: rotated });
}

async function recoverRefreshRevocation(
  input: Parameters<typeof createCloudflareProjectDeletion>[0],
  request: ReturnType<typeof parseDeleteInput>,
  grant: Extract<CloudflareProjectDnsGrant, { readonly status: "active" }>,
  refreshToken: string,
): Promise<void> {
  let observation: Awaited<ReturnType<typeof input.providers.oauth.observeRefreshToken>>;
  try {
    observation = await input.providers.oauth.observeRefreshToken(refreshToken);
  } catch {
    throw new CloudflareProjectDeletionUnavailableError();
  }
  if (observation.state === "revoked") return;
  const associatedData = grantAssociatedData(grant);
  const rotatedAt = input.clock.now();
  const [access, refresh] = await Promise.all([
    input.cipher.seal(observation.tokens.accessToken, `${associatedData}:access`),
    input.cipher.seal(observation.tokens.refreshToken, `${associatedData}:refresh`),
  ]);
  if (access.keyVersion !== refresh.keyVersion) {
    throw new CloudflareProjectDeletionConflictError();
  }
  const rotated = await input.persistence.restartRevocationAfterReadback({
    ...request,
    authorizationId: grant.authorizationId,
    expectedUpdatedAt: grant.updatedAt,
    expectedRefreshTokenSha256: tokenDigest(refreshToken),
    refreshTokenSha256: tokenDigest(observation.tokens.refreshToken),
    accessCiphertext: decodeBase64(access.ciphertext),
    accessNonce: decodeBase64(access.nonce),
    refreshCiphertext: decodeBase64(refresh.ciphertext),
    refreshNonce: decodeBase64(refresh.nonce),
    keyVersion: access.keyVersion,
    accessExpiresAt: new Date(
      rotatedAt.getTime() + observation.tokens.expiresInSeconds * 1_000,
    ).toISOString(),
    rotatedAt: rotatedAt.toISOString(),
  });
  if (rotated === null || rotated.status !== "active") {
    throw new CloudflareProjectDeletionUnavailableError();
  }
  try {
    await input.providers.oauth.revokeRefreshToken(observation.tokens.refreshToken);
  } catch {
    throw new CloudflareProjectDeletionUnavailableError();
  }
}

function openRefreshToken(
  cipher: CloudflareTokenCipherWithOpen,
  grant: Extract<CloudflareProjectDnsGrant, { readonly status: "active" }>,
): Promise<string> {
  return cipher.open({
    ciphertext: encodeBase64(grant.refreshCiphertext),
    nonce: encodeBase64(grant.refreshNonce),
    keyVersion: grant.keyVersion,
    associatedData: `${grantAssociatedData(grant)}:refresh`,
  });
}

function tokenDigest(value: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function toCustomerDnsReceipt(
  receipt: Extract<CloudflareProjectDomainReceipt, { kind: "dns_record" }>,
): CloudflareCustomerDnsRecord {
  return Object.freeze({
    id: receipt.providerResourceId,
    type: receipt.type,
    name: receipt.name,
    content: receipt.content,
    ttl: receipt.ttl,
    comment: receipt.comment,
    proxied: receipt.proxied,
  });
}

function toRouteReceipt(
  receipt: Extract<CloudflareProjectDomainReceipt, { kind: "worker_route" }>,
): CloudflareWorkerRouteReceipt {
  return Object.freeze({
    routeId: receipt.providerResourceId,
    hostname: receipt.pattern.slice(0, -2),
    scriptName: receipt.script,
    pattern: receipt.pattern,
    observedAt: new Date(receipt.observedAt),
  });
}

function latestByProviderId<
  T extends Extract<CloudflareProjectDomainReceipt, { kind: "dns_record" | "worker_route" }>,
>(values: readonly T[]): T[] {
  const grouped = new Map<string, T>();
  for (const value of values) {
    const current = grouped.get(value.providerResourceId);
    if (current === undefined || current.observedAt < value.observedAt)
      grouped.set(value.providerResourceId, value);
  }
  return [...grouped.values()].sort((a, b) =>
    a.providerResourceId.localeCompare(b.providerResourceId),
  );
}

function latestDnsReceipts(
  values: readonly Extract<CloudflareProjectDomainReceipt, { kind: "dns_record" }>[],
) {
  const grouped = new Map<string, (typeof values)[number]>();
  for (const value of values) {
    const identity =
      value.type === "CNAME"
        ? `${value.type}\0${value.name}`
        : `${value.type}\0${value.name}\0${value.content}\0${value.ttl}\0${value.proxied}\0${value.comment}`;
    const scopedIdentity = `${value.zoneId}\0${value.zoneName}\0${identity}`;
    const current = grouped.get(scopedIdentity);
    if (
      current === undefined ||
      current.observedAt < value.observedAt ||
      (current.observedAt === value.observedAt && current.receiptId < value.receiptId)
    ) {
      grouped.set(scopedIdentity, value);
    }
  }
  return [...grouped.values()].sort((left, right) => left.receiptId.localeCompare(right.receiptId));
}

function exactPlatformZone(
  receipts: readonly Extract<CloudflareProjectDomainReceipt, { kind: "dns_record" }>[],
): { readonly zoneId: string; readonly zoneName: string } {
  const first = receipts[0];
  if (
    first === undefined ||
    !/^[a-f0-9]{32}$/u.test(first.zoneId) ||
    receipts.some(
      (receipt) => receipt.zoneId !== first.zoneId || receipt.zoneName !== first.zoneName,
    )
  ) {
    throw new CloudflareProjectDeletionConflictError();
  }
  return { zoneId: first.zoneId, zoneName: first.zoneName };
}

function isDnsReceipt(
  value: CloudflareProjectDomainReceipt,
): value is Extract<CloudflareProjectDomainReceipt, { kind: "dns_record" }> {
  return value.kind === "dns_record";
}
function isRouteReceipt(
  value: CloudflareProjectDomainReceipt,
): value is Extract<CloudflareProjectDomainReceipt, { kind: "worker_route" }> {
  return value.kind === "worker_route";
}

function deletionProviderResourceId(receipt: CloudflareProjectDomainReceipt): string {
  if (receipt.providerResourceId !== null) return receipt.providerResourceId;
  if (receipt.kind === "ssl") return receipt.customHostnameId;
  throw new CloudflareProjectDeletionConflictError();
}

function result(
  operationId: Ulid,
  receipts: readonly Readonly<Record<string, unknown>>[],
  outcome: "deleted" | "absent",
  oauthGrant: "revoked" | "absent",
  observedAt: Date,
) {
  return Object.freeze({
    outcome,
    operationId,
    receipts: Object.freeze(receipts.map((receipt) => Object.freeze({ ...receipt }))),
    oauthGrant,
    observedAt: observedAt.toISOString(),
  });
}

function parseDeleteInput(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "operationId,organizationId,projectId") {
    throw new TypeError("Cloudflare project deletion input is invalid");
  }
  return Object.freeze({
    organizationId: parseUlid(String(record["organizationId"])),
    projectId: parseUlid(String(record["projectId"])),
    operationId: parseUlid(String(record["operationId"])),
  });
}

function grantAssociatedData(input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly authorizationId: string;
}): string {
  return `ohmyhost.cloudflare-project-grant/v1:${input.organizationId}:${input.projectId}:${input.authorizationId}`;
}
function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}
