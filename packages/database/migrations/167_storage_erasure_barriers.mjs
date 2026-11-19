export function up(pgm) {
  pgm.sql(`CREATE TABLE project_r2_erasure_barriers (
    transfer_id ulid PRIMARY KEY REFERENCES project_r2_upload_reservations(transfer_id),
    deletion_id ulid NOT NULL REFERENCES project_r2_delete_requests(deletion_id),
    organization_id ulid NOT NULL,project_id ulid NOT NULL,environment_id ulid NOT NULL,
    data_environment_id ulid NOT NULL,object_key text NOT NULL,physical_object_key text NOT NULL,
    bucket_name text NOT NULL,jurisdiction text NOT NULL CHECK(jurisdiction IN ('us','eu')),
    marker_sha256 bytea NOT NULL,erased_at timestamptz NOT NULL CHECK(isfinite(erased_at)),
    UNIQUE(organization_id,project_id,environment_id,physical_object_key),
    FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES project_r2_bucket_receipts(organization_id,project_id,environment_id),
    FOREIGN KEY(organization_id,project_id,data_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id),
    CONSTRAINT project_r2_erasure_barrier_marker_check CHECK(
      octet_length(marker_sha256)=32 AND marker_sha256=sha256(convert_to(
        'ohmyhost.r2-erasure/v1'||chr(10)||organization_id::text||chr(10)||project_id::text||chr(10)||
        environment_id::text||chr(10)||data_environment_id::text||chr(10)||transfer_id::text||chr(10)||physical_object_key,'UTF8'))));
    CREATE FUNCTION require_storage_erasure_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS(
        SELECT 1 FROM project_r2_upload_reservations reservation
        JOIN project_r2_delete_requests request USING(organization_id,project_id,environment_id,data_environment_id,object_key,physical_object_key)
        JOIN project_r2_bucket_receipts bucket USING(organization_id,project_id,environment_id)
        WHERE reservation.transfer_id=NEW.transfer_id AND request.deletion_id=NEW.deletion_id
          AND (NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.data_environment_id,
            NEW.object_key,NEW.physical_object_key,NEW.bucket_name,NEW.jurisdiction)
            =(reservation.organization_id,reservation.project_id,reservation.environment_id,reservation.data_environment_id,
              reservation.object_key,reservation.physical_object_key,bucket.bucket_name,bucket.jurisdiction)
          AND NEW.erased_at>=request.requested_at AND NEW.erased_at>=reservation.requested_at
      ) THEN RAISE EXCEPTION 'storage erasure scope does not match its accepted request and original reservation' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER project_r2_erasure_barriers_scope BEFORE INSERT ON project_r2_erasure_barriers
      FOR EACH ROW EXECUTE FUNCTION require_storage_erasure_scope();
    CREATE TRIGGER project_r2_erasure_barriers_append_only BEFORE UPDATE OR DELETE ON project_r2_erasure_barriers
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      GRANT SELECT,INSERT ON project_r2_erasure_barriers TO control_runtime;
    END IF; END $$;`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_r2_erasure_barriers) THEN
      RAISE EXCEPTION 'Recorded storage erasure barriers prevent lossless downgrade' USING ERRCODE='23514';
    END IF; END $$;
    DROP TRIGGER project_r2_erasure_barriers_scope ON project_r2_erasure_barriers;
    DROP FUNCTION require_storage_erasure_scope();
    DROP TABLE project_r2_erasure_barriers;`);
}
