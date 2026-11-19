-- Genuine preview preparation operations own durable application resources, without a deployment.
CREATE TABLE preview_resource_preparations (
  preparation_id TEXT PRIMARY KEY CHECK(length(preparation_id)=26),
  preview_id TEXT NOT NULL UNIQUE REFERENCES preview_sessions(preview_id),
  generation INTEGER NOT NULL CHECK(generation>0),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  physical_environment_id TEXT NOT NULL,
  billing_epoch_id TEXT NOT NULL,
  ownership_version INTEGER NOT NULL,
  lifecycle_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN('preparing','ready','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(organization_id,project_id,preparation_id) REFERENCES operations(organization_id,project_id,operation_id),
  FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id)
) STRICT;
CREATE UNIQUE INDEX preview_preparation_one_physical ON preview_resource_preparations(organization_id,project_id,physical_environment_id) WHERE state='preparing';
CREATE TRIGGER preview_preparation_identity_immutable BEFORE UPDATE ON preview_resource_preparations
WHEN NEW.preparation_id<>OLD.preparation_id OR NEW.preview_id<>OLD.preview_id OR NEW.generation<>OLD.generation OR NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id OR NEW.physical_environment_id<>OLD.physical_environment_id OR NEW.billing_epoch_id<>OLD.billing_epoch_id OR NEW.ownership_version<>OLD.ownership_version OR NEW.lifecycle_version<>OLD.lifecycle_version
BEGIN SELECT RAISE(ABORT,'preview_preparation_identity_immutable'); END;
