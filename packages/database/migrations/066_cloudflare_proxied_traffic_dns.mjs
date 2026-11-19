const RECEIPT_KIND_CHECK = `(kind='dns_record'
  AND environment_name IS NULL
  AND provider_resource_id IS NOT NULL
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
  AND route_script~'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')`;

const LEGACY_RECEIPT_KIND_CHECK = RECEIPT_KIND_CHECK.replace(
  "((dns_type='CNAME' AND dns_ttl=1 AND dns_proxied=true)\n    OR (dns_ttl BETWEEN 60 AND 86400 AND dns_proxied=false))",
  "dns_ttl BETWEEN 60 AND 86400 AND dns_proxied=false",
);

export function up(pgm) {
  pgm.dropConstraint(
    "cloudflare_project_domain_receipts",
    "cloudflare_project_domain_receipts_kind_check",
  );
  pgm.addConstraint(
    "cloudflare_project_domain_receipts",
    "cloudflare_project_domain_receipts_kind_check",
    { check: RECEIPT_KIND_CHECK },
  );
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM cloudflare_project_domain_receipts
      WHERE kind='dns_record' AND (dns_proxied<>false OR dns_ttl NOT BETWEEN 60 AND 86400))
    THEN RAISE EXCEPTION 'Proxied Cloudflare traffic DNS evidence prevents a lossless downgrade'
      USING ERRCODE='23514'; END IF;
  END $$`);
  pgm.dropConstraint(
    "cloudflare_project_domain_receipts",
    "cloudflare_project_domain_receipts_kind_check",
  );
  pgm.addConstraint(
    "cloudflare_project_domain_receipts",
    "cloudflare_project_domain_receipts_kind_check",
    { check: LEGACY_RECEIPT_KIND_CHECK },
  );
}
