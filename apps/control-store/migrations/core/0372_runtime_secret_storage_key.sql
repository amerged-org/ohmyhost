-- Original048 storage key used by the actual RuntimeSecretDelivery compound; bucket authority comes ONLY from0337.
CREATE TABLE storage_gateway_keys (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK(key_version=1),
  key_sha256 BLOB NOT NULL CHECK(length(key_sha256)=32),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,environment_id)
    REFERENCES project_r2_bucket_receipts(organization_id,project_id,environment_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER storage_gateway_keys_no_update BEFORE UPDATE ON storage_gateway_keys
BEGIN SELECT RAISE(ABORT,'Storage gateway keys are append-only'); END;
CREATE TRIGGER storage_gateway_keys_no_delete BEFORE DELETE ON storage_gateway_keys
BEGIN SELECT RAISE(ABORT,'Storage gateway keys are append-only'); END;
