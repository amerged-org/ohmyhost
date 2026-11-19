-- Additive original171/175 inventory parents only; no publication/reservation/blob fact or readiness is seeded.
CREATE TABLE managed_source_reservations (
 operation_id TEXT NOT NULL REFERENCES managed_source_publications(operation_id) CHECK(length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 path TEXT NOT NULL CHECK(instr(path,char(0))=0 AND length(path) BETWEEN 1 AND 240),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND length(CAST(sha256 AS BLOB))=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 2097152),
 executable INTEGER NOT NULL CHECK(executable IN(0,1)),
 created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB))=27 AND created_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(operation_id,path)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER managed_source_reservations_no_update BEFORE UPDATE ON managed_source_reservations
BEGIN SELECT RAISE(ABORT,'managed source reservations are append-only');END;
CREATE TRIGGER managed_source_reservations_no_delete BEFORE DELETE ON managed_source_reservations
BEGIN SELECT RAISE(ABORT,'managed source reservations are append-only');END;
CREATE TABLE managed_source_blobs (
 operation_id TEXT NOT NULL REFERENCES managed_source_publications(operation_id) CHECK(length(operation_id)=26 AND length(CAST(operation_id AS BLOB))=26 AND substr(operation_id,1,1) BETWEEN '0' AND '7' AND operation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
 path TEXT NOT NULL CHECK(instr(path,char(0))=0),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND length(CAST(sha256 AS BLOB))=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 2097152),
 executable INTEGER NOT NULL CHECK(executable IN(0,1)),
 bucket TEXT NOT NULL CHECK(instr(bucket,char(0))=0),
 object_key TEXT NOT NULL CHECK(instr(object_key,char(0))=0),
 version_id TEXT NOT NULL CHECK(length(version_id)=32 AND length(CAST(version_id AS BLOB))=32 AND version_id NOT GLOB '*[^0-9a-f]*'),
 etag TEXT NOT NULL CHECK(instr(etag,char(0))=0),
 created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB))=27 AND created_at GLOB '????-??-??T??:??:??.??????Z'),
 PRIMARY KEY(operation_id,path)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER managed_source_blobs_no_update BEFORE UPDATE ON managed_source_blobs
BEGIN SELECT RAISE(ABORT,'managed source blobs are append-only');END;
CREATE TRIGGER managed_source_blobs_no_delete BEFORE DELETE ON managed_source_blobs
BEGIN SELECT RAISE(ABORT,'managed source blobs are append-only');END;
CREATE TRIGGER managed_source_blob_reservation BEFORE INSERT ON managed_source_blobs
WHEN NOT EXISTS(SELECT 1 FROM managed_source_reservations r WHERE r.operation_id=NEW.operation_id AND r.path=NEW.path AND r.sha256=NEW.sha256 AND r.byte_length=NEW.byte_length AND r.executable=NEW.executable)
BEGIN SELECT RAISE(ABORT,'Managed source blob has no matching admission reservation');END;
