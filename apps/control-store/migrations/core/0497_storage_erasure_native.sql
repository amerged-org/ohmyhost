-- Actual original167 erasure facts for the real StorageGateway producer; no receipt aliases or seeded proofs.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE project_r2_erasure_barriers (
 transfer_id TEXT NOT NULL PRIMARY KEY REFERENCES project_r2_upload_reservations(transfer_id),
 deletion_id TEXT NOT NULL REFERENCES project_r2_delete_requests(deletion_id),
 organization_id TEXT NOT NULL,project_id TEXT NOT NULL,environment_id TEXT NOT NULL,data_environment_id TEXT NOT NULL,
 object_key TEXT NOT NULL,physical_object_key TEXT NOT NULL,bucket_name TEXT NOT NULL,
 jurisdiction TEXT NOT NULL CHECK(jurisdiction IN('us','eu')),
 marker_sha256 BLOB NOT NULL CHECK(length(marker_sha256)=32),
 erased_at TEXT NOT NULL CHECK(erased_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(erased_at AS BLOB))=27),
 UNIQUE(organization_id,project_id,environment_id,physical_object_key),
 FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES project_r2_bucket_receipts(organization_id,project_id,environment_id),
 FOREIGN KEY(organization_id,project_id,data_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER project_r2_erasure_barriers_scope BEFORE INSERT ON project_r2_erasure_barriers
 WHEN NOT EXISTS(SELECT 1 FROM project_r2_upload_reservations reservation
 JOIN project_r2_delete_requests request USING(organization_id,project_id,environment_id,data_environment_id,object_key,physical_object_key)
 JOIN project_r2_bucket_receipts bucket USING(organization_id,project_id,environment_id)
 WHERE reservation.transfer_id=NEW.transfer_id AND request.deletion_id=NEW.deletion_id
 AND NEW.organization_id=reservation.organization_id AND NEW.project_id=reservation.project_id AND NEW.environment_id=reservation.environment_id AND NEW.data_environment_id=reservation.data_environment_id
 AND NEW.object_key=reservation.object_key AND NEW.physical_object_key=reservation.physical_object_key AND NEW.bucket_name=bucket.bucket_name AND NEW.jurisdiction=bucket.jurisdiction
 AND NEW.erased_at>=request.requested_at AND NEW.erased_at>=reservation.requested_at)
 BEGIN SELECT RAISE(ABORT,'storage erasure scope does not match accepted request and reservation'); END;
-- Core's closed completion command verifies the original deterministic SHA256 over this exact scope before INSERT.
-- D1 has no PostgreSQL sha256 SQL function; the raw importer must use the same native marker validator.
CREATE TRIGGER project_r2_erasure_barriers_no_update BEFORE UPDATE ON project_r2_erasure_barriers BEGIN SELECT RAISE(ABORT,'storage erasure barriers are append-only'); END;
CREATE TRIGGER project_r2_erasure_barriers_no_delete BEFORE DELETE ON project_r2_erasure_barriers BEGIN SELECT RAISE(ABORT,'storage erasure barriers are append-only'); END;
