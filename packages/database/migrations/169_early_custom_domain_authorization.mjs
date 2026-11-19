// A declared hostname can bind customer DNS consent before Prod exists. Its provider lifetime
// starts only when the original apply is resumed against a healthy Prod deployment.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE paid_project_domains ADD COLUMN provisioning_started_at timestamptz;
    UPDATE paid_project_domains SET provisioning_started_at=created_at;
    CREATE FUNCTION fill_paid_domain_provisioning_started_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.state IN ('pending','active') THEN
        IF NEW.provisioning_started_at IS NULL THEN
          IF TG_OP='UPDATE' THEN
            IF OLD.state='awaiting_deployment' THEN
              RAISE EXCEPTION 'Deferred domain activation requires an explicit provider start'
                USING ERRCODE='23514';
            END IF;
          END IF;
          NEW.provisioning_started_at:=NEW.created_at;
        ELSIF TG_OP='UPDATE' THEN
          IF OLD.state='deleted' AND NEW.created_at IS DISTINCT FROM OLD.created_at
            AND NEW.provisioning_started_at IS NOT DISTINCT FROM OLD.provisioning_started_at THEN
            NEW.provisioning_started_at:=NEW.created_at;
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER fill_paid_domain_provisioning_started_at BEFORE INSERT OR UPDATE ON paid_project_domains
      FOR EACH ROW EXECUTE FUNCTION fill_paid_domain_provisioning_started_at();
    ALTER TABLE paid_project_domains ALTER COLUMN gateway_script_name DROP NOT NULL;
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_state_check;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_state_check
      CHECK (state IN ('awaiting_deployment','pending','active','deleting','deleted'));
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_provisioning_shape CHECK (
      (state='awaiting_deployment' AND gateway_script_name IS NULL AND provisioning_started_at IS NULL)
      OR (state IN ('pending','active') AND gateway_script_name IS NOT NULL
        AND provisioning_started_at IS NOT NULL)
      OR (state IN ('deleting','deleted') AND
        ((gateway_script_name IS NULL AND provisioning_started_at IS NULL
          AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL)
        OR (gateway_script_name IS NOT NULL AND provisioning_started_at IS NOT NULL)))) ;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_provisioning_time CHECK (
      provisioning_started_at IS NULL OR provisioning_started_at>=created_at);
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_state_shape;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_state_shape CHECK (
      (state IN ('awaiting_deployment','pending') AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL
        AND delete_idempotency_sha256 IS NULL AND delete_request_sha256 IS NULL
        AND deleted_at IS NULL)
      OR (state='active' AND jsonb_typeof(custom_hostname_receipt)='object'
        AND jsonb_typeof(worker_route_receipt)='object' AND deleted_at IS NULL)
      OR (state IN ('deleting','deleted')
        AND ((jsonb_typeof(custom_hostname_receipt)='object' AND jsonb_typeof(worker_route_receipt)='object')
          OR (custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL))
        AND octet_length(delete_idempotency_sha256)=32 AND octet_length(delete_request_sha256)=32
        AND (deleted_at IS NULL)=(state='deleting')))`);
  pgm.sql(`ALTER TABLE project_mail_domains
  ADD COLUMN declaration_generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE cloudflare_project_authorization_states
  ADD COLUMN declaration_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT cloudflare_authorization_declaration_snapshot_array
    CHECK (jsonb_typeof(declaration_snapshot)='array');

CREATE FUNCTION cloudflare_authorization_declaration_is_current(
  p_organization_id ulid,p_project_id ulid,p_zone_name text,p_snapshot jsonb
) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM paid_project_domains declared
      WHERE declared.organization_id=p_organization_id AND declared.project_id=p_project_id
        AND declared.state IN ('awaiting_deployment','pending','active')
        AND (declared.hostname=p_zone_name
          OR right(declared.hostname,length(p_zone_name)+1)='.'||p_zone_name)
        AND p_snapshot @> jsonb_build_array(jsonb_build_object(
          'kind','paid','identity',encode(declared.apply_idempotency_sha256,'hex'),
          'hostname',declared.hostname))
      FOR SHARE OF declared)
    OR EXISTS (SELECT 1 FROM project_mail_domains declared
      WHERE declared.organization_id=p_organization_id AND declared.project_id=p_project_id
        AND (declared.domain=p_zone_name
          OR right(declared.domain,length(p_zone_name)+1)='.'||p_zone_name)
        AND p_snapshot @> jsonb_build_array(jsonb_build_object(
          'kind','legacy_mail','identity',declared.declaration_generation::text,
          'hostname',declared.domain))
      FOR SHARE OF declared)
    OR EXISTS (SELECT 1 FROM resend_mail_domains declared
      WHERE declared.organization_id=p_organization_id AND declared.project_id=p_project_id
        AND declared.deleted_at IS NULL
        AND (declared.domain=p_zone_name
          OR right(declared.domain,length(p_zone_name)+1)='.'||p_zone_name)
        AND p_snapshot @> jsonb_build_array(jsonb_build_object(
          'kind','resend_mail','identity',declared.domain_id::text,
          'hostname',declared.domain))
      FOR SHARE OF declared)
$$;

CREATE FUNCTION capture_cloudflare_authorization_declaration_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding record; snapshot jsonb:='[]'::jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.declaration_snapshot IS DISTINCT FROM OLD.declaration_snapshot THEN
      RAISE EXCEPTION 'Cloudflare OAuth declaration snapshot is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
      AND NOT cloudflare_authorization_declaration_is_current(
        OLD.organization_id,OLD.project_id,OLD.zone_name,OLD.declaration_snapshot) THEN
      RAISE EXCEPTION 'Cloudflare OAuth declaration is unavailable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  FOR binding IN SELECT hostname,apply_idempotency_sha256 FROM paid_project_domains
    WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
      AND state IN ('awaiting_deployment','pending','active')
      AND (hostname=NEW.zone_name OR right(hostname,length(NEW.zone_name)+1)='.'||NEW.zone_name)
    FOR SHARE
  LOOP
    snapshot:=snapshot||jsonb_build_array(jsonb_build_object(
      'kind','paid','identity',encode(binding.apply_idempotency_sha256,'hex'),
      'hostname',binding.hostname));
  END LOOP;
  FOR binding IN SELECT domain,declaration_generation FROM project_mail_domains
    WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
      AND (domain=NEW.zone_name OR right(domain,length(NEW.zone_name)+1)='.'||NEW.zone_name)
    FOR SHARE
  LOOP
    snapshot:=snapshot||jsonb_build_array(jsonb_build_object(
      'kind','legacy_mail','identity',binding.declaration_generation::text,
      'hostname',binding.domain));
  END LOOP;
  FOR binding IN SELECT domain,domain_id FROM resend_mail_domains
    WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND deleted_at IS NULL
      AND (domain=NEW.zone_name OR right(domain,length(NEW.zone_name)+1)='.'||NEW.zone_name)
    FOR SHARE
  LOOP
    snapshot:=snapshot||jsonb_build_array(jsonb_build_object(
      'kind','resend_mail','identity',binding.domain_id::text,'hostname',binding.domain));
  END LOOP;
  NEW.declaration_snapshot:=snapshot;
  RETURN NEW;
END $$;
CREATE TRIGGER cloudflare_project_authorization_declaration_snapshot
  BEFORE INSERT OR UPDATE ON cloudflare_project_authorization_states
  FOR EACH ROW EXECUTE FUNCTION capture_cloudflare_authorization_declaration_snapshot();

CREATE FUNCTION require_cloudflare_dns_grant_current_declaration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cloudflare_project_authorization_states auth_state
    INNER JOIN project_ownerships ownership
      ON ownership.organization_id=auth_state.organization_id
        AND ownership.project_id=auth_state.project_id AND ownership.state='active'
    INNER JOIN projects project
      ON project.project_id=auth_state.project_id AND project.lifecycle_state='active'
    WHERE auth_state.authorization_id=NEW.authorization_id
      AND auth_state.organization_id=NEW.organization_id AND auth_state.project_id=NEW.project_id
      AND auth_state.principal_id=NEW.principal_id AND auth_state.zone_name=NEW.zone_name
      AND auth_state.consumed_at IS NOT NULL AND auth_state.consumed_at<=NEW.connected_at
      AND NEW.connected_at<auth_state.expires_at
      AND cloudflare_authorization_declaration_is_current(auth_state.organization_id,
        auth_state.project_id,auth_state.zone_name,auth_state.declaration_snapshot)) THEN
    RAISE EXCEPTION 'Cloudflare OAuth declaration is unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloudflare_project_dns_grant_current_declaration
  BEFORE INSERT ON cloudflare_project_dns_grants
  FOR EACH ROW EXECUTE FUNCTION require_cloudflare_dns_grant_current_declaration();`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM paid_project_domains WHERE gateway_script_name IS NULL
        OR provisioning_started_at IS DISTINCT FROM created_at)
        OR EXISTS (SELECT 1 FROM cloudflare_project_authorization_states
          WHERE declaration_snapshot<>'[]'::jsonb) THEN
        RAISE EXCEPTION 'Early domain declarations or distinct provider lifetimes prevent a lossless downgrade';
      END IF;
    END $$;
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_state_shape;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_state_shape CHECK (
      (state='pending' AND custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL
        AND delete_idempotency_sha256 IS NULL AND delete_request_sha256 IS NULL AND deleted_at IS NULL)
      OR (state='active' AND jsonb_typeof(custom_hostname_receipt)='object'
        AND jsonb_typeof(worker_route_receipt)='object' AND deleted_at IS NULL)
      OR (state IN ('deleting','deleted')
        AND ((jsonb_typeof(custom_hostname_receipt)='object' AND jsonb_typeof(worker_route_receipt)='object')
          OR (custom_hostname_receipt IS NULL AND worker_route_receipt IS NULL))
        AND octet_length(delete_idempotency_sha256)=32 AND octet_length(delete_request_sha256)=32
        AND (deleted_at IS NULL)=(state='deleting')));
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_provisioning_time;
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_provisioning_shape;
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_state_check;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_state_check
      CHECK (state IN ('pending','active','deleting','deleted'));
    ALTER TABLE paid_project_domains ALTER COLUMN gateway_script_name SET NOT NULL;
    DROP TRIGGER fill_paid_domain_provisioning_started_at ON paid_project_domains;
    DROP FUNCTION fill_paid_domain_provisioning_started_at();
    ALTER TABLE paid_project_domains DROP COLUMN provisioning_started_at`);
  pgm.sql(`DROP TRIGGER cloudflare_project_dns_grant_current_declaration ON cloudflare_project_dns_grants;
DROP FUNCTION require_cloudflare_dns_grant_current_declaration();
DROP TRIGGER cloudflare_project_authorization_declaration_snapshot ON cloudflare_project_authorization_states;
DROP FUNCTION capture_cloudflare_authorization_declaration_snapshot();
DROP FUNCTION cloudflare_authorization_declaration_is_current(ulid,ulid,text,jsonb);
ALTER TABLE cloudflare_project_authorization_states
  DROP CONSTRAINT cloudflare_authorization_declaration_snapshot_array,
  DROP COLUMN declaration_snapshot;
ALTER TABLE project_mail_domains DROP COLUMN declaration_generation;`);
}
