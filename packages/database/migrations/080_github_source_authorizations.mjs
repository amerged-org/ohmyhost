export function up(pgm) {
  pgm.sql(`
    CREATE TABLE github_source_authorizations (
      authorization_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      environment_id ulid NOT NULL,
      billing_epoch_id ulid NOT NULL REFERENCES billing_epochs(billing_epoch_id),
      principal_id text NOT NULL,
      session_id text NOT NULL,
      workos_organization_id text NOT NULL,
      token_expires_at bigint NOT NULL,
      repository_owner text NOT NULL,
      repository_name text NOT NULL,
      idempotency_key text NOT NULL,
      request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
      state_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(state_sha256)=32),
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
      value_sha256 bytea NOT NULL CHECK (octet_length(value_sha256)=32),
      key_version integer NOT NULL CHECK (key_version>0),
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','authorizing','authorized','failed')),
      operation_id ulid UNIQUE,
      github_user_id text,
      installation_id text,
      repository_id text,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
      UNIQUE (organization_id,project_id,principal_id,idempotency_key),
      FOREIGN KEY (organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id),
      CHECK ((state='authorized' AND operation_id IS NOT NULL AND github_user_id IS NOT NULL
        AND installation_id IS NOT NULL AND repository_id IS NOT NULL)
        OR (state<>'authorized' AND operation_id IS NULL AND github_user_id IS NULL
          AND installation_id IS NULL AND repository_id IS NULL))
    );
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM github_source_authorizations) THEN
      RAISE EXCEPTION 'GitHub authorization records require explicit retention before rollback';
    END IF;
  END $$;`);
  pgm.dropTable("github_source_authorizations");
}
