-- core-v1 source: migrations/directory/0010_directory_commands.sql
-- Guards of the directory commands, the append-only revocations and the sweeps' indexes.

-- A terminal revocation is never rewritten; only a row with a purge time (a session) can be removed, after it.
CREATE TRIGGER revocations_no_update BEFORE UPDATE ON revocations
BEGIN SELECT RAISE(ABORT, 'revocations are append-only'); END;
CREATE TRIGGER revocations_delete_only_when_purgeable BEFORE DELETE ON revocations
  WHEN OLD.purge_after IS NULL
BEGIN SELECT RAISE(ABORT, 'user and organization revocations are permanent'); END;

CREATE INDEX onboarding_requests_purge ON onboarding_requests (completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX project_directory_reserved ON project_directory (reserved_until) WHERE state = 'reserved';
