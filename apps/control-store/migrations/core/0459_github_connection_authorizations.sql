-- Original135/136 organization GitHub connection authorizations: the OAuth state and sealed PKCE verifier of one
-- connection attempt. The same strict state machine and static parents as github_source_authorizations (0452).
-- UNSERVED additive only: no row is fabricated; the import converts the captured rows (state expires within the hour).
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE github_connection_authorizations (
 authorization_id TEXT NOT NULL PRIMARY KEY CHECK(length(authorization_id)=26 AND length(CAST(authorization_id AS BLOB))=26 AND substr(authorization_id,1,1) BETWEEN '0' AND '7' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
 principal_id TEXT NOT NULL,
 session_id TEXT,
 user_api_key_id TEXT,
 workos_organization_id TEXT NOT NULL,
 token_expires_at INTEGER,
 idempotency_key TEXT NOT NULL,
 state_sha256 BLOB NOT NULL UNIQUE CHECK(length(state_sha256)=32),
 ciphertext BLOB NOT NULL,
 nonce BLOB NOT NULL CHECK(length(nonce)=12),
 value_sha256 BLOB NOT NULL CHECK(length(value_sha256)=32),
 key_version INTEGER NOT NULL CHECK(key_version BETWEEN 1 AND 2147483647),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','authorizing','connected','failed')),
 flow TEXT NOT NULL DEFAULT 'installation' CHECK(flow IN('installation','oauth')),
 installation_id TEXT CHECK(installation_id IS NULL OR(length(installation_id)>0 AND substr(installation_id,1,1) BETWEEN '1' AND '9' AND installation_id NOT GLOB '*[^0-9]*')),
 connection_id TEXT,
 last_failure TEXT CHECK(last_failure IS NULL OR last_failure IN('installation_access_required','account_admin_required','authorization_code_rejected','provider_unavailable','expired','session_inactive','denied','code_spent')),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
 expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.??????Z' AND expires_at>created_at),
 UNIQUE(organization_id,principal_id,idempotency_key),
 FOREIGN KEY(organization_id,connection_id) REFERENCES github_organization_connections(organization_id,connection_id),
 CHECK((session_id IS NOT NULL AND user_api_key_id IS NULL AND token_expires_at IS NOT NULL) OR(session_id IS NULL AND user_api_key_id IS NOT NULL)),
 CHECK((state='connected')=(connection_id IS NOT NULL))
) STRICT, WITHOUT ROWID;
