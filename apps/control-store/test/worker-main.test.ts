import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import type { ControlRuntime, MaintenanceRuntime } from "../src/worker-main.js";
import {
  createTestControl,
  organizationIdWithShard,
  shardOf,
  type TestControl,
} from "./support/control-d1.js";
import { seedAcceptedOperation } from "./support/accepted-operation.js";
import { acceptInput, digest, projectInput } from "./support/seed.js";

/**
 * Only the `cloudflare:workers` base class is replaced; the entrypoints, the store, the catalog commands and the
 * D1 databases (workerd's engine through Miniflare, migrated with the checked-in SQL) are the production code.
 */
const state = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = state.env;
  },
}));

let control: TestControl;
let runtime: InstanceType<typeof ControlRuntime>;
let maintenance: InstanceType<typeof MaintenanceRuntime>;
// A shard-wide drain claims the oldest due work of the whole partition, and there is exactly one partition:
// every test therefore starts on its own empty core (a fresh core applies every migration, so the hook gets a
// timeout that a loaded machine can meet).
beforeEach(async () => {
  control = await createTestControl(2);
  state.env = control.bindings;
  const entry = await import("../src/worker-main.js");
  runtime = new (entry.ControlRuntime as unknown as new () => typeof runtime)();
  maintenance = new (entry.MaintenanceRuntime as unknown as new () => typeof maintenance)();
  expect(maintenance).not.toHaveProperty("purgeAcknowledgedOutbox");
  expect(maintenance).not.toHaveProperty("purgeEvidenceBelowHorizon");
}, 60_000);
afterEach(async () => control.dispose());

const rows = async <Row>(shard: number, sql: string, ...binds: unknown[]) =>
  (
    await shardOf(control, shard)
      .prepare(sql)
      .bind(...binds)
      .all<Row>()
  ).results;
const directoryRows = async <Row>(sql: string, ...binds: unknown[]) =>
  (
    await control.directory
      .prepare(sql)
      .bind(...binds)
      .all<Row>()
  ).results;
/** The refusal of a call, whether the entrypoint throws it synchronously or rejects. */
const refused = (call: () => unknown) => expect((async () => call())()).rejects;

it("offers exact-scope SQL access history without provider or global maintenance authority", async () => {
  expect(
    await runtime.readProjectDatabaseAccessHistory({
      organizationId: newUlid(),
      projectId: newUlid(),
      now: "2026-10-28T10:00:00.000Z",
    }),
  ).toEqual({ items: [] });
  await refused(() =>
    runtime.readProjectDatabaseAccessHistory({
      organizationId: newUlid(),
      projectId: newUlid(),
      now: "invalid",
    }),
  ).toThrow();
});

async function onboard(shard: number, seed: number, workosOrganizationId: string, tag: number) {
  const organizationId = await organizationIdWithShard(2, shard, seed);
  await expect(
    runtime.applyWorkosOrganizationSnapshot({
      organizationId,
      workosOrganizationId,
      state: "active",
      snapshotDigest: digest(tag),
      snapshotFetchedAt: "2026-10-28T09:00:00.000Z",
      synchronizedAt: "2026-10-28T09:00:00.000Z",
      triggerEventId: "evt_onboard",
      memberships: [],
      auditEventId: newUlid(),
    }),
  ).resolves.toEqual({
    organizationId,
    organizationChanged: true,
    changedMemberships: 0,
    ignoredAfterDeletion: false,
  });
  return organizationId;
}

/** The workflow rows an accepted operation has once its outbox event was delivered: intent, run and (optionally) claim. */
async function seedWorkflow(
  shard: number,
  project: ReturnType<typeof projectInput>,
  accepted: ReturnType<typeof acceptInput>,
  claim: boolean,
) {
  const seeded = await seedAcceptedOperation(
    { ...project, shard: shardOf(control, shard) },
    accepted.environmentId,
    {
      operationId: accepted.operationId,
      eventId: accepted.outboxEventId,
      claim,
      at: "2026-10-28T11:00:00.000000Z",
    },
  );
  return seeded.workflowId;
}

const transition = (
  project: ReturnType<typeof projectInput>,
  operationId: string,
  type: string,
  expectedState: string,
  eventCount: number,
  occurredAt: string,
) => ({
  organizationId: project.organizationId,
  operationId,
  expected: { state: expectedState, eventCount },
  event: { eventId: newUlid(), type, idempotencyKey: `${type}-${operationId}`, occurredAt },
  audit: {
    auditEventId: newUlid(),
    projectId: project.projectId,
    operationId,
    eventType: type,
    actorType: "system",
    actorId: "workflow",
    payload: {},
    occurredAt,
  },
});

describe("Worker entrypoints on real D1", () => {
  it("creates a project and runs an operation to an abandoned lease through ControlRuntime, with the shard-wide reapers only on MaintenanceRuntime", async () => {
    const organizationId = await onboard(0, 9100, "org_flow1", 101);
    const project = projectInput(organizationId, "entry-project");
    expect(await runtime.createInitialProject(project)).toEqual({
      outcome: "created",
      projectId: project.projectId,
      operationId: project.operation.operationId,
    });
    expect(
      await rows(
        0,
        "SELECT handle, lifecycle_state FROM projects WHERE project_id = ?",
        project.projectId,
      ),
    ).toEqual([{ handle: "entry-project", lifecycle_state: "active" }]);
    expect(
      await directoryRows(
        "SELECT state FROM project_directory WHERE project_id = ?",
        project.projectId,
      ),
    ).toEqual([{ state: "active" }]);

    // A reservation whose creator vanished is closed by the scheduler's resolver, and the late creator is refused.
    const abandoned = projectInput(organizationId, "entry-abandoned");
    await control.directory
      .prepare(
        "INSERT INTO project_directory(project_id, organization_id, handle, state, reserved_until, created_at) VALUES (?, ?, ?, 'reserved', '2026-10-28T10:15:00.000000Z', '2026-10-28T10:00:00.000000Z')",
      )
      .bind(abandoned.projectId, organizationId, abandoned.projectHandle)
      .run();
    expect(
      await maintenance.resolveProjectReservations({ now: "2026-10-28T10:16:00.000Z", limit: 10 }),
    ).toEqual({ activated: 0, released: 1 });
    expect(
      await rows(
        0,
        "SELECT organization_id FROM project_creation_aborts WHERE project_id = ?",
        abandoned.projectId,
      ),
    ).toEqual([{ organization_id: organizationId }]);
    await refused(() => runtime.createInitialProject(abandoned)).toMatchObject({
      code: "project_reservation_expired",
    });

    // Accept, replay and read back through the receipt and the audit feed.
    const accepted = acceptInput(project);
    expect(await runtime.acceptApiOperation(accepted)).toEqual({
      outcome: "created",
      operationId: accepted.operationId,
    });
    expect(
      await runtime.acceptApiOperation({ ...acceptInput(project), idempotencyKey: "key-1" }),
    ).toEqual({
      outcome: "replayed",
      operationId: accepted.operationId,
    });
    expect(
      await runtime.readStoredIdempotencyResponse({
        organizationId,
        principalId: accepted.principalId,
        httpMethod: accepted.httpMethod,
        routeTemplate: accepted.routeTemplate,
        idempotencyKey: accepted.idempotencyKey,
      }),
    ).toEqual({
      httpStatus: 202,
      responseHeaders: { Location: `/v1/operations/${accepted.operationId}` },
      responseBody: { operation_id: accepted.operationId },
    });
    const feed = await runtime.readAuditEvents({ organizationId, limit: 10 });
    expect(feed.events.map((event) => event.eventType).sort()).toEqual([
      "DeploymentRequestedV1",
      "ProjectCreated",
    ]);

    // A second queued operation waits behind the first one's provider-mutation claim.
    const queuedId = newUlid();
    const queued = {
      organizationId,
      billingEpochId: project.billingEpochId,
      operation: {
        operationId: queuedId,
        projectId: project.projectId,
        eventId: newUlid(),
        occurredAt: "2026-10-28T11:01:00.000Z",
      },
      audit: {
        auditEventId: newUlid(),
        projectId: project.projectId,
        operationId: queuedId,
        eventType: "OperationQueued",
        actorType: "system",
        actorId: "workflow",
        payload: {},
        occurredAt: "2026-10-28T11:01:00.000Z",
      },
      outbox: {
        eventId: newUlid(),
        eventType: "DeploymentRequestedV1",
        createdAt: "2026-10-28T11:01:00.000Z",
        maxAttempts: 5,
      },
    };
    expect(await runtime.queueOperation(queued)).toBe("created");
    const workflowId = await seedWorkflow(0, project, accepted, true);
    expect(
      await runtime.readBlockingProductOperation({ organizationId, operationId: queuedId }),
    ).toBe(accepted.operationId);

    // Start the accepted operation and keep its lease alive; only the run's own physical workflow may renew it.
    const loaded = await runtime.loadOperation({
      organizationId,
      operationId: accepted.operationId,
    });
    expect(loaded).toMatchObject({ state: "queued", leaseExpiresAt: null });
    expect(loaded?.events.map((event) => event.type)).toEqual(["OperationQueued"]);
    expect(
      await runtime.transitionOperation(
        transition(
          project,
          accepted.operationId,
          "OperationStarted",
          "queued",
          1,
          "2026-10-28T12:00:00.000Z",
        ),
      ),
    ).toEqual({ outcome: "applied", state: "running", eventCount: 2 });
    const renew = (physicalWorkflowId: string) =>
      runtime.renewOperationLease({
        organizationId,
        operationId: accepted.operationId,
        workflowId,
        physicalWorkflowId,
        now: "2026-10-28T12:05:00.000Z",
        durationMilliseconds: 900_000,
      });
    await refused(() => renew("another-physical-workflow")).toMatchObject({
      code: "operation_lease_inactive",
    });
    await renew(workflowId);
    expect(
      await runtime.loadOperation({ organizationId, operationId: accepted.operationId }),
    ).toMatchObject({
      state: "running",
      leaseExpiresAt: "2026-10-28T12:20:00.000Z",
    });

    // The ordinary form refuses "any expired operation" and changes nothing; one exact captured execution recovers.
    await refused(() =>
      runtime.recoverExpiredOperationLease({ now: "2026-10-28T12:30:00.000Z", shardId: 0 }),
    ).toThrow("maintenance command");
    expect(
      await rows(0, "SELECT state FROM operations WHERE operation_id = ?", accepted.operationId),
    ).toEqual([{ state: "running" }]);
    expect(
      await runtime.recoverExpiredOperationLease({
        now: "2026-10-28T12:30:00.000Z",
        exactOperation: {
          organizationId,
          projectId: project.projectId,
          operationId: accepted.operationId,
          leaseExpiresAt: "2026-10-28T12:20:00.000Z",
        },
      }),
    ).toEqual({ organizationId, operationId: accepted.operationId, releaseBuildCredits: true });
    const failed = await runtime.loadOperation({
      organizationId,
      operationId: accepted.operationId,
    });
    expect(failed).toMatchObject({
      state: "failed",
      failure: { code: "OPERATION_ABANDONED" },
      leaseExpiresAt: null,
    });
    expect(failed?.events.map((event) => event.type)).toEqual([
      "OperationQueued",
      "OperationStarted",
      "OperationFailed",
    ]);
    expect(
      await rows(
        0,
        "SELECT 1 AS held FROM product_provider_mutation_claims WHERE operation_id = ?",
        accepted.operationId,
      ),
    ).toEqual([]);
    expect(
      await rows(
        0,
        "SELECT last_error_code, reconciliation_required_at IS NOT NULL AS parked FROM outbox_events WHERE event_id = ?",
        accepted.outboxEventId,
      ),
    ).toEqual([{ last_error_code: "OPERATION_ABANDONED", parked: 1 }]);
    expect(
      await runtime.readBlockingProductOperation({ organizationId, operationId: queuedId }),
    ).toBeNull();

    // The scheduler's shard-wide reaper recovers the next abandoned execution, once.
    const second = acceptInput(project, { idempotencyKey: "key-2" });
    await runtime.acceptApiOperation(second);
    await seedWorkflow(0, project, second, false);
    await runtime.transitionOperation(
      transition(
        project,
        second.operationId,
        "OperationStarted",
        "queued",
        1,
        "2026-10-28T12:00:00.000Z",
      ),
    );
    expect(
      await maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:30:00.000Z",
        shardId: 0,
      }),
    ).toEqual({ organizationId, operationId: second.operationId, releaseBuildCredits: true });
    expect(
      await maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:30:00.000Z",
        shardId: 0,
      }),
    ).toBeNull();
    expect(
      await runtime.loadOperation({ organizationId, operationId: second.operationId }),
    ).toMatchObject({
      state: "failed",
    });
    const audit = await runtime.readAuditEvents({ organizationId, limit: 100 });
    expect(
      audit.events.filter(
        (event) =>
          event.actorId === "operation-lease-sweeper" && event.eventType === "OperationFailed",
      ),
    ).toHaveLength(2);
  }, 60_000);

  it("serves the WorkOS management Worker's eight identity commands through the actual ControlRuntime class and exposes no financial or maintenance authority", async () => {
    const workosOrganizationId = "org_flow_workos";
    const organizationId = await onboard(0, 9150, workosOrganizationId, 150);
    const sessionId = "session_flow_workos";
    const userId = "user_flow_workos";
    // The runtime's public surface: the six existing identity methods plus the two new ones, nothing global.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(runtime));
    for (const name of [
      "authorizeUserApiKeyScope",
      "claimUserApiKeyCreation",
      "finishUserApiKeyCreation",
      "readUserApiKeyNames",
      "recordTerminalRevocation",
      "isSessionEligible",
      "readSessionRevocation",
      "recordUserApiKeyRevocationAudit",
    ]) {
      expect(surface).toContain(name);
    }
    expect(
      surface.filter((name) => /credit|billing|entitlement|purge|doorbell/iu.test(name)),
    ).toEqual([]);
    expect(surface).not.toContain("routeUnroutedInboxEvents");

    // Not a member yet: not eligible and no revocation recorded.
    await expect(
      runtime.isSessionEligible({
        sessionId,
        workosUserId: userId,
        workosOrganizationId,
        observedAt: "2026-10-28T09:30:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(runtime.readSessionRevocation({ sessionId })).resolves.toBeNull();

    // The terminal revocation is global; the session read then names its user, once.
    const revoke = {
      kind: "session",
      sessionId,
      workosUserId: userId,
      sourceEventId: "evt_session_revoke",
      effectiveAt: "2026-10-28T09:31:00.000Z",
    };
    await runtime.recordTerminalRevocation(revoke);
    await expect(runtime.readSessionRevocation({ sessionId })).resolves.toEqual({
      workosUserId: userId,
    });
    await refused(() => runtime.readSessionRevocation({ sessionId, extra: 1 })).toMatchObject({
      code: "invalid_request",
    });

    // The key-revocation audit is a closed command: recorded once, an identical repeat is a no-op, a forged
    // organization pair is refused.
    const audit = {
      organizationId,
      workosOrganizationId,
      userId,
      keyId: "api_key_flow1",
      stage: "requested",
      auditEventId: newUlid(),
      now: "2026-10-28T09:32:00.000Z",
    };
    await expect(runtime.recordUserApiKeyRevocationAudit(audit)).resolves.toEqual({
      recorded: true,
    });
    await expect(runtime.recordUserApiKeyRevocationAudit(audit)).resolves.toEqual({
      recorded: true,
    });
    await refused(() =>
      runtime.recordUserApiKeyRevocationAudit({ ...audit, workosOrganizationId: "org_other" }),
    ).toMatchObject({ code: "resource_not_found" });
    expect(
      await rows(
        0,
        "SELECT event_type, actor_id FROM organization_audit_events WHERE audit_event_id = ?",
        audit.auditEventId,
      ),
    ).toEqual([{ event_type: "UserApiKeyRevocationRequested", actor_id: `user:${userId}` }]);

    // The scope commands refuse a user who is not an active member, before any provider work could follow.
    await refused(() =>
      runtime.authorizeUserApiKeyScope({
        organizationId,
        workosOrganizationId,
        userId,
        sessionId: "session_flow_other",
        now: "2026-10-28T09:33:00.000Z",
      }),
    ).toMatchObject({ code: "resource_not_found" });
    await expect(
      runtime.readUserApiKeyNames({ organizationId, userId, keyIds: ["api_key_flow1"] }),
    ).resolves.toEqual(new Map());
  }, 60_000);

  it("settles a delegated operation's outbox events through ControlRuntime and parks final attempts by exact scope or by shard sweep", async () => {
    const organizationId = await onboard(1, 9200, "org_flow2", 102);
    const project = projectInput(organizationId, "entry-delegated");
    await runtime.createInitialProject(project);

    // An effective consent grant admits the delegated operation; revoking it invalidates the queued operation.
    const grantId = crypto.randomUUID();
    const at = "2026-10-28T10:00:00.000000Z";
    const db = shardOf(control, 1);
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
          "INSERT INTO mcp_client_grants(organization_id, grant_id, user_id, client_id, consent_hash, project_id, ownership_version, billing_epoch_id, allow_publish, revision, created_at) VALUES (?1, ?2, 'user_seed', 'client-1', ?3, ?4, 1, ?5, 1, 1, ?6)",
        )
        .bind(organizationId, grantId, digest(5), project.projectId, project.billingEpochId, at),
    ]);
    const accepted = acceptInput(project, {
      idempotencyKey: "delegated",
      delegation: {
        grantId,
        clientId: "client-1",
        consentHash: digest(5),
        action: "deployments:create",
      },
    });
    expect(await runtime.acceptApiOperation(accepted)).toMatchObject({ outcome: "created" });
    expect(
      await rows(
        1,
        "SELECT grant_id, requires_publication FROM operation_mcp_delegations WHERE operation_id = ?",
        accepted.operationId,
      ),
    ).toEqual([{ grant_id: grantId, requires_publication: 0 }]);
    await expect(
      runtime.assertOperationDelegationCurrent({
        organizationId,
        operationId: accepted.operationId,
      }),
    ).resolves.toBeUndefined();
    await db
      .prepare(
        "UPDATE mcp_client_grants SET revoked_at = '2026-10-28T11:30:00.000000Z' WHERE grant_id = ?",
      )
      .bind(grantId)
      .run();
    await refused(() =>
      runtime.assertOperationDelegationCurrent({
        organizationId,
        operationId: accepted.operationId,
      }),
    ).toMatchObject({ code: "operation_authorization_changed" });

    // Claims: the exact event for ControlRuntime, the oldest due event for the shard sweeper; a shard drain through
    // ControlRuntime is refused before anything is leased.
    const eventScope = {
      eventId: accepted.outboxEventId,
      organizationId,
      projectId: project.projectId,
      operationId: accepted.operationId,
    };
    const [first, sweeper, again] = [newUlid(), newUlid(), newUlid()];
    await refused(() =>
      runtime.claimOutboxEvent({
        shardId: 0,
        now: "2026-10-28T12:00:00.000Z",
        leaseMilliseconds: 60_000,
        attemptId: newUlid(),
      }),
    ).toThrow("maintenance command");
    expect(
      await rows(
        1,
        "SELECT attempt_count FROM outbox_events WHERE event_id = ?",
        accepted.outboxEventId,
      ),
    ).toEqual([{ attempt_count: 0 }]);
    expect(
      await runtime.claimOutboxEvent({
        eventScope,
        now: "2026-10-28T12:00:00.000Z",
        leaseMilliseconds: 60_000,
        attemptId: first,
      }),
    ).toMatchObject({
      eventId: accepted.outboxEventId,
      attemptId: first,
      attemptNumber: 1,
      eventType: "DeploymentRequestedV1",
      leaseExpiresAt: "2026-10-28T12:01:00.000Z",
    });
    expect(
      await maintenance.claimOutboxEvent({
        shardId: 0,
        now: "2026-10-28T12:00:00.000Z",
        leaseMilliseconds: 60_000,
        attemptId: sweeper,
      }),
    ).toMatchObject({
      eventId: project.outbox.eventId,
      operationId: project.operation.operationId,
      eventType: "ProjectCreated",
      attemptNumber: 1,
    });

    // A failed attempt is retried later; an uncertain one is parked for the operator; a delivered one is acknowledged.
    expect(
      await runtime.recordOutboxDeliveryFailure({
        organizationId,
        eventId: accepted.outboxEventId,
        attemptId: first,
        errorCode: "PROVIDER_TIMEOUT",
        failedAt: "2026-10-28T12:00:10.000Z",
        nextAvailableAt: "2026-10-28T12:05:00.000Z",
        audit: {
          auditEventId: newUlid(),
          projectId: project.projectId,
          operationId: accepted.operationId,
          eventType: "OutboxRetryScheduled",
          actorType: "system",
          actorId: "outbox",
          payload: {},
          occurredAt: "2026-10-28T12:00:10.000Z",
        },
      }),
    ).toEqual({ outcome: "retry_scheduled", attemptNumber: 1 });
    expect(
      await rows(
        1,
        "SELECT available_at, current_attempt_id FROM outbox_events WHERE event_id = ?",
        accepted.outboxEventId,
      ),
    ).toEqual([{ available_at: "2026-10-28T12:05:00.000000Z", current_attempt_id: null }]);
    expect(
      await runtime.requireOutboxReconciliation({
        organizationId,
        eventId: project.outbox.eventId,
        attemptId: sweeper,
        errorCode: "PROVIDER_UNCERTAIN",
        reconciledAt: "2026-10-28T12:00:20.000Z",
        audit: {
          auditEventId: newUlid(),
          projectId: project.projectId,
          operationId: project.operation.operationId,
          eventType: "OutboxReconciliationRequired",
          actorType: "system",
          actorId: "outbox",
          payload: { providerRequestId: "req-9" },
          occurredAt: "2026-10-28T12:00:20.000Z",
        },
      }),
    ).toEqual({ attemptNumber: 1 });
    expect(
      await rows(
        1,
        "SELECT reconciliation_required_at, last_error_code FROM outbox_events WHERE event_id = ?",
        project.outbox.eventId,
      ),
    ).toEqual([
      {
        reconciliation_required_at: "2026-10-28T12:00:20.000000Z",
        last_error_code: "PROVIDER_UNCERTAIN",
      },
    ]);
    expect(
      await runtime.claimOutboxEvent({
        eventScope,
        now: "2026-10-28T12:06:00.000Z",
        leaseMilliseconds: 60_000,
        attemptId: again,
      }),
    ).toMatchObject({ attemptNumber: 2 });
    expect(
      await runtime.acknowledgeOutboxEvent({
        organizationId,
        eventId: accepted.outboxEventId,
        attemptId: again,
        now: "2026-10-28T12:06:10.000Z",
      }),
    ).toBe(true);
    expect(
      await rows(
        1,
        "SELECT acknowledged_at FROM outbox_events WHERE event_id = ?",
        accepted.outboxEventId,
      ),
    ).toEqual([{ acknowledged_at: "2026-10-28T12:06:10.000000Z" }]);

    // Final attempts whose lease lapsed may have been delivered: parked, never retried.
    const queueOne = async (createdAt: string) => {
      const operationId = newUlid();
      const outboxEventId = newUlid();
      await runtime.queueOperation({
        organizationId,
        billingEpochId: project.billingEpochId,
        operation: {
          operationId,
          projectId: project.projectId,
          eventId: newUlid(),
          occurredAt: createdAt,
        },
        audit: {
          auditEventId: newUlid(),
          projectId: project.projectId,
          operationId,
          eventType: "OperationQueued",
          actorType: "system",
          actorId: "workflow",
          payload: {},
          occurredAt: createdAt,
        },
        outbox: {
          eventId: outboxEventId,
          eventType: "DeploymentRequestedV1",
          createdAt,
          maxAttempts: 1,
        },
      });
      const scope = {
        eventId: outboxEventId,
        organizationId,
        projectId: project.projectId,
        operationId,
      };
      await runtime.claimOutboxEvent({
        eventScope: scope,
        now: createdAt,
        leaseMilliseconds: 10_000,
        attemptId: newUlid(),
      });
      return scope;
    };
    const oldest = await queueOne("2026-10-28T12:10:00.000Z");
    const newest = await queueOne("2026-10-28T12:10:01.000Z");
    const recovery = (auditEventId: string, extra: Record<string, unknown>) => ({
      now: "2026-10-28T12:11:00.000Z",
      auditEventId,
      actorType: "system",
      actorId: "outbox-sweeper",
      ...extra,
    });
    await refused(() =>
      runtime.recoverExpiredFinalOutboxLease(recovery(newUlid(), { shardId: 0 })),
    ).toThrow("maintenance command");
    expect(
      await maintenance.recoverExpiredFinalOutboxLease(recovery(newUlid(), { shardId: 0 })),
    ).toMatchObject({ eventId: oldest.eventId, attemptNumber: 1 });
    expect(
      await runtime.recoverExpiredFinalOutboxLease(recovery(newUlid(), { eventScope: newest })),
    ).toMatchObject({ eventId: newest.eventId, attemptNumber: 1 });
    expect(
      await rows(
        1,
        "SELECT last_error_code FROM outbox_events WHERE event_id IN (?, ?) AND reconciliation_required_at IS NOT NULL",
        oldest.eventId,
        newest.eventId,
      ),
    ).toEqual([
      { last_error_code: "FINAL_ATTEMPT_LEASE_EXPIRED" },
      { last_error_code: "FINAL_ATTEMPT_LEASE_EXPIRED" },
    ]);
    expect(
      await maintenance.recoverExpiredFinalOutboxLease(recovery(newUlid(), { shardId: 0 })),
    ).toBeNull();
  }, 60_000);

  it("routes, claims, retries, renews and parks provider events and re-arms the doorbells through the two entrypoints", async () => {
    // A WorkOS event of an owner the directory does not know yet waits in the global table...
    const workosEvent = {
      provider: "workos",
      inboxEventId: newUlid(),
      externalEventId: "evt_flow3",
      eventType: "organization_membership.created",
      payload: { workosOrganizationId: "org_flow3" },
      bodyDigest: digest(111),
      receivedAt: "2026-10-28T10:00:00.000Z",
      signatureTimestamp: "2026-10-28T10:00:00.000Z",
      maxAttempts: 10,
      routing: { kind: "workos_organization", workosOrganizationId: "org_flow3" },
    };
    // Explicit retained prototype fixture: new ingress writes canonical global rows directly.
    await control.core
      .prepare(
        `INSERT INTO inbox_unrouted(inbox_event_id,provider,external_event_id,routing_key,event_type,payload,body_sha256,received_at,purge_after,max_attempts,signature_timestamp) VALUES (?1,'workos',?2,'org_flow3',?3,?4,unhex(?5),'2026-10-28T10:00:00.000000Z','2026-11-01T10:00:00.000000Z',10,'2026-10-28T10:00:00.000000Z')`,
      )
      .bind(
        workosEvent.inboxEventId,
        workosEvent.externalEventId,
        workosEvent.eventType,
        JSON.stringify(workosEvent.payload),
        workosEvent.bodyDigest,
      )
      .run();
    const organizationId = await onboard(1, 9300, "org_flow3", 103);
    // ...and moves into the owner's shard when the scheduler routes it.
    expect(await maintenance.routeUnroutedInboxEvents({ limit: 10 })).toBe(1);
    expect(
      await directoryRows(
        "SELECT 1 AS left FROM inbox_unrouted WHERE external_event_id = 'evt_flow3'",
      ),
    ).toEqual([]);
    expect(
      await rows(
        1,
        "SELECT state, organization_id FROM webhook_inbox WHERE external_event_id = 'evt_flow3'",
      ),
    ).toEqual([{ state: "pending", organization_id: organizationId }]);

    const github = (
      externalEventId: string,
      receivedAt: string,
      maxAttempts: number,
      tag: number,
    ) => ({
      provider: "github",
      inboxEventId: newUlid(),
      externalEventId,
      eventType: "push",
      payload: { repository: "r" },
      bodyDigest: digest(tag),
      receivedAt,
      maxAttempts,
      routing: { kind: "organization", organizationId },
    });
    const finalOne = github("delivery-final", "2026-10-28T10:00:00.000Z", 1, 112);
    const ordinary = github("delivery-ordinary", "2026-10-28T10:00:30.000Z", 3, 113);
    expect(
      await createControlStore(control.bindings).operations.recordInboxEvent(finalOne),
    ).toEqual({
      outcome: "created",
      routed: "shard",
    });
    expect(
      await createControlStore(control.bindings).operations.recordInboxEvent(ordinary),
    ).toEqual({
      outcome: "created",
      routed: "shard",
    });
    expect(
      await createControlStore(control.bindings).operations.recordInboxEvent(finalOne),
    ).toEqual({
      outcome: "existing",
      routed: "shard",
    });

    // The WorkOS event is claimed by the shard sweeper, fails, and waits for its retry.
    const [claimWorkos, claimFinal, claimOrdinary] = [newUlid(), newUlid(), newUlid()];
    const workos = await maintenance.claimInboxEvent({
      shardId: 0,
      provider: "workos",
      claimId: claimWorkos,
      claimedAt: "2026-10-28T10:01:00.000Z",
      leaseExpiresAt: "2026-10-28T10:03:00.000Z",
    });
    expect(workos).toMatchObject({
      externalEventId: "evt_flow3",
      attemptNumber: 1,
      maxAttempts: 10,
    });
    expect(
      await runtime.failInboxEvent({
        organizationId,
        provider: "workos",
        inboxEventId: workos?.inboxEventId,
        claimId: claimWorkos,
        failedAt: "2026-10-28T10:01:20.000Z",
        errorCode: "WORKOS_FETCH_FAILED",
        nextAvailableAt: "2026-10-28T10:02:00.000Z",
      }),
    ).toBe("retry");

    // A shard drain through ControlRuntime is refused and leases nothing; the sweeper takes the final-attempt event.
    await refused(() =>
      runtime.claimInboxEvent({
        shardId: 0,
        provider: "github",
        claimId: newUlid(),
        claimedAt: "2026-10-28T10:01:00.000Z",
        leaseExpiresAt: "2026-10-28T10:01:30.000Z",
      }),
    ).toThrow("maintenance command");
    expect(
      await rows(1, "SELECT state FROM webhook_inbox WHERE external_event_id = 'delivery-final'"),
    ).toEqual([{ state: "pending" }]);
    const final = await maintenance.claimInboxEvent({
      shardId: 0,
      provider: "github",
      claimId: claimFinal,
      claimedAt: "2026-10-28T10:01:00.000Z",
      leaseExpiresAt: "2026-10-28T10:01:30.000Z",
    });
    expect(final).toMatchObject({
      externalEventId: "delivery-final",
      attemptNumber: 1,
      maxAttempts: 1,
    });

    // The ordinary event is claimed for the exact organization, kept alive and acknowledged.
    const ordinaryClaim = await runtime.claimInboxEvent({
      organizationId,
      provider: "github",
      claimId: claimOrdinary,
      claimedAt: "2026-10-28T10:01:05.000Z",
      leaseExpiresAt: "2026-10-28T10:02:05.000Z",
    });
    expect(ordinaryClaim).toMatchObject({ externalEventId: "delivery-ordinary" });
    const held = {
      organizationId,
      provider: "github",
      inboxEventId: ordinaryClaim?.inboxEventId,
      claimId: claimOrdinary,
    };
    expect(
      await runtime.renewInboxLease({
        ...held,
        renewedAt: "2026-10-28T10:01:10.000Z",
        leaseExpiresAt: "2026-10-28T10:03:00.000Z",
      }),
    ).toBe(true);
    expect(
      await runtime.acknowledgeInboxEvent({ ...held, acknowledgedAt: "2026-10-28T10:01:20.000Z" }),
    ).toBe(true);
    expect(
      await rows(
        1,
        "SELECT state, acknowledged_at FROM webhook_inbox WHERE external_event_id = 'delivery-ordinary'",
      ),
    ).toEqual([{ state: "acknowledged", acknowledged_at: "2026-10-28T10:01:20.000000Z" }]);

    // The final attempt's lease lapsed without an outcome: found by the sweeper or by organization, then parked once.
    const lapsed = { provider: "github", observedAt: "2026-10-28T10:02:00.000Z" };
    await refused(() => runtime.findExpiredFinalInboxClaim({ shardId: 0, ...lapsed })).toThrow(
      "maintenance command",
    );
    expect(await maintenance.findExpiredFinalInboxClaim({ shardId: 0, ...lapsed })).toMatchObject({
      inboxEventId: final?.inboxEventId,
      claimId: claimFinal,
    });
    expect(await runtime.findExpiredFinalInboxClaim({ organizationId, ...lapsed })).toMatchObject({
      inboxEventId: final?.inboxEventId,
    });
    const park = {
      organizationId,
      provider: "github",
      inboxEventId: final?.inboxEventId,
      claimId: claimFinal,
      recoveredAt: "2026-10-28T10:02:00.000Z",
      errorCode: "FINAL_ATTEMPT_LEASE_EXPIRED",
    };
    expect(await runtime.recoverExpiredFinalInboxLease(park)).toBe(true);
    expect(await runtime.recoverExpiredFinalInboxLease(park)).toBe(false);
    expect(
      await rows(
        1,
        "SELECT state, last_error_code FROM webhook_inbox WHERE external_event_id = 'delivery-final'",
      ),
    ).toEqual([
      { state: "reconciliation_required", last_error_code: "FINAL_ATTEMPT_LEASE_EXPIRED" },
    ]);

    // The doorbells: the sweeper claims the overdue inbox bell once and re-arms it for the pending retry; healing
    // restores the bell of pending work.
    const token = newUlid();
    const claimed = await maintenance.claimDoorbells({
      now: "2026-10-28T13:00:00.000Z",
      limit: 64,
      claimToken: token,
    });
    expect(claimed).toContainEqual(expect.objectContaining({ kind: "inbox", shardId: 0 }));
    expect(
      await maintenance.settleDoorbell({ kind: "inbox", shardId: 0, claimToken: token }),
    ).toEqual({
      settled: true,
      nextDueAt: "2026-10-28T10:02:00.000000Z",
    });
    expect(
      await directoryRows(
        "SELECT due_at, claim_token FROM work_due WHERE kind = 'inbox' AND shard_id = 0",
      ),
    ).toEqual([{ due_at: "2026-10-28T10:02:00.000000Z", claim_token: null }]);
    await control.directory
      .prepare("DELETE FROM work_due WHERE kind = 'inbox' AND shard_id = 0")
      .run();
    expect((await maintenance.healDoorbells({ shardId: 0 })).rung).toContain("inbox");
    expect(
      await directoryRows("SELECT due_at FROM work_due WHERE kind = 'inbox' AND shard_id = 0"),
    ).toEqual([{ due_at: "2026-10-28T10:02:00.000000Z" }]);
  }, 60_000);
});
