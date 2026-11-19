-- One client-chosen subscription and immutable activation receipts per logical environment.
-- Secrets are sealed before reaching Core; neither webhook headers nor plaintext secrets are stored here.
CREATE TABLE database_webhook_subscriptions (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('dev','prod')),
  subscription_id TEXT NOT NULL CHECK(length(subscription_id)=26),
  physical_environment_id TEXT NOT NULL,
  provider_project_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('creating','active','deactivating','inactive')),
  provider_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,project_id,environment,subscription_id),
  CHECK(state NOT IN ('active','deactivating') OR provider_id IS NOT NULL)
);
CREATE INDEX database_webhook_subscriptions_capacity ON database_webhook_subscriptions(provider_project_id,database_id,state);

CREATE TABLE database_webhook_activation_receipts (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  request_key_sha256 BLOB NOT NULL CHECK(length(request_key_sha256)=32),
  request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),
  provider_id TEXT,
  secret_ciphertext BLOB,
  secret_nonce BLOB,
  secret_sha256 BLOB,
  secret_key_version INTEGER,
  delete_key_sha256 BLOB CHECK(delete_key_sha256 IS NULL OR length(delete_key_sha256)=32),
  abort_reason TEXT CHECK(abort_reason IS NULL OR abort_reason IN ('webhook_limit','idempotency_key_reused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,project_id,environment,subscription_id,generation),
  UNIQUE(organization_id,project_id,environment,request_key_sha256),
  FOREIGN KEY(organization_id,project_id,environment,subscription_id)
    REFERENCES database_webhook_subscriptions(organization_id,project_id,environment,subscription_id),
  CHECK((provider_id IS NULL AND secret_ciphertext IS NULL AND secret_nonce IS NULL AND secret_sha256 IS NULL AND secret_key_version IS NULL)
    OR (provider_id IS NOT NULL AND length(secret_ciphertext)>=17 AND length(secret_nonce)=12 AND length(secret_sha256)=32 AND secret_key_version>=1))
);
CREATE UNIQUE INDEX database_webhook_deactivation_keys ON database_webhook_activation_receipts(organization_id,project_id,environment,delete_key_sha256) WHERE delete_key_sha256 IS NOT NULL;
CREATE TRIGGER database_webhook_activation_identity_immutable BEFORE UPDATE ON database_webhook_activation_receipts
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id
 OR NEW.environment IS NOT OLD.environment OR NEW.subscription_id IS NOT OLD.subscription_id
 OR NEW.generation IS NOT OLD.generation OR NEW.request_key_sha256 IS NOT OLD.request_key_sha256
 OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.provider_id IS NOT NULL AND (NEW.provider_id IS NOT OLD.provider_id OR NEW.secret_ciphertext IS NOT OLD.secret_ciphertext
   OR NEW.secret_nonce IS NOT OLD.secret_nonce OR NEW.secret_sha256 IS NOT OLD.secret_sha256 OR NEW.secret_key_version IS NOT OLD.secret_key_version))
 OR (OLD.delete_key_sha256 IS NOT NULL AND NEW.delete_key_sha256 IS NOT OLD.delete_key_sha256)
 OR (OLD.abort_reason IS NOT NULL AND NEW.abort_reason IS NOT OLD.abort_reason)
BEGIN SELECT RAISE(ABORT,'webhook activation receipt is immutable'); END;
