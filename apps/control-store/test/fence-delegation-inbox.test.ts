import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readWorkflowDelegation,
  workflowExecutionGuards,
} from "../src/catalog/provisioning/authority.js";
import { newUlid } from "../src/catalog/common.js";
import { BucketMovingError } from "../src/fence.js";
import { bucketOf } from "../src/router.js";
import { createControlStore } from "../src/store.js";
import {
  createTestControl,
  organizationIdWithShard,
  shardOf,
  type TestControl,
} from "./support/control-d1.js";
import { acceptInput, digest, projectInput, seedOrganization, type Store } from "./support/seed.js";

let control: TestControl;
let store: Store;
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

const fence = (shard: number, bucket: number, state: "moving" | "moved") =>
  shardOf(control, shard)
    .prepare(
      "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?, ?, ?, '2026-10-28T12:00:00.000000Z')",
    )
    .bind(bucket, state, newUlid())
    .run();
const rows = async (shard: number, sql: string, ...binds: unknown[]) =>
  (
    await shardOf(control, shard)
      .prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>()
  ).results;

describe("authoritative bucket fence", () => {
  it("stops a command routed by a stale cached map at the shard, re-routes it once, and keeps sweepers off a moving bucket", async () => {
    const organizationId = await seedOrganization(store, 2, 0);
    const bucket = await bucketOf(organizationId);
    const project = projectInput(organizationId, "fenced-handle");
    await store.projects.createInitialProject(project); // warms this isolate's 60 s route cache: bucket -> shard 0

    // Moving: writes are refused at the shard even though the cached and the directory map still say shard 0.
    await fence(0, bucket, "moving");
    await expect(
      store.operations.acceptApiOperation(acceptInput(project, { idempotencyKey: "while-moving" })),
    ).rejects.toBeInstanceOf(BucketMovingError);
    expect(
      await rows(0, "SELECT 1 FROM api_idempotency_records WHERE idempotency_key = 'while-moving'"),
    ).toHaveLength(0);
    // Reads of a moving bucket stay served; its due work is not claimed by a shard-wide sweeper.
    expect(await store.operations.readAuditEvents({ organizationId, limit: 5 })).toMatchObject({
      events: [{ eventType: "ProjectCreated" }],
    });
    expect(
      await store.maintenance.claimOutboxEvent({
        shardId: 0,
        now: "2026-10-28T13:00:00.000Z",
        leaseMilliseconds: 60_000,
        attemptId: newUlid(),
      }),
    ).toBeNull();

    // Moved: reads and writes are refused for the fenced bucket's organizations whatever any cache says.
    await shardOf(control, 0)
      .prepare("UPDATE bucket_fences SET state = 'moved' WHERE bucket = ?")
      .bind(bucket)
      .run();
    await expect(
      store.operations.readAuditEvents({ organizationId, limit: 5 }),
    ).rejects.toBeInstanceOf(BucketMovingError);
    await expect(
      store.operations.acceptApiOperation(acceptInput(project, { idempotencyKey: "after-moved" })),
    ).rejects.toBeInstanceOf(BucketMovingError);
    expect(
      await rows(0, "SELECT 1 FROM api_idempotency_records WHERE idempotency_key = 'after-moved'"),
    ).toHaveLength(0);

    // The operator lifts the quarantine: the same command now lands once in the one core, nothing was half applied.
    await shardOf(control, 0)
      .prepare("DELETE FROM bucket_fences WHERE bucket = ?")
      .bind(bucket)
      .run();
    await expect(
      store.identity.applyOrganizationSnapshot({
        organizationId,
        workosOrganizationId: "org_seed1",
        state: "suspended",
        snapshotDigest: digest(77),
        snapshotFetchedAt: "2026-10-28T12:30:00.000Z",
        synchronizedAt: "2026-10-28T12:30:00.000Z",
        triggerEventId: "evt_seed",
        memberships: [],
        auditEventId: newUlid(),
      }),
    ).resolves.toMatchObject({ organizationChanged: true });
    expect(
      await rows(
        0,
        "SELECT bucket, state, mapping_revision FROM organizations WHERE organization_id = ?",
        organizationId,
      ),
    ).toEqual([{ bucket, state: "suspended", mapping_revision: 2 }]);
  });
});

async function seedGrant(
  organizationId: string,
  shard: number,
  project: ReturnType<typeof projectInput>,
  allowPublish: boolean,
) {
  const db = shardOf(control, shard);
  const grantId = crypto.randomUUID();
  const at = "2026-10-28T10:00:00.000000Z";
  await db.batch([
    db
      .prepare("UPDATE organizations SET beta_admitted_at = ?1 WHERE organization_id = ?2")
      .bind(at, organizationId),
    db
      .prepare(
        "INSERT INTO organization_memberships(organization_id, workos_user_id, role, state, mapping_revision, snapshot_sha256, effective_at, trigger_event_id) VALUES (?1, 'user_seed', 'admin', 'active', 1, ?2, ?3, 'evt')",
      )
      .bind(organizationId, new Uint8Array(32), at),
    db
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id, grant_id, project_id, environment_id, principal_kind, principal_id, role, created_at) VALUES (?1, ?2, NULL, NULL, 'user', 'user:user_seed', 'owner', ?3)",
      )
      .bind(organizationId, newUlid(), at),
    db
      .prepare(
        "INSERT INTO mcp_client_grants(organization_id, grant_id, user_id, client_id, consent_hash, project_id, ownership_version, billing_epoch_id, allow_publish, revision, created_at) VALUES (?1, ?2, 'user_seed', 'client-1', ?3, ?4, 1, ?5, ?6, 1, ?7)",
      )
      .bind(
        organizationId,
        grantId,
        digest(5),
        project.projectId,
        project.billingEpochId,
        allowPublish ? 1 : 0,
        at,
      ),
  ]);
  return grantId;
}

describe("delegated operations", () => {
  it("accepts under an effective grant and refuses once the consent or the user is revoked, without a trace", async () => {
    const organizationId = await seedOrganization(store, 2, 0);
    const project = projectInput(organizationId, "delegated-handle");
    await store.projects.createInitialProject(project);
    const grantId = await seedGrant(organizationId, 0, project, true);
    const delegation = {
      grantId,
      clientId: "client-1",
      consentHash: digest(5),
      action: "deployments:create" as const,
    };
    const input = acceptInput(project, {
      principalId: "user:user_seed",
      delegation,
      idempotencyKey: "delegated",
    });
    expect(await store.operations.acceptApiOperation(input)).toMatchObject({ outcome: "created" });
    expect(
      await rows(
        0,
        "SELECT grant_id, requires_publication FROM operation_mcp_delegations WHERE operation_id = ?",
        input.operationId,
      ),
    ).toEqual([{ grant_id: grantId, requires_publication: 0 }]);
    await expect(
      store.identity.assertOperationDelegationCurrent({
        organizationId,
        operationId: input.operationId,
      }),
    ).resolves.toBeUndefined();

    // The accepted restriction is immutable and remains effective when the user's role changes.
    const empty = acceptInput(project, {
      principalId: "user:user_seed",
      idempotencyKey: "empty-cap",
      delegation: { ...delegation, authorizationRestriction: { actions: [] } },
    });
    await expect(store.operations.acceptApiOperation(empty)).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    expect(
      await rows(0, "SELECT 1 FROM operations WHERE operation_id = ?", empty.operationId),
    ).toHaveLength(0);
    await shardOf(control, 0)
      .prepare(
        "UPDATE organization_memberships SET role='member' WHERE organization_id=? AND workos_user_id='user_seed'",
      )
      .bind(organizationId)
      .run();
    await expect(
      store.identity.assertOperationDelegationCurrent({
        organizationId,
        operationId: input.operationId,
      }),
    ).rejects.toMatchObject({ code: "operation_authorization_changed" });
    await shardOf(control, 0)
      .prepare(
        "UPDATE organization_memberships SET role='admin' WHERE organization_id=? AND workos_user_id='user_seed'",
      )
      .bind(organizationId)
      .run();
    await expect(
      store.identity.assertOperationDelegationCurrent({
        organizationId,
        operationId: input.operationId,
      }),
    ).resolves.toBeUndefined();

    // A role change inside the same transaction must prevent the provider effect and roll back.
    const db = shardOf(control, 0);
    const scope = { organizationId, projectId: project.projectId, operationId: input.operationId };
    const proof = await readWorkflowDelegation(db, scope);
    expect(proof).not.toBeNull();
    await expect(
      db.batch([
        db
          .prepare(
            "UPDATE organization_memberships SET role='member' WHERE organization_id=? AND workos_user_id='user_seed'",
          )
          .bind(organizationId),
        ...workflowExecutionGuards(db, scope, proof),
      ]),
    ).rejects.toThrow();
    expect(
      await rows(
        0,
        "SELECT role FROM organization_memberships WHERE organization_id=? AND workos_user_id='user_seed'",
        organizationId,
      ),
    ).toEqual([{ role: "admin" }]);

    // A membership event committed after the effect snapshot is authoritative in the write batch.
    const membership = await db
      .prepare(
        "SELECT role FROM organization_memberships WHERE organization_id=? AND workos_user_id='user_seed'",
      )
      .bind(organizationId)
      .first<{ role: string }>();
    if (!membership) throw new Error("Membership fixture missing");
    const effect = db
      .prepare(
        "UPDATE organization_memberships SET role='member' WHERE organization_id=? AND workos_user_id='user_seed'",
      )
      .bind(organizationId);
    await db.batch([
      effect,
      db
        .prepare(
          "UPDATE organization_memberships SET role=?1 WHERE organization_id=?2 AND workos_user_id='user_seed'",
        )
        .bind(membership.role, organizationId),
    ]);
    const beforeBarrier = await readWorkflowDelegation(db, scope);
    await db
      .prepare(
        "INSERT INTO workos_membership_sync_barriers(organization_id,workos_user_id,source_event_id,event_created_at,reconciled_at) VALUES(?1,'user_seed','effect-barrier','2026-10-28T11:00:00.000000Z',NULL)",
      )
      .bind(organizationId)
      .run();
    await expect(
      store.identity.assertOperationDelegationCurrent({
        organizationId,
        operationId: input.operationId,
      }),
    ).rejects.toMatchObject({ code: "operation_authorization_changed" });
    await expect(
      db.batch([...workflowExecutionGuards(db, scope, beforeBarrier), effect]),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT role FROM organization_memberships WHERE organization_id=? AND workos_user_id='user_seed'",
        )
        .bind(organizationId)
        .first(),
    ).toEqual(membership);
    expect(
      await db
        .prepare(
          "SELECT reconciled_at FROM workos_membership_sync_barriers WHERE organization_id=? AND workos_user_id='user_seed'",
        )
        .bind(organizationId)
        .first(),
    ).toEqual({ reconciled_at: null });
    await db
      .prepare(
        "UPDATE workos_membership_sync_barriers SET reconciled_at='2026-10-28T11:00:01.000000Z' WHERE organization_id=? AND workos_user_id='user_seed'",
      )
      .bind(organizationId)
      .run();
    await expect(
      store.identity.assertOperationDelegationCurrent({
        organizationId,
        operationId: input.operationId,
      }),
    ).resolves.toBeUndefined();

    // A committed organization deletion must fence already accepted work before reconciliation.
    const deletedOrganization = await seedOrganization(store, 2, 0);
    const deletedProject = projectInput(deletedOrganization, "deleted-workspace-effect");
    await store.projects.createInitialProject(deletedProject);
    const deletedGrant = await seedGrant(deletedOrganization, 0, deletedProject, true);
    const deletedInput = acceptInput(deletedProject, {
      principalId: "user:user_seed",
      delegation: { ...delegation, grantId: deletedGrant },
      idempotencyKey: "accepted-before-organization-deletion",
    });
    expect(await store.operations.acceptApiOperation(deletedInput)).toMatchObject({
      outcome: "created",
    });
    const deletedScope = {
      organizationId: deletedOrganization,
      projectId: deletedProject.projectId,
      operationId: deletedInput.operationId,
    };
    const beforeDeletion = await readWorkflowDelegation(db, deletedScope);
    expect(beforeDeletion).not.toBeNull();
    await expect(
      db.batch(workflowExecutionGuards(db, deletedScope, beforeDeletion)),
    ).resolves.toBeDefined();
    const deletedMapping = await db
      .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?")
      .bind(deletedOrganization)
      .first<{ workos_organization_id: string }>();
    if (!deletedMapping) throw new Error("Organization mapping fixture missing");
    await store.identity.recordTerminalRevocation({
      kind: "organization",
      workosOrganizationId: deletedMapping.workos_organization_id,
      sourceEventId: "terminal-deletion-between-snapshot-and-effect",
      effectiveAt: "2026-10-28T11:00:02.000Z",
    });
    await expect(
      store.identity.assertOperationDelegationCurrent({
        organizationId: deletedOrganization,
        operationId: deletedInput.operationId,
      }),
    ).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    await expect(
      db.batch([
        ...workflowExecutionGuards(db, deletedScope, beforeDeletion),
        db
          .prepare(
            "UPDATE organization_memberships SET role='member' WHERE organization_id=? AND workos_user_id='user_seed'",
          )
          .bind(deletedOrganization),
      ]),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT o.state,m.role FROM organizations o JOIN organization_memberships m USING(organization_id) WHERE o.organization_id=? AND m.workos_user_id='user_seed'",
        )
        .bind(deletedOrganization)
        .first(),
    ).toEqual({ state: "active", role: "admin" });
    expect(
      await db
        .prepare("SELECT kind FROM revocations WHERE resource_id=?")
        .bind(deletedMapping.workos_organization_id)
        .first(),
    ).toEqual({ kind: "organization" });
    await expect(
      store.identity.assertOperationDelegationCurrent({
        organizationId,
        operationId: input.operationId,
      }),
    ).resolves.toBeUndefined();

    // A different user cannot use the accepted connection proof.
    const noPublish = await seedGrant(organizationId, 0, project, false).catch(() => null); // unique consent scope: refused by the schema
    expect(noPublish).toBeNull();
    const prod = acceptInput(project, {
      environmentId: project.productionEnvironmentId,
      delegation,
      principalId: "user:user_other",
      idempotencyKey: "other-user",
    });
    await expect(store.operations.acceptApiOperation(prod)).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    expect(
      await rows(0, "SELECT 1 FROM operations WHERE operation_id = ?", prod.operationId),
    ).toHaveLength(0);

    // Revoking the consent invalidates the queued operation and blocks a replay.
    await shardOf(control, 0)
      .prepare(
        "UPDATE mcp_client_grants SET revoked_at = '2026-10-28T11:30:00.000000Z' WHERE grant_id = ?",
      )
      .bind(grantId)
      .run();
    await expect(
      store.identity.assertOperationDelegationCurrent({
        organizationId,
        operationId: input.operationId,
      }),
    ).rejects.toMatchObject({ code: "operation_authorization_changed" });
    await expect(store.operations.acceptApiOperation(input)).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    // A user revoked in the global directory is refused before any shard write.
    await control.directory
      .prepare(
        "INSERT INTO revocations(kind, resource_id, source_event_id, effective_at) VALUES ('user', 'user_seed', 'evt-revoke', '2026-10-28T11:40:00.000000Z')",
      )
      .run();
    const later = acceptInput(project, { delegation, idempotencyKey: "after-user-revocation" });
    await expect(store.operations.acceptApiOperation(later)).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    expect(
      await rows(
        0,
        "SELECT 1 FROM api_idempotency_records WHERE idempotency_key = 'after-user-revocation'",
      ),
    ).toHaveLength(0);
  });
});

describe("provider inbox", () => {
  it("parks an event until its owner exists, then claims, fails over to a retry and acknowledges it exactly once", async () => {
    const organizationId = await organizationIdWithShard(2, 0, 800_000);
    const event = {
      provider: "workos",
      inboxEventId: newUlid(),
      externalEventId: "evt_1",
      eventType: "organization_membership.created",
      payload: { workosOrganizationId: "org_inbox" },
      bodyDigest: digest(11),
      receivedAt: "2026-10-28T10:00:00.000Z",
      signatureTimestamp: "2026-10-28T10:00:00.000Z",
      maxAttempts: 3,
      routing: { kind: "workos_organization", workosOrganizationId: "org_inbox" },
    };
    // Retained legacy buffer fixture. New ingress never creates this prototype row.
    await control.core
      .prepare(
        `INSERT INTO inbox_unrouted(inbox_event_id,provider,external_event_id,routing_key,event_type,payload,body_sha256,received_at,purge_after,max_attempts,signature_timestamp) VALUES (?1,'workos',?2,'org_inbox',?3,?4,unhex(?5),'2026-10-28T10:00:00.000000Z','2026-11-01T10:00:00.000000Z',3,'2026-10-28T10:00:00.000000Z')`,
      )
      .bind(
        event.inboxEventId,
        event.externalEventId,
        event.eventType,
        JSON.stringify(event.payload),
        event.bodyDigest,
      )
      .run();
    expect(await store.operations.recordInboxEvent(event)).toEqual({
      outcome: "existing",
      routed: "unrouted",
    });
    expect(await store.operations.recordInboxEvent(event)).toEqual({
      outcome: "existing",
      routed: "unrouted",
    });
    await expect(
      store.operations.recordInboxEvent({ ...event, bodyDigest: digest(12) }),
    ).rejects.toMatchObject({ code: "webhook_inbox_content_conflict" });
    await store.identity.applyOrganizationSnapshot({
      organizationId,
      workosOrganizationId: "org_inbox",
      state: "active",
      snapshotDigest: digest(21),
      snapshotFetchedAt: "2026-10-28T09:00:00.000Z",
      synchronizedAt: "2026-10-28T09:00:00.000Z",
      triggerEventId: "evt_seed",
      memberships: [],
      auditEventId: newUlid(),
    });
    expect(await store.maintenance.routeUnroutedInboxEvents({ limit: 10 })).toBe(1);
    expect(await store.operations.recordInboxEvent(event)).toEqual({
      outcome: "existing",
      routed: "shard",
    });

    const claim = (claimId: string, at: string, leaseSeconds = 60) => ({
      shardId: 0,
      provider: "workos",
      claimId,
      claimedAt: at,
      leaseExpiresAt: new Date(Date.parse(at) + leaseSeconds * 1000).toISOString(),
    });
    const [a, b] = [newUlid(), newUlid()];
    const claims = await Promise.all(
      [a, b].map((id) => store.maintenance.claimInboxEvent(claim(id, "2026-10-28T10:01:00.000Z"))),
    );
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    const held = claims.find((c) => c !== null) as { claimId: string; inboxEventId: string };
    const key = {
      organizationId,
      provider: "workos",
      inboxEventId: held.inboxEventId,
      claimId: held.claimId,
    };
    // A stranger with the right event id but another organization cannot touch the claim.
    const stranger = await seedOrganization(store, 2, 0);
    expect(
      await store.operations.acknowledgeInboxEvent({
        ...key,
        organizationId: stranger,
        acknowledgedAt: "2026-10-28T10:01:10.000Z",
      }),
    ).toBe(false);
    expect(
      await store.operations.failInboxEvent({
        ...key,
        failedAt: "2026-10-28T10:01:20.000Z",
        errorCode: "WORKOS_FETCH_FAILED",
        nextAvailableAt: "2026-10-28T10:02:00.000Z",
      }),
    ).toBe("retry");
    expect(
      await store.operations.acknowledgeInboxEvent({
        ...key,
        acknowledgedAt: "2026-10-28T10:01:30.000Z",
      }),
    ).toBe(false); // claim is gone
    const second = newUlid();
    expect(
      await store.maintenance.claimInboxEvent(claim(second, "2026-10-28T10:01:30.000Z")),
    ).toBeNull(); // retry not yet due
    expect(
      await store.maintenance.claimInboxEvent(claim(second, "2026-10-28T10:02:00.000Z")),
    ).toMatchObject({ attemptNumber: 2 });
    expect(
      await store.operations.acknowledgeInboxEvent({
        ...key,
        claimId: second,
        acknowledgedAt: "2026-10-28T10:02:10.000Z",
      }),
    ).toBe(true);
    expect(
      await store.operations.acknowledgeInboxEvent({
        ...key,
        claimId: second,
        acknowledgedAt: "2026-10-28T10:02:11.000Z",
      }),
    ).toBe(false);
  });
});
