import type {
  WorkosCapabilityObservation,
  WorkosManagementRpcRequest,
  WorkosOrganizationSnapshot,
  WorkosSessionStatusRequest,
} from "@ohmyhost/workos-auth-contracts";

declare const workosManagementCredentialBrand: unique symbol;

/** Opaque workload-identity capability. It deliberately cannot expose credential material. */
export interface WorkosManagementCredential {
  readonly [workosManagementCredentialBrand]: true;
}

export interface WorkloadIdentitySecretResolver {
  withWorkosManagementCredential<Result>(
    use: (credential: WorkosManagementCredential) => Promise<Result>,
  ): Promise<Result>;
}

export interface WorkosManagementTransport {
  fetchCurrentOrganizationSnapshot(
    credential: WorkosManagementCredential,
    workosOrganizationId: string,
  ): Promise<unknown>;
  checkCandidateFga(
    credential: WorkosManagementCredential,
    input: Extract<WorkosManagementRpcRequest, { method: "fga.check_candidate" }>["payload"],
  ): Promise<"allow" | "deny">;
  probeReadOnlyCapabilities(
    credential: WorkosManagementCredential,
  ): Promise<readonly WorkosCapabilityObservation[]>;
}

export interface WorkosSessionTransport {
  isSessionActive(
    credential: WorkosManagementCredential,
    input: WorkosSessionStatusRequest,
  ): Promise<boolean>;
}

export interface InternalRpcAuthenticator {
  authenticate(input: {
    readonly authentication: unknown;
    readonly requestId: string;
  }): Promise<boolean>;
}

export interface CandidateClock {
  now(): Date;
}

export interface CandidateIdFactory {
  next(): string;
}

export interface WorkosInboxTrigger {
  readonly inboxEventId: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly claimId: string;
  readonly attemptNumber: number;
}

export interface WorkosSnapshotApplication {
  /** Proposed for first observation; the database resolves the stable ID under its transaction lock. */
  readonly organizationId: string;
  readonly triggerEventId: string;
  readonly snapshot: WorkosOrganizationSnapshot;
  readonly canonicalSnapshot: string;
}

export interface WorkosOrganizationDeletion {
  /** Proposed for a delete-before-create observation; the database resolves the stable ID. */
  readonly organizationId: string;
  readonly workosOrganizationId: string;
  readonly triggerEventId: string;
  /** Stable PII-free authority tombstone; provider event identity remains outside this digest input. */
  readonly canonicalTombstone: string;
}

export interface WorkosManagementDatabase {
  isSessionEligible(input: {
    readonly sessionId: string;
    readonly workosUserId: string;
    readonly workosOrganizationId: string | null;
    readonly observedAt: string;
  }): Promise<boolean>;
  claim(input: {
    readonly claimId: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<WorkosInboxTrigger | null>;
  findExpiredFinalClaim(input: { readonly observedAt: string }): Promise<WorkosInboxTrigger | null>;
  applySnapshotAndAcknowledge(input: {
    readonly claim: WorkosInboxTrigger;
    readonly application: WorkosSnapshotApplication;
    readonly synchronizedAt: string;
  }): Promise<{ readonly organizationId: string } | null>;
  applyDeletionAndAcknowledge(input: {
    readonly claim: WorkosInboxTrigger;
    readonly deletion: WorkosOrganizationDeletion;
    readonly deletedAt: string;
  }): Promise<{ readonly organizationId: string } | null>;
  revokeLocalAuthorizationForUncertainSnapshot(input: {
    readonly workosOrganizationId: string;
    readonly revokedAt: string;
  }): Promise<void>;
  recordFailure(input: {
    readonly claim: WorkosInboxTrigger;
    readonly failedAt: string;
    readonly errorCode: string;
    readonly nextAvailableAt: string;
  }): Promise<"retry_scheduled" | "reconciliation_required" | "stale_claim">;
  recoverExpiredFinalClaim(input: {
    readonly claim: WorkosInboxTrigger;
    readonly recoveredAt: string;
    readonly errorCode: string;
  }): Promise<boolean>;
}

/**
 * `unavailable` is a retryable WorkOS outage (a 5xx, 408 or 429 answer, a timeout or a network failure); `permanent`
 * is every other refusal or unusable answer, including a missing private credential and an oversized or malformed body.
 */
export class WorkosTransportFailure extends Error {
  public constructor(public readonly code: "not_found" | "unavailable" | "permanent") {
    super("WorkOS management transport failed");
    this.name = "WorkosTransportFailure";
  }
}
