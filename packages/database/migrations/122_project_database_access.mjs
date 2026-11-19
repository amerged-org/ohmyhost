// P35: a customer-issued, time-bound and revocable PostgreSQL login for one project environment.
export function up(pgm) {
  pgm.sql(`CREATE TABLE project_database_access (
    access_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL,
    environment_id ulid NOT NULL,
    environment text NOT NULL CHECK(environment IN ('dev','prod')),
    data_environment_id ulid NOT NULL,
    provider_project_id text NOT NULL CHECK(provider_project_id~'^[a-z0-9-]{1,60}$'),
    default_branch_id text NOT NULL CHECK(default_branch_id~'^[a-z0-9-]{1,60}$'),
    role_name text NOT NULL UNIQUE,
    mode text NOT NULL CHECK(mode IN ('read','write')),
    label text CHECK(label IS NULL OR (length(label) BETWEEN 1 AND 64
      AND label!~'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]'
      AND label!~'^[[:space:]]' AND label!~'[[:space:]]$')),
    principal_id text NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 256),
    origin_host text NOT NULL CHECK(origin_host~'^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_by text,
    revocation_reason text,
    role_dropped_at timestamptz,
    FOREIGN KEY(organization_id,project_id,environment_id)
      REFERENCES environments(organization_id,project_id,environment_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CHECK(role_name~'^ohmyho_da_[0-7][0-9a-hjkmnp-tv-z]{25}_[0-9a-z]{8}$'
      AND role_name~('^ohmyho_da_'||lower(data_environment_id::text)||'_[0-9a-z]{8}$')),
    CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '24 hours'),
    CHECK((revoked_at IS NULL)=(revocation_reason IS NULL) AND (revoked_at IS NULL)=(revoked_by IS NULL)),
    CHECK(revocation_reason IS NULL OR revocation_reason IN ('principal','expired','budget','creation_failed')),
    CHECK(role_dropped_at IS NULL OR revoked_at IS NOT NULL),
    CHECK(revoked_at IS NULL OR revoked_at>=issued_at)
  );
  CREATE INDEX project_database_access_environment_idx ON project_database_access(organization_id,project_id,environment_id,issued_at DESC);
  CREATE INDEX project_database_access_active_idx ON project_database_access(expires_at) WHERE revoked_at IS NULL;
  CREATE INDEX project_database_access_undropped_idx ON project_database_access(revoked_at) WHERE revoked_at IS NOT NULL AND role_dropped_at IS NULL;
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') AND has_table_privilege('control_runtime','operations','INSERT') THEN
    GRANT SELECT,INSERT,UPDATE ON project_database_access TO control_runtime;
  END IF; END $$;`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_database_access) THEN RAISE EXCEPTION 'Database access credentials prevent lossless downgrade' USING ERRCODE='23514'; END IF; END $$;
    DROP TABLE project_database_access;`);
}
