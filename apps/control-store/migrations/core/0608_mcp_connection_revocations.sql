-- Terminal disconnection is independent of membership and covers later workspaces.
CREATE TABLE mcp_connection_revocations (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  consent_hash TEXT NOT NULL CHECK (length(consent_hash) = 64),
  revoked_at TEXT NOT NULL CHECK (revoked_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (user_id, client_id, consent_hash)
) STRICT, WITHOUT ROWID;
-- Keep each ownership/billing generation as a separate proof: old operations retain their FK.
DROP INDEX mcp_client_grants_consent_scope;
CREATE UNIQUE INDEX mcp_client_grants_consent_epoch
  ON mcp_client_grants(organization_id,user_id,client_id,consent_hash,COALESCE(project_id,''),COALESCE(ownership_version,-1),COALESCE(billing_epoch_id,''));
-- NULL restriction is the full-default credential; an object with empty arrays is deny-all for those dimensions.
ALTER TABLE operation_mcp_delegations ADD COLUMN authorization_action TEXT;
ALTER TABLE operation_mcp_delegations ADD COLUMN authorization_restriction TEXT CHECK (authorization_restriction IS NULL OR (json_valid(authorization_restriction) AND json_type(authorization_restriction)='object'));
ALTER TABLE managed_source_publications ADD COLUMN delegation_action TEXT;
ALTER TABLE managed_source_publications ADD COLUMN delegation_restriction TEXT CHECK (delegation_restriction IS NULL OR (json_valid(delegation_restriction) AND json_type(delegation_restriction)='object'));
ALTER TABLE managed_source_initializations ADD COLUMN delegation_action TEXT;
ALTER TABLE managed_source_initializations ADD COLUMN delegation_restriction TEXT CHECK (delegation_restriction IS NULL OR (json_valid(delegation_restriction) AND json_type(delegation_restriction)='object'));
-- Removed project-selection grants were not disconnects; restore their evidence only
-- where the explicit workspace tombstone does not exist. Epoch pins stay untouched.
UPDATE mcp_client_grants AS g SET revoked_at=NULL
WHERE g.revoked_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=g.organization_id
    AND r.user_id=g.user_id AND r.client_id=g.client_id AND r.consent_hash=g.consent_hash
);
CREATE TRIGGER managed_source_initializations_restriction_immutable BEFORE UPDATE ON managed_source_initializations
WHEN NEW.delegation_action IS NOT OLD.delegation_action OR NEW.delegation_restriction IS NOT OLD.delegation_restriction
BEGIN SELECT RAISE(ABORT, 'managed_source_initialization_authority_immutable'); END;
CREATE TRIGGER managed_source_publications_restriction_immutable BEFORE UPDATE ON managed_source_publications
WHEN NEW.delegation_action IS NOT OLD.delegation_action OR NEW.delegation_restriction IS NOT OLD.delegation_restriction
BEGIN SELECT RAISE(ABORT, 'managed_source_publication_authority_immutable'); END;
ALTER TABLE mcp_portal_handoffs ADD COLUMN authority TEXT CHECK (authority IS NULL OR (json_valid(authority) AND json_type(authority)='object'));
-- Reconcile still-live old handoffs using full-default historic token semantics.
-- Do not repin a secret handoff whose original project ownership cannot be proven.
CREATE TABLE mcp_handoff_conversion_epoch_guard(value INTEGER NOT NULL CHECK(value=0)) STRICT;
INSERT INTO mcp_handoff_conversion_epoch_guard(value)
 SELECT CASE WHEN EXISTS(SELECT 1 FROM mcp_portal_handoffs h
  LEFT JOIN projects p ON p.organization_id=h.organization_id AND p.project_id=json_extract(h.secret_target,'$.projectId')
  LEFT JOIN billing_epochs e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.billing_epoch_id=p.active_billing_epoch_id
  WHERE h.kind='secret' AND h.consumed_at IS NULL AND h.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
    AND (p.project_id IS NULL OR p.ownership_version<>1 OR e.billing_epoch_id IS NULL OR e.started_at>h.created_at OR e.ended_at IS NOT NULL)) THEN 1 ELSE 0 END;
DROP TABLE mcp_handoff_conversion_epoch_guard;
INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at)
 SELECT h.organization_id,lower(substr(hex(randomblob(16)),1,8)||'-'||substr(hex(randomblob(16)),1,4)||'-'||substr(hex(randomblob(16)),1,4)||'-'||substr(hex(randomblob(16)),1,4)||'-'||substr(hex(randomblob(16)),1,12)),
 h.user_id,h.client_id,h.consent_hash,CASE h.kind WHEN 'secret' THEN p.project_id ELSE NULL END,
 CASE h.kind WHEN 'secret' THEN p.ownership_version ELSE NULL END,CASE h.kind WHEN 'secret' THEN p.active_billing_epoch_id ELSE NULL END,1,1,MIN(h.created_at)
 FROM mcp_portal_handoffs h LEFT JOIN projects p ON p.organization_id=h.organization_id AND p.project_id=json_extract(h.secret_target,'$.projectId')
 WHERE h.kind IN('secret','github') AND h.consumed_at IS NULL AND h.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
 AND (h.kind='github' OR p.project_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=h.organization_id AND r.user_id=h.user_id AND r.client_id=h.client_id AND r.consent_hash=h.consent_hash)
 AND NOT EXISTS(SELECT 1 FROM mcp_client_grants g WHERE g.organization_id=h.organization_id AND g.user_id=h.user_id AND g.client_id=h.client_id AND g.consent_hash=h.consent_hash
   AND g.project_id IS CASE h.kind WHEN 'secret' THEN p.project_id ELSE NULL END
   AND g.ownership_version IS CASE h.kind WHEN 'secret' THEN p.ownership_version ELSE NULL END
   AND g.billing_epoch_id IS CASE h.kind WHEN 'secret' THEN p.active_billing_epoch_id ELSE NULL END)
 GROUP BY h.organization_id,h.user_id,h.client_id,h.consent_hash,h.kind,p.project_id,p.ownership_version,p.active_billing_epoch_id;
UPDATE mcp_portal_handoffs AS h SET authority=(SELECT json_object('grantId',g.grant_id,'clientId',h.client_id,'consentHash',h.consent_hash,'action',CASE h.kind WHEN 'secret' THEN 'secrets:write' ELSE 'sources:link' END)
 FROM mcp_client_grants g LEFT JOIN projects p ON p.organization_id=h.organization_id AND p.project_id=json_extract(h.secret_target,'$.projectId')
 WHERE g.organization_id=h.organization_id AND g.user_id=h.user_id AND g.client_id=h.client_id AND g.consent_hash=h.consent_hash
   AND g.project_id IS CASE h.kind WHEN 'secret' THEN p.project_id ELSE NULL END
   AND g.ownership_version IS CASE h.kind WHEN 'secret' THEN p.ownership_version ELSE NULL END
   AND g.billing_epoch_id IS CASE h.kind WHEN 'secret' THEN p.active_billing_epoch_id ELSE NULL END AND g.revoked_at IS NULL)
 WHERE h.kind IN('secret','github') AND h.consumed_at IS NULL AND h.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
 AND NOT EXISTS(SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=h.organization_id AND r.user_id=h.user_id AND r.client_id=h.client_id AND r.consent_hash=h.consent_hash);
CREATE TRIGGER mcp_portal_handoff_authority_immutable BEFORE UPDATE ON mcp_portal_handoffs
WHEN NEW.authority IS NOT OLD.authority BEGIN SELECT RAISE(ABORT, 'mcp_handoff_authority_immutable'); END;
CREATE TRIGGER mcp_workspace_revocations_active_recovery BEFORE INSERT ON mcp_client_revocations
WHEN EXISTS(SELECT 1 FROM project_recovery_fences f JOIN operation_mcp_delegations d
  ON d.organization_id=f.organization_id AND d.operation_id=f.operation_id
  WHERE f.organization_id=NEW.organization_id AND f.released_at IS NULL AND f.lease_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
    AND d.principal_id='user:'||NEW.user_id AND d.client_id=NEW.client_id AND d.consent_hash=NEW.consent_hash)
BEGIN SELECT RAISE(ABORT, 'mcp_connection_recovery_use_active'); END;

-- Convert historical mail-scoped consent evidence to the single current connection proof.
-- Retain original bytes for audit and keep all existing proof/grant rows and foreign keys.
CREATE TABLE mcp_dns_authority_conversion (
  authorization_id TEXT PRIMARY KEY REFERENCES scoped_customer_dns_authorizations(authorization_id),
  original_delegation TEXT NOT NULL
) STRICT, WITHOUT ROWID;
INSERT INTO mcp_dns_authority_conversion(authorization_id,original_delegation)
  SELECT a.authorization_id,a.delegation FROM scoped_customer_dns_authorizations a
  JOIN mcp_mail_domain_grants old ON old.organization_id=a.organization_id AND old.grant_id=json_extract(a.delegation,'$.grantId')
  WHERE a.purpose='workspace_mail' AND a.delegation IS NOT NULL;
INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at)
  SELECT old.organization_id,old.grant_id,old.user_id,old.client_id,old.consent_hash,NULL,NULL,NULL,1,1,old.created_at
  FROM mcp_mail_domain_grants old
  WHERE old.grant_id=(SELECT MIN(candidate.grant_id) FROM mcp_mail_domain_grants candidate
    WHERE candidate.organization_id=old.organization_id AND candidate.user_id=old.user_id AND candidate.client_id=old.client_id AND candidate.consent_hash=old.consent_hash)
  AND NOT EXISTS(SELECT 1 FROM mcp_client_grants current WHERE current.organization_id=old.organization_id AND current.user_id=old.user_id AND current.client_id=old.client_id AND current.consent_hash=old.consent_hash AND current.project_id IS NULL);
-- An organization-wide historical proof did not pin ownership. Refuse the entire
-- conversion if any such authorization cannot be tied to the original epoch.
CREATE TABLE mcp_dns_conversion_epoch_guard(value INTEGER NOT NULL CHECK(value=0)) STRICT;
INSERT INTO mcp_dns_conversion_epoch_guard(value)
 SELECT CASE WHEN EXISTS(SELECT 1 FROM scoped_customer_dns_authorizations a
   JOIN mcp_client_grants old ON old.organization_id=a.organization_id AND old.grant_id=json_extract(a.delegation,'$.grantId')
   LEFT JOIN projects p ON p.organization_id=a.organization_id AND p.project_id=a.resource_id
   LEFT JOIN billing_epochs epoch ON epoch.organization_id=p.organization_id AND epoch.project_id=p.project_id AND epoch.billing_epoch_id=p.active_billing_epoch_id
   WHERE a.purpose='application_identity' AND a.delegation IS NOT NULL AND old.project_id IS NULL
     AND (p.project_id IS NULL OR p.ownership_version<>1 OR epoch.billing_epoch_id IS NULL OR epoch.started_at>a.issued_at OR epoch.ended_at IS NOT NULL)) THEN 1 ELSE 0 END;
DROP TABLE mcp_dns_conversion_epoch_guard;
-- Older application-identity authorizations may point at an organization-wide grant.
-- Create an epoch-specific project proof while retaining the signed original separately.
INSERT INTO mcp_dns_authority_conversion(authorization_id,original_delegation)
  SELECT a.authorization_id,a.delegation FROM scoped_customer_dns_authorizations a
  JOIN mcp_client_grants old ON old.organization_id=a.organization_id AND old.grant_id=json_extract(a.delegation,'$.grantId')
  WHERE a.purpose='application_identity' AND a.delegation IS NOT NULL AND old.project_id IS NULL;
INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at)
  SELECT a.organization_id,lower(substr(hex(randomblob(16)),1,8)||'-'||substr(hex(randomblob(16)),1,4)||'-'||substr(hex(randomblob(16)),1,4)||'-'||substr(hex(randomblob(16)),1,4)||'-'||substr(hex(randomblob(16)),1,12)),
    old.user_id,old.client_id,old.consent_hash,a.resource_id,p.ownership_version,p.active_billing_epoch_id,1,1,MIN(old.created_at)
  FROM scoped_customer_dns_authorizations a JOIN mcp_client_grants old ON old.organization_id=a.organization_id AND old.grant_id=json_extract(a.delegation,'$.grantId')
  JOIN projects p ON p.organization_id=a.organization_id AND p.project_id=a.resource_id
  WHERE a.purpose='application_identity' AND old.project_id IS NULL AND NOT EXISTS(
    SELECT 1 FROM mcp_client_grants current WHERE current.organization_id=a.organization_id AND current.user_id=old.user_id AND current.client_id=old.client_id AND current.consent_hash=old.consent_hash AND current.project_id=a.resource_id AND current.ownership_version=p.ownership_version AND current.billing_epoch_id=p.active_billing_epoch_id)
  GROUP BY a.organization_id,old.user_id,old.client_id,old.consent_hash,a.resource_id,p.ownership_version,p.active_billing_epoch_id;
DROP TRIGGER scoped_customer_dns_authorizations_identity;
DROP TRIGGER scoped_customer_dns_authorizations_current_update;
UPDATE scoped_customer_dns_authorizations AS a SET delegation=json_set(a.delegation,
  '$.grantId',(SELECT current.grant_id FROM mcp_mail_domain_grants old JOIN mcp_client_grants current
    ON current.organization_id=old.organization_id AND current.user_id=old.user_id AND current.client_id=old.client_id AND current.consent_hash=old.consent_hash AND current.project_id IS NULL
    WHERE old.organization_id=a.organization_id AND old.grant_id=json_extract(a.delegation,'$.grantId')),
  '$.grantRevision',(SELECT current.revision FROM mcp_mail_domain_grants old JOIN mcp_client_grants current
    ON current.organization_id=old.organization_id AND current.user_id=old.user_id AND current.client_id=old.client_id AND current.consent_hash=old.consent_hash AND current.project_id IS NULL
    WHERE old.organization_id=a.organization_id AND old.grant_id=json_extract(a.delegation,'$.grantId')))
  WHERE a.purpose='workspace_mail' AND a.authorization_id IN(SELECT authorization_id FROM mcp_dns_authority_conversion);
UPDATE scoped_customer_dns_authorizations AS a SET delegation=json_set(a.delegation,
  '$.grantId',(SELECT current.grant_id FROM mcp_client_grants old JOIN projects p ON p.organization_id=a.organization_id AND p.project_id=a.resource_id
    JOIN mcp_client_grants current ON current.organization_id=old.organization_id AND current.user_id=old.user_id AND current.client_id=old.client_id AND current.consent_hash=old.consent_hash AND current.project_id=a.resource_id AND current.ownership_version=p.ownership_version AND current.billing_epoch_id=p.active_billing_epoch_id
    WHERE old.organization_id=a.organization_id AND old.grant_id=json_extract(a.delegation,'$.grantId')),
  '$.grantRevision',(SELECT current.revision FROM mcp_client_grants old JOIN projects p ON p.organization_id=a.organization_id AND p.project_id=a.resource_id
    JOIN mcp_client_grants current ON current.organization_id=old.organization_id AND current.user_id=old.user_id AND current.client_id=old.client_id AND current.consent_hash=old.consent_hash AND current.project_id=a.resource_id AND current.ownership_version=p.ownership_version AND current.billing_epoch_id=p.active_billing_epoch_id
    WHERE old.organization_id=a.organization_id AND old.grant_id=json_extract(a.delegation,'$.grantId')))
  WHERE a.purpose='application_identity' AND a.authorization_id IN(SELECT authorization_id FROM mcp_dns_authority_conversion);
CREATE TRIGGER scoped_customer_dns_authorizations_identity BEFORE UPDATE ON scoped_customer_dns_authorizations WHEN NEW.authorization_id IS NOT OLD.authorization_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.purpose IS NOT OLD.purpose OR NEW.resource_id IS NOT OLD.resource_id OR NEW.resource_revision IS NOT OLD.resource_revision OR NEW.principal_id IS NOT OLD.principal_id OR NEW.delegation IS NOT OLD.delegation OR NEW.zone_name IS NOT OLD.zone_name OR NEW.state_sha256 IS NOT OLD.state_sha256 OR NEW.idempotency_key_sha256 IS NOT OLD.idempotency_key_sha256 OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at BEGIN SELECT RAISE(ABORT,'Scoped DNS authorization identity is immutable'); END;
CREATE TRIGGER scoped_customer_dns_authorizations_current_update BEFORE UPDATE ON scoped_customer_dns_authorizations WHEN NEW.revoked_at IS NULL AND NOT(CASE NEW.purpose WHEN 'application_identity' THEN EXISTS(SELECT 1 FROM project_application_domain_identities identity JOIN projects project ON project.project_id=identity.project_id AND project.organization_id=identity.organization_id AND project.owner_state='active' AND project.lifecycle_state='active' WHERE identity.organization_id=NEW.organization_id AND identity.project_id=NEW.resource_id AND identity.revision=NEW.resource_revision AND identity.state IN('pending','verified') AND(identity.state='verified' OR identity.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) AND(identity.hostname=NEW.zone_name OR substr(identity.hostname,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) WHEN 'workspace_mail' THEN EXISTS(SELECT 1 FROM workspace_mail_domains domain WHERE domain.organization_id=NEW.organization_id AND domain.domain_id=NEW.resource_id AND domain.revision=NEW.resource_revision AND domain.status IN('active','retiring') AND(domain.domain=NEW.zone_name OR substr(domain.domain,-length(NEW.zone_name)-1)='.'||NEW.zone_name)) ELSE 0 END) BEGIN SELECT RAISE(ABORT,'Scoped DNS resource declaration is stale'); END;
