-- W41: durable preview identity belongs to a project environment, not a commit lease.
-- Historical 0622-0630 preview sessions and their usage remain untouched.
-- The retained activated Build-history lineage predates 0384's assignment primary key.
-- Give both lineages the same exact parent key without rebuilding historical assignments.
CREATE UNIQUE INDEX environment_data_assignments_preview_scope ON environment_data_assignments(organization_id,project_id,environment_id,assignment_version);
CREATE TABLE project_previews (
  preview_id TEXT PRIMARY KEY CHECK(length(preview_id)=26),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  environment_name TEXT NOT NULL CHECK(environment_name IN ('dev','prod')),
  data_environment_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL CHECK(assignment_version>0),
  billing_epoch_id TEXT NOT NULL,
  ownership_version INTEGER NOT NULL CHECK(ownership_version>0),
  lifecycle_version INTEGER NOT NULL CHECK(lifecycle_version>0),
  token_lookup_sha256 BLOB CHECK(token_lookup_sha256 IS NULL OR length(token_lookup_sha256)=32),
  token_ciphertext TEXT CHECK(token_ciphertext IS NULL OR length(token_ciphertext) BETWEEN 32 AND 256),
  token_nonce TEXT CHECK(token_nonce IS NULL OR length(token_nonce)=16),
  token_key_version INTEGER CHECK(token_key_version IS NULL OR token_key_version>0),
  token_generation INTEGER NOT NULL CHECK(token_generation>0),
  runtime_generation INTEGER NOT NULL CHECK(runtime_generation>0),
  auth_generation INTEGER NOT NULL CHECK(auth_generation>0),
  row_version INTEGER NOT NULL CHECK(row_version>0),
  state TEXT NOT NULL CHECK(state IN ('cold','starting','ready','sleeping')),
  retirement TEXT NOT NULL DEFAULT 'none' CHECK(retirement IN ('none','rotating','destroying','suspended','retired')),
  retirement_request_id TEXT,
  target_connection_id TEXT,
  target_generation INTEGER,
  target_sequence INTEGER,
  target_commit TEXT,
  applied_connection_id TEXT,
  applied_generation INTEGER,
  applied_sequence INTEGER,
  applied_commit TEXT,
  backup_handle TEXT,
  backup_expires_at TEXT,
  backup_connection_id TEXT,
  backup_generation INTEGER,
  backup_sequence INTEGER,
  backup_commit TEXT,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,environment_id,assignment_version) REFERENCES environment_data_assignments(organization_id,project_id,environment_id,assignment_version),
  FOREIGN KEY(organization_id,project_id,data_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id),
  FOREIGN KEY(organization_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,billing_epoch_id),
  CHECK((retirement='retired' AND token_lookup_sha256 IS NULL AND token_ciphertext IS NULL AND token_nonce IS NULL AND token_key_version IS NULL) OR (retirement<>'retired' AND token_lookup_sha256 IS NOT NULL AND token_ciphertext IS NOT NULL AND token_nonce IS NOT NULL AND token_key_version IS NOT NULL)),
  CHECK((retirement='none' AND retirement_request_id IS NULL) OR (retirement<>'none' AND retirement_request_id IS NOT NULL)),
  CHECK((target_connection_id IS NULL AND target_generation IS NULL AND target_sequence IS NULL AND target_commit IS NULL)
    OR (target_connection_id IS NOT NULL AND target_generation>0 AND target_sequence>0 AND length(target_commit)=40)),
  CHECK((applied_connection_id IS NULL AND applied_generation IS NULL AND applied_sequence IS NULL AND applied_commit IS NULL)
    OR (applied_connection_id IS NOT NULL AND applied_generation>0 AND applied_sequence>0 AND length(applied_commit)=40)),
  CHECK((backup_handle IS NULL AND backup_expires_at IS NULL AND backup_connection_id IS NULL AND backup_generation IS NULL AND backup_sequence IS NULL AND backup_commit IS NULL)
    OR (backup_handle IS NOT NULL AND length(backup_handle) BETWEEN 1 AND 4096 AND backup_expires_at IS NOT NULL AND backup_connection_id IS NOT NULL AND backup_generation>0 AND backup_sequence>0 AND length(backup_commit)=40))
) STRICT;
CREATE UNIQUE INDEX project_previews_active_environment ON project_previews(project_id,environment_id) WHERE retirement<>'retired';
CREATE UNIQUE INDEX project_previews_active_token ON project_previews(token_lookup_sha256) WHERE retirement<>'retired';
CREATE TRIGGER project_previews_identity_immutable BEFORE UPDATE OF preview_id,organization_id,project_id,environment_id,environment_name,billing_epoch_id,ownership_version,lifecycle_version ON project_previews
BEGIN SELECT RAISE(ABORT,'preview identity is immutable'); END;

-- Source sequence is allocated in the same transaction that accepts a source version.
CREATE TABLE project_preview_source_events (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 256),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  source_connection_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation>0),
  commit_sha TEXT NOT NULL CHECK(length(commit_sha)=40),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,project_id,event_id),
  UNIQUE(organization_id,project_id,sequence),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE project_preview_source_heads (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  source_connection_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation>0),
  commit_sha TEXT NOT NULL CHECK(length(commit_sha)=40),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,project_id),
  FOREIGN KEY(organization_id,project_id,sequence) REFERENCES project_preview_source_events(organization_id,project_id,sequence)
) STRICT, WITHOUT ROWID;
-- A durable coalescing outbox: no source save starts a sleeping preview.
CREATE TABLE project_preview_source_pending (
  preview_id TEXT PRIMARY KEY REFERENCES project_previews(preview_id),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  updated_at TEXT NOT NULL
) STRICT;

-- A request receipt never retains a capability, envelope, URL, backup, or key.
CREATE TABLE project_preview_receipts (
  preview_id TEXT NOT NULL REFERENCES project_previews(preview_id),
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK(kind IN ('rotate','destroy')),
  generation INTEGER NOT NULL CHECK(generation>0),
  PRIMARY KEY(preview_id,request_id)
) STRICT, WITHOUT ROWID;

-- Retained immutable runs decouple measured charges from active identity cleanup.
CREATE TABLE project_preview_runs (
  preview_id TEXT NOT NULL REFERENCES project_previews(preview_id),
  runtime_generation INTEGER NOT NULL CHECK(runtime_generation>0),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  billing_epoch_id TEXT NOT NULL,
  application_id TEXT NOT NULL CHECK(length(application_id) IN (32,36)),
  started_at TEXT NOT NULL,
  PRIMARY KEY(preview_id,runtime_generation),
  FOREIGN KEY(organization_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,billing_epoch_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE project_preview_usage_intervals (
  preview_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL,
  interval_id TEXT NOT NULL CHECK(length(interval_id) BETWEEN 1 AND 128),
  reservation_id TEXT NOT NULL UNIQUE,
  seconds INTEGER NOT NULL CHECK(seconds BETWEEN 1 AND 60),
  hold_sequence INTEGER NOT NULL CHECK(hold_sequence>0),
  quoted_micros INTEGER NOT NULL CHECK(quoted_micros>0),
  state TEXT NOT NULL CHECK(state IN ('reserved','unstarted','awaiting_provider','settled')),
  container_start_attempted INTEGER CHECK(container_start_attempted IS NULL OR container_start_attempted IN (0,1)),
  active_milliseconds INTEGER,
  cpu_milliseconds INTEGER,
  charged_micros INTEGER,
  provider_fact_id TEXT,
  provider_observed_at TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  resolved_at TEXT,
  reconciliation_next_at TEXT,
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_attempts BETWEEN 0 AND 32),
  last_reconciliation_at TEXT,
  PRIMARY KEY(preview_id,runtime_generation,interval_id),
  FOREIGN KEY(preview_id,runtime_generation) REFERENCES project_preview_runs(preview_id,runtime_generation),
  CHECK((state='reserved' AND container_start_attempted IS NULL AND active_milliseconds IS NULL AND cpu_milliseconds IS NULL AND charged_micros IS NULL AND provider_fact_id IS NULL AND provider_observed_at IS NULL AND closed_at IS NULL AND resolved_at IS NULL AND reconciliation_next_at IS NULL AND reconciliation_attempts=0 AND last_reconciliation_at IS NULL)
    OR (state='unstarted' AND container_start_attempted=0 AND active_milliseconds=0 AND cpu_milliseconds IS NULL AND charged_micros=0 AND provider_fact_id IS NULL AND provider_observed_at IS NULL AND closed_at IS NOT NULL AND resolved_at IS NOT NULL AND reconciliation_next_at IS NULL AND reconciliation_attempts=0 AND last_reconciliation_at IS NULL)
    OR (state='awaiting_provider' AND container_start_attempted=1 AND active_milliseconds IS NOT NULL AND cpu_milliseconds IS NULL AND charged_micros IS NOT NULL AND charged_micros>=0 AND provider_fact_id IS NULL AND provider_observed_at IS NULL AND closed_at IS NOT NULL AND resolved_at IS NULL AND reconciliation_next_at IS NOT NULL)
    OR (state='settled' AND container_start_attempted=1 AND active_milliseconds IS NOT NULL AND cpu_milliseconds IS NOT NULL AND charged_micros IS NOT NULL AND provider_fact_id IS NOT NULL AND provider_observed_at IS NOT NULL AND closed_at IS NOT NULL AND resolved_at IS NOT NULL AND reconciliation_next_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX project_preview_one_open_interval ON project_preview_usage_intervals(preview_id) WHERE state='reserved';
CREATE UNIQUE INDEX project_preview_interval_identity ON project_preview_usage_intervals(preview_id,interval_id);
CREATE INDEX project_preview_usage_due ON project_preview_usage_intervals(state,reconciliation_next_at,preview_id,runtime_generation,interval_id) WHERE state IN ('awaiting_provider','settled');
-- Exact-object custody survives replacing or expiring a backup until the trusted actor confirms deletion.
CREATE TABLE project_preview_backup_cleanup (
  preview_id TEXT NOT NULL REFERENCES project_previews(preview_id),
  cleanup_id TEXT NOT NULL CHECK(length(cleanup_id)=26),
  backup_handle TEXT NOT NULL CHECK(length(backup_handle) BETWEEN 1 AND 4096),
  created_at TEXT NOT NULL,
  PRIMARY KEY(preview_id,cleanup_id),
  UNIQUE(preview_id,backup_handle)
) STRICT, WITHOUT ROWID;
-- Each verified provider observation is retained; only cumulative increases add charges.
CREATE TABLE project_preview_usage_observations (
  preview_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL,
  interval_id TEXT NOT NULL,
  provider_fact_id TEXT NOT NULL CHECK(length(provider_fact_id)=64 AND provider_fact_id NOT GLOB '*[^0-9a-f]*'),
  cpu_milliseconds INTEGER NOT NULL CHECK(cpu_milliseconds>=0),
  observed_at TEXT NOT NULL,
  charged_delta_micros INTEGER NOT NULL CHECK(charged_delta_micros>=0),
  PRIMARY KEY(preview_id,runtime_generation,interval_id,provider_fact_id),
  FOREIGN KEY(preview_id,runtime_generation,interval_id) REFERENCES project_preview_usage_intervals(preview_id,runtime_generation,interval_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER project_preview_usage_observations_immutable BEFORE UPDATE ON project_preview_usage_observations BEGIN SELECT RAISE(ABORT,'provider usage observations are immutable'); END;
CREATE TRIGGER project_preview_usage_observations_no_delete BEFORE DELETE ON project_preview_usage_observations BEGIN SELECT RAISE(ABORT,'provider usage observations are retained'); END;

-- A terminal receipt lets a lost actor acknowledgement be replayed safely without storing secret custody.
CREATE TABLE project_preview_cleanup_receipts (
  preview_id TEXT NOT NULL REFERENCES project_previews(preview_id),
  runtime_generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('scope','entitlement','assignment','source')),
  completed_at TEXT NOT NULL,
  PRIMARY KEY(preview_id,runtime_generation)
) STRICT, WITHOUT ROWID;
-- Preview Native Auth preparation has its own source-bound claim, never a fabricated deployment intent.
CREATE TABLE project_preview_native_preparations (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=26),
  claim_id TEXT NOT NULL UNIQUE CHECK(length(claim_id)=26),
  preview_id TEXT NOT NULL REFERENCES project_previews(preview_id),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  billing_epoch_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL CHECK(runtime_generation>0),
  token_generation INTEGER NOT NULL CHECK(token_generation>0),
  auth_generation INTEGER NOT NULL CHECK(auth_generation>0),
  source_connection_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation>0),
  source_sequence INTEGER NOT NULL CHECK(source_sequence>0),
  commit_sha TEXT NOT NULL CHECK(length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  build_plan_sha256 TEXT NOT NULL CHECK(length(build_plan_sha256)=64 AND build_plan_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('pending','running','uncertain','succeeded','failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(preview_id,source_sequence,auth_generation),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
  FOREIGN KEY(organization_id,billing_epoch_id) REFERENCES billing_epochs(organization_id,billing_epoch_id)
) STRICT;
CREATE UNIQUE INDEX preview_native_one_running_project ON project_preview_native_preparations(project_id) WHERE state='running';
CREATE TABLE project_preview_usage_cursor (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  preview_id TEXT,
  runtime_generation INTEGER,
  interval_id TEXT,
  reconciliation_budget_minute TEXT,
  reconciliation_budget_used INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_budget_used BETWEEN 0 AND 20),
  CHECK((preview_id IS NULL AND runtime_generation IS NULL AND interval_id IS NULL) OR (preview_id IS NOT NULL AND runtime_generation>0 AND interval_id IS NOT NULL))
) STRICT;
INSERT INTO project_preview_usage_cursor(singleton,preview_id,runtime_generation,interval_id) VALUES(1,NULL,NULL,NULL);
CREATE TABLE project_preview_native_cursor (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  operation_id TEXT CHECK(operation_id IS NULL OR length(operation_id)=26)
) STRICT;
INSERT INTO project_preview_native_cursor(singleton,operation_id) VALUES(1,NULL);

CREATE TABLE project_preview_native_policy_receipts (
  preview_id TEXT NOT NULL REFERENCES project_previews(preview_id),
  auth_generation INTEGER NOT NULL CHECK(auth_generation>0),
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision>0),
  revocation_epoch INTEGER NOT NULL CHECK(revocation_epoch>0),
  registry_version INTEGER NOT NULL CHECK(registry_version>0),
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256)=64 AND schema_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation_id TEXT NOT NULL REFERENCES project_preview_native_preparations(operation_id),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(preview_id,auth_generation,configuration_revision,revocation_epoch)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER project_preview_native_policy_receipts_immutable BEFORE UPDATE ON project_preview_native_policy_receipts BEGIN SELECT RAISE(ABORT,'preview native policy receipts are immutable'); END;
CREATE TRIGGER project_preview_native_policy_receipts_no_delete BEFORE DELETE ON project_preview_native_policy_receipts BEGIN SELECT RAISE(ABORT,'preview native policy receipts are retained'); END;
CREATE TABLE project_preview_native_drains (
  preview_id TEXT NOT NULL REFERENCES project_previews(preview_id),
  runtime_generation INTEGER NOT NULL CHECK(runtime_generation>0),
  token_generation INTEGER NOT NULL CHECK(token_generation>0),
  auth_generation INTEGER NOT NULL CHECK(auth_generation>0),
  completed_at TEXT NOT NULL,
  PRIMARY KEY(preview_id,runtime_generation,token_generation,auth_generation)
) STRICT, WITHOUT ROWID;
