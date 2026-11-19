import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAcceptedApiProductOperation } from "../../src/catalog/product-api/accepted-operation.js";
import { newUlid } from "../../src/catalog/common.js";
import { seedAcceptedOperation, deploymentIntent } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  acceptance,
  createPlan,
  linkSource,
  productRig,
  publishedRevision,
} from "../support/product-api-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
});
afterAll(async () => control.dispose());

const one = async (sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .first<Record<string, unknown>>();

describe("productApi reads", () => {
  it("reads the scope, deployments, project projection and status of a published project", async () => {
    const rig = await productRig(control),
      { sourceConnectionId } = await linkSource(rig),
      plan = await createPlan(rig, sourceConnectionId),
      published = await publishedRevision(rig, rig.devEnvironmentId),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    const request = acceptance(rig, rig.devEnvironmentId, {
      eventType: "DeploymentRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/deployments",
      planId: plan.planId,
      planDigest: plan.planDigest,
      deploymentId: newUlid(),
    });
    const accepted = await api.acceptApiProductOperation(request);

    expect(await api.readApiProductScope(scope)).toEqual({
      ...scope,
      environmentId: rig.devEnvironmentId,
      billingEpochId: rig.billingEpochId,
      lifecycleVersion: 1,
      headVersion: 1,
    });
    expect(await api.readApiProductScope({ ...scope, environmentName: "prod" })).toMatchObject({
      environmentId: rig.prodEnvironmentId,
      headVersion: 0,
    });
    expect(await api.readApiProductScope({ ...scope, projectId: newUlid() })).toBeNull();

    const head = await api.readApiProductDeployment({
      ...scope,
      deploymentId: published.deploymentId,
    });
    expect(head).toMatchObject({
      deploymentId: published.deploymentId,
      environmentId: rig.devEnvironmentId,
      status: "succeeded",
      kind: "deploy",
      deploymentUrl: `https://dev-${rig.handle}.check.omh.st`,
      activeVersion: 1,
      isEnvironmentHead: true,
      environmentHeadVersion: 1,
      mailRequired: false,
    });
    expect(head?.artifactDigest?.byteLength).toBe(32);
    expect(
      await api.readApiProductDeployment({ ...scope, deploymentId: request.deploymentId }),
    ).toMatchObject({
      operationId: request.operationId,
      status: "queued",
      artifactDigest: null,
      deploymentUrl: null,
      isEnvironmentHead: false,
    });
    expect(await api.readApiProductDeployment({ ...scope, deploymentId: newUlid() })).toBeNull();

    const first = await api.readApiProductDeployments({ ...scope, limit: 1 });
    expect(first).toMatchObject({
      items: [{ deploymentId: request.deploymentId }],
      nextCursor: request.deploymentId,
    });
    expect(
      await api.readApiProductDeployments({ ...scope, limit: 5, cursor: first?.nextCursor }),
    ).toMatchObject({ items: [{ deploymentId: published.deploymentId }], nextCursor: null });
    expect(
      await api.readApiProductDeployments({ ...scope, projectId: newUlid(), limit: 5 }),
    ).toBeNull();

    const project = await api.readApiProductProject(scope);
    // Already deployed Control callers may retain their private selector during the forward rollout.
    expect(await api.readApiProductProject({ ...scope, paidDevView: true })).toEqual(project);
    expect(project).toMatchObject({
      project_id: rig.projectId,
      handle: rig.handle,
      region: "eu",
      lifecycle_state: "active",
      default_environment: { name: "dev", active_deployment_id: published.deploymentId },
      environments: [
        { id: rig.devEnvironmentId, name: "dev" },
        { id: rig.prodEnvironmentId, name: "prod" },
      ],
      source: { provider: "github", state: "ready", source_connection_id: sourceConnectionId },
      gateway_evidence: {
        dev: { runtime_provider: "wfp", public_origin: `https://dev-${rig.handle}.check.omh.st` },
        prod: null,
      },
    });
    expect(await api.readApiProductProject({ ...scope, projectId: newUlid() })).toBeNull();

    const status = await api.readApiProductStatus(scope);
    expect(await api.readApiProductStatus({ ...scope, paidDevView: true })).toEqual(status);
    expect(status).toMatchObject({
      projection: project,
      headDeployment: { deploymentId: published.deploymentId },
      latestOperation: {
        operation_id: accepted.operationId,
        state: "queued",
        failure_code: null,
        blockingOperationId: null,
        reconciliation: null,
      },
    });
    expect(status?.cleanupState).toBeUndefined();
    expect(await api.readApiProductStatus({ ...scope, projectId: newUlid() })).toBeNull();
    expect(status?.customDomains).toEqual([]);
    const foreign = await productRig(control);
    for (const owner of [rig, foreign])
      await control.core
        .prepare(
          "INSERT INTO paid_project_domains(organization_id,project_id,hostname,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at) VALUES(?1,?2,?3,'awaiting_deployment','user:owner',zeroblob(32),zeroblob(32),?4,?4)",
        )
        .bind(
          owner.organizationId,
          owner.projectId,
          `${owner.handle}.example.com`,
          "2026-10-28T11:00:00.000000Z",
        )
        .run();
    expect((await api.readApiProductStatus(scope))?.customDomains).toEqual([
      { hostname: `${rig.handle}.example.com`, environment: "prod", state: "awaiting_deployment" },
    ]);
    expect(
      await foreign.store.productApi.readApiProductStatus({
        organizationId: foreign.organizationId,
        projectId: rig.projectId,
      }),
    ).toBeNull();

    // The queued deployment waits for the operation that holds the project's provider claim ...
    const holder = await seedAcceptedOperation(rig, rig.devEnvironmentId);
    expect((await api.readApiProductStatus(scope))?.latestOperation?.blockingOperationId).toBe(
      holder.operationId,
    );
    // ... and reports the reconciliation its Workflow run requires.
    await control.core
      .prepare(
        "INSERT INTO product_workflow_runs(organization_id,operation_id,event_type,workflow_id,event_id,project_id,environment_id,billing_epoch_id,state,created_at,updated_at) VALUES(?1,?2,'DeploymentRequestedV1',?3,?4,?5,?6,?7,'reconciliation_required','2026-10-28T11:31:00.000000Z','2026-10-28T11:32:00.000000Z')",
      )
      .bind(
        rig.organizationId,
        request.operationId,
        newUlid(),
        request.outboxEventId,
        rig.projectId,
        rig.devEnvironmentId,
        rig.billingEpochId,
      )
      .run();
    expect((await api.readApiProductStatus(scope))?.latestOperation?.reconciliation).toEqual({
      state: "required",
      attempt_id: null,
      observed_at: "2026-10-28T11:32:00.000Z",
    });
  }, 30_000);

  it("reads the planning source, the deployment plan and the rename admission", async () => {
    const rig = await productRig(control),
      { sourceConnectionId, grantId } = await linkSource(rig),
      plan = await createPlan(rig, sourceConnectionId),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };

    expect(await api.readApiPlanningSource(scope)).toMatchObject({
      ...scope,
      environmentId: rig.devEnvironmentId,
      billingEpochId: rig.billingEpochId,
      lifecycleVersion: 1,
      headVersion: 0,
      sourceConnectionId,
      grantId,
      provider: "github",
      installationId: "7",
      repositoryOwner: "o",
      repositoryName: "r",
      revoked: false,
      sourceGeneration: 1,
      projectHandle: rig.handle,
      region: "eu",
      storageJurisdiction: "eu",
      environmentName: "dev",
      dataMode: "shared",
    });
    expect(await api.readApiPlanningSource({ ...scope, sourceConnectionId: newUlid() })).toBeNull();

    expect(
      await api.readApiDeploymentPlan({ ...scope, planId: plan.planId, readAt: plan.createdAt }),
    ).toMatchObject({
      planId: plan.planId,
      sourceConnectionId,
      environmentId: rig.devEnvironmentId,
      commitSha: plan.commitSha,
      runtime: plan.runtime,
      sourceGeneration: 1,
      expiresAt: "2026-10-29T11:00:00.000Z",
    });
    expect(
      await api.readApiDeploymentPlan({
        ...scope,
        planId: plan.planId,
        readAt: "2026-10-30T00:00:00.000Z",
      }),
    ).toBeNull();

    // A free handle, a handle another project owns, and a project with an operation in flight.
    const free = {
      environmentId: rig.devEnvironmentId,
      billingEpochId: rig.billingEpochId,
      lifecycleVersion: 1,
      handle: rig.handle,
      busy: false,
      nativeRecoveryPending: false,
      nativePreparationPending: false,
      taken: false,
    };
    expect(await api.readApiRenameAdmission({ ...scope, handle: "fresh-name" })).toEqual(free);
    const other = await productRig(control);
    expect(
      await other.store.productApi.readApiRenameAdmission({
        organizationId: other.organizationId,
        projectId: other.projectId,
        handle: rig.handle,
      }),
    ).toMatchObject({ taken: true, busy: false });
    await seedAcceptedOperation(rig, rig.devEnvironmentId, { claim: false });
    expect(await api.readApiRenameAdmission({ ...scope, handle: "fresh-name" })).toEqual({
      ...free,
      busy: true,
    });
  }, 30_000);

  it("replays an accepted operation by its receipt and reads its history, failure and diagnostic", async () => {
    const rig = await productRig(control),
      api = rig.store.productApi,
      request = acceptance(rig, rig.devEnvironmentId, {
        eventType: "SourceLinkRequestedV1",
        routeTemplate: "/v1/projects/{project_id}/source",
        installationId: "7",
        repositoryOwner: "o",
        repositoryName: "r",
      }),
      receipt = {
        organizationId: rig.organizationId,
        principalId: rig.principalId,
        httpMethod: request.httpMethod,
        routeTemplate: request.routeTemplate,
        idempotencyKey: request.idempotencyKey,
        canonicalRequestDigest: request.canonicalRequestDigest,
      };
    expect(await api.readApiProductReplay(receipt)).toBeNull();
    const accepted = await api.acceptApiProductOperation(request);
    expect(await api.readApiProductReplay(receipt)).toEqual(accepted);
    await expect(
      api.readApiProductReplay({
        ...receipt,
        canonicalRequestDigest: new Uint8Array(32).fill(250),
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(
      await readAcceptedApiProductOperation(control.core, rig.organizationId, request.operationId),
    ).toEqual(accepted);
    expect(
      await readAcceptedApiProductOperation(control.core, rig.organizationId, newUlid()),
    ).toBeNull();

    // The operation fails; its failure code is public, its conversion diagnostic is parsed from the stored failure.
    const transition = (type: string, state: string, count: number, failure?: object) =>
      rig.store.operations.transitionOperation({
        organizationId: rig.organizationId,
        operationId: request.operationId,
        expected: { state, eventCount: count },
        event: {
          eventId: newUlid(),
          type,
          idempotencyKey: `${type}-replay`,
          occurredAt: "2026-10-28T11:40:00.000Z",
          ...(failure === undefined ? {} : { failure }),
        },
        audit: {
          auditEventId: newUlid(),
          projectId: rig.projectId,
          operationId: request.operationId,
          eventType: type,
          actorType: "system",
          actorId: "workflow",
          payload: {},
          occurredAt: "2026-10-28T11:40:00.000Z",
        },
      });
    await transition("OperationStarted", "queued", 1);
    const failure = {
      code: "FRAMEWORK_CONVERSION_REQUIRED",
      message: "The exact source requires conversion.",
    };
    await transition("OperationFailed", "running", 2, failure);
    expect(await api.readApiProductReplay(receipt)).toMatchObject({
      state: "failed",
      failure: { code: failure.code },
      failureDiagnostic: null,
    });
    const diagnostic = { code: "package_manifest_invalid", path: "package.json" };
    await control.core
      .prepare("UPDATE operations SET failure=?3 WHERE organization_id=?1 AND operation_id=?2")
      .bind(rig.organizationId, request.operationId, JSON.stringify({ ...failure, diagnostic }))
      .run();
    expect(await api.readApiProductReplay(receipt)).toMatchObject({
      state: "failed",
      failure: { code: failure.code },
      failureDiagnostic: diagnostic,
    });
    expect(
      await one(
        "SELECT count(*) n FROM operation_events WHERE operation_id=?",
        request.operationId,
      ),
    ).toEqual({ n: 3 });
  }, 30_000);

  it("stops offering a rollback target once a maintenance run removed its script", async () => {
    const rig = await productRig(control),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    await linkSource(rig);
    const published = await publishedRevision(rig, rig.devEnvironmentId),
      target = { ...scope, deploymentId: published.deploymentId };
    expect(await api.readApiRollbackTarget({ ...scope, deploymentId: newUlid() })).toBeNull();
    expect(await api.readApiRollbackTarget(target)).toMatchObject({
      revisionId: published.revisionId,
    });

    // A binding-refresh run that replaced the target's candidate script and recorded its absence.
    const maintenance = await seedAcceptedOperation(rig, rig.devEnvironmentId, {
      claim: false,
      intent: async (operationId) => {
        const intent = await deploymentIntent(rig, operationId, rig.devEnvironmentId, {
          refresh: true,
        });
        return {
          ...intent,
          binding_refresh_snapshot: JSON.stringify({
            ...JSON.parse(String(intent.binding_refresh_snapshot)),
            sourceCandidateReceiptId: published.candidateReceiptId,
          }),
        };
      },
    });
    const script = await one(
      "SELECT dispatch_namespace||'/'||immutable_script_name locator FROM wfp_candidate_receipts WHERE candidate_receipt_id=?",
      published.candidateReceiptId,
    );
    const hash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`cloudflare\0wfp-script\0${String(script?.["locator"])}`),
      ),
    );
    await control.core
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',?5,'2026-10-28T11:00:00.000000Z','script')",
      )
      .bind(rig.organizationId, newUlid(), rig.projectId, maintenance.operationId, hash)
      .run();
    // Recorded for removal but not yet removed: still a target.
    expect(await api.readApiRollbackTarget(target)).not.toBeNull();
    await control.core
      .prepare(
        "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,error_code,attempted_at) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',?5,'removed',NULL,'2026-10-28T11:10:00.000000Z')",
      )
      .bind(newUlid(), rig.organizationId, rig.projectId, maintenance.operationId, hash)
      .run();
    expect(await api.readApiRollbackTarget(target)).toBeNull();
  }, 30_000);

  it("stops offering a rollback target once a data change removed its Dev script", async () => {
    const rig = await productRig(control),
      api = rig.store.productApi,
      scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    await linkSource(rig);
    const published = await publishedRevision(rig, rig.devEnvironmentId),
      target = { ...scope, deploymentId: published.deploymentId };
    expect(await api.readApiRollbackTarget(target)).not.toBeNull();

    // A Dev reset removes the candidate script under its own data-change operation, whose intent carries no
    // binding refresh snapshot naming the candidate.
    const change = await seedAcceptedOperation(rig, rig.devEnvironmentId, {
      claim: false,
      eventType: "ProjectDataChangeRequestedV1",
    });
    const script = await one(
      "SELECT dispatch_namespace||'/'||immutable_script_name locator FROM wfp_candidate_receipts WHERE candidate_receipt_id=?",
      published.candidateReceiptId,
    );
    const hash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`cloudflare\0wfp-script\0${String(script?.["locator"])}`),
      ),
    );
    await control.core
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',?5,'2026-10-28T11:00:00.000000Z','script')",
      )
      .bind(rig.organizationId, newUlid(), rig.projectId, change.operationId, hash)
      .run();
    await control.core
      .prepare(
        "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,error_code,attempted_at) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',?5,'removed',NULL,'2026-10-28T11:10:00.000000Z')",
      )
      .bind(newUlid(), rig.organizationId, rig.projectId, change.operationId, hash)
      .run();
    expect(await api.readApiRollbackTarget(target)).toBeNull();
  }, 30_000);
});
