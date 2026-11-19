-- The archive password is sealed to the exact restore and never stored in plaintext.
CREATE TABLE native_auth_restore_jobs (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL,
  export_operation_id TEXT NOT NULL, archive_sha256 BLOB NOT NULL CHECK(length(archive_sha256)=32),
  principal_id TEXT NOT NULL, delegation TEXT CHECK(delegation IS NULL OR json_valid(delegation)),
  input_ciphertext BLOB, input_nonce BLOB, input_key_version INTEGER, input_digest BLOB NOT NULL CHECK(length(input_digest)=32),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  input_expires_at TEXT NOT NULL CHECK(input_expires_at GLOB '????-??-??T??:??:??.??????Z' AND input_expires_at>created_at),
  claim_id TEXT, input_generation INTEGER NOT NULL DEFAULT 1 CHECK(input_generation BETWEEN 1 AND 2147483647), state TEXT NOT NULL CHECK(state IN('queued','claimed','consumed','complete','expired','failed')),
  PRIMARY KEY(organization_id,project_id,restore_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  FOREIGN KEY(organization_id,export_operation_id) REFERENCES project_recovery_jobs(organization_id,operation_id),
  CHECK((state='queued' AND claim_id IS NULL) OR (state IN('claimed','consumed','complete') AND claim_id IS NOT NULL) OR state IN('expired','failed')),
  CHECK((state IN('queued','claimed') AND input_ciphertext IS NOT NULL AND length(input_ciphertext) BETWEEN 17 AND 8208 AND input_nonce IS NOT NULL AND length(input_nonce)=12 AND input_key_version IS NOT NULL AND input_key_version>0)
    OR (state IN('consumed','complete','expired','failed') AND input_ciphertext IS NULL AND input_nonce IS NULL AND input_key_version IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE native_auth_restore_claims (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL,
  claim_id TEXT NOT NULL, input_generation INTEGER NOT NULL CHECK(input_generation BETWEEN 1 AND 2147483647), previous_claim_id TEXT,
  PRIMARY KEY(organization_id,project_id,restore_id,claim_id),
  UNIQUE(organization_id,project_id,restore_id,input_generation),
  FOREIGN KEY(organization_id,project_id,restore_id) REFERENCES native_auth_restore_jobs(organization_id,project_id,restore_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_restore_claim_no_update BEFORE UPDATE ON native_auth_restore_claims
BEGIN SELECT RAISE(ABORT,'native auth restore claim is immutable'); END;
CREATE TRIGGER native_auth_restore_claim_no_delete BEFORE DELETE ON native_auth_restore_claims
BEGIN SELECT RAISE(ABORT,'native auth restore claim is retained'); END;
CREATE TRIGGER native_auth_restore_job_transition BEFORE UPDATE ON native_auth_restore_jobs
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.restore_id<>OLD.restore_id OR NEW.input_digest IS NOT OLD.input_digest
 OR NEW.export_operation_id<>OLD.export_operation_id OR NEW.archive_sha256 IS NOT OLD.archive_sha256 OR NEW.principal_id<>OLD.principal_id OR NEW.delegation IS NOT OLD.delegation OR NEW.created_at<>OLD.created_at
 OR NOT ((OLD.state='queued' AND NEW.state='claimed' AND NEW.input_generation=OLD.input_generation AND NEW.input_expires_at=OLD.input_expires_at AND NEW.input_ciphertext IS OLD.input_ciphertext AND NEW.input_nonce IS OLD.input_nonce AND NEW.input_key_version IS OLD.input_key_version)
   OR (OLD.state IN('queued','claimed') AND NEW.state='expired' AND OLD.input_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND NEW.input_generation=OLD.input_generation AND NEW.claim_id IS OLD.claim_id AND NEW.input_expires_at=OLD.input_expires_at)
   OR (OLD.state='expired' AND NEW.state='queued' AND NEW.input_generation=OLD.input_generation+1 AND NEW.claim_id IS NULL AND NEW.input_expires_at>OLD.input_expires_at)
   OR (OLD.state='claimed' AND NEW.state='consumed' AND NEW.claim_id=OLD.claim_id AND NEW.input_generation=OLD.input_generation AND NEW.input_expires_at=OLD.input_expires_at)
   OR (OLD.state IN('queued','claimed','expired') AND NEW.state='failed' AND NEW.claim_id IS OLD.claim_id AND NEW.input_generation=OLD.input_generation AND NEW.input_expires_at=OLD.input_expires_at)
   OR (OLD.state='consumed' AND NEW.state='complete' AND NEW.claim_id=OLD.claim_id AND NEW.input_generation=OLD.input_generation AND NEW.input_expires_at=OLD.input_expires_at))
BEGIN SELECT RAISE(ABORT,'native auth restore job transition invalid'); END;
CREATE TRIGGER native_auth_restore_job_no_delete BEFORE DELETE ON native_auth_restore_jobs
BEGIN SELECT RAISE(ABORT,'native auth restore job is retained'); END;

-- The private executor records this receipt only after lifecycle inspection and an exact encrypted copy/readback.
CREATE TABLE native_auth_restore_pins (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL,
  export_operation_id TEXT NOT NULL, claim_id TEXT NOT NULL, bucket TEXT NOT NULL,
  object_key TEXT NOT NULL, archive_bytes INTEGER NOT NULL CHECK(archive_bytes>0),
  archive_sha256 BLOB NOT NULL CHECK(length(archive_sha256)=32),
  manifest_sha256 BLOB NOT NULL CHECK(length(manifest_sha256)=32), state TEXT NOT NULL CHECK(state IN('reserved','verified','tombstoned')),
  PRIMARY KEY(organization_id,project_id,restore_id),
  UNIQUE(bucket,object_key),
  FOREIGN KEY(organization_id,project_id,restore_id) REFERENCES native_auth_restore_jobs(organization_id,project_id,restore_id),
  CHECK(object_key='restore-pins/'||organization_id||'/'||project_id||'/'||restore_id||'.zip')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_restore_pin_transition BEFORE UPDATE ON native_auth_restore_pins
WHEN NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.restore_id<>OLD.restore_id OR NEW.export_operation_id<>OLD.export_operation_id OR NEW.claim_id<>OLD.claim_id OR NEW.bucket<>OLD.bucket OR NEW.object_key<>OLD.object_key OR NEW.archive_bytes<>OLD.archive_bytes OR NEW.archive_sha256 IS NOT OLD.archive_sha256 OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR OLD.state<>'reserved' OR NEW.state NOT IN('verified','tombstoned')
BEGIN SELECT RAISE(ABORT,'native auth restore pin transition invalid'); END;
CREATE TRIGGER native_auth_restore_pin_no_delete BEFORE DELETE ON native_auth_restore_pins
BEGIN SELECT RAISE(ABORT,'native auth restore pin is retained'); END;
CREATE TABLE native_auth_restore_pin_tombstones (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,restore_id),
  FOREIGN KEY(organization_id,project_id,restore_id) REFERENCES native_auth_restore_pins(organization_id,project_id,restore_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_restore_tombstone_no_update BEFORE UPDATE ON native_auth_restore_pin_tombstones
BEGIN SELECT RAISE(ABORT,'native auth restore tombstone is immutable'); END;
CREATE TRIGGER native_auth_restore_tombstone_no_delete BEFORE DELETE ON native_auth_restore_pin_tombstones
BEGIN SELECT RAISE(ABORT,'native auth restore tombstone is retained'); END;
CREATE TABLE native_auth_restore_pin_absences (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, restore_id TEXT NOT NULL,
  bucket TEXT NOT NULL, object_key TEXT NOT NULL,
  absent_at TEXT NOT NULL CHECK(absent_at GLOB '????-??-??T??:??:??.??????Z'),
  source TEXT NOT NULL CHECK(source IN('restore-complete','project-delete')),
  PRIMARY KEY(organization_id,project_id,restore_id),
  FOREIGN KEY(organization_id,project_id,restore_id) REFERENCES native_auth_restore_pins(organization_id,project_id,restore_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER native_auth_restore_pin_absence_validate BEFORE INSERT ON native_auth_restore_pin_absences
WHEN NOT EXISTS(SELECT 1 FROM native_auth_restore_pins p WHERE p.organization_id=NEW.organization_id AND p.project_id=NEW.project_id AND p.restore_id=NEW.restore_id AND p.bucket=NEW.bucket AND p.object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'native auth restore pin absence mismatch'); END;
CREATE TRIGGER native_auth_restore_pin_absence_no_update BEFORE UPDATE ON native_auth_restore_pin_absences
BEGIN SELECT RAISE(ABORT,'native auth restore pin absence is immutable'); END;
CREATE TRIGGER native_auth_restore_pin_absence_no_delete BEFORE DELETE ON native_auth_restore_pin_absences
BEGIN SELECT RAISE(ABORT,'native auth restore pin absence is retained'); END;
CREATE TRIGGER native_auth_restore_requires_pin BEFORE INSERT ON native_auth_restores
WHEN NOT EXISTS(SELECT 1 FROM native_auth_restore_pins p JOIN native_auth_restore_jobs j USING(organization_id,project_id,restore_id)
 JOIN project_recovery_jobs a ON a.organization_id=j.organization_id AND a.project_id=j.project_id AND a.operation_id=j.export_operation_id
 WHERE p.organization_id=NEW.organization_id AND p.project_id=NEW.project_id AND p.restore_id=NEW.restore_id
   AND p.export_operation_id=NEW.export_operation_id AND p.archive_sha256=NEW.archive_sha256
   AND p.archive_sha256=a.archive_sha256 AND p.manifest_sha256=a.native_manifest_sha256 AND p.archive_bytes=a.archive_bytes AND p.bucket=a.archive_bucket AND p.state='verified'
   AND j.state='claimed')
BEGIN SELECT RAISE(ABORT,'native auth restore pin missing'); END;
