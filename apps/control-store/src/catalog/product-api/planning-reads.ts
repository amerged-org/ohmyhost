import { z } from "zod";
import { parseHostingRegion, parseNewProductionFrameworkPlan, parseUlid } from "@ohmyhost/platform";
import { parseProjectHandle, projectEnvironmentAddress } from "@ohmyhost/project-handles";
import { routeOrganization, ulid, instant, type CatalogContext } from "../common.js";
import { storedTimestamp } from "../../timestamps.js";
import { readContextSnapshot, type ContextRead } from "../provisioning/context-queries.js";
import { bytes, integer, iso, text, type Row } from "../provisioning/context-values.js";
import { API_PRODUCT_SCOPE_SQL } from "./reads.js";
import { nativeDomainPreparationViolation } from "../identity/native-auth-domain-snapshot.js";
const scope = z.strictObject({ organizationId: ulid, projectId: ulid });
const planning = scope.extend({
  sourceConnectionId: ulid.optional(),
  environmentName: z.enum(["dev", "prod"]).optional(),
});
const API_PLANNING_SOURCE_SQL = `SELECT project.handle,project.region,project.data_mode,environment.environment_id,environment.name environment_name,
 project.active_billing_epoch_id billing_epoch_id,project.lifecycle_version,environment.head_version,domain.production_domain,
 grant_record.source_connection_id,grant_record.grant_id,grant_record.provider,grant_record.github_installation_id,
 grant_record.external_repository_id,grant_record.repository_owner,grant_record.repository_name,grant_record.granted_at,binding.generation source_generation
 FROM projects project JOIN environments environment USING(organization_id,project_id)
 JOIN cloudflare_project_domains domain USING(organization_id,project_id)
 JOIN project_sources source USING(organization_id,project_id)
 JOIN repository_grants grant_record ON grant_record.organization_id=source.organization_id AND grant_record.project_id=source.project_id AND grant_record.grant_id=source.grant_id
 JOIN project_source_bindings binding ON binding.organization_id=grant_record.organization_id AND binding.project_id=grant_record.project_id AND binding.source_connection_id=grant_record.source_connection_id
 WHERE project.organization_id=?1 AND project.project_id=?2 AND project.owner_state='active' AND project.lifecycle_state='active'
 AND environment.name=COALESCE(?3,CASE WHEN EXISTS(SELECT 1 FROM environments preferred WHERE preferred.organization_id=project.organization_id AND preferred.project_id=project.project_id AND preferred.name='dev') THEN 'dev' ELSE 'prod' END)
 AND domain.deleted_at IS NULL AND domain.handle=project.handle AND domain.zone_name='omh.st'
 AND source.state='ready' AND (?4 IS NULL OR grant_record.source_connection_id=?4)
 AND NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id)
 ORDER BY source.updated_at DESC LIMIT 1`;
export async function readApiPlanningSource(context: CatalogContext, raw: unknown) {
  const i = planning.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const [result, jurisdictions] = await db.batch([
    db
      .prepare(API_PLANNING_SOURCE_SQL)
      .bind(i.organizationId, i.projectId, i.environmentName ?? null, i.sourceConnectionId ?? null),
    db
      .prepare(
        `SELECT jurisdiction FROM project_r2_bucket_receipts WHERE organization_id=?1 AND project_id=?2 UNION SELECT jurisdiction FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2`,
      )
      .bind(i.organizationId, i.projectId),
  ]);
  const r = result?.results[0];
  if (r === undefined) return null;
  if ((jurisdictions?.results.length ?? 0) > 1) throw new Error("project_r2_bucket_conflict");
  const region = parseHostingRegion(r["region"]),
    storageJurisdiction = z
      .enum(["us", "eu"])
      .parse(jurisdictions?.results[0]?.["jurisdiction"] ?? region),
    projectHandle = parseProjectHandle(text(r, "handle")),
    environmentName = z.enum(["dev", "prod"]).parse(r["environment_name"]);
  const platform =
    r["production_domain"] === `${projectHandle}.check.omh.st` ? "production" : "development";
  const address = { projectId: parseUlid(i.projectId), handle: projectHandle, platform } as const;
  if (
    r["production_domain"] !==
    projectEnvironmentAddress({ ...address, environmentName: "prod" }).hostname
  )
    throw new TypeError("Persisted project domain is invalid");
  return {
    organizationId: parseUlid(i.organizationId),
    projectId: parseUlid(i.projectId),
    environmentId: parseUlid(text(r, "environment_id")),
    billingEpochId: parseUlid(text(r, "billing_epoch_id")),
    lifecycleVersion: integer(r["lifecycle_version"], 1),
    headVersion: integer(r["head_version"]),
    sourceConnectionId: parseUlid(text(r, "source_connection_id")),
    grantId: parseUlid(text(r, "grant_id")),
    provider: z.enum(["github", "managed"]).parse(r["provider"]),
    installationId: r["github_installation_id"] == null ? null : text(r, "github_installation_id"),
    externalRepositoryId: text(r, "external_repository_id"),
    repositoryOwner: text(r, "repository_owner"),
    repositoryName: text(r, "repository_name"),
    grantedAt: iso(r["granted_at"]),
    revoked: false as const,
    sourceGeneration: integer(r["source_generation"], 1),
    projectHandle,
    region,
    storageJurisdiction,
    environmentName,
    publicOrigin: projectEnvironmentAddress({ ...address, environmentName }).origin,
    dataMode: r["data_mode"] === "shared" ? ("shared" as const) : ("isolated" as const),
  };
}
export const API_DEPLOYMENT_PLAN_SQL = `SELECT plan.*,project.active_billing_epoch_id billing_epoch_id FROM deployment_plans plan
 JOIN projects project USING(organization_id,project_id)
 JOIN environments environment ON environment.organization_id=plan.organization_id AND environment.project_id=plan.project_id AND environment.environment_id=plan.environment_id
 JOIN repository_grants grant_record ON grant_record.organization_id=plan.organization_id AND grant_record.project_id=plan.project_id AND grant_record.source_connection_id=plan.source_connection_id
 JOIN project_source_bindings binding ON binding.organization_id=plan.organization_id AND binding.project_id=plan.project_id AND binding.source_connection_id=plan.source_connection_id AND binding.generation=plan.source_generation
 WHERE plan.organization_id=?1 AND plan.project_id=?2 AND plan.plan_id=?3 AND project.owner_state='active'
 AND plan.created_at<=?4 AND plan.expires_at>?4 AND NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id)`;
export async function readApiDeploymentPlan(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ planId: ulid, readAt: instant }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const r = await db
    .prepare(API_DEPLOYMENT_PLAN_SQL)
    .bind(i.organizationId, i.projectId, i.planId, i.readAt)
    .first<Row>();
  if (r === null) return null;
  const frameworkPlan = parseNewProductionFrameworkPlan(JSON.parse(text(r, "framework_plan")));
  const sourceDigest = bytes(r["source_sha256"]),
    buildPlanDigest = bytes(r["build_plan_sha256"]),
    planDigest = bytes(r["plan_sha256"]);
  if ([sourceDigest, buildPlanDigest, planDigest].some((b) => b.byteLength !== 32))
    throw new TypeError("Persisted deployment digest is invalid");
  return {
    planId: parseUlid(i.planId),
    sourceConnectionId: parseUlid(text(r, "source_connection_id")),
    environmentId: parseUlid(text(r, "environment_id")),
    billingEpochId: parseUlid(text(r, "billing_epoch_id")),
    commitSha: text(r, "commit_sha"),
    planDigest,
    sourceDigest,
    buildPlanDigest,
    runtime: text(r, "runtime"),
    applicationRoot: frameworkPlan.applicationRoot,
    frameworkPlan,
    expiresAt: iso(r["expires_at"]),
    sourceGeneration: integer(r["source_generation"], 1),
  };
}
export async function readApiPromotionEnvironments(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = (
    await db
      .prepare(
        `SELECT environment_id,name FROM environments WHERE organization_id=?1 AND project_id=?2 AND name IN('dev','prod') ORDER BY name`,
      )
      .bind(i.organizationId, i.projectId)
      .all<Row>()
  ).results;
  const dev = rows.find((r) => r["name"] === "dev"),
    prod = rows.find((r) => r["name"] === "prod");
  return dev === undefined || prod === undefined || rows.length !== 2
    ? null
    : {
        sourceEnvironmentId: parseUlid(text(dev, "environment_id")),
        targetEnvironmentId: parseUlid(text(prod, "environment_id")),
      };
}
const API_PROMOTION_TARGET_SQL = `SELECT project.data_mode,json_extract(plan.framework_plan,'$.database.enabled') database_enabled,project.active_billing_epoch_id billing_epoch_id,
 source.active_deployment_id source_deployment_id,source.active_revision_id source_revision_id,revision.artifact_id source_artifact_id,artifact.artifact_sha256,
 source.head_version source_head_version,target.head_version target_head_version
 FROM environments source JOIN environments target ON target.organization_id=source.organization_id AND target.project_id=source.project_id AND target.environment_id=?4 AND target.name='prod'
 JOIN projects project ON project.organization_id=source.organization_id AND project.project_id=source.project_id AND project.owner_state='active' AND project.lifecycle_state='active'
 JOIN deployments deployment ON deployment.organization_id=source.organization_id AND deployment.project_id=source.project_id AND deployment.environment_id=source.environment_id AND deployment.deployment_id=source.active_deployment_id AND deployment.status='succeeded'
 JOIN deployment_revisions revision ON revision.organization_id=source.organization_id AND revision.project_id=source.project_id AND revision.deployment_id=source.active_deployment_id AND revision.revision_id=source.active_revision_id AND deployment.active_revision_id=revision.revision_id
 JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id
 JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id
 JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.environment_id=source.environment_id AND receipt.artifact_id=revision.artifact_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id
 WHERE source.organization_id=?1 AND source.project_id=?2 AND source.environment_id=?3 AND source.name='dev' AND source.active_deployment_id IS NOT NULL AND source.active_revision_id IS NOT NULL`;
export async function readApiPromotionTarget(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ sourceEnvironmentId: ulid, targetEnvironmentId: ulid }).parse(raw);
  if (i.sourceEnvironmentId === i.targetEnvironmentId)
    throw new TypeError("Promotion environments must be distinct");
  const { db } = await routeOrganization(context, i.organizationId),
    r = await db
      .prepare(API_PROMOTION_TARGET_SQL)
      .bind(i.organizationId, i.projectId, i.sourceEnvironmentId, i.targetEnvironmentId)
      .first<Row>();
  if (
    r === null ||
    !["shared", "isolated"].includes(String(r["data_mode"])) ||
    ![0, 1].includes(Number(r["database_enabled"])) ||
    r["database_enabled"] === null
  )
    return null;
  return {
    dataMode: z.enum(["shared", "isolated"]).parse(r["data_mode"]),
    databaseEnabled: r["database_enabled"] === 1,
    billingEpochId: parseUlid(text(r, "billing_epoch_id")),
    sourceEnvironmentId: parseUlid(i.sourceEnvironmentId),
    sourceDeploymentId: parseUlid(text(r, "source_deployment_id")),
    sourceRevisionId: parseUlid(text(r, "source_revision_id")),
    sourceArtifactId: parseUlid(text(r, "source_artifact_id")),
    sourceArtifactDigest: bytes(r["artifact_sha256"]),
    expectedSourceHeadVersion: integer(r["source_head_version"]),
    targetEnvironmentId: parseUlid(i.targetEnvironmentId),
    expectedTargetHeadVersion: integer(r["target_head_version"]),
  };
}
export const API_DELETION_ADMISSION_SQL = `SELECT environment.environment_id,project.active_billing_epoch_id billing_epoch_id,project.lifecycle_version,project.lifecycle_state,
 CASE WHEN project.lifecycle_state='deleting' THEN (SELECT intent.operation_id FROM product_command_intents intent JOIN operations operation USING(organization_id,operation_id) WHERE intent.organization_id=project.organization_id AND intent.project_id=project.project_id AND intent.event_type='ProjectDeletionRequestedV1' ORDER BY operation.created_at DESC,operation.operation_id DESC LIMIT 1) ELSE NULL END previous_operation_id
 FROM projects project JOIN environments environment USING(organization_id,project_id)
 JOIN billing_epochs epoch ON epoch.billing_epoch_id=project.active_billing_epoch_id AND epoch.organization_id=project.organization_id AND epoch.project_id=project.project_id AND epoch.ended_at IS NULL
 WHERE project.organization_id=?1 AND project.project_id=?2 AND project.owner_state='active' AND environment.name=CASE WHEN EXISTS(SELECT 1 FROM environments preferred WHERE preferred.organization_id=project.organization_id AND preferred.project_id=project.project_id AND preferred.name='dev') THEN 'dev' ELSE 'prod' END
 AND(project.lifecycle_state='active' OR(project.lifecycle_state='deleting'
 AND(SELECT operation.state FROM product_command_intents intent JOIN operations operation USING(organization_id,operation_id) WHERE intent.organization_id=project.organization_id AND intent.project_id=project.project_id AND intent.event_type='ProjectDeletionRequestedV1' ORDER BY operation.created_at DESC,operation.operation_id DESC LIMIT 1)='failed'
 AND NOT EXISTS(SELECT 1 FROM product_provider_mutation_claims claim WHERE claim.organization_id=?1 AND claim.project_id=?2)
 AND NOT EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=?1 AND operation.project_id=?2 AND operation.state IN('queued','running') AND operation.operation_id IS NOT ?3)
 AND NOT EXISTS(SELECT 1 FROM product_workflow_runs run WHERE run.organization_id=?1 AND run.project_id=?2 AND run.state<>'completed')))`;
export function apiDeletionAdmissionOf(r: Row | undefined) {
  return r === undefined
    ? null
    : {
        environmentId: parseUlid(text(r, "environment_id")),
        billingEpochId: parseUlid(text(r, "billing_epoch_id")),
        expectedProjectVersion: integer(r["lifecycle_version"], 1),
        lifecycleState: z.enum(["active", "deleting"]).parse(r["lifecycle_state"]),
        previousOperationId:
          r["previous_operation_id"] == null ? null : parseUlid(text(r, "previous_operation_id")),
      };
}
export async function readApiDeletionAdmission(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ acceptingOperationId: ulid.optional() }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const [admission, domain, nativePending] = await db.batch([
    db
      .prepare(API_DELETION_ADMISSION_SQL)
      .bind(i.organizationId, i.projectId, i.acceptingOperationId ?? null),
    db
      .prepare(
        `SELECT 1 present FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND state NOT IN('deleted','displaced') LIMIT 1`,
      )
      .bind(i.organizationId, i.projectId),
    db
      .prepare(
        "SELECT 1 FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND state='pending' LIMIT 1",
      )
      .bind(i.organizationId, i.projectId),
  ]);
  if (admission?.results.length === 1 && nativePending?.results.length)
    throw new Error("native_domain_sync_pending");
  if (admission?.results.length === 1 && domain?.results.length)
    throw new Error("project_domain_delete_required");
  return apiDeletionAdmissionOf(admission?.results[0]);
}
export async function readApiRenameAdmission(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ handle: z.string() }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const r = await db
    .prepare(
      `SELECT environment.environment_id,project.active_billing_epoch_id billing_epoch_id,project.lifecycle_version,project.handle,
 EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=?1 AND operation.project_id=?2 AND operation.state IN('queued','running') AND NOT EXISTS(SELECT 1 FROM native_auth_domain_operations pending JOIN product_provider_mutation_claims claim ON claim.organization_id=pending.organization_id AND claim.project_id=pending.project_id AND claim.operation_id=pending.identity AND claim.event_type='ProjectHandleChangeRequestedV1' WHERE pending.organization_id=operation.organization_id AND pending.project_id=operation.project_id AND pending.kind='handle_change' AND pending.identity=operation.operation_id AND pending.state='pending')) busy,
 EXISTS(SELECT 1 FROM native_auth_domain_operations pending JOIN product_provider_mutation_claims claim ON claim.organization_id=pending.organization_id AND claim.project_id=pending.project_id AND claim.operation_id=pending.identity AND claim.event_type='ProjectHandleChangeRequestedV1' WHERE pending.organization_id=?1 AND pending.project_id=?2 AND pending.kind='handle_change' AND pending.state='pending') native_recovery_pending,
 ${nativeDomainPreparationViolation("realm.canonical_origin IN (SELECT 'https://'||production_domain FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND zone_name='omh.st' AND handle<>?3 UNION SELECT 'https://'||development_domain FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND zone_name='omh.st' AND handle<>?3)")} native_preparation_pending,
 (EXISTS(SELECT 1 FROM projects other WHERE other.handle=?3 AND other.project_id<>?2 AND other.owner_state<>'transferred') OR EXISTS(SELECT 1 FROM project_directory claimed WHERE claimed.handle=?3 AND claimed.project_id<>?2) OR EXISTS(SELECT 1 FROM project_handle_releases released WHERE released.handle=?3 AND released.organization_id<>?1 AND released.quarantined_until>?4)) taken
 FROM projects project JOIN environments environment USING(organization_id,project_id) JOIN billing_epochs epoch ON epoch.billing_epoch_id=project.active_billing_epoch_id AND epoch.organization_id=project.organization_id AND epoch.project_id=project.project_id AND epoch.ended_at IS NULL
 WHERE project.organization_id=?1 AND project.project_id=?2 AND project.owner_state='active' AND project.lifecycle_state='active' AND environment.name=CASE WHEN EXISTS(SELECT 1 FROM environments preferred WHERE preferred.organization_id=project.organization_id AND preferred.project_id=project.project_id AND preferred.name='dev') THEN 'dev' ELSE 'prod' END`,
    )
    .bind(i.organizationId, i.projectId, i.handle, storedTimestamp(new Date().toISOString()))
    .first<Row>();
  return r === null
    ? null
    : {
        environmentId: parseUlid(text(r, "environment_id")),
        billingEpochId: parseUlid(text(r, "billing_epoch_id")),
        lifecycleVersion: integer(r["lifecycle_version"], 1),
        handle: text(r, "handle"),
        busy: r["busy"] === 1,
        nativeRecoveryPending: r["native_recovery_pending"] === 1,
        nativePreparationPending: r["native_preparation_pending"] === 1,
        taken: r["taken"] === 1,
      };
}
/** The complete plan target, including source-object deletion counts, is one native snapshot. */
export async function readApiDeletePlanTarget(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    parameters = [i.organizationId, i.projectId];
  const reads: ContextRead[] = [
    {
      sql: API_PRODUCT_SCOPE_SQL.replace(
        "environment.name=?3",
        "environment.name=CASE WHEN EXISTS(SELECT 1 FROM environments preferred WHERE preferred.organization_id=project.organization_id AND preferred.project_id=project.project_id AND preferred.name='dev') THEN 'dev' ELSE 'prod' END",
      ),
      parameters,
    },
    { sql: API_DELETION_ADMISSION_SQL, parameters: [...parameters, null] },
    {
      sql: `SELECT 1 present FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND state NOT IN('deleted','displaced') LIMIT 1`,
      parameters,
    },
    {
      sql: `SELECT CAST((SELECT count(*) FROM managed_source_repositories WHERE organization_id=?1 AND project_id=?2) AS TEXT) repositories,CAST((SELECT count(*) FROM(SELECT DISTINCT blob.bucket,blob.object_key,blob.version_id FROM managed_source_blobs blob JOIN managed_source_publications publication USING(operation_id) WHERE publication.organization_id=?1 AND publication.project_id=?2)) AS TEXT) objects`,
      parameters,
    },
    {
      sql: "SELECT 1 FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND state='pending' LIMIT 1",
      parameters,
    },
  ];
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await readContextSnapshot(db, reads);
    if (rows === null) continue;
    const active = rows[0]?.[0],
      admission = rows[1]?.[0];
    if (
      active === undefined &&
      (admission === undefined || admission["lifecycle_state"] !== "deleting")
    )
      return null;
    if (rows[4]?.length) throw new Error("native_domain_sync_pending");
    if (rows[2]?.length) throw new Error("project_domain_delete_required");
    const r = active ?? admission;
    if (r === undefined) throw new TypeError("Deletion plan scope is absent");
    const version = integer(r["lifecycle_version"], 1),
      count = rows[3]?.[0];
    if (count === undefined) throw new Error("Project source deletion counts are unavailable");
    return {
      expectedProjectVersion: version,
      expectedEtag: `project:${i.projectId}:v${version}`,
      managedRepositoryCount: integer(count["repositories"]),
      stagedSourceObjectCount: integer(count["objects"]),
    };
  }
  throw new Error("Deletion plan snapshot changed repeatedly");
}
