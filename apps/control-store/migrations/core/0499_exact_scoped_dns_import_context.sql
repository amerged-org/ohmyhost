-- Exact0472 context union plus ONLY the two independently reviewed0498 scoped DNS history families.
-- Ever-activated/open-state/static/duplicate-name guards remain unchanged. No source row is changed.
DROP TRIGGER core_historical_import_open;
CREATE TRIGGER core_historical_import_open BEFORE INSERT ON core_historical_import
BEGIN
  SELECT RAISE(ABORT,'an ever-activated authority can never open historical import') WHERE EXISTS(SELECT 1 FROM core_authority_activation);
  SELECT RAISE(ABORT,'historical import begins loading, never already qualified')
    WHERE NEW.closed_at IS NOT NULL OR NEW.comparison_sha256 IS NOT NULL OR NEW.restored_runtime_schema_sha256 IS NOT NULL;
  SELECT RAISE(ABORT,'historical temporal admission has a closed exact table allowlist')
    WHERE EXISTS(SELECT 1 FROM json_each(NEW.temporal_tables) WHERE type<>'text' OR value NOT IN (
      'wfp_candidate_receipts','wfp_candidate_cleanup_receipts','wfp_publish_receipts','wfp_rollback_activation_receipts','runtime_secret_delivery_stage_activations','operations','environment_data_assignments','mail_credit_accounts','mail_credit_ledger','project_mail_domain_bindings','usage_valuations','scoped_customer_dns_authorizations','scoped_customer_dns_grants'))
      OR (SELECT count(*) FROM json_each(NEW.temporal_tables))<>(SELECT count(DISTINCT value) FROM json_each(NEW.temporal_tables));
END;
