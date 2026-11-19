-- CORE-46: a user API key creation that failed before its provider request was sent is finished as rejected with
-- KEY_CREATION_NOT_SENT. Until now such a claim stayed unfinished, so every retry under the same Idempotency-Key observed it
-- as uncertain forever. SQLite cannot alter a CHECK in place: the table is rebuilt with every row, its primary and unique keys,
-- its foreign key and its purge index unchanged. Only the admitted failure codes grow.
CREATE TABLE user_api_key_requests_0921 (
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
  failure_code            TEXT CHECK (failure_code IS NULL OR failure_code IN ('KEY_PERMISSIONS_UNAVAILABLE', 'KEY_CREATION_NOT_SENT')),
  finished_at             TEXT CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (organization_id, request_id),
  UNIQUE (organization_id, workos_user_id, idempotency_sha256),
  CHECK ((finished_at IS NULL AND provider_key_id IS NULL AND failure_code IS NULL)
      OR (finished_at IS NOT NULL AND finished_at >= requested_at
          AND ((provider_key_id IS NOT NULL AND failure_code IS NULL) OR (provider_key_id IS NULL AND failure_code IS NOT NULL))))
) STRICT, WITHOUT ROWID;
INSERT INTO user_api_key_requests_0921 (organization_id, request_id, workos_user_id, workos_organization_id, idempotency_sha256, request_sha256, name, permissions, requested_at, expires_at, provider_key_id, failure_code, finished_at)
  SELECT organization_id, request_id, workos_user_id, workos_organization_id, idempotency_sha256, request_sha256, name, permissions, requested_at, expires_at, provider_key_id, failure_code, finished_at
    FROM user_api_key_requests;
DROP TABLE user_api_key_requests;
ALTER TABLE user_api_key_requests_0921 RENAME TO user_api_key_requests;
CREATE INDEX user_api_key_requests_purge ON user_api_key_requests (finished_at) WHERE finished_at IS NOT NULL;
