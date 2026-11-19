-- Context H: secrets, keys and credentials (tenant shard). Sealed records keep ciphertext, nonce, digest and key_version byte-identical;
-- their AAD identity columns are part of the cryptographic contract and are never updated. environment_secrets itself is in 0001.

-- Idempotency receipts of environment secret mutations. The effect and the receipt commit in one batch, so a receipt always carries its response. Purged 7 days after completion.
CREATE TABLE environment_secret_requests (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK (length(environment_id) = 26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  action           TEXT NOT NULL CHECK (action IN ('set', 'delete')),
  name             TEXT NOT NULL CHECK (name GLOB '[A-Z]*' AND length(name) BETWEEN 1 AND 128 AND name NOT GLOB '*[^A-Z0-9_]*'),
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  response TEXT NOT NULL CHECK (json_valid(response)),
  requested_at TEXT NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??.??????Z'),
  completed_at TEXT NOT NULL CHECK (completed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, environment_id, action, idempotency_key),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX environment_secret_requests_purge ON environment_secret_requests (completed_at);

-- One sealed Dev share link per project; the generation grows with every replacement and is the Dev access epoch of share sessions.
CREATE TABLE dev_share_links (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK (length(environment_id) = 26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  token_sha256 BLOB NOT NULL CHECK (length(token_sha256) = 32),
  ciphertext       BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 17 AND 5120),
  nonce            BLOB NOT NULL CHECK (length(nonce) = 12),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  UNIQUE (organization_id, token_sha256),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id)
) STRICT, WITHOUT ROWID;

-- Rotation receipts: purged 24 hours after creation.
CREATE TABLE dev_share_link_rotations (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  key_sha256 BLOB NOT NULL CHECK (length(key_sha256) = 32),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, key_sha256),
  FOREIGN KEY (organization_id, project_id) REFERENCES dev_share_links (organization_id, project_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX dev_share_link_rotations_purge ON dev_share_link_rotations (created_at);

-- One-time Dev access tickets (redeemed on the Dev origin). Purged one day after expiry.
CREATE TABLE dev_access_tickets (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  ticket_id TEXT NOT NULL CHECK (length(ticket_id) = 26 AND ticket_id GLOB '[0-7]*' AND ticket_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_id TEXT NOT NULL CHECK (length(environment_id) = 26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  environment_name        TEXT NOT NULL CHECK (environment_name = 'dev'),
  handle                  TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 59 AND handle NOT GLOB '*[^a-z0-9-]*' AND handle NOT GLOB '-*' AND handle NOT GLOB '*-'),
  public_origin           TEXT NOT NULL CHECK (public_origin GLOB 'https://*'),
  dev_access_epoch INTEGER NOT NULL CHECK (dev_access_epoch >= 1),
  issued_to_principal_id  TEXT NOT NULL CHECK (length(issued_to_principal_id) BETWEEN 1 AND 256),
  token_sha256 BLOB NOT NULL CHECK (length(token_sha256) = 32),
  issued_at TEXT NOT NULL CHECK (issued_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z'),
  consumed_at TEXT CHECK (consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, ticket_id),
  UNIQUE (organization_id, token_sha256),
  FOREIGN KEY (organization_id, environment_id) REFERENCES environments (organization_id, environment_id),
  CHECK (expires_at > issued_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX dev_access_tickets_open ON dev_access_tickets (organization_id, project_id, issued_to_principal_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX dev_access_tickets_purge ON dev_access_tickets (expires_at);

-- Idempotency receipts of Dev access changes; the response is sealed by the caller. Purged 24 hours after recording.
CREATE TABLE project_dev_access_requests (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  actor_id                TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
  key_sha256 BLOB NOT NULL CHECK (length(key_sha256) = 32),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  response_ciphertext     BLOB NOT NULL CHECK (length(response_ciphertext) BETWEEN 17 AND 5136),
  response_nonce          BLOB NOT NULL CHECK (length(response_nonce) = 12),
  response_value_sha256 BLOB NOT NULL CHECK (length(response_value_sha256) = 32),
  response_key_version INTEGER NOT NULL CHECK (response_key_version >= 1),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id, actor_id, key_sha256)
) STRICT, WITHOUT ROWID;
CREATE INDEX project_dev_access_requests_purge ON project_dev_access_requests (recorded_at);

-- One-time Cloudflare OAuth consent state of a project. declaration_snapshot is the set of declared hostnames the consent covers.
CREATE TABLE cloudflare_project_authorization_states (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  authorization_id TEXT NOT NULL CHECK (length(authorization_id) = 26 AND authorization_id GLOB '[0-7]*' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  principal_id            TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  zone_name               TEXT NOT NULL CHECK (length(zone_name) BETWEEN 3 AND 253 AND zone_name = lower(zone_name)),
  state_sha256 BLOB NOT NULL CHECK (length(state_sha256) = 32),
  idempotency_key_sha256 BLOB NOT NULL CHECK (length(idempotency_key_sha256) = 32),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  issued_at TEXT NOT NULL CHECK (issued_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z'),
  consumed_at TEXT CHECK (consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.??????Z'),
  declaration_snapshot    TEXT NOT NULL CHECK (json_valid(declaration_snapshot) AND json_type(declaration_snapshot) = 'array'),
  PRIMARY KEY (organization_id, authorization_id),
  UNIQUE (state_sha256),
  UNIQUE (organization_id, project_id, principal_id, idempotency_key_sha256),
  UNIQUE (organization_id, project_id, authorization_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id),
  CHECK (expires_at > issued_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX cloudflare_project_authorization_states_latest ON cloudflare_project_authorization_states (organization_id, project_id, issued_at DESC);
CREATE INDEX cloudflare_project_authorization_states_purge ON cloudflare_project_authorization_states (expires_at);
CREATE TRIGGER cloudflare_project_authorization_states_one_time BEFORE UPDATE ON cloudflare_project_authorization_states
  WHEN OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
    OR NEW.organization_id IS NOT OLD.organization_id OR NEW.authorization_id IS NOT OLD.authorization_id
    OR NEW.project_id IS NOT OLD.project_id OR NEW.principal_id IS NOT OLD.principal_id
    OR NEW.zone_name IS NOT OLD.zone_name OR NEW.state_sha256 IS NOT OLD.state_sha256
    OR NEW.idempotency_key_sha256 IS NOT OLD.idempotency_key_sha256 OR NEW.request_sha256 IS NOT OLD.request_sha256
    OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.declaration_snapshot IS NOT OLD.declaration_snapshot
BEGIN SELECT RAISE(ABORT, 'E55000 a Cloudflare authorization state is consumed once and otherwise immutable'); END;

-- The sealed Cloudflare OAuth tokens of a project (one grant per project). Every token refresh rewrites the envelope under a compare-and-swap on updated_at.
CREATE TABLE cloudflare_project_dns_grants (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  authorization_id TEXT NOT NULL CHECK (length(authorization_id) = 26 AND authorization_id GLOB '[0-7]*' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  principal_id        TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  zone_id             TEXT NOT NULL CHECK (length(zone_id) = 32 AND zone_id NOT GLOB '*[^a-f0-9]*'),
  zone_name           TEXT NOT NULL CHECK (length(zone_name) BETWEEN 3 AND 253),
  account_id          TEXT NOT NULL CHECK (length(account_id) = 32 AND account_id NOT GLOB '*[^a-f0-9]*'),
  scopes              TEXT NOT NULL CHECK (scopes = '["dns.write","zone.read"]'),
  access_ciphertext   BLOB CHECK (access_ciphertext IS NULL OR length(access_ciphertext) >= 17),
  access_nonce        BLOB CHECK (access_nonce IS NULL OR length(access_nonce) = 12),
  refresh_ciphertext  BLOB CHECK (refresh_ciphertext IS NULL OR length(refresh_ciphertext) >= 17),
  refresh_nonce       BLOB CHECK (refresh_nonce IS NULL OR length(refresh_nonce) = 12),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  access_expires_at TEXT NOT NULL CHECK (access_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  status              TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  connected_at TEXT NOT NULL CHECK (connected_at GLOB '????-??-??T??:??:??.??????Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  UNIQUE (authorization_id),
  UNIQUE (organization_id, project_id, authorization_id),
  FOREIGN KEY (organization_id, project_id, authorization_id) REFERENCES cloudflare_project_authorization_states (organization_id, project_id, authorization_id),
  CHECK ((status = 'active' AND access_ciphertext IS NOT NULL AND access_nonce IS NOT NULL AND refresh_ciphertext IS NOT NULL AND refresh_nonce IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND access_ciphertext IS NULL AND access_nonce IS NULL AND refresh_ciphertext IS NULL AND refresh_nonce IS NULL AND revoked_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cloudflare_project_dns_grants_identity_guard BEFORE UPDATE ON cloudflare_project_dns_grants
  WHEN OLD.status = 'revoked'
    OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
    OR NEW.authorization_id IS NOT OLD.authorization_id OR NEW.principal_id IS NOT OLD.principal_id
    OR NEW.zone_id IS NOT OLD.zone_id OR NEW.zone_name IS NOT OLD.zone_name OR NEW.account_id IS NOT OLD.account_id
    OR NEW.scopes IS NOT OLD.scopes OR NEW.connected_at IS NOT OLD.connected_at
BEGIN SELECT RAISE(ABORT, 'E55000 a Cloudflare DNS grant keeps its identity and a revoked grant is terminal'); END;

-- Provider revocation evidence of a project's OAuth grant at deletion: revoke_started <-> readback_started, then confirmed (terminal).
CREATE TABLE cloudflare_project_oauth_revocations (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) = 26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 26 AND operation_id GLOB '[0-7]*' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  authorization_id TEXT NOT NULL CHECK (length(authorization_id) = 26 AND authorization_id GLOB '[0-7]*' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  refresh_token_sha256 BLOB NOT NULL CHECK (length(refresh_token_sha256) = 32),
  state                 TEXT NOT NULL CHECK (state IN ('revoke_started', 'readback_started', 'confirmed')),
  provider_started_at TEXT NOT NULL CHECK (provider_started_at GLOB '????-??-??T??:??:??.??????Z'),
  readback_started_at TEXT CHECK (readback_started_at IS NULL OR readback_started_at GLOB '????-??-??T??:??:??.??????Z'),
  confirmed_at TEXT CHECK (confirmed_at IS NULL OR confirmed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, project_id),
  UNIQUE (organization_id, operation_id),
  FOREIGN KEY (organization_id, project_id, authorization_id) REFERENCES cloudflare_project_dns_grants (organization_id, project_id, authorization_id),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK ((state = 'readback_started') = (readback_started_at IS NOT NULL) OR state = 'confirmed')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cloudflare_project_oauth_revocations_transition_guard BEFORE UPDATE ON cloudflare_project_oauth_revocations
  WHEN OLD.state = 'confirmed'
    OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
    OR NEW.operation_id IS NOT OLD.operation_id OR NEW.authorization_id IS NOT OLD.authorization_id
    OR NOT ((OLD.state = 'revoke_started' AND NEW.state IN ('readback_started', 'confirmed')
             AND NEW.refresh_token_sha256 IS OLD.refresh_token_sha256 AND NEW.provider_started_at IS OLD.provider_started_at)
         OR (OLD.state = 'readback_started' AND NEW.state = 'confirmed'
             AND NEW.refresh_token_sha256 IS OLD.refresh_token_sha256 AND NEW.provider_started_at IS OLD.provider_started_at)
         OR (OLD.state = 'readback_started' AND NEW.state = 'revoke_started'))
BEGIN SELECT RAISE(ABORT, 'E55000 a Cloudflare OAuth revocation follows revoke, readback, confirmed'); END;
CREATE TRIGGER cloudflare_project_oauth_revocations_no_delete BEFORE DELETE ON cloudflare_project_oauth_revocations
BEGIN SELECT RAISE(ABORT, 'E55000 cloudflare_project_oauth_revocations is append-only'); END;

-- Scoped customer DNS consent (application identity and workspace mail records). Purged 7 days after consumed, revoked or expired.
CREATE TABLE scoped_customer_dns_authorizations (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  authorization_id TEXT NOT NULL CHECK (length(authorization_id) = 26 AND authorization_id GLOB '[0-7]*' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  purpose                 TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 64),
  resource_id             TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  resource_revision INTEGER NOT NULL CHECK (resource_revision >= 1),
  principal_id            TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  delegation TEXT CHECK (delegation IS NULL OR json_valid(delegation)),
  zone_name               TEXT NOT NULL CHECK (length(zone_name) BETWEEN 3 AND 253),
  state_sha256 BLOB NOT NULL CHECK (length(state_sha256) = 32),
  idempotency_key_sha256 BLOB NOT NULL CHECK (length(idempotency_key_sha256) = 32),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  issued_at TEXT NOT NULL CHECK (issued_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z'),
  consumed_at TEXT CHECK (consumed_at IS NULL OR consumed_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  dns_receipts TEXT NOT NULL CHECK (json_valid(dns_receipts)),
  PRIMARY KEY (organization_id, authorization_id),
  UNIQUE (organization_id, authorization_id, purpose, resource_id, resource_revision),
  UNIQUE (organization_id, purpose, resource_id, idempotency_key_sha256),
  UNIQUE (state_sha256),
  FOREIGN KEY (organization_id) REFERENCES organizations (organization_id),
  CHECK (expires_at > issued_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX scoped_customer_dns_authorizations_resource ON scoped_customer_dns_authorizations (organization_id, purpose, resource_id, issued_at DESC);
CREATE INDEX scoped_customer_dns_authorizations_purge ON scoped_customer_dns_authorizations (expires_at);
CREATE TRIGGER scoped_customer_dns_authorizations_identity BEFORE UPDATE ON scoped_customer_dns_authorizations
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.authorization_id IS NOT OLD.authorization_id
    OR NEW.purpose IS NOT OLD.purpose OR NEW.resource_id IS NOT OLD.resource_id
    OR NEW.resource_revision IS NOT OLD.resource_revision OR NEW.principal_id IS NOT OLD.principal_id
    OR NEW.zone_name IS NOT OLD.zone_name OR NEW.state_sha256 IS NOT OLD.state_sha256
    OR NEW.idempotency_key_sha256 IS NOT OLD.idempotency_key_sha256 OR NEW.request_sha256 IS NOT OLD.request_sha256
    OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'E55000 a scoped DNS authorization keeps its identity'); END;

-- The sealed scoped DNS tokens of one resource (one grant per organization, purpose and resource).
CREATE TABLE scoped_customer_dns_grants (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  purpose             TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 64),
  resource_id         TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  resource_revision INTEGER NOT NULL CHECK (resource_revision >= 1),
  authorization_id TEXT NOT NULL CHECK (length(authorization_id) = 26 AND authorization_id GLOB '[0-7]*' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  principal_id        TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  zone_name           TEXT NOT NULL CHECK (length(zone_name) BETWEEN 3 AND 253),
  zone_id             TEXT NOT NULL CHECK (length(zone_id) = 32 AND zone_id NOT GLOB '*[^a-f0-9]*'),
  account_id          TEXT NOT NULL CHECK (length(account_id) = 32 AND account_id NOT GLOB '*[^a-f0-9]*'),
  access_ciphertext   BLOB NOT NULL CHECK (length(access_ciphertext) >= 17),
  access_nonce        BLOB NOT NULL CHECK (length(access_nonce) = 12),
  refresh_ciphertext  BLOB NOT NULL CHECK (length(refresh_ciphertext) >= 17),
  refresh_nonce       BLOB NOT NULL CHECK (length(refresh_nonce) = 12),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  access_expires_at TEXT NOT NULL CHECK (access_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  connected_at TEXT NOT NULL CHECK (connected_at GLOB '????-??-??T??:??:??.??????Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  dns_receipts TEXT NOT NULL CHECK (json_valid(dns_receipts)),
  PRIMARY KEY (organization_id, purpose, resource_id),
  FOREIGN KEY (organization_id, authorization_id, purpose, resource_id, resource_revision)
    REFERENCES scoped_customer_dns_authorizations (organization_id, authorization_id, purpose, resource_id, resource_revision)
) STRICT, WITHOUT ROWID;

-- Revocation receipts of scoped DNS grants (idempotent revoke with its stored response). Purged 7 days after revocation.
CREATE TABLE scoped_customer_dns_revocations (
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  purpose                 TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 64),
  resource_id             TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  resource_revision INTEGER NOT NULL CHECK (resource_revision >= 1),
  principal_id            TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  idempotency_key_sha256 BLOB NOT NULL CHECK (length(idempotency_key_sha256) = 32),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  revoked_at TEXT NOT NULL CHECK (revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  response TEXT NOT NULL CHECK (json_valid(response)),
  PRIMARY KEY (organization_id, purpose, resource_id, idempotency_key_sha256),
  FOREIGN KEY (organization_id) REFERENCES organizations (organization_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX scoped_customer_dns_revocations_purge ON scoped_customer_dns_revocations (revoked_at);
