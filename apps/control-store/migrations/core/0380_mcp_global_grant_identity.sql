-- Original172/200 grant_id UUIDs are globally UNIQUE in each grant family, independently of organization.
-- Preserve every existing identity and byte. A populated duplicate refuses this whole forward migration;
-- no consent is relabelled, revoked, regenerated or merged to make the index succeed.
CREATE UNIQUE INDEX mcp_client_grants_global_id ON mcp_client_grants(grant_id);
CREATE UNIQUE INDEX mcp_mail_domain_grants_global_id ON mcp_mail_domain_grants(grant_id);
