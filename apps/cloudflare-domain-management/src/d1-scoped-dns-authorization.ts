import { parseUlid } from "@ohmyhost/platform";
import type {
  CloudflareCustomerDnsProvider,
  CloudflareCustomerDnsRecord,
  CloudflareDesiredDnsRecord,
} from "@ohmyhost/provider-cloudflare";
import type { CloudflareCustomerOAuthProvider, CloudflareOAuthStateSigner } from "./runtime.js";
import type { CloudflareTokenCipherWithOpen } from "./secrets.js";
import { createD1ScopedDnsPersistence } from "./d1-scoped-dns-persistence.js";
import type { ScopedDnsPersistence, ScopedDnsSealedTokens } from "./scoped-dns-persistence.js";
import {
  ScopedDnsConflictError,
  parseRequest,
  parseScopedDnsDelegation,
  signedState,
  aad,
  openRefreshToken,
  openToken,
  sha,
  equal,
  bytes,
  decode,
  exact,
  type Purpose,
  type Scope,
  type Resource,
  type Authorization,
  type Grant,
} from "./scoped-dns-authorization.js";

type Provider = Pick<
  CloudflareCustomerDnsProvider,
  "reconcileRecords" | "deleteRecords" | "observeRefreshToken"
>;
interface WorkResult<T> {
  value: T;
  records?: readonly CloudflareCustomerDnsRecord[];
  authorizationReceipt?: {
    zoneId: string;
    zoneName: string;
    records: readonly CloudflareCustomerDnsRecord[];
  };
  cleanup?: { recordIds: readonly string[]; observedAt: string; expectedReceipt: string };
}
/** The scoped OAuth/DNS flow over one closed persistence capability; providers, ciphers and plaintext tokens stay in this Worker. */
export async function createD1ScopedDnsAuthorizationRuntime(input: {
  readonly binding?: unknown;
  readonly parseDelegation?: typeof parseScopedDnsDelegation;
  readonly persistence?: ScopedDnsPersistence;
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
  readonly stateSigner: CloudflareOAuthStateSigner;
  readonly tokenCipher: CloudflareTokenCipherWithOpen;
  readonly oauth: CloudflareCustomerOAuthProvider;
  readonly providerForUse: (beforeRequest: () => Promise<void>) => Provider;
}) {
  const persistence =
      input.persistence ??
      (await createD1ScopedDnsPersistence(input.binding, input.parseDelegation)),
    now = () => input.clock.now().toISOString();
  async function begin(raw: unknown, purpose: Purpose) {
    const request = parseRequest(raw, purpose, true, true, input.parseDelegation),
      authorizationId = input.ids.next(),
      issuedAt = now(),
      proposed: Authorization = {
        organizationId: request.organizationId,
        purpose,
        resourceId: request.resourceId,
        authorizationId,
        principalId: request.actorId,
        resourceRevision: request.expectedRevision,
        zoneName: request.zoneName,
        idempotencyKeySha256: bytes(request.idempotencyKeySha256),
        requestSha256: bytes(request.requestSha256),
        stateSha256: Buffer.alloc(32),
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + 600000).toISOString(),
        delegation: request.delegation,
      };
    const state = await signedState(proposed, input.stateSigner);
    proposed.stateSha256 = sha(state);
    const claimed = await persistence.issue(proposed),
      claimedState = await signedState(claimed, input.stateSigner);
    if (!equal(claimed.stateSha256, sha(claimedState)))
      throw new ScopedDnsConflictError("authorization_closed");
    return Object.freeze({
      authorizationId: claimed.authorizationId,
      authorizationUrl: input.oauth.authorizationUrl({ state: claimedState }),
      expiresAt: claimed.expiresAt,
    });
  }
  async function status(raw: unknown, purpose: Purpose) {
    const request = parseRequest(raw, purpose, false, true, input.parseDelegation);
    return persistence.status(
      { organizationId: request.organizationId, purpose, resourceId: request.resourceId },
      now,
    );
  }
  async function revoke(raw: unknown, purpose: Purpose) {
    const request = parseRequest(raw, purpose, true, false, input.parseDelegation);
    return persistence.revoke(
      {
        organizationId: request.organizationId,
        purpose,
        resourceId: request.resourceId,
        resourceRevision: request.expectedRevision,
        principalId: request.actorId,
        delegation: request.delegation,
        idempotencyKeySha256: bytes(request.idempotencyKeySha256),
        requestSha256: bytes(request.requestSha256),
      },
      now,
    );
  }
  /** Revokes the stored refresh token of each revoked grant at Cloudflare, then wipes its ciphertext. Any failure, a Cloudflare rejection included, keeps the token for the next sweep: a token that may still be live is never forgotten. */
  async function sweep() {
    const grants = await persistence.listRevokedGrants(20);
    let wiped = 0,
      failed = 0;
    for (const grant of grants) {
      try {
        await input.oauth.revokeRefreshToken(await openToken(input.tokenCipher, grant, "refresh"));
        if (await persistence.wipeRevokedGrantTokens(grant)) wiped++;
        else failed++;
      } catch {
        failed++;
      }
    }
    // A re-authorization displaced these pairs: each refresh token is revoked upstream, and its row is forgotten only
    // after Cloudflare accepted the revoke. A failure keeps the row for the next sweep.
    const displacedTokens = await persistence.listDisplacedTokens(20);
    let displacedRevoked = 0,
      displacedFailed = 0;
    for (const token of displacedTokens) {
      try {
        await input.oauth.revokeRefreshToken(await openRefreshToken(input.tokenCipher, token));
        if (await persistence.completeDisplacedToken(token)) displacedRevoked++;
        else displacedFailed++;
      } catch {
        displacedFailed++;
      }
    }
    return Object.freeze({
      attempted: grants.length,
      wiped,
      failed,
      displaced: Object.freeze({
        attempted: displacedTokens.length,
        revoked: displacedRevoked,
        failed: displacedFailed,
      }),
    });
  }

  async function use<T>(
    scope: Scope,
    work: (
      resource: Resource,
      grant: Grant,
      token: string,
      provider: Provider,
    ) => Promise<WorkResult<T>>,
    cleanup = false,
  ): Promise<T | null> {
    const claimed = await persistence.claimUse(scope, globalThis.crypto.randomUUID(), cleanup, now);
    if (claimed === null) return null;
    let closed = false;
    try {
      const grant = claimed.grant,
        provider = input.providerForUse(() => persistence.renewUse(claimed));
      let token = await openToken(input.tokenCipher, grant, "access"),
        tokens: ScopedDnsSealedTokens | null = null;
      if (Date.parse(grant.accessExpiresAt) <= input.clock.now().getTime() + 60000) {
        const observed = await provider.observeRefreshToken(
          await openToken(input.tokenCipher, grant, "refresh"),
        );
        if (observed.state === "revoked") {
          await persistence.finishUse(claimed, { kind: "revoked", revokedAt: now() });
          closed = true;
          return null;
        }
        token = observed.tokens.accessToken;
        const [access, refresh] = await Promise.all([
          input.tokenCipher.seal(token, `${aad(grant)}:access`),
          input.tokenCipher.seal(observed.tokens.refreshToken, `${aad(grant)}:refresh`),
        ]);
        if (access.keyVersion !== refresh.keyVersion)
          throw new Error("Scoped DNS refresh encryption is unavailable");
        tokens = {
          accessCiphertext: decode(access.ciphertext),
          accessNonce: decode(access.nonce),
          refreshCiphertext: decode(refresh.ciphertext),
          refreshNonce: decode(refresh.nonce),
          keyVersion: access.keyVersion,
          accessExpiresAt: new Date(
            input.clock.now().getTime() + observed.tokens.expiresInSeconds * 1000,
          ).toISOString(),
        };
      }
      // A successful refresh is stored even when its post-refresh authority recheck refuses DNS.
      if (!(await persistence.authorizeUse(claimed))) {
        await persistence.finishUse(claimed, { kind: "applied", tokens });
        closed = true;
        return null;
      }
      let result: WorkResult<T>;
      try {
        result = await work(claimed.resource, grant, token, provider);
      } catch (error) {
        // The refresh above already rotated the pair, and the old refresh token may now be invalid: store the
        // rotated pair before the failure propagates, without any DNS record or receipt of the failed work. A refused
        // store never replaces the work's own error; the lease then expires on its own.
        if (tokens !== null) {
          try {
            await persistence.finishUse(claimed, { kind: "applied", tokens });
            closed = true;
          } catch {
            /* The work's error is the one reported, so the caller decides on the failure it actually had. */
          }
        }
        throw error;
      }
      const { value, ...metadata } = result;
      await persistence.finishUse(claimed, { kind: "applied", tokens, ...metadata });
      closed = true;
      return value;
    } finally {
      if (!closed) {
        try {
          await persistence.releaseUse(claimed);
        } catch {
          /* Preserve the original failed effect; an unreleased technical lease expires and grants no retry permission. */
        }
      }
    }
  }
  return Object.freeze({
    beginApplicationIdentityAuthorization: (raw: unknown) => begin(raw, "application_identity"),
    getApplicationIdentityAuthorizationStatus: (raw: unknown) =>
      status(raw, "application_identity"),
    beginWorkspaceMailAuthorization: (raw: unknown) => begin(raw, "workspace_mail"),
    getWorkspaceMailAuthorizationStatus: (raw: unknown) => status(raw, "workspace_mail"),
    revokeApplicationIdentityAuthorization: (raw: unknown) => revoke(raw, "application_identity"),
    revokeWorkspaceMailAuthorization: (raw: unknown) => revoke(raw, "workspace_mail"),
    /** The scheduled mail reconciliation calls this with an empty object; any field is refused. */
    sweepRevokedGrants: (raw: unknown) => {
      exact(raw, []);
      return sweep();
    },
    async completeScopedAuthorization(raw: unknown) {
      const request = exact(raw, ["code", "principalId", "state"]),
        state = String(request["state"]),
        code = String(request["code"]),
        principalId = String(request["principalId"]);
      if (
        !/^[0-7][0-9A-HJKMNP-TV-Z]{25}\.[A-Za-z0-9_-]{43}$/u.test(state) ||
        !/^[A-Za-z0-9._~-]{8,2048}$/u.test(code) ||
        principalId.length < 1 ||
        principalId.length > 256
      )
        throw new TypeError("Scoped DNS callback is invalid");
      const at = now(),
        consumed = await persistence.consume(state.slice(0, 26), sha(state), principalId, () => at);
      if (consumed === null) return Object.freeze({ status: "invalid" as const });
      let tokens;
      try {
        tokens = await input.oauth.exchangeAuthorizationCode(code);
      } catch {
        return Object.freeze({ status: "token_exchange_failed" as const });
      }
      // A token pair that no grant stores is revoked at Cloudflare; a failed revoke keeps the callback's status.
      const abandon = async (
        status: "zone_observe_failed" | "token_encrypt_failed" | "grant_persist_failed",
      ) => {
        try {
          await input.oauth.revokeRefreshToken(tokens.refreshToken);
        } catch {
          /* The status below is the callback's answer; the revoke is best-effort. */
        }
        return Object.freeze({ status });
      };
      let zone;
      try {
        zone = await input.oauth.observeZone(tokens.accessToken, consumed.zoneName);
      } catch {
        return abandon("zone_observe_failed");
      }
      if (zone.state !== "found" || zone.zoneName !== consumed.zoneName)
        return abandon("zone_observe_failed");
      let access, refresh;
      try {
        [access, refresh] = await Promise.all([
          input.tokenCipher.seal(tokens.accessToken, `${aad(consumed)}:access`),
          input.tokenCipher.seal(tokens.refreshToken, `${aad(consumed)}:refresh`),
        ]);
      } catch {
        return abandon("token_encrypt_failed");
      }
      if (access.keyVersion !== refresh.keyVersion) return abandon("token_encrypt_failed");
      const connectedAt = now();
      try {
        await persistence.saveGrant({
          ...consumed,
          zoneId: zone.zoneId,
          accountId: zone.accountId,
          accessCiphertext: decode(access.ciphertext),
          accessNonce: decode(access.nonce),
          refreshCiphertext: decode(refresh.ciphertext),
          refreshNonce: decode(refresh.nonce),
          keyVersion: access.keyVersion,
          accessExpiresAt: new Date(
            Date.parse(connectedAt) + tokens.expiresInSeconds * 1000,
          ).toISOString(),
          connectedAt,
        });
      } catch {
        return abandon("grant_persist_failed");
      }
      return Object.freeze({ status: "authorized" as const });
    },
    async ensureApplicationIdentityChallenge(request: {
      organizationId: string;
      projectId: string;
      expectedRevision: number;
    }) {
      await use(
        {
          organizationId: request.organizationId,
          purpose: "application_identity",
          resourceId: request.projectId,
        },
        async (resource, grant, token, provider) => {
          if (
            resource.revision !== request.expectedRevision ||
            resource.challengeName === null ||
            resource.challengeValue === null
          )
            throw new ScopedDnsConflictError("application_identity_stale");
          const obsolete = grant.dnsReceipts.filter(
            (record) =>
              record.type === "TXT" &&
              record.name === resource.challengeName &&
              record.content !== resource.challengeValue &&
              record.comment === `ohmyhost:${resource.resourceId}:app-identity:v1`,
          );
          if (obsolete.length > 0) {
            const deleted = await provider.deleteRecords(token, {
              zoneId: grant.zoneId,
              zoneName: grant.zoneName,
              records: obsolete,
            });
            if (
              [...deleted.recordIds].sort().join(",") !==
              obsolete
                .map((record) => record.id)
                .sort()
                .join(",")
            )
              throw new Error("Prior application identity DNS cleanup is incomplete");
          }
          const records = await provider.reconcileRecords(token, {
            zoneId: grant.zoneId,
            zoneName: grant.zoneName,
            records: [
              {
                type: "TXT",
                name: resource.challengeName,
                content: resource.challengeValue,
                ttl: 300,
                proxied: false,
                comment: `ohmyhost:${resource.resourceId}:app-identity:v1`,
              },
            ],
          });
          if (records.records.length !== 1)
            throw new Error("Application identity DNS receipt is incomplete");
          return {
            value: undefined,
            records: records.records,
            authorizationReceipt: {
              zoneId: grant.zoneId,
              zoneName: grant.zoneName,
              records: records.records,
            },
          };
        },
      );
    },
    reconcileWorkspaceMailRecords(request: {
      organizationId: string;
      mailDomainId: string;
      records: readonly CloudflareDesiredDnsRecord[];
    }) {
      return use(
        {
          organizationId: request.organizationId,
          purpose: "workspace_mail",
          resourceId: request.mailDomainId,
        },
        async (resource, grant, token, provider) => {
          if (
            request.records.some(
              (record) =>
                record.name !== resource.hostname && !record.name.endsWith(`.${resource.hostname}`),
            )
          )
            throw new TypeError("Workspace mail DNS records are outside the resource");
          const result = await provider.reconcileRecords(token, {
            zoneId: grant.zoneId,
            zoneName: grant.zoneName,
            records: request.records,
          });
          if (result.records.length !== request.records.length)
            throw new Error("Workspace mail DNS receipt is incomplete");
          return {
            value: { zoneId: grant.zoneId, zoneName: grant.zoneName, records: result.records },
            records: result.records,
          };
        },
      );
    },
    async retireWorkspaceMailRecords(raw: unknown) {
      const request = exact(raw, ["organizationId", "mailDomainId"]),
        scope: Scope = {
          organizationId: parseUlid(String(request["organizationId"])),
          purpose: "workspace_mail",
          resourceId: parseUlid(String(request["mailDomainId"])),
        },
        observed = await persistence.readCleanup(scope);
      if (observed.cleanup !== null) return observed.cleanup;
      if (observed.records.length === 0)
        return persistence.completeEmptyCleanup(scope, observed.receipt, now);
      const cleaned = await use(
        scope,
        async (_resource, grant, token, provider) => {
          const current = await persistence.readCleanup(scope);
          if (current.cleanup !== null) return { value: current.cleanup };
          if (grant.zoneId !== current.zoneId || grant.zoneName !== current.zoneName)
            throw new ScopedDnsConflictError("mail_dns_authorization_required");
          const receipt = await provider.deleteRecords(token, {
            zoneId: grant.zoneId,
            zoneName: grant.zoneName,
            records: current.records,
          });
          if (
            [...receipt.recordIds].sort().join(",") !==
            current.records
              .map((record) => record.id)
              .sort()
              .join(",")
          )
            throw new Error("Workspace mail DNS cleanup readback is incomplete");
          return {
            value: { status: "deleted" as const, recordIds: [...receipt.recordIds] },
            cleanup: {
              recordIds: receipt.recordIds,
              observedAt: now(),
              expectedReceipt: current.receipt,
            },
          };
        },
        true,
      );
      if (cleaned === null) throw new ScopedDnsConflictError("mail_dns_authorization_required");
      return cleaned;
    },
  });
}

export type ScopedDnsAuthorizationRuntime = Awaited<
  ReturnType<typeof createD1ScopedDnsAuthorizationRuntime>
>;
