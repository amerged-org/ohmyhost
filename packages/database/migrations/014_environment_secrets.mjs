export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE environment_secrets (
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      environment_id ulid NOT NULL,
      name text NOT NULL,
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL,
      value_sha256 bytea NOT NULL,
      key_version integer NOT NULL,
      revision bigint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      CONSTRAINT environment_secrets_pkey PRIMARY KEY (
        organization_id,
        project_id,
        environment_id,
        name
      ),
      CONSTRAINT environment_secrets_environment_fkey
        FOREIGN KEY (organization_id, project_id, environment_id)
        REFERENCES environments(organization_id, project_id, environment_id)
        ON DELETE CASCADE,
      CONSTRAINT environment_secrets_name_check
        CHECK (name ~ '^[A-Z][A-Z0-9_]{0,127}$'),
      CONSTRAINT environment_secrets_ciphertext_check
        CHECK (octet_length(ciphertext) BETWEEN 17 AND 65552),
      CONSTRAINT environment_secrets_nonce_check
        CHECK (octet_length(nonce) = 12),
      CONSTRAINT environment_secrets_digest_check
        CHECK (octet_length(value_sha256) = 32),
      CONSTRAINT environment_secrets_key_version_check CHECK (key_version > 0),
      CONSTRAINT environment_secrets_revision_check CHECK (revision > 0),
      CONSTRAINT environment_secrets_time_check CHECK (updated_at >= created_at)
    );

    CREATE TABLE environment_secret_requests (
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      environment_id ulid NOT NULL,
      action text NOT NULL,
      name text NOT NULL,
      idempotency_key text NOT NULL,
      request_sha256 bytea NOT NULL,
      response jsonb,
      requested_at timestamptz NOT NULL,
      completed_at timestamptz,
      CONSTRAINT environment_secret_requests_pkey PRIMARY KEY (
        organization_id,
        project_id,
        environment_id,
        action,
        idempotency_key
      ),
      CONSTRAINT environment_secret_requests_environment_fkey
        FOREIGN KEY (organization_id, project_id, environment_id)
        REFERENCES environments(organization_id, project_id, environment_id)
        ON DELETE CASCADE,
      CONSTRAINT environment_secret_requests_action_check CHECK (action IN ('set','delete')),
      CONSTRAINT environment_secret_requests_name_check
        CHECK (name ~ '^[A-Z][A-Z0-9_]{0,127}$'),
      CONSTRAINT environment_secret_requests_key_check
        CHECK (length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key = btrim(idempotency_key)),
      CONSTRAINT environment_secret_requests_digest_check
        CHECK (octet_length(request_sha256) = 32),
      CONSTRAINT environment_secret_requests_response_check
        CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
      CONSTRAINT environment_secret_requests_completion_check
        CHECK ((response IS NULL AND completed_at IS NULL) OR (response IS NOT NULL AND completed_at IS NOT NULL)),
      CONSTRAINT environment_secret_requests_time_check
        CHECK (completed_at IS NULL OR completed_at >= requested_at)
    );
  `);
};

export const down = (pgm) => {
  pgm.sql("DROP TABLE environment_secret_requests; DROP TABLE environment_secrets;");
};
