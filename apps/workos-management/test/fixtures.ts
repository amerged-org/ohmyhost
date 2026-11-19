import type {
  CandidateClock,
  CandidateIdFactory,
  InternalRpcAuthenticator,
  WorkloadIdentitySecretResolver,
  WorkosInboxTrigger,
  WorkosManagementCredential,
  WorkosManagementDatabase,
  WorkosManagementTransport,
  WorkosSessionTransport,
  WorkosOrganizationDeletion,
  WorkosSnapshotApplication,
} from "../src/index.js";
import type { WorkosCapabilityObservation } from "@ohmyhost/workos-auth-contracts";

export const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const CLAIM_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

export const rawSnapshot = {
  organization: {
    id: "org_workos",
    name: "Example",
    created_at: "2026-08-18T09:00:00.000Z",
    updated_at: "2026-08-18T10:00:00.000Z",
  },
  memberships: [
    {
      id: "membership_1",
      organization_id: "org_workos",
      user_id: "user_1",
      status: "active",
      roles: [{ slug: "admin" }],
      created_at: "2026-08-18T09:00:00.000Z",
      updated_at: "2026-08-18T10:00:00.000Z",
    },
  ],
};

export const claim: WorkosInboxTrigger = {
  inboxEventId: INBOX_ID,
  externalEventId: "event_1",
  eventType: "organization.updated",
  payload: {
    schemaVersion: "workos.organization-trigger.v1",
    workosOrganizationId: "org_workos",
  },
  claimId: CLAIM_ID,
  attemptNumber: 1,
};

export class SequenceClock implements CandidateClock {
  public constructor(private readonly dates: readonly Date[]) {}

  private index = 0;

  public now(): Date {
    const value = this.dates[this.index] ?? this.dates.at(-1);
    if (value === undefined) throw new Error("Clock fixture is empty");
    this.index += 1;
    return value;
  }
}

export class FixedIds implements CandidateIdFactory {
  public next(): string {
    return CLAIM_ID;
  }
}

export class FixedOrganizationIds implements CandidateIdFactory {
  public next(): string {
    return ORGANIZATION_ID;
  }
}

export class FixtureResolver implements WorkloadIdentitySecretResolver {
  public uses = 0;

  public async withWorkosManagementCredential<Result>(
    use: (credential: WorkosManagementCredential) => Promise<Result>,
  ): Promise<Result> {
    this.uses += 1;
    return use(Object.freeze({}) as WorkosManagementCredential);
  }
}

export class FixtureTransport implements WorkosManagementTransport, WorkosSessionTransport {
  public snapshot: unknown = rawSnapshot;
  public snapshotError: unknown;
  public fgaDecision: "allow" | "deny" = "deny";
  public snapshotRequests: string[] = [];
  public fgaRequests: unknown[] = [];
  public capabilityObservations: readonly WorkosCapabilityObservation[] = [];
  public sessionActive = false;
  public sessionError: unknown;
  public sessionRequests: unknown[] = [];

  public async isSessionActive(
    _credential: WorkosManagementCredential,
    input: Parameters<WorkosSessionTransport["isSessionActive"]>[1],
  ): Promise<boolean> {
    this.sessionRequests.push(input);
    if (this.sessionError !== undefined) throw this.sessionError;
    return this.sessionActive;
  }

  public async fetchCurrentOrganizationSnapshot(
    _credential: WorkosManagementCredential,
    workosOrganizationId: string,
  ): Promise<unknown> {
    this.snapshotRequests.push(workosOrganizationId);
    if (this.snapshotError !== undefined) throw this.snapshotError;
    return this.snapshot;
  }

  public async checkCandidateFga(
    _credential: WorkosManagementCredential,
    input: Parameters<WorkosManagementTransport["checkCandidateFga"]>[1],
  ): Promise<"allow" | "deny"> {
    this.fgaRequests.push(input);
    return this.fgaDecision;
  }

  public async probeReadOnlyCapabilities(): Promise<readonly WorkosCapabilityObservation[]> {
    return this.capabilityObservations;
  }
}

export class FixtureAuthenticator implements InternalRpcAuthenticator {
  public allowed = true;
  public requests: unknown[] = [];

  public async authenticate(input: {
    readonly authentication: unknown;
    readonly requestId: string;
  }): Promise<boolean> {
    this.requests.push(input);
    return this.allowed;
  }
}

export class FixtureDatabase implements WorkosManagementDatabase {
  public sessionEligible = true;
  public sessionEligibilityError: unknown;
  public sessionEligibilityChecks: unknown[] = [];
  public nextClaim: WorkosInboxTrigger | null = claim;
  public appliedOrganizationId: string | null = ORGANIZATION_ID;
  public failureOutcome: "retry_scheduled" | "reconciliation_required" | "stale_claim" =
    "retry_scheduled";
  public recovered = true;
  public expiredFinalClaim: WorkosInboxTrigger | null = null;
  public claims: unknown[] = [];
  public applications: WorkosSnapshotApplication[] = [];
  public deletions: WorkosOrganizationDeletion[] = [];
  public failures: unknown[] = [];
  public recoveries: unknown[] = [];
  public recoveryScans: unknown[] = [];
  public uncertainSnapshotRevocations: unknown[] = [];

  public async isSessionEligible(input: {
    readonly sessionId: string;
    readonly workosUserId: string;
    readonly workosOrganizationId: string;
    readonly observedAt: string;
  }): Promise<boolean> {
    this.sessionEligibilityChecks.push(input);
    if (this.sessionEligibilityError !== undefined) throw this.sessionEligibilityError;
    return this.sessionEligible;
  }

  public async claim(input: {
    readonly claimId: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<WorkosInboxTrigger | null> {
    this.claims.push(input);
    return this.nextClaim;
  }

  public async findExpiredFinalClaim(input: {
    readonly observedAt: string;
  }): Promise<WorkosInboxTrigger | null> {
    this.recoveryScans.push(input);
    return this.expiredFinalClaim;
  }

  public async applySnapshotAndAcknowledge(input: {
    readonly claim: WorkosInboxTrigger;
    readonly application: WorkosSnapshotApplication;
    readonly synchronizedAt: string;
  }): Promise<{ readonly organizationId: string } | null> {
    this.applications.push(input.application);
    return this.appliedOrganizationId === null
      ? null
      : { organizationId: this.appliedOrganizationId };
  }

  public async applyDeletionAndAcknowledge(input: {
    readonly claim: WorkosInboxTrigger;
    readonly deletion: WorkosOrganizationDeletion;
    readonly deletedAt: string;
  }): Promise<{ readonly organizationId: string } | null> {
    this.deletions.push(input.deletion);
    return this.appliedOrganizationId === null
      ? null
      : { organizationId: this.appliedOrganizationId };
  }

  public async revokeLocalAuthorizationForUncertainSnapshot(input: {
    readonly workosOrganizationId: string;
    readonly revokedAt: string;
  }): Promise<void> {
    this.uncertainSnapshotRevocations.push(input);
  }

  public async recordFailure(input: {
    readonly claim: WorkosInboxTrigger;
    readonly failedAt: string;
    readonly errorCode: string;
    readonly nextAvailableAt: string;
  }): Promise<"retry_scheduled" | "reconciliation_required" | "stale_claim"> {
    this.failures.push(input);
    return this.failureOutcome;
  }

  public async recoverExpiredFinalClaim(input: {
    readonly claim: WorkosInboxTrigger;
    readonly recoveredAt: string;
    readonly errorCode: string;
  }): Promise<boolean> {
    this.recoveries.push(input);
    return this.recovered;
  }
}
