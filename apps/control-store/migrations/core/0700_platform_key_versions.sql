-- RTG-05: an installed Storage gateway key can be rotated by its owner. Each rotation appends a new key version beside the
-- earlier ones; the append-only history stays as it is and the gateway authorizes only the newest version. SQLite cannot
-- widen a CHECK or change a primary key in place, so the table is rebuilt as 0651 rebuilt its table, with the same
-- append-only triggers recreated. Every existing row keeps version 1 and its digest, so no key changes meaning.
-- Mail keys do not version: the Mail gateway authorizes from the environment secret, so a rotation only replaces it.
CREATE TABLE storage_gateway_keys_0700 (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK(key_version BETWEEN 1 AND 2147483647),
  key_sha256 BLOB NOT NULL CHECK(length(key_sha256)=32),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,environment_id,key_version),
  FOREIGN KEY(organization_id,project_id,environment_id)
    REFERENCES project_r2_bucket_receipts(organization_id,project_id,environment_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
INSERT INTO storage_gateway_keys_0700(organization_id,project_id,environment_id,key_version,key_sha256,created_at)
  SELECT organization_id,project_id,environment_id,key_version,key_sha256,created_at FROM storage_gateway_keys;
DROP TABLE storage_gateway_keys;
ALTER TABLE storage_gateway_keys_0700 RENAME TO storage_gateway_keys;
CREATE TRIGGER storage_gateway_keys_no_update BEFORE UPDATE ON storage_gateway_keys
BEGIN SELECT RAISE(ABORT,'Storage gateway keys are append-only'); END;
CREATE TRIGGER storage_gateway_keys_no_delete BEFORE DELETE ON storage_gateway_keys
BEGIN SELECT RAISE(ABORT,'Storage gateway keys are append-only'); END;
-- A version is only ever the next one of its environment. A re-sent row of an existing version is left to its primary key,
-- so an ensure that replays after a rotation still answers "exists" rather than failing here.
CREATE TRIGGER storage_gateway_keys_next_version BEFORE INSERT ON storage_gateway_keys
WHEN NEW.key_version<>COALESCE((SELECT MAX(k.key_version) FROM storage_gateway_keys k WHERE k.organization_id=NEW.organization_id AND k.project_id=NEW.project_id AND k.environment_id=NEW.environment_id),0)+1
 AND NOT EXISTS(SELECT 1 FROM storage_gateway_keys k WHERE k.organization_id=NEW.organization_id AND k.project_id=NEW.project_id AND k.environment_id=NEW.environment_id AND k.key_version=NEW.key_version)
BEGIN SELECT RAISE(ABORT,'Storage gateway key version is not the next one'); END;
