-- Exact original062/127 immutable resource expectations; requests/candidates are canonical0364/0334 parents.
CREATE TABLE wfp_candidate_cleanup_resource_expectations (
  cleanup_request_id TEXT NOT NULL,
  candidate_receipt_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider='cloudflare'),
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('source-archive','build-artifact')),
  resource_identity_sha256 BLOB NOT NULL CHECK(length(resource_identity_sha256)=32),
  PRIMARY KEY(cleanup_request_id,provider,resource_kind,resource_identity_sha256),
  UNIQUE(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,resource_kind,resource_identity_sha256),
  FOREIGN KEY(cleanup_request_id) REFERENCES wfp_candidate_cleanup_requests(cleanup_request_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,candidate_receipt_id,operation_id)
    REFERENCES wfp_candidate_receipts(organization_id,project_id,candidate_receipt_id,operation_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER wfp_candidate_cleanup_resource_expectations_no_update BEFORE UPDATE ON wfp_candidate_cleanup_resource_expectations
BEGIN SELECT RAISE(ABORT,'Cleanup resource expectations are append-only'); END;
CREATE TRIGGER wfp_candidate_cleanup_resource_expectations_no_delete BEFORE DELETE ON wfp_candidate_cleanup_resource_expectations
BEGIN SELECT RAISE(ABORT,'Cleanup resource expectations are append-only'); END;
