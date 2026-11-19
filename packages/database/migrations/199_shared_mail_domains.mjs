/** Additive ownership split. Legacy ciphertext, DNS receipts and inbound FKs remain untouched.
 * @param {import("node-pg-migrate").MigrationBuilder} pgm
 */
export function up(pgm) {
  pgm.sql(`
 -- Custody and billed history keep their original organization when current ownership moves.
 ALTER TABLE resend_mail_domains DROP CONSTRAINT resend_mail_domains_organization_id_project_id_fkey,
  DROP CONSTRAINT resend_mail_domains_organization_id_environment_id_fkey,
  ADD CONSTRAINT resend_mail_domains_stable_project_fkey FOREIGN KEY(project_id) REFERENCES projects(project_id);
 ALTER TABLE resend_mail_commands DROP CONSTRAINT resend_mail_commands_organization_id_environment_id_fkey;
 ALTER TABLE mail_send_requests DROP CONSTRAINT mail_send_requests_owner_fkey,
  ADD CONSTRAINT mail_send_requests_stable_project_fkey FOREIGN KEY(project_id) REFERENCES projects(project_id);
 ALTER TABLE mail_gateway_keys DROP CONSTRAINT mail_gateway_keys_owner_fkey,
  ADD CONSTRAINT mail_gateway_keys_stable_project_fkey FOREIGN KEY(project_id) REFERENCES projects(project_id);
 ALTER TABLE mail_credit_accounts DROP CONSTRAINT mail_credit_accounts_ownership_fkey,
  ADD CONSTRAINT mail_credit_accounts_stable_project_fkey FOREIGN KEY(project_id) REFERENCES projects(project_id);
 CREATE TABLE workspace_mail_domains (
  domain_id ulid PRIMARY KEY,organization_id ulid NOT NULL,domain text NOT NULL,
  registrable_domain text,legacy_domain_id ulid UNIQUE REFERENCES resend_mail_domains(domain_id),
  custody_organization_id ulid NOT NULL,custody_project_id ulid NOT NULL,custody_environment_id ulid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retiring','retired')),
  reputation_state text NOT NULL DEFAULT 'active' CHECK(reputation_state IN ('active','suspended')),reputation_suspended_at timestamptz,reputation_suspension_reason text,reputation_triggering_event_id uuid,reputation_version bigint NOT NULL DEFAULT 1 CHECK(reputation_version>0),
  capabilities_lease_until timestamptz,capabilities_lease_token ulid,
  last_reconcile_at timestamptz,capabilities_dirty boolean NOT NULL DEFAULT true,
  provider_domain_id text UNIQUE,provider_claimed_at timestamptz,provider_preflight_at timestamptz,verify_requested_at timestamptz,
  sending_key_id text UNIQUE,sending_key_claimed_at timestamptz,sending_key_ciphertext bytea,sending_key_nonce bytea,sending_key_sha256 bytea,sending_key_version integer,
  sending_status text NOT NULL DEFAULT 'pending' CHECK(sending_status IN ('disabled','pending','ready','failed')),
  receiving_status text NOT NULL DEFAULT 'disabled' CHECK(receiving_status IN ('disabled','pending','ready','failed')),
  records jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(records)='array'),dns_receipts jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(dns_receipts)='object'),
  configured_at timestamptz NOT NULL,observed_at timestamptz,retired_at timestamptz,
  UNIQUE(domain_id,organization_id),CHECK(domain=lower(domain)),
  CHECK(registrable_domain IS NOT NULL OR legacy_domain_id IS NOT NULL),
  CHECK(custody_organization_id=organization_id),
  CHECK((reputation_state='active' AND reputation_suspended_at IS NULL AND reputation_suspension_reason IS NULL AND reputation_triggering_event_id IS NULL)
    OR(reputation_state='suspended' AND reputation_suspended_at IS NOT NULL AND reputation_suspension_reason IS NOT NULL AND reputation_suspension_reason IN ('bounce_rate','complaint_rate') AND reputation_triggering_event_id IS NOT NULL)),
  CHECK((sending_key_id IS NULL AND sending_key_ciphertext IS NULL AND sending_key_nonce IS NULL AND sending_key_sha256 IS NULL AND sending_key_version IS NULL)
   OR(sending_key_id IS NOT NULL AND sending_key_ciphertext IS NOT NULL AND octet_length(sending_key_ciphertext)>=17 AND sending_key_nonce IS NOT NULL AND octet_length(sending_key_nonce)=12 AND sending_key_sha256 IS NOT NULL AND octet_length(sending_key_sha256)=32 AND sending_key_version IS NOT NULL AND sending_key_version>0))
 );
 CREATE UNIQUE INDEX workspace_mail_domain_live_name ON workspace_mail_domains(domain) WHERE status<>'retired';
 CREATE FUNCTION guard_workspace_mail_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.domain_id,NEW.organization_id,NEW.domain,NEW.legacy_domain_id,NEW.custody_organization_id,NEW.custody_project_id,NEW.custody_environment_id,NEW.configured_at)
   IS DISTINCT FROM ROW(OLD.domain_id,OLD.organization_id,OLD.domain,OLD.legacy_domain_id,OLD.custody_organization_id,OLD.custody_project_id,OLD.custody_environment_id,OLD.configured_at)
   OR(OLD.provider_domain_id IS NOT NULL AND NEW.provider_domain_id IS DISTINCT FROM OLD.provider_domain_id)
   OR(OLD.sending_key_id IS NOT NULL AND NEW.sending_key_id IS DISTINCT FROM OLD.sending_key_id)
   OR(OLD.sending_key_id IS NOT NULL AND ROW(NEW.sending_key_ciphertext,NEW.sending_key_nonce,NEW.sending_key_sha256,NEW.sending_key_version) IS DISTINCT FROM ROW(OLD.sending_key_ciphertext,OLD.sending_key_nonce,OLD.sending_key_sha256,OLD.sending_key_version))
   OR(OLD.registrable_domain IS NOT NULL AND NEW.registrable_domain IS DISTINCT FROM OLD.registrable_domain)
   OR(OLD.status='retired' AND NEW.status<>'retired')
   THEN RAISE EXCEPTION 'workspace mail domain identity is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER guard_workspace_mail_identity BEFORE UPDATE ON workspace_mail_domains FOR EACH ROW EXECUTE FUNCTION guard_workspace_mail_identity();
 CREATE TABLE workspace_mail_commands (
  organization_id ulid NOT NULL,idempotency_key text NOT NULL,domain_id ulid NOT NULL,operation text NOT NULL,
  principal_id text NOT NULL,request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),response jsonb,
  created_at timestamptz NOT NULL,completed_at timestamptz,lease_until timestamptz,claimed_attempt integer CHECK(claimed_attempt BETWEEN 1 AND 4),
  PRIMARY KEY(organization_id,idempotency_key),FOREIGN KEY(domain_id,organization_id) REFERENCES workspace_mail_domains(domain_id,organization_id),
  CHECK(length(idempotency_key) BETWEEN 1 AND 128)
 );
 CREATE TABLE workspace_mail_reputation_decisions (
  decision_id uuid NOT NULL,domain_id ulid NOT NULL REFERENCES workspace_mail_domains(domain_id),organization_id ulid NOT NULL,project_id ulid NOT NULL,
  action text NOT NULL CHECK(action IN ('suspend','reinstate','retain')),reason text NOT NULL,triggering_event_id uuid,
  eligible_send_count bigint NOT NULL CHECK(eligible_send_count>=0),hard_bounce_count bigint NOT NULL CHECK(hard_bounce_count>=0),complaint_count bigint NOT NULL CHECK(complaint_count>=0),
  actor_id text NOT NULL,evidence_sha256 bytea CHECK(evidence_sha256 IS NULL OR octet_length(evidence_sha256)=32),occurred_at timestamptz NOT NULL,
  PRIMARY KEY(decision_id,domain_id),FOREIGN KEY(domain_id,organization_id) REFERENCES workspace_mail_domains(domain_id,organization_id)
 );
 CREATE TABLE project_application_domain_identities (
  project_id ulid PRIMARY KEY,organization_id ulid NOT NULL,hostname text NOT NULL,registrable_domain text NOT NULL,
  revision bigint NOT NULL CHECK(revision>0),state text NOT NULL CHECK(state IN ('pending','verified','revoked')),
  challenge_name text NOT NULL,challenge_value text NOT NULL,declared_at timestamptz NOT NULL,
  verified_at timestamptz,expires_at timestamptz NOT NULL,revoked_at timestamptz,automatic_revalidation_attempted_at timestamptz,
  idempotency_key_sha256 bytea NOT NULL CHECK(octet_length(idempotency_key_sha256)=32),
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),actor_id text NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id),
  UNIQUE(project_id,organization_id,revision),
  CHECK(hostname=lower(hostname) AND challenge_name='_omh-project.'||hostname),
  CHECK(state<>'verified' OR(verified_at IS NOT NULL AND expires_at>verified_at)),
  CHECK(length(challenge_value) BETWEEN 32 AND 128)
 );
 CREATE INDEX application_mail_identity_revalidation_due ON project_application_domain_identities(expires_at,project_id) WHERE state='verified';
 CREATE FUNCTION guard_application_mail_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND(NEW.revision<OLD.revision OR(NEW.revision=OLD.revision AND ROW(NEW.hostname,NEW.registrable_domain,NEW.challenge_name,NEW.challenge_value) IS DISTINCT FROM ROW(OLD.hostname,OLD.registrable_domain,OLD.challenge_name,OLD.challenge_value)))
   THEN RAISE EXCEPTION 'mail_identity_revision_conflict' USING ERRCODE='23514'; END IF;
  IF NEW.state<>'revoked' AND EXISTS(SELECT 1 FROM paid_project_domains website WHERE website.organization_id=NEW.organization_id AND website.project_id=NEW.project_id AND website.state IN ('awaiting_deployment','pending','active')
    AND website.hostname<>NEW.registrable_domain AND right(website.hostname,length(NEW.registrable_domain)+1)<>'.'||NEW.registrable_domain)
   THEN RAISE EXCEPTION 'mail_domain_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW; END $$;
 CREATE TRIGGER guard_application_mail_identity BEFORE INSERT OR UPDATE ON project_application_domain_identities FOR EACH ROW EXECUTE FUNCTION guard_application_mail_identity();
 CREATE TABLE project_application_identity_commands (
  organization_id ulid NOT NULL,project_id ulid NOT NULL,idempotency_key_sha256 bytea NOT NULL CHECK(octet_length(idempotency_key_sha256)=32),
  request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),response jsonb NOT NULL,
  PRIMARY KEY(organization_id,project_id,idempotency_key_sha256),FOREIGN KEY(project_id) REFERENCES projects(project_id)
 );
 CREATE TABLE project_application_identity_action_commands (
  organization_id ulid NOT NULL,project_id ulid NOT NULL,actor_id text NOT NULL,action text NOT NULL CHECK(action IN ('verify','revoke')),
  idempotency_key_sha256 bytea NOT NULL CHECK(octet_length(idempotency_key_sha256)=32),request_sha256 bytea NOT NULL CHECK(octet_length(request_sha256)=32),response jsonb NOT NULL,
  PRIMARY KEY(organization_id,project_id,actor_id,action,idempotency_key_sha256),FOREIGN KEY(project_id) REFERENCES projects(project_id)
 );
 CREATE TABLE project_mail_domain_bindings (
  project_id ulid PRIMARY KEY,organization_id ulid NOT NULL,environment_id ulid NOT NULL,mail_domain_id ulid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','detached','suspended')),
  sending boolean NOT NULL DEFAULT true,legacy boolean NOT NULL DEFAULT false,
  sender_addresses jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(sender_addresses)='array'),default_from text,default_reply_to text,
  application_identity_revision bigint,configured_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
  FOREIGN KEY(mail_domain_id,organization_id) REFERENCES workspace_mail_domains(domain_id,organization_id),
  FOREIGN KEY(project_id) REFERENCES projects(project_id),
  FOREIGN KEY(project_id,environment_id) REFERENCES environments(project_id,environment_id),
  CHECK(legacy OR(application_identity_revision IS NOT NULL AND jsonb_array_length(sender_addresses) BETWEEN 1 AND 32 AND default_from IS NOT NULL AND sender_addresses ? default_from))
 );
 CREATE INDEX project_mail_domain_active_refs ON project_mail_domain_bindings(mail_domain_id) WHERE state='active';
 CREATE TABLE shared_mail_capabilities (
  capability text PRIMARY KEY CHECK(capability='same-domain-sharing-v1'),enabled boolean NOT NULL DEFAULT false,
  cohort_revision text,activated_at timestamptz,CHECK(NOT enabled OR(cohort_revision IS NOT NULL AND activated_at IS NOT NULL))
 );
 INSERT INTO shared_mail_capabilities(capability) VALUES('same-domain-sharing-v1');
 CREATE FUNCTION mirror_legacy_workspace_mail_domain() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ohmyhost:resend-mail:domain:'||NEW.domain,0));
  IF EXISTS(SELECT 1 FROM workspace_mail_domains WHERE organization_id=NEW.organization_id AND domain=NEW.domain AND reputation_state='suspended') THEN RAISE EXCEPTION 'mail_domain_conflict' USING ERRCODE='23514'; END IF;
  INSERT INTO workspace_mail_domains(domain_id,organization_id,domain,legacy_domain_id,custody_organization_id,custody_project_id,custody_environment_id,configured_at)
   VALUES(NEW.domain_id,NEW.organization_id,NEW.domain,NEW.domain_id,NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.configured_at);
  INSERT INTO project_mail_domain_bindings(project_id,organization_id,environment_id,mail_domain_id,legacy,sending,configured_at,updated_at)
   VALUES(NEW.project_id,NEW.organization_id,NEW.environment_id,NEW.domain_id,true,NEW.sending,NEW.configured_at,NEW.configured_at)
   ON CONFLICT(project_id) DO UPDATE SET organization_id=EXCLUDED.organization_id,environment_id=EXCLUDED.environment_id,mail_domain_id=EXCLUDED.mail_domain_id,
    legacy=true,sending=EXCLUDED.sending,state='active',revision=project_mail_domain_bindings.revision+1,sender_addresses='[]',default_from=NULL,default_reply_to=NULL,application_identity_revision=NULL,updated_at=EXCLUDED.updated_at;
  RETURN NEW; END $$;
 INSERT INTO workspace_mail_domains(domain_id,organization_id,domain,legacy_domain_id,custody_organization_id,custody_project_id,custody_environment_id,configured_at)
  SELECT d.domain_id,d.organization_id,d.domain,d.domain_id,d.organization_id,d.project_id,d.environment_id,d.configured_at FROM resend_mail_domains d
  JOIN projects p ON p.project_id=d.project_id AND p.lifecycle_state='active'
  JOIN project_ownerships o ON o.project_id=d.project_id AND o.organization_id=d.organization_id AND o.state='active'
  WHERE d.deleted_at IS NULL;
 INSERT INTO project_mail_domain_bindings(project_id,organization_id,environment_id,mail_domain_id,legacy,sending,configured_at,updated_at)
  SELECT d.project_id,d.organization_id,d.environment_id,d.domain_id,true,d.sending,d.configured_at,d.configured_at FROM resend_mail_domains d
  JOIN workspace_mail_domains w ON w.legacy_domain_id=d.domain_id WHERE d.deleted_at IS NULL;
 CREATE TRIGGER mirror_legacy_workspace_mail AFTER INSERT ON resend_mail_domains FOR EACH ROW WHEN(NEW.deleted_at IS NULL) EXECUTE FUNCTION mirror_legacy_workspace_mail_domain();
 CREATE FUNCTION guard_shared_mail_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.state='active' AND NOT NEW.legacy AND NOT EXISTS(SELECT 1 FROM shared_mail_capabilities WHERE capability='same-domain-sharing-v1' AND enabled)
   THEN RAISE EXCEPTION 'mail_sharing_unavailable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM environments e JOIN projects p USING(project_id) JOIN project_ownerships o ON o.project_id=p.project_id AND o.organization_id=NEW.organization_id
   WHERE e.environment_id=NEW.environment_id AND e.name='prod' AND e.project_id=NEW.project_id AND e.organization_id=NEW.organization_id AND p.lifecycle_state='active' AND o.state='active')
   AND NEW.state='active' THEN RAISE EXCEPTION 'mail_scope_unavailable' USING ERRCODE='23514'; END IF;
  IF NEW.state='active' AND NOT NEW.legacy AND NOT EXISTS(SELECT 1 FROM project_application_domain_identities i JOIN workspace_mail_domains d ON d.domain_id=NEW.mail_domain_id AND d.organization_id=NEW.organization_id
   WHERE i.project_id=NEW.project_id AND i.organization_id=NEW.organization_id AND i.revision=NEW.application_identity_revision AND i.state='verified' AND i.expires_at>statement_timestamp() AND i.registrable_domain=d.registrable_domain AND d.status='active')
   THEN RAISE EXCEPTION 'mail_domain_mismatch' USING ERRCODE='23514'; END IF;
  IF NOT NEW.legacy AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.sender_addresses) address(value) JOIN workspace_mail_domains d ON d.domain_id=NEW.mail_domain_id
   WHERE address.value !~ '^[A-Za-z0-9._%+-]{1,64}@' OR split_part(address.value,'@',2)<>d.domain OR length(address.value)-length(replace(address.value,'@',''))<>1)
   THEN RAISE EXCEPTION 'invalid mail sender settings' USING ERRCODE='23514'; END IF;
  RETURN NEW; END $$;
 CREATE TRIGGER guard_project_mail_binding BEFORE INSERT OR UPDATE ON project_mail_domain_bindings FOR EACH ROW EXECUTE FUNCTION guard_shared_mail_binding();
 CREATE FUNCTION mark_mail_capabilities_dirty() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  UPDATE workspace_mail_domains SET capabilities_dirty=true WHERE domain_id=NEW.mail_domain_id;
  IF TG_OP='UPDATE' AND OLD.mail_domain_id<>NEW.mail_domain_id THEN UPDATE workspace_mail_domains SET capabilities_dirty=true WHERE domain_id=OLD.mail_domain_id; END IF;
  RETURN NEW; END $$;
 CREATE TRIGGER mark_mail_capabilities_dirty AFTER INSERT OR UPDATE ON project_mail_domain_bindings FOR EACH ROW EXECUTE FUNCTION mark_mail_capabilities_dirty();
 CREATE FUNCTION detach_inactive_project_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.lifecycle_state<>'active' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('ohmyhost:resend-mail:project:'||NEW.project_id::text,0));
   UPDATE project_mail_domain_bindings SET state='detached',sending=false,revision=revision+1,updated_at=statement_timestamp() WHERE project_id=NEW.project_id AND state<>'detached';
   UPDATE project_application_domain_identities SET state='revoked',revoked_at=statement_timestamp() WHERE project_id=NEW.project_id AND state<>'revoked';
  END IF; RETURN NEW; END $$;
 CREATE TRIGGER detach_inactive_project_mail AFTER UPDATE OF lifecycle_state ON projects FOR EACH ROW EXECUTE FUNCTION detach_inactive_project_mail();
 CREATE FUNCTION detach_transferred_project_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.state<>'active' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('ohmyhost:resend-mail:project:'||NEW.project_id::text,0));
   UPDATE project_mail_domain_bindings SET state='detached',sending=false,revision=revision+1,updated_at=statement_timestamp() WHERE project_id=NEW.project_id AND organization_id=NEW.organization_id AND state<>'detached';
   UPDATE project_application_domain_identities SET state='revoked',revoked_at=statement_timestamp() WHERE project_id=NEW.project_id AND organization_id=NEW.organization_id AND state<>'revoked';
  END IF; RETURN NEW; END $$;
 CREATE TRIGGER detach_transferred_project_mail AFTER UPDATE OF state ON project_ownerships FOR EACH ROW EXECUTE FUNCTION detach_transferred_project_mail();
 CREATE FUNCTION invalidate_changed_application_mail_domain() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF(TG_OP='UPDATE' AND(NEW.hostname IS DISTINCT FROM OLD.hostname OR(NEW.state IN ('deleting','deleted') AND OLD.state NOT IN ('deleting','deleted'))))
   OR EXISTS(SELECT 1 FROM project_application_domain_identities i WHERE i.organization_id=NEW.organization_id AND i.project_id=NEW.project_id AND i.state<>'revoked' AND NEW.hostname<>i.registrable_domain AND right(NEW.hostname,length(i.registrable_domain)+1)<>'.'||i.registrable_domain) THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('ohmyhost:resend-mail:project:'||NEW.project_id::text,0));
   UPDATE project_application_domain_identities SET state='revoked',revoked_at=statement_timestamp() WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND state<>'revoked';
   UPDATE project_mail_domain_bindings SET state='suspended',sending=false,revision=revision+1,updated_at=statement_timestamp() WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND NOT legacy AND state='active';
  END IF; RETURN NEW; END $$;
 CREATE TRIGGER invalidate_changed_application_mail_domain AFTER INSERT OR UPDATE OF hostname,state ON paid_project_domains FOR EACH ROW EXECUTE FUNCTION invalidate_changed_application_mail_domain();
 ALTER TABLE mail_send_requests ADD COLUMN mail_domain_id ulid REFERENCES workspace_mail_domains(domain_id),ADD COLUMN mail_binding_revision bigint,
  ADD COLUMN effective_from text,ADD COLUMN effective_reply_to text,ADD COLUMN request_input_sha256 bytea CHECK(request_input_sha256 IS NULL OR octet_length(request_input_sha256)=32);
 -- The existing terminal-row guard rejects even a new metadata column. The migration's
 -- transactional DDL lock admits only this proven additive attribution, then restores it.
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='mail_send_requests'::regclass AND tgname='mail_send_requests_guard' AND tgenabled='O' AND NOT tgisinternal)
  THEN RAISE EXCEPTION 'Expected enabled mail send identity guard'; END IF; END $$;
 ALTER TABLE mail_send_requests DISABLE TRIGGER mail_send_requests_guard;
 UPDATE mail_send_requests r SET mail_domain_id=w.domain_id FROM workspace_mail_domains w JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id
  WHERE r.mail_provider='resend' AND r.organization_id=d.organization_id AND r.project_id=d.project_id AND r.requested_at>=d.configured_at;
 ALTER TABLE mail_send_requests ENABLE TRIGGER mail_send_requests_guard;
 -- During schema-before-Worker rollout the previous Gateway still inserts its original
 -- columns. Attribute only its live original Resend custody; this grants no sending authority,
 -- resolves no defaults and changes no financial, identity or effective-message fields.
 CREATE FUNCTION attribute_legacy_mail_send_domain() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.mail_provider='resend' AND NEW.mail_domain_id IS NULL THEN
   SELECT w.domain_id INTO NEW.mail_domain_id FROM resend_mail_domains d
    JOIN workspace_mail_domains w ON w.legacy_domain_id=d.domain_id AND w.organization_id=d.organization_id AND w.status='active'
    JOIN project_ownerships o ON o.organization_id=d.organization_id AND o.project_id=d.project_id AND o.state='active'
    JOIN projects p ON p.project_id=d.project_id AND p.lifecycle_state='active'
    WHERE d.organization_id=NEW.organization_id AND d.project_id=NEW.project_id
     AND d.deleted_at IS NULL AND NEW.requested_at>=d.configured_at;
  END IF; RETURN NEW; END $$;
 CREATE TRIGGER attribute_legacy_mail_send_domain BEFORE INSERT ON mail_send_requests FOR EACH ROW EXECUTE FUNCTION attribute_legacy_mail_send_domain();
 UPDATE workspace_mail_domains w SET reputation_state='suspended',reputation_suspended_at=r.suspended_at,reputation_suspension_reason=r.suspension_reason,reputation_triggering_event_id=r.triggering_event_id
  FROM resend_mail_domains d JOIN mail_reputation_states r ON r.organization_id=d.organization_id AND r.project_id=d.project_id
  WHERE w.legacy_domain_id=d.domain_id AND r.state='suspended';
 CREATE FUNCTION guard_mail_sender_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.mail_domain_id,NEW.mail_binding_revision,NEW.effective_from,NEW.effective_reply_to,NEW.request_input_sha256) IS DISTINCT FROM ROW(OLD.mail_domain_id,OLD.mail_binding_revision,OLD.effective_from,OLD.effective_reply_to,OLD.request_input_sha256)
   THEN RAISE EXCEPTION 'mail sender snapshot is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER guard_mail_sender_snapshot BEFORE UPDATE ON mail_send_requests FOR EACH ROW EXECUTE FUNCTION guard_mail_sender_snapshot();
 DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
  GRANT SELECT,INSERT,UPDATE ON workspace_mail_domains,workspace_mail_commands,project_application_domain_identities,project_mail_domain_bindings TO control_runtime;
  GRANT SELECT,INSERT ON project_application_identity_commands TO control_runtime;
  GRANT SELECT,INSERT ON project_application_identity_action_commands TO control_runtime;
  GRANT SELECT,INSERT ON workspace_mail_reputation_decisions TO control_runtime;
  GRANT SELECT ON shared_mail_capabilities TO control_runtime;
 END IF; END $$;
 `);
}
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_application_domain_identities) OR EXISTS(SELECT 1 FROM project_mail_domain_bindings WHERE NOT legacy) OR EXISTS(SELECT 1 FROM workspace_mail_domains WHERE legacy_domain_id IS NULL) OR EXISTS(SELECT 1 FROM workspace_mail_commands) OR EXISTS(SELECT 1 FROM workspace_mail_reputation_decisions) OR EXISTS(SELECT 1 FROM mail_send_requests WHERE effective_from IS NOT NULL OR request_input_sha256 IS NOT NULL)
  OR EXISTS(SELECT 1 FROM resend_mail_domains d JOIN project_ownerships o USING(project_id) WHERE d.organization_id<>o.organization_id)
  OR EXISTS(SELECT 1 FROM resend_mail_commands d JOIN project_ownerships o USING(project_id) WHERE d.organization_id<>o.organization_id)
  OR EXISTS(SELECT 1 FROM mail_send_requests d JOIN project_ownerships o USING(project_id) WHERE d.organization_id<>o.organization_id)
  OR EXISTS(SELECT 1 FROM mail_gateway_keys d JOIN project_ownerships o USING(project_id) WHERE d.organization_id<>o.organization_id)
  OR EXISTS(SELECT 1 FROM mail_credit_accounts d JOIN project_ownerships o USING(project_id) WHERE d.organization_id<>o.organization_id)
  THEN RAISE EXCEPTION 'Shared mail evidence prevents rollback'; END IF; END $$;
 DROP TRIGGER detach_transferred_project_mail ON project_ownerships;DROP FUNCTION detach_transferred_project_mail();
 DROP TRIGGER detach_inactive_project_mail ON projects;DROP FUNCTION detach_inactive_project_mail();
 DROP TRIGGER mirror_legacy_workspace_mail ON resend_mail_domains;DROP FUNCTION mirror_legacy_workspace_mail_domain();
 DROP TRIGGER guard_project_mail_binding ON project_mail_domain_bindings;DROP FUNCTION guard_shared_mail_binding();
 DROP TRIGGER mark_mail_capabilities_dirty ON project_mail_domain_bindings;DROP FUNCTION mark_mail_capabilities_dirty();
 DROP TRIGGER guard_workspace_mail_identity ON workspace_mail_domains;DROP FUNCTION guard_workspace_mail_identity();
 DROP TRIGGER guard_application_mail_identity ON project_application_domain_identities;DROP FUNCTION guard_application_mail_identity();
 DROP TRIGGER invalidate_changed_application_mail_domain ON paid_project_domains;DROP FUNCTION invalidate_changed_application_mail_domain();
 DROP TRIGGER guard_mail_sender_snapshot ON mail_send_requests;DROP FUNCTION guard_mail_sender_snapshot();
 DROP TRIGGER attribute_legacy_mail_send_domain ON mail_send_requests;DROP FUNCTION attribute_legacy_mail_send_domain();
 ALTER TABLE mail_send_requests DROP COLUMN mail_domain_id,DROP COLUMN mail_binding_revision,DROP COLUMN effective_from,DROP COLUMN effective_reply_to,DROP COLUMN request_input_sha256;
 DROP TABLE shared_mail_capabilities,workspace_mail_reputation_decisions,workspace_mail_commands,project_mail_domain_bindings,project_application_identity_action_commands,project_application_identity_commands,project_application_domain_identities,workspace_mail_domains;`);
  pgm.sql(`ALTER TABLE resend_mail_domains DROP CONSTRAINT resend_mail_domains_stable_project_fkey,
   ADD CONSTRAINT resend_mail_domains_organization_id_project_id_fkey FOREIGN KEY(organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id),
   ADD CONSTRAINT resend_mail_domains_organization_id_environment_id_fkey FOREIGN KEY(organization_id,environment_id) REFERENCES environments(organization_id,environment_id);
  ALTER TABLE resend_mail_commands ADD CONSTRAINT resend_mail_commands_organization_id_environment_id_fkey FOREIGN KEY(organization_id,environment_id) REFERENCES environments(organization_id,environment_id);
  ALTER TABLE mail_send_requests DROP CONSTRAINT mail_send_requests_stable_project_fkey,ADD CONSTRAINT mail_send_requests_owner_fkey FOREIGN KEY(organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id);
  ALTER TABLE mail_gateway_keys DROP CONSTRAINT mail_gateway_keys_stable_project_fkey,ADD CONSTRAINT mail_gateway_keys_owner_fkey FOREIGN KEY(organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id);
  ALTER TABLE mail_credit_accounts DROP CONSTRAINT mail_credit_accounts_stable_project_fkey,ADD CONSTRAINT mail_credit_accounts_ownership_fkey FOREIGN KEY(organization_id,project_id) REFERENCES project_ownerships(organization_id,project_id);`);
}
