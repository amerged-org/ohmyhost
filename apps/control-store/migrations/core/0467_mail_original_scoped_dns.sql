-- Original201 scoped DNS consent and sealed grant identities. Empty prototype preparation only.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE mail_scoped_empty_guard_0467(value INTEGER NOT NULL CHECK(value=0)) STRICT;
INSERT INTO mail_scoped_empty_guard_0467 SELECT 1 WHERE EXISTS(SELECT 1 FROM scoped_customer_dns_authorizations) OR EXISTS(SELECT 1 FROM scoped_customer_dns_grants) OR EXISTS(SELECT 1 FROM scoped_customer_dns_revocations);
DROP TABLE scoped_customer_dns_grants;
DROP TABLE scoped_customer_dns_authorizations;
DROP TABLE scoped_customer_dns_revocations;
CREATE TABLE scoped_customer_dns_authorizations (
 authorization_id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES org_directory(organization_id),
 purpose TEXT NOT NULL CHECK(purpose IN('application_identity','workspace_mail')),
 resource_id TEXT NOT NULL,
 resource_revision INTEGER NOT NULL CHECK(resource_revision>0),
 principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 256 AND instr(principal_id,char(0))=0),
 delegation TEXT CHECK(delegation IS NULL OR(json_valid(delegation) AND json_type(delegation)='object')),
 zone_name TEXT NOT NULL CHECK(instr(zone_name,char(0))=0),
 state_sha256 BLOB NOT NULL CHECK(length(state_sha256)=32),
 idempotency_key_sha256 BLOB NOT NULL CHECK(length(idempotency_key_sha256)=32),
 request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),
 issued_at TEXT NOT NULL,
 expires_at TEXT NOT NULL CHECK(expires_at>issued_at AND expires_at<=(strftime('%Y-%m-%dT%H:%M:%S',substr(issued_at,1,19),'+10 minutes')||substr(issued_at,20))),
 consumed_at TEXT,
 revoked_at TEXT,
 dns_receipts TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(dns_receipts) AND json_type(dns_receipts)='object'),
 UNIQUE(organization_id,purpose,resource_id,idempotency_key_sha256),
 UNIQUE(authorization_id,organization_id,purpose,resource_id,resource_revision),
 CHECK(consumed_at IS NULL OR(consumed_at>=issued_at AND consumed_at<expires_at)),
 CHECK(length(authorization_id)=26 AND length(CAST(authorization_id AS BLOB))=26 AND substr(authorization_id,1,1) BETWEEN '0' AND '7' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(length(resource_id)=26 AND length(CAST(resource_id AS BLOB))=26 AND substr(resource_id,1,1) BETWEEN '0' AND '7' AND resource_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(issued_at IS NULL OR(length(issued_at)=27 AND length(CAST(issued_at AS BLOB))=27 AND issued_at GLOB '????-??-??T??:??:??.??????Z')),
 CHECK(expires_at IS NULL OR(length(expires_at)=27 AND length(CAST(expires_at AS BLOB))=27 AND expires_at GLOB '????-??-??T??:??:??.??????Z')),
 CHECK(consumed_at IS NULL OR(length(consumed_at)=27 AND length(CAST(consumed_at AS BLOB))=27 AND consumed_at GLOB '????-??-??T??:??:??.??????Z')),
 CHECK(revoked_at IS NULL OR(length(revoked_at)=27 AND length(CAST(revoked_at AS BLOB))=27 AND revoked_at GLOB '????-??-??T??:??:??.??????Z'))
) STRICT, WITHOUT ROWID;
CREATE TABLE scoped_customer_dns_grants (
 organization_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN('application_identity','workspace_mail')),
 resource_id TEXT NOT NULL,
 resource_revision INTEGER NOT NULL CHECK(resource_revision>0),
 authorization_id TEXT NOT NULL,
 principal_id TEXT NOT NULL CHECK(instr(principal_id,char(0))=0),
 zone_name TEXT NOT NULL CHECK(instr(zone_name,char(0))=0),
 zone_id TEXT NOT NULL CHECK(length(zone_id)=32 AND length(CAST(zone_id AS BLOB))=32 AND zone_id NOT GLOB '*[^a-f0-9]*'),
 account_id TEXT NOT NULL CHECK(length(account_id)=32 AND length(CAST(account_id AS BLOB))=32 AND account_id NOT GLOB '*[^a-f0-9]*'),
 access_ciphertext BLOB NOT NULL,
 access_nonce BLOB NOT NULL CHECK(length(access_nonce)=12),
 refresh_ciphertext BLOB NOT NULL,
 refresh_nonce BLOB NOT NULL CHECK(length(refresh_nonce)=12),
 key_version INTEGER NOT NULL CHECK(key_version BETWEEN 1 AND 2147483647),
 access_expires_at TEXT NOT NULL,
 connected_at TEXT NOT NULL,
 revoked_at TEXT,
 dns_receipts TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dns_receipts) AND json_type(dns_receipts)='array'),
 PRIMARY KEY(organization_id,purpose,resource_id),
 FOREIGN KEY(authorization_id,organization_id,purpose,resource_id,resource_revision) REFERENCES scoped_customer_dns_authorizations(authorization_id,organization_id,purpose,resource_id,resource_revision),
 CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(length(resource_id)=26 AND length(CAST(resource_id AS BLOB))=26 AND substr(resource_id,1,1) BETWEEN '0' AND '7' AND resource_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(length(authorization_id)=26 AND length(CAST(authorization_id AS BLOB))=26 AND substr(authorization_id,1,1) BETWEEN '0' AND '7' AND authorization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(access_expires_at IS NULL OR(length(access_expires_at)=27 AND length(CAST(access_expires_at AS BLOB))=27 AND access_expires_at GLOB '????-??-??T??:??:??.??????Z')),
 CHECK(connected_at IS NULL OR(length(connected_at)=27 AND length(CAST(connected_at AS BLOB))=27 AND connected_at GLOB '????-??-??T??:??:??.??????Z')),
 CHECK(revoked_at IS NULL OR(length(revoked_at)=27 AND length(CAST(revoked_at AS BLOB))=27 AND revoked_at GLOB '????-??-??T??:??:??.??????Z'))
) STRICT, WITHOUT ROWID;
CREATE TABLE scoped_customer_dns_revocations (
 organization_id TEXT NOT NULL REFERENCES org_directory(organization_id),
 purpose TEXT NOT NULL CHECK(purpose IN('application_identity','workspace_mail')),
 resource_id TEXT NOT NULL,
 resource_revision INTEGER NOT NULL CHECK(resource_revision>0),
 principal_id TEXT NOT NULL CHECK(instr(principal_id,char(0))=0),
 idempotency_key_sha256 BLOB NOT NULL CHECK(length(idempotency_key_sha256)=32),
 request_sha256 BLOB NOT NULL CHECK(length(request_sha256)=32),
 revoked_at TEXT NOT NULL,
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'),
 PRIMARY KEY(organization_id,purpose,resource_id,idempotency_key_sha256),
 CHECK(length(organization_id)=26 AND length(CAST(organization_id AS BLOB))=26 AND substr(organization_id,1,1) BETWEEN '0' AND '7' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(length(resource_id)=26 AND length(CAST(resource_id AS BLOB))=26 AND substr(resource_id,1,1) BETWEEN '0' AND '7' AND resource_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 CHECK(revoked_at IS NULL OR(length(revoked_at)=27 AND length(CAST(revoked_at AS BLOB))=27 AND revoked_at GLOB '????-??-??T??:??:??.??????Z'))
) STRICT, WITHOUT ROWID;
CREATE INDEX scoped_customer_dns_authorizations_resource ON scoped_customer_dns_authorizations(organization_id,purpose,resource_id,issued_at DESC);
CREATE INDEX scoped_customer_dns_authorizations_purge ON scoped_customer_dns_authorizations(expires_at);
CREATE INDEX scoped_customer_dns_revocations_purge ON scoped_customer_dns_revocations(revoked_at);
DROP TABLE mail_scoped_empty_guard_0467;

CREATE TRIGGER scoped_customer_dns_authorizations_current_insert BEFORE INSERT ON scoped_customer_dns_authorizations WHEN NEW.revoked_at IS NULL AND NOT(CASE NEW.purpose WHEN 'application_identity' THEN EXISTS(SELECT 1 FROM project_application_domain_identities identity JOIN projects project ON project.project_id=identity.project_id AND project.organization_id=identity.organization_id AND project.owner_state='active' AND project.lifecycle_state='active' WHERE identity.organization_id=NEW.organization_id AND identity.project_id=NEW.resource_id AND identity.revision=NEW.resource_revision AND identity.state IN('pending','verified') AND(identity.state='verified' OR identity.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) AND(identity.hostname=NEW.zone_name OR substr(identity.hostname,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) WHEN 'workspace_mail' THEN EXISTS(SELECT 1 FROM workspace_mail_domains domain WHERE domain.organization_id=NEW.organization_id AND domain.domain_id=NEW.resource_id AND domain.revision=NEW.resource_revision AND domain.status IN('active','retiring') AND(domain.domain=NEW.zone_name OR substr(domain.domain,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) ELSE 0 END) BEGIN SELECT RAISE(ABORT,'Scoped DNS resource declaration is stale'); END;

CREATE TRIGGER scoped_customer_dns_grants_current_insert BEFORE INSERT ON scoped_customer_dns_grants WHEN NEW.revoked_at IS NULL AND NOT(CASE NEW.purpose WHEN 'application_identity' THEN EXISTS(SELECT 1 FROM project_application_domain_identities identity JOIN projects project ON project.project_id=identity.project_id AND project.organization_id=identity.organization_id AND project.owner_state='active' AND project.lifecycle_state='active' WHERE identity.organization_id=NEW.organization_id AND identity.project_id=NEW.resource_id AND identity.revision=NEW.resource_revision AND identity.state IN('pending','verified') AND(identity.state='verified' OR identity.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) AND(identity.hostname=NEW.zone_name OR substr(identity.hostname,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) WHEN 'workspace_mail' THEN EXISTS(SELECT 1 FROM workspace_mail_domains domain WHERE domain.organization_id=NEW.organization_id AND domain.domain_id=NEW.resource_id AND domain.revision=NEW.resource_revision AND domain.status IN('active','retiring') AND(domain.domain=NEW.zone_name OR substr(domain.domain,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) ELSE 0 END) BEGIN SELECT RAISE(ABORT,'Scoped DNS resource declaration is stale'); END;
CREATE TRIGGER scoped_customer_dns_grants_authority_insert BEFORE INSERT ON scoped_customer_dns_grants WHEN NEW.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM scoped_customer_dns_authorizations auth WHERE auth.authorization_id=NEW.authorization_id AND auth.organization_id=NEW.organization_id AND auth.purpose=NEW.purpose AND auth.resource_id=NEW.resource_id AND auth.resource_revision=NEW.resource_revision AND auth.principal_id=NEW.principal_id AND auth.zone_name=NEW.zone_name AND auth.consumed_at IS NOT NULL AND auth.revoked_at IS NULL AND auth.consumed_at<=NEW.connected_at AND NEW.connected_at<auth.expires_at) BEGIN SELECT RAISE(ABORT,'Scoped DNS authorization is unavailable'); END;

CREATE TRIGGER scoped_customer_dns_authorizations_current_update BEFORE UPDATE ON scoped_customer_dns_authorizations WHEN NEW.revoked_at IS NULL AND NOT(CASE NEW.purpose WHEN 'application_identity' THEN EXISTS(SELECT 1 FROM project_application_domain_identities identity JOIN projects project ON project.project_id=identity.project_id AND project.organization_id=identity.organization_id AND project.owner_state='active' AND project.lifecycle_state='active' WHERE identity.organization_id=NEW.organization_id AND identity.project_id=NEW.resource_id AND identity.revision=NEW.resource_revision AND identity.state IN('pending','verified') AND(identity.state='verified' OR identity.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) AND(identity.hostname=NEW.zone_name OR substr(identity.hostname,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) WHEN 'workspace_mail' THEN EXISTS(SELECT 1 FROM workspace_mail_domains domain WHERE domain.organization_id=NEW.organization_id AND domain.domain_id=NEW.resource_id AND domain.revision=NEW.resource_revision AND domain.status IN('active','retiring') AND(domain.domain=NEW.zone_name OR substr(domain.domain,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) ELSE 0 END) BEGIN SELECT RAISE(ABORT,'Scoped DNS resource declaration is stale'); END;

CREATE TRIGGER scoped_customer_dns_grants_current_update BEFORE UPDATE ON scoped_customer_dns_grants WHEN NEW.revoked_at IS NULL AND NOT(CASE NEW.purpose WHEN 'application_identity' THEN EXISTS(SELECT 1 FROM project_application_domain_identities identity JOIN projects project ON project.project_id=identity.project_id AND project.organization_id=identity.organization_id AND project.owner_state='active' AND project.lifecycle_state='active' WHERE identity.organization_id=NEW.organization_id AND identity.project_id=NEW.resource_id AND identity.revision=NEW.resource_revision AND identity.state IN('pending','verified') AND(identity.state='verified' OR identity.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) AND(identity.hostname=NEW.zone_name OR substr(identity.hostname,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) WHEN 'workspace_mail' THEN EXISTS(SELECT 1 FROM workspace_mail_domains domain WHERE domain.organization_id=NEW.organization_id AND domain.domain_id=NEW.resource_id AND domain.revision=NEW.resource_revision AND domain.status IN('active','retiring') AND(domain.domain=NEW.zone_name OR substr(domain.domain,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) ELSE 0 END) BEGIN SELECT RAISE(ABORT,'Scoped DNS resource declaration is stale'); END;
CREATE TRIGGER scoped_customer_dns_grants_authority_update BEFORE UPDATE ON scoped_customer_dns_grants WHEN NEW.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM scoped_customer_dns_authorizations auth WHERE auth.authorization_id=NEW.authorization_id AND auth.organization_id=NEW.organization_id AND auth.purpose=NEW.purpose AND auth.resource_id=NEW.resource_id AND auth.resource_revision=NEW.resource_revision AND auth.principal_id=NEW.principal_id AND auth.zone_name=NEW.zone_name AND auth.consumed_at IS NOT NULL AND auth.revoked_at IS NULL AND auth.consumed_at<=NEW.connected_at AND NEW.connected_at<auth.expires_at) BEGIN SELECT RAISE(ABORT,'Scoped DNS authorization is unavailable'); END;

CREATE TRIGGER scoped_customer_dns_authorizations_identity BEFORE UPDATE ON scoped_customer_dns_authorizations WHEN NEW.authorization_id IS NOT OLD.authorization_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.purpose IS NOT OLD.purpose OR NEW.resource_id IS NOT OLD.resource_id OR NEW.resource_revision IS NOT OLD.resource_revision OR NEW.principal_id IS NOT OLD.principal_id OR NEW.delegation IS NOT OLD.delegation OR NEW.zone_name IS NOT OLD.zone_name OR NEW.state_sha256 IS NOT OLD.state_sha256 OR NEW.idempotency_key_sha256 IS NOT OLD.idempotency_key_sha256 OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at BEGIN SELECT RAISE(ABORT,'Scoped DNS authorization identity is immutable'); END;
