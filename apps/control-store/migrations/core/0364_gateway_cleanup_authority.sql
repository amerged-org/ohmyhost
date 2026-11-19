-- Original062 mutable cleanup authority, replacing no immutable absence evidence.
-- The earlier merged prototype is preserved byte-for-byte as read-only compatibility history. Its request/claim
-- facts are projected only when every original static parent and shape holds; ambiguous/incomplete facts abort.
CREATE TABLE wfp_candidate_cleanup_requests (
  cleanup_request_id TEXT NOT NULL PRIMARY KEY CHECK(length(cleanup_request_id)=26 AND substr(cleanup_request_id,1,1) BETWEEN '0' AND '7' AND cleanup_request_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  candidate_receipt_id TEXT NOT NULL CHECK(length(candidate_receipt_id)=26 AND substr(candidate_receipt_id,1,1) BETWEEN '0' AND '7' AND candidate_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  operation_id TEXT NOT NULL CHECK(length(operation_id)=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  reason TEXT NOT NULL CHECK(reason IN('superseded','failed','compensate')),
  requested_at TEXT NOT NULL CHECK(requested_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(candidate_receipt_id),
  FOREIGN KEY(organization_id,project_id,candidate_receipt_id,operation_id) REFERENCES wfp_candidate_receipts(organization_id,project_id,candidate_receipt_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER wfp_candidate_cleanup_requests_no_update BEFORE UPDATE ON wfp_candidate_cleanup_requests
BEGIN SELECT RAISE(ABORT,'Candidate cleanup requests are append-only'); END;
CREATE TRIGGER wfp_candidate_cleanup_requests_no_delete BEFORE DELETE ON wfp_candidate_cleanup_requests
BEGIN SELECT RAISE(ABORT,'Candidate cleanup requests are append-only'); END;
CREATE TABLE wfp_candidate_cleanup_claims (
  candidate_receipt_id TEXT NOT NULL PRIMARY KEY CHECK(length(candidate_receipt_id)=26 AND substr(candidate_receipt_id,1,1) BETWEEN '0' AND '7' AND candidate_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  claim_id TEXT NOT NULL UNIQUE CHECK(length(claim_id)=26 AND substr(claim_id,1,1) BETWEEN '0' AND '7' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 2147483647),
  claimed_at TEXT NOT NULL CHECK(claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at TEXT NOT NULL CHECK(lease_expires_at GLOB '????-??-??T??:??:??.??????Z' AND lease_expires_at>claimed_at),
  FOREIGN KEY(organization_id,project_id,candidate_receipt_id) REFERENCES wfp_candidate_receipts(organization_id,project_id,candidate_receipt_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM wfp_candidate_cleanups
 WHERE (claim_id IS NULL AND (claim_attempt_number IS NOT NULL OR claimed_at IS NOT NULL OR lease_expires_at IS NOT NULL))
 OR (claim_id IS NOT NULL AND (claim_attempt_number IS NULL OR claimed_at IS NULL OR lease_expires_at IS NULL)));
INSERT INTO wfp_candidate_cleanup_requests(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,reason,requested_at)
 SELECT cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,reason,requested_at FROM wfp_candidate_cleanups;
INSERT INTO wfp_candidate_cleanup_claims(candidate_receipt_id,organization_id,project_id,claim_id,attempt_number,claimed_at,lease_expires_at)
 SELECT candidate_receipt_id,organization_id,project_id,claim_id,claim_attempt_number,claimed_at,lease_expires_at FROM wfp_candidate_cleanups WHERE claim_id IS NOT NULL;
-- Retained resources/outcomes are not interpreted as provider absence or new immutable receipts.
CREATE TRIGGER wfp_candidate_cleanups_legacy_no_insert BEFORE INSERT ON wfp_candidate_cleanups
BEGIN SELECT RAISE(ABORT,'Legacy merged cleanup authority is read-only history'); END;
CREATE TRIGGER wfp_candidate_cleanups_legacy_no_update BEFORE UPDATE ON wfp_candidate_cleanups
BEGIN SELECT RAISE(ABORT,'Legacy merged cleanup authority is read-only history'); END;
CREATE TRIGGER wfp_candidate_cleanups_legacy_no_delete BEFORE DELETE ON wfp_candidate_cleanups
BEGIN SELECT RAISE(ABORT,'Legacy merged cleanup authority is read-only history'); END;
