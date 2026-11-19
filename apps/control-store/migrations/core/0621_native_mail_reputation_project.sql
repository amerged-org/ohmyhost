-- Preserve reputation and decision history while binding its custody to the existing global project identity.
CREATE TABLE mail_reputation_states_copy_0621 AS SELECT organization_id, project_id, state, warmup_started_at, suspended_at, suspension_reason, triggering_event_id, version, updated_at FROM mail_reputation_states;
CREATE TABLE mail_reputation_decisions_copy_0621 AS SELECT decision_id, organization_id, project_id, action, reason, triggering_event_id, eligible_send_count, hard_bounce_count, complaint_count, actor_id, evidence_sha256, occurred_at FROM mail_reputation_decisions;
DROP TABLE mail_reputation_decisions;
DROP TABLE mail_reputation_states;
CREATE TABLE mail_reputation_states (
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL,
 state TEXT NOT NULL,
 warmup_started_at TEXT NOT NULL CHECK(warmup_started_at GLOB '????-??-??T??:??:??.??????Z'),
 suspended_at TEXT CHECK(suspended_at IS NULL OR suspended_at GLOB '????-??-??T??:??:??.??????Z'),
 suspension_reason TEXT,
 triggering_event_id TEXT REFERENCES mail_send_events(provider_event_id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>=1),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z' AND updated_at>=warmup_started_at),
 PRIMARY KEY(organization_id,project_id),
 FOREIGN KEY(project_id) REFERENCES project_identities(project_id) ON DELETE RESTRICT,
 CHECK((state='active' AND suspended_at IS NULL AND suspension_reason IS NULL AND triggering_event_id IS NULL) OR
  (state='suspended' AND suspended_at IS NOT NULL AND suspension_reason IN('bounce_rate','complaint_rate') AND triggering_event_id IS NOT NULL AND updated_at>=suspended_at))
) STRICT, WITHOUT ROWID;
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
INSERT INTO mail_reputation_states (organization_id, project_id, state, warmup_started_at, suspended_at, suspension_reason, triggering_event_id, version, updated_at) SELECT organization_id, project_id, state, warmup_started_at, suspended_at, suspension_reason, triggering_event_id, version, updated_at FROM mail_reputation_states_copy_0621;
INSERT INTO mail_reputation_decisions (decision_id, organization_id, project_id, action, reason, triggering_event_id, eligible_send_count, hard_bounce_count, complaint_count, actor_id, evidence_sha256, occurred_at) SELECT decision_id, organization_id, project_id, action, reason, triggering_event_id, eligible_send_count, hard_bounce_count, complaint_count, actor_id, evidence_sha256, occurred_at FROM mail_reputation_decisions_copy_0621;
DROP TABLE mail_reputation_states_copy_0621;
DROP TABLE mail_reputation_decisions_copy_0621;
CREATE TRIGGER mail_reputation_states_no_delete BEFORE DELETE ON mail_reputation_states
BEGIN SELECT RAISE(ABORT,'Mail reputation state is append-preserving'); END;
CREATE TRIGGER mail_reputation_states_version BEFORE UPDATE ON mail_reputation_states
 WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
 OR NOT((OLD.state='active' AND NEW.state='suspended' AND NEW.warmup_started_at=OLD.warmup_started_at) OR(OLD.state='suspended' AND NEW.state='active' AND NEW.warmup_started_at=NEW.updated_at))
BEGIN SELECT RAISE(ABORT,'Mail reputation state transition is invalid'); END;
CREATE TRIGGER mail_reputation_decisions_append_only_delete BEFORE DELETE ON mail_reputation_decisions
BEGIN SELECT RAISE(ABORT,'Mail reputation decisions are append-only'); END;
CREATE TRIGGER mail_reputation_decisions_append_only_update BEFORE UPDATE ON mail_reputation_decisions
BEGIN SELECT RAISE(ABORT,'Mail reputation decisions are append-only'); END;
