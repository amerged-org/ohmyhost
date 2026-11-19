-- Restore original065 receipt columns beside the existing runtime body projection.
-- This forward migration is only for a never-served Core; captured JSONB/arrays/instants remain opaque.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
-- A populated prototype lacks original fields; refuse to manufacture unknown Source values.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM cloudflare_project_domain_receipts);
CREATE UNIQUE INDEX cloudflare_project_authorization_states_global_id ON cloudflare_project_authorization_states(authorization_id);
CREATE UNIQUE INDEX cloudflare_project_domain_receipts_global_id ON cloudflare_project_domain_receipts(receipt_id);
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN zone_id TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN zone_name TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN dns_type TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN dns_name TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN dns_content TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN dns_ttl INTEGER;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN dns_proxied INTEGER;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN dns_comment TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN hostname_status TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN provider_created_at TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN ownership_verification TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN ownership_verification_http TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN verification_errors TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN ssl_status TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN ssl_type TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN ssl_method TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN ssl_bundle_method TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN ssl_certificate_authority TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN ssl_validation_records TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN route_pattern TEXT;
ALTER TABLE cloudflare_project_domain_receipts ADD COLUMN route_script TEXT;

DROP TRIGGER scoped_customer_dns_authorizations_current_insert;
CREATE TRIGGER scoped_customer_dns_authorizations_current_insert BEFORE INSERT ON scoped_customer_dns_authorizations WHEN NOT(EXISTS(SELECT 1 FROM core_historical_import i WHERE i.singleton=1 AND i.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM core_authority_activation) AND EXISTS(SELECT 1 FROM json_each(i.temporal_tables) WHERE value='scoped_customer_dns_authorizations'))) AND NEW.revoked_at IS NULL AND NOT(CASE NEW.purpose WHEN 'application_identity' THEN EXISTS(SELECT 1 FROM project_application_domain_identities identity JOIN projects project ON project.project_id=identity.project_id AND project.organization_id=identity.organization_id AND project.owner_state='active' AND project.lifecycle_state='active' WHERE identity.organization_id=NEW.organization_id AND identity.project_id=NEW.resource_id AND identity.revision=NEW.resource_revision AND identity.state IN('pending','verified') AND(identity.state='verified' OR identity.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) AND(identity.hostname=NEW.zone_name OR substr(identity.hostname,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) WHEN 'workspace_mail' THEN EXISTS(SELECT 1 FROM workspace_mail_domains domain WHERE domain.organization_id=NEW.organization_id AND domain.domain_id=NEW.resource_id AND domain.revision=NEW.resource_revision AND domain.status IN('active','retiring') AND(domain.domain=NEW.zone_name OR substr(domain.domain,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) ELSE 0 END) BEGIN SELECT RAISE(ABORT,'Scoped DNS resource declaration is stale'); END;

DROP TRIGGER scoped_customer_dns_grants_current_insert;
CREATE TRIGGER scoped_customer_dns_grants_current_insert BEFORE INSERT ON scoped_customer_dns_grants WHEN NOT(EXISTS(SELECT 1 FROM core_historical_import i WHERE i.singleton=1 AND i.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM core_authority_activation) AND EXISTS(SELECT 1 FROM json_each(i.temporal_tables) WHERE value='scoped_customer_dns_grants'))) AND NEW.revoked_at IS NULL AND NOT(CASE NEW.purpose WHEN 'application_identity' THEN EXISTS(SELECT 1 FROM project_application_domain_identities identity JOIN projects project ON project.project_id=identity.project_id AND project.organization_id=identity.organization_id AND project.owner_state='active' AND project.lifecycle_state='active' WHERE identity.organization_id=NEW.organization_id AND identity.project_id=NEW.resource_id AND identity.revision=NEW.resource_revision AND identity.state IN('pending','verified') AND(identity.state='verified' OR identity.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) AND(identity.hostname=NEW.zone_name OR substr(identity.hostname,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) WHEN 'workspace_mail' THEN EXISTS(SELECT 1 FROM workspace_mail_domains domain WHERE domain.organization_id=NEW.organization_id AND domain.domain_id=NEW.resource_id AND domain.revision=NEW.resource_revision AND domain.status IN('active','retiring') AND(domain.domain=NEW.zone_name OR substr(domain.domain,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) ELSE 0 END) BEGIN SELECT RAISE(ABORT,'Scoped DNS resource declaration is stale'); END;
