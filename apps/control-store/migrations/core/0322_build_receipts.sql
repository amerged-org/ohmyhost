-- W32: the actual BuildRunner receipt port (PostgreSQL migrations 009, 018, 127).
-- Composite scope keys retain the original tenant/project foreign keys, even when an organization is a former owner.
CREATE UNIQUE INDEX build_environment_scope ON environments (organization_id, project_id, environment_id);
CREATE UNIQUE INDEX build_operation_scope ON operations (organization_id, project_id, operation_id);
CREATE UNIQUE INDEX build_epoch_scope ON billing_epochs (organization_id, project_id, billing_epoch_id);

CREATE TABLE build_receipts (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  provider_build_id TEXT NOT NULL CHECK (provider_build_id = trim(provider_build_id) AND length(provider_build_id) BETWEEN 1 AND 512),
  build_project_name TEXT NOT NULL CHECK (build_project_name = trim(build_project_name) AND length(build_project_name) BETWEEN 1 AND 255),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  input_fingerprint BLOB,
  build_claim_id TEXT,
  PRIMARY KEY (organization_id, project_id, environment_id, operation_id),
  UNIQUE (build_project_name, provider_build_id),
  FOREIGN KEY (organization_id, project_id, environment_id) REFERENCES environments (organization_id, project_id, environment_id),
  FOREIGN KEY (organization_id, project_id, operation_id) REFERENCES operations (organization_id, project_id, operation_id),
  CHECK ((input_fingerprint IS NULL AND build_claim_id IS NULL) OR
    (length(input_fingerprint) = 32 AND length(build_claim_id) = 36 AND length(replace(build_claim_id, '-', '')) = 32 AND replace(build_claim_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      AND substr(build_claim_id, 9, 1) = '-' AND substr(build_claim_id, 14, 2) = '-4'
      AND substr(build_claim_id, 19, 1) = '-' AND substr(build_claim_id, 20, 1) GLOB '[89ab]' AND substr(build_claim_id, 24, 1) = '-'))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER build_receipts_no_update BEFORE UPDATE ON build_receipts
BEGIN SELECT RAISE(ABORT, 'build_receipts is append-only'); END;
CREATE TRIGGER build_receipts_no_delete BEFORE DELETE ON build_receipts
BEGIN SELECT RAISE(ABORT, 'build_receipts is append-only'); END;

CREATE TABLE build_input_reservations (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_fingerprint BLOB NOT NULL CHECK (length(input_fingerprint) = 32),
  claim_id TEXT NOT NULL UNIQUE CHECK (length(claim_id) = 36 AND length(replace(claim_id, '-', '')) = 32 AND replace(claim_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr(claim_id, 9, 1) = '-' AND substr(claim_id, 14, 2) = '-4'
    AND substr(claim_id, 19, 1) = '-' AND substr(claim_id, 20, 1) GLOB '[89ab]' AND substr(claim_id, 24, 1) = '-'),
  claim_mode TEXT NOT NULL CHECK (claim_mode IN ('start','observe')),
  claimed_at TEXT NOT NULL CHECK (claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at TEXT NOT NULL CHECK (lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  start_allowed_until TEXT NOT NULL CHECK (start_allowed_until GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, environment_id, operation_id),
  FOREIGN KEY (organization_id, project_id, environment_id) REFERENCES environments (organization_id, project_id, environment_id),
  FOREIGN KEY (organization_id, project_id, operation_id) REFERENCES operations (organization_id, project_id, operation_id),
  CHECK (claimed_at >= created_at AND lease_expires_at > claimed_at
    AND lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%S', claimed_at, '+300 seconds') || substr(claimed_at, 20)
    AND start_allowed_until = strftime('%Y-%m-%dT%H:%M:%S', created_at, '+4 minutes') || substr(created_at, 20)
    AND (claim_mode = 'observe' OR claimed_at < start_allowed_until))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER build_input_reservations_no_delete BEFORE DELETE ON build_input_reservations
BEGIN SELECT RAISE(ABORT, 'build_input_reservations is append-only'); END;
CREATE TRIGGER build_input_reservations_renewal BEFORE UPDATE ON build_input_reservations
  WHEN EXISTS (SELECT 1 FROM build_receipts r WHERE r.organization_id = OLD.organization_id AND r.project_id = OLD.project_id
      AND r.environment_id = OLD.environment_id AND r.operation_id = OLD.operation_id)
    OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
    OR NEW.environment_id IS NOT OLD.environment_id OR NEW.operation_id IS NOT OLD.operation_id
    OR NEW.input_fingerprint IS NOT OLD.input_fingerprint OR NEW.created_at IS NOT OLD.created_at
    OR NEW.start_allowed_until IS NOT OLD.start_allowed_until OR NEW.claim_id = OLD.claim_id
    OR OLD.lease_expires_at > NEW.claimed_at OR NEW.claimed_at <= OLD.claimed_at
    OR NEW.lease_expires_at <= OLD.lease_expires_at OR NEW.attempt_number <> OLD.attempt_number + 1
    OR (OLD.claim_mode = 'observe' AND NEW.claim_mode <> 'observe')
    OR (NEW.claim_mode = 'start' AND NEW.claimed_at >= NEW.start_allowed_until)
BEGIN SELECT RAISE(ABORT, 'build_input_reservations permits only expired claim renewal'); END;

CREATE TABLE build_usage (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  billing_epoch_id TEXT NOT NULL,
  provider_build_id TEXT NOT NULL,
  build_project_name TEXT NOT NULL,
  runner TEXT NOT NULL CHECK (runner = 'cloudflare-build-sandbox'),
  instance_type TEXT NOT NULL CHECK (length(instance_type) BETWEEN 1 AND 64 AND substr(instance_type, 1, 1) GLOB '[a-z]' AND instance_type NOT GLOB '*[^a-z0-9-]*'),
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','FAULT','STOPPED','TIMED_OUT')),
  started_at TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.??????Z'),
  provisioning_started_at TEXT CHECK (provisioning_started_at IS NULL OR provisioning_started_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at TEXT NOT NULL CHECK (completed_at GLOB '????-??-??T??:??:??.??????Z'),
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, environment_id, operation_id),
  FOREIGN KEY (organization_id, project_id, environment_id, operation_id) REFERENCES build_receipts (organization_id, project_id, environment_id, operation_id),
  FOREIGN KEY (organization_id, project_id, billing_epoch_id) REFERENCES billing_epochs (organization_id, project_id, billing_epoch_id),
  CHECK (completed_at >= started_at AND (provisioning_started_at IS NULL OR provisioning_started_at BETWEEN started_at AND completed_at))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER build_usage_no_update BEFORE UPDATE ON build_usage
BEGIN SELECT RAISE(ABORT, 'build_usage is append-only'); END;
CREATE TRIGGER build_usage_no_delete BEFORE DELETE ON build_usage
BEGIN SELECT RAISE(ABORT, 'build_usage is append-only'); END;
