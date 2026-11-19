import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { projectInput, seedOrganization, acceptInput } from "../support/seed.js";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import * as core from "../../src/catalog/provisioning/queue-delivery-recovery.js";
import { workflowFixture } from "./workflow-fixture.js";
import { leaseOperation } from "../support/accepted-operation.js";
import { parseUlid } from "@ohmyhost/platform";
const time = "2026-10-28T12:00:00.000Z",
  stamp = (s: string) => s.replace("Z", "000Z");
type Control = Awaited<ReturnType<typeof createTestControl>>;
/** A retained former-owner scope with its own closed epoch; current Native ownership remains one row. */
async function historicalScope(c: Control, p: ReturnType<typeof projectInput>) {
  const store = createControlStore(c.bindings),
    old = await seedOrganization(store, 2, 0),
    epoch = newUlid(),
    at = "2026-10-28T10:01:00.000000Z";
  const current = await c.core
    .prepare("SELECT * FROM projects WHERE organization_id=?1 AND project_id=?2")
    .bind(p.organizationId, p.projectId)
    .first<Record<string, unknown>>();
  if (!current) throw new Error("Missing current project fixture");
  const row = {
      ...current,
      organization_id: old,
      owner_state: "transferred",
      active_billing_epoch_id: epoch,
      updated_at: at,
    },
    columns = Object.keys(row);
  await c.core.batch([
    c.core.prepare("PRAGMA defer_foreign_keys=ON"),
    c.core
      .prepare(
        `INSERT INTO projects(${columns.join(",")})VALUES(${columns.map((_, n) => "?" + (n + 1)).join(",")})`,
      )
      .bind(...Object.values(row)),
    c.core
      .prepare(
        "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,ended_at,created_by_principal_id)VALUES(?1,?2,?3,'2026-10-28T10:00:00.000000Z',?4,'user:history-fixture')",
      )
      .bind(old, epoch, p.projectId, at),
  ]);
  expect(
    (
      await c.core
        .prepare(
          "SELECT count(*) n FROM projects WHERE project_id=?1 AND owner_state<>'transferred'",
        )
        .bind(p.projectId)
        .first()
    )?.["n"],
  ).toBe(1);
}
async function finalDelivery(c: Control, event: string, project: boolean) {
  const attempts = Array.from({ length: 5 }, () => newUlid()),
    error = project ? "PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN" : "FINAL_ATTEMPT_LEASE_EXPIRED",
    failed = "2026-10-28T12:05:00.000Z";
  const history = attempts.map((id, n) => ({
    id,
    number: n + 1,
    claimed: n === 4 ? "2026-10-28T12:04:40.000Z" : `2026-10-28T12:0${n + 1}:00.000Z`,
    lease: n === 4 ? failed : `2026-10-28T12:0${n + 1}:30.000Z`,
    status: n === 0 ? "retry_scheduled" : n === 4 ? "reconciliation_required" : "claimed",
    failed: n === 0 ? "2026-10-28T12:01:10.000Z" : n === 4 ? failed : null,
    next: n === 0 ? "2026-10-28T12:02:00.000Z" : null,
    error: n === 0 ? "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN" : n === 4 ? error : null,
  }));
  // Exactly the original first failed send, three expired leases and final fifth failed lease.
  await c.core.batch([
    c.core
      .prepare(
        "UPDATE outbox_events SET current_attempt_id=?2,attempt_count=5,max_attempts=5,last_error_code=?3,reconciliation_required_at=?4,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
      )
      .bind(event, attempts[4], error, stamp(failed)),
    ...history.map((h) =>
      c.core
        .prepare(
          "INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,status,failed_at,next_available_at,error_code,acknowledged_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL)",
        )
        .bind(
          h.id,
          event,
          h.number,
          stamp(h.claimed),
          stamp(h.lease),
          h.status,
          h.failed === null ? null : stamp(h.failed),
          h.next === null ? null : stamp(h.next),
          h.error,
        ),
    ),
  ]);
  return attempts[4] as string;
}
function identity(org: string, op: string) {
  return {
    organizationId: parseUlid(org),
    operationId: parseUlid(op),
    reconciliationId: parseUlid(newUlid()),
    preparedAuditEventId: parseUlid(newUlid()),
    finalAuditEventId: parseUlid(newUlid()),
    actorId: "user:queue-owner",
    idempotencySha256: ("sha256:" + "ab".repeat(32)) as `sha256:${string}`,
    preparedAt: "2026-10-28T12:06:00.000Z",
  };
}
it("executes the eight recovery transactions on the Core with atomic late failure, exact history/replay and positive guarded provider continuation", async () => {
  const c = await createTestControl();
  try {
    const db = c.core,
      context = { directory: db, router: new SharedCoreRouter(db) },
      store = createControlStore(c.bindings);
    const org = await seedOrganization(store, 2, 0),
      p = projectInput(org, "queue-hello-" + newUlid().toLowerCase());
    p.outbox.eventType = "ProjectProvisioningRequested";
    p.outbox.payload = { projectId: p.projectId, operationId: p.operation.operationId };
    await store.projects.createInitialProject(p);
    const helloAttempt = await finalDelivery(c, p.outbox.eventId, true);
    await historicalScope(c, p);
    const hello = identity(org, p.operation.operationId),
      hp = await core.prepareProjectProvisioningQueueDeliveryRecovery(context, hello);
    expect(hp).toEqual({
      outcome: "prepared",
      reconciliationId: hello.reconciliationId,
      organizationId: org,
      projectId: p.projectId,
      operationId: p.operation.operationId,
      requestEventId: p.outbox.eventId,
      deliveryAttemptId: helloAttempt,
      workflowId: `project-provisioning-v1-${p.outbox.eventId}-${p.operation.operationId}`,
      operationState: "queued",
    });
    if (hp.outcome !== "prepared") throw new Error("Expected exact hello candidate");
    const hf = {
      ...hello,
      projectId: hp.projectId,
      requestEventId: hp.requestEventId,
      deliveryAttemptId: hp.deliveryAttemptId,
      workflowId: hp.workflowId,
      recoveredAt: "2026-10-28T12:07:00.000Z",
      workflowOutcome: "pending" as const,
    };
    await db
      .prepare(
        "CREATE TRIGGER reject_queue_final BEFORE INSERT ON audit_events WHEN NEW.event_type='ProjectProvisioningQueueDeliveryRecovered' BEGIN SELECT RAISE(ABORT,'late queue final');END",
      )
      .run();
    await expect(
      core.finalizeProjectProvisioningQueueDeliveryRecovery(context, hf),
    ).rejects.toThrow("late queue final");
    expect(
      (
        await db
          .prepare("SELECT acknowledged_at FROM outbox_events WHERE event_id=?")
          .bind(p.outbox.eventId)
          .first()
      )?.["acknowledged_at"],
    ).toBeNull();
    await db.prepare("DROP TRIGGER reject_queue_final").run();
    expect(await core.finalizeProjectProvisioningQueueDeliveryRecovery(context, hf)).toEqual({
      outcome: "recovered",
      reconciliationId: hello.reconciliationId,
      operationId: p.operation.operationId,
      state: "pending",
    });
    expect((await core.finalizeProjectProvisioningQueueDeliveryRecovery(context, hf)).outcome).toBe(
      "duplicate",
    );
    const so = await seedOrganization(store, 2, 0),
      sp = projectInput(so, "queue-source-" + newUlid().toLowerCase());
    await store.projects.createInitialProject(sp);
    const accepted = acceptInput(sp, { eventType: "SourceLinkRequestedV1" });
    await store.operations.acceptApiOperation(accepted);
    const sw = `product-command-v1-source-link-${accepted.outboxEventId}-${accepted.operationId}`;
    await db.batch([
      db
        .prepare(
          "INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,installation_id,repository_owner,repository_name,created_at)VALUES(?1,?2,?3,?4,?5,'SourceLinkRequestedV1','42','owner','repo',?6)",
        )
        .bind(
          so,
          sp.projectId,
          sp.developmentEnvironmentId,
          accepted.operationId,
          sp.billingEpochId,
          stamp(time),
        ),
      db
        .prepare(
          "INSERT INTO product_workflow_runs(workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,state,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,'SourceLinkRequestedV1','queued',?8,?8)",
        )
        .bind(
          sw,
          accepted.outboxEventId,
          so,
          sp.projectId,
          sp.developmentEnvironmentId,
          accepted.operationId,
          sp.billingEpochId,
          stamp(time),
        ),
    ]);
    const sourceAttempt = await finalDelivery(c, accepted.outboxEventId, false);
    await historicalScope(c, sp);
    const si = identity(so, accepted.operationId),
      sr = await core.prepareSourceLinkQueueDeliveryRecovery(context, si);
    expect(sr).toEqual({
      outcome: "prepared",
      reconciliationId: si.reconciliationId,
      organizationId: so,
      projectId: sp.projectId,
      environmentId: sp.developmentEnvironmentId,
      operationId: accepted.operationId,
      billingEpochId: sp.billingEpochId,
      requestEventId: accepted.outboxEventId,
      deliveryAttemptId: sourceAttempt,
      workflowId: sw,
      originalMessage: {
        version: 1,
        eventType: "SourceLinkRequestedV1",
        eventId: accepted.outboxEventId,
        organizationId: so,
        projectId: sp.projectId,
        billingEpochId: sp.billingEpochId,
        environmentId: sp.developmentEnvironmentId,
        operationId: accepted.operationId,
      },
    });
    if (sr.outcome !== "prepared") throw new Error("Expected source candidate");
    const sf = {
      ...si,
      projectId: sr.projectId,
      environmentId: sr.environmentId,
      billingEpochId: sr.billingEpochId,
      requestEventId: sr.requestEventId,
      deliveryAttemptId: sr.deliveryAttemptId,
      workflowId: sr.workflowId,
      recoveredAt: "2026-10-28T12:07:00.000Z",
      workflowOutcome: "errored" as const,
    };
    const closed = {
      outcome: "recovered",
      reconciliationId: si.reconciliationId,
      operationId: accepted.operationId,
      state: "completed",
    };
    // The SourceLink Workflow ran its first step, which renewed the operation's lease before it errored.
    await leaseOperation(db, accepted.operationId);
    expect(await core.finalizeSourceLinkQueueDeliveryRecovery(context, sf)).toEqual(closed);
    expect(
      await db
        .prepare("SELECT state,failure,lease_expires_at FROM operations WHERE operation_id=?1")
        .bind(accepted.operationId)
        .first(),
    ).toEqual({
      state: "failed",
      failure:
        '{"code":"SOURCE_LINK_WORKFLOW_ERRORED","message":"The source link could not be completed."}',
      lease_expires_at: null,
    });
    expect(await core.readClosedSourceLinkQueueDeliveryRecovery(context, si)).toEqual(closed);
    const attempt = newUlid(),
      physical = "product-command-replay-v1-" + attempt,
      digest = new Uint8Array(32).fill(9),
      failureId = newUlid();
    await db.batch([
      db
        .prepare(
          "INSERT INTO product_workflow_replay_attempts(attempt_id,organization_id,project_id,environment_id,operation_id,event_id,billing_epoch_id,logical_workflow_id,physical_workflow_id,event_type,idempotency_sha256,attempt_number,actor_id,created_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'SourceLinkRequestedV1',?10,1,?11,?12)",
        )
        .bind(
          attempt,
          so,
          sp.projectId,
          sp.developmentEnvironmentId,
          accepted.operationId,
          accepted.outboxEventId,
          sp.billingEpochId,
          sw,
          physical,
          digest,
          si.actorId,
          stamp(sf.recoveredAt),
        ),
      db
        .prepare(
          "INSERT INTO product_workflow_replay_failures(failure_id,attempt_id,organization_id,operation_id,physical_workflow_id,terminal_status,evidence_sha256,actor_id,created_at)VALUES(?1,?2,?3,?4,?5,'errored',?6,?7,?8)",
        )
        .bind(
          failureId,
          attempt,
          so,
          accepted.operationId,
          physical,
          digest,
          si.actorId,
          stamp(sf.recoveredAt),
        ),
    ]);
    const terminal = {
      organizationId: si.organizationId,
      operationId: si.operationId,
      attemptId: parseUlid(attempt),
      actorId: si.actorId,
      idempotencyDigest: digest,
    };
    expect(await core.readTerminalSourceLinkWorkflowReplayAttempt(context, terminal)).toEqual({
      outcome: "completed",
      attemptId: parseUlid(attempt),
    });
    const d = await workflowFixture(c);
    const deploymentAttempt = await finalDelivery(c, d.accepted.outboxEventId, false);
    await historicalScope(c, d.p);
    const di = identity(d.p.organizationId, d.input.operationId),
      dp = await core.prepareDeploymentQueueDeliveryRecovery(context, di);
    expect(dp).toEqual({
      outcome: "prepared",
      reconciliationId: di.reconciliationId,
      organizationId: d.p.organizationId,
      projectId: d.p.projectId,
      environmentId: d.input.environmentId,
      operationId: d.input.operationId,
      billingEpochId: d.p.billingEpochId,
      requestEventId: d.input.eventId,
      deliveryAttemptId: deploymentAttempt,
      planId: d.plan,
      deploymentId: d.deployment,
      workflowId: d.input.logicalWorkflowId,
      originalMessage: {
        version: 1,
        eventType: "DeploymentRequestedV1",
        eventId: d.input.eventId,
        organizationId: d.p.organizationId,
        projectId: d.p.projectId,
        billingEpochId: d.p.billingEpochId,
        environmentId: d.input.environmentId,
        operationId: d.input.operationId,
        planId: d.plan,
      },
    });
    if (dp.outcome !== "prepared") throw new Error("Expected deployment candidate");
    // Actual positive provider context is part of the final close, with its same-batch observation plan.
    const hint = JSON.stringify({ providerReconciliationHint: { phase: "source" } }),
      at = "2026-10-28T12:06:30.000Z";
    await db.batch([
      db
        .prepare(
          "INSERT INTO product_provider_mutation_claims(claim_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_id,logical_workflow_id,event_type,accepted_lifecycle_version,claimed_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'DeploymentRequestedV1',1,?9)",
        )
        .bind(
          d.input.claimId,
          d.p.organizationId,
          d.p.projectId,
          d.input.environmentId,
          d.input.operationId,
          d.p.billingEpochId,
          d.input.eventId,
          d.input.logicalWorkflowId,
          stamp(at),
        ),
      db
        .prepare(
          "UPDATE deployments SET status='reconciliation_required',updated_at=?2 WHERE deployment_id=?1",
        )
        .bind(d.deployment, stamp(at)),
      db
        .prepare(
          "UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code='PROVIDER_OBSERVATION_UNCERTAIN',intermediate_evidence=?2,updated_at=?3 WHERE workflow_id=?1",
        )
        .bind(d.input.logicalWorkflowId, hint, stamp(at)),
    ]);
    const df = {
      ...di,
      eventType: "DeploymentRequestedV1" as const,
      projectId: dp.projectId,
      environmentId: dp.environmentId,
      billingEpochId: dp.billingEpochId,
      requestEventId: dp.requestEventId,
      deliveryAttemptId: dp.deliveryAttemptId,
      planId: dp.planId,
      deploymentId: dp.deploymentId,
      workflowId: dp.workflowId,
      recoveredAt: "2026-10-28T12:07:00.000Z",
      workflowOutcome: "complete" as const,
    };
    expect(await core.finalizeDeploymentQueueDeliveryRecovery(context, df)).toEqual({
      outcome: "recovered",
      reconciliationId: di.reconciliationId,
      operationId: d.input.operationId,
      state: "pending",
      continueProviderReconciliation: true,
    });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 120000);
