import { routeOrganization, type CatalogContext } from "../common.js";
import { removalInput, SharedGatewayConflictError } from "./contracts.js";

// Exact original removal authorities: data reset, completed binding refresh, accepted project deletion, or live candidate cleanup.
// The provider still performs its own scoped removal. This read neither accepts a cleanup nor invents an absence receipt.
const REMOVAL = `SELECT 1 FROM wfp_candidate_receipts candidate
    JOIN projects project ON project.organization_id=candidate.organization_id AND project.project_id=candidate.project_id AND project.owner_state='active'

    JOIN environments environment ON environment.organization_id=candidate.organization_id AND environment.project_id=candidate.project_id AND environment.environment_id=candidate.environment_id
    WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3 AND candidate.candidate_receipt_id=?6
      AND candidate.product_deployment_id=?7 AND candidate.immutable_script_name=?8 AND candidate.provider_tag=?9
      AND ((project.lifecycle_state='active' AND environment.name='dev' AND environment.active_deployment_id IS NULL AND EXISTS (
        SELECT 1 FROM product_provider_mutation_claims claim
        JOIN product_command_intents intent ON intent.organization_id=claim.organization_id AND intent.project_id=claim.project_id AND intent.operation_id=claim.operation_id
        JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id
        WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.operation_id=?4 AND claim.claim_id=?5
          AND claim.environment_id=?3 AND claim.event_type='ProjectDataChangeRequestedV1'
          AND intent.event_type=claim.event_type AND intent.data_change IN ('share_prod_keeps_data','reset_dev')
          AND operation.state IN ('queued','running') AND claim.accepted_lifecycle_version=project.lifecycle_version
      )) OR (project.lifecycle_state='active' AND EXISTS (
        SELECT 1 FROM product_provider_mutation_claims refresh_claim
        JOIN product_command_intents refresh_intent ON refresh_intent.organization_id=refresh_claim.organization_id AND refresh_intent.project_id=refresh_claim.project_id AND refresh_intent.operation_id=refresh_claim.operation_id
        JOIN operations refresh_operation ON refresh_operation.organization_id=refresh_claim.organization_id AND refresh_operation.project_id=refresh_claim.project_id AND refresh_operation.operation_id=refresh_claim.operation_id
        JOIN deployment_revisions refreshed ON refreshed.organization_id=environment.organization_id AND refreshed.project_id=environment.project_id AND refreshed.deployment_id=environment.active_deployment_id AND refreshed.revision_id=environment.active_revision_id
        WHERE refresh_claim.organization_id=?1 AND refresh_claim.project_id=?2 AND refresh_claim.environment_id=?3 AND refresh_claim.operation_id=?4 AND refresh_claim.claim_id=?5
          AND refresh_claim.event_type='DeploymentRequestedV1' AND refresh_intent.event_type=refresh_claim.event_type AND refresh_intent.binding_refresh_snapshot IS NOT NULL
          AND refresh_operation.state='running' AND refresh_claim.accepted_lifecycle_version=project.lifecycle_version
          AND refresh_intent.binding_refresh_snapshot->>'sourceCandidateReceiptId'=candidate.candidate_receipt_id
          AND refresh_intent.binding_refresh_snapshot->>'sourceNamespace'=candidate.dispatch_namespace
          AND refresh_intent.binding_refresh_snapshot->>'sourceScriptName'=candidate.immutable_script_name
          AND refresh_intent.binding_refresh_snapshot->>'sourceProviderTag'=candidate.provider_tag
          AND refreshed.operation_id=?4 AND refreshed.deployment_id=refresh_intent.deployment_id
          AND refreshed.artifact_id=refresh_intent.binding_refresh_snapshot->>'sourceArtifactId'
          AND EXISTS(SELECT 1 FROM wfp_publish_receipts refreshed_receipt JOIN shared_gateway_route_revisions live ON live.organization_id=?1 AND live.project_id=?2 AND live.environment_id=?3
            AND live.active=1 AND live.operation_id=?4 AND live.candidate_receipt_id=refreshed_receipt.candidate_receipt_id
            AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions newer WHERE newer.organization_id=live.organization_id AND newer.project_id=live.project_id AND newer.environment_id=live.environment_id AND newer.revision>live.revision)
            WHERE refreshed_receipt.organization_id=?1 AND refreshed_receipt.project_id=?2 AND refreshed_receipt.environment_id=?3
              AND refreshed_receipt.wfp_receipt_id=refreshed.wfp_receipt_id)
          AND environment.head_version=(refresh_intent.binding_refresh_snapshot->>'expectedHeadVersion')+1
          AND (SELECT data_environment_id FROM environment_data_assignments current_assignment WHERE current_assignment.organization_id=?1 AND current_assignment.project_id=?2 AND current_assignment.environment_id=?3 ORDER BY assignment_version DESC LIMIT 1)=refresh_intent.binding_refresh_snapshot->>'dataEnvironmentId'
      ) AND NOT EXISTS (
        SELECT 1 FROM environments other JOIN deployment_revisions other_head
          ON other_head.organization_id=other.organization_id AND other_head.project_id=other.project_id AND other_head.deployment_id=other.active_deployment_id AND other_head.revision_id=other.active_revision_id
        JOIN wfp_publish_receipts other_published ON other_published.organization_id=other_head.organization_id AND other_published.project_id=other_head.project_id AND other_published.wfp_receipt_id=other_head.wfp_receipt_id
        WHERE other.organization_id=?1 AND other.project_id=?2 AND other_published.candidate_receipt_id=candidate.candidate_receipt_id
      )) OR (project.lifecycle_state='deleting' AND EXISTS (
        -- The accepted deletion's pending or running cleanup run is the authority.
        SELECT 1 FROM cleanup_runs cleanup
        JOIN operations operation ON operation.organization_id=cleanup.organization_id AND operation.project_id=cleanup.project_id AND operation.operation_id=cleanup.operation_id AND operation.state IN ('queued','running')
        JOIN product_command_intents intent ON intent.organization_id=cleanup.organization_id AND intent.project_id=cleanup.project_id AND intent.operation_id=cleanup.operation_id AND intent.event_type='ProjectDeletionRequestedV1'
        WHERE cleanup.organization_id=?1 AND cleanup.project_id=?2 AND cleanup.operation_id=?4 AND cleanup.cleanup_run_id=?5 AND cleanup.state IN ('pending','running')
      )) OR (project.lifecycle_state='active' AND EXISTS (
        SELECT 1 FROM wfp_candidate_cleanup_requests request
        JOIN wfp_candidate_cleanup_claims claim ON claim.organization_id=request.organization_id AND claim.project_id=request.project_id AND claim.candidate_receipt_id=request.candidate_receipt_id
        WHERE request.organization_id=?1 AND request.project_id=?2 AND request.candidate_receipt_id=?6 AND request.operation_id=?4 AND claim.claim_id=?5 AND claim.lease_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
      ) AND NOT EXISTS (
        -- An exact v7 route can still dispatch to this candidate during cutover.
        SELECT 1 FROM wfp_publish_receipts legacy
        WHERE legacy.organization_id=candidate.organization_id AND legacy.project_id=candidate.project_id
          AND legacy.environment_id=candidate.environment_id AND legacy.candidate_receipt_id=candidate.candidate_receipt_id
          AND legacy.gateway_script_name IS NOT NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM deployment_revisions head
        JOIN effective_wfp_publish_receipts published ON published.organization_id=head.organization_id AND published.project_id=head.project_id AND published.wfp_receipt_id=head.wfp_receipt_id
        WHERE head.organization_id=environment.organization_id AND head.project_id=environment.project_id AND head.deployment_id=environment.active_deployment_id AND head.revision_id=environment.active_revision_id AND published.candidate_receipt_id=candidate.candidate_receipt_id
      )))`;
export async function authorizeGatewayCandidateRemoval(
  context: CatalogContext,
  raw: unknown,
): Promise<{ authorized: true }> {
  const input = removalInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const prefix = `p-${input.projectId.toLowerCase()}-`,
    suffix = `-${input.productDeploymentId.toLowerCase()}`;
  if (!input.scriptName.startsWith(prefix) || !input.scriptName.endsWith(suffix))
    throw new SharedGatewayConflictError();
  const rows = (
    await db
      .prepare(REMOVAL)
      .bind(
        input.organizationId,
        input.projectId,
        input.environmentId,
        input.operationId,
        input.claimId,
        input.candidateReceiptId,
        input.productDeploymentId,
        input.scriptName,
        input.providerTag,
      )
      .all()
  ).results;
  if (rows.length !== 1) throw new SharedGatewayConflictError();
  return { authorized: true };
}
