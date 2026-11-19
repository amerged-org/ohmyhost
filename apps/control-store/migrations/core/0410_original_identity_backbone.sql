-- Original002 principal observations are independent facts: there was no organization FK or inferred clock order.
-- Original173 delegations retain their GLOBAL operation/grant identities and all four exact native foreign keys.
-- This preserving unserved rebuild refuses incompatible prototype rows; it never repairs or relabels evidence.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE principal_mappings (
  provider TEXT NOT NULL CHECK(provider='workos'),
  provider_principal_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  first_observed_at TEXT NOT NULL CHECK(first_observed_at GLOB '????-??-??T??:??:??.??????Z'),
  last_observed_at TEXT NOT NULL CHECK(last_observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(provider,provider_principal_id,organization_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE operation_mcp_delegations_0410 (
  operation_id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  billing_epoch_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  grant_id TEXT NOT NULL CHECK(length(grant_id)=36),
  client_id TEXT NOT NULL,
  consent_hash TEXT NOT NULL CHECK(length(consent_hash)=64 AND consent_hash NOT GLOB '*[^0-9a-f]*'),
  requires_publication INTEGER NOT NULL CHECK(requires_publication IN (0,1)),
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,operation_id),
  FOREIGN KEY(operation_id) REFERENCES operations(operation_id),
  FOREIGN KEY(grant_id) REFERENCES mcp_client_grants(grant_id),
  FOREIGN KEY(organization_id,project_id,operation_id,billing_epoch_id)
    REFERENCES operations(organization_id,project_id,operation_id,billing_epoch_id),
  FOREIGN KEY(organization_id,project_id,environment_id)
    REFERENCES environments(organization_id,project_id,environment_id)
) STRICT, WITHOUT ROWID;
INSERT INTO operation_mcp_delegations_0410(operation_id,organization_id,project_id,environment_id,billing_epoch_id,principal_id,grant_id,client_id,consent_hash,requires_publication,event_type,created_at)
  SELECT operation_id,organization_id,project_id,environment_id,billing_epoch_id,principal_id,grant_id,client_id,consent_hash,requires_publication,event_type,created_at FROM operation_mcp_delegations;
DROP TABLE operation_mcp_delegations;
ALTER TABLE operation_mcp_delegations_0410 RENAME TO operation_mcp_delegations;
CREATE TRIGGER operation_mcp_delegations_no_update BEFORE UPDATE ON operation_mcp_delegations
BEGIN SELECT RAISE(ABORT, 'operation_mcp_delegations is append-only'); END;
CREATE TRIGGER operation_mcp_delegations_no_delete BEFORE DELETE ON operation_mcp_delegations
BEGIN SELECT RAISE(ABORT, 'operation_mcp_delegations is append-only'); END;
