const tables = [
  "wfp_publish_receipts",
  "wfp_rollback_activation_receipts",
  "runtime_secret_delivery_stage_activations",
  "wfp_candidate_cleanup_receipts",
];

export function up(pgm) {
  pgm.sql(`
    -- Retain schema definitions solely for a lossless downgrade before new evidence exists.
    CREATE TABLE shared_gateway_receipt_migration_restore (
      kind text NOT NULL, name text NOT NULL, definition text NOT NULL, PRIMARY KEY(kind,name)
    );
    REVOKE ALL ON shared_gateway_receipt_migration_restore FROM PUBLIC;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      REVOKE ALL ON shared_gateway_receipt_migration_restore FROM control_runtime;
    END IF; END $$;
    INSERT INTO shared_gateway_receipt_migration_restore VALUES
      ('function','require_project_gateway_receipt_insert',pg_get_functiondef('require_project_gateway_receipt_insert()'::regprocedure)),
      ('function','require_rollback_gateway_identity',pg_get_functiondef('require_rollback_gateway_identity()'::regprocedure)),
      ('view','effective_wfp_publish_receipts',pg_get_viewdef('effective_wfp_publish_receipts'::regclass,true));

    ALTER TABLE runtime_secret_delivery_stage_activations ADD COLUMN organization_id ulid,
      ADD COLUMN project_id ulid, ADD COLUMN environment_id ulid;
    ALTER TABLE wfp_candidate_cleanup_receipts ADD COLUMN environment_id ulid;
    ${tables
      .map(
        (table) => `ALTER TABLE ${table} ADD COLUMN shared_gateway_revision bigint;
      ALTER TABLE ${table} ADD CONSTRAINT ${table}_shared_gateway_fkey
        FOREIGN KEY(organization_id,project_id,environment_id,shared_gateway_revision)
        REFERENCES shared_gateway_route_revisions(organization_id,project_id,environment_id,revision);`,
      )
      .join("\n")}

    DO $schema$ DECLARE item record; null_shape text; BEGIN
      FOR item IN SELECT c.conrelid::regclass::text AS table_name,c.conname,
          pg_get_expr(c.conbin,c.conrelid) AS expression,pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c WHERE c.connamespace=current_schema()::regnamespace AND c.contype='c'
          AND c.conrelid=ANY(ARRAY[${tables.map((table) => `'${table}'::regclass`).join(",")}])
          AND pg_get_expr(c.conbin,c.conrelid) LIKE '%gateway_%'
      LOOP
        INSERT INTO shared_gateway_receipt_migration_restore VALUES('constraint',item.table_name||'.'||item.conname,item.definition);
        SELECT string_agg(format('%I IS NULL',a.attname),' AND ') INTO null_shape
          FROM pg_attribute a WHERE a.attrelid=item.table_name::regclass
            AND a.attnum>0 AND NOT a.attisdropped AND a.attname LIKE 'gateway_%';
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.table_name,item.conname);
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK ((shared_gateway_revision IS NULL AND (%s)) OR (shared_gateway_revision IS NOT NULL AND ((%s) OR (%s))))',item.table_name,item.conname,item.expression,null_shape,item.expression);
      END LOOP;
      FOR item IN SELECT a.attrelid::regclass::text AS table_name,a.attname,a.attnotnull,
          pg_get_expr(d.adbin,d.adrelid) AS default_expression
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=ANY(ARRAY[${tables.map((table) => `'${table}'::regclass`).join(",")}])
          AND a.attnum>0 AND NOT a.attisdropped AND a.attname LIKE 'gateway_%'
      LOOP
        INSERT INTO shared_gateway_receipt_migration_restore VALUES('column',item.table_name||'.'||item.attname,
          jsonb_build_object('notNull',item.attnotnull,'default',item.default_expression)::text);
        EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP NOT NULL, ALTER COLUMN %I DROP DEFAULT',item.table_name,item.attname,item.attname);
      END LOOP;
    END $schema$;

    CREATE FUNCTION require_current_shared_gateway_receipt(
      expected_organization ulid,expected_project ulid,expected_environment ulid,
      expected_revision bigint,expected_candidate ulid
    ) RETURNS shared_gateway_route_revisions LANGUAGE plpgsql AS $$
    DECLARE route shared_gateway_route_revisions%ROWTYPE; expected_origin text; expected_handle text; production_domain text;
    BEGIN
      SELECT 'https://'||CASE environment.name WHEN 'dev' THEN domain.development_domain ELSE domain.production_domain END,
        project.handle,domain.production_domain INTO STRICT expected_origin,expected_handle,production_domain
      FROM environments environment JOIN projects project ON project.project_id=environment.project_id
      JOIN cloudflare_project_domains domain ON domain.organization_id=environment.organization_id
        AND domain.project_id=environment.project_id AND domain.deleted_at IS NULL AND domain.handle=project.handle
      WHERE environment.organization_id=expected_organization AND environment.project_id=expected_project
        AND environment.environment_id=expected_environment AND project.lifecycle_state='active'
      FOR UPDATE OF environment;
      SELECT * INTO STRICT route FROM shared_gateway_route_revisions
        WHERE organization_id=expected_organization AND project_id=expected_project AND environment_id=expected_environment
        ORDER BY revision DESC LIMIT 1;
      IF expected_revision IS NULL OR route.revision IS DISTINCT FROM expected_revision OR NOT route.active
        OR (expected_candidate IS NOT NULL AND route.candidate_receipt_id IS DISTINCT FROM expected_candidate)
        OR route.public_origin IS DISTINCT FROM expected_origin OR route.handle IS DISTINCT FROM expected_handle
        OR NOT EXISTS(SELECT 1 FROM wfp_candidate_receipts candidate WHERE candidate.organization_id=route.organization_id
          AND candidate.project_id=route.project_id AND candidate.environment_id=route.environment_id AND candidate.candidate_receipt_id=route.candidate_receipt_id
          AND CASE WHEN production_domain=expected_handle||'.check.omh.st' THEN candidate.dispatch_namespace='ohmyho-production'
            ELSE candidate.dispatch_namespace IN ('sandbox','ohmyho-sandbox','ohmyho-poc-private-fullstack') END)
        OR EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=route.candidate_receipt_id)
      THEN RAISE EXCEPTION 'Shared gateway receipt requires the exact active current route' USING ERRCODE='23514'; END IF;
      RETURN route;
    EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'Shared gateway receipt requires one exact scoped route and domain' USING ERRCODE='23514';
    END $$;

    CREATE OR REPLACE FUNCTION require_project_gateway_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE candidate wfp_candidate_receipts%ROWTYPE; route shared_gateway_route_revisions%ROWTYPE;
    BEGIN
      SELECT * INTO STRICT candidate FROM wfp_candidate_receipts WHERE organization_id=NEW.organization_id
        AND project_id=NEW.project_id AND candidate_receipt_id=NEW.candidate_receipt_id;
      route:=require_current_shared_gateway_receipt(NEW.organization_id,NEW.project_id,NEW.environment_id,
        NEW.shared_gateway_revision,NEW.candidate_receipt_id);
      IF NEW.product_deployment_id IS DISTINCT FROM candidate.product_deployment_id
        OR NEW.environment_id IS DISTINCT FROM candidate.environment_id OR NEW.artifact_id IS DISTINCT FROM candidate.artifact_id
        OR NEW.dispatch_namespace IS DISTINCT FROM candidate.dispatch_namespace OR NEW.script_name IS DISTINCT FROM candidate.immutable_script_name
        OR NEW.provider_version_id IS DISTINCT FROM candidate.provider_tag OR NEW.published_at<candidate.staged_at
        OR route.operation_id IS DISTINCT FROM candidate.operation_id OR NEW.deployment_url IS DISTINCT FROM route.public_origin
      THEN RAISE EXCEPTION 'WFP publish receipt does not match its immutable candidate and shared gateway'
        USING ERRCODE='23514',CONSTRAINT='wfp_publish_receipts_gateway_shape_check'; END IF;
      RETURN NEW;
    EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'WFP publish receipt requires one exact immutable candidate' USING ERRCODE='23514';
    END $$;

    CREATE OR REPLACE FUNCTION require_rollback_gateway_identity() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE route shared_gateway_route_revisions%ROWTYPE; current_head bigint;
    BEGIN
      route:=require_current_shared_gateway_receipt(NEW.organization_id,NEW.project_id,NEW.environment_id,
        NEW.shared_gateway_revision,NEW.candidate_receipt_id);
      SELECT head_version INTO STRICT current_head FROM environments WHERE organization_id=NEW.organization_id
        AND project_id=NEW.project_id AND environment_id=NEW.environment_id;
      IF NEW.activated_head_version IS DISTINCT FROM current_head+1 OR route.operation_id IS DISTINCT FROM NEW.operation_id
        OR NOT EXISTS(SELECT 1 FROM deployment_revisions revision JOIN wfp_publish_receipts receipt
          ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id
          JOIN deployments rollback ON rollback.organization_id=NEW.organization_id AND rollback.project_id=NEW.project_id
            AND rollback.deployment_id=NEW.rollback_deployment_id AND rollback.operation_id=NEW.operation_id
            AND rollback.environment_id=NEW.environment_id AND rollback.kind='rollback'
            AND rollback.rollback_target_deployment_id=NEW.target_deployment_id AND rollback.rollback_target_revision_id=NEW.target_revision_id
          WHERE revision.organization_id=NEW.organization_id AND revision.project_id=NEW.project_id
            AND revision.deployment_id=NEW.target_deployment_id AND revision.revision_id=NEW.target_revision_id
            AND revision.wfp_receipt_id=NEW.wfp_receipt_id AND receipt.candidate_receipt_id=NEW.candidate_receipt_id
            AND receipt.environment_id=NEW.environment_id AND receipt.product_deployment_id=NEW.target_deployment_id)
      THEN RAISE EXCEPTION 'Rollback requires the exact target, current shared gateway and next head' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;

    CREATE FUNCTION require_shared_gateway_stage_activation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE stage runtime_secret_delivery_stages%ROWTYPE; route shared_gateway_route_revisions%ROWTYPE;
    BEGIN
      SELECT * INTO STRICT stage FROM runtime_secret_delivery_stages WHERE stage_receipt_id=NEW.stage_receipt_id;
      IF (NEW.organization_id IS NOT NULL AND NEW.organization_id<>stage.organization_id)
        OR (NEW.project_id IS NOT NULL AND NEW.project_id<>stage.project_id)
        OR (NEW.environment_id IS NOT NULL AND NEW.environment_id<>stage.environment_id)
        OR NEW.gateway_version_id IS NOT NULL OR NEW.gateway_deployment_id IS NOT NULL
      THEN RAISE EXCEPTION 'Secret activation scope differs from its stage' USING ERRCODE='23514'; END IF;
      NEW.organization_id:=stage.organization_id; NEW.project_id:=stage.project_id; NEW.environment_id:=stage.environment_id;
      route:=require_current_shared_gateway_receipt(NEW.organization_id,NEW.project_id,NEW.environment_id,
        NEW.shared_gateway_revision,stage.candidate_receipt_id);
      IF route.operation_id IS DISTINCT FROM stage.operation_id THEN
        RAISE EXCEPTION 'Secret activation requires its own operation route' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'Secret activation requires one exact stage' USING ERRCODE='23514';
    END $$;
    CREATE TRIGGER shared_gateway_stage_activation BEFORE INSERT ON runtime_secret_delivery_stage_activations
      FOR EACH ROW EXECUTE FUNCTION require_shared_gateway_stage_activation();

    CREATE FUNCTION require_shared_gateway_cleanup_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE candidate wfp_candidate_receipts%ROWTYPE; route shared_gateway_route_revisions%ROWTYPE; target_script text;
    BEGIN
      SELECT * INTO STRICT candidate FROM wfp_candidate_receipts WHERE organization_id=NEW.organization_id
        AND project_id=NEW.project_id AND candidate_receipt_id=NEW.candidate_receipt_id;
      IF (NEW.environment_id IS NOT NULL AND NEW.environment_id<>candidate.environment_id)
        OR NEW.gateway_version_id IS NOT NULL OR NEW.gateway_deployment_id IS NOT NULL
        OR NEW.outcome NOT IN ('removed','not_found') OR NEW.observed_provider_tag IS DISTINCT FROM candidate.provider_tag
      THEN RAISE EXCEPTION 'Candidate cleanup requires exact scoped shared gateway evidence' USING ERRCODE='23514'; END IF;
      NEW.environment_id:=candidate.environment_id;
      IF NEW.shared_gateway_revision IS NOT NULL THEN
        route:=require_current_shared_gateway_receipt(NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.shared_gateway_revision,NULL);
        SELECT immutable_script_name INTO STRICT target_script FROM wfp_candidate_receipts
          WHERE organization_id=route.organization_id AND project_id=route.project_id AND candidate_receipt_id=route.candidate_receipt_id;
        IF NEW.compensated_target_script_name IS DISTINCT FROM target_script OR route.candidate_receipt_id=NEW.candidate_receipt_id THEN
          RAISE EXCEPTION 'Cleanup compensation requires the exact restored candidate' USING ERRCODE='23514'; END IF;
      ELSE
        IF NEW.compensated_target_script_name IS NOT NULL OR EXISTS(
          SELECT 1 FROM shared_gateway_route_revisions current_route WHERE current_route.organization_id=NEW.organization_id
            AND current_route.project_id=NEW.project_id AND current_route.environment_id=NEW.environment_id AND current_route.active
            AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions newer WHERE newer.organization_id=current_route.organization_id
              AND newer.project_id=current_route.project_id AND newer.environment_id=current_route.environment_id AND newer.revision>current_route.revision)
        ) THEN RAISE EXCEPTION 'Removed gateway cleanup cannot leave an active route' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'Candidate cleanup requires one exact scoped candidate' USING ERRCODE='23514';
    END $$;
    CREATE TRIGGER shared_gateway_cleanup_receipt BEFORE INSERT ON wfp_candidate_cleanup_receipts
      FOR EACH ROW EXECUTE FUNCTION require_shared_gateway_cleanup_receipt();

    -- Preserve current customer heads while the per-project Cloudflare resources are retired.
    -- The original receipt columns remain untouched; only the new scoped route reference is set.
    CREATE TEMP TABLE gateway_backfill ON COMMIT DROP AS
      SELECT environment.organization_id,environment.project_id,environment.environment_id,
        environment.name AS environment_name,
        environment.active_deployment_id,environment.active_revision_id,
        receipt.wfp_receipt_id,receipt.candidate_receipt_id,receipt.deployment_url,
        candidate.operation_id,candidate.immutable_script_name,candidate.provider_tag,
        candidate.dispatch_namespace,project.handle,project.lifecycle_state,
        domain.production_domain,domain.development_domain,
        receipt.gateway_contract_version,receipt.gateway_script_name,receipt.gateway_public_origin,
        receipt.gateway_egress_policy_sha256,
        run.terminal_evidence->'runtimePolicy'->'egressAllowedOrigins' AS egress_origins,
        EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup
          WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id) AS candidate_cleaned
      FROM environments environment
      JOIN deployment_revisions revision ON revision.organization_id=environment.organization_id
        AND revision.project_id=environment.project_id
        AND revision.deployment_id=environment.active_deployment_id
        AND revision.revision_id=environment.active_revision_id
      JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id
        AND receipt.project_id=revision.project_id AND receipt.environment_id=environment.environment_id
        AND receipt.wfp_receipt_id=revision.wfp_receipt_id
      JOIN wfp_candidate_receipts candidate ON candidate.organization_id=receipt.organization_id
        AND candidate.project_id=receipt.project_id AND candidate.environment_id=receipt.environment_id
        AND candidate.candidate_receipt_id=receipt.candidate_receipt_id
      JOIN projects project ON project.project_id=environment.project_id
      JOIN cloudflare_project_domains domain ON domain.organization_id=environment.organization_id
        AND domain.project_id=environment.project_id AND domain.deleted_at IS NULL
        AND domain.handle=project.handle
      JOIN product_workflow_runs run ON run.organization_id=candidate.organization_id
        AND run.project_id=candidate.project_id AND run.environment_id=candidate.environment_id
        AND run.operation_id=candidate.operation_id AND run.state='completed'
      JOIN operations successful ON successful.organization_id=run.organization_id
        AND successful.project_id=run.project_id AND successful.operation_id=run.operation_id
        AND successful.state='succeeded'
      WHERE environment.active_deployment_id IS NOT NULL AND receipt.shared_gateway_revision IS NULL;

    DO $backfill$ BEGIN
      IF EXISTS (
        SELECT 1 FROM environments environment
        WHERE environment.active_deployment_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM gateway_backfill current_head
            WHERE current_head.organization_id=environment.organization_id
              AND current_head.project_id=environment.project_id
              AND current_head.environment_id=environment.environment_id)
      ) OR EXISTS (
        SELECT 1 FROM gateway_backfill head
        WHERE head.gateway_contract_version<>'ohmyhost.project-gateway/v7'
          OR head.gateway_script_name IS NULL
          OR head.gateway_public_origin IS DISTINCT FROM head.deployment_url
          OR head.immutable_script_name IS NULL OR head.provider_tag IS NULL
          OR head.lifecycle_state<>'active' OR head.candidate_cleaned
          OR CASE WHEN head.production_domain=head.handle||'.check.omh.st'
            THEN head.dispatch_namespace<>'ohmyho-production'
            ELSE head.dispatch_namespace NOT IN ('sandbox','ohmyho-sandbox','ohmyho-poc-private-fullstack') END
          OR head.egress_origins IS NULL OR jsonb_typeof(head.egress_origins)<>'array'
          OR jsonb_array_length(head.egress_origins)>16
          OR head.gateway_egress_policy_sha256 IS NULL
          OR head.deployment_url IS DISTINCT FROM 'https://'||CASE head.environment_name
            WHEN 'dev' THEN head.development_domain ELSE head.production_domain END
          OR head.gateway_egress_policy_sha256 IS DISTINCT FROM sha256(convert_to(
            '['||COALESCE((SELECT string_agg(to_json(value)::text,',' ORDER BY ordinal)
              FROM jsonb_array_elements_text(head.egress_origins) WITH ORDINALITY origins(value,ordinal)), '')||']',
            'UTF8'))
      ) THEN
        RAISE EXCEPTION 'Active gateway backfill needs exact publication, domain and egress evidence';
      END IF;
    END $backfill$;

    INSERT INTO shared_gateway_route_revisions(
      organization_id,project_id,environment_id,revision,operation_id,candidate_receipt_id,
      action,active,handle,public_origin,egress_allowed_origins)
    SELECT head.organization_id,head.project_id,head.environment_id,1,
      head.operation_id,head.candidate_receipt_id,'activate',true,head.handle,
      head.deployment_url,head.egress_origins
    FROM gateway_backfill head
    WHERE NOT EXISTS (SELECT 1 FROM shared_gateway_route_revisions route
      WHERE route.organization_id=head.organization_id AND route.project_id=head.project_id
        AND route.environment_id=head.environment_id);

    DO $verify_backfill$ BEGIN
      IF EXISTS (
        SELECT 1 FROM gateway_backfill head
        LEFT JOIN shared_gateway_route_revisions route
          ON route.organization_id=head.organization_id AND route.project_id=head.project_id
          AND route.environment_id=head.environment_id AND route.revision=1
          AND route.candidate_receipt_id=head.candidate_receipt_id
          AND route.operation_id=head.operation_id AND route.active
          AND route.handle=head.handle AND route.public_origin=head.deployment_url
          AND route.egress_allowed_origins=head.egress_origins
        WHERE route.revision IS NULL
      ) THEN RAISE EXCEPTION 'Active gateway backfill conflicts with an existing route'; END IF;
    END $verify_backfill$;

    ALTER TABLE wfp_publish_receipts DISABLE TRIGGER USER;
    UPDATE wfp_publish_receipts receipt SET shared_gateway_revision=1
      FROM gateway_backfill head
      WHERE receipt.organization_id=head.organization_id AND receipt.project_id=head.project_id
        AND receipt.environment_id=head.environment_id AND receipt.wfp_receipt_id=head.wfp_receipt_id;
    ALTER TABLE wfp_publish_receipts ENABLE TRIGGER USER;

    ALTER TABLE wfp_rollback_activation_receipts DISABLE TRIGGER USER;
    UPDATE wfp_rollback_activation_receipts activation SET shared_gateway_revision=1
      FROM gateway_backfill head
      WHERE activation.organization_id=head.organization_id
        AND activation.project_id=head.project_id AND activation.environment_id=head.environment_id
        AND activation.target_deployment_id=head.active_deployment_id
        AND activation.target_revision_id=head.active_revision_id
        AND activation.wfp_receipt_id=head.wfp_receipt_id
        AND activation.activated_head_version=(SELECT environment.head_version FROM environments environment
          WHERE environment.organization_id=head.organization_id AND environment.project_id=head.project_id
            AND environment.environment_id=head.environment_id);
    ALTER TABLE wfp_rollback_activation_receipts ENABLE TRIGGER USER;

    ALTER TABLE runtime_secret_delivery_stage_activations DISABLE TRIGGER USER;
    UPDATE runtime_secret_delivery_stage_activations activation
      SET organization_id=stage.organization_id,project_id=stage.project_id,
          environment_id=stage.environment_id,shared_gateway_revision=1
      FROM runtime_secret_delivery_stages stage JOIN gateway_backfill head
        ON head.organization_id=stage.organization_id AND head.project_id=stage.project_id
        AND head.environment_id=stage.environment_id
        AND head.candidate_receipt_id=stage.candidate_receipt_id
      WHERE activation.stage_receipt_id=stage.stage_receipt_id;
    ALTER TABLE runtime_secret_delivery_stage_activations ENABLE TRIGGER USER;

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
  `);
}

export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF ${tables.map((table) => `EXISTS(SELECT 1 FROM ${table} WHERE shared_gateway_revision IS NOT NULL)`).join(" OR ")}
        OR EXISTS(SELECT 1 FROM runtime_secret_delivery_stage_activations WHERE environment_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts WHERE environment_id IS NOT NULL)
      THEN RAISE EXCEPTION 'Shared gateway receipt evidence prevents a lossless downgrade'; END IF;
    END $$;
    DROP VIEW effective_wfp_publish_receipts;
    DROP TRIGGER shared_gateway_stage_activation ON runtime_secret_delivery_stage_activations;
    DROP TRIGGER shared_gateway_cleanup_receipt ON wfp_candidate_cleanup_receipts;
    DROP FUNCTION require_shared_gateway_stage_activation();
    DROP FUNCTION require_shared_gateway_cleanup_receipt();
    DO $restore$ DECLARE item record; parts text[]; BEGIN
      FOR item IN SELECT * FROM shared_gateway_receipt_migration_restore WHERE kind='function' LOOP EXECUTE item.definition; END LOOP;
      FOR item IN SELECT * FROM shared_gateway_receipt_migration_restore WHERE kind='constraint' LOOP
        parts:=string_to_array(item.name,'.');
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',parts[1],parts[2]);
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s',parts[1],parts[2],item.definition);
      END LOOP;
      FOR item IN SELECT * FROM shared_gateway_receipt_migration_restore WHERE kind='column' LOOP
        parts:=string_to_array(item.name,'.');
        IF (item.definition::jsonb->>'notNull')::boolean THEN EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET NOT NULL',parts[1],parts[2]); END IF;
        IF item.definition::jsonb->>'default' IS NOT NULL THEN EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT %s',parts[1],parts[2],item.definition::jsonb->>'default'); END IF;
      END LOOP;
      SELECT * INTO STRICT item FROM shared_gateway_receipt_migration_restore WHERE kind='view' AND name='effective_wfp_publish_receipts';
      EXECUTE 'CREATE VIEW effective_wfp_publish_receipts WITH(security_invoker=true) AS '||item.definition;
    END $restore$;
    DROP FUNCTION require_current_shared_gateway_receipt(ulid,ulid,ulid,bigint,ulid);
    ${tables.map((table) => `ALTER TABLE ${table} DROP CONSTRAINT ${table}_shared_gateway_fkey, DROP COLUMN shared_gateway_revision;`).join("\n")}
    ALTER TABLE runtime_secret_delivery_stage_activations DROP COLUMN organization_id,DROP COLUMN project_id,DROP COLUMN environment_id;
    ALTER TABLE wfp_candidate_cleanup_receipts DROP COLUMN environment_id;
    DROP TABLE shared_gateway_receipt_migration_restore;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      GRANT SELECT ON effective_wfp_publish_receipts TO control_runtime;
    END IF; END $$;
  `);
}
