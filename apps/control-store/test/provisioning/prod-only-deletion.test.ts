import { afterAll, beforeAll, expect, it } from "vitest";
import { parseProductCommandMessageV1 } from "../../../orchestrator/src/product-command.js";
import { createCoreDeploymentLifecyclePort } from "../../../project-provisioning-worker/src/core-deployment-lifecycle.js";
import { createCoreDeploymentReaderPort } from "../../../project-provisioning-worker/src/core-deployment-reader.js";
import type {
  LifecycleCompletionInput,
  LifecycleGatewayAbsence,
} from "../../../project-provisioning-worker/src/deployment-lifecycle-port.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  beforeFirstWrite,
  seedProject,
  STORED_NOW,
  type SeededProject,
} from "../support/platform-fixtures.js";
import { newUlid } from "../../src/catalog/common.js";
import { leaseOperation, seedOperation } from "../support/accepted-operation.js";
import { seedDevAccessProject } from "../support/dev-access-fixture.js";
import { makePaid } from "../support/credit-fixtures.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";
import { acceptDeletion, lifecycleContext, seedSecret } from "./lifecycle.fixture.js";
import { observeGatewayRoute } from "../../src/catalog/gateway/reads.js";
import { readProductWorkflowContext } from "../../src/catalog/provisioning/context-reader.js";
import { readPendingDeliveries } from "../../src/catalog/runtime-secrets/reads.js";
import { SharedCoreRouter } from "../../src/router.js";
import {
  completeProductLifecycleCommand,
  retainProductDeletionTombstone,
} from "../../src/catalog/provisioning/lifecycle-completion.js";
import {
  deletionInventoryStatements,
  readDeletionInventoryPlan,
  recordLifecycleCleanupAttempt,
  readLifecycleDeletionEvidence,
} from "../../src/catalog/provisioning/lifecycle-inventory.js";
import { archiveDevEnvironment } from "../support/archived-dev-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => {
  await control?.dispose();
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fixture missing");
  return value;
}
async function prepare(project: SeededProject) {
  const context = lifecycleContext(control.core),
    deletion = await acceptDeletion(project, { environmentId: project.prodEnvironmentId });
  const command = parseProductCommandMessageV1({
    version: 1,
    eventType: "ProjectDeletionRequestedV1",
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
    billingEpochId: project.billingEpochId,
    operationId: deletion.operationId,
    eventId: deletion.eventId,
  });
  if (command.eventType !== "ProjectDeletionRequestedV1")
    throw new Error("Deletion fixture changed");
  const submitted: LifecycleCompletionInput[] = [];
  const readers = createCoreDeploymentReaderPort({
    readProductWorkflowContext: (raw) => readProductWorkflowContext(context, raw),
    readProductWorkflowDatabaseTarget: async () => {
      throw new Error("Unexpected database lookup");
    },
    claimProductProviderMutation: async () => {
      throw new Error("Unexpected provider claim");
    },
  });
  const port = createCoreDeploymentLifecyclePort(
    {
      completeProductLifecycleCommand: (raw) => {
        submitted.push(raw);
        return completeProductLifecycleCommand(context, raw);
      },
      retainProductDeletionTombstone: (raw) => retainProductDeletionTombstone(context, raw),
    },
    readers,
    () => new Date(),
  );
  const plan = await readDeletionInventoryPlan(control.core, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    operationId: deletion.operationId,
    recordedAt: new Date().toISOString(),
  });
  await control.core.batch(deletionInventoryStatements(control.core, plan));
  await port.retainDeletionTombstone({
    workflowId: deletion.workflowId,
    executionId: deletion.workflowId,
    command,
    tombstoneReceiptId: "exact-tombstone",
  });
  await leaseOperation(control.core, deletion.operationId);

  const mark = async (records = plan.records) => {
    for (const record of records)
      await recordLifecycleCleanupAttempt(context, {
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId: deletion.operationId,
        cleanupAttemptId: newUlid(),
        provider: record.provider,
        resourceKind: record.resourceKind,
        externalRefHash: record.externalRefHash,
        outcome: "removed",
        attemptedAt: new Date().toISOString(),
      });
  };
  const snapshot = required(await readers.readContext(command));
  const evidence = {
    tombstoneReceiptId: "exact-tombstone",
    inventoryClean: true,
    consecutive404s: 3,
    gatewayAbsence: snapshot.deletionEnvironments.map<LifecycleGatewayAbsence | null>(() => null),
  };
  const input = () => ({
    workflowId: deletion.workflowId,
    executionId: deletion.workflowId,
    command,
    evidence,
  });
  const completion = (): LifecycleCompletionInput => ({
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
    operationId: deletion.operationId,
    workflowId: deletion.workflowId,
    outboxEventId: deletion.eventId,
    startedOperationEventId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    completedAt: new Date().toISOString(),
    eventType: "ProjectDeletionRequestedV1",
    expectedEnvironmentHeads: snapshot.deletionEnvironments.map((e) => ({
      environmentId: e.environmentId,
      expectedHeadVersion: e.headVersion,
    })),
    deletion: { ...evidence, inventoryClean: true },
  });
  return {
    context,
    deletion,
    command,
    readers,
    port,
    plan,
    mark,
    snapshot,
    evidence,
    input,
    completion,
    submitted,
  };
}

it("deletes actual Prod-only and legacy Dev/Prod scopes through real Core context and the production caller", async () => {
  for (const prodOnly of [true, false]) {
    const project = await seedProject(control, { prodOnly });
    const rows = (
      await control.core
        .prepare("SELECT environment_id FROM environments WHERE project_id=? ORDER BY name")
        .bind(project.projectId)
        .all<{ environment_id: string }>()
    ).results;
    for (const row of rows) await seedSecret(project, row.environment_id);
    const f = await prepare(project);
    await f.mark();
    expect(f.snapshot.deletionEnvironments.map((e) => e.environmentName)).toEqual(
      prodOnly ? ["prod"] : ["dev", "prod"],
    );
    expect(await f.port.complete(f.input())).toBe("applied");
    const sent = required(f.submitted[0]);
    if (sent.eventType !== "ProjectDeletionRequestedV1") throw new Error("Wrong terminal command");
    expect(sent.expectedEnvironmentHeads.map((e) => e.environmentId).sort()).toEqual(
      rows.map((e) => e.environment_id).sort(),
    );
    expect(sent.deletion.gatewayAbsence).toHaveLength(rows.length);
    expect(await completeProductLifecycleCommand(f.context, sent)).toBe("replayed");
    expect(
      await control.core
        .prepare("SELECT lifecycle_state FROM projects WHERE project_id=?")
        .bind(project.projectId)
        .first(),
    ).toEqual({ lifecycle_state: "deleted" });
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM environment_secrets WHERE project_id=?")
        .bind(project.projectId)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM environments WHERE project_id=?")
        .bind(project.projectId)
        .first(),
    ).toEqual({ n: rows.length });
  }
}, 60_000);

it("rejects missing, duplicated, foreign or raced actual scopes before any secret purge or terminal write", async () => {
  const project = await seedProject(control, { prodOnly: true });
  await seedSecret(project, project.prodEnvironmentId);
  const f = await prepare(project);
  await f.mark();
  const valid = f.completion();
  if (valid.eventType !== "ProjectDeletionRequestedV1") throw new Error("Wrong deletion fixture");
  for (const changed of [
    { deletion: { ...valid.deletion, gatewayAbsence: [] } },
    { deletion: { ...valid.deletion, gatewayAbsence: [null, null] } },
    {
      expectedEnvironmentHeads: [
        ...valid.expectedEnvironmentHeads,
        ...valid.expectedEnvironmentHeads,
      ],
    },
    { expectedEnvironmentHeads: [{ environmentId: newUlid(), expectedHeadVersion: 0 }] },
    {
      expectedEnvironmentHeads: [
        { environmentId: project.prodEnvironmentId, expectedHeadVersion: 99 },
      ],
    },
  ])
    await expect(
      completeProductLifecycleCommand(f.context, { ...valid, ...changed }),
    ).rejects.toThrow();
  const extra = newUlid(),
    raced = beforeFirstWrite(control.core, async () => {
      await control.core
        .prepare(
          "INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at)VALUES(?,?,?,'dev','{}',0,1,?,?)",
        )
        .bind(project.organizationId, project.projectId, extra, STORED_NOW, STORED_NOW)
        .run();
    });
  await expect(completeProductLifecycleCommand(lifecycleContext(raced), valid)).rejects.toThrow();
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM environment_secrets WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await control.core
      .prepare("SELECT lifecycle_state FROM projects WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toEqual({ lifecycle_state: "deleting" });
  expect(
    await control.core
      .prepare("SELECT head_version FROM environments WHERE environment_id=?")
      .bind(project.prodEnvironmentId)
      .first(),
  ).toEqual({ head_version: 0 });
});

it("retains actual archived Dev candidate scope and purges its ciphertext only after exact whole-project cleanup evidence", async () => {
  const f = await seedDevAccessProject(control),
    project = f.project,
    context = lifecycleContext(control.core),
    old = project.devEnvironmentId;
  await makePaid(control.core, project.organizationId);
  await control.core.batch([
    control.core
      .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?")
      .bind(project.organizationId),
    control.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at)VALUES(?,?,?,?)",
      )
      .bind(project.organizationId, project.projectId, project.prodEnvironmentId, STORED_NOW),
    ...[project.devEnvironmentId, project.prodEnvironmentId].map((id) =>
      control.core
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at)VALUES(?,?,?,?,1,?)",
        )
        .bind(project.organizationId, project.projectId, id, project.prodEnvironmentId, STORED_NOW),
    ),
  ]);
  const op = await seedOperation(project, { state: "running" }),
    published = await seedWfpPublication(project, {
      operationId: op,
      environmentId: old,
    });
  await control.core
    .prepare(
      "UPDATE operations SET state='succeeded',lease_expires_at=NULL WHERE organization_id=? AND operation_id=?",
    )
    .bind(project.organizationId, op)
    .run();
  await seedSecret(project, old);
  await control.core
    .prepare(
      "UPDATE runtime_secret_delivery_states SET provider_tag='exact-fixture-tag',applied_manifest_sha256=zeroblob(32),desired_generation=1,applied_generation=0,applied_secret_count=1,applied_secret_names='[\"API_KEY\"]' WHERE organization_id=? AND environment_id=?",
    )
    .bind(project.organizationId, old)
    .run();
  const fresh = {
    environmentId: await archiveDevEnvironment(
      control.core,
      project,
      project.prodEnvironmentId,
      new Date().toISOString().replace("Z", "000Z"),
    ),
  };
  const d = await prepare(project);
  expect(d.snapshot.deletionEnvironments.map((e) => e.environmentId).sort()).toEqual(
    [old, fresh.environmentId, project.prodEnvironmentId].sort(),
  );
  expect(d.snapshot.deletionEnvironments.filter((e) => e.environmentName === "dev")).toHaveLength(
    2,
  );
  expect(
    d.snapshot.deletionEnvironments
      .find((e) => e.environmentId === old)
      ?.wfpDeployments.map((e) => e.productDeploymentId),
  ).toContain(published.deploymentId);
  expect(
    (
      await readLifecycleDeletionEvidence(context, {
        organizationId: project.organizationId,
        projectId: project.projectId,
      })
    ).candidates.map((e) => e.environmentId),
  ).toContain(old);
  // The private provider path records actual route removal; metadata absence alone cannot purge a live route.
  await control.core
    .prepare(
      "INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,observed_at)SELECT organization_id,project_id,environment_id,2,1,?,candidate_receipt_id,'remove',0,handle,public_origin,egress_allowed_origins,? FROM shared_gateway_route_revisions WHERE organization_id=? AND environment_id=? AND revision=1",
    )
    .bind(
      d.deletion.operationId,
      new Date().toISOString().replace("Z", "000Z"),
      project.organizationId,
      old,
    )
    .run();
  d.evidence.gatewayAbsence = await Promise.all(
    d.snapshot.deletionEnvironments.map(async (environment) => {
      const receipt = await observeGatewayRoute(context, {
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: environment.environmentId,
      });
      return receipt === null ? null : { ...receipt, observedAt: receipt.observedAt.toISOString() };
    }),
  );
  expect(
    d.evidence.gatewayAbsence.filter((receipt) => receipt?.environmentId === old),
  ).toMatchObject([{ environmentName: "dev", active: false }]);
  await expect(d.port.complete(d.input())).rejects.toThrow();
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM environment_secrets WHERE environment_id=?")
      .bind(old)
      .first(),
  ).toEqual({ n: 1 });
  await d.mark();
  expect(await d.port.complete(d.input())).toBe("applied");
  const sent = required(d.submitted.at(-1));
  if (sent.eventType !== "ProjectDeletionRequestedV1") throw new Error("Wrong terminal command");
  expect(sent.expectedEnvironmentHeads).toHaveLength(3);
  expect(sent.deletion.gatewayAbsence).toHaveLength(3);
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM environment_secrets WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM environments WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toEqual({ n: 3 });
}, 60_000);

it("completes the deletion of a Prod scope whose runtime secret generation is still pending, and purges its secrets", async () => {
  const project = await seedProject(control, { prodOnly: true });
  const live = await seedOperation(project);
  await seedWfpPublication(project, {
    operationId: live,
    environmentId: project.prodEnvironmentId,
  });
  await control.core
    .prepare(
      "UPDATE operations SET state='succeeded',lease_expires_at=NULL WHERE organization_id=? AND operation_id=?",
    )
    .bind(project.organizationId, live)
    .run();
  // the owner changed a secret after the last delivery: the minute cron has not applied the new generation yet
  await control.core
    .prepare(
      "UPDATE runtime_secret_delivery_states SET provider_tag='exact-fixture-tag',desired_generation=applied_generation+1 WHERE project_id=?",
    )
    .bind(project.projectId)
    .run();
  await seedSecret(project, project.prodEnvironmentId);
  const f = await prepare(project);
  // the deleting project is no delivery the minute cron may keep retrying
  expect(
    (
      await readPendingDeliveries(
        { directory: control.core, router: new SharedCoreRouter(control.core) },
        { now: new Date().toISOString(), limit: 50 },
      )
    ).some((row) => row.projectId === project.projectId),
  ).toBe(false);
  // the deletion retires the gateway route of the scope before its completion
  await control.core
    .prepare(
      "INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,observed_at) SELECT organization_id,project_id,environment_id,2,1,?4,candidate_receipt_id,'remove',0,handle,public_origin,'[]','2026-10-28T12:03:00.000000Z' FROM shared_gateway_route_revisions WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND revision=1",
    )
    .bind(
      project.organizationId,
      project.projectId,
      project.prodEnvironmentId,
      f.deletion.operationId,
    )
    .run();
  await f.mark();
  expect(await f.port.complete(f.input())).toBe("applied");
  expect(
    await control.core
      .prepare("SELECT lifecycle_state FROM projects WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toEqual({ lifecycle_state: "deleted" });
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM environment_secrets WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toEqual({ n: 0 });
}, 60_000);

it("completes the deletion of a Prod scope whose delivery worker crashed under a lease that has since expired", async () => {
  const project = await seedProject(control, { prodOnly: true });
  const live = await seedOperation(project);
  await seedWfpPublication(project, {
    operationId: live,
    environmentId: project.prodEnvironmentId,
  });
  await control.core
    .prepare(
      "UPDATE operations SET state='succeeded',lease_expires_at=NULL WHERE organization_id=? AND operation_id=?",
    )
    .bind(project.organizationId, live)
    .run();
  // a delivery worker claimed the pending generation and died; nothing renews its lease, which ran out before the deletion
  await control.core
    .prepare(
      "UPDATE runtime_secret_delivery_states SET provider_tag='exact-fixture-tag',desired_generation=applied_generation+1,active_lease_id=?,claimed_generation=applied_generation+1,claimed_trigger='deploy',claimed_at='2026-10-28T11:00:00.000000Z',claimed_release_sequence=next_release_sequence,next_release_sequence=next_release_sequence+1,lease_expires_at='2026-10-28T11:05:00.000000Z' WHERE project_id=?",
    )
    .bind(newUlid(), project.projectId)
    .run();
  await seedSecret(project, project.prodEnvironmentId);
  const f = await prepare(project);
  // the deletion retires the gateway route of the scope before its completion
  await control.core
    .prepare(
      "INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,observed_at) SELECT organization_id,project_id,environment_id,2,1,?4,candidate_receipt_id,'remove',0,handle,public_origin,'[]','2026-10-28T12:03:00.000000Z' FROM shared_gateway_route_revisions WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND revision=1",
    )
    .bind(
      project.organizationId,
      project.projectId,
      project.prodEnvironmentId,
      f.deletion.operationId,
    )
    .run();
  await f.mark();
  expect(await f.port.complete(f.input())).toBe("applied");
  expect(
    await control.core
      .prepare("SELECT lifecycle_state FROM projects WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toEqual({ lifecycle_state: "deleted" });
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM environment_secrets WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toEqual({ n: 0 });
}, 60_000);
