-- W32: replace incomplete pre-data mail prototypes with final original native facts.
-- This is an EMPTY-target-only schema preparation, never a data conversion or rewrite.
-- If any affected original/normalized row exists, abort before dropping any object.
CREATE TABLE mail_send_empty_guard_0461 (value INTEGER NOT NULL CHECK(value=0)) STRICT;
INSERT INTO mail_send_empty_guard_0461 SELECT 1 WHERE
 EXISTS(SELECT 1 FROM mail_send_requests) OR EXISTS(SELECT 1 FROM mail_send_events) OR
 EXISTS(SELECT 1 FROM mail_send_outcomes) OR EXISTS(SELECT 1 FROM mail_gateway_keys) OR
 EXISTS(SELECT 1 FROM mail_reputation_states) OR EXISTS(SELECT 1 FROM mail_reputation_decisions);
DROP TABLE mail_reputation_decisions;
DROP TABLE mail_reputation_states;
DROP TABLE mail_send_outcomes;
DROP TABLE mail_send_events;
DROP TABLE mail_send_requests;
DROP TABLE mail_gateway_keys;

CREATE UNIQUE INDEX credit_holds_mail_original_scope ON credit_holds(organization_id,project_id,hold_id);
CREATE TABLE mail_gateway_keys (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL,
 key_version INTEGER NOT NULL CHECK(key_version=1),
 key_sha256 BLOB NOT NULL UNIQUE CHECK(length(key_sha256)=32),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(organization_id,project_id),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER mail_gateway_keys_no_update BEFORE UPDATE ON mail_gateway_keys
BEGIN SELECT RAISE(ABORT,'Mail gateway keys are append-only'); END;
CREATE TRIGGER mail_gateway_keys_no_delete BEFORE DELETE ON mail_gateway_keys
BEGIN SELECT RAISE(ABORT,'Mail gateway keys are append-only'); END;

CREATE TABLE mail_send_requests (
 request_id TEXT PRIMARY KEY CHECK(length(request_id)=26 AND substr(request_id,1,1) BETWEEN '0' AND '7' AND request_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),
 recipient_sha256 BLOB NOT NULL CHECK(length(recipient_sha256)=32),
 content_sha256 BLOB NOT NULL CHECK(length(content_sha256)=32),
 credit_charge_micros INTEGER NOT NULL CHECK(credit_charge_micros>0),
 state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','accepted','uncertain','rejected')),
 provider_started_at TEXT CHECK(provider_started_at IS NULL OR provider_started_at GLOB '????-??-??T??:??:??.??????Z'),
 provider_message_id TEXT,
 requested_at TEXT NOT NULL CHECK(requested_at GLOB '????-??-??T??:??:??.??????Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at>=requested_at),
 credit_reservation_id TEXT UNIQUE,
 credit_rate_card_id TEXT REFERENCES published_credit_rate_cards(rate_card_id),
 credit_meter TEXT,
 credit_provider_cost_micros INTEGER,
 mail_provider TEXT NOT NULL DEFAULT 'aws-ses-v2' CHECK(mail_provider IN('aws-ses-v2','resend')),
 mail_domain_id TEXT REFERENCES workspace_mail_domains(domain_id),
 mail_binding_revision INTEGER,
 effective_from TEXT,
 effective_reply_to TEXT,
 request_input_sha256 BLOB CHECK(request_input_sha256 IS NULL OR length(request_input_sha256)=32),
 UNIQUE(organization_id,project_id,request_id),
 UNIQUE(organization_id,project_id,idempotency_key),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id),
 FOREIGN KEY(organization_id,project_id,credit_reservation_id) REFERENCES credit_holds(organization_id,project_id,hold_id),
 CHECK((credit_reservation_id IS NULL AND credit_rate_card_id IS NULL AND credit_meter IS NULL AND credit_provider_cost_micros IS NULL) OR
  (credit_reservation_id IS NOT NULL AND credit_rate_card_id IS NOT NULL AND credit_meter IS NOT NULL AND credit_provider_cost_micros IS NOT NULL AND credit_provider_cost_micros>0)),
 CHECK((state='reserved' AND provider_message_id IS NULL) OR
  (state='accepted' AND provider_started_at IS NOT NULL AND length(provider_message_id) BETWEEN 1 AND 256 AND provider_message_id NOT GLOB '*[^A-Za-z0-9._-]*') OR
  (state='uncertain' AND provider_started_at IS NOT NULL AND provider_message_id IS NULL) OR(state='rejected' AND provider_message_id IS NULL)),
 CHECK(provider_started_at IS NULL OR provider_started_at>=requested_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX mail_send_requests_by_project ON mail_send_requests(organization_id,project_id,requested_at DESC);
CREATE INDEX mail_send_requests_by_message ON mail_send_requests(organization_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
-- The original attribute_legacy_mail_send_domain BEFORE INSERT behavior belongs to the closed
-- runtime insert plan. It MUST NOT relabel imported historical NULL snapshots against today's owner.
CREATE TRIGGER mail_send_requests_no_delete BEFORE DELETE ON mail_send_requests
BEGIN SELECT RAISE(ABORT,'E23514 mail send requests are append-preserving'); END;
CREATE TRIGGER mail_send_requests_guard BEFORE UPDATE ON mail_send_requests
 WHEN NEW.request_id IS NOT OLD.request_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
 OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_sha256 IS NOT OLD.request_sha256
 OR NEW.recipient_sha256 IS NOT OLD.recipient_sha256 OR NEW.content_sha256 IS NOT OLD.content_sha256
 OR NEW.credit_charge_micros IS NOT OLD.credit_charge_micros OR NEW.requested_at IS NOT OLD.requested_at
 OR OLD.state IN('accepted','rejected')
 OR NOT((OLD.state='reserved' AND NEW.state IN('reserved','accepted','uncertain','rejected')) OR(OLD.state='uncertain' AND NEW.state IN('uncertain','accepted','rejected')))
 OR(OLD.provider_started_at IS NOT NULL AND NEW.provider_started_at IS NOT OLD.provider_started_at)
BEGIN SELECT RAISE(ABORT,'E23514 mail send request identity or state transition is immutable'); END;
CREATE TRIGGER mail_send_requests_sender_snapshot BEFORE UPDATE ON mail_send_requests
 WHEN NEW.mail_domain_id IS NOT OLD.mail_domain_id OR NEW.mail_binding_revision IS NOT OLD.mail_binding_revision
 OR NEW.effective_from IS NOT OLD.effective_from OR NEW.effective_reply_to IS NOT OLD.effective_reply_to OR NEW.request_input_sha256 IS NOT OLD.request_input_sha256
BEGIN SELECT RAISE(ABORT,'E23514 the sender snapshot of a mail send request is immutable'); END;

CREATE TABLE mail_send_events (
 provider_event_id TEXT PRIMARY KEY CHECK(length(provider_event_id)=36 AND length(replace(provider_event_id,'-',''))=32 AND replace(provider_event_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(provider_event_id,9,1)='-' AND substr(provider_event_id,14,1)='-' AND substr(provider_event_id,19,1)='-' AND substr(provider_event_id,24,1)='-'),
 organization_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 provider_message_id TEXT NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 256 AND provider_message_id NOT GLOB '*[^A-Za-z0-9._-]*'),
 event_type TEXT NOT NULL CHECK(event_type IN('Send','Delivery','DeliveryDelay','Bounce','Complaint','Reject','Rendering Failure')),
 outcome TEXT NOT NULL CHECK(outcome IN('accepted','delivered','delayed','bounced','complained','failed')),
 detail_sha256 BLOB NOT NULL CHECK(length(detail_sha256)=32),
 occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z'),
 sent_at TEXT NOT NULL CHECK(sent_at GLOB '????-??-??T??:??:??.??????Z'),
 received_at TEXT NOT NULL CHECK(received_at GLOB '????-??-??T??:??:??.??????Z' AND received_at>=sent_at),
 reputation_kind TEXT,
 FOREIGN KEY(organization_id,project_id,request_id) REFERENCES mail_send_requests(organization_id,project_id,request_id) ON DELETE RESTRICT,
 CHECK(reputation_kind IS NULL OR(event_type='Bounce' AND reputation_kind='hard_bounce') OR(event_type='Complaint' AND reputation_kind='complaint'))
) STRICT, WITHOUT ROWID;
CREATE INDEX mail_send_events_by_request ON mail_send_events(organization_id,project_id,request_id);
CREATE INDEX mail_send_events_reputation ON mail_send_events(organization_id,project_id,received_at) WHERE reputation_kind IS NOT NULL;
CREATE TRIGGER mail_send_events_append_only_update BEFORE UPDATE ON mail_send_events
BEGIN SELECT RAISE(ABORT,'Mail send events are append-only'); END;
CREATE TRIGGER mail_send_events_append_only_delete BEFORE DELETE ON mail_send_events
BEGIN SELECT RAISE(ABORT,'Mail send events are append-only'); END;

CREATE TABLE mail_reputation_states (
 organization_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 state TEXT NOT NULL,
 warmup_started_at TEXT NOT NULL CHECK(warmup_started_at GLOB '????-??-??T??:??:??.??????Z'),
 suspended_at TEXT CHECK(suspended_at IS NULL OR suspended_at GLOB '????-??-??T??:??:??.??????Z'),
 suspension_reason TEXT,
 triggering_event_id TEXT REFERENCES mail_send_events(provider_event_id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>=1),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at>=warmup_started_at),
 PRIMARY KEY(organization_id,project_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES mail_gateway_keys(organization_id,project_id) ON DELETE RESTRICT,
 CHECK((state='active' AND suspended_at IS NULL AND suspension_reason IS NULL AND triggering_event_id IS NULL) OR
  (state='suspended' AND suspended_at IS NOT NULL AND suspension_reason IN('bounce_rate','complaint_rate') AND triggering_event_id IS NOT NULL AND updated_at>=suspended_at))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER mail_reputation_states_no_delete BEFORE DELETE ON mail_reputation_states
BEGIN SELECT RAISE(ABORT,'Mail reputation state is append-preserving'); END;
CREATE TRIGGER mail_reputation_states_version BEFORE UPDATE ON mail_reputation_states
 WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
 OR NOT((OLD.state='active' AND NEW.state='suspended' AND NEW.warmup_started_at=OLD.warmup_started_at) OR(OLD.state='suspended' AND NEW.state='active' AND NEW.warmup_started_at=NEW.updated_at))
BEGIN SELECT RAISE(ABORT,'Mail reputation state transition is invalid'); END;

CREATE TABLE mail_reputation_decisions (
 decision_id TEXT PRIMARY KEY CHECK(length(decision_id)=36 AND length(replace(decision_id,'-',''))=32 AND replace(decision_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(decision_id,9,1)='-' AND substr(decision_id,14,1)='-' AND substr(decision_id,19,1)='-' AND substr(decision_id,24,1)='-'),
 organization_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN('suspend','reinstate','retain')),
 reason TEXT NOT NULL CHECK(reason IN('bounce_rate','complaint_rate','manual_review')),
 triggering_event_id TEXT REFERENCES mail_send_events(provider_event_id) ON DELETE RESTRICT,
 eligible_send_count INTEGER NOT NULL CHECK(eligible_send_count>=0),
 hard_bounce_count INTEGER NOT NULL CHECK(hard_bounce_count>=0),
 complaint_count INTEGER NOT NULL CHECK(complaint_count>=0),
 actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 255),
 evidence_sha256 BLOB,
 occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z'),
 FOREIGN KEY(organization_id,project_id) REFERENCES mail_reputation_states(organization_id,project_id) ON DELETE RESTRICT,
 CHECK((action='suspend' AND reason IN('bounce_rate','complaint_rate') AND triggering_event_id IS NOT NULL AND actor_id='system:ses-reputation' AND evidence_sha256 IS NULL) OR
  (action IN('reinstate','retain') AND reason='manual_review' AND triggering_event_id IS NULL AND substr(actor_id,1,9)='operator:' AND length(actor_id) BETWEEN 10 AND 255 AND substr(actor_id,10) NOT GLOB '*[^A-Za-z0-9._@-]*' AND length(evidence_sha256)=32))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER mail_reputation_decisions_append_only_update BEFORE UPDATE ON mail_reputation_decisions
BEGIN SELECT RAISE(ABORT,'Mail reputation decisions are append-only'); END;
CREATE TRIGGER mail_reputation_decisions_append_only_delete BEFORE DELETE ON mail_reputation_decisions
BEGIN SELECT RAISE(ABORT,'Mail reputation decisions are append-only'); END;

CREATE TABLE mail_send_outcomes (
 organization_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN('accepted','delivered','delayed','bounced','complained','failed')),
 provider_event_id TEXT NOT NULL REFERENCES mail_send_events(provider_event_id) ON DELETE RESTRICT,
 occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z'),
 version INTEGER NOT NULL CHECK(version>=1),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at>=occurred_at),
 PRIMARY KEY(organization_id,project_id,request_id),
 FOREIGN KEY(organization_id,project_id,request_id) REFERENCES mail_send_requests(organization_id,project_id,request_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
DROP TABLE mail_send_empty_guard_0461;
