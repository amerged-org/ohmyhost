import type { ProjectScope, SeededProject } from "./platform-fixtures.js";
import { STORED_NOW, bytes } from "./platform-fixtures.js";
import { newUlid } from "../../src/catalog/common.js";

/** A complete plan admitted by the actual original400 v5/170/181 constraints, not a recovery-only stub. */
export function sourceFrameworkPlan(databaseEnabled = false) {
  return {
    schemaVersion: "ohmyhost.framework-plan/v5",
    adapter: "nextjs",
    runtime: "edge",
    applicationRoot: ".",
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
    outputDirectory: ".open-next/assets",
    serverOutputDirectory: ".ohmyhost-worker",
    serverEntryPoint: ".ohmyhost-worker/worker.js",
    serverConfigPath: "wrangler.jsonc",
    compatibilityDate: "2026-10-12",
    compatibilityFlags: ["nodejs_compat"],
    runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    database: databaseEnabled ? { enabled: true, migrations: "db/migrations" } : { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
  };
}

/**
 * Real rows of the production `deployment_plans` table (migration 0073) with the real FK chain it needs:
 * `source_connections` and `repository_grants` of migration 0090. Idempotent per project for the connection/grant.
 */
export async function seedDeploymentPlan(
  project: ProjectScope,
  planId: string,
  frameworkPlan: unknown,
  environmentId: string,
  options: {
    /** The project's source connection to plan against; default its first one, or a new one. */
    readonly sourceConnectionId?: string | undefined;
    /** The plan's cost estimate (default `{}`): the quote an accepted build is settled against. */
    readonly costEstimate?: unknown;
  } = {},
): Promise<{ readonly sourceConnectionId: string }> {
  const db = project.shard;
  const sourceConnectionId = options.sourceConnectionId;
  // These are global source identities. A lossy string hash of projectId can alias another project's row.
  const connection =
    sourceConnectionId ??
    (
      await db
        .prepare(
          "SELECT source_connection_id FROM source_connections WHERE organization_id=? AND project_id=? ORDER BY source_connection_id LIMIT 1",
        )
        .bind(project.organizationId, project.projectId)
        .first<{ source_connection_id: string }>()
    )?.source_connection_id ??
    newUlid();
  const grant =
    (
      await db
        .prepare(
          "SELECT grant_id FROM repository_grants WHERE organization_id=? AND project_id=? AND source_connection_id=? ORDER BY grant_id LIMIT 1",
        )
        .bind(project.organizationId, project.projectId, connection)
        .first<{ grant_id: string }>()
    )?.grant_id ?? newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO source_connections(organization_id, source_connection_id, project_id, billing_epoch_id, provider, external_repository_id, created_at) VALUES (?1, ?2, ?3, ?4, 'github', '42', ?5)",
      )
      .bind(
        project.organizationId,
        connection,
        project.projectId,
        project.billingEpochId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO repository_grants(organization_id, grant_id, project_id, billing_epoch_id, source_connection_id, provider, github_installation_id, external_repository_id, repository_owner, repository_name, permission, granted_at) VALUES (?1, ?2, ?3, ?4, ?5, 'github', '7', '42', 'o', 'r', 'contents:read', ?6)",
      )
      .bind(
        project.organizationId,
        grant,
        project.projectId,
        project.billingEpochId,
        connection,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO deployment_plans(organization_id, plan_id, project_id, source_connection_id, commit_sha, source_sha256, build_plan_sha256, runtime, impacts, risks, cost_estimate, created_at, expires_at, plan_sha256, framework_plan, environment_id, source_generation) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'cloudflare_workers_edge_ssr', '[]', '[]', ?10, ?7, '2026-10-29T09:00:00.000000Z', ?6, ?8, ?9, 1)",
      )
      .bind(
        project.organizationId,
        planId,
        project.projectId,
        connection,
        "a".repeat(40),
        bytes(32, 3),
        STORED_NOW,
        frameworkPlan === null
          ? null
          : typeof frameworkPlan === "string"
            ? frameworkPlan
            : JSON.stringify(frameworkPlan),
        environmentId,
        JSON.stringify(options.costEstimate ?? {}),
      ),
  ]);
  return { sourceConnectionId: connection };
}

/** Complete real-row publication graph. All original static FK/hash/plan/route guards remain active. No fake DDL. */
export async function seedWfpPublication(
  project: SeededProject,
  input: {
    operationId: string;
    environmentId?: string;
    frameworkPlan?: unknown;
    stagedAt?: string;
    headVersion?: number;
    gatewayRevision?: number;
    deploymentId?: string;
    revisionId?: string;
    planId?: string;
    candidateReceiptId?: string;
    bindingSetDigest?: Uint8Array;
    wfpReceiptId?: string;
    sourceConnectionId?: string;
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
  await seedDeploymentPlan(project, ids.planId, frame, env, {
    sourceConnectionId: input.sourceConnectionId,
  });
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
  const configuredDomain = await db
    .prepare(
      "SELECT production_domain,development_domain FROM cloudflare_project_domains WHERE organization_id=? AND project_id=? AND deleted_at IS NULL",
    )
    .bind(project.organizationId, project.projectId)
    .first<{ production_domain: string; development_domain: string }>();
  const namespace =
    configuredDomain && configuredDomain.production_domain !== `${project.handle}.check.omh.st`
      ? "ohmyho-poc-private-fullstack"
      : "ohmyho-production";
  const script = `p-${project.projectId.toLowerCase()}-${name}-${ids.deploymentId.toLowerCase()}`;
  const url = configuredDomain
      ? `https://${name === "dev" ? configuredDomain.development_domain : configuredDomain.production_domain}`
      : `https://${name === "dev" ? "dev-" : ""}${project.handle}.check.omh.st`,
    staged = input.stagedAt ?? STORED_NOW;
  const candidateSql =
    input.bindingSetDigest == null
      ? `INSERT INTO wfp_candidate_receipts(candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'${namespace}',?8,?9,'exact-fixture-tag',0,?10)`
      : `INSERT INTO wfp_candidate_receipts(candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at,binding_set_digest) VALUES(?1,?2,?3,?4,?5,?6,?7,'${namespace}',?8,?9,'exact-fixture-tag',0,?10,?11)`;
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
        "INSERT INTO build_artifacts(artifact_id,organization_id,project_id,build_execution_id,artifact_sha256,manifest_sha256,sbom_sha256,object_version_ref,created_at) VALUES(?1,?2,?3,?4,?5,?5,?5,'exact-artifact',?6)",
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
      .prepare(candidateSql)
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
        ...(input.bindingSetDigest == null ? [] : [input.bindingSetDigest]),
      ),
    db
      .prepare(
        "INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'activate',1,?8,?9,'[]',?10)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        env,
        input.gatewayRevision ?? 1,
        (input.gatewayRevision ?? 1) === 1 ? null : (input.gatewayRevision ?? 1) - 1,
        op,
        ids.candidateReceiptId,
        project.handle,
        url,
        STORED_NOW,
      ),
    db
      .prepare(
        `INSERT INTO wfp_publish_receipts(wfp_receipt_id,organization_id,project_id,environment_id,artifact_id,dispatch_namespace,script_name,provider_version_id,deployment_url,published_at,candidate_receipt_id,product_deployment_id,shared_gateway_revision) VALUES(?1,?2,?3,?4,?5,'${namespace}',?6,'exact-fixture-tag',?7,?8,?9,?10,?11)`,
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
        input.gatewayRevision ?? 1,
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
