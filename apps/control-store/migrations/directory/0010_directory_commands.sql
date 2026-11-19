-- Guards of the directory commands, the append-only revocations and the sweeps' indexes.
DROP TABLE guard_fail;
CREATE TABLE guard_fail (
  code TEXT NOT NULL,
  CONSTRAINT guard_row_version_conflict CHECK (code <> 'row_version_conflict'),
  CONSTRAINT guard_claim_lost CHECK (code <> 'claim_lost'),
  CONSTRAINT guard_operation_conflict CHECK (code <> 'operation_conflict'),
  CONSTRAINT guard_owner_changed CHECK (code <> 'owner_changed'),
  CONSTRAINT guard_insufficient_credits CHECK (code <> 'insufficient_credits'),
  CONSTRAINT guard_wallet_version_conflict CHECK (code <> 'wallet_version_conflict'),
  CONSTRAINT guard_source_head_conflict CHECK (code <> 'source_head_conflict'),
  CONSTRAINT guard_scope_inactive CHECK (code <> 'scope_inactive'),
  CONSTRAINT guard_consent_changed CHECK (code <> 'consent_changed'),
  CONSTRAINT guard_organization_inactive CHECK (code <> 'organization_inactive'),
  CONSTRAINT guard_attribution_conflict CHECK (code <> 'attribution_conflict'),
  CONSTRAINT guard_environment_set_invalid CHECK (code <> 'environment_set_invalid'),
  CONSTRAINT guard_bucket_fenced CHECK (code <> 'bucket_fenced'),
  -- Platform contexts H to L: a fact the decision read no longer holds, so the snapshot is stale.
  CONSTRAINT guard_precondition_changed CHECK (code <> 'precondition_changed')
) STRICT;

-- A terminal revocation is never rewritten; only a row with a purge time (a session) can be removed, after it.
CREATE TRIGGER revocations_no_update BEFORE UPDATE ON revocations
BEGIN SELECT RAISE(ABORT, 'revocations are append-only'); END;
CREATE TRIGGER revocations_delete_only_when_purgeable BEFORE DELETE ON revocations
  WHEN OLD.purge_after IS NULL
BEGIN SELECT RAISE(ABORT, 'user and organization revocations are permanent'); END;

CREATE INDEX onboarding_requests_purge ON onboarding_requests (completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX project_directory_reserved ON project_directory (reserved_until) WHERE state = 'reserved';
