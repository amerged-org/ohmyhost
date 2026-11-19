import { newUlid } from "../../src/catalog/common.js";
import { seedOperation } from "./accepted-operation.js";
import { STORED_NOW, bytes, type SeededProject } from "./platform-fixtures.js";
import { seedDeploymentPlan, sourceFrameworkPlan } from "./provider-fixtures.js";

/** What the candidate cleanup commands expect of the two provider resources a staged candidate leaves behind. */
export const SOURCE_ARCHIVE_LOCATOR = "source-fixture/source/exact-version";
export const BUILD_ARTIFACT_LOCATOR = "exact-artifact";

export async function resourceDigest(kind: string, locator: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`cloudflare\0${kind}\0${locator}`),
    ),
  );
}

/** The expected cleanup resources of a candidate in the order the commands report them (kind, then digest). */
export async function candidateResources() {
  return [
    {
      provider: "cloudflare" as const,
      resourceKind: "build-artifact" as const,
      resourceIdentityDigest: await resourceDigest("build-artifact", BUILD_ARTIFACT_LOCATOR),
    },
    {
      provider: "cloudflare" as const,
      resourceKind: "source-archive" as const,
      resourceIdentityDigest: await resourceDigest("source-archive", SOURCE_ARCHIVE_LOCATOR),
    },
  ];
}

/**
 * A staged, never published WFP candidate with the real rows it hangs on: the source upload and archive evidence,
 * the build and its artifact, the running deployment and the candidate receipt itself (migration 0334/0336 triggers
 * stay active). `seedWfpPublication` always publishes; cleanup needs the candidate before that.
 */
export async function seedCandidate(
  project: SeededProject,
  options: { environmentId?: string; operationId?: string; stagedAt?: string } = {},
) {
  const db = project.shard,
    environmentId = options.environmentId ?? project.devEnvironmentId,
    operationId = options.operationId ?? (await seedOperation(project)),
    staged = options.stagedAt ?? STORED_NOW,
    ids = {
      candidateReceiptId: newUlid(),
      deploymentId: newUlid(),
      uploadId: newUlid(),
      buildExecutionId: newUlid(),
      artifactId: newUlid(),
      planId: newUlid(),
    };
  const { sourceConnectionId } = await seedDeploymentPlan(
    project,
    ids.planId,
    sourceFrameworkPlan(false),
    environmentId,
  );
  const name = environmentId === project.devEnvironmentId ? "dev" : "prod";
  const script = `p-${project.projectId.toLowerCase()}-${name}-${ids.deploymentId.toLowerCase()}`;
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
        operationId,
        sourceConnectionId,
        "a".repeat(40),
        newUlid(),
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO product_source_archive_objects(operation_id,organization_id,project_id,environment_id,bucket_name,object_key,object_version_id,object_etag,byte_length,source_sha256,recorded_at) VALUES(?1,?2,?3,?4,'source-fixture','source','exact-version','etag',10,?5,?6)",
      )
      .bind(
        operationId,
        project.organizationId,
        project.projectId,
        environmentId,
        bytes(32, 3),
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
        operationId,
        ids.uploadId,
        bytes(32, 3),
        STORED_NOW,
      ),
    db
      .prepare(
        `INSERT INTO build_artifacts(artifact_id,organization_id,project_id,build_execution_id,artifact_sha256,manifest_sha256,sbom_sha256,object_version_ref,created_at) VALUES(?1,?2,?3,?4,?5,?5,?5,'${BUILD_ARTIFACT_LOCATOR}',?6)`,
      )
      .bind(
        ids.artifactId,
        project.organizationId,
        project.projectId,
        ids.buildExecutionId,
        bytes(32, 3),
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','running',0,?6,?6)",
      )
      .bind(
        project.organizationId,
        ids.deploymentId,
        project.projectId,
        environmentId,
        operationId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO wfp_candidate_receipts(candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'ohmyho-production',?8,?9,'exact-fixture-tag',0,?10)",
      )
      .bind(
        ids.candidateReceiptId,
        project.organizationId,
        project.projectId,
        environmentId,
        operationId,
        ids.deploymentId,
        ids.artifactId,
        script,
        bytes(32, 3),
        staged,
      ),
  ]);
  /** The `candidate` input of `prepareProductCandidateCleanup`. */
  const candidate = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    candidateReceiptId: ids.candidateReceiptId,
    environmentId,
    operationId,
    productDeploymentId: ids.deploymentId,
    artifactId: ids.artifactId,
    namespace: "ohmyho-production",
    immutableScriptName: script,
    artifactDigest: bytes(32, 3),
    providerTag: "exact-fixture-tag",
    buildReused: false,
    stagedAt: `${staged.slice(0, 23)}Z`,
  };
  return { ...ids, environmentId, operationId, script, candidate };
}
