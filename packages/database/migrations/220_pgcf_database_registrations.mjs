/** Extend the registration contract without changing the interpretation of legacy receipts. */
export function up(pgm) {
  pgm.sql(`DO $$ DECLARE definition text; BEGIN
    SELECT pg_get_functiondef(oid) INTO definition FROM pg_proc WHERE proname='valid_project_database_registration_metadata' AND pronamespace=current_schema()::regnamespace;
    EXECUTE replace(definition,'valid_project_database_registration_metadata(', 'valid_project_database_registration_metadata_neon(');
  END $$;
  CREATE OR REPLACE FUNCTION valid_project_database_registration_metadata(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE key text; environments text[];
  BEGIN
    IF value->>'provider' IS DISTINCT FROM 'pgcf' THEN RETURN valid_project_database_registration_metadata_neon(value); END IF;
    IF jsonb_typeof(value)<>'object' OR NOT(value ?& ARRAY['operationId','organizationId','projectId','physicalEnvironmentId','registrationVersion','region','provider','providerProjectId','databaseId','originHost','originDatabase','originUser','authorizedEnvironmentIds','status']) OR value-ARRAY['operationId','organizationId','projectId','physicalEnvironmentId','registrationVersion','region','provider','providerProjectId','databaseId','originHost','originDatabase','originUser','authorizedEnvironmentIds','status']<>'{}'::jsonb THEN RETURN false; END IF;
    FOREACH key IN ARRAY ARRAY['operationId','organizationId','projectId','physicalEnvironmentId'] LOOP IF jsonb_typeof(value->key)<>'string' OR value->>key !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' THEN RETURN false; END IF; END LOOP;
    FOREACH key IN ARRAY ARRAY['provider','providerProjectId','databaseId','region','originHost','originDatabase','originUser','status'] LOOP IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' THEN RETURN false; END IF; END LOOP;
    IF jsonb_typeof(value->'registrationVersion')<>'number' OR value->>'registrationVersion' !~ '^[1-9][0-9]*$' OR (value->>'registrationVersion')::numeric>9007199254740991
      OR value->>'region' NOT IN ('us','eu') OR value->>'status' NOT IN ('active','revoked')
      OR value->>'providerProjectId' !~ '^prj_[a-z0-9]{20}$' OR value->>'databaseId' !~ '^[a-z][a-z0-9]{19}$'
      OR value->>'originDatabase' IS DISTINCT FROM value->>'databaseId' OR value->>'originUser' IS DISTINCT FROM 'ohmyho_rw_'||lower(value->>'physicalEnvironmentId')
      OR value->>'originHost' !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z][a-z0-9-]{1,62}$' OR jsonb_typeof(value->'authorizedEnvironmentIds')<>'array' THEN RETURN false; END IF;
    SELECT array_agg(environment) INTO environments FROM jsonb_array_elements_text(value->'authorizedEnvironmentIds') environment;
    IF coalesce(cardinality(environments),0) NOT BETWEEN 1 AND 2 OR cardinality(environments)<>(SELECT count(DISTINCT environment) FROM unnest(environments) environment)
      OR EXISTS(SELECT 1 FROM unnest(environments) environment WHERE environment IS NULL OR environment!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$') THEN RETURN false; END IF;
    RETURN true;
  EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
  CREATE TABLE pgcf_registration_constraint_restore(relation_name text NOT NULL,constraint_name text NOT NULL,definition text NOT NULL,PRIMARY KEY(relation_name,constraint_name));
  INSERT INTO pgcf_registration_constraint_restore SELECT conrelid::regclass::text,conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN ('project_database_registration_reservations'::regclass,'project_database_registration_receipts'::regclass) AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%originDatabase%' OR pg_get_constraintdef(oid) LIKE '%branchId%');
  DO $$ DECLARE c record; BEGIN FOR c IN SELECT * FROM pgcf_registration_constraint_restore LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.relation_name,c.constraint_name); END LOOP; END $$;
  ALTER TABLE project_database_registration_reservations ADD CONSTRAINT pgcf_registration_reservation_shape CHECK(valid_project_database_registration_metadata(metadata) IS TRUE AND metadata->>'status' IN ('active','revoked'));
  ALTER TABLE project_database_registration_receipts ADD CONSTRAINT pgcf_registration_receipt_shape CHECK(valid_project_database_registration_metadata(metadata) IS TRUE);
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ DECLARE definition text; c record; BEGIN
    IF EXISTS(SELECT 1 FROM project_database_registration_reservations WHERE metadata->>'provider'='pgcf') OR EXISTS(SELECT 1 FROM project_database_registration_receipts WHERE metadata->>'provider'='pgcf') THEN RAISE EXCEPTION 'PGCF registration evidence prevents downgrade'; END IF;
    SELECT pg_get_functiondef(oid) INTO definition FROM pg_proc WHERE proname='valid_project_database_registration_metadata_neon' AND pronamespace=current_schema()::regnamespace;
    EXECUTE replace(definition,'valid_project_database_registration_metadata_neon(', 'valid_project_database_registration_metadata(');
    ALTER TABLE project_database_registration_reservations DROP CONSTRAINT pgcf_registration_reservation_shape;
    ALTER TABLE project_database_registration_receipts DROP CONSTRAINT pgcf_registration_receipt_shape;
    FOR c IN SELECT * FROM pgcf_registration_constraint_restore LOOP EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',c.relation_name,c.constraint_name,c.definition); END LOOP;
  END $$;
  DROP FUNCTION valid_project_database_registration_metadata_neon(jsonb); DROP TABLE pgcf_registration_constraint_restore;`);
}
