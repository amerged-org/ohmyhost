import type { SeededProject } from "../support/platform-fixtures.js";
import { STORED_NOW, bytes } from "../support/platform-fixtures.js";
import { seedDeploymentPlan, sourceFrameworkPlan } from "../support/provider-fixtures.js";
import { newUlid } from "../../src/catalog/common.js";
/** Qualified publication fixture with an actual immutable output locator and binding-refresh tag. */
export async function seedContextPublication(
  project: SeededProject,
  input: {
    operationId: string;
    environmentId?: string;
    frameworkPlan?: unknown;
    stagedAt?: string;
    headVersion?: number;
    deploymentId?: string;
    revisionId?: string;
    planId?: string;
    candidateReceiptId?: string;
    wfpReceiptId?: string;
  },
) {
  const db = project.shard,
    env = input.environmentId ?? project.prodEnvironmentId,
    op = input.operationId;
  const ids = {
    deploymentId: input.deploymentId ?? newUlid(),
    revisionId: input.revisionId ?? newUlid(),
    planId: input.planId ?? newUlid(),
    candidateReceiptId: input.candidateReceiptId ?? newUlid(),
    wfpReceiptId: input.wfpReceiptId ?? newUlid(),
    uploadId: newUlid(),
    buildExecutionId: newUlid(),
    artifactId: newUlid(),
  };
  const frame =
    input.frameworkPlan === undefined ? sourceFrameworkPlan(false) : input.frameworkPlan;
  await seedDeploymentPlan(project, ids.planId, frame, env);
  const connection = (
    await db
      .prepare(
        "SELECT source_connection_id FROM deployment_plans WHERE organization_id=? AND plan_id=?",
      )
      .bind(project.organizationId, ids.planId)
      .first<{ source_connection_id: string }>()
  )?.source_connection_id;
  if (!connection) throw new Error("source fixture plan missing");
  const name = (
    await db
      .prepare("SELECT name FROM environments WHERE organization_id=? AND environment_id=?")
      .bind(project.organizationId, env)
      .first<{ name: string }>()
  )?.name;
  if (name !== "dev" && name !== "prod")
    throw new Error("source fixture requires native environment");
  const script = `p-${project.projectId.toLowerCase()}-${name}-${ids.deploymentId.toLowerCase()}`;
  const url = `https://${name === "dev" ? "dev-" : ""}${project.handle}.check.omh.st`,
    staged = input.stagedAt ?? STORED_NOW;
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys=ON"),
    db
      .prepare(
        "INSERT INTO build_source_uploads(upload_id,organization_id,project_id,operation_id,source_connection_id,commit_sha,bucket_name,object_key,object_version_id,state,claim_id,claimed_at,lease_expires_at,attempt_number,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'source-fixture','source','exact-version','completed',?7,?8,'2026-10-28T11:00:00.000000Z',1,?8,?8)",
      )
      .bind(
        ids.uploadId,
        project.organizationId,
        project.projectId,
        op,
        connection,
        "a".repeat(40),
        newUlid(),
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO build_executions(build_execution_id,organization_id,project_id,operation_id,source_upload_id,build_plan_sha256,build_project_name,provider_build_id,state,attempt_number,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'fixture-build','exact-build','succeeded',1,?7,?7)",
      )
      .bind(
        ids.buildExecutionId,
        project.organizationId,
        project.projectId,
        op,
        ids.uploadId,
        bytes(32, 3),
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO build_artifacts(artifact_id,organization_id,project_id,build_execution_id,artifact_sha256,manifest_sha256,sbom_sha256,object_version_ref,created_at) VALUES(?1,?2,?3,?4,?5,?5,?5,?7,?6)",
      )
      .bind(
        ids.artifactId,
        project.organizationId,
        project.projectId,
        ids.buildExecutionId,
        bytes(32, 3),
        STORED_NOW,
        `r2-version:ohmyho-builds-production-eu/runs/${project.projectId}/${env}/${op}/output/bundle.tar.gz#${"a".repeat(32)}`,
      ),
    db
      .prepare(
        "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_revision_id,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','succeeded',?6,1,?7,?7)",
      )
      .bind(
        project.organizationId,
        ids.deploymentId,
        project.projectId,
        env,
        op,
        ids.revisionId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO cloudflare_project_domains(organization_id,project_id,operation_id,handle,zone_name,production_domain,development_domain,mail_domain,configured_by_principal_id,idempotency_key_sha256,request_sha256,configured_at) VALUES(?1,?2,?3,?4,'omh.st',?5,?6,NULL,'user:fixture',?7,?7,?8)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        op,
        project.handle,
        project.handle + ".check.omh.st",
        "dev-" + project.handle + ".check.omh.st",
        bytes(32, 3),
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO wfp_candidate_receipts(candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'ohmyho-production',?8,?9,'ffffffffffffffffffffffffffffffff',0,?10)",
      )
      .bind(
        ids.candidateReceiptId,
        project.organizationId,
        project.projectId,
        env,
        op,
        ids.deploymentId,
        ids.artifactId,
        script,
        bytes(32, 3),
        staged,
      ),
    db
      .prepare(
        "INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,observed_at) VALUES(?1,?2,?3,1,?4,?5,'activate',1,?6,?7,'[]',?8)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        env,
        op,
        ids.candidateReceiptId,
        project.handle,
        url,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO wfp_publish_receipts(wfp_receipt_id,organization_id,project_id,environment_id,artifact_id,dispatch_namespace,script_name,provider_version_id,deployment_url,published_at,candidate_receipt_id,product_deployment_id,shared_gateway_revision) VALUES(?1,?2,?3,?4,?5,'ohmyho-production',?6,'ffffffffffffffffffffffffffffffff',?7,?8,?9,?10,1)",
      )
      .bind(
        ids.wfpReceiptId,
        project.organizationId,
        project.projectId,
        env,
        ids.artifactId,
        script,
        url,
        STORED_NOW,
        ids.candidateReceiptId,
        ids.deploymentId,
      ),
    db
      .prepare(
        "INSERT INTO deployment_revisions(organization_id,revision_id,project_id,deployment_id,plan_id,build_execution_id,artifact_id,wfp_receipt_id,operation_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
      )
      .bind(
        project.organizationId,
        ids.revisionId,
        project.projectId,
        ids.deploymentId,
        ids.planId,
        ids.buildExecutionId,
        ids.artifactId,
        ids.wfpReceiptId,
        op,
        STORED_NOW,
      ),
    db
      .prepare(
        "UPDATE environments SET active_deployment_id=?3,active_revision_id=?4,head_version=?5 WHERE organization_id=?1 AND environment_id=?2",
      )
      .bind(project.organizationId, env, ids.deploymentId, ids.revisionId, input.headVersion ?? 1),
  ]);
  return ids;
}
