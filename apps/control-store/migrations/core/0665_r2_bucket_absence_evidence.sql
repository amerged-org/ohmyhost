-- Durable absence evidence for a project R2 bucket reservation. A provider read that proves the bucket absent is
-- recorded here before the reservation may be superseded. The evidence is append-only: it never changes or expires.
CREATE TABLE project_r2_bucket_absences (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26),
 project_id TEXT NOT NULL CHECK(length(project_id)=26),
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26),
 claim_id TEXT NOT NULL CHECK(length(claim_id)=26),
 bucket_name TEXT NOT NULL,
 observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(organization_id,project_id,environment_id,claim_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER project_r2_bucket_absences_no_update BEFORE UPDATE ON project_r2_bucket_absences BEGIN SELECT RAISE(ABORT,'R2 bucket absence evidence is append-only'); END;
CREATE TRIGGER project_r2_bucket_absences_no_delete BEFORE DELETE ON project_r2_bucket_absences BEGIN SELECT RAISE(ABORT,'R2 bucket absence evidence is append-only'); END;
-- A reservation may leave only with its receipt, or without a create authorization once absence of its bucket is proven.
DROP TRIGGER IF EXISTS project_r2_bucket_reservations_delete;
CREATE TRIGGER project_r2_bucket_reservations_delete BEFORE DELETE ON project_r2_bucket_reservations
 WHEN NOT (
  EXISTS(SELECT 1 FROM project_r2_bucket_receipts r WHERE r.organization_id=OLD.organization_id AND r.project_id=OLD.project_id AND r.environment_id=OLD.environment_id AND r.claim_id=OLD.claim_id)
  OR (OLD.create_started_at IS NULL AND EXISTS(SELECT 1 FROM project_r2_bucket_absences a WHERE a.organization_id=OLD.organization_id AND a.project_id=OLD.project_id AND a.environment_id=OLD.environment_id AND a.claim_id=OLD.claim_id AND a.bucket_name=OLD.bucket_name))
 )
 BEGIN SELECT RAISE(ABORT,'active R2 bucket reservation cannot be deleted'); END;
