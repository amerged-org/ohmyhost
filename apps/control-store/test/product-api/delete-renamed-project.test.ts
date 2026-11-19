import { expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import { seedAcceptedOperation, seedOperation } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";

const LEASE = "2026-10-28T10:02:00.000000Z";

/**
 * A project whose prod environment serves a published deployment under `handle`, and the accepted rename to
 * `requested` whose gateway route is already moved: the exact state in which the Workflow finalizes the rename.
 */
async function renameFixture(control: TestControl, handle: string, requested: string) {
  const store = createControlStore(control.bindings);
  const project = await seedProject(control, { handle });
  const publishing = await seedOperation(project);
  const published = await seedWfpPublication(project, {
    operationId: publishing,
    environmentId: project.prodEnvironmentId,
  });
  await control.core
    .prepare("UPDATE operations SET state='succeeded' WHERE operation_id=?1")
    .bind(publishing)
    .run();
  const accepted = await seedAcceptedOperation(project, project.prodEnvironmentId, {
    eventType: "ProjectHandleChangeRequestedV1",
    intent: { expected_etag: `"${"a".repeat(64)}"`, requested_handle: requested },
  });
  const route = await store.gateway.management.activate({
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
    operationId: accepted.operationId,
    claimId: accepted.claimId,
    expectedRevision: 1,
    candidateReceiptId: published.candidateReceiptId,
    egressAllowedOrigins: [],
  });
  await control.core
    .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
    .bind(accepted.eventId, "2026-10-28T10:01:00.000000Z")
    .run();
  await control.core
    .prepare("UPDATE operations SET lease_expires_at=?2 WHERE operation_id=?1")
    .bind(accepted.operationId, LEASE)
    .run();
  const input = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
    operationId: accepted.operationId,
    requestedHandle: requested,
    moved: [{ environmentId: project.prodEnvironmentId, publicOrigin: route.publicOrigin }],
    workflowId: accepted.workflowId,
    outboxEventId: accepted.eventId,
    startedOperationEventId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    completedAt: "2026-10-28T10:05:00.000Z",
  };
  return { control, project, published, accepted, route, input, store };
}

it("accepts a project deletion of a project whose handle was changed, like an unrenamed one", async () => {
  const control = await createTestControl();
  try {
    const f = await renameFixture(control, "old-handle-del", "renamed-del");
    expect(await f.store.provisioning.finalizeHandleChange(f.input)).toBe("applied");
    // The finished rename releases its provider mutation claim, which would otherwise block every later project write.
    expect(
      (
        await control.core
          .prepare("SELECT operation_id FROM product_provider_mutation_claims WHERE project_id=?1")
          .bind(f.project.projectId)
          .all()
      ).results,
    ).toEqual([]);

    const api = f.store.productApi;
    const scope = { organizationId: f.project.organizationId, projectId: f.project.projectId };
    const target = await api.readApiDeletePlanTarget(scope);
    expect(target).toMatchObject({ expectedProjectVersion: 1 });
    const expectedEtag = String(target?.expectedEtag);
    const issued = {
      confirmationId: newUlid(),
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      issuedToPrincipalId: "user:user_seed",
      action: "delete" as const,
      subjectEtag: expectedEtag,
      tokenDigest: new Uint8Array(32).fill(0xc7),
      issuedAt: "2026-10-28T11:20:00.000Z",
    };
    expect(await api.issueApiActionConfirmation(issued)).toBe("created");

    const accepted = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: f.project.devEnvironmentId,
      billingEpochId: f.project.billingEpochId,
      operationId: newUlid(),
      operationEventId: newUlid(),
      auditEventId: newUlid(),
      outboxEventId: newUlid(),
      principalId: "user:user_seed",
      requestId: "req-product",
      httpMethod: "DELETE",
      routeTemplate: "/v1/projects/{project_id}",
      idempotencyKey: `key-${newUlid()}`,
      canonicalRequestDigest: new Uint8Array(32).fill(0xc8),
      occurredAt: "2026-10-28T11:30:00.000Z",
      eventType: "ProjectDeletionRequestedV1",
      cleanupRunId: newUlid(),
      expectedProjectVersion: 1,
      expectedEtag,
      confirmation: {
        organizationId: issued.organizationId,
        projectId: issued.projectId,
        issuedToPrincipalId: issued.issuedToPrincipalId,
        action: issued.action,
        subjectEtag: issued.subjectEtag,
        tokenDigest: issued.tokenDigest,
        consumedAt: "2026-10-28T11:25:00.000Z",
      },
    };
    expect(await api.acceptApiProductOperation(accepted)).toMatchObject({
      operationId: accepted.operationId,
      state: "queued",
    });
    expect(
      await control.core
        .prepare("SELECT state FROM cleanup_runs WHERE cleanup_run_id=?1")
        .bind(accepted.cleanupRunId)
        .first(),
    ).toEqual({ state: "pending" });
  } finally {
    await control.dispose();
  }
}, 60_000);
