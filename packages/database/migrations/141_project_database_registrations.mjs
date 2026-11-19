export function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION valid_project_database_registration_metadata(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $shape$
    DECLARE key text; environments text[];
    BEGIN
      IF jsonb_typeof(value)<>'object' OR NOT(value ?& ARRAY['operationId','organizationId','projectId','physicalEnvironmentId','registrationVersion','region','providerProjectId','branchId','originHost','originDatabase','originUser','authorizedEnvironmentIds','status']) OR value-ARRAY['operationId','organizationId','projectId','physicalEnvironmentId','registrationVersion','region','providerProjectId','branchId','originHost','originDatabase','originUser','authorizedEnvironmentIds','status']<>'{}'::jsonb THEN RETURN false; END IF;
      FOREACH key IN ARRAY ARRAY['operationId','organizationId','projectId','physicalEnvironmentId'] LOOP
        IF jsonb_typeof(value->key)<>'string' OR (value->>key)!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' THEN RETURN false; END IF;
      END LOOP;
      FOREACH key IN ARRAY ARRAY['region','providerProjectId','branchId','originHost','originDatabase','originUser','status'] LOOP
        IF jsonb_typeof(value->key)<>'string' THEN RETURN false; END IF;
      END LOOP;
      IF jsonb_typeof(value->'registrationVersion')<>'number' OR (value->>'registrationVersion')!~'^[1-9][0-9]*$' OR (value->>'registrationVersion')::numeric>9007199254740991
        OR value->>'region' NOT IN ('us','eu') OR value->>'status' NOT IN ('active','revoked')
        OR value->>'originDatabase'<>'neondb' OR value->>'originUser'<>'ohmyho_rw_'||lower(value->>'physicalEnvironmentId')
        OR value->>'providerProjectId' !~ '^[a-z0-9-]{1,60}$' OR value->>'branchId' !~ '^[a-z0-9-]{1,60}$'
        OR value->>'originHost' !~ '^ep-[a-z0-9-]+-pooler[.](c-[0-9]+[.])?(us-east-[12]|eu-central-1)[.]aws[.]neon[.]tech$'
        OR (value->>'region'='eu') IS DISTINCT FROM (value->>'originHost' LIKE '%.eu-central-1.aws.neon.tech')
        OR jsonb_typeof(value->'authorizedEnvironmentIds')<>'array' THEN RETURN false; END IF;
      SELECT array_agg(environment) INTO environments FROM jsonb_array_elements_text(value->'authorizedEnvironmentIds') environment;
      IF coalesce(cardinality(environments),0) NOT BETWEEN 1 AND 2 OR NOT (value->>'physicalEnvironmentId'=ANY(environments))
        OR cardinality(environments)<>(SELECT count(DISTINCT environment) FROM unnest(environments) environment)
        OR EXISTS(SELECT 1 FROM unnest(environments) environment WHERE environment IS NULL OR environment!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$') THEN RETURN false; END IF;
      RETURN true;
    EXCEPTION WHEN OTHERS THEN RETURN false; END $shape$;
    CREATE TABLE project_database_registration_reservations (
      organization_id ulid NOT NULL, project_id ulid NOT NULL, physical_environment_id ulid NOT NULL,
      operation_id ulid NOT NULL, claim_id ulid NOT NULL, registration_version bigint NOT NULL CHECK(registration_version>0), metadata jsonb NOT NULL CHECK(valid_project_database_registration_metadata(metadata) IS TRUE),
      PRIMARY KEY(organization_id,project_id,physical_environment_id),
      FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
      FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES environments(organization_id,project_id,environment_id),
      CHECK(metadata->>'organizationId'=organization_id::text AND metadata->>'projectId'=project_id::text AND metadata->>'physicalEnvironmentId'=physical_environment_id::text AND metadata->>'operationId'=operation_id::text AND (metadata->>'registrationVersion')::bigint=registration_version),
      CHECK(metadata ?& ARRAY['operationId','organizationId','projectId','physicalEnvironmentId','registrationVersion','region','providerProjectId','branchId','originHost','originDatabase','originUser','authorizedEnvironmentIds','status'] AND metadata-ARRAY['operationId','organizationId','projectId','physicalEnvironmentId','registrationVersion','region','providerProjectId','branchId','originHost','originDatabase','originUser','authorizedEnvironmentIds','status']='{}'::jsonb),
      CHECK(metadata->>'status'='active' AND metadata->>'region' IN ('us','eu') AND metadata->>'originDatabase'='neondb' AND metadata->>'originUser'='ohmyho_rw_'||lower(physical_environment_id::text))
    );
    CREATE TRIGGER project_database_registration_reservations_append_only BEFORE UPDATE OR DELETE ON project_database_registration_reservations FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TABLE project_database_registration_receipts (
      organization_id ulid NOT NULL, project_id ulid NOT NULL, physical_environment_id ulid NOT NULL,
      operation_id ulid NOT NULL, claim_id ulid NOT NULL, registration_version bigint NOT NULL CHECK(registration_version>0),
      status text NOT NULL CHECK(status IN ('active','revoked')), metadata jsonb NOT NULL CHECK(valid_project_database_registration_metadata(metadata) IS TRUE), observed_at timestamptz NOT NULL,
      PRIMARY KEY(organization_id,project_id,physical_environment_id,registration_version),
      FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES environments(organization_id,project_id,environment_id),
      FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
      CHECK(metadata->>'organizationId'=organization_id::text AND metadata->>'projectId'=project_id::text AND metadata->>'physicalEnvironmentId'=physical_environment_id::text AND metadata->>'operationId'=operation_id::text AND (metadata->>'registrationVersion')::bigint=registration_version AND metadata->>'status'=status),
      CHECK(metadata ?& ARRAY['operationId','organizationId','projectId','physicalEnvironmentId','registrationVersion','region','providerProjectId','branchId','originHost','originDatabase','originUser','authorizedEnvironmentIds','status'] AND metadata-ARRAY['operationId','organizationId','projectId','physicalEnvironmentId','registrationVersion','region','providerProjectId','branchId','originHost','originDatabase','originUser','authorizedEnvironmentIds','status']='{}'::jsonb),
      CHECK(metadata->>'region' IN ('us','eu') AND metadata->>'originDatabase'='neondb' AND metadata->>'originUser'='ohmyho_rw_'||lower(physical_environment_id::text))
    );
    CREATE TRIGGER project_database_registration_receipts_append_only BEFORE UPDATE OR DELETE ON project_database_registration_receipts FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    DO $grant$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      GRANT SELECT,INSERT ON project_database_registration_reservations,project_database_registration_receipts TO control_runtime;
    END IF; END $grant$;
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_database_registration_receipts) OR EXISTS(SELECT 1 FROM project_database_registration_reservations) THEN RAISE EXCEPTION 'Database registration evidence prevents a lossless downgrade'; END IF; END $$;
    DROP TABLE project_database_registration_receipts; DROP TABLE project_database_registration_reservations; DROP FUNCTION valid_project_database_registration_metadata(jsonb);`);
}
