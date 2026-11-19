import { afterAll, beforeAll, expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control?.dispose());

it("accepts and continues deletion of a real Free Prod-only project without requiring a Dev row", async () => {
  const project = await seedProject(control, { prodOnly: true }),
    other = await seedProject(control, { prodOnly: true }),
    store = createControlStore(control.bindings),
    api = store.productApi,
    db = project.shard,
    scope = { organizationId: project.organizationId, projectId: project.projectId },
    principalId = "user:fixture";
  const environments = () =>
    db
      .prepare(
        "SELECT environment_id,name,dev_access_epoch FROM environments WHERE organization_id=? AND project_id=?",
      )
      .bind(scope.organizationId, scope.projectId)
      .all();
  expect((await environments()).results).toEqual([
    { environment_id: project.prodEnvironmentId, name: "prod", dev_access_epoch: 1 },
  ]);
  expect(
    await db
      .prepare("SELECT paid_until FROM credit_account WHERE organization_id=?")
      .bind(scope.organizationId)
      .first(),
  ).toBeNull();
  expect(
    await api.readApiDeletionAdmission({ ...scope, organizationId: other.organizationId }),
  ).toBeNull();

  const deletion = async (version: number, minute: string) => {
    const plan = await api.readApiDeletePlanTarget(scope);
    expect(plan).toMatchObject({
      expectedProjectVersion: version,
      expectedEtag: `project:${scope.projectId}:v${version}`,
    });
    const confirmation = {
      ...scope,
      issuedToPrincipalId: principalId,
      action: "delete" as const,
      subjectEtag: String(plan?.expectedEtag),
      tokenDigest: new Uint8Array(32).fill(version),
    };
    expect(
      await api.issueApiActionConfirmation({
        ...confirmation,
        confirmationId: newUlid(),
        issuedAt: `2026-10-28T11:${minute}:00.000Z`,
      }),
    ).toBe("created");
    return {
      ...scope,
      environmentId: project.prodEnvironmentId,
      billingEpochId: project.billingEpochId,
      operationId: newUlid(),
      operationEventId: newUlid(),
      auditEventId: newUlid(),
      outboxEventId: newUlid(),
      principalId,
      requestId: "prod-only-deletion",
      httpMethod: "DELETE",
      routeTemplate: "/v1/projects/{project_id}",
      idempotencyKey: `prod-only-deletion-${version}`,
      canonicalRequestDigest: new Uint8Array(32).fill(version),
      eventType: "ProjectDeletionRequestedV1" as const,
      cleanupRunId: newUlid(),
      expectedProjectVersion: version,
      expectedEtag: String(plan?.expectedEtag),
      confirmation: {
        ...confirmation,
        consumedAt: `2026-10-28T11:${minute}:01.000Z`,
      },
      occurredAt: `2026-10-28T11:${minute}:01.000Z`,
    };
  };
  const first = await deletion(1, "00");
  await expect(
    api.acceptApiProductOperation({ ...first, environmentId: project.devEnvironmentId }),
  ).rejects.toThrow("deployment_persistence_conflict");
  expect(await api.acceptApiProductOperation(first)).toMatchObject({
    operationId: first.operationId,
    state: "queued",
  });
  expect(await api.readApiDeletionAdmission(scope)).toBeNull();

  for (const [index, type] of ["OperationStarted", "OperationFailed"].entries()) {
    await store.operations.transitionOperation({
      organizationId: scope.organizationId,
      operationId: first.operationId,
      expected: { state: index === 0 ? "queued" : "running", eventCount: index + 1 },
      event: {
        eventId: newUlid(),
        type,
        idempotencyKey: `${type}-prod-only-deletion`,
        occurredAt: "2026-10-28T11:02:00.000Z",
        ...(index === 1 ? { failure: { code: "CLEANUP_FAILED", message: "cleanup failed" } } : {}),
      },
      audit: {
        auditEventId: newUlid(),
        projectId: scope.projectId,
        operationId: first.operationId,
        eventType: type,
        actorType: "system",
        actorId: "workflow",
        payload: {},
        occurredAt: "2026-10-28T11:02:00.000Z",
      },
    });
  }
  const continuation = await deletion(2, "03");
  expect(await api.readApiDeletionAdmission(scope)).toMatchObject({
    environmentId: project.prodEnvironmentId,
    lifecycleState: "deleting",
    previousOperationId: first.operationId,
  });
  expect(await api.acceptApiProductOperation(continuation)).toMatchObject({
    operationId: continuation.operationId,
    state: "queued",
  });
  expect(await api.acceptApiProductOperation(continuation)).toMatchObject({
    operationId: continuation.operationId,
    state: "queued",
  });
  const audit = await db
    .prepare(
      "SELECT payload FROM organization_audit_events WHERE organization_id=? AND event_type='ProjectDeletionContinuationAccepted'",
    )
    .bind(scope.organizationId)
    .first<{ payload: string }>();
  expect(JSON.parse(String(audit?.payload))).toMatchObject({
    projectId: scope.projectId,
    operationId: continuation.operationId,
    previousOperationId: first.operationId,
    inheritedObjectAbsence: [],
  });
  expect(
    await db
      .prepare(
        "SELECT lifecycle_state,lifecycle_version FROM projects WHERE organization_id=? AND project_id=?",
      )
      .bind(scope.organizationId, scope.projectId)
      .first(),
  ).toEqual({ lifecycle_state: "deleting", lifecycle_version: 3 });
  expect((await environments()).results).toEqual([
    { environment_id: project.prodEnvironmentId, name: "prod", dev_access_epoch: 1 },
  ]);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}, 30_000);

it("plans the deletion of a project whose Paid hostname was displaced, since a displaced connection holds nothing", async () => {
  const project = await seedProject(control, { prodOnly: true }),
    store = createControlStore(control.bindings),
    scope = { organizationId: project.organizationId, projectId: project.projectId };
  await project.shard
    .prepare(
      "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at) VALUES(?1,?2,'shop.displaced-plan.example',NULL,'displaced','user:owner',?3,?4,'2026-10-28T10:00:00.000000Z','2026-10-28T10:00:00.000000Z')",
    )
    .bind(
      scope.organizationId,
      scope.projectId,
      new Uint8Array(32).fill(0xd2),
      new Uint8Array(32).fill(0xd3),
    )
    .run();
  await expect(store.productApi.readApiDeletionAdmission(scope)).resolves.toMatchObject({
    lifecycleState: "active",
  });
}, 30_000);

it("refuses to plan the deletion of an active project whose Paid hostname is still live", async () => {
  const project = await seedProject(control, { prodOnly: true }),
    store = createControlStore(control.bindings),
    scope = { organizationId: project.organizationId, projectId: project.projectId };
  await project.shard
    .prepare(
      "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at) VALUES(?1,?2,'shop.live-plan.example',NULL,'awaiting_deployment','user:owner',?3,?4,'2026-10-28T10:00:00.000000Z','2026-10-28T10:00:00.000000Z')",
    )
    .bind(
      scope.organizationId,
      scope.projectId,
      new Uint8Array(32).fill(0xd4),
      new Uint8Array(32).fill(0xd5),
    )
    .run();
  // The live connection must be removed first: the plan, the admission and the confirmed DELETE all refuse it alike.
  await expect(store.productApi.readApiDeletePlanTarget(scope)).rejects.toThrow(
    "project_domain_delete_required",
  );
  await expect(store.productApi.readApiDeletionAdmission(scope)).rejects.toThrow(
    "project_domain_delete_required",
  );
}, 30_000);
