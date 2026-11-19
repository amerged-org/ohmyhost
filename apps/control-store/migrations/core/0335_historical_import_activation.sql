-- Closed trusted-operator import admission, NEVER a runtime RPC. Static identities, FKs, append-only guards and
-- financial conservation remain active. Only a named temporal/current-authority INSERT predicate may recognize
-- the exact attested table allowlist while loading historical evidence that was admitted by the original source.
-- A production runtime requires the immutable activation below. Therefore a cached positive activation can never
-- overlap a later import: opening an import on ANY ever-activated database is permanently refused.
CREATE TABLE core_historical_import (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  import_id TEXT NOT NULL UNIQUE CHECK (length(import_id) = 36
    AND substr(import_id,9,1) = '-' AND substr(import_id,14,1) = '-'
    AND substr(import_id,19,1) = '-' AND substr(import_id,24,1) = '-'
    AND length(replace(import_id,'-','')) = 32 AND replace(import_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  manifest_sha256 BLOB NOT NULL CHECK (length(manifest_sha256) = 32),
  source_fingerprint_sha256 BLOB NOT NULL CHECK (length(source_fingerprint_sha256) = 32),
  expected_runtime_schema_sha256 BLOB NOT NULL CHECK (length(expected_runtime_schema_sha256) = 32),
  temporal_tables TEXT NOT NULL CHECK (json_valid(temporal_tables) AND json_type(temporal_tables) = 'array'),
  started_at TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.??????Z'),
  closed_at TEXT CHECK (closed_at IS NULL OR closed_at GLOB '????-??-??T??:??:??.??????Z'),
  comparison_sha256 BLOB CHECK (comparison_sha256 IS NULL OR length(comparison_sha256) = 32),
  restored_runtime_schema_sha256 BLOB CHECK (restored_runtime_schema_sha256 IS NULL OR length(restored_runtime_schema_sha256) = 32),
  CHECK ((closed_at IS NULL AND comparison_sha256 IS NULL AND restored_runtime_schema_sha256 IS NULL)
    OR (closed_at IS NOT NULL AND closed_at >= started_at AND comparison_sha256 IS NOT NULL
      AND restored_runtime_schema_sha256 IS NOT NULL
      AND restored_runtime_schema_sha256 = expected_runtime_schema_sha256))
) STRICT, WITHOUT ROWID;

CREATE TABLE core_authority_activation (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  activation_id TEXT NOT NULL UNIQUE CHECK (length(activation_id) = 36
    AND substr(activation_id,9,1) = '-' AND substr(activation_id,14,1) = '-'
    AND substr(activation_id,19,1) = '-' AND substr(activation_id,24,1) = '-'
    AND length(replace(activation_id,'-','')) = 32 AND replace(activation_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  activated_at TEXT NOT NULL CHECK (activated_at GLOB '????-??-??T??:??:??.??????Z'),
  import_id TEXT REFERENCES core_historical_import(import_id),
  qualification_sha256 BLOB NOT NULL CHECK (length(qualification_sha256) = 32),
  runtime_schema_sha256 BLOB NOT NULL CHECK (length(runtime_schema_sha256) = 32)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER core_historical_import_open BEFORE INSERT ON core_historical_import
BEGIN
  SELECT RAISE(ABORT, 'an ever-activated authority can never open historical import')
    WHERE EXISTS (SELECT 1 FROM core_authority_activation);
  SELECT RAISE(ABORT, 'historical import begins loading, never already qualified')
    WHERE NEW.closed_at IS NOT NULL OR NEW.comparison_sha256 IS NOT NULL OR NEW.restored_runtime_schema_sha256 IS NOT NULL;
  SELECT RAISE(ABORT, 'historical temporal admission has a closed exact table allowlist')
    WHERE EXISTS (SELECT 1 FROM json_each(NEW.temporal_tables)
      WHERE type <> 'text' OR value NOT IN ('wfp_candidate_receipts','wfp_candidate_cleanup_receipts','wfp_publish_receipts'))
      OR (SELECT count(*) FROM json_each(NEW.temporal_tables))
        <> (SELECT count(DISTINCT value) FROM json_each(NEW.temporal_tables));
END;
CREATE TRIGGER core_historical_import_close_only BEFORE UPDATE ON core_historical_import
  WHEN OLD.closed_at IS NOT NULL OR NEW.singleton IS NOT OLD.singleton OR NEW.import_id IS NOT OLD.import_id
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR NEW.source_fingerprint_sha256 IS NOT OLD.source_fingerprint_sha256
    OR NEW.expected_runtime_schema_sha256 IS NOT OLD.expected_runtime_schema_sha256
    OR NEW.temporal_tables IS NOT OLD.temporal_tables OR NEW.started_at IS NOT OLD.started_at
    OR NEW.closed_at IS NULL OR NEW.comparison_sha256 IS NULL
    OR NEW.restored_runtime_schema_sha256 IS NOT OLD.expected_runtime_schema_sha256
BEGIN SELECT RAISE(ABORT, 'historical import identity is immutable and closes once with comparison and exact restored DDL'); END;
CREATE TRIGGER core_historical_import_no_delete BEFORE DELETE ON core_historical_import
BEGIN SELECT RAISE(ABORT, 'historical import attestation is never deleted'); END;

CREATE TRIGGER core_authority_activation_qualified BEFORE INSERT ON core_authority_activation
BEGIN
  SELECT RAISE(ABORT, 'authority activation requires no open historical import')
    WHERE EXISTS (SELECT 1 FROM core_historical_import WHERE closed_at IS NULL);
  SELECT RAISE(ABORT, 'authority activation requires the exact closed qualified historical context')
    WHERE EXISTS (SELECT 1 FROM core_historical_import)
      AND NOT EXISTS (SELECT 1 FROM core_historical_import i WHERE i.import_id = NEW.import_id
        AND i.closed_at IS NOT NULL AND i.closed_at <= NEW.activated_at
        AND i.comparison_sha256 = NEW.qualification_sha256
        AND i.expected_runtime_schema_sha256 = NEW.runtime_schema_sha256
        AND i.restored_runtime_schema_sha256 = NEW.runtime_schema_sha256);
END;
CREATE TRIGGER core_authority_activation_no_update BEFORE UPDATE ON core_authority_activation
BEGIN SELECT RAISE(ABORT, 'authority activation is immutable'); END;
CREATE TRIGGER core_authority_activation_no_delete BEFORE DELETE ON core_authority_activation
BEGIN SELECT RAISE(ABORT, 'authority activation is never deleted'); END;
