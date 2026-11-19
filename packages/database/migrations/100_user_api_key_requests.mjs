export function up(pgm) {
  pgm.sql(`CREATE TABLE user_api_key_requests (
    request_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL,
    workos_user_id text NOT NULL CHECK (workos_user_id ~ '^user_[A-Za-z0-9_]{1,123}$'),
    workos_organization_id text NOT NULL CHECK (workos_organization_id ~ '^org_[A-Za-z0-9_]{1,124}$'),
    idempotency_sha256 bytea NOT NULL CHECK (octet_length(idempotency_sha256)=32),
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    permissions text[] NOT NULL CHECK (cardinality(permissions) BETWEEN 1 AND 100),
    requested_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at=requested_at+interval '2160 hours'),
    provider_key_id text UNIQUE CHECK (provider_key_id ~ '^api_key_[A-Za-z0-9_]{1,120}$'),
    failure_code text CHECK (failure_code IN ('KEY_PERMISSIONS_UNAVAILABLE')),
    finished_at timestamptz,
    UNIQUE (organization_id,workos_user_id,idempotency_sha256),
    CHECK ((finished_at IS NULL AND provider_key_id IS NULL AND failure_code IS NULL)
      OR (finished_at IS NOT NULL AND finished_at>=requested_at
        AND ((provider_key_id IS NOT NULL AND failure_code IS NULL)
          OR (provider_key_id IS NULL AND failure_code IS NOT NULL))))
  )`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM user_api_key_requests) THEN
      RAISE EXCEPTION 'Retain API-key issuance history before removing this delivery';
    END IF;
  END $$`);
  pgm.dropTable("user_api_key_requests");
}
