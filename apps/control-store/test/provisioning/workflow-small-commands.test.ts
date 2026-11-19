import { afterAll, beforeAll, expect, it } from "vitest";
import { SharedCoreRouter } from "../../src/router.js";
import { newUlid } from "../../src/catalog/common.js";
import { renewProductOperationLease } from "../../src/catalog/provisioning/operation-lease.js";
import { readProductRollbackDataTarget } from "../../src/catalog/provisioning/rollback-data-target.js";
import {
  runtimeSecretDeletionHash,
  runtimeSecretDeletionPublication,
  runtimeSecretDeletionStatements,
} from "../../src/catalog/provisioning/runtime-secret-deletion.js";
import {
  RUN,
  terminalIdentity,
  terminalMatches,
  workflowTerminalStatements,
} from "../../src/catalog/provisioning/workflow-terminal-plan.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  STORED_NOW,
  losingWriteResponses,
  seedProject,
  type SeededProject,
} from "../support/platform-fixtures.js";
import { seedAcceptedOperation, seedOperation } from "../support/accepted-operation.js";
import { seedWfpPublication, sourceFrameworkPlan } from "../support/provider-fixtures.js";
import type { D1Database } from "../../src/d1-types.js";

let control: TestControl;
let project: SeededProject;
beforeAll(async () => {
  control = await createTestControl();
  project = await seedProject(control);
});
afterAll(async () => control.dispose());

/** A fixture row that must exist; the test fails with a clear message instead of a null dereference. */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`fixture row missing: ${what}`);
  return value;
}
const context = (db: D1Database) => ({ directory: db, router: new SharedCoreRouter(db) });
const leaseOf = async (operationId: string) =>
  (
    await control.core
      .prepare("SELECT state,lease_expires_at FROM operations WHERE operation_id=?")
      .bind(operationId)
      .first<{ state: string; lease_expires_at: string | null }>()
  )?.lease_expires_at;

it("renews the original step lease, replays a lost reply and refuses an expired or finished execution", async () => {
  const op = await seedAcceptedOperation(project, project.devEnvironmentId, { claim: false });
  const input = (now: string, durationMilliseconds = 900_000) => ({
    organizationId: project.organizationId,
    operationId: op.operationId,
    workflowId: op.workflowId,
    physicalWorkflowId: op.workflowId,
    now,
    durationMilliseconds,
  });
  await control.core
    .prepare(
      "UPDATE operations SET lease_expires_at='2026-10-28T11:30:00.000000Z' WHERE operation_id=?",
    )
    .bind(op.operationId)
    .run();

  // a lost reply: the write committed, the lookup recognizes the exact lease
  await renewProductOperationLease(
    context(losingWriteResponses(control.core, 1)),
    input("2026-10-28T11:10:00.000Z"),
  );
  expect(await leaseOf(op.operationId)).toBe("2026-10-28T11:25:00.000000Z");
  // the same renewal again is a plain success
  await renewProductOperationLease(
    context(control.core),
    input("2026-10-28T11:20:00.000Z", 1_800_000),
  );
  expect(await leaseOf(op.operationId)).toBe("2026-10-28T11:50:00.000000Z");

  // a different physical execution cannot renew the lease of this logical Workflow
  await expect(
    renewProductOperationLease(context(control.core), {
      ...input("2026-10-28T11:21:00.000Z"),
      physicalWorkflowId: "foreign-execution",
    }),
  ).rejects.toThrow("Operation lease is no longer active");
  // an expired lease cannot renew itself
  await expect(
    renewProductOperationLease(context(control.core), input("2026-10-28T12:00:00.000Z")),
  ).rejects.toThrow("Operation lease is no longer active");
  expect(await leaseOf(op.operationId)).toBe("2026-10-28T11:50:00.000000Z");
  // a duration outside the original bounds is invalid input
  await expect(
    renewProductOperationLease(context(control.core), input("2026-10-28T11:21:00.000Z", 1000)),
  ).rejects.toThrow();

  // a succeeded operation answers success without touching the row (cleanup may finish after success)
  await control.core
    .prepare("UPDATE operations SET state='succeeded',lease_expires_at=NULL WHERE operation_id=?")
    .bind(op.operationId)
    .run();
  await renewProductOperationLease(context(control.core), input("2026-10-28T13:00:00.000Z"));
  expect(await leaseOf(op.operationId)).toBeNull();
});

/** The original per-environment data identity the project creation command leaves behind. */
async function assignData(
  p: SeededProject,
  dataEnvironmentId: string,
  version: number,
  at: string,
) {
  const db = control.core;
  await db.batch([
    db
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(p.organizationId, p.projectId, dataEnvironmentId, at),
    ...[p.devEnvironmentId, p.prodEnvironmentId].map((environmentId) =>
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,assignment_version,data_environment_id,assigned_at) VALUES(?1,?2,?3,?4,?5,?6)",
        )
        .bind(p.organizationId, p.projectId, environmentId, version, dataEnvironmentId, at),
    ),
  ]);
}

it("reads the original rollback data identity, flags a moved data target and an open data change, and refuses a cleaned or unknown target", async () => {
  const p = await seedProject(control);
  const dataEnvironmentId = newUlid();
  await assignData(p, dataEnvironmentId, 1, STORED_NOW);
  const operationId = await seedOperation(p);
  const published = await seedWfpPublication(p, {
    operationId,
    environmentId: p.prodEnvironmentId,
  });
  const scope = {
    organizationId: p.organizationId,
    projectId: p.projectId,
    environmentId: p.prodEnvironmentId,
    deploymentId: published.deploymentId,
  };
  const target = {
    deploymentId: published.deploymentId,
    environmentId: p.prodEnvironmentId,
    revisionId: published.revisionId,
    artifactId: published.artifactId,
    artifactDigest: new Uint8Array(32).fill(3),
    expectedHeadVersion: 1,
    dataEnvironmentId,
    assignmentVersion: 1,
    registrationVersion: 0,
    dataChanged: false,
    dataChangeInProgress: false,
  };
  expect(await readProductRollbackDataTarget(context(control.core), scope)).toEqual(target);
  expect(
    await readProductRollbackDataTarget(context(control.core), {
      ...scope,
      revisionId: published.revisionId,
    }),
  ).toEqual(target);
  expect(
    await readProductRollbackDataTarget(context(control.core), { ...scope, revisionId: newUlid() }),
  ).toBeNull();
  expect(
    await readProductRollbackDataTarget(context(control.core), {
      ...scope,
      deploymentId: newUlid(),
    }),
  ).toBeNull();

  // a database-enabled revision whose data target moved after it was staged, while a data change is running
  const dataOperation = await seedOperation(p);
  const withData = await seedWfpPublication(p, {
    operationId: dataOperation,
    environmentId: p.devEnvironmentId,
    frameworkPlan: sourceFrameworkPlan(true),
  });
  const movedTo = newUlid();
  await assignData(p, movedTo, 2, "2026-10-28T12:00:00.000000Z");
  await seedAcceptedOperation(p, p.devEnvironmentId, {
    eventType: "ProjectDataChangeRequestedV1",
    claim: false,
    operationId: await seedOperation(p, { state: "queued" }),
  });
  expect(
    await readProductRollbackDataTarget(context(control.core), {
      ...scope,
      environmentId: p.devEnvironmentId,
      deploymentId: withData.deploymentId,
    }),
  ).toMatchObject({
    dataEnvironmentId: movedTo,
    assignmentVersion: 2,
    dataChanged: true,
    dataChangeInProgress: true,
  });

  // once the exact published script was removed by a maintenance cleanup the revision is not a rollback target
  const script = present(
    await control.core
      .prepare(
        "SELECT dispatch_namespace,immutable_script_name FROM wfp_candidate_receipts WHERE candidate_receipt_id=?",
      )
      .bind(published.candidateReceiptId)
      .first<{ dispatch_namespace: string; immutable_script_name: string }>(),
    "candidate",
  );
  const maintenance = await seedOperation(p);
  const refreshDeploymentId = newUlid();
  await control.core
    .prepare(
      "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','running',0,?6,?6)",
    )
    .bind(
      p.organizationId,
      refreshDeploymentId,
      p.projectId,
      p.prodEnvironmentId,
      maintenance,
      STORED_NOW,
    )
    .run();
  const plan = present(
    await control.core
      .prepare("SELECT source_connection_id FROM deployment_plans WHERE plan_id=?")
      .bind(published.planId)
      .first<{ source_connection_id: string }>(),
    "plan",
  );
  await seedAcceptedOperation(p, p.prodEnvironmentId, {
    operationId: maintenance,
    claim: false,
    intent: {
      plan_id: published.planId,
      source_connection_id: plan.source_connection_id,
      deployment_id: refreshDeploymentId,
      source_generation: 1,
      binding_refresh_snapshot: JSON.stringify({
        sourceDeploymentId: published.deploymentId,
        sourceRevisionId: published.revisionId,
        sourceCandidateReceiptId: published.candidateReceiptId,
        sourceArtifactId: published.artifactId,
        sourcePlanId: published.planId,
        sourceBuildExecutionId: published.buildExecutionId,
        sourceArtifactSha256: "02".repeat(32),
        sourceNamespace: script.dispatch_namespace,
        sourceScriptName: script.immutable_script_name,
        sourceProviderTag: "ab".repeat(16),
        expectedHeadVersion: 1,
        expectedGatewayRevision: 1,
        dataEnvironmentId,
        assignmentVersion: 1,
        registrationVersion: 0,
      }),
      binding_refresh_snapshot_sha256: new Uint8Array(32).fill(8),
    },
  });
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `cloudflare\0wfp-script\0${script.dispatch_namespace}/${script.immutable_script_name}`,
        ),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),?6,?7)",
      )
      .bind(
        p.organizationId,
        newUlid(),
        p.projectId,
        maintenance,
        hash,
        STORED_NOW,
        `${script.dispatch_namespace}/${script.immutable_script_name}`,
      ),
    control.core
      .prepare(
        "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,attempted_at) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),'removed',?6)",
      )
      .bind(newUlid(), p.organizationId, p.projectId, maintenance, hash, STORED_NOW),
  ]);
  expect(await readProductRollbackDataTarget(context(control.core), scope)).toBeNull();
});

it("appends the fixed terminal history once and refuses a stale executor; the stored evidence compares canonically", async () => {
  const db = control.core;
  const op = await seedAcceptedOperation(project, project.devEnvironmentId, { claim: false });
  const scope = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
    operationId: op.operationId,
  };
  const ids = () => ({
    workflowId: op.workflowId,
    outboxEventId: op.eventId,
    startedOperationEventId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
  });
  const read = () =>
    db
      .prepare(RUN)
      .bind(...terminalIdentity(scope, ids(), "DeploymentRequestedV1"))
      .first<Record<string, unknown>>();
  const run = present(await read(), "workflow run");
  expect(terminalMatches(run, {})).toBe(false);
  const evidence = { status: "ok", nested: { list: [1, { z: 1, y: 2 }], none: null } };
  const first = ids();
  // the queue consumer acknowledged the outbox event before the Workflow terminates
  await db
    .prepare("UPDATE outbox_events SET acknowledged_at=? WHERE event_id=?")
    .bind(STORED_NOW, op.eventId)
    .run();
  await db.batch(
    workflowTerminalStatements(
      db,
      scope,
      first,
      "DeploymentRequestedV1",
      run,
      evidence,
      "2026-10-28T12:00:00.000000Z",
      { url: "https://x.example" },
    ),
  );
  const done = await read();
  expect(done).toMatchObject({ state: "completed", completed_at: "2026-10-28T12:00:00.000000Z" });
  expect(
    terminalMatches(done, { nested: { none: null, list: [1, { y: 2, z: 1 }] }, status: "ok" }),
  ).toBe(true);
  expect(terminalMatches(done, { ...evidence, status: "other" })).toBe(false);
  expect(terminalMatches(null, evidence)).toBe(false);
  expect(
    (
      await db
        .prepare(
          "SELECT revision,event_type,idempotency_key,payload FROM operation_events WHERE operation_id=? ORDER BY revision",
        )
        .bind(op.operationId)
        .all()
    ).results.map((row) => ({ ...row, payload: JSON.parse(String(row["payload"])) as unknown })),
  ).toEqual([
    {
      revision: 1,
      event_type: "OperationStarted",
      idempotency_key: `${op.workflowId}:start`,
      payload: {},
    },
    {
      revision: 2,
      event_type: "OperationSucceeded",
      idempotency_key: `${op.workflowId}:complete`,
      payload: { result: { url: "https://x.example" } },
    },
  ]);
  expect(
    await db
      .prepare("SELECT event_type,actor_id FROM audit_events WHERE audit_event_id=?")
      .bind(first.auditEventId)
      .first(),
  ).toEqual({ event_type: "DeploymentRequestedV1Completed", actor_id: "deployment-workflow" });
  await expect(
    db.batch(
      workflowTerminalStatements(
        db,
        scope,
        ids(),
        "DeploymentRequestedV1",
        run,
        evidence,
        "2026-10-28T12:00:01.000000Z",
        null,
      ),
    ),
  ).rejects.toThrow("guard_operation_conflict");
});

it("deletes a project environment's secrets only under the exact deletion authority", async () => {
  const db = control.core;
  const p = await seedProject(control);
  const published = await seedWfpPublication(p, {
    operationId: await seedOperation(p),
    environmentId: p.prodEnvironmentId,
  });
  const op = await seedAcceptedOperation(p, p.devEnvironmentId, {
    eventType: "ProjectDeletionRequestedV1",
    claim: false,
  });
  await db.batch([
    db
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting' WHERE organization_id=? AND project_id=?",
      )
      .bind(p.organizationId, p.projectId),
    ...[p.devEnvironmentId, p.prodEnvironmentId].map((environmentId) =>
      db
        .prepare(
          "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,'EDGE_KEY',?4,?5,?6,1,1,?7,?7)",
        )
        .bind(
          p.organizationId,
          p.projectId,
          environmentId,
          new Uint8Array(32).fill(1),
          new Uint8Array(12).fill(2),
          new Uint8Array(32).fill(3),
          STORED_NOW,
        ),
    ),
  ]);
  const scope = (environmentId: string) => ({
    organizationId: p.organizationId,
    projectId: p.projectId,
    environmentId,
    operationId: op.operationId,
    completedAt: "2026-10-28T12:00:00.000000Z",
  });
  const secrets = async (environmentId: string) =>
    (
      await db
        .prepare(
          "SELECT name FROM environment_secrets WHERE organization_id=? AND environment_id=?",
        )
        .bind(p.organizationId, environmentId)
        .all()
    ).results.length;

  // never published: no original publication, so no cleanup hash is required
  const none = await runtimeSecretDeletionPublication(db, scope(p.devEnvironmentId)).first<{
    dispatch_namespace: string;
    script_name: string;
  }>();
  expect(none).toBeNull();
  expect(await runtimeSecretDeletionHash(none)).toBeNull();
  await db.batch(runtimeSecretDeletionStatements(db, scope(p.devEnvironmentId), none, null));
  expect(await secrets(p.devEnvironmentId)).toBe(0);
  expect(await secrets(p.prodEnvironmentId)).toBe(1);

  // published and still active: the exact cleanup of the script is not proven, nothing is deleted
  const publication = await runtimeSecretDeletionPublication(db, scope(p.prodEnvironmentId)).first<{
    dispatch_namespace: string;
    script_name: string;
  }>();
  expect(publication).toEqual({
    dispatch_namespace: "ohmyho-production",
    script_name: `p-${p.projectId.toLowerCase()}-prod-${published.deploymentId.toLowerCase()}`,
  });
  const publicationHash = await runtimeSecretDeletionHash(publication);
  expect(publicationHash).toMatch(/^[0-9a-f]{64}$/u);
  await expect(
    db.batch(
      runtimeSecretDeletionStatements(db, scope(p.prodEnvironmentId), publication, publicationHash),
    ),
  ).rejects.toThrow("guard_operation_conflict");
  expect(await secrets(p.prodEnvironmentId)).toBe(1);
});
