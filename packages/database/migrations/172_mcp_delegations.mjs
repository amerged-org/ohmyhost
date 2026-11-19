// Remote-agent consent is separate from platform login and customer Git custody.
export function up(pgm) {
  pgm.sql(`CREATE TABLE mcp_portal_handoffs (
    request_hash text PRIMARY KEY CHECK(request_hash ~ '^[a-f0-9]{64}$'),
    user_id text NOT NULL CHECK(user_id ~ '^user_[A-Za-z0-9]+$'),
    client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 2048 AND client_id !~ '[[:space:][:cntrl:]]'),
    consent_hash text NOT NULL CHECK(consent_hash ~ '^[a-f0-9]{64}$'),
    organization_id ulid NOT NULL,
    kind text NOT NULL CHECK(kind IN ('grant','secret','github')),
    project_ids ulid[] NOT NULL CHECK(cardinality(project_ids)<=100),
    allow_create boolean NOT NULL,
    allow_publish boolean NOT NULL,
    secret_target jsonb,
    github_target jsonb,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
    consumed_at timestamptz,
    outcome text CHECK(outcome IN ('approved','declined','secret_submitted','secret_failed','github_started','github_failed')),
    CHECK((consumed_at IS NULL)=(outcome IS NULL)),
    CHECK((kind='grant' AND secret_target IS NULL AND github_target IS NULL)
       OR (kind='secret' AND cardinality(project_ids)=1 AND NOT allow_create AND NOT allow_publish
           AND jsonb_typeof(secret_target)='object' AND github_target IS NULL)
       OR (kind='github' AND cardinality(project_ids)=0 AND NOT allow_create AND NOT allow_publish
           AND secret_target IS NULL AND jsonb_typeof(github_target)='object'))
  );
  CREATE INDEX mcp_portal_handoffs_expiry ON mcp_portal_handoffs(expires_at) WHERE consumed_at IS NULL;
  CREATE TABLE mcp_client_grants (
    grant_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    user_id text NOT NULL,
    client_id text NOT NULL,
    consent_hash text NOT NULL CHECK(consent_hash ~ '^[a-f0-9]{64}$'),
    organization_id ulid NOT NULL,
    project_id ulid,
    ownership_version integer,
    billing_epoch_id ulid,
    allow_publish boolean NOT NULL,
    created_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK((project_id IS NULL AND ownership_version IS NULL AND billing_epoch_id IS NULL)
      OR (project_id IS NOT NULL AND ownership_version>0 AND billing_epoch_id IS NOT NULL)),
    UNIQUE NULLS NOT DISTINCT(user_id,client_id,consent_hash,organization_id,project_id)
  );
  CREATE TABLE mcp_client_revocations (
    user_id text NOT NULL,
    client_id text NOT NULL,
    consent_hash text NOT NULL,
    organization_id ulid NOT NULL,
    revoked_at timestamptz NOT NULL,
    PRIMARY KEY(user_id,client_id,consent_hash,organization_id)
  );
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
    GRANT SELECT,INSERT,UPDATE ON mcp_portal_handoffs,mcp_client_grants TO control_runtime;
    GRANT SELECT,INSERT ON mcp_client_revocations TO control_runtime;
  END IF; END $$;`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM mcp_portal_handoffs) OR EXISTS(SELECT 1 FROM mcp_client_grants)
       OR EXISTS(SELECT 1 FROM mcp_client_revocations) THEN
      RAISE EXCEPTION 'Remote MCP consent evidence prevents rollback';
    END IF;
  END $$;
  DROP TABLE mcp_client_revocations,mcp_client_grants,mcp_portal_handoffs;`);
}
