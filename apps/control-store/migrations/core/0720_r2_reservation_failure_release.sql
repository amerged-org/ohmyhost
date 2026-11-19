-- The failure path of an operation deletes its provider mutation claim in the same batch that fails the operation (deployment-
-- failure.ts). A project R2 bucket reservation of that claim references the claim with ON DELETE RESTRICT, so the claim could not
-- leave while the reservation remained, the operation could not end, and the reservation could never be superseded: the
-- supersede answers operation_open forever. Only the supersede path (0665, 0666) had released a reservation.
--
-- Now the claim's delete releases the reservation of an ended operation itself, in the same statement and before the reference
-- check. The reservation's own delete rule still decides what may leave: a spent create authorization needs absence observed after
-- the spend (0666); an unspent reservation was never able to create a bucket, so it may leave once its operation has ended. A
-- running operation keeps its claim and its reservation, and a reservation that cannot leave aborts the whole delete.
--
-- The claim delete guard (0634) no longer exempts a claim while a reservation of its operation exists: the release above decides
-- that case, and the guard's closure conditions then apply to every ended operation in the same way. Applying this file again
-- changes nothing, because every statement drops and recreates its trigger.

DROP TRIGGER IF EXISTS project_r2_bucket_reservations_delete;
CREATE TRIGGER project_r2_bucket_reservations_delete BEFORE DELETE ON project_r2_bucket_reservations
 WHEN NOT (
  EXISTS(SELECT 1 FROM project_r2_bucket_receipts r WHERE r.organization_id=OLD.organization_id AND r.project_id=OLD.project_id AND r.environment_id=OLD.environment_id AND r.claim_id=OLD.claim_id)
  OR EXISTS(SELECT 1 FROM project_r2_bucket_absences a WHERE a.organization_id=OLD.organization_id AND a.project_id=OLD.project_id AND a.environment_id=OLD.environment_id AND a.claim_id=OLD.claim_id AND a.bucket_name=OLD.bucket_name AND (OLD.create_started_at IS NULL OR a.observed_at>=OLD.create_started_at))
  OR (OLD.create_started_at IS NULL AND EXISTS(SELECT 1 FROM operations o WHERE o.organization_id=OLD.organization_id AND o.project_id=OLD.project_id AND o.operation_id=OLD.operation_id AND o.state IN ('succeeded','failed','cancelled')))
 )
 BEGIN SELECT RAISE(ABORT,'active R2 bucket reservation cannot be deleted'); END;

DROP TRIGGER IF EXISTS product_provider_mutation_claims_release_bucket_reservation;
CREATE TRIGGER product_provider_mutation_claims_release_bucket_reservation BEFORE DELETE ON product_provider_mutation_claims
WHEN EXISTS(SELECT 1 FROM operations o WHERE o.organization_id=OLD.organization_id AND o.project_id=OLD.project_id AND o.operation_id=OLD.operation_id AND o.state IN ('succeeded','failed','cancelled'))
BEGIN
 DELETE FROM project_r2_bucket_reservations WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND environment_id=OLD.environment_id AND claim_id=OLD.claim_id AND operation_id=OLD.operation_id;
END;

DROP TRIGGER IF EXISTS product_provider_mutation_claims_delete_guard;
CREATE TRIGGER product_provider_mutation_claims_delete_guard BEFORE DELETE ON product_provider_mutation_claims
WHEN NOT EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=OLD.organization_id AND operation.project_id=OLD.project_id AND operation.operation_id=OLD.operation_id AND operation.state IN ('succeeded','failed'))
 AND NOT EXISTS(SELECT 1 FROM product_provider_reconciliation_attempts attempt WHERE attempt.mode='abandon' AND attempt.outcome='resolved_absent' AND attempt.claim_id=OLD.claim_id AND attempt.organization_id=OLD.organization_id AND attempt.project_id=OLD.project_id AND attempt.environment_id=OLD.environment_id AND attempt.operation_id=OLD.operation_id AND attempt.event_id=OLD.event_id AND attempt.billing_epoch_id=OLD.billing_epoch_id AND attempt.logical_workflow_id=OLD.logical_workflow_id AND attempt.event_type=OLD.event_type AND attempt.accepted_lifecycle_version=OLD.accepted_lifecycle_version)
 AND NOT ( EXISTS(SELECT 1 FROM operations cancelled WHERE cancelled.organization_id=OLD.organization_id AND cancelled.project_id=OLD.project_id AND cancelled.operation_id=OLD.operation_id AND cancelled.state='cancelled')
 AND EXISTS(SELECT 1 FROM github_push_deployments push WHERE push.organization_id=OLD.organization_id AND push.project_id=OLD.project_id AND push.operation_id=OLD.operation_id AND push.state='superseded' AND push.cleanup_required=0)
 AND EXISTS(SELECT 1 FROM wfp_candidate_receipts candidate WHERE candidate.organization_id=OLD.organization_id AND candidate.project_id=OLD.project_id AND candidate.operation_id=OLD.operation_id)
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_receipts candidate WHERE candidate.organization_id=OLD.organization_id AND candidate.project_id=OLD.project_id AND candidate.operation_id=OLD.operation_id
  AND (NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_requests request JOIN wfp_candidate_cleanup_receipts cleanup ON cleanup.candidate_receipt_id=request.candidate_receipt_id WHERE request.candidate_receipt_id=candidate.candidate_receipt_id)
   OR EXISTS(SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected WHERE expected.candidate_receipt_id=candidate.candidate_receipt_id AND NOT EXISTS(SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual WHERE actual.cleanup_request_id=expected.cleanup_request_id AND actual.provider=expected.provider AND actual.resource_kind=expected.resource_kind AND actual.resource_identity_sha256=expected.resource_identity_sha256))
   OR EXISTS(SELECT 1 FROM wfp_candidate_operation_cleanup_receipts actual WHERE actual.candidate_receipt_id=candidate.candidate_receipt_id AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_resource_expectations expected WHERE expected.cleanup_request_id=actual.cleanup_request_id AND expected.provider=actual.provider AND expected.resource_kind=actual.resource_kind AND expected.resource_identity_sha256=actual.resource_identity_sha256))))
 AND NOT EXISTS(SELECT 1 FROM product_provider_reconciliation_attempts attempt WHERE attempt.organization_id=OLD.organization_id AND attempt.project_id=OLD.project_id AND attempt.operation_id=OLD.operation_id AND attempt.outcome='unknown')
 AND NOT EXISTS(SELECT 1 FROM neon_project_placement_reservations placement WHERE placement.organization_id=OLD.organization_id AND placement.project_id=OLD.project_id AND placement.operation_id=OLD.operation_id)
 AND NOT EXISTS(SELECT 1 FROM native_auth_database_operations native_create WHERE native_create.organization_id=OLD.organization_id AND native_create.project_id=OLD.project_id AND native_create.operation_id=OLD.operation_id AND native_create.state IN ('reserved','dispatched'))
 AND NOT EXISTS(SELECT 1 FROM product_workflow_runs run WHERE run.organization_id=OLD.organization_id AND run.project_id=OLD.project_id AND run.operation_id=OLD.operation_id AND (run.state<>'completed' OR run.active_reconciliation_attempt_id IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM deployments deployment WHERE deployment.organization_id=OLD.organization_id AND deployment.project_id=OLD.project_id AND deployment.operation_id=OLD.operation_id AND deployment.status NOT IN ('succeeded','failed')))
BEGIN SELECT RAISE(ABORT,'active product provider mutation claim cannot be deleted'); END;
