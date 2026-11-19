-- W32: original PostgreSQL 002/003/006/092 global webhook inbox, with nullable routing metadata only.
-- Copy every existing fact unchanged; incompatible prototype facts fail this atomic batch and remain untouched.
-- Stage the sole referencing child, retain its complete DDL/bytes and change ONLY its inbox FK to the original global id.
-- Foreign keys remain enabled. The original reconciliation evidence guard and indexes are restored before commit.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS (
  SELECT 1 FROM webhook_inbox i JOIN inbox_unrouted u
    ON i.inbox_event_id = u.inbox_event_id OR (i.provider = u.provider AND i.external_event_id = u.external_event_id)
  WHERE i.inbox_event_id <> u.inbox_event_id OR i.provider <> u.provider
    OR i.external_event_id <> u.external_event_id OR i.body_sha256 IS NOT u.body_sha256
);
CREATE TABLE github_push_deployments_copy_0326 AS SELECT * FROM github_push_deployments;
DROP TABLE github_push_deployments;

CREATE TABLE webhook_inbox_0326 (
  inbox_event_id TEXT NOT NULL PRIMARY KEY CHECK (length(inbox_event_id) = 26 AND inbox_event_id GLOB '[0-7]*' AND inbox_event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  body_sha256 BLOB NOT NULL CHECK (length(body_sha256) = 32),
  received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.??????Z'),
  signature_timestamp TEXT CHECK (signature_timestamp IS NULL OR signature_timestamp GLOB '????-??-??T??:??:??.??????Z'),
  state TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2147483647),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 2147483647),
  available_at TEXT NOT NULL CHECK (available_at GLOB '????-??-??T??:??:??.??????Z'),
  claim_id TEXT CHECK (claim_id IS NULL OR (length(claim_id) = 26 AND claim_id GLOB '[0-7]*' AND claim_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  claimed_at TEXT CHECK (claimed_at IS NULL OR claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  last_error_code TEXT CHECK (last_error_code IS NULL OR (last_error_code GLOB '[A-Z]*' AND length(last_error_code) BETWEEN 2 AND 64 AND last_error_code NOT GLOB '*[^A-Z0-9_]*')),
  acknowledged_at TEXT CHECK (acknowledged_at IS NULL OR acknowledged_at GLOB '????-??-??T??:??:??.??????Z'),
  organization_id TEXT CHECK (organization_id IS NULL OR (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
  UNIQUE (provider, external_event_id),
  CHECK ((provider = 'workos' AND signature_timestamp IS NOT NULL) OR (provider IN ('github','stripe') AND signature_timestamp IS NULL)),
  CHECK (attempt_count <= max_attempts),
  CHECK ((state = 'pending' AND attempt_count = 0 AND claim_id IS NULL AND acknowledged_at IS NULL)
      OR (state = 'processing' AND attempt_count > 0 AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at > claimed_at AND acknowledged_at IS NULL)
      OR (state = 'retry_wait' AND attempt_count > 0 AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL)
      OR (state = 'acknowledged' AND attempt_count >= 0 AND claim_id IS NULL AND last_error_code IS NULL AND acknowledged_at IS NOT NULL)
      OR (state = 'reconciliation_required' AND attempt_count = max_attempts AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL))
) STRICT, WITHOUT ROWID;
INSERT INTO webhook_inbox_0326 (inbox_event_id, provider, external_event_id, event_type, payload, body_sha256, received_at, signature_timestamp, state, attempt_count, max_attempts, available_at, claim_id, claimed_at, lease_expires_at, last_error_code, acknowledged_at, organization_id) SELECT inbox_event_id, provider, external_event_id, event_type, payload, body_sha256, received_at, signature_timestamp, state, attempt_count, max_attempts, available_at, claim_id, claimed_at, lease_expires_at, last_error_code, acknowledged_at, organization_id FROM webhook_inbox;
DROP TABLE webhook_inbox;
ALTER TABLE webhook_inbox_0326 RENAME TO webhook_inbox;
CREATE UNIQUE INDEX webhook_inbox_global_id ON webhook_inbox (inbox_event_id);
CREATE INDEX webhook_inbox_claim ON webhook_inbox (available_at, received_at, inbox_event_id)
  WHERE state IN ('pending','retry_wait','processing') AND acknowledged_at IS NULL;
CREATE INDEX webhook_inbox_purge ON webhook_inbox (acknowledged_at) WHERE acknowledged_at IS NOT NULL;
CREATE TRIGGER webhook_inbox_reconciliation_delete_requires_export BEFORE DELETE ON webhook_inbox
WHEN OLD.state = 'reconciliation_required'
  AND (OLD.received_at > COALESCE((SELECT exported_through FROM retention_horizon WHERE table_name = 'webhook_inbox'), '')
    OR NOT EXISTS (SELECT 1 FROM evidence_exports ex WHERE ex.organization_id = OLD.organization_id AND ex.table_name = 'webhook_inbox'
         AND ex.period_start <= OLD.received_at AND OLD.received_at < ex.period_end))
BEGIN SELECT RAISE(ABORT, 'a reconciliation-required inbox event is deletable only after a verified export'); END;

CREATE TABLE github_push_deployments (
  organization_id        TEXT    NOT NULL,
  push_deployment_id     TEXT    NOT NULL CHECK (length(push_deployment_id) = 26),
  inbox_event_id         TEXT    NOT NULL,
  project_id             TEXT    NOT NULL,
  source_connection_id   TEXT    NOT NULL,
  config_generation      INTEGER NOT NULL CHECK (config_generation > 0),
  delivery_guid          TEXT    NOT NULL,
  github_installation_id TEXT    NOT NULL CHECK (github_installation_id NOT GLOB '*[^0-9]*' AND github_installation_id NOT GLOB '0*' AND length(github_installation_id) BETWEEN 1 AND 20),
  external_repository_id TEXT    NOT NULL CHECK (external_repository_id NOT GLOB '*[^0-9]*' AND external_repository_id NOT GLOB '0*' AND length(external_repository_id) BETWEEN 1 AND 16),
  branch_ref             TEXT    NOT NULL CHECK (branch_ref GLOB 'refs/heads/*'),
  commit_sha             TEXT    NOT NULL CHECK (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*' AND commit_sha <> '0000000000000000000000000000000000000000'),
  sequence               INTEGER NOT NULL CHECK (sequence > 0),
  operation_id           TEXT    NOT NULL,
  state                  TEXT    NOT NULL CHECK (state IN ('queued', 'running', 'superseded', 'failed', 'active', 'reconciliation_required')),
  superseded_by_id       TEXT,
  cleanup_required       INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_required IN (0, 1)),
  created_at             TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at             TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at >= created_at),
  PRIMARY KEY (organization_id, push_deployment_id),
  UNIQUE (organization_id, project_id, delivery_guid),
  CHECK ((state = 'superseded' AND superseded_by_id IS NOT NULL AND cleanup_required = 1)
      OR (state <> 'superseded' AND superseded_by_id IS NULL)),
  FOREIGN KEY (inbox_event_id) REFERENCES webhook_inbox (inbox_event_id),
  FOREIGN KEY (organization_id, project_id, source_connection_id) REFERENCES repository_grants (organization_id, project_id, source_connection_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
  FOREIGN KEY (organization_id, superseded_by_id) REFERENCES github_push_deployments (organization_id, push_deployment_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX github_push_deployments_by_operation ON github_push_deployments (organization_id, operation_id);
INSERT INTO github_push_deployments SELECT * FROM github_push_deployments_copy_0326;
DROP TABLE github_push_deployments_copy_0326;
