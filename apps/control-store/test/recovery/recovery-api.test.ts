import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { seedDeletionIntent } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { beforeFirstWrite, seedProject, ulidOf, STORED_NOW } from "../support/platform-fixtures.js";

let control: TestControl;
let sequence = 0;
const next = () => ulidOf("recovery-api", ++sequence);
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => {
  await control?.dispose();
});

function request(p: Awaited<ReturnType<typeof seedProject>>, at = "2026-10-28T11:00:00.000Z") {
  return {
    organizationId: p.organizationId,
    projectId: p.projectId,
    principalId: "user:recovery-api",
    requestId: next(),
    idempotencyKey: next(),
    canonicalRequestDigest: "ab".repeat(32),
    operationId: next(),
    operationEventId: next(),
    auditEventId: next(),
    outboxEventId: next(),
    occurredAt: at,
    archiveBucket: "ohmyho-development-backups",
    sealedInput: {
      ciphertext: new Uint8Array(17).fill(3),
      nonce: new Uint8Array(12).fill(4),
      keyVersion: 1,
    },
  };
}

const mutation = (r: ReturnType<typeof request>, at = "2026-10-28T11:00:01.000Z") => ({
  organizationId: r.organizationId,
  projectId: r.projectId,
  operationId: r.operationId,
  claimId: UUID,
  occurredAt: at,
  operationEventId: next(),
  auditEventId: next(),
});

it("anchors an export to actual Prod when no canonical Dev exists and preserves keyed replay without creating Dev", async () => {
  const store = createControlStore(control.bindings),
    p = await seedProject(control, { prodOnly: true }),
    r = request(p);
  expect(await store.recovery.owner.acceptProjectExport(r)).toMatchObject({ outcome: "created" });
  expect(
    await p.shard
      .prepare("SELECT environment_id FROM project_recovery_jobs WHERE operation_id=?1")
      .bind(r.operationId)
      .first(),
  ).toEqual({ environment_id: p.prodEnvironmentId });
  expect(await store.recovery.owner.acceptProjectExport(r)).toMatchObject({ outcome: "replayed" });
  expect(
    (
      await p.shard
        .prepare(
          "SELECT environment_id,name FROM environments WHERE organization_id=?1 AND project_id=?2 AND name IN('dev','prod')",
        )
        .bind(p.organizationId, p.projectId)
        .all()
    ).results,
  ).toEqual([{ environment_id: p.prodEnvironmentId, name: "prod" }]);
  const racing = await seedProject(control, { prodOnly: true }),
    changed = request(racing);
  const delayed = createControlStore({
    ...control.bindings,
    CONTROL_CORE: beforeFirstWrite(control.core, async () => {
      await racing.shard
        .prepare(
          "INSERT INTO environments(organization_id,environment_id,project_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at) VALUES(?1,?2,?3,'dev','{}',0,1,?4,?4)",
        )
        .bind(racing.organizationId, racing.devEnvironmentId, racing.projectId, STORED_NOW)
        .run();
    }),
  });
  await expect(delayed.recovery.owner.acceptProjectExport(changed)).rejects.toThrow();
  expect(
    await racing.shard
      .prepare("SELECT 1 FROM project_recovery_jobs WHERE operation_id=?1")
      .bind(changed.operationId)
      .first(),
  ).toBeNull();
});

it("keeps the Dev anchor, exact keyed replay, and the original GLOBAL project export quota across retained owner scopes", async () => {
  const store = createControlStore(control.bindings),
    a = await seedProject(control),
    r = request(a);
  const first = await store.recovery.owner.acceptProjectExport(r);
  expect(first).toMatchObject({
    outcome: "created",
    response: { httpStatus: 202, responseBody: { id: r.operationId, state: "queued" } },
  });
  expect(
    await store.recovery.owner.readExportReplay({
      organizationId: r.organizationId,
      projectId: r.projectId,
      principalId: r.principalId,
      idempotencyKey: r.idempotencyKey,
      canonicalRequestDigest: r.canonicalRequestDigest,
    }),
  ).toMatchObject({
    outcome: "replayed",
    operation: { operationId: r.operationId, state: "queued" },
  });
  expect(
    await store.recovery.owner.readExportReplay({
      organizationId: r.organizationId,
      projectId: r.projectId,
      principalId: r.principalId,
      idempotencyKey: r.idempotencyKey,
      canonicalRequestDigest: "cd".repeat(32),
    }),
  ).toEqual({ outcome: "conflict" });
  const job = await control.core
    .prepare("SELECT environment_id FROM project_recovery_jobs WHERE operation_id=?")
    .bind(r.operationId)
    .first();
  expect(job).toEqual({ environment_id: a.devEnvironmentId });
  await store.recovery.executor.claim(mutation(r));
  await store.recovery.executor.finish({
    ...mutation(r, "2026-10-28T11:00:02.000Z"),
    failureCode: "RECOVERY_JOB_FAILED",
  });
  const replay = await store.recovery.owner.readExportReplay({
    organizationId: r.organizationId,
    projectId: r.projectId,
    principalId: r.principalId,
    idempotencyKey: r.idempotencyKey,
    canonicalRequestDigest: r.canonicalRequestDigest,
  });
  expect(replay).toMatchObject({
    outcome: "replayed",
    operation: { operationId: r.operationId, state: "failed" },
  });
  const b = await seedProject(control),
    epoch = next(),
    transfer = "2026-10-28T11:00:03.000000Z";
  // A faithful history import of the ownership transition. Earlier job/operation/event/epoch rows retain A exactly.
  await control.core.batch([
    control.core
      .prepare(
        "UPDATE billing_epochs SET ended_at=?3 WHERE organization_id=?1 AND billing_epoch_id=?2",
      )
      .bind(a.organizationId, a.billingEpochId, transfer),
    control.core
      .prepare(
        "UPDATE projects SET owner_state='transferred',updated_at=?3 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(a.organizationId, a.projectId, transfer),
    control.core
      .prepare(
        `INSERT INTO projects(organization_id,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,owner_state,ownership_version,active_billing_epoch_id,data_mode,region,dev_access_mode,created_at,updated_at)
      SELECT ?1,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,'active',2,?3,data_mode,region,dev_access_mode,created_at,?4 FROM projects WHERE organization_id=?2 AND project_id=?5`,
      )
      .bind(b.organizationId, a.organizationId, epoch, transfer, a.projectId),
    control.core
      .prepare(
        "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,created_by_principal_id) VALUES (?1,?2,?3,?4,'user:import')",
      )
      .bind(b.organizationId, epoch, a.projectId, transfer),
    control.core
      .prepare(
        `INSERT INTO environments(organization_id,environment_id,project_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at)
      SELECT ?1,environment_id,project_id,name,desired_state,0,dev_access_epoch,created_at,?4 FROM environments WHERE organization_id=?2 AND project_id=?3`,
      )
      .bind(b.organizationId, a.organizationId, a.projectId, transfer),
  ]);
  const later = { ...request(a, "2026-10-28T11:00:04.000Z"), organizationId: b.organizationId };
  expect(await store.recovery.owner.acceptProjectExport(later)).toEqual({
    outcome: "limited",
    retryAt: "2026-10-29T11:00:00.000Z",
  });
  expect(
    (
      await control.core
        .prepare("SELECT count(*) AS n FROM project_recovery_jobs WHERE project_id=?")
        .bind(a.projectId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(
    await control.core
      .prepare("SELECT organization_id FROM project_recovery_jobs WHERE operation_id=?")
      .bind(r.operationId)
      .first(),
  ).toEqual({ organization_id: a.organizationId });
  expect(
    await store.recovery.owner.acceptProjectExport({
      ...later,
      occurredAt: "2026-10-29T11:00:00.001Z",
    }),
  ).toMatchObject({ outcome: "created" });
}, 30_000);

it("derives purge authority only from an accepted open deletion and the one EXACT frozen archive locator", async () => {
  const store = createControlStore(control.bindings),
    p = await seedProject(control),
    r = request(p),
    m = mutation(r);
  await store.recovery.owner.acceptProjectExport(r);
  await store.recovery.executor.claim(m);
  const fence = await store.recovery.executor.acquireFence({
    organizationId: r.organizationId,
    projectId: r.projectId,
    operationId: r.operationId,
    claimId: UUID,
    holderId: UUID,
    now: m.occurredAt,
    leaseMilliseconds: 300_000,
  });
  const archive = {
    sqlFiles: ["shared.sql"],
    bytes: 100,
    sha256: new Uint8Array(32).fill(7),
    capturedAt: "2026-10-28T11:00:02.000Z",
  };
  await store.recovery.executor.prepareArchive({
    ...mutation(r, "2026-10-28T11:00:02.500Z"),
    archive,
    fence: { epoch: fence.epoch, holderId: UUID },
  });
  await store.recovery.executor.finish({
    ...mutation(r, "2026-10-28T11:00:03.000Z"),
    archive,
    fence: { epoch: fence.epoch, holderId: UUID },
  });
  const deletion = next(),
    cleanup = next(),
    key = `snapshots/${p.organizationId}/${p.projectId}/${r.operationId}.zip`,
    bucket = "ohmyho-development-backups";
  const scope = {
    organizationId: p.organizationId,
    projectId: p.projectId,
    operationId: deletion,
    exportId: r.operationId,
  };
  await expect(store.recovery.cleanup.readCleanupTarget(scope)).rejects.toThrow(
    "recovery_cleanup_scope_unavailable",
  );
  // Only a guarded-reader fixture: the full multi-provider deletion acceptance writer remains its own upstream port.
  await control.core.batch([
    control.core
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=2 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId),
    control.core
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES (?1,?2,?3,'queued',?4,?5,?5)",
      )
      .bind(p.organizationId, deletion, p.projectId, p.billingEpochId, STORED_NOW),
    control.core
      .prepare(
        "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,'pending',1,?5,?5)",
      )
      .bind(p.organizationId, cleanup, p.projectId, deletion, STORED_NOW),
  ]);
  await seedDeletionIntent(p, p.devEnvironmentId, deletion, { cleanupRunId: cleanup });
  await expect(store.recovery.cleanup.readCleanupTarget(scope)).rejects.toThrow(
    "recovery_cleanup_scope_unavailable",
  );
  const locator = `encoded/${Buffer.from(`${bucket}/${key}`).toString("base64url")}`;
  await control.core
    .prepare(
      "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES (?1,?2,?3,?4,'cloudflare','sql-export',?5,?6,?7)",
    )
    .bind(
      p.organizationId,
      next(),
      p.projectId,
      deletion,
      new Uint8Array(32).fill(5),
      STORED_NOW,
      locator,
    )
    .run();
  expect(await store.recovery.cleanup.readCleanupTarget(scope)).toEqual({
    exportId: r.operationId,
    bucket,
    key,
  });
  await expect(
    store.recovery.cleanup.readCleanupTarget({ ...scope, exportId: next() }),
  ).rejects.toThrow("recovery_cleanup_scope_unavailable");
  await control.core
    .prepare(
      "UPDATE cleanup_runs SET state='succeeded',completed_at=?3,updated_at=?3 WHERE organization_id=?1 AND cleanup_run_id=?2",
    )
    .bind(p.organizationId, cleanup, STORED_NOW)
    .run();
  await expect(store.recovery.cleanup.readCleanupTarget(scope)).rejects.toThrow(
    "recovery_cleanup_scope_unavailable",
  );
}, 30_000);

it("rolls exhausted job termination and outbox reconciliation back together, replays once, and waits for a live capture", async () => {
  const store = createControlStore(control.bindings);
  const exhausted = async () => {
    const p = await seedProject(control),
      r = request(p);
    await store.recovery.owner.acceptProjectExport(r);
    let attemptId = next();
    for (let i = 0; i < 5; i++) {
      attemptId = next();
      const claimed = await store.operations.claimOutboxEvent({
        eventScope: {
          organizationId: r.organizationId,
          projectId: r.projectId,
          operationId: r.operationId,
          eventId: r.outboxEventId,
        },
        attemptId,
        supportedEventTypes: ["ProjectRecoveryRequestedV1"],
        now: new Date(Date.parse(r.occurredAt) + (i + 1) * 10).toISOString(),
        leaseMilliseconds: 1,
      });
      expect(claimed?.attemptNumber).toBe(i + 1);
    }
    return {
      r,
      attemptId,
      failure: {
        ...mutation(r),
        terminalOperationEventId: next(),
        terminalAuditEventId: next(),
        eventId: r.outboxEventId,
        attemptId,
        deliveryAuditEventId: next(),
        errorCode: "RECOVERY_DISPATCH_UNAVAILABLE",
      },
    };
  };
  const a = await exhausted();
  const originalAttempts = await control.core
    .prepare("SELECT * FROM delivery_attempts WHERE event_id=? ORDER BY attempt_number")
    .bind(a.r.outboxEventId)
    .all();
  expect(originalAttempts.results).toHaveLength(5);
  await control.core
    .prepare(
      "CREATE TRIGGER recovery_test_delivery_abort BEFORE UPDATE ON delivery_attempts WHEN NEW.status='reconciliation_required' BEGIN SELECT RAISE(ABORT,'late delivery failure'); END",
    )
    .run();
  await expect(store.recovery.owner.recordDispatchFailure(a.failure)).rejects.toThrow(
    "late delivery failure",
  );
  expect(
    await control.core
      .prepare("SELECT state FROM operations WHERE operation_id=?")
      .bind(a.r.operationId)
      .first(),
  ).toEqual({ state: "queued" });
  expect(
    (
      await control.core
        .prepare("SELECT count(*) AS n FROM operation_events WHERE operation_id=?")
        .bind(a.r.operationId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(
    (
      await control.core
        .prepare("SELECT * FROM delivery_attempts WHERE event_id=? ORDER BY attempt_number")
        .bind(a.r.outboxEventId)
        .all()
    ).results,
  ).toEqual(originalAttempts.results);
  expect(
    (
      await control.core
        .prepare(
          "SELECT input_ciphertext IS NOT NULL AS retained FROM project_recovery_jobs WHERE operation_id=?",
        )
        .bind(a.r.operationId)
        .first<{ retained: number }>()
    )?.retained,
  ).toBe(1);
  await control.core.prepare("DROP TRIGGER recovery_test_delivery_abort").run();
  expect(
    await Promise.all([
      store.recovery.owner.recordDispatchFailure(a.failure),
      store.recovery.owner.recordDispatchFailure(a.failure),
    ]),
  ).toEqual([{ outcome: "reconciliation_required" }, { outcome: "reconciliation_required" }]);
  expect(
    await control.core
      .prepare("SELECT state FROM operations WHERE operation_id=?")
      .bind(a.r.operationId)
      .first(),
  ).toEqual({ state: "failed" });
  const completedAttempts = (
    await control.core
      .prepare(
        "SELECT status,error_code,failed_at,next_available_at,acknowledged_at FROM delivery_attempts WHERE event_id=? ORDER BY attempt_number",
      )
      .bind(a.r.outboxEventId)
      .all()
  ).results;
  expect(completedAttempts.map((row) => row["status"])).toEqual([
    "claimed",
    "claimed",
    "claimed",
    "claimed",
    "reconciliation_required",
  ]);
  expect(completedAttempts[4]).toMatchObject({
    error_code: "RECOVERY_DISPATCH_UNAVAILABLE",
    next_available_at: null,
    acknowledged_at: null,
  });
  expect(
    (
      await control.core
        .prepare("SELECT count(*) AS n FROM operation_events WHERE operation_id=?")
        .bind(a.r.operationId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(3);
  expect(await store.recovery.owner.recordDispatchFailure(a.failure)).toEqual({
    outcome: "reconciliation_required",
  });
  expect(
    (
      await control.core
        .prepare("SELECT count(*) AS n FROM operation_events WHERE operation_id=?")
        .bind(a.r.operationId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(3);

  const b = await exhausted();
  await store.recovery.executor.claim(mutation(b.r));
  const lease = await store.recovery.executor.acquireFence({
    organizationId: b.r.organizationId,
    projectId: b.r.projectId,
    operationId: b.r.operationId,
    claimId: UUID,
    holderId: UUID,
    now: "2026-10-28T11:00:01.000Z",
    leaseMilliseconds: 300_000,
  });
  expect(
    await store.recovery.owner.recordDispatchFailure({
      ...b.failure,
      occurredAt: "2026-10-28T11:00:02.000Z",
    }),
  ).toEqual({ outcome: "waiting" });
  expect(
    await control.core
      .prepare("SELECT state FROM operations WHERE operation_id=?")
      .bind(b.r.operationId)
      .first(),
  ).toEqual({ state: "running" });
  expect(
    (
      await control.core
        .prepare("SELECT reconciliation_required_at FROM outbox_events WHERE event_id=?")
        .bind(b.r.outboxEventId)
        .first()
    )?.["reconciliation_required_at"],
  ).toBeNull();
  const archive = {
    sqlFiles: ["shared.sql"],
    bytes: 100,
    sha256: new Uint8Array(32).fill(8),
    capturedAt: "2026-10-28T11:00:02.000Z",
  };
  await store.recovery.executor.prepareArchive({
    ...mutation(b.r, "2026-10-28T11:00:03.000Z"),
    archive,
    fence: { epoch: lease.epoch, holderId: UUID },
  });
  await store.recovery.executor.finish({
    ...mutation(b.r, "2026-10-28T11:00:04.000Z"),
    archive,
    fence: { epoch: lease.epoch, holderId: UUID },
  });
  expect(
    await store.recovery.owner.recordDispatchFailure({
      ...b.failure,
      occurredAt: "2026-10-28T11:00:05.000Z",
    }),
  ).toEqual({ outcome: "acknowledged" });
  expect(
    await control.core
      .prepare("SELECT state FROM operations WHERE operation_id=?")
      .bind(b.r.operationId)
      .first(),
  ).toEqual({ state: "succeeded" });
  expect(
    (
      await control.core
        .prepare(
          "SELECT acknowledged_at IS NOT NULL AS acknowledged FROM outbox_events WHERE event_id=?",
        )
        .bind(b.r.outboxEventId)
        .first<{ acknowledged: number }>()
    )?.acknowledged,
  ).toBe(1);
  expect(
    await control.core
      .prepare(
        "SELECT attempt.status,attempt.acknowledged_at=event.acknowledged_at AS same FROM delivery_attempts attempt JOIN outbox_events event ON event.event_id=attempt.event_id WHERE event.event_id=? AND attempt.attempt_id=event.current_attempt_id",
      )
      .bind(b.r.outboxEventId)
      .first(),
  ).toEqual({ status: "acknowledged", same: 1 });
}, 30_000);
