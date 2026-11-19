// Mail resources require new explicit consent; existing project grants remain unchanged.
export function up(pgm) {
  pgm.sql(`ALTER TABLE mcp_client_grants ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK(revision>0);
  ALTER TABLE mcp_portal_handoffs
    ADD COLUMN mail_domain_scopes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(mail_domain_scopes)='array' AND jsonb_array_length(mail_domain_scopes)<=100),
    ADD COLUMN allow_mail_domain_create boolean NOT NULL DEFAULT false;
  CREATE TABLE mcp_mail_domain_grants (
    grant_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    user_id text NOT NULL,
    client_id text NOT NULL,
    consent_hash text NOT NULL CHECK(consent_hash ~ '^[a-f0-9]{64}$'),
    organization_id ulid NOT NULL,
    mail_domain_id ulid,
    permissions text[] NOT NULL CHECK(cardinality(permissions)>0 AND permissions <@ ARRAY['read','use','admin']::text[]),
    revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
    created_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK(mail_domain_id IS NOT NULL OR permissions=ARRAY['admin']::text[]),
    UNIQUE NULLS NOT DISTINCT(user_id,client_id,consent_hash,organization_id,mail_domain_id)
  );
  CREATE FUNCTION bump_mcp_consent_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    NEW.revision=OLD.revision+1; RETURN NEW;
  END $$;
  CREATE TRIGGER bump_mcp_project_consent BEFORE UPDATE ON mcp_client_grants FOR EACH ROW EXECUTE FUNCTION bump_mcp_consent_revision();
  CREATE TRIGGER bump_mcp_mail_consent BEFORE UPDATE ON mcp_mail_domain_grants FOR EACH ROW EXECUTE FUNCTION bump_mcp_consent_revision();
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
    GRANT SELECT,INSERT,UPDATE ON mcp_mail_domain_grants TO control_runtime;
  END IF; END $$;`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM mcp_mail_domain_grants) OR EXISTS(SELECT 1 FROM mcp_portal_handoffs WHERE mail_domain_scopes <> '[]'::jsonb OR allow_mail_domain_create) THEN
      RAISE EXCEPTION 'Mail consent evidence prevents rollback';
    END IF;
  END $$;
  DROP TRIGGER bump_mcp_project_consent ON mcp_client_grants;
  DROP TRIGGER bump_mcp_mail_consent ON mcp_mail_domain_grants;
  DROP FUNCTION bump_mcp_consent_revision();
  DROP TABLE mcp_mail_domain_grants;
  ALTER TABLE mcp_client_grants DROP COLUMN revision;
  ALTER TABLE mcp_portal_handoffs DROP COLUMN mail_domain_scopes,DROP COLUMN allow_mail_domain_create;`);
}
