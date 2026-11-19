-- Retain the identity of every Native-bearing export independently of the job's terminal state.
CREATE TABLE native_export_effects (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  archive_bytes INTEGER NOT NULL,
  archive_sha256 BLOB NOT NULL CHECK(length(archive_sha256)=32),
  native_manifest TEXT NOT NULL,
  native_manifest_sha256 BLOB NOT NULL CHECK(length(native_manifest_sha256)=32),
  expires_at TEXT NOT NULL,
  next_attempt_at TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','verified','tombstoned','absent')),
  PRIMARY KEY(organization_id,operation_id),
  FOREIGN KEY(organization_id,operation_id) REFERENCES project_recovery_jobs(organization_id,operation_id),
  CHECK(object_key='native-exports/'||organization_id||'/'||project_id||'/'||operation_id||'.zip')
) STRICT, WITHOUT ROWID;
CREATE INDEX native_export_effects_due ON native_export_effects(state,expires_at);
CREATE TRIGGER native_export_effect_identity_immutable BEFORE UPDATE OF organization_id,project_id,operation_id,bucket,object_key,archive_bytes,archive_sha256,native_manifest,native_manifest_sha256,expires_at ON native_export_effects
BEGIN SELECT RAISE(ABORT,'native export effect identity is immutable'); END;
CREATE TRIGGER native_export_effect_no_delete BEFORE DELETE ON native_export_effects
BEGIN SELECT RAISE(ABORT,'native export effects are retained'); END;
CREATE TRIGGER native_export_effect_state_monotonic BEFORE UPDATE OF state ON native_export_effects
WHEN NOT ((OLD.state='reserved' AND NEW.state IN ('dispatched','tombstoned','absent'))
  OR (OLD.state='dispatched' AND NEW.state IN ('verified','tombstoned','absent'))
  OR (OLD.state='verified' AND NEW.state='absent') OR OLD.state=NEW.state)
BEGIN SELECT RAISE(ABORT,'native export effect transition is invalid'); END;
-- Project deletion may not outrun even a failed job's unknown Native PUT.
CREATE TRIGGER native_export_block_unretired_project BEFORE UPDATE OF lifecycle_state ON projects
WHEN NEW.lifecycle_state='deleted' AND OLD.lifecycle_state<>'deleted'
 AND (EXISTS(SELECT 1 FROM native_export_effects e WHERE e.project_id=OLD.project_id AND e.state NOT IN ('tombstoned','absent'))
   OR EXISTS(SELECT 1 FROM project_recovery_jobs j WHERE j.project_id=OLD.project_id AND j.native_manifest IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM native_export_effects e WHERE e.organization_id=j.organization_id AND e.operation_id=j.operation_id)))
BEGIN SELECT RAISE(ABORT,'native export retirement incomplete'); END;
