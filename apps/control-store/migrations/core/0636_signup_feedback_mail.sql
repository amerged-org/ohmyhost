-- The owner must explicitly enable this campaign after reviewing the test message.
CREATE TABLE signup_feedback_mail_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
) STRICT;
INSERT INTO signup_feedback_mail_settings(singleton,enabled) VALUES(1,0);

-- No recipient addresses or message bodies are retained in Core.
CREATE TABLE signup_feedback_mail (
  workos_user_id TEXT PRIMARY KEY REFERENCES user_signup(workos_user_id),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','sending','accepted','uncertain','skipped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_until TEXT,
  next_attempt_at TEXT,
  claim_token TEXT,
  provider_message_id TEXT,
  CHECK(state NOT IN ('claimed','sending') OR (lease_until IS NOT NULL AND claim_token IS NOT NULL)),
  CHECK(state <> 'accepted' OR provider_message_id IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX signup_feedback_mail_due ON signup_feedback_mail(state,next_attempt_at,lease_until,created_at);

-- Only first origin capture while enabled creates a job; activating the gate never backfills old accounts.
-- New signups are due one hour later. Explicit historical cohort entries omit next_attempt_at and are due immediately.
CREATE TRIGGER signup_feedback_first_insert AFTER INSERT ON user_signup
WHEN NEW.origin_present=1 AND (SELECT enabled FROM signup_feedback_mail_settings WHERE singleton=1)=1
BEGIN
  INSERT INTO signup_feedback_mail(workos_user_id,state,created_at,updated_at,next_attempt_at)
  VALUES(NEW.workos_user_id,'pending',NEW.recorded_at,NEW.recorded_at,
    strftime('%Y-%m-%dT%H:%M:%S',substr(NEW.recorded_at,1,19),'+1 hour')||substr(NEW.recorded_at,20))
  ON CONFLICT(workos_user_id) DO NOTHING;
END;
CREATE TRIGGER signup_feedback_first_origin AFTER UPDATE OF origin_present ON user_signup
WHEN OLD.origin_present=0 AND NEW.origin_present=1 AND (SELECT enabled FROM signup_feedback_mail_settings WHERE singleton=1)=1
BEGIN
  INSERT INTO signup_feedback_mail(workos_user_id,state,created_at,updated_at,next_attempt_at)
  VALUES(NEW.workos_user_id,'pending',NEW.recorded_at,NEW.recorded_at,
    strftime('%Y-%m-%dT%H:%M:%S',substr(NEW.recorded_at,1,19),'+1 hour')||substr(NEW.recorded_at,20))
  ON CONFLICT(workos_user_id) DO NOTHING;
END;
