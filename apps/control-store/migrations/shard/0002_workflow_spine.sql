-- Workflow spine and the merged tables (same shard database; applied after shard.sql).

CREATE TABLE product_command_intents (
  organization_id                  TEXT    NOT NULL,
  operation_id                     TEXT    NOT NULL,
  event_type                       TEXT    NOT NULL CHECK (event_type GLOB '*V[0-9]*' AND length(event_type) BETWEEN 8 AND 128),
  project_id                       TEXT    NOT NULL,
  environment_id                   TEXT    NOT NULL,
  billing_epoch_id                 TEXT    NOT NULL,
  installation_id                  TEXT,
  repository_owner                 TEXT,
  repository_name                  TEXT,
  plan_id                          TEXT,
  source_connection_id             TEXT,
  deployment_id                    TEXT,
  target_deployment_id             TEXT,
  target_revision_id               TEXT,
  target_artifact_id               TEXT,
  expected_etag                    TEXT,
  cleanup_run_id                   TEXT,
  source_environment_id            TEXT,
  source_deployment_id             TEXT,
  source_revision_id               TEXT,
  source_artifact_id               TEXT,
  source_artifact_sha256           BLOB CHECK (source_artifact_sha256 IS NULL OR length(source_artifact_sha256) = 32),
  expected_source_head_version     INTEGER,
  expected_target_head_version     INTEGER,
  requested_handle                 TEXT,
  data_change                      TEXT CHECK (data_change IS NULL OR json_valid(data_change)),
  data_change_snapshot             TEXT CHECK (data_change_snapshot IS NULL OR json_valid(data_change_snapshot)),
  binding_refresh_snapshot         TEXT CHECK (binding_refresh_snapshot IS NULL OR json_valid(binding_refresh_snapshot)),
  binding_refresh_snapshot_sha256  BLOB CHECK (binding_refresh_snapshot_sha256 IS NULL OR length(binding_refresh_snapshot_sha256) = 32),
  source_generation                INTEGER,
  created_at                       TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, operation_id, event_type),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
  CHECK ((binding_refresh_snapshot IS NULL) = (binding_refresh_snapshot_sha256 IS NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX product_binding_refresh_snapshot_key
  ON product_command_intents (organization_id, project_id, environment_id, binding_refresh_snapshot_sha256)
  WHERE binding_refresh_snapshot_sha256 IS NOT NULL;

CREATE TABLE product_workflow_runs (
  organization_id                  TEXT NOT NULL,
  operation_id                     TEXT NOT NULL,
  event_type                       TEXT NOT NULL,
  workflow_id                      TEXT NOT NULL UNIQUE CHECK (length(workflow_id) = 26),
  event_id                         TEXT NOT NULL,
  project_id                       TEXT NOT NULL,
  environment_id                   TEXT NOT NULL,
  billing_epoch_id                 TEXT NOT NULL,
  state                            TEXT NOT NULL CHECK (state IN ('queued','running','reconciliation_required','completed')),
  terminal_evidence                TEXT CHECK (terminal_evidence IS NULL OR json_valid(terminal_evidence)),
  intermediate_evidence            TEXT CHECK (intermediate_evidence IS NULL OR json_valid(intermediate_evidence)),
  evidence_archive_key             TEXT,
  reconciliation_code              TEXT,
  active_reconciliation_attempt_id TEXT,
  active_replay_attempt_id         TEXT,
  created_at                       TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at                       TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at                     TEXT CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (organization_id, event_id),
  FOREIGN KEY (organization_id, operation_id, event_type) REFERENCES product_command_intents (organization_id, operation_id, event_type),
  FOREIGN KEY (organization_id, event_id) REFERENCES outbox_events (organization_id, event_id)
) STRICT, WITHOUT ROWID;

-- mail_send_requests absorbs mail_send_outcomes (latest provider outcome per request).
CREATE TABLE mail_send_requests (
  organization_id          TEXT    NOT NULL,
  request_id               TEXT    NOT NULL CHECK (length(request_id) = 26),
  project_id               TEXT    NOT NULL,
  idempotency_key          TEXT    NOT NULL,
  request_sha256           BLOB    NOT NULL CHECK (length(request_sha256) = 32),
  recipient_sha256         BLOB    NOT NULL CHECK (length(recipient_sha256) = 32),
  content_sha256           BLOB    NOT NULL CHECK (length(content_sha256) = 32),
  request_input_sha256     BLOB    CHECK (request_input_sha256 IS NULL OR length(request_input_sha256) = 32),
  credit_charge_micros     TEXT    NOT NULL CHECK (credit_charge_micros NOT GLOB '*[^0-9]*'),
  credit_reservation_id    TEXT    UNIQUE,
  credit_rate_card_id      TEXT,
  credit_meter             TEXT,
  credit_provider_cost_micros TEXT CHECK (credit_provider_cost_micros IS NULL OR credit_provider_cost_micros NOT GLOB '*[^0-9]*'),
  mail_provider            TEXT    NOT NULL,
  mail_domain_id           TEXT,
  mail_binding_revision    INTEGER,
  effective_from           TEXT,
  effective_reply_to       TEXT,
  state                    TEXT    NOT NULL,
  provider_started_at      TEXT    CHECK (provider_started_at IS NULL OR provider_started_at GLOB '????-??-??T??:??:??.??????Z'),
  provider_message_id      TEXT,
  outcome                  TEXT,
  outcome_event_id         TEXT,
  outcome_at               TEXT    CHECK (outcome_at IS NULL OR outcome_at GLOB '????-??-??T??:??:??.??????Z'),
  outcome_version          INTEGER NOT NULL DEFAULT 0,
  requested_at             TEXT    NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at               TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, request_id),
  UNIQUE (organization_id, project_id, idempotency_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX mail_send_requests_by_project ON mail_send_requests (organization_id, project_id, requested_at DESC);
CREATE INDEX mail_send_requests_by_message ON mail_send_requests (organization_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- the five wfp_candidate_cleanup_* tables as one row per candidate (request, lease, expectations, per-resource receipts, outcome).
CREATE TABLE wfp_candidate_cleanups (
  organization_id                  TEXT NOT NULL,
  candidate_receipt_id             TEXT NOT NULL,
  project_id                       TEXT NOT NULL,
  cleanup_request_id               TEXT NOT NULL UNIQUE,
  operation_id                     TEXT NOT NULL,
  reason                           TEXT NOT NULL,
  requested_at                     TEXT NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??.??????Z'),
  claim_id                         TEXT UNIQUE,
  claim_attempt_number             INTEGER,
  claimed_at                       TEXT CHECK (claimed_at IS NULL OR claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at                 TEXT CHECK (lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  expected_resources               TEXT NOT NULL CHECK (json_valid(expected_resources) AND json_type(expected_resources) = 'array'),
  resource_receipts                TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(resource_receipts) AND json_type(resource_receipts) = 'array'),
  outcome                          TEXT CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 64),
  outcome_detail                   TEXT CHECK (outcome_detail IS NULL OR json_valid(outcome_detail)),
  observed_at                      TEXT CHECK (observed_at IS NULL OR observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, candidate_receipt_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER wfp_candidate_cleanups_outcome_final BEFORE UPDATE ON wfp_candidate_cleanups
  WHEN OLD.outcome IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'cleanup outcome is final'); END;

-- historical AWS mail receipts (ses_*, route53_*, legacy_aws_mail_absence): body is the original row as JSON.
CREATE TABLE legacy_aws_mail_receipts (
  organization_id  TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('ses_tenant','ses_project_resource','ses_event_destination','route53_dkim_change','route53_dkim','absence')),
  locator          TEXT NOT NULL CHECK (length(locator) BETWEEN 1 AND 512),
  body             TEXT NOT NULL CHECK (json_valid(body)),
  recorded_at      TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, kind, locator)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER legacy_aws_mail_receipts_append_only BEFORE UPDATE ON legacy_aws_mail_receipts
BEGIN SELECT RAISE(ABORT, 'legacy_aws_mail_receipts is append-only'); END;
