/** P27/P30: retain explicit customer choices in the existing immutable compute history. */
export function up(pgm) {
  pgm.sql(`ALTER TABLE project_database_compute_changes
    ADD COLUMN requested_preset text CHECK(requested_preset IN ('standard','performance')),
    DROP CONSTRAINT project_database_compute_changes_profile_check,
    ADD CONSTRAINT project_database_compute_changes_profile_check CHECK(profile IN ('free','paid','performance')),
    DROP CONSTRAINT project_database_compute_changes_check,
    ADD CONSTRAINT project_database_compute_changes_check CHECK(
      (profile='free' AND compute_units=0.25 AND suspend_timeout_seconds=60)
      OR (profile='paid' AND compute_units=0.5 AND suspend_timeout_seconds IN (60,120))
      OR (profile='performance' AND compute_units=1 AND suspend_timeout_seconds=300)
    );`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM project_database_compute_changes WHERE requested_preset IS NOT NULL OR profile='performance') THEN
    RAISE EXCEPTION 'Customer compute choices prevent lossless downgrade' USING ERRCODE='23514';
    END IF; END $$;
    ALTER TABLE project_database_compute_changes DROP COLUMN requested_preset,
      DROP CONSTRAINT project_database_compute_changes_profile_check,
      ADD CONSTRAINT project_database_compute_changes_profile_check CHECK(profile IN ('free','paid')),
      DROP CONSTRAINT project_database_compute_changes_check,
      ADD CONSTRAINT project_database_compute_changes_check CHECK(
        (profile='free' AND compute_units=0.25 AND suspend_timeout_seconds=60)
        OR (profile='paid' AND compute_units=0.5 AND suspend_timeout_seconds IN (60,120))
      );`);
}
