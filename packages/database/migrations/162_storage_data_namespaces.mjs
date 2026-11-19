export function up(pgm) {
  pgm.sql(`
    CREATE FUNCTION storage_data_change_blocks_environment(org ulid,project ulid,environment ulid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM product_command_intents intent JOIN operations operation USING(organization_id,project_id,operation_id)
        JOIN environments caller ON caller.organization_id=intent.organization_id AND caller.project_id=intent.project_id AND caller.environment_id=environment
        WHERE intent.organization_id=org AND intent.project_id=project AND intent.event_type='ProjectDataChangeRequestedV1' AND operation.state IN ('queued','running')
          AND CASE WHEN jsonb_typeof(to_jsonb(intent)->'data_change_snapshot'->'transition'->'redeployEnvironments')='array'
            THEN CASE WHEN jsonb_array_length(to_jsonb(intent)->'data_change_snapshot'->'transition'->'redeployEnvironments')=1
              AND (to_jsonb(intent)->'data_change_snapshot'->'transition'->'redeployEnvironments'->>0)=CASE WHEN to_jsonb(intent)->>'data_change'='isolate_dev_keeps_data' THEN 'prod' WHEN to_jsonb(intent)->>'data_change' IN ('isolate_prod_keeps_data','share_prod_keeps_data','reset_dev') THEN 'dev' ELSE NULL END
              THEN (to_jsonb(intent)->'data_change_snapshot'->'transition'->'redeployEnvironments') ? caller.name ELSE true END
            ELSE true END) $$;
    ALTER TABLE project_r2_upload_reservations ADD COLUMN data_environment_id ulid, ADD COLUMN physical_object_key text,
      ADD COLUMN logical_namespace_version smallint NOT NULL DEFAULT 1 CHECK(logical_namespace_version IN (1,2));
    ALTER TABLE project_r2_objects ADD COLUMN data_environment_id ulid, ADD COLUMN physical_object_key text;
    ALTER TABLE project_r2_delete_requests ADD COLUMN data_environment_id ulid, ADD COLUMN physical_object_key text, ADD COLUMN object_was_observed boolean NOT NULL DEFAULT false;
    ALTER TABLE project_r2_delete_receipts ADD COLUMN data_environment_id ulid, ADD COLUMN physical_object_key text;
    ALTER TABLE project_r2_upload_reservations DISABLE TRIGGER project_r2_upload_reservations_append_only;
    ALTER TABLE project_r2_objects DISABLE TRIGGER project_r2_objects_append_only;
    ALTER TABLE project_r2_delete_requests DISABLE TRIGGER project_r2_delete_requests_append_only;
    ALTER TABLE project_r2_delete_receipts DISABLE TRIGGER project_r2_delete_receipts_append_only;
    UPDATE project_r2_upload_reservations SET data_environment_id=data_environment_at(organization_id,project_id,environment_id,requested_at),physical_object_key=object_key;
    UPDATE project_r2_objects o SET data_environment_id=r.data_environment_id,physical_object_key=r.physical_object_key FROM project_r2_upload_reservations r WHERE r.transfer_id=o.transfer_id;
    UPDATE project_r2_delete_requests d SET data_environment_id=r.data_environment_id,physical_object_key=r.physical_object_key FROM project_r2_upload_reservations r WHERE r.organization_id=d.organization_id AND r.project_id=d.project_id AND r.environment_id=d.environment_id AND r.object_key=d.object_key;
    UPDATE project_r2_delete_receipts d SET data_environment_id=r.data_environment_id,physical_object_key=r.physical_object_key FROM project_r2_delete_requests r WHERE r.deletion_id=d.deletion_id;
    ALTER TABLE project_r2_upload_reservations ENABLE TRIGGER project_r2_upload_reservations_append_only;
    ALTER TABLE project_r2_objects ENABLE TRIGGER project_r2_objects_append_only;
    ALTER TABLE project_r2_delete_requests ENABLE TRIGGER project_r2_delete_requests_append_only;
    ALTER TABLE project_r2_delete_receipts ENABLE TRIGGER project_r2_delete_receipts_append_only;
    ALTER TABLE project_r2_upload_reservations DROP CONSTRAINT project_r2_upload_idempotency_key, DROP CONSTRAINT project_r2_upload_object_key;
    ALTER TABLE project_r2_upload_reservations ADD CONSTRAINT project_r2_upload_idempotency_key UNIQUE(organization_id,project_id,environment_id,data_environment_id,idempotency_key);
    CREATE UNIQUE INDEX project_r2_upload_object_key_v2 ON project_r2_upload_reservations(organization_id,project_id,data_environment_id,object_key) WHERE logical_namespace_version=2;
    ALTER TABLE project_r2_upload_reservations ADD CONSTRAINT project_r2_upload_physical_locator UNIQUE(organization_id,project_id,environment_id,physical_object_key);
    ALTER TABLE project_r2_objects DROP CONSTRAINT project_r2_objects_pkey;
    ALTER TABLE project_r2_objects ADD CONSTRAINT project_r2_objects_pkey PRIMARY KEY(organization_id,project_id,environment_id,physical_object_key);
    ALTER TABLE project_r2_delete_requests DROP CONSTRAINT project_r2_delete_idempotency_key, DROP CONSTRAINT project_r2_delete_object_key;
    ALTER TABLE project_r2_delete_requests ADD CONSTRAINT project_r2_delete_idempotency_key UNIQUE(organization_id,project_id,request_environment_id,data_environment_id,idempotency_key);
    ALTER TABLE project_r2_delete_receipts DROP CONSTRAINT project_r2_delete_receipts_object_key;
    CREATE FUNCTION assign_storage_data_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE reservation project_r2_upload_reservations%ROWTYPE; deletion project_r2_delete_requests%ROWTYPE; current_data ulid;
    BEGIN
      IF TG_TABLE_NAME='project_r2_upload_reservations' THEN
        current_data:=current_data_environment(NEW.organization_id,NEW.project_id,NEW.environment_id);
        IF current_data IS NULL OR storage_data_change_blocks_environment(NEW.organization_id,NEW.project_id,NEW.environment_id) THEN RAISE EXCEPTION 'storage assignment unavailable' USING ERRCODE='55000'; END IF;
        IF NEW.data_environment_id IS NOT NULL AND NEW.data_environment_id<>current_data THEN RAISE EXCEPTION 'storage data identity mismatch' USING ERRCODE='55000'; END IF;
        NEW.data_environment_id:=current_data;
        -- Existing rows retain version 1 and their original physical addresses. Every new writer,
        -- including the old gateway during schema cutover, uses the create-once version 2 slot.
        NEW.logical_namespace_version:=2;
        IF EXISTS(SELECT 1 FROM project_r2_upload_reservations prior WHERE prior.organization_id=NEW.organization_id AND prior.project_id=NEW.project_id AND prior.data_environment_id=current_data AND prior.object_key=NEW.object_key AND prior.transfer_id<>NEW.transfer_id) THEN RAISE EXCEPTION 'storage logical key is already reserved' USING ERRCODE='55000'; END IF;
        IF EXISTS(SELECT 1 FROM project_r2_delete_requests request WHERE request.organization_id=NEW.organization_id AND request.project_id=NEW.project_id AND request.data_environment_id=current_data AND request.object_key=NEW.object_key) THEN RAISE EXCEPTION 'storage logical key is deleted' USING ERRCODE='55000'; END IF;
        -- Old gateway inserts omit the locator and still PUT their exact legacy key.
        IF NEW.physical_object_key IS NULL THEN NEW.physical_object_key:=NEW.object_key;
        ELSIF NEW.physical_object_key<>'d/'||current_data||'/'||NEW.object_key THEN RAISE EXCEPTION 'storage locator mismatch' USING ERRCODE='55000'; END IF;
      ELSIF TG_TABLE_NAME='project_r2_objects' THEN
        SELECT * INTO STRICT reservation FROM project_r2_upload_reservations WHERE transfer_id=NEW.transfer_id FOR UPDATE;
        IF (NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.object_key) IS DISTINCT FROM (reservation.organization_id,reservation.project_id,reservation.environment_id,reservation.object_key) THEN RAISE EXCEPTION 'storage reservation mismatch' USING ERRCODE='55000'; END IF;
        NEW.data_environment_id:=reservation.data_environment_id; NEW.physical_object_key:=reservation.physical_object_key;
        IF NOT EXISTS(SELECT 1 FROM environments environment WHERE environment.organization_id=reservation.organization_id AND environment.project_id=reservation.project_id AND current_data_environment(environment.organization_id,environment.project_id,environment.environment_id)=reservation.data_environment_id)
          OR EXISTS(SELECT 1 FROM project_r2_delete_requests request WHERE request.organization_id=reservation.organization_id AND request.project_id=reservation.project_id AND request.data_environment_id=reservation.data_environment_id AND request.object_key=reservation.object_key) THEN RAISE EXCEPTION 'storage publication is deleted' USING ERRCODE='55000'; END IF;
      ELSIF TG_TABLE_NAME='project_r2_delete_requests' THEN
        current_data:=COALESCE(NEW.data_environment_id,current_data_environment(NEW.organization_id,NEW.project_id,NEW.request_environment_id));
        SELECT * INTO STRICT reservation FROM project_r2_upload_reservations WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND data_environment_id=current_data AND object_key=NEW.object_key AND environment_id=NEW.environment_id FOR UPDATE;
        NEW.data_environment_id:=reservation.data_environment_id; NEW.physical_object_key:=reservation.physical_object_key;
      ELSE
        SELECT * INTO STRICT deletion FROM project_r2_delete_requests WHERE deletion_id=NEW.deletion_id;
        IF (NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.object_key) IS DISTINCT FROM (deletion.organization_id,deletion.project_id,deletion.environment_id,deletion.object_key) THEN RAISE EXCEPTION 'storage deletion mismatch' USING ERRCODE='55000'; END IF;
        NEW.data_environment_id:=deletion.data_environment_id; NEW.physical_object_key:=deletion.physical_object_key;
      END IF;
      RETURN NEW;
    END $$;
  `);
  for (const table of [
    "project_r2_upload_reservations",
    "project_r2_objects",
    "project_r2_delete_requests",
    "project_r2_delete_receipts",
  ]) {
    pgm.sql(`ALTER TABLE ${table} ALTER COLUMN data_environment_id SET NOT NULL, ALTER COLUMN physical_object_key SET NOT NULL;
      ALTER TABLE ${table} ADD CONSTRAINT ${table}_data_fkey FOREIGN KEY(organization_id,project_id,data_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id), ADD CONSTRAINT ${table}_locator_shape CHECK(octet_length(physical_object_key) BETWEEN 1 AND 544);
      CREATE TRIGGER ${table}_namespace BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION assign_storage_data_namespace();
      CREATE INDEX ${table}_data_idx ON ${table}(organization_id,project_id,data_environment_id);`);
  }
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_r2_upload_reservations WHERE physical_object_key<>object_key) OR EXISTS(SELECT 1 FROM environment_data_assignments WHERE assignment_version>1) OR EXISTS(SELECT 1 FROM project_r2_delete_requests GROUP BY organization_id,project_id,environment_id,object_key HAVING count(*)>1) THEN RAISE EXCEPTION 'Storage namespaces prevent a lossless downgrade' USING ERRCODE='23514'; END IF; END $$;
    DROP INDEX project_r2_upload_object_key_v2;
    ALTER TABLE project_r2_upload_reservations DROP CONSTRAINT project_r2_upload_idempotency_key,DROP CONSTRAINT project_r2_upload_physical_locator;
    ALTER TABLE project_r2_upload_reservations ADD CONSTRAINT project_r2_upload_idempotency_key UNIQUE(organization_id,project_id,environment_id,idempotency_key),ADD CONSTRAINT project_r2_upload_object_key UNIQUE(organization_id,project_id,environment_id,object_key);
    ALTER TABLE project_r2_objects DROP CONSTRAINT project_r2_objects_pkey;
    ALTER TABLE project_r2_objects ADD CONSTRAINT project_r2_objects_pkey PRIMARY KEY(organization_id,project_id,environment_id,object_key);
    ALTER TABLE project_r2_delete_requests DROP CONSTRAINT project_r2_delete_idempotency_key;
    ALTER TABLE project_r2_delete_requests ADD CONSTRAINT project_r2_delete_idempotency_key UNIQUE(organization_id,project_id,request_environment_id,idempotency_key),ADD CONSTRAINT project_r2_delete_object_key UNIQUE(organization_id,project_id,environment_id,object_key);
    ALTER TABLE project_r2_delete_receipts ADD CONSTRAINT project_r2_delete_receipts_object_key UNIQUE(organization_id,project_id,environment_id,object_key);`);
  for (const table of [
    "project_r2_upload_reservations",
    "project_r2_objects",
    "project_r2_delete_requests",
    "project_r2_delete_receipts",
  ])
    pgm.sql(
      `DROP TRIGGER ${table}_namespace ON ${table};DROP INDEX ${table}_data_idx;ALTER TABLE ${table} DROP COLUMN data_environment_id,DROP COLUMN physical_object_key;`,
    );
  pgm.sql("DROP FUNCTION assign_storage_data_namespace()");
  pgm.sql("ALTER TABLE project_r2_upload_reservations DROP COLUMN logical_namespace_version");
  pgm.sql("ALTER TABLE project_r2_delete_requests DROP COLUMN object_was_observed");
  pgm.sql("DROP FUNCTION storage_data_change_blocks_environment(ulid,ulid,ulid)");
}
