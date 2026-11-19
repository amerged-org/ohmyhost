import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { projectInput, seedOrganization, acceptInput } from "../support/seed.js";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import * as replay from "../../src/catalog/provisioning/workflow-replay-recovery.js";
import * as lost from "../../src/catalog/provisioning/lost-command-recovery.js";
import { parseUlid } from "@ohmyhost/platform";
import { seedAcceptedOperation, seedCleanupRun } from "../support/accepted-operation.js";
import { seedProject } from "../support/platform-fixtures.js";
import { acceptProductDispatch } from "../../src/catalog/provisioning/dispatch.js";
import { linkSource, productRig, publishedRevision } from "../support/product-api-fixture.js";
import { promotionIntent, rollbackIntent } from "../support/accepted-operation.js";
type Control = Awaited<ReturnType<typeof createTestControl>>;
/** Every event type whose exhausted delivery is handed off or accepted run-less (the queue handoff set of the Core). */
const HANDOFF_EVENTS = [
  "SourceLinkRequestedV1",
  "DeploymentRollbackRequestedV1",
  "DeploymentPromotionRequestedV1",
  "ProjectDeletionRequestedV1",
  "ProjectDataChangeRequestedV1",
] as const;

/**
 * The project, the environment and the intent columns of an accepted event of a type. A rollback or promotion needs a real
 * published Dev revision as its parent (its target or its source), so those types run on a product rig that has one.
 */
async function acceptedProject(c: Control, eventType: (typeof HANDOFF_EVENTS)[number]) {
  if (
    eventType !== "DeploymentRollbackRequestedV1" &&
    eventType !== "DeploymentPromotionRequestedV1"
  ) {
    const project = await seedProject(c);
    return { project, environmentId: project.devEnvironmentId, intent: undefined };
  }
  const rig = await productRig(c);
  await linkSource(rig);
  const published = await publishedRevision(rig, rig.devEnvironmentId);
  if (eventType === "DeploymentRollbackRequestedV1")
    return {
      project: rig,
      environmentId: rig.devEnvironmentId,
      intent: (operationId: string) =>
        rollbackIntent(rig, operationId, rig.devEnvironmentId, published),
    };
  return {
    project: rig,
    environmentId: rig.prodEnvironmentId,
    intent: (operationId: string) =>
      promotionIntent(rig, operationId, rig.prodEnvironmentId, {
        ...published,
        environmentId: rig.devEnvironmentId,
      }),
  };
}
const time = "2026-10-28T12:00:00.000Z",
  stored = (v: string) => v.replace("Z", "000Z");
/** Fresh synthetic accepted database facts, not public admission or historical import qualification. */
async function command(
  c: Control,
  type: "SourceLinkRequestedV1" | "ProjectDeletionRequestedV1" | "ProjectHandleChangeRequestedV1",
) {
  const store = createControlStore(c.bindings),
    org = await seedOrganization(store, 2, 0),
    p = projectInput(org, "replay-" + newUlid().toLowerCase());
  await store.projects.createInitialProject(p);
  const input = acceptInput(p, { eventType: type, occurredAt: time });
  await store.operations.acceptApiOperation(input);
  const workflow = `product-command-v1-${type === "SourceLinkRequestedV1" ? "source-link" : type === "ProjectDeletionRequestedV1" ? "delete" : "handle-change"}-${input.outboxEventId}-${input.operationId}`,
    cleanup = newUlid();
  const statement = c.core.prepare(
    type === "SourceLinkRequestedV1"
      ? "INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,installation_id,repository_owner,repository_name,created_at)VALUES(?1,?2,?3,?4,?5,'SourceLinkRequestedV1','42','owner','repo',?6)"
      : type === "ProjectDeletionRequestedV1"
        ? "INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,expected_etag,cleanup_run_id,created_at)VALUES(?1,?2,?3,?4,?5,'ProjectDeletionRequestedV1','fixture-etag',?7,?6)"
        : "INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,expected_etag,requested_handle,created_at)VALUES(?1,?2,?3,?4,?5,'ProjectHandleChangeRequestedV1','fixture-etag','changed-handle',?6)",
  );
  const scope = [
      org,
      p.projectId,
      p.developmentEnvironmentId,
      input.operationId,
      p.billingEpochId,
      stored(time),
    ],
    steps = [];
  if (type === "ProjectDeletionRequestedV1")
    steps.push(
      c.core
        .prepare(
          "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at)VALUES(?1,?2,?3,?4,'pending',1,?5,?5)",
        )
        .bind(org, cleanup, p.projectId, input.operationId, stored(time)),
    );
  steps.push(
    statement.bind(...scope, ...(type === "ProjectDeletionRequestedV1" ? [cleanup] : [])),
    c.core
      .prepare(
        "INSERT INTO product_workflow_runs(workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,state,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'queued',?9,?9)",
      )
      .bind(
        workflow,
        input.outboxEventId,
        org,
        p.projectId,
        p.developmentEnvironmentId,
        input.operationId,
        p.billingEpochId,
        type,
        stored(time),
      ),
  );
  if (type === "ProjectDeletionRequestedV1")
    steps.push(
      c.core
        .prepare(
          "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(org, p.projectId),
    );
  await c.core.batch(steps);
  return { p, input, workflow, org };
}
it("prepares, recovers and hands off replays and lost commands with exact results, preserves plain four-ID aggregate events, and rolls a late replay audit back atomically", async () => {
  const c = await createTestControl();
  try {
    const db = c.core,
      context = { directory: db, router: new SharedCoreRouter(db) },
      source = await command(c, "SourceLinkRequestedV1"),
      at = "2026-10-28T12:01:00.000Z";
    await db
      .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
      .bind(source.input.outboxEventId, stored(at))
      .run();
    const scope = {
        organizationId: parseUlid(source.org),
        operationId: parseUlid(source.input.operationId),
      },
      candidate = await replay.findProductWorkflowReplayCandidate(context, scope);
    expect(candidate).toEqual({
      organizationId: source.org,
      projectId: source.p.projectId,
      environmentId: source.p.developmentEnvironmentId,
      operationId: source.input.operationId,
      eventId: source.input.outboxEventId,
      billingEpochId: source.p.billingEpochId,
      logicalWorkflowId: source.workflow,
      eventType: "SourceLinkRequestedV1",
      queueHandoffPending: false,
    });
    if (!candidate) throw new Error("Missing replay candidate");
    const attemptId = parseUlid(newUlid()),
      input = {
        ...candidate,
        attemptId,
        physicalWorkflowId: "product-command-replay-v1-" + attemptId,
        actorId: "user:replay-owner",
        idempotencyDigest: new Uint8Array(32).fill(3),
        preparedAt: "2026-10-28T12:02:00.000Z",
      };
    await db
      .prepare(
        "CREATE TRIGGER fail_replay_audit BEFORE INSERT ON audit_events WHEN NEW.event_type='ProductWorkflowReplayPrepared' BEGIN SELECT RAISE(ABORT,'late replay audit');END",
      )
      .run();
    await expect(replay.prepareProductWorkflowReplay(context, input)).rejects.toThrow(
      "late replay audit",
    );
    expect(
      (
        await db
          .prepare("SELECT count(*) n FROM product_workflow_replay_attempts WHERE attempt_id=?1")
          .bind(attemptId)
          .first()
      )?.["n"],
    ).toBe(0);
    await db.prepare("DROP TRIGGER fail_replay_audit").run();
    expect(await replay.prepareProductWorkflowReplay(context, input)).toBe("prepared");
    const read = {
      ...scope,
      attemptId,
      actorId: input.actorId,
      idempotencyDigest: input.idempotencyDigest,
    };
    expect(await replay.readProductWorkflowReplayAttempt(context, read)).toEqual({
      outcome: "prepared",
      attemptId,
      physicalWorkflowId: input.physicalWorkflowId,
      originalMessage: {
        version: 1,
        eventType: "SourceLinkRequestedV1",
        eventId: source.input.outboxEventId,
        organizationId: source.org,
        projectId: source.p.projectId,
        environmentId: source.p.developmentEnvironmentId,
        operationId: source.input.operationId,
        billingEpochId: source.p.billingEpochId,
      },
    });
    const terminal = {
      ...scope,
      attemptId,
      failureId: parseUlid(newUlid()),
      actorId: input.actorId,
      terminalStatus: "errored" as const,
      evidenceDigest: new Uint8Array(32).fill(4),
      recoveredAt: "2026-10-28T12:03:00.000Z",
    };
    expect(await replay.recoverTerminalProductWorkflowReplay(context, terminal)).toBe("recovered");
    expect(await replay.readProductWorkflowReplayAttempt(context, read)).toEqual({
      outcome: "completed",
      attemptId,
    });
    expect(await replay.recoverTerminalProductWorkflowReplay(context, terminal)).toBe("existing");
    const deletion = await command(c, "ProjectDeletionRequestedV1"),
      delivery = newUlid(),
      failure = "2026-10-28T12:05:00.000Z";
    await db.batch([
      db
        .prepare(
          "UPDATE outbox_events SET current_attempt_id=?2,attempt_count=5,max_attempts=5,last_error_code='FINAL_ATTEMPT_LEASE_EXPIRED',reconciliation_required_at=?3,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
        )
        .bind(deletion.input.outboxEventId, delivery, stored(failure)),
      db
        .prepare(
          "INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,failed_at,status,error_code)VALUES(?1,?2,5,'2026-10-28T12:04:00.000000Z',?3,?3,'reconciliation_required','FINAL_ATTEMPT_LEASE_EXPIRED')",
        )
        .bind(delivery, deletion.input.outboxEventId, stored(failure)),
    ]);
    const ds = {
        organizationId: parseUlid(deletion.org),
        operationId: parseUlid(deletion.input.operationId),
      },
      dc = await replay.findProductWorkflowReplayCandidate(context, ds);
    if (!dc) throw new Error("Missing deletion handoff candidate");
    const handoff = {
      ...dc,
      auditEventId: parseUlid(newUlid()),
      actorId: "user:replay-owner",
      acknowledgedAt: "2026-10-28T12:06:00.000Z",
    };
    expect(dc).toMatchObject({
      eventType: "ProjectDeletionRequestedV1",
      logicalWorkflowId: deletion.workflow,
      queueHandoffPending: true,
    });
    expect(await replay.finalizeProjectDeletionQueueHandoff(context, handoff)).toBe("acknowledged");
    expect(await replay.finalizeProjectDeletionQueueHandoff(context, handoff)).toBe("existing");
    const rename = await command(c, "ProjectHandleChangeRequestedV1"),
      renamedelivery = newUlid();
    await db.batch([
      db
        .prepare(
          "UPDATE outbox_events SET current_attempt_id=?2,attempt_count=5,max_attempts=5,last_error_code='FINAL_ATTEMPT_LEASE_EXPIRED',reconciliation_required_at=?3,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
        )
        .bind(rename.input.outboxEventId, renamedelivery, stored(failure)),
      db
        .prepare(
          "INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,failed_at,status,error_code)VALUES(?1,?2,5,'2026-10-28T12:04:00.000000Z',?3,?3,'reconciliation_required','FINAL_ATTEMPT_LEASE_EXPIRED')",
        )
        .bind(renamedelivery, rename.input.outboxEventId, stored(failure)),
    ]);
    const ls = {
      organizationId: parseUlid(rename.org),
      operationId: parseUlid(rename.input.operationId),
    };
    expect(await lost.findLostProductCommand(context, ls)).toEqual({
      state: "lost",
      workflowId: rename.workflow,
    });
    const eventIds = Array.from({ length: 4 }, () => parseUlid(newUlid())),
      abandon = {
        ...ls,
        workflowId: rename.workflow,
        reconciliationId: parseUlid(newUlid()),
        actorId: "user:replay-owner",
        abandonedAt: "2026-10-28T12:06:00.000Z",
        eventIds,
      };
    expect(await lost.abandonLostProductCommand(context, abandon)).toBe("abandoned");
    expect(await lost.findLostProductCommand(context, ls)).toEqual({ state: "abandoned" });
    expect(await lost.abandonLostProductCommand(context, abandon)).toBe("existing");
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 120000);

it.each(HANDOFF_EVENTS)(
  "hands off a %s whose final Queue send was uncertain, so its queued Workflow is not stranded",
  async (eventType) => {
    const c = await createTestControl();
    try {
      const db = c.core,
        context = { directory: db, router: new SharedCoreRouter(db) };
      const { project, environmentId, intent } = await acceptedProject(c, eventType);
      const accepted = await seedAcceptedOperation(project, environmentId, {
        eventType,
        // only a data change holds a provider mutation claim before its Workflow runs
        claim: eventType === "ProjectDataChangeRequestedV1",
        ...(intent === undefined ? {} : { intent }),
      });
      if (eventType === "ProjectDeletionRequestedV1")
        await db
          .prepare(
            "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(project.organizationId, project.projectId)
          .run();
      const failure = "2026-10-28T12:05:00.000Z",
        delivery = newUlid();
      await db.batch([
        db
          .prepare(
            "UPDATE outbox_events SET current_attempt_id=?2,attempt_count=5,max_attempts=5,last_error_code='PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN',reconciliation_required_at=?3,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
          )
          .bind(accepted.eventId, delivery, stored(failure)),
        db
          .prepare(
            "INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,failed_at,status,error_code)VALUES(?1,?2,5,'2026-10-28T12:04:00.000000Z',?3,?3,'reconciliation_required','PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN')",
          )
          .bind(delivery, accepted.eventId, stored(failure)),
      ]);
      const candidate = await replay.findProductWorkflowReplayCandidate(context, {
        organizationId: parseUlid(project.organizationId),
        operationId: parseUlid(accepted.operationId),
      });
      if (!candidate) throw new Error("Missing handoff candidate");
      expect(candidate).toMatchObject({ eventType, queueHandoffPending: true });
      expect(
        await replay.finalizeProjectDeletionQueueHandoff(context, {
          ...candidate,
          auditEventId: parseUlid(newUlid()),
          actorId: "user:replay-owner",
          acknowledgedAt: "2026-10-28T12:06:00.000Z",
        }),
      ).toBe("acknowledged");
    } finally {
      await c.dispose();
    }
  },
  120000,
);

it.each(HANDOFF_EVENTS)(
  "finds a %s exhausted before its Workflow run row existed, accepts it, and then hands it off",
  async (eventType) => {
    const c = await createTestControl();
    try {
      const db = c.core,
        context = { directory: db, router: new SharedCoreRouter(db) };
      const { project, environmentId, intent } = await acceptedProject(c, eventType);
      const accepted = await seedAcceptedOperation(project, environmentId, {
        eventType,
        claim: false,
        ...(intent === undefined ? {} : { intent }),
      });
      // the publisher lost its final lease after claiming the event and before it accepted the run
      await db
        .prepare("DELETE FROM product_workflow_runs WHERE event_id=?1")
        .bind(accepted.eventId)
        .run();
      if (eventType === "ProjectDeletionRequestedV1")
        await db
          .prepare(
            "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(project.organizationId, project.projectId)
          .run();
      const failure = "2026-10-28T12:05:00.000Z",
        delivery = newUlid();
      await db.batch([
        db
          .prepare(
            "UPDATE outbox_events SET payload=?4,current_attempt_id=?2,attempt_count=5,max_attempts=5,last_error_code='FINAL_ATTEMPT_LEASE_EXPIRED',reconciliation_required_at=?3,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
          )
          .bind(
            accepted.eventId,
            delivery,
            failure.replace("Z", "000Z"),
            // the publisher's payload: the environment the intent names
            JSON.stringify({ environmentId }),
          ),
        db
          .prepare(
            "INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,failed_at,status,error_code)VALUES(?1,?2,5,'2026-10-28T12:04:00.000000Z',?3,?3,'reconciliation_required','FINAL_ATTEMPT_LEASE_EXPIRED')",
          )
          .bind(delivery, accepted.eventId, failure.replace("Z", "000Z")),
      ]);
      const ids = {
        organizationId: parseUlid(project.organizationId),
        operationId: parseUlid(accepted.operationId),
      };
      expect(await replay.findProductWorkflowReplayCandidate(context, ids)).toBeNull();
      const runless = await replay.findRunlessProductDispatch(context, ids);
      expect(runless).toMatchObject({
        eventId: accepted.eventId,
        eventType,
        attemptId: delivery,
        environmentId,
        operationId: accepted.operationId,
      });
      if (runless === null) throw new Error("Missing run-less candidate");
      await acceptProductDispatch(context, {
        organizationId: runless.organizationId,
        projectId: runless.projectId,
        environmentId: runless.environmentId,
        operationId: runless.operationId,
        eventId: runless.eventId,
        attemptId: runless.attemptId,
        workflowId: `product-command-v1-replay-${runless.eventId}`,
        acceptedAt: "2026-10-28T12:06:00.000Z",
      });
      // accepted: the run exists now and the ordinary handoff matcher takes over
      expect(await replay.findRunlessProductDispatch(context, ids)).toBeNull();
      const candidate = await replay.findProductWorkflowReplayCandidate(context, ids);
      expect(candidate).toMatchObject({ eventType, queueHandoffPending: true });
      if (candidate === null) throw new Error("Missing handoff candidate");
      expect(
        await replay.finalizeProjectDeletionQueueHandoff(context, {
          ...candidate,
          auditEventId: parseUlid(newUlid()),
          actorId: "user:replay-owner",
          acknowledgedAt: "2026-10-28T12:07:00.000Z",
        }),
      ).toBe("acknowledged");
    } finally {
      await c.dispose();
    }
  },
  120000,
);

const RUNLESS_TYPES = [
  "SourceLinkRequestedV1",
  "DeploymentRollbackRequestedV1",
  "DeploymentPromotionRequestedV1",
] as const;

/**
 * An accepted event of a type whose Workflow run row is gone and whose delivery is exhausted at its final attempt, as the
 * run-less recovery finds it.
 */
async function exhaustedWithoutRun(c: Control, eventType: (typeof RUNLESS_TYPES)[number]) {
  const { project, environmentId, intent } = await acceptedProject(c, eventType);
  const accepted = await seedAcceptedOperation(project, environmentId, {
    eventType,
    claim: false,
    ...(intent === undefined ? {} : { intent }),
  });
  const failure = "2026-10-28T12:05:00.000000Z",
    delivery = newUlid();
  await c.core.batch([
    c.core.prepare("DELETE FROM product_workflow_runs WHERE event_id=?1").bind(accepted.eventId),
    c.core
      .prepare(
        "UPDATE outbox_events SET payload=?4,current_attempt_id=?2,attempt_count=5,max_attempts=5,last_error_code='FINAL_ATTEMPT_LEASE_EXPIRED',reconciliation_required_at=?3,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
      )
      .bind(accepted.eventId, delivery, failure, JSON.stringify({ environmentId })),
    c.core
      .prepare(
        "INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,failed_at,status,error_code)VALUES(?1,?2,5,'2026-10-28T12:04:00.000000Z',?3,?3,'reconciliation_required','FINAL_ATTEMPT_LEASE_EXPIRED')",
      )
      .bind(delivery, accepted.eventId, failure),
  ]);
  const ids = {
    organizationId: parseUlid(project.organizationId),
    operationId: parseUlid(accepted.operationId),
  };
  return { project, environmentId, accepted, ids };
}

it.each(RUNLESS_TYPES)(
  "the intent of a %s refuses a cleanup run, so no such intent can reach the handoff or the run-less recovery",
  async (eventType) => {
    const c = await createTestControl();
    try {
      const { project, environmentId, intent } = await acceptedProject(c, eventType);
      await expect(
        seedAcceptedOperation(project, environmentId, {
          eventType,
          claim: false,
          intent: async (operationId: string) => ({
            ...(intent === undefined
              ? { installation_id: "7", repository_owner: "o", repository_name: "r" }
              : await intent(operationId)),
            cleanup_run_id: await seedCleanupRun(project, operationId),
          }),
        }),
      ).rejects.toThrow(/CHECK constraint failed/u);
    } finally {
      await c.dispose();
    }
  },
  120000,
);

it.each(RUNLESS_TYPES)(
  "refuses the handoff and the run-less recovery of a %s whose project is being deleted",
  async (eventType) => {
    const c = await createTestControl();
    try {
      const db = c.core,
        context = { directory: db, router: new SharedCoreRouter(db) };
      const { project, ids } = await exhaustedWithoutRun(c, eventType);
      // matched while the project is active, so the refusal below is the lifecycle alone
      expect(await replay.findRunlessProductDispatch(context, ids)).not.toBeNull();
      await db
        .prepare(
          "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(project.organizationId, project.projectId)
        .run();
      expect(await replay.findRunlessProductDispatch(context, ids)).toBeNull();
      expect(await replay.findProductWorkflowReplayCandidate(context, ids)).toBeNull();
    } finally {
      await c.dispose();
    }
  },
  120000,
);

it.each(RUNLESS_TYPES)(
  "accepts a run-less %s once: a repeated accept replays the same result and never runs the event twice",
  async (eventType) => {
    const c = await createTestControl();
    try {
      const db = c.core,
        context = { directory: db, router: new SharedCoreRouter(db) };
      const { ids, accepted } = await exhaustedWithoutRun(c, eventType);
      const runless = await replay.findRunlessProductDispatch(context, ids);
      if (runless === null) throw new Error("Missing run-less candidate");
      const accept = () =>
        acceptProductDispatch(context, {
          organizationId: runless.organizationId,
          projectId: runless.projectId,
          environmentId: runless.environmentId,
          operationId: runless.operationId,
          eventId: runless.eventId,
          attemptId: runless.attemptId,
          workflowId: `product-command-v1-replay-${runless.eventId}`,
          acceptedAt: "2026-10-28T12:06:00.000Z",
        });
      const first = await accept();
      const second = await accept();
      expect(second).toEqual(first);
      expect(
        await db
          .prepare("SELECT count(*) AS n FROM product_workflow_runs WHERE event_id=?1")
          .bind(accepted.eventId)
          .first(),
      ).toEqual({ n: 1 });
      expect(await replay.findRunlessProductDispatch(context, ids)).toBeNull();
    } finally {
      await c.dispose();
    }
  },
  120000,
);
