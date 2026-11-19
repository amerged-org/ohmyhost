import {
  WorkosContractError,
  type WorkosOrganizationSnapshot,
} from "@ohmyhost/workos-auth-contracts";

import { requireControlRuntimeBinding } from "./d1-identity-port.js";
import type {
  CandidateIdFactory,
  WorkosInboxTrigger,
  WorkosManagementDatabase,
  WorkosSnapshotApplication,
} from "./ports.js";

/**
 * The closed set of `ControlRuntime` methods the WorkOS snapshot poller calls. Each is one typed command: the
 * snapshot with its exact inbox acknowledgement and the deletion with its acknowledgement are ONE batch each, and
 * none accepts SQL, a provider, a permission list or an event type.
 */
export interface ControlRuntimePollerBinding {
  claimWorkosInboxEvent(input: unknown): Promise<ClaimedEvent | null>;
  findExpiredFinalWorkosInboxClaim(input: unknown): Promise<ClaimedEvent | null>;
  recordWorkosInboxFailure(
    input: unknown,
  ): Promise<"retry_scheduled" | "reconciliation_required" | "stale_claim">;
  recoverExpiredFinalWorkosInboxLease(input: unknown): Promise<boolean>;
  applyPolledWorkosSnapshot(input: unknown): Promise<{ readonly organizationId: string }>;
  applyWorkosOrganizationDeletion(input: unknown): Promise<{ readonly organizationId: string }>;
  revokeLocalAuthorizationForUncertainSnapshot(input: unknown): Promise<unknown>;
}

export const CONTROL_RUNTIME_POLLER_METHODS = [
  "claimWorkosInboxEvent",
  "findExpiredFinalWorkosInboxClaim",
  "recordWorkosInboxFailure",
  "recoverExpiredFinalWorkosInboxLease",
  "applyPolledWorkosSnapshot",
  "applyWorkosOrganizationDeletion",
  "revokeLocalAuthorizationForUncertainSnapshot",
] as const satisfies readonly (keyof ControlRuntimePollerBinding)[];

interface ClaimedEvent {
  readonly organizationId: string | null;
  readonly inboxEventId: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly claimId: string;
  readonly attemptNumber: number;
}

/** The original global trigger plus optional routing metadata; provider subject resolves authority on apply. */
export interface D1WorkosInboxTrigger extends WorkosInboxTrigger {
  readonly organizationId: string | null;
}

type PollerDatabase = Pick<
  WorkosManagementDatabase,
  | "claim"
  | "findExpiredFinalClaim"
  | "applySnapshotAndAcknowledge"
  | "applyDeletionAndAcknowledge"
  | "revokeLocalAuthorizationForUncertainSnapshot"
  | "recordFailure"
  | "recoverExpiredFinalClaim"
>;

const STALE_DELETION = "WorkOS inbox claim is stale during organization deletion";

const sha256Hex = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** The original `membershipRole`: exactly one role per member, decided before anything is written. */
const membershipRole = (membership: WorkosOrganizationSnapshot["memberships"][number]): string => {
  const uniqueRoles = [...new Set(membership.roles)].sort();
  const role = uniqueRoles[0];
  if (role === undefined) {
    throw new WorkosContractError(
      "invalid_membership_role",
      "Membership must have exactly one role",
    );
  }
  if (uniqueRoles.length > 1) {
    throw new WorkosContractError(
      "unsupported_multiple_roles",
      "Membership has unsupported multiple roles",
    );
  }
  return role;
};

const membershipState = (
  status: WorkosOrganizationSnapshot["memberships"][number]["status"],
): "active" | "suspended" => (status === "active" ? "active" : "suspended");

const trigger = (event: ClaimedEvent): D1WorkosInboxTrigger => ({
  organizationId: event.organizationId,
  inboxEventId: event.inboxEventId,
  externalEventId: event.externalEventId,
  eventType: event.eventType,
  payload: event.payload,
  claimId: event.claimId,
  attemptNumber: event.attemptNumber,
});

/** Require the store claim shape, including explicit NULL routing metadata for global historical events. */
const scopeOf = (claim: WorkosInboxTrigger): D1WorkosInboxTrigger => {
  const organizationId = (claim as Partial<D1WorkosInboxTrigger>).organizationId;
  if (organizationId !== null && typeof organizationId !== "string") {
    throw new TypeError("WorkOS inbox claim carries invalid routing metadata");
  }
  return claim as D1WorkosInboxTrigger;
};

/**
 * The poller half of the D1 management database. Every call is `() => binding.method(input)` over the real
 * service binding. The organization id the poller proposes is never used: the store resolved the stable id when it
 * claimed the event (the mapped organization, or the id derived from the WorkOS organization).
 */
export function createD1WorkosPollerPort(input: {
  readonly runtime: unknown;
  readonly auditIds: CandidateIdFactory;
}): PollerDatabase {
  const binding = requireControlRuntimeBinding(
    input.runtime,
  ) as unknown as ControlRuntimePollerBinding;
  return {
    claim: async (claim) => {
      const event = await binding.claimWorkosInboxEvent(claim);
      return event === null ? null : trigger(event);
    },
    findExpiredFinalClaim: async (find) => {
      const event = await binding.findExpiredFinalWorkosInboxClaim(find);
      return event === null ? null : trigger(event);
    },
    applySnapshotAndAcknowledge: async ({ claim, application, synchronizedAt }) => {
      const scope = scopeOf(claim);
      const memberships = await memberRows(application);
      const applied = await binding.applyPolledWorkosSnapshot({
        workosOrganizationId: application.snapshot.organization.id,
        snapshotDigest: await sha256Hex(application.canonicalSnapshot),
        snapshotFetchedAt: application.snapshot.fetchedAt,
        synchronizedAt,
        triggerEventId: application.triggerEventId,
        memberships,
        auditEventId: input.auditIds.next(),
        claim: { inboxEventId: scope.inboxEventId, claimId: scope.claimId },
      });
      return { organizationId: applied.organizationId };
    },
    applyDeletionAndAcknowledge: async ({ claim, deletion, deletedAt }) => {
      const scope = scopeOf(claim);
      try {
        const applied = await binding.applyWorkosOrganizationDeletion({
          workosOrganizationId: deletion.workosOrganizationId,
          tombstoneDigest: await sha256Hex(deletion.canonicalTombstone),
          triggerEventId: deletion.triggerEventId,
          deletedAt,
          auditEventId: input.auditIds.next(),
          claim: { inboxEventId: scope.inboxEventId, claimId: scope.claimId },
        });
        return { organizationId: applied.organizationId };
      } catch (error) {
        if (error instanceof Error && error.message === STALE_DELETION) return null;
        throw error;
      }
    },
    revokeLocalAuthorizationForUncertainSnapshot: async (revocation) => {
      if (revocation.workosOrganizationId.trim() === "") return;
      await binding.revokeLocalAuthorizationForUncertainSnapshot(revocation);
    },
    recordFailure: ({ claim, failedAt, errorCode, nextAvailableAt }) => {
      const scope = scopeOf(claim);
      return binding.recordWorkosInboxFailure({
        organizationId: scope.organizationId,
        inboxEventId: scope.inboxEventId,
        claimId: scope.claimId,
        failedAt,
        errorCode,
        nextAvailableAt,
      });
    },
    recoverExpiredFinalClaim: ({ claim, recoveredAt, errorCode }) => {
      const scope = scopeOf(claim);
      return binding.recoverExpiredFinalWorkosInboxLease({
        organizationId: scope.organizationId,
        inboxEventId: scope.inboxEventId,
        claimId: scope.claimId,
        recoveredAt,
        errorCode,
      });
    },
  };
}

async function memberRows(application: WorkosSnapshotApplication) {
  // The role is decided for every member before the command is sent, so a refusal writes nothing.
  const decided = application.snapshot.memberships.map((membership) => ({
    membership,
    role: membershipRole(membership),
  }));
  return Promise.all(
    decided.map(async ({ membership, role }) => ({
      workosUserId: membership.userId,
      role,
      status: membershipState(membership.status),
      digest: await sha256Hex(JSON.stringify(membership)),
    })),
  );
}
