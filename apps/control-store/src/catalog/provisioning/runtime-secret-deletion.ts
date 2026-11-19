import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { resourceHash } from "./context-values.js";
import { archivedDevProofSql } from "./deletion-environments.js";

export interface RuntimeSecretDeletionScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  operationId: string;
  completedAt: string;
}
export interface RuntimeSecretDeletionPublication {
  dispatch_namespace: string;
  script_name: string;
}
/** The existing active revision identifies the one original publication whose exact cleanup hash is needed. */
export function runtimeSecretDeletionPublication(
  db: D1Database,
  input: RuntimeSecretDeletionScope,
) {
  return db
    .prepare(
      `SELECT publication.dispatch_namespace,publication.script_name
 FROM environments environment JOIN deployment_revisions revision
 ON revision.organization_id=environment.organization_id AND revision.project_id=environment.project_id
 AND revision.deployment_id=environment.active_deployment_id AND revision.revision_id=environment.active_revision_id
 JOIN wfp_publish_receipts publication ON publication.organization_id=revision.organization_id
 AND publication.project_id=revision.project_id AND publication.environment_id=environment.environment_id
 AND publication.wfp_receipt_id=revision.wfp_receipt_id AND publication.shared_gateway_revision IS NOT NULL
 WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.environment_id=?3
 UNION SELECT candidate.dispatch_namespace,candidate.immutable_script_name script_name
 FROM environments environment JOIN runtime_secret_delivery_states state USING(organization_id,project_id,environment_id)
 JOIN wfp_candidate_receipts candidate ON candidate.organization_id=state.organization_id AND candidate.project_id=state.project_id AND candidate.environment_id=state.environment_id AND candidate.provider_tag=state.provider_tag
 WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.environment_id=?3 AND ${archivedDevProofSql("environment")} AND environment.active_deployment_id IS NULL AND environment.active_revision_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_receipts other WHERE other.organization_id=state.organization_id AND other.project_id=state.project_id AND other.environment_id=state.environment_id AND other.provider_tag=state.provider_tag AND(other.dispatch_namespace<>candidate.dispatch_namespace OR other.immutable_script_name<>candidate.immutable_script_name))`,
    )
    .bind(input.organizationId, input.projectId, input.environmentId);
}
export async function runtimeSecretDeletionHash(
  publication: RuntimeSecretDeletionPublication | null,
) {
  return publication === null
    ? null
    : resourceHash(
        "cloudflare",
        "wfp-script",
        `${publication.dispatch_namespace}/${publication.script_name}`,
      );
}
/** Exact original finalizeRuntimeSecretDeletion authorization. This plan is server-local and shares the parent batch. */
export function runtimeSecretDeletionStatements(
  db: D1Database,
  input: RuntimeSecretDeletionScope,
  publication: RuntimeSecretDeletionPublication | null,
  publicationHash: string | null,
): D1PreparedStatement[] {
  const retiredProof = `${archivedDevProofSql("environment")} AND environment.active_deployment_id IS NULL AND environment.active_revision_id IS NULL AND state.provider_tag IS NOT NULL
 AND EXISTS(SELECT 1 FROM wfp_candidate_receipts candidate WHERE candidate.organization_id=state.organization_id AND candidate.project_id=state.project_id AND candidate.environment_id=state.environment_id AND candidate.provider_tag=state.provider_tag AND candidate.dispatch_namespace=?6 AND candidate.immutable_script_name=?7)
 AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions route WHERE route.organization_id=state.organization_id AND route.project_id=state.project_id AND route.environment_id=state.environment_id AND route.active AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions newer WHERE newer.organization_id=route.organization_id AND newer.project_id=route.project_id AND newer.environment_id=route.environment_id AND newer.revision>route.revision))
 AND EXISTS(SELECT 1 FROM run_resource_inventory inventory WHERE inventory.organization_id=state.organization_id AND inventory.project_id=state.project_id AND inventory.operation_id=?4 AND inventory.provider='cloudflare' AND inventory.resource_kind='wfp-script' AND inventory.external_ref_hash=unhex(?8)
 AND(SELECT attempt.outcome FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id AND attempt.provider=inventory.provider AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash ORDER BY attempt.attempted_at DESC,attempt.cleanup_attempt_id DESC LIMIT 1) IN('removed','not_found')
 AND(SELECT attempt.attempted_at FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id AND attempt.provider=inventory.provider AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash ORDER BY attempt.attempted_at DESC,attempt.cleanup_attempt_id DESC LIMIT 1)<=?5)`;
  // The original publication is cleaned up with its exact WfP script removed: the secrets of that scope are not needed any more.
  const publicationProof = `revision.revision_id IS NOT NULL AND state.provider_tag IS NOT NULL AND EXISTS(SELECT 1 FROM wfp_publish_receipts publication
 WHERE publication.organization_id=revision.organization_id AND publication.project_id=revision.project_id
 AND publication.environment_id=state.environment_id AND publication.wfp_receipt_id=revision.wfp_receipt_id
 AND publication.shared_gateway_revision IS NOT NULL AND publication.dispatch_namespace=?6 AND publication.script_name=?7
 AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions route WHERE route.organization_id=state.organization_id
 AND route.project_id=state.project_id AND route.environment_id=state.environment_id AND route.active
 AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions newer WHERE newer.organization_id=route.organization_id
 AND newer.project_id=route.project_id AND newer.environment_id=route.environment_id AND newer.revision>route.revision))
 AND EXISTS(SELECT 1 FROM run_resource_inventory inventory WHERE inventory.organization_id=state.organization_id
 AND inventory.project_id=state.project_id AND inventory.operation_id=?4 AND inventory.provider='cloudflare'
 AND inventory.resource_kind='wfp-script' AND inventory.external_ref_hash=unhex(?8)
 AND(SELECT attempt.outcome FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id
 AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id AND attempt.provider=inventory.provider
 AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash
 ORDER BY attempt.attempted_at DESC,attempt.cleanup_attempt_id DESC LIMIT 1) IN('removed','not_found')
 AND(SELECT attempt.attempted_at FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id
 AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id AND attempt.provider=inventory.provider
 AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash
 ORDER BY attempt.attempted_at DESC,attempt.cleanup_attempt_id DESC LIMIT 1)<=?5))`;
  const authorized = `SELECT 1 FROM runtime_secret_delivery_states state
 JOIN product_command_intents intent ON intent.organization_id=state.organization_id
 AND intent.project_id=state.project_id AND intent.operation_id=?4 AND intent.event_type='ProjectDeletionRequestedV1'
 JOIN operations operation ON operation.organization_id=intent.organization_id
 AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id AND operation.state IN('queued','running')
 JOIN projects project ON project.organization_id=state.organization_id AND project.project_id=state.project_id
 AND project.owner_state='active' AND project.lifecycle_state='deleting'
 JOIN environments environment ON environment.organization_id=state.organization_id
 AND environment.project_id=state.project_id AND environment.environment_id=state.environment_id
 LEFT JOIN deployment_revisions revision ON revision.organization_id=environment.organization_id
 AND revision.project_id=environment.project_id AND revision.deployment_id=environment.active_deployment_id
 AND revision.revision_id=environment.active_revision_id
 WHERE state.organization_id=?1 AND state.project_id=?2 AND state.environment_id=?3 AND(state.active_lease_id IS NULL OR state.lease_expires_at<=?5)
 AND(state.desired_generation=state.applied_generation OR(environment.active_deployment_id IS NULL
 AND environment.active_revision_id IS NULL AND state.provider_tag IS NULL AND state.applied_secret_count=0
 AND json_array_length(state.applied_secret_names)=0 AND NOT EXISTS(SELECT 1 FROM wfp_publish_receipts publication
 WHERE publication.organization_id=state.organization_id AND publication.project_id=state.project_id AND publication.environment_id=state.environment_id)) OR(${retiredProof}) OR(${publicationProof}))
 AND((environment.active_revision_id IS NULL AND state.provider_tag IS NULL AND state.applied_secret_count=0)
 OR(revision.revision_id IS NOT NULL AND state.provider_tag IS NOT NULL AND state.applied_secret_count=0
 AND json_array_length(state.applied_secret_names)=0 AND EXISTS(SELECT 1 FROM runtime_secret_delivery_receipts receipt
 WHERE receipt.organization_id=state.organization_id AND receipt.project_id=state.project_id AND receipt.environment_id=state.environment_id
 AND receipt.release_sequence=state.applied_release_sequence AND receipt.generation=state.applied_generation
 AND receipt.manifest_sha256=state.applied_manifest_sha256 AND receipt.manifest_secret_count=0 AND json_array_length(receipt.applied_secret_names)=0))
 OR(${retiredProof})
 OR(${publicationProof}))`;
  const values = [
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.operationId,
    input.completedAt,
    publication?.dispatch_namespace ?? null,
    publication?.script_name ?? null,
    publicationHash,
  ];
  return [
    // An environment that never claimed runtime secrets has no delivery state and no publication to authorize.
    guard(
      db,
      "operation_conflict",
      `NOT EXISTS(${authorized}) AND(EXISTS(SELECT 1 FROM runtime_secret_delivery_states state WHERE state.organization_id=?1 AND state.project_id=?2 AND state.environment_id=?3)
 OR EXISTS(SELECT 1 FROM wfp_publish_receipts publication WHERE publication.organization_id=?1 AND publication.project_id=?2 AND publication.environment_id=?3))`,
      values,
    ),
    db
      .prepare(
        "DELETE FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(input.organizationId, input.projectId, input.environmentId),
  ];
}
