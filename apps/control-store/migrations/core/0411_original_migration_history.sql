-- Historical PostgreSQL runner facts, isolated from Core's own migration allocator and command receipts.
-- run_on is an original timestamp WITHOUT time zone: the text retains its wall-clock components, not a UTC claim.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE TABLE control_source_migrations (
  id INTEGER NOT NULL PRIMARY KEY CHECK(id BETWEEN -2147483648 AND 2147483647),
  name TEXT NOT NULL CHECK(length(name)<=255),
  run_on TEXT NOT NULL CHECK(run_on GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
CREATE TRIGGER control_source_migrations_no_update BEFORE UPDATE ON control_source_migrations
BEGIN SELECT RAISE(ABORT,'original migration history is read-only source evidence'); END;
CREATE TRIGGER control_source_migrations_no_delete BEFORE DELETE ON control_source_migrations
BEGIN SELECT RAISE(ABORT,'original migration history is read-only source evidence'); END;
CREATE TABLE control_source_migration_sequence (
  source_name TEXT NOT NULL PRIMARY KEY CHECK(source_name='control_db_migrations_id_seq'),
  last_value INTEGER NOT NULL CHECK(last_value BETWEEN 1 AND 2147483647),
  is_called INTEGER NOT NULL CHECK(is_called IN (0,1))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER control_source_migration_sequence_no_update BEFORE UPDATE ON control_source_migration_sequence
BEGIN SELECT RAISE(ABORT,'original migration allocator snapshot is read-only source evidence'); END;
CREATE TRIGGER control_source_migration_sequence_no_delete BEFORE DELETE ON control_source_migration_sequence
BEGIN SELECT RAISE(ABORT,'original migration allocator snapshot is read-only source evidence'); END;
