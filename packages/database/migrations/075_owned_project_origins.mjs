const DOMAIN_CHECK = `handle~'^[a-z]+-[a-z]+-[a-z]+$' AND length(handle)<=59
  AND zone_name='aixyte.com'
  AND production_domain=handle||'.poc.aixyte.com'
  AND development_domain='dev-'||handle||'.poc.aixyte.com'
  AND mail_domain=handle||'.mail.aixyte.com'
  AND configured_by_principal_id=btrim(configured_by_principal_id)
  AND length(configured_by_principal_id) BETWEEN 1 AND 256
  AND octet_length(idempotency_key_sha256)=32 AND octet_length(request_sha256)=32
  AND (deleted_at IS NULL OR deleted_at>=configured_at)`;

const TICKET_CHECK = `environment_name='dev'
  AND handle~'^[a-z]+-[a-z]+-[a-z]+$' AND length(handle)<=59
  AND public_origin='https://dev-'||handle||'.poc.aixyte.com'
  AND issued_to_principal_id=btrim(issued_to_principal_id)
  AND length(issued_to_principal_id) BETWEEN 1 AND 256
  AND octet_length(token_sha256)=32 AND dev_access_epoch>=1
  AND expires_at=issued_at+interval '10 minutes'
  AND (consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at))
  AND (revoked_at IS NULL OR (revoked_at>=issued_at AND consumed_at IS NULL))
  AND NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)`;

const RECEIPT_COMMON_CHECK = `kind IN ('dns_record','custom_hostname','ssl','worker_route')
  AND ((kind='ssl' AND (provider_resource_id IS NULL OR
        (provider_resource_id=btrim(provider_resource_id) AND length(provider_resource_id) BETWEEN 1 AND 64)))
    OR (kind<>'ssl' AND provider_resource_id IS NOT NULL
        AND provider_resource_id=btrim(provider_resource_id) AND length(provider_resource_id) BETWEEN 1 AND 64))
  AND (environment_name IS NULL OR environment_name IN ('dev','prod'))
  AND (zone_id IS NULL OR zone_id~'^[a-f0-9]{32}$')
  AND (zone_name IS NULL OR zone_name='aixyte.com')`;

const RECEIPT_KIND_CHECK = `(kind='dns_record'
  AND environment_name IS NULL AND provider_resource_id IS NOT NULL
  AND provider_resource_id~'^[a-f0-9]{32}$'
  AND zone_id IS NOT NULL AND zone_name='aixyte.com'
  AND dns_type IN ('CNAME','NS','TXT')
  AND dns_name IS NOT NULL AND dns_name~'^[a-z0-9_]([a-z0-9._-]{0,251}[a-z0-9])?$'
  AND (dns_name='aixyte.com' OR dns_name LIKE '%.aixyte.com')
  AND dns_content IS NOT NULL AND length(dns_content) BETWEEN 1 AND 2048
  AND ((dns_type='CNAME' AND dns_ttl=1 AND dns_proxied=true)
    OR (dns_ttl BETWEEN 60 AND 86400 AND dns_proxied=false))
  AND dns_comment~'^ohmyhost:[0-7][0-9A-HJKMNP-TV-Z]{25}:[a-z0-9-]{1,32}:v1$'
  AND hostname IS NULL AND hostname_status IS NULL AND provider_created_at IS NULL
  AND ownership_verification IS NULL AND ownership_verification_http IS NULL
  AND verification_errors IS NULL AND custom_hostname_id IS NULL
  AND ssl_status IS NULL AND ssl_type IS NULL AND ssl_method IS NULL
  AND ssl_bundle_method IS NULL AND ssl_certificate_authority IS NULL
  AND ssl_validation_records IS NULL AND route_pattern IS NULL AND route_script IS NULL)
OR (kind='custom_hostname'
  AND environment_name IN ('dev','prod') AND provider_resource_id IS NOT NULL
  AND provider_resource_id~'^[a-f0-9]{32}$' AND zone_id IS NULL AND zone_name IS NULL
  AND dns_type IS NULL AND dns_name IS NULL AND dns_content IS NULL
  AND dns_ttl IS NULL AND dns_proxied IS NULL AND dns_comment IS NULL AND hostname IS NOT NULL
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
  AND verification_errors IS NOT NULL AND custom_hostname_id IS NULL
  AND ssl_status IS NULL AND ssl_type IS NULL AND ssl_method IS NULL
  AND ssl_bundle_method IS NULL AND ssl_certificate_authority IS NULL
  AND ssl_validation_records IS NULL AND route_pattern IS NULL AND route_script IS NULL)
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
    (ssl_certificate_authority=btrim(ssl_certificate_authority) AND length(ssl_certificate_authority) BETWEEN 1 AND 64))
  AND jsonb_typeof(ssl_validation_records)='array' AND route_pattern IS NULL AND route_script IS NULL)
OR (kind='worker_route'
  AND environment_name IN ('dev','prod') AND provider_resource_id IS NOT NULL
  AND provider_resource_id~'^[a-f0-9]{32}$' AND zone_id IS NOT NULL AND zone_name IS NULL
  AND dns_type IS NULL AND dns_name IS NULL AND dns_content IS NULL
  AND dns_ttl IS NULL AND dns_proxied IS NULL AND dns_comment IS NULL
  AND hostname IS NULL AND hostname_status IS NULL AND provider_created_at IS NULL
  AND ownership_verification IS NULL AND ownership_verification_http IS NULL
  AND verification_errors IS NULL AND custom_hostname_id IS NULL
  AND ssl_status IS NULL AND ssl_type IS NULL AND ssl_method IS NULL
  AND ssl_bundle_method IS NULL AND ssl_certificate_authority IS NULL AND ssl_validation_records IS NULL
  AND route_pattern IS NOT NULL AND length(route_pattern) BETWEEN 3 AND 512
  AND route_script~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')`;

const WFP_CHECK = `gateway_script_name IS NOT NULL AND gateway_target_script_name IS NOT NULL
  AND gateway_workers_dev_subdomain IS NOT NULL AND gateway_provider_tag IS NOT NULL
  AND gateway_module_sha256 IS NOT NULL AND gateway_egress_policy_sha256 IS NOT NULL
  AND gateway_public_origin IS NOT NULL AND gateway_compatibility_date IS NOT NULL
  AND gateway_observed_at IS NOT NULL AND gateway_target_script_name=script_name
  AND script_name~'^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$'
  AND gateway_workers_dev_subdomain~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
  AND octet_length(gateway_provider_tag)=32 AND octet_length(gateway_module_sha256)=32
  AND octet_length(gateway_egress_policy_sha256)=32
  AND (gateway_dev_access_service IS NULL OR gateway_dev_access_service~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
  AND (gateway_dev_access_entrypoint IS NULL OR gateway_dev_access_entrypoint='DevAccessService')
  AND (gateway_dev_access_key_id IS NULL OR octet_length(gateway_dev_access_key_id)=32)
  AND (gateway_dev_access_public_key_sha256 IS NULL OR octet_length(gateway_dev_access_public_key_sha256)=32)
  AND deployment_url=gateway_public_origin AND gateway_compatibility_date>='2024-09-23'::date
  AND gateway_version_id=btrim(gateway_version_id) AND length(gateway_version_id) BETWEEN 1 AND 255
  AND gateway_deployment_id=btrim(gateway_deployment_id) AND length(gateway_deployment_id) BETWEEN 1 AND 255
  AND ((gateway_contract_version='ohmyhost.project-gateway/v6' AND gateway_internal_origin IS NULL
        AND gateway_public_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev')
    OR (gateway_contract_version='ohmyhost.project-gateway/v7'
        AND gateway_internal_origin='https://'||gateway_script_name||'.'||gateway_workers_dev_subdomain||'.workers.dev'
        AND gateway_public_origin='https://'||gateway_script_name||'.poc.aixyte.com'))`;

const REQUIRE_PUBLICATION = `CREATE OR REPLACE FUNCTION require_project_gateway_receipt_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE project_handle text; environment_name text; expected_public_origin text; production_domain text;
  candidate wfp_candidate_receipts%ROWTYPE;
BEGIN
  SELECT project.handle,environment.name,
    CASE environment.name WHEN 'prod' THEN domain.production_domain WHEN 'dev' THEN domain.development_domain END,
    domain.production_domain INTO STRICT project_handle,environment_name,expected_public_origin,production_domain
  FROM projects project JOIN environments environment ON environment.project_id=project.project_id
    AND environment.environment_id=NEW.environment_id
  JOIN cloudflare_project_domains domain ON domain.organization_id=NEW.organization_id
    AND domain.project_id=project.project_id AND domain.deleted_at IS NULL
  WHERE project.project_id=NEW.project_id;
  SELECT * INTO STRICT candidate FROM wfp_candidate_receipts
    WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
      AND candidate_receipt_id=NEW.candidate_receipt_id;
  IF EXISTS (SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)
    OR NEW.gateway_contract_version<>'ohmyhost.project-gateway/v7'
    OR NEW.product_deployment_id<>candidate.product_deployment_id OR NEW.environment_id<>candidate.environment_id
    OR NEW.artifact_id<>candidate.artifact_id OR NEW.dispatch_namespace<>candidate.dispatch_namespace
    OR NEW.script_name<>candidate.immutable_script_name OR NEW.provider_version_id<>candidate.provider_tag
    OR NEW.published_at<candidate.staged_at
    OR NEW.gateway_script_name IS DISTINCT FROM (CASE environment_name WHEN 'prod' THEN project_handle ELSE 'dev-'||project_handle END)
    OR NEW.gateway_target_script_name<>candidate.immutable_script_name
    OR NEW.gateway_internal_origin<>'https://'||NEW.gateway_script_name||'.'||NEW.gateway_workers_dev_subdomain||'.workers.dev'
    OR NEW.gateway_public_origin<>'https://'||expected_public_origin
    OR NEW.gateway_internal_origin=NEW.gateway_public_origin OR NEW.deployment_url<>NEW.gateway_public_origin
    OR (environment_name='dev' AND (NEW.gateway_dev_access_service IS NULL
      OR NEW.gateway_dev_access_entrypoint IS DISTINCT FROM 'DevAccessService'
      OR NEW.gateway_dev_access_key_id IS NULL OR NEW.gateway_dev_access_public_key_sha256 IS NULL
      OR NEW.gateway_dev_access_key_id<>NEW.gateway_dev_access_public_key_sha256))
    OR (environment_name='prod' AND (NEW.gateway_dev_access_service IS NOT NULL
      OR NEW.gateway_dev_access_entrypoint IS NOT NULL OR NEW.gateway_dev_access_key_id IS NOT NULL
      OR NEW.gateway_dev_access_public_key_sha256 IS NOT NULL)) THEN
    RAISE EXCEPTION 'WFP publish receipt does not match its immutable candidate and gateway receipt'
      USING ERRCODE='23514',CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
  RAISE EXCEPTION 'WFP publish receipt requires one exact immutable candidate'
    USING ERRCODE='23514',CONSTRAINT='wfp_publish_receipts_gateway_shape_check';
END $$;`;

const REQUIRE_ROLLBACK = `CREATE OR REPLACE FUNCTION require_rollback_gateway_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_origin text; expected_script text; environment_name text; current_head bigint;
BEGIN
  SELECT 'https://'||CASE environment.name WHEN 'dev' THEN domain.development_domain ELSE domain.production_domain END,
    CASE environment.name WHEN 'dev' THEN 'dev-'||domain.handle ELSE domain.handle END,
    environment.name,environment.head_version INTO expected_origin,expected_script,environment_name,current_head
  FROM environments environment JOIN cloudflare_project_domains domain
    ON domain.organization_id=environment.organization_id AND domain.project_id=environment.project_id AND domain.deleted_at IS NULL
  WHERE environment.organization_id=NEW.organization_id AND environment.project_id=NEW.project_id AND environment.environment_id=NEW.environment_id;
  IF NOT FOUND OR NEW.activated_head_version IS NULL OR NEW.activated_head_version<>current_head+1
    OR NEW.gateway_public_origin IS DISTINCT FROM expected_origin OR NEW.gateway_script_name IS DISTINCT FROM expected_script
    OR (environment_name='dev' AND NEW.gateway_dev_access_service IS NULL)
    OR (environment_name='prod' AND NEW.gateway_dev_access_service IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback requires complete current gateway identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;`;

const REQUIRE_ROUTE = `CREATE OR REPLACE FUNCTION require_cloudflare_project_domain_receipt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_hostname text; expected_script text;
BEGIN
  IF NEW.kind<>'worker_route' THEN RETURN NEW; END IF;
  SELECT CASE NEW.environment_name WHEN 'dev' THEN domain.development_domain ELSE domain.production_domain END,
    CASE NEW.environment_name WHEN 'dev' THEN 'dev-'||domain.handle ELSE domain.handle END
    INTO STRICT expected_hostname,expected_script FROM cloudflare_project_domains domain
    WHERE domain.organization_id=NEW.organization_id AND domain.project_id=NEW.project_id AND domain.deleted_at IS NULL;
  IF NEW.route_pattern<>expected_hostname||'/*' OR NEW.route_script IS DISTINCT FROM expected_script
    OR NOT EXISTS (SELECT 1 FROM cloudflare_project_domain_receipts dns
      WHERE dns.organization_id=NEW.organization_id AND dns.project_id=NEW.project_id AND dns.kind='dns_record'
        AND dns.zone_id=NEW.zone_id AND dns.dns_type='CNAME' AND dns.dns_name=expected_hostname) THEN
    RAISE EXCEPTION 'Cloudflare Worker route receipt does not match its project gateway'
      USING ERRCODE='23514',CONSTRAINT='cloudflare_project_domain_receipts_kind_check';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
  RAISE EXCEPTION 'Cloudflare Worker route receipt requires one exact active project domain'
    USING ERRCODE='23514',CONSTRAINT='cloudflare_project_domain_receipts_kind_check';
END $$;`;

function replaceCheck(pgm, table, name, check) {
  pgm.dropConstraint(table, name);
  pgm.addConstraint(table, name, { check });
}

export function up(pgm) {
  replaceCheck(
    pgm,
    "cloudflare_project_domains",
    "cloudflare_project_domains_shape_check",
    DOMAIN_CHECK.replace(
      "zone_name='aixyte.com'\n  AND production_domain=handle||'.poc.aixyte.com'\n  AND development_domain='dev-'||handle||'.poc.aixyte.com'",
      "((zone_name='aixyte.com' AND production_domain=handle||'.poc.aixyte.com' AND development_domain='dev-'||handle||'.poc.aixyte.com') OR (zone_name='omh.st' AND production_domain IN (handle||'.dev.check.omh.st',handle||'.check.omh.st') AND development_domain='dev-'||production_domain))",
    ).replace(
      "mail_domain=handle||'.mail.aixyte.com'",
      "(mail_domain=handle||'.mail.aixyte.com' OR (zone_name='omh.st' AND production_domain=handle||'.check.omh.st' AND mail_domain='p-'||handle||'.mail.aixyte.com'))",
    ),
  );
  pgm.sql(`DO $$ DECLARE platform text; BEGIN
    IF EXISTS (SELECT 1 FROM cloudflare_project_domains WHERE deleted_at IS NULL AND zone_name='aixyte.com') THEN
      platform:=current_setting('ohmyhost.migration075_platform',true);
      IF platform IS NULL OR platform NOT IN ('development','production') THEN
        RAISE EXCEPTION 'migration075 requires explicit development or production platform selection';
      END IF;
      IF EXISTS (SELECT 1 FROM product_provider_mutation_claims)
        OR EXISTS (SELECT 1 FROM operations WHERE state IN ('queued','running')) THEN
        RAISE EXCEPTION 'owned-origin cutover requires drained operations and claims';
      END IF;
      ALTER TABLE cloudflare_project_domains DISABLE TRIGGER cloudflare_project_domains_identity_guard;
      UPDATE cloudflare_project_domains SET zone_name='omh.st',
        production_domain=handle||CASE platform WHEN 'development' THEN '.dev.check.omh.st' ELSE '.check.omh.st' END,
        development_domain='dev-'||handle||CASE platform WHEN 'development' THEN '.dev.check.omh.st' ELSE '.check.omh.st' END
        WHERE deleted_at IS NULL AND zone_name='aixyte.com';
      ALTER TABLE cloudflare_project_domains ENABLE TRIGGER cloudflare_project_domains_identity_guard;
    END IF;
  END $$;
  CREATE FUNCTION require_owned_project_domain_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.zone_name<>'omh.st' OR NEW.mail_domain IS DISTINCT FROM
      ((CASE WHEN NEW.production_domain=NEW.handle||'.check.omh.st' THEN 'p-' ELSE '' END)||NEW.handle||'.mail.aixyte.com')
    THEN RAISE EXCEPTION 'new project domains require the owned platform zone and mail namespace' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER cloudflare_project_domains_owned_insert BEFORE INSERT ON cloudflare_project_domains
    FOR EACH ROW EXECUTE FUNCTION require_owned_project_domain_insert();
  CREATE FUNCTION project_gateway_script_name(project_id ulid,handle text,environment_name text,production_domain text)
    RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
      SELECT CASE WHEN $3 IN ('dev','prod') THEN CASE
        WHEN $4=$2||'.check.omh.st' THEN 'g-p-'||lower($1::text)||'-'||$3
        WHEN $4 IN ($2||'.dev.check.omh.st',$2||'.poc.aixyte.com')
          THEN CASE $3 WHEN 'dev' THEN 'dev-'||$2 ELSE $2 END
      END END
    $$;`);
  replaceCheck(
    pgm,
    "cloudflare_project_domain_receipts",
    "cloudflare_project_domain_receipts_common_check",
    RECEIPT_COMMON_CHECK.replace("zone_name='aixyte.com'", "zone_name IN ('aixyte.com','omh.st')"),
  );
  replaceCheck(
    pgm,
    "cloudflare_project_domain_receipts",
    "cloudflare_project_domain_receipts_kind_check",
    RECEIPT_KIND_CHECK.replace(
      "zone_name='aixyte.com'",
      "zone_name IN ('aixyte.com','omh.st')",
    ).replace(
      "(dns_name='aixyte.com' OR dns_name LIKE '%.aixyte.com')",
      "(dns_name=zone_name OR right(dns_name,length(zone_name)+1)='.'||zone_name)",
    ),
  );
  replaceCheck(
    pgm,
    "dev_access_tickets",
    "dev_access_tickets_shape_check",
    TICKET_CHECK.replace(
      "public_origin='https://dev-'||handle||'.poc.aixyte.com'",
      "public_origin IN ('https://dev-'||handle||'.poc.aixyte.com','https://dev-'||handle||'.dev.check.omh.st','https://dev-'||handle||'.check.omh.st')",
    ),
  );
  replaceCheck(
    pgm,
    "wfp_publish_receipts",
    "wfp_publish_receipts_gateway_shape_check",
    WFP_CHECK.replace(
      "gateway_public_origin='https://'||gateway_script_name||'.poc.aixyte.com'",
      () =>
        "(gateway_public_origin='https://'||gateway_script_name||'.poc.aixyte.com' OR gateway_public_origin~'^https://(dev-)?[a-z]+-[a-z]+-[a-z]+[.](dev[.])?check[.]omh[.]st$')",
    ),
  );
  pgm.sql(
    REQUIRE_PUBLICATION.replace(
      "CASE environment_name WHEN 'prod' THEN project_handle ELSE 'dev-'||project_handle END",
      "project_gateway_script_name(NEW.project_id,project_handle,environment_name,production_domain)",
    ).replace(
      "OR NEW.gateway_contract_version<>",
      "OR (CASE WHEN production_domain=project_handle||'.check.omh.st' THEN NEW.dispatch_namespace<>'ohmyho-production' ELSE NEW.dispatch_namespace NOT IN ('sandbox','ohmyho-sandbox','ohmyho-poc-private-fullstack') END)\n    OR NEW.gateway_contract_version<>",
    ),
  );
  pgm.sql(
    REQUIRE_ROLLBACK.replace(
      "CASE environment.name WHEN 'dev' THEN 'dev-'||domain.handle ELSE domain.handle END",
      "project_gateway_script_name(NEW.project_id,domain.handle,environment.name,domain.production_domain)",
    ).replace(
      "OR NEW.gateway_public_origin IS DISTINCT FROM expected_origin",
      `OR NOT EXISTS (
      SELECT 1 FROM wfp_candidate_receipts candidate JOIN cloudflare_project_domains domain
        ON domain.organization_id=candidate.organization_id AND domain.project_id=candidate.project_id
        AND domain.deleted_at IS NULL
      WHERE candidate.candidate_receipt_id=NEW.candidate_receipt_id
        AND candidate.organization_id=NEW.organization_id AND candidate.project_id=NEW.project_id
        AND candidate.environment_id=NEW.environment_id
        AND CASE WHEN domain.production_domain=domain.handle||'.check.omh.st'
          THEN candidate.dispatch_namespace='ohmyho-production'
          ELSE candidate.dispatch_namespace IN ('sandbox','ohmyho-sandbox','ohmyho-poc-private-fullstack') END)
    OR NEW.gateway_public_origin IS DISTINCT FROM expected_origin`,
    ),
  );
  pgm.sql(
    REQUIRE_ROUTE.replace(
      "CASE NEW.environment_name WHEN 'dev' THEN 'dev-'||domain.handle ELSE domain.handle END",
      "project_gateway_script_name(NEW.project_id,domain.handle,NEW.environment_name,domain.production_domain)",
    ),
  );
  replaceCheck(
    pgm,
    "paid_project_domains",
    "paid_project_domains_gateway_script_name_check",
    "gateway_script_name~'^[a-z]+-[a-z]+-[a-z]+$' OR gateway_script_name='g-p-'||lower(project_id::text)||'-prod'",
  );
  pgm.addConstraint("paid_project_domains", "paid_project_domains_external_host_check", {
    check: "hostname NOT IN ('omh.st','ohmyho.st') AND hostname!~'[.](omh[.]st|ohmyho[.]st)$'",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM cloudflare_project_domains WHERE zone_name='omh.st')
      OR EXISTS (SELECT 1 FROM cloudflare_project_domain_receipts WHERE zone_name='omh.st')
      OR EXISTS (SELECT 1 FROM wfp_publish_receipts WHERE gateway_public_origin LIKE '%.omh.st')
      OR EXISTS (SELECT 1 FROM wfp_rollback_activation_receipts WHERE gateway_public_origin LIKE '%.omh.st')
      OR EXISTS (SELECT 1 FROM dev_access_tickets WHERE public_origin LIKE '%.omh.st')
      OR EXISTS (SELECT 1 FROM paid_project_domains WHERE gateway_script_name LIKE 'g-p-%') THEN
      RAISE EXCEPTION 'Owned project origins prevent a lossless downgrade' USING ERRCODE='23514';
    END IF;
    END $$;
    DROP TRIGGER cloudflare_project_domains_owned_insert ON cloudflare_project_domains;
    DROP FUNCTION require_owned_project_domain_insert();`);
  replaceCheck(
    pgm,
    "cloudflare_project_domains",
    "cloudflare_project_domains_shape_check",
    DOMAIN_CHECK,
  );
  replaceCheck(
    pgm,
    "cloudflare_project_domain_receipts",
    "cloudflare_project_domain_receipts_common_check",
    RECEIPT_COMMON_CHECK,
  );
  replaceCheck(
    pgm,
    "cloudflare_project_domain_receipts",
    "cloudflare_project_domain_receipts_kind_check",
    RECEIPT_KIND_CHECK,
  );
  replaceCheck(pgm, "dev_access_tickets", "dev_access_tickets_shape_check", TICKET_CHECK);
  replaceCheck(pgm, "wfp_publish_receipts", "wfp_publish_receipts_gateway_shape_check", WFP_CHECK);
  pgm.sql(REQUIRE_PUBLICATION);
  pgm.sql(REQUIRE_ROLLBACK);
  pgm.sql(REQUIRE_ROUTE);
  pgm.sql("DROP FUNCTION project_gateway_script_name(ulid,text,text,text);");
  pgm.dropConstraint("paid_project_domains", "paid_project_domains_external_host_check");
  replaceCheck(
    pgm,
    "paid_project_domains",
    "paid_project_domains_gateway_script_name_check",
    "gateway_script_name~'^[a-z]+-[a-z]+-[a-z]+$'",
  );
}
