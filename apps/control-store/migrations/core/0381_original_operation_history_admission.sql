-- Closed Original001 retained operation history; parent-qualified0371 five names remain exact.
DROP TRIGGER core_historical_import_open;
CREATE TRIGGER core_historical_import_open BEFORE INSERT ON core_historical_import
BEGIN
  SELECT RAISE(ABORT, 'an ever-activated authority can never open historical import')
    WHERE EXISTS (SELECT 1 FROM core_authority_activation);
  SELECT RAISE(ABORT, 'historical import begins loading, never already qualified')
    WHERE NEW.closed_at IS NOT NULL OR NEW.comparison_sha256 IS NOT NULL OR NEW.restored_runtime_schema_sha256 IS NOT NULL;
  SELECT RAISE(ABORT, 'historical temporal admission has a closed exact table allowlist')
    WHERE EXISTS (SELECT 1 FROM json_each(NEW.temporal_tables)
      WHERE type <> 'text' OR value NOT IN ('wfp_candidate_receipts','wfp_candidate_cleanup_receipts','wfp_publish_receipts','wfp_rollback_activation_receipts','runtime_secret_delivery_stage_activations','operations'))
      OR (SELECT count(*) FROM json_each(NEW.temporal_tables))
        <> (SELECT count(DISTINCT value) FROM json_each(NEW.temporal_tables));
END;

DROP TRIGGER operations_require_current_owner;
CREATE TRIGGER operations_require_current_owner BEFORE INSERT ON operations
WHEN NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND owner_state='active')
  AND NOT EXISTS(SELECT 1 FROM core_historical_import i WHERE i.closed_at IS NULL
    AND EXISTS(SELECT 1 FROM json_each(i.temporal_tables) WHERE value='operations')
    AND NOT EXISTS(SELECT 1 FROM core_authority_activation))
BEGIN SELECT RAISE(ABORT,'operation requires current ownership or exact unserved historical admission'); END;

-- Original001 operation epoch belongs to this exact project/organization, even while importing historical rows.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(
  SELECT 1 FROM operations o WHERE NOT EXISTS(SELECT 1 FROM billing_epochs e
    WHERE e.organization_id=o.organization_id AND e.project_id=o.project_id AND e.billing_epoch_id=o.billing_epoch_id));
CREATE TRIGGER operations_original_epoch_scope BEFORE INSERT ON operations
WHEN NOT EXISTS(SELECT 1 FROM billing_epochs e WHERE e.organization_id=NEW.organization_id
  AND e.project_id=NEW.project_id AND e.billing_epoch_id=NEW.billing_epoch_id)
BEGIN SELECT RAISE(ABORT,'operation requires its exact original project epoch'); END;
