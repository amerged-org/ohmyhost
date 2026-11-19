const GATEWAY_COLUMNS = {
  gateway_contract_version: "text",
  gateway_script_name: "text",
  gateway_workers_dev_subdomain: "text",
  gateway_internal_origin: "text",
  gateway_public_origin: "text",
  gateway_provider_tag: "bytea",
  gateway_egress_policy_sha256: "bytea",
  gateway_dev_access_service: "text",
  gateway_dev_access_entrypoint: "text",
  gateway_dev_access_key_id: "bytea",
  gateway_dev_access_public_key_sha256: "bytea",
  gateway_module_sha256: "bytea",
  gateway_compatibility_date: "date",
  gateway_observed_at: "timestamptz",
};

export function up(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM environments environment
      JOIN wfp_rollback_activation_receipts activation
        ON activation.organization_id=environment.organization_id
       AND activation.project_id=environment.project_id
       AND activation.environment_id=environment.environment_id
       AND activation.target_deployment_id=environment.active_deployment_id
       AND activation.target_revision_id=environment.active_revision_id
    ) THEN
      RAISE EXCEPTION 'active legacy rollback requires provider-verified gateway refresh before migration';
    END IF;
  END $$;`);
  pgm.addColumns("wfp_rollback_activation_receipts", {
    activated_head_version: { type: "bigint" },
    ...Object.fromEntries(Object.entries(GATEWAY_COLUMNS).map(([name, type]) => [name, { type }])),
  });
  pgm.addConstraint("wfp_rollback_activation_receipts", "rollback_gateway_head_key", {
    unique: ["organization_id", "project_id", "environment_id", "activated_head_version"],
  });
  pgm.sql(`
    ALTER TABLE wfp_rollback_activation_receipts ADD CONSTRAINT rollback_gateway_identity_check CHECK ((
      (activated_head_version IS NULL AND ${Object.keys(GATEWAY_COLUMNS)
        .map((name) => `${name} IS NULL`)
        .join(" AND ")})
      OR (
        activated_head_version>0 AND gateway_contract_version='ohmyhost.project-gateway/v7'
        AND gateway_script_name ~ '^[a-z0-9][a-z0-9-]{0,62}$'
        AND gateway_workers_dev_subdomain ~ '^[a-z0-9][a-z0-9-]{0,62}$'
        AND gateway_internal_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev'
        AND gateway_public_origin ~ '^https://[a-z0-9.-]+$'
        AND gateway_internal_origin<>gateway_public_origin
        AND octet_length(gateway_provider_tag)=32
        AND octet_length(gateway_egress_policy_sha256)=32
        AND octet_length(gateway_module_sha256)=32
        AND gateway_compatibility_date>='2024-09-23'::date AND gateway_observed_at IS NOT NULL
        AND ((gateway_dev_access_service IS NULL AND gateway_dev_access_entrypoint IS NULL
              AND gateway_dev_access_key_id IS NULL AND gateway_dev_access_public_key_sha256 IS NULL)
          OR (gateway_dev_access_service ~ '^[a-z0-9][a-z0-9-]{0,62}$'
              AND gateway_dev_access_entrypoint='DevAccessService'
              AND octet_length(gateway_dev_access_key_id)=32
              AND gateway_dev_access_key_id=gateway_dev_access_public_key_sha256))
      )
    ) IS TRUE);

    CREATE FUNCTION require_rollback_gateway_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE expected_origin text; expected_script text; environment_name text; current_head bigint;
    BEGIN
      SELECT 'https://'||CASE environment.name WHEN 'dev' THEN domain.development_domain ELSE domain.production_domain END,
             CASE environment.name WHEN 'dev' THEN 'dev-'||domain.handle ELSE domain.handle END,
             environment.name,environment.head_version
        INTO expected_origin,expected_script,environment_name,current_head
      FROM environments environment
      JOIN cloudflare_project_domains domain
        ON domain.organization_id=environment.organization_id AND domain.project_id=environment.project_id
       AND domain.deleted_at IS NULL
      WHERE environment.organization_id=NEW.organization_id AND environment.project_id=NEW.project_id
        AND environment.environment_id=NEW.environment_id;
      IF NOT FOUND OR NEW.activated_head_version IS NULL
        OR NEW.activated_head_version<>current_head+1
        OR NEW.gateway_public_origin IS DISTINCT FROM expected_origin
        OR NEW.gateway_script_name IS DISTINCT FROM expected_script
        OR (environment_name='dev' AND NEW.gateway_dev_access_service IS NULL)
        OR (environment_name='prod' AND NEW.gateway_dev_access_service IS NOT NULL)
      THEN
        RAISE EXCEPTION 'rollback requires complete current gateway identity' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER rollback_gateway_identity BEFORE INSERT ON wfp_rollback_activation_receipts
      FOR EACH ROW EXECUTE FUNCTION require_rollback_gateway_identity();

    CREATE VIEW effective_wfp_publish_receipts WITH (security_invoker=true) AS
    SELECT receipt.wfp_receipt_id,receipt.organization_id,receipt.project_id,receipt.artifact_id,
           receipt.dispatch_namespace,receipt.script_name,receipt.provider_version_id,
           CASE WHEN activation.rollback_activation_receipt_id IS NOT NULL
             THEN activation.gateway_public_origin ELSE receipt.deployment_url END AS deployment_url,
           receipt.published_at,receipt.environment_id,receipt.candidate_receipt_id,receipt.product_deployment_id,
           receipt.gateway_target_script_name,
           ${[...Object.keys(GATEWAY_COLUMNS), "gateway_version_id", "gateway_deployment_id"].map((name) => `CASE WHEN activation.rollback_activation_receipt_id IS NOT NULL THEN activation.${name} ELSE receipt.${name} END AS ${name}`).join(",\n           ")}
    FROM wfp_publish_receipts receipt
    LEFT JOIN environments environment
      ON environment.organization_id=receipt.organization_id AND environment.project_id=receipt.project_id
     AND environment.environment_id=receipt.environment_id
     AND environment.active_deployment_id=receipt.product_deployment_id
     AND EXISTS (SELECT 1 FROM deployment_revisions revision
       WHERE revision.organization_id=receipt.organization_id AND revision.project_id=receipt.project_id
         AND revision.wfp_receipt_id=receipt.wfp_receipt_id
         AND revision.deployment_id=environment.active_deployment_id AND revision.revision_id=environment.active_revision_id)
    LEFT JOIN wfp_rollback_activation_receipts activation
      ON activation.organization_id=environment.organization_id AND activation.project_id=environment.project_id
     AND activation.environment_id=environment.environment_id
     AND activation.target_deployment_id=environment.active_deployment_id
     AND activation.target_revision_id=environment.active_revision_id
     AND activation.wfp_receipt_id=receipt.wfp_receipt_id
     AND activation.activated_head_version=environment.head_version;

    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        GRANT SELECT ON effective_wfp_publish_receipts TO control_runtime;
      END IF;
    END $$;
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM wfp_rollback_activation_receipts WHERE activated_head_version IS NOT NULL) THEN
      RAISE EXCEPTION 'rollback gateway identity cannot be discarded';
    END IF;
  END $$;
  DROP VIEW effective_wfp_publish_receipts;
  DROP TRIGGER rollback_gateway_identity ON wfp_rollback_activation_receipts;
  DROP FUNCTION require_rollback_gateway_identity();
  ALTER TABLE wfp_rollback_activation_receipts DROP CONSTRAINT rollback_gateway_identity_check;`);
  pgm.dropConstraint("wfp_rollback_activation_receipts", "rollback_gateway_head_key");
  pgm.dropColumns("wfp_rollback_activation_receipts", [
    "activated_head_version",
    ...Object.keys(GATEWAY_COLUMNS),
  ]);
}
