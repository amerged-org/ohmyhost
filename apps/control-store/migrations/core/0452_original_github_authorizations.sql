-- Original080/107/130/131/135 GitHub consent evidence required by the full context reader.
-- organizations is the already-qualified merged workos_organization_mappings parent;
-- projects is the already-qualified historical ownership parent. No synthetic aliases or current-owner bypass.
CREATE TABLE github_organization_connections (
 connection_id TEXT NOT NULL PRIMARY KEY CHECK(length(connection_id)=26 AND substr(connection_id,1,1) BETWEEN '0' AND '7' AND connection_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
 installation_id TEXT NOT NULL CHECK(length(installation_id)>0 AND substr(installation_id,1,1) BETWEEN '1' AND '9' AND installation_id NOT GLOB '*[^0-9]*'),
 account_id TEXT NOT NULL CHECK(length(account_id)>0 AND substr(account_id,1,1) BETWEEN '1' AND '9' AND account_id NOT GLOB '*[^0-9]*'),
 account_login TEXT NOT NULL,account_type TEXT NOT NULL CHECK(account_type IN('User','Organization')),
 github_user_id TEXT NOT NULL CHECK(length(github_user_id)>0 AND substr(github_user_id,1,1) BETWEEN '1' AND '9' AND github_user_id NOT GLOB '*[^0-9]*'),
 github_user_login TEXT NOT NULL,principal_id TEXT NOT NULL,settings_url TEXT NOT NULL,
 connected_at TEXT NOT NULL CHECK(connected_at GLOB '????-??-??T??:??:??.??????Z'),
 revoked_at TEXT CHECK(revoked_at IS NULL OR (revoked_at GLOB '????-??-??T??:??:??.??????Z' AND revoked_at>=connected_at)),
 UNIQUE(organization_id,connection_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX github_organization_one_active ON github_organization_connections(organization_id) WHERE revoked_at IS NULL;
CREATE TABLE github_repository_link_consents (
 operation_id TEXT NOT NULL PRIMARY KEY REFERENCES operations(operation_id),
 organization_id TEXT NOT NULL,project_id TEXT NOT NULL,
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 billing_epoch_id TEXT NOT NULL REFERENCES billing_epochs(billing_epoch_id),connection_id TEXT NOT NULL,principal_id TEXT NOT NULL,
 installation_id TEXT NOT NULL CHECK(length(installation_id)>0 AND substr(installation_id,1,1) BETWEEN '1' AND '9' AND installation_id NOT GLOB '*[^0-9]*'),
 repository_id TEXT NOT NULL CHECK(length(repository_id)>0 AND substr(repository_id,1,1) BETWEEN '1' AND '9' AND repository_id NOT GLOB '*[^0-9]*'),
 repository_owner TEXT NOT NULL,repository_name TEXT NOT NULL,idempotency_key TEXT NOT NULL,
 request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),
 authorized_at TEXT NOT NULL CHECK(authorized_at GLOB '????-??-??T??:??:??.??????Z'),
 UNIQUE(organization_id,project_id,principal_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id,operation_id,billing_epoch_id) REFERENCES operations(organization_id,project_id,operation_id,billing_epoch_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES github_organization_connections(organization_id,connection_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER github_repository_link_consents_no_update BEFORE UPDATE ON github_repository_link_consents
BEGIN SELECT RAISE(ABORT,'GitHub repository consent evidence is append-only'); END;
CREATE TRIGGER github_repository_link_consents_no_delete BEFORE DELETE ON github_repository_link_consents
BEGIN SELECT RAISE(ABORT,'GitHub repository consent evidence is append-only'); END;
CREATE TABLE github_source_authorizations (
 authorization_id TEXT NOT NULL PRIMARY KEY CHECK(length(authorization_id)=26 AND substr(authorization_id,1,1) BETWEEN '0' AND '7' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL,project_id TEXT NOT NULL,
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 billing_epoch_id TEXT NOT NULL REFERENCES billing_epochs(billing_epoch_id),principal_id TEXT NOT NULL,session_id TEXT,
 workos_organization_id TEXT NOT NULL,
 token_expires_at INTEGER,
 repository_owner TEXT NOT NULL,repository_name TEXT NOT NULL,idempotency_key TEXT NOT NULL,
 request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),state_sha256 BLOB NOT NULL UNIQUE CHECK(length(state_sha256)=32),
 ciphertext BLOB NOT NULL,nonce BLOB NOT NULL CHECK(length(nonce)=12),value_sha256 BLOB NOT NULL CHECK(length(value_sha256)=32),
 key_version INTEGER NOT NULL CHECK(key_version BETWEEN 1 AND 2147483647),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','authorizing','authorized','failed')),
 operation_id TEXT UNIQUE CHECK(operation_id IS NULL OR(length(operation_id)=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 github_user_id TEXT,installation_id TEXT,repository_id TEXT,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
 expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.??????Z' AND expires_at>created_at),
 user_api_key_id TEXT,
 last_failure TEXT CHECK(last_failure IS NULL OR last_failure IN('repository_not_installed','repository_access_required','authorization_code_rejected','provider_unavailable','expired','session_inactive','denied','code_spent')),
 UNIQUE(organization_id,project_id,principal_id,idempotency_key),
 FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id),
 CHECK((session_id IS NOT NULL AND substr(session_id,1,8)='session_' AND length(session_id)>8 AND substr(session_id,9) NOT GLOB '*[^A-Za-z0-9_]*' AND user_api_key_id IS NULL AND token_expires_at IS NOT NULL)
 OR(session_id IS NULL AND user_api_key_id IS NOT NULL AND substr(user_api_key_id,1,8)='api_key_' AND length(user_api_key_id) BETWEEN 9 AND 128 AND substr(user_api_key_id,9) NOT GLOB '*[^A-Za-z0-9_]*')),
 CHECK((state='authorized' AND operation_id IS NOT NULL AND github_user_id IS NOT NULL AND installation_id IS NOT NULL AND repository_id IS NOT NULL)
 OR(state<>'authorized' AND operation_id IS NULL AND github_user_id IS NULL AND installation_id IS NULL AND repository_id IS NULL))
) STRICT, WITHOUT ROWID;

-- Original011/058 raw source object custody, distinct from upload/build evidence. Historical
-- environment identities survive ownership transfer; operation custody retains its original owner.
CREATE TABLE product_source_archive_objects (
 operation_id TEXT NOT NULL PRIMARY KEY,
 organization_id TEXT NOT NULL,project_id TEXT NOT NULL,environment_id TEXT NOT NULL,
 bucket_name TEXT NOT NULL CHECK(length(bucket_name) BETWEEN 3 AND 63),
 object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 512),
 object_version_id TEXT NOT NULL CHECK(length(object_version_id) BETWEEN 1 AND 512),
 object_etag TEXT NOT NULL CHECK(length(object_etag) BETWEEN 1 AND 512),
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 9007199254740991),
 source_sha256 BLOB NOT NULL CHECK(length(source_sha256)=32),
 recorded_at TEXT NOT NULL CHECK(recorded_at GLOB '????-??-??T??:??:??.??????Z'),
 FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER product_source_archive_objects_no_update BEFORE UPDATE ON product_source_archive_objects
BEGIN SELECT RAISE(ABORT,'Source archive object evidence is append-only'); END;
CREATE TRIGGER product_source_archive_objects_no_delete BEFORE DELETE ON product_source_archive_objects
BEGIN SELECT RAISE(ABORT,'Source archive object evidence is append-only'); END;
