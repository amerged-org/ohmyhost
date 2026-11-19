import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  planProjectDataChangeTransition,
  type ProjectDataAssignments,
} from "../../../../packages/database/src/project-data-environments.js";
import { readProductWorkflowContext } from "../../src/catalog/provisioning/context.js";
import { SharedCoreRouter, bucketOf } from "../../src/router.js";
import { createContextRpcControl } from "./context-rpc.fixture.js";
import { createTestControl } from "../support/control-d1.js";
import { contextGatewayFixture as gatewayFixture } from "./context-gateway.fixture.js";
import {
  seedContextData,
  insertContext,
  updateContext,
  type ContextFixture,
  beforeContextSnapshot,
} from "./context-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { NOW, STORED_NOW } from "../support/platform-fixtures.js";
import {
  parseProjectBindingRefreshSnapshot,
  parseProjectDataChangeSnapshot,
} from "../../src/catalog/provisioning/context-snapshots.js";

type Fixture = Awaited<ReturnType<typeof gatewayFixture>>;
type Environment = { id: string; name: "dev" | "prod" };
const DIGEST_03 = `sha256:${"03".repeat(32)}`;
const FRAMEWORK_PLAN = {
  schemaVersion: "ohmyhost.framework-plan/v5",
  applicationRoot: ".",
  adapter: "nextjs",
  runtime: "edge",
  installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
  buildCommand: "pnpm run build",
  outputDirectory: ".open-next/assets",
  serverOutputDirectory: ".ohmyhost-worker",
  serverEntryPoint: ".ohmyhost-worker/worker.js",
  serverConfigPath: "wrangler.jsonc",
  compatibilityDate: "2026-10-12",
  compatibilityFlags: ["nodejs_compat"],
  runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
  database: { enabled: false },
  auth: { provider: "none" },
  mail: { enabled: false },
  storage: { enabled: false },
};

/** The deployed Workers-for-Platforms script of one product deployment, as the context reports it. */
function wfp(
  r: Fixture,
  deploymentId: string,
  providerTag: string,
  buildReused: boolean,
  environment: Environment = { id: r.project.prodEnvironmentId, name: "prod" },
) {
  return {
    provider: "cloudflare-wfp",
    namespace: "ohmyho-production",
    scriptName: `p-${r.project.projectId.toLowerCase()}-${environment.name}-${deploymentId.toLowerCase()}`,
    projectId: r.project.projectId,
    environmentId: environment.id,
    productDeploymentId: deploymentId,
    providerTag,
    artifactDigest: DIGEST_03,
    buildReused,
    deployedAt: NOW,
  };
}
const publishedWfp = (r: Fixture, environment?: Environment) =>
  wfp(r, r.published.deploymentId, "f".repeat(32), false, environment);
/** The immutable build output of the published deployment (its build ran in the previous operation). */
function buildArtifact(r: Fixture, environmentId = r.project.prodEnvironmentId) {
  const scope = {
    projectId: r.project.projectId,
    environmentId,
    operationId: r.previous.operationId,
  };
  return {
    receipt: { buildId: "exact-build", projectName: "fixture-build", scope },
    deploymentId: r.published.deploymentId,
    commitSha: "a".repeat(40),
    sourceSha256: "03".repeat(32),
    buildPlanSha256: "03".repeat(32),
    frameworkPlan: FRAMEWORK_PLAN,
    output: {
      bucket: "ohmyho-builds-production-eu",
      key: `runs/${r.project.projectId}/${environmentId}/${r.previous.operationId}/output/bundle.tar.gz`,
      versionId: "a".repeat(32),
      scope,
    },
  };
}
function activeGateway(r: Fixture) {
  const p = r.project;
  return {
    provider: "ohmyhost-shared-gateway",
    organizationId: p.organizationId,
    projectId: p.projectId,
    environmentId: p.prodEnvironmentId,
    environmentName: "prod",
    handle: p.handle,
    hostname: r.hostname,
    publicOrigin: `https://${r.hostname}`,
    targetDeploymentId: r.published.deploymentId,
    targetScriptName: publishedWfp(r).scriptName,
    targetArtifactDigest: DIGEST_03,
    targetProviderTag: "f".repeat(32),
    egressPolicyDigest: `sha256:${createHash("sha256").update("[]").digest("hex")}`,
    egressAllowedOrigins: [],
    candidateReceiptId: r.published.candidateReceiptId,
    revision: 1,
    predecessorRevision: null,
    operationId: r.previous.operationId,
    active: true,
    observedAt: NOW,
  };
}
/** The shared data identity every fixture project starts with: both environments use the dev one. */
function sharedAssignments(r: Fixture): ProjectDataAssignments {
  const p = r.project;
  return {
    dataMode: "shared",
    dev: {
      environmentId: p.devEnvironmentId,
      environment: "dev",
      dataEnvironmentId: p.devEnvironmentId,
      assignmentVersion: 1,
      assignedAt: "2026-09-01T00:00:00.000Z",
    },
    prod: {
      environmentId: p.prodEnvironmentId,
      environment: "prod",
      dataEnvironmentId: p.devEnvironmentId,
      assignmentVersion: 1,
      assignedAt: "2026-09-01T00:00:00.000Z",
    },
  };
}

it("reads the full accepted deployment context over real accepted deployment/publication facts", async () => {
  const control = await createContextRpcControl();
  try {
    const r = await gatewayFixture(control);
    await seedContextData(r);
    const p = r.project;
    const scope = { ...r.scope, operationId: r.accepted.operationId };
    const sourceConnectionId = must(
      await r.db
        .prepare("SELECT source_connection_id FROM deployment_plans WHERE plan_id=?")
        .bind(r.published.planId)
        .first<{ source_connection_id: string }>(),
    ).source_connection_id;
    const grant = must(
      await r.db
        .prepare("SELECT grant_id FROM repository_grants WHERE organization_id=? AND project_id=?")
        .bind(p.organizationId, p.projectId)
        .first<{ grant_id: string }>(),
    ).grant_id;
    const accepted = {
      handle: p.handle,
      environmentName: "prod",
      intent: {
        eventType: "DeploymentRequestedV1",
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.prodEnvironmentId,
        operationId: r.accepted.operationId,
        billingEpochId: p.billingEpochId,
        installationId: null,
        repositoryOwner: null,
        repositoryName: null,
        planId: r.published.planId,
        sourceConnectionId,
        sourceGeneration: 1,
        deploymentId: r.deploymentId,
        targetDeploymentId: null,
        targetRevisionId: null,
        targetArtifactId: null,
        expectedEtag: null,
        requestedHandle: null,
        cleanupRunId: null,
        sourceEnvironmentId: null,
        sourceDeploymentId: null,
        sourceRevisionId: null,
        sourceArtifactId: null,
        sourceArtifactDigest: null,
        expectedSourceHeadVersion: null,
        expectedTargetHeadVersion: null,
        commitSha: "a".repeat(40),
        sourceDigest: Buffer.alloc(32, 3),
        buildPlanDigest: Buffer.alloc(32, 3),
        providerVersionId: null,
        dataChange: null,
        dataChangeSnapshot: null,
        bindingRefreshSnapshot: null,
      },
      dataMode: "shared",
      region: "eu",
      projectLifecycleVersion: 1,
      headVersion: 1,
      sourceGrant: {
        sourceConnectionId,
        grantId: grant,
        provider: "github",
        installationId: "7",
        externalRepositoryId: "42",
        repositoryOwner: "o",
        repositoryName: "r",
        grantedAt: NOW,
        revoked: false,
        sourceGeneration: 1,
      },
      knownDeployments: [wfp(r, r.deploymentId, r.providerTag, true), publishedWfp(r)],
      rollbackArtifact: null,
      promotionArtifact: null,
      bindingRefreshArtifact: null,
      bindingRefreshPublished: false,
      bindingRefreshCompleted: false,
      promotionSourceDeployment: null,
      artifactExpectations: [buildArtifact(r)],
      activeDeploymentId: r.published.deploymentId,
      activeDeployment: publishedWfp(r),
      activeGateway: activeGateway(r),
      deletionEnvironments: [],
      deletionDataEnvironments: [],
      deletionInventory: [],
      environmentSecretCount: 0,
      acceptedAt: NOW,
      sourceArchives: [],
      frameworkPlan: FRAMEWORK_PLAN,
      mailDomain: null,
    };
    expect(hydrate(await read(r, scope.operationId))).toEqual(accepted);
    // Raw archive custody is independently admitted; UTC6 and max exact-safe byte length survive.
    await insertContext(r, "product_source_archive_objects", {
      ...idsOf(r, r.accepted.operationId),
      environment_id: p.prodEnvironmentId,
      bucket_name: "ohmyho-builds-production-eu",
      object_key: "raw/key",
      object_version_id: "exact-version",
      object_etag: "exact-etag",
      byte_length: 9007199254740991,
      source_sha256: Buffer.alloc(32, 9),
      recorded_at: "2026-10-28T10:00:00.123456Z",
    });
    const archived = {
      ...accepted,
      sourceArchives: [
        {
          bucket: "ohmyho-builds-production-eu",
          key: "raw/key",
          versionId: "exact-version",
          eTag: "exact-etag",
          byteLength: Number.MAX_SAFE_INTEGER,
          scope: {
            projectId: p.projectId,
            environmentId: p.prodEnvironmentId,
            operationId: r.accepted.operationId,
          },
          sourceSha256: "09".repeat(32),
        },
      ],
    };
    expect(hydrate(await read(r, scope.operationId))).toEqual(archived);
    const transported = await control.read(scope);
    expect(transported?.intent.sourceDigest).toBeInstanceOf(Uint8Array);
    expect(hydrate(transported)).toEqual(archived);
    await updateContext(
      r,
      "UPDATE runtime_secret_delivery_states SET provider_tag=?3,desired_generation=4,applied_generation=4 WHERE organization_id=?1 AND environment_id=?2",
      [p.organizationId, p.prodEnvironmentId, "c".repeat(32)],
    );
    // The runtime state's tag is reported as one more receipt of the active deployment.
    const tagged = {
      ...archived,
      knownDeployments: [
        ...archived.knownDeployments,
        { ...publishedWfp(r), providerTag: "c".repeat(32) },
      ],
    };
    expect(hydrate(await read(r, scope.operationId))).toEqual(tagged);

    const currentData = must(
      await r.db
        .prepare(
          "SELECT data_environment_id FROM environment_data_assignments WHERE organization_id=? AND environment_id=? ORDER BY assignment_version DESC LIMIT 1",
        )
        .bind(p.organizationId, p.prodEnvironmentId)
        .first<{ data_environment_id: string }>(),
    ).data_environment_id;
    const refreshSnapshot = {
      sourceDeploymentId: r.published.deploymentId,
      sourceRevisionId: r.published.revisionId,
      sourceCandidateReceiptId: r.published.candidateReceiptId,
      sourceArtifactId: r.published.artifactId,
      sourcePlanId: r.published.planId,
      sourceBuildExecutionId: r.published.buildExecutionId,
      sourceArtifactSha256: "03".repeat(32),
      sourceNamespace: "ohmyho-production",
      sourceScriptName: publishedWfp(r).scriptName,
      sourceProviderTag: "f".repeat(32),
      expectedHeadVersion: 1,
      expectedGatewayRevision: 1,
      dataEnvironmentId: currentData,
      assignmentVersion: 1,
      registrationVersion: 0,
    };
    expect(parseProjectBindingRefreshSnapshot(refreshSnapshot)).toEqual(refreshSnapshot);
    const refresh = await accept(r, "DeploymentRequestedV1", {
      plan_id: r.published.planId,
      source_connection_id: sourceConnectionId,
      binding_refresh_snapshot: refreshSnapshot,
    });
    expect(hydrate(await read(r, refresh))).toEqual({
      ...tagged,
      intent: {
        ...tagged.intent,
        operationId: refresh,
        deploymentId: expect.stringMatching(/^[0-9A-Z]{26}$/u),
        bindingRefreshSnapshot: refreshSnapshot,
      },
      bindingRefreshArtifact: buildArtifact(r),
    });
    for (const invalid of [
      { ...refreshSnapshot, extra: true },
      { ...refreshSnapshot, sourceArtifactSha256: "bad" },
      { ...refreshSnapshot, expectedHeadVersion: 0 },
    ])
      expect(() => parseProjectBindingRefreshSnapshot(invalid)).toThrow();
    // Exact current binding and revocation, never an arbitrary retained grant.
    await insertContext(r, "repository_grant_revocations", {
      revocation_id: newUlid(),
      organization_id: p.organizationId,
      project_id: p.projectId,
      grant_id: grant,
      reason: "permission_revoked",
      revoked_at: STORED_NOW,
    });
    expect(hydrate(await read(r, scope.operationId))).toEqual({ ...tagged, sourceGrant: null });
    // Every concrete scope component is authoritative, and an absent accepted run is absence.
    const context = { directory: r.db, router: new SharedCoreRouter(r.db) };
    for (const changed of [
      { projectId: newUlid() },
      { environmentId: p.devEnvironmentId },
      { operationId: newUlid() },
    ])
      expect(await readProductWorkflowContext(context, { ...scope, ...changed })).toBeNull();
    await expect(readProductWorkflowContext(context, { ...scope, extra: true })).rejects.toThrow();
    await r.db
      .prepare(
        "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=? AND project_id=?",
      )
      .bind(p.organizationId, p.projectId)
      .run();
    expect(await read(r, scope.operationId)).toBeNull();
    await r.db
      .prepare("INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES(?,'moved',?,?)")
      .bind(await bucketOf(scope.organizationId), newUlid(), STORED_NOW)
      .run();
    await expect(readProductWorkflowContext(context, scope)).rejects.toThrow();
    await expect(control.read(scope)).rejects.toThrow();
  } finally {
    await control.dispose();
  }
}, 240000);

function idsOf(r: ContextFixture, operationId: string) {
  return {
    organization_id: r.project.organizationId,
    project_id: r.project.projectId,
    operation_id: operationId,
  };
}
function hydrate(value: Awaited<ReturnType<typeof readProductWorkflowContext>>) {
  if (value === null) return null;
  return {
    ...value,
    intent: {
      ...value.intent,
      sourceArtifactDigest:
        value.intent.sourceArtifactDigest === null
          ? null
          : Buffer.from(value.intent.sourceArtifactDigest),
      sourceDigest:
        value.intent.sourceDigest === null ? null : Buffer.from(value.intent.sourceDigest),
      buildPlanDigest:
        value.intent.buildPlanDigest === null ? null : Buffer.from(value.intent.buildPlanDigest),
    },
  };
}
async function read(
  r: ContextFixture,
  operationId: string,
  environmentId = r.project.prodEnvironmentId,
) {
  return await readProductWorkflowContext(
    { directory: r.db, router: new SharedCoreRouter(r.db) },
    {
      organizationId: r.project.organizationId,
      projectId: r.project.projectId,
      environmentId,
      operationId,
    },
  );
}
async function accept(
  r: ContextFixture,
  type: string,
  fields: Record<string, unknown> = {},
  environmentId = r.project.prodEnvironmentId,
) {
  const operationId = newUlid(),
    eventId = newUlid(),
    workflowId = newUlid(),
    scope = idsOf(r, operationId);
  await insertContext(r, "operations", {
    ...scope,
    state: "running",
    billing_epoch_id: r.project.billingEpochId,
    created_at: STORED_NOW,
    updated_at: STORED_NOW,
  });
  if (
    type === "DeploymentPromotionRequestedV1" ||
    type === "DeploymentRollbackRequestedV1" ||
    type === "DeploymentRequestedV1"
  ) {
    const deploymentId = newUlid();
    await insertContext(r, "deployments", {
      ...scope,
      deployment_id: deploymentId,
      environment_id: environmentId,
      kind:
        type === "DeploymentPromotionRequestedV1"
          ? "promotion"
          : type === "DeploymentRollbackRequestedV1"
            ? "rollback"
            : "deploy",
      status: "running",
      ...(type === "DeploymentRollbackRequestedV1"
        ? {
            rollback_target_deployment_id: fields["target_deployment_id"],
            rollback_target_revision_id: fields["target_revision_id"],
          }
        : {}),
      ...(type === "DeploymentPromotionRequestedV1"
        ? {
            promotion_source_environment_id: fields["source_environment_id"],
            promotion_source_deployment_id: fields["source_deployment_id"],
            promotion_source_revision_id: fields["source_revision_id"],
          }
        : {}),
      created_at: STORED_NOW,
      updated_at: STORED_NOW,
    });
    fields = { ...fields, deployment_id: deploymentId };
  }
  if (type === "ProjectDeletionRequestedV1" || type === "ProjectDataChangeRequestedV1") {
    const cleanupId = newUlid();
    await insertContext(r, "cleanup_runs", {
      ...scope,
      cleanup_run_id: cleanupId,
      state: "pending",
      revision: 1,
      created_at: STORED_NOW,
      updated_at: STORED_NOW,
    });
    fields = { ...fields, cleanup_run_id: cleanupId };
  }
  if (
    [
      "DeploymentRequestedV1",
      "DeploymentPromotionRequestedV1",
      "DeploymentRollbackRequestedV1",
    ].includes(type)
  ) {
    const binding = await r.db
      .prepare(
        "SELECT generation FROM project_source_bindings WHERE organization_id=? AND project_id=?",
      )
      .bind(r.project.organizationId, r.project.projectId)
      .first<{ generation: number }>();
    fields = { ...fields, source_generation: binding?.generation ?? 0 };
  }
  await insertContext(r, "product_command_intents", {
    ...scope,
    environment_id: environmentId,
    billing_epoch_id: r.project.billingEpochId,
    event_type: type,
    created_at: STORED_NOW,
    ...fields,
  });
  // initial_available_at is Core's exact original outbox created availability provenance.
  await r.db
    .prepare(
      "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,billing_epoch_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts) VALUES(?1,?2,?3,?4,?5,?6,'{}',?7,?7,?7,3)",
    )
    .bind(
      r.project.organizationId,
      eventId,
      r.project.projectId,
      operationId,
      r.project.billingEpochId,
      type,
      STORED_NOW,
    )
    .run();
  await insertContext(r, "product_workflow_runs", {
    ...scope,
    workflow_id: workflowId,
    event_id: eventId,
    environment_id: environmentId,
    billing_epoch_id: r.project.billingEpochId,
    event_type: type,
    state: "queued",
    created_at: STORED_NOW,
    updated_at: STORED_NOW,
  });
  return operationId;
}

it("decides rename, consent, rollback, data-change and deletion cleanup over complete real graphs", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    await seedContextData(r);
    const p = r.project;
    await insertContext(r, "environment_secrets", {
      organization_id: p.organizationId,
      project_id: p.projectId,
      environment_id: p.prodEnvironmentId,
      name: "SYNTHETIC_TEST",
      ciphertext: Buffer.alloc(17, 1),
      nonce: Buffer.alloc(12, 2),
      value_sha256: Buffer.alloc(32, 3),
      key_version: 1,
      revision: 1,
      created_at: STORED_NOW,
      updated_at: STORED_NOW,
    });
    const domainId = newUlid();
    await insertContext(r, "workspace_mail_domains", {
      organization_id: p.organizationId,
      domain_id: domainId,
      domain: "mail.example.test",
      registrable_domain: "example.test",
      custody_organization_id: p.organizationId,
      custody_project_id: p.projectId,
      custody_environment_id: p.prodEnvironmentId,
      configured_at: STORED_NOW,
    });
    await insertContext(r, "project_mail_domain_bindings", {
      organization_id: p.organizationId,
      project_id: p.projectId,
      environment_id: p.prodEnvironmentId,
      mail_domain_id: domainId,
      revision: 1,
      state: "active",
      sending: true,
      legacy: true,
      sender_addresses: [],
      configured_at: STORED_NOW,
      updated_at: STORED_NOW,
    });
    const bucketClaimId = newUlid();
    await insertContext(r, "project_r2_bucket_receipts", {
      organization_id: p.organizationId,
      project_id: p.projectId,
      environment_id: p.prodEnvironmentId,
      operation_id: r.previous.operationId,
      claim_id: bucketClaimId,
      bucket_name: `ohmyho-${p.projectId.toLowerCase()}-${p.prodEnvironmentId.toLowerCase()}`,
      provider_bucket_id: "a".repeat(32),
      jurisdiction: "eu",
      storage_class: "Standard",
      public_access: false,
      observed_at: STORED_NOW,
      created_at: STORED_NOW,
    });
    await insertContext(r, "product_source_archive_objects", {
      ...idsOf(r, r.previous.operationId),
      environment_id: p.prodEnvironmentId,
      bucket_name: "bucket",
      object_key: "raw",
      object_version_id: "exact-version",
      object_etag: "etag",
      byte_length: 19,
      source_sha256: Buffer.alloc(32, 9),
      recorded_at: STORED_NOW,
    });
    const archive = {
      bucket: "bucket",
      key: "raw",
      versionId: "exact-version",
      eTag: "etag",
      byteLength: 19,
      scope: {
        projectId: p.projectId,
        environmentId: p.prodEnvironmentId,
        operationId: r.previous.operationId,
      },
      sourceSha256: "09".repeat(32),
    };
    // The two environments of the deletion-like contexts: dev has nothing, prod carries the whole retained graph.
    const environments = (sourceArchives: unknown[]) => [
      {
        environmentId: p.devEnvironmentId,
        environmentName: "dev",
        headVersion: 0,
        activeDeploymentId: null,
        activeRevisionId: null,
        activeDeployment: null,
        activeGateway: null,
        activeRuntimePolicy: null,
        wfpDeployments: [],
        environmentSecretCount: 0,
        artifactExpectations: [],
        sourceArchives: [],
        r2Bucket: null,
        deletionBuildArtifacts: [],
      },
      {
        environmentId: p.prodEnvironmentId,
        environmentName: "prod",
        headVersion: 1,
        activeDeploymentId: r.published.deploymentId,
        activeRevisionId: r.published.revisionId,
        activeDeployment: publishedWfp(r),
        activeGateway: activeGateway(r),
        activeRuntimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        wfpDeployments: [wfp(r, r.deploymentId, r.providerTag, true), publishedWfp(r)],
        environmentSecretCount: 1,
        artifactExpectations: [],
        sourceArchives,
        r2Bucket: {
          organizationId: p.organizationId,
          projectId: p.projectId,
          environmentId: p.prodEnvironmentId,
          operationId: r.previous.operationId,
          claimId: bucketClaimId,
          bucketName: `ohmyho-${p.projectId.toLowerCase()}-${p.prodEnvironmentId.toLowerCase()}`,
          bucketId: "a".repeat(32),
          jurisdiction: "eu",
          storageClass: "Standard",
          publicAccess: false,
          observedAt: new Date(NOW),
        },
        deletionBuildArtifacts: [
          {
            artifactId: r.published.artifactId,
            buildExecutionId: r.published.buildExecutionId,
            artifactDigest: DIGEST_03,
            output: buildArtifact(r).output,
          },
        ],
      },
    ];
    const rename = await accept(r, "ProjectHandleChangeRequestedV1", {
      expected_etag: "project-v1",
      requested_handle: "renamed-project",
    });
    const renameHash = createHash("sha256")
      .update("cloudflare\0source-object\0bucket/raw/exact-version")
      .digest();
    await insertContext(r, "run_resource_inventory", {
      ...idsOf(r, rename),
      resource_record_id: newUlid(),
      provider: "cloudflare",
      resource_kind: "source-object",
      external_ref_hash: renameHash,
      cleanup_locator: "encoded/c3ludGhldGlj",
      recorded_at: STORED_NOW,
    });
    await insertContext(r, "run_cleanup_attempts", {
      ...idsOf(r, rename),
      cleanup_attempt_id: newUlid(),
      provider: "cloudflare",
      resource_kind: "source-object",
      external_ref_hash: renameHash,
      outcome: "removed",
      attempted_at: STORED_NOW,
    });
    // A removed source object leaves the per-environment cleanup list but stays in the project's custody list.
    const renamed = must(await read(r, rename));
    expect(renamed.intent).toMatchObject({
      eventType: "ProjectHandleChangeRequestedV1",
      environmentId: p.prodEnvironmentId,
      operationId: rename,
      expectedEtag: "project-v1",
      requestedHandle: "renamed-project",
      deploymentId: null,
      planId: null,
    });
    expect(renamed).toMatchObject({
      handle: p.handle,
      environmentName: "prod",
      headVersion: 1,
      environmentSecretCount: 1,
      mailDomain: "mail.example.test",
      activeDeploymentId: r.published.deploymentId,
      deletionDataEnvironments: [],
      deletionInventory: [],
      sourceArchives: [archive],
      frameworkPlan: null,
    });
    expect(renamed.deletionEnvironments).toEqual(environments([]));
    const rollback = await accept(r, "DeploymentRollbackRequestedV1", {
      target_deployment_id: r.published.deploymentId,
      target_revision_id: r.published.revisionId,
      target_artifact_id: r.published.artifactId,
      expected_etag: "head-v1",
    });
    const rolledBack = must(await read(r, rollback));
    expect(rolledBack.intent).toMatchObject({
      eventType: "DeploymentRollbackRequestedV1",
      targetDeploymentId: r.published.deploymentId,
      targetRevisionId: r.published.revisionId,
      targetArtifactId: r.published.artifactId,
      expectedEtag: "head-v1",
      providerVersionId: "f".repeat(32),
      sourceGeneration: 1,
    });
    expect(rolledBack.rollbackArtifact).toEqual(buildArtifact(r));
    expect(rolledBack.deletionEnvironments).toEqual([]);
    const link = await accept(r, "SourceLinkRequestedV1", {
      installation_id: "7",
      repository_owner: "o",
      repository_name: "r",
    });
    const unauthorized = must(await read(r, link));
    expect(unauthorized.intent).toMatchObject({
      eventType: "SourceLinkRequestedV1",
      installationId: "7",
      repositoryOwner: "o",
      repositoryName: "r",
    });
    expect(unauthorized.authorizedRepositoryId).toBeUndefined();
    const connectionId = newUlid();
    await insertContext(r, "github_organization_connections", {
      connection_id: connectionId,
      organization_id: p.organizationId,
      installation_id: "7",
      account_id: "11",
      account_login: "o",
      account_type: "Organization",
      github_user_id: "12",
      github_user_login: "fixture",
      principal_id: "user:fixture",
      settings_url: "https://github.com/settings/installations/7",
      connected_at: STORED_NOW,
    });
    await insertContext(r, "github_repository_link_consents", {
      ...idsOf(r, link),
      environment_id: p.prodEnvironmentId,
      billing_epoch_id: p.billingEpochId,
      connection_id: connectionId,
      principal_id: "user:fixture",
      installation_id: "7",
      repository_id: "42",
      repository_owner: "o",
      repository_name: "r",
      idempotency_key: "consent-one",
      request_sha256: Buffer.alloc(32, 1),
      authorized_at: STORED_NOW,
    });
    expect((await read(r, link))?.authorizedRepositoryId).toBe("42");
    // A recorded consent is immutable.
    for (const mutation of [
      "UPDATE github_repository_link_consents SET repository_id='43' WHERE operation_id=?1",
      "DELETE FROM github_repository_link_consents WHERE operation_id=?1",
    ])
      await expect(r.db.prepare(mutation).bind(link).run()).rejects.toThrow();
    expect((await read(r, link))?.authorizedRepositoryId).toBe("42");
    const oldLink = await accept(r, "SourceLinkRequestedV1", {
      installation_id: "8",
      repository_owner: "legacy",
      repository_name: "repo",
    });
    await insertContext(r, "github_source_authorizations", {
      authorization_id: newUlid(),
      ...idsOf(r, oldLink),
      environment_id: p.prodEnvironmentId,
      billing_epoch_id: p.billingEpochId,
      principal_id: "user:fixture",
      session_id: null,
      user_api_key_id: "api_key_fixture",
      workos_organization_id: "org_fixture",
      token_expires_at: "9223372036854775807",
      repository_owner: "legacy",
      repository_name: "repo",
      idempotency_key: "legacy-consent",
      request_sha256: Buffer.alloc(32, 1),
      state_sha256: Buffer.alloc(32, 2),
      ciphertext: Buffer.alloc(18, 3),
      nonce: Buffer.alloc(12, 4),
      value_sha256: Buffer.alloc(32, 5),
      key_version: 1,
      state: "authorized",
      github_user_id: "13",
      installation_id: "8",
      repository_id: "99",
      created_at: STORED_NOW,
      expires_at: "2026-10-28T10:30:00.000000Z",
    });
    expect((await read(r, oldLink))?.authorizedRepositoryId).toBe("99");
    expect(
      (
        await r.db
          .prepare(
            "SELECT CAST(token_expires_at AS TEXT) value FROM github_source_authorizations WHERE operation_id=?",
          )
          .bind(oldLink)
          .first<{ value: string }>()
      )?.value,
    ).toBe("9223372036854775807");
    const assignments = sharedAssignments(r);
    const newDataEnvironmentId = newUlid();
    const dataChangeSnapshot = {
      transition: planProjectDataChangeTransition({
        change: "isolate_prod_keeps_data",
        assignments,
        newDataEnvironmentId,
        prodDatabaseReady: true,
      }),
      environmentHeads: [
        { environmentId: p.devEnvironmentId, expectedHeadVersion: 0 },
        { environmentId: p.prodEnvironmentId, expectedHeadVersion: 1 },
      ],
      registrationGenerations: [
        { dataEnvironmentId: assignments.dev.dataEnvironmentId, registrationVersion: 0 },
      ],
    };
    const change = await accept(
      r,
      "ProjectDataChangeRequestedV1",
      {
        expected_etag: "head-v1",
        data_change: "isolate_prod_keeps_data",
        data_change_snapshot: dataChangeSnapshot,
      },
      p.devEnvironmentId,
    );
    const changed = must(await read(r, change, p.devEnvironmentId));
    expect(changed.intent).toMatchObject({
      eventType: "ProjectDataChangeRequestedV1",
      environmentId: p.devEnvironmentId,
      expectedEtag: "head-v1",
      dataChange: "isolate_prod_keeps_data",
    });
    // The stored plan comes back exactly as the acceptance froze it.
    expect(changed.intent.dataChangeSnapshot).toEqual({
      transition: {
        change: "isolate_prod_keeps_data",
        before: assignments,
        after: {
          ...assignments,
          dataMode: "isolated",
          dev: {
            ...assignments.dev,
            dataEnvironmentId: newDataEnvironmentId,
            assignmentVersion: 2,
          },
        },
        retiredDataEnvironmentIds: [],
        reauthorizations: [
          {
            dataEnvironmentId: p.devEnvironmentId,
            authorizedEnvironmentIds: [p.prodEnvironmentId],
            direction: "narrow",
          },
        ],
        redeployEnvironments: ["dev"],
        removeDevDeployment: false,
      },
      environmentHeads: [
        { environmentId: p.devEnvironmentId, expectedHeadVersion: 0 },
        { environmentId: p.prodEnvironmentId, expectedHeadVersion: 1 },
      ],
      registrationGenerations: [{ dataEnvironmentId: p.devEnvironmentId, registrationVersion: 0 }],
    });
    expect(changed).toMatchObject({
      environmentName: "dev",
      headVersion: 0,
      knownDeployments: [],
      activeDeploymentId: null,
      activeDeployment: null,
      activeGateway: null,
      deletionDataEnvironments: [],
      deletionInventory: [],
      environmentSecretCount: 0,
      sourceArchives: [],
      mailDomain: "mail.example.test",
    });
    expect(changed.deletionEnvironments.map((e) => e.environmentName)).toEqual(["dev", "prod"]);
    const deletion = await accept(r, "ProjectDeletionRequestedV1", { expected_etag: "project-v1" });
    await r.db
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=2 WHERE organization_id=? AND project_id=?",
      )
      .bind(p.organizationId, p.projectId)
      .run();
    // The Core lifecycle trigger detaches the sender custody of a deleting project.
    expect(
      await r.db
        .prepare(
          "SELECT state,sending,revision FROM project_mail_domain_bindings WHERE organization_id=? AND project_id=?",
        )
        .bind(p.organizationId, p.projectId)
        .first(),
    ).toEqual({ state: "detached", sending: 0, revision: 2 });
    // The retained source object is not yet an admitted cleanup resource of the deletion.
    expect(await read(r, deletion)).toBeNull();
    const locator = "bucket/raw/exact-version",
      hash = createHash("sha256").update(`cloudflare\0source-object\0${locator}`).digest();
    const resourceRecordId = newUlid();
    await insertContext(r, "run_resource_inventory", {
      ...idsOf(r, deletion),
      resource_record_id: resourceRecordId,
      provider: "cloudflare",
      resource_kind: "source-object",
      external_ref_hash: hash,
      cleanup_locator: "encoded/c3ludGhldGlj",
      recorded_at: STORED_NOW,
    });
    const admitted = must(await read(r, deletion));
    expect(admitted.intent).toMatchObject({
      eventType: "ProjectDeletionRequestedV1",
      expectedEtag: "project-v1",
      dataChange: null,
      dataChangeSnapshot: null,
    });
    expect(admitted).toMatchObject({
      projectLifecycleVersion: 2,
      mailDomain: null,
      environmentSecretCount: 1,
      sourceArchives: [archive],
      deletionDataEnvironments: [
        {
          dataEnvironmentId: p.devEnvironmentId,
          providerTarget: null,
          neonPlacement: null,
          databaseRegistration: null,
        },
        {
          dataEnvironmentId: p.prodEnvironmentId,
          providerTarget: null,
          neonPlacement: null,
          databaseRegistration: null,
        },
      ],
    });
    expect(admitted.deletionEnvironments).toEqual(environments([archive]));
    expect(
      admitted.deletionInventory.map((item) => ({
        ...item,
        externalRefHash: Buffer.from(item.externalRefHash).toString("hex"),
      })),
    ).toEqual([
      {
        resourceRecordId,
        provider: "cloudflare",
        resourceKind: "source-object",
        externalRefHash: hash.toString("hex"),
        cleanupLocator: "encoded/c3ludGhldGlj",
      },
    ]);
    await insertContext(r, "run_cleanup_attempts", {
      ...idsOf(r, deletion),
      cleanup_attempt_id: newUlid(),
      provider: "cloudflare",
      resource_kind: "source-object",
      external_ref_hash: hash,
      outcome: "not_found",
      attempted_at: STORED_NOW,
    });
    const cleaned = must(await read(r, deletion));
    expect(cleaned.sourceArchives).toEqual([]);
    expect(cleaned.deletionEnvironments).toEqual(environments([]));
    expect(cleaned.deletionInventory[0]).toMatchObject({
      resourceRecordId,
      cleanupOutcome: "not_found",
    });
    expect((await r.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 240000);

it("retains source/target stale promotions, admitted abandoned candidates and complete bounded snapshots across races", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control, { publishedEnvironment: "dev" });
    await seedContextData(r);
    const p = r.project;
    const dev: Environment = { id: p.devEnvironmentId, name: "dev" };
    const promoteFields = {
      source_environment_id: p.devEnvironmentId,
      source_deployment_id: r.published.deploymentId,
      source_revision_id: r.published.revisionId,
      source_artifact_id: r.published.artifactId,
      source_artifact_sha256: Buffer.alloc(32, 3),
      expected_source_head_version: 1,
      expected_target_head_version: 0,
      expected_etag: "target-v0",
    };
    const promotion = await accept(r, "DeploymentPromotionRequestedV1", promoteFields);
    const current = must(await read(r, promotion));
    expect(current.intent).toMatchObject({
      eventType: "DeploymentPromotionRequestedV1",
      environmentId: p.prodEnvironmentId,
      sourceEnvironmentId: p.devEnvironmentId,
      sourceDeploymentId: r.published.deploymentId,
      sourceRevisionId: r.published.revisionId,
      sourceArtifactId: r.published.artifactId,
      expectedSourceHeadVersion: 1,
      expectedTargetHeadVersion: 0,
      expectedEtag: "target-v0",
    });
    expect(Buffer.from(must(current.intent.sourceArtifactDigest)).toString("hex")).toBe(
      "03".repeat(32),
    );
    expect(current.promotionArtifact).toEqual(buildArtifact(r, p.devEnvironmentId));
    expect(current.promotionSourceDeployment).toEqual(publishedWfp(r, dev));
    expect(current.promotionStale).toBeUndefined();
    const staleTarget = await accept(r, "DeploymentPromotionRequestedV1", {
      ...promoteFields,
      expected_target_head_version: 1,
    });
    expect(await read(r, staleTarget)).toMatchObject({
      promotionStale: "target",
      promotionArtifact: null,
      promotionSourceDeployment: null,
    });
    await updateContext(
      r,
      "UPDATE environments SET head_version=2 WHERE organization_id=?1 AND environment_id=?2",
      [p.organizationId, p.devEnvironmentId],
    );
    expect(await read(r, promotion)).toMatchObject({
      promotionStale: "source",
      promotionArtifact: null,
      promotionSourceDeployment: null,
    });
    const failed = r.accepted.operationId;
    await updateContext(
      r,
      "UPDATE operations SET state='failed',failure=?3 WHERE organization_id=?1 AND operation_id=?2",
      [
        p.organizationId,
        failed,
        JSON.stringify({ code: "OPERATION_ABANDONED", message: "synthetic abandonment" }),
      ],
    );
    await updateContext(
      r,
      "UPDATE deployments SET status='failed' WHERE organization_id=?1 AND operation_id=?2",
      [p.organizationId, failed],
    );
    await updateContext(
      r,
      "UPDATE product_workflow_runs SET state='completed',terminal_evidence='{}',completed_at=?3,intermediate_evidence=?4 WHERE organization_id=?1 AND operation_id=?2",
      [
        p.organizationId,
        failed,
        STORED_NOW,
        JSON.stringify({
          providerReconciliationHint: {
            activationRuntimePolicy: { healthCheckPath: "/healthz", egressAllowedOrigins: [] },
          },
        }),
      ],
    );
    await updateContext(
      r,
      "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2",
      [p.organizationId, p.projectId],
    );
    const source = must(
      await r.db
        .prepare("SELECT source_connection_id FROM deployment_plans WHERE plan_id=?")
        .bind(r.published.planId)
        .first<{ source_connection_id: string }>(),
    ).source_connection_id;
    const retry = await accept(r, "DeploymentRequestedV1", {
      plan_id: r.published.planId,
      source_connection_id: source,
    });
    const run = must(
      await r.db
        .prepare(
          "SELECT event_id,workflow_id FROM product_workflow_runs WHERE organization_id=? AND operation_id=?",
        )
        .bind(p.organizationId, retry)
        .first<{ event_id: string; workflow_id: string }>(),
    );
    await insertContext(r, "product_provider_mutation_claims", {
      ...idsOf(r, retry),
      claim_id: newUlid(),
      environment_id: p.prodEnvironmentId,
      billing_epoch_id: p.billingEpochId,
      event_id: run.event_id,
      logical_workflow_id: run.workflow_id,
      event_type: "DeploymentRequestedV1",
      accepted_lifecycle_version: 1,
      claimed_at: STORED_NOW,
    });
    const abandoned = must(await read(r, retry));
    expect(abandoned.intent).toMatchObject({
      eventType: "DeploymentRequestedV1",
      operationId: retry,
      planId: r.published.planId,
      sourceConnectionId: source,
    });
    expect(abandoned).toMatchObject({
      headVersion: 0,
      activeDeploymentId: null,
      knownDeployments: [wfp(r, r.deploymentId, r.providerTag, true)],
      abandonedWfpTargets: [
        {
          candidateReceiptId: r.candidateReceiptId,
          operationId: failed,
          candidate: wfp(r, r.deploymentId, r.providerTag, true),
          runtimePolicy: { healthCheckPath: "/healthz", egressAllowedOrigins: [] },
        },
      ],
    });
    // A runtime policy stored as a JSON string, not an object, is corrupt evidence and is refused.
    await updateContext(
      r,
      "UPDATE product_workflow_runs SET intermediate_evidence=?3 WHERE organization_id=?1 AND operation_id=?2",
      [
        p.organizationId,
        failed,
        JSON.stringify({
          providerReconciliationHint: {
            activationRuntimePolicy: JSON.stringify({
              healthCheckPath: "/",
              egressAllowedOrigins: [],
            }),
          },
        }),
      ],
    );
    await expect(read(r, retry)).rejects.toThrow();
    await updateContext(
      r,
      "UPDATE product_workflow_runs SET intermediate_evidence=?3 WHERE organization_id=?1 AND operation_id=?2",
      [
        p.organizationId,
        failed,
        JSON.stringify({ providerReconciliationHint: { activationRuntimePolicy: null } }),
      ],
    );
    expect((await read(r, retry))?.abandonedWfpTargets?.[0]?.runtimePolicy).toEqual({
      healthCheckPath: "/",
      egressAllowedOrigins: [],
    });
    // 129 immutable objects prove a second raw-row page is read; no history truncation.
    const objects = [];
    for (let index = 0; index < 129; index++) {
      const operationId = newUlid();
      await insertContext(r, "operations", {
        ...idsOf(r, operationId),
        state: "running",
        billing_epoch_id: p.billingEpochId,
        created_at: STORED_NOW,
        updated_at: STORED_NOW,
      });
      await insertContext(r, "product_source_archive_objects", {
        ...idsOf(r, operationId),
        environment_id: p.prodEnvironmentId,
        bucket_name: "source-fixture",
        object_key: `source-${index}`,
        object_version_id: "exact-version",
        object_etag: "etag",
        byte_length: 1,
        source_sha256: Buffer.alloc(32, index),
        recorded_at: STORED_NOW,
      });
      objects.push(archiveOf(r, operationId, `source-${index}`, index));
    }
    // Listed by operation id (ULIDs sort bytewise), whatever order they were written in.
    const byOperation = (list: ReturnType<typeof archiveOf>[]) =>
      [...list].sort((a, b) => (a.scope.operationId < b.scope.operationId ? -1 : 1));
    const paged = must(await read(r, retry));
    expect(paged.sourceArchives).toEqual(byOperation(objects));
    const extra = newUlid();
    await insertContext(r, "operations", {
      ...idsOf(r, extra),
      state: "running",
      billing_epoch_id: p.billingEpochId,
      created_at: STORED_NOW,
      updated_at: STORED_NOW,
    });
    let raced = 0;
    const wrapped = beforeContextSnapshot(r.db, async () => {
      raced++;
      await insertContext(r, "product_source_archive_objects", {
        ...idsOf(r, extra),
        environment_id: p.prodEnvironmentId,
        bucket_name: "source-fixture",
        object_key: "racing-source",
        object_version_id: "exact-version",
        object_etag: "etag",
        byte_length: 1,
        source_sha256: Buffer.alloc(32, 1),
        recorded_at: STORED_NOW,
      });
    });
    const racedContext = must(
      await readProductWorkflowContext(
        { directory: r.db, router: new SharedCoreRouter(wrapped) },
        {
          organizationId: p.organizationId,
          projectId: p.projectId,
          environmentId: p.prodEnvironmentId,
          operationId: retry,
        },
      ),
    );
    // The racing insert changed the snapshot once: the reader re-read it and returns all 130 objects, nothing else changed.
    expect(raced).toBe(1);
    expect(racedContext.sourceArchives).toEqual(
      byOperation([...objects, archiveOf(r, extra, "racing-source", 1)]),
    );
    expect(hydrate({ ...racedContext, sourceArchives: [] })).toEqual(
      hydrate({ ...paged, sourceArchives: [] }),
    );
    const assignments = sharedAssignments(r);
    for (const change of [
      "isolate_prod_keeps_data",
      "isolate_dev_keeps_data",
      "share_prod_keeps_data",
      "reset_dev",
    ] as const) {
      const before: ProjectDataAssignments = change.startsWith("isolate")
        ? assignments
        : {
            ...assignments,
            dataMode: "isolated" as const,
            dev: { ...assignments.dev, dataEnvironmentId: newUlid() },
          };
      const transition = planProjectDataChangeTransition({
        change,
        assignments: before,
        newDataEnvironmentId: newUlid(),
        prodDatabaseReady: true,
      });
      const snapshot = {
        transition,
        environmentHeads: [
          { environmentId: p.devEnvironmentId, expectedHeadVersion: 2 },
          { environmentId: p.prodEnvironmentId, expectedHeadVersion: 0 },
        ],
        registrationGenerations: [
          ...new Set([before.dev.dataEnvironmentId, before.prod.dataEnvironmentId]),
        ].map((dataEnvironmentId) => ({ dataEnvironmentId, registrationVersion: 0 })),
      };
      expect(parseProjectDataChangeSnapshot(snapshot)).toEqual(snapshot);
      expect(() => parseProjectDataChangeSnapshot({ ...snapshot, extra: true })).toThrow();
      let rejected: unknown;
      try {
        parseProjectDataChangeSnapshot({
          ...snapshot,
          transition: { ...transition, change: "invalid" },
        });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toMatchObject({
        code: "data_change_not_applicable",
        message: "Project data assignments conflict with the requested change",
      });
    }
    expect(() => parseProjectDataChangeSnapshot({})).toThrow();
    expect((await r.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 240000);

/** One immutable source object of the project's production environment, as the context lists it. */
function archiveOf(r: Fixture, operationId: string, key: string, fill: number) {
  return {
    bucket: "source-fixture",
    key,
    versionId: "exact-version",
    eTag: "etag",
    byteLength: 1,
    scope: {
      projectId: r.project.projectId,
      environmentId: r.project.prodEnvironmentId,
      operationId,
    },
    sourceSha256: fill.toString(16).padStart(2, "0").repeat(32),
  };
}
function must<Value>(value: Value | null | undefined): Value {
  if (value == null) throw new Error("Context fixture is incomplete");
  return value;
}
