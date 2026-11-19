export function up(pgm) {
  pgm.sql(`CREATE TABLE project_data_environments (
    organization_id ulid NOT NULL,project_id ulid NOT NULL,data_environment_id ulid NOT NULL,created_at timestamptz NOT NULL,
    PRIMARY KEY(organization_id,project_id,data_environment_id),
    FOREIGN KEY(project_id) REFERENCES projects(project_id));
    CREATE TABLE environment_data_assignments (
    organization_id ulid NOT NULL,project_id ulid NOT NULL,environment_id ulid NOT NULL,data_environment_id ulid NOT NULL,
    assignment_version bigint NOT NULL CHECK(assignment_version>0),assigned_at timestamptz NOT NULL,operation_id ulid,
    PRIMARY KEY(organization_id,project_id,environment_id,assignment_version),
    FOREIGN KEY(project_id,environment_id) REFERENCES environments(project_id,environment_id),
    FOREIGN KEY(organization_id,project_id,data_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id),
    FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id));
    INSERT INTO project_data_environments SELECT organization_id,project_id,environment_id,created_at FROM environments;
    INSERT INTO environment_data_assignments
      SELECT environment.organization_id,environment.project_id,environment.environment_id,
        CASE WHEN project.data_mode='shared' THEN development.environment_id ELSE environment.environment_id END,1,project.created_at,NULL
      FROM environments environment JOIN projects project USING(project_id)
      JOIN environments development ON development.organization_id=environment.organization_id AND development.project_id=environment.project_id AND development.name='dev';
    CREATE TRIGGER project_data_environments_append_only BEFORE UPDATE OR DELETE ON project_data_environments FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TRIGGER environment_data_assignments_append_only BEFORE UPDATE OR DELETE ON environment_data_assignments FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE FUNCTION require_project_data_assignment_environment_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM environments WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND environment_id=NEW.environment_id) THEN
        RAISE EXCEPTION 'data assignments require current environment scope' USING ERRCODE='42501';
      END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER environment_data_assignments_require_current_scope BEFORE INSERT ON environment_data_assignments FOR EACH ROW EXECUTE FUNCTION require_project_data_assignment_environment_scope();
    ALTER TABLE environment_data_assignments ENABLE ALWAYS TRIGGER environment_data_assignments_require_current_scope;
    CREATE FUNCTION current_data_environment(org ulid,project ulid,environment ulid) RETURNS ulid LANGUAGE sql STABLE AS $$
      SELECT data_environment_id FROM environment_data_assignments WHERE organization_id=org AND project_id=project AND environment_id=environment ORDER BY assignment_version DESC LIMIT 1 $$;
    CREATE FUNCTION data_environment_at(org ulid,project ulid,environment ulid,at_time timestamptz) RETURNS ulid LANGUAGE sql STABLE AS $$
      SELECT data_environment_id FROM environment_data_assignments WHERE organization_id=org AND project_id=project AND environment_id=environment AND assigned_at<=at_time ORDER BY assigned_at DESC,assignment_version DESC LIMIT 1 $$;
    CREATE FUNCTION project_data_change_in_progress(org ulid,project ulid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM product_command_intents intent JOIN operations operation USING(organization_id,project_id,operation_id)
        WHERE intent.organization_id=org AND intent.project_id=project AND intent.event_type='ProjectDataChangeRequestedV1' AND operation.state IN ('queued','running')) $$;
    CREATE FUNCTION initialize_project_data_assignments() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (SELECT count(*) FROM environments WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND name IN ('dev','prod'))<>2 THEN RETURN NEW; END IF;
      INSERT INTO project_data_environments SELECT organization_id,project_id,environment_id,created_at FROM environments WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id ON CONFLICT DO NOTHING;
      INSERT INTO environment_data_assignments
        SELECT environment.organization_id,environment.project_id,environment.environment_id,CASE WHEN project.data_mode='shared' THEN development.environment_id ELSE environment.environment_id END,1,project.created_at,NULL
        FROM environments environment JOIN projects project USING(project_id)
        JOIN environments development ON development.organization_id=environment.organization_id AND development.project_id=environment.project_id AND development.name='dev'
        WHERE environment.organization_id=NEW.organization_id AND environment.project_id=NEW.project_id
        ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$;
    CREATE TRIGGER initialize_project_data_assignments AFTER INSERT ON environments FOR EACH ROW EXECUTE FUNCTION initialize_project_data_assignments();
    ALTER TABLE environments ENABLE ALWAYS TRIGGER initialize_project_data_assignments;
    CREATE FUNCTION append_transferred_project_data_assignments() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE previous environment_data_assignments%ROWTYPE; transferred_at timestamptz;
    BEGIN
      SELECT * INTO previous FROM environment_data_assignments
        WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id AND environment_id=OLD.environment_id
        ORDER BY assignment_version DESC LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'transferred environment has no prior data assignment' USING ERRCODE='55000'; END IF;
      SELECT updated_at INTO transferred_at FROM project_ownerships WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id;
      IF transferred_at IS NULL THEN RAISE EXCEPTION 'transferred assignment requires current ownership' USING ERRCODE='42501'; END IF;
      -- Alias exact identities, including retired ones, without changing original-owner history or provider receipts.
      INSERT INTO project_data_environments SELECT NEW.organization_id,project_id,data_environment_id,created_at
        FROM project_data_environments WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id ON CONFLICT DO NOTHING;
      INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at,operation_id)
        VALUES(NEW.organization_id,NEW.project_id,NEW.environment_id,previous.data_environment_id,previous.assignment_version+1,transferred_at,NULL);
      RETURN NEW;
    END $$;
    CREATE TRIGGER append_transferred_project_data_assignments AFTER UPDATE OF organization_id ON environments FOR EACH ROW WHEN(NEW.organization_id IS DISTINCT FROM OLD.organization_id) EXECUTE FUNCTION append_transferred_project_data_assignments();
    ALTER TABLE environments ENABLE ALWAYS TRIGGER append_transferred_project_data_assignments;
    CREATE OR REPLACE FUNCTION reject_project_data_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE development ulid;production ulid; BEGIN
      IF NEW.data_mode IS DISTINCT FROM OLD.data_mode THEN
        SELECT current_data_environment(organization_id,project_id,environment_id) INTO development FROM environments WHERE project_id=NEW.project_id AND name='dev';
        SELECT current_data_environment(organization_id,project_id,environment_id) INTO production FROM environments WHERE project_id=NEW.project_id AND name='prod';
        IF development IS NULL OR production IS NULL OR (NEW.data_mode='shared') IS DISTINCT FROM (development=production) THEN
          RAISE EXCEPTION 'project data mode must match its environment data assignments' USING ERRCODE='55000';
        END IF;
      END IF; RETURN NEW;
    END $$;
    CREATE FUNCTION check_project_data_assignments() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE development ulid;production ulid;mode text;current_org ulid; BEGIN
      SELECT data_mode INTO mode FROM projects WHERE project_id=NEW.project_id;
      SELECT organization_id INTO current_org FROM project_ownerships WHERE project_id=NEW.project_id;
      SELECT current_data_environment(organization_id,project_id,environment_id) INTO development FROM environments WHERE organization_id=current_org AND project_id=NEW.project_id AND name='dev';
      SELECT current_data_environment(organization_id,project_id,environment_id) INTO production FROM environments WHERE organization_id=current_org AND project_id=NEW.project_id AND name='prod';
      IF development IS NULL OR production IS NULL OR (mode='shared') IS DISTINCT FROM (development=production) THEN
        RAISE EXCEPTION 'project data mode must match its environment data assignments' USING ERRCODE='55000';
      END IF; RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER check_project_data_assignments AFTER INSERT ON environment_data_assignments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_project_data_assignments();
    ALTER TABLE product_provider_mutation_claims ADD CONSTRAINT product_provider_mutation_claims_data_identity_key UNIQUE(claim_id,organization_id,project_id,operation_id);
    ALTER TABLE neon_project_placement_reservations DROP CONSTRAINT neon_project_placement_reservations_claim_fkey;
    ALTER TABLE neon_project_placement_reservations ADD CONSTRAINT neon_project_placement_reservations_claim_fkey FOREIGN KEY(claim_id,organization_id,project_id,operation_id) REFERENCES product_provider_mutation_claims(claim_id,organization_id,project_id,operation_id);
    ALTER TABLE neon_project_role_reservations DROP CONSTRAINT neon_project_role_reservations_claim_fkey;
    ALTER TABLE neon_project_role_reservations ADD CONSTRAINT neon_project_role_reservations_claim_fkey FOREIGN KEY(claim_id,organization_id,project_id,operation_id) REFERENCES product_provider_mutation_claims(claim_id,organization_id,project_id,operation_id);
    DO $$ DECLARE table_name text; BEGIN
      FOREACH table_name IN ARRAY ARRAY['neon_project_placement_receipts','neon_project_placement_reservations'] LOOP
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id)',table_name,table_name||'_data_identity_fkey');
      END LOOP;
    END $$;
    DO $$ DECLARE item record; BEGIN FOR item IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint WHERE conrelid IN ('project_database_registration_reservations'::regclass,'project_database_registration_receipts'::regclass) AND confrelid='environments'::regclass LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.relation,item.conname);
    END LOOP; END $$;
    ALTER TABLE project_database_registration_reservations ADD CONSTRAINT project_database_registration_reservations_data_identity_fkey FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id);
    ALTER TABLE project_database_registration_receipts ADD CONSTRAINT project_database_registration_receipts_data_identity_fkey FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id);
    DO $$ DECLARE definition text; BEGIN
      SELECT pg_get_functiondef(oid) INTO definition FROM pg_proc WHERE proname='valid_project_database_registration_metadata' AND pronamespace=current_schema()::regnamespace;
      EXECUTE replace(definition,' OR NOT (value->>''physicalEnvironmentId''=ANY(environments))','');
    END $$;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      GRANT SELECT,INSERT ON project_data_environments,environment_data_assignments TO control_runtime;
      GRANT UPDATE(data_mode) ON projects TO control_runtime;
    END IF; END $$;`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM environment_data_assignments WHERE assignment_version>1) OR EXISTS(SELECT 1 FROM project_data_environments data WHERE NOT EXISTS(SELECT 1 FROM environments environment WHERE environment.organization_id=data.organization_id AND environment.project_id=data.project_id AND environment.environment_id=data.data_environment_id)) THEN RAISE EXCEPTION 'Changed data assignments prevent a lossless downgrade' USING ERRCODE='23514'; END IF; END $$;
    DROP TRIGGER check_project_data_assignments ON environment_data_assignments;
    DROP FUNCTION check_project_data_assignments();
    DROP TRIGGER initialize_project_data_assignments ON environments;
    DROP FUNCTION initialize_project_data_assignments();
    DROP TRIGGER append_transferred_project_data_assignments ON environments;
    DROP FUNCTION append_transferred_project_data_assignments();
    DROP TRIGGER environment_data_assignments_require_current_scope ON environment_data_assignments;
    DROP FUNCTION require_project_data_assignment_environment_scope();
    ALTER TABLE project_database_registration_reservations DROP CONSTRAINT project_database_registration_reservations_data_identity_fkey;
    ALTER TABLE project_database_registration_receipts DROP CONSTRAINT project_database_registration_receipts_data_identity_fkey;
    ALTER TABLE project_database_registration_reservations ADD FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES environments(organization_id,project_id,environment_id);
    ALTER TABLE project_database_registration_receipts ADD FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES environments(organization_id,project_id,environment_id);
    ALTER TABLE neon_project_placement_receipts DROP CONSTRAINT neon_project_placement_receipts_data_identity_fkey;
    ALTER TABLE neon_project_placement_reservations DROP CONSTRAINT neon_project_placement_reservations_data_identity_fkey;
    ALTER TABLE neon_project_placement_reservations DROP CONSTRAINT neon_project_placement_reservations_claim_fkey;
    ALTER TABLE neon_project_placement_reservations ADD CONSTRAINT neon_project_placement_reservations_claim_fkey FOREIGN KEY(claim_id,organization_id,project_id,environment_id,operation_id) REFERENCES product_provider_mutation_claims(claim_id,organization_id,project_id,environment_id,operation_id);
    ALTER TABLE neon_project_role_reservations DROP CONSTRAINT neon_project_role_reservations_claim_fkey;
    ALTER TABLE neon_project_role_reservations ADD CONSTRAINT neon_project_role_reservations_claim_fkey FOREIGN KEY(claim_id,organization_id,project_id,environment_id,operation_id) REFERENCES product_provider_mutation_claims(claim_id,organization_id,project_id,environment_id,operation_id);
    ALTER TABLE product_provider_mutation_claims DROP CONSTRAINT product_provider_mutation_claims_data_identity_key;
    DO $$ DECLARE definition text; BEGIN
      SELECT pg_get_functiondef(oid) INTO definition FROM pg_proc WHERE proname='valid_project_database_registration_metadata' AND pronamespace=current_schema()::regnamespace;
      EXECUTE replace(definition,'IF coalesce(cardinality(environments),0) NOT BETWEEN 1 AND 2',
        'IF coalesce(cardinality(environments),0) NOT BETWEEN 1 AND 2 OR NOT (value->>''physicalEnvironmentId''=ANY(environments))');
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN REVOKE UPDATE(data_mode) ON projects FROM control_runtime; END IF;
    END $$;
    DROP FUNCTION project_data_change_in_progress(ulid,ulid);
    DROP FUNCTION data_environment_at(ulid,ulid,ulid,timestamptz);
    DROP FUNCTION current_data_environment(ulid,ulid,ulid);
    DROP TABLE environment_data_assignments; DROP TABLE project_data_environments;
    CREATE OR REPLACE FUNCTION reject_project_data_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.data_mode IS DISTINCT FROM OLD.data_mode THEN RAISE EXCEPTION 'project data mode requires an explicit data migration' USING ERRCODE='55000'; END IF; RETURN NEW;
    END $$;`);
}
