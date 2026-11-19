-- A re-authorization of a customer DNS grant replaces the grant's token pair. The replaced refresh token stays live at
-- Cloudflare until it is revoked, so the pair is recorded here (expand-only; new table) and the Domain Management sweep
-- revokes it, keeps the row until Cloudflare accepts the revoke, then deletes it.
CREATE TABLE scoped_customer_dns_displaced_tokens (
  displaced_id       TEXT PRIMARY KEY CHECK (length(displaced_id) = 26),
  organization_id    TEXT NOT NULL CHECK (length(organization_id) = 26),
  purpose            TEXT NOT NULL CHECK (purpose IN ('application_identity', 'workspace_mail')),
  resource_id        TEXT NOT NULL CHECK (length(resource_id) = 26),
  resource_revision  INTEGER NOT NULL CHECK (resource_revision > 0),
  authorization_id   TEXT NOT NULL CHECK (length(authorization_id) = 26),
  key_version        INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 2147483647),
  refresh_ciphertext BLOB NOT NULL CHECK (length(refresh_ciphertext) > 0),
  refresh_nonce      BLOB NOT NULL CHECK (length(refresh_nonce) = 12),
  displaced_at       TEXT NOT NULL CHECK (displaced_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
CREATE INDEX scoped_customer_dns_displaced_tokens_by_org ON scoped_customer_dns_displaced_tokens (organization_id, purpose, resource_id);
