-- Expand the retained recovery archive contract without changing existing rows or guards.
CREATE TABLE project_recovery_jobs_v2 (
  organization_id      TEXT    NOT NULL,
  operation_id         TEXT    NOT NULL CHECK (length(operation_id) = 26),
  project_id           TEXT    NOT NULL CHECK (length(project_id) = 26),
  environment_id       TEXT    NOT NULL CHECK (length(environment_id) = 26),
  input_ciphertext     BLOB,
  input_nonce          BLOB,
  input_key_version    INTEGER,
  input_expires_at     TEXT    NOT NULL CHECK (input_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  requested_at         TEXT    NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??.??????Z'),
  claim_id             TEXT    CHECK (claim_id IS NULL OR (length(claim_id) = 36 AND claim_id GLOB '????????-????-????-????-????????????' AND claim_id NOT GLOB '*[^0-9a-f-]*')),
  started_at           TEXT    CHECK (started_at IS NULL OR started_at GLOB '????-??-??T??:??:??.??????Z'),
  archive_bucket       TEXT    NOT NULL CHECK (archive_bucket IN ('ohmyho-development-backups','ohmyho-production-backups')),
  archive_key          TEXT    GENERATED ALWAYS AS ('snapshots/' || organization_id || '/' || project_id || '/' || operation_id || '.zip') STORED,
  archive_bytes        INTEGER CHECK (archive_bytes IS NULL OR archive_bytes BETWEEN 1 AND 536870912),
  archive_sha256       BLOB    CHECK (archive_sha256 IS NULL OR length(archive_sha256) = 32),
  sql_files            TEXT    CHECK (sql_files IS NULL OR sql_files IN ('["dev.sql"]','["prod.sql"]','["dev.sql","prod.sql"]','["shared.sql"]','["auth.sql"]','["dev.sql","auth.sql"]','["prod.sql","auth.sql"]','["dev.sql","prod.sql","auth.sql"]','["shared.sql","auth.sql"]')),
  native_manifest      TEXT    CHECK(native_manifest IS NULL OR ((json_valid(native_manifest) AND json_type(native_manifest)='object'
    AND json_extract(native_manifest,'$.schemaVersion')='ohmyhost.native-auth-inventory/v1'
    AND json_extract(native_manifest,'$.organizationId')=organization_id AND json_extract(native_manifest,'$.projectId')=project_id
    AND json_type(native_manifest,'$.databaseId')='text' AND json_type(native_manifest,'$.migrationVersion')='integer'
    AND json_type(native_manifest,'$.migrationDigest')='text' AND json_type(native_manifest,'$.realms')='array' AND json_array_length(native_manifest,'$.realms') BETWEEN 1 AND 2) IS TRUE)),
  native_manifest_sha256 BLOB CHECK(native_manifest_sha256 IS NULL OR length(native_manifest_sha256)=32),
  captured_at          TEXT    CHECK (captured_at IS NULL OR captured_at GLOB '????-??-??T??:??:??.??????Z'),
  archive_expires_at   TEXT    CHECK (archive_expires_at IS NULL OR archive_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  verified_at          TEXT    CHECK (verified_at IS NULL OR verified_at GLOB '????-??-??T??:??:??.??????Z'),
  finished_at          TEXT    CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.??????Z'),
  failure_code         TEXT    CHECK (failure_code IS NULL OR (failure_code GLOB '[A-Z]*' AND length(failure_code) <= 96 AND failure_code NOT GLOB '*[^A-Z0-9_]*')),
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id),
  CHECK ((input_ciphertext IS NULL AND input_nonce IS NULL AND input_key_version IS NULL)
      OR (input_ciphertext IS NOT NULL AND length(input_ciphertext) BETWEEN 17 AND 8208
          AND input_nonce IS NOT NULL AND length(input_nonce) = 12 AND input_key_version IS NOT NULL AND input_key_version > 0)),
  CHECK (substr(input_expires_at, 1, 23) = strftime('%Y-%m-%dT%H:%M:%f', substr(requested_at, 1, 23), '+1 hour')),
  CHECK ((claim_id IS NULL AND started_at IS NULL) OR (claim_id IS NOT NULL AND started_at IS NOT NULL)),
  CHECK ((archive_bytes IS NULL AND archive_sha256 IS NULL AND sql_files IS NULL AND captured_at IS NULL AND archive_expires_at IS NULL)
      OR (archive_bytes IS NOT NULL AND archive_sha256 IS NOT NULL AND sql_files IS NOT NULL AND captured_at IS NOT NULL AND archive_expires_at IS NOT NULL
          AND substr(archive_expires_at, 1, 23) = strftime('%Y-%m-%dT%H:%M:%f', substr(captured_at, 1, 23), '+7 days'))),
  CHECK((native_manifest IS NULL AND native_manifest_sha256 IS NULL AND (sql_files IS NULL OR instr(sql_files,'"auth.sql"')=0))
    OR (native_manifest IS NOT NULL AND native_manifest_sha256 IS NOT NULL AND sql_files IS NOT NULL AND instr(sql_files,'"auth.sql"')>0)),
  CHECK (verified_at IS NULL OR (archive_sha256 IS NOT NULL AND finished_at IS NOT NULL AND failure_code IS NULL)),
  CHECK (failure_code IS NULL OR (finished_at IS NOT NULL AND verified_at IS NULL)),
  CHECK (finished_at IS NULL OR (input_ciphertext IS NULL AND (verified_at IS NOT NULL OR failure_code IS NOT NULL)))
) STRICT, WITHOUT ROWID;
INSERT INTO project_recovery_jobs_v2(organization_id,operation_id,project_id,environment_id,input_ciphertext,input_nonce,input_key_version,input_expires_at,requested_at,claim_id,started_at,archive_bucket,archive_bytes,archive_sha256,sql_files,captured_at,archive_expires_at,verified_at,finished_at,failure_code) SELECT organization_id,operation_id,project_id,environment_id,input_ciphertext,input_nonce,input_key_version,input_expires_at,requested_at,claim_id,started_at,archive_bucket,archive_bytes,archive_sha256,sql_files,captured_at,archive_expires_at,verified_at,finished_at,failure_code FROM project_recovery_jobs;
DROP TRIGGER project_recovery_jobs_no_delete;
DROP TABLE project_recovery_jobs;
ALTER TABLE project_recovery_jobs_v2 RENAME TO project_recovery_jobs;
CREATE INDEX project_recovery_rolling_limit ON project_recovery_jobs (organization_id, project_id, requested_at);
CREATE INDEX recovery_jobs_global_project_requested ON project_recovery_jobs (project_id, requested_at);
CREATE TRIGGER project_recovery_jobs_scope_matches BEFORE INSERT ON project_recovery_jobs
WHEN NOT EXISTS (SELECT 1 FROM operations o JOIN environments e ON e.organization_id = o.organization_id
                  WHERE o.organization_id = NEW.organization_id AND o.operation_id = NEW.operation_id AND o.project_id = NEW.project_id
                    AND e.environment_id = NEW.environment_id AND e.project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'project_recovery_jobs scope does not match its operation and environment'); END;
CREATE TRIGGER project_recovery_jobs_identity_immutable BEFORE UPDATE OF organization_id, operation_id, project_id, environment_id, requested_at, input_expires_at, archive_bucket ON project_recovery_jobs
BEGIN SELECT RAISE(ABORT, 'project_recovery_jobs identity is immutable'); END;
CREATE TRIGGER project_recovery_jobs_terminal_final BEFORE UPDATE ON project_recovery_jobs
WHEN OLD.finished_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'project_recovery_jobs is final once finished'); END;
CREATE TRIGGER project_recovery_jobs_no_delete BEFORE DELETE ON project_recovery_jobs
BEGIN SELECT RAISE(ABORT, 'project_recovery_jobs is retained'); END;
CREATE TRIGGER project_recovery_jobs_archive_final BEFORE UPDATE ON project_recovery_jobs
WHEN OLD.archive_bytes IS NOT NULL AND (NEW.archive_bytes IS NOT OLD.archive_bytes OR NEW.archive_sha256 IS NOT OLD.archive_sha256
  OR NEW.sql_files IS NOT OLD.sql_files OR NEW.native_manifest IS NOT OLD.native_manifest OR NEW.native_manifest_sha256 IS NOT OLD.native_manifest_sha256 OR NEW.captured_at IS NOT OLD.captured_at OR NEW.archive_expires_at IS NOT OLD.archive_expires_at)
  AND NOT (NEW.archive_bytes IS NULL AND NEW.archive_sha256 IS NULL AND NEW.sql_files IS NULL AND NEW.captured_at IS NULL
    AND NEW.archive_expires_at IS NULL AND NEW.native_manifest IS NULL AND NEW.native_manifest_sha256 IS NULL AND NEW.input_ciphertext IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'project_recovery_jobs archive is final once prepared'); END;
