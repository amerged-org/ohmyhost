export function up(pgm) {
  pgm.sql(`
    DO $migration_065_deleted_project_orphan$
    DECLARE
      orphan_operation constant ulid := '01M14J8J8871J2CKSZ7DRYQ24A';
      orphan_project constant ulid := '01M14H8DP5GVSYQYTJ6WC0ETBE';
      orphan_deployment constant ulid := '01M14J8J8871J2CKSZ7DRYQ24B';
      repair_at timestamptz;
      open_deleted bigint;
      row_count bigint;
      evidence_table record;
      evidence_count bigint;
      expected_count bigint;
      operation_failure jsonb := jsonb_build_object(
        'code','PROJECT_DELETED_BEFORE_EXECUTION',
        'message','The deployment could not start because the project was already deleted.'
      );
      orphan_terminal_evidence jsonb := jsonb_build_object(
        'schemaVersion','ohmyhost.migration-065-deleted-project-orphan/v1',
        'resolution','project_deleted_before_execution',
        'operationId',orphan_operation::text
      );
    BEGIN
      SELECT count(*) INTO open_deleted
      FROM operations operation
      INNER JOIN projects project ON project.project_id=operation.project_id
      WHERE project.lifecycle_state='deleted' AND operation.state IN ('queued','running');
      IF open_deleted=0 THEN RETURN; END IF;
      IF open_deleted<>1 OR NOT EXISTS (
        SELECT 1 FROM operations
        WHERE operation_id=orphan_operation AND project_id=orphan_project AND state='queued'
      ) THEN
        RAISE EXCEPTION 'Deleted-project queued operation is not the exact migration 065 orphan'
          USING ERRCODE='23514';
      END IF;

      FOR evidence_table IN
        SELECT table_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND column_name='operation_id'
        ORDER BY table_name
      LOOP
        EXECUTE format('SELECT count(*) FROM %I WHERE operation_id=$1',evidence_table.table_name)
          INTO evidence_count USING orphan_operation;
        expected_count:=CASE evidence_table.table_name
          WHEN 'api_idempotency_records' THEN 1
          WHEN 'audit_events' THEN 1
          WHEN 'deployments' THEN 1
          WHEN 'operation_events' THEN 1
          WHEN 'operations' THEN 1
          WHEN 'outbox_events' THEN 1
          WHEN 'product_command_intents' THEN 1
          WHEN 'product_workflow_runs' THEN 1
          ELSE 0
        END;
        IF evidence_count<>expected_count THEN
          RAISE EXCEPTION 'Deleted-project queued operation is not the exact migration 065 orphan'
            USING ERRCODE='23514';
        END IF;
      END LOOP;

      SELECT GREATEST(
        clock_timestamp(),operation.updated_at,deployment.updated_at,run.updated_at,
        outbox.acknowledged_at
      ) INTO repair_at
      FROM operations operation
      INNER JOIN projects project ON project.project_id=operation.project_id
      INNER JOIN deployments deployment
        ON deployment.organization_id=operation.organization_id
       AND deployment.project_id=operation.project_id
       AND deployment.operation_id=operation.operation_id
      INNER JOIN product_command_intents intent
        ON intent.organization_id=operation.organization_id
       AND intent.project_id=operation.project_id
       AND intent.operation_id=operation.operation_id
      INNER JOIN outbox_events outbox
        ON outbox.organization_id=operation.organization_id
       AND outbox.project_id=operation.project_id
       AND outbox.operation_id=operation.operation_id
      INNER JOIN product_workflow_runs run
        ON run.organization_id=operation.organization_id
       AND run.project_id=operation.project_id
       AND run.operation_id=operation.operation_id
       AND run.event_id=outbox.event_id
      WHERE operation.operation_id=orphan_operation
        AND operation.project_id=orphan_project
        AND operation.state='queued' AND operation.failure IS NULL
        AND operation.result_deployment_id IS NULL AND operation.result_url IS NULL
        AND operation.result_artifact_sha256 IS NULL
        AND project.lifecycle_state='deleted' AND project.lifecycle_version=3
        AND deployment.deployment_id=orphan_deployment AND deployment.kind='deploy'
        AND deployment.status='queued' AND deployment.active_revision_id IS NULL
        AND deployment.active_version=0
        AND intent.event_type='DeploymentRequestedV1'
        AND intent.deployment_id=orphan_deployment
        AND intent.plan_id IS NOT NULL AND intent.source_connection_id IS NOT NULL
        AND outbox.event_type='DeploymentRequestedV1'
        AND outbox.acknowledged_at IS NOT NULL
        AND outbox.reconciliation_required_at IS NULL AND outbox.last_error_code IS NULL
        AND run.event_type='DeploymentRequestedV1' AND run.state='queued'
        AND run.terminal_evidence IS NULL AND run.intermediate_evidence IS NULL
        AND run.reconciliation_code IS NULL
        AND run.active_reconciliation_attempt_id IS NULL AND run.active_replay_attempt_id IS NULL
        AND (SELECT count(*) FROM operation_events event
             WHERE event.operation_id=orphan_operation AND event.revision=0
               AND event.event_type='OperationQueued' AND event.idempotency_key IS NULL
               AND event.payload='{}'::jsonb)=1
        AND NOT EXISTS (SELECT 1 FROM operation_events
                        WHERE event_id IN (orphan_operation,orphan_deployment));
      IF repair_at IS NULL THEN
        RAISE EXCEPTION 'Deleted-project queued operation is not the exact migration 065 orphan'
          USING ERRCODE='23514';
      END IF;

      INSERT INTO operation_events(
        organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,
        payload,occurred_at)
      SELECT operation.organization_id,orphan_operation,operation.operation_id,
             operation.project_id,1,'OperationStarted','migration-065:orphan:start',
             '{}'::jsonb,repair_at
      FROM operations operation WHERE operation.operation_id=orphan_operation
      UNION ALL
      SELECT operation.organization_id,orphan_deployment,operation.operation_id,
             operation.project_id,2,'OperationFailed','migration-065:orphan:failed',
             jsonb_build_object('failure',operation_failure),repair_at
      FROM operations operation WHERE operation.operation_id=orphan_operation;

      UPDATE deployments SET status='failed',updated_at=repair_at
      WHERE deployment_id=orphan_deployment AND operation_id=orphan_operation
        AND status='queued' AND active_revision_id IS NULL AND active_version=0;
      GET DIAGNOSTICS row_count=ROW_COUNT;
      IF row_count<>1 THEN RAISE EXCEPTION 'Migration 065 orphan deployment changed'; END IF;

      UPDATE operations SET state='failed',failure=operation_failure,updated_at=repair_at
      WHERE operation_id=orphan_operation AND project_id=orphan_project AND state='queued';
      GET DIAGNOSTICS row_count=ROW_COUNT;
      IF row_count<>1 THEN RAISE EXCEPTION 'Migration 065 orphan operation changed'; END IF;

      UPDATE product_workflow_runs
      SET state='completed',terminal_evidence=orphan_terminal_evidence,
          active_reconciliation_attempt_id=NULL,active_replay_attempt_id=NULL,
          updated_at=repair_at,completed_at=repair_at
      WHERE operation_id=orphan_operation AND state='queued'
        AND active_reconciliation_attempt_id IS NULL AND active_replay_attempt_id IS NULL;
      GET DIAGNOSTICS row_count=ROW_COUNT;
      IF row_count<>1 THEN RAISE EXCEPTION 'Migration 065 orphan Workflow changed'; END IF;

      IF EXISTS (
        SELECT 1 FROM operations operation
        INNER JOIN projects project ON project.project_id=operation.project_id
        WHERE project.lifecycle_state='deleted' AND operation.state IN ('queued','running')
      ) THEN
        RAISE EXCEPTION 'Migration 065 left an open operation for a deleted project';
      END IF;
    END
    $migration_065_deleted_project_orphan$;

    CREATE TABLE cloudflare_project_authorization_states (
      authorization_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      principal_id text NOT NULL,
      zone_name text NOT NULL,
      state_sha256 bytea NOT NULL UNIQUE,
      idempotency_key_sha256 bytea NOT NULL,
      request_sha256 bytea NOT NULL,
      issued_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      CONSTRAINT cloudflare_project_authorization_states_scope_key
        UNIQUE (organization_id,project_id,authorization_id),
      CONSTRAINT cloudflare_project_authorization_states_idempotency_key
        UNIQUE (organization_id,project_id,principal_id,idempotency_key_sha256),
      CONSTRAINT cloudflare_project_authorization_states_project_fkey
        FOREIGN KEY (organization_id,project_id)
        REFERENCES project_ownerships(organization_id,project_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT cloudflare_project_authorization_states_shape_check CHECK (
        principal_id=btrim(principal_id) AND length(principal_id) BETWEEN 1 AND 256
        AND zone_name='aixyte.com'
        AND octet_length(state_sha256)=32
        AND octet_length(idempotency_key_sha256)=32 AND octet_length(request_sha256)=32
        AND expires_at=issued_at+interval '10 minutes'
        AND (consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at))
      )
    );
    CREATE INDEX cloudflare_project_authorization_states_expiry_idx
      ON cloudflare_project_authorization_states(expires_at,authorization_id)
      WHERE consumed_at IS NULL;

    CREATE FUNCTION guard_cloudflare_project_authorization_state_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
        OR NEW.zone_name IS DISTINCT FROM OLD.zone_name
        OR NEW.state_sha256 IS DISTINCT FROM OLD.state_sha256
        OR NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256
        OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
        OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR OLD.consumed_at IS NOT NULL
        OR NEW.consumed_at IS NULL THEN
        RAISE EXCEPTION 'Cloudflare project authorization state is one-time'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER cloudflare_project_authorization_states_one_time
      BEFORE UPDATE ON cloudflare_project_authorization_states
      FOR EACH ROW EXECUTE FUNCTION guard_cloudflare_project_authorization_state_change();

    CREATE TABLE cloudflare_project_dns_grants (
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      authorization_id ulid NOT NULL UNIQUE,
      principal_id text NOT NULL,
      zone_id text NOT NULL,
      zone_name text NOT NULL,
      account_id text NOT NULL,
      scopes text[] NOT NULL,
      access_ciphertext bytea,
      access_nonce bytea,
      refresh_ciphertext bytea,
      refresh_nonce bytea,
      key_version integer NOT NULL,
      access_expires_at timestamptz NOT NULL,
      status text NOT NULL,
      connected_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      revoked_at timestamptz,
      CONSTRAINT cloudflare_project_dns_grants_pkey PRIMARY KEY (organization_id,project_id),
      CONSTRAINT cloudflare_project_dns_grants_scope_authorization_key
        UNIQUE (organization_id,project_id,authorization_id),
      CONSTRAINT cloudflare_project_dns_grants_project_fkey
        FOREIGN KEY (organization_id,project_id)
        REFERENCES project_ownerships(organization_id,project_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT cloudflare_project_dns_grants_authorization_fkey
        FOREIGN KEY (organization_id,project_id,authorization_id)
        REFERENCES cloudflare_project_authorization_states(organization_id,project_id,authorization_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT cloudflare_project_dns_grants_shape_check CHECK (
        principal_id=btrim(principal_id) AND length(principal_id) BETWEEN 1 AND 256
        AND zone_id~'^[a-f0-9]{32}$' AND zone_name='aixyte.com'
        AND account_id=btrim(account_id) AND length(account_id) BETWEEN 1 AND 128
        AND scopes=ARRAY['dns.write','zone.read']::text[]
        AND key_version>0 AND access_expires_at>connected_at AND updated_at>=connected_at
        AND ((status='active'
              AND access_expires_at>updated_at
              AND access_ciphertext IS NOT NULL
              AND octet_length(access_ciphertext) BETWEEN 17 AND 65552
              AND access_nonce IS NOT NULL AND octet_length(access_nonce)=12
              AND refresh_ciphertext IS NOT NULL
              AND octet_length(refresh_ciphertext) BETWEEN 17 AND 65552
              AND refresh_nonce IS NOT NULL AND octet_length(refresh_nonce)=12
              AND access_nonce<>refresh_nonce
              AND revoked_at IS NULL)
          OR (status='revoked'
              AND access_ciphertext IS NULL AND access_nonce IS NULL
              AND refresh_ciphertext IS NULL AND refresh_nonce IS NULL
              AND revoked_at IS NOT NULL AND revoked_at>=connected_at
              AND updated_at=revoked_at))
      )
    );

    CREATE FUNCTION guard_cloudflare_project_dns_grant_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
        OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
        OR NEW.zone_id IS DISTINCT FROM OLD.zone_id
        OR NEW.zone_name IS DISTINCT FROM OLD.zone_name
        OR NEW.account_id IS DISTINCT FROM OLD.account_id
        OR NEW.scopes IS DISTINCT FROM OLD.scopes
        OR NEW.connected_at IS DISTINCT FROM OLD.connected_at
        OR OLD.status='revoked'
        OR (OLD.status='active' AND NEW.status NOT IN ('active','revoked')) THEN
        RAISE EXCEPTION 'Cloudflare project DNS grant identity is immutable'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER cloudflare_project_dns_grants_identity_guard
      BEFORE UPDATE ON cloudflare_project_dns_grants
      FOR EACH ROW EXECUTE FUNCTION guard_cloudflare_project_dns_grant_change();

    CREATE TABLE cloudflare_project_oauth_revocations (
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      operation_id ulid NOT NULL UNIQUE,
      authorization_id ulid NOT NULL,
      refresh_token_sha256 bytea NOT NULL,
      state text NOT NULL,
      provider_started_at timestamptz NOT NULL,
      readback_started_at timestamptz,
      confirmed_at timestamptz,
      CONSTRAINT cloudflare_project_oauth_revocations_pkey
        PRIMARY KEY (organization_id,project_id),
      CONSTRAINT cloudflare_project_oauth_revocations_grant_fkey
        FOREIGN KEY (organization_id,project_id,authorization_id)
        REFERENCES cloudflare_project_dns_grants(organization_id,project_id,authorization_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT cloudflare_project_oauth_revocations_operation_fkey
        FOREIGN KEY (organization_id,project_id,operation_id)
        REFERENCES operations(organization_id,project_id,operation_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT cloudflare_project_oauth_revocations_shape_check CHECK (
        octet_length(refresh_token_sha256)=32
        AND ((state='revoke_started' AND readback_started_at IS NULL AND confirmed_at IS NULL)
          OR (state='readback_started' AND readback_started_at IS NOT NULL
              AND readback_started_at>=provider_started_at AND confirmed_at IS NULL)
          OR (state='confirmed' AND confirmed_at IS NOT NULL
              AND confirmed_at>=provider_started_at
              AND (readback_started_at IS NULL OR confirmed_at>=readback_started_at)))
      )
    );

    CREATE FUNCTION guard_cloudflare_project_oauth_revocation_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
        OR OLD.state='confirmed'
        OR NOT (
          (OLD.state='revoke_started' AND NEW.state='readback_started'
            AND NEW.refresh_token_sha256=OLD.refresh_token_sha256
            AND NEW.provider_started_at=OLD.provider_started_at)
          OR (OLD.state='readback_started' AND NEW.state='revoke_started'
            AND NEW.provider_started_at>=OLD.readback_started_at)
          OR (OLD.state IN ('revoke_started','readback_started') AND NEW.state='confirmed'
            AND NEW.refresh_token_sha256=OLD.refresh_token_sha256
            AND NEW.provider_started_at=OLD.provider_started_at
            AND NEW.readback_started_at IS NOT DISTINCT FROM OLD.readback_started_at)
        ) THEN
        RAISE EXCEPTION 'Cloudflare OAuth revocation transition is invalid'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER cloudflare_project_oauth_revocations_transition_guard
      BEFORE UPDATE OR DELETE ON cloudflare_project_oauth_revocations
      FOR EACH ROW EXECUTE FUNCTION guard_cloudflare_project_oauth_revocation_change();

    CREATE TABLE cloudflare_project_domains (
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      operation_id ulid NOT NULL,
      handle text NOT NULL,
      zone_name text NOT NULL,
      production_domain text NOT NULL,
      development_domain text NOT NULL,
      mail_domain text NOT NULL,
      configured_by_principal_id text NOT NULL,
      idempotency_key_sha256 bytea NOT NULL,
      request_sha256 bytea NOT NULL,
      configured_at timestamptz NOT NULL,
      deleted_at timestamptz,
      CONSTRAINT cloudflare_project_domains_pkey PRIMARY KEY (organization_id,project_id),
      CONSTRAINT cloudflare_project_domains_project_fkey
        FOREIGN KEY (organization_id,project_id)
        REFERENCES project_ownerships(organization_id,project_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT cloudflare_project_domains_operation_fkey
        FOREIGN KEY (organization_id,project_id,operation_id)
        REFERENCES operations(organization_id,project_id,operation_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT cloudflare_project_domains_operation_key UNIQUE (operation_id),
      CONSTRAINT cloudflare_project_domains_idempotency_key
        UNIQUE (organization_id,project_id,idempotency_key_sha256),
      CONSTRAINT cloudflare_project_domains_production_key UNIQUE (production_domain),
      CONSTRAINT cloudflare_project_domains_development_key UNIQUE (development_domain),
      CONSTRAINT cloudflare_project_domains_mail_key UNIQUE (mail_domain),
      CONSTRAINT cloudflare_project_domains_shape_check CHECK (
        handle~'^[a-z]+-[a-z]+-[a-z]+$' AND length(handle)<=59
        AND zone_name='aixyte.com'
        AND production_domain=handle||'.poc.aixyte.com'
        AND development_domain='dev-'||handle||'.poc.aixyte.com'
        AND mail_domain=handle||'.mail.aixyte.com'
        AND configured_by_principal_id=btrim(configured_by_principal_id)
        AND length(configured_by_principal_id) BETWEEN 1 AND 256
        AND octet_length(idempotency_key_sha256)=32 AND octet_length(request_sha256)=32
        AND (deleted_at IS NULL OR deleted_at>=configured_at)
      )
    );

    CREATE FUNCTION guard_cloudflare_project_domain_change() RETURNS trigger
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
        OR OLD.deleted_at IS NOT NULL
        OR NEW.deleted_at IS NULL THEN
        RAISE EXCEPTION 'Cloudflare project domain desired state is immutable'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER cloudflare_project_domains_identity_guard
      BEFORE UPDATE ON cloudflare_project_domains
      FOR EACH ROW EXECUTE FUNCTION guard_cloudflare_project_domain_change();

    CREATE TABLE cloudflare_project_domain_receipts (
      receipt_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      kind text NOT NULL,
      environment_name text,
      provider_resource_id text,
      zone_id text,
      zone_name text,
      dns_type text,
      dns_name text,
      dns_content text,
      dns_ttl integer,
      dns_proxied boolean,
      dns_comment text,
      hostname text,
      hostname_status text,
      provider_created_at timestamptz,
      ownership_verification jsonb,
      ownership_verification_http jsonb,
      verification_errors text[],
      custom_hostname_id text,
      ssl_status text,
      ssl_type text,
      ssl_method text,
      ssl_bundle_method text,
      ssl_certificate_authority text,
      ssl_validation_records jsonb,
      route_pattern text,
      route_script text,
      observed_at timestamptz NOT NULL,
      CONSTRAINT cloudflare_project_domain_receipts_resource_key
        UNIQUE (organization_id,project_id,kind,provider_resource_id,observed_at),
      CONSTRAINT cloudflare_project_domain_receipts_domains_fkey
        FOREIGN KEY (organization_id,project_id)
        REFERENCES cloudflare_project_domains(organization_id,project_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT cloudflare_project_domain_receipts_common_check CHECK (
        kind IN ('dns_record','custom_hostname','ssl','worker_route')
        AND ((kind='ssl' AND (provider_resource_id IS NULL OR
              (provider_resource_id=btrim(provider_resource_id)
               AND length(provider_resource_id) BETWEEN 1 AND 64)))
          OR (kind<>'ssl' AND provider_resource_id IS NOT NULL
              AND provider_resource_id=btrim(provider_resource_id)
              AND length(provider_resource_id) BETWEEN 1 AND 64))
        AND (environment_name IS NULL OR environment_name IN ('dev','prod'))
        AND (zone_id IS NULL OR zone_id~'^[a-f0-9]{32}$')
        AND (zone_name IS NULL OR zone_name='aixyte.com')
      ),
      CONSTRAINT cloudflare_project_domain_receipts_kind_check CHECK (
        (kind='dns_record'
          AND environment_name IS NULL
          AND provider_resource_id IS NOT NULL
          AND provider_resource_id~'^[a-f0-9]{32}$'
          AND zone_id IS NOT NULL AND zone_name='aixyte.com'
          AND dns_type IN ('CNAME','NS','TXT')
          AND dns_name IS NOT NULL AND dns_name~'^[a-z0-9_]([a-z0-9._-]{0,251}[a-z0-9])?$'
          AND (dns_name='aixyte.com' OR dns_name LIKE '%.aixyte.com')
          AND dns_content IS NOT NULL AND length(dns_content) BETWEEN 1 AND 2048
          AND dns_ttl BETWEEN 60 AND 86400 AND dns_proxied=false
          AND dns_comment~'^ohmyhost:[0-7][0-9A-HJKMNP-TV-Z]{25}:[a-z0-9-]{1,32}:v1$'
          AND hostname IS NULL AND hostname_status IS NULL AND provider_created_at IS NULL
          AND ownership_verification IS NULL AND ownership_verification_http IS NULL
          AND verification_errors IS NULL AND custom_hostname_id IS NULL
          AND ssl_status IS NULL AND ssl_type IS NULL AND ssl_method IS NULL
          AND ssl_bundle_method IS NULL AND ssl_certificate_authority IS NULL
          AND ssl_validation_records IS NULL AND route_pattern IS NULL AND route_script IS NULL)
        OR (kind='custom_hostname'
          AND environment_name IN ('dev','prod')
          AND provider_resource_id IS NOT NULL
          AND provider_resource_id~'^[a-f0-9]{32}$'
          AND zone_id IS NULL AND zone_name IS NULL
          AND dns_type IS NULL AND dns_name IS NULL AND dns_content IS NULL
          AND dns_ttl IS NULL AND dns_proxied IS NULL AND dns_comment IS NULL
          AND hostname IS NOT NULL
          AND hostname_status IN ('active','pending','active_redeploying','moved','pending_deletion',
            'deleted','pending_blocked','pending_migration','pending_provisioned','test_pending',
            'test_active','test_active_apex','test_blocked','test_failed','provisioned','blocked')
          AND (ownership_verification IS NULL OR
            (jsonb_typeof(ownership_verification)='object'
             AND ownership_verification ?& ARRAY['type','name','value']
             AND ownership_verification-ARRAY['type','name','value']='{}'::jsonb
             AND ownership_verification->>'type'='txt'))
          AND (ownership_verification_http IS NULL OR
            (jsonb_typeof(ownership_verification_http)='object'
             AND ownership_verification_http ?& ARRAY['httpUrl','httpBody']
             AND ownership_verification_http-ARRAY['httpUrl','httpBody']='{}'::jsonb))
          AND verification_errors IS NOT NULL
          AND custom_hostname_id IS NULL AND ssl_status IS NULL AND ssl_type IS NULL
          AND ssl_method IS NULL AND ssl_bundle_method IS NULL
          AND ssl_certificate_authority IS NULL AND ssl_validation_records IS NULL
          AND route_pattern IS NULL AND route_script IS NULL)
        OR (kind='ssl'
          AND environment_name IN ('dev','prod')
          AND (provider_resource_id IS NULL OR provider_resource_id~'^[a-f0-9-]{36}$')
          AND zone_id IS NULL AND zone_name IS NULL
          AND dns_type IS NULL AND dns_name IS NULL AND dns_content IS NULL
          AND dns_ttl IS NULL AND dns_proxied IS NULL AND dns_comment IS NULL
          AND hostname IS NOT NULL AND hostname_status IS NULL AND provider_created_at IS NULL
          AND ownership_verification IS NULL AND ownership_verification_http IS NULL
          AND verification_errors IS NULL AND custom_hostname_id~'^[a-f0-9]{32}$'
          AND (ssl_status IS NULL OR ssl_status IN ('initializing','pending_validation','deleted','pending_issuance',
            'pending_deployment','pending_deletion','pending_expiration','expired','active',
            'initializing_timed_out','validation_timed_out','issuance_timed_out',
            'deployment_timed_out','deletion_timed_out','pending_cleanup','staging_deployment',
            'staging_active','deactivating','inactive','backup_issued','holding_deployment'))
          AND (ssl_type IS NULL OR ssl_type='dv')
          AND (ssl_method IS NULL OR ssl_method IN ('http','txt','email'))
          AND (ssl_bundle_method IS NULL OR ssl_bundle_method IN ('ubiquitous','optimal','force'))
          AND (ssl_certificate_authority IS NULL OR
            (ssl_certificate_authority=btrim(ssl_certificate_authority)
             AND length(ssl_certificate_authority) BETWEEN 1 AND 64))
          AND jsonb_typeof(ssl_validation_records)='array'
          AND route_pattern IS NULL AND route_script IS NULL)
        OR (kind='worker_route'
          AND environment_name IN ('dev','prod')
          AND provider_resource_id IS NOT NULL
          AND provider_resource_id~'^[a-f0-9]{32}$'
          AND zone_id IS NOT NULL AND zone_name IS NULL
          AND dns_type IS NULL AND dns_name IS NULL AND dns_content IS NULL
          AND dns_ttl IS NULL AND dns_proxied IS NULL AND dns_comment IS NULL
          AND hostname IS NULL AND hostname_status IS NULL AND provider_created_at IS NULL
          AND ownership_verification IS NULL AND ownership_verification_http IS NULL
          AND verification_errors IS NULL AND custom_hostname_id IS NULL
          AND ssl_status IS NULL AND ssl_type IS NULL AND ssl_method IS NULL
          AND ssl_bundle_method IS NULL AND ssl_certificate_authority IS NULL
          AND ssl_validation_records IS NULL
          AND route_pattern IS NOT NULL AND length(route_pattern) BETWEEN 3 AND 512
          AND route_script~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
      )
    );
    CREATE INDEX cloudflare_project_domain_receipts_project_idx
      ON cloudflare_project_domain_receipts(organization_id,project_id,kind,observed_at,receipt_id);
    CREATE FUNCTION require_cloudflare_project_domain_receipt_identity() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      project_handle text;
      expected_hostname text;
      expected_zone_id text;
      expected_script text;
    BEGIN
      IF NEW.kind<>'worker_route' THEN RETURN NEW; END IF;
      SELECT domain.handle,
             CASE NEW.environment_name
               WHEN 'dev' THEN domain.development_domain
               WHEN 'prod' THEN domain.production_domain
             END,
             dns_grant.zone_id
        INTO STRICT project_handle,expected_hostname,expected_zone_id
      FROM cloudflare_project_domains domain
      INNER JOIN cloudflare_project_dns_grants dns_grant
        ON dns_grant.organization_id=domain.organization_id
       AND dns_grant.project_id=domain.project_id
      WHERE domain.organization_id=NEW.organization_id AND domain.project_id=NEW.project_id
        AND domain.deleted_at IS NULL AND dns_grant.status='active'
        AND dns_grant.access_expires_at>NEW.observed_at;
      expected_script:=CASE NEW.environment_name
        WHEN 'dev' THEN 'dev-'||project_handle
        WHEN 'prod' THEN project_handle
      END;
      IF NEW.zone_id<>expected_zone_id
        OR NEW.route_pattern<>expected_hostname||'/*'
        OR NEW.route_script<>expected_script THEN
        RAISE EXCEPTION 'Cloudflare Worker route receipt does not match its project gateway'
          USING ERRCODE='23514', CONSTRAINT='cloudflare_project_domain_receipts_kind_check';
      END IF;
      RETURN NEW;
    EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'Cloudflare Worker route receipt requires one exact active project domain'
        USING ERRCODE='23514', CONSTRAINT='cloudflare_project_domain_receipts_kind_check';
    END $$;
    CREATE TRIGGER cloudflare_project_domain_receipts_exact_identity
      BEFORE INSERT ON cloudflare_project_domain_receipts
      FOR EACH ROW EXECUTE FUNCTION require_cloudflare_project_domain_receipt_identity();
    CREATE TRIGGER cloudflare_project_domain_receipts_append_only
      BEFORE UPDATE OR DELETE ON cloudflare_project_domain_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM dev_access_tickets) THEN
        RAISE EXCEPTION 'legacy workers.dev dev-access tickets must be removed through project cleanup before the custom-origin cutover'
          USING ERRCODE='23514', CONSTRAINT='dev_access_tickets_shape_check';
      END IF;
    END $$;
    ALTER TABLE dev_access_tickets
      DROP CONSTRAINT dev_access_tickets_shape_check,
      ADD CONSTRAINT dev_access_tickets_shape_check CHECK (
        environment_name='dev'
        AND handle~'^[a-z]+-[a-z]+-[a-z]+$' AND length(handle)<=59
        AND public_origin='https://dev-'||handle||'.poc.aixyte.com'
        AND issued_to_principal_id=btrim(issued_to_principal_id)
        AND length(issued_to_principal_id) BETWEEN 1 AND 256
        AND octet_length(token_sha256)=32
        AND dev_access_epoch>=1
        AND expires_at=issued_at+interval '10 minutes'
        AND (consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at))
        AND (revoked_at IS NULL OR (revoked_at>=issued_at AND consumed_at IS NULL))
        AND NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL));
    CREATE FUNCTION require_custom_dev_access_ticket_origin() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM cloudflare_project_domains domain
      WHERE domain.organization_id=NEW.organization_id AND domain.project_id=NEW.project_id
        AND domain.deleted_at IS NULL AND domain.handle=NEW.handle
        AND NEW.public_origin='https://'||domain.development_domain;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'dev access ticket requires the active custom development origin'
          USING ERRCODE='23514', CONSTRAINT='dev_access_tickets_shape_check';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER dev_access_tickets_custom_origin
      BEFORE INSERT ON dev_access_tickets
      FOR EACH ROW EXECUTE FUNCTION require_custom_dev_access_ticket_origin();

    ALTER TABLE wfp_publish_receipts ADD COLUMN gateway_internal_origin text;
    ALTER TABLE wfp_publish_receipts
      DROP CONSTRAINT wfp_publish_receipts_gateway_shape_check,
      ADD CONSTRAINT wfp_publish_receipts_gateway_shape_check CHECK (
        gateway_script_name IS NOT NULL
        AND gateway_target_script_name IS NOT NULL
        AND gateway_workers_dev_subdomain IS NOT NULL
        AND gateway_provider_tag IS NOT NULL
        AND gateway_module_sha256 IS NOT NULL
        AND gateway_egress_policy_sha256 IS NOT NULL
        AND gateway_public_origin IS NOT NULL
        AND gateway_compatibility_date IS NOT NULL
        AND gateway_observed_at IS NOT NULL
        AND gateway_target_script_name=script_name
        AND script_name~'^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$'
        AND gateway_workers_dev_subdomain~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
        AND octet_length(gateway_provider_tag)=32
        AND octet_length(gateway_module_sha256)=32
        AND octet_length(gateway_egress_policy_sha256)=32
        AND (gateway_dev_access_service IS NULL OR gateway_dev_access_service~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
        AND (gateway_dev_access_entrypoint IS NULL OR gateway_dev_access_entrypoint='DevAccessService')
        AND (gateway_dev_access_key_id IS NULL OR octet_length(gateway_dev_access_key_id)=32)
        AND (gateway_dev_access_public_key_sha256 IS NULL OR octet_length(gateway_dev_access_public_key_sha256)=32)
        AND deployment_url=gateway_public_origin
        AND gateway_compatibility_date>='2024-09-23'::date
        AND gateway_version_id=btrim(gateway_version_id) AND length(gateway_version_id) BETWEEN 1 AND 255
        AND gateway_deployment_id=btrim(gateway_deployment_id) AND length(gateway_deployment_id) BETWEEN 1 AND 255
        AND ((gateway_contract_version='ohmyhost.project-gateway/v6'
              AND gateway_internal_origin IS NULL
              AND gateway_public_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev')
          OR (gateway_contract_version='ohmyhost.project-gateway/v7'
              AND gateway_internal_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev'
              AND gateway_public_origin='https://'||gateway_script_name||'.poc.aixyte.com'))
      );

    CREATE OR REPLACE FUNCTION require_project_gateway_receipt_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      project_handle text;
      environment_name text;
      expected_public_origin text;
      candidate wfp_candidate_receipts%ROWTYPE;
    BEGIN
      SELECT project.handle,environment.name,
             CASE environment.name
               WHEN 'prod' THEN domain.production_domain
               WHEN 'dev' THEN domain.development_domain
             END
        INTO STRICT project_handle,environment_name,expected_public_origin
      FROM projects project
      INNER JOIN environments environment
        ON environment.project_id=project.project_id
       AND environment.environment_id=NEW.environment_id
      INNER JOIN cloudflare_project_domains domain
        ON domain.organization_id=NEW.organization_id AND domain.project_id=project.project_id
       AND domain.deleted_at IS NULL
      WHERE project.project_id=NEW.project_id;

      SELECT * INTO STRICT candidate FROM wfp_candidate_receipts
      WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
        AND candidate_receipt_id=NEW.candidate_receipt_id;

      IF EXISTS (SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup
                 WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)
        OR NEW.gateway_contract_version<>'ohmyhost.project-gateway/v7'
        OR NEW.product_deployment_id<>candidate.product_deployment_id
        OR NEW.environment_id<>candidate.environment_id
        OR NEW.artifact_id<>candidate.artifact_id
        OR NEW.dispatch_namespace<>candidate.dispatch_namespace
        OR NEW.script_name<>candidate.immutable_script_name
        OR NEW.provider_version_id<>candidate.provider_tag
        OR NEW.published_at<candidate.staged_at
        OR NEW.gateway_script_name<>(CASE environment_name
             WHEN 'prod' THEN project_handle
             WHEN 'dev' THEN 'dev-'||project_handle
           END)
        OR NEW.gateway_target_script_name<>candidate.immutable_script_name
        OR NEW.gateway_internal_origin<>'https://'||NEW.gateway_script_name||'.'||NEW.gateway_workers_dev_subdomain||'.workers.dev'
        OR NEW.gateway_public_origin<>'https://'||expected_public_origin
        OR NEW.gateway_internal_origin=NEW.gateway_public_origin
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
        RAISE EXCEPTION 'WFP publish receipt does not match its immutable candidate and gateway receipt'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
      END IF;
      RETURN NEW;
    EXCEPTION
      WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'WFP publish receipt requires one exact immutable candidate'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
    END;
    $$;
  `);
}

export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM operations operation
        WHERE operation.operation_id='01M14J8J8871J2CKSZ7DRYQ24A'
          AND operation.failure->>'code'='PROJECT_DELETED_BEFORE_EXECUTION'
      ) OR EXISTS (
        SELECT 1 FROM product_workflow_runs run
        WHERE run.operation_id='01M14J8J8871J2CKSZ7DRYQ24A'
          AND run.terminal_evidence->>'schemaVersion'=
            'ohmyhost.migration-065-deleted-project-orphan/v1'
      ) THEN
        RAISE EXCEPTION 'Migration 065 deleted-project repair evidence prevents a lossless downgrade'
          USING ERRCODE='23514';
      END IF;
    END $$;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM cloudflare_project_authorization_states)
        OR EXISTS (SELECT 1 FROM cloudflare_project_dns_grants)
        OR EXISTS (SELECT 1 FROM cloudflare_project_oauth_revocations)
        OR EXISTS (SELECT 1 FROM cloudflare_project_domains)
        OR EXISTS (SELECT 1 FROM cloudflare_project_domain_receipts)
        OR EXISTS (SELECT 1 FROM wfp_publish_receipts
                   WHERE gateway_contract_version='ohmyhost.project-gateway/v7') THEN
        RAISE EXCEPTION 'Cloudflare project-domain evidence prevents a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
    END $$;
    ALTER TABLE wfp_publish_receipts
      DROP CONSTRAINT wfp_publish_receipts_gateway_shape_check,
      ADD CONSTRAINT wfp_publish_receipts_gateway_shape_check CHECK (
        gateway_contract_version='ohmyhost.project-gateway/v6'
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
        AND script_name~'^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$'
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
        AND gateway_version_id=btrim(gateway_version_id) AND length(gateway_version_id) BETWEEN 1 AND 255
        AND gateway_deployment_id=btrim(gateway_deployment_id) AND length(gateway_deployment_id) BETWEEN 1 AND 255
      );

    CREATE OR REPLACE FUNCTION require_project_gateway_receipt_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      project_handle text;
      environment_name text;
      candidate wfp_candidate_receipts%ROWTYPE;
    BEGIN
      SELECT project.handle,environment.name INTO STRICT project_handle,environment_name
      FROM projects project
      INNER JOIN environments environment
        ON environment.project_id=project.project_id
       AND environment.environment_id=NEW.environment_id
      WHERE project.project_id=NEW.project_id;

      SELECT * INTO STRICT candidate FROM wfp_candidate_receipts
      WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
        AND candidate_receipt_id=NEW.candidate_receipt_id;

      IF EXISTS (SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup
                 WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)
        OR NEW.gateway_contract_version<>'ohmyhost.project-gateway/v6'
        OR NEW.product_deployment_id<>candidate.product_deployment_id
        OR NEW.environment_id<>candidate.environment_id
        OR NEW.artifact_id<>candidate.artifact_id
        OR NEW.dispatch_namespace<>candidate.dispatch_namespace
        OR NEW.script_name<>candidate.immutable_script_name
        OR NEW.provider_version_id<>candidate.provider_tag
        OR NEW.published_at<candidate.staged_at
        OR NEW.gateway_script_name<>(CASE environment_name
             WHEN 'prod' THEN project_handle
             WHEN 'dev' THEN 'dev-'||project_handle
           END)
        OR NEW.gateway_target_script_name<>candidate.immutable_script_name
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
        RAISE EXCEPTION 'WFP publish receipt does not match its immutable candidate and gateway receipt'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
      END IF;
      RETURN NEW;
    EXCEPTION
      WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'WFP publish receipt requires one exact immutable candidate'
          USING ERRCODE='23514', CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
    END;
    $$;

    ALTER TABLE wfp_publish_receipts DROP COLUMN gateway_internal_origin;

    DROP TRIGGER dev_access_tickets_custom_origin ON dev_access_tickets;
    DROP FUNCTION require_custom_dev_access_ticket_origin();
    ALTER TABLE dev_access_tickets
      DROP CONSTRAINT dev_access_tickets_shape_check,
      ADD CONSTRAINT dev_access_tickets_shape_check CHECK (
        environment_name='dev'
        AND handle~'^[a-z]+-[a-z]+-[a-z]+$' AND length(handle)<=59
        AND public_origin='https://dev-'||handle||'.your-omh-account.workers.dev'
        AND issued_to_principal_id=btrim(issued_to_principal_id)
        AND length(issued_to_principal_id) BETWEEN 1 AND 256
        AND octet_length(token_sha256)=32
        AND dev_access_epoch>=1
        AND expires_at=issued_at+interval '10 minutes'
        AND (consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at))
        AND (revoked_at IS NULL OR (revoked_at>=issued_at AND consumed_at IS NULL))
        AND NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL));

    DROP TRIGGER cloudflare_project_domain_receipts_append_only
      ON cloudflare_project_domain_receipts;
    DROP TRIGGER cloudflare_project_domain_receipts_exact_identity
      ON cloudflare_project_domain_receipts;
    DROP FUNCTION require_cloudflare_project_domain_receipt_identity();
    DROP TABLE cloudflare_project_domain_receipts;
    DROP TRIGGER cloudflare_project_domains_identity_guard ON cloudflare_project_domains;
    DROP TABLE cloudflare_project_domains;
    DROP FUNCTION guard_cloudflare_project_domain_change();
    DROP TRIGGER cloudflare_project_oauth_revocations_transition_guard
      ON cloudflare_project_oauth_revocations;
    DROP TABLE cloudflare_project_oauth_revocations;
    DROP FUNCTION guard_cloudflare_project_oauth_revocation_change();
    DROP TRIGGER cloudflare_project_dns_grants_identity_guard ON cloudflare_project_dns_grants;
    DROP TABLE cloudflare_project_dns_grants;
    DROP FUNCTION guard_cloudflare_project_dns_grant_change();
    DROP TRIGGER cloudflare_project_authorization_states_one_time
      ON cloudflare_project_authorization_states;
    DROP TABLE cloudflare_project_authorization_states;
    DROP FUNCTION guard_cloudflare_project_authorization_state_change();
  `);
}
