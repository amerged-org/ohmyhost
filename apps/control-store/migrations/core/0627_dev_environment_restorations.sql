-- Immutable identity boundary for historical billing and current Dev restoration.
CREATE TABLE dev_environment_restorations (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  previous_environment_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  physical_environment_id TEXT NOT NULL,
  archived_at TEXT NOT NULL CHECK(archived_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,previous_environment_id),
  UNIQUE(organization_id,project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,previous_environment_id) REFERENCES environments(organization_id,project_id,environment_id),
  -- The immutable boundary precedes archiving the old name; its replacement is created
  -- later in that same atomic batch. A missing replacement still fails the commit.
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;
CREATE TRIGGER dev_environment_restorations_no_update BEFORE UPDATE ON dev_environment_restorations
BEGIN SELECT RAISE(ABORT,'Dev restoration identity boundaries are immutable'); END;
CREATE TRIGGER dev_environment_restorations_no_delete BEFORE DELETE ON dev_environment_restorations
BEGIN SELECT RAISE(ABORT,'Dev restoration identity boundaries are retained'); END;

-- Keep every identity field immutable. The one name transition is backed by the
-- already inserted restoration boundary and the exact completed policy retirement.
DROP TRIGGER environments_identity_immutable;
CREATE TRIGGER environments_identity_immutable BEFORE UPDATE ON environments
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.environment_id IS NOT OLD.environment_id
 OR NEW.project_id IS NOT OLD.project_id OR NEW.created_at IS NOT OLD.created_at
 OR (NEW.name IS NOT OLD.name AND NOT (
   OLD.name='dev' AND NEW.name='retired-dev-'||OLD.environment_id
   AND NEW.desired_state IS OLD.desired_state AND NEW.head_version IS OLD.head_version
   AND NEW.active_deployment_id IS NULL AND NEW.active_revision_id IS NULL
   AND NEW.dev_access_epoch=OLD.dev_access_epoch+1
   AND EXISTS (
     SELECT 1 FROM dev_environment_restorations boundary
     JOIN projects project ON project.organization_id=boundary.organization_id AND project.project_id=boundary.project_id
     JOIN organizations organization ON organization.organization_id=project.organization_id
     JOIN credit_account paid ON paid.organization_id=project.organization_id
     JOIN free_dev_retirements retired ON retired.organization_id=boundary.organization_id
       AND retired.project_id=boundary.project_id AND retired.environment_id=boundary.previous_environment_id
       AND retired.ownership_version=project.ownership_version
     WHERE boundary.organization_id=OLD.organization_id AND boundary.project_id=OLD.project_id
       AND boundary.previous_environment_id=OLD.environment_id AND boundary.environment_id<>OLD.environment_id
       AND boundary.archived_at=NEW.updated_at
       AND boundary.archived_at<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
       AND project.owner_state='active' AND project.lifecycle_state='active' AND organization.state='active'
       AND paid.paid_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
       AND (retired.state='completed' OR (retired.state='cancelled' AND EXISTS (
         SELECT 1 FROM free_dev_retirement_resources effect WHERE effect.organization_id=retired.organization_id
           AND effect.project_id=retired.project_id AND effect.retirement_id=retired.retirement_id
           AND (effect.state='removed' OR effect.partial_removal_at IS NOT NULL))))
       AND NOT EXISTS (SELECT 1 FROM environments replacement WHERE replacement.organization_id=boundary.organization_id
         AND replacement.environment_id=boundary.environment_id)
       AND NOT EXISTS (SELECT 1 FROM bucket_fences fence WHERE fence.bucket=organization.bucket)
       AND NOT EXISTS (SELECT 1 FROM free_dev_retirements pending WHERE pending.organization_id=project.organization_id
         AND pending.project_id=project.project_id AND pending.state IN('pending','running'))
       AND NOT EXISTS (SELECT 1 FROM free_dev_retirement_dispatches pending WHERE pending.organization_id=project.organization_id
         AND pending.project_id=project.project_id AND pending.state='pending')
       AND NOT EXISTS (SELECT 1 FROM project_database_access login WHERE login.organization_id=OLD.organization_id
         AND login.project_id=OLD.project_id AND login.environment_id=OLD.environment_id
         AND login.provider='pgcf' AND login.role_dropped_at IS NULL)
   )
 ))
BEGIN SELECT RAISE(ABORT,'environment identity is immutable'); END;
