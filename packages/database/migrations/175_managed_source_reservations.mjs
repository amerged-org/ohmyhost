export function up(pgm) {
  pgm.sql(`
    CREATE TABLE managed_source_reservations (
      operation_id ulid NOT NULL REFERENCES managed_source_publications(operation_id),
      path text NOT NULL CHECK(length(path) BETWEEN 1 AND 240),
      sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
      byte_length bigint NOT NULL CHECK(byte_length BETWEEN 0 AND 2097152),
      executable boolean NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY(operation_id,path)
    );
    INSERT INTO managed_source_reservations(operation_id,path,sha256,byte_length,executable,created_at)
      SELECT operation_id,path,sha256,byte_length,executable,created_at FROM managed_source_blobs;
    CREATE TRIGGER managed_source_reservations_immutable BEFORE UPDATE OR DELETE ON managed_source_reservations
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE FUNCTION require_managed_source_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM managed_source_reservations reservation WHERE reservation.operation_id=NEW.operation_id
        AND reservation.path=NEW.path AND reservation.sha256=NEW.sha256 AND reservation.byte_length=NEW.byte_length
        AND reservation.executable=NEW.executable)
      THEN RAISE EXCEPTION 'Managed source blob has no matching admission reservation' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER managed_source_blob_reservation BEFORE INSERT ON managed_source_blobs
      FOR EACH ROW EXECUTE FUNCTION require_managed_source_reservation();
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM managed_source_reservations) THEN RAISE EXCEPTION 'Managed source admission history prevents downgrade' USING ERRCODE='23514'; END IF; END $$;
    DROP TRIGGER managed_source_blob_reservation ON managed_source_blobs;
    DROP FUNCTION require_managed_source_reservation();
    DROP TABLE managed_source_reservations;
  `);
}
