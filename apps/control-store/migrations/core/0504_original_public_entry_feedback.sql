-- Original098/110/111/151/feature-vote public and customer feedback facts, plus retained scheduled retention parents.
-- UNSERVED additive only: no generic public_intake alias, captured row/feedback event or sequence state is fabricated.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE beta_feature_interests (
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)=36 AND length(CAST(idempotency_key AS BLOB))=36 AND substr(idempotency_key,9,1)='-' AND substr(idempotency_key,14,1)='-' AND substr(idempotency_key,19,1)='-' AND substr(idempotency_key,24,1)='-' AND length(replace(idempotency_key,'-',''))=32 AND replace(idempotency_key,'-','') NOT GLOB '*[^a-f0-9]*'),
 feature TEXT NOT NULL CHECK(instr(feature,char(0))=0),
 created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB))=27 AND created_at GLOB '????-??-??T??:??:??.??????Z' AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)||substr(created_at,21,6)) NOT GLOB '*[^0-9]*'),
 voter_sha256 BLOB,
 choice TEXT CHECK(instr(choice,char(0))=0),
 position INTEGER NOT NULL,
 expires_at TEXT NOT NULL CHECK(length(CAST(expires_at AS BLOB))=27 AND expires_at GLOB '????-??-??T??:??:??.??????Z' AND substr(expires_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(expires_at,1,10),'+0 days')=substr(expires_at,1,10) AND substr(expires_at,12,2) BETWEEN '00' AND '23' AND substr(expires_at,15,2) BETWEEN '00' AND '59' AND substr(expires_at,18,2) BETWEEN '00' AND '59' AND (substr(expires_at,12,2)||substr(expires_at,15,2)||substr(expires_at,18,2)||substr(expires_at,21,6)) NOT GLOB '*[^0-9]*'),
 PRIMARY KEY(idempotency_key),CHECK(choice IN('up','down')),CHECK(expires_at>created_at),CHECK(feature IN('eu','iso27001','soc2')),CHECK(voter_sha256 IS NULL OR length(voter_sha256)=32)
) STRICT, WITHOUT ROWID;
CREATE TABLE contact_requests (
 request_id TEXT NOT NULL CHECK(length(request_id)=36 AND length(CAST(request_id AS BLOB))=36 AND substr(request_id,9,1)='-' AND substr(request_id,14,1)='-' AND substr(request_id,19,1)='-' AND substr(request_id,24,1)='-' AND length(replace(request_id,'-',''))=32 AND replace(request_id,'-','') NOT GLOB '*[^a-f0-9]*'),
 payload_sha256 BLOB NOT NULL,
 name TEXT NOT NULL CHECK(instr(name,char(0))=0),
 email TEXT NOT NULL CHECK(instr(email,char(0))=0),
 company TEXT NOT NULL CHECK(instr(company,char(0))=0),
 message TEXT NOT NULL CHECK(instr(message,char(0))=0),
 created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB))=27 AND created_at GLOB '????-??-??T??:??:??.??????Z' AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)||substr(created_at,21,6)) NOT GLOB '*[^0-9]*'),
 expires_at TEXT NOT NULL CHECK(length(CAST(expires_at AS BLOB))=27 AND expires_at GLOB '????-??-??T??:??:??.??????Z' AND substr(expires_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(expires_at,1,10),'+0 days')=substr(expires_at,1,10) AND substr(expires_at,12,2) BETWEEN '00' AND '23' AND substr(expires_at,15,2) BETWEEN '00' AND '59' AND substr(expires_at,18,2) BETWEEN '00' AND '59' AND (substr(expires_at,12,2)||substr(expires_at,15,2)||substr(expires_at,18,2)||substr(expires_at,21,6)) NOT GLOB '*[^0-9]*'),
 PRIMARY KEY(request_id),CHECK(expires_at>created_at),CHECK(length(company)<=200),CHECK(length(email) BETWEEN 3 AND 254),CHECK(length(message) BETWEEN 1 AND 8000),CHECK(length(name) BETWEEN 1 AND 120),CHECK(length(payload_sha256)=32)
) STRICT, WITHOUT ROWID;
CREATE TABLE customer_feedback (
 feedback_id TEXT NOT NULL CHECK(length(feedback_id)=26 AND length(CAST(feedback_id AS BLOB))=26 AND substr(feedback_id,1,1) BETWEEN '0' AND '7' AND feedback_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 actor_id TEXT NOT NULL CHECK(instr(actor_id,char(0))=0),
 idempotency_key TEXT NOT NULL CHECK(instr(idempotency_key,char(0))=0),
 request_sha256 BLOB NOT NULL,
 project_id TEXT CHECK(length(project_id)=26 AND length(CAST(project_id AS BLOB))=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT CHECK(length(environment_id)=26 AND length(CAST(environment_id AS BLOB))=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 operation_id TEXT CHECK(length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 report TEXT NOT NULL CHECK(instr(report,char(0))=0),
 submitted_at TEXT NOT NULL CHECK(length(CAST(submitted_at AS BLOB))=27 AND submitted_at GLOB '????-??-??T??:??:??.??????Z' AND substr(submitted_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(submitted_at,1,10),'+0 days')=substr(submitted_at,1,10) AND substr(submitted_at,12,2) BETWEEN '00' AND '23' AND substr(submitted_at,15,2) BETWEEN '00' AND '59' AND substr(submitted_at,18,2) BETWEEN '00' AND '59' AND (substr(submitted_at,12,2)||substr(submitted_at,15,2)||substr(submitted_at,18,2)||substr(submitted_at,21,6)) NOT GLOB '*[^0-9]*'),
 PRIMARY KEY(feedback_id),UNIQUE(organization_id,actor_id,idempotency_key),FOREIGN KEY(project_id) REFERENCES project_directory(project_id) ON DELETE RESTRICT,FOREIGN KEY(operation_id) REFERENCES operations(operation_id) ON DELETE RESTRICT,CHECK(length(actor_id) BETWEEN 1 AND 256),CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),CHECK(json_valid(report) AND json_type(report)='object' AND length(CAST(report AS BLOB))<=65600),CHECK(length(request_sha256)=32),CHECK((environment_id IS NULL AND operation_id IS NULL) OR project_id IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE TABLE customer_feedback_events (
 event_id TEXT NOT NULL CHECK(length(event_id)=26 AND length(CAST(event_id AS BLOB))=26 AND substr(event_id,1,1) BETWEEN '0' AND '7' AND event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 feedback_id TEXT NOT NULL CHECK(length(feedback_id)=26 AND length(CAST(feedback_id AS BLOB))=26 AND substr(feedback_id,1,1) BETWEEN '0' AND '7' AND feedback_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 visibility TEXT NOT NULL CHECK(instr(visibility,char(0))=0),
 status TEXT CHECK(instr(status,char(0))=0),
 release TEXT CHECK(instr(release,char(0))=0),
 body TEXT CHECK(instr(body,char(0))=0),
 actor_id TEXT NOT NULL CHECK(instr(actor_id,char(0))=0),
 recorded_at TEXT NOT NULL CHECK(length(CAST(recorded_at AS BLOB))=27 AND recorded_at GLOB '????-??-??T??:??:??.??????Z' AND substr(recorded_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(recorded_at,1,10),'+0 days')=substr(recorded_at,1,10) AND substr(recorded_at,12,2) BETWEEN '00' AND '23' AND substr(recorded_at,15,2) BETWEEN '00' AND '59' AND substr(recorded_at,18,2) BETWEEN '00' AND '59' AND (substr(recorded_at,12,2)||substr(recorded_at,15,2)||substr(recorded_at,18,2)||substr(recorded_at,21,6)) NOT GLOB '*[^0-9]*'),
 PRIMARY KEY(event_id),FOREIGN KEY(feedback_id) REFERENCES customer_feedback(feedback_id) ON DELETE RESTRICT,CHECK(length(actor_id) BETWEEN 1 AND 256),CHECK(length(body) BETWEEN 1 AND 2000),CHECK(status IS NULL OR visibility='customer'),CHECK(status IS NOT NULL OR body IS NOT NULL),CHECK((status IS 'resolved')=(release IS NOT NULL)),CHECK(status IS NULL OR status NOT IN('resolved','closed') OR body IS NOT NULL),CHECK(release IS NULL OR(length(release) BETWEEN 1 AND 64 AND substr(release,1,1) GLOB '[A-Za-z0-9]' AND release NOT GLOB '*[^A-Za-z0-9._:/+-]*')),CHECK(status IN('in_review','planned','in_progress','resolved','closed')),CHECK(visibility IN('customer','internal'))
) STRICT, WITHOUT ROWID;
CREATE TABLE beta_interests (
 email TEXT NOT NULL CHECK(instr(email,char(0))=0),
 consent_version TEXT NOT NULL CHECK(instr(consent_version,char(0))=0),
 created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB))=27 AND created_at GLOB '????-??-??T??:??:??.??????Z' AND substr(created_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(created_at,1,10),'+0 days')=substr(created_at,1,10) AND substr(created_at,12,2) BETWEEN '00' AND '23' AND substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND (substr(created_at,12,2)||substr(created_at,15,2)||substr(created_at,18,2)||substr(created_at,21,6)) NOT GLOB '*[^0-9]*'),
 expires_at TEXT NOT NULL CHECK(length(CAST(expires_at AS BLOB))=27 AND expires_at GLOB '????-??-??T??:??:??.??????Z' AND substr(expires_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(expires_at,1,10),'+0 days')=substr(expires_at,1,10) AND substr(expires_at,12,2) BETWEEN '00' AND '23' AND substr(expires_at,15,2) BETWEEN '00' AND '59' AND substr(expires_at,18,2) BETWEEN '00' AND '59' AND (substr(expires_at,12,2)||substr(expires_at,15,2)||substr(expires_at,18,2)||substr(expires_at,21,6)) NOT GLOB '*[^0-9]*'),
 PRIMARY KEY(email),CHECK(expires_at>created_at),CHECK(consent_version='beta-interest-2026-09-13'),CHECK(email=lower(trim(email)) AND length(email) BETWEEN 3 AND 254)
) STRICT, WITHOUT ROWID;
CREATE TABLE referral_observations (
 source TEXT NOT NULL CHECK(instr(source,char(0))=0),
 observations INTEGER NOT NULL,
 last_seen_at TEXT NOT NULL CHECK(length(CAST(last_seen_at AS BLOB))=27 AND last_seen_at GLOB '????-??-??T??:??:??.??????Z' AND substr(last_seen_at,1,4) BETWEEN '0001' AND '9999' AND date(substr(last_seen_at,1,10),'+0 days')=substr(last_seen_at,1,10) AND substr(last_seen_at,12,2) BETWEEN '00' AND '23' AND substr(last_seen_at,15,2) BETWEEN '00' AND '59' AND substr(last_seen_at,18,2) BETWEEN '00' AND '59' AND (substr(last_seen_at,12,2)||substr(last_seen_at,15,2)||substr(last_seen_at,18,2)||substr(last_seen_at,21,6)) NOT GLOB '*[^0-9]*'),
 PRIMARY KEY(source),CHECK(observations>0),CHECK(length(source) BETWEEN 1 AND 64)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER customer_feedback_append_only_update BEFORE UPDATE ON customer_feedback BEGIN SELECT RAISE(ABORT,'customer_feedback is append-only');END;
CREATE TRIGGER customer_feedback_append_only_delete BEFORE DELETE ON customer_feedback BEGIN SELECT RAISE(ABORT,'customer_feedback is append-only');END;
CREATE TRIGGER customer_feedback_events_append_only_update BEFORE UPDATE ON customer_feedback_events BEGIN SELECT RAISE(ABORT,'customer_feedback_events is append-only');END;
CREATE TRIGGER customer_feedback_events_append_only_delete BEFORE DELETE ON customer_feedback_events BEGIN SELECT RAISE(ABORT,'customer_feedback_events is append-only');END;
CREATE INDEX beta_feature_current ON beta_feature_interests(voter_sha256,feature,position DESC) WHERE voter_sha256 IS NOT NULL;
CREATE INDEX beta_feature_expiry_index ON beta_feature_interests(expires_at);
CREATE INDEX beta_interests_expiry ON beta_interests(expires_at);
CREATE INDEX contact_requests_expiry ON contact_requests(expires_at);
CREATE INDEX customer_feedback_events_history ON customer_feedback_events(feedback_id,recorded_at,event_id);
-- Original position is neither a PK nor UNIQUE. Its independent captured sequence is never inferred from rows.
CREATE TABLE beta_feature_vote_allocator (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 last_value INTEGER NOT NULL CHECK(last_value BETWEEN 1 AND 9223372036854775807),
 is_called INTEGER NOT NULL CHECK(is_called IN(0,1))
) STRICT;
INSERT INTO beta_feature_vote_allocator(singleton,last_value,is_called) VALUES(1,1,0);
