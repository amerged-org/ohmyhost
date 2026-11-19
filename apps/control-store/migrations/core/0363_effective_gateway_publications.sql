-- Exact original146 address identity and effective publication reader. Static history has no temporal bypass.
CREATE TABLE shared_gateway_address_receipts (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL, wfp_receipt_id TEXT NOT NULL,
  shared_gateway_revision INTEGER NOT NULL CHECK(shared_gateway_revision>0),
  head_version INTEGER NOT NULL CHECK(head_version BETWEEN 1 AND 2147483647),
  handle TEXT NOT NULL, public_origin TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,environment_id,operation_id),
  UNIQUE(organization_id,project_id,environment_id,shared_gateway_revision),
  FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id),
  FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
  FOREIGN KEY(organization_id,project_id,wfp_receipt_id) REFERENCES wfp_publish_receipts(organization_id,project_id,wfp_receipt_id),
  FOREIGN KEY(organization_id,project_id,environment_id,shared_gateway_revision) REFERENCES shared_gateway_route_revisions(organization_id,project_id,environment_id,revision),
  CHECK(substr(public_origin,1,8)='https://' AND length(public_origin)>8 AND substr(public_origin,9) NOT GLOB '*[^a-z0-9.-]*')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER shared_gateway_address_receipts_no_update BEFORE UPDATE ON shared_gateway_address_receipts
BEGIN SELECT RAISE(ABORT,'Gateway address evidence is append-only'); END;
CREATE TRIGGER shared_gateway_address_receipts_no_delete BEFORE DELETE ON shared_gateway_address_receipts
BEGIN SELECT RAISE(ABORT,'Gateway address evidence is append-only'); END;

-- No raw publication alias: current-head rollback and the exact latest handle/address receipt override its route.
CREATE VIEW effective_wfp_publish_receipts AS
      SELECT receipt.wfp_receipt_id,receipt.organization_id,receipt.project_id,receipt.artifact_id,
        receipt.dispatch_namespace,receipt.script_name,receipt.provider_version_id,route.public_origin AS deployment_url,
        receipt.published_at,receipt.environment_id,receipt.candidate_receipt_id,receipt.product_deployment_id,
        receipt.script_name AS gateway_target_script_name,NULL AS gateway_contract_version,NULL AS gateway_script_name,
        NULL AS gateway_workers_dev_subdomain,NULL AS gateway_internal_origin,route.public_origin AS gateway_public_origin,
        NULL AS gateway_provider_tag,NULL AS gateway_egress_policy_sha256,NULL AS gateway_dev_access_service,
        NULL AS gateway_dev_access_entrypoint,NULL AS gateway_dev_access_key_id,NULL AS gateway_dev_access_public_key_sha256,
        NULL AS gateway_module_sha256,NULL AS gateway_compatibility_date,NULL AS gateway_observed_at,
        NULL AS gateway_version_id,NULL AS gateway_deployment_id,route.revision AS shared_gateway_revision
      FROM wfp_publish_receipts receipt
      LEFT JOIN environments environment ON environment.organization_id=receipt.organization_id AND environment.project_id=receipt.project_id
        AND environment.environment_id=receipt.environment_id AND environment.active_deployment_id=receipt.product_deployment_id
        AND EXISTS(SELECT 1 FROM deployment_revisions revision WHERE revision.organization_id=receipt.organization_id
          AND revision.project_id=receipt.project_id AND revision.wfp_receipt_id=receipt.wfp_receipt_id
          AND revision.deployment_id=environment.active_deployment_id AND revision.revision_id=environment.active_revision_id)
      LEFT JOIN wfp_rollback_activation_receipts activation ON activation.organization_id=environment.organization_id
        AND activation.project_id=environment.project_id AND activation.environment_id=environment.environment_id
        AND activation.target_deployment_id=environment.active_deployment_id AND activation.target_revision_id=environment.active_revision_id
        AND activation.wfp_receipt_id=receipt.wfp_receipt_id AND activation.activated_head_version=environment.head_version
      LEFT JOIN projects project ON project.organization_id=receipt.organization_id AND project.project_id=receipt.project_id
      JOIN shared_gateway_route_revisions route ON route.organization_id=receipt.organization_id AND route.project_id=receipt.project_id
        AND route.environment_id=receipt.environment_id AND route.candidate_receipt_id=receipt.candidate_receipt_id AND route.active
        AND route.revision=COALESCE((SELECT address.shared_gateway_revision FROM shared_gateway_address_receipts address
 WHERE address.organization_id=receipt.organization_id AND address.project_id=receipt.project_id AND address.environment_id=receipt.environment_id
 AND address.wfp_receipt_id=receipt.wfp_receipt_id AND address.head_version=environment.head_version AND address.handle=project.handle
 ORDER BY address.shared_gateway_revision DESC LIMIT 1),
          CASE WHEN activation.rollback_activation_receipt_id IS NOT NULL
            THEN activation.shared_gateway_revision ELSE receipt.shared_gateway_revision END);
