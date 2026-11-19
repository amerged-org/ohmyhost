import { afterAll, beforeAll, expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf, NOW } from "../support/platform-fixtures.js";
import { seedProductRuntimeFixture } from "../support/product-runtime-fixture.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 120000);
afterAll(async () => {
  await control?.dispose();
});

type Fixture = Awaited<ReturnType<typeof seedProductRuntimeFixture>>;

const digest = (n: number) => n.toString(16).padStart(64, "0");

async function member(
  core: TestControl["core"],
  organizationId: string,
  workosUserId: string,
  status: "active" | "suspended",
  role = "admin",
) {
  await core
    .prepare(
      "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,?2,?3,?4,1,?5,?6,'evt_seed')",
    )
    .bind(
      organizationId,
      workosUserId,
      role,
      status,
      new Uint8Array(32).fill(3),
      "2026-10-28T10:00:00.000000Z",
    )
    .run();
}

async function workosOrganizationId(core: TestControl["core"], organizationId: string) {
  const row = await core
    .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?1")
    .bind(organizationId)
    .first<{ workos_organization_id: string }>();
  expect(row).not.toBeNull();
  return row?.workos_organization_id ?? "";
}

async function issue(
  st: ReturnType<typeof createControlStore>,
  f: Fixture,
  principalId: string,
  index: number,
) {
  const accessId = ulidOf(`membership-access-${principalId}-${f.n}`, index);
  const accepted = await st.productDatabase.issueAccess({
    organizationId: f.organizationId,
    projectId: f.projectId,
    environment: "dev",
    mode: "read",
    ttlSeconds: 3600,
    label: `membership fixture ${index}`,
    principalId,
    now: NOW,
    roleSuffix: String(index).padStart(8, "0"),
    accessId,
    auditEventId: newUlid(),
  });
  expect(accepted).toMatchObject({ status: "accepted" });
  return accessId;
}

async function accessRows(core: TestControl["core"], accessIds: string[]) {
  const rows = await core
    .prepare(
      `SELECT access_id,revoked_at,revoked_by,revocation_reason FROM project_database_access WHERE access_id IN(${accessIds.map((_, i) => `?${i + 1}`).join(",")})`,
    )
    .bind(...accessIds)
    .all<{
      access_id: string;
      revoked_at: string | null;
      revoked_by: string | null;
      revocation_reason: string | null;
    }>();
  return new Map(rows.results.map((row) => [row.access_id, row]));
}

it("ends the database access of a member the organization snapshot removes or suspends, and of no one else", async () => {
  const f = await seedProductRuntimeFixture(control);
  const orgWorkosId = await workosOrganizationId(control.core, f.organizationId);
  await member(control.core, f.organizationId, "user_removed", "active");
  await member(control.core, f.organizationId, "user_suspended", "active");
  await member(control.core, f.organizationId, "user_kept", "active");
  const removed = await issue(store, f, "user:user_removed", 1);
  const suspended = await issue(store, f, "user:user_suspended", 2);
  const kept = await issue(store, f, "user:user_kept", 3);

  await store.identity.applyOrganizationSnapshot({
    organizationId: f.organizationId,
    workosOrganizationId: orgWorkosId,
    state: "active",
    snapshotDigest: digest(f.n + 1000),
    snapshotFetchedAt: "2026-10-28T11:00:00.000Z",
    synchronizedAt: "2026-10-28T11:00:00.500Z",
    triggerEventId: "evt_membership_removed",
    memberships: [
      {
        workosUserId: "user_suspended",
        role: "admin",
        status: "suspended",
        digest: digest(f.n + 1001),
      },
      { workosUserId: "user_kept", role: "admin", status: "active", digest: digest(f.n + 1002) },
    ],
    auditEventId: newUlid(),
  });

  const byId = await accessRows(control.core, [removed, suspended, kept]);
  expect(byId.get(removed)).toMatchObject({
    revocation_reason: "principal",
    revoked_by: "membership",
  });
  expect(byId.get(removed)?.revoked_at).not.toBeNull();
  expect(byId.get(suspended)?.revoked_at).not.toBeNull();
  expect(byId.get(kept)?.revoked_at).toBeNull();

  // Each ended access leaves one DatabaseAccessRevoked audit event, written by the platform in the same batch.
  const audits = await control.core
    .prepare(
      "SELECT payload, actor_type FROM audit_events WHERE event_type='DatabaseAccessRevoked' AND organization_id=?1",
    )
    .bind(f.organizationId)
    .all<{ payload: string; actor_type: string }>();
  expect(audits.results.map((row) => row.actor_type)).toEqual(["platform", "platform"]);
  expect(JSON.parse(audits.results[0]?.payload ?? "{}")).toMatchObject({
    revocation_reason: "principal",
  });

  // The sweep then drops the removed member's login role; the kept member's access is not listed.
  const sweep = await store.productDatabase.readAccessSweep({
    now: "2026-10-28T11:01:00.000Z",
    limit: 50,
  });
  const undropped = sweep.undropped.map((record) => record.accessId);
  expect(undropped).toEqual(expect.arrayContaining([removed, suspended]));
  expect(undropped).not.toContain(kept);
});

it("ends the open access of every member when the snapshot marks the organization inactive", async () => {
  const f = await seedProductRuntimeFixture(control);
  const orgWorkosId = await workosOrganizationId(control.core, f.organizationId);
  await member(control.core, f.organizationId, "user_admin", "active");
  const first = await issue(store, f, "user:user_admin", 1);
  const second = await issue(store, f, "user:user_other", 2);

  await store.identity.applyOrganizationSnapshot({
    organizationId: f.organizationId,
    workosOrganizationId: orgWorkosId,
    state: "suspended",
    snapshotDigest: digest(f.n + 2000),
    snapshotFetchedAt: "2026-10-28T11:00:00.000Z",
    synchronizedAt: "2026-10-28T11:00:00.500Z",
    triggerEventId: "evt_organization_suspended",
    memberships: [
      { workosUserId: "user_admin", role: "admin", status: "active", digest: digest(f.n + 2001) },
    ],
    auditEventId: newUlid(),
  });

  const byId = await accessRows(control.core, [first, second]);
  expect(byId.get(first)).toMatchObject({
    revocation_reason: "principal",
    revoked_by: "organization",
  });
  expect(byId.get(second)).toMatchObject({
    revocation_reason: "principal",
    revoked_by: "organization",
  });
});

it("ends the access of an admin whom the snapshot downgrades to member, and keeps the other admins", async () => {
  const f = await seedProductRuntimeFixture(control);
  const orgWorkosId = await workosOrganizationId(control.core, f.organizationId);
  await member(control.core, f.organizationId, "user_downgraded", "active");
  await member(control.core, f.organizationId, "user_still_admin", "active");
  const downgraded = await issue(store, f, "user:user_downgraded", 1);
  const admin = await issue(store, f, "user:user_still_admin", 2);

  await store.identity.applyOrganizationSnapshot({
    organizationId: f.organizationId,
    workosOrganizationId: orgWorkosId,
    state: "active",
    snapshotDigest: digest(f.n + 3000),
    snapshotFetchedAt: "2026-10-28T11:00:00.000Z",
    synchronizedAt: "2026-10-28T11:00:00.500Z",
    triggerEventId: "evt_role_downgraded",
    memberships: [
      {
        workosUserId: "user_downgraded",
        role: "member",
        status: "active",
        digest: digest(f.n + 3001),
      },
      {
        workosUserId: "user_still_admin",
        role: "admin",
        status: "active",
        digest: digest(f.n + 3002),
      },
    ],
    auditEventId: newUlid(),
  });

  const byId = await accessRows(control.core, [downgraded, admin]);
  expect(byId.get(downgraded)?.revoked_at).not.toBeNull();
  expect(byId.get(admin)?.revoked_at).toBeNull();
});

it("ends the open access of a member when a membership barrier opens for that member", async () => {
  const f = await seedProductRuntimeFixture(control);
  const orgWorkosId = await workosOrganizationId(control.core, f.organizationId);
  await member(control.core, f.organizationId, "user_barred", "active");
  await member(control.core, f.organizationId, "user_other", "active");
  const barred = await issue(store, f, "user:user_barred", 1);
  const other = await issue(store, f, "user:user_other", 2);

  await store.identity.recordMembershipBarrier({
    workosOrganizationId: orgWorkosId,
    workosUserId: "user_barred",
    sourceEventId: newUlid(),
    eventCreatedAt: "2026-10-28T10:30:00.000Z",
  });

  const byId = await accessRows(control.core, [barred, other]);
  expect(byId.get(barred)).toMatchObject({
    revocation_reason: "principal",
    revoked_by: "membership-barrier",
  });
  expect(byId.get(other)?.revoked_at).toBeNull();
});

it("ends the user's open access in every organization when a terminal user revocation is recorded", async () => {
  // A user revocation is global, so this test owns its Core.
  const own = await createTestControl(),
    ownStore = createControlStore(own.bindings);
  try {
    const first = await seedProductRuntimeFixture(own);
    const second = await seedProductRuntimeFixture(own);
    await member(own.core, first.organizationId, "user_deleted", "active");
    await member(own.core, second.organizationId, "user_deleted", "active");
    await member(own.core, first.organizationId, "user_other", "active");
    const inFirst = await issue(ownStore, first, "user:user_deleted", 1);
    const inSecond = await issue(ownStore, second, "user:user_deleted", 1);
    const other = await issue(ownStore, first, "user:user_other", 2);

    await ownStore.identity.recordTerminalRevocation({
      kind: "user",
      workosUserId: "user_deleted",
      sourceEventId: newUlid(),
      effectiveAt: "2026-10-28T10:45:00.000Z",
    });

    const byId = await accessRows(own.core, [inFirst, inSecond, other]);
    expect(byId.get(inFirst)).toMatchObject({
      revocation_reason: "principal",
      revoked_by: "user-revocation",
    });
    expect(byId.get(inSecond)?.revoked_at).not.toBeNull();
    expect(byId.get(other)?.revoked_at).toBeNull();
  } finally {
    await own.dispose();
  }
}, 60000);

it("ends every open database access of an organization that WorkOS deletes, one audit event each", async () => {
  // The deletion claims the next inbox event of the Core, so this test owns its Core.
  const own = await createTestControl(),
    ownStore = createControlStore(own.bindings);
  try {
    const f = await seedProductRuntimeFixture(own);
    const orgWorkosId = await workosOrganizationId(own.core, f.organizationId);
    await member(own.core, f.organizationId, "user_admin", "active");
    const first = await issue(ownStore, f, "user:user_admin", 1);
    const second = await issue(ownStore, f, "user:user_other", 2);

    const inboxEventId = newUlid(),
      receivedAt = new Date().toISOString();
    await ownStore.operations.recordInboxEvent({
      provider: "workos",
      inboxEventId,
      externalEventId: `evt_${inboxEventId}`,
      eventType: "organization.deleted",
      payload: {
        schemaVersion: "workos.organization-trigger.v1",
        workosOrganizationId: orgWorkosId,
      },
      bodyDigest: "ab".repeat(32),
      receivedAt,
      signatureTimestamp: receivedAt,
      maxAttempts: 3,
      routing: { kind: "workos_organization", workosOrganizationId: orgWorkosId },
    });
    const claimId = newUlid(),
      held = await ownStore.identity.claimWorkosInboxEvent({
        claimId,
        claimedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    expect(held).toMatchObject({ inboxEventId });
    await ownStore.identity.applyWorkosOrganizationDeletion({
      organizationId: f.organizationId,
      workosOrganizationId: orgWorkosId,
      tombstoneDigest: digest(f.n + 4000),
      triggerEventId: `evt_${inboxEventId}`,
      deletedAt: new Date().toISOString(),
      auditEventId: newUlid(),
      claim: { inboxEventId, claimId },
    });

    const byId = await accessRows(own.core, [first, second]);
    expect(byId.get(first)).toMatchObject({
      revocation_reason: "principal",
      revoked_by: "organization",
    });
    expect(byId.get(second)).toMatchObject({
      revocation_reason: "principal",
      revoked_by: "organization",
    });
    const audits = await own.core
      .prepare(
        "SELECT actor_type FROM audit_events WHERE event_type='DatabaseAccessRevoked' AND organization_id=?1",
      )
      .bind(f.organizationId)
      .all<{ actor_type: string }>();
    expect(audits.results.map((row) => row.actor_type)).toEqual(["platform", "platform"]);
  } finally {
    await own.dispose();
  }
}, 60000);
