import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acceptApiOperationInput,
  acceptStatements,
} from "../src/catalog/operations/accept-api-operation.js";
import { purgeReconciliationInbox } from "../src/catalog/operations/retention.js";
import { bucketOf } from "../src/router.js";
import { createControlStore } from "../src/store.js";
import { newUlid, hexBytes } from "../src/catalog/common.js";
import { coreRouter, createTestControl, shardOf, type TestControl } from "./support/control-d1.js";
import {
  deploymentIntent,
  promotionIntent,
  rollbackIntent,
  seedAcceptedOperation,
  seedDeletionIntent,
  seedIntent,
  seedOperation,
  type IntentColumns,
  type IntentEventType,
} from "./support/accepted-operation.js";
import { seedWfpPublication } from "./support/provider-fixtures.js";
import { acceptInput, digest, projectInput, seedOrganization, type Store } from "./support/seed.js";

let control: TestControl;
let store: Store;
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

const AT = "2026-10-28T11:00:00.000000Z";
const rows = async <Row>(shard: number, sql: string, ...binds: unknown[]) =>
  (
    await shardOf(control, shard)
      .prepare(sql)
      .bind(...binds)
      .all<Row>()
  ).results;
const run = async (shard: number, sql: string, ...binds: unknown[]) =>
  shardOf(control, shard)
    .prepare(sql)
    .bind(...binds)
    .run();

async function seedProject(shard: number, handle: string) {
  const organizationId = await seedOrganization(store, 2, shard);
  const project = projectInput(organizationId, handle);
  await store.projects.createInitialProject(project);
  return project;
}
type Project = Awaited<ReturnType<typeof seedProject>>;

/** An accepted operation with the run, intent and (optionally) the provider claim an executing Workflow has. */
async function seedExecuting(
  shard: number,
  project: Project,
  key: string,
  claim: boolean,
  at = AT,
) {
  const accepted = acceptInput(project, { idempotencyKey: key, occurredAt: at });
  await store.operations.acceptApiOperation(accepted);
  const db = shardOf(control, shard);
  const { claimId } = await seedAcceptedOperation(
    { ...project, shard: db },
    accepted.environmentId,
    {
      operationId: accepted.operationId,
      eventId: accepted.outboxEventId,
      claim,
      at,
    },
  );
  await db
    .prepare(
      "UPDATE operations SET lease_expires_at = '2026-10-28T11:15:00.000000Z' WHERE organization_id = ?1 AND operation_id = ?2",
    )
    .bind(project.organizationId, accepted.operationId)
    .run();
  return { accepted, claimId };
}

const reserveNeon = async (
  shard: number,
  project: Project,
  executing: { accepted: { operationId: string; environmentId: string }; claimId: string },
  reservedAt = AT,
) => {
  const physical = await shardOf(control, shard)
    .prepare(
      "SELECT data_environment_id FROM environment_data_assignments WHERE organization_id=? AND project_id=? AND environment_id=? ORDER BY assignment_version DESC LIMIT 1",
    )
    .bind(project.organizationId, project.projectId, executing.accepted.environmentId)
    .first<{ data_environment_id: string }>();
  if (physical === null) throw new Error("fixture physical data scope missing");
  return run(
    shard,
    "INSERT INTO neon_project_placement_reservations(organization_id, project_id, environment_id, operation_id, claim_id, project_name, region_id, postgres_version, reserved_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'aws-eu-central-1', 17, ?7)",
    project.organizationId,
    project.projectId,
    physical.data_environment_id,
    executing.accepted.operationId,
    executing.claimId,
    `ohmyho-${project.projectId.toLowerCase()}`,
    reservedAt,
  );
};

/** A data change whose data assignment switched at 11:10 on 28 October and whose lease then expired, never reconciled. */
async function seedSwitchedDataChange(handle: string) {
  const project = await seedProject(0, handle);
  const db = shardOf(control, 0);
  const accepted = await seedAcceptedOperation(
    { ...project, shard: db },
    project.developmentEnvironmentId,
    { eventType: "ProjectDataChangeRequestedV1", claim: true, at: AT },
  );
  await db
    .prepare(
      "INSERT INTO environment_data_assignments(organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at,operation_id) SELECT organization_id,environment_id,assignment_version+1,project_id,data_environment_id,'2026-10-28T11:10:00.000000Z',?3 FROM environment_data_assignments WHERE organization_id=?1 AND environment_id=?2 ORDER BY assignment_version DESC LIMIT 1",
    )
    .bind(project.organizationId, project.developmentEnvironmentId, accepted.operationId)
    .run();
  const leaseExpiresAt = "2026-10-28T11:15:00.000000Z";
  await db
    .prepare(
      "UPDATE operations SET lease_expires_at = ?3 WHERE organization_id = ?1 AND operation_id = ?2",
    )
    .bind(project.organizationId, accepted.operationId, leaseExpiresAt)
    .run();
  return {
    operationId: accepted.operationId,
    exact: {
      organizationId: project.organizationId,
      projectId: project.projectId,
      operationId: accepted.operationId,
      leaseExpiresAt,
    },
  };
}
const claimCount = async (operationId: string) =>
  (
    await rows<{ n: number }>(
      0,
      "SELECT count(*) AS n FROM product_provider_mutation_claims WHERE operation_id = ?",
      operationId,
    )
  )[0]?.n;

describe("lease recovery keeps uncertain provider work", () => {
  it("never recovers an operation with an unresolved Neon placement, fails its GitHub push deployment otherwise, and refuses a late reservation", async () => {
    const guarded = await seedProject(0, "gate-neon");
    const held = await seedExecuting(0, guarded, "neon", true);
    await reserveNeon(0, guarded, held);

    const plain = await seedProject(0, "gate-plain");
    const open = await seedExecuting(0, plain, "plain", true);
    // A GitHub push deployment of the abandoned operation (full real FK chain).
    const org = plain.organizationId;
    const connection = newUlid();
    const inboxId = newUlid();
    const pushId = newUlid();
    const db = shardOf(control, 0);
    await db.batch([
      db
        .prepare(
          "INSERT INTO source_connections(organization_id, source_connection_id, project_id, billing_epoch_id, provider, external_repository_id, created_at) VALUES (?1, ?2, ?3, ?4, 'github', '42', ?5)",
        )
        .bind(org, connection, plain.projectId, plain.billingEpochId, AT),
      db
        .prepare(
          "INSERT INTO repository_grants(organization_id, grant_id, project_id, billing_epoch_id, source_connection_id, provider, github_installation_id, external_repository_id, repository_owner, repository_name, permission, granted_at) VALUES (?1, ?2, ?3, ?4, ?5, 'github', '7', '42', 'o', 'r', 'contents:read', ?6)",
        )
        .bind(org, newUlid(), plain.projectId, plain.billingEpochId, connection, AT),
      db
        .prepare(
          "INSERT INTO github_auto_deploy_configs(organization_id, project_id, source_connection_id, branch_ref, generation, enabled, configured_at, updated_at) VALUES (?1, ?2, ?3, 'refs/heads/main', 1, 1, ?4, ?4)",
        )
        .bind(org, plain.projectId, connection, AT),
      db
        .prepare(
          "INSERT INTO webhook_inbox(organization_id, inbox_event_id, provider, external_event_id, event_type, payload, body_sha256, received_at, signature_timestamp, state, attempt_count, max_attempts, available_at) VALUES (?1, ?2, 'github', 'push-1', 'push', '{}', ?3, ?4, NULL, 'pending', 0, 5, ?4)",
        )
        .bind(org, inboxId, new Uint8Array(32), AT),
      db
        .prepare(
          "INSERT INTO github_push_deployments(organization_id, push_deployment_id, inbox_event_id, project_id, source_connection_id, config_generation, delivery_guid, github_installation_id, external_repository_id, branch_ref, commit_sha, sequence, operation_id, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, '5e7a3c1d-0b52-4c8e-9a41-6d2f8b0c1e11', '7', '42', 'refs/heads/main', ?6, 1, ?7, 'running', ?8, ?8)",
        )
        .bind(
          org,
          pushId,
          inboxId,
          plain.projectId,
          connection,
          "a".repeat(40),
          open.accepted.operationId,
          AT,
        ),
    ]);

    // The reaper takes the other candidate and leaves the placement-held operation untouched.
    expect(
      await store.maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:00:00.000Z",
        shardId: 0,
      }),
    ).toEqual({
      organizationId: org,
      operationId: open.accepted.operationId,
      releaseBuildCredits: true,
    });
    expect(
      await store.maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:00:00.000Z",
        shardId: 0,
      }),
    ).toBeNull();
    expect(
      await rows(
        0,
        "SELECT state, cleanup_required FROM github_push_deployments WHERE push_deployment_id = ?",
        pushId,
      ),
    ).toEqual([{ state: "failed", cleanup_required: 0 }]);
    expect(
      await rows(
        0,
        "SELECT state FROM operations WHERE operation_id = ?",
        held.accepted.operationId,
      ),
    ).toEqual([{ state: "queued" }]);
    expect(
      await rows(
        0,
        "SELECT 1 AS present FROM product_provider_mutation_claims WHERE operation_id = ?",
        held.accepted.operationId,
      ),
    ).toHaveLength(1);
    // The exact captured execution is refused the same way: a later clock never replays an uncertain provider create.
    for (const now of ["2026-10-28T13:00:00.000Z", "2026-10-29T13:00:00.000Z"]) {
      expect(
        await store.maintenance.recoverExpiredOperationLease({
          now,
          exactOperation: {
            organizationId: guarded.organizationId,
            projectId: guarded.projectId,
            operationId: held.accepted.operationId,
            leaseExpiresAt: "2026-10-28T11:15:00.000Z",
          },
        }),
      ).toBeNull();
    }

    // A reservation that appears between the candidate read and the write aborts the whole batch, nothing persists.
    const late = await seedProject(0, "gate-late");
    const lateOp = await seedExecuting(0, late, "late", true);
    const lateDb = shardOf(control, 0);
    let reserved = false;
    const racing = {
      prepare: (sql: string) => lateDb.prepare(sql),
      batch: async (statements: Parameters<typeof lateDb.batch>[0]) => {
        if (!reserved && statements.length > 5) {
          reserved = true;
          await reserveNeon(0, late, lateOp);
        }
        return lateDb.batch(statements);
      },
    } as typeof lateDb;
    const racingStore = createControlStore({ CONTROL_CORE: racing });
    expect(
      await racingStore.maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:00:00.000Z",
        shardId: 0,
      }),
    ).toBeNull();
    expect(reserved).toBe(true);
    expect(
      await rows(
        0,
        "SELECT state FROM operations WHERE operation_id = ?",
        lateOp.accepted.operationId,
      ),
    ).toEqual([{ state: "queued" }]);
    expect(
      await rows(
        0,
        "SELECT 1 AS present FROM product_provider_mutation_claims WHERE operation_id = ?",
        lateOp.accepted.operationId,
      ),
    ).toHaveLength(1);
  });
  it("keeps an expired data change whose data assignment already switched, with its claim, for an explicit reconcile", async () => {
    const project = await seedProject(0, "gate-data-switch");
    const db = shardOf(control, 0);
    const accepted = await seedAcceptedOperation(
      { ...project, shard: db },
      project.developmentEnvironmentId,
      { eventType: "ProjectDataChangeRequestedV1", claim: true, at: AT },
    );
    // the switch committed the new data assignment of the Dev environment under this operation
    await db
      .prepare(
        "INSERT INTO environment_data_assignments(organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at,operation_id) SELECT organization_id,environment_id,assignment_version+1,project_id,data_environment_id,'2026-10-28T11:10:00.000000Z',?3 FROM environment_data_assignments WHERE organization_id=?1 AND environment_id=?2 ORDER BY assignment_version DESC LIMIT 1",
      )
      .bind(project.organizationId, project.developmentEnvironmentId, accepted.operationId)
      .run();
    const leaseExpiresAt = "2026-10-28T11:15:00.000000Z";
    await db
      .prepare(
        "UPDATE operations SET lease_expires_at = ?3 WHERE organization_id = ?1 AND operation_id = ?2",
      )
      .bind(project.organizationId, accepted.operationId, leaseExpiresAt)
      .run();
    // nobody called :reconcile within the lease: the lease expiry does not abandon the switched data change
    expect(
      await store.maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:00:00.000Z",
        exactOperation: {
          organizationId: project.organizationId,
          projectId: project.projectId,
          operationId: accepted.operationId,
          leaseExpiresAt,
        },
      }),
    ).toBeNull();
    expect(
      await rows(0, "SELECT state FROM operations WHERE operation_id = ?", accepted.operationId),
    ).toEqual([{ state: "running" }]);
    expect(
      await rows(
        0,
        "SELECT count(*) AS n FROM product_provider_mutation_claims WHERE operation_id = ?",
        accepted.operationId,
      ),
    ).toEqual([{ n: 1 }]);
  });
  it("keeps a switched data change for 24 hours after its switch, one millisecond short of the bound", async () => {
    const switched = await seedSwitchedDataChange("gate-data-hold");
    // The switch committed at 11:10 on 28 October: at 11:09:59.999 on 29 October it is still inside its 24 hours.
    expect(
      await store.maintenance.recoverExpiredOperationLease({
        now: "2026-10-29T11:09:59.999Z",
        exactOperation: switched.exact,
      }),
    ).toBeNull();
    expect(
      await rows(0, "SELECT state FROM operations WHERE operation_id = ?", switched.operationId),
    ).toEqual([{ state: "running" }]);
    expect(await claimCount(switched.operationId)).toBe(1);
  });

  it("abandons a switched data change that nobody reconciled 24 hours after its switch, releasing its claim and naming the data change", async () => {
    const switched = await seedSwitchedDataChange("gate-data-abandon");
    expect(
      await store.maintenance.recoverExpiredOperationLease({
        now: "2026-10-29T11:10:00.000Z",
        exactOperation: switched.exact,
      }),
    ).toEqual({
      organizationId: switched.exact.organizationId,
      operationId: switched.operationId,
      releaseBuildCredits: true,
    });
    const [operation] = await rows<{ state: string; failure: string }>(
      0,
      "SELECT state, failure FROM operations WHERE operation_id = ?",
      switched.operationId,
    );
    expect(operation?.state).toBe("failed");
    expect(JSON.parse(operation?.failure ?? "{}")).toMatchObject({
      code: "OPERATION_ABANDONED",
      message: expect.stringContaining("data change"),
    });
    expect(await claimCount(switched.operationId)).toBe(0);
    const [audit] = await rows<{ payload: string }>(
      0,
      "SELECT payload FROM audit_events WHERE operation_id = ? AND event_type = 'OperationFailed'",
      switched.operationId,
    );
    expect(JSON.parse(audit?.payload ?? "{}")).toMatchObject({
      reasonCode: "OPERATION_ABANDONED",
      reason: expect.stringContaining("data change"),
    });
  });
  it("aborts the recovery batch when a data change's data assignment switches after its candidate was read", async () => {
    const project = await seedProject(0, "gate-data-race");
    const db = shardOf(control, 0);
    const accepted = await seedAcceptedOperation(
      { ...project, shard: db },
      project.developmentEnvironmentId,
      { eventType: "ProjectDataChangeRequestedV1", claim: true, at: AT },
    );
    const leaseExpiresAt = "2026-10-28T11:15:00.000000Z";
    await db
      .prepare(
        "UPDATE operations SET lease_expires_at = ?3 WHERE organization_id = ?1 AND operation_id = ?2",
      )
      .bind(project.organizationId, accepted.operationId, leaseExpiresAt)
      .run();
    // The switch commits after the candidate was read and before the recovery batch: the batch must not abandon it.
    let switched = false;
    const racing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: Parameters<typeof db.batch>[0]) => {
        if (!switched && statements.length > 5) {
          switched = true;
          await db
            .prepare(
              "INSERT INTO environment_data_assignments(organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at,operation_id) SELECT organization_id,environment_id,assignment_version+1,project_id,data_environment_id,'2026-10-28T11:10:00.000000Z',?3 FROM environment_data_assignments WHERE organization_id=?1 AND environment_id=?2 ORDER BY assignment_version DESC LIMIT 1",
            )
            .bind(project.organizationId, project.developmentEnvironmentId, accepted.operationId)
            .run();
        }
        return db.batch(statements);
      },
    } as typeof db;
    expect(
      await createControlStore({ CONTROL_CORE: racing }).maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:00:00.000Z",
        exactOperation: {
          organizationId: project.organizationId,
          projectId: project.projectId,
          operationId: accepted.operationId,
          leaseExpiresAt,
        },
      }),
    ).toBeNull();
    expect(switched).toBe(true);
    expect(
      await rows(0, "SELECT state FROM operations WHERE operation_id = ?", accepted.operationId),
    ).toEqual([{ state: "running" }]);
    expect(
      await rows(
        0,
        "SELECT count(*) AS n FROM product_provider_mutation_claims WHERE operation_id = ?",
        accepted.operationId,
      ),
    ).toEqual([{ n: 1 }]);
  });
});

describe("acceptApiOperation gates", () => {
  const traces = async (shard: number, operationId: string) => ({
    operation: (await rows(shard, "SELECT 1 FROM operations WHERE operation_id = ?", operationId))
      .length,
    audit: (await rows(shard, "SELECT 1 FROM audit_events WHERE operation_id = ?", operationId))
      .length,
    outbox: (await rows(shard, "SELECT 1 FROM outbox_events WHERE operation_id = ?", operationId))
      .length,
    receipt: (
      await rows(shard, "SELECT 1 FROM api_idempotency_records WHERE operation_id = ?", operationId)
    ).length,
  });
  const none = { operation: 0, audit: 0, outbox: 0, receipt: 0 };

  it("refuses a gated command while a provider cutover is pending, with no trace, and accepts after the release", async () => {
    const project = await seedProject(1, "gate-cutover");
    const authorization = newUlid();
    const cutoverOperation = acceptInput(project, { idempotencyKey: "cutover-op" });
    await store.operations.acceptApiOperation(cutoverOperation);
    await run(
      1,
      "INSERT INTO database_provider_cutover_authorizations(organization_id, operation_id, project_id, physical_environment_id, manifest_sha256, expected_lifecycle_version, source_target_version, source_registration, target_provider_project_id, target_region_id, target_size_class_id, approved_at, approved_by) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, '{}', 'prj_abcdefghijklmnopqrst', 'us-dev', 'small', ?6, 'owner')",
      project.organizationId,
      cutoverOperation.operationId,
      project.projectId,
      authorization,
      new Uint8Array(32),
      AT,
    );
    const blocked = acceptInput(project, { idempotencyKey: "blocked" });
    await expect(store.operations.acceptApiOperation(blocked)).rejects.toMatchObject({
      code: "deployment_persistence_conflict",
    });
    expect(await traces(1, blocked.operationId)).toEqual(none);
    // The same gate holds in the writing batch when the cutover appears after the snapshot.
    await expect(
      shardOf(control, 1).batch(
        acceptStatements(
          shardOf(control, 1),
          acceptApiOperationInput.parse({
            ...blocked,
            canonicalRequestDigest: digest(9),
            idempotencyKey: "direct",
          }),
          false,
          false,
        ),
      ),
    ).rejects.toThrow(/guard_precondition_changed/u);
    expect(await traces(1, blocked.operationId)).toEqual(none);
    // A non-gated event is not blocked by the cutover.
    const free = acceptInput(project, {
      idempotencyKey: "free",
      eventType: "ProjectHandleChangeRequestedV1",
    });
    await expect(store.operations.acceptApiOperation(free)).resolves.toMatchObject({
      outcome: "created",
    });

    await run(
      1,
      "INSERT INTO database_provider_cutover_releases(organization_id, operation_id, released_at, released_by) VALUES (?1, ?2, ?3, 'owner')",
      project.organizationId,
      cutoverOperation.operationId,
      AT,
    );
    await expect(store.operations.acceptApiOperation(blocked)).resolves.toMatchObject({
      outcome: "created",
    });
    // Authorizations and releases are append-only evidence.
    await expect(
      run(
        1,
        "DELETE FROM database_provider_cutover_releases WHERE organization_id = ?",
        project.organizationId,
      ),
    ).rejects.toThrow(/append-only/u);
    await expect(
      run(
        1,
        "UPDATE database_provider_cutover_authorizations SET approved_by = 'x' WHERE organization_id = ?",
        project.organizationId,
      ),
    ).rejects.toThrow(/append-only/u);
  });

  it("consumes a confirmation once with the accepted operation and refuses a stale or mismatched one with nothing consumed", async () => {
    const project = await seedProject(0, "gate-confirm");
    const token = digest(77);
    const confirmationId = newUlid();
    const issue = (
      action: string,
      target: string | null,
      generation: number | null,
      id = newUlid(),
    ) =>
      run(
        0,
        "INSERT INTO action_confirmations(organization_id, confirmation_id, project_id, issued_to_principal_id, action, target_deployment_id, subject_etag, token_sha256, source_generation, created_at, expires_at) VALUES (?1, ?2, ?3, 'user:user_seed', ?4, ?5, 'etag-1', ?6, ?7, '2026-10-28T10:55:00.000000Z', '2026-10-28T11:05:00.000000Z')",
        project.organizationId,
        id,
        project.projectId,
        action,
        target,
        hexBytes(token),
        generation,
      );
    await issue("delete", null, null, confirmationId);
    const confirmation = (overrides: Record<string, unknown> = {}) => ({
      action: "delete",
      issuedToPrincipalId: "user:user_seed",
      subjectEtag: "etag-1",
      tokenDigest: token,
      consumedAt: "2026-10-28T11:00:00.000Z",
      ...overrides,
    });
    for (const [key, overrides] of [
      ["wrong-etag", { subjectEtag: "etag-2" }],
      ["wrong-principal", { issuedToPrincipalId: "user:other" }],
      ["wrong-token", { tokenDigest: digest(78) }],
      ["expired", { consumedAt: "2026-10-28T11:06:00.000Z" }],
      ["wrong-action", { action: "data_change" }],
    ] as const) {
      const input = acceptInput(project, {
        idempotencyKey: key,
        eventType: "ProjectDeletionRequestedV1",
        httpMethod: "DELETE",
        confirmation: confirmation(overrides),
      });
      await expect(store.operations.acceptApiOperation(input)).rejects.toMatchObject({
        code: "deployment_persistence_conflict",
      });
      expect(await traces(0, input.operationId)).toEqual(none);
    }
    expect(
      await rows(
        0,
        "SELECT consumed_at FROM action_confirmations WHERE confirmation_id = ?",
        confirmationId,
      ),
    ).toEqual([{ consumed_at: null }]);

    const good = acceptInput(project, {
      idempotencyKey: "confirmed",
      eventType: "ProjectDeletionRequestedV1",
      httpMethod: "DELETE",
      confirmation: confirmation(),
    });
    // A concurrent consumer wins between the snapshot and the write: the batch aborts whole.
    await expect(
      shardOf(control, 0).batch([
        shardOf(control, 0)
          .prepare(
            "UPDATE action_confirmations SET consumed_at = '2026-10-28T10:59:00.000000Z' WHERE confirmation_id = ?",
          )
          .bind(confirmationId),
        ...acceptStatements(
          shardOf(control, 0),
          acceptApiOperationInput.parse({ ...good, canonicalRequestDigest: digest(7) }),
          false,
          false,
        ),
      ]),
    ).rejects.toThrow(/guard_precondition_changed|guard_scope_inactive/u);
    expect(await traces(0, good.operationId)).toEqual(none);
    // The aborted batch rolled the concurrent consumer back too: the confirmation is still unconsumed, nothing to reset.
    expect(
      await rows(
        0,
        "SELECT consumed_at FROM action_confirmations WHERE confirmation_id = ?",
        confirmationId,
      ),
    ).toEqual([{ consumed_at: null }]);

    // Promote and rollback pin the source generation the confirmation was issued under.
    const target = newUlid();
    const rollback = acceptInput(project, {
      idempotencyKey: "rollback-stale",
      eventType: "DeploymentRollbackRequestedV1",
      confirmation: confirmation({ action: "rollback", targetDeploymentId: target }),
    });
    await expect(store.operations.acceptApiOperation(rollback)).rejects.toMatchObject({
      code: "deployment_persistence_conflict",
    });
    expect(await traces(0, rollback.operationId)).toEqual(none);

    await expect(store.operations.acceptApiOperation(good)).resolves.toMatchObject({
      outcome: "created",
    });
    expect(
      (
        await rows<{ consumed_at: string }>(
          0,
          "SELECT consumed_at FROM action_confirmations WHERE confirmation_id = ?",
          confirmationId,
        )
      )[0]?.consumed_at,
    ).toBe("2026-10-28T11:00:00.000000Z");
    // The identity of the original request replays; the consumed token cannot be used by another request.
    await expect(store.operations.acceptApiOperation(good)).resolves.toMatchObject({
      outcome: "replayed",
      operationId: good.operationId,
    });
    const second = acceptInput(project, {
      idempotencyKey: "second",
      eventType: "ProjectDeletionRequestedV1",
      httpMethod: "DELETE",
      confirmation: confirmation(),
    });
    await expect(store.operations.acceptApiOperation(second)).rejects.toMatchObject({
      code: "deployment_persistence_conflict",
    });
    await expect(
      store.operations.acceptApiOperation(
        acceptInput(project, {
          idempotencyKey: "bad",
          confirmation: { ...confirmation(), action: "rollback" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("admits a further deletion only after the previous deletion failed and nothing else holds the project", async () => {
    const project = await seedProject(1, "gate-deleting");
    const first = acceptInput(project, {
      idempotencyKey: "del-1",
      eventType: "ProjectDeletionRequestedV1",
      httpMethod: "DELETE",
    });
    await store.operations.acceptApiOperation(first);
    const db = shardOf(control, 1);
    await seedDeletionIntent({ ...project, shard: db }, first.environmentId, first.operationId, {
      at: AT,
    });
    await db
      .prepare(
        "UPDATE projects SET lifecycle_state = 'deleting', lifecycle_version = 2 WHERE organization_id = ?1 AND project_id = ?2",
      )
      .bind(project.organizationId, project.projectId)
      .run();
    const again = (key: string, overrides: Record<string, unknown> = {}) =>
      acceptInput(project, {
        idempotencyKey: key,
        eventType: "ProjectDeletionRequestedV1",
        httpMethod: "DELETE",
        ...overrides,
      });
    // The previous deletion is still queued: refused, nothing written.
    const early = again("del-early");
    await expect(store.operations.acceptApiOperation(early)).rejects.toMatchObject({
      code: "deployment_persistence_conflict",
    });
    expect(await traces(1, early.operationId)).toEqual(none);
    // Only a DELETE deletion is admitted into a deleting project.
    const wrongMethod = again("del-post", { httpMethod: "POST" });
    await expect(store.operations.acceptApiOperation(wrongMethod)).rejects.toMatchObject({
      code: "scope_inactive",
    });
    const otherEvent = acceptInput(project, { idempotencyKey: "del-other" });
    await expect(store.operations.acceptApiOperation(otherEvent)).rejects.toMatchObject({
      code: "scope_inactive",
    });

    await run(
      1,
      "UPDATE operations SET state = 'failed', lease_expires_at = NULL WHERE operation_id = ?",
      first.operationId,
    );
    // The project's own creation operation is finished too: only the deletion lifecycle is open.
    await run(
      1,
      "UPDATE operations SET state = 'succeeded', lease_expires_at = NULL WHERE organization_id = ?1 AND operation_id <> ?2",
      project.organizationId,
      first.operationId,
    );
    // A live paid domain blocks planning the deletion.
    await run(
      1,
      "INSERT INTO paid_project_domains(organization_id, project_id, hostname, gateway_script_name, state, configured_by_principal_id, apply_idempotency_sha256, apply_request_sha256, created_at, updated_at) VALUES (?1, ?2, 'shop.example.com', NULL, 'awaiting_deployment', 'user:user_seed', ?3, ?3, ?4, ?4)",
      project.organizationId,
      project.projectId,
      new Uint8Array(32),
      AT,
    );
    const domain = again("del-domain");
    await expect(store.operations.acceptApiOperation(domain)).rejects.toMatchObject({
      code: "project_domain_delete_required",
    });
    expect(await traces(1, domain.operationId)).toEqual(none);
    await run(
      1,
      "UPDATE paid_project_domains SET state = 'deleted', deleted_at = ?2, delete_idempotency_sha256 = ?3, delete_request_sha256 = ?3 WHERE organization_id = ?1",
      project.organizationId,
      AT,
      new Uint8Array(32),
    );
    // A changed scope (another environment or epoch) is refused.
    const moved = again("del-scope", { billingEpochId: newUlid() });
    await expect(store.operations.acceptApiOperation(moved)).rejects.toMatchObject({
      code: expect.stringMatching(/deployment_persistence_conflict|owner_changed/u),
    });
    const wrongEnv = again("del-env", { environmentId: project.productionEnvironmentId });
    await expect(store.operations.acceptApiOperation(wrongEnv)).rejects.toMatchObject({
      code: "deployment_persistence_conflict",
    });

    const ok = again("del-ok");
    await expect(store.operations.acceptApiOperation(ok)).resolves.toMatchObject({
      outcome: "created",
    });
    expect((await traces(1, ok.operationId)).outbox).toBe(1);
    // The writing batch re-proves the admission: now the new deletion is queued, a third request loses the guard.
    await expect(
      shardOf(control, 1).batch(
        acceptStatements(
          shardOf(control, 1),
          acceptApiOperationInput.parse({
            ...again("del-third"),
            canonicalRequestDigest: digest(3),
          }),
          false,
          false,
          { lifecycle: "deleting" },
        ),
      ),
    ).rejects.toThrow(/guard_precondition_changed/u);
  });
});

describe("operation delegation recheck of the pinned source", () => {
  it("invalidates an operation whose source generation, link or repository grant changed", async () => {
    const project = await seedProject(0, "gate-source");
    const org = project.organizationId;
    const connection = newUlid();
    const other = newUlid();
    const grantId = newUlid();
    const setup = [
      [
        "INSERT INTO source_connections(organization_id, source_connection_id, project_id, billing_epoch_id, provider, external_repository_id, created_at) VALUES (?1, ?2, ?3, ?4, 'github', '42', ?5)",
        [org, connection, project.projectId, project.billingEpochId, AT],
      ],
      [
        "INSERT INTO source_connections(organization_id, source_connection_id, project_id, billing_epoch_id, provider, external_repository_id, created_at) VALUES (?1, ?2, ?3, ?4, 'github', '43', ?5)",
        [org, other, project.projectId, project.billingEpochId, AT],
      ],
      [
        "INSERT INTO repository_grants(organization_id, grant_id, project_id, billing_epoch_id, source_connection_id, provider, github_installation_id, external_repository_id, repository_owner, repository_name, permission, granted_at) VALUES (?1, ?2, ?3, ?4, ?5, 'github', '7', '42', 'o', 'r', 'contents:read', ?6)",
        [org, grantId, project.projectId, project.billingEpochId, connection, AT],
      ],
      [
        "UPDATE project_source_bindings SET generation=3,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND source_connection_id=?3",
        [org, project.projectId, connection, AT],
      ],
    ] as const;
    for (const [sql, binds] of setup) await run(0, sql, ...binds);
    const scope = { ...project, shard: shardOf(control, 0) };
    // A real published revision of Production: the source of the promotion and the target of the rollback.
    const published = await seedWfpPublication(
      {
        ...scope,
        handle: project.projectHandle,
        devEnvironmentId: project.developmentEnvironmentId,
        prodEnvironmentId: project.productionEnvironmentId,
      },
      {
        operationId: await seedOperation(scope),
        environmentId: project.productionEnvironmentId,
        sourceConnectionId: connection,
      },
    );
    const revision = { ...published, environmentId: project.productionEnvironmentId };
    const intent = async (eventType: IntentEventType, generation: number, snapshot: boolean) => {
      const accepted = acceptInput(project, {
        idempotencyKey: `${eventType}-${generation}-${String(snapshot)}-${newUlid()}`,
      });
      await store.operations.acceptApiOperation(accepted);
      const columns: IntentColumns =
        eventType === "DeploymentPromotionRequestedV1"
          ? await promotionIntent(scope, accepted.operationId, accepted.environmentId, revision)
          : eventType === "DeploymentRollbackRequestedV1"
            ? await rollbackIntent(scope, accepted.operationId, accepted.environmentId, published)
            : await deploymentIntent(scope, accepted.operationId, accepted.environmentId, {
                sourceConnectionId: connection,
                refresh: snapshot,
              });
      await seedIntent(
        scope,
        accepted.environmentId,
        accepted.operationId,
        eventType,
        {
          ...columns,
          source_generation: generation,
          ...(snapshot
            ? { binding_refresh_snapshot_sha256: new Uint8Array(32).fill(generation) }
            : {}),
        },
        AT,
      );
      return accepted.operationId;
    };
    const assertCurrent = (operationId: string) =>
      store.identity.assertOperationDelegationCurrent({ organizationId: org, operationId });

    const plain = await intent("DeploymentRequestedV1", 3, false);
    const promote = await intent("DeploymentPromotionRequestedV1", 3, false);
    const rollback = await intent("DeploymentRollbackRequestedV1", 3, false);
    await expect(assertCurrent(plain)).resolves.toBeUndefined();
    await expect(assertCurrent(promote)).resolves.toBeUndefined();
    await expect(assertCurrent(rollback)).resolves.toBeUndefined();

    // A repository grant revoked: only the plain pinned deployment checks the grant.
    await run(
      0,
      "INSERT INTO repository_grant_revocations(organization_id, revocation_id, grant_id, project_id, reason, revoked_at) VALUES (?1, ?2, ?3, ?4, 'permission_revoked', ?5)",
      org,
      newUlid(),
      grantId,
      project.projectId,
      AT,
    );
    await expect(assertCurrent(plain)).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    await expect(assertCurrent(promote)).resolves.toBeUndefined();
    await expect(
      run(0, "DELETE FROM repository_grant_revocations WHERE grant_id = ?", grantId),
    ).rejects.toThrow(/append-only/u);
    await expect(
      run(
        0,
        "UPDATE repository_grant_revocations SET reason = 'repository_removed' WHERE grant_id = ?",
        grantId,
      ),
    ).rejects.toThrow(/append-only/u);

    // The source was replaced (new generation, then another link): every pinned operation is stale.
    await run(
      0,
      "UPDATE project_source_bindings SET generation = 4 WHERE organization_id = ?1 AND project_id = ?2",
      org,
      project.projectId,
    );
    await expect(assertCurrent(promote)).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    await expect(assertCurrent(rollback)).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    const refreshed = await intent("DeploymentRequestedV1", 4, true);
    await expect(assertCurrent(refreshed)).resolves.toBeUndefined();
    await run(
      0,
      "UPDATE project_source_bindings SET source_connection_id = ?3, generation = 5 WHERE organization_id = ?1 AND project_id = ?2",
      org,
      project.projectId,
      other,
    );
    await expect(assertCurrent(refreshed)).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    // Unbound after the intent pinned a generation: generation 0 no longer equals the pin.
    await run(
      0,
      "DELETE FROM project_source_bindings WHERE organization_id = ?1 AND project_id = ?2",
      org,
      project.projectId,
    );
    await expect(assertCurrent(promote)).rejects.toMatchObject({
      code: "operation_authorization_changed",
    });
    // An unknown operation has nothing to recheck; another tenant's operation is invisible.
    await expect(assertCurrent(newUlid())).resolves.toBeUndefined();
    const stranger = await seedProject(0, "gate-stranger");
    await expect(
      store.identity.assertOperationDelegationCurrent({
        organizationId: stranger.organizationId,
        operationId: plain,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("unrouted inbox policy", () => {
  const event = (id: string, routing: unknown, overrides: Record<string, unknown> = {}) => ({
    provider: "workos",
    inboxEventId: newUlid(),
    externalEventId: id,
    eventType: "organization_membership.created",
    payload: {},
    bodyDigest: digest(
      Math.abs([...id].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7)) % 100_000,
    ),
    receivedAt: "2026-10-28T10:00:00.000Z",
    signatureTimestamp: "2026-10-28T09:59:30.000Z",
    maxAttempts: 7,
    routing,
    ...overrides,
  });
  // Explicit retained prototype fixtures. New verified recording only writes the canonical global table.
  const seedLegacy = async (input: ReturnType<typeof event>) => {
    const route = input.routing as {
      kind: string;
      workosOrganizationId?: string;
      routingKey?: string;
    };
    const acknowledged =
      "acknowledgedAt" in input && typeof input.acknowledgedAt === "string"
        ? input.acknowledgedAt
        : undefined;
    const key = route.workosOrganizationId ?? route.routingKey;
    await control.core
      .prepare(
        `INSERT INTO inbox_unrouted(inbox_event_id,provider,external_event_id,routing_key,event_type,payload,body_sha256,received_at,purge_after,max_attempts,signature_timestamp,terminal_code,terminal_at) VALUES (?1,'workos',?2,?3,?4,?5,unhex(?6),?7,'2026-11-11T10:00:00.000000Z',?8,?9,?10,?11)`,
      )
      .bind(
        input.inboxEventId,
        input.externalEventId,
        acknowledged === undefined ? key : `acknowledged:${key}`,
        input.eventType,
        JSON.stringify(input.payload),
        input.bodyDigest,
        input.receivedAt.replace(/Z$/u, "000Z"),
        input.maxAttempts,
        input.signatureTimestamp.replace(/Z$/u, "000Z"),
        acknowledged === undefined ? null : "ACKNOWLEDGED_EVIDENCE",
        acknowledged?.replace(/Z$/u, "000Z") ?? null,
      )
      .run();
  };
  const unrouted = async (externalEventId: string) =>
    (
      await control.directory
        .prepare(
          "SELECT terminal_code, route_attempts, max_attempts, signature_timestamp FROM inbox_unrouted WHERE external_event_id = ?",
        )
        .bind(externalEventId)
        .all<{
          terminal_code: string | null;
          route_attempts: number;
          max_attempts: number;
          signature_timestamp: string | null;
        }>()
    ).results;

  it("keeps the original max_attempts and signature time, classifies unroutable legacy events and refuses contradictory canonical identities without losing evidence", async () => {
    await seedLegacy(
      event("evt-policy", { kind: "workos_organization", workosOrganizationId: "org_policy" }),
    );
    expect(await unrouted("evt-policy")).toEqual([
      {
        terminal_code: null,
        route_attempts: 0,
        max_attempts: 7,
        signature_timestamp: "2026-10-28T09:59:30.000000Z",
      },
    ]);
    await seedLegacy(event("evt-nokey", { kind: "unscoped", routingKey: "session:abc" }));
    await seedLegacy(
      event(
        "evt-ack",
        { kind: "workos_organization", workosOrganizationId: "org_policy" },
        { acknowledgedAt: "2026-10-28T10:00:00.000Z" },
      ),
    );
    expect(await unrouted("evt-ack")).toMatchObject([{ terminal_code: "ACKNOWLEDGED_EVIDENCE" }]);

    // The owner has not appeared: waiting is not an attempt and nothing is skipped as terminal.
    expect(
      await store.maintenance.routeUnroutedInboxEvents({
        limit: 10,
        now: "2026-10-28T10:05:00.000Z",
      }),
    ).toBe(0);
    expect(await unrouted("evt-policy")).toMatchObject([
      { terminal_code: null, route_attempts: 0 },
    ]);
    expect(await unrouted("evt-nokey")).toMatchObject([
      { terminal_code: "UNROUTABLE_ROUTING_KEY" },
    ]);

    await seedLegacy(
      event("evt-conflict", {
        kind: "workos_organization",
        workosOrganizationId: "org_still_missing",
      }),
    );
    const organizationId = await seedOrganization(store, 2, 1);
    // seedOrganization already mapped this organization to its own WorkOS id, so mapping it to org_policy through the
    // snapshot command is refused; the directory row is then repointed directly to stage the late-arriving owner.
    await expect(
      store.identity.applyOrganizationSnapshot({
        organizationId,
        workosOrganizationId: "org_policy",
        state: "active",
        snapshotDigest: digest(4242),
        snapshotFetchedAt: "2026-10-28T09:00:00.000Z",
        synchronizedAt: "2026-10-28T09:00:00.000Z",
        triggerEventId: "evt_seed",
        memberships: [],
        auditEventId: newUlid(),
      }),
    ).rejects.toMatchObject({ code: "workos_organization_mapped" });
    await control.directory
      .prepare(
        "UPDATE org_directory SET workos_organization_id = 'org_policy' WHERE organization_id = ?",
      )
      .bind(organizationId)
      .run();
    // The final schema refuses contradictory cross-buffer identities before they can be written.
    await expect(
      run(
        1,
        "INSERT INTO webhook_inbox(organization_id, inbox_event_id, provider, external_event_id, event_type, payload, body_sha256, received_at, signature_timestamp, state, attempt_count, max_attempts, available_at) VALUES (?1, ?2, 'workos', 'evt-conflict', 'x', '{}', ?3, ?4, ?4, 'pending', 0, 3, ?4)",
        organizationId,
        newUlid(),
        new Uint8Array(32).fill(9),
        AT,
      ),
    ).rejects.toThrow(/cross-inbox identity conflict/u);
    expect(
      await store.maintenance.routeUnroutedInboxEvents({
        limit: 10,
        now: "2026-10-28T10:10:00.000Z",
      }),
    ).toBe(1);
    expect(await unrouted("evt-conflict")).toMatchObject([{ terminal_code: null }]);
    expect(await unrouted("evt-policy")).toEqual([]);
    expect(
      await rows(
        1,
        "SELECT max_attempts, signature_timestamp, state FROM webhook_inbox WHERE external_event_id = 'evt-policy'",
      ),
    ).toEqual([
      { max_attempts: 7, signature_timestamp: "2026-10-28T09:59:30.000000Z", state: "pending" },
    ]);

    // Later clock: terminal rows are never selected again, so no actor replays them, and they are not deleted silently.
    expect(await store.maintenance.routeUnroutedInboxEvents({ limit: 10 })).toBe(0);
    expect(
      await store.maintenance.routeUnroutedInboxEvents({
        limit: 10,
        now: "2026-12-30T00:00:00.000Z",
      }),
    ).toBe(0);
    expect(await unrouted("evt-conflict")).toMatchObject([{ terminal_code: null }]);
    expect(await unrouted("evt-nokey")).toMatchObject([
      { terminal_code: "UNROUTABLE_ROUTING_KEY" },
    ]);
  });

  it("counts a failing route step, parks the event at its own max_attempts and treats a fenced bucket as a wait", async () => {
    const organizationId = await seedOrganization(store, 2, 1);
    await control.directory
      .prepare(
        "UPDATE org_directory SET workos_organization_id = 'org_budget' WHERE organization_id = ?",
      )
      .bind(organizationId)
      .run();
    await seedLegacy(
      event(
        "evt-budget",
        { kind: "workos_organization", workosOrganizationId: "org_unknown_yet" },
        { maxAttempts: 2 },
      ),
    );
    await control.directory
      .prepare(
        "UPDATE inbox_unrouted SET routing_key = 'org_budget' WHERE external_event_id = 'evt-budget'",
      )
      .run();
    // A core that cannot be reached fails the step: each sweep counts one attempt.
    const partial = createControlStore({
      CONTROL_CORE: {
        prepare: (sql) => control.core.prepare(sql),
        batch: async () => {
          throw new Error("D1 storage is unavailable");
        },
      },
    });
    expect(
      await partial.maintenance.routeUnroutedInboxEvents({
        limit: 5,
        now: "2026-10-28T10:20:00.000Z",
      }),
    ).toBe(0);
    expect(await unrouted("evt-budget")).toMatchObject([
      { terminal_code: null, route_attempts: 1, max_attempts: 2 },
    ]);
    // A fenced bucket of the owner: a wait, not an attempt (the second sweep below the budget stays open).
    const bucket = await bucketOf(organizationId);
    await run(
      1,
      "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?1, 'moving', ?2, ?3)",
      bucket,
      newUlid(),
      AT,
    );
    expect(
      await store.maintenance.routeUnroutedInboxEvents({
        limit: 5,
        now: "2026-10-28T10:20:30.000Z",
      }),
    ).toBe(0);
    expect(await unrouted("evt-budget")).toMatchObject([
      { terminal_code: null, route_attempts: 1 },
    ]);
    await run(1, "DELETE FROM bucket_fences WHERE bucket = ?1", bucket);
    expect(
      await partial.maintenance.routeUnroutedInboxEvents({
        limit: 5,
        now: "2026-10-28T10:21:00.000Z",
      }),
    ).toBe(0);
    expect(await unrouted("evt-budget")).toMatchObject([
      { terminal_code: "ROUTE_ATTEMPTS_EXHAUSTED", route_attempts: 2 },
    ]);
    // Exhausted rows are evidence: never selected again, healthy store included.
    expect(
      await store.maintenance.routeUnroutedInboxEvents({
        limit: 5,
        now: "2026-10-28T11:00:00.000Z",
      }),
    ).toBe(0);
    expect(await unrouted("evt-budget")).toMatchObject([
      { terminal_code: "ROUTE_ATTEMPTS_EXHAUSTED" },
    ]);
  });
});

describe("reconciliation inbox purge", () => {
  it("deletes parked events only inside a registered export below the horizon, and no raw delete bypasses it", async () => {
    const organizationId = await seedOrganization(store, 2, 0);
    const other = await seedOrganization(store, 2, 0);
    const context = {
      directory: control.directory,
      router: coreRouter(control, control.shards),
    };
    const insert = (org: string, id: string, state: string, receivedAt: string) =>
      run(
        0,
        `INSERT INTO webhook_inbox(organization_id, inbox_event_id, provider, external_event_id, event_type, payload, body_sha256, received_at, signature_timestamp, state, attempt_count, max_attempts, available_at, last_error_code, acknowledged_at)
         VALUES (?1, ?2, 'github', ?3, 'push', '{}', ?4, ?5, NULL, ?6, ${state === "acknowledged" ? "1, 1" : "3, 3"}, ?5, ${state === "acknowledged" ? "NULL, ?5" : "'PROVIDER_FAILED', NULL"})`,
        org,
        newUlid(),
        id,
        new Uint8Array(32).fill(id.length),
        receivedAt,
        state,
      );
    await insert(
      organizationId,
      "parked-exported",
      "reconciliation_required",
      "2026-09-10T00:00:00.000000Z",
    );
    await insert(
      organizationId,
      "parked-unexported",
      "reconciliation_required",
      "2026-08-10T00:00:00.000000Z",
    );
    await insert(
      organizationId,
      "parked-after-horizon",
      "reconciliation_required",
      "2026-10-10T00:00:00.000000Z",
    );
    await insert(organizationId, "acked-in-window", "acknowledged", "2026-09-11T00:00:00.000000Z");
    await insert(other, "other-parked", "reconciliation_required", "2026-09-12T00:00:00.000000Z");
    const purge = (org: string) =>
      purgeReconciliationInbox(context, { organizationId: org, limit: 100 });
    const count = async () =>
      (
        await rows<{ n: number }>(
          0,
          "SELECT count(*) AS n FROM webhook_inbox WHERE state = 'reconciliation_required'",
        )
      )[0]?.n;

    // No horizon: nothing, and the table trigger refuses a raw delete.
    expect(await purge(organizationId)).toBe(0);
    await expect(
      run(0, "DELETE FROM webhook_inbox WHERE external_event_id = 'parked-exported'"),
    ).rejects.toThrow(/verified export/u);
    // Horizon without a registered export: still nothing.
    await store.maintenance.advanceRetentionHorizon({
      shardId: 0,
      tableName: "webhook_inbox",
      exportedThrough: "2026-09-30T00:00:00.000Z",
      now: "2026-10-01T00:00:00.000Z",
    });
    expect(await purge(organizationId)).toBe(0);
    expect(await count()).toBe(4);
    // A registered export of September for this organization only.
    await store.maintenance.recordEvidenceExport({
      exportId: newUlid(),
      organizationId,
      tableName: "webhook_inbox",
      sourceFormat: "d1-control-evidence-projection-v1",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      rowCount: 1,
      sha256: "ab".repeat(32),
      r2Key: "inbox/2026-09.jsonl",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(await purge(organizationId)).toBe(1);
    expect(
      await rows(
        0,
        "SELECT external_event_id FROM webhook_inbox WHERE organization_id = ? ORDER BY external_event_id",
        organizationId,
      ),
    ).toEqual([
      { external_event_id: "acked-in-window" },
      { external_event_id: "parked-after-horizon" },
      { external_event_id: "parked-unexported" },
    ]);
    // Another tenant's matching row is untouched; the unexported and post-horizon rows stay; a repeat is a no-op.
    expect(
      await rows(0, "SELECT 1 FROM webhook_inbox WHERE external_event_id = 'other-parked'"),
    ).toHaveLength(1);
    expect(await purge(organizationId)).toBe(0);
    // A GitHub push deployment that still points at a parked event keeps it.
    const kept = (
      await rows<{ inbox_event_id: string }>(
        0,
        "SELECT inbox_event_id FROM webhook_inbox WHERE external_event_id = 'other-parked'",
      )
    )[0]?.inbox_event_id as string;
    const connection = newUlid();
    const project = projectInput(other, "gate-keeps");
    await store.projects.createInitialProject(project);
    const accepted = acceptInput(project, { idempotencyKey: "keep" });
    await store.operations.acceptApiOperation(accepted);
    await shardOf(control, 0).batch([
      shardOf(control, 0)
        .prepare(
          "INSERT INTO source_connections(organization_id, source_connection_id, project_id, billing_epoch_id, provider, external_repository_id, created_at) VALUES (?1, ?2, ?3, ?4, 'github', '42', ?5)",
        )
        .bind(other, connection, project.projectId, project.billingEpochId, AT),
      shardOf(control, 0)
        .prepare(
          "INSERT INTO repository_grants(organization_id, grant_id, project_id, billing_epoch_id, source_connection_id, provider, github_installation_id, external_repository_id, repository_owner, repository_name, permission, granted_at) VALUES (?1, ?2, ?3, ?4, ?5, 'github', '7', '42', 'o', 'r', 'contents:read', ?6)",
        )
        .bind(other, newUlid(), project.projectId, project.billingEpochId, connection, AT),
      shardOf(control, 0)
        .prepare(
          "INSERT INTO github_auto_deploy_configs(organization_id, project_id, source_connection_id, branch_ref, generation, enabled, configured_at, updated_at) VALUES (?1, ?2, ?3, 'refs/heads/main', 1, 1, ?4, ?4)",
        )
        .bind(other, project.projectId, connection, AT),
      shardOf(control, 0)
        .prepare(
          "INSERT INTO github_push_deployments(organization_id, push_deployment_id, inbox_event_id, project_id, source_connection_id, config_generation, delivery_guid, github_installation_id, external_repository_id, branch_ref, commit_sha, sequence, operation_id, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, '5e7a3c1d-0b52-4c8e-9a41-6d2f8b0c1e22', '7', '42', 'refs/heads/main', ?6, 1, ?7, 'failed', ?8, ?8)",
        )
        .bind(
          other,
          newUlid(),
          kept,
          project.projectId,
          connection,
          "b".repeat(40),
          accepted.operationId,
          AT,
        ),
    ]);
    await store.maintenance.recordEvidenceExport({
      exportId: newUlid(),
      organizationId: other,
      tableName: "webhook_inbox",
      sourceFormat: "d1-control-evidence-projection-v1",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      rowCount: 1,
      sha256: "cd".repeat(32),
      r2Key: "inbox/other-2026-09.jsonl",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(await purge(other)).toBe(0);
    expect(
      await rows(0, "SELECT 1 FROM webhook_inbox WHERE external_event_id = 'other-parked'"),
    ).toHaveLength(1);
  });
});

/** Ends an operation the way its success or failure path does: the Workflow run completes and the lease is released. */
async function endOperation(
  shard: number,
  organizationId: string,
  operationId: string,
  state: "succeeded" | "failed",
  at: string,
) {
  const db = shardOf(control, shard);
  await db.batch([
    db
      .prepare(
        "UPDATE operations SET state = ?3, failure = ?4, lease_expires_at = NULL, updated_at = ?5 WHERE organization_id = ?1 AND operation_id = ?2",
      )
      .bind(
        organizationId,
        operationId,
        state,
        state === "failed"
          ? JSON.stringify({
              code: "OPERATION_ABANDONED",
              message: "The operation stopped renewing its execution lease.",
            })
          : null,
        at,
      ),
    db
      .prepare(
        "UPDATE product_workflow_runs SET state = 'completed', terminal_evidence = ?3, completed_at = ?4, updated_at = ?4 WHERE organization_id = ?1 AND operation_id = ?2",
      )
      .bind(organizationId, operationId, JSON.stringify({ errorCode: "OPERATION_ABANDONED" }), at),
  ]);
}

describe("the publisher releases the claim of an operation that ended an hour ago", () => {
  it("releases a stale claim on a publisher tick and keeps young, placement-held and live claims", async () => {
    const stale = await seedProject(0, "claim-stale");
    const staleOp = await seedExecuting(0, stale, "claim-stale", true);
    await endOperation(
      0,
      stale.organizationId,
      staleOp.accepted.operationId,
      "failed",
      "2026-10-28T11:10:00.000000Z",
    );

    const young = await seedProject(0, "claim-young");
    const youngOp = await seedExecuting(0, young, "claim-young", true);
    await endOperation(
      0,
      young.organizationId,
      youngOp.accepted.operationId,
      "succeeded",
      "2026-10-28T12:30:00.000000Z",
    );

    // The oldest claim is held by a Neon placement (D431): it stays and must not block the stale claim behind it.
    const placed = await seedProject(0, "claim-placed");
    const placedOp = await seedExecuting(0, placed, "claim-placed", true);
    await endOperation(
      0,
      placed.organizationId,
      placedOp.accepted.operationId,
      "failed",
      "2026-10-28T11:05:00.000000Z",
    );
    await reserveNeon(0, placed, placedOp);

    const live = await seedProject(0, "claim-live");
    const liveOp = await seedExecuting(0, live, "claim-live", true);
    await run(
      0,
      "UPDATE operations SET lease_expires_at = '2026-10-28T23:00:00.000000Z' WHERE organization_id = ?1 AND operation_id = ?2",
      live.organizationId,
      liveOp.accepted.operationId,
    );

    const held = () =>
      Promise.all(
        [staleOp, youngOp, placedOp, liveOp].map(
          async (executing) =>
            (
              await rows(
                0,
                "SELECT 1 AS present FROM product_provider_mutation_claims WHERE operation_id = ?",
                executing.accepted.operationId,
              )
            ).length,
        ),
      );
    const tick = (now: string) => store.projectDispatch.recoverProductExecutionLease({ now });

    // The stale claim leaves in the tick; the claim that ended 30 minutes earlier, the placement-held one and the live one stay.
    expect(await tick("2026-10-28T13:00:00.000Z")).toBeNull();
    expect(await held()).toEqual([0, 1, 1, 1]);
    // An hour after the young operation ended, its claim leaves too.
    expect(await tick("2026-10-28T13:45:00.000Z")).toBeNull();
    expect(await held()).toEqual([0, 0, 1, 1]);
    expect(
      await rows(
        0,
        "SELECT state FROM operations WHERE operation_id = ?",
        staleOp.accepted.operationId,
      ),
    ).toEqual([{ state: "failed" }]);
  });

  it("releases the placement reservation with the claim of an operation that ended seven days ago, keeps a younger one, and admits the deletion only of the released project", async () => {
    // D431 keeps a placement reservation with its claim for seven days after its operation ended (owner approval 2026-11-15).
    const old = await seedProject(0, "placed-old");
    const oldOp = await seedExecuting(0, old, "placed-old", true, "2026-10-01T11:00:00.000000Z");
    await endOperation(
      0,
      old.organizationId,
      oldOp.accepted.operationId,
      "failed",
      "2026-10-01T11:05:00.000000Z",
    );
    await reserveNeon(0, old, oldOp, "2026-10-01T11:00:00.000000Z");

    const young = await seedProject(0, "placed-young");
    const youngOp = await seedExecuting(
      0,
      young,
      "placed-young",
      true,
      "2026-10-25T11:00:00.000000Z",
    );
    await endOperation(
      0,
      young.organizationId,
      youngOp.accepted.operationId,
      "succeeded",
      "2026-10-25T11:05:00.000000Z",
    );
    await reserveNeon(0, young, youngOp, "2026-10-25T11:00:00.000000Z");

    // The claim and the reservation of one operation: [claims, placement reservations].
    const held = async (executing: { accepted: { operationId: string } }) => [
      (
        await rows(
          0,
          "SELECT 1 AS present FROM product_provider_mutation_claims WHERE operation_id = ?",
          executing.accepted.operationId,
        )
      ).length,
      (
        await rows(
          0,
          "SELECT 1 AS present FROM neon_project_placement_reservations WHERE operation_id = ?",
          executing.accepted.operationId,
        )
      ).length,
    ];
    const tick = (now: string) => store.projectDispatch.recoverProductExecutionLease({ now });

    // On 28 October the old operation is 27 days past its end: its reservation leaves with its claim in one tick.
    // The young one is 3 days past its end and keeps both, through a later tick too.
    expect(await tick("2026-10-28T13:00:00.000Z")).toBeNull();
    expect(await held(oldOp)).toEqual([0, 0]);
    expect(await held(youngOp)).toEqual([1, 1]);
    expect(await tick("2026-10-28T13:45:00.000Z")).toBeNull();
    expect(await held(youngOp)).toEqual([1, 1]);

    // The deletion the public DELETE route submits: refused while the young claim holds the project, admitted once it is released.
    const deletion = async (project: Project, token: number) => {
      const scope = { organizationId: project.organizationId, projectId: project.projectId };
      const plan = await store.productApi.readApiDeletePlanTarget(scope);
      const admission = await store.productApi.readApiDeletionAdmission(scope);
      if (plan === null || admission === null) throw new Error("deletion plan is missing");
      const confirmation = {
        ...scope,
        issuedToPrincipalId: "user:fixture",
        action: "delete" as const,
        subjectEtag: plan.expectedEtag,
        tokenDigest: new Uint8Array(32).fill(token),
      };
      expect(
        await store.productApi.issueApiActionConfirmation({
          ...confirmation,
          confirmationId: newUlid(),
          issuedAt: "2026-10-28T13:00:00.000Z",
        }),
      ).toBe("created");
      return {
        ...scope,
        environmentId: admission.environmentId,
        billingEpochId: admission.billingEpochId,
        operationId: newUlid(),
        operationEventId: newUlid(),
        auditEventId: newUlid(),
        outboxEventId: newUlid(),
        principalId: "user:fixture",
        requestId: `placement-deletion-${token}`,
        httpMethod: "DELETE",
        routeTemplate: "/v1/projects/{project_id}",
        idempotencyKey: `placement-deletion-${token}`,
        canonicalRequestDigest: new Uint8Array(32).fill(token),
        eventType: "ProjectDeletionRequestedV1" as const,
        cleanupRunId: newUlid(),
        expectedProjectVersion: plan.expectedProjectVersion,
        expectedEtag: plan.expectedEtag,
        confirmation: { ...confirmation, consumedAt: "2026-10-28T13:00:01.000Z" },
        occurredAt: "2026-10-28T13:00:01.000Z",
      };
    };
    // The creation operations that createInitialProject queued end here, so only a held claim can refuse a deletion.
    for (const project of [old, young])
      await run(
        0,
        "UPDATE operations SET state = 'succeeded', lease_expires_at = NULL WHERE organization_id = ?1 AND project_id = ?2 AND state IN ('queued','running')",
        project.organizationId,
        project.projectId,
      );
    await expect(
      store.productApi.acceptApiProductOperation(await deletion(young, 2)),
    ).rejects.toThrow("project_operation_in_progress");
    await expect(
      store.productApi.acceptApiProductOperation(await deletion(old, 1)),
    ).resolves.toMatchObject({ state: "queued" });
  });
});
