import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import type { ProductDeploymentRead } from "@ohmyhost/database";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import {
  readContextSnapshot,
  type ContextRead,
  type ContextRows,
} from "../provisioning/context-queries.js";
import { bytes, integer, iso, text, type Row } from "../provisioning/context-values.js";

export type ApiProductDeployment = Omit<
  ProductDeploymentRead,
  "sourceDigest" | "buildPlanDigest" | "artifactDigest"
> & {
  readonly sourceDigest: Uint8Array;
  readonly buildPlanDigest: Uint8Array;
  readonly artifactDigest: Uint8Array | null;
};
const scopeInput = z.strictObject({ organizationId: ulid, projectId: ulid });
const projectReadInput = scopeInput.extend({ paidDevView: z.literal(true).optional() });
const readScopeInput = scopeInput.extend({ environmentName: z.enum(["dev", "prod"]).optional() });
const deploymentInput = scopeInput.extend({ deploymentId: ulid });
const pageInput = scopeInput.extend({
  cursor: ulid.optional(),
  limit: z.number().int().min(1).max(100),
});
export const API_PRODUCT_SCOPE_SQL = `SELECT project.organization_id,project.project_id,environment.environment_id,
 project.active_billing_epoch_id billing_epoch_id,project.lifecycle_version,environment.head_version
 FROM projects project JOIN environments environment ON environment.organization_id=project.organization_id AND environment.project_id=project.project_id
 WHERE project.organization_id=?1 AND project.project_id=?2 AND project.owner_state='active' AND project.lifecycle_state='active' AND environment.name=?3`;

/** Original command-scope read is lock-free and does not require an open billing epoch. */
export async function readApiProductScope(context: CatalogContext, raw: unknown) {
  const i = readScopeInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const r = await db
    .prepare(
      API_PRODUCT_SCOPE_SQL.replace(
        "environment.name=?3",
        "environment.name=COALESCE(?3,CASE WHEN EXISTS(SELECT 1 FROM environments preferred WHERE preferred.organization_id=?1 AND preferred.project_id=?2 AND preferred.name='dev') THEN 'dev' ELSE 'prod' END)",
      ),
    )
    .bind(i.organizationId, i.projectId, i.environmentName ?? null)
    .first<Row>();
  return r === null
    ? null
    : {
        organizationId: parseUlid(i.organizationId),
        projectId: parseUlid(i.projectId),
        environmentId: parseUlid(text(r, "environment_id")),
        billingEpochId: parseUlid(text(r, "billing_epoch_id")),
        lifecycleVersion: integer(r["lifecycle_version"], 1),
        headVersion: integer(r["head_version"]),
      };
}

// Same join precedence as native readProductDeployment: active revision, rollback target, promotion source, then intent plan.
export const API_PRODUCT_DEPLOYMENT_SQL = `SELECT deployment.deployment_id,deployment.project_id,deployment.environment_id,deployment.operation_id,
 plan.commit_sha,plan.source_sha256,plan.build_plan_sha256,artifact.artifact_sha256,
 (SELECT max(usage.completed_at) FROM build_usage usage WHERE usage.organization_id=deployment.organization_id AND usage.project_id=deployment.project_id
 AND usage.environment_id=deployment.environment_id AND usage.operation_id=deployment.operation_id AND usage.status='SUCCEEDED') build_completed_at,
 COALESCE(json_extract(plan.framework_plan,'$.mail.enabled'),0) mail_required,
 deployment.status,receipt.deployment_url,deployment.created_at,deployment.updated_at,deployment.active_version,deployment.kind,
 (environment.active_deployment_id=deployment.deployment_id AND environment.active_revision_id=deployment.active_revision_id) is_environment_head,
 environment.head_version environment_head_version
 FROM deployments deployment JOIN projects ownership ON ownership.organization_id=deployment.organization_id AND ownership.project_id=deployment.project_id
 JOIN environments environment ON environment.organization_id=deployment.organization_id AND environment.project_id=deployment.project_id AND environment.environment_id=deployment.environment_id
 JOIN product_command_intents intent ON intent.organization_id=deployment.organization_id AND intent.project_id=deployment.project_id AND intent.operation_id=deployment.operation_id
 LEFT JOIN deployment_revisions target_revision ON target_revision.organization_id=deployment.organization_id AND target_revision.project_id=deployment.project_id AND target_revision.deployment_id=deployment.rollback_target_deployment_id AND target_revision.revision_id=deployment.rollback_target_revision_id
 LEFT JOIN deployment_revisions source_revision ON source_revision.organization_id=deployment.organization_id AND source_revision.project_id=deployment.project_id AND source_revision.deployment_id=deployment.promotion_source_deployment_id AND source_revision.revision_id=deployment.promotion_source_revision_id
 LEFT JOIN deployment_revisions active_revision ON active_revision.organization_id=deployment.organization_id AND active_revision.project_id=deployment.project_id AND active_revision.deployment_id=deployment.deployment_id AND active_revision.revision_id=deployment.active_revision_id
 JOIN deployment_plans plan ON plan.organization_id=deployment.organization_id AND plan.project_id=deployment.project_id AND plan.plan_id=COALESCE(active_revision.plan_id,target_revision.plan_id,source_revision.plan_id,intent.plan_id)
 LEFT JOIN build_artifacts artifact ON artifact.organization_id=deployment.organization_id AND artifact.project_id=deployment.project_id AND artifact.artifact_id=COALESCE(active_revision.artifact_id,target_revision.artifact_id,source_revision.artifact_id)
 LEFT JOIN effective_wfp_publish_receipts receipt ON receipt.organization_id=active_revision.organization_id AND receipt.project_id=active_revision.project_id AND receipt.wfp_receipt_id=active_revision.wfp_receipt_id
 WHERE deployment.organization_id=?1 AND deployment.project_id=?2 AND ownership.owner_state='active'`;
export function apiDeploymentOf(r: Row): ApiProductDeployment {
  const sourceDigest = bytes(r["source_sha256"]),
    buildPlanDigest = bytes(r["build_plan_sha256"]),
    artifactDigest = r["artifact_sha256"] == null ? null : bytes(r["artifact_sha256"]);
  if (
    sourceDigest.byteLength !== 32 ||
    buildPlanDigest.byteLength !== 32 ||
    (artifactDigest !== null && artifactDigest.byteLength !== 32)
  )
    throw new TypeError("Persisted deployment digest is invalid");
  return {
    deploymentId: parseUlid(text(r, "deployment_id")),
    projectId: parseUlid(text(r, "project_id")),
    environmentId: parseUlid(text(r, "environment_id")),
    operationId: parseUlid(text(r, "operation_id")),
    commitSha: text(r, "commit_sha"),
    sourceDigest,
    buildPlanDigest,
    artifactDigest,
    ...(r["build_completed_at"] == null ? {} : { buildCompletedAt: iso(r["build_completed_at"]) }),
    mailRequired: r["mail_required"] === 1,
    status: z
      .enum(["queued", "running", "succeeded", "failed", "reconciliation_required"])
      .parse(r["status"]),
    deploymentUrl: r["deployment_url"] == null ? null : text(r, "deployment_url"),
    createdAt: iso(r["created_at"]),
    updatedAt: iso(r["updated_at"]),
    activeVersion: integer(r["active_version"]),
    kind: z.enum(["deploy", "rollback", "promotion"]).parse(r["kind"]),
    isEnvironmentHead: r["is_environment_head"] === 1,
    environmentHeadVersion: integer(r["environment_head_version"]),
  };
}
export async function readApiProductDeployment(
  context: CatalogContext,
  raw: unknown,
): Promise<ApiProductDeployment | null> {
  const i = deploymentInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = (
    await db
      .prepare(`${API_PRODUCT_DEPLOYMENT_SQL} AND deployment.deployment_id=?3`)
      .bind(i.organizationId, i.projectId, i.deploymentId)
      .all<Row>()
  ).results;
  if (rows.length > 1) throw new TypeError("Deployment projection is ambiguous");
  return rows[0] === undefined ? null : apiDeploymentOf(rows[0]);
}
export async function readApiProductDeployments(context: CatalogContext, raw: unknown) {
  const i = pageInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const [ownership, page] = await db.batch([
    db
      .prepare(
        "SELECT 1 present FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active'",
      )
      .bind(i.organizationId, i.projectId),
    db
      .prepare(
        `${API_PRODUCT_DEPLOYMENT_SQL} AND (?3 IS NULL OR (deployment.created_at,deployment.deployment_id)<(SELECT created_at,deployment_id FROM deployments WHERE organization_id=?1 AND project_id=?2 AND deployment_id=?3)) ORDER BY deployment.created_at DESC,deployment.deployment_id DESC LIMIT ?4`,
      )
      .bind(i.organizationId, i.projectId, i.cursor ?? null, i.limit + 1),
  ]);
  if (ownership?.results.length !== 1) return null;
  const rows = (page?.results ?? []).slice(0, i.limit);
  return {
    items: rows.map(apiDeploymentOf),
    nextCursor:
      (page?.results.length ?? 0) > i.limit ? String(rows.at(-1)?.["deployment_id"]) : null,
  };
}
const PROJECT = `SELECT project_id,name,handle,region,dev_access_mode,lifecycle_state,lifecycle_version FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state<>'transferred'`;
const ENVIRONMENTS = `SELECT environment_id,name,active_deployment_id FROM environments WHERE organization_id=?1 AND project_id=?2 ORDER BY name`;
const SOURCE = `SELECT source.*,grant_record.source_connection_id,COALESCE(binding.generation,source.revision) source_generation,binding.commit_sha current_commit_sha
 FROM project_sources source JOIN repository_grants grant_record USING(organization_id,project_id,grant_id)
 LEFT JOIN project_source_bindings binding USING(organization_id,project_id)
 WHERE source.organization_id=?1 AND source.project_id=?2 AND(binding.source_connection_id IS NULL OR binding.source_connection_id=grant_record.source_connection_id)
 ORDER BY source.created_at DESC LIMIT 1`;
const GATEWAY = `SELECT environment.name,receipt.wfp_receipt_id,receipt.product_deployment_id,receipt.script_name,
 candidate.immutable_script_name target_script_name,route.public_origin,route.revision route_revision,route.observed_at
 FROM environments environment JOIN projects project USING(organization_id,project_id)
 JOIN deployment_revisions revision ON revision.organization_id=environment.organization_id AND revision.project_id=environment.project_id AND revision.deployment_id=environment.active_deployment_id AND revision.revision_id=environment.active_revision_id
 JOIN effective_wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.environment_id=environment.environment_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id
 JOIN shared_gateway_route_revisions route ON route.organization_id=environment.organization_id AND route.project_id=environment.project_id AND route.environment_id=environment.environment_id AND route.revision=receipt.shared_gateway_revision AND route.active=1 AND route.handle=project.handle
 JOIN wfp_candidate_receipts candidate ON candidate.organization_id=receipt.organization_id AND candidate.project_id=receipt.project_id AND candidate.candidate_receipt_id=route.candidate_receipt_id AND candidate.immutable_script_name=receipt.script_name
 WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.name IN('dev','prod') ORDER BY environment.name`;
function projectReads(parameters: readonly unknown[]): ContextRead[] {
  return [PROJECT, ENVIRONMENTS, SOURCE, GATEWAY].map((sql) => ({ sql, parameters }));
}
function projectProjection(rows: readonly ContextRows[]): Readonly<Record<string, unknown>> | null {
  const [projects, environments, sources, gateways] = rows,
    r = projects?.[0];
  if (r === undefined) return null;
  if (projects?.length !== 1) throw new TypeError("Project projection is ambiguous");
  const gateway_evidence: Record<string, unknown> = { dev: null, prod: null };
  for (const g of gateways ?? []) {
    const name = z.enum(["dev", "prod"]).parse(g["name"]);
    if (gateway_evidence[name] !== null) throw new TypeError("Gateway projection is ambiguous");
    gateway_evidence[name] = {
      ...g,
      runtime_provider: "wfp",
      contract_version: "ohmyhost.shared-gateway/v1",
      deployment_url: g["public_origin"],
    };
  }
  return {
    ...r,
    default_environment:
      environments?.find((e) => e["name"] === "dev") ??
      environments?.find((e) => e["name"] === "prod") ??
      null,
    environments: (environments ?? [])
      .filter((e) => ["dev", "prod"].includes(String(e["name"])))
      .map((e) => ({ id: e["environment_id"], name: e["name"] })),
    source: sources?.[0] ?? null,
    gateway_evidence,
  };
}
async function snapshot(
  context: CatalogContext,
  organizationId: string,
  reads: readonly ContextRead[],
) {
  const { db } = await routeOrganization(context, organizationId);
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await readContextSnapshot(db, reads);
    if (rows !== null) return rows;
  }
  throw new Error("Product API snapshot changed repeatedly");
}
/** Complete source and gateway facts are read in one native snapshot, including current source-binding selection. */
export async function readApiProductProject(context: CatalogContext, raw: unknown) {
  const i = projectReadInput.parse(raw);
  return projectProjection(
    await snapshot(context, i.organizationId, projectReads([i.organizationId, i.projectId])),
  );
}
const LATEST = `SELECT operation_id,state,created_at,updated_at,json_extract(failure,'$.code') failure_code,failure->'$.diagnostic' failure_diagnostic
 FROM operations WHERE organization_id=?1 AND project_id=?2 ORDER BY created_at DESC,operation_id DESC LIMIT 1`;
const BLOCKING = `SELECT claim.operation_id FROM (${LATEST}) waiting JOIN operations exact_waiting ON exact_waiting.organization_id=?1 AND exact_waiting.operation_id=waiting.operation_id
 JOIN product_provider_mutation_claims claim ON claim.organization_id=exact_waiting.organization_id AND claim.project_id=exact_waiting.project_id
 JOIN operations holder ON holder.organization_id=claim.organization_id AND holder.operation_id=claim.operation_id
 WHERE waiting.state='queued' AND holder.state IN('queued','running') AND claim.operation_id<>waiting.operation_id`;
const RECONCILIATION = `SELECT run.state,COALESCE(run.active_reconciliation_attempt_id,run.active_replay_attempt_id) attempt_id,run.updated_at
 FROM product_workflow_runs run JOIN operations operation ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id AND operation.operation_id=run.operation_id
 JOIN projects ownership ON ownership.organization_id=run.organization_id AND ownership.project_id=run.project_id
 WHERE run.organization_id=?1 AND run.project_id=?2 AND run.operation_id=(SELECT operation_id FROM (${LATEST})) AND operation.state IN('queued','running')
 AND(run.state='reconciliation_required' OR(run.state='queued' AND COALESCE(run.active_reconciliation_attempt_id,run.active_replay_attempt_id) IS NOT NULL))`;
export async function readApiProductStatus(context: CatalogContext, raw: unknown) {
  const i = projectReadInput.parse(raw),
    parameters = [i.organizationId, i.projectId];
  const rows = await snapshot(context, i.organizationId, [
    ...projectReads(parameters),
    {
      sql: `${API_PRODUCT_DEPLOYMENT_SQL} AND environment.name=CASE WHEN EXISTS(SELECT 1 FROM environments preferred WHERE preferred.organization_id=?1 AND preferred.project_id=?2 AND preferred.name='dev') THEN 'dev' ELSE 'prod' END AND environment.active_deployment_id=deployment.deployment_id`,
      parameters,
    },
    ...[
      LATEST,
      BLOCKING,
      RECONCILIATION,
      `SELECT state FROM cleanup_runs WHERE organization_id=?1 AND project_id=?2 ORDER BY created_at DESC,cleanup_run_id DESC LIMIT 1`,
      `SELECT hostname,state FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND state NOT IN('deleted','displaced') ORDER BY hostname`,
    ].map((sql) => ({ sql, parameters })),
  ]);
  const projection = projectProjection(rows);
  if (projection === null) return null;
  const [head, latest, blocking, reconciliation, cleanup, customDomains] = rows.slice(4),
    r = latest?.[0],
    rec = reconciliation?.[0];
  if ((head?.length ?? 0) > 1 || (blocking?.length ?? 0) > 1 || (reconciliation?.length ?? 0) > 1)
    throw new TypeError("Project status projection is ambiguous");
  if (rec?.["state"] === "reconciliation_required" && rec["attempt_id"] !== null)
    throw new TypeError("Required reconciliation still has an active attempt");
  return {
    projection,
    customDomains: (customDomains ?? []).map((domain) => ({
      hostname: text(domain, "hostname"),
      environment: "prod" as const,
      state: z
        .enum(["awaiting_deployment", "pending", "active", "deleting"])
        .parse(domain["state"]),
    })),
    headDeployment: head?.[0] === undefined ? null : apiDeploymentOf(head[0]),
    latestOperation:
      r === undefined
        ? undefined
        : {
            operation_id: text(r, "operation_id"),
            state: text(r, "state"),
            created_at: iso(r["created_at"]),
            updated_at: iso(r["updated_at"]),
            failure_code: r["failure_code"] == null ? null : text(r, "failure_code"),
            failure_diagnostic:
              typeof r["failure_diagnostic"] === "string"
                ? (JSON.parse(r["failure_diagnostic"]) as unknown)
                : r["failure_diagnostic"],
            blockingOperationId:
              blocking?.[0] === undefined ? null : text(blocking[0], "operation_id"),
            reconciliation: apiOperationReconciliationOf(rec),
          },
    cleanupState: cleanup?.[0] === undefined ? undefined : text(cleanup[0], "state"),
  };
}

/** Same original reconciliation projection for status and complete operation polling. */
export function apiOperationReconciliationOf(rec: Row | undefined) {
  if (rec === undefined) return null;
  if (rec["state"] === "reconciliation_required" && rec["attempt_id"] !== null)
    throw new TypeError("Required reconciliation still has an active attempt");
  return {
    state:
      rec["state"] === "reconciliation_required" ? ("required" as const) : ("pending" as const),
    attempt_id: rec["attempt_id"] == null ? null : parseUlid(text(rec, "attempt_id")),
    observed_at: iso(rec["updated_at"]),
  };
}
