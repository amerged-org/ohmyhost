-- W32 native Mail/Resend prerequisites. Original Dev/Prod schema-only baselines agree.
-- Restore original global identities and the five missing original physical families.
-- No data, provider authority, capability activation, plaintext or runtime switch is seeded.
-- These tables are independent of the global WorkOS/GitHub/Stripe webhook inbox.
CREATE UNIQUE INDEX mail_send_requests_global_request_id ON mail_send_requests(request_id);
CREATE UNIQUE INDEX mail_send_requests_original_scope ON mail_send_requests(organization_id,project_id,request_id);
CREATE UNIQUE INDEX mail_send_events_global_provider_event ON mail_send_events(provider_event_id);
CREATE UNIQUE INDEX resend_mail_domains_global_domain_id ON resend_mail_domains(domain_id);
CREATE UNIQUE INDEX resend_mail_domains_original_scope ON resend_mail_domains(domain_id,organization_id,project_id,environment_id);
CREATE UNIQUE INDEX workspace_mail_domains_global_domain_id ON workspace_mail_domains(domain_id);
CREATE UNIQUE INDEX workspace_mail_domains_original_scope ON workspace_mail_domains(domain_id,organization_id);
CREATE UNIQUE INDEX mail_received_messages_global_message_id ON mail_received_messages(message_id);
CREATE UNIQUE INDEX project_mail_domain_bindings_global_project ON project_mail_domain_bindings(project_id);
CREATE UNIQUE INDEX project_application_domain_identities_global_project ON project_application_domain_identities(project_id);

CREATE TABLE resend_event_receipts (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  provider_message_id TEXT,
  payload_sha256 BLOB NOT NULL CHECK(length(payload_sha256)=32),
  received_at TEXT NOT NULL CHECK(received_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;

CREATE TABLE infrastructure_alert_receipts (
  event_id TEXT PRIMARY KEY CHECK(length(event_id)=36 AND length(replace(event_id,'-',''))=32 AND replace(event_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  first_attempt_at TEXT NOT NULL CHECK(first_attempt_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_until TEXT NOT NULL CHECK(lease_until GLOB '????-??-??T??:??:??.??????Z'),
  provider_message_id TEXT CHECK(provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 256),
  accepted_at TEXT CHECK(accepted_at IS NULL OR accepted_at GLOB '????-??-??T??:??:??.??????Z'),
  CHECK((provider_message_id IS NULL)=(accepted_at IS NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE shared_mail_capabilities (
  capability TEXT PRIMARY KEY CHECK(capability='same-domain-sharing-v1'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
  cohort_revision TEXT,
  activated_at TEXT CHECK(activated_at IS NULL OR activated_at GLOB '????-??-??T??:??:??.??????Z'),
  CHECK(enabled=0 OR(cohort_revision IS NOT NULL AND activated_at IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE mail_send_outcomes (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN('accepted','delivered','delayed','bounced','complained','failed')),
  provider_event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9223372036854775807),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at>=occurred_at),
  PRIMARY KEY(organization_id,project_id,request_id),
  FOREIGN KEY(provider_event_id) REFERENCES mail_send_events(provider_event_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,request_id) REFERENCES mail_send_requests(organization_id,project_id,request_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_mail_reputation_decisions (
  decision_id TEXT NOT NULL CHECK(length(decision_id)=36 AND length(replace(decision_id,'-',''))=32 AND replace(decision_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(decision_id,9,1)='-' AND substr(decision_id,14,1)='-' AND substr(decision_id,19,1)='-' AND substr(decision_id,24,1)='-'),
  domain_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL CHECK(length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  action TEXT NOT NULL CHECK(action IN('suspend','reinstate','retain')),
  reason TEXT NOT NULL,
  triggering_event_id TEXT CHECK(triggering_event_id IS NULL OR(length(triggering_event_id)=36 AND length(replace(triggering_event_id,'-',''))=32 AND replace(triggering_event_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(triggering_event_id,9,1)='-' AND substr(triggering_event_id,14,1)='-' AND substr(triggering_event_id,19,1)='-' AND substr(triggering_event_id,24,1)='-')),
  eligible_send_count INTEGER NOT NULL CHECK(eligible_send_count>=0),
  hard_bounce_count INTEGER NOT NULL CHECK(hard_bounce_count>=0),
  complaint_count INTEGER NOT NULL CHECK(complaint_count>=0),
  actor_id TEXT NOT NULL,
  evidence_sha256 BLOB CHECK(evidence_sha256 IS NULL OR length(evidence_sha256)=32),
  occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(decision_id,domain_id),
  FOREIGN KEY(domain_id,organization_id) REFERENCES workspace_mail_domains(domain_id,organization_id),
  FOREIGN KEY(domain_id) REFERENCES workspace_mail_domains(domain_id)
) STRICT, WITHOUT ROWID;
