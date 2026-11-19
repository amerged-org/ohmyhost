-- Browser-only connection attempts. Credential and provider values are held by the broker; Core stores digests and sealed verifier bytes.
CREATE TABLE connection_handoffs (
  handoff_hash TEXT PRIMARY KEY CHECK(length(handoff_hash)=64),
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, session_id TEXT NOT NULL, browser_session TEXT NOT NULL CHECK(json_valid(browser_session)), registration TEXT NOT NULL, originating_delegation TEXT CHECK(originating_delegation IS NULL OR json_valid(originating_delegation)), originating_credential TEXT CHECK(originating_credential IS NULL OR json_valid(originating_credential)),
  ownership_version INTEGER NOT NULL, billing_epoch_id TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, attempt_expires_at TEXT, attempt_id TEXT UNIQUE,
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id)
) STRICT;
CREATE TABLE connection_attempts (
  attempt_id TEXT PRIMARY KEY, handoff_hash TEXT NOT NULL UNIQUE REFERENCES connection_handoffs(handoff_hash),
  state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash)=64), cookie_hash TEXT NOT NULL CHECK(length(cookie_hash)=64),
  verifier_nonce TEXT NOT NULL, verifier_ciphertext TEXT NOT NULL, key_version INTEGER NOT NULL CHECK(key_version>0),
  oidc_nonce TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','exchange_claimed','awaiting_confirmation','active','denied','outcome_unknown')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
) STRICT;
CREATE TABLE connection_grants (
  grant_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES connection_attempts(attempt_id),
  subject TEXT NOT NULL, token_nonce TEXT NOT NULL, token_ciphertext TEXT NOT NULL, key_version INTEGER NOT NULL CHECK(key_version>0),
  generation INTEGER NOT NULL CHECK(generation>0), result_hash TEXT NOT NULL UNIQUE CHECK(length(result_hash)=64),
  state TEXT NOT NULL CHECK(state IN ('pending','active','refreshing','reconnect_required','disconnecting','disconnected')),
  confirmation_expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  refresh_claim_id TEXT, refresh_claim_expires_at TEXT, refresh_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(refresh_dispatched IN (0,1)),
  refresh_committed_claim_id TEXT, revocation_status TEXT CHECK(revocation_status IS NULL OR revocation_status IN ('pending','revoked','outcome_unknown')), revocation_claim_id TEXT, revocation_claim_expires_at TEXT, revocation_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(revocation_dispatched IN (0,1))
) STRICT;
CREATE TABLE integration_portal_handoffs (
  handoff_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, registration TEXT NOT NULL, credential_id TEXT NOT NULL, idempotency_key_hash TEXT NOT NULL,
  request_digest TEXT NOT NULL, originating_credential TEXT, originating_delegation TEXT,
  ownership_version INTEGER NOT NULL, billing_epoch_id TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
  UNIQUE(organization_id,principal_id,credential_id,idempotency_key_hash),
  CHECK((originating_credential IS NULL) <> (originating_delegation IS NULL)),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id)
) STRICT;
-- Tokens received after authority changed are retained only for bounded provider revocation; never executable.
CREATE TABLE connection_orphan_grants (
  attempt_id TEXT PRIMARY KEY REFERENCES connection_attempts(attempt_id), grant_id TEXT NOT NULL UNIQUE,
  subject TEXT, token_nonce TEXT NOT NULL, token_ciphertext TEXT NOT NULL, key_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('revocation_pending','revoked','outcome_unknown')), created_at TEXT NOT NULL, revocation_claim_id TEXT, revocation_claim_expires_at TEXT, revocation_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(revocation_dispatched IN (0,1))
) STRICT;
CREATE TABLE connection_refresh_orphans (
  grant_id TEXT NOT NULL REFERENCES connection_grants(grant_id), claim_id TEXT NOT NULL,
  previous_generation INTEGER NOT NULL, token_nonce TEXT NOT NULL, token_ciphertext TEXT NOT NULL, key_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('revocation_pending','revoked','outcome_unknown')), created_at TEXT NOT NULL,
  revocation_claim_id TEXT, revocation_claim_expires_at TEXT, revocation_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(revocation_dispatched IN (0,1)),
  PRIMARY KEY(grant_id,claim_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER connection_handoff_identity_immutable BEFORE UPDATE OF handoff_hash,organization_id,project_id,environment_id,principal_id,session_id,browser_session,registration,originating_delegation,originating_credential,ownership_version,billing_epoch_id,created_at,expires_at ON connection_handoffs BEGIN SELECT RAISE(ABORT,'connection handoff identity immutable'); END;
CREATE TRIGGER integration_portal_identity_immutable BEFORE UPDATE OF handoff_hash,organization_id,project_id,environment_id,principal_id,registration,credential_id,idempotency_key_hash,request_digest,originating_credential,originating_delegation,ownership_version,billing_epoch_id,created_at,expires_at ON integration_portal_handoffs BEGIN SELECT RAISE(ABORT,'integration portal identity immutable'); END;
CREATE TRIGGER connection_attempt_identity_immutable BEFORE UPDATE OF attempt_id,handoff_hash,state_hash,cookie_hash,verifier_nonce,verifier_ciphertext,key_version,oidc_nonce,created_at,expires_at ON connection_attempts BEGIN SELECT RAISE(ABORT,'connection attempt identity immutable'); END;
