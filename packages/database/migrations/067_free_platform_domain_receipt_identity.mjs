const FREE_PLATFORM_RECEIPT_IDENTITY = `
  CREATE OR REPLACE FUNCTION require_cloudflare_project_domain_receipt_identity() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    project_handle text;
    expected_hostname text;
    expected_script text;
  BEGIN
    IF NEW.kind<>'worker_route' THEN RETURN NEW; END IF;
    SELECT domain.handle,
           CASE NEW.environment_name
             WHEN 'dev' THEN domain.development_domain
             WHEN 'prod' THEN domain.production_domain
           END
      INTO STRICT project_handle,expected_hostname
    FROM cloudflare_project_domains domain
    WHERE domain.organization_id=NEW.organization_id AND domain.project_id=NEW.project_id
      AND domain.deleted_at IS NULL;
    expected_script:=CASE NEW.environment_name
      WHEN 'dev' THEN 'dev-'||project_handle
      WHEN 'prod' THEN project_handle
    END;
    IF NEW.route_pattern<>expected_hostname||'/*'
      OR NEW.route_script<>expected_script
      OR NOT EXISTS (
        SELECT 1 FROM cloudflare_project_domain_receipts dns
        WHERE dns.organization_id=NEW.organization_id AND dns.project_id=NEW.project_id
          AND dns.kind='dns_record' AND dns.zone_id=NEW.zone_id
          AND dns.dns_type='CNAME' AND dns.dns_name=expected_hostname
      ) THEN
      RAISE EXCEPTION 'Cloudflare Worker route receipt does not match its project gateway'
        USING ERRCODE='23514', CONSTRAINT='cloudflare_project_domain_receipts_kind_check';
    END IF;
    RETURN NEW;
  EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'Cloudflare Worker route receipt requires one exact active project domain'
      USING ERRCODE='23514', CONSTRAINT='cloudflare_project_domain_receipts_kind_check';
  END $$;
`;

const LEGACY_OAUTH_RECEIPT_IDENTITY = `
  CREATE OR REPLACE FUNCTION require_cloudflare_project_domain_receipt_identity() RETURNS trigger
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
`;

export function up(pgm) {
  pgm.sql(FREE_PLATFORM_RECEIPT_IDENTITY);
}

export function down(pgm) {
  pgm.sql(LEGACY_OAUTH_RECEIPT_IDENTITY);
}
