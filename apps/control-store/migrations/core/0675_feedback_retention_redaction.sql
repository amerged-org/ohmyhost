-- Feedback retention: a report older than twelve months is redacted by the retention sweep. The only update
-- allowed to customer_feedback is that one redaction: the report becomes an empty object and redacted_at is set,
-- and every other column stays as it was. Deleting feedback stays forbidden.
ALTER TABLE customer_feedback ADD COLUMN redacted_at TEXT CHECK (redacted_at IS NULL OR (length(CAST(redacted_at AS BLOB))=27 AND redacted_at GLOB '????-??-??T??:??:??.??????Z'));
DROP TRIGGER IF EXISTS customer_feedback_append_only_update;
CREATE TRIGGER customer_feedback_append_only_update BEFORE UPDATE ON customer_feedback
WHEN NOT (
  OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.report = '{}'
  AND NEW.feedback_id = OLD.feedback_id AND NEW.organization_id = OLD.organization_id
  AND NEW.actor_id = OLD.actor_id AND NEW.idempotency_key = OLD.idempotency_key
  AND NEW.request_sha256 IS OLD.request_sha256 AND NEW.project_id IS OLD.project_id
  AND NEW.environment_id IS OLD.environment_id AND NEW.operation_id IS OLD.operation_id
  AND NEW.submitted_at = OLD.submitted_at
)
BEGIN SELECT RAISE(ABORT,'customer_feedback is append-only');END;
