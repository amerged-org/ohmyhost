import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import {
  readProductProviderReconciliationContext,
  readProductProviderReconciliationPlan,
} from "../../src/catalog/provisioning/provider-reconciliation.js";
import {
  rollbackIntent,
  seedAcceptedOperation,
  seedOperation,
} from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  STORED_NOW,
  bytes,
  seedProject,
  type SeededProject,
} from "../support/platform-fixtures.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";

/**
 * The reconciliation context reads the same provider facts as the Workflow context, but only for a workflow that
 * stopped at an uncertain observation. Each scenario leaves the Workflow in that state and reads the plan.
 */
let c: TestControl;
let context: { directory: TestControl["core"]; router: SharedCoreRouter };
beforeAll(async () => {
  c = await createTestControl();
  context = { directory: c.core, router: new SharedCoreRouter(c.core) };
});
afterAll(async () => c.dispose());

const POLICY = { healthCheckPath: "/healthz", egressAllowedOrigins: ["https://api.example.test"] };

/** The claimed workflow of `operationId` stops at an uncertain provider observation carrying `hint`. */
async function stopUncertain(
  project: SeededProject,
  operationId: string,
  workflowId: string,
  hint: unknown,
) {
  await c.core.batch([
    c.core
      .prepare(
        "UPDATE deployments SET status='reconciliation_required' WHERE organization_id=?1 AND operation_id=?2",
      )
      .bind(project.organizationId, operationId),
    c.core
      .prepare(
        "UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code='PROVIDER_OBSERVATION_UNCERTAIN',intermediate_evidence=?2 WHERE workflow_id=?1",
      )
      .bind(workflowId, JSON.stringify({ providerReconciliationHint: hint })),
  ]);
}

const scopeOf = (
  project: SeededProject,
  environmentId: string,
  accepted: { operationId: string; claimId: string },
) => ({
  organizationId: project.organizationId,
  projectId: project.projectId,
  environmentId,
  operationId: accepted.operationId,
  claimId: accepted.claimId,
});

describe("provider reconciliation context", () => {
  it("has no context and no guards for a claim whose workflow is not waiting for reconciliation", async () => {
    const project = await seedProject(c),
      accepted = await seedAcceptedOperation(project, project.devEnvironmentId),
      plan = await readProductProviderReconciliationPlan(
        context,
        scopeOf(project, project.devEnvironmentId, accepted),
      );
    expect(plan.value).toBeNull();
    expect(plan.guards(c.core)).toEqual([]);
    expect(
      await readProductProviderReconciliationContext(
        context,
        scopeOf(project, project.devEnvironmentId, accepted),
      ),
    ).toBeNull();
  });

  it("reads known deployments, the current runtime release and both rollback targets, and guards exactly those facts", async () => {
    const project = await seedProject(c),
      production = project.prodEnvironmentId,
      published = await seedWfpPublication(project, {
        operationId: await seedOperation(project, { state: "running" }),
        environmentId: production,
      }),
      accepted = await seedAcceptedOperation(project, production, {
        eventType: "DeploymentRollbackRequestedV1",
        intent: (operationId) =>
          rollbackIntent(project, operationId, production, {
            deploymentId: published.deploymentId,
            revisionId: published.revisionId,
            artifactId: published.artifactId,
          }),
      });
    // the runtime secret release names a provider tag no receipt knows: it joins the known deployments
    await c.core
      .prepare(
        "UPDATE runtime_secret_delivery_states SET provider_tag='runtime-release-tag' WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(project.organizationId, project.projectId, production)
      .run();
    await stopUncertain(project, accepted.operationId, accepted.workflowId, {
      phase: "wfp",
      activationRuntimePolicy: POLICY,
    });

    const scope = scopeOf(project, production, accepted),
      plan = await readProductProviderReconciliationPlan(context, scope);
    expect(plan.value).toMatchObject({
      eventType: "DeploymentRollbackRequestedV1",
      hasActiveGateway: true,
      providerHint: { phase: "wfp", activationRuntimePolicy: POLICY },
      wfpTarget: { runtimePolicy: POLICY },
      retainedWfpTarget: { runtimePolicy: expect.objectContaining({ healthCheckPath: "/" }) },
    });
    expect(plan.value?.knownDeployments.map((known) => known.providerTag).sort()).toEqual([
      "exact-fixture-tag",
      "runtime-release-tag",
    ]);

    // the guards hold while nothing changed and refuse the effect once a read fact moved
    await c.core.batch(plan.guards(c.core));
    await c.core
      .prepare(
        "UPDATE runtime_secret_delivery_states SET provider_tag='rotated-release-tag' WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(project.organizationId, project.projectId, production)
      .run();
    await expect(c.core.batch(plan.guards(c.core))).rejects.toThrow(/operation_conflict/u);
  });

  it("reads the abandoned candidate of an earlier command that never published", async () => {
    const project = await seedProject(c),
      environment = project.devEnvironmentId,
      old = await seedAcceptedOperation(project, environment, { claim: false });
    // the earlier command was ended as abandoned after it staged a candidate
    const oldDeployment = old.intent.deployment_id ?? "",
      artifact = newUlid(),
      upload = newUlid(),
      build = newUlid();
    await c.core.batch([
      c.core.prepare("PRAGMA defer_foreign_keys=ON"),
      c.core
        .prepare(
          'UPDATE operations SET state=\'failed\',failure=\'{"code":"OPERATION_ABANDONED","message":"ended"}\' WHERE organization_id=?1 AND operation_id=?2',
        )
        .bind(project.organizationId, old.operationId),
      c.core
        .prepare(
          "UPDATE product_workflow_runs SET state='completed',terminal_evidence='{\"errorCode\":\"OPERATION_ABANDONED\"}',completed_at=?2 WHERE workflow_id=?1",
        )
        .bind(old.workflowId, STORED_NOW),
      c.core
        .prepare("UPDATE deployments SET status='failed' WHERE deployment_id=?1")
        .bind(oldDeployment),
      c.core
        .prepare(
          "INSERT INTO build_source_uploads(upload_id,organization_id,project_id,operation_id,source_connection_id,commit_sha,bucket_name,object_key,object_version_id,state,claim_id,claimed_at,lease_expires_at,attempt_number,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'source-fixture','source','exact-version','completed',?7,?8,'2026-10-28T11:00:00.000000Z',1,?8,?8)",
        )
        .bind(
          upload,
          project.organizationId,
          project.projectId,
          old.operationId,
          old.intent.source_connection_id ?? "",
          "a".repeat(40),
          newUlid(),
          STORED_NOW,
        ),
      c.core
        .prepare(
          "INSERT INTO build_executions(build_execution_id,organization_id,project_id,operation_id,source_upload_id,build_plan_sha256,build_project_name,provider_build_id,state,attempt_number,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'fixture-build','exact-build','succeeded',1,?7,?7)",
        )
        .bind(
          build,
          project.organizationId,
          project.projectId,
          old.operationId,
          upload,
          bytes(32, 3),
          STORED_NOW,
        ),
      c.core
        .prepare(
          "INSERT INTO build_artifacts(artifact_id,organization_id,project_id,build_execution_id,artifact_sha256,manifest_sha256,sbom_sha256,object_version_ref,created_at) VALUES(?1,?2,?3,?4,?5,?5,?5,'exact-artifact',?6)",
        )
        .bind(artifact, project.organizationId, project.projectId, build, bytes(32, 3), STORED_NOW),
      c.core
        .prepare(
          "INSERT INTO wfp_candidate_receipts(candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'ohmyho-production',?8,?9,'abandoned-tag',0,?10)",
        )
        .bind(
          newUlid(),
          project.organizationId,
          project.projectId,
          environment,
          old.operationId,
          oldDeployment,
          artifact,
          `p-${project.projectId.toLowerCase()}-dev-${oldDeployment.toLowerCase()}`,
          bytes(32, 3),
          STORED_NOW,
        ),
    ]);
    const current = await seedAcceptedOperation(project, environment);
    await stopUncertain(project, current.operationId, current.workflowId, { phase: "source" });

    const read = await readProductProviderReconciliationContext(
      context,
      scopeOf(project, environment, current),
    );
    expect(read?.abandonedWfpTargets).toHaveLength(1);
    expect(read?.abandonedWfpTargets?.[0]).toMatchObject({
      operationId: old.operationId,
      candidate: { providerTag: "abandoned-tag", productDeploymentId: oldDeployment },
      runtimePolicy: { healthCheckPath: "/" },
    });
    expect(read?.hasActiveGateway).toBe(false);
  });
});
