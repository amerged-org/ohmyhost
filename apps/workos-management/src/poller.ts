import { parseUlid } from "@ohmyhost/platform";
import {
  canonicalizeWorkosOrganizationSnapshot,
  parseWorkosOrganizationSnapshot,
  WorkosContractError,
} from "@ohmyhost/workos-auth-contracts";

import type {
  CandidateClock,
  CandidateIdFactory,
  WorkloadIdentitySecretResolver,
  WorkosInboxTrigger,
  WorkosManagementDatabase,
  WorkosManagementTransport,
  WorkosOrganizationDeletion,
} from "./ports.js";
import { WorkosTransportFailure } from "./ports.js";

export type WorkosPollResult =
  | { readonly outcome: "idle" }
  | { readonly outcome: "acknowledged"; readonly eventId: string; readonly changedScope: string }
  | {
      readonly outcome: "retry_scheduled" | "reconciliation_required" | "stale_claim";
      readonly eventId: string;
      readonly errorCode: string;
    };

export interface WorkosSnapshotPoller {
  pollOne(): Promise<WorkosPollResult>;
  recoverOneExpiredFinalClaim(): Promise<WorkosPollResult | null>;
  recoverExpiredFinalClaim(claim: WorkosInboxTrigger): Promise<WorkosPollResult>;
}

export interface WorkosOrganizationTrigger {
  readonly schemaVersion: "workos.organization-trigger.v1";
  readonly workosOrganizationId: string;
}

const SUPPORTED_INBOX_EVENT_TYPES = new Set([
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organization_membership.created",
  "organization_membership.updated",
  "organization_membership.deleted",
]);

const assertSupportedInboxEventType = (eventType: string): void => {
  if (!SUPPORTED_INBOX_EVENT_TYPES.has(eventType)) {
    throw new TypeError("Unsupported WorkOS inbox event type");
  }
};

export const buildOrganizationDeletion = (input: {
  readonly organizationId: string;
  readonly workosOrganizationId: string;
  readonly triggerEventId: string;
}): WorkosOrganizationDeletion => ({
  ...input,
  canonicalTombstone: JSON.stringify({
    schemaVersion: "workos.organization-deletion.v1",
    workosOrganizationId: input.workosOrganizationId,
  }),
});

export const parseWorkosOrganizationTrigger = (
  payload: Readonly<Record<string, unknown>>,
): WorkosOrganizationTrigger => {
  const schemaVersion = payload["schemaVersion"];
  const workosOrganizationId = payload["workosOrganizationId"];
  if (
    Object.keys(payload).some((key) => key !== "schemaVersion" && key !== "workosOrganizationId") ||
    schemaVersion !== "workos.organization-trigger.v1" ||
    typeof workosOrganizationId !== "string" ||
    workosOrganizationId.trim() === ""
  ) {
    throw new TypeError("Invalid WorkOS inbox trigger");
  }
  return { schemaVersion, workosOrganizationId };
};

const failureCode = (error: unknown): string => {
  if (error instanceof WorkosTransportFailure) {
    if (error.code === "not_found") return "WORKOS_ORGANIZATION_NOT_FOUND";
    return error.code === "unavailable" ? "WORKOS_UNAVAILABLE" : "WORKOS_TRANSPORT_PERMANENT";
  }
  if (error instanceof WorkosContractError) {
    return error.code === "unsupported_multiple_roles"
      ? "WORKOS_UNSUPPORTED_MULTIPLE_ROLES"
      : "WORKOS_INVALID_SNAPSHOT";
  }
  if (error instanceof TypeError || error instanceof RangeError) return "WORKOS_INVALID_TRIGGER";
  return "WORKOS_SYNC_FAILED";
};

const retryDelay = (attemptNumber: number, baseRetryMs: number, maxRetryMs: number): number =>
  Math.min(maxRetryMs, baseRetryMs * 2 ** Math.max(0, attemptNumber - 1));

export function createWorkosSnapshotPoller(input: {
  readonly clock: CandidateClock;
  readonly ids: CandidateIdFactory;
  readonly organizationIds: CandidateIdFactory;
  readonly database: WorkosManagementDatabase;
  readonly resolver: WorkloadIdentitySecretResolver;
  readonly transport: WorkosManagementTransport;
  readonly leaseMs: number;
  readonly baseRetryMs: number;
  readonly maxRetryMs: number;
}): WorkosSnapshotPoller {
  if (
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1 ||
    !Number.isSafeInteger(input.baseRetryMs) ||
    input.baseRetryMs < 1 ||
    !Number.isSafeInteger(input.maxRetryMs) ||
    input.maxRetryMs < input.baseRetryMs
  ) {
    throw new RangeError("WorkOS poller timing configuration is invalid");
  }

  const scheduleFailure = async (
    claim: WorkosInboxTrigger,
    error: unknown,
  ): Promise<WorkosPollResult> => {
    const failedAt = input.clock.now();
    const errorCode = failureCode(error);
    const outcome = await input.database.recordFailure({
      claim,
      failedAt: failedAt.toISOString(),
      errorCode,
      nextAvailableAt: new Date(
        failedAt.getTime() + retryDelay(claim.attemptNumber, input.baseRetryMs, input.maxRetryMs),
      ).toISOString(),
    });
    return {
      outcome,
      eventId: claim.externalEventId,
      errorCode,
    };
  };

  const applyDeletion = async (
    claim: WorkosInboxTrigger,
    trigger: WorkosOrganizationTrigger,
    organizationId: string,
  ): Promise<WorkosPollResult> => {
    const deletedAt = input.clock.now().toISOString();
    const applied = await input.database.applyDeletionAndAcknowledge({
      claim,
      deletion: buildOrganizationDeletion({
        organizationId,
        workosOrganizationId: trigger.workosOrganizationId,
        triggerEventId: claim.externalEventId,
      }),
      deletedAt,
    });
    if (applied === null) {
      return {
        outcome: "stale_claim",
        eventId: claim.externalEventId,
        errorCode: "WORKOS_STALE_CLAIM",
      };
    }
    return {
      outcome: "acknowledged",
      eventId: claim.externalEventId,
      changedScope: applied.organizationId,
    };
  };

  const recoverExpiredFinalClaim = async (claim: WorkosInboxTrigger): Promise<WorkosPollResult> => {
    const recoveredAt = input.clock.now().toISOString();
    const errorCode = "WORKOS_LEASE_EXPIRED";
    const recovered = await input.database.recoverExpiredFinalClaim({
      claim,
      recoveredAt,
      errorCode,
    });
    return recovered
      ? { outcome: "reconciliation_required", eventId: claim.externalEventId, errorCode }
      : { outcome: "stale_claim", eventId: claim.externalEventId, errorCode };
  };

  return {
    async pollOne() {
      const claimedAt = input.clock.now();
      const claim = await input.database.claim({
        claimId: input.ids.next(),
        claimedAt: claimedAt.toISOString(),
        leaseExpiresAt: new Date(claimedAt.getTime() + input.leaseMs).toISOString(),
      });
      if (claim === null) return { outcome: "idle" };
      try {
        assertSupportedInboxEventType(claim.eventType);
        const trigger = parseWorkosOrganizationTrigger(claim.payload);
        const organizationId = parseUlid(input.organizationIds.next());
        if (claim.eventType === "organization.deleted") {
          return await applyDeletion(claim, trigger, organizationId);
        }
        const fetchedAt = input.clock.now();
        const rawSnapshot = await input.resolver.withWorkosManagementCredential((credential) =>
          input.transport.fetchCurrentOrganizationSnapshot(
            credential,
            trigger.workosOrganizationId,
          ),
        );
        const snapshot = parseWorkosOrganizationSnapshot(rawSnapshot, fetchedAt);
        if (snapshot.organization.id !== trigger.workosOrganizationId) {
          throw new WorkosContractError(
            "organization_mismatch",
            "Provider snapshot does not match its trigger",
          );
        }
        const synchronizedAt = input.clock.now().toISOString();
        const applied = await input.database.applySnapshotAndAcknowledge({
          claim,
          application: {
            organizationId,
            triggerEventId: claim.externalEventId,
            snapshot,
            canonicalSnapshot: canonicalizeWorkosOrganizationSnapshot(snapshot),
          },
          synchronizedAt,
        });
        if (applied === null) {
          return {
            outcome: "stale_claim",
            eventId: claim.externalEventId,
            errorCode: "WORKOS_STALE_CLAIM",
          };
        }
        return {
          outcome: "acknowledged",
          eventId: claim.externalEventId,
          changedScope: applied.organizationId,
        };
      } catch (error) {
        if (error instanceof WorkosContractError) {
          try {
            await input.database.revokeLocalAuthorizationForUncertainSnapshot({
              workosOrganizationId:
                typeof claim.payload["workosOrganizationId"] === "string"
                  ? claim.payload["workosOrganizationId"]
                  : "",
              revokedAt: input.clock.now().toISOString(),
            });
          } catch (revocationError) {
            return scheduleFailure(claim, revocationError);
          }
        }
        return scheduleFailure(claim, error);
      }
    },
    async recoverOneExpiredFinalClaim() {
      const claim = await input.database.findExpiredFinalClaim({
        observedAt: input.clock.now().toISOString(),
      });
      return claim === null ? null : recoverExpiredFinalClaim(claim);
    },
    recoverExpiredFinalClaim,
  };
}
