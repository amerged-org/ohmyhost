-- Exact original062/074/144 rollback static identity, including every legacy gateway byte/nullable field.
-- The original temporal INSERT predicate admits only its exact current target/route and next environment head.
CREATE TABLE wfp_rollback_activation_receipts (
  rollback_activation_receipt_id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  rollback_deployment_id TEXT NOT NULL,
  target_deployment_id TEXT NOT NULL,
  target_revision_id TEXT NOT NULL,
  candidate_receipt_id TEXT NOT NULL,
  wfp_receipt_id TEXT NOT NULL,
  gateway_version_id TEXT,
  gateway_deployment_id TEXT,
  activated_at TEXT NOT NULL CHECK(activated_at GLOB '????-??-??T??:??:??.??????Z'),
  activated_head_version INTEGER,
  gateway_contract_version TEXT,
  gateway_script_name TEXT,
  gateway_workers_dev_subdomain TEXT,
  gateway_internal_origin TEXT,
  gateway_public_origin TEXT,
  gateway_provider_tag BLOB,
  gateway_egress_policy_sha256 BLOB,
  gateway_dev_access_service TEXT,
  gateway_dev_access_entrypoint TEXT,
  gateway_dev_access_key_id BLOB,
  gateway_dev_access_public_key_sha256 BLOB,
  gateway_module_sha256 BLOB,
  gateway_compatibility_date TEXT,
  gateway_observed_at TEXT CHECK(gateway_observed_at IS NULL OR gateway_observed_at GLOB '????-??-??T??:??:??.??????Z'),
  shared_gateway_revision INTEGER,
  UNIQUE(organization_id,project_id,operation_id),
  UNIQUE(organization_id,project_id,environment_id,activated_head_version),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,rollback_deployment_id) REFERENCES deployments(organization_id,project_id,deployment_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,target_deployment_id,target_revision_id) REFERENCES deployment_revisions(organization_id,project_id,deployment_id,revision_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,candidate_receipt_id) REFERENCES wfp_candidate_receipts(organization_id,project_id,candidate_receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,wfp_receipt_id) REFERENCES wfp_publish_receipts(organization_id,project_id,wfp_receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,environment_id,shared_gateway_revision) REFERENCES shared_gateway_route_revisions(organization_id,project_id,environment_id,revision),
  CHECK((shared_gateway_revision IS NULL AND (gateway_version_id=trim(gateway_version_id) AND length(gateway_version_id) BETWEEN 1 AND 255 AND gateway_deployment_id=trim(gateway_deployment_id) AND length(gateway_deployment_id) BETWEEN 1 AND 255)) OR (shared_gateway_revision IS NOT NULL AND ((gateway_version_id IS NULL AND gateway_deployment_id IS NULL AND gateway_contract_version IS NULL AND gateway_script_name IS NULL AND gateway_workers_dev_subdomain IS NULL AND gateway_internal_origin IS NULL AND gateway_public_origin IS NULL AND gateway_provider_tag IS NULL AND gateway_egress_policy_sha256 IS NULL AND gateway_dev_access_service IS NULL AND gateway_dev_access_entrypoint IS NULL AND gateway_dev_access_key_id IS NULL AND gateway_dev_access_public_key_sha256 IS NULL AND gateway_module_sha256 IS NULL AND gateway_compatibility_date IS NULL AND gateway_observed_at IS NULL) OR (gateway_version_id=trim(gateway_version_id) AND length(gateway_version_id) BETWEEN 1 AND 255 AND gateway_deployment_id=trim(gateway_deployment_id) AND length(gateway_deployment_id) BETWEEN 1 AND 255)))),
  CHECK((shared_gateway_revision IS NULL AND (((activated_head_version IS NULL AND gateway_contract_version IS NULL AND gateway_script_name IS NULL AND gateway_workers_dev_subdomain IS NULL AND gateway_internal_origin IS NULL AND gateway_public_origin IS NULL AND gateway_provider_tag IS NULL AND gateway_egress_policy_sha256 IS NULL AND gateway_dev_access_service IS NULL AND gateway_dev_access_entrypoint IS NULL AND gateway_dev_access_key_id IS NULL AND gateway_dev_access_public_key_sha256 IS NULL AND gateway_module_sha256 IS NULL AND gateway_compatibility_date IS NULL AND gateway_observed_at IS NULL) OR (activated_head_version>0 AND gateway_contract_version='ohmyhost.project-gateway/v7' AND (length(gateway_script_name) BETWEEN 1 AND 63 AND substr(gateway_script_name,1,1) GLOB '[a-z0-9]' AND gateway_script_name NOT GLOB '*[^a-z0-9-]*') AND (length(gateway_workers_dev_subdomain) BETWEEN 1 AND 63 AND substr(gateway_workers_dev_subdomain,1,1) GLOB '[a-z0-9]' AND gateway_workers_dev_subdomain NOT GLOB '*[^a-z0-9-]*') AND gateway_internal_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev' AND (substr(gateway_public_origin,1,8)='https://' AND length(gateway_public_origin)>8 AND substr(gateway_public_origin,9) NOT GLOB '*[^a-z0-9.-]*') AND gateway_internal_origin<>gateway_public_origin AND length(gateway_provider_tag)=32 AND length(gateway_egress_policy_sha256)=32 AND length(gateway_module_sha256)=32 AND gateway_compatibility_date>='2024-09-23' AND gateway_observed_at IS NOT NULL AND ((gateway_dev_access_service IS NULL AND gateway_dev_access_entrypoint IS NULL AND gateway_dev_access_key_id IS NULL AND gateway_dev_access_public_key_sha256 IS NULL) OR ((length(gateway_dev_access_service) BETWEEN 1 AND 63 AND substr(gateway_dev_access_service,1,1) GLOB '[a-z0-9]' AND gateway_dev_access_service NOT GLOB '*[^a-z0-9-]*') AND gateway_dev_access_entrypoint='DevAccessService' AND length(gateway_dev_access_key_id)=32 AND gateway_dev_access_key_id=gateway_dev_access_public_key_sha256)))) IS TRUE)) OR (shared_gateway_revision IS NOT NULL AND ((gateway_version_id IS NULL AND gateway_deployment_id IS NULL AND gateway_contract_version IS NULL AND gateway_script_name IS NULL AND gateway_workers_dev_subdomain IS NULL AND gateway_internal_origin IS NULL AND gateway_public_origin IS NULL AND gateway_provider_tag IS NULL AND gateway_egress_policy_sha256 IS NULL AND gateway_dev_access_service IS NULL AND gateway_dev_access_entrypoint IS NULL AND gateway_dev_access_key_id IS NULL AND gateway_dev_access_public_key_sha256 IS NULL AND gateway_module_sha256 IS NULL AND gateway_compatibility_date IS NULL AND gateway_observed_at IS NULL) OR (((activated_head_version IS NULL AND gateway_contract_version IS NULL AND gateway_script_name IS NULL AND gateway_workers_dev_subdomain IS NULL AND gateway_internal_origin IS NULL AND gateway_public_origin IS NULL AND gateway_provider_tag IS NULL AND gateway_egress_policy_sha256 IS NULL AND gateway_dev_access_service IS NULL AND gateway_dev_access_entrypoint IS NULL AND gateway_dev_access_key_id IS NULL AND gateway_dev_access_public_key_sha256 IS NULL AND gateway_module_sha256 IS NULL AND gateway_compatibility_date IS NULL AND gateway_observed_at IS NULL) OR (activated_head_version>0 AND gateway_contract_version='ohmyhost.project-gateway/v7' AND (length(gateway_script_name) BETWEEN 1 AND 63 AND substr(gateway_script_name,1,1) GLOB '[a-z0-9]' AND gateway_script_name NOT GLOB '*[^a-z0-9-]*') AND (length(gateway_workers_dev_subdomain) BETWEEN 1 AND 63 AND substr(gateway_workers_dev_subdomain,1,1) GLOB '[a-z0-9]' AND gateway_workers_dev_subdomain NOT GLOB '*[^a-z0-9-]*') AND gateway_internal_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev' AND (substr(gateway_public_origin,1,8)='https://' AND length(gateway_public_origin)>8 AND substr(gateway_public_origin,9) NOT GLOB '*[^a-z0-9.-]*') AND gateway_internal_origin<>gateway_public_origin AND length(gateway_provider_tag)=32 AND length(gateway_egress_policy_sha256)=32 AND length(gateway_module_sha256)=32 AND gateway_compatibility_date>='2024-09-23' AND gateway_observed_at IS NOT NULL AND ((gateway_dev_access_service IS NULL AND gateway_dev_access_entrypoint IS NULL AND gateway_dev_access_key_id IS NULL AND gateway_dev_access_public_key_sha256 IS NULL) OR ((length(gateway_dev_access_service) BETWEEN 1 AND 63 AND substr(gateway_dev_access_service,1,1) GLOB '[a-z0-9]' AND gateway_dev_access_service NOT GLOB '*[^a-z0-9-]*') AND gateway_dev_access_entrypoint='DevAccessService' AND length(gateway_dev_access_key_id)=32 AND gateway_dev_access_key_id=gateway_dev_access_public_key_sha256)))) IS TRUE)))),
  CHECK(length(rollback_activation_receipt_id)=26 AND rollback_activation_receipt_id GLOB '[0-7]*' AND rollback_activation_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK(length(project_id)=26 AND project_id GLOB '[0-7]*' AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK(length(environment_id)=26 AND environment_id GLOB '[0-7]*' AND environment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK(length(operation_id)=26 AND operation_id GLOB '[0-7]*' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK(length(rollback_deployment_id)=26 AND rollback_deployment_id GLOB '[0-7]*' AND rollback_deployment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK(length(target_deployment_id)=26 AND target_deployment_id GLOB '[0-7]*' AND target_deployment_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK(length(target_revision_id)=26 AND target_revision_id GLOB '[0-7]*' AND target_revision_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK(length(candidate_receipt_id)=26 AND candidate_receipt_id GLOB '[0-7]*' AND candidate_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  CHECK(length(wfp_receipt_id)=26 AND wfp_receipt_id GLOB '[0-7]*' AND wfp_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER wfp_rollback_activation_receipts_no_update BEFORE UPDATE ON wfp_rollback_activation_receipts
BEGIN SELECT RAISE(ABORT,'Rollback activation evidence is append-only'); END;
CREATE TRIGGER wfp_rollback_activation_receipts_no_delete BEFORE DELETE ON wfp_rollback_activation_receipts
BEGIN SELECT RAISE(ABORT,'Rollback activation evidence is append-only'); END;

-- No runtime RPC can open this context; an ever-activated Core can never import again.
DROP TRIGGER core_historical_import_open;
CREATE TRIGGER core_historical_import_open BEFORE INSERT ON core_historical_import
BEGIN
  SELECT RAISE(ABORT, 'an ever-activated authority can never open historical import')
    WHERE EXISTS (SELECT 1 FROM core_authority_activation);
  SELECT RAISE(ABORT, 'historical import begins loading, never already qualified')
    WHERE NEW.closed_at IS NOT NULL OR NEW.comparison_sha256 IS NOT NULL OR NEW.restored_runtime_schema_sha256 IS NOT NULL;
  SELECT RAISE(ABORT, 'historical temporal admission has a closed exact table allowlist')
    WHERE EXISTS (SELECT 1 FROM json_each(NEW.temporal_tables)
      WHERE type <> 'text' OR value NOT IN ('wfp_candidate_receipts','wfp_candidate_cleanup_receipts','wfp_publish_receipts','wfp_rollback_activation_receipts'))
      OR (SELECT count(*) FROM json_each(NEW.temporal_tables))
        <> (SELECT count(DISTINCT value) FROM json_each(NEW.temporal_tables));
END;

CREATE TRIGGER wfp_rollback_activation_current BEFORE INSERT ON wfp_rollback_activation_receipts
WHEN NOT(NOT EXISTS(SELECT 1 FROM core_authority_activation) AND EXISTS(SELECT 1 FROM core_historical_import historical,json_each(historical.temporal_tables) allowed WHERE historical.closed_at IS NULL AND allowed.value='wfp_rollback_activation_receipts')) AND NOT(EXISTS(SELECT 1 FROM environments environment
 JOIN projects project ON project.organization_id=environment.organization_id AND project.project_id=environment.project_id AND project.lifecycle_state='active'
 JOIN cloudflare_project_domains domain ON domain.organization_id=environment.organization_id AND domain.project_id=environment.project_id AND domain.deleted_at IS NULL AND domain.handle=project.handle
 JOIN shared_gateway_route_revisions route ON route.organization_id=environment.organization_id AND route.project_id=environment.project_id AND route.environment_id=environment.environment_id
  AND route.revision=NEW.shared_gateway_revision AND route.active=1 AND route.candidate_receipt_id=NEW.candidate_receipt_id AND route.operation_id=NEW.operation_id
  AND route.handle=project.handle AND route.public_origin='https://'||CASE environment.name WHEN 'dev' THEN domain.development_domain ELSE domain.production_domain END
 JOIN deployment_revisions revision ON revision.organization_id=NEW.organization_id AND revision.project_id=NEW.project_id AND revision.deployment_id=NEW.target_deployment_id AND revision.revision_id=NEW.target_revision_id AND revision.wfp_receipt_id=NEW.wfp_receipt_id
 JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id AND receipt.candidate_receipt_id=NEW.candidate_receipt_id AND receipt.environment_id=NEW.environment_id AND receipt.product_deployment_id=NEW.target_deployment_id
 JOIN deployments rollback ON rollback.organization_id=NEW.organization_id AND rollback.project_id=NEW.project_id AND rollback.deployment_id=NEW.rollback_deployment_id AND rollback.operation_id=NEW.operation_id AND rollback.environment_id=NEW.environment_id AND rollback.kind='rollback' AND rollback.rollback_target_deployment_id=NEW.target_deployment_id AND rollback.rollback_target_revision_id=NEW.target_revision_id
 WHERE environment.organization_id=NEW.organization_id AND environment.project_id=NEW.project_id AND environment.environment_id=NEW.environment_id
 AND NEW.activated_head_version=environment.head_version+1
 AND EXISTS(SELECT 1 FROM wfp_candidate_receipts candidate WHERE candidate.organization_id=route.organization_id AND candidate.project_id=route.project_id AND candidate.environment_id=route.environment_id AND candidate.candidate_receipt_id=route.candidate_receipt_id
  AND CASE WHEN domain.production_domain=project.handle||'.check.omh.st' THEN candidate.dispatch_namespace='ohmyho-production' ELSE candidate.dispatch_namespace IN ('sandbox','ohmyho-sandbox','ohmyho-poc-private-fullstack') END)
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=route.candidate_receipt_id)
 AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions newer WHERE newer.organization_id=route.organization_id AND newer.project_id=route.project_id AND newer.environment_id=route.environment_id AND newer.revision>route.revision)))
BEGIN SELECT RAISE(ABORT,'Rollback requires the exact target, current shared gateway and next head'); END;
