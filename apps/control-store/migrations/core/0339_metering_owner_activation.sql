-- Closed operator attestation of this ONE qualified physical Core, using the fixed release profile's existing
-- CONTROL_PLATFORM_ENVIRONMENT / CONTROL_CORE_DATABASE_ID. No ordinary Runtime may initialize or repair it.
-- The global Core activation precedes this row in the operator's same qualified activation batch.
CREATE TABLE metering_runtime_identity (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  environment TEXT NOT NULL CHECK(environment IN ('local','development','production')),
  database_id TEXT NOT NULL CHECK(length(database_id)=36 AND database_id GLOB '????????-????-????-????-????????????'
    AND length(replace(database_id,'-',''))=32 AND replace(database_id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND database_id<>'00000000-0000-0000-0000-000000000000'),
  activation_id TEXT NOT NULL REFERENCES core_authority_activation(activation_id) ON DELETE RESTRICT,
  qualified_at TEXT NOT NULL CHECK(qualified_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER metering_runtime_identity_no_update BEFORE UPDATE ON metering_runtime_identity
BEGIN SELECT RAISE(ABORT,'Metering Core identity is immutable'); END;
CREATE TRIGGER metering_runtime_identity_no_delete BEFORE DELETE ON metering_runtime_identity
BEGIN SELECT RAISE(ABORT,'Metering Core identity is immutable'); END;

-- Original188 immutable operation evidence. Canonical PostgreSQL-jsonb text/digest is calculated and checked by
-- the closed operator command and original-source readback; no generic runtime JSON, SQL or owner setter is exposed.
CREATE TABLE metering_owner_activation_receipts (
  operation_id TEXT NOT NULL PRIMARY KEY CHECK(length(operation_id)=36 AND operation_id GLOB '????????-????-????-????-????????????'
    AND length(replace(operation_id,'-',''))=32 AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND operation_id<>'00000000-0000-0000-0000-000000000000'),
  lane TEXT NOT NULL CHECK(lane='financial'),
  expected_owner TEXT NOT NULL CHECK(expected_owner IN ('control','metering')),
  expected_epoch INTEGER NOT NULL CHECK(expected_epoch>0),
  next_owner TEXT NOT NULL CHECK(next_owner IN ('control','metering') AND next_owner<>expected_owner),
  next_epoch INTEGER NOT NULL CHECK(next_epoch=expected_epoch+1),
  environment TEXT NOT NULL CHECK(environment IN ('development','production')),
  source_commit TEXT NOT NULL CHECK(length(source_commit)=40 AND source_commit NOT GLOB '*[^0-9a-f]*'),
  release_manifest_sha256 BLOB NOT NULL CHECK(length(release_manifest_sha256)=32),
  evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence)='object' AND length(CAST(evidence AS BLOB))<=16384),
  evidence_sha256 BLOB NOT NULL CHECK(length(evidence_sha256)=32),
  recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  actor_role TEXT NOT NULL CHECK(actor_role=trim(actor_role) AND length(actor_role) BETWEEN 1 AND 63)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER metering_owner_activation_receipts_no_update BEFORE UPDATE ON metering_owner_activation_receipts
BEGIN SELECT RAISE(ABORT,'Metering owner activation receipts are append-only'); END;
CREATE TRIGGER metering_owner_activation_receipts_no_delete BEFORE DELETE ON metering_owner_activation_receipts
BEGIN SELECT RAISE(ABORT,'Metering owner activation receipts are append-only'); END;
