import type { Authorization, Grant, Resource, Scope } from "./scoped-dns-authorization.js";
import type { CloudflareCustomerDnsRecord } from "@ohmyhost/provider-cloudflare";

export interface ScopedDnsStatus {
  readonly status: "not_authorized" | "pending" | "authorized" | "expired" | "revoked";
  readonly zone: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
}
export interface ScopedDnsRevocationStatus extends ScopedDnsStatus {
  readonly status: "revoked" | "not_authorized";
}
export interface ScopedDnsCleanup {
  records: CloudflareCustomerDnsRecord[];
  zoneId?: string;
  zoneName?: string;
  cleanup: { status: "deleted"; recordIds: string[] } | null;
  /** Stored Source JSON is opaque to the transport and is never reserialized during a read. */
  receipt: string;
}
export interface ScopedDnsUse {
  leaseToken: string;
  resource: Resource;
  grant: Grant;
}
export interface ScopedDnsSealedTokens {
  accessCiphertext: Uint8Array;
  accessNonce: Uint8Array;
  refreshCiphertext: Uint8Array;
  refreshNonce: Uint8Array;
  keyVersion: number;
  accessExpiresAt: string;
}
type ScopedDnsRevocation = Pick<
  Authorization,
  | "organizationId"
  | "purpose"
  | "resourceId"
  | "resourceRevision"
  | "principalId"
  | "delegation"
  | "idempotencyKeySha256"
  | "requestSha256"
>;
type ScopedDnsUseResult =
  | { kind: "revoked"; revokedAt: string }
  | {
      kind: "applied";
      tokens: ScopedDnsSealedTokens | null;
      records?: readonly CloudflareCustomerDnsRecord[];
      authorizationReceipt?: {
        zoneId: string;
        zoneName: string;
        records: readonly CloudflareCustomerDnsRecord[];
      };
      cleanup?: { recordIds: readonly string[]; observedAt: string; expectedReceipt: string };
    };

/** Closed persistence effects; provider/cipher callbacks and tokens in plaintext stay in CF. */
/** A refresh token pair a re-authorization displaced: still live at Cloudflare until the sweep revokes it. */
export interface DisplacedGrantToken {
  readonly displacedId: string;
  readonly organizationId: string;
  readonly purpose: Grant["purpose"];
  readonly resourceId: string;
  readonly resourceRevision: number;
  readonly authorizationId: string;
  readonly keyVersion: number;
  readonly refreshCiphertext: Buffer;
  readonly refreshNonce: Buffer;
}
export interface ScopedDnsPersistence {
  /** Displaced refresh tokens, in random order; the sweep is their only reader. */
  listDisplacedTokens(limit: number): Promise<DisplacedGrantToken[]>;
  /** Forgets one displaced pair after its refresh token was revoked; false when the row no longer holds that token. */
  completeDisplacedToken(
    input: Pick<
      DisplacedGrantToken,
      "organizationId" | "purpose" | "resourceId" | "displacedId" | "refreshCiphertext"
    >,
  ): Promise<boolean>;
  issue(input: Authorization): Promise<Authorization>;
  status(input: Scope, now: () => string): Promise<ScopedDnsStatus>;
  revoke(input: ScopedDnsRevocation, now: () => string): Promise<ScopedDnsRevocationStatus>;
  /** Revoked grants that still store a sealed refresh token, oldest first; the sweep is their only reader. */
  listRevokedGrants(limit: number): Promise<Grant[]>;
  /** Wipes both sealed tokens of a revoked grant only while the stored refresh token is the one passed; false when it changed. */
  wipeRevokedGrantTokens(
    input: Pick<
      Grant,
      "organizationId" | "purpose" | "resourceId" | "authorizationId" | "refreshCiphertext"
    >,
  ): Promise<boolean>;
  /** Consumes the ticket only for the user who started it; any other principal leaves it open and gets null. */
  consume(
    authorizationId: string,
    stateSha256: Uint8Array,
    principalId: string,
    now: () => string,
  ): Promise<Authorization | null>;
  saveGrant(input: Omit<Grant, "revokedAt" | "dnsReceipts">): Promise<void>;
  claimUse(
    scope: Scope,
    leaseToken: string,
    cleanup: boolean,
    now: () => string,
  ): Promise<ScopedDnsUse | null>;
  renewUse(input: ScopedDnsUse): Promise<void>;
  authorizeUse(input: ScopedDnsUse): Promise<boolean>;
  finishUse(input: ScopedDnsUse, result: ScopedDnsUseResult): Promise<void>;
  releaseUse(input: ScopedDnsUse): Promise<void>;
  readCleanup(scope: Scope): Promise<ScopedDnsCleanup>;
  completeEmptyCleanup(
    scope: Scope,
    expectedReceipt: string,
    now: () => string,
  ): Promise<{ status: "deleted"; recordIds: string[] }>;
}
