-- Original warning metadata. A populated two-column grace prototype has no source warning clock/error facts;
-- refuse it instead of inventing those values from exhaustion or a caller's clock.
CREATE TABLE mail_warning_empty_guard_0471(value INTEGER NOT NULL CHECK(value=0)) STRICT;
INSERT INTO mail_warning_empty_guard_0471 SELECT 1 WHERE EXISTS(SELECT 1 FROM credit_grace_periods);
DROP TABLE credit_grace_periods;
CREATE TABLE credit_grace_periods (
 organization_id TEXT PRIMARY KEY REFERENCES organizations(organization_id) CHECK(length(CAST(organization_id AS BLOB))=26 AND length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 exhausted_at TEXT NOT NULL CHECK((length(CAST(exhausted_at AS BLOB))=27 AND exhausted_at GLOB '????-??-??T??:??:??.??????Z')),
 -- PostgreSQL DEFAULT now() belongs to the database execution clock, never exhausted_at or a supplied test clock.
 warning_next_attempt_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
  CHECK((length(CAST(warning_next_attempt_at AS BLOB))=27 AND warning_next_attempt_at GLOB '????-??-??T??:??:??.??????Z')),
 warning_error_code TEXT CHECK(warning_error_code IN('CREDIT_WARNING_RECIPIENTS_UNAVAILABLE','CREDIT_WARNING_SEND_UNRESOLVED'))
) STRICT, WITHOUT ROWID;
CREATE INDEX credit_warning_due ON credit_grace_periods(warning_next_attempt_at,organization_id);
CREATE TABLE organization_credit_warnings (
 notice_id TEXT PRIMARY KEY CHECK(length(CAST(notice_id AS BLOB))=length(notice_id) AND length(notice_id)=26 AND substr(notice_id,1,1) BETWEEN '0' AND '7' AND notice_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 organization_id TEXT NOT NULL REFERENCES organizations(organization_id) CHECK(length(CAST(organization_id AS BLOB))=26 AND length(organization_id)=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 exhausted_at TEXT NOT NULL CHECK((length(CAST(exhausted_at AS BLOB))=27 AND exhausted_at GLOB '????-??-??T??:??:??.??????Z')),
 owner_id TEXT NOT NULL CHECK(length(CAST(owner_id AS BLOB))=length(owner_id) AND substr(owner_id,1,5)='user_' AND length(owner_id) BETWEEN 6 AND 133 AND substr(owner_id,6) NOT GLOB '*[^A-Za-z0-9_]*'),
 state TEXT NOT NULL CHECK(state IN('sending','retry','accepted','uncertain','failed','delivered','bounced','complained')),
 attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),
 provider_message_id TEXT CHECK(length(CAST(provider_message_id AS BLOB))=length(provider_message_id) AND length(provider_message_id) BETWEEN 1 AND 256 AND provider_message_id NOT GLOB '*[^A-Za-z0-9._-]*'),
 provider_event_id TEXT CHECK(provider_event_id IS NULL OR(length(CAST(provider_event_id AS BLOB))=length(provider_event_id) AND length(provider_event_id)=36 AND substr(provider_event_id,9,1)='-' AND substr(provider_event_id,14,1)='-' AND substr(provider_event_id,19,1)='-' AND substr(provider_event_id,24,1)='-' AND length(replace(provider_event_id,'-',''))=32 AND replace(provider_event_id,'-','') NOT GLOB '*[^0-9a-f]*')),
 event_occurred_at TEXT CHECK(event_occurred_at IS NULL OR (length(CAST(event_occurred_at AS BLOB))=27 AND event_occurred_at GLOB '????-??-??T??:??:??.??????Z')),
 last_error_code TEXT CHECK(last_error_code IN('CREDIT_WARNING_NOT_SENT','CREDIT_WARNING_REJECTED','CREDIT_WARNING_UNCERTAIN')),
 created_at TEXT NOT NULL CHECK((length(CAST(created_at AS BLOB))=27 AND created_at GLOB '????-??-??T??:??:??.??????Z')),
 updated_at TEXT NOT NULL CHECK((length(CAST(updated_at AS BLOB))=27 AND updated_at GLOB '????-??-??T??:??:??.??????Z')),
 UNIQUE(organization_id,exhausted_at,owner_id),
 CHECK(state NOT IN('accepted','delivered','bounced','complained') OR provider_message_id IS NOT NULL)
) STRICT, WITHOUT ROWID;
DROP TABLE mail_warning_empty_guard_0471;
