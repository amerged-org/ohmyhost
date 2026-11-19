-- W38: policy retirement is independent of project deletion and preserves immutable source/audit rows.
CREATE TABLE free_dev_retirements (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  retirement_id TEXT NOT NULL CHECK(length(retirement_id)=26),
  environment_id TEXT NOT NULL,
  ownership_version INTEGER NOT NULL,
  policy_epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('pending','running','completed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_attempt_at TEXT CHECK(last_attempt_at IS NULL OR last_attempt_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,retirement_id),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX free_dev_retirements_one_active ON free_dev_retirements(organization_id,project_id) WHERE state IN('pending','running');
CREATE TABLE free_dev_retirement_resources (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  retirement_id TEXT NOT NULL,
  resource_id TEXT NOT NULL CHECK(length(resource_id)=64),
  kind TEXT NOT NULL CHECK(kind IN('wfp-script','database','r2-object','r2-bucket','native-auth','database-access')),
  locator TEXT NOT NULL CHECK(length(locator) BETWEEN 1 AND 1024),
  metadata TEXT NOT NULL CHECK(json_valid(metadata)),
  state TEXT NOT NULL CHECK(state IN('pending','claimed','removed','preserved')),
  claim_id TEXT,
  claim_expires_at TEXT,
  provider_operation_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  removed_at TEXT,
  partial_removal_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,project_id,retirement_id,resource_id),
  FOREIGN KEY(organization_id,project_id,retirement_id) REFERENCES free_dev_retirements(organization_id,project_id,retirement_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER free_dev_retirement_identity BEFORE UPDATE ON free_dev_retirements
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id OR NEW.retirement_id IS NOT OLD.retirement_id OR NEW.environment_id IS NOT OLD.environment_id OR NEW.ownership_version IS NOT OLD.ownership_version OR NEW.policy_epoch IS NOT OLD.policy_epoch OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'Dev retirement identity is immutable'); END;
CREATE TRIGGER free_dev_retirement_resource_identity BEFORE UPDATE ON free_dev_retirement_resources
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id OR NEW.retirement_id IS NOT OLD.retirement_id OR NEW.resource_id IS NOT OLD.resource_id OR NEW.kind IS NOT OLD.kind OR NEW.locator IS NOT OLD.locator OR NEW.metadata IS NOT OLD.metadata OR(OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT OLD.removed_at) OR(OLD.partial_removal_at IS NOT NULL AND NEW.partial_removal_at IS NOT OLD.partial_removal_at)
BEGIN SELECT RAISE(ABORT,'Dev retirement resource identity is immutable'); END;
CREATE TABLE free_dev_retirement_dispatches (
 organization_id TEXT NOT NULL,project_id TEXT NOT NULL,retirement_id TEXT NOT NULL,resource_id TEXT NOT NULL,
 step TEXT NOT NULL,claim_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','completed','failed')),
 started_at TEXT NOT NULL,resolved_at TEXT,
 PRIMARY KEY(organization_id,project_id,retirement_id,resource_id,step),
 FOREIGN KEY(organization_id,project_id,retirement_id,resource_id) REFERENCES free_dev_retirement_resources(organization_id,project_id,retirement_id,resource_id)
) STRICT,WITHOUT ROWID;
CREATE TRIGGER free_dev_retirement_dispatch_identity BEFORE UPDATE ON free_dev_retirement_dispatches
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id OR NEW.retirement_id IS NOT OLD.retirement_id OR NEW.resource_id IS NOT OLD.resource_id OR NEW.step IS NOT OLD.step OR NEW.claim_id IS NOT OLD.claim_id OR NEW.started_at IS NOT OLD.started_at OR(OLD.state<>'pending' AND(NEW.state IS NOT OLD.state OR NEW.resolved_at IS NOT OLD.resolved_at))
BEGIN SELECT RAISE(ABORT,'Dev retirement dispatch identity is immutable'); END;
