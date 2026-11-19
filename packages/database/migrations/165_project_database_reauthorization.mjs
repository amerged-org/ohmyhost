export function up(pgm) {
  pgm.sql(`ALTER TABLE project_database_registration_reservations DROP CONSTRAINT project_database_registration_reservations_pkey;
    ALTER TABLE project_database_registration_reservations ADD PRIMARY KEY(organization_id,project_id,physical_environment_id,registration_version);
    DO $$ DECLARE item record; definition text; BEGIN
      FOR item IN SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
        WHERE conrelid='project_database_registration_reservations'::regclass AND contype='c'
        AND position('(metadata ->> ''status''::text) = ''active''::text' in pg_get_constraintdef(oid))>0
      LOOP
        definition := replace(item.definition,'(metadata ->> ''status''::text) = ''active''::text','(metadata ->> ''status''::text) = ANY (ARRAY[''active''::text,''revoked''::text])');
        EXECUTE format('ALTER TABLE project_database_registration_reservations DROP CONSTRAINT %I',item.conname);
        EXECUTE format('ALTER TABLE project_database_registration_reservations ADD CONSTRAINT %I %s',item.conname,definition);
        EXECUTE format('COMMENT ON CONSTRAINT %I ON project_database_registration_reservations IS %L',item.conname,'pre-data-revoke:'||item.definition);
      END LOOP;
    END $$;
    ALTER TABLE project_database_access DROP CONSTRAINT project_database_access_revocation_reason_check;
    ALTER TABLE project_database_access ADD CONSTRAINT project_database_access_revocation_reason_check CHECK(revocation_reason IS NULL OR revocation_reason IN ('principal','expired','budget','creation_failed','data_change'));`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_database_registration_reservations WHERE registration_version>1) OR EXISTS(SELECT 1 FROM project_database_access WHERE revocation_reason='data_change') THEN RAISE EXCEPTION 'Database reauthorization evidence prevents lossless downgrade' USING ERRCODE='23514'; END IF; END $$;
    ALTER TABLE project_database_access DROP CONSTRAINT project_database_access_revocation_reason_check;
    ALTER TABLE project_database_access ADD CONSTRAINT project_database_access_revocation_reason_check CHECK(revocation_reason IS NULL OR revocation_reason IN ('principal','expired','budget','creation_failed'));
    DO $$ DECLARE item record; BEGIN
      FOR item IN SELECT conname,obj_description(oid,'pg_constraint') definition FROM pg_constraint WHERE conrelid='project_database_registration_reservations'::regclass AND obj_description(oid,'pg_constraint') LIKE 'pre-data-revoke:%'
      LOOP
        EXECUTE format('ALTER TABLE project_database_registration_reservations DROP CONSTRAINT %I',item.conname);
        EXECUTE format('ALTER TABLE project_database_registration_reservations ADD CONSTRAINT %I %s',item.conname,substring(item.definition from length('pre-data-revoke:')+1));
      END LOOP;
    END $$;
    ALTER TABLE project_database_registration_reservations DROP CONSTRAINT project_database_registration_reservations_pkey;
    ALTER TABLE project_database_registration_reservations ADD PRIMARY KEY(organization_id,project_id,physical_environment_id);`);
}
