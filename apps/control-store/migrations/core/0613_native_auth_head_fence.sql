-- Revocation is committed with the deployment head, before any stale route can serve the old capability.
-- The private Auth database must separately acknowledge this epoch before the workflow reports completion.
CREATE TRIGGER native_auth_source_off_epoch AFTER UPDATE OF active_deployment_id,active_revision_id ON environments
WHEN (OLD.active_deployment_id IS NOT NEW.active_deployment_id OR OLD.active_revision_id IS NOT NEW.active_revision_id)
  AND EXISTS(SELECT 1 FROM deployment_revisions r JOIN deployment_plans p
    ON p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.plan_id=r.plan_id
    WHERE r.organization_id=OLD.organization_id AND r.project_id=OLD.project_id
      AND r.deployment_id=OLD.active_deployment_id AND r.revision_id=OLD.active_revision_id
      AND json_extract(p.framework_plan,'$.auth.provider')='omh-native')
  AND NOT EXISTS(SELECT 1 FROM deployment_revisions r JOIN deployment_plans p
    ON p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.plan_id=r.plan_id
    WHERE r.organization_id=NEW.organization_id AND r.project_id=NEW.project_id
      AND r.deployment_id=NEW.active_deployment_id AND r.revision_id=NEW.active_revision_id
      AND json_extract(p.framework_plan,'$.auth.provider')='omh-native')
BEGIN
  UPDATE native_auth_realms SET revocation_epoch=revocation_epoch+1
    WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND environment_id=NEW.environment_id;
END;
