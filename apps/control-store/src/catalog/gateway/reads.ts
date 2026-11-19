import type { SharedGatewayResolution } from "@ohmyhost/platform";
import { routeOrganization, type CatalogContext } from "../common.js";
import { scopeInput, resolveInput, SharedGatewayConflictError } from "./contracts.js";
import { LATEST, ROUTE_ROW, ROUTE_FROM } from "./facts.js";
import { receiptOf, type Route } from "./mutations.js";

/**
 * The original effective publication is the authority, including rollback/address overrides; a candidate alone is not a head.
 * A hostname is either a route's own origin or the hostname of an active paid domain of a production route. An OR between
 * the two leaves no predicate that an index can drive, so every cold miss scanned a table; the two cases are two complete
 * selects, each starting from its own index (`shared_gateway_routes_origin_idx`, `paid_project_domains_live_hostname`), and
 * UNION returns a route that both would find once. `state<>'deleted'` repeats the partial index's own condition.
 */
const resolveBranch = (from: string, hostname: string) => `SELECT ${ROUTE_ROW} value,
 json_extract(plan.framework_plan,'$.auth.provider') auth_provider, realm.revocation_epoch auth_epoch,
 realm.configuration_revision auth_revision, project.region project_region,
 environment.name='prod' AND EXISTS(SELECT 1 FROM project_powered_by_flag_periods flag WHERE flag.project_id=route.project_id AND flag.organization_id=project.organization_id AND flag.disabled_at IS NULL) powered_by,
 EXISTS(SELECT 1 FROM organizations organization JOIN bucket_fences fence ON fence.bucket=organization.bucket WHERE organization.organization_id=route.organization_id AND fence.state='moved') bucket_moved
 ${from}
 JOIN projects project ON project.organization_id=route.organization_id AND project.project_id=route.project_id AND project.owner_state='active' AND project.lifecycle_state='active' AND project.handle=route.handle
 JOIN deployment_revisions head ON head.organization_id=environment.organization_id AND head.project_id=environment.project_id AND head.deployment_id=environment.active_deployment_id AND head.revision_id=environment.active_revision_id
 JOIN deployment_plans plan ON plan.organization_id=head.organization_id AND plan.project_id=head.project_id AND plan.plan_id=head.plan_id
 LEFT JOIN native_auth_realms realm ON realm.organization_id=environment.organization_id AND realm.project_id=environment.project_id AND realm.environment_id=environment.environment_id
 JOIN effective_wfp_publish_receipts published ON published.organization_id=head.organization_id AND published.project_id=head.project_id AND published.wfp_receipt_id=head.wfp_receipt_id AND published.candidate_receipt_id=route.candidate_receipt_id AND published.shared_gateway_revision=route.revision
 JOIN cloudflare_project_domains domain ON domain.organization_id=route.organization_id AND domain.project_id=route.project_id AND domain.deleted_at IS NULL AND domain.handle=project.handle
 WHERE route.active=1 AND route.public_origin='https://'||CASE environment.name WHEN 'dev' THEN domain.development_domain WHEN 'prod' THEN domain.production_domain END
 AND ${hostname}
 AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions tombstone WHERE tombstone.organization_id=route.organization_id AND tombstone.project_id=route.project_id AND tombstone.environment_id=route.environment_id AND tombstone.revision>route.revision AND tombstone.active=0)
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=route.candidate_receipt_id)`;
export const RESOLVE = `SELECT * FROM (${resolveBranch(ROUTE_FROM, "route.public_origin='https://'||?1")} UNION ${resolveBranch(
  ROUTE_FROM.replace(
    "FROM shared_gateway_route_revisions route",
    "FROM paid_project_domains paid CROSS JOIN shared_gateway_route_revisions route",
  ),
  "environment.name='prod' AND paid.hostname=?1 AND paid.state<>'deleted' AND paid.state='active' AND paid.hostname_proven_at IS NOT NULL AND paid.deleted_at IS NULL AND paid.gateway_script_name='ohmyho-gateway-production' AND paid.organization_id=route.organization_id AND paid.project_id=route.project_id",
)}) LIMIT 2`;

export async function observeGatewayRoute(context: CatalogContext, raw: unknown) {
  const input = scopeInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const row = await db
    .prepare(LATEST)
    .bind(input.organizationId, input.projectId, input.environmentId)
    .first<{ value: string }>();
  return row === null ? null : receiptOf(JSON.parse(row.value) as Route);
}
export async function resolveGatewayRoute(
  context: CatalogContext,
  raw: unknown,
): Promise<SharedGatewayResolution | null> {
  const input = resolveInput.parse(raw);
  // This closed hostname lookup is global and read-only; a moved bucket errors instead of masquerading as absence.
  const rows = (
    await context.directory.prepare(RESOLVE).bind(input.hostname).all<{
      value: string;
      powered_by: number;
      bucket_moved: number;
      auth_provider: string | null;
      auth_epoch: number | null;
      auth_revision: number | null;
      project_region: string;
    }>()
  ).results;
  if (rows.length > 1) throw new SharedGatewayConflictError();
  const row = rows[0];
  if (row === undefined) return null;
  if (row.bucket_moved === 1) throw new SharedGatewayConflictError();
  if (
    row.auth_provider === "omh-native" &&
    ((row.auth_epoch === null) !== (row.auth_revision === null) ||
      (row.project_region !== "us" && row.project_region !== "eu"))
  )
    throw new SharedGatewayConflictError();
  const value = await receiptOf(JSON.parse(row.value) as Route);
  return {
    organizationId: value.organizationId,
    projectId: value.projectId,
    environmentId: value.environmentId,
    environmentName: value.environmentName,
    handle: value.handle,
    hostname: input.hostname,
    publicOrigin: value.publicOrigin,
    targetDeploymentId: value.targetDeploymentId,
    targetScriptName: value.targetScriptName,
    egressAllowedOrigins: value.egressAllowedOrigins,
    ...(value.browserPolicy === undefined ? {} : { browserPolicy: value.browserPolicy }),
    poweredBy: row.powered_by === 1,
    ...(row.auth_provider === "omh-native"
      ? {
          nativeAuth:
            row.auth_epoch === null
              ? {
                  realmGeneration: null,
                  configurationRevision: null,
                  region: row.project_region as "us" | "eu",
                }
              : {
                  realmGeneration: row.auth_epoch,
                  configurationRevision: row.auth_revision as number,
                  region: row.project_region as "us" | "eu",
                },
        }
      : {}),
  };
}
