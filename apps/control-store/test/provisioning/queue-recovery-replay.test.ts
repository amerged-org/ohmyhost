import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import * as core from "../../src/catalog/provisioning/queue-delivery-recovery.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { acceptInput, projectInput, seedOrganization } from "../support/seed.js";
import { workflowFixture } from "./workflow-fixture.js";

/**
 * In-process replays of the queue-delivery recovery commands: the PostgreSQL-differential test proves the first
 * prepare/finalize against the original; these tests drive the replay, refusal and continuation branches that only
 * a second call, a different outcome or a different event type reaches.
 */
let c: TestControl;
let store: ReturnType<typeof createControlStore>;
let context: { directory: TestControl["core"]; router: SharedCoreRouter };
beforeAll(async () => {
  c = await createTestControl();
  store = createControlStore(c.bindings);
  context = { directory: c.core, router: new SharedCoreRouter(c.core) };
});
afterAll(async () => c.dispose());

const stamp = (s: string) => s.replace("Z", "000Z");

/** Exactly the original first failed send, three expired leases and the final failed fifth lease. */
async function finalDelivery(event: string, project: boolean, finalCode?: string) {
  const attempts = Array.from({ length: 5 }, () => newUlid()),
    error =
      finalCode ??
      (project ? "PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN" : "FINAL_ATTEMPT_LEASE_EXPIRED"),
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

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
/** The Outbox still signals reconciliation, but its last error is not the final lease expiry. */
async function markSignalOnly(event: string) {
  await c.core
    .prepare(
      "UPDATE outbox_events SET last_error_code='PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN' WHERE event_id=?1",
    )
    .bind(event)
    .run();
}
async function insertClaim(d: Fixture, at: string) {
  await c.core
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
    )
    .run();
}
/** The workflow stopped at an uncertain provider observation, the way the Workflow leaves it. */
async function reconciliationRequired(d: Fixture, at: string) {
  await c.core.batch([
    c.core
      .prepare(
        "UPDATE deployments SET status='reconciliation_required',updated_at=?2 WHERE deployment_id=?1",
      )
      .bind(d.deployment, stamp(at)),
    c.core
      .prepare(
        "UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code='PROVIDER_OBSERVATION_UNCERTAIN',intermediate_evidence=?2,updated_at=?3 WHERE workflow_id=?1",
      )
      .bind(
        d.input.logicalWorkflowId,
        JSON.stringify({ providerReconciliationHint: { phase: "source" } }),
        stamp(at),
      ),
  ]);
}

describe("project provisioning queue recovery", () => {
  it("prepares the final recovery of a request parked as a send timeout or an expired final lease, and still refuses a configuration error", async () => {
    for (const code of ["PROJECT_PROVISIONING_QUEUE_SEND_TIMEOUT", "FINAL_ATTEMPT_LEASE_EXPIRED"]) {
      const org = await seedOrganization(store, 2, 0),
        p = projectInput(org, "queue-parked-" + newUlid().toLowerCase());
      p.outbox.eventType = "ProjectProvisioningRequested";
      p.outbox.payload = { projectId: p.projectId, operationId: p.operation.operationId };
      await store.projects.createInitialProject(p);
      await finalDelivery(p.outbox.eventId, true, code);
      const hello = identity(org, p.operation.operationId),
        prepared = await core.prepareProjectProvisioningQueueDeliveryRecovery(context, hello);
      if (prepared.outcome !== "prepared") throw new Error("Expected the parked request candidate");
      expect(
        await core.finalizeProjectProvisioningQueueDeliveryRecovery(context, {
          ...hello,
          projectId: prepared.projectId,
          requestEventId: prepared.requestEventId,
          deliveryAttemptId: prepared.deliveryAttemptId,
          workflowId: prepared.workflowId,
          recoveredAt: "2026-10-28T12:07:00.000Z",
          workflowOutcome: "pending",
        }),
      ).toMatchObject({ outcome: "recovered", state: "pending" });
      // a later prepare of the same request answers from its final audit, which checks the parked code again
      expect(
        await core.prepareProjectProvisioningQueueDeliveryRecovery(context, hello),
      ).toMatchObject({
        outcome: "recovered",
        state: "pending",
      });
    }

    const org = await seedOrganization(store, 2, 0),
      p = projectInput(org, "queue-config-" + newUlid().toLowerCase());
    p.outbox.eventType = "ProjectProvisioningRequested";
    p.outbox.payload = { projectId: p.projectId, operationId: p.operation.operationId };
    await store.projects.createInitialProject(p);
    await finalDelivery(p.outbox.eventId, true, "PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR");
    await expect(
      core.prepareProjectProvisioningQueueDeliveryRecovery(
        context,
        identity(org, p.operation.operationId),
      ),
    ).rejects.toThrow("not an exact final Queue-send recovery candidate");
  });

  it("answers unknown scopes, replays a prepared and a closed recovery and keeps a queued terminal Workflow uncertain", async () => {
    const org = await seedOrganization(store, 2, 0),
      p = projectInput(org, "queue-hello-" + newUlid().toLowerCase());
    p.outbox.eventType = "ProjectProvisioningRequested";
    p.outbox.payload = { projectId: p.projectId, operationId: p.operation.operationId };
    await store.projects.createInitialProject(p);
    await finalDelivery(p.outbox.eventId, true);

    // No such operation anywhere: not applicable, nothing written.
    expect(
      await core.prepareProjectProvisioningQueueDeliveryRecovery(context, identity(org, newUlid())),
    ).toEqual({
      outcome: "not_applicable",
    });

    const hello = identity(org, p.operation.operationId),
      prepared = await core.prepareProjectProvisioningQueueDeliveryRecovery(context, hello);
    if (prepared.outcome !== "prepared") throw new Error("Expected the exact hello candidate");
    // The same request replays the persisted prepared audit instead of writing a second one.
    expect(await core.prepareProjectProvisioningQueueDeliveryRecovery(context, hello)).toEqual(
      prepared,
    );
    await expect(
      core.prepareProjectProvisioningQueueDeliveryRecovery(context, {
        ...hello,
        preparedAuditEventId: parseUlid(newUlid()),
      }),
    ).rejects.toThrow("already prepared");
    const audits = () =>
      c.core
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE operation_id=?1 AND event_type LIKE 'ProjectProvisioningQueueDelivery%'",
        )
        .bind(p.operation.operationId)
        .first<{ n: number }>();
    expect(await audits()).toEqual({ n: 1 });

    const finalize = {
      ...hello,
      projectId: prepared.projectId,
      requestEventId: prepared.requestEventId,
      deliveryAttemptId: prepared.deliveryAttemptId,
      workflowId: prepared.workflowId,
      recoveredAt: "2026-10-28T12:07:00.000Z",
    };
    // A terminal Workflow of a still queued operation is not provable: no write.
    expect(
      await core.finalizeProjectProvisioningQueueDeliveryRecovery(context, {
        ...finalize,
        workflowOutcome: "complete",
      }),
    ).toMatchObject({ outcome: "uncertain", state: "uncertain" });
    expect(await audits()).toEqual({ n: 1 });

    expect(
      await core.finalizeProjectProvisioningQueueDeliveryRecovery(context, {
        ...finalize,
        workflowOutcome: "pending",
      }),
    ).toMatchObject({ outcome: "recovered", state: "pending" });
    expect(
      await core.finalizeProjectProvisioningQueueDeliveryRecovery(context, {
        ...finalize,
        workflowOutcome: "pending",
      }),
    ).toMatchObject({ outcome: "duplicate", state: "pending" });
    // A later prepare of the same request answers from the final audit.
    expect(
      await core.prepareProjectProvisioningQueueDeliveryRecovery(context, hello),
    ).toMatchObject({
      outcome: "recovered",
      state: "pending",
    });
    expect(await audits()).toEqual({ n: 2 });
  });

  it("refuses a project that already holds a provider claim", async () => {
    const d = await workflowFixture(c);
    await insertClaim(d, "2026-10-28T12:00:00.000Z");
    // the project of the claim is no provisioning candidate any more, whatever its Queue delivery looks like
    await expect(
      core.prepareProjectProvisioningQueueDeliveryRecovery(
        context,
        identity(d.p.organizationId, d.p.operation.operationId),
      ),
    ).rejects.toThrow("not an exact final Queue-send recovery candidate");
  });
});

describe("deployment queue recovery", () => {
  it("replays a prepared and a closed recovery and continues a provider reconciliation exactly once", async () => {
    const d = await workflowFixture(c);
    await finalDelivery(d.accepted.outboxEventId, false);
    const di = identity(d.p.organizationId, d.input.operationId),
      prepared = await core.prepareDeploymentQueueDeliveryRecovery(context, di);
    if (prepared.outcome !== "prepared") throw new Error("Expected the deployment candidate");
    expect(await core.prepareDeploymentQueueDeliveryRecovery(context, di)).toEqual(prepared);

    await insertClaim(d, "2026-10-28T12:06:30.000Z");
    await reconciliationRequired(d, "2026-10-28T12:06:30.000Z");
    const finalize = {
      ...di,
      eventType: "DeploymentRequestedV1" as const,
      projectId: prepared.projectId,
      environmentId: prepared.environmentId,
      billingEpochId: prepared.billingEpochId,
      requestEventId: prepared.requestEventId,
      deliveryAttemptId: prepared.deliveryAttemptId,
      planId: prepared.planId,
      deploymentId: prepared.deploymentId,
      workflowId: prepared.workflowId,
      recoveredAt: "2026-10-28T12:07:00.000Z",
      workflowOutcome: "complete" as const,
    };
    const closed = await core.finalizeDeploymentQueueDeliveryRecovery(context, finalize);
    expect(closed).toMatchObject({
      outcome: "recovered",
      continueProviderReconciliation: true,
      state: "pending",
    });
    expect(await core.finalizeDeploymentQueueDeliveryRecovery(context, finalize)).toMatchObject({
      outcome: "duplicate",
    });
    expect(await core.prepareDeploymentQueueDeliveryRecovery(context, di)).toMatchObject({
      outcome: "recovered",
    });
  });

  it("prepares the recovery of a deployment whose final Queue send was uncertain, and closes it", async () => {
    const d = await workflowFixture(c);
    await finalDelivery(d.accepted.outboxEventId, false, "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN");
    const di = identity(d.p.organizationId, d.input.operationId),
      prepared = await core.prepareDeploymentQueueDeliveryRecovery(context, di);
    expect(prepared).toMatchObject({ outcome: "prepared" });
    if (prepared.outcome !== "prepared") throw new Error("Expected the deployment candidate");
    await insertClaim(d, "2026-10-28T12:06:30.000Z");
    await reconciliationRequired(d, "2026-10-28T12:06:30.000Z");
    const closed = await core.finalizeDeploymentQueueDeliveryRecovery(context, {
      ...di,
      eventType: "DeploymentRequestedV1" as const,
      projectId: prepared.projectId,
      environmentId: prepared.environmentId,
      billingEpochId: prepared.billingEpochId,
      requestEventId: prepared.requestEventId,
      deliveryAttemptId: prepared.deliveryAttemptId,
      planId: prepared.planId,
      deploymentId: prepared.deploymentId,
      workflowId: prepared.workflowId,
      recoveredAt: "2026-10-28T12:07:00.000Z",
      workflowOutcome: "complete" as const,
    });
    expect(closed).toMatchObject({ outcome: "recovered", continueProviderReconciliation: true });
    expect(
      await c.core
        .prepare("SELECT acknowledged_at FROM outbox_events WHERE event_id=?")
        .bind(d.accepted.outboxEventId)
        .first(),
    ).toMatchObject({ acknowledged_at: expect.any(String) });
  });

  it("prepares a recovery over an existing provider claim and refuses unacknowledged signals that are no final delivery", async () => {
    expect(
      await core.prepareDeploymentQueueDeliveryRecovery(context, identity(newUlid(), newUlid())),
    ).toEqual({ outcome: "not_applicable" });

    const d = await workflowFixture(c);
    await finalDelivery(d.accepted.outboxEventId, false);
    await insertClaim(d, "2026-10-28T12:00:30.000Z");
    await reconciliationRequired(d, "2026-10-28T12:00:30.000Z");
    expect(
      await core.prepareDeploymentQueueDeliveryRecovery(
        context,
        identity(d.p.organizationId, d.input.operationId),
      ),
    ).toMatchObject({ outcome: "prepared" });

    // a reconciliation signal whose delivery is not the exact final lease expiry is no recovery candidate
    const e = await workflowFixture(c);
    await finalDelivery(e.accepted.outboxEventId, false);
    await markSignalOnly(e.accepted.outboxEventId);
    await expect(
      core.prepareDeploymentQueueDeliveryRecovery(
        context,
        identity(e.p.organizationId, e.input.operationId),
      ),
    ).rejects.toThrow("not an exact final Queue-delivery recovery candidate");
  });
});

describe("source-link queue recovery", () => {
  async function sourceLinkScope() {
    const org = await seedOrganization(store, 2, 0),
      sp = projectInput(org, "queue-source-" + newUlid().toLowerCase());
    await store.projects.createInitialProject(sp);
    const accepted = acceptInput(sp, { eventType: "SourceLinkRequestedV1" });
    await store.operations.acceptApiOperation(accepted);
    const workflow = `product-command-v1-source-link-${accepted.outboxEventId}-${accepted.operationId}`,
      at = stamp("2026-10-28T12:00:00.000Z");
    await c.core.batch([
      c.core
        .prepare(
          "INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,installation_id,repository_owner,repository_name,created_at)VALUES(?1,?2,?3,?4,?5,'SourceLinkRequestedV1','42','owner','repo',?6)",
        )
        .bind(
          org,
          sp.projectId,
          sp.developmentEnvironmentId,
          accepted.operationId,
          sp.billingEpochId,
          at,
        ),
      c.core
        .prepare(
          "INSERT INTO product_workflow_runs(workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,state,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,'SourceLinkRequestedV1','queued',?8,?8)",
        )
        .bind(
          workflow,
          accepted.outboxEventId,
          org,
          sp.projectId,
          sp.developmentEnvironmentId,
          accepted.operationId,
          sp.billingEpochId,
          at,
        ),
    ]);
    return { org, sp, accepted, workflow };
  }
  async function sourceLink(finalCode?: string) {
    const scope = await sourceLinkScope();
    await finalDelivery(scope.accepted.outboxEventId, false, finalCode);
    return scope;
  }

  it("answers not applicable for a SourceLink whose outbox holds no final delivery, and writes no recovery audit", async () => {
    const never = await sourceLinkScope();
    expect(
      await core.prepareSourceLinkQueueDeliveryRecovery(
        context,
        identity(never.org, never.accepted.operationId),
      ),
    ).toEqual({ outcome: "not_applicable" });

    // one acknowledged attempt is ordinary history of a delivered event
    const acknowledged = await sourceLinkScope(),
      attempt = newUlid(),
      at = stamp("2026-10-28T12:00:30.000Z");
    await c.core.batch([
      c.core
        .prepare(
          "INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,status,acknowledged_at)VALUES(?1,?2,1,?3,?4,'acknowledged',?4)",
        )
        .bind(attempt, acknowledged.accepted.outboxEventId, stamp("2026-10-28T12:00:00.000Z"), at),
      c.core
        .prepare(
          "UPDATE outbox_events SET attempt_count=1,current_attempt_id=?2,claimed_at=NULL,lease_expires_at=NULL,acknowledged_at=?3,last_attempt_status='acknowledged' WHERE event_id=?1",
        )
        .bind(acknowledged.accepted.outboxEventId, attempt, at),
    ]);
    expect(
      await core.prepareSourceLinkQueueDeliveryRecovery(
        context,
        identity(acknowledged.org, acknowledged.accepted.operationId),
      ),
    ).toEqual({ outcome: "not_applicable" });
    expect(
      await c.core
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE event_type LIKE 'SourceLinkQueueDelivery%' AND operation_id IN (?1,?2)",
        )
        .bind(never.accepted.operationId, acknowledged.accepted.operationId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("refuses a parked SourceLink signal that is no exact final delivery, as the project path does, and writes no recovery audit", async () => {
    // a parked signal whose code is not one of the closed final codes
    const coded = await sourceLinkScope();
    await finalDelivery(coded.accepted.outboxEventId, false);
    await c.core
      .prepare(
        "UPDATE outbox_events SET last_error_code='PRODUCT_COMMAND_CONFIGURATION_INVALID' WHERE event_id=?1",
      )
      .bind(coded.accepted.outboxEventId)
      .run();
    await expect(
      core.prepareSourceLinkQueueDeliveryRecovery(
        context,
        identity(coded.org, coded.accepted.operationId),
      ),
    ).rejects.toThrow("not an exact final Queue-delivery recovery candidate");

    // a parked signal whose attempt count is not its max attempts
    const counted = await sourceLinkScope();
    await finalDelivery(counted.accepted.outboxEventId, false);
    await c.core
      .prepare("UPDATE outbox_events SET attempt_count=4 WHERE event_id=?1")
      .bind(counted.accepted.outboxEventId)
      .run();
    await expect(
      core.prepareSourceLinkQueueDeliveryRecovery(
        context,
        identity(counted.org, counted.accepted.operationId),
      ),
    ).rejects.toThrow("not an exact final Queue-delivery recovery candidate");

    expect(
      await c.core
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE event_type LIKE 'SourceLinkQueueDelivery%' AND operation_id IN (?1,?2)",
        )
        .bind(coded.accepted.operationId, counted.accepted.operationId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("prepares the recovery of a SourceLink whose final Queue send was uncertain", async () => {
    const { org, accepted } = await sourceLink("PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN");
    expect(
      await core.prepareSourceLinkQueueDeliveryRecovery(
        context,
        identity(org, accepted.operationId),
      ),
    ).toMatchObject({ outcome: "prepared" });
  });

  it("answers unknown scopes, replays, keeps a queued terminal Workflow uncertain and exposes the Workflow replay chain of a pending close", async () => {
    const { org, sp, accepted, workflow } = await sourceLink();
    expect(
      await core.prepareSourceLinkQueueDeliveryRecovery(context, identity(org, newUlid())),
    ).toEqual({
      outcome: "not_applicable",
    });
    const si = identity(org, accepted.operationId),
      prepared = await core.prepareSourceLinkQueueDeliveryRecovery(context, si);
    if (prepared.outcome !== "prepared") throw new Error("Expected the source-link candidate");
    expect(await core.prepareSourceLinkQueueDeliveryRecovery(context, si)).toEqual(prepared);
    const finalize = {
      ...si,
      projectId: prepared.projectId,
      environmentId: prepared.environmentId,
      billingEpochId: prepared.billingEpochId,
      requestEventId: prepared.requestEventId,
      deliveryAttemptId: prepared.deliveryAttemptId,
      workflowId: prepared.workflowId,
      recoveredAt: "2026-10-28T12:07:00.000Z",
    };
    // a terminal Workflow of a queued source link is only recorded as a failure when it errored; "complete" stays uncertain
    expect(
      await core.finalizeSourceLinkQueueDeliveryRecovery(context, {
        ...finalize,
        workflowOutcome: "complete",
      }),
    ).toMatchObject({ outcome: "uncertain" });
    const closed = await core.finalizeSourceLinkQueueDeliveryRecovery(context, {
      ...finalize,
      workflowOutcome: "pending",
    });
    expect(closed).toMatchObject({ outcome: "recovered", state: "pending" });
    expect(
      await core.finalizeSourceLinkQueueDeliveryRecovery(context, {
        ...finalize,
        workflowOutcome: "pending",
      }),
    ).toMatchObject({ outcome: "duplicate" });

    // the first Workflow replay is active: the closed recovery reads its chain
    const attempt = si.reconciliationId,
      physical = "product-command-replay-v1-" + attempt,
      digest = new Uint8Array(32).fill(0xab),
      replayed = "2026-10-28T12:08:00.000000Z";
    await c.core.batch([
      c.core
        .prepare(
          "INSERT INTO product_workflow_replay_attempts(attempt_id,organization_id,project_id,environment_id,operation_id,event_id,billing_epoch_id,logical_workflow_id,physical_workflow_id,event_type,idempotency_sha256,attempt_number,actor_id,created_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'SourceLinkRequestedV1',?10,1,?11,?12)",
        )
        .bind(
          attempt,
          org,
          sp.projectId,
          sp.developmentEnvironmentId,
          accepted.operationId,
          accepted.outboxEventId,
          sp.billingEpochId,
          workflow,
          physical,
          digest,
          si.actorId,
          replayed,
        ),
      c.core
        .prepare(
          "UPDATE product_workflow_runs SET active_replay_attempt_id=?2 WHERE workflow_id=?1",
        )
        .bind(workflow, attempt),
    ]);
    expect(await core.readClosedSourceLinkQueueDeliveryRecovery(context, si)).toMatchObject({
      outcome: "recovered",
    });
  });

  it("refuses a signal that is no final delivery and a Workflow outcome that the durable source facts do not prove", async () => {
    const closing = await sourceLink();
    const ci = identity(closing.org, closing.accepted.operationId),
      prepared = await core.prepareSourceLinkQueueDeliveryRecovery(context, ci);
    if (prepared.outcome !== "prepared") throw new Error("Expected the source-link candidate");
    // the operation and its Workflow succeeded, but no repository source exists to prove it
    await c.core.batch([
      c.core
        .prepare(
          "UPDATE product_workflow_runs SET state='completed',terminal_evidence='{\"externalRepositoryId\":\"42\"}',completed_at=?2,updated_at=?2 WHERE workflow_id=?1",
        )
        .bind(closing.workflow, stamp("2026-10-28T12:06:30.000Z")),
      c.core
        .prepare("UPDATE operations SET state='succeeded',updated_at=?2 WHERE operation_id=?1")
        .bind(closing.accepted.operationId, stamp("2026-10-28T12:06:30.000Z")),
    ]);
    await expect(
      core.finalizeSourceLinkQueueDeliveryRecovery(context, {
        ...ci,
        projectId: prepared.projectId,
        environmentId: prepared.environmentId,
        billingEpochId: prepared.billingEpochId,
        requestEventId: prepared.requestEventId,
        deliveryAttemptId: prepared.deliveryAttemptId,
        workflowId: prepared.workflowId,
        recoveredAt: "2026-10-28T12:07:00.000Z",
        workflowOutcome: "complete",
      }),
    ).rejects.toThrow();

    const { org, accepted } = await sourceLink();
    await markSignalOnly(accepted.outboxEventId);
    await expect(
      core.prepareSourceLinkQueueDeliveryRecovery(context, identity(org, accepted.operationId)),
    ).rejects.toThrow("not an exact final Queue-delivery recovery candidate");
  });
});
