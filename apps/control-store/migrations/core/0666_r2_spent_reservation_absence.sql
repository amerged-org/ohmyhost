-- A reservation whose create authorization was spent may leave once its bucket is proven absent by a read taken after the
-- spend (0665 allowed only an unspent reservation). Evidence observed before the spend says nothing about a create that
-- spend may have made, so it keeps the reservation. Idempotent: the trigger is replaced in place.
DROP TRIGGER IF EXISTS project_r2_bucket_reservations_delete;
CREATE TRIGGER project_r2_bucket_reservations_delete BEFORE DELETE ON project_r2_bucket_reservations
 WHEN NOT (
  EXISTS(SELECT 1 FROM project_r2_bucket_receipts r WHERE r.organization_id=OLD.organization_id AND r.project_id=OLD.project_id AND r.environment_id=OLD.environment_id AND r.claim_id=OLD.claim_id)
  OR EXISTS(SELECT 1 FROM project_r2_bucket_absences a WHERE a.organization_id=OLD.organization_id AND a.project_id=OLD.project_id AND a.environment_id=OLD.environment_id AND a.claim_id=OLD.claim_id AND a.bucket_name=OLD.bucket_name AND (OLD.create_started_at IS NULL OR a.observed_at>=OLD.create_started_at))
 )
 BEGIN SELECT RAISE(ABORT,'active R2 bucket reservation cannot be deleted'); END;
