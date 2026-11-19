export function up(pgm) {
  pgm.sql(`
    CREATE TABLE github_organization_connections (
      connection_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
      installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]*$'),
      account_id text NOT NULL CHECK (account_id ~ '^[1-9][0-9]*$'),
      account_login text NOT NULL,
      account_type text NOT NULL CHECK (account_type IN ('User','Organization')),
      github_user_id text NOT NULL CHECK (github_user_id ~ '^[1-9][0-9]*$'),
      github_user_login text NOT NULL,
      principal_id text NOT NULL,
      settings_url text NOT NULL,
      connected_at timestamptz NOT NULL,
      revoked_at timestamptz,
      UNIQUE (organization_id,connection_id),
      CHECK (revoked_at IS NULL OR revoked_at>=connected_at)
    );
    CREATE UNIQUE INDEX github_organization_one_active ON github_organization_connections(organization_id) WHERE revoked_at IS NULL;
    CREATE TABLE github_connection_authorizations (
      authorization_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
      principal_id text NOT NULL,
      session_id text,
      user_api_key_id text,
      workos_organization_id text NOT NULL,
      token_expires_at bigint,
      idempotency_key text NOT NULL,
      state_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(state_sha256)=32),
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
      value_sha256 bytea NOT NULL CHECK (octet_length(value_sha256)=32),
      key_version integer NOT NULL CHECK (key_version>0),
      state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','authorizing','connected','failed')),
      flow text NOT NULL DEFAULT 'installation' CHECK (flow IN ('installation','oauth')),
      installation_id text CHECK (installation_id ~ '^[1-9][0-9]*$'),
      connection_id ulid,
      last_failure text CHECK (last_failure IN ('installation_access_required','account_admin_required','authorization_code_rejected','provider_unavailable','expired','session_inactive','denied','code_spent')),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
      UNIQUE (organization_id,principal_id,idempotency_key),
      FOREIGN KEY (organization_id,connection_id) REFERENCES github_organization_connections(organization_id,connection_id),
      CHECK ((session_id IS NOT NULL AND user_api_key_id IS NULL AND token_expires_at IS NOT NULL) OR (session_id IS NULL AND user_api_key_id IS NOT NULL)),
      CHECK ((state='connected')=(connection_id IS NOT NULL))
    );
    CREATE TABLE github_repository_link_consents (
      operation_id ulid PRIMARY KEY REFERENCES operations(operation_id),
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      environment_id ulid NOT NULL,
      billing_epoch_id ulid NOT NULL REFERENCES billing_epochs(billing_epoch_id),
      connection_id ulid NOT NULL,
      principal_id text NOT NULL,
      installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]*$'),
      repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]*$'),
      repository_owner text NOT NULL,
      repository_name text NOT NULL,
      idempotency_key text NOT NULL,
      request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
      authorized_at timestamptz NOT NULL,
      UNIQUE (organization_id,project_id,principal_id,idempotency_key),
      FOREIGN KEY (organization_id,project_id,operation_id,billing_epoch_id) REFERENCES operations(organization_id,project_id,operation_id,billing_epoch_id),
      FOREIGN KEY (organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id),
      FOREIGN KEY (organization_id,connection_id) REFERENCES github_organization_connections(organization_id,connection_id)
    );
    CREATE TRIGGER github_repository_link_consents_immutable BEFORE UPDATE OR DELETE ON github_repository_link_consents FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM github_organization_connections) OR EXISTS (SELECT 1 FROM github_connection_authorizations) OR EXISTS (SELECT 1 FROM github_repository_link_consents) THEN
      RAISE EXCEPTION 'GitHub connection history requires explicit retention before rollback';
    END IF;
  END $$;`);
  pgm.dropTable("github_repository_link_consents");
  pgm.dropTable("github_connection_authorizations");
  pgm.dropTable("github_organization_connections");
}
