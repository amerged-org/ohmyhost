-- Technical replacement for original scoped-DNS transaction/advisory row locks across awaited provider calls.
-- This is not a Source/provider observation or activation marker. Expired uses grant no further effect permission.
CREATE TABLE scoped_dns_provider_uses (
 organization_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN('application_identity','workspace_mail')),
 resource_id TEXT NOT NULL,
 authorization_id TEXT NOT NULL,
 principal_id TEXT NOT NULL CHECK(instr(principal_id,char(0))=0),
 delegation_grant_id TEXT,
 lease_token TEXT NOT NULL,
 created_at TEXT NOT NULL,
 lease_until TEXT NOT NULL CHECK(lease_until>created_at),
 PRIMARY KEY(organization_id,purpose,resource_id),
 UNIQUE(lease_token),
 CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(length(resource_id)=26 AND length(CAST(resource_id AS BLOB))=26 AND substr(resource_id,1,1) BETWEEN '0' AND '7' AND resource_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(length(authorization_id)=26 AND length(CAST(authorization_id AS BLOB))=26 AND substr(authorization_id,1,1) BETWEEN '0' AND '7' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(length(lease_token)=36 AND length(CAST(lease_token AS BLOB))=36 AND substr(lease_token,9,1)='-' AND substr(lease_token,14,1)='-' AND substr(lease_token,19,1)='-' AND substr(lease_token,24,1)='-' AND length(replace(lease_token,'-',''))=32 AND replace(lease_token,'-','') NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(created_at)=27 AND length(CAST(created_at AS BLOB))=27 AND created_at GLOB '????-??-??T??:??:??.??????Z'),
 CHECK(length(lease_until)=27 AND length(CAST(lease_until AS BLOB))=27 AND lease_until GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
CREATE INDEX scoped_dns_provider_uses_expiry ON scoped_dns_provider_uses(lease_until,organization_id,purpose,resource_id);

CREATE TRIGGER scoped_dns_use_project_application_domain_identities_update BEFORE UPDATE ON project_application_domain_identities
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='application_identity' AND lease.organization_id=OLD.organization_id AND lease.resource_id=OLD.project_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_project_application_domain_identities_delete BEFORE DELETE ON project_application_domain_identities
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='application_identity' AND lease.organization_id=OLD.organization_id AND lease.resource_id=OLD.project_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_projects_update BEFORE UPDATE ON projects
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='application_identity' AND lease.organization_id=OLD.organization_id AND lease.resource_id=OLD.project_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_projects_delete BEFORE DELETE ON projects
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='application_identity' AND lease.organization_id=OLD.organization_id AND lease.resource_id=OLD.project_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_workspace_mail_domains_update BEFORE UPDATE ON workspace_mail_domains
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='workspace_mail' AND lease.organization_id=OLD.organization_id AND lease.resource_id=OLD.domain_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_workspace_mail_domains_delete BEFORE DELETE ON workspace_mail_domains
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='workspace_mail' AND lease.organization_id=OLD.organization_id AND lease.resource_id=OLD.domain_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_organization_memberships_update BEFORE UPDATE ON organization_memberships
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND OLD.state='active' AND lease.organization_id=OLD.organization_id AND lease.principal_id='user:'||OLD.workos_user_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_organization_memberships_delete BEFORE DELETE ON organization_memberships
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND OLD.state='active' AND lease.organization_id=OLD.organization_id AND lease.principal_id='user:'||OLD.workos_user_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_local_authorization_grants_update BEFORE UPDATE ON local_authorization_grants
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND OLD.revoked_at IS NULL AND lease.organization_id=OLD.organization_id AND lease.principal_id=OLD.principal_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_local_authorization_grants_delete BEFORE DELETE ON local_authorization_grants
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND OLD.revoked_at IS NULL AND lease.organization_id=OLD.organization_id AND lease.principal_id=OLD.principal_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_mcp_client_grants_update BEFORE UPDATE ON mcp_client_grants
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='application_identity' AND lease.delegation_grant_id=OLD.grant_id AND lease.organization_id=OLD.organization_id AND OLD.revoked_at IS NULL)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_mcp_client_grants_delete BEFORE DELETE ON mcp_client_grants
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='application_identity' AND lease.delegation_grant_id=OLD.grant_id AND lease.organization_id=OLD.organization_id AND OLD.revoked_at IS NULL)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_mcp_mail_domain_grants_update BEFORE UPDATE ON mcp_mail_domain_grants
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='workspace_mail' AND lease.delegation_grant_id=OLD.grant_id AND lease.organization_id=OLD.organization_id AND OLD.revoked_at IS NULL)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_mcp_mail_domain_grants_delete BEFORE DELETE ON mcp_mail_domain_grants
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.purpose='workspace_mail' AND lease.delegation_grant_id=OLD.grant_id AND lease.organization_id=OLD.organization_id AND OLD.revoked_at IS NULL)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_scoped_customer_dns_authorizations_update BEFORE UPDATE ON scoped_customer_dns_authorizations
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.organization_id=OLD.organization_id AND lease.purpose=OLD.purpose AND lease.resource_id=OLD.resource_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_scoped_customer_dns_authorizations_delete BEFORE DELETE ON scoped_customer_dns_authorizations
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.organization_id=OLD.organization_id AND lease.purpose=OLD.purpose AND lease.resource_id=OLD.resource_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_scoped_customer_dns_grants_update BEFORE UPDATE ON scoped_customer_dns_grants
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.organization_id=OLD.organization_id AND lease.purpose=OLD.purpose AND lease.resource_id=OLD.resource_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_scoped_customer_dns_grants_delete BEFORE DELETE ON scoped_customer_dns_grants
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.organization_id=OLD.organization_id AND lease.purpose=OLD.purpose AND lease.resource_id=OLD.resource_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_scoped_customer_dns_authorizations_insert BEFORE INSERT ON scoped_customer_dns_authorizations
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.organization_id=NEW.organization_id AND lease.purpose=NEW.purpose AND lease.resource_id=NEW.resource_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;

CREATE TRIGGER scoped_dns_use_scoped_customer_dns_grants_insert BEFORE INSERT ON scoped_customer_dns_grants
 WHEN EXISTS(SELECT 1 FROM scoped_dns_provider_uses lease WHERE lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND lease.organization_id=NEW.organization_id AND lease.purpose=NEW.purpose AND lease.resource_id=NEW.resource_id)
 BEGIN INSERT INTO guard_fail(code)VALUES('precondition_changed'); END;
