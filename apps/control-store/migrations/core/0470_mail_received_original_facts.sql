-- W32: original received-message metadata only, never content/recipient plaintext or a readiness seed.
-- Refuse any populated prototype before dropping a table, and preserve the original receiver's four-coordinate FK.
CREATE TABLE mail_received_empty_guard_0470(value INTEGER NOT NULL CHECK(value=0)) STRICT;
INSERT INTO mail_received_empty_guard_0470 SELECT 1 WHERE EXISTS(SELECT 1 FROM mail_received_messages);
DROP TABLE mail_received_messages;
CREATE TABLE mail_received_messages (
 message_id TEXT PRIMARY KEY CHECK(length(CAST(message_id AS BLOB))=length(message_id) AND length(message_id)=26 AND substr(message_id,1,1) BETWEEN '0' AND '7' AND message_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 provider_message_id TEXT NOT NULL UNIQUE CHECK(instr(provider_message_id,char(0))=0),
 domain_id TEXT NOT NULL CHECK(length(CAST(domain_id AS BLOB))=26 AND length(domain_id)=26 AND substr(domain_id,1,1) BETWEEN '0' AND '7' AND domain_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL CHECK(length(CAST(organization_id AS BLOB))=26 AND length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 project_id TEXT NOT NULL CHECK(length(CAST(project_id AS BLOB))=26 AND length(project_id)=26 AND substr(project_id,1,1) BETWEEN '0' AND '7' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 environment_id TEXT NOT NULL CHECK(length(CAST(environment_id AS BLOB))=26 AND length(environment_id)=26 AND substr(environment_id,1,1) BETWEEN '0' AND '7' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 received_at TEXT NOT NULL CHECK((length(CAST(received_at AS BLOB))=27 AND received_at GLOB '????-??-??T??:??:??.??????Z')),
 expires_at TEXT NOT NULL CHECK((length(CAST(expires_at AS BLOB))=27 AND expires_at GLOB '????-??-??T??:??:??.??????Z')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','delivering','delivered','delivery_failed','expired')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
 first_attempt_at TEXT CHECK(first_attempt_at IS NULL OR (length(CAST(first_attempt_at AS BLOB))=27 AND first_attempt_at GLOB '????-??-??T??:??:??.??????Z')),
 lease_until TEXT CHECK(lease_until IS NULL OR(length(CAST(lease_until AS BLOB))=27 AND lease_until GLOB '????-??-??T??:??:??.??????Z')),
 next_attempt_at TEXT NOT NULL CHECK((length(CAST(next_attempt_at AS BLOB))=27 AND next_attempt_at GLOB '????-??-??T??:??:??.??????Z')),
 last_http_status INTEGER CHECK(last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
 billed_at TEXT CHECK(billed_at IS NULL OR (length(CAST(billed_at AS BLOB))=27 AND billed_at GLOB '????-??-??T??:??:??.??????Z')),
 FOREIGN KEY(domain_id,organization_id,project_id,environment_id) REFERENCES resend_mail_domains(domain_id,organization_id,project_id,environment_id),
 -- Preserve microseconds exactly rather than letting SQLite's millisecond datetime parser round them.
 CHECK(substr(expires_at,1,19)=strftime('%Y-%m-%dT%H:%M:%S',substr(received_at,1,19)||'Z','+72 hours') AND substr(expires_at,20)=substr(received_at,20)),
 CHECK((attempts=0 AND first_attempt_at IS NULL) OR(attempts>0 AND first_attempt_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX mail_received_messages_global_message_id ON mail_received_messages(message_id);
CREATE INDEX mail_received_messages_due ON mail_received_messages(next_attempt_at) WHERE state IN('pending','delivering');
CREATE INDEX mail_received_messages_unbilled ON mail_received_messages(received_at) WHERE billed_at IS NULL;
CREATE INDEX mail_received_messages_purge ON mail_received_messages(expires_at);
CREATE TRIGGER mail_received_messages_identity BEFORE UPDATE ON mail_received_messages
 WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.message_id IS NOT OLD.message_id OR NEW.provider_message_id IS NOT OLD.provider_message_id
 OR NEW.domain_id IS NOT OLD.domain_id OR NEW.project_id IS NOT OLD.project_id OR NEW.environment_id IS NOT OLD.environment_id
 OR NEW.received_at IS NOT OLD.received_at OR NEW.expires_at IS NOT OLD.expires_at
 OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
 OR(OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS NOT OLD.first_attempt_at)
BEGIN SELECT RAISE(ABORT,'mail ownership, receipt deadline and delivery budget are immutable');END;
DROP TABLE mail_received_empty_guard_0470;
