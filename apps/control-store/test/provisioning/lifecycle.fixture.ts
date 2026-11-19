import { createHash } from "node:crypto";
import type { D1Database } from "../../src/d1-types.js";
import { newUlid, type CatalogContext } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import {
  bytes,
  STORED_NOW,
  type SeededProject,
  type ProjectScope,
} from "../support/platform-fixtures.js";
import {
  deploymentIntent,
  seedAcceptedOperation,
  seedOperation,
} from "../support/accepted-operation.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";

export const lifecycleContext = (db: D1Database): CatalogContext => ({
  directory: db,
  router: new SharedCoreRouter(db),
});

/** The accepted deletion of a project: queued operation, pending cleanup run, deletion intent, acknowledged outbox event. */
export async function acceptDeletion(
  project: ProjectScope & { readonly devEnvironmentId: string },
  options: {
    readonly cleanup?: "pending" | "running";
    /** Fixed identities for fixtures whose Workflow is started by a command with these ids. */
    readonly operationId?: string;
    readonly eventId?: string;
    readonly workflowId?: string;
    /** Prod-only projects use their real Prod anchor. */
    readonly environmentId?: string;
  } = {},
) {
  const db = project.shard,
    operationId = await seedOperation(project, {
      state: "queued",
      operationId: options.operationId ?? newUlid(),
    }),
    cleanupRunId = newUlid();
  await db
    .prepare(
      "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,1,?6,?6)",
    )
    .bind(
      project.organizationId,
      cleanupRunId,
      project.projectId,
      operationId,
      options.cleanup ?? "pending",
      STORED_NOW,
    )
    .run();
  const accepted = await seedAcceptedOperation(
    project,
    options.environmentId ?? project.devEnvironmentId,
    {
      eventType: "ProjectDeletionRequestedV1",
      operationId,
      eventId: options.eventId ?? newUlid(),
      workflowId: options.workflowId ?? newUlid(),
      claim: false,
      intent: { expected_etag: `"${"a".repeat(64)}"`, cleanup_run_id: cleanupRunId },
    },
  );
  await db
    .prepare(
      "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(project.organizationId, project.projectId)
    .run();
  await acknowledgeOutbox(project, accepted.eventId);
  return { ...accepted, cleanupRunId };
}

/** The Workflow only completes an operation whose start event was delivered and acknowledged. */
export async function acknowledgeOutbox(project: ProjectScope, eventId: string) {
  await project.shard
    .prepare("UPDATE outbox_events SET acknowledged_at=?3 WHERE organization_id=?1 AND event_id=?2")
    .bind(project.organizationId, eventId, STORED_NOW)
    .run();
}

/** Every identity field the lifecycle commands share, for an accepted operation of `accepted`. */
export function lifecycleIdentity(
  project: ProjectScope,
  environmentId: string,
  accepted: { readonly operationId: string; readonly eventId: string; readonly workflowId: string },
  completedAt = "2026-10-28T12:00:00.000Z",
) {
  return {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId,
    operationId: accepted.operationId,
    workflowId: accepted.workflowId,
    outboxEventId: accepted.eventId,
    startedOperationEventId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    completedAt,
  };
}

/** A deployment accepted for a build: operation, plan, deployment and intent (no provider claim). */
export async function acceptBuild(project: SeededProject, environmentId: string) {
  const operationId = await seedOperation(project, { state: "running" }),
    accepted = await seedAcceptedOperation(project, environmentId, {
      operationId,
      claim: false,
      intent: await deploymentIntent(project, operationId, environmentId),
    });
  return { operationId, planId: accepted.intent.plan_id, accepted };
}

/** Real build rows of an accepted deployment whose artifact lives at `objectVersionRef`. */
export async function seedBuildArtifact(
  project: ProjectScope,
  operationId: string,
  objectVersionRef: string,
) {
  const db = project.shard,
    sourceConnection = (
      await db
        .prepare(
          "SELECT source_connection_id FROM product_command_intents WHERE organization_id=?1 AND operation_id=?2",
        )
        .bind(project.organizationId, operationId)
        .first<{ source_connection_id: string }>()
    )?.source_connection_id,
    uploadId = newUlid(),
    buildExecutionId = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO build_source_uploads(upload_id,organization_id,project_id,operation_id,source_connection_id,commit_sha,bucket_name,object_key,object_version_id,state,claim_id,claimed_at,lease_expires_at,attempt_number,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'source-fixture','source','exact-version','completed',?7,?8,'2026-10-28T11:00:00.000000Z',1,?8,?8)",
      )
      .bind(
        uploadId,
        project.organizationId,
        project.projectId,
        operationId,
        sourceConnection,
        "a".repeat(40),
        newUlid(),
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO build_executions(build_execution_id,organization_id,project_id,operation_id,source_upload_id,build_plan_sha256,build_project_name,provider_build_id,state,attempt_number,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'fixture-build','exact-build','succeeded',1,?7,?7)",
      )
      .bind(
        buildExecutionId,
        project.organizationId,
        project.projectId,
        operationId,
        uploadId,
        bytes(32, 3),
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO build_artifacts(artifact_id,organization_id,project_id,build_execution_id,artifact_sha256,manifest_sha256,sbom_sha256,object_version_ref,created_at) VALUES(?1,?2,?3,?4,?5,?5,?5,?6,?7)",
      )
      .bind(
        newUlid(),
        project.organizationId,
        project.projectId,
        buildExecutionId,
        bytes(32, 3),
        objectVersionRef,
        STORED_NOW,
      ),
  ]);
}

/** The exact R2 reference the build runner persists for the bundle of an operation. */
export const bundleRef = (
  projectId: string,
  environmentId: string,
  operationId: string,
  bucket = "ohmyho-builds-development-eu",
) =>
  `r2-version:${bucket}/runs/${projectId}/${environmentId}/${operationId}/output/bundle.tar.gz#${"c".repeat(32)}`;

export async function seedSourceArchive(
  project: ProjectScope,
  environmentId: string,
  operationId: string,
  bucket: string,
) {
  await project.shard
    .prepare(
      "INSERT INTO product_source_archive_objects(operation_id,organization_id,project_id,environment_id,bucket_name,object_key,object_version_id,object_etag,byte_length,source_sha256,recorded_at) VALUES(?1,?2,?3,?4,?5,'raw/key','exact-version','exact-etag',4096,?6,?7)",
    )
    .bind(
      operationId,
      project.organizationId,
      project.projectId,
      environmentId,
      bucket,
      bytes(32, 9),
      STORED_NOW,
    )
    .run();
}

export async function seedR2Bucket(project: SeededProject, environmentId: string) {
  await project.shard
    .prepare(
      "INSERT INTO project_r2_bucket_receipts(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'eu','Standard',0,?8,?8)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      environmentId,
      newUlid(),
      newUlid(),
      `ohmyho-${project.projectId.toLowerCase()}-${environmentId.toLowerCase()}`,
      createHash("sha256").update(environmentId).digest("hex").slice(0, 32),
      STORED_NOW,
    )
    .run();
}

/** A function schedule of the environment over a published candidate of its own (the schedule row references it). */
export async function seedSchedule(project: SeededProject, environmentId: string) {
  const operationId = await seedOperation(project),
    ids = await seedWfpPublication(project, { operationId, environmentId }),
    name = environmentId === project.devEnvironmentId ? "dev" : "prod";
  await project.shard
    .prepare(
      "INSERT INTO environment_function_schedules(organization_id,environment_id,project_id,deployment_id,candidate_receipt_id,immutable_script_name,crons,egress_allowed_origins,next_fire_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'[\"*/5 * * * *\"]','[]',?7,?7)",
    )
    .bind(
      project.organizationId,
      environmentId,
      project.projectId,
      ids.deploymentId,
      ids.candidateReceiptId,
      `p-${project.projectId.toLowerCase()}-${name}-${ids.deploymentId.toLowerCase()}`,
      STORED_NOW,
    )
    .run();
}

/** A managed Git repository with one published operation of `paths` blobs (reservation, then blob, as admission does). */
export async function seedManagedSource(project: SeededProject, paths: readonly string[]) {
  const db = project.shard,
    namespace = `ns-${project.projectId.toLowerCase()}`,
    sourceConnectionId = newUlid(),
    operationId = await seedOperation(project, { state: "running" });
  await db
    .prepare(
      "INSERT INTO managed_source_repositories(source_connection_id,organization_id,project_id,billing_epoch_id,namespace,repository_name,created_at) VALUES(?1,?2,?3,?4,?5,'repo',?6)",
    )
    .bind(
      sourceConnectionId,
      project.organizationId,
      project.projectId,
      project.billingEpochId,
      namespace,
      STORED_NOW,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO managed_source_publications(operation_id,organization_id,project_id,billing_epoch_id,principal_id,source_connection_id,mode,expected_source_generation,state,message,created_at,expires_at,updated_at) VALUES(?1,?2,?3,?4,'user:fixture',?5,'initialize',0,'staging','m',?6,'2026-10-29T10:00:00.000000Z',?6)",
    )
    .bind(
      operationId,
      project.organizationId,
      project.projectId,
      project.billingEpochId,
      sourceConnectionId,
      STORED_NOW,
    )
    .run();
  for (const [index, path] of paths.entries()) {
    const sha = createHash("sha256").update(path).digest("hex");
    await db.batch([
      db
        .prepare(
          "INSERT INTO managed_source_reservations(operation_id,path,sha256,byte_length,executable,created_at) VALUES(?1,?2,?3,10,?4,?5)",
        )
        .bind(operationId, path, sha, index % 2, STORED_NOW),
      db
        .prepare(
          "INSERT INTO managed_source_blobs(operation_id,path,sha256,byte_length,executable,bucket,object_key,version_id,etag,created_at) VALUES(?1,?2,?3,10,?4,'source-bucket',?5,?6,'etag',?7)",
        )
        .bind(operationId, path, sha, index % 2, `blobs/${sha}`, "e".repeat(32), STORED_NOW),
    ]);
  }
  return { sourceConnectionId, namespace, operationId };
}

/**
 * A project that owns the resource families of the deletion inventory except provider database targets: a published
 * production deployment, a built development deployment with its source archive, an R2 bucket and a managed repository.
 */
export async function seedOwnedResources(project: SeededProject) {
  const publishedOperationId = await seedOperation(project),
    ids = await seedWfpPublication(project, { operationId: publishedOperationId }),
    plan = await project.shard
      .prepare("SELECT source_connection_id FROM deployment_plans WHERE plan_id=?1")
      .bind(ids.planId)
      .first<{ source_connection_id: string }>();
  await seedAcceptedOperation(project, project.prodEnvironmentId, {
    operationId: publishedOperationId,
    claim: false,
    intent: {
      plan_id: ids.planId,
      source_connection_id: plan?.source_connection_id ?? "",
      deployment_id: ids.deploymentId,
      source_generation: 1,
    },
  });
  await seedR2Bucket(project, project.prodEnvironmentId);
  const built = await acceptBuild(project, project.devEnvironmentId);
  await seedBuildArtifact(
    project,
    built.operationId,
    bundleRef(project.projectId, project.devEnvironmentId, built.operationId),
  );
  await seedSourceArchive(
    project,
    project.devEnvironmentId,
    built.operationId,
    "ohmyho-poc-private-fullstack-build-123456789012-eu",
  );
  const managed = await seedManagedSource(project, ["b.txt", "a.txt"]);
  await project.shard
    .prepare(
      "UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND project_id=?2 AND operation_id IN(?3,?4,?5)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      publishedOperationId,
      built.operationId,
      managed.operationId,
    )
    .run();
  return {
    published: {
      ...ids,
      operationId: publishedOperationId,
      scriptName: `p-${project.projectId.toLowerCase()}-prod-${ids.deploymentId.toLowerCase()}`,
    },
    built,
    managed,
  };
}

/** A secret of the environment, which a completed deletion must purge in the same commit. */
export async function seedSecret(project: SeededProject, environmentId: string) {
  await project.shard
    .prepare(
      "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,'API_KEY',?4,?5,?6,1,1,?7,?7)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      environmentId,
      bytes(17, 1),
      bytes(12, 2),
      bytes(32, 3),
      STORED_NOW,
    )
    .run();
}

/**
 * The state the Workflow leaves behind before it completes a deletion of the published production deployment:
 * the gateway route removed (a newer inactive revision) and the runtime delivery state pointing at the live script.
 */
export async function retirePublishedDeployment(
  project: SeededProject,
  deletionOperationId: string,
) {
  const db = project.shard;
  await db.batch([
    db
      .prepare(
        "INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,observed_at) SELECT organization_id,project_id,environment_id,2,1,?4,candidate_receipt_id,'remove',0,handle,public_origin,egress_allowed_origins,?5 FROM shared_gateway_route_revisions WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND revision=1",
      )
      .bind(
        project.organizationId,
        project.projectId,
        project.prodEnvironmentId,
        deletionOperationId,
        STORED_NOW,
      ),
    db
      .prepare(
        "UPDATE runtime_secret_delivery_states SET provider_tag='exact-fixture-tag',applied_manifest_sha256=?4 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(project.organizationId, project.projectId, project.prodEnvironmentId, bytes(32, 5)),
  ]);
}
