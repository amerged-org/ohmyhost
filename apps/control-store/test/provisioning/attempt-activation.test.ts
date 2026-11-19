import { afterAll, beforeAll, expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import {
  activateProductProviderReconciliationAttempt,
  activateProductWorkflowReplayAttempt,
} from "../../src/catalog/provisioning/attempt-activation.js";
import { prepareProductProviderReconciliation } from "../../src/catalog/provisioning/provider-reconciliation-commands.js";
import {
  findProductWorkflowReplayCandidate,
  prepareProductWorkflowReplay,
  recoverTerminalProductWorkflowReplay,
} from "../../src/catalog/provisioning/workflow-replay-recovery.js";
import { seedAcceptedOperation } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  beforeFirstWrite,
  losingWriteResponses,
  seedProject,
  STORED_NOW,
} from "../support/platform-fixtures.js";
import {
  claimedWorkflow,
  deploymentContext as context,
} from "../support/deployment-commands-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

/** A claimed deployment whose Workflow stopped for reconciliation, with one prepared retry attempt. */
async function preparedRetry() {
  const r = await claimedWorkflow(control);
  await control.core.batch([
    control.core
      .prepare(
        `UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code='SOURCE_UNCERTAIN',intermediate_evidence='{"providerReconciliationHint":{"phase":"source"}}' WHERE workflow_id=?1`,
      )
      .bind(r.input.logicalWorkflowId),
    control.core
      .prepare(`UPDATE deployments SET status='reconciliation_required' WHERE deployment_id=?1`)
      .bind(r.deployment),
  ]);
  const attemptId = newUlid(),
    physicalWorkflowId = `provider-reconcile-v1-${newUlid()}`;
  const prepared = await prepareProductProviderReconciliation(context(control.core), {
    attemptId,
    observationId: newUlid(),
    claimId: r.input.claimId,
    organizationId: r.input.organizationId,
    projectId: r.input.projectId,
    environmentId: r.input.environmentId,
    operationId: r.input.operationId,
    eventId: r.input.eventId,
    logicalWorkflowId: r.input.logicalWorkflowId,
    physicalWorkflowId,
    mode: "retry",
    idempotencyDigest: new Uint8Array(32).fill(1),
    evidenceDigest: new Uint8Array(32).fill(2),
    gateway: { state: "unknown" },
    wfp: { state: "unknown" },
    actorId: "workflow-fixture",
    startedOperationEventId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    preparedAt: "2026-10-28T11:00:11.000Z",
  });
  expect(prepared).toMatchObject({ outcome: "prepared", attemptId, physicalWorkflowId });
  return {
    r,
    activation: {
      attemptId,
      physicalWorkflowId,
      organizationId: r.input.organizationId,
      projectId: r.input.projectId,
      environmentId: r.input.environmentId,
      operationId: r.input.operationId,
      eventId: r.input.eventId,
      eventType: r.input.eventType,
    },
  };
}

const runOf = async (workflowId: string) =>
  control.core
    .prepare(
      "SELECT state,reconciliation_code,active_reconciliation_attempt_id FROM product_workflow_runs WHERE workflow_id=?",
    )
    .bind(workflowId)
    .first();

it("activates the exact prepared reconciliation attempt once and answers a committed activation whose response was lost", async () => {
  const { r, activation } = await preparedRetry();
  expect(
    await activateProductProviderReconciliationAttempt(
      context(losingWriteResponses(control.core, 1)),
      activation,
    ),
  ).toBe("existing");
  expect(await runOf(r.input.logicalWorkflowId)).toEqual({
    state: "queued",
    reconciliation_code: null,
    active_reconciliation_attempt_id: activation.attemptId,
  });
  expect(
    await control.core
      .prepare("SELECT status FROM deployments WHERE deployment_id=?")
      .bind(r.deployment)
      .first(),
  ).toEqual({ status: "running" });
  expect(
    await activateProductProviderReconciliationAttempt(context(control.core), activation),
  ).toBe("existing");

  // A fresh attempt is activated by its own batch.
  const next = await preparedRetry();
  expect(
    await activateProductProviderReconciliationAttempt(context(control.core), next.activation),
  ).toBe("activated");
  expect(await runOf(next.r.input.logicalWorkflowId)).toMatchObject({
    state: "queued",
    active_reconciliation_attempt_id: next.activation.attemptId,
  });
  // The attempt of another physical Workflow, or one that is not the prepared attempt, is refused.
  await expect(
    activateProductProviderReconciliationAttempt(context(control.core), {
      ...activation,
      physicalWorkflowId: "provider-reconcile-v1-other",
    }),
  ).rejects.toThrow("Provider reconciliation activation changed");
}, 60_000);

it("refuses a reconciliation activation whose project lifecycle changes before the batch commits", async () => {
  const { r, activation } = await preparedRetry(),
    race = beforeFirstWrite(control.core, async () => {
      await control.core
        .prepare("UPDATE projects SET lifecycle_version=lifecycle_version+1 WHERE project_id=?")
        .bind(r.input.projectId)
        .run();
    });
  await expect(
    activateProductProviderReconciliationAttempt(context(race), activation),
  ).rejects.toThrow("Provider reconciliation activation changed");
  expect(await runOf(r.input.logicalWorkflowId)).toMatchObject({
    state: "reconciliation_required",
    active_reconciliation_attempt_id: null,
  });
}, 60_000);

it("activates a prepared Workflow replay while it is the run's active attempt and refuses it afterwards", async () => {
  const project = await seedProject(control),
    accepted = await seedAcceptedOperation(project, project.devEnvironmentId, {
      eventType: "SourceLinkRequestedV1",
      claim: false,
    });
  await control.core
    .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
    .bind(accepted.eventId, STORED_NOW)
    .run();
  const scope = { organizationId: project.organizationId, operationId: accepted.operationId },
    candidate = await findProductWorkflowReplayCandidate(context(control.core), scope);
  if (candidate === null) throw new Error("Missing replay candidate");
  const attemptId = newUlid(),
    physicalWorkflowId = `product-command-replay-v1-${attemptId}`;
  expect(
    await prepareProductWorkflowReplay(context(control.core), {
      ...candidate,
      attemptId,
      physicalWorkflowId,
      actorId: "user:replay-owner",
      idempotencyDigest: new Uint8Array(32).fill(3),
      preparedAt: "2026-10-28T12:02:00.000Z",
    }),
  ).toBe("prepared");
  const activation = {
    attemptId,
    physicalWorkflowId,
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
    operationId: accepted.operationId,
    eventId: accepted.eventId,
  };
  expect(await activateProductWorkflowReplayAttempt(context(control.core), activation)).toBe(
    "active",
  );
  await expect(
    activateProductWorkflowReplayAttempt(context(control.core), {
      ...activation,
      physicalWorkflowId: "product-command-replay-v1-other",
    }),
  ).rejects.toThrow("Product Workflow replay execution identity is invalid");
  const unknown = newUlid();
  await expect(
    activateProductWorkflowReplayAttempt(context(control.core), {
      ...activation,
      attemptId: unknown,
      physicalWorkflowId: `product-command-replay-v1-${unknown}`,
    }),
  ).rejects.toThrow("Product Workflow replay is no longer active");
  // Terminal recovery of the physical attempt ends it: the same activation is no longer active.
  expect(
    await recoverTerminalProductWorkflowReplay(context(control.core), {
      ...scope,
      attemptId,
      failureId: newUlid(),
      actorId: "user:replay-owner",
      terminalStatus: "errored",
      evidenceDigest: new Uint8Array(32).fill(4),
      recoveredAt: "2026-10-28T12:03:00.000Z",
    }),
  ).toBe("recovered");
  await expect(
    activateProductWorkflowReplayAttempt(context(control.core), activation),
  ).rejects.toThrow("Product Workflow replay is no longer active");
}, 60_000);
