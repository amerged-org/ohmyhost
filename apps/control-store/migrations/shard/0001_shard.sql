-- Command layer shared by the directory and every shard.
-- guard_fail never holds a row: inserting one aborts the whole D1 batch with "CHECK constraint failed: guard_<code>".
CREATE TABLE guard_fail (
  code TEXT NOT NULL,
  CONSTRAINT guard_row_version_conflict CHECK (code <> 'row_version_conflict'),
  CONSTRAINT guard_claim_lost CHECK (code <> 'claim_lost'),
  CONSTRAINT guard_operation_conflict CHECK (code <> 'operation_conflict'),
  CONSTRAINT guard_owner_changed CHECK (code <> 'owner_changed'),
  CONSTRAINT guard_insufficient_credits CHECK (code <> 'insufficient_credits'),
  CONSTRAINT guard_wallet_version_conflict CHECK (code <> 'wallet_version_conflict'),
  CONSTRAINT guard_source_head_conflict CHECK (code <> 'source_head_conflict'),
  CONSTRAINT guard_scope_inactive CHECK (code <> 'scope_inactive')
) STRICT;

-- Exactly-once identity of commands that have no natural unique key.
CREATE TABLE command_log (
  command_id TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  digest     TEXT NOT NULL,
  result     TEXT NOT NULL CHECK (json_valid(result)),
  applied_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- TENANT SHARD database (CONTROL_SHARD_nnnn). Many organizations per database; every primary key starts with organization_id.
-- Foreign keys: declared only along the containment spine and always against a primary key. Pointer columns that would
-- create a cycle (projects.active_billing_epoch_id, environments.active_*) are guarded in the write batch instead.
-- Every write path is one db.batch(); cross-row conditions are INSERT ... SELECT ... WHERE guards, not interactive reads.

CREATE TABLE organizations (
  organization_id         TEXT    NOT NULL PRIMARY KEY
    CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  workos_organization_id  TEXT    NOT NULL UNIQUE CHECK (workos_organization_id GLOB 'org_*' AND length(workos_organization_id) BETWEEN 5 AND 128),
  state                   TEXT    NOT NULL CHECK (state IN ('active','suspended','deleted')),
  mapping_revision        INTEGER NOT NULL CHECK (mapping_revision > 0),
  snapshot_sha256         BLOB    NOT NULL CHECK (length(snapshot_sha256) = 32),
  snapshot_fetched_at     TEXT    NOT NULL CHECK (snapshot_fetched_at GLOB '????-??-??T??:??:??.??????Z'),
  synchronized_at         TEXT    NOT NULL CHECK (synchronized_at GLOB '????-??-??T??:??:??.??????Z'),
  beta_admitted_at        TEXT    CHECK (beta_admitted_at IS NULL OR beta_admitted_at GLOB '????-??-??T??:??:??.??????Z'),
  signup_source           TEXT,
  created_at              TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at              TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  -- Routing bucket, written with the first snapshot. Always a real bucket: the bucket fence of sweepers joins on
  -- it, so there is no "unknown" value that could bypass a live fence.
  bucket                  INTEGER NOT NULL CHECK (bucket BETWEEN 0 AND 1023)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER organizations_deleted_terminal BEFORE UPDATE OF state ON organizations
  WHEN OLD.state = 'deleted' AND NEW.state <> 'deleted'
BEGIN SELECT RAISE(ABORT, 'deleted organization is terminal'); END;

CREATE TABLE organization_memberships (
  organization_id   TEXT    NOT NULL REFERENCES organizations (organization_id),
  workos_user_id    TEXT    NOT NULL CHECK (workos_user_id GLOB 'user_*' AND length(workos_user_id) BETWEEN 6 AND 128),
  role              TEXT    NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
  state             TEXT    NOT NULL CHECK (state IN ('active','suspended','revoked')),
  mapping_revision  INTEGER NOT NULL CHECK (mapping_revision > 0),
  snapshot_sha256   BLOB    NOT NULL CHECK (length(snapshot_sha256) = 32),
  effective_at      TEXT    NOT NULL CHECK (effective_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at        TEXT    CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  trigger_event_id  TEXT    NOT NULL,
  PRIMARY KEY (organization_id, workos_user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX organization_memberships_user ON organization_memberships (workos_user_id, organization_id) WHERE state = 'active';

CREATE TABLE local_authorization_grants (
  organization_id    TEXT NOT NULL REFERENCES organizations (organization_id),
  grant_id           TEXT NOT NULL CHECK (length(grant_id) = 26),
  project_id         TEXT CHECK (project_id IS NULL OR length(project_id) = 26),
  environment_id     TEXT CHECK (environment_id IS NULL OR length(environment_id) = 26),
  principal_kind     TEXT NOT NULL CHECK (principal_kind IN ('user','service')),
  principal_id       TEXT NOT NULL,
  role               TEXT NOT NULL CHECK (role IN ('owner','member')),
  ownership_version  INTEGER,
  billing_epoch_id   TEXT CHECK (billing_epoch_id IS NULL OR length(billing_epoch_id) = 26),
  created_at         TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at         TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, grant_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX local_authorization_grants_one_active_scope
  ON local_authorization_grants (organization_id, principal_kind, principal_id, COALESCE(project_id, ''), COALESCE(environment_id, ''))
  WHERE revoked_at IS NULL;

-- projects absorbs project_ownerships (1:1 in Dev: 67/67). organization_id is the owner; created_organization_id is attribution only.
CREATE TABLE projects (
  organization_id          TEXT    NOT NULL REFERENCES organizations (organization_id),
  project_id               TEXT    NOT NULL
    CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  created_organization_id  TEXT    NOT NULL CHECK (length(created_organization_id) = 26),
  name                     TEXT    NOT NULL CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 128),
  created_event_id         TEXT    NOT NULL UNIQUE CHECK (length(created_event_id) = 26),
  handle                   TEXT    NOT NULL CHECK (length(handle) BETWEEN 1 AND 59),
  handle_version           TEXT    NOT NULL,
  handle_attempt           INTEGER NOT NULL CHECK (handle_attempt BETWEEN 0 AND 31),
  lifecycle_state          TEXT    NOT NULL CHECK (lifecycle_state IN ('active','deleting','deleted')),
  lifecycle_version        INTEGER NOT NULL CHECK (lifecycle_version > 0),
  owner_state              TEXT    NOT NULL CHECK (owner_state IN ('active','transfer_pending_frozen','security_frozen')),
  ownership_version        INTEGER NOT NULL CHECK (ownership_version > 0),
  active_billing_epoch_id  TEXT    NOT NULL CHECK (length(active_billing_epoch_id) = 26),
  data_mode                TEXT    NOT NULL CHECK (data_mode IN ('shared','isolated')),
  region                   TEXT    NOT NULL CHECK (region IN ('us','eu')),
  dev_access_mode          TEXT    NOT NULL CHECK (dev_access_mode IN ('protected','public')),
  created_at               TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at               TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX projects_by_handle ON projects (handle);

CREATE TABLE billing_epochs (
  organization_id          TEXT NOT NULL,
  billing_epoch_id         TEXT NOT NULL CHECK (length(billing_epoch_id) = 26),
  project_id               TEXT NOT NULL,
  started_at               TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.??????Z'),
  ended_at                 TEXT CHECK (ended_at IS NULL OR ended_at GLOB '????-??-??T??:??:??.??????Z'),
  created_by_principal_id  TEXT NOT NULL,
  PRIMARY KEY (organization_id, billing_epoch_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX billing_epochs_one_open_per_project ON billing_epochs (organization_id, project_id) WHERE ended_at IS NULL;

-- environments absorbs billing_environment_scopes (1:1, 134/134). Head pointers are guarded in the batch (cycle with deployments).
CREATE TABLE environments (
  organization_id        TEXT    NOT NULL,
  environment_id         TEXT    NOT NULL
    CHECK (length(environment_id) = 26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id             TEXT    NOT NULL,
  name                   TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 63),
  desired_state          TEXT    NOT NULL CHECK (json_valid(desired_state) AND json_type(desired_state) = 'object'),
  active_deployment_id   TEXT    CHECK (active_deployment_id IS NULL OR length(active_deployment_id) = 26),
  active_revision_id     TEXT    CHECK (active_revision_id IS NULL OR length(active_revision_id) = 26),
  head_version           INTEGER NOT NULL CHECK (head_version >= 0),
  dev_access_epoch       INTEGER NOT NULL CHECK (dev_access_epoch >= 0),
  created_at             TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at             TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, environment_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  UNIQUE (organization_id, project_id, name),
  CHECK ((head_version = 0 AND active_deployment_id IS NULL AND active_revision_id IS NULL)
      OR (head_version > 0 AND active_deployment_id IS NOT NULL AND active_revision_id IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE project_data_environments (
  organization_id      TEXT NOT NULL,
  project_id           TEXT NOT NULL,
  data_environment_id  TEXT NOT NULL CHECK (length(data_environment_id) = 26),
  created_at           TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, data_environment_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE environment_data_assignments (
  organization_id      TEXT    NOT NULL,
  environment_id       TEXT    NOT NULL,
  assignment_version   INTEGER NOT NULL CHECK (assignment_version >= 1),
  project_id           TEXT    NOT NULL,
  data_environment_id  TEXT    NOT NULL,
  assigned_at          TEXT    NOT NULL CHECK (assigned_at GLOB '????-??-??T??:??:??.??????Z'),
  operation_id         TEXT    CHECK (operation_id IS NULL OR length(operation_id) = 26),
  PRIMARY KEY (organization_id, environment_id, assignment_version),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id),
  FOREIGN KEY (organization_id, project_id, data_environment_id) REFERENCES project_data_environments (organization_id, project_id, data_environment_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE operations (
  organization_id        TEXT NOT NULL,
  operation_id           TEXT NOT NULL
    CHECK (length(operation_id) = 26 AND operation_id GLOB '[0-7]*' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id             TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  failure                TEXT CHECK (failure IS NULL OR json_valid(failure)),
  billing_epoch_id       TEXT NOT NULL,
  result_deployment_id   TEXT CHECK (result_deployment_id IS NULL OR length(result_deployment_id) = 26),
  result_url             TEXT,
  result_artifact_sha256 BLOB,
  lease_expires_at       TEXT CHECK (lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  archive_key            TEXT,
  created_at             TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at             TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  FOREIGN KEY (organization_id, billing_epoch_id) REFERENCES billing_epochs (organization_id, billing_epoch_id),
  CHECK ((result_deployment_id IS NULL AND result_url IS NULL AND result_artifact_sha256 IS NULL)
      OR (state = 'succeeded' AND result_deployment_id IS NOT NULL AND result_url GLOB 'https://*' AND length(result_artifact_sha256) = 32)),
  CHECK (lease_expires_at IS NULL OR state IN ('queued','running'))
) STRICT, WITHOUT ROWID;
CREATE INDEX operations_expired_lease ON operations (lease_expires_at) WHERE lease_expires_at IS NOT NULL;
CREATE INDEX operations_by_project ON operations (organization_id, project_id, created_at DESC, operation_id);

CREATE TABLE operation_events (
  organization_id  TEXT    NOT NULL,
  operation_id     TEXT    NOT NULL,
  revision         INTEGER NOT NULL CHECK (revision >= 0),
  event_id         TEXT    NOT NULL CHECK (length(event_id) = 26),
  project_id       TEXT    NOT NULL,
  event_type       TEXT    NOT NULL,
  idempotency_key  TEXT,
  payload          TEXT    NOT NULL CHECK (json_valid(payload)),
  occurred_at      TEXT    NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, operation_id, revision),
  UNIQUE (organization_id, event_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX operation_events_idempotency ON operation_events (organization_id, operation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- outbox_events absorbs delivery_attempts: attempt history is attempt_count + the current attempt fence + the last outcome.
CREATE TABLE outbox_events (
  organization_id             TEXT    NOT NULL,
  event_id                   TEXT    NOT NULL CHECK (length(event_id) = 26),
  project_id                 TEXT    NOT NULL,
  operation_id               TEXT    NOT NULL,
  billing_epoch_id           TEXT    NOT NULL,
  event_type                 TEXT    NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  payload                    TEXT    NOT NULL CHECK (json_valid(payload)),
  created_at                 TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  initial_available_at       TEXT    NOT NULL CHECK (initial_available_at GLOB '????-??-??T??:??:??.??????Z'),
  available_at               TEXT    NOT NULL CHECK (available_at GLOB '????-??-??T??:??:??.??????Z'),
  attempt_count              INTEGER NOT NULL DEFAULT 0,
  max_attempts               INTEGER NOT NULL,
  current_attempt_id         TEXT    CHECK (current_attempt_id IS NULL OR length(current_attempt_id) = 26),
  claimed_at                 TEXT    CHECK (claimed_at IS NULL OR claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at           TEXT    CHECK (lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  last_attempt_status        TEXT    CHECK (last_attempt_status IS NULL OR last_attempt_status IN ('claimed','retry_scheduled','reconciliation_required','acknowledged')),
  last_error_code            TEXT    CHECK (last_error_code IS NULL OR (last_error_code GLOB '[A-Z]*' AND length(last_error_code) BETWEEN 2 AND 64 AND last_error_code NOT GLOB '*[^A-Z0-9_]*')),
  reconciliation_required_at TEXT    CHECK (reconciliation_required_at IS NULL OR reconciliation_required_at GLOB '????-??-??T??:??:??.??????Z'),
  acknowledged_at            TEXT    CHECK (acknowledged_at IS NULL OR acknowledged_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, event_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
  CHECK (attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts),
  CHECK (reconciliation_required_at IS NULL OR (acknowledged_at IS NULL AND last_error_code IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX outbox_events_claim ON outbox_events (available_at, created_at, event_id)
  WHERE acknowledged_at IS NULL AND reconciliation_required_at IS NULL;
CREATE INDEX outbox_events_expired_final_lease ON outbox_events (lease_expires_at, created_at, event_id)
  WHERE acknowledged_at IS NULL AND reconciliation_required_at IS NULL AND current_attempt_id IS NOT NULL
    AND lease_expires_at IS NOT NULL AND attempt_count = max_attempts;
CREATE INDEX outbox_events_purge ON outbox_events (acknowledged_at) WHERE acknowledged_at IS NOT NULL;

CREATE TABLE audit_events (
  organization_id   TEXT NOT NULL,
  audit_event_id    TEXT NOT NULL CHECK (length(audit_event_id) = 26),
  project_id        TEXT CHECK (project_id IS NULL OR length(project_id) = 26),
  operation_id      TEXT CHECK (operation_id IS NULL OR length(operation_id) = 26),
  billing_epoch_id  TEXT CHECK (billing_epoch_id IS NULL OR length(billing_epoch_id) = 26),
  event_type        TEXT NOT NULL,
  actor_type        TEXT NOT NULL,
  actor_id          TEXT NOT NULL,
  payload           TEXT NOT NULL CHECK (json_valid(payload)),
  occurred_at       TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, occurred_at, audit_event_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX audit_events_by_id ON audit_events (organization_id, audit_event_id);

CREATE TABLE api_idempotency_records (
  organization_id           TEXT NOT NULL,
  principal_id              TEXT NOT NULL,
  http_method               TEXT NOT NULL CHECK (http_method = upper(http_method)),
  route_template            TEXT NOT NULL CHECK (route_template GLOB '/v1/*'),
  idempotency_key           TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  canonical_request_sha256  BLOB NOT NULL CHECK (length(canonical_request_sha256) = 32),
  canonicalization_version  TEXT NOT NULL CHECK (canonicalization_version = 'rfc8785-v1'),
  request_id                TEXT NOT NULL,
  operation_id              TEXT CHECK (operation_id IS NULL OR length(operation_id) = 26),
  http_status               INTEGER NOT NULL CHECK (http_status BETWEEN 200 AND 599),
  response_headers          TEXT NOT NULL CHECK (json_valid(response_headers) AND json_type(response_headers) = 'object'),
  response_body             TEXT NOT NULL CHECK (json_valid(response_body) AND json_type(response_body) = 'object'),
  created_at                TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at              TEXT NOT NULL CHECK (completed_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at                TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z' AND expires_at >= completed_at),
  PRIMARY KEY (organization_id, principal_id, http_method, route_template, idempotency_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX api_idempotency_records_expiry ON api_idempotency_records (expires_at);

CREATE TABLE webhook_inbox (
  organization_id      TEXT    NOT NULL,
  inbox_event_id       TEXT    NOT NULL CHECK (length(inbox_event_id) = 26),
  provider             TEXT    NOT NULL CHECK (provider IN ('workos','github','resend','stripe')),
  external_event_id    TEXT    NOT NULL,
  event_type           TEXT    NOT NULL,
  payload              TEXT    NOT NULL CHECK (json_valid(payload)),
  body_sha256          BLOB    NOT NULL CHECK (length(body_sha256) = 32),
  received_at          TEXT    NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.??????Z'),
  signature_timestamp  TEXT    NOT NULL CHECK (signature_timestamp GLOB '????-??-??T??:??:??.??????Z'),
  state                TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','retry_wait','acknowledged','reconciliation_required')),
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL,
  available_at         TEXT    NOT NULL CHECK (available_at GLOB '????-??-??T??:??:??.??????Z'),
  claim_id             TEXT    CHECK (claim_id IS NULL OR length(claim_id) = 26),
  claimed_at           TEXT    CHECK (claimed_at IS NULL OR claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at     TEXT    CHECK (lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  last_error_code      TEXT    CHECK (last_error_code IS NULL OR (last_error_code GLOB '[A-Z]*' AND length(last_error_code) BETWEEN 2 AND 64 AND last_error_code NOT GLOB '*[^A-Z0-9_]*')),
  acknowledged_at      TEXT    CHECK (acknowledged_at IS NULL OR acknowledged_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, inbox_event_id),
  UNIQUE (provider, external_event_id),
  CHECK (attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts),
  CHECK ((state = 'pending' AND attempt_count = 0 AND claim_id IS NULL AND acknowledged_at IS NULL)
      OR (state = 'processing' AND attempt_count > 0 AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at > claimed_at AND acknowledged_at IS NULL)
      OR (state = 'retry_wait' AND attempt_count > 0 AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL)
      OR (state = 'acknowledged' AND attempt_count > 0 AND claim_id IS NULL AND last_error_code IS NULL AND acknowledged_at IS NOT NULL)
      OR (state = 'reconciliation_required' AND attempt_count = max_attempts AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX webhook_inbox_claim ON webhook_inbox (available_at, received_at, inbox_event_id)
  WHERE state IN ('pending','retry_wait','processing') AND acknowledged_at IS NULL;
CREATE INDEX webhook_inbox_purge ON webhook_inbox (acknowledged_at) WHERE acknowledged_at IS NOT NULL;

CREATE TABLE deployments (
  organization_id                TEXT    NOT NULL,
  deployment_id                  TEXT    NOT NULL
    CHECK (length(deployment_id) = 26 AND deployment_id GLOB '[0-7]*' AND deployment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id                     TEXT    NOT NULL,
  environment_id                 TEXT    NOT NULL,
  operation_id                   TEXT    NOT NULL,
  kind                           TEXT    NOT NULL CHECK (kind IN ('deploy','promotion','rollback')),
  status                         TEXT    NOT NULL CHECK (status IN ('queued','running','succeeded','failed','reconciliation_required')),
  active_revision_id             TEXT    CHECK (active_revision_id IS NULL OR length(active_revision_id) = 26),
  active_version                 INTEGER NOT NULL CHECK (active_version >= 0),
  rollback_target_deployment_id  TEXT,
  rollback_target_revision_id    TEXT,
  promotion_source_environment_id TEXT,
  promotion_source_deployment_id TEXT,
  promotion_source_revision_id   TEXT,
  created_at                     TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at                     TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, deployment_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX deployments_by_environment ON deployments (organization_id, project_id, environment_id, created_at DESC, deployment_id DESC);

CREATE TABLE deployment_revisions (
  organization_id     TEXT NOT NULL,
  revision_id         TEXT NOT NULL CHECK (length(revision_id) = 26),
  project_id          TEXT NOT NULL,
  deployment_id       TEXT NOT NULL,
  plan_id             TEXT NOT NULL,
  build_execution_id  TEXT NOT NULL,
  artifact_id         TEXT NOT NULL,
  wfp_receipt_id      TEXT NOT NULL,
  operation_id        TEXT NOT NULL,
  created_at          TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, revision_id),
  FOREIGN KEY (organization_id, deployment_id) REFERENCES deployments (organization_id, deployment_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX deployment_revisions_by_deployment ON deployment_revisions (organization_id, deployment_id, revision_id);

-- Sealed environment secrets: the envelope (ciphertext, nonce, key_version) and the AAD identity (org, project, environment, name) are never rewritten except by a revision bump.
CREATE TABLE environment_secrets (
  organization_id  TEXT    NOT NULL,
  project_id       TEXT    NOT NULL,
  environment_id   TEXT    NOT NULL,
  name             TEXT    NOT NULL CHECK (name GLOB '[A-Z]*' AND length(name) BETWEEN 1 AND 128 AND name NOT GLOB '*[^A-Z0-9_]*'),
  ciphertext       BLOB    NOT NULL CHECK (length(ciphertext) BETWEEN 17 AND 65552),
  nonce            BLOB    NOT NULL CHECK (length(nonce) = 12),
  value_sha256     BLOB    NOT NULL CHECK (length(value_sha256) = 32),
  key_version      INTEGER NOT NULL CHECK (key_version >= 1),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  created_at       TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at       TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, environment_id, name),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER environment_secrets_identity_immutable BEFORE UPDATE OF organization_id, project_id, environment_id, name ON environment_secrets
BEGIN SELECT RAISE(ABORT, 'secret identity is immutable'); END;
CREATE TRIGGER environment_secrets_envelope_by_revision BEFORE UPDATE ON environment_secrets
  WHEN (NEW.ciphertext IS NOT OLD.ciphertext OR NEW.nonce IS NOT OLD.nonce OR NEW.value_sha256 IS NOT OLD.value_sha256 OR NEW.key_version IS NOT OLD.key_version)
   AND NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'secret envelope changes only with a revision bump'); END;

CREATE TABLE runtime_secret_delivery_states (
  organization_id             TEXT    NOT NULL,
  project_id                  TEXT    NOT NULL,
  environment_id              TEXT    NOT NULL,
  desired_generation          INTEGER NOT NULL CHECK (desired_generation >= 0),
  applied_generation          INTEGER NOT NULL CHECK (applied_generation >= 0),
  active_lease_id             TEXT,
  claimed_generation          INTEGER,
  claimed_trigger             TEXT,
  claimed_at                  TEXT CHECK (claimed_at IS NULL OR claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at            TEXT CHECK (lease_expires_at IS NULL OR lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  provider_tag                TEXT,
  applied_secret_names        TEXT NOT NULL CHECK (json_valid(applied_secret_names) AND json_type(applied_secret_names) = 'array'),
  applied_manifest_sha256     BLOB CHECK (applied_manifest_sha256 IS NULL OR length(applied_manifest_sha256) = 32),
  applied_secret_count        INTEGER NOT NULL CHECK (applied_secret_count >= 0),
  last_failure_code           TEXT,
  last_failed_at              TEXT CHECK (last_failed_at IS NULL OR last_failed_at GLOB '????-??-??T??:??:??.??????Z'),
  next_release_sequence       INTEGER NOT NULL,
  claimed_release_sequence    INTEGER,
  applied_release_sequence    INTEGER NOT NULL,
  created_at                  TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at                  TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, environment_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX runtime_secret_delivery_pending ON runtime_secret_delivery_states (updated_at, organization_id, project_id, environment_id)
  WHERE desired_generation > applied_generation OR last_failure_code IS NOT NULL OR active_lease_id IS NOT NULL;

-- one active provider mutation per project (transient lock; 0 rows at rest)
CREATE TABLE product_provider_mutation_claims (
  organization_id            TEXT    NOT NULL,
  project_id                 TEXT    NOT NULL,
  claim_id                   TEXT    NOT NULL UNIQUE CHECK (length(claim_id) = 26),
  environment_id             TEXT    NOT NULL,
  operation_id               TEXT    NOT NULL,
  billing_epoch_id           TEXT    NOT NULL,
  event_id                   TEXT    NOT NULL,
  logical_workflow_id        TEXT    NOT NULL,
  event_type                 TEXT    NOT NULL,
  accepted_lifecycle_version INTEGER NOT NULL,
  claimed_at                 TEXT    NOT NULL CHECK (claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE environment_function_schedules (
  organization_id          TEXT NOT NULL,
  environment_id           TEXT NOT NULL,
  project_id               TEXT NOT NULL,
  deployment_id            TEXT NOT NULL,
  candidate_receipt_id     TEXT NOT NULL,
  immutable_script_name    TEXT NOT NULL,
  crons                    TEXT NOT NULL CHECK (json_valid(crons) AND json_type(crons) = 'array'),
  egress_allowed_origins   TEXT NOT NULL CHECK (json_valid(egress_allowed_origins) AND json_type(egress_allowed_origins) = 'array'),
  next_fire_at             TEXT NOT NULL CHECK (next_fire_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at               TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, environment_id),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX environment_function_schedules_due ON environment_function_schedules (next_fire_at, organization_id, environment_id);

CREATE TABLE function_runs (
  organization_id          TEXT    NOT NULL,
  run_id                   TEXT    NOT NULL CHECK (length(run_id) = 26),
  project_id               TEXT    NOT NULL,
  environment_id           TEXT    NOT NULL,
  deployment_id            TEXT    NOT NULL,
  immutable_script_name    TEXT    NOT NULL,
  cron                     TEXT    NOT NULL,
  scheduled_at             TEXT    NOT NULL CHECK (scheduled_at GLOB '????-??-??T??:??:??.??????Z'),
  state                    TEXT    NOT NULL CHECK (state IN ('due','running','retry','succeeded','failed')),
  attempt                  INTEGER NOT NULL CHECK (attempt >= 0),
  lease_until              TEXT    CHECK (lease_until IS NULL OR lease_until GLOB '????-??-??T??:??:??.??????Z'),
  started_at               TEXT    CHECK (started_at IS NULL OR started_at GLOB '????-??-??T??:??:??.??????Z'),
  finished_at              TEXT    CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.??????Z'),
  status_code              INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  egress_allowed_origins   TEXT    NOT NULL CHECK (json_valid(egress_allowed_origins)),
  created_at               TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at               TEXT    NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, run_id),
  UNIQUE (organization_id, environment_id, cron, scheduled_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX function_runs_open ON function_runs (scheduled_at, run_id) WHERE state IN ('due','retry','running');
CREATE INDEX function_runs_newest ON function_runs (organization_id, environment_id, scheduled_at DESC, cron);

-- Retention bookkeeping. Evidence tables are append-only; deletion is allowed only below the exported horizon.
CREATE TABLE evidence_exports (
  export_id        TEXT    NOT NULL PRIMARY KEY CHECK (length(export_id) = 26),
  organization_id  TEXT    NOT NULL,
  table_name       TEXT    NOT NULL,
  period_start     TEXT    NOT NULL CHECK (period_start GLOB '????-??-??T??:??:??.??????Z'),
  period_end       TEXT    NOT NULL CHECK (period_end GLOB '????-??-??T??:??:??.??????Z'),
  row_count        INTEGER NOT NULL CHECK (row_count >= 0),
  sha256           BLOB    NOT NULL CHECK (length(sha256) = 32),
  r2_key           TEXT    NOT NULL,
  created_at       TEXT    NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE (organization_id, table_name, period_start)
) STRICT, WITHOUT ROWID;

CREATE TABLE retention_horizon (
  table_name        TEXT NOT NULL PRIMARY KEY,
  exported_through  TEXT NOT NULL CHECK (exported_through GLOB '????-??-??T??:??:??.??????Z'),
  updated_at        TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_events_delete_below_horizon BEFORE DELETE ON audit_events
  WHEN OLD.occurred_at > COALESCE((SELECT exported_through FROM retention_horizon WHERE table_name = 'audit_events'), '')
BEGIN SELECT RAISE(ABORT, 'audit_events rows are deletable only after export'); END;
CREATE TRIGGER operation_events_no_update BEFORE UPDATE ON operation_events BEGIN SELECT RAISE(ABORT, 'operation_events is append-only'); END;
CREATE TRIGGER operation_events_delete_below_horizon BEFORE DELETE ON operation_events
  WHEN OLD.occurred_at > COALESCE((SELECT exported_through FROM retention_horizon WHERE table_name = 'operation_events'), '')
BEGIN SELECT RAISE(ABORT, 'operation_events rows are deletable only after export'); END;
