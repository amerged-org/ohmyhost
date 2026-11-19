import { describe, expect, it } from "vitest";

import { DeterministicEntropy, FixedClock, createUlidFactory } from "../../shared/index.js";
import type { OwnedProject } from "./ownership-transfer.js";
import {
  cancelProjectTransfer,
  completeProjectTransfer,
  createOwnedProject,
  freezeProjectForTransfer,
  getHistoricalProjectRecordVisibility,
  getProjectVisibility,
  securityFreezeProject,
} from "./ownership-transfer.js";

function fixture(seed = 80) {
  const clock = new FixedClock("2026-08-18T10:00:00.000Z");
  const eventIds = createUlidFactory({ clock, entropy: new DeterministicEntropy(seed) });
  const organizationId = eventIds.next();
  const project = createOwnedProject({
    projectId: eventIds.next(),
    organizationId,
    billingEpochId: eventIds.next(),
    createdByPrincipalId: "user:user_01",
    clock,
    eventIds,
  });
  return { clock, eventIds, organizationId, project };
}

function begin(project: OwnedProject, seed = 90, time = "2026-08-18T11:00:00.000Z") {
  const clock = new FixedClock(time);
  const eventIds = createUlidFactory({ clock, entropy: new DeterministicEntropy(seed) });
  const transferId = eventIds.next();
  const targetOrganizationId = eventIds.next();
  const pending = freezeProjectForTransfer({
    project,
    transferId,
    targetOrganizationId,
    initiatorPrincipalId: "user:user_02",
    expectedOwnershipVersion: project.ownershipVersion,
    clock,
    eventIds,
  });
  return { clock, eventIds, transferId, targetOrganizationId, pending };
}

describe("project ownership state machine", () => {
  it("creates deeply immutable ownership state and its attributed billing epoch", () => {
    const { project } = fixture();

    expect(project).toMatchObject({
      ownershipState: "active",
      ownershipVersion: 1,
      activeTransferId: null,
      transferIntents: [],
      ownershipEpochs: [{ createdByPrincipalId: "user:user_01" }],
    });
    expect(Object.isFrozen(project)).toBe(true);
    expect(Object.isFrozen(project.ownershipEpochs)).toBe(true);
    expect(Object.isFrozen(project.ownershipEpochs[0])).toBe(true);
    expect(Object.isFrozen(project.transferIntents)).toBe(true);
    expect(Object.isFrozen(project.ownershipEvents[0])).toBe(true);
  });

  it("persists the exact transfer identity, parties, initiator, and locked version", () => {
    const { project, organizationId } = fixture(81);
    const { pending, transferId, targetOrganizationId } = begin(project, 91);

    expect(pending).toMatchObject({
      ownershipState: "transfer_pending_frozen",
      ownershipVersion: 2,
      activeTransferId: transferId,
      transferIntents: [
        {
          transferId,
          sourceOrganizationId: organizationId,
          targetOrganizationId,
          initiatorPrincipalId: "user:user_02",
          expectedOwnershipVersion: 2,
          state: "pending_frozen",
          resolvedAt: null,
          failureCode: null,
        },
      ],
    });
    expect(Object.isFrozen(pending.transferIntents[0])).toBe(true);
  });

  it("completes only the exact intent and attributes the new epoch to its initiator", () => {
    const { project } = fixture(82);
    const { pending, transferId, targetOrganizationId, clock, eventIds } = begin(project, 92);
    const nextBillingEpochId = eventIds.next();
    const transferred = completeProjectTransfer({
      project: pending,
      transferId,
      expectedOwnershipVersion: 2,
      targetOrganizationId,
      nextBillingEpochId,
      clock,
      eventIds,
    });

    expect(transferred).toMatchObject({
      organizationId: targetOrganizationId,
      billingEpochId: nextBillingEpochId,
      ownershipState: "active",
      ownershipVersion: 3,
      activeTransferId: null,
      transferIntents: [{ state: "completed", resolvedAt: "2026-08-18T11:00:00.000Z" }],
    });
    expect(transferred.ownershipEpochs[0]?.effectiveUntil).toBe("2026-08-18T11:00:00.000Z");
    expect(transferred.ownershipEpochs[1]).toMatchObject({
      organizationId: targetOrganizationId,
      createdByPrincipalId: "user:user_02",
      effectiveUntil: null,
    });
  });

  it.each([
    ["wrong transfer", { transferId: "wrong" }, "PROJECT_TRANSFER_ID_MISMATCH"],
    ["stale ownership", { expectedOwnershipVersion: 1 }, "PROJECT_TRANSFER_STALE_VERSION"],
    ["wrong target", { targetOrganizationId: "wrong" }, "PROJECT_TRANSFER_TARGET_MISMATCH"],
  ] as const)("security-freezes completion with %s", (_name, change, failureCode) => {
    const { project } = fixture(83);
    const begun = begin(project, 93);
    const failed = completeProjectTransfer({
      project: begun.pending,
      transferId: begun.transferId,
      expectedOwnershipVersion: 2,
      targetOrganizationId: begun.targetOrganizationId,
      nextBillingEpochId: begun.eventIds.next(),
      clock: begun.clock,
      eventIds: begun.eventIds,
      ...change,
    } as Parameters<typeof completeProjectTransfer>[0]);

    expect(failed).toMatchObject({
      ownershipState: "security_frozen",
      activeTransferId: null,
      transferIntents: [{ state: "failed_frozen", failureCode }],
    });
  });

  it("security-freezes a stale begin and rejects invalid identity inputs", () => {
    const { project, clock, eventIds } = fixture(84);
    const stale = freezeProjectForTransfer({
      project,
      transferId: eventIds.next(),
      targetOrganizationId: eventIds.next(),
      initiatorPrincipalId: "user:user_02",
      expectedOwnershipVersion: 0,
      clock,
      eventIds,
    });
    expect(stale).toMatchObject({
      ownershipState: "security_frozen",
      transferIntents: [{ state: "failed_frozen", failureCode: "PROJECT_TRANSFER_STALE_VERSION" }],
    });
    expect(() =>
      createOwnedProject({
        projectId: eventIds.next(),
        organizationId: eventIds.next(),
        billingEpochId: eventIds.next(),
        createdByPrincipalId: " ",
        clock,
        eventIds,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PRINCIPAL_ID" }));
    expect(() =>
      freezeProjectForTransfer({
        project,
        transferId: eventIds.next(),
        targetOrganizationId: project.organizationId,
        initiatorPrincipalId: "user:user_02",
        expectedOwnershipVersion: 1,
        clock,
        eventIds,
      }),
    ).toThrowError(expect.objectContaining({ code: "PROJECT_TRANSFER_TARGET_UNCHANGED" }));
  });

  it("cancels only the exact pending intent back to the source", () => {
    const { project, organizationId } = fixture(86);
    const begun = begin(project, 96);
    const cancelled = cancelProjectTransfer({
      project: begun.pending,
      transferId: begun.transferId,
      expectedOwnershipVersion: 2,
      clock: begun.clock,
      eventIds: begun.eventIds,
    });
    expect(cancelled).toMatchObject({
      organizationId,
      ownershipState: "active",
      transferIntents: [{ state: "cancelled_to_source" }],
    });
    expect(() =>
      cancelProjectTransfer({
        project: cancelled,
        transferId: begun.transferId,
        expectedOwnershipVersion: 3,
        clock: begun.clock,
        eventIds: begun.eventIds,
      }),
    ).toThrowError(expect.objectContaining({ code: "PROJECT_TRANSFER_NOT_PENDING" }));
  });

  it("explicitly freezes a pending transfer with a stable failure", () => {
    const { project } = fixture(87);
    const begun = begin(project, 97);
    const frozen = securityFreezeProject({
      project: begun.pending,
      transferId: begun.transferId,
      expectedOwnershipVersion: 2,
      failureCode: "BACKEND_UNCERTAIN",
      clock: begun.clock,
      eventIds: begun.eventIds,
    });
    expect(frozen.transferIntents[0]).toMatchObject({
      state: "failed_frozen",
      failureCode: "BACKEND_UNCERTAIN",
    });
    expect(() =>
      securityFreezeProject({
        project: begun.pending,
        transferId: begun.transferId,
        expectedOwnershipVersion: 2,
        failureCode: "not stable",
        clock: begun.clock,
        eventIds: begun.eventIds,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSFER_FAILURE_CODE" }));
  });

  it("freezes billing-epoch reuse and never rewrites older closed epochs", () => {
    const { project } = fixture(89);
    const first = begin(project, 99);
    const firstCompleted = completeProjectTransfer({
      project: first.pending,
      transferId: first.transferId,
      expectedOwnershipVersion: 2,
      targetOrganizationId: first.targetOrganizationId,
      nextBillingEpochId: first.eventIds.next(),
      clock: first.clock,
      eventIds: first.eventIds,
    });
    const originalClosedEpoch = firstCompleted.ownershipEpochs[0];
    const second = begin(firstCompleted, 100);
    const secondCompleted = completeProjectTransfer({
      project: second.pending,
      transferId: second.transferId,
      expectedOwnershipVersion: 4,
      targetOrganizationId: second.targetOrganizationId,
      nextBillingEpochId: second.eventIds.next(),
      clock: new FixedClock("2026-08-18T12:00:00.000Z"),
      eventIds: second.eventIds,
    });
    expect(secondCompleted.ownershipEpochs[0]).toBe(originalClosedEpoch);

    const third = begin(secondCompleted, 101, "2026-08-18T13:00:00.000Z");
    const failed = completeProjectTransfer({
      project: third.pending,
      transferId: third.transferId,
      expectedOwnershipVersion: 6,
      targetOrganizationId: third.targetOrganizationId,
      nextBillingEpochId: project.billingEpochId,
      clock: new FixedClock("2026-08-18T13:00:00.000Z"),
      eventIds: third.eventIds,
    });
    expect(failed.transferIntents.at(-1)).toMatchObject({
      state: "failed_frozen",
      failureCode: "BILLING_EPOCH_ID_REUSED",
    });
  });

  it("rejects ownership time moving backwards", () => {
    const { project } = fixture(90);
    const begun = begin(project, 102);
    expect(() =>
      cancelProjectTransfer({
        project: begun.pending,
        transferId: begun.transferId,
        expectedOwnershipVersion: 2,
        clock: new FixedClock("2026-08-18T10:59:59.999Z"),
        eventIds: begun.eventIds,
      }),
    ).toThrowError(expect.objectContaining({ code: "PROJECT_OWNERSHIP_TIME_MOVED_BACKWARDS" }));
  });
});

describe("ownership visibility", () => {
  it("keeps pending current data source-only and history epoch-scoped after completion", () => {
    const { project, organizationId } = fixture(88);
    const begun = begin(project, 98);
    expect(getProjectVisibility(begun.pending, organizationId).currentProject).toBe("read_only");
    expect(getProjectVisibility(begun.pending, begun.targetOrganizationId).currentProject).toBe(
      "hidden",
    );
    const transferred = completeProjectTransfer({
      project: begun.pending,
      transferId: begun.transferId,
      expectedOwnershipVersion: 2,
      targetOrganizationId: begun.targetOrganizationId,
      nextBillingEpochId: begun.eventIds.next(),
      clock: begun.clock,
      eventIds: begun.eventIds,
    });
    const oldRecord = {
      kind: "audit" as const,
      organizationId,
      billingEpochId: project.billingEpochId,
    };
    expect(getHistoricalProjectRecordVisibility(transferred, organizationId, oldRecord)).toBe(
      "full",
    );
    expect(
      getHistoricalProjectRecordVisibility(transferred, begun.targetOrganizationId, oldRecord),
    ).toBe("hidden");
    expect(
      getHistoricalProjectRecordVisibility(transferred, organizationId, {
        ...oldRecord,
        kind: "transfer_boundary",
      }),
    ).toBe("redacted");
    expect(getProjectVisibility(transferred, begun.targetOrganizationId).currentProject).toBe(
      "read_write",
    );
  });
});
