const DOMAIN = "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$";
const OWNED_ZONES = "zone_name = ANY (ARRAY['aixyte.com'::text, 'omh.st'::text])";
const CUSTOMER_ZONE = `zone_name ~ '${DOMAIN}'::text`;
const WEB_SHAPE = `handle~'^[a-z]+-[a-z]+-[a-z]+$' AND length(handle)<=59
  AND ((zone_name='aixyte.com' AND production_domain=handle||'.poc.aixyte.com'
        AND development_domain='dev-'||handle||'.poc.aixyte.com')
    OR (zone_name='omh.st' AND production_domain IN (handle||'.dev.check.omh.st',handle||'.check.omh.st')
        AND development_domain='dev-'||production_domain))
  AND configured_by_principal_id=btrim(configured_by_principal_id)
  AND length(configured_by_principal_id) BETWEEN 1 AND 256
  AND octet_length(idempotency_key_sha256)=32 AND octet_length(request_sha256)=32
  AND (deleted_at IS NULL OR deleted_at>=configured_at)`;
const OLD_MAIL_SHAPE = `(mail_domain=handle||'.mail.aixyte.com' OR
  (zone_name='omh.st' AND production_domain=handle||'.check.omh.st' AND mail_domain='p-'||handle||'.mail.aixyte.com'))`;

export function up(pgm) {
  pgm.sql(`
    ALTER TABLE cloudflare_project_domains ALTER COLUMN mail_domain DROP NOT NULL;
    COMMENT ON COLUMN cloudflare_project_domains.mail_domain IS
      'Historical generated value only. Current readers use project_mail_domains; new Free configurations leave this NULL.';
    ALTER TABLE cloudflare_project_domains DROP CONSTRAINT cloudflare_project_domains_shape_check;
    ALTER TABLE cloudflare_project_domains ADD CONSTRAINT cloudflare_project_domains_shape_check
      CHECK (${WEB_SHAPE} AND (mail_domain IS NULL OR mail_domain~'${DOMAIN}'));
    CREATE OR REPLACE FUNCTION require_owned_project_domain_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.zone_name<>'omh.st' OR NEW.mail_domain IS NOT NULL THEN
        RAISE EXCEPTION 'new project domains require the owned platform zone without an implicit sender' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;`);
  replaceReceiptZones(pgm, OWNED_ZONES, CUSTOMER_ZONE);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM cloudflare_project_domains WHERE mail_domain IS NULL)
      OR EXISTS (SELECT 1 FROM cloudflare_project_domain_receipts
                 WHERE zone_name IS NOT NULL AND zone_name NOT IN ('aixyte.com','omh.st')) THEN
      RAISE EXCEPTION 'Explicit customer mail prevents a lossless downgrade';
    END IF;
  END $$;
  ALTER TABLE cloudflare_project_domains DROP CONSTRAINT cloudflare_project_domains_shape_check;
  ALTER TABLE cloudflare_project_domains ADD CONSTRAINT cloudflare_project_domains_shape_check
    CHECK (${WEB_SHAPE} AND ${OLD_MAIL_SHAPE});
  ALTER TABLE cloudflare_project_domains ALTER COLUMN mail_domain SET NOT NULL;
  COMMENT ON COLUMN cloudflare_project_domains.mail_domain IS NULL;
  CREATE OR REPLACE FUNCTION require_owned_project_domain_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.zone_name<>'omh.st' OR NEW.mail_domain IS DISTINCT FROM
      ((CASE WHEN NEW.production_domain=NEW.handle||'.check.omh.st' THEN 'p-' ELSE '' END)||NEW.handle||'.mail.aixyte.com') THEN
      RAISE EXCEPTION 'new project domains require the owned platform zone and mail namespace' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END $$;`);
  replaceReceiptZones(pgm, CUSTOMER_ZONE, OWNED_ZONES);
}

function replaceReceiptZones(pgm, before, after) {
  pgm.sql(`DO $$ DECLARE item record; revised text; BEGIN
    FOR item IN SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='cloudflare_project_domain_receipts'::regclass AND conname IN
        ('cloudflare_project_domain_receipts_common_check','cloudflare_project_domain_receipts_kind_check')
    LOOP
      revised:=replace(item.definition,${quote(before)},${quote(after)});
      IF revised=item.definition THEN RAISE EXCEPTION 'Unexpected Cloudflare receipt zone constraint'; END IF;
      EXECUTE format('ALTER TABLE cloudflare_project_domain_receipts DROP CONSTRAINT %I',item.conname);
      EXECUTE format('ALTER TABLE cloudflare_project_domain_receipts ADD CONSTRAINT %I %s',item.conname,revised);
    END LOOP;
  END $$;`);
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
