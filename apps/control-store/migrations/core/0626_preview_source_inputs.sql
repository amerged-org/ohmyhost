-- Private source custody is recorded before an R2 transfer, independently of runtime admission.
CREATE TABLE preview_source_inputs (
  preview_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  billing_epoch_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL,
  source_connection_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation > 0),
  commit_sha TEXT NOT NULL CHECK(length(commit_sha) = 40),
  region TEXT NOT NULL CHECK(region IN ('us','eu')),
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 25000000),
  source_archive TEXT CHECK(source_archive IS NULL OR json_valid(source_archive)),
  source_outcome TEXT NOT NULL DEFAULT 'unknown' CHECK(source_outcome IN ('unknown','not_started','recorded')),
  state TEXT NOT NULL CHECK(state IN ('reserved','recorded','adopted','cleanup_required','cleaned')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  cleanup_after TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,project_id,request_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  FOREIGN KEY(organization_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,billing_epoch_id),
  FOREIGN KEY(organization_id,project_id,source_connection_id) REFERENCES source_connections(organization_id,project_id,source_connection_id)
) STRICT;
CREATE INDEX preview_source_input_cleanup ON preview_source_inputs(state,cleanup_after);

CREATE TRIGGER preview_source_input_identity_immutable BEFORE UPDATE ON preview_source_inputs
WHEN NEW.preview_id<>OLD.preview_id OR NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id
 OR NEW.environment_id<>OLD.environment_id OR NEW.billing_epoch_id<>OLD.billing_epoch_id OR NEW.principal_id<>OLD.principal_id
 OR NEW.request_id<>OLD.request_id OR NEW.intent_sha256<>OLD.intent_sha256 OR NEW.source_connection_id<>OLD.source_connection_id
 OR NEW.source_generation<>OLD.source_generation OR NEW.commit_sha<>OLD.commit_sha OR NEW.region<>OLD.region
 OR NEW.bucket<>OLD.bucket OR NEW.object_key<>OLD.object_key OR NEW.source_sha256<>OLD.source_sha256 OR NEW.byte_length<>OLD.byte_length
 OR NEW.created_at<>OLD.created_at OR OLD.source_archive IS NOT NULL AND NEW.source_archive IS NOT OLD.source_archive
BEGIN SELECT RAISE(ABORT,'preview_source_input_identity_immutable'); END;
