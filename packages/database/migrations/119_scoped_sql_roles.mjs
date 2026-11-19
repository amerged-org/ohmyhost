export function up(pgm) {
  for (const table of ["neon_project_role_receipts", "neon_project_role_reservations"]) {
    pgm.dropConstraint(table, `${table}_shape`);
    pgm.addConstraint(table, `${table}_shape`, {
      check: `provider_project_id~'^[a-z0-9-]{1,60}$' AND branch_id~'^[a-z0-9-]{1,60}$'
      AND role_name IN ('ohmyho_migration','ohmyho_readonly','ohmyho_runtime','ohmyho_m_'||lower(environment_id::text),'ohmyho_ro_'||lower(environment_id::text),'ohmyho_rw_'||lower(environment_id::text))
      AND ${table.endsWith("_receipts") ? "cardinality(operation_ids)<=128 AND state='ready'" : "(create_started_at IS NULL OR create_started_at>=reserved_at)"}`,
    });
  }
  for (const table of ["project_hyperdrive_receipts", "project_hyperdrive_reservations"]) {
    pgm.dropConstraint(table, `${table}_shape`);
    pgm.addConstraint(table, `${table}_shape`, {
      check: `provider_project_id~'^[a-z0-9-]{1,60}$' AND branch_id~'^[a-z0-9-]{1,60}$'
      AND config_name IN ('ohmyho-'||lower(project_id::text),'ohmyho-'||lower(project_id::text)||'-'||lower(environment_id::text))
      AND origin_host~'^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' AND origin_database='neondb'
      AND origin_user IN ('ohmyho_runtime','ohmyho_rw_'||lower(environment_id::text))
      AND ${table.endsWith("_receipts") ? "hyperdrive_id~'^[0-9a-f]{32}$'" : "(create_started_at IS NULL OR create_started_at>=reserved_at)"}`,
    });
  }
  pgm.sql(`ALTER TABLE project_hyperdrive_receipts ADD CONSTRAINT project_hyperdrive_origin_scope UNIQUE(organization_id,project_id,environment_id,hyperdrive_id);
    CREATE TABLE project_hyperdrive_origin_receipts (
      organization_id ulid NOT NULL,project_id ulid NOT NULL,environment_id ulid NOT NULL,hyperdrive_id text PRIMARY KEY,
      operation_id ulid NOT NULL,claim_id ulid NOT NULL,origin_user text NOT NULL,observed_at timestamptz NOT NULL,
      CHECK(origin_user='ohmyho_rw_'||lower(environment_id::text)),
      FOREIGN KEY(organization_id,project_id,environment_id,hyperdrive_id) REFERENCES project_hyperdrive_receipts(organization_id,project_id,environment_id,hyperdrive_id),
      FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
      FOREIGN KEY(organization_id,project_id,environment_id,origin_user) REFERENCES neon_project_role_receipts(organization_id,project_id,environment_id,role_name)
    );
    CREATE TRIGGER project_hyperdrive_origin_receipts_append_only BEFORE UPDATE OR DELETE ON project_hyperdrive_origin_receipts FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') AND has_table_privilege('control_runtime','project_hyperdrive_receipts','INSERT') THEN
      GRANT SELECT,INSERT ON project_hyperdrive_origin_receipts TO control_runtime;
      REVOKE UPDATE,DELETE ON project_hyperdrive_origin_receipts FROM control_runtime;
    END IF; END $$;
    CREATE OR REPLACE FUNCTION guard_project_hyperdrive_reservation_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN
        IF NOT EXISTS(SELECT 1 FROM project_hyperdrive_receipts receipt WHERE receipt.organization_id=OLD.organization_id AND receipt.project_id=OLD.project_id AND receipt.environment_id=OLD.environment_id AND receipt.claim_id=OLD.claim_id)
          AND NOT EXISTS(SELECT 1 FROM project_hyperdrive_origin_receipts receipt WHERE receipt.organization_id=OLD.organization_id AND receipt.project_id=OLD.project_id AND receipt.environment_id=OLD.environment_id AND receipt.claim_id=OLD.claim_id)
        THEN RAISE EXCEPTION 'Active Hyperdrive mutation cannot be deleted' USING ERRCODE='55000'; END IF;
        RETURN OLD;
      END IF;
      IF OLD.create_started_at IS NOT NULL OR NEW.create_started_at IS NULL OR (to_jsonb(NEW)-'create_started_at') IS DISTINCT FROM (to_jsonb(OLD)-'create_started_at')
        THEN RAISE EXCEPTION 'Hyperdrive mutation identity is immutable' USING ERRCODE='55000'; END IF;
      RETURN NEW;
    END $$;`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM project_hyperdrive_origin_receipts)
      OR EXISTS(SELECT 1 FROM neon_project_role_receipts WHERE role_name~'^ohmyho_(m|ro|rw)_[0-7][0-9a-hjkmnp-tv-z]{25}$')
      OR EXISTS(SELECT 1 FROM neon_project_role_reservations WHERE role_name~'^ohmyho_(m|ro|rw)_[0-7][0-9a-hjkmnp-tv-z]{25}$')
    THEN RAISE EXCEPTION 'Scoped SQL-role evidence prevents lossless downgrade' USING ERRCODE='23514'; END IF;
  END $$;
  DROP TABLE project_hyperdrive_origin_receipts;
  ALTER TABLE project_hyperdrive_receipts DROP CONSTRAINT project_hyperdrive_origin_scope;`);
  for (const table of ["neon_project_role_receipts", "neon_project_role_reservations"]) {
    pgm.dropConstraint(table, `${table}_shape`);
    pgm.addConstraint(table, `${table}_shape`, {
      check: `provider_project_id~'^[a-z0-9-]{1,60}$' AND branch_id~'^[a-z0-9-]{1,60}$' AND role_name IN ('ohmyho_migration','ohmyho_readonly','ohmyho_runtime')
      AND ${table.endsWith("_receipts") ? "cardinality(operation_ids)<=128 AND state='ready'" : "(create_started_at IS NULL OR create_started_at>=reserved_at)"}`,
    });
  }
  for (const table of ["project_hyperdrive_receipts", "project_hyperdrive_reservations"]) {
    pgm.dropConstraint(table, `${table}_shape`);
    pgm.addConstraint(table, `${table}_shape`, {
      check: `provider_project_id~'^[a-z0-9-]{1,60}$' AND branch_id~'^[a-z0-9-]{1,60}$' AND config_name IN ('ohmyho-'||lower(project_id::text),'ohmyho-'||lower(project_id::text)||'-'||lower(environment_id::text))
      AND origin_host~'^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' AND origin_database='neondb' AND origin_user='ohmyho_runtime'
      AND ${table.endsWith("_receipts") ? "hyperdrive_id~'^[0-9a-f]{32}$'" : "(create_started_at IS NULL OR create_started_at>=reserved_at)"}`,
    });
  }
  pgm.sql(`CREATE OR REPLACE FUNCTION guard_project_hyperdrive_reservation_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' THEN
      IF NOT EXISTS(SELECT 1 FROM project_hyperdrive_receipts receipt WHERE receipt.organization_id=OLD.organization_id AND receipt.project_id=OLD.project_id AND receipt.claim_id=OLD.claim_id)
      THEN RAISE EXCEPTION 'Active Hyperdrive reservation cannot be deleted' USING ERRCODE='55000'; END IF; RETURN OLD;
    END IF;
    IF OLD.create_started_at IS NOT NULL OR NEW.create_started_at IS NULL OR (to_jsonb(NEW)-'create_started_at') IS DISTINCT FROM (to_jsonb(OLD)-'create_started_at')
      THEN RAISE EXCEPTION 'Hyperdrive reservation identity is immutable' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END $$;`);
}
