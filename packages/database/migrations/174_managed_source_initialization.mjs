export function up(pgm) {
  pgm.sql(`
    CREATE TABLE managed_source_initializations (
      parent_operation_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL, project_id ulid NOT NULL, billing_epoch_id ulid NOT NULL,
      source_connection_id ulid NOT NULL UNIQUE, initialization_event_id ulid NOT NULL UNIQUE,
      principal_id text NOT NULL CHECK(principal_id ~ '^user:[A-Za-z0-9_:-]{1,250}$'),
      template text NOT NULL CHECK(template IN ('vite-react','empty')),
      region text NOT NULL CHECK(region IN ('us','eu')), request_id text NOT NULL,
      state text NOT NULL CHECK(state IN ('waiting','queued','initializing','initialized','failed')),
      child_operation_id ulid UNIQUE REFERENCES managed_source_publications(operation_id),
      delegation_grant_id uuid REFERENCES mcp_client_grants(grant_id),
      delegation_client_id text, delegation_consent_sha256 text,
      error_code text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      UNIQUE(organization_id,project_id),
      FOREIGN KEY(organization_id,project_id,parent_operation_id,billing_epoch_id)
        REFERENCES operations(organization_id,project_id,operation_id,billing_epoch_id),
      FOREIGN KEY(billing_epoch_id,project_id,organization_id)
        REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
      CHECK((delegation_grant_id IS NULL AND delegation_client_id IS NULL AND delegation_consent_sha256 IS NULL)
        OR (delegation_grant_id IS NOT NULL AND delegation_client_id IS NOT NULL
          AND delegation_consent_sha256 ~ '^[0-9a-f]{64}$')),
      CHECK((state='failed')=(error_code IS NOT NULL)),
      CHECK(state NOT IN ('initializing','initialized') OR child_operation_id IS NOT NULL),
      CHECK(updated_at>=created_at)
    );
    CREATE FUNCTION retain_managed_source_initialization_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (NEW.parent_operation_id,NEW.organization_id,NEW.project_id,NEW.billing_epoch_id,
          NEW.source_connection_id,NEW.initialization_event_id,NEW.principal_id,NEW.template,
          NEW.region,NEW.request_id,NEW.delegation_grant_id,NEW.delegation_client_id,
          NEW.delegation_consent_sha256,NEW.created_at)
        IS DISTINCT FROM
         (OLD.parent_operation_id,OLD.organization_id,OLD.project_id,OLD.billing_epoch_id,
          OLD.source_connection_id,OLD.initialization_event_id,OLD.principal_id,OLD.template,
          OLD.region,OLD.request_id,OLD.delegation_grant_id,OLD.delegation_client_id,
          OLD.delegation_consent_sha256,OLD.created_at)
        OR (OLD.child_operation_id IS NOT NULL AND NEW.child_operation_id IS DISTINCT FROM OLD.child_operation_id)
      THEN RAISE EXCEPTION 'Managed source initialization identity is immutable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER managed_source_initialization_identity BEFORE UPDATE ON managed_source_initializations
      FOR EACH ROW EXECUTE FUNCTION retain_managed_source_initialization_identity();
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM managed_source_initializations)
    THEN RAISE EXCEPTION 'Managed source initialization history prevents downgrade' USING ERRCODE='23514'; END IF; END $$;
    DROP TABLE managed_source_initializations;
    DROP FUNCTION retain_managed_source_initialization_identity();
  `);
}
