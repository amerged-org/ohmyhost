-- Original161 retains old-organization assignments after the actual environment moves to its new owner.
-- Static environment identity is (project,environment); current organization is an INSERT admission rule only.
PRAGMA defer_foreign_keys=ON;
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE environment_data_assignments_next (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  data_environment_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL CHECK(assignment_version>0),
  assigned_at TEXT NOT NULL CHECK(assigned_at GLOB '????-??-??T??:??:??.??????Z'),
  operation_id TEXT,
  PRIMARY KEY(organization_id,project_id,environment_id,assignment_version),
  FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,data_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id),
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id)
) STRICT, WITHOUT ROWID;
INSERT INTO environment_data_assignments_next(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at,operation_id)
  SELECT organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at,operation_id FROM environment_data_assignments;
DROP TRIGGER projects_data_mode_matches_assignments;
DROP TABLE environment_data_assignments;
ALTER TABLE environment_data_assignments_next RENAME TO environment_data_assignments;
CREATE TRIGGER projects_data_mode_matches_assignments BEFORE UPDATE OF data_mode ON projects
  WHEN NEW.data_mode IS NOT OLD.data_mode AND NOT (
    (SELECT data_environment_id FROM environment_data_assignments a WHERE a.organization_id = NEW.organization_id AND a.project_id = NEW.project_id
       AND a.environment_id = (SELECT environment_id FROM environments e WHERE e.organization_id = NEW.organization_id AND e.project_id = NEW.project_id AND e.name = 'dev')
       ORDER BY a.assignment_version DESC LIMIT 1) IS NOT NULL
    AND (SELECT data_environment_id FROM environment_data_assignments a WHERE a.organization_id = NEW.organization_id AND a.project_id = NEW.project_id
       AND a.environment_id = (SELECT environment_id FROM environments e WHERE e.organization_id = NEW.organization_id AND e.project_id = NEW.project_id AND e.name = 'prod')
       ORDER BY a.assignment_version DESC LIMIT 1) IS NOT NULL
    AND ((NEW.data_mode = 'shared') = (
      (SELECT data_environment_id FROM environment_data_assignments a WHERE a.organization_id = NEW.organization_id AND a.project_id = NEW.project_id
         AND a.environment_id = (SELECT environment_id FROM environments e WHERE e.organization_id = NEW.organization_id AND e.project_id = NEW.project_id AND e.name = 'dev')
         ORDER BY a.assignment_version DESC LIMIT 1)
      = (SELECT data_environment_id FROM environment_data_assignments a WHERE a.organization_id = NEW.organization_id AND a.project_id = NEW.project_id
         AND a.environment_id = (SELECT environment_id FROM environments e WHERE e.organization_id = NEW.organization_id AND e.project_id = NEW.project_id AND e.name = 'prod')
         ORDER BY a.assignment_version DESC LIMIT 1))))
BEGIN SELECT RAISE(ABORT, 'project data mode must match the current data assignments'); END;
CREATE TRIGGER environment_data_assignments_no_update BEFORE UPDATE ON environment_data_assignments
BEGIN SELECT RAISE(ABORT, 'environment_data_assignments is append-only'); END;
CREATE TRIGGER environment_data_assignments_no_delete BEFORE DELETE ON environment_data_assignments
BEGIN SELECT RAISE(ABORT, 'environment_data_assignments is append-only'); END;
CREATE TRIGGER environment_data_assignments_require_current_scope BEFORE INSERT ON environment_data_assignments
WHEN NOT EXISTS(SELECT 1 FROM environments WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND environment_id=NEW.environment_id)
  AND NOT EXISTS(SELECT 1 FROM core_historical_import i WHERE i.closed_at IS NULL
    AND EXISTS(SELECT 1 FROM json_each(i.temporal_tables) WHERE value='environment_data_assignments')
    AND NOT EXISTS(SELECT 1 FROM core_authority_activation))
BEGIN SELECT RAISE(ABORT,'data assignment requires current environment scope or exact unserved historical admission'); END;

DROP TRIGGER core_historical_import_open;
CREATE TRIGGER core_historical_import_open BEFORE INSERT ON core_historical_import
BEGIN
  SELECT RAISE(ABORT,'an ever-activated authority can never open historical import') WHERE EXISTS(SELECT 1 FROM core_authority_activation);
  SELECT RAISE(ABORT,'historical import begins loading, never already qualified')
    WHERE NEW.closed_at IS NOT NULL OR NEW.comparison_sha256 IS NOT NULL OR NEW.restored_runtime_schema_sha256 IS NOT NULL;
  SELECT RAISE(ABORT,'historical temporal admission has a closed exact table allowlist')
    WHERE EXISTS(SELECT 1 FROM json_each(NEW.temporal_tables) WHERE type<>'text' OR value NOT IN (
      'wfp_candidate_receipts','wfp_candidate_cleanup_receipts','wfp_publish_receipts','wfp_rollback_activation_receipts','runtime_secret_delivery_stage_activations','operations','environment_data_assignments'))
      OR (SELECT count(*) FROM json_each(NEW.temporal_tables))<>(SELECT count(DISTINCT value) FROM json_each(NEW.temporal_tables));
END;
