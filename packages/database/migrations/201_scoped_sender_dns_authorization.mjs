/** New purpose/resource grants deliberately do not copy legacy project-grant ciphertext or AAD. */
export function up(pgm) {
  pgm.sql(`
CREATE TABLE scoped_customer_dns_authorizations (
  authorization_id ulid PRIMARY KEY,
  organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
  purpose text NOT NULL CHECK(purpose IN ('application_identity','workspace_mail')),
  resource_id ulid NOT NULL,
  resource_revision bigint NOT NULL CHECK(resource_revision>0),
  principal_id text NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 256),
  delegation jsonb CHECK(delegation IS NULL OR jsonb_typeof(delegation)='object'),
  zone_name text NOT NULL,
  state_sha256 bytea NOT NULL CHECK(octet_length(state_sha256)=32),
  idempotency_key_sha256 bytea NOT NULL CHECK(octet_length(idempotency_key_sha256)=32),
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '10 minutes'),
  consumed_at timestamptz,
  revoked_at timestamptz,
  dns_receipts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(dns_receipts)='object'),
  UNIQUE(organization_id,purpose,resource_id,idempotency_key_sha256),
  UNIQUE(authorization_id,organization_id,purpose,resource_id,resource_revision),
  CHECK(consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at))
);
CREATE TABLE scoped_customer_dns_grants (
  organization_id ulid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('application_identity','workspace_mail')),
  resource_id ulid NOT NULL,
  resource_revision bigint NOT NULL CHECK(resource_revision>0),
  authorization_id ulid NOT NULL,
  principal_id text NOT NULL,
  zone_name text NOT NULL,
  zone_id text NOT NULL CHECK(zone_id~'^[a-f0-9]{32}$'),
  account_id text NOT NULL CHECK(account_id~'^[a-f0-9]{32}$'),
  access_ciphertext bytea NOT NULL,
  access_nonce bytea NOT NULL CHECK(octet_length(access_nonce)=12),
  refresh_ciphertext bytea NOT NULL,
  refresh_nonce bytea NOT NULL CHECK(octet_length(refresh_nonce)=12),
  key_version integer NOT NULL CHECK(key_version>0),
  access_expires_at timestamptz NOT NULL,
  connected_at timestamptz NOT NULL,
  revoked_at timestamptz,
  dns_receipts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(dns_receipts)='array'),
  PRIMARY KEY(organization_id,purpose,resource_id),
  FOREIGN KEY(authorization_id,organization_id,purpose,resource_id,resource_revision)
    REFERENCES scoped_customer_dns_authorizations(authorization_id,organization_id,purpose,resource_id,resource_revision)
);
CREATE TABLE scoped_customer_dns_revocations (
  organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
  purpose text NOT NULL CHECK(purpose IN ('application_identity','workspace_mail')),
  resource_id ulid NOT NULL,resource_revision bigint NOT NULL CHECK(resource_revision>0),
  principal_id text NOT NULL,idempotency_key_sha256 bytea NOT NULL CHECK(octet_length(idempotency_key_sha256)=32),
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),revoked_at timestamptz NOT NULL,
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  PRIMARY KEY(organization_id,purpose,resource_id,idempotency_key_sha256)
);

CREATE FUNCTION scoped_customer_dns_resource_is_current(p_org ulid,p_purpose text,p_resource ulid,p_revision bigint,p_zone text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT CASE p_purpose
  WHEN 'application_identity' THEN EXISTS (
    SELECT 1 FROM project_application_domain_identities identity
      JOIN project_ownerships ownership ON ownership.organization_id=identity.organization_id
        AND ownership.project_id=identity.project_id AND ownership.state='active'
      JOIN projects project ON project.project_id=identity.project_id AND project.lifecycle_state='active'
    WHERE identity.organization_id=p_org AND identity.project_id=p_resource
      AND identity.revision=p_revision AND identity.state IN ('pending','verified')
      AND (identity.state='verified' OR identity.expires_at>clock_timestamp())
      AND (identity.hostname=p_zone OR right(identity.hostname,length(p_zone)+1)='.'||p_zone)
    FOR SHARE OF identity,ownership,project)
  WHEN 'workspace_mail' THEN EXISTS (
    SELECT 1 FROM workspace_mail_domains domain
    WHERE domain.organization_id=p_org AND domain.domain_id=p_resource
      AND domain.revision=p_revision AND domain.status IN ('active','retiring')
      AND (domain.domain=p_zone OR right(domain.domain,length(p_zone)+1)='.'||p_zone)
    FOR SHARE OF domain)
  ELSE false END
$$;
CREATE FUNCTION guard_scoped_customer_dns_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='scoped_customer_dns_authorizations' THEN
    IF TG_OP='UPDATE' AND (NEW.authorization_id,NEW.organization_id,NEW.purpose,NEW.resource_id,
      NEW.resource_revision,NEW.principal_id,NEW.delegation,NEW.zone_name,NEW.state_sha256,
      NEW.idempotency_key_sha256,NEW.request_sha256,NEW.issued_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.authorization_id,OLD.organization_id,OLD.purpose,OLD.resource_id,
      OLD.resource_revision,OLD.principal_id,OLD.delegation,OLD.zone_name,OLD.state_sha256,
      OLD.idempotency_key_sha256,OLD.request_sha256,OLD.issued_at,OLD.expires_at) THEN
      RAISE EXCEPTION 'Scoped DNS authorization identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM scoped_customer_dns_authorizations auth
      WHERE auth.authorization_id=NEW.authorization_id AND auth.organization_id=NEW.organization_id
        AND auth.purpose=NEW.purpose AND auth.resource_id=NEW.resource_id
        AND auth.resource_revision=NEW.resource_revision AND auth.principal_id=NEW.principal_id
        AND auth.zone_name=NEW.zone_name AND auth.consumed_at IS NOT NULL
        AND auth.revoked_at IS NULL AND auth.consumed_at<=NEW.connected_at
        AND NEW.connected_at<auth.expires_at) THEN
      RAISE EXCEPTION 'Scoped DNS authorization is unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.revoked_at IS NULL AND NOT scoped_customer_dns_resource_is_current(
    NEW.organization_id,NEW.purpose,NEW.resource_id,NEW.resource_revision,NEW.zone_name) THEN
    RAISE EXCEPTION 'Scoped DNS resource declaration is stale' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scoped_customer_dns_authorization_authority BEFORE INSERT OR UPDATE ON scoped_customer_dns_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_scoped_customer_dns_authority();
CREATE TRIGGER scoped_customer_dns_grant_authority BEFORE INSERT OR UPDATE ON scoped_customer_dns_grants
  FOR EACH ROW EXECUTE FUNCTION guard_scoped_customer_dns_authority();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
  GRANT SELECT,INSERT,UPDATE ON scoped_customer_dns_authorizations,scoped_customer_dns_grants,scoped_customer_dns_revocations TO control_runtime;
END IF; END $$;
`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM scoped_customer_dns_authorizations)
    OR EXISTS(SELECT 1 FROM scoped_customer_dns_grants) OR EXISTS(SELECT 1 FROM scoped_customer_dns_revocations) THEN
    RAISE EXCEPTION 'Scoped DNS receipts prevent a lossless downgrade'; END IF; END $$;
DROP TABLE scoped_customer_dns_grants;
DROP TABLE scoped_customer_dns_authorizations;
DROP TABLE scoped_customer_dns_revocations;
DROP FUNCTION guard_scoped_customer_dns_authority();
DROP FUNCTION scoped_customer_dns_resource_is_current(ulid,text,ulid,bigint,text);`);
}
