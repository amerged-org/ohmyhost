-- Original general-DNS token refresh holds the project/grant rows across provider work.
-- A private renewable use identity retains that exclusion without a SQL transaction over HTTP.
CREATE UNIQUE INDEX cloudflare_project_authorization_global_id ON cloudflare_project_authorization_states(authorization_id);
CREATE TABLE cloudflare_general_grant_uses (
 organization_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 use_id TEXT NOT NULL UNIQUE,
 authorization_id TEXT NOT NULL,
 grant_updated_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(organization_id,project_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER cloudflare_general_grant_use_update BEFORE UPDATE ON cloudflare_project_dns_grants
WHEN EXISTS(SELECT 1 FROM cloudflare_general_grant_uses use WHERE use.organization_id=OLD.organization_id AND use.project_id=OLD.project_id AND use.expires_at>strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
BEGIN SELECT RAISE(ABORT,'General Cloudflare grant is held by a provider use'); END;
CREATE TRIGGER cloudflare_general_grant_use_delete BEFORE DELETE ON cloudflare_project_dns_grants
WHEN EXISTS(SELECT 1 FROM cloudflare_general_grant_uses use WHERE use.organization_id=OLD.organization_id AND use.project_id=OLD.project_id AND use.expires_at>strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
BEGIN SELECT RAISE(ABORT,'General Cloudflare grant is held by a provider use'); END;
CREATE TRIGGER cloudflare_general_project_use_update BEFORE UPDATE ON projects
WHEN EXISTS(SELECT 1 FROM cloudflare_general_grant_uses use WHERE use.organization_id=OLD.organization_id AND use.project_id=OLD.project_id AND use.expires_at>strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
BEGIN SELECT RAISE(ABORT,'Project is held by a general Cloudflare grant use'); END;
