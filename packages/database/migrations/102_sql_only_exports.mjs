export function up(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_recovery_jobs) THEN
      RAISE EXCEPTION 'Retain recovery jobs before changing the archive contract';
    END IF;
  END $$;
  ALTER TABLE project_recovery_jobs DROP COLUMN kind, DROP COLUMN archive_key;
  ALTER TABLE project_recovery_jobs
    ADD COLUMN archive_key text GENERATED ALWAYS AS ('snapshots/'||organization_id::text||'/'||project_id::text||'/'||operation_id::text||'.zip') STORED,
    ADD COLUMN sql_files text[],
    ADD CONSTRAINT recovery_sql_files CHECK (
      (archive_bytes IS NULL AND sql_files IS NULL)
      OR (archive_bytes IS NOT NULL AND sql_files IS NOT NULL AND sql_files IN (
        ARRAY['dev.sql'], ARRAY['prod.sql'], ARRAY['dev.sql','prod.sql'], ARRAY['shared.sql']))),
    ADD CONSTRAINT recovery_password_input_bound CHECK (input_ciphertext IS NULL OR octet_length(input_ciphertext)<=8208);
  CREATE INDEX project_recovery_rolling_limit ON project_recovery_jobs(project_id,requested_at);`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_recovery_jobs) THEN
      RAISE EXCEPTION 'Retain recovery jobs before changing the archive contract';
    END IF;
  END $$;
  DROP INDEX project_recovery_rolling_limit;
  ALTER TABLE project_recovery_jobs DROP CONSTRAINT recovery_password_input_bound,
    DROP COLUMN sql_files, DROP COLUMN archive_key;
  ALTER TABLE project_recovery_jobs
    ADD COLUMN kind text NOT NULL CHECK (kind IN ('export','daily')),
    ADD COLUMN archive_key text GENERATED ALWAYS AS ('snapshots/'||organization_id::text||'/'||project_id::text||'/'||operation_id::text||'.tar.age') STORED;`);
}
