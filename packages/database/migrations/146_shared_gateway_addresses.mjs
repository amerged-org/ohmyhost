/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE shared_gateway_address_receipts (
      organization_id ulid NOT NULL, project_id ulid NOT NULL, environment_id ulid NOT NULL,
      operation_id ulid NOT NULL, wfp_receipt_id ulid NOT NULL,
      shared_gateway_revision bigint NOT NULL CHECK (shared_gateway_revision>0),
      head_version integer NOT NULL CHECK (head_version>0),
      handle text NOT NULL, public_origin text NOT NULL,
      observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (organization_id,project_id,environment_id,operation_id),
      UNIQUE (organization_id,project_id,environment_id,shared_gateway_revision),
      FOREIGN KEY (organization_id,project_id,environment_id)
        REFERENCES environments(organization_id,project_id,environment_id),
      FOREIGN KEY (organization_id,project_id,operation_id)
        REFERENCES operations(organization_id,project_id,operation_id),
      FOREIGN KEY (organization_id,project_id,wfp_receipt_id)
        REFERENCES wfp_publish_receipts(organization_id,project_id,wfp_receipt_id),
      FOREIGN KEY (organization_id,project_id,environment_id,shared_gateway_revision)
        REFERENCES shared_gateway_route_revisions(organization_id,project_id,environment_id,revision),
      CHECK (public_origin ~ '^https://[a-z0-9.-]+$')
    );
    CREATE TRIGGER shared_gateway_address_receipts_append_only
      BEFORE UPDATE OR DELETE ON shared_gateway_address_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    DO $grant$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        GRANT SELECT,INSERT ON shared_gateway_address_receipts TO control_runtime;
      END IF;
    END $grant$;
    CREATE OR REPLACE FUNCTION guard_cloudflare_project_domain_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF (NEW.handle,NEW.production_domain,NEW.development_domain)
          IS DISTINCT FROM (OLD.handle,OLD.production_domain,OLD.development_domain)
        AND NEW.organization_id=OLD.organization_id AND NEW.project_id=OLD.project_id
        AND NEW.operation_id=OLD.operation_id AND NEW.zone_name=OLD.zone_name
        AND NEW.mail_domain IS NOT DISTINCT FROM OLD.mail_domain
        AND NEW.configured_by_principal_id=OLD.configured_by_principal_id
        AND NEW.idempotency_key_sha256=OLD.idempotency_key_sha256
        AND NEW.request_sha256=OLD.request_sha256 AND NEW.configured_at=OLD.configured_at
        AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at AND OLD.deleted_at IS NULL
        AND NEW.handle ~ '^[a-z0-9]+(-[a-z0-9]+){0,4}$'
        AND substring(OLD.production_domain FROM length(OLD.handle)+1)
          IN ('.check.omh.st','.dev.check.omh.st')
        AND NEW.production_domain=NEW.handle||substring(OLD.production_domain FROM length(OLD.handle)+1)
        AND NEW.development_domain='dev-'||NEW.handle||substring(OLD.production_domain FROM length(OLD.handle)+1)
        AND EXISTS (
          SELECT 1 FROM projects project
          JOIN product_command_intents intent ON intent.project_id=project.project_id
            AND intent.organization_id=NEW.organization_id
            AND intent.event_type='ProjectHandleChangeRequestedV1'
            AND intent.requested_handle=NEW.handle
          JOIN operations operation ON operation.organization_id=intent.organization_id
            AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id
            AND operation.state IN ('queued','running')
          JOIN product_provider_mutation_claims claim ON claim.organization_id=intent.organization_id
            AND claim.project_id=intent.project_id AND claim.operation_id=intent.operation_id
            AND claim.accepted_lifecycle_version=project.lifecycle_version
          WHERE project.project_id=NEW.project_id AND project.handle=NEW.handle
            AND project.lifecycle_state='active'
            AND NOT EXISTS (
              SELECT 1 FROM environments environment
              WHERE environment.organization_id=NEW.organization_id
                AND environment.project_id=NEW.project_id
                AND environment.active_deployment_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM shared_gateway_route_revisions route
                  WHERE route.organization_id=environment.organization_id
                    AND route.project_id=environment.project_id
                    AND route.environment_id=environment.environment_id
                    AND route.operation_id=intent.operation_id AND route.active
                    AND route.handle=NEW.handle
                    AND route.public_origin='https://'||CASE environment.name
                      WHEN 'dev' THEN NEW.development_domain ELSE NEW.production_domain END
                    AND NOT EXISTS (SELECT 1 FROM shared_gateway_route_revisions newer
                      WHERE newer.organization_id=route.organization_id
                        AND newer.project_id=route.project_id
                        AND newer.environment_id=route.environment_id
                        AND newer.revision>route.revision)
                )
            )
        ) THEN
        RETURN NEW;
      END IF;
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.handle IS DISTINCT FROM OLD.handle
        OR NEW.zone_name IS DISTINCT FROM OLD.zone_name
        OR NEW.production_domain IS DISTINCT FROM OLD.production_domain
        OR NEW.development_domain IS DISTINCT FROM OLD.development_domain
        OR NEW.mail_domain IS DISTINCT FROM OLD.mail_domain
        OR NEW.configured_by_principal_id IS DISTINCT FROM OLD.configured_by_principal_id
        OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
        OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
        OR NEW.configured_at IS DISTINCT FROM OLD.configured_at
        OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
        RAISE EXCEPTION 'Cloudflare project domain desired state is immutable'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE VIEW effective_wfp_publish_receipts WITH(security_invoker=true) AS
      SELECT receipt.wfp_receipt_id,receipt.organization_id,receipt.project_id,receipt.artifact_id,
        receipt.dispatch_namespace,receipt.script_name,receipt.provider_version_id,route.public_origin AS deployment_url,
        receipt.published_at,receipt.environment_id,receipt.candidate_receipt_id,receipt.product_deployment_id,
        receipt.script_name AS gateway_target_script_name,NULL::text AS gateway_contract_version,NULL::text AS gateway_script_name,
        NULL::text AS gateway_workers_dev_subdomain,NULL::text AS gateway_internal_origin,route.public_origin AS gateway_public_origin,
        NULL::bytea AS gateway_provider_tag,NULL::bytea AS gateway_egress_policy_sha256,NULL::text AS gateway_dev_access_service,
        NULL::text AS gateway_dev_access_entrypoint,NULL::bytea AS gateway_dev_access_key_id,NULL::bytea AS gateway_dev_access_public_key_sha256,
        NULL::bytea AS gateway_module_sha256,NULL::date AS gateway_compatibility_date,NULL::timestamptz AS gateway_observed_at,
        NULL::text AS gateway_version_id,NULL::text AS gateway_deployment_id,route.revision AS shared_gateway_revision
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
      LEFT JOIN projects project ON project.project_id=receipt.project_id
      LEFT JOIN LATERAL (
        SELECT address.shared_gateway_revision FROM shared_gateway_address_receipts address
        WHERE address.organization_id=receipt.organization_id AND address.project_id=receipt.project_id
          AND address.environment_id=receipt.environment_id AND address.wfp_receipt_id=receipt.wfp_receipt_id
          AND address.head_version=environment.head_version AND address.handle=project.handle
        ORDER BY address.shared_gateway_revision DESC LIMIT 1
      ) address ON true
      JOIN shared_gateway_route_revisions route ON route.organization_id=receipt.organization_id AND route.project_id=receipt.project_id
        AND route.environment_id=receipt.environment_id AND route.candidate_receipt_id=receipt.candidate_receipt_id AND route.active
        AND route.revision=COALESCE(address.shared_gateway_revision,
          CASE WHEN activation.rollback_activation_receipt_id IS NOT NULL
            THEN activation.shared_gateway_revision ELSE receipt.shared_gateway_revision END);
  `);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM shared_gateway_address_receipts) THEN
        RAISE EXCEPTION 'active address receipts cannot be discarded';
      END IF;
    END $$;
    CREATE OR REPLACE FUNCTION guard_cloudflare_project_domain_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.handle IS DISTINCT FROM OLD.handle
        OR NEW.zone_name IS DISTINCT FROM OLD.zone_name
        OR NEW.production_domain IS DISTINCT FROM OLD.production_domain
        OR NEW.development_domain IS DISTINCT FROM OLD.development_domain
        OR NEW.mail_domain IS DISTINCT FROM OLD.mail_domain
        OR NEW.configured_by_principal_id IS DISTINCT FROM OLD.configured_by_principal_id
        OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
        OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
        OR NEW.configured_at IS DISTINCT FROM OLD.configured_at
        OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
        RAISE EXCEPTION 'Cloudflare project domain desired state is immutable'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE VIEW effective_wfp_publish_receipts WITH(security_invoker=true) AS
      SELECT receipt.wfp_receipt_id,receipt.organization_id,receipt.project_id,receipt.artifact_id,
        receipt.dispatch_namespace,receipt.script_name,receipt.provider_version_id,route.public_origin AS deployment_url,
        receipt.published_at,receipt.environment_id,receipt.candidate_receipt_id,receipt.product_deployment_id,
        receipt.script_name AS gateway_target_script_name,NULL::text AS gateway_contract_version,NULL::text AS gateway_script_name,
        NULL::text AS gateway_workers_dev_subdomain,NULL::text AS gateway_internal_origin,route.public_origin AS gateway_public_origin,
        NULL::bytea AS gateway_provider_tag,NULL::bytea AS gateway_egress_policy_sha256,NULL::text AS gateway_dev_access_service,
        NULL::text AS gateway_dev_access_entrypoint,NULL::bytea AS gateway_dev_access_key_id,NULL::bytea AS gateway_dev_access_public_key_sha256,
        NULL::bytea AS gateway_module_sha256,NULL::date AS gateway_compatibility_date,NULL::timestamptz AS gateway_observed_at,
        NULL::text AS gateway_version_id,NULL::text AS gateway_deployment_id,route.revision AS shared_gateway_revision
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
      JOIN shared_gateway_route_revisions route ON route.organization_id=receipt.organization_id AND route.project_id=receipt.project_id
        AND route.environment_id=receipt.environment_id AND route.candidate_receipt_id=receipt.candidate_receipt_id AND route.active
        AND route.revision=CASE WHEN activation.rollback_activation_receipt_id IS NOT NULL
          THEN activation.shared_gateway_revision ELSE receipt.shared_gateway_revision END;
    DROP TABLE shared_gateway_address_receipts;
  `);
}
