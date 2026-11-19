-- W32 original142/150/199 domain, command, custody, sender-binding and application-proof facts.
-- Empty prototype preparation only. Historical ciphertext/AAD, identities and proof bytes are never rewritten.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE mail_manager_empty_guard_0466(value INTEGER NOT NULL CHECK(value=0)) STRICT;
INSERT INTO mail_manager_empty_guard_0466 SELECT 1 WHERE EXISTS(SELECT 1 FROM resend_mail_domains) OR EXISTS(SELECT 1 FROM resend_mail_commands) OR EXISTS(SELECT 1 FROM workspace_mail_domains) OR EXISTS(SELECT 1 FROM workspace_mail_commands) OR EXISTS(SELECT 1 FROM project_application_domain_identities) OR EXISTS(SELECT 1 FROM project_application_identity_commands) OR EXISTS(SELECT 1 FROM project_application_identity_action_commands) OR EXISTS(SELECT 1 FROM project_mail_domain_bindings);
DROP TABLE project_mail_domain_bindings;
DROP TABLE project_application_identity_action_commands;
DROP TABLE project_application_identity_commands;
DROP TABLE project_application_domain_identities;
DROP TABLE workspace_mail_commands;
DROP TABLE workspace_mail_domains;
DROP TABLE resend_mail_commands;
DROP TABLE resend_mail_domains;

CREATE TABLE resend_mail_domains (
 domain_id TEXT NOT NULL CHECK(length(domain_id)=26 AND length(CAST(domain_id AS BLOB))=26 AND substr(domain_id,1,1) BETWEEN '0' AND '7' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 domain TEXT NOT NULL CHECK(instr(domain,char(0))=0),
 provider_domain_id TEXT CHECK(provider_domain_id IS NULL OR (instr(provider_domain_id,char(0))=0)),
 provider_claimed_at TEXT CHECK(provider_claimed_at IS NULL OR (length(provider_claimed_at)=27 AND length(CAST(provider_claimed_at AS BLOB))=27 AND provider_claimed_at GLOB '????-??-??T??:??:??.??????Z')),
 provider_preflight_at TEXT CHECK(provider_preflight_at IS NULL OR (length(provider_preflight_at)=27 AND length(CAST(provider_preflight_at AS BLOB))=27 AND provider_preflight_at GLOB '????-??-??T??:??:??.??????Z')),
 verify_requested_at TEXT CHECK(verify_requested_at IS NULL OR (length(verify_requested_at)=27 AND length(CAST(verify_requested_at AS BLOB))=27 AND verify_requested_at GLOB '????-??-??T??:??:??.??????Z')),
 sending_key_id TEXT CHECK(sending_key_id IS NULL OR (instr(sending_key_id,char(0))=0)),
 sending_key_claimed_at TEXT CHECK(sending_key_claimed_at IS NULL OR (length(sending_key_claimed_at)=27 AND length(CAST(sending_key_claimed_at AS BLOB))=27 AND sending_key_claimed_at GLOB '????-??-??T??:??:??.??????Z')),
 sending_key_ciphertext BLOB,
 sending_key_nonce BLOB,
 sending_key_sha256 BLOB,
 sending_key_version INTEGER CHECK(sending_key_version IS NULL OR (sending_key_version BETWEEN -2147483648 AND 2147483647)),
 sending INTEGER DEFAULT 1 NOT NULL CHECK(sending IN(0,1)),
 receiving INTEGER DEFAULT 0 NOT NULL CHECK(receiving IN(0,1)),
 receiving_suspended INTEGER DEFAULT 0 NOT NULL CHECK(receiving_suspended IN(0,1)),
 last_entitlement_check_at TEXT CHECK(last_entitlement_check_at IS NULL OR (length(last_entitlement_check_at)=27 AND length(CAST(last_entitlement_check_at AS BLOB))=27 AND last_entitlement_check_at GLOB '????-??-??T??:??:??.??????Z')),
 last_reconcile_at TEXT CHECK(last_reconcile_at IS NULL OR (length(last_reconcile_at)=27 AND length(CAST(last_reconcile_at AS BLOB))=27 AND last_reconcile_at GLOB '????-??-??T??:??:??.??????Z')),
 sending_status TEXT DEFAULT 'pending' NOT NULL CHECK(instr(sending_status,char(0))=0),
 receiving_status TEXT DEFAULT 'disabled' NOT NULL CHECK(instr(receiving_status,char(0))=0),
 records TEXT DEFAULT '[]' NOT NULL CHECK(json_valid(records)),
 dns_receipts TEXT DEFAULT '{}' NOT NULL CHECK(json_valid(dns_receipts)),
 webhook_url TEXT CHECK(webhook_url IS NULL OR (instr(webhook_url,char(0))=0)),
 webhook_verified_at TEXT CHECK(webhook_verified_at IS NULL OR (length(webhook_verified_at)=27 AND length(CAST(webhook_verified_at AS BLOB))=27 AND webhook_verified_at GLOB '????-??-??T??:??:??.??????Z')),
 configured_at TEXT NOT NULL CHECK(length(configured_at)=27 AND length(CAST(configured_at AS BLOB))=27 AND configured_at GLOB '????-??-??T??:??:??.??????Z'),
 observed_at TEXT CHECK(observed_at IS NULL OR (length(observed_at)=27 AND length(CAST(observed_at AS BLOB))=27 AND observed_at GLOB '????-??-??T??:??:??.??????Z')),
 deleted_at TEXT CHECK(deleted_at IS NULL OR (length(deleted_at)=27 AND length(CAST(deleted_at AS BLOB))=27 AND deleted_at GLOB '????-??-??T??:??:??.??????Z')),
 PRIMARY KEY(domain_id),
 UNIQUE(domain_id,organization_id,project_id,environment_id),
 UNIQUE(provider_domain_id),
 UNIQUE(sending_key_id),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id),
 FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
 CHECK(sending_status IN('disabled','pending','ready','failed') AND receiving_status IN('disabled','pending','ready','failed')),
 CHECK(NOT receiving OR(webhook_url IS NOT NULL AND webhook_verified_at IS NOT NULL)),
 CHECK(NOT receiving OR sending),
 CHECK((sending_key_id IS NULL AND sending_key_ciphertext IS NULL AND sending_key_nonce IS NULL AND sending_key_sha256 IS NULL AND sending_key_version IS NULL) OR(sending_key_id IS NOT NULL AND sending_key_ciphertext IS NOT NULL AND sending_key_nonce IS NOT NULL AND length(sending_key_nonce)=12 AND sending_key_sha256 IS NOT NULL AND length(sending_key_sha256)=32 AND sending_key_version IS NOT NULL AND sending_key_version>0)),
 CHECK(json_type(records)='array' AND json_type(dns_receipts)='object'),
 CHECK(domain=lower(domain) AND length(domain)>=3 AND substr(domain,1,1) GLOB '[a-z0-9]' AND substr(domain,-1,1) GLOB '[a-z]' AND domain NOT GLOB '*[^a-z0-9.-]*'),
 CHECK(webhook_url IS NULL OR substr(webhook_url,1,8)='https://')
) STRICT, WITHOUT ROWID;

CREATE TABLE resend_mail_commands (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 idempotency_key TEXT NOT NULL CHECK(instr(idempotency_key,char(0))=0),
 request_sha256 BLOB NOT NULL,
 response TEXT CHECK(response IS NULL OR (json_valid(response))),
 created_at TEXT NOT NULL CHECK(length(created_at)=27 AND length(CAST(created_at AS BLOB))=27 AND created_at GLOB '????-??-??T??:??:??.??????Z'),
 completed_at TEXT CHECK(completed_at IS NULL OR (length(completed_at)=27 AND length(CAST(completed_at AS BLOB))=27 AND completed_at GLOB '????-??-??T??:??:??.??????Z')),
 lease_until TEXT CHECK(lease_until IS NULL OR (length(lease_until)=27 AND length(CAST(lease_until AS BLOB))=27 AND lease_until GLOB '????-??-??T??:??:??.??????Z')),
 claimed_attempt INTEGER CHECK(claimed_attempt IS NULL OR (claimed_attempt BETWEEN -2147483648 AND 2147483647)),
 domain_id TEXT CHECK(domain_id IS NULL OR (length(domain_id)=26 AND length(CAST(domain_id AS BLOB))=26 AND substr(domain_id,1,1) BETWEEN '0' AND '7' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 PRIMARY KEY(organization_id,project_id,environment_id,idempotency_key),
 FOREIGN KEY(domain_id) REFERENCES resend_mail_domains(domain_id),
 FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
 CHECK(claimed_attempt BETWEEN 1 AND 4),
 CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 CHECK(length(request_sha256)=32)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_mail_domains (
 domain_id TEXT NOT NULL CHECK(length(domain_id)=26 AND length(CAST(domain_id AS BLOB))=26 AND substr(domain_id,1,1) BETWEEN '0' AND '7' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 domain TEXT NOT NULL CHECK(instr(domain,char(0))=0),
 registrable_domain TEXT CHECK(registrable_domain IS NULL OR (instr(registrable_domain,char(0))=0)),
 legacy_domain_id TEXT CHECK(legacy_domain_id IS NULL OR (length(legacy_domain_id)=26 AND length(CAST(legacy_domain_id AS BLOB))=26 AND substr(legacy_domain_id,1,1) BETWEEN '0' AND '7' AND legacy_domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 custody_organization_id TEXT NOT NULL CHECK(length(custody_organization_id)=26 AND length(CAST(custody_organization_id AS BLOB))=26 AND substr(custody_organization_id,1,1) BETWEEN '0' AND '7' AND custody_organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 custody_project_id TEXT NOT NULL CHECK(length(custody_project_id)=26 AND length(CAST(custody_project_id AS BLOB))=26 AND substr(custody_project_id,1,1) BETWEEN '0' AND '7' AND custody_project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 custody_environment_id TEXT NOT NULL CHECK(length(custody_environment_id)=26 AND length(CAST(custody_environment_id AS BLOB))=26 AND substr(custody_environment_id,1,1) BETWEEN '0' AND '7' AND custody_environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 revision INTEGER DEFAULT 1 NOT NULL,
 status TEXT DEFAULT 'active' NOT NULL CHECK(instr(status,char(0))=0),
 reputation_state TEXT DEFAULT 'active' NOT NULL CHECK(instr(reputation_state,char(0))=0),
 reputation_suspended_at TEXT CHECK(reputation_suspended_at IS NULL OR (length(reputation_suspended_at)=27 AND length(CAST(reputation_suspended_at AS BLOB))=27 AND reputation_suspended_at GLOB '????-??-??T??:??:??.??????Z')),
 reputation_suspension_reason TEXT CHECK(reputation_suspension_reason IS NULL OR (instr(reputation_suspension_reason,char(0))=0)),
 reputation_triggering_event_id TEXT CHECK(reputation_triggering_event_id IS NULL OR (length(reputation_triggering_event_id)=36 AND length(CAST(reputation_triggering_event_id AS BLOB))=36 AND substr(reputation_triggering_event_id,9,1)='-' AND substr(reputation_triggering_event_id,14,1)='-' AND substr(reputation_triggering_event_id,19,1)='-' AND substr(reputation_triggering_event_id,24,1)='-' AND length(replace(reputation_triggering_event_id,'-',''))=32 AND replace(reputation_triggering_event_id,'-','') NOT GLOB '*[^0-9a-f]*')),
 reputation_version INTEGER DEFAULT 1 NOT NULL,
 capabilities_lease_until TEXT CHECK(capabilities_lease_until IS NULL OR (length(capabilities_lease_until)=27 AND length(CAST(capabilities_lease_until AS BLOB))=27 AND capabilities_lease_until GLOB '????-??-??T??:??:??.??????Z')),
 capabilities_lease_token TEXT CHECK(capabilities_lease_token IS NULL OR (length(capabilities_lease_token)=26 AND length(CAST(capabilities_lease_token AS BLOB))=26 AND substr(capabilities_lease_token,1,1) BETWEEN '0' AND '7' AND capabilities_lease_token NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')),
 last_reconcile_at TEXT CHECK(last_reconcile_at IS NULL OR (length(last_reconcile_at)=27 AND length(CAST(last_reconcile_at AS BLOB))=27 AND last_reconcile_at GLOB '????-??-??T??:??:??.??????Z')),
 capabilities_dirty INTEGER DEFAULT 1 NOT NULL CHECK(capabilities_dirty IN(0,1)),
 provider_domain_id TEXT CHECK(provider_domain_id IS NULL OR (instr(provider_domain_id,char(0))=0)),
 provider_claimed_at TEXT CHECK(provider_claimed_at IS NULL OR (length(provider_claimed_at)=27 AND length(CAST(provider_claimed_at AS BLOB))=27 AND provider_claimed_at GLOB '????-??-??T??:??:??.??????Z')),
 provider_preflight_at TEXT CHECK(provider_preflight_at IS NULL OR (length(provider_preflight_at)=27 AND length(CAST(provider_preflight_at AS BLOB))=27 AND provider_preflight_at GLOB '????-??-??T??:??:??.??????Z')),
 verify_requested_at TEXT CHECK(verify_requested_at IS NULL OR (length(verify_requested_at)=27 AND length(CAST(verify_requested_at AS BLOB))=27 AND verify_requested_at GLOB '????-??-??T??:??:??.??????Z')),
 sending_key_id TEXT CHECK(sending_key_id IS NULL OR (instr(sending_key_id,char(0))=0)),
 sending_key_claimed_at TEXT CHECK(sending_key_claimed_at IS NULL OR (length(sending_key_claimed_at)=27 AND length(CAST(sending_key_claimed_at AS BLOB))=27 AND sending_key_claimed_at GLOB '????-??-??T??:??:??.??????Z')),
 sending_key_ciphertext BLOB,
 sending_key_nonce BLOB,
 sending_key_sha256 BLOB,
 sending_key_version INTEGER CHECK(sending_key_version IS NULL OR (sending_key_version BETWEEN -2147483648 AND 2147483647)),
 sending_status TEXT DEFAULT 'pending' NOT NULL CHECK(instr(sending_status,char(0))=0),
 receiving_status TEXT DEFAULT 'disabled' NOT NULL CHECK(instr(receiving_status,char(0))=0),
 records TEXT DEFAULT '[]' NOT NULL CHECK(json_valid(records)),
 dns_receipts TEXT DEFAULT '{}' NOT NULL CHECK(json_valid(dns_receipts)),
 configured_at TEXT NOT NULL CHECK(length(configured_at)=27 AND length(CAST(configured_at AS BLOB))=27 AND configured_at GLOB '????-??-??T??:??:??.??????Z'),
 observed_at TEXT CHECK(observed_at IS NULL OR (length(observed_at)=27 AND length(CAST(observed_at AS BLOB))=27 AND observed_at GLOB '????-??-??T??:??:??.??????Z')),
 retired_at TEXT CHECK(retired_at IS NULL OR (length(retired_at)=27 AND length(CAST(retired_at AS BLOB))=27 AND retired_at GLOB '????-??-??T??:??:??.??????Z')),
 PRIMARY KEY(domain_id),
 UNIQUE(domain_id,organization_id),
 UNIQUE(legacy_domain_id),
 UNIQUE(provider_domain_id),
 UNIQUE(sending_key_id),
 FOREIGN KEY(legacy_domain_id) REFERENCES resend_mail_domains(domain_id),
 CHECK(registrable_domain IS NOT NULL OR legacy_domain_id IS NOT NULL),
 CHECK(custody_organization_id=organization_id),
 CHECK((reputation_state='active' AND reputation_suspended_at IS NULL AND reputation_suspension_reason IS NULL AND reputation_triggering_event_id IS NULL) OR(reputation_state='suspended' AND reputation_suspended_at IS NOT NULL AND reputation_suspension_reason IS NOT NULL AND reputation_suspension_reason IN('bounce_rate','complaint_rate') AND reputation_triggering_event_id IS NOT NULL)),
 CHECK((sending_key_id IS NULL AND sending_key_ciphertext IS NULL AND sending_key_nonce IS NULL AND sending_key_sha256 IS NULL AND sending_key_version IS NULL) OR(sending_key_id IS NOT NULL AND sending_key_ciphertext IS NOT NULL AND length(sending_key_ciphertext)>=17 AND sending_key_nonce IS NOT NULL AND length(sending_key_nonce)=12 AND sending_key_sha256 IS NOT NULL AND length(sending_key_sha256)=32 AND sending_key_version IS NOT NULL AND sending_key_version>0)),
 CHECK(json_type(dns_receipts)='object'),
 CHECK(domain=lower(domain)),
 CHECK(receiving_status IN('disabled','pending','ready','failed')),
 CHECK(json_type(records)='array'),
 CHECK(reputation_state IN('active','suspended')),
 CHECK(reputation_version>0),
 CHECK(revision>0),
 CHECK(sending_status IN('disabled','pending','ready','failed')),
 CHECK(status IN('active','retiring','retired'))
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_mail_commands (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 idempotency_key TEXT NOT NULL CHECK(instr(idempotency_key,char(0))=0),
 domain_id TEXT NOT NULL CHECK(length(domain_id)=26 AND length(CAST(domain_id AS BLOB))=26 AND substr(domain_id,1,1) BETWEEN '0' AND '7' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 operation TEXT NOT NULL CHECK(instr(operation,char(0))=0),
 principal_id TEXT NOT NULL CHECK(instr(principal_id,char(0))=0),
 request_sha256 BLOB NOT NULL,
 response TEXT CHECK(response IS NULL OR (json_valid(response))),
 created_at TEXT NOT NULL CHECK(length(created_at)=27 AND length(CAST(created_at AS BLOB))=27 AND created_at GLOB '????-??-??T??:??:??.??????Z'),
 completed_at TEXT CHECK(completed_at IS NULL OR (length(completed_at)=27 AND length(CAST(completed_at AS BLOB))=27 AND completed_at GLOB '????-??-??T??:??:??.??????Z')),
 lease_until TEXT CHECK(lease_until IS NULL OR (length(lease_until)=27 AND length(CAST(lease_until AS BLOB))=27 AND lease_until GLOB '????-??-??T??:??:??.??????Z')),
 claimed_attempt INTEGER CHECK(claimed_attempt IS NULL OR (claimed_attempt BETWEEN -2147483648 AND 2147483647)),
 PRIMARY KEY(organization_id,idempotency_key),
 FOREIGN KEY(domain_id,organization_id) REFERENCES workspace_mail_domains(domain_id,organization_id),
 CHECK(claimed_attempt BETWEEN 1 AND 4),
 CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 CHECK(length(request_sha256)=32)
) STRICT, WITHOUT ROWID;

CREATE TABLE project_application_domain_identities (
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 hostname TEXT NOT NULL CHECK(instr(hostname,char(0))=0),
 registrable_domain TEXT NOT NULL CHECK(instr(registrable_domain,char(0))=0),
 revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(instr(state,char(0))=0),
 challenge_name TEXT NOT NULL CHECK(instr(challenge_name,char(0))=0),
 challenge_value TEXT NOT NULL CHECK(instr(challenge_value,char(0))=0),
 declared_at TEXT NOT NULL CHECK(length(declared_at)=27 AND length(CAST(declared_at AS BLOB))=27 AND declared_at GLOB '????-??-??T??:??:??.??????Z'),
 verified_at TEXT CHECK(verified_at IS NULL OR (length(verified_at)=27 AND length(CAST(verified_at AS BLOB))=27 AND verified_at GLOB '????-??-??T??:??:??.??????Z')),
 expires_at TEXT NOT NULL CHECK(length(expires_at)=27 AND length(CAST(expires_at AS BLOB))=27 AND expires_at GLOB '????-??-??T??:??:??.??????Z'),
 revoked_at TEXT CHECK(revoked_at IS NULL OR (length(revoked_at)=27 AND length(CAST(revoked_at AS BLOB))=27 AND revoked_at GLOB '????-??-??T??:??:??.??????Z')),
 automatic_revalidation_attempted_at TEXT CHECK(automatic_revalidation_attempted_at IS NULL OR (length(automatic_revalidation_attempted_at)=27 AND length(CAST(automatic_revalidation_attempted_at AS BLOB))=27 AND automatic_revalidation_attempted_at GLOB '????-??-??T??:??:??.??????Z')),
 idempotency_key_sha256 BLOB NOT NULL,
 request_sha256 BLOB NOT NULL,
 actor_id TEXT NOT NULL CHECK(instr(actor_id,char(0))=0),
 PRIMARY KEY(project_id),
 UNIQUE(project_id,organization_id,revision),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id),
 CHECK(length(idempotency_key_sha256)=32),
 CHECK(length(challenge_value) BETWEEN 32 AND 128),
 CHECK(hostname=lower(hostname) AND challenge_name='_omh-project.'||hostname),
 CHECK(state<>'verified' OR(verified_at IS NOT NULL AND expires_at>verified_at)),
 CHECK(length(request_sha256)=32),
 CHECK(revision>0),
 CHECK(state IN('pending','verified','revoked'))
) STRICT, WITHOUT ROWID;

CREATE TABLE project_application_identity_commands (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 idempotency_key_sha256 BLOB NOT NULL,
 request_sha256 BLOB NOT NULL,
 response TEXT NOT NULL CHECK(json_valid(response)),
 PRIMARY KEY(organization_id,project_id,idempotency_key_sha256),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id),
 CHECK(length(idempotency_key_sha256)=32),
 CHECK(length(request_sha256)=32)
) STRICT, WITHOUT ROWID;

CREATE TABLE project_application_identity_action_commands (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 actor_id TEXT NOT NULL CHECK(instr(actor_id,char(0))=0),
 action TEXT NOT NULL CHECK(instr(action,char(0))=0),
 idempotency_key_sha256 BLOB NOT NULL,
 request_sha256 BLOB NOT NULL,
 response TEXT NOT NULL CHECK(json_valid(response)),
 PRIMARY KEY(organization_id,project_id,actor_id,action,idempotency_key_sha256),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id),
 CHECK(length(idempotency_key_sha256)=32),
 CHECK(length(request_sha256)=32),
 CHECK(action IN('verify','revoke'))
) STRICT, WITHOUT ROWID;

CREATE TABLE project_mail_domain_bindings (
 project_id TEXT NOT NULL CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT NOT NULL CHECK(length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 mail_domain_id TEXT NOT NULL CHECK(length(mail_domain_id)=26 AND length(CAST(mail_domain_id AS BLOB))=26 AND substr(mail_domain_id,1,1) BETWEEN '0' AND '7' AND mail_domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 revision INTEGER DEFAULT 1 NOT NULL,
 state TEXT DEFAULT 'active' NOT NULL CHECK(instr(state,char(0))=0),
 sending INTEGER DEFAULT 1 NOT NULL CHECK(sending IN(0,1)),
 legacy INTEGER DEFAULT 0 NOT NULL CHECK(legacy IN(0,1)),
 sender_addresses TEXT DEFAULT '[]' NOT NULL CHECK(json_valid(sender_addresses)),
 default_from TEXT CHECK(default_from IS NULL OR (instr(default_from,char(0))=0)),
 default_reply_to TEXT CHECK(default_reply_to IS NULL OR (instr(default_reply_to,char(0))=0)),
 application_identity_revision INTEGER,
 configured_at TEXT NOT NULL CHECK(length(configured_at)=27 AND length(CAST(configured_at AS BLOB))=27 AND configured_at GLOB '????-??-??T??:??:??.??????Z'),
 updated_at TEXT NOT NULL CHECK(length(updated_at)=27 AND length(CAST(updated_at AS BLOB))=27 AND updated_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(project_id),
 FOREIGN KEY(mail_domain_id,organization_id) REFERENCES workspace_mail_domains(domain_id,organization_id),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id),
 FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
 CHECK(legacy OR(application_identity_revision IS NOT NULL AND json_array_length(sender_addresses) BETWEEN 1 AND 32 AND default_from IS NOT NULL)),
 CHECK(revision>0),
 CHECK(json_type(sender_addresses)='array'),
 CHECK(state IN('active','detached','suspended'))
) STRICT, WITHOUT ROWID;

-- Retain the qualified static named identities already referenced by original Mail families.
CREATE UNIQUE INDEX resend_mail_domains_global_domain_id ON resend_mail_domains(domain_id);
CREATE UNIQUE INDEX resend_mail_domains_original_scope ON resend_mail_domains(domain_id,organization_id,project_id,environment_id);
-- The pre0470 prototype child still names this pair; global domain_id already implies its uniqueness.
CREATE UNIQUE INDEX resend_mail_domains_received_compat_scope ON resend_mail_domains(organization_id,domain_id);
CREATE UNIQUE INDEX workspace_mail_domains_global_domain_id ON workspace_mail_domains(domain_id);
CREATE UNIQUE INDEX workspace_mail_domains_original_scope ON workspace_mail_domains(domain_id,organization_id);
CREATE UNIQUE INDEX project_mail_domain_bindings_global_project ON project_mail_domain_bindings(project_id);
CREATE UNIQUE INDEX project_application_domain_identities_global_project ON project_application_domain_identities(project_id);
CREATE UNIQUE INDEX resend_mail_domain_live_name ON resend_mail_domains(domain) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX resend_mail_domain_live_project ON resend_mail_domains(project_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX workspace_mail_domain_live_name ON workspace_mail_domains(domain) WHERE status<>'retired';
CREATE INDEX project_mail_domain_active_refs ON project_mail_domain_bindings(mail_domain_id) WHERE state='active';
CREATE INDEX application_mail_identity_revalidation_due ON project_application_domain_identities(expires_at,project_id) WHERE state='verified';
CREATE TRIGGER resend_domain_identity BEFORE UPDATE ON resend_mail_domains
WHEN NEW.domain_id IS NOT OLD.domain_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
 OR NEW.environment_id IS NOT OLD.environment_id OR NEW.domain IS NOT OLD.domain OR NEW.configured_at IS NOT OLD.configured_at
 OR(OLD.provider_domain_id IS NOT NULL AND NEW.provider_domain_id IS NOT OLD.provider_domain_id)
 OR(OLD.sending_key_id IS NOT NULL AND NEW.sending_key_id IS NOT OLD.sending_key_id)
 OR(OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
BEGIN SELECT RAISE(ABORT,'mail domain ownership is immutable'); END;
CREATE TRIGGER resend_prod_environment BEFORE INSERT ON resend_mail_domains
WHEN NOT EXISTS(SELECT 1 FROM environment_identities e WHERE e.environment_id=NEW.environment_id AND e.project_id=NEW.project_id AND e.name='prod')
BEGIN SELECT RAISE(ABORT,'mail domain must belong to project production environment'); END;
CREATE TRIGGER guard_workspace_mail_identity BEFORE UPDATE ON workspace_mail_domains
WHEN NEW.domain_id IS NOT OLD.domain_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.domain IS NOT OLD.domain
 OR NEW.legacy_domain_id IS NOT OLD.legacy_domain_id OR NEW.custody_organization_id IS NOT OLD.custody_organization_id
 OR NEW.custody_project_id IS NOT OLD.custody_project_id OR NEW.custody_environment_id IS NOT OLD.custody_environment_id OR NEW.configured_at IS NOT OLD.configured_at
 OR(OLD.provider_domain_id IS NOT NULL AND NEW.provider_domain_id IS NOT OLD.provider_domain_id)
 OR(OLD.sending_key_id IS NOT NULL AND(NEW.sending_key_id IS NOT OLD.sending_key_id OR NEW.sending_key_ciphertext IS NOT OLD.sending_key_ciphertext
  OR NEW.sending_key_nonce IS NOT OLD.sending_key_nonce OR NEW.sending_key_sha256 IS NOT OLD.sending_key_sha256 OR NEW.sending_key_version IS NOT OLD.sending_key_version))
 OR(OLD.registrable_domain IS NOT NULL AND NEW.registrable_domain IS NOT OLD.registrable_domain)
 OR(OLD.status='retired' AND NEW.status<>'retired')
BEGIN SELECT RAISE(ABORT,'workspace mail domain identity is immutable'); END;
DROP TRIGGER core_historical_import_open;
CREATE TRIGGER core_historical_import_open BEFORE INSERT ON core_historical_import
BEGIN
  SELECT RAISE(ABORT,'an ever-activated authority can never open historical import') WHERE EXISTS(SELECT 1 FROM core_authority_activation);
  SELECT RAISE(ABORT,'historical import begins loading, never already qualified')
    WHERE NEW.closed_at IS NOT NULL OR NEW.comparison_sha256 IS NOT NULL OR NEW.restored_runtime_schema_sha256 IS NOT NULL;
  SELECT RAISE(ABORT,'historical temporal admission has a closed exact table allowlist')
    WHERE EXISTS(SELECT 1 FROM json_each(NEW.temporal_tables) WHERE type<>'text' OR value NOT IN (
      'wfp_candidate_receipts','wfp_candidate_cleanup_receipts','wfp_publish_receipts','wfp_rollback_activation_receipts','runtime_secret_delivery_stage_activations','operations','environment_data_assignments','mail_credit_accounts','mail_credit_ledger','project_mail_domain_bindings'))
      OR (SELECT count(*) FROM json_each(NEW.temporal_tables))<>(SELECT count(DISTINCT value) FROM json_each(NEW.temporal_tables));
END;

CREATE TRIGGER guard_project_mail_binding_insert BEFORE INSERT ON project_mail_domain_bindings
BEGIN
 SELECT RAISE(ABORT,'mail_sharing_unavailable') WHERE NOT(EXISTS(SELECT 1 FROM core_historical_import i,json_each(i.temporal_tables) family WHERE i.closed_at IS NULL AND family.type='text' AND family.value='project_mail_domain_bindings') AND NOT EXISTS(SELECT 1 FROM core_authority_activation)) AND NEW.state='active' AND NOT NEW.legacy
  AND NOT EXISTS(SELECT 1 FROM shared_mail_capabilities WHERE capability='same-domain-sharing-v1' AND enabled);
 SELECT RAISE(ABORT,'mail_scope_unavailable') WHERE NOT(EXISTS(SELECT 1 FROM core_historical_import i,json_each(i.temporal_tables) family WHERE i.closed_at IS NULL AND family.type='text' AND family.value='project_mail_domain_bindings') AND NOT EXISTS(SELECT 1 FROM core_authority_activation)) AND NEW.state='active' AND NOT EXISTS(
  SELECT 1 FROM environments e JOIN projects p ON p.organization_id=NEW.organization_id AND p.project_id=NEW.project_id
  WHERE e.organization_id=NEW.organization_id AND e.project_id=NEW.project_id AND e.environment_id=NEW.environment_id AND e.name='prod'
   AND p.owner_state='active' AND p.lifecycle_state='active');
 SELECT RAISE(ABORT,'mail_domain_mismatch') WHERE NOT(EXISTS(SELECT 1 FROM core_historical_import i,json_each(i.temporal_tables) family WHERE i.closed_at IS NULL AND family.type='text' AND family.value='project_mail_domain_bindings') AND NOT EXISTS(SELECT 1 FROM core_authority_activation)) AND NEW.state='active' AND NOT NEW.legacy AND NOT EXISTS(
  SELECT 1 FROM project_application_domain_identities i JOIN workspace_mail_domains w ON w.domain_id=NEW.mail_domain_id AND w.organization_id=NEW.organization_id
  WHERE i.project_id=NEW.project_id AND i.organization_id=NEW.organization_id AND i.revision=NEW.application_identity_revision
   AND i.state='verified' AND i.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND i.registrable_domain=w.registrable_domain AND w.status='active');
 -- These original static value checks never recognize the historical context.
 SELECT RAISE(ABORT,'invalid mail sender settings') WHERE NOT NEW.legacy AND NOT EXISTS(SELECT 1 FROM json_each(NEW.sender_addresses) address WHERE address.type='text' AND address.value=NEW.default_from);
 SELECT RAISE(ABORT,'invalid mail sender settings') WHERE NOT NEW.legacy AND EXISTS(
  SELECT 1 FROM json_each(NEW.sender_addresses) address JOIN workspace_mail_domains w ON w.domain_id=NEW.mail_domain_id
  WHERE instr(CAST(address.value AS TEXT),'@') NOT BETWEEN 2 AND 65 OR substr(CAST(address.value AS TEXT),1,instr(CAST(address.value AS TEXT),'@')-1) GLOB '*[^A-Za-z0-9._%+-]*'
   OR substr(CAST(address.value AS TEXT),instr(CAST(address.value AS TEXT),'@')+1)<>w.domain
   OR length(CAST(address.value AS TEXT))-length(replace(CAST(address.value AS TEXT),'@',''))<>1);
END;

CREATE TRIGGER guard_project_mail_binding_update BEFORE UPDATE ON project_mail_domain_bindings
BEGIN
 SELECT RAISE(ABORT,'mail_sharing_unavailable') WHERE NEW.state='active' AND NOT NEW.legacy
  AND NOT EXISTS(SELECT 1 FROM shared_mail_capabilities WHERE capability='same-domain-sharing-v1' AND enabled);
 SELECT RAISE(ABORT,'mail_scope_unavailable') WHERE NEW.state='active' AND NOT EXISTS(
  SELECT 1 FROM environments e JOIN projects p ON p.organization_id=NEW.organization_id AND p.project_id=NEW.project_id
  WHERE e.organization_id=NEW.organization_id AND e.project_id=NEW.project_id AND e.environment_id=NEW.environment_id AND e.name='prod'
   AND p.owner_state='active' AND p.lifecycle_state='active');
 SELECT RAISE(ABORT,'mail_domain_mismatch') WHERE NEW.state='active' AND NOT NEW.legacy AND NOT EXISTS(
  SELECT 1 FROM project_application_domain_identities i JOIN workspace_mail_domains w ON w.domain_id=NEW.mail_domain_id AND w.organization_id=NEW.organization_id
  WHERE i.project_id=NEW.project_id AND i.organization_id=NEW.organization_id AND i.revision=NEW.application_identity_revision
   AND i.state='verified' AND i.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND i.registrable_domain=w.registrable_domain AND w.status='active');
 -- These original static value checks never recognize the historical context.
 SELECT RAISE(ABORT,'invalid mail sender settings') WHERE NOT NEW.legacy AND NOT EXISTS(SELECT 1 FROM json_each(NEW.sender_addresses) address WHERE address.type='text' AND address.value=NEW.default_from);
 SELECT RAISE(ABORT,'invalid mail sender settings') WHERE NOT NEW.legacy AND EXISTS(
  SELECT 1 FROM json_each(NEW.sender_addresses) address JOIN workspace_mail_domains w ON w.domain_id=NEW.mail_domain_id
  WHERE instr(CAST(address.value AS TEXT),'@') NOT BETWEEN 2 AND 65 OR substr(CAST(address.value AS TEXT),1,instr(CAST(address.value AS TEXT),'@')-1) GLOB '*[^A-Za-z0-9._%+-]*'
   OR substr(CAST(address.value AS TEXT),instr(CAST(address.value AS TEXT),'@')+1)<>w.domain
   OR length(CAST(address.value AS TEXT))-length(replace(CAST(address.value AS TEXT),'@',''))<>1);
END;

CREATE TRIGGER guard_application_mail_identity_insert BEFORE INSERT ON project_application_domain_identities
BEGIN
 SELECT RAISE(ABORT,'mail_domain_mismatch') WHERE NEW.state<>'revoked' AND EXISTS(SELECT 1 FROM paid_project_domains website WHERE website.organization_id=NEW.organization_id AND website.project_id=NEW.project_id AND website.state IN('awaiting_deployment','pending','active') AND website.hostname<>NEW.registrable_domain AND substr(website.hostname,-length(NEW.registrable_domain)-1)<>'.'||NEW.registrable_domain);
END;

CREATE TRIGGER guard_application_mail_identity_update BEFORE UPDATE ON project_application_domain_identities
BEGIN
 SELECT RAISE(ABORT,'mail_identity_revision_conflict') WHERE NEW.revision<OLD.revision OR(NEW.revision=OLD.revision AND(NEW.hostname IS NOT OLD.hostname OR NEW.registrable_domain IS NOT OLD.registrable_domain OR NEW.challenge_name IS NOT OLD.challenge_name OR NEW.challenge_value IS NOT OLD.challenge_value));
 SELECT RAISE(ABORT,'mail_domain_mismatch') WHERE NEW.state<>'revoked' AND EXISTS(SELECT 1 FROM paid_project_domains website WHERE website.organization_id=NEW.organization_id AND website.project_id=NEW.project_id AND website.state IN('awaiting_deployment','pending','active') AND website.hostname<>NEW.registrable_domain AND substr(website.hostname,-length(NEW.registrable_domain)-1)<>'.'||NEW.registrable_domain);
END;

CREATE TRIGGER mirror_legacy_workspace_mail AFTER INSERT ON resend_mail_domains WHEN NEW.deleted_at IS NULL
BEGIN
 SELECT RAISE(ABORT,'mail_domain_conflict') WHERE EXISTS(SELECT 1 FROM workspace_mail_domains WHERE organization_id=NEW.organization_id AND domain=NEW.domain AND reputation_state='suspended');
 INSERT INTO workspace_mail_domains(domain_id,organization_id,domain,legacy_domain_id,custody_organization_id,custody_project_id,custody_environment_id,configured_at)
 VALUES(NEW.domain_id,NEW.organization_id,NEW.domain,NEW.domain_id,NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.configured_at);
 INSERT INTO project_mail_domain_bindings(project_id,organization_id,environment_id,mail_domain_id,legacy,sending,configured_at,updated_at)
 VALUES(NEW.project_id,NEW.organization_id,NEW.environment_id,NEW.domain_id,1,NEW.sending,NEW.configured_at,NEW.configured_at)
 ON CONFLICT(project_id) DO UPDATE SET organization_id=excluded.organization_id,environment_id=excluded.environment_id,mail_domain_id=excluded.mail_domain_id,
 legacy=1,sending=excluded.sending,state='active',revision=project_mail_domain_bindings.revision+1,sender_addresses='[]',default_from=NULL,default_reply_to=NULL,application_identity_revision=NULL,updated_at=excluded.updated_at;
END;

CREATE TRIGGER mark_mail_capabilities_dirty_insert AFTER INSERT ON project_mail_domain_bindings
BEGIN
 UPDATE workspace_mail_domains SET capabilities_dirty=1 WHERE domain_id=NEW.mail_domain_id;
END;

CREATE TRIGGER mark_mail_capabilities_dirty_update AFTER UPDATE ON project_mail_domain_bindings
BEGIN
 UPDATE workspace_mail_domains SET capabilities_dirty=1 WHERE domain_id=NEW.mail_domain_id;
 UPDATE workspace_mail_domains SET capabilities_dirty=1 WHERE domain_id=OLD.mail_domain_id AND OLD.mail_domain_id<>NEW.mail_domain_id;
END;

-- A Core scope row carries the original project's lifecycle and original ownership transition separately.
CREATE TRIGGER detach_inactive_project_mail AFTER UPDATE OF lifecycle_state ON projects WHEN NEW.lifecycle_state<>'active'
BEGIN
 UPDATE project_mail_domain_bindings SET state='detached',sending=0,revision=revision+1,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE project_id=NEW.project_id AND state<>'detached';
 UPDATE project_application_domain_identities SET state='revoked',revoked_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE project_id=NEW.project_id AND state<>'revoked';
END;
CREATE TRIGGER detach_transferred_project_mail AFTER UPDATE OF owner_state ON projects WHEN NEW.owner_state<>'active'
BEGIN
 UPDATE project_mail_domain_bindings SET state='detached',sending=0,revision=revision+1,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE project_id=NEW.project_id AND organization_id=NEW.organization_id AND state<>'detached';
 UPDATE project_application_domain_identities SET state='revoked',revoked_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE project_id=NEW.project_id AND organization_id=NEW.organization_id AND state<>'revoked';
END;

CREATE TRIGGER invalidate_changed_application_mail_domain_insert AFTER INSERT ON paid_project_domains
WHEN EXISTS(SELECT 1 FROM project_application_domain_identities i WHERE i.organization_id=NEW.organization_id AND i.project_id=NEW.project_id AND i.state<>'revoked' AND NEW.hostname<>i.registrable_domain AND substr(NEW.hostname,-length(i.registrable_domain)-1)<>'.'||i.registrable_domain)
BEGIN
 UPDATE project_application_domain_identities SET state='revoked',revoked_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND state<>'revoked';
 UPDATE project_mail_domain_bindings SET state='suspended',sending=0,revision=revision+1,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND NOT legacy AND state='active';
END;

CREATE TRIGGER invalidate_changed_application_mail_domain_update AFTER UPDATE OF hostname,state ON paid_project_domains
WHEN (NEW.hostname IS NOT OLD.hostname OR(NEW.state IN('deleting','deleted') AND OLD.state NOT IN('deleting','deleted'))) OR EXISTS(SELECT 1 FROM project_application_domain_identities i WHERE i.organization_id=NEW.organization_id AND i.project_id=NEW.project_id AND i.state<>'revoked' AND NEW.hostname<>i.registrable_domain AND substr(NEW.hostname,-length(i.registrable_domain)-1)<>'.'||i.registrable_domain)
BEGIN
 UPDATE project_application_domain_identities SET state='revoked',revoked_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND state<>'revoked';
 UPDATE project_mail_domain_bindings SET state='suspended',sending=0,revision=revision+1,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND NOT legacy AND state='active';
END;

DROP TABLE mail_manager_empty_guard_0466;
