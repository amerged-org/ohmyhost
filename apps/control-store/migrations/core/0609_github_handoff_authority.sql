-- The immutable authority accepted with an agent-originated GitHub connection attempt.
ALTER TABLE github_connection_authorizations ADD COLUMN handoff_delegation TEXT;
CREATE TABLE github_connection_provider_uses (
  authorization_id TEXT PRIMARY KEY REFERENCES github_connection_authorizations(authorization_id),
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  consent_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX github_connection_provider_uses_consent ON github_connection_provider_uses(user_id,client_id,consent_hash,organization_id,expires_at);
