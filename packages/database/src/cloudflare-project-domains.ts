import { type Ulid } from "@ohmyhost/platform";

type PlatformZoneName = "omh.st";

export interface CloudflareProjectScope {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

interface CloudflareProjectDnsGrantCommon extends CloudflareProjectScope {
  readonly authorizationId: Ulid;
  readonly principalId: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly accountId: string;
  readonly scopes: readonly ["dns.write", "zone.read"];
  /** The hostnames declared when the zone was consented; the grant reaches no other name of the zone. */
  readonly declaredHostnames: readonly string[];
  readonly keyVersion: number;
  readonly accessExpiresAt: string;
  readonly connectedAt: string;
  readonly updatedAt: string;
}

export interface RotateCloudflareProjectDnsGrantInput extends CloudflareProjectScope {
  readonly authorizationId: Ulid;
  readonly expectedUpdatedAt: string;
  readonly accessCiphertext: Uint8Array;
  readonly accessNonce: Uint8Array;
  readonly refreshCiphertext: Uint8Array;
  readonly refreshNonce: Uint8Array;
  readonly keyVersion: number;
  readonly accessExpiresAt: string;
  readonly rotatedAt: string;
}

export type CloudflareProjectDnsGrant =
  | Readonly<
      CloudflareProjectDnsGrantCommon & {
        readonly status: "active";
        readonly accessCiphertext: Uint8Array;
        readonly accessNonce: Uint8Array;
        readonly refreshCiphertext: Uint8Array;
        readonly refreshNonce: Uint8Array;
        readonly revokedAt: null;
      }
    >
  | Readonly<
      CloudflareProjectDnsGrantCommon & {
        readonly status: "revoked";
        readonly accessCiphertext: null;
        readonly accessNonce: null;
        readonly refreshCiphertext: null;
        readonly refreshNonce: null;
        readonly revokedAt: string;
      }
    >;

export interface CloudflareProjectOAuthRevocation extends CloudflareProjectScope {
  readonly operationId: Ulid;
  readonly authorizationId: Ulid;
  readonly refreshTokenSha256: Uint8Array;
  readonly state: "revoke_started" | "readback_started" | "confirmed";
  readonly providerStartedAt: string;
  readonly readbackStartedAt: string | null;
  readonly confirmedAt: string | null;
}

export interface CloudflareProjectDomains extends CloudflareProjectScope {
  readonly operationId: Ulid;
  readonly handle: string;
  readonly zoneName: PlatformZoneName;
  readonly productionDomain: string;
  readonly developmentDomain: string;
  readonly mailDomain: string | null;
  readonly configuredByPrincipalId: string;
  readonly configuredAt: string;
  readonly deletedAt: string | null;
}

interface CloudflareProjectDomainReceiptBase<ProviderResourceId extends string | null = string>
  extends CloudflareProjectScope {
  readonly receiptId: Ulid;
  readonly providerResourceId: ProviderResourceId;
  readonly observedAt: string;
}

export interface CloudflareDnsRecordReceipt extends CloudflareProjectDomainReceiptBase {
  readonly kind: "dns_record";
  readonly zoneId: string;
  readonly zoneName: string;
  readonly type: "CNAME" | "NS" | "TXT";
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly comment: string;
}

export type CloudflareCustomHostnameStatus =
  | "active"
  | "pending"
  | "active_redeploying"
  | "moved"
  | "pending_deletion"
  | "deleted"
  | "pending_blocked"
  | "pending_migration"
  | "pending_provisioned"
  | "test_pending"
  | "test_active"
  | "test_active_apex"
  | "test_blocked"
  | "test_failed"
  | "provisioned"
  | "blocked";

export interface CloudflareCustomHostnameReceipt extends CloudflareProjectDomainReceiptBase {
  readonly kind: "custom_hostname";
  readonly environmentName: "dev" | "prod";
  readonly hostname: string;
  readonly status: CloudflareCustomHostnameStatus;
  readonly providerCreatedAt: string | null;
  readonly ownershipVerification: Readonly<{
    type: "txt";
    name: string;
    value: string;
  }> | null;
  readonly ownershipVerificationHttp: Readonly<{
    httpUrl: string;
    httpBody: string;
  }> | null;
  readonly verificationErrors: readonly string[];
}

export interface CloudflareSslValidationRecord {
  readonly status?: string;
  readonly cname?: string;
  readonly cnameTarget?: string;
  readonly httpBody?: string;
  readonly httpUrl?: string;
  readonly txtName?: string;
  readonly txtValue?: string;
  readonly wildcard?: boolean;
}

export type CloudflareSslStatus =
  | "initializing"
  | "pending_validation"
  | "deleted"
  | "pending_issuance"
  | "pending_deployment"
  | "pending_deletion"
  | "pending_expiration"
  | "expired"
  | "active"
  | "initializing_timed_out"
  | "validation_timed_out"
  | "issuance_timed_out"
  | "deployment_timed_out"
  | "deletion_timed_out"
  | "pending_cleanup"
  | "staging_deployment"
  | "staging_active"
  | "deactivating"
  | "inactive"
  | "backup_issued"
  | "holding_deployment";

export interface CloudflareSslReceipt extends CloudflareProjectDomainReceiptBase<string | null> {
  readonly kind: "ssl";
  readonly environmentName: "dev" | "prod";
  readonly customHostnameId: string;
  readonly hostname: string;
  readonly status: CloudflareSslStatus | null;
  readonly type: "dv" | null;
  readonly method: "http" | "txt" | "email" | null;
  readonly bundleMethod: "ubiquitous" | "optimal" | "force" | null;
  readonly certificateAuthority: string | null;
  readonly validationRecords: readonly CloudflareSslValidationRecord[];
}

export interface CloudflareWorkerRouteReceipt extends CloudflareProjectDomainReceiptBase {
  readonly kind: "worker_route";
  readonly environmentName: "dev" | "prod";
  readonly zoneId: string;
  readonly pattern: string;
  readonly script: string;
}

export type CloudflareProjectDomainReceipt =
  | CloudflareDnsRecordReceipt
  | CloudflareCustomHostnameReceipt
  | CloudflareSslReceipt
  | CloudflareWorkerRouteReceipt;

export interface CloudflareProjectDomainDeletionState extends CloudflareProjectScope {
  readonly operationId: Ulid;
  readonly grant: CloudflareProjectDnsGrant | null;
  readonly domains: CloudflareProjectDomains | null;
  readonly receipts: readonly CloudflareProjectDomainReceipt[];
  readonly customHostnameDeleteTargets: readonly CloudflareCustomHostnameDeleteTarget[];
  readonly revocation: CloudflareProjectOAuthRevocation | null;
}

export interface CloudflareCustomHostnameDeleteTarget {
  readonly environmentName: "dev" | "prod";
  readonly customHostnameId: string;
  readonly hostname: string;
  readonly observedAt: string;
}

export class CloudflareProjectDomainConflictError extends Error {
  public readonly code = "cloudflare_project_domain_conflict" as const;

  public constructor() {
    super("Cloudflare project-domain state conflicts with durable state");
    this.name = "CloudflareProjectDomainConflictError";
  }
}

export class CloudflareAuthorizationClosedError extends CloudflareProjectDomainConflictError {
  public constructor() {
    super();
    this.name = "CloudflareAuthorizationClosedError";
  }
}
