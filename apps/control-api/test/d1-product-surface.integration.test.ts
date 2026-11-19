import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DeploymentMailDomainRequiredError,
  DeploymentPersistenceConflictError,
  OrganizationCreditError,
  ProjectDomainDeletionRequiredError,
  ProjectR2BucketConflictError,
} from "@ohmyhost/database";
import { createUlidFactory, parseUlid, SystemEntropy } from "@ohmyhost/platform";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import {
  seedProject,
  STORED_NOW,
  type SeededProject,
} from "../../control-store/test/support/platform-fixtures.js";
import {
  releaseProviderClaim,
  seedPublishedClaim,
} from "../../control-store/test/support/accepted-operation.js";
import {
  seedWfpPublication,
  sourceFrameworkPlan,
} from "../../control-store/test/support/provider-fixtures.js";
import { IdempotencyKeyReusedError, ProductSurfaceConflictError } from "../src/contracts.js";
import {
  createD1ProductSurfaceDataPort,
  createD1ProductSurfacePort,
  isD1ProductSurfaceRuntime,
  productCoreCall,
  type D1ProductSurfaceRuntime,
} from "../src/d1-product-surface.js";

const NOW = "2026-10-28T11:00:00.000Z";
const PRINCIPAL = "user:user_surface";
const bytes = (fill: number) => new Uint8Array(32).fill(fill);
const ulid = () => parseUlid(newUlid());

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
let runtime: D1ProductSurfaceRuntime;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
  runtime = store.productApi as unknown as D1ProductSurfaceRuntime;
});
afterAll(async () => control.dispose());

/** A project whose Dev environment runs one published deployment of a GitHub source (the grant binds it), with its data area assigned. */
let sequence = 0;
async function deployedProject() {
  const project = await seedProject(control, { handle: `calm-otter-surface-${++sequence}` }),
    db = control.core;
  const { published } = await seedPublishedClaim(project, project.devEnvironmentId, (operationId) =>
    seedWfpPublication(project, { operationId, environmentId: project.devEnvironmentId }),
  );
  await releaseProviderClaim(project);
  const plan = await db
    .prepare("SELECT source_connection_id FROM deployment_plans WHERE plan_id=?")
    .bind(published.planId)
    .first<{ source_connection_id: string }>();
  const grant = await db
    .prepare("SELECT grant_id FROM repository_grants WHERE source_connection_id=?")
    .bind(plan?.source_connection_id)
    .first<{ grant_id: string }>();
  if (plan === null || grant === null) throw new Error("fixture plan is missing its source");
  const sourceConnectionId = plan.source_connection_id;
  await db.batch([
    db
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(project.organizationId, project.projectId, project.devEnvironmentId, STORED_NOW),
    ...[project.devEnvironmentId, project.prodEnvironmentId].map((environmentId) =>
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,assignment_version,data_environment_id,assigned_at) VALUES(?1,?2,?3,1,?4,?5)",
        )
        .bind(
          project.organizationId,
          project.projectId,
          environmentId,
          project.devEnvironmentId,
          STORED_NOW,
        ),
    ),
    db
      .prepare(
        "INSERT INTO project_sources(organization_id,project_id,source_id,billing_epoch_id,grant_id,provider,installation_id,external_repository_id,repository_owner,repository_name,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'github','7','42','o','r','ready',1,?6,?6)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        newUlid(),
        project.billingEpochId,
        grant.grant_id,
        STORED_NOW,
      ),
  ]);
  return { project, published, sourceConnectionId };
}
const scopeOf = (project: SeededProject) => ({
  organizationId: parseUlid(project.organizationId),
  projectId: parseUlid(project.projectId),
});

describe("D1 product surface data port over the real Core", () => {
  it("reads status, project, source, plans, deployments and every action target of a deployed project and refuses a foreign Core answer", async () => {
    const { project, published, sourceConnectionId } = await deployedProject(),
      scope = scopeOf(project),
      port = createD1ProductSurfaceDataPort(runtime);
    expect(isD1ProductSurfaceRuntime(runtime)).toBe(true);
    expect(() => createD1ProductSurfaceDataPort({} as never)).toThrow(
      "product_core_binding_required",
    );

    const status = await port.readProjectStatus({ ...scope, principalId: PRINCIPAL } as never);
    expect(status).toMatchObject({
      projection: { project_id: project.projectId, handle: project.handle },
      headDeployment: {
        deploymentId: published.deploymentId,
        status: "succeeded",
        kind: "deploy",
        isEnvironmentHead: true,
        activeVersion: 1,
      },
      latestOperation: { state: "succeeded", blockingOperationId: null, reconciliation: null },
    });
    expect(await port.readProductProject(() => scope as never)).toMatchObject({
      project_id: project.projectId,
      region: "eu",
      source: { repository_owner: "o", repository_name: "r" },
    });
    expect(await port.readScope(scope as never)).toMatchObject({
      environmentId: project.devEnvironmentId,
      billingEpochId: project.billingEpochId,
      lifecycleVersion: 1,
      headVersion: 1,
    });
    expect(await port.readPlanningSource({ ...scope, sourceConnectionId } as never)).toMatchObject({
      sourceConnectionId,
      provider: "github",
      repositoryOwner: "o",
      repositoryName: "r",
      sourceGeneration: 1,
      projectHandle: project.handle,
      region: "eu",
      storageJurisdiction: "eu",
      environmentName: "dev",
      dataMode: "shared",
      revoked: false,
    });
    expect(
      await port.readPlanningSource({ ...scope, sourceConnectionId: ulid() } as never),
    ).toBeNull();

    const planRead = { ...scope, planId: published.planId, readAt: NOW };
    expect(await port.readDeploymentPlan(() => planRead as never)).toMatchObject({
      planId: published.planId,
      sourceConnectionId,
      environmentId: project.devEnvironmentId,
      sourceGeneration: 1,
      runtime: "cloudflare_workers_edge_ssr",
      applicationRoot: ".",
    });
    expect(
      await port.readDeploymentPlan(
        () => ({ ...planRead, readAt: "2026-10-30T00:00:00.000Z" }) as never,
      ),
    ).toBeNull();

    const deployment = await port.readProductDeployment(
      () => ({ ...scope, deploymentId: published.deploymentId }) as never,
    );
    expect(deployment).toMatchObject({
      deploymentId: published.deploymentId,
      environmentId: project.devEnvironmentId,
      status: "succeeded",
      isEnvironmentHead: true,
      environmentHeadVersion: 1,
    });
    expect(deployment?.sourceDigest.byteLength).toBe(32);
    expect(
      await port.readProductDeployment(() => ({ ...scope, deploymentId: ulid() }) as never),
    ).toBeNull();
    expect(await port.readProductDeployments(() => ({ ...scope, limit: 10 }) as never)).toEqual({
      items: [deployment],
      nextCursor: null,
    });

    expect(await port.readPromotionEnvironments(scope as never)).toEqual({
      sourceEnvironmentId: project.devEnvironmentId,
      targetEnvironmentId: project.prodEnvironmentId,
    });
    expect(
      await port.readPromotionPlanTarget(
        () =>
          ({
            ...scope,
            sourceEnvironmentId: project.devEnvironmentId,
            targetEnvironmentId: project.prodEnvironmentId,
          }) as never,
      ),
    ).toMatchObject({
      dataMode: "shared",
      databaseEnabled: false,
      billingEpochId: project.billingEpochId,
      sourceDeploymentId: published.deploymentId,
      sourceRevisionId: published.revisionId,
      sourceArtifactId: published.artifactId,
      expectedSourceHeadVersion: 1,
      expectedTargetHeadVersion: 0,
    });
    expect(await port.readDeletePlanTarget(() => scope as never)).toEqual({
      expectedProjectVersion: 1,
      expectedEtag: `project:${project.projectId}:v1`,
      managedRepositoryCount: 0,
      stagedSourceObjectCount: 0,
    });
    expect(
      await port.readProjectRenameAdmission(() => ({ ...scope, handle: "free-name" }) as never),
    ).toMatchObject({
      environmentId: project.devEnvironmentId,
      lifecycleVersion: 1,
      handle: project.handle,
      busy: false,
      taken: false,
    });
    const other = await deployedProject();
    expect(
      await port.readProjectRenameAdmission(
        () => ({ ...scope, handle: other.project.handle }) as never,
      ),
    ).toMatchObject({ taken: true });
    expect(await port.readProjectDeletionAdmission(() => scope as never)).toMatchObject({
      environmentId: project.devEnvironmentId,
      expectedProjectVersion: 1,
      lifecycleState: "active",
      previousOperationId: null,
    });
    expect(
      await port.readRollbackTargetForDeployment({
        ...scope,
        deploymentId: published.deploymentId,
      } as never),
    ).toMatchObject({
      deploymentId: published.deploymentId,
      environmentId: project.devEnvironmentId,
      revisionId: published.revisionId,
      artifactId: published.artifactId,
      expectedHeadVersion: 1,
      dataEnvironmentId: project.devEnvironmentId,
      assignmentVersion: 1,
      registrationVersion: 0,
      dataChanged: false,
      dataChangeInProgress: false,
    });

    // Another project's data never answers for this one: every read stays inside its own scope.
    const foreign = scopeOf(other.project);
    expect(
      await port.readProjectStatus({ ...foreign, principalId: PRINCIPAL } as never),
    ).not.toEqual(status);
    expect(
      await port.readProductDeployment(
        () => ({ ...foreign, deploymentId: published.deploymentId }) as never,
      ),
    ).toBeNull();
    const crossed = createD1ProductSurfaceDataPort({
      ...runtime,
      readApiProductStatus: () => runtime.readApiProductStatus(foreign),
      readApiProductProject: () => runtime.readApiProductProject(foreign),
      readApiProductScope: () => runtime.readApiProductScope(foreign),
      readApiPlanningSource: () => runtime.readApiPlanningSource(foreign),
      readApiDeploymentPlan: () =>
        runtime.readApiDeploymentPlan({ ...foreign, planId: other.published.planId, readAt: NOW }),
      readApiProductDeployment: () =>
        runtime.readApiProductDeployment({
          ...foreign,
          deploymentId: other.published.deploymentId,
        }),
      readApiProductDeployments: () => runtime.readApiProductDeployments({ ...foreign, limit: 10 }),
      readApiPromotionTarget: () =>
        runtime.readApiPromotionTarget({
          ...foreign,
          sourceEnvironmentId: other.project.devEnvironmentId,
          targetEnvironmentId: other.project.prodEnvironmentId,
        }),
      readApiRollbackTarget: () =>
        runtime.readApiRollbackTarget({ ...foreign, deploymentId: other.published.deploymentId }),
    } as D1ProductSurfaceRuntime);
    const truncated = createD1ProductSurfaceDataPort({
      ...runtime,
      readApiProductDeployment: async (input: unknown) => ({
        ...((await runtime.readApiProductDeployment(input)) as object),
        sourceDigest: new Uint8Array(31),
      }),
    } as D1ProductSurfaceRuntime);
    await expect(
      truncated.readProductDeployment(
        () => ({ ...scope, deploymentId: published.deploymentId }) as never,
      ),
    ).rejects.toThrow("Product digest is invalid");
    const refused = "product_core_response_scope_invalid";
    await expect(crossed.readProjectStatus(scope as never)).rejects.toThrow(refused);
    await expect(crossed.readProductProject(() => scope as never)).rejects.toThrow(refused);
    await expect(crossed.readScope(scope as never)).rejects.toThrow(refused);
    await expect(
      crossed.readPlanningSource({ ...scope, sourceConnectionId } as never),
    ).rejects.toThrow(refused);
    const wrongEnvironment = createD1ProductSurfaceDataPort({
      ...runtime,
      readApiPlanningSource: () =>
        runtime.readApiPlanningSource({ ...scope, environmentName: "dev" }),
    } as D1ProductSurfaceRuntime);
    await expect(
      wrongEnvironment.readPlanningSource({ ...scope, environmentName: "prod" } as never),
    ).rejects.toThrow(refused);
    await expect(crossed.readDeploymentPlan(() => planRead as never)).rejects.toThrow(refused);
    await expect(
      crossed.readProductDeployment(
        () => ({ ...scope, deploymentId: published.deploymentId }) as never,
      ),
    ).rejects.toThrow(refused);
    await expect(
      crossed.readProductDeployments(() => ({ ...scope, limit: 10 }) as never),
    ).rejects.toThrow(refused);
    await expect(
      crossed.readPromotionPlanTarget(
        () =>
          ({
            ...scope,
            sourceEnvironmentId: project.devEnvironmentId,
            targetEnvironmentId: project.prodEnvironmentId,
          }) as never,
      ),
    ).rejects.toThrow(refused);
    await expect(
      crossed.readRollbackTargetForDeployment({
        ...scope,
        deploymentId: published.deploymentId,
      } as never),
    ).rejects.toThrow(refused);
  });

  it("issues confirmations, plans, auto-deploy configuration and accepted operations idempotently and refuses conflicting repeats", async () => {
    const { project, sourceConnectionId } = await deployedProject(),
      scope = scopeOf(project),
      port = createD1ProductSurfaceDataPort(runtime);

    const confirmation = {
      confirmationId: ulid(),
      ...scope,
      issuedToPrincipalId: PRINCIPAL,
      action: "delete" as const,
      subjectEtag: `project:${project.projectId}:v1`,
      tokenDigest: bytes(5),
      issuedAt: NOW,
    };
    expect(await port.issueActionConfirmation(() => confirmation as never)).toBe("created");
    expect(await port.issueActionConfirmation(() => confirmation as never)).toBe("existing");
    await expect(
      port.issueActionConfirmation(() => ({ ...confirmation, subjectEtag: "other" }) as never),
    ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);
    const usable = {
      ...scope,
      principalId: PRINCIPAL,
      action: "delete" as const,
      subjectEtag: confirmation.subjectEtag,
      tokenDigest: confirmation.tokenDigest,
      now: NOW,
    };
    await expect(port.requireUsableConfirmation(usable as never)).resolves.toBeUndefined();
    await expect(
      port.requireUsableConfirmation({ ...usable, tokenDigest: bytes(6) } as never),
    ).rejects.toMatchObject({ reason: "confirmation_invalid" });
    await expect(
      port.requireUsableConfirmation({ ...usable, now: "2026-10-28T11:30:00.000Z" } as never),
    ).rejects.toMatchObject({ reason: "confirmation_expired" });

    const plan = {
      planId: ulid(),
      ...scope,
      environmentId: parseUlid(project.devEnvironmentId),
      sourceConnectionId: parseUlid(sourceConnectionId),
      sourceGeneration: 1,
      commitSha: "c".repeat(40),
      sourceDigest: bytes(1),
      buildPlanDigest: bytes(2),
      planDigest: bytes(3),
      runtime: "cloudflare_workers_edge_ssr",
      frameworkPlan: sourceFrameworkPlan(false),
      impacts: [] as string[],
      risks: [] as string[],
      costEstimate: {},
      createdAt: NOW,
    };
    expect(await port.createDeploymentPlan(() => plan as never)).toBe("created");
    expect(await port.createDeploymentPlan(() => plan as never)).toBe("existing");
    await expect(
      port.createDeploymentPlan(() => ({ ...plan, commitSha: "d".repeat(40) }) as never),
    ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);
    expect(
      await port.readDeploymentPlan(
        () => ({ ...scope, planId: plan.planId, readAt: NOW }) as never,
      ),
    ).toMatchObject({ planId: plan.planId, commitSha: plan.commitSha });

    expect(await port.readGithubAutoDeployConfig(() => scope as never)).toBeNull();
    const configure = {
      ...scope,
      principalId: PRINCIPAL,
      requestId: "req-auto-deploy",
      idempotencyKey: "auto-deploy-1",
      canonicalRequestDigest: bytes(9),
      operationId: ulid(),
      queuedEventId: ulid(),
      succeededEventId: ulid(),
      auditEventId: ulid(),
      branchRef: "refs/heads/main",
      enabled: true,
      configuredAt: NOW,
    };
    const configured = await port.configureGithubAutoDeployIdempotently(() => configure as never);
    expect(configured).toMatchObject({
      sourceConnectionId,
      branchRef: "refs/heads/main",
      generation: 1,
      enabled: true,
      grantActive: true,
    });
    expect(await port.configureGithubAutoDeployIdempotently(() => configure as never)).toEqual(
      configured,
    );
    expect(await port.readGithubAutoDeployConfig(() => scope as never)).toEqual(configured);
    await expect(
      port.configureGithubAutoDeployIdempotently(
        () => ({ ...configure, canonicalRequestDigest: bytes(10) }) as never,
      ),
    ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);

    const route = "/v1/projects/{project_id}/source:link",
      request = {
        ...scope,
        principalId: PRINCIPAL,
        requestId: "req-link",
        idempotencyKey: "link-1",
        canonicalRequestDigest: bytes(11),
      };
    expect(await port.replayAcceptedOperation(request as never, "POST", route)).toBeNull();
    const accepted = await port.acceptProductOperation(
      () =>
        ({
          ...request,
          environmentId: project.devEnvironmentId,
          billingEpochId: project.billingEpochId,
          operationId: ulid(),
          operationEventId: ulid(),
          auditEventId: ulid(),
          outboxEventId: ulid(),
          httpMethod: "POST",
          routeTemplate: route,
          eventType: "SourceLinkRequestedV1",
          installationId: "7",
          repositoryOwner: "o",
          repositoryName: "r",
          occurredAt: NOW,
        }) as never,
      "SourceLinkRequestedV1",
    );
    expect(accepted).toMatchObject({ state: "queued" });
    expect(await port.replayAcceptedOperation(request as never, "POST", route)).toMatchObject({
      status: 202,
      body: { id: accepted.operationId, state: "queued" },
    });
    await expect(
      port.replayAcceptedOperation(
        { ...request, canonicalRequestDigest: bytes(12) } as never,
        "POST",
        route,
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it("serves the customer-facing product port from the same Core and maps closed refusal codes of an RPC error", async () => {
    const { project, published } = await deployedProject(),
      surface = createD1ProductSurfacePort({
        runtime,
        clock: { now: () => new Date(NOW) },
        ids: createUlidFactory({
          clock: { now: () => new Date(NOW) },
          entropy: new SystemEntropy(),
        }),
        sourceInspector: {} as never,
        dataChanges: {} as never,
      }),
      context = { ...scopeOf(project), principalId: PRINCIPAL, requestId: "req-surface" };
    expect(await surface.getProjectStatus(context as never)).toMatchObject({
      status: 200,
      body: {
        project_id: project.projectId,
        handle: project.handle,
        head_deployment: { id: published.deploymentId, status: "active" },
      },
    });
    expect(
      await surface.getDeployment({ ...context, deploymentId: published.deploymentId } as never),
    ).toMatchObject({ status: 200, body: { id: published.deploymentId } });

    const rpc = (code: string) => () =>
      productCoreCall(async () => {
        throw Object.assign(new Error("Remote error"), { code });
      });
    await expect(rpc("idempotency_key_reused")()).rejects.toBeInstanceOf(
      DeploymentPersistenceConflictError,
    );
    await expect(rpc("deployment_persistence_conflict")()).rejects.toBeInstanceOf(
      DeploymentPersistenceConflictError,
    );
    await expect(rpc("mail_domain_required")()).rejects.toBeInstanceOf(
      DeploymentMailDomainRequiredError,
    );
    await expect(rpc("project_domain_delete_required")()).rejects.toBeInstanceOf(
      ProjectDomainDeletionRequiredError,
    );
    await expect(rpc("project_r2_bucket_conflict")()).rejects.toBeInstanceOf(
      ProjectR2BucketConflictError,
    );
    await expect(rpc("data_change_in_progress")()).rejects.toBeInstanceOf(
      ProductSurfaceConflictError,
    );
    await expect(rpc("native_domain_sync_pending")()).rejects.toMatchObject({
      reason: "native_domain_sync_pending",
    });
    await expect(rpc("paid_plan_required")()).rejects.toBeInstanceOf(OrganizationCreditError);
    await expect(
      productCoreCall(async () => {
        throw new Error("rollback_target_data_changed");
      }),
    ).rejects.toMatchObject({ reason: "rollback_target_data_changed" });
    // A change that is still running, or a provider cutover, is a retryable conflict with its own reason.
    await expect(rpc("cutover_pending")()).rejects.toMatchObject({ reason: "cutover_pending" });
    await expect(rpc("project_operation_in_progress")()).rejects.toMatchObject({
      reason: "project_operation_in_progress",
    });
    await expect(rpc("unrelated")()).rejects.toThrow("Remote error");
  });
});
