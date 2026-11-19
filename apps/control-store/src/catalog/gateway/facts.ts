import { deletionGatewayEnvironmentNameSql } from "../provisioning/deletion-environments.js";
import type { D1Database } from "../../d1-types.js";
import { SharedGatewayConflictError, type Mutation } from "./contracts.js";

// Literal original shared-gateway authority and predecessor queries, adapted to the one-Core owner projection.
// Bound values only; nothing in these private catalog functions accepts caller SQL.
export const AUTHORITY = `SELECT CASE WHEN intent.event_type='ProjectHandleChangeRequestedV1' THEN intent.requested_handle ELSE project.handle END AS handle,
    CASE WHEN intent.event_type='ProjectHandleChangeRequestedV1'
      THEN 'https://'||CASE environment.name WHEN 'dev' THEN 'dev-' ELSE '' END||intent.requested_handle||substr(domain.production_domain,length(project.handle)+1)
      ELSE 'https://'||CASE environment.name WHEN 'dev' THEN domain.development_domain WHEN 'prod' THEN domain.production_domain END END AS public_origin
    FROM product_provider_mutation_claims claim
    JOIN projects project ON project.organization_id=claim.organization_id AND project.project_id=claim.project_id AND project.lifecycle_version=claim.accepted_lifecycle_version
    AND project.owner_state='active'
    JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id AND operation.state IN ('queued','running')
    JOIN environments environment ON environment.organization_id=claim.organization_id AND environment.project_id=claim.project_id AND environment.environment_id=?3
    LEFT JOIN product_command_intents intent ON intent.organization_id=claim.organization_id AND intent.project_id=claim.project_id AND intent.operation_id=claim.operation_id
    LEFT JOIN cloudflare_project_domains domain ON domain.organization_id=claim.organization_id AND domain.project_id=claim.project_id AND domain.deleted_at IS NULL AND domain.handle=project.handle
    WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.operation_id=?4 AND claim.claim_id=?5
      AND (claim.environment_id=?3 OR intent.event_type='ProjectHandleChangeRequestedV1' OR (?8=true AND intent.event_type='ProjectDeletionRequestedV1'))
      AND (project.lifecycle_state='active' OR (?8=true AND project.lifecycle_state='deleting'))
      AND (claim.event_type<>'ProjectDataChangeRequestedV1' OR (?8=true AND intent.data_change IN ('share_prod_keeps_data','reset_dev') AND environment.name='dev' AND environment.active_deployment_id IS NULL AND environment.active_revision_id IS NULL))`;
export const DELETE_AUTHORITY = `SELECT project.handle,'' AS public_origin
    FROM cleanup_runs cleanup
    JOIN projects project ON project.organization_id=cleanup.organization_id AND project.project_id=cleanup.project_id AND project.lifecycle_state='deleting'
    AND project.owner_state='active'
    JOIN operations operation ON operation.organization_id=cleanup.organization_id AND operation.project_id=cleanup.project_id AND operation.operation_id=cleanup.operation_id AND operation.state IN ('queued','running')
    JOIN product_command_intents intent ON intent.organization_id=cleanup.organization_id AND intent.project_id=cleanup.project_id AND intent.operation_id=cleanup.operation_id AND intent.event_type='ProjectDeletionRequestedV1'
    JOIN environments environment ON environment.organization_id=cleanup.organization_id AND environment.project_id=cleanup.project_id AND environment.environment_id=?3
    WHERE cleanup.organization_id=?1 AND cleanup.project_id=?2 AND cleanup.operation_id=?4 AND cleanup.cleanup_run_id=?5 AND cleanup.state IN ('pending','running')`;
export const CLEARED_ROOT = `SELECT 1 FROM environments environment
       JOIN projects project ON project.organization_id=environment.organization_id AND project.project_id=environment.project_id AND project.lifecycle_state='active'
       AND project.owner_state='active'
       JOIN shared_gateway_route_revisions tombstone ON tombstone.organization_id=environment.organization_id
         AND tombstone.project_id=environment.project_id AND tombstone.environment_id=environment.environment_id
         AND tombstone.action='remove' AND NOT tombstone.active AND tombstone.operation_id<>?4
       JOIN operations removed ON removed.organization_id=tombstone.organization_id
         AND removed.project_id=tombstone.project_id AND removed.operation_id=tombstone.operation_id AND removed.state='succeeded'
       JOIN product_command_intents intent ON intent.organization_id=removed.organization_id
         AND intent.project_id=removed.project_id AND intent.operation_id=removed.operation_id
         AND intent.environment_id=environment.environment_id AND intent.event_type='ProjectDataChangeRequestedV1'
         AND intent.data_change IN ('reset_dev','share_prod_keeps_data')
       JOIN cleanup_runs cleanup ON cleanup.cleanup_run_id=intent.cleanup_run_id
         AND cleanup.organization_id=intent.organization_id AND cleanup.project_id=intent.project_id
         AND cleanup.operation_id=intent.operation_id AND cleanup.state='succeeded'
       WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.environment_id=?3
         AND environment.name='dev' AND environment.active_deployment_id IS NULL AND environment.active_revision_id IS NULL
         AND (SELECT data_environment_id FROM environment_data_assignments current_assignment WHERE current_assignment.organization_id=environment.organization_id AND current_assignment.project_id=environment.project_id AND current_assignment.environment_id=environment.environment_id ORDER BY assignment_version DESC LIMIT 1) IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions later
           JOIN operations operation ON operation.organization_id=later.organization_id
             AND operation.project_id=later.project_id AND operation.operation_id=later.operation_id
           WHERE later.organization_id=tombstone.organization_id AND later.project_id=tombstone.project_id
             AND later.environment_id=tombstone.environment_id AND later.revision>tombstone.revision
             AND (later.operation_id=?4 OR operation.state NOT IN ('failed','cancelled')))
         AND NOT EXISTS(SELECT 1 FROM product_command_intents pending JOIN operations operation
           ON operation.organization_id=pending.organization_id AND operation.project_id=pending.project_id
            AND operation.operation_id=pending.operation_id
           WHERE pending.organization_id=environment.organization_id AND pending.project_id=environment.project_id
             AND pending.event_type='ProjectDataChangeRequestedV1' AND operation.state IN ('queued','running'))`;
export const HEAD_PREDECESSOR = `SELECT 1 FROM environments environment
    WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.environment_id=?3
      AND CASE WHEN environment.active_deployment_id IS NULL AND environment.active_revision_id IS NULL THEN ?6 IS NULL
        ELSE EXISTS (SELECT 1 FROM deployment_revisions head
          JOIN effective_wfp_publish_receipts published ON published.organization_id=head.organization_id AND published.project_id=head.project_id AND published.wfp_receipt_id=head.wfp_receipt_id
          WHERE head.organization_id=environment.organization_id AND head.project_id=environment.project_id AND head.deployment_id=environment.active_deployment_id AND head.revision_id=environment.active_revision_id AND published.shared_gateway_revision=?6) END
      AND NOT EXISTS (SELECT 1 FROM shared_gateway_route_revisions later
        JOIN operations operation ON operation.organization_id=later.organization_id AND operation.project_id=later.project_id AND operation.operation_id=later.operation_id
        WHERE later.organization_id=environment.organization_id AND later.project_id=environment.project_id AND later.environment_id=environment.environment_id
          AND later.revision>COALESCE(?6,0) AND (later.operation_id=?4 OR operation.state NOT IN ('failed','cancelled')))`;

export const ROUTE_ROW = `json_object('organization_id',route.organization_id,'project_id',route.project_id,'environment_id',route.environment_id,
 'environment_name',${deletionGatewayEnvironmentNameSql("environment")},'revision',CAST(route.revision AS TEXT),'predecessor_revision',CAST(route.predecessor_revision AS TEXT),
 'operation_id',route.operation_id,'candidate_receipt_id',route.candidate_receipt_id,'action',route.action,'active',route.active,'handle',route.handle,
 'public_origin',route.public_origin,'egress_allowed_origins',json(route.egress_allowed_origins),'browser_policy',json(route.browser_policy),
 'observed_at',route.observed_at,'product_deployment_id',candidate.product_deployment_id,'immutable_script_name',candidate.immutable_script_name,
 'artifact_sha256',lower(hex(candidate.artifact_sha256)),'provider_tag',candidate.provider_tag)`;
export const ROUTE_FROM = `FROM shared_gateway_route_revisions route JOIN environments environment ON environment.organization_id=route.organization_id
 AND environment.project_id=route.project_id AND environment.environment_id=route.environment_id
 JOIN wfp_candidate_receipts candidate ON candidate.organization_id=route.organization_id AND candidate.project_id=route.project_id
 AND candidate.environment_id=route.environment_id AND candidate.candidate_receipt_id=route.candidate_receipt_id`;
const WHERE_SCOPE = "route.organization_id=?1 AND route.project_id=?2 AND route.environment_id=?3";
export const LATEST = `SELECT ${ROUTE_ROW} value ${ROUTE_FROM} WHERE ${WHERE_SCOPE} ORDER BY route.revision DESC LIMIT 1`;
const BASE = `SELECT ${ROUTE_ROW} value ${ROUTE_FROM} WHERE ${WHERE_SCOPE} AND route.revision=?6`;
const PRIOR = `SELECT ${ROUTE_ROW} value ${ROUTE_FROM} WHERE ${WHERE_SCOPE} AND route.revision=(SELECT predecessor_revision
 FROM shared_gateway_route_revisions WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 ORDER BY revision DESC LIMIT 1)`;
const AVAILABLE = `SELECT json_group_array(candidate_receipt_id) FROM(SELECT candidate.candidate_receipt_id FROM wfp_candidate_receipts candidate
 WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3
 AND candidate.candidate_receipt_id IN (?7,json_extract((SELECT value FROM(${LATEST})),'$.candidate_receipt_id'),
 json_extract((SELECT value FROM(${BASE})),'$.candidate_receipt_id'),json_extract((SELECT value FROM(${PRIOR})),'$.candidate_receipt_id'))
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_requests cleanup WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)
 ORDER BY candidate.candidate_receipt_id)`;
const CANDIDATE = `SELECT json_object('organization_id',candidate.organization_id,'project_id',candidate.project_id,'environment_id',candidate.environment_id,
 'environment_name',${deletionGatewayEnvironmentNameSql("environment")},'candidate_receipt_id',candidate.candidate_receipt_id,'product_deployment_id',candidate.product_deployment_id,
 'immutable_script_name',candidate.immutable_script_name,'artifact_sha256',lower(hex(candidate.artifact_sha256)),'provider_tag',candidate.provider_tag)
 FROM wfp_candidate_receipts candidate JOIN environments environment ON environment.organization_id=candidate.organization_id
 AND environment.project_id=candidate.project_id AND environment.environment_id=candidate.environment_id
 WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3 AND candidate.candidate_receipt_id=?7`;
const RENAME = `SELECT 1 FROM product_command_intents intent JOIN projects project ON project.organization_id=intent.organization_id AND project.project_id=intent.project_id
 JOIN cloudflare_project_domains domain ON domain.organization_id=intent.organization_id AND domain.project_id=intent.project_id AND domain.deleted_at IS NULL
 JOIN environments environment ON environment.organization_id=intent.organization_id AND environment.project_id=intent.project_id AND environment.environment_id=?3
 WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.operation_id=?4 AND intent.event_type='ProjectHandleChangeRequestedV1'
 AND intent.requested_handle=(SELECT handle FROM(${AUTHORITY}))
 AND project.handle=json_extract((SELECT value FROM(${PRIOR})),'$.handle') AND domain.handle=project.handle
 AND json_extract((SELECT value FROM(${PRIOR})),'$.public_origin')='https://'||CASE environment.name WHEN 'dev' THEN domain.development_domain ELSE domain.production_domain END`;

/** One consistent decision document. Its exact SQL expression is checked again by the final write batch. */
export const MUTATION_STATE = `SELECT json_object('authority',json((SELECT json_object('handle',handle,'public_origin',public_origin) FROM(${AUTHORITY}))),
 'deletion',json((SELECT json_object('handle',handle,'public_origin',public_origin) FROM(${DELETE_AUTHORITY}))),
 'latest',json((SELECT value FROM(${LATEST}))),'base',json((SELECT value FROM(${BASE}))),'prior',json((SELECT value FROM(${PRIOR}))),
 'candidate',json((${CANDIDATE})),'available',json((${AVAILABLE})),
 'cleared',(SELECT count(*) FROM(${CLEARED_ROOT}))=1,'fallback',(SELECT count(*) FROM(${HEAD_PREDECESSOR}))=1,
 'rename',(SELECT count(*) FROM(${RENAME}))=1,
 'environment',json((SELECT json_object('head_version',CAST(head_version AS TEXT),'deployment',active_deployment_id,'revision',active_revision_id,
 'owner_state',project.owner_state,'ownership_version',CAST(project.ownership_version AS TEXT),'lifecycle',project.lifecycle_state,'lifecycle_version',CAST(project.lifecycle_version AS TEXT))
 FROM environments environment JOIN projects project USING(organization_id,project_id) WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.environment_id=?3))) document`;
export function mutationParams(
  input: Mutation,
  candidate: string,
  allowDeleting: boolean,
): unknown[] {
  return [
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.operationId,
    input.claimId,
    input.expectedRevision,
    candidate,
    allowDeleting ? 1 : 0,
  ];
}
export async function readMutationDocument(db: D1Database, params: unknown[]): Promise<string> {
  const row = await db
    .prepare(MUTATION_STATE)
    .bind(...params)
    .first<{ document: string }>();
  if (row === null) throw new SharedGatewayConflictError();
  return row.document;
}
