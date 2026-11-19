/** Additive preparation; historical SES receipts and billing remain immutable until cutover. */
export function up(pgm) {
  pgm.sql(`
 ALTER TABLE mail_gateway_keys DROP CONSTRAINT mail_gateway_keys_ready_domain_fkey;
 ALTER TABLE mail_gateway_keys ADD CONSTRAINT mail_gateway_keys_owner_fkey FOREIGN KEY(organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id);
 ALTER TABLE mail_send_requests DROP CONSTRAINT mail_send_requests_ready_domain_fkey;
 ALTER TABLE mail_send_requests ADD CONSTRAINT mail_send_requests_owner_fkey FOREIGN KEY(organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id);
 ALTER TABLE mail_send_requests ADD COLUMN mail_provider text NOT NULL DEFAULT 'aws-ses-v2' CHECK(mail_provider IN ('aws-ses-v2','resend'));
 CREATE TABLE resend_mail_domains (
  domain_id ulid PRIMARY KEY, organization_id ulid NOT NULL, project_id ulid NOT NULL,
  environment_id ulid NOT NULL, domain text NOT NULL,
  provider_domain_id text UNIQUE, provider_claimed_at timestamptz, provider_preflight_at timestamptz, verify_requested_at timestamptz,
  sending_key_id text UNIQUE, sending_key_claimed_at timestamptz,
  sending_key_ciphertext bytea, sending_key_nonce bytea, sending_key_sha256 bytea, sending_key_version integer,
  sending boolean NOT NULL DEFAULT true, receiving boolean NOT NULL DEFAULT false,
  receiving_suspended boolean NOT NULL DEFAULT false, last_entitlement_check_at timestamptz, last_reconcile_at timestamptz,
  sending_status text NOT NULL DEFAULT 'pending', receiving_status text NOT NULL DEFAULT 'disabled',
  records jsonb NOT NULL DEFAULT '[]', dns_receipts jsonb NOT NULL DEFAULT '{}' ,
  webhook_url text, webhook_verified_at timestamptz,
  configured_at timestamptz NOT NULL, observed_at timestamptz, deleted_at timestamptz,
  FOREIGN KEY(organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id),
  FOREIGN KEY(organization_id,environment_id) REFERENCES environments(organization_id,environment_id),
  FOREIGN KEY(project_id,environment_id) REFERENCES environments(project_id,environment_id),
  UNIQUE(domain_id,organization_id,project_id,environment_id),
  CHECK(domain=lower(domain) AND domain ~ '^[a-z0-9][a-z0-9.-]+[a-z]$'),
  CHECK(sending_status IN ('disabled','pending','ready','failed') AND receiving_status IN ('disabled','pending','ready','failed')),
  CHECK(NOT receiving OR (webhook_url IS NOT NULL AND webhook_verified_at IS NOT NULL)),
  CHECK(NOT receiving OR sending),
  CHECK(webhook_url IS NULL OR webhook_url ~ '^https://'),
  CHECK ((sending_key_id IS NULL AND sending_key_ciphertext IS NULL AND sending_key_nonce IS NULL AND sending_key_sha256 IS NULL AND sending_key_version IS NULL)
    OR (sending_key_id IS NOT NULL AND sending_key_ciphertext IS NOT NULL AND sending_key_nonce IS NOT NULL AND octet_length(sending_key_nonce)=12 AND sending_key_sha256 IS NOT NULL AND octet_length(sending_key_sha256)=32 AND sending_key_version IS NOT NULL AND sending_key_version>0)),
  CHECK(jsonb_typeof(records)='array' AND jsonb_typeof(dns_receipts)='object')
 );
 CREATE FUNCTION guard_resend_domain_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.domain_id,NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.domain,NEW.configured_at)
   IS DISTINCT FROM ROW(OLD.domain_id,OLD.organization_id,OLD.project_id,OLD.environment_id,OLD.domain,OLD.configured_at)
   OR (OLD.provider_domain_id IS NOT NULL AND NEW.provider_domain_id IS DISTINCT FROM OLD.provider_domain_id)
   OR (OLD.sending_key_id IS NOT NULL AND NEW.sending_key_id IS DISTINCT FROM OLD.sending_key_id)
   OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  THEN RAISE EXCEPTION 'mail domain ownership is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW; END $$;
 CREATE TRIGGER resend_domain_identity BEFORE UPDATE ON resend_mail_domains FOR EACH ROW EXECUTE FUNCTION guard_resend_domain_identity();
 CREATE FUNCTION guard_resend_prod_environment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM environments e WHERE e.environment_id=NEW.environment_id AND e.project_id=NEW.project_id AND e.name='prod')
  THEN RAISE EXCEPTION 'mail domain must belong to project production environment' USING ERRCODE='23514'; END IF;
  RETURN NEW; END $$;
 CREATE TRIGGER resend_prod_environment BEFORE INSERT ON resend_mail_domains FOR EACH ROW EXECUTE FUNCTION guard_resend_prod_environment();
 CREATE UNIQUE INDEX resend_mail_domain_live_name ON resend_mail_domains(domain) WHERE deleted_at IS NULL;
 CREATE UNIQUE INDEX resend_mail_domain_live_project ON resend_mail_domains(project_id) WHERE deleted_at IS NULL;
 CREATE TABLE mail_received_messages (
  message_id ulid PRIMARY KEY, provider_message_id text NOT NULL UNIQUE,
  domain_id ulid NOT NULL, organization_id ulid NOT NULL, project_id ulid NOT NULL, environment_id ulid NOT NULL,
  received_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz, lease_until timestamptz, next_attempt_at timestamptz NOT NULL,
  last_http_status integer, billed_at timestamptz,
  FOREIGN KEY(domain_id,organization_id,project_id,environment_id) REFERENCES resend_mail_domains(domain_id,organization_id,project_id,environment_id),
  CHECK(expires_at=received_at+interval '72 hours'),
  CHECK(attempts BETWEEN 0 AND 4),
  CHECK((attempts=0 AND first_attempt_at IS NULL) OR (attempts>0 AND first_attempt_at IS NOT NULL)),
  CHECK(state IN ('pending','delivering','delivered','delivery_failed','expired')),
  CHECK(last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599)
 );
 CREATE INDEX mail_received_due ON mail_received_messages(next_attempt_at) WHERE state IN ('pending','delivering');
 CREATE FUNCTION guard_received_mail_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.message_id,NEW.provider_message_id,NEW.domain_id,NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.received_at,NEW.expires_at)
   IS DISTINCT FROM ROW(OLD.message_id,OLD.provider_message_id,OLD.domain_id,OLD.organization_id,OLD.project_id,OLD.environment_id,OLD.received_at,OLD.expires_at)
   OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
   OR (OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at)
  THEN RAISE EXCEPTION 'mail ownership, receipt deadline and delivery budget are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW; END $$;
 CREATE TRIGGER received_mail_identity BEFORE UPDATE ON mail_received_messages FOR EACH ROW EXECUTE FUNCTION guard_received_mail_identity();
 CREATE TABLE resend_mail_commands (
  organization_id ulid NOT NULL, project_id ulid NOT NULL, environment_id ulid NOT NULL,
  idempotency_key text NOT NULL, request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),
  response jsonb, created_at timestamptz NOT NULL, completed_at timestamptz, lease_until timestamptz, claimed_attempt integer CHECK(claimed_attempt BETWEEN 1 AND 4),
  PRIMARY KEY(organization_id,project_id,environment_id,idempotency_key),
  FOREIGN KEY(project_id,environment_id) REFERENCES environments(project_id,environment_id),
  FOREIGN KEY(organization_id,environment_id) REFERENCES environments(organization_id,environment_id),
  CHECK(length(idempotency_key) BETWEEN 1 AND 128)
 );
 CREATE TABLE resend_event_receipts (
  event_id text PRIMARY KEY, event_type text NOT NULL, provider_message_id text,
  payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32), received_at timestamptz NOT NULL
 );
 `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM resend_mail_domains) OR EXISTS(SELECT 1 FROM resend_event_receipts) THEN RAISE EXCEPTION 'Resend ownership and delivery evidence must be retained'; END IF; END $$;
 ALTER TABLE mail_send_requests DROP CONSTRAINT mail_send_requests_owner_fkey;
 ALTER TABLE mail_send_requests DROP COLUMN mail_provider;
 ALTER TABLE mail_send_requests ADD CONSTRAINT mail_send_requests_ready_domain_fkey FOREIGN KEY(organization_id,project_id) REFERENCES route53_dkim_receipts(organization_id,project_id);
 ALTER TABLE mail_gateway_keys DROP CONSTRAINT mail_gateway_keys_owner_fkey;
 ALTER TABLE mail_gateway_keys ADD CONSTRAINT mail_gateway_keys_ready_domain_fkey FOREIGN KEY(organization_id,project_id) REFERENCES route53_dkim_receipts(organization_id,project_id);
 DROP TABLE mail_received_messages,resend_mail_commands,resend_event_receipts,resend_mail_domains;
 DROP FUNCTION guard_received_mail_identity(),guard_resend_domain_identity(),guard_resend_prod_environment();`);
}
