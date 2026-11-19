import { authorizeProductActivation } from "../../src/catalog/provisioning/deployment-authorization.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { resourceHash } from "../../src/catalog/provisioning/context-values.js";
import {
  assertProductBindingRefresh,
  finalizeProductCandidate,
  finalizeProductRollback,
  finishProductBindingRefresh,
  completeNativePolicySync,
} from "../../src/catalog/provisioning/deployment-finalization.js";
import { reconcileProductWorkflow } from "../../src/catalog/provisioning/deployment-reconciliation.js";
import type { D1Database, D1PreparedStatement } from "../../src/d1-types.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import {
  releaseProviderClaim,
  rollbackIntent,
  seedAcceptedOperation,
  seedOperation,
  seedPublishedClaim,
} from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { deploymentContext as context } from "../support/deployment-commands-fixture.js";
import { losingWriteResponses, STORED_NOW } from "../support/platform-fixtures.js";
import { seedWfpPublication, sourceFrameworkPlan } from "../support/provider-fixtures.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const one = async <T>(sql: string, ...values: unknown[]) =>
  (await control.core
    .prepare(sql)
    .bind(...values)
    .first<T>()) as T;

function losingNativeCompletionResponse(db: D1Database): D1Database {
  let lost = false;
  const wrap = (
    inner: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement & { inner: D1PreparedStatement; sql: string } => ({
    inner,
    sql,
    bind: (...values) => wrap(inner.bind(...values), sql),
    first: (...args: []) => inner.first(...args),
    all: () => inner.all(),
    run: () => inner.run(),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    async batch(statements) {
      const wrapped = statements as (D1PreparedStatement & {
        inner: D1PreparedStatement;
        sql: string;
      })[];
      const results = await db.batch(wrapped.map((statement) => statement.inner));
      if (
        !lost &&
        wrapped.some((statement) =>
          statement.sql.includes("UPDATE native_auth_policy_syncs SET state='completed'"),
        )
      ) {
        lost = true;
        throw new Error("Network connection lost");
      }
      return results;
    },
  };
}

async function seedNativeRegistration(
  scope: { organizationId: string; projectId: string; environmentId: string },
  operationId: string,
  claimId: string,
) {
  const dbid = `a${newUlid().toLowerCase().slice(-19)}`,
    provider = `prj_${newUlid().toLowerCase().slice(-20)}`,
    schema = `omh_auth_${scope.environmentId.toLowerCase()}`,
    runtime = `omh_ar_${scope.environmentId.toLowerCase()}`;
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,?3,?4,'op_fixture','eu-dev','r256-s500m',1,'2026-10-28T10:00:00.000000Z','2026-10-28T10:00:00.000000Z')",
      )
      .bind(scope.organizationId, scope.projectId, provider, dbid),
    control.core
      .prepare(
        "INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,?5,?6,?7,'eu-dev','pgcf.example.com',?8,?9,1,1,?10,'active')",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        operationId,
        claimId,
        provider,
        dbid,
        schema,
        runtime,
        `${scope.projectId}:${scope.environmentId}`,
      ),
    control.core
      .prepare(
        "INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,?13)",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        operationId,
        claimId,
        provider,
        dbid,
        schema,
        runtime,
        `omh_am_${scope.environmentId.toLowerCase()}`,
        `omh_ab_${scope.projectId.toLowerCase()}`,
        NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
      ),
  ]);
}

/** The pending deployment of the gateway fixture with its candidate activated on the shared gateway. */
async function candidateInput(options: { frameworkPlan?: unknown } = {}) {
  const r = await gatewayFixture(control, options),
    gateway = await r.store.gateway.management.activate(r.activation),
    run = await one<{ workflow_id: string; event_id: string }>(
      "SELECT workflow_id,event_id FROM product_workflow_runs WHERE operation_id=?",
      r.accepted.operationId,
    );
  await control.core
    .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
    .bind(run.event_id, "2026-10-28T10:30:00.000000Z")
    .run();
  const publication = {
    ...r.scope,
    operationId: r.accepted.operationId,
    candidateReceiptId: r.candidateReceiptId,
    wfpReceiptId: newUlid(),
    revisionId: newUlid(),
    productDeploymentId: r.deploymentId,
    expectedHeadVersion: 1,
    deploymentUrl: gateway.publicOrigin,
    publishedAt: "2026-10-28T12:00:00.000Z",
    gateway,
  };
  return {
    r,
    input: {
      eventType: "DeploymentRequestedV1" as const,
      bindingRefreshSnapshot: null,
      publication,
      schedule: { crons: [], egressAllowedOrigins: [] },
      completion: {
        workflowId: run.workflow_id,
        outboxEventId: run.event_id,
        startedOperationEventId: newUlid(),
        operationEventId: newUlid(),
        auditEventId: newUlid(),
        acceptedLifecycleVersion: 1,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        result: {
          schemaVersion: "ohmyhost.operation-deployment-result/v2",
          operationId: r.accepted.operationId,
          deploymentId: r.deploymentId,
          planId: r.published.planId,
          artifactSha256: "03".repeat(32),
          url: gateway.publicOrigin,
        },
      },
    },
  };
}

it("fences Native sessions atomically when a deployment turns the capability off", async () => {
  const frameworkPlan = {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  };
  const { r, input } = await candidateInput({ frameworkPlan });
  await control.core
    .prepare(
      "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
    )
    .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId, `https://${r.hostname}`)
    .run();
  await seedNativeRegistration(r.scope, r.accepted.operationId, r.accepted.claimId);
  const oldHead = await one<{ active_deployment_id: string }>(
    "SELECT active_deployment_id FROM environments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    r.scope.organizationId,
    r.scope.projectId,
    r.scope.environmentId,
  );
  const authorityScope = { projectId: r.scope.projectId, environmentId: r.scope.environmentId };
  expect(
    await r.store.identity.resolveNativeAuthAuthority({
      ...authorityScope,
      deploymentId: oldHead.active_deployment_id,
    }),
  ).toMatchObject({ deploymentId: oldHead.active_deployment_id });
  const deniedContext = { directory: control.core, router: context(control.core).router };
  await expect(
    authorizeProductActivation(deniedContext, {
      organizationId: r.scope.organizationId,
      projectId: r.scope.projectId,
      operationId: r.accepted.operationId,
    }),
  ).rejects.toThrow("Native Auth launch unavailable");
  await expect(
    authorizeProductActivation(deniedContext, {
      organizationId: r.scope.organizationId,
      projectId: r.scope.projectId,
      operationId: r.accepted.operationId,
      candidateReceiptId: input.publication.candidateReceiptId,
    }),
  ).rejects.toThrow("Native Auth launch unavailable");
  await expect(finalizeProductCandidate(deniedContext, input)).rejects.toThrow(
    "Native Auth launch unavailable",
  );
  await finalizeProductCandidate(context(losingWriteResponses(control.core, 1)), input);
  expect(
    await one<{ state: string }>(
      "SELECT state FROM operations WHERE organization_id=?1 AND operation_id=?2",
      r.scope.organizationId,
      r.accepted.operationId,
    ),
  ).toEqual({ state: "running" });
  await finalizeProductCandidate(context(control.core), input);
  const syncScope = {
    ...r.scope,
    operationId: r.accepted.operationId,
    claimId: r.accepted.claimId,
  };
  const pending = await r.store.provisioning.readPendingNativePolicySync(syncScope);
  expect(pending).toMatchObject({
    state: "pending",
    headVersion: 2,
    targetDeploymentId: r.deploymentId,
    configurationRevision: 1,
    revocationEpoch: 1,
    registryVersion: 1,
  });
  if (!pending || pending.state !== "pending") throw new Error("Missing Native policy sync");
  const ack = {
    ...syncScope,
    headVersion: pending.headVersion,
    configurationRevision: pending.configurationRevision,
    revocationEpoch: pending.revocationEpoch,
    ownerEnabled: pending.ownerEnabled,
    canonicalOrigin: pending.canonicalOrigin,
    registryVersion: pending.registryVersion,
    acknowledgement: "applied" as const,
  };
  await expect(
    r.store.provisioning.completeNativePolicySync({ ...ack, revocationEpoch: 2 }),
  ).rejects.toThrow();
  await expect(
    completeNativePolicySync(context(losingNativeCompletionResponse(control.core)), ack),
  ).rejects.toThrow("Network connection lost");
  expect(await r.store.provisioning.completeNativePolicySync(ack)).toBe("replayed");
  expect(await r.store.provisioning.readPendingNativePolicySync(syncScope)).toMatchObject({
    state: "completed",
  });
  expect(
    await one<{ state: string }>(
      "SELECT state FROM operations WHERE organization_id=?1 AND operation_id=?2",
      r.scope.organizationId,
      r.accepted.operationId,
    ),
  ).toEqual({ state: "succeeded" });
  await expect(
    r.store.identity.resolveNativeAuthAuthority({
      ...authorityScope,
      deploymentId: oldHead.active_deployment_id,
    }),
  ).rejects.toThrow("auth_unavailable");
  expect(
    await r.store.identity.resolveNativeAuthAuthority({
      ...authorityScope,
      deploymentId: r.deploymentId,
    }),
  ).toMatchObject({ deploymentId: r.deploymentId });
  const epoch = async () =>
    one<{ revocation_epoch: number }>(
      "SELECT revocation_epoch FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      r.scope.organizationId,
      r.scope.projectId,
      r.scope.environmentId,
    );
  expect(await epoch()).toEqual({ revocation_epoch: 1 });
  await control.core
    .prepare(
      "UPDATE native_auth_realms SET revocation_epoch=2147483647 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId)
    .run();
  await expect(
    control.core
      .prepare(
        "UPDATE environments SET active_deployment_id=NULL,active_revision_id=NULL,head_version=head_version+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId)
      .run(),
  ).rejects.toThrow();
  expect(
    await one<{ active_deployment_id: string }>(
      "SELECT active_deployment_id FROM environments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      r.scope.organizationId,
      r.scope.projectId,
      r.scope.environmentId,
    ),
  ).toEqual({ active_deployment_id: r.deploymentId });
  await control.core
    .prepare(
      "UPDATE native_auth_realms SET revocation_epoch=1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId)
    .run();
  await control.core
    .prepare(
      "UPDATE environments SET active_deployment_id=NULL,active_revision_id=NULL,head_version=head_version+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId)
    .run();
  expect(await epoch()).toEqual({ revocation_epoch: 2 });
});

it("does not complete a Native publication when private storage is unprovisioned", async () => {
  const frameworkPlan = {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  };
  const { r, input } = await candidateInput({ frameworkPlan });
  await control.core
    .prepare(
      "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
    )
    .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId, `https://${r.hostname}`)
    .run();
  await finalizeProductCandidate(context(control.core), input);
  await expect(
    r.store.provisioning.readPendingNativePolicySync({
      ...r.scope,
      operationId: r.accepted.operationId,
      claimId: r.accepted.claimId,
    }),
  ).rejects.toThrow("Native deployment requires verified private storage");
  expect(
    await one<{ state: string }>(
      "SELECT state FROM operations WHERE organization_id=?1 AND operation_id=?2",
      r.scope.organizationId,
      r.accepted.operationId,
    ),
  ).toEqual({ state: "running" });
});

/** A running operation holds a lease that its terminal write must clear. */
const leaseOperation = (operationId: string) =>
  control.core
    .prepare("UPDATE operations SET lease_expires_at=?2 WHERE operation_id=?1")
    .bind(operationId, "2999-01-01T00:00:00.000000Z")
    .run();

it("publishes the candidate, moves the head and completes the Workflow in one batch, then replays it", async () => {
  const { r, input } = await candidateInput(),
    p = input.publication;
  await leaseOperation(r.accepted.operationId);
  await finalizeProductCandidate(context(control.core), input);
  expect(
    await one(
      "SELECT active_deployment_id,active_revision_id,head_version FROM environments WHERE environment_id=?",
      r.scope.environmentId,
    ),
  ).toEqual({
    active_deployment_id: r.deploymentId,
    active_revision_id: p.revisionId,
    head_version: 2,
  });
  expect(
    await one(
      "SELECT status,active_revision_id,active_version FROM deployments WHERE deployment_id=?",
      r.deploymentId,
    ),
  ).toEqual({ status: "succeeded", active_revision_id: p.revisionId, active_version: 1 });
  expect(
    await one(
      "SELECT revision.plan_id,revision.artifact_id,receipt.deployment_url,receipt.shared_gateway_revision FROM deployment_revisions revision JOIN wfp_publish_receipts receipt ON receipt.wfp_receipt_id=revision.wfp_receipt_id WHERE revision.revision_id=?",
      p.revisionId,
    ),
  ).toEqual({
    plan_id: r.published.planId,
    artifact_id: r.published.artifactId,
    deployment_url: p.deploymentUrl,
    shared_gateway_revision: 2,
  });
  expect(
    await one(
      "SELECT state,result_deployment_id,result_url,lower(hex(result_artifact_sha256)) digest,lease_expires_at FROM operations WHERE operation_id=?",
      r.accepted.operationId,
    ),
  ).toEqual({
    state: "succeeded",
    result_deployment_id: r.deploymentId,
    result_url: p.deploymentUrl,
    digest: "03".repeat(32),
    lease_expires_at: null,
  });
  expect(
    await one(
      "SELECT state,active_reconciliation_attempt_id FROM product_workflow_runs WHERE workflow_id=?",
      input.completion.workflowId,
    ),
  ).toEqual({ state: "completed", active_reconciliation_attempt_id: null });
  expect(
    await one(
      "SELECT count(*) n FROM product_provider_mutation_claims WHERE operation_id=?",
      r.accepted.operationId,
    ),
  ).toEqual({ n: 0 });
  expect(
    (
      await control.core
        .prepare("SELECT event_type FROM operation_events WHERE operation_id=? ORDER BY revision")
        .bind(r.accepted.operationId)
        .all()
    ).results,
  ).toEqual([{ event_type: "OperationStarted" }, { event_type: "OperationSucceeded" }]);
  expect(
    await one(
      "SELECT count(*) n FROM audit_events WHERE audit_event_id=? AND event_type='DeploymentRequestedV1Completed'",
      input.completion.auditEventId,
    ),
  ).toEqual({ n: 1 });
  // The replay of the committed finalization changes nothing.
  await finalizeProductCandidate(context(control.core), input);
  expect(
    await one(
      "SELECT head_version FROM environments WHERE environment_id=?",
      r.scope.environmentId,
    ),
  ).toEqual({ head_version: 2 });
}, 60_000);

it("recovers a committed finalization whose response was lost", async () => {
  const { r, input } = await candidateInput();
  await finalizeProductCandidate(context(losingWriteResponses(control.core, 1)), input);
  expect(
    await one(
      "SELECT head_version FROM environments WHERE environment_id=?",
      r.scope.environmentId,
    ),
  ).toEqual({ head_version: 2 });
  expect(
    await one(
      "SELECT count(*) n FROM wfp_publish_receipts WHERE wfp_receipt_id=?",
      input.publication.wfpReceiptId,
    ),
  ).toEqual({ n: 1 });
}, 60_000);

it("refuses a finalization whose gateway, candidate, Workflow, result or refresh scope differs from the persisted facts", async () => {
  const { r, input } = await candidateInput(),
    finalize = (patch: object) =>
      finalizeProductCandidate(context(control.core), { ...input, ...patch }),
    publication = (patch: object) => ({ ...input.publication, ...patch });
  await expect(
    finalize({ publication: publication({ candidateReceiptId: newUlid() }) }),
  ).rejects.toThrow("Shared gateway receipt scope changed");
  await expect(
    finalize({ publication: publication({ productDeploymentId: newUlid() }) }),
  ).rejects.toThrow("WFP candidate is unavailable");
  await expect(
    finalize({ completion: { ...input.completion, workflowId: "product-command-v1-unknown" } }),
  ).rejects.toThrow("Product Workflow state changed");
  await expect(
    finalize({
      completion: {
        ...input.completion,
        result: { ...input.completion.result, planId: newUlid() },
      },
    }),
  ).rejects.toThrow("Finalized WFP deployment result changed");
  await expect(finalize({ eventType: "DeploymentPromotionRequestedV1" })).rejects.toThrow(
    "WFP reused artifact provenance changed",
  );
  await expect(
    finalize({
      completion: null,
      bindingRefreshSnapshot: {
        sourceDeploymentId: r.published.deploymentId,
        sourceRevisionId: r.published.revisionId,
        sourceCandidateReceiptId: r.published.candidateReceiptId,
        sourceArtifactId: r.published.artifactId,
        sourcePlanId: r.published.planId,
        sourceBuildExecutionId: r.published.buildExecutionId,
        sourceArtifactSha256: "03".repeat(32),
        sourceNamespace: "ohmyho-production",
        sourceScriptName: r.script,
        sourceProviderTag: "ab".repeat(16),
        expectedHeadVersion: 1,
        expectedGatewayRevision: 1,
        dataEnvironmentId: newUlid(),
        assignmentVersion: 1,
        registrationVersion: 0,
      },
    }),
  ).rejects.toThrow("Binding refresh finalization scope changed");
  // A later route revision supersedes the receipt the Workflow observed.
  await r.store.gateway.management.compensate({ ...r.mutation, expectedRevision: 2 });
  await expect(finalize({})).rejects.toThrow("Shared gateway route changed before publication");
  expect(
    await one(
      "SELECT head_version FROM environments WHERE environment_id=?",
      r.scope.environmentId,
    ),
  ).toEqual({ head_version: 1 });
  expect(
    await one(
      "SELECT count(*) n FROM wfp_publish_receipts WHERE candidate_receipt_id=?",
      r.candidateReceiptId,
    ),
  ).toEqual({ n: 0 });
}, 60_000);

/** A rollback of the published deployment: the retained candidate is activated again by a new operation. */
async function rollbackInput(options: { frameworkPlan?: unknown } = {}) {
  const r = await gatewayFixture(control, options);
  await releaseProviderClaim(r.project);
  const environmentId = r.scope.environmentId,
    operationId = await seedOperation(r.project),
    intent = {
      ...(await rollbackIntent(r.project, operationId, environmentId, r.published)),
      source_generation: 1,
    },
    accepted = await seedAcceptedOperation(r.project, environmentId, {
      eventType: "DeploymentRollbackRequestedV1",
      operationId,
      intent,
    });
  await control.core
    .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
    .bind(accepted.eventId, "2026-10-28T10:30:00.000000Z")
    .run();
  const gateway = await r.store.gateway.management.activate({
    ...r.scope,
    operationId,
    claimId: accepted.claimId,
    expectedRevision: 1,
    candidateReceiptId: r.published.candidateReceiptId,
    egressAllowedOrigins: [],
  });
  return {
    r,
    operationId,
    claimId: accepted.claimId,
    input: {
      activation: {
        ...r.scope,
        operationId,
        rollbackActivationReceiptId: newUlid(),
        rollbackDeploymentId: String(intent.deployment_id),
        targetDeploymentId: r.published.deploymentId,
        targetRevisionId: r.published.revisionId,
        candidateReceiptId: r.published.candidateReceiptId,
        wfpReceiptId: r.published.wfpReceiptId,
        gateway,
        expectedHeadVersion: 1,
        completedAt: "2026-10-28T12:00:00.000Z",
      },
      schedule: { crons: [], egressAllowedOrigins: [] },
      completion: {
        workflowId: accepted.workflowId,
        outboxEventId: accepted.eventId,
        startedOperationEventId: newUlid(),
        operationEventId: newUlid(),
        auditEventId: newUlid(),
        acceptedLifecycleVersion: 1,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      },
    },
  };
}

/** A native candidate finalized with its policy sync pending; the run stays queued, the claim held (CORE-27). */
async function pendingNativeHead() {
  const frameworkPlan = {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  };
  const { r, input } = await candidateInput({ frameworkPlan });
  // The rollback reader joins the environment's data assignment, which the gateway fixture does not seed.
  const physical = newUlid();
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(r.scope.organizationId, r.scope.projectId, physical, STORED_NOW),
    control.core
      .prepare(
        "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,assignment_version,data_environment_id,assigned_at) VALUES(?1,?2,?3,1,?4,?5)",
      )
      .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId, physical, STORED_NOW),
  ]);
  await control.core
    .prepare(
      "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
    )
    .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId, `https://${r.hostname}`)
    .run();
  await seedNativeRegistration(r.scope, r.accepted.operationId, r.accepted.claimId);
  await leaseOperation(r.accepted.operationId);
  await finalizeProductCandidate(context(control.core), input);
  const run = await one<{ workflow_id: string; event_id: string }>(
    "SELECT workflow_id,event_id FROM product_workflow_runs WHERE operation_id=?",
    r.accepted.operationId,
  );
  const scope = { ...r.scope, operationId: r.accepted.operationId, claimId: r.accepted.claimId };
  const readers = {
    rollback: () =>
      r.store.productApi.readApiRollbackTarget({
        organizationId: r.scope.organizationId,
        projectId: r.scope.projectId,
        environmentId: r.scope.environmentId,
        deploymentId: r.deploymentId,
      }),
    paidDomain: () =>
      r.store.cloudflareDomain.readPaidDomainTarget({
        organizationId: r.scope.organizationId,
        projectId: r.scope.projectId,
      }),
  };
  return { r, input, scope, run, readers };
}

/** The provider reconciliation of the run downgrades its head, as it does today. */
async function downgradeHead(
  r: Awaited<ReturnType<typeof candidateInput>>["r"],
  run: { workflow_id: string; event_id: string },
) {
  await reconcileProductWorkflow(context(control.core), {
    workflowId: run.workflow_id,
    organizationId: r.scope.organizationId,
    projectId: r.scope.projectId,
    environmentId: r.scope.environmentId,
    operationId: r.accepted.operationId,
    outboxEventId: run.event_id,
    auditEventId: newUlid(),
    reconciledAt: "2026-10-28T12:00:00.000Z",
    bindingsOutdated: false,
    providerReconciliation: {
      observationId: newUlid(),
      evidenceDigest: new Uint8Array(32).fill(1),
      hint: {
        phase: "gateway" as const,
        expectedArtifactDigest: `sha256:${"03".repeat(32)}`,
        currentProviderTag: "tag-1",
        currentProductDeploymentId: newUlid(),
        activationRuntimePolicy: {
          healthCheckPath: "/health",
          egressAllowedOrigins: ["https://a.example"],
        },
      },
    },
  });
  expect(
    await one<{ status: string }>(
      "SELECT status FROM deployments WHERE deployment_id=?",
      r.deploymentId,
    ),
  ).toEqual({ status: "reconciliation_required" });
  // The recovery attempt that resumes the Workflow runs it again; its deployment runs under that attempt.
  await control.core.batch([
    control.core
      .prepare(
        "UPDATE product_workflow_runs SET state='queued',reconciliation_code=NULL WHERE workflow_id=?1",
      )
      .bind(run.workflow_id),
    control.core
      .prepare("UPDATE deployments SET status='running' WHERE deployment_id=?1")
      .bind(r.deploymentId),
  ]);
}

it("restores a native head that a reconciliation downgraded once its pending policy sync completes, and replays without change", async () => {
  const { r, input, scope, run, readers } = await pendingNativeHead();
  const status = () =>
    one<{ status: string }>("SELECT status FROM deployments WHERE deployment_id=?", r.deploymentId);
  expect(await status()).toEqual({ status: "succeeded" });
  await downgradeHead(r, run);
  expect(await status()).toEqual({ status: "running" });
  expect(await readers.rollback()).toBeNull();
  expect(await readers.paidDomain()).not.toEqual({
    gatewayScriptName: "ohmyho-gateway-production",
  });

  const pending = await r.store.provisioning.readPendingNativePolicySync(scope);
  if (!pending || pending.state !== "pending") throw new Error("Missing Native policy sync");
  const ack = {
    ...scope,
    headVersion: pending.headVersion,
    configurationRevision: pending.configurationRevision,
    revocationEpoch: pending.revocationEpoch,
    ownerEnabled: pending.ownerEnabled,
    canonicalOrigin: pending.canonicalOrigin,
    registryVersion: pending.registryVersion,
    acknowledgement: "applied" as const,
  };
  expect(await r.store.provisioning.completeNativePolicySync(ack)).toBe("completed");
  expect(await status()).toEqual({ status: "succeeded" });
  expect(await readers.rollback()).toMatchObject({ revisionId: input.publication.revisionId });
  expect(await readers.paidDomain()).toEqual({ gatewayScriptName: "ohmyho-gateway-production" });

  // A replay of the completed sync changes nothing.
  expect(await r.store.provisioning.completeNativePolicySync(ack)).toBe("replayed");
  expect(await status()).toEqual({ status: "succeeded" });
}, 60_000);

it("leaves a downgraded native head as it is when its policy sync was superseded before it completed", async () => {
  const { r, scope, run } = await pendingNativeHead();
  await downgradeHead(r, run);
  const pending = await r.store.provisioning.readPendingNativePolicySync(scope);
  if (!pending || pending.state !== "pending") throw new Error("Missing Native policy sync");
  // A newer head of the environment supersedes the deployment: its sync can no longer complete.
  await control.core
    .prepare("UPDATE environments SET head_version=head_version+1 WHERE environment_id=?1")
    .bind(r.scope.environmentId)
    .run();
  await expect(
    r.store.provisioning.completeNativePolicySync({
      ...scope,
      headVersion: pending.headVersion,
      configurationRevision: pending.configurationRevision,
      revocationEpoch: pending.revocationEpoch,
      ownerEnabled: pending.ownerEnabled,
      canonicalOrigin: pending.canonicalOrigin,
      registryVersion: pending.registryVersion,
      acknowledgement: "applied" as const,
    }),
  ).rejects.toThrow("Native policy acknowledgement changed");
  expect(
    await one<{ status: string }>(
      "SELECT status FROM deployments WHERE deployment_id=?",
      r.deploymentId,
    ),
  ).toEqual({ status: "running" });
}, 60_000);

it("retains a Native rollback pending until the exact private policy acknowledgement", async () => {
  const frameworkPlan = {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  };
  const { r, operationId, claimId, input } = await rollbackInput({ frameworkPlan });
  await control.core
    .prepare(
      "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
    )
    .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId, `https://${r.hostname}`)
    .run();
  await seedNativeRegistration(r.scope, operationId, claimId);
  const deniedContext = { directory: control.core, router: context(control.core).router };
  await expect(
    authorizeProductActivation(deniedContext, {
      organizationId: r.scope.organizationId,
      projectId: r.scope.projectId,
      operationId,
    }),
  ).rejects.toThrow("Native Auth launch unavailable");
  await expect(finalizeProductRollback(deniedContext, input)).rejects.toThrow(
    "Native Auth launch unavailable",
  );
  expect(
    await one(
      "SELECT count(*) n FROM wfp_rollback_activation_receipts WHERE operation_id=?",
      operationId,
    ),
  ).toEqual({ n: 0 });
  expect(
    await one(
      "SELECT head_version FROM environments WHERE environment_id=?",
      r.scope.environmentId,
    ),
  ).toEqual({ head_version: 1 });
  await finalizeProductRollback(context(control.core), input);
  await finalizeProductRollback(context(control.core), input);
  expect(
    await one<{ state: string }>(
      "SELECT state FROM operations WHERE organization_id=?1 AND operation_id=?2",
      r.scope.organizationId,
      operationId,
    ),
  ).toEqual({ state: "running" });
  const scope = { ...r.scope, operationId, claimId },
    pending = await r.store.provisioning.readPendingNativePolicySync(scope);
  if (!pending || pending.state !== "pending") throw new Error("Missing Native rollback sync");
  expect(pending).toMatchObject({
    headVersion: 2,
    targetDeploymentId: r.published.deploymentId,
    configurationRevision: 1,
    revocationEpoch: 1,
  });
  const ack = {
    ...scope,
    headVersion: pending.headVersion,
    configurationRevision: pending.configurationRevision,
    revocationEpoch: pending.revocationEpoch,
    ownerEnabled: pending.ownerEnabled,
    canonicalOrigin: pending.canonicalOrigin,
    registryVersion: pending.registryVersion,
    acknowledgement: "applied" as const,
  };
  expect(await r.store.provisioning.completeNativePolicySync(ack)).toBe("completed");
  expect(await r.store.provisioning.completeNativePolicySync(ack)).toBe("replayed");
});

it("fences a real Native to non-Native rollback until its new epoch is acknowledged", async () => {
  const r = await gatewayFixture(control);
  await releaseProviderClaim(r.project);
  const plan = {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  };
  const native = await seedPublishedClaim(r.project, r.scope.environmentId, (operationId) =>
    seedWfpPublication(r.project, {
      operationId,
      environmentId: r.scope.environmentId,
      frameworkPlan: plan,
      headVersion: 2,
      gatewayRevision: 2,
    }),
  );
  await releaseProviderClaim(r.project);
  const operationId = await seedOperation(r.project),
    intent = {
      ...(await rollbackIntent(r.project, operationId, r.scope.environmentId, r.published)),
      source_generation: 1,
    };
  const accepted = await seedAcceptedOperation(r.project, r.scope.environmentId, {
    eventType: "DeploymentRollbackRequestedV1",
    operationId,
    intent,
  });
  await control.core
    .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
    .bind(accepted.eventId, "2026-10-28T10:30:00.000000Z")
    .run();
  await control.core
    .prepare(
      "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
    )
    .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId, `https://${r.hostname}`)
    .run();
  await seedNativeRegistration(r.scope, native.claim.operationId, native.claim.claimId);
  const gateway = await r.store.gateway.management.activate({
    ...r.scope,
    operationId,
    claimId: accepted.claimId,
    expectedRevision: 2,
    candidateReceiptId: r.published.candidateReceiptId,
    egressAllowedOrigins: [],
  });
  const input = {
    activation: {
      ...r.scope,
      operationId,
      rollbackActivationReceiptId: newUlid(),
      rollbackDeploymentId: String(intent.deployment_id),
      targetDeploymentId: r.published.deploymentId,
      targetRevisionId: r.published.revisionId,
      candidateReceiptId: r.published.candidateReceiptId,
      wfpReceiptId: r.published.wfpReceiptId,
      gateway,
      expectedHeadVersion: 2,
      completedAt: "2026-10-28T12:00:00.000Z",
    },
    schedule: { crons: [], egressAllowedOrigins: [] },
    completion: {
      workflowId: accepted.workflowId,
      outboxEventId: accepted.eventId,
      startedOperationEventId: newUlid(),
      operationEventId: newUlid(),
      auditEventId: newUlid(),
      acceptedLifecycleVersion: 1,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    },
  };
  const deniedContext = { directory: control.core, router: context(control.core).router };
  await expect(
    authorizeProductActivation(deniedContext, {
      organizationId: r.scope.organizationId,
      projectId: r.scope.projectId,
      operationId,
    }),
  ).resolves.toEqual({ allowed: true });
  await finalizeProductRollback(deniedContext, input);
  const syncScope = { ...r.scope, operationId, claimId: accepted.claimId },
    pending = await r.store.provisioning.readPendingNativePolicySync(syncScope);
  if (!pending || pending.state !== "pending") throw new Error("Missing source-off policy sync");
  expect(pending).toMatchObject({
    revocationEpoch: 2,
    headVersion: 3,
    targetDeploymentId: r.published.deploymentId,
  });
  expect(
    await one<{ state: string }>(
      "SELECT state FROM operations WHERE organization_id=?1 AND operation_id=?2",
      r.scope.organizationId,
      operationId,
    ),
  ).toEqual({ state: "running" });
  const ack = {
    ...syncScope,
    headVersion: pending.headVersion,
    configurationRevision: pending.configurationRevision,
    revocationEpoch: pending.revocationEpoch,
    ownerEnabled: pending.ownerEnabled,
    canonicalOrigin: pending.canonicalOrigin,
    registryVersion: pending.registryVersion,
    acknowledgement: "applied" as const,
  };
  await expect(
    r.store.provisioning.completeNativePolicySync({ ...ack, revocationEpoch: 1 }),
  ).rejects.toThrow();
  expect(await r.store.provisioning.completeNativePolicySync(ack)).toBe("completed");
  expect(
    await one<{ state: string }>(
      "SELECT state FROM operations WHERE organization_id=?1 AND operation_id=?2",
      r.scope.organizationId,
      operationId,
    ),
  ).toEqual({ state: "succeeded" });
}, 60_000);

it("activates the retained rollback target, completes the Workflow, replays it and refuses a changed target", async () => {
  const { r, operationId, input } = await rollbackInput(),
    a = input.activation;
  await leaseOperation(operationId);
  await expect(
    finalizeProductRollback(context(control.core), {
      ...input,
      activation: { ...a, targetDeploymentId: newUlid() },
    }),
  ).rejects.toThrow("Rollback immutable candidate changed");
  await expect(
    finalizeProductRollback(context(control.core), {
      ...input,
      activation: { ...a, candidateReceiptId: newUlid() },
    }),
  ).rejects.toThrow("Shared gateway receipt scope changed");
  await finalizeProductRollback(context(losingWriteResponses(control.core, 1)), input);
  expect(
    await one(
      "SELECT active_deployment_id,active_revision_id,head_version FROM environments WHERE environment_id=?",
      r.scope.environmentId,
    ),
  ).toEqual({
    active_deployment_id: r.published.deploymentId,
    active_revision_id: r.published.revisionId,
    head_version: 2,
  });
  expect(
    await one(
      "SELECT target_deployment_id,activated_head_version,shared_gateway_revision FROM wfp_rollback_activation_receipts WHERE rollback_activation_receipt_id=?",
      a.rollbackActivationReceiptId,
    ),
  ).toEqual({
    target_deployment_id: r.published.deploymentId,
    activated_head_version: 2,
    shared_gateway_revision: 2,
  });
  expect(
    await one("SELECT status FROM deployments WHERE deployment_id=?", a.rollbackDeploymentId),
  ).toEqual({ status: "succeeded" });
  expect(
    await one(
      "SELECT state,result_deployment_id,lease_expires_at FROM operations WHERE operation_id=?",
      operationId,
    ),
  ).toEqual({
    state: "succeeded",
    result_deployment_id: r.published.deploymentId,
    lease_expires_at: null,
  });
  expect(
    await one(
      "SELECT state FROM product_workflow_runs WHERE workflow_id=?",
      input.completion.workflowId,
    ),
  ).toEqual({ state: "completed" });
  expect(
    await one(
      "SELECT count(*) n FROM product_provider_mutation_claims WHERE operation_id=?",
      operationId,
    ),
  ).toEqual({ n: 0 });
  await finalizeProductRollback(context(control.core), input);
  expect(
    await one(
      "SELECT head_version FROM environments WHERE environment_id=?",
      r.scope.environmentId,
    ),
  ).toEqual({ head_version: 2 });
}, 60_000);

it("activates the retained rollback target in one batch when its response arrives", async () => {
  const { r, operationId, input } = await rollbackInput();
  await finalizeProductRollback(context(control.core), input);
  expect(
    await one(
      "SELECT active_deployment_id,head_version FROM environments WHERE environment_id=?",
      r.scope.environmentId,
    ),
  ).toEqual({ active_deployment_id: r.published.deploymentId, head_version: 2 });
  expect(
    await one(
      "SELECT count(*) n FROM wfp_rollback_activation_receipts WHERE operation_id=?",
      operationId,
    ),
  ).toEqual({ n: 1 });
  expect(await one("SELECT state FROM operations WHERE operation_id=?", operationId)).toEqual({
    state: "succeeded",
  });
}, 60_000);

/**
 * A binding refresh of the published deployment: a new operation that reuses its artifact under a new script, pinned
 * to a frozen snapshot of the source, the gateway revision and the data assignment it was accepted against.
 */
async function refreshFixture(options: { frameworkPlan?: unknown } = {}) {
  const r = await gatewayFixture(control, options),
    { project } = r,
    db = control.core,
    environmentId = r.scope.environmentId,
    sourceScript = `p-${project.projectId.toLowerCase()}-prod-${r.published.deploymentId.toLowerCase()}`;
  await releaseProviderClaim(project);
  // The fixture publication keeps a free-form provider tag; the refresh snapshot names it as a 32-digit hex tag.
  const tag = "ab".repeat(16),
    frozen = ["wfp_candidate_receipts_no_update", "wfp_publish_receipts_no_update"],
    definitions = await Promise.all(
      frozen.map((name) =>
        one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", name),
      ),
    ),
    physical = newUlid();
  await db.batch([
    ...frozen.map((name) => db.prepare(`DROP TRIGGER ${name}`)),
    db
      .prepare("UPDATE wfp_candidate_receipts SET provider_tag=?2 WHERE candidate_receipt_id=?1")
      .bind(r.published.candidateReceiptId, tag),
    db
      .prepare("UPDATE wfp_publish_receipts SET provider_version_id=?2 WHERE wfp_receipt_id=?1")
      .bind(r.published.wfpReceiptId, tag),
    ...definitions.map((definition) => db.prepare(definition.sql)),
    db
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(project.organizationId, project.projectId, physical, STORED_NOW),
    db
      .prepare(
        "INSERT INTO environment_data_assignments(organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at) VALUES(?1,?2,1,?3,?4,?5)",
      )
      .bind(project.organizationId, environmentId, project.projectId, physical, STORED_NOW),
  ]);
  const operationId = await seedOperation(project),
    deploymentId = newUlid(),
    candidateReceiptId = newUlid(),
    source = await one<{ source_connection_id: string }>(
      "SELECT source_connection_id FROM deployment_plans WHERE plan_id=?",
      r.published.planId,
    ),
    snapshot = {
      sourceDeploymentId: r.published.deploymentId,
      sourceRevisionId: r.published.revisionId,
      sourceCandidateReceiptId: r.published.candidateReceiptId,
      sourceArtifactId: r.published.artifactId,
      sourcePlanId: r.published.planId,
      sourceBuildExecutionId: r.published.buildExecutionId,
      sourceArtifactSha256: "03".repeat(32),
      sourceNamespace: "ohmyho-production",
      sourceScriptName: sourceScript,
      sourceProviderTag: tag,
      expectedHeadVersion: 1,
      expectedGatewayRevision: 1,
      dataEnvironmentId: physical,
      assignmentVersion: 1,
      registrationVersion: 0,
    };
  await db.batch([
    db
      .prepare(
        "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','running',0,?6,?6)",
      )
      .bind(
        project.organizationId,
        deploymentId,
        project.projectId,
        environmentId,
        operationId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO wfp_candidate_receipts(candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'ohmyho-production',?8,?9,?10,1,?11)",
      )
      .bind(
        candidateReceiptId,
        project.organizationId,
        project.projectId,
        environmentId,
        operationId,
        deploymentId,
        r.published.artifactId,
        `p-${project.projectId.toLowerCase()}-prod-${deploymentId.toLowerCase()}`,
        new Uint8Array(32).fill(3),
        "cd".repeat(16),
        STORED_NOW,
      ),
  ]);
  const accepted = await seedAcceptedOperation(project, environmentId, {
    operationId,
    intent: {
      plan_id: r.published.planId,
      source_connection_id: source.source_connection_id,
      deployment_id: deploymentId,
      source_generation: 1,
      binding_refresh_snapshot: JSON.stringify(snapshot),
    },
  });
  await db.batch([
    db
      .prepare(
        "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'DeploymentRequestedV1','service','binding-refresh',?5,?6,?7)",
      )
      .bind(
        project.organizationId,
        newUlid(),
        project.projectId,
        operationId,
        JSON.stringify({ bindingRefreshSnapshot: snapshot, acceptedLifecycleVersion: 1 }),
        STORED_NOW,
        project.billingEpochId,
      ),
    db
      .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
      .bind(accepted.eventId, "2026-10-28T10:30:00.000000Z"),
  ]);
  return {
    r,
    accepted,
    operationId,
    deploymentId,
    candidateReceiptId,
    snapshot,
    scope: { ...r.scope, operationId },
    sourceHash: await resourceHash(
      "cloudflare",
      "wfp-script",
      `${snapshot.sourceNamespace}/${snapshot.sourceScriptName}`,
    ),
  };
}

/** Activates the refresh candidate on the shared gateway and publishes it; the Workflow's finish is still open. */
async function publishRefresh(f: Awaited<ReturnType<typeof refreshFixture>>, db = control.core) {
  const gateway = await f.r.store.gateway.management.activate({
    ...f.r.scope,
    operationId: f.operationId,
    claimId: f.accepted.claimId,
    expectedRevision: 1,
    candidateReceiptId: f.candidateReceiptId,
    egressAllowedOrigins: [],
  });
  await finalizeProductCandidate(context(db), {
    eventType: "DeploymentRequestedV1",
    bindingRefreshSnapshot: f.snapshot,
    publication: {
      ...f.scope,
      candidateReceiptId: f.candidateReceiptId,
      wfpReceiptId: newUlid(),
      revisionId: f.operationId,
      productDeploymentId: f.deploymentId,
      expectedHeadVersion: 1,
      deploymentUrl: gateway.publicOrigin,
      publishedAt: "2026-10-28T12:00:00.000Z",
      gateway,
    },
    schedule: { crons: [], egressAllowedOrigins: [] },
    completion: null,
  });
  const completion = {
    workflowId: f.accepted.workflowId,
    outboxEventId: f.accepted.eventId,
    startedOperationEventId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    acceptedLifecycleVersion: 1,
    runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    result: {
      schemaVersion: "ohmyhost.operation-deployment-result/v2",
      operationId: f.operationId,
      deploymentId: f.deploymentId,
      planId: f.r.published.planId,
      artifactSha256: "03".repeat(32),
      url: gateway.publicOrigin,
    },
  };
  return {
    gateway,
    completion,
    finish: { ...f.scope, completedAt: "2026-10-28T12:01:00.000Z", completion },
  };
}

/** The retired source script is recorded as removed, which a refresh must prove before it finishes. */
async function retireSourceScript(f: Awaited<ReturnType<typeof refreshFixture>>) {
  const { organizationId, projectId } = f.r.scope;
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),?6,'encoded/c3ludGhldGlj')",
      )
      .bind(organizationId, newUlid(), projectId, f.operationId, f.sourceHash, STORED_NOW),
    control.core
      .prepare(
        "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,attempted_at) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),'removed',?6)",
      )
      .bind(newUlid(), organizationId, projectId, f.operationId, f.sourceHash, STORED_NOW),
  ]);
}

const operationOf = (operationId: string) =>
  one(
    "SELECT state,result_deployment_id,result_url,lease_expires_at FROM operations WHERE operation_id=?",
    operationId,
  );

it("keeps a Native binding refresh pending through cleanup and exact policy ACK", async () => {
  const plan = {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  };
  const f = await refreshFixture({ frameworkPlan: plan });
  await control.core
    .prepare(
      "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
    )
    .bind(
      f.r.scope.organizationId,
      f.r.scope.projectId,
      f.r.scope.environmentId,
      `https://${f.r.hostname}`,
    )
    .run();
  await seedNativeRegistration(f.r.scope, f.operationId, f.accepted.claimId);
  const { finish } = await publishRefresh(f, losingWriteResponses(control.core, 1)),
    scope = { ...f.scope, claimId: f.accepted.claimId };
  expect(await f.r.store.provisioning.readPendingNativePolicySync(scope)).toMatchObject({
    state: "cleanup_required",
    headVersion: 2,
    targetDeploymentId: f.deploymentId,
  });
  await expect(finishProductBindingRefresh(context(control.core), finish)).rejects.toThrow();
  await retireSourceScript(f);
  expect(await finishProductBindingRefresh(context(control.core), finish)).toBe(
    "native_policy_pending",
  );
  expect(await finishProductBindingRefresh(context(control.core), finish)).toBe(
    "native_policy_pending",
  );
  expect(await operationOf(f.operationId)).toMatchObject({ state: "running" });
  const pending = await f.r.store.provisioning.readPendingNativePolicySync(scope);
  if (!pending || pending.state !== "pending") throw new Error("Missing Native refresh policy");
  const ack = {
    ...scope,
    headVersion: pending.headVersion,
    configurationRevision: pending.configurationRevision,
    revocationEpoch: pending.revocationEpoch,
    ownerEnabled: pending.ownerEnabled,
    canonicalOrigin: pending.canonicalOrigin,
    registryVersion: pending.registryVersion,
    acknowledgement: "applied" as const,
  };
  await control.core
    .prepare(
      "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,error_code,attempted_at) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),'failed','RETRY','2026-10-28T12:02:00.000000Z')",
    )
    .bind(newUlid(), scope.organizationId, scope.projectId, scope.operationId, f.sourceHash)
    .run();
  await expect(f.r.store.provisioning.completeNativePolicySync(ack)).rejects.toThrow();
  await control.core
    .prepare(
      "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,attempted_at) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),'removed','2026-10-28T12:03:00.000000Z')",
    )
    .bind(newUlid(), scope.organizationId, scope.projectId, scope.operationId, f.sourceHash)
    .run();
  expect(await f.r.store.provisioning.completeNativePolicySync(ack)).toBe("completed");
  expect(await f.r.store.provisioning.readPendingNativePolicySync(scope)).toMatchObject({
    state: "completed",
  });
  expect(await finishProductBindingRefresh(context(control.core), finish)).toBe("replayed");
}, 60_000);

it("proves, publishes and finishes a binding refresh against its frozen source snapshot", async () => {
  const f = await refreshFixture(),
    assertRefresh = (db = control.core, patch: object = {}) =>
      assertProductBindingRefresh(context(db), {
        ...f.scope,
        snapshot: f.snapshot,
        allowPublished: false,
        ...patch,
      });
  await expect(assertRefresh()).resolves.toBeUndefined();
  await expect(assertRefresh(losingWriteResponses(control.core, 1))).resolves.toBeUndefined();
  await expect(
    assertRefresh(control.core, { snapshot: { ...f.snapshot, expectedHeadVersion: 2 } }),
  ).rejects.toThrow("Binding refresh accepted snapshot changed");
  await expect(
    assertProductBindingRefresh(context(control.core), {
      ...f.scope,
      operationId: f.r.accepted.operationId,
      snapshot: f.snapshot,
      allowPublished: false,
    }),
  ).rejects.toThrow("Binding refresh snapshot is absent");

  const { gateway, completion, finish } = await publishRefresh(f);
  expect(
    await one(
      "SELECT active_deployment_id,active_revision_id,head_version FROM environments WHERE environment_id=?",
      f.r.scope.environmentId,
    ),
  ).toEqual({
    active_deployment_id: f.deploymentId,
    active_revision_id: f.operationId,
    head_version: 2,
  });
  // A refresh publication leaves the operation and Workflow to its own finish.
  expect(await operationOf(f.operationId)).toMatchObject({ state: "running" });
  await expect(assertRefresh(control.core, { allowPublished: true })).resolves.toBeUndefined();

  // The retired source script must be proven absent first.
  await expect(finishProductBindingRefresh(context(control.core), finish)).rejects.toThrow();
  await retireSourceScript(f);
  await expect(
    finishProductBindingRefresh(context(control.core), {
      ...finish,
      completion: { ...completion, result: { ...completion.result, planId: newUlid() } },
    }),
  ).rejects.toThrow("Finalized WFP deployment result changed");
  await leaseOperation(f.operationId);
  expect(await finishProductBindingRefresh(context(control.core), finish)).toBe("completed");
  expect(await operationOf(f.operationId)).toEqual({
    state: "succeeded",
    result_deployment_id: f.deploymentId,
    result_url: gateway.publicOrigin,
    lease_expires_at: null,
  });
  expect(
    await one("SELECT state FROM product_workflow_runs WHERE workflow_id=?", completion.workflowId),
  ).toEqual({ state: "completed" });
  expect(
    await one(
      "SELECT count(*) n FROM product_provider_mutation_claims WHERE operation_id=?",
      f.operationId,
    ),
  ).toEqual({ n: 0 });
  expect(await finishProductBindingRefresh(context(control.core), finish)).toBe("replayed");
}, 60_000);

it("recovers a committed binding refresh finish whose response was lost", async () => {
  const f = await refreshFixture(),
    { finish } = await publishRefresh(f);
  await retireSourceScript(f);
  await leaseOperation(f.operationId);
  expect(
    await finishProductBindingRefresh(context(losingWriteResponses(control.core, 1)), finish),
  ).toBe("replayed");
  expect(await operationOf(f.operationId)).toMatchObject({
    state: "succeeded",
    lease_expires_at: null,
  });
}, 60_000);

it("refuses a binding refresh while another operation runs or a database cutover is pending", async () => {
  const f = await refreshFixture(),
    assertRefresh = () =>
      assertProductBindingRefresh(context(control.core), {
        ...f.scope,
        snapshot: f.snapshot,
        allowPublished: false,
      });
  await expect(assertRefresh()).resolves.toBeUndefined();
  // A cutover authorization without a release blocks every refresh of the project.
  const cutover = await seedOperation(f.r.project, { state: "queued" });
  await control.core
    .prepare(
      "INSERT INTO database_provider_cutover_authorizations(organization_id, operation_id, project_id, physical_environment_id, manifest_sha256, expected_lifecycle_version, source_target_version, source_registration, target_provider_project_id, target_region_id, target_size_class_id, approved_at, approved_by) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, '{}', 'prj_abcdefghijklmnopqrst', 'us-dev', 'small', ?6, 'owner')",
    )
    .bind(
      f.r.scope.organizationId,
      cutover,
      f.r.scope.projectId,
      f.snapshot.dataEnvironmentId,
      new Uint8Array(32),
      STORED_NOW,
    )
    .run();
  await expect(assertRefresh()).rejects.toThrow("lost the race");
}, 60_000);
