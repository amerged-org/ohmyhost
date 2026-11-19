-- Original062/128 immutable candidate operation-resource absence receipts; no provider action or inferred outcome.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE wfp_candidate_operation_cleanup_receipts (
 operation_cleanup_receipt_id TEXT NOT NULL CHECK(length(operation_cleanup_receipt_id)=26 AND length(CAST(operation_cleanup_receipt_id AS BLOB))=26 AND substr(operation_cleanup_receipt_id,1,1) BETWEEN '0' AND '7' AND operation_cleanup_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 cleanup_request_id TEXT NOT NULL CHECK(length(cleanup_request_id)=26 AND length(CAST(cleanup_request_id AS BLOB))=26 AND substr(cleanup_request_id,1,1) BETWEEN '0' AND '7' AND cleanup_request_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 candidate_receipt_id TEXT NOT NULL CHECK(length(candidate_receipt_id)=26 AND length(CAST(candidate_receipt_id AS BLOB))=26 AND substr(candidate_receipt_id,1,1) BETWEEN '0' AND '7' AND candidate_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 operation_id TEXT NOT NULL CHECK(length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 provider TEXT NOT NULL CHECK(provider='cloudflare'),resource_kind TEXT NOT NULL CHECK(resource_kind IN('source-archive','build-artifact')),
 resource_identity_sha256 BLOB NOT NULL CHECK(length(resource_identity_sha256)=32),outcome TEXT NOT NULL CHECK(outcome IN('removed','not_found')),
 observed_at TEXT NOT NULL CHECK((observed_at GLOB '????-??-??T??:??:??.??????Z' AND length(CAST(observed_at AS BLOB))=27 AND substr(observed_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(observed_at,1,10),'+0 days')=substr(observed_at,1,10) AND (substr(observed_at,12,2)||substr(observed_at,15,2)||substr(observed_at,18,2)||substr(observed_at,21,6)) NOT GLOB '*[^0-9]*' AND substr(observed_at,12,2) BETWEEN '00' AND '23' AND substr(observed_at,15,2) BETWEEN '00' AND '59' AND substr(observed_at,18,2) BETWEEN '00' AND '59') IS TRUE),
 PRIMARY KEY(operation_cleanup_receipt_id),UNIQUE(cleanup_request_id,provider,resource_kind,resource_identity_sha256),
 FOREIGN KEY(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,resource_kind,resource_identity_sha256) REFERENCES wfp_candidate_cleanup_resource_expectations(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,resource_kind,resource_identity_sha256) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER wfp_candidate_operation_cleanup_receipts_no_update BEFORE UPDATE ON wfp_candidate_operation_cleanup_receipts BEGIN SELECT RAISE(ABORT,'Candidate operation cleanup receipts are append-only'); END;
CREATE TRIGGER wfp_candidate_operation_cleanup_receipts_no_delete BEFORE DELETE ON wfp_candidate_operation_cleanup_receipts BEGIN SELECT RAISE(ABORT,'Candidate operation cleanup receipts are append-only'); END;
