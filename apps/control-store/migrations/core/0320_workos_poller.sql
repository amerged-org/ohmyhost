-- The original legacy API-key metadata (migration 002) is retained independently of WorkOS-held user keys.
-- An organization tombstone revokes it in the SAME batch as memberships, machine bindings, grants and inbox ACK.
CREATE TABLE api_key_metadata (
  api_key_id TEXT NOT NULL PRIMARY KEY CHECK (length(api_key_id) = 26 AND api_key_id GLOB '[0-7]*' AND api_key_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  created_by_principal_id TEXT NOT NULL,
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  key_digest BLOB NOT NULL UNIQUE CHECK (length(key_digest) = 32),
  key_prefix TEXT NOT NULL,
  pepper_version INTEGER NOT NULL CHECK (pepper_version > 0),
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array' AND json_array_length(scopes) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT CHECK (expires_at IS NULL OR (expires_at GLOB '????-??-??T??:??:??.??????Z' AND expires_at > created_at)),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (revoked_at GLOB '????-??-??T??:??:??.??????Z' AND revoked_at >= created_at)),
  last_used_at TEXT CHECK (last_used_at IS NULL OR last_used_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER api_key_metadata_scope_insert BEFORE INSERT ON api_key_metadata
WHEN EXISTS (SELECT 1 FROM json_each(NEW.scopes) WHERE type <> 'text' OR value NOT IN ('projects:read','projects:write','operations:read','audit:read'))
BEGIN SELECT RAISE(ABORT, 'invalid API key scopes'); END;
CREATE TRIGGER api_key_metadata_scope_update BEFORE UPDATE OF scopes ON api_key_metadata
WHEN EXISTS (SELECT 1 FROM json_each(NEW.scopes) WHERE type <> 'text' OR value NOT IN ('projects:read','projects:write','operations:read','audit:read'))
BEGIN SELECT RAISE(ABORT, 'invalid API key scopes'); END;
-- inbox_event_id was the original GLOBAL primary key, not an organization-local identifier.
CREATE UNIQUE INDEX webhook_inbox_global_id ON webhook_inbox (inbox_event_id);
