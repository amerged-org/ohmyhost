-- Publication commits the head first; terminal success waits for the private realm policy acknowledgement.
CREATE TABLE native_auth_policy_syncs (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  claim_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('DeploymentRequestedV1','DeploymentPromotionRequestedV1','DeploymentRollbackRequestedV1')),
  head_deployment_id TEXT NOT NULL, head_revision_id TEXT NOT NULL, head_version INTEGER NOT NULL CHECK(head_version>0),
  completion TEXT CHECK(completion IS NULL OR (json_valid(completion) AND json_type(completion)='object')),
  publication TEXT NOT NULL CHECK(json_valid(publication) AND json_type(publication)='object'),
  schedule TEXT NOT NULL CHECK(json_valid(schedule) AND json_type(schedule)='object'),
  terminal_evidence TEXT CHECK(terminal_evidence IS NULL OR (json_valid(terminal_evidence) AND json_type(terminal_evidence)='object')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), result_url TEXT NOT NULL,
  binding_refresh_snapshot TEXT CHECK(binding_refresh_snapshot IS NULL OR (json_valid(binding_refresh_snapshot) AND json_type(binding_refresh_snapshot)='object')),
  refresh_source_hash TEXT CHECK(refresh_source_hash IS NULL OR (length(refresh_source_hash)=64 AND refresh_source_hash NOT GLOB '*[^0-9a-f]*')),
  artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
  published_at TEXT NOT NULL CHECK(published_at GLOB '????-??-??T??:??:??.??????Z'),
  terminal_at TEXT CHECK(terminal_at IS NULL OR terminal_at GLOB '????-??-??T??:??:??.??????Z'),
  acknowledgement TEXT CHECK(acknowledgement IS NULL OR (json_valid(acknowledgement) AND json_type(acknowledgement)='object')),
  acknowledged_at TEXT CHECK(acknowledged_at IS NULL OR acknowledged_at GLOB '????-??-??T??:??:??.??????Z'),
  state TEXT NOT NULL CHECK(state IN ('refresh_pending_cleanup','pending','completed')),
  PRIMARY KEY(organization_id,project_id,environment_id,operation_id),
  FOREIGN KEY(organization_id,operation_id) REFERENCES operations(organization_id,operation_id),
  CHECK((state='refresh_pending_cleanup' AND binding_refresh_snapshot IS NOT NULL AND completion IS NULL AND terminal_evidence IS NULL AND result_json IS NULL AND terminal_at IS NULL AND refresh_source_hash IS NULL AND acknowledgement IS NULL AND acknowledged_at IS NULL)
    OR (state IN('pending','completed') AND completion IS NOT NULL AND terminal_evidence IS NOT NULL AND result_json IS NOT NULL AND terminal_at IS NOT NULL
      AND ((binding_refresh_snapshot IS NULL AND refresh_source_hash IS NULL) OR (binding_refresh_snapshot IS NOT NULL AND refresh_source_hash IS NOT NULL))
      AND ((state='pending' AND acknowledgement IS NULL AND acknowledged_at IS NULL) OR (state='completed' AND acknowledgement IS NOT NULL AND acknowledged_at IS NOT NULL))))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_policy_sync_update BEFORE UPDATE ON native_auth_policy_syncs
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id OR NEW.operation_id<>OLD.operation_id
  OR NEW.claim_id<>OLD.claim_id OR NEW.event_type<>OLD.event_type OR NEW.head_deployment_id<>OLD.head_deployment_id OR NEW.head_revision_id<>OLD.head_revision_id OR NEW.head_version<>OLD.head_version
  OR NEW.publication IS NOT OLD.publication OR NEW.schedule IS NOT OLD.schedule OR NEW.binding_refresh_snapshot IS NOT OLD.binding_refresh_snapshot OR NEW.result_url<>OLD.result_url OR NEW.artifact_sha256<>OLD.artifact_sha256 OR NEW.published_at<>OLD.published_at
  OR NOT ((OLD.state='refresh_pending_cleanup' AND NEW.state='pending') OR
    (OLD.state='pending' AND NEW.state='completed' AND NEW.completion IS OLD.completion AND NEW.terminal_evidence IS OLD.terminal_evidence AND NEW.result_json IS OLD.result_json AND NEW.terminal_at IS OLD.terminal_at AND NEW.refresh_source_hash IS OLD.refresh_source_hash))
BEGIN SELECT RAISE(ABORT,'native auth policy sync is immutable'); END;
CREATE TRIGGER native_auth_policy_sync_no_delete BEFORE DELETE ON native_auth_policy_syncs
BEGIN SELECT RAISE(ABORT,'native auth policy sync is retained'); END;
