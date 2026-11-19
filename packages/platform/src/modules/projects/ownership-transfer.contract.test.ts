import { describe, expect, it } from "vitest";

import * as platform from "../../index.js";
import { DeterministicEntropy, FixedClock, createUlidFactory } from "../../shared/index.js";

type UnknownFunction = (...arguments_: readonly unknown[]) => unknown;

function requirePlatformFunction(name: string): UnknownFunction {
  const candidate = (platform as Record<string, unknown>)[name];
  expect(candidate, `Expected @ohmyhost/platform to export ${name}`).toBeTypeOf("function");
  return candidate as UnknownFunction;
}

describe("project ownership and billing epochs", () => {
  it("creates one immutable ownership epoch bound to the initial organization", () => {
    const clock = new FixedClock("2026-08-18T10:00:00.000Z");
    const ids = createUlidFactory({ clock, entropy: new DeterministicEntropy(41) });
    const projectId = ids.next();
    const organizationId = ids.next();
    const billingEpochId = ids.next();

    const project = requirePlatformFunction("createOwnedProject")({
      projectId,
      organizationId,
      billingEpochId,
      createdByPrincipalId: "user:user_01",
      clock,
      eventIds: ids,
    });

    expect(project).toMatchObject({
      projectId,
      organizationId,
      billingEpochId,
      transferState: "active",
      ownershipEpochs: [
        {
          organizationId,
          billingEpochId,
          createdByPrincipalId: "user:user_01",
          effectiveFrom: "2026-08-18T10:00:00.000Z",
          effectiveUntil: null,
        },
      ],
    });
  });

  it("freezes without changing ownership or the current billing epoch", () => {
    const clock = new FixedClock("2026-08-18T10:00:00.000Z");
    const ids = createUlidFactory({ clock, entropy: new DeterministicEntropy(42) });
    const createOwnedProject = requirePlatformFunction("createOwnedProject");
    const freezeProjectForTransfer = requirePlatformFunction("freezeProjectForTransfer");
    const project = createOwnedProject({
      projectId: ids.next(),
      organizationId: ids.next(),
      billingEpochId: ids.next(),
      createdByPrincipalId: "user:user_01",
      clock,
      eventIds: ids,
    });

    const frozen = freezeProjectForTransfer({
      project,
      transferId: ids.next(),
      targetOrganizationId: ids.next(),
      initiatorPrincipalId: "user:user_01",
      expectedOwnershipVersion: 1,
      clock,
      eventIds: ids,
    });

    expect(frozen).toMatchObject({
      organizationId: (project as Record<string, unknown>)["organizationId"],
      billingEpochId: (project as Record<string, unknown>)["billingEpochId"],
      transferState: "frozen",
      ownershipEpochs: (project as Record<string, unknown>)["ownershipEpochs"],
    });
  });

  it("completes transfer with a new billing epoch while preserving historical attribution", () => {
    const initialClock = new FixedClock("2026-08-18T10:00:00.000Z");
    const transferClock = new FixedClock("2026-08-18T11:00:00.000Z");
    const ids = createUlidFactory({ clock: initialClock, entropy: new DeterministicEntropy(43) });
    const createOwnedProject = requirePlatformFunction("createOwnedProject");
    const originalOrganizationId = ids.next();
    const originalBillingEpochId = ids.next();
    const project = createOwnedProject({
      projectId: ids.next(),
      organizationId: originalOrganizationId,
      billingEpochId: originalBillingEpochId,
      createdByPrincipalId: "user:user_01",
      clock: initialClock,
      eventIds: ids,
    });
    const transferId = ids.next();
    const targetOrganizationId = ids.next();
    const frozen = requirePlatformFunction("freezeProjectForTransfer")({
      project,
      transferId,
      targetOrganizationId,
      initiatorPrincipalId: "user:user_01",
      expectedOwnershipVersion: 1,
      clock: transferClock,
      eventIds: ids,
    });
    const nextBillingEpochId = ids.next();

    const transferred = requirePlatformFunction("completeProjectTransfer")({
      project: frozen,
      transferId,
      expectedOwnershipVersion: 2,
      targetOrganizationId,
      nextBillingEpochId,
      clock: transferClock,
      eventIds: ids,
    });

    expect(transferred).toMatchObject({
      projectId: (project as Record<string, unknown>)["projectId"],
      organizationId: targetOrganizationId,
      billingEpochId: nextBillingEpochId,
      transferState: "active",
      ownershipEpochs: [
        {
          organizationId: originalOrganizationId,
          billingEpochId: originalBillingEpochId,
          createdByPrincipalId: "user:user_01",
          effectiveFrom: "2026-08-18T10:00:00.000Z",
          effectiveUntil: "2026-08-18T11:00:00.000Z",
        },
        {
          organizationId: targetOrganizationId,
          billingEpochId: nextBillingEpochId,
          createdByPrincipalId: "user:user_01",
          effectiveFrom: "2026-08-18T11:00:00.000Z",
          effectiveUntil: null,
        },
      ],
    });
  });
});
