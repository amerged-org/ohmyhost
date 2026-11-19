const ENVIRONMENT_REFERENCES = [
  ["local_authorization_grants", "local_authorization_grants_environment_fkey", "CASCADE", false],
  ["wfp_publish_receipts", "wfp_publish_receipts_environment_fkey", "RESTRICT", false],
  ["deployments", "deployments_environment_fkey", "RESTRICT", false],
  ["aws_build_receipts", "aws_build_receipts_environment_fkey", "RESTRICT", false],
  ["product_command_intents", "product_command_intents_environment_fkey", "RESTRICT", false],
  [
    "product_source_archive_objects",
    "product_source_archive_objects_environment_fkey",
    "RESTRICT",
    false,
  ],
  ["product_workflow_runs", "product_workflow_runs_environment_fkey", "RESTRICT", false],
  ["environment_secrets", "environment_secrets_environment_fkey", "CASCADE", true],
  ["environment_secret_requests", "environment_secret_requests_environment_fkey", "CASCADE", false],
  [
    "runtime_secret_delivery_states",
    "runtime_secret_delivery_states_environment_fkey",
    "CASCADE",
    true,
  ],
  [
    "runtime_secret_delivery_receipts",
    "runtime_secret_delivery_receipts_environment_fkey",
    "RESTRICT",
    false,
  ],
  [
    "aws_build_input_reservations",
    "aws_build_input_reservations_environment_fkey",
    "RESTRICT",
    false,
  ],
  [
    "oci_assembly_input_reservations",
    "oci_assembly_input_reservations_environment_fkey",
    "RESTRICT",
    false,
  ],
  ["oci_assembly_receipts", "oci_assembly_receipts_environment_fkey", "RESTRICT", false],
  ["ecr_image_receipts", "ecr_image_receipts_environment_fkey", "RESTRICT", false],
  ["container_artifact_objects", "container_artifact_objects_environment_fkey", "RESTRICT", false],
  [
    "container_application_receipts",
    "container_application_receipts_environment_fkey",
    "RESTRICT",
    false,
  ],
  ["project_r2_bucket_receipts", "project_r2_bucket_receipts_environment_fkey", "RESTRICT", false],
];

export function up(pgm) {
  pgm.sql(`
    DO $cutover$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='projects' AND column_name='handle'
      ) THEN
        ALTER TABLE projects
          ADD COLUMN handle text,
          ADD COLUMN handle_version text,
          ADD COLUMN handle_attempt integer;
      END IF;

      IF EXISTS (
        SELECT 1 FROM projects
        WHERE handle IS NULL OR handle_version IS NULL OR handle_attempt IS NULL
      ) THEN
        RAISE EXCEPTION 'project handle cutover requires truthful staged evidence for every existing project'
          USING ERRCODE='23514';
      END IF;

      IF EXISTS (
        SELECT project.project_id
        FROM projects project
        INNER JOIN project_ownerships ownership USING(project_id)
        LEFT JOIN environments environment
          ON environment.organization_id=ownership.organization_id
         AND environment.project_id=project.project_id
        GROUP BY project.project_id
        HAVING count(environment.environment_id)<>2
          OR count(*) FILTER (WHERE environment.name='dev')<>1
          OR count(*) FILTER (WHERE environment.name='prod')<>1
          OR count(*) FILTER (WHERE environment.name NOT IN ('dev','prod'))<>0
          OR count(*) FILTER (WHERE environment.environment_id=project.project_id)<>0
      ) OR EXISTS (
        SELECT 1 FROM environments environment
        WHERE environment.name NOT IN ('dev','prod')
      ) THEN
        RAISE EXCEPTION 'project environment cutover requires exact staged dev and prod rows for every existing project'
          USING ERRCODE='23514';
      END IF;

      IF EXISTS (
        SELECT 1 FROM wfp_publish_receipts WHERE gateway_contract_version IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'project gateway cutover requires fresh environment-specific provider receipts; existing gateway evidence cannot be inferred or rewritten'
          USING ERRCODE='23514';
      END IF;

      ALTER TABLE projects
        ALTER COLUMN handle SET NOT NULL,
        ALTER COLUMN handle_version SET NOT NULL,
        ALTER COLUMN handle_attempt SET NOT NULL;

      ALTER TABLE projects
        ADD CONSTRAINT projects_handle_key UNIQUE(handle),
        ADD CONSTRAINT projects_handle_shape_check
          CHECK (handle~'^[a-z]+-[a-z]+-[a-z]+$' AND length(handle)<=59),
        ADD CONSTRAINT projects_handle_evidence_check
          CHECK (handle_version='human-id-4.2.0-sha256-project-handle-words-v1'
            AND handle_attempt BETWEEN 0 AND 31);

      ALTER TABLE environments
        ADD CONSTRAINT environments_poc_name_check CHECK (name IN ('dev','prod')),
        ADD CONSTRAINT environments_project_environment_key UNIQUE(project_id,environment_id),
        ADD CONSTRAINT environments_project_id_distinct_check CHECK (environment_id<>project_id);

      DROP INDEX environments_one_default_per_project_key;
      ALTER TABLE environments DROP COLUMN is_default;

      ALTER TABLE wfp_publish_receipts
        DROP CONSTRAINT wfp_publish_receipts_gateway_shape_check,
        ADD COLUMN gateway_egress_policy_sha256 bytea,
        ADD COLUMN gateway_dev_access_service text,
        ADD COLUMN gateway_dev_access_entrypoint text,
        ADD COLUMN gateway_dev_access_key_id bytea,
        ADD COLUMN gateway_dev_access_public_key_sha256 bytea,
        ADD CONSTRAINT wfp_publish_receipts_gateway_shape_check CHECK ((
          gateway_contract_version IS NULL
          AND gateway_script_name IS NULL
          AND gateway_target_script_name IS NULL
          AND gateway_workers_dev_subdomain IS NULL
          AND gateway_provider_tag IS NULL
          AND gateway_module_sha256 IS NULL
          AND gateway_egress_policy_sha256 IS NULL
          AND gateway_dev_access_service IS NULL
          AND gateway_dev_access_entrypoint IS NULL
          AND gateway_dev_access_key_id IS NULL
          AND gateway_dev_access_public_key_sha256 IS NULL
          AND gateway_public_origin IS NULL
          AND gateway_compatibility_date IS NULL
          AND gateway_observed_at IS NULL
        ) OR (
          gateway_contract_version='ohmyhost.project-gateway/v5'
          AND gateway_script_name IS NOT NULL
          AND gateway_target_script_name IS NOT NULL
          AND gateway_workers_dev_subdomain IS NOT NULL
          AND gateway_provider_tag IS NOT NULL
          AND gateway_module_sha256 IS NOT NULL
          AND gateway_egress_policy_sha256 IS NOT NULL
          AND gateway_public_origin IS NOT NULL
          AND gateway_compatibility_date IS NOT NULL
          AND gateway_observed_at IS NOT NULL
          AND gateway_target_script_name=script_name
          AND gateway_workers_dev_subdomain~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
          AND octet_length(gateway_provider_tag)=32
          AND octet_length(gateway_module_sha256)=32
          AND octet_length(gateway_egress_policy_sha256)=32
          AND (gateway_dev_access_service IS NULL OR gateway_dev_access_service~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
          AND (gateway_dev_access_entrypoint IS NULL OR gateway_dev_access_entrypoint='DevAccessService')
          AND (gateway_dev_access_key_id IS NULL OR octet_length(gateway_dev_access_key_id)=32)
          AND (gateway_dev_access_public_key_sha256 IS NULL OR octet_length(gateway_dev_access_public_key_sha256)=32)
          AND gateway_public_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev'
          AND deployment_url=gateway_public_origin
          AND gateway_compatibility_date>='2024-09-23'::date
        ));

      ${environmentReferenceSql(false)}
    END $cutover$;

    DROP TRIGGER projects_default_environment ON projects;
    DROP FUNCTION ensure_default_sandbox_environment();

    CREATE OR REPLACE FUNCTION require_project_gateway_receipt_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      project_handle text;
      environment_name text;
    BEGIN
      IF NEW.gateway_contract_version IS NULL THEN
        RAISE EXCEPTION 'new WFP receipts require project gateway evidence'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_insert_required';
      END IF;

      SELECT project.handle,environment.name INTO STRICT project_handle,environment_name
      FROM projects project
      INNER JOIN environments environment
        ON environment.project_id=project.project_id
       AND environment.environment_id=NEW.environment_id
      WHERE project.project_id=NEW.project_id;

      IF NEW.gateway_contract_version<>'ohmyhost.project-gateway/v5'
        OR NEW.gateway_script_name<>(CASE environment_name
             WHEN 'prod' THEN project_handle
             WHEN 'dev' THEN 'dev-'||project_handle
           END)
        OR NEW.gateway_target_script_name<>'p-'||lower(NEW.project_id::text)||'-'||environment_name
        OR NEW.script_name<>NEW.gateway_target_script_name
        OR NEW.gateway_public_origin<>'https://'||NEW.gateway_script_name||'.'||NEW.gateway_workers_dev_subdomain||'.workers.dev'
        OR NEW.deployment_url<>NEW.gateway_public_origin
        OR (environment_name='dev' AND (
          NEW.gateway_dev_access_service IS NULL
          OR NEW.gateway_dev_access_entrypoint IS DISTINCT FROM 'DevAccessService'
          OR NEW.gateway_dev_access_key_id IS NULL
          OR NEW.gateway_dev_access_public_key_sha256 IS NULL
          OR NEW.gateway_dev_access_key_id<>NEW.gateway_dev_access_public_key_sha256
        ))
        OR (environment_name='prod' AND (
          NEW.gateway_dev_access_service IS NOT NULL
          OR NEW.gateway_dev_access_entrypoint IS NOT NULL
          OR NEW.gateway_dev_access_key_id IS NOT NULL
          OR NEW.gateway_dev_access_public_key_sha256 IS NOT NULL
        )) THEN
        RAISE EXCEPTION 'WFP gateway receipt does not match its immutable project environment identity'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
      END IF;
      RETURN NEW;
    EXCEPTION
      WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'WFP gateway receipt requires one exact project environment identity'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
    END;
    $$;

    CREATE OR REPLACE FUNCTION reject_project_identity_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.created_organization_id IS DISTINCT FROM OLD.created_organization_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.handle IS DISTINCT FROM OLD.handle
        OR NEW.handle_version IS DISTINCT FROM OLD.handle_version
        OR NEW.handle_attempt IS DISTINCT FROM OLD.handle_attempt
        OR NEW.created_event_id IS DISTINCT FROM OLD.created_event_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'project creation identity is immutable' USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE FUNCTION reject_environment_identity_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'project environments cannot be deleted' USING ERRCODE='55000';
      END IF;
      IF NEW.environment_id IS DISTINCT FROM OLD.environment_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'environment creation identity is immutable' USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER environments_identity_immutable
      BEFORE UPDATE OR DELETE ON environments
      FOR EACH ROW EXECUTE FUNCTION reject_environment_identity_change();

    CREATE FUNCTION require_exact_poc_environments(checked_project_id ulid) RETURNS void
    LANGUAGE plpgsql AS $$
    DECLARE
      current_organization_id ulid;
    BEGIN
      SELECT organization_id INTO STRICT current_organization_id
      FROM project_ownerships WHERE project_id=checked_project_id;

      IF EXISTS (
        SELECT 1 FROM environments
        WHERE project_id=checked_project_id AND organization_id<>current_organization_id
      ) OR (SELECT count(*) FROM environments
            WHERE project_id=checked_project_id AND organization_id=current_organization_id)<>2
        OR NOT EXISTS (SELECT 1 FROM environments
                       WHERE project_id=checked_project_id
                         AND organization_id=current_organization_id
                         AND name='dev')
        OR NOT EXISTS (SELECT 1 FROM environments
                       WHERE project_id=checked_project_id
                         AND organization_id=current_organization_id
                         AND name='prod') THEN
        RAISE EXCEPTION 'project must commit with exactly immutable dev and prod environments'
          USING ERRCODE='23514', CONSTRAINT='environments_exact_poc_set';
      END IF;
    EXCEPTION
      WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'project must commit with one owned exact dev and prod environment set'
          USING ERRCODE='23514', CONSTRAINT='environments_exact_poc_set';
    END;
    $$;

    CREATE FUNCTION check_project_exact_poc_environments() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM require_exact_poc_environments(NEW.project_id);
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER projects_exact_poc_environments
      AFTER INSERT ON projects DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION check_project_exact_poc_environments();

    CREATE FUNCTION check_environment_exact_poc_set() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM require_exact_poc_environments(CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END);
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER environments_exact_poc_set
      AFTER INSERT OR UPDATE OR DELETE ON environments DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION check_environment_exact_poc_set();

    CREATE FUNCTION check_ownership_exact_poc_environments() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM require_exact_poc_environments(CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END);
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER project_ownerships_exact_poc_environments
      AFTER INSERT OR UPDATE OR DELETE ON project_ownerships DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION check_ownership_exact_poc_environments();
  `);
}

export function down(pgm) {
  pgm.sql(`
    DO $downgrade$
    BEGIN
      IF EXISTS (SELECT 1 FROM projects) THEN
        RAISE EXCEPTION 'project handle cutover cannot be downgraded while projects exist'
          USING ERRCODE='23514';
      END IF;
    END $downgrade$;

    DROP TRIGGER project_ownerships_exact_poc_environments ON project_ownerships;
    DROP FUNCTION check_ownership_exact_poc_environments();
    DROP TRIGGER environments_exact_poc_set ON environments;
    DROP FUNCTION check_environment_exact_poc_set();
    DROP TRIGGER projects_exact_poc_environments ON projects;
    DROP FUNCTION check_project_exact_poc_environments();
    DROP FUNCTION require_exact_poc_environments(ulid);
    DROP TRIGGER environments_identity_immutable ON environments;
    DROP FUNCTION reject_environment_identity_change();

    ALTER TABLE environments DROP CONSTRAINT environments_poc_name_check;
    ${environmentReferenceSql(true)}
    ALTER TABLE environments
      DROP CONSTRAINT environments_project_id_distinct_check,
      DROP CONSTRAINT environments_project_environment_key;
    ALTER TABLE environments ADD COLUMN is_default boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX environments_one_default_per_project_key
      ON environments(organization_id,project_id) WHERE is_default;

    ALTER TABLE projects
      DROP CONSTRAINT projects_handle_evidence_check,
      DROP CONSTRAINT projects_handle_shape_check,
      DROP CONSTRAINT projects_handle_key,
      DROP COLUMN handle_attempt,
      DROP COLUMN handle_version,
      DROP COLUMN handle;

    ALTER TABLE wfp_publish_receipts
      DROP CONSTRAINT wfp_publish_receipts_gateway_shape_check,
      DROP COLUMN gateway_dev_access_public_key_sha256,
      DROP COLUMN gateway_dev_access_key_id,
      DROP COLUMN gateway_dev_access_entrypoint,
      DROP COLUMN gateway_dev_access_service,
      DROP COLUMN gateway_egress_policy_sha256,
      ADD CONSTRAINT wfp_publish_receipts_gateway_shape_check CHECK ((
        gateway_contract_version IS NULL
        AND gateway_script_name IS NULL
        AND gateway_target_script_name IS NULL
        AND gateway_workers_dev_subdomain IS NULL
        AND gateway_provider_tag IS NULL
        AND gateway_module_sha256 IS NULL
        AND gateway_public_origin IS NULL
        AND gateway_compatibility_date IS NULL
        AND gateway_observed_at IS NULL
      ) OR (
        gateway_contract_version='ohmyhost.project-gateway/v1'
        AND gateway_script_name='g-'||lower(project_id::text)
        AND gateway_target_script_name=script_name
        AND gateway_target_script_name='p-'||lower(project_id::text)
        AND gateway_workers_dev_subdomain~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
        AND octet_length(gateway_provider_tag)=32
        AND octet_length(gateway_module_sha256)=32
        AND gateway_public_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev'
        AND deployment_url=gateway_public_origin||'/p/'||project_id::text
        AND gateway_compatibility_date>='2024-09-23'::date
      ));

    CREATE OR REPLACE FUNCTION require_project_gateway_receipt_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.gateway_contract_version IS NULL THEN
        RAISE EXCEPTION 'new WFP receipts require project gateway evidence'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_insert_required';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION reject_project_identity_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.created_organization_id IS DISTINCT FROM OLD.created_organization_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.created_event_id IS DISTINCT FROM OLD.created_event_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'project creation identity is immutable' USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE FUNCTION ensure_default_sandbox_environment() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO environments
        (organization_id,environment_id,project_id,name,desired_state,created_at,updated_at,is_default)
      SELECT ownership.organization_id,NEW.project_id,NEW.project_id,'sandbox','{}'::jsonb,
             NEW.created_at,NEW.created_at,true
      FROM project_ownerships ownership WHERE ownership.project_id=NEW.project_id
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER projects_default_environment
      AFTER INSERT ON projects DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ensure_default_sandbox_environment();
  `);
}

function environmentReferenceSql(includeOrganization) {
  return ENVIRONMENT_REFERENCES.map(([table, constraint, onDelete, followsOwnership]) => {
    const currentScope = includeOrganization || followsOwnership;
    const columns = currentScope
      ? "organization_id,project_id,environment_id"
      : "project_id,environment_id";
    const onUpdate = !includeOrganization && followsOwnership ? " ON UPDATE CASCADE" : "";
    return `ALTER TABLE ${table}
      DROP CONSTRAINT ${constraint},
      ADD CONSTRAINT ${constraint}
        FOREIGN KEY (${columns})
        REFERENCES environments(${columns})
       ${onUpdate} ON DELETE ${onDelete};`;
  }).join("\n");
}
