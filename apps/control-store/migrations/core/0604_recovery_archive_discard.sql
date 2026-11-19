-- P2-j9: a prepared archive whose upload never landed is cleared by its job so that a fresh archive can be captured.
-- The archive-final trigger of 0280 aborted every change of a prepared archive, so the store could not express that
-- discard. A prepared archive is still never replaced by another one: the trigger now permits only the clearing of all
-- five archive fields while the job still holds its sealed input. Every other change of a prepared archive is refused,
-- and project_recovery_jobs_terminal_final (unchanged) keeps every finished job immutable.
-- Forward migration of 0280: no core_authority_activation guard, the lineage migrations stay unchanged.

DROP TRIGGER project_recovery_jobs_archive_final;
CREATE TRIGGER project_recovery_jobs_archive_final BEFORE UPDATE ON project_recovery_jobs
WHEN OLD.archive_bytes IS NOT NULL AND (NEW.archive_bytes IS NOT OLD.archive_bytes OR NEW.archive_sha256 IS NOT OLD.archive_sha256
  OR NEW.sql_files IS NOT OLD.sql_files OR NEW.captured_at IS NOT OLD.captured_at OR NEW.archive_expires_at IS NOT OLD.archive_expires_at)
  AND NOT (NEW.archive_bytes IS NULL AND NEW.archive_sha256 IS NULL AND NEW.sql_files IS NULL AND NEW.captured_at IS NULL
    AND NEW.archive_expires_at IS NULL AND NEW.input_ciphertext IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'project_recovery_jobs archive is final once prepared'); END;
