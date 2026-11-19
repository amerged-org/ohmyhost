-- core-v1 source: migrations/shard/0010_identity_access.sql
-- Identity and access tables of the tenant shard that the first migrations did not carry, plus the guards of the
-- tables they protect. The core guard_fail catalog is in 0001_core_layout.sql.

-- Fail-closed ordering barrier between a WorkOS membership webhook and the snapshot that reconciles it.
CREATE TABLE workos_membership_sync_barriers (
  organization_id   TEXT NOT NULL REFERENCES organizations (organization_id),
  workos_user_id    TEXT NOT NULL CHECK (workos_user_id = trim(workos_user_id) AND length(workos_user_id) BETWEEN 1 AND 255),
  source_event_id   TEXT NOT NULL CHECK (source_event_id = trim(source_event_id) AND length(source_event_id) BETWEEN 1 AND 255),
  event_created_at  TEXT NOT NULL CHECK (event_created_at GLOB '????-??-??T??:??:??.??????Z'),
  reconciled_at     TEXT CHECK (reconciled_at IS NULL OR reconciled_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, workos_user_id),
  CHECK (reconciled_at IS NULL OR reconciled_at >= event_created_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX workos_membership_sync_barriers_purge ON workos_membership_sync_barriers (reconciled_at) WHERE reconciled_at IS NOT NULL;

-- Idempotent creation record of a WorkOS-held user API key (recovers an uncertain creation).
CREATE TABLE user_api_key_requests (
  organization_id         TEXT NOT NULL REFERENCES organizations (organization_id),
  request_id              TEXT NOT NULL CHECK (length(request_id) = 26),
  workos_user_id          TEXT NOT NULL CHECK (workos_user_id GLOB 'user_*' AND length(workos_user_id) BETWEEN 6 AND 128),
  workos_organization_id  TEXT NOT NULL CHECK (workos_organization_id GLOB 'org_*' AND length(workos_organization_id) BETWEEN 5 AND 128),
  idempotency_sha256      BLOB NOT NULL CHECK (length(idempotency_sha256) = 32),
  request_sha256          BLOB NOT NULL CHECK (length(request_sha256) = 32),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  permissions             TEXT NOT NULL CHECK (json_valid(permissions) AND json_type(permissions) = 'array' AND json_array_length(permissions) BETWEEN 1 AND 100),
  requested_at            TEXT NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at              TEXT CHECK (expires_at IS NULL OR expires_at GLOB '????-??-??T??:??:??.??????Z'),
  provider_key_id         TEXT UNIQUE CHECK (provider_key_id IS NULL OR (provider_key_id GLOB 'api_key_*' AND length(provider_key_id) BETWEEN 9 AND 128)),
  failure_code            TEXT CHECK (failure_code IS NULL OR failure_code IN ('KEY_PERMISSIONS_UNAVAILABLE')),
  finished_at             TEXT CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, request_id),
  UNIQUE (organization_id, workos_user_id, idempotency_sha256),
  CHECK ((finished_at IS NULL AND provider_key_id IS NULL AND failure_code IS NULL)
      OR (finished_at IS NOT NULL AND finished_at >= requested_at
          AND ((provider_key_id IS NOT NULL AND failure_code IS NULL) OR (provider_key_id IS NULL AND failure_code IS NOT NULL))))
) STRICT, WITHOUT ROWID;
CREATE INDEX user_api_key_requests_purge ON user_api_key_requests (finished_at) WHERE finished_at IS NOT NULL;

-- Machine-to-machine client bound to an organization, with allowlisted scopes; written only by the owner.
CREATE TABLE m2m_organization_bindings (
  organization_id    TEXT NOT NULL REFERENCES organizations (organization_id),
  connect_client_id  TEXT NOT NULL CHECK (length(connect_client_id) BETWEEN 1 AND 255),
  scopes             TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array' AND json_array_length(scopes) > 0),
  state              TEXT NOT NULL CHECK (state IN ('active','revoked')),
  mapping_revision   INTEGER NOT NULL CHECK (mapping_revision > 0),
  created_at         TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at         TEXT CHECK (expires_at IS NULL OR (expires_at GLOB '????-??-??T??:??:??.??????Z' AND expires_at > created_at)),
  revoked_at         TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, connect_client_id),
  CHECK ((state = 'active' AND revoked_at IS NULL) OR (state = 'revoked' AND revoked_at IS NOT NULL))
) STRICT, WITHOUT ROWID;

-- Remote-agent consent: one-use portal handoffs, the grants they produce and the tombstones that block a later grant.
CREATE TABLE mcp_portal_handoffs (
  organization_id          TEXT NOT NULL REFERENCES organizations (organization_id),
  request_hash             TEXT NOT NULL UNIQUE CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  user_id                  TEXT NOT NULL CHECK (user_id GLOB 'user_*' AND user_id NOT GLOB '*[^A-Za-z0-9_]*'),
  client_id                TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 2048),
  consent_hash             TEXT NOT NULL CHECK (length(consent_hash) = 64 AND consent_hash NOT GLOB '*[^0-9a-f]*'),
  kind                     TEXT NOT NULL CHECK (kind IN ('grant','secret','github')),
  project_ids              TEXT NOT NULL CHECK (json_valid(project_ids) AND json_type(project_ids) = 'array' AND json_array_length(project_ids) <= 100),
  allow_create             INTEGER NOT NULL CHECK (allow_create IN (0,1)),
  allow_publish            INTEGER NOT NULL CHECK (allow_publish IN (0,1)),
  secret_target            TEXT CHECK (secret_target IS NULL OR (json_valid(secret_target) AND json_type(secret_target) = 'object')),
  github_target            TEXT CHECK (github_target IS NULL OR (json_valid(github_target) AND json_type(github_target) = 'object')),
  mail_domain_scopes       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mail_domain_scopes) AND json_type(mail_domain_scopes) = 'array' AND json_array_length(mail_domain_scopes) <= 100),
  allow_mail_domain_create INTEGER NOT NULL DEFAULT 0 CHECK (allow_mail_domain_create IN (0,1)),
  created_at               TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at               TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z' AND expires_at > created_at),
  consumed_at              TEXT CHECK (consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.??????Z'),
  outcome                  TEXT CHECK (outcome IS NULL OR outcome IN ('approved','declined','secret_submitted','secret_failed','github_started','github_failed')),
  PRIMARY KEY (organization_id, request_hash),
  CHECK ((consumed_at IS NULL) = (outcome IS NULL)),
  CHECK ((kind = 'grant' AND secret_target IS NULL AND github_target IS NULL)
      OR (kind = 'secret' AND json_array_length(project_ids) = 1 AND allow_create = 0 AND allow_publish = 0
          AND secret_target IS NOT NULL AND github_target IS NULL)
      OR (kind = 'github' AND json_array_length(project_ids) = 0 AND allow_create = 0 AND allow_publish = 0
          AND secret_target IS NULL AND github_target IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX mcp_portal_handoffs_expiry ON mcp_portal_handoffs (expires_at);

CREATE TABLE mcp_client_grants (
  organization_id    TEXT NOT NULL REFERENCES organizations (organization_id),
  grant_id           TEXT NOT NULL CHECK (length(grant_id) = 36),
  user_id            TEXT NOT NULL CHECK (user_id GLOB 'user_*'),
  client_id          TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 2048),
  consent_hash       TEXT NOT NULL CHECK (length(consent_hash) = 64 AND consent_hash NOT GLOB '*[^0-9a-f]*'),
  project_id         TEXT CHECK (project_id IS NULL OR length(project_id) = 26),
  ownership_version  INTEGER,
  billing_epoch_id   TEXT CHECK (billing_epoch_id IS NULL OR length(billing_epoch_id) = 26),
  allow_publish      INTEGER NOT NULL CHECK (allow_publish IN (0,1)),
  revision           INTEGER NOT NULL CHECK (revision > 0),
  created_at         TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at         TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, grant_id),
  CHECK ((project_id IS NULL AND ownership_version IS NULL AND billing_epoch_id IS NULL)
      OR (project_id IS NOT NULL AND ownership_version > 0 AND billing_epoch_id IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX mcp_client_grants_consent_scope
  ON mcp_client_grants (organization_id, user_id, client_id, consent_hash, COALESCE(project_id, ''));

CREATE TABLE mcp_client_revocations (
  organization_id  TEXT NOT NULL REFERENCES organizations (organization_id),
  user_id          TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  consent_hash     TEXT NOT NULL CHECK (length(consent_hash) = 64),
  revoked_at       TEXT NOT NULL CHECK (revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, user_id, client_id, consent_hash)
) STRICT, WITHOUT ROWID;

CREATE TABLE mcp_mail_domain_grants (
  organization_id  TEXT NOT NULL REFERENCES organizations (organization_id),
  grant_id         TEXT NOT NULL CHECK (length(grant_id) = 36),
  user_id          TEXT NOT NULL CHECK (user_id GLOB 'user_*'),
  client_id        TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 2048),
  consent_hash     TEXT NOT NULL CHECK (length(consent_hash) = 64 AND consent_hash NOT GLOB '*[^0-9a-f]*'),
  mail_domain_id   TEXT CHECK (mail_domain_id IS NULL OR length(mail_domain_id) = 26),
  permissions      TEXT NOT NULL CHECK (json_valid(permissions) AND json_type(permissions) = 'array' AND json_array_length(permissions) > 0),
  revision         INTEGER NOT NULL CHECK (revision > 0),
  created_at       TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at       TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, grant_id),
  CHECK (mail_domain_id IS NOT NULL OR permissions = '["admin"]')
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX mcp_mail_domain_grants_consent_scope
  ON mcp_mail_domain_grants (organization_id, user_id, client_id, consent_hash, COALESCE(mail_domain_id, ''));

-- Immutable delegated-client evidence on a queued operation.
CREATE TABLE operation_mcp_delegations (
  organization_id       TEXT NOT NULL,
  operation_id          TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  environment_id        TEXT NOT NULL,
  billing_epoch_id      TEXT NOT NULL,
  principal_id          TEXT NOT NULL,
  grant_id              TEXT NOT NULL CHECK (length(grant_id) = 36),
  client_id             TEXT NOT NULL,
  consent_hash          TEXT NOT NULL CHECK (length(consent_hash) = 64),
  requires_publication  INTEGER NOT NULL CHECK (requires_publication IN (0,1)),
  event_type            TEXT NOT NULL,
  created_at            TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, operation_id) REFERENCES operations (organization_id, operation_id),
  FOREIGN KEY (organization_id, grant_id) REFERENCES mcp_client_grants (organization_id, grant_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER operation_mcp_delegations_no_update BEFORE UPDATE ON operation_mcp_delegations
BEGIN SELECT RAISE(ABORT, 'operation_mcp_delegations is append-only'); END;
CREATE TRIGGER operation_mcp_delegations_no_delete BEFORE DELETE ON operation_mcp_delegations
BEGIN SELECT RAISE(ABORT, 'operation_mcp_delegations is append-only'); END;

-- A local authorization grant keeps its scope forever; only its revocation time may be set, once.
CREATE TRIGGER local_authorization_grants_revoke_only BEFORE UPDATE ON local_authorization_grants
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.grant_id IS NOT OLD.grant_id
    OR NEW.project_id IS NOT OLD.project_id OR NEW.environment_id IS NOT OLD.environment_id
    OR NEW.principal_kind IS NOT OLD.principal_kind OR NEW.principal_id IS NOT OLD.principal_id
    OR NEW.role IS NOT OLD.role OR NEW.ownership_version IS NOT OLD.ownership_version
    OR NEW.billing_epoch_id IS NOT OLD.billing_epoch_id OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT, 'local authorization grant scope is immutable'); END;
