-- AI gateway: the cap of unresolved calls per organization is one more guard code. A CHECK cannot be altered, so the
-- always-empty guard_fail table is recreated with every code of GUARD_CODES, in the order of 0001 and the new one last.
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
  CONSTRAINT guard_precondition_changed CHECK (code <> 'precondition_changed'),
  -- AI gateway: the organization holds the unresolved calls its cap allows, so the batch refuses a call before it reserves.
  CONSTRAINT guard_ai_open_calls_exceeded CHECK (code <> 'ai_open_calls_exceeded'),
  -- Declared last, so a registered code always fails on its own named constraint above. A code nobody registered still
  -- aborts the batch (a guard that merely inserted a row would let the write through), as `guard_unregistered`.
  CONSTRAINT guard_unregistered CHECK (length(code) < 0)
) STRICT;
