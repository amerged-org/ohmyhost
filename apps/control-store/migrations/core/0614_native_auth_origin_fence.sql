-- Losing an approved hostname must not silently restore an old session if the hostname later returns.
-- The workflow separately waits for the private Auth database to acknowledge the new epoch.
CREATE TRIGGER native_auth_primary_origin_lost AFTER UPDATE OF deleted_at,production_domain,development_domain ON cloudflare_project_domains
WHEN NEW.deleted_at IS NOT NULL OR NEW.production_domain<>OLD.production_domain OR NEW.development_domain<>OLD.development_domain
BEGIN
  UPDATE native_auth_providers SET last_success_at=NULL WHERE (organization_id,project_id,environment_id) IN
    (SELECT organization_id,project_id,environment_id FROM native_auth_realms WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND
     ((canonical_origin='https://'||OLD.production_domain AND (NEW.deleted_at IS NOT NULL OR NEW.production_domain<>OLD.production_domain)) OR
      (canonical_origin='https://'||OLD.development_domain AND (NEW.deleted_at IS NOT NULL OR NEW.development_domain<>OLD.development_domain))));
  UPDATE native_auth_realms SET canonical_origin=NULL,configuration_revision=configuration_revision+1,revocation_epoch=revocation_epoch+1
   WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND
     ((canonical_origin='https://'||OLD.production_domain AND (NEW.deleted_at IS NOT NULL OR NEW.production_domain<>OLD.production_domain)) OR
      (canonical_origin='https://'||OLD.development_domain AND (NEW.deleted_at IS NOT NULL OR NEW.development_domain<>OLD.development_domain)));
END;
CREATE TRIGGER native_auth_primary_origin_deleted AFTER DELETE ON cloudflare_project_domains
BEGIN
  UPDATE native_auth_providers SET last_success_at=NULL WHERE (organization_id,project_id,environment_id) IN
    (SELECT organization_id,project_id,environment_id FROM native_auth_realms WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin IN ('https://'||OLD.production_domain,'https://'||OLD.development_domain));
  UPDATE native_auth_realms SET canonical_origin=NULL,configuration_revision=configuration_revision+1,revocation_epoch=revocation_epoch+1
   WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin IN ('https://'||OLD.production_domain,'https://'||OLD.development_domain);
END;
CREATE TRIGGER native_auth_custom_origin_lost AFTER UPDATE OF state,deleted_at,hostname,gateway_script_name,custom_hostname_receipt,worker_route_receipt ON paid_project_domains
WHEN OLD.state='active' AND (NEW.state<>'active' OR NEW.deleted_at IS NOT NULL OR NEW.hostname<>OLD.hostname OR NEW.gateway_script_name IS NOT 'ohmyho-gateway-production' OR NEW.custom_hostname_receipt IS NULL OR NEW.worker_route_receipt IS NULL)
BEGIN
  UPDATE native_auth_providers SET last_success_at=NULL WHERE (organization_id,project_id,environment_id) IN
    (SELECT organization_id,project_id,environment_id FROM native_auth_realms WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin='https://'||OLD.hostname);
  UPDATE native_auth_realms SET canonical_origin=NULL,configuration_revision=configuration_revision+1,revocation_epoch=revocation_epoch+1
   WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin='https://'||OLD.hostname;
END;
CREATE TRIGGER native_auth_custom_origin_deleted AFTER DELETE ON paid_project_domains
BEGIN
  UPDATE native_auth_providers SET last_success_at=NULL WHERE (organization_id,project_id,environment_id) IN
    (SELECT organization_id,project_id,environment_id FROM native_auth_realms WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin='https://'||OLD.hostname);
  UPDATE native_auth_realms SET canonical_origin=NULL,configuration_revision=configuration_revision+1,revocation_epoch=revocation_epoch+1
   WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND canonical_origin='https://'||OLD.hostname;
END;
