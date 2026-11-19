/** P27: new Paid jobs use 120 seconds; accepted historical jobs retain their immutable recipe. */
export function up(pgm) {
  pgm.sql(`ALTER TABLE project_database_compute_changes
    DROP CONSTRAINT project_database_compute_changes_check,
    ADD CONSTRAINT project_database_compute_changes_check CHECK(
      (profile='free' AND compute_units=0.25 AND suspend_timeout_seconds=60)
      OR (profile='paid' AND compute_units=0.5 AND suspend_timeout_seconds IN (60,120))
    );`);
}
export function down(pgm) {
  pgm.sql(`ALTER TABLE project_database_compute_changes
    DROP CONSTRAINT project_database_compute_changes_check,
    ADD CONSTRAINT project_database_compute_changes_check CHECK(
      suspend_timeout_seconds=60 AND (
        (profile='free' AND compute_units=0.25) OR (profile='paid' AND compute_units=0.5)
      )
    );`);
}
