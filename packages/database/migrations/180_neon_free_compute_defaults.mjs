/** Accept Neon's plan-default suspend setting without rewriting historical compute receipts. */
export function up(pgm) {
  pgm.sql(`ALTER TABLE project_database_compute_changes
    DROP CONSTRAINT project_database_compute_changes_check,
    ADD CONSTRAINT project_database_compute_changes_check CHECK(
      (profile='free' AND compute_units=0.25 AND suspend_timeout_seconds IN (0,60))
      OR (profile='paid' AND compute_units=0.5 AND suspend_timeout_seconds IN (0,60,120))
      OR (profile='performance' AND compute_units=1 AND suspend_timeout_seconds IN (0,300))
    );`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_database_compute_changes WHERE suspend_timeout_seconds=0) THEN
    RAISE EXCEPTION 'Provider-default compute evidence prevents lossless downgrade' USING ERRCODE='23514';
    END IF; END $$;
    ALTER TABLE project_database_compute_changes
      DROP CONSTRAINT project_database_compute_changes_check,
      ADD CONSTRAINT project_database_compute_changes_check CHECK(
        (profile='free' AND compute_units=0.25 AND suspend_timeout_seconds=60)
        OR (profile='paid' AND compute_units=0.5 AND suspend_timeout_seconds IN (60,120))
        OR (profile='performance' AND compute_units=1 AND suspend_timeout_seconds=300)
      );`);
}
