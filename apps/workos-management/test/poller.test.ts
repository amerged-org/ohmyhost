import { describe, expect, it } from "vitest";
import { WorkosContractError } from "@ohmyhost/workos-auth-contracts";

import {
  buildOrganizationDeletion,
  createWorkosSnapshotPoller,
  parseWorkosOrganizationTrigger,
  WorkosTransportFailure,
} from "../src/index.js";
import {
  claim,
  FixedIds,
  FixtureDatabase,
  FixtureResolver,
  FixtureTransport,
  FixedOrganizationIds,
  ORGANIZATION_ID,
  rawSnapshot,
  SequenceClock,
} from "./fixtures.js";

const dates = [
  new Date("2026-08-18T12:00:00.000Z"),
  new Date("2026-08-18T12:00:01.000Z"),
  new Date("2026-08-18T12:00:02.000Z"),
  new Date("2026-08-18T12:00:03.000Z"),
];

const createPoller = () => {
  const database = new FixtureDatabase();
  const resolver = new FixtureResolver();
  const transport = new FixtureTransport();
  const clock = new SequenceClock(dates);
  return {
    database,
    resolver,
    transport,
    poller: createWorkosSnapshotPoller({
      database,
      resolver,
      transport,
      clock,
      ids: new FixedIds(),
      organizationIds: new FixedOrganizationIds(),
      leaseMs: 30_000,
      baseRetryMs: 1_000,
      maxRetryMs: 8_000,
    }),
  };
};

describe("WorkOS current-snapshot inbox poller", () => {
  it("builds a deterministic PII-free organization tombstone", () => {
    const deletion = buildOrganizationDeletion({
      organizationId: ORGANIZATION_ID,
      workosOrganizationId: "org_workos",
      triggerEventId: "event_secret_must_not_enter_tombstone",
    });
    expect(deletion).toEqual({
      organizationId: ORGANIZATION_ID,
      workosOrganizationId: "org_workos",
      triggerEventId: "event_secret_must_not_enter_tombstone",
      canonicalTombstone:
        '{"schemaVersion":"workos.organization-deletion.v1","workosOrganizationId":"org_workos"}',
    });
    expect(deletion.canonicalTombstone).not.toContain("event_secret");
  });

  it("accepts only the canonical PII-minimized ingress trigger", () => {
    expect(
      parseWorkosOrganizationTrigger({
        schemaVersion: "workos.organization-trigger.v1",
        workosOrganizationId: "org_workos",
      }),
    ).toEqual({
      schemaVersion: "workos.organization-trigger.v1",
      workosOrganizationId: "org_workos",
    });
    for (const invalid of [
      { schemaVersion: "workos.organization-trigger.v0", workosOrganizationId: "org_workos" },
      { schemaVersion: "workos.organization-trigger.v1", workosOrganizationId: "" },
      {
        schemaVersion: "workos.organization-trigger.v1",
        workosOrganizationId: "org_workos",
        userId: "user_must_not_cross_handoff",
      },
    ]) {
      expect(() => parseWorkosOrganizationTrigger(invalid)).toThrow("Invalid WorkOS inbox trigger");
    }
  });

  it("rejects unsafe timing configuration", () => {
    const fixture = createPoller();
    const common = {
      database: fixture.database,
      resolver: fixture.resolver,
      transport: fixture.transport,
      clock: new SequenceClock(dates),
      ids: new FixedIds(),
      organizationIds: new FixedOrganizationIds(),
      baseRetryMs: 1,
      maxRetryMs: 2,
      leaseMs: 1,
    };
    expect(() => createWorkosSnapshotPoller({ ...common, leaseMs: 0 })).toThrow(
      "timing configuration",
    );
    expect(() => createWorkosSnapshotPoller({ ...common, baseRetryMs: 0 })).toThrow(
      "timing configuration",
    );
    expect(() => createWorkosSnapshotPoller({ ...common, maxRetryMs: 0 })).toThrow(
      "timing configuration",
    );
  });

  it("returns idle without resolving a credential when no trigger is claimable", async () => {
    const fixture = createPoller();
    fixture.database.nextClaim = null;
    await expect(fixture.poller.pollOne()).resolves.toEqual({ outcome: "idle" });
    expect(fixture.resolver.uses).toBe(0);
  });

  it("fetches current state and atomically requests mapping persistence plus acknowledgement", async () => {
    const fixture = createPoller();
    await expect(fixture.poller.pollOne()).resolves.toEqual({
      outcome: "acknowledged",
      eventId: "event_1",
      changedScope: ORGANIZATION_ID,
    });
    expect(fixture.database.applications).toHaveLength(1);
    expect(fixture.database.applications[0]).toMatchObject({
      organizationId: ORGANIZATION_ID,
      triggerEventId: "event_1",
      snapshot: { organization: { id: "org_workos" } },
    });
    expect(fixture.database.failures).toEqual([]);

    fixture.database.appliedOrganizationId = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    await expect(fixture.poller.pollOne()).resolves.toMatchObject({
      changedScope: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
    });
  });

  it.each([
    "organization.created",
    "organization.updated",
    "organization_membership.created",
    "organization_membership.updated",
    "organization_membership.deleted",
  ])("accepts the supported current-state trigger %s", async (eventType) => {
    const fixture = createPoller();
    fixture.database.nextClaim = { ...claim, eventType };
    await expect(fixture.poller.pollOne()).resolves.toMatchObject({ outcome: "acknowledged" });
    expect(fixture.transport.snapshotRequests).toEqual(["org_workos"]);
  });

  it("applies an explicit organization deletion without resolving provider credentials", async () => {
    const fixture = createPoller();
    fixture.database.nextClaim = { ...claim, eventType: "organization.deleted" };
    await expect(fixture.poller.pollOne()).resolves.toEqual({
      outcome: "acknowledged",
      eventId: "event_1",
      changedScope: ORGANIZATION_ID,
    });
    expect(fixture.resolver.uses).toBe(0);
    expect(fixture.transport.snapshotRequests).toEqual([]);
    expect(fixture.database.applications).toEqual([]);
    expect(fixture.database.deletions).toEqual([
      {
        organizationId: ORGANIZATION_ID,
        workosOrganizationId: "org_workos",
        triggerEventId: "event_1",
        canonicalTombstone:
          '{"schemaVersion":"workos.organization-deletion.v1","workosOrganizationId":"org_workos"}',
      },
    ]);
  });

  it("rejects unsupported inbox event types before provider access", async () => {
    const fixture = createPoller();
    fixture.database.nextClaim = { ...claim, eventType: "user.created" };
    await expect(fixture.poller.pollOne()).resolves.toEqual({
      outcome: "retry_scheduled",
      eventId: "event_1",
      errorCode: "WORKOS_INVALID_TRIGGER",
    });
    expect(fixture.resolver.uses).toBe(0);
    expect(fixture.database.applications).toEqual([]);
    expect(fixture.database.deletions).toEqual([]);
  });

  it("does not acknowledge a stale lease", async () => {
    const fixture = createPoller();
    fixture.database.appliedOrganizationId = null;
    await expect(fixture.poller.pollOne()).resolves.toEqual({
      outcome: "stale_claim",
      eventId: "event_1",
      errorCode: "WORKOS_STALE_CLAIM",
    });
  });

  it("does not acknowledge a stale deletion lease", async () => {
    const fixture = createPoller();
    fixture.database.nextClaim = { ...claim, eventType: "organization.deleted" };
    fixture.database.appliedOrganizationId = null;
    await expect(fixture.poller.pollOne()).resolves.toEqual({
      outcome: "stale_claim",
      eventId: "event_1",
      errorCode: "WORKOS_STALE_CLAIM",
    });
  });

  it.each([
    [new WorkosTransportFailure("unavailable"), "WORKOS_UNAVAILABLE"],
    [new WorkosTransportFailure("permanent"), "WORKOS_TRANSPORT_PERMANENT"],
    [new WorkosTransportFailure("not_found"), "WORKOS_ORGANIZATION_NOT_FOUND"],
    [new WorkosContractError("invalid_organization_snapshot", "bad"), "WORKOS_INVALID_SNAPSHOT"],
    [new Error("database detail"), "WORKOS_SYNC_FAILED"],
  ])("schedules a bounded redacted retry for %s", async (error, errorCode) => {
    const fixture = createPoller();
    fixture.transport.snapshotError = error;
    await expect(fixture.poller.pollOne()).resolves.toEqual({
      outcome: "retry_scheduled",
      eventId: "event_1",
      errorCode,
    });
    expect(JSON.stringify(fixture.database.failures)).not.toContain("database detail");
  });

  it("rejects malformed and mismatched triggers without applying authorization state", async () => {
    const malformed = createPoller();
    malformed.database.nextClaim = {
      ...claim,
      payload: { schemaVersion: "workos.organization-trigger.v1" },
    };
    await expect(malformed.poller.pollOne()).resolves.toMatchObject({
      outcome: "retry_scheduled",
      errorCode: "WORKOS_INVALID_TRIGGER",
    });
    expect(malformed.database.applications).toEqual([]);

    const mismatched = createPoller();
    mismatched.transport.snapshot = {
      ...rawSnapshot,
      organization: {
        ...rawSnapshot.organization,
        id: "org_other",
      },
      memberships: [],
    };
    await expect(mismatched.poller.pollOne()).resolves.toMatchObject({
      outcome: "retry_scheduled",
      errorCode: "WORKOS_INVALID_SNAPSHOT",
    });
    expect(mismatched.database.applications).toEqual([]);
  });

  it("fails closed with a deterministic redacted code for multiple distinct roles", async () => {
    const fixture = createPoller();
    fixture.transport.snapshot = {
      ...rawSnapshot,
      memberships: [
        {
          ...rawSnapshot.memberships[0],
          roles: [{ slug: "admin" }, { slug: "viewer" }, { slug: "admin" }],
        },
      ],
    };

    await expect(fixture.poller.pollOne()).resolves.toEqual({
      outcome: "retry_scheduled",
      eventId: "event_1",
      errorCode: "WORKOS_UNSUPPORTED_MULTIPLE_ROLES",
    });
    expect(fixture.database.applications).toEqual([]);
    expect(fixture.database.uncertainSnapshotRevocations).toEqual([
      {
        workosOrganizationId: "org_workos",
        revokedAt: "2026-08-18T12:00:02.000Z",
      },
    ]);
    expect(JSON.stringify(fixture.database.failures)).not.toContain("admin");
    expect(JSON.stringify(fixture.database.failures)).not.toContain("viewer");
  });

  it("keeps an uncertain snapshot fail closed when grant revocation cannot be confirmed", async () => {
    const fixture = createPoller();
    fixture.transport.snapshot = {
      ...rawSnapshot,
      memberships: [
        {
          ...rawSnapshot.memberships[0],
          roles: [{ slug: "admin" }, { slug: "member" }],
        },
      ],
    };
    fixture.database.revokeLocalAuthorizationForUncertainSnapshot = async () => {
      throw new Error("database unavailable");
    };

    await expect(fixture.poller.pollOne()).resolves.toEqual({
      outcome: "retry_scheduled",
      eventId: "event_1",
      errorCode: "WORKOS_SYNC_FAILED",
    });
    expect(fixture.database.applications).toEqual([]);
  });

  it("reports a stale claim when failure fencing loses", async () => {
    const fixture = createPoller();
    fixture.transport.snapshotError = new Error("failure");
    fixture.database.failureOutcome = "stale_claim";
    await expect(fixture.poller.pollOne()).resolves.toMatchObject({ outcome: "stale_claim" });
  });

  it("reports reconciliation when the durable attempt budget is exhausted", async () => {
    const fixture = createPoller();
    fixture.transport.snapshotError = new Error("failure");
    fixture.database.failureOutcome = "reconciliation_required";
    await expect(fixture.poller.pollOne()).resolves.toMatchObject({
      outcome: "reconciliation_required",
      errorCode: "WORKOS_SYNC_FAILED",
    });
  });

  it("moves an expired final claim to reconciliation exactly through the database seam", async () => {
    const recovered = createPoller();
    await expect(recovered.poller.recoverExpiredFinalClaim(claim)).resolves.toEqual({
      outcome: "reconciliation_required",
      eventId: "event_1",
      errorCode: "WORKOS_LEASE_EXPIRED",
    });
    expect(recovered.database.recoveries).toHaveLength(1);

    const stale = createPoller();
    stale.database.recovered = false;
    await expect(stale.poller.recoverExpiredFinalClaim(claim)).resolves.toMatchObject({
      outcome: "stale_claim",
    });
  });

  it("scans and recovers at most one expired final claim before normal polling", async () => {
    const recovered = createPoller();
    recovered.database.expiredFinalClaim = claim;
    await expect(recovered.poller.recoverOneExpiredFinalClaim()).resolves.toEqual({
      outcome: "reconciliation_required",
      eventId: "event_1",
      errorCode: "WORKOS_LEASE_EXPIRED",
    });
    expect(recovered.database.recoveryScans).toHaveLength(1);
    expect(recovered.database.recoveries).toHaveLength(1);

    const idle = createPoller();
    await expect(idle.poller.recoverOneExpiredFinalClaim()).resolves.toBeNull();
    expect(idle.database.recoveryScans).toHaveLength(1);
    expect(idle.database.recoveries).toEqual([]);
  });
});
