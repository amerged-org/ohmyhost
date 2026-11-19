import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  losingWriteResponses,
  seedProject,
  type SeededProject,
} from "../support/platform-fixtures.js";
import {
  leaseOperation,
  seedAcceptedOperation,
  seedCleanupRun,
} from "../support/accepted-operation.js";
import {
  acceptDeletion,
  acknowledgeOutbox,
  lifecycleContext,
  lifecycleIdentity,
  retirePublishedDeployment,
  seedOwnedResources,
  seedR2Bucket,
  seedSecret,
} from "./lifecycle.fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { StoreBusyError } from "../../src/run-command.js";
import { observeGatewayRoute } from "../../src/catalog/gateway/reads.js";
import { ProductWorkflowContextConflictError } from "../../src/catalog/provisioning/context.js";
import {
  completeProductLifecycleCommand,
  retainProductDeletionTombstone,
} from "../../src/catalog/provisioning/lifecycle-completion.js";
import {
  deletionInventoryStatements,
  readDeletionInventoryPlan,
  recordLifecycleCleanupAttempt,
} from "../../src/catalog/provisioning/lifecycle-inventory.js";
import { planProjectDataChangeTransition } from "../../src/catalog/provisioning/context-snapshots.js";
import { readAcceptedApiProductOperation } from "../../src/catalog/product-api/accepted-operation.js";
import { recoverExpiredOperationLease } from "../../src/catalog/operations/operation-leases.js";

const RECORDED = "2026-10-28T11:00:00.000Z",
  REMOVED = "2026-10-28T11:30:00.000Z",
  COMPLETED = "2026-10-28T12:00:00.000Z";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(() => control.dispose());

const first = async <T>(sql: string, ...values: unknown[]) =>
  (await control.core
    .prepare(sql)
    .bind(...values)
    .first<T>()) as T;
const all = async <T>(sql: string, ...values: unknown[]) =>
  (
    await control.core
      .prepare(sql)
      .bind(...values)
      .all<T>()
  ).results;

/** Records the inventory of the accepted deletion and, when `removed`, a `removed` attempt for each of its targets. */
async function inventoryOf(
  project: SeededProject,
  deletion: { readonly operationId: string },
  removed: boolean,
) {
  const plan = await readDeletionInventoryPlan(control.core, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    operationId: deletion.operationId,
    recordedAt: RECORDED,
  });
  await control.core.batch(deletionInventoryStatements(control.core, plan));
  if (removed)
    for (const record of plan.records)
      await recordLifecycleCleanupAttempt(lifecycleContext(control.core), {
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId: deletion.operationId,
        cleanupAttemptId: newUlid(),
        provider: record.provider,
        resourceKind: record.resourceKind,
        externalRefHash: record.externalRefHash,
        outcome: "removed",
        attemptedAt: REMOVED,
      });
  return plan;
}

const tombstoneOf = (
  project: SeededProject,
  deletion: Parameters<typeof lifecycleIdentity>[2],
  tombstoneReceiptId = "tombstone-1",
) => {
  const identity = lifecycleIdentity(project, project.devEnvironmentId, deletion);
  return {
    organizationId: identity.organizationId,
    projectId: identity.projectId,
    environmentId: identity.environmentId,
    operationId: identity.operationId,
    workflowId: identity.workflowId,
    outboxEventId: identity.outboxEventId,
    startedOperationEventId: identity.startedOperationEventId,
    recordedAt: RECORDED,
    tombstoneReceiptId,
  };
};

async function headsOf(project: SeededProject) {
  return (
    await all<{ environment_id: string; head_version: number }>(
      "SELECT environment_id,head_version FROM environments WHERE organization_id=?1 AND project_id=?2 ORDER BY name",
      project.organizationId,
      project.projectId,
    )
  ).map((row) => ({
    environmentId: row.environment_id,
    expectedHeadVersion: row.head_version,
  }));
}

it("retains the tombstone, then completes a deletion atomically and answers a replay", async () => {
  const project = await seedProject(control),
    owned = await seedOwnedResources(project),
    deletion = await acceptDeletion(project);
  await seedSecret(project, project.devEnvironmentId);
  await seedSecret(project, project.prodEnvironmentId);
  await inventoryOf(project, deletion, true);
  await retirePublishedDeployment(project, deletion.operationId);
  const context = lifecycleContext(control.core),
    scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      operationId: deletion.operationId,
    };

  // The tombstone is the first durable step: it starts the operation and moves cleanup to running.
  const tombstone = tombstoneOf(project, deletion);
  expect(await retainProductDeletionTombstone(context, tombstone)).toBe("created");
  expect(await retainProductDeletionTombstone(context, tombstone)).toBe("created");
  const queued = await first<{ state: string; intermediate_evidence: string }>(
    "SELECT state,intermediate_evidence FROM product_workflow_runs WHERE workflow_id=?1",
    deletion.workflowId,
  );
  expect(queued.state).toBe("queued");
  expect(JSON.parse(queued.intermediate_evidence)).toEqual({ tombstoneReceiptId: "tombstone-1" });
  expect(
    await first("SELECT state FROM operations WHERE operation_id=?1", deletion.operationId),
  ).toEqual({ state: "running" });
  expect(
    await first(
      "SELECT state,revision FROM cleanup_runs WHERE cleanup_run_id=?1",
      deletion.cleanupRunId,
    ),
  ).toEqual({ state: "running", revision: 2 });
  expect(
    await all(
      "SELECT revision,event_type FROM operation_events WHERE operation_id=?1",
      deletion.operationId,
    ),
  ).toEqual([{ revision: 1, event_type: "OperationStarted" }]);
  // Other evidence for the same Workflow is refused, never overwritten.
  await expect(
    retainProductDeletionTombstone(context, tombstoneOf(project, deletion, "tombstone-2")),
  ).rejects.toBeInstanceOf(ProductWorkflowContextConflictError);

  const absent = await observeGatewayRoute(context, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.prodEnvironmentId,
    }),
    completion = {
      ...lifecycleIdentity(project, project.devEnvironmentId, deletion, COMPLETED),
      eventType: "ProjectDeletionRequestedV1" as const,
      expectedEnvironmentHeads: await headsOf(project),
      deletion: {
        tombstoneReceiptId: "tombstone-1",
        inventoryClean: true as const,
        consecutive404s: 3,
        gatewayAbsence: [null, absent],
      },
    };
  expect(absent).toMatchObject({ active: false, revision: 2, environmentName: "prod" });
  // The running Workflow holds the operation's lease when its terminal command runs.
  await leaseOperation(control.core, deletion.operationId);
  expect(await completeProductLifecycleCommand(context, completion)).toBe("completed");
  expect(
    await first(
      "SELECT state,lease_expires_at FROM operations WHERE operation_id=?1",
      deletion.operationId,
    ),
  ).toEqual({ state: "succeeded", lease_expires_at: null });

  // The deleted row carries the instant the deletion completed: a billing day after it no longer owns the project.
  expect(
    await first(
      "SELECT lifecycle_state,lifecycle_version,updated_at FROM projects WHERE project_id=?1",
      project.projectId,
    ),
  ).toEqual({
    lifecycle_state: "deleted",
    lifecycle_version: 3,
    updated_at: "2026-10-28T12:00:00.000000Z",
  });
  expect(
    await all(
      "SELECT name,head_version,active_deployment_id,active_revision_id FROM environments WHERE project_id=?1 ORDER BY name",
      project.projectId,
    ),
  ).toEqual([
    { name: "dev", head_version: 1, active_deployment_id: null, active_revision_id: null },
    { name: "prod", head_version: 2, active_deployment_id: null, active_revision_id: null },
  ]);
  expect(
    await first(
      "SELECT count(*) n FROM environment_secrets WHERE project_id=?1",
      project.projectId,
    ),
  ).toEqual({ n: 0 });
  expect(
    await first(
      "SELECT state,completed_at FROM cleanup_runs WHERE cleanup_run_id=?1",
      deletion.cleanupRunId,
    ),
  ).toMatchObject({ state: "succeeded" });
  expect(
    await first("SELECT state FROM operations WHERE operation_id=?1", deletion.operationId),
  ).toEqual({ state: "succeeded" });
  const run = await first<{ state: string; terminal_evidence: string; completed_at: string }>(
    "SELECT state,terminal_evidence,completed_at FROM product_workflow_runs WHERE workflow_id=?1",
    deletion.workflowId,
  );
  expect(run.state).toBe("completed");
  expect(JSON.parse(run.terminal_evidence)).toMatchObject({
    tombstoneReceiptId: "tombstone-1",
    inventoryClean: true,
    consecutive404s: 3,
    gatewayAbsence: [null, { environmentName: "prod", active: false, revision: 2 }],
  });
  expect(
    await all(
      "SELECT revision,event_type FROM operation_events WHERE operation_id=?1 ORDER BY revision",
      deletion.operationId,
    ),
  ).toEqual([
    { revision: 1, event_type: "OperationStarted" },
    { revision: 2, event_type: "OperationSucceeded" },
  ]);
  expect(
    await all(
      "SELECT event_type FROM audit_events WHERE operation_id=?1 ORDER BY event_type",
      deletion.operationId,
    ),
  ).toEqual([
    { event_type: "OperationStarted" },
    { event_type: "ProjectDeletionRequestedV1Completed" },
  ]);

  // Replay: the same evidence answers "replayed" and writes nothing; different evidence is refused.
  expect(await completeProductLifecycleCommand(context, completion)).toBe("replayed");
  expect(
    await first("SELECT count(*) n FROM operation_events WHERE operation_id=?1", scope.operationId),
  ).toEqual({ n: 2 });
  await expect(
    completeProductLifecycleCommand(context, {
      ...completion,
      deletion: { ...completion.deletion, tombstoneReceiptId: "tombstone-other" },
    }),
  ).rejects.toThrow("Product Workflow state changed");
  expect(owned.published.operationId).not.toBe(deletion.operationId);
});

it("refuses to complete a deletion while inventory remains, with incomplete heads or an inconsistent scope", async () => {
  const project = await seedProject(control);
  await seedR2Bucket(project, project.prodEnvironmentId);
  const deletion = await acceptDeletion(project);
  await inventoryOf(project, deletion, false);
  const context = lifecycleContext(control.core),
    completion = {
      ...lifecycleIdentity(project, project.devEnvironmentId, deletion, COMPLETED),
      eventType: "ProjectDeletionRequestedV1" as const,
      expectedEnvironmentHeads: await headsOf(project),
      deletion: {
        tombstoneReceiptId: "tombstone-1",
        inventoryClean: true as const,
        consecutive404s: 3,
        gatewayAbsence: [null, null],
      },
    };
  // The R2 bucket has no removed/not_found attempt: the guard rejects every attempt and nothing is changed.
  await expect(completeProductLifecycleCommand(context, completion)).rejects.toBeInstanceOf(
    StoreBusyError,
  );
  expect(
    await first("SELECT lifecycle_state FROM projects WHERE project_id=?1", project.projectId),
  ).toEqual({ lifecycle_state: "deleting" });
  expect(
    await first(
      "SELECT state FROM product_workflow_runs WHERE workflow_id=?1",
      deletion.workflowId,
    ),
  ).toEqual({ state: "queued" });

  const [dev] = completion.expectedEnvironmentHeads;
  await expect(
    completeProductLifecycleCommand(context, {
      ...completion,
      expectedEnvironmentHeads: [dev, dev],
    }),
  ).rejects.toThrow("Deletion environment heads are incomplete");
  await expect(
    completeProductLifecycleCommand(context, {
      ...completion,
      deletion: { ...completion.deletion, gatewayAbsence: [null, { not: "a receipt" }] },
    }),
  ).rejects.toThrow();
  // A completion for another command kind than the stored intent, and two recovery attempts, are refused.
  const handle = { ...lifecycleIdentity(project, project.devEnvironmentId, deletion, COMPLETED) };
  await expect(
    completeProductLifecycleCommand(context, {
      ...handle,
      eventType: "ProjectHandleChangeRequestedV1",
    }),
  ).rejects.toThrow("Product command intent scope changed");
  await expect(
    completeProductLifecycleCommand(context, {
      ...completion,
      reconciliationAttemptId: newUlid(),
      replayAttemptId: newUlid(),
    }),
  ).rejects.toThrow("Product Workflow cannot activate two recovery attempts");
});

it("resolves a lost response of the tombstone and the completion by reading the committed evidence", async () => {
  const project = await seedProject(control),
    deletion = await acceptDeletion(project);
  await inventoryOf(project, deletion, false);
  const tombstone = tombstoneOf(project, deletion);
  expect(
    await retainProductDeletionTombstone(
      lifecycleContext(losingWriteResponses(control.core, 1)),
      tombstone,
    ),
  ).toBe("created");
  expect(
    await first("SELECT state FROM operations WHERE operation_id=?1", deletion.operationId),
  ).toEqual({ state: "running" });

  const completion = {
    ...lifecycleIdentity(project, project.devEnvironmentId, deletion, COMPLETED),
    eventType: "ProjectDeletionRequestedV1" as const,
    expectedEnvironmentHeads: await headsOf(project),
    deletion: {
      tombstoneReceiptId: "tombstone-1",
      inventoryClean: true as const,
      consecutive404s: 3,
      gatewayAbsence: [null, null],
    },
  };
  // The commit succeeded, only its answer was lost: the retry finds the terminal evidence and says "replayed".
  expect(
    await completeProductLifecycleCommand(
      lifecycleContext(losingWriteResponses(control.core, 1)),
      completion,
    ),
  ).toBe("replayed");
  expect(
    await first("SELECT lifecycle_state FROM projects WHERE project_id=?1", project.projectId),
  ).toEqual({ lifecycle_state: "deleted" });
});

it("completes the deletion of a project that never claimed runtime secrets or published a deployment", async () => {
  const project = await seedProject(control),
    deletion = await acceptDeletion(project);
  // Only a claim of runtime secrets creates the delivery state; seedProject's state is removed for this project.
  await control.core
    .prepare("DELETE FROM runtime_secret_delivery_states WHERE project_id=?1")
    .bind(project.projectId)
    .run();
  await inventoryOf(project, deletion, true);
  const context = lifecycleContext(control.core);
  expect(await retainProductDeletionTombstone(context, tombstoneOf(project, deletion))).toBe(
    "created",
  );
  const absent = await observeGatewayRoute(context, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
  });
  await leaseOperation(control.core, deletion.operationId);
  const completion = {
    ...lifecycleIdentity(project, project.devEnvironmentId, deletion, COMPLETED),
    eventType: "ProjectDeletionRequestedV1" as const,
    expectedEnvironmentHeads: await headsOf(project),
    deletion: {
      tombstoneReceiptId: "tombstone-1",
      inventoryClean: true as const,
      consecutive404s: 3,
      gatewayAbsence: [null, absent],
    },
  };
  expect(await completeProductLifecycleCommand(context, completion)).toBe("completed");
  expect(
    await first("SELECT lifecycle_state FROM projects WHERE project_id=?1", project.projectId),
  ).toEqual({ lifecycle_state: "deleted" });
  expect(
    await first("SELECT state FROM operations WHERE operation_id=?1", deletion.operationId),
  ).toEqual({ state: "succeeded" });
});

it("revokes the project's application-identity DNS grants when its deletion completes, leaving the upstream revoke to the sweep", async () => {
  const project = await seedProject(control);
  // A live Cloudflare grant of the project: its refresh token must be revoked upstream after the project is gone.
  const authorization = newUlid(),
    zero = "00".repeat(32);
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO project_application_domain_identities(project_id,organization_id,hostname,registrable_domain,revision,state,challenge_name,challenge_value,declared_at,expires_at,idempotency_key_sha256,request_sha256,actor_id) VALUES(?1,?2,'example.test','example.test',1,'pending','_omh-project.example.test',?3,'2026-10-28T10:00:00.000000Z','2099-01-01T00:00:00.000000Z',zeroblob(32),zeroblob(32),'user:user_owner')",
      )
      .bind(project.projectId, project.organizationId, "v".repeat(64)),
    control.core
      .prepare(
        "INSERT INTO scoped_customer_dns_authorizations(authorization_id,organization_id,purpose,resource_id,resource_revision,principal_id,delegation,zone_name,state_sha256,idempotency_key_sha256,request_sha256,issued_at,expires_at,consumed_at) VALUES(?1,?2,'application_identity',?3,1,'user:user_owner','{}','example.test',unhex(?4),unhex(?4),unhex(?4),'2026-10-28T10:00:00.000000Z','2026-10-28T10:05:00.000000Z','2026-10-28T10:01:00.000000Z')",
      )
      .bind(authorization, project.organizationId, project.projectId, zero),
    control.core
      .prepare(
        "INSERT INTO scoped_customer_dns_grants(organization_id,purpose,resource_id,resource_revision,authorization_id,principal_id,zone_name,zone_id,account_id,access_ciphertext,access_nonce,refresh_ciphertext,refresh_nonce,key_version,access_expires_at,connected_at) VALUES(?1,'application_identity',?2,1,?3,'user:user_owner','example.test',?4,?4,x'01',zeroblob(12),x'02',zeroblob(12),1,'2026-10-28T11:00:00.000000Z','2026-10-28T10:02:00.000000Z')",
      )
      .bind(project.organizationId, project.projectId, authorization, "ab".repeat(16)),
  ]);
  const deletion = await acceptDeletion(project);
  await control.core
    .prepare("DELETE FROM runtime_secret_delivery_states WHERE project_id=?1")
    .bind(project.projectId)
    .run();
  await inventoryOf(project, deletion, true);
  const context = lifecycleContext(control.core);
  expect(await retainProductDeletionTombstone(context, tombstoneOf(project, deletion))).toBe(
    "created",
  );
  const absent = await observeGatewayRoute(context, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
  });
  await leaseOperation(control.core, deletion.operationId);
  expect(
    await completeProductLifecycleCommand(context, {
      ...lifecycleIdentity(project, project.devEnvironmentId, deletion, COMPLETED),
      eventType: "ProjectDeletionRequestedV1" as const,
      expectedEnvironmentHeads: await headsOf(project),
      deletion: {
        tombstoneReceiptId: "tombstone-1",
        inventoryClean: true as const,
        consecutive404s: 3,
        gatewayAbsence: [null, absent],
      },
    }),
  ).toBe("completed");
  expect(
    await first(
      "SELECT revoked_at FROM scoped_customer_dns_grants WHERE organization_id=?1 AND purpose='application_identity' AND resource_id=?2",
      project.organizationId,
      project.projectId,
    ),
  ).toEqual({ revoked_at: "2026-10-28T12:00:00.000000Z" });
  expect(
    await first(
      "SELECT revoked_at FROM scoped_customer_dns_authorizations WHERE authorization_id=?1",
      authorization,
    ),
  ).toEqual({ revoked_at: "2026-10-28T12:00:00.000000Z" });
});

it("keeps refusing the deletion of a project whose publication has no runtime secret state", async () => {
  const project = await seedProject(control);
  await seedOwnedResources(project);
  const deletion = await acceptDeletion(project);
  await control.core
    .prepare("DELETE FROM runtime_secret_delivery_states WHERE project_id=?1")
    .bind(project.projectId)
    .run();
  await inventoryOf(project, deletion, true);
  await retirePublishedDeployment(project, deletion.operationId);
  const context = lifecycleContext(control.core);
  expect(await retainProductDeletionTombstone(context, tombstoneOf(project, deletion))).toBe(
    "created",
  );
  const absent = await observeGatewayRoute(context, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
  });
  await leaseOperation(control.core, deletion.operationId);
  await expect(
    completeProductLifecycleCommand(context, {
      ...lifecycleIdentity(project, project.devEnvironmentId, deletion, COMPLETED),
      eventType: "ProjectDeletionRequestedV1" as const,
      expectedEnvironmentHeads: await headsOf(project),
      deletion: {
        tombstoneReceiptId: "tombstone-1",
        inventoryClean: true as const,
        consecutive404s: 3,
        gatewayAbsence: [null, absent],
      },
    }),
  ).rejects.toBeInstanceOf(StoreBusyError);
  expect(
    await first("SELECT lifecycle_state FROM projects WHERE project_id=?1", project.projectId),
  ).toEqual({ lifecycle_state: "deleting" });
});

it("completes a refused handle change and a data change, each exactly once", async () => {
  // Handle change: the Workflow ends with the refusal evidence; the operation ends failed (see the test below).
  const project = await seedProject(control),
    handle = await seedAcceptedOperation(project, project.devEnvironmentId, {
      eventType: "ProjectHandleChangeRequestedV1",
      claim: false,
    });
  await acknowledgeOutbox(project, handle.eventId);
  const context = lifecycleContext(control.core),
    handleCompletion = {
      ...lifecycleIdentity(project, project.devEnvironmentId, handle, COMPLETED),
      eventType: "ProjectHandleChangeRequestedV1" as const,
    };
  expect(await completeProductLifecycleCommand(context, handleCompletion)).toBe("completed");
  expect(
    JSON.parse(
      (
        await first<{ terminal_evidence: string }>(
          "SELECT terminal_evidence FROM product_workflow_runs WHERE workflow_id=?1",
          handle.workflowId,
        )
      ).terminal_evidence,
    ),
  ).toEqual({ requestedHandle: "renamed-handle", outcome: "project_handle_taken" });
  expect(await completeProductLifecycleCommand(context, handleCompletion)).toBe("replayed");

  // Data change: dev gets a new data environment, prod keeps the shared one.
  const owner = await seedProject(control),
    shared = newUlid(),
    isolated = newUlid(),
    assignedAt = "2026-10-28T10:00:00.000Z",
    stored = "2026-10-28T10:00:00.000000Z",
    before = {
      dataMode: "shared" as const,
      dev: {
        environment: "dev" as const,
        environmentId: owner.devEnvironmentId,
        dataEnvironmentId: shared,
        assignmentVersion: 1,
        assignedAt,
      },
      prod: {
        environment: "prod" as const,
        environmentId: owner.prodEnvironmentId,
        dataEnvironmentId: shared,
        assignmentVersion: 1,
        assignedAt,
      },
    },
    transition = planProjectDataChangeTransition({
      change: "isolate_prod_keeps_data",
      assignments: before,
      newDataEnvironmentId: isolated,
      prodDatabaseReady: true,
    }),
    db = control.core;
  await db.batch([
    ...[shared, isolated].map((id) =>
      db
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
        )
        .bind(owner.organizationId, owner.projectId, id, stored),
    ),
    ...[owner.devEnvironmentId, owner.prodEnvironmentId].map((environmentId) =>
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?4,1,?5)",
        )
        .bind(owner.organizationId, owner.projectId, environmentId, shared, stored),
    ),
  ]);
  const change = await seedAcceptedOperation(owner, owner.devEnvironmentId, {
    eventType: "ProjectDataChangeRequestedV1",
    intent: async (operationId) => ({
      expected_etag: `"${"a".repeat(64)}"`,
      cleanup_run_id: await seedCleanupRun(owner, operationId),
      data_change: "isolate_prod_keeps_data",
      data_change_snapshot: JSON.stringify({
        transition,
        environmentHeads: [
          { environmentId: owner.devEnvironmentId, expectedHeadVersion: 0 },
          { environmentId: owner.prodEnvironmentId, expectedHeadVersion: 0 },
        ],
        registrationGenerations: [{ dataEnvironmentId: shared, registrationVersion: 0 }],
      }),
    }),
  });
  await acknowledgeOutbox(owner, change.eventId);
  await leaseOperation(control.core, change.operationId);
  const dataCompletion = {
    ...lifecycleIdentity(owner, owner.devEnvironmentId, change, COMPLETED),
    eventType: "ProjectDataChangeRequestedV1" as const,
    dataChangeResult: {
      schemaVersion: "ohmyhost.operation-data-change-result/v1",
      operationId: change.operationId,
      change: "isolate_prod_keeps_data",
      data_mode: "isolated",
      redeploy_environments: ["dev"],
      deleted_database: false,
      deleted_files: 0,
    },
  };
  // The assignments have not been switched yet: the Workflow must not complete.
  await expect(completeProductLifecycleCommand(context, dataCompletion)).rejects.toThrow(
    "Data change assignments are incomplete",
  );
  await db
    .prepare(
      "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?4,2,?5)",
    )
    .bind(owner.organizationId, owner.projectId, owner.devEnvironmentId, isolated, stored)
    .run();
  expect(await completeProductLifecycleCommand(context, dataCompletion)).toBe("completed");
  expect(
    await first(
      "SELECT state,lease_expires_at FROM operations WHERE operation_id=?1",
      change.operationId,
    ),
  ).toEqual({ state: "succeeded", lease_expires_at: null });
  expect(
    await first(
      "SELECT count(*) n FROM product_provider_mutation_claims WHERE operation_id=?1",
      change.operationId,
    ),
  ).toEqual({ n: 0 });
  expect(
    await first("SELECT state FROM cleanup_runs WHERE operation_id=?1", change.operationId),
  ).toEqual({ state: "succeeded" });
  expect(
    await first("SELECT lifecycle_state FROM projects WHERE project_id=?1", owner.projectId),
  ).toEqual({ lifecycle_state: "active" });
  expect(await completeProductLifecycleCommand(context, dataCompletion)).toBe("replayed");
  // The evidence of another change than the accepted one is refused.
  await expect(
    completeProductLifecycleCommand(context, {
      ...dataCompletion,
      dataChangeResult: {
        ...dataCompletion.dataChangeResult,
        change: "reset_dev",
        data_mode: "isolated",
      },
    }),
  ).rejects.toThrow("Data change terminal evidence changed");
});

it("ends a refused handle change as failed and releases its claim, so no later sweep reopens it", async () => {
  // The rename moved the gateway address, then the handle was found taken: the operation must end as failed.
  const project = await seedProject(control),
    rename = await seedAcceptedOperation(project, project.devEnvironmentId, {
      eventType: "ProjectHandleChangeRequestedV1",
    });
  await acknowledgeOutbox(project, rename.eventId);
  await control.core
    .prepare(
      "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) SELECT organization_id,?1,operation_id,project_id,0,'OperationQueued',NULL,'{}',created_at FROM operations WHERE operation_id=?2",
    )
    .bind(newUlid(), rename.operationId)
    .run();
  await leaseOperation(control.core, rename.operationId);
  const context = lifecycleContext(control.core);
  expect(
    await completeProductLifecycleCommand(context, {
      ...lifecycleIdentity(project, project.devEnvironmentId, rename, COMPLETED),
      eventType: "ProjectHandleChangeRequestedV1" as const,
    }),
  ).toBe("completed");
  expect(
    await readAcceptedApiProductOperation(control.core, project.organizationId, rename.operationId),
  ).toMatchObject({ state: "failed", failure: { code: "PROJECT_HANDLE_TAKEN" } });
  expect(
    await first(
      "SELECT lease_expires_at FROM operations WHERE operation_id=?1",
      rename.operationId,
    ),
  ).toEqual({ lease_expires_at: null });
  expect(
    await first(
      "SELECT count(*) n FROM product_provider_mutation_claims WHERE operation_id=?1",
      rename.operationId,
    ),
  ).toEqual({ n: 0 });
  // A later sweep finds nothing to fail: the terminal history stays the only history.
  expect(
    await recoverExpiredOperationLease(context, {
      now: "2999-01-02T00:00:00.000Z",
      exactOperation: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId: rename.operationId,
        leaseExpiresAt: "2999-01-01T00:00:00.000Z",
      },
    }),
  ).toBeNull();
  expect(
    await readAcceptedApiProductOperation(control.core, project.organizationId, rename.operationId),
  ).toMatchObject({ state: "failed", failure: { code: "PROJECT_HANDLE_TAKEN" } });
});
