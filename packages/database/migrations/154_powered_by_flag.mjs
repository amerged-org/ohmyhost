/**
 * "Powered by ohmyho.st" flag (user decision 2026-09-25). A project shows the flag on its
 * production site while it has an open period; every period records the organization that opted
 * in, so a transferred project never carries the previous owner's consent. The periods are the
 * exact history the custom-hostname fee waiver is settled against, so they may only be closed.
 *
 * `organization_paid_access.paid_until` bounds a granted Paid access in time (NULL: no end), which
 * the thirty-day flag referral rewards use.
 */
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE project_powered_by_flag_periods (
    period_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL,
    project_id ulid NOT NULL REFERENCES projects(project_id),
    enabled_at timestamptz NOT NULL,
    disabled_at timestamptz,
    CHECK (disabled_at IS NULL OR disabled_at>=enabled_at)
  )`);
  pgm.sql(`CREATE UNIQUE INDEX project_powered_by_flag_periods_one_open
    ON project_powered_by_flag_periods(project_id) WHERE disabled_at IS NULL`);
  pgm.sql(`CREATE INDEX project_powered_by_flag_periods_project
    ON project_powered_by_flag_periods(project_id,enabled_at)`);
  pgm.sql(`CREATE FUNCTION close_only_powered_by_flag_period() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP='UPDATE' AND OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL
      AND NEW.period_id=OLD.period_id AND NEW.organization_id=OLD.organization_id
      AND NEW.project_id=OLD.project_id AND NEW.enabled_at=OLD.enabled_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Powered-by flag periods may only be closed';
  END $$`);
  pgm.sql(`CREATE TRIGGER project_powered_by_flag_periods_close_only
    BEFORE UPDATE OR DELETE ON project_powered_by_flag_periods
    FOR EACH ROW EXECUTE FUNCTION close_only_powered_by_flag_period()`);
  pgm.sql(`ALTER TABLE organization_paid_access ADD COLUMN paid_until timestamptz`);
  pgm.sql(`ALTER TABLE organization_paid_access_events ADD COLUMN paid_until timestamptz`);
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      REVOKE ALL ON project_powered_by_flag_periods FROM control_runtime;
      GRANT SELECT,INSERT,UPDATE(disabled_at) ON project_powered_by_flag_periods TO control_runtime;
    END IF;
  END $$`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_powered_by_flag_periods)
      OR EXISTS (SELECT 1 FROM organization_paid_access WHERE paid_until IS NOT NULL)
      OR EXISTS (SELECT 1 FROM organization_paid_access_events WHERE paid_until IS NOT NULL) THEN
      RAISE EXCEPTION 'Powered-by flag state prevents a lossless downgrade';
    END IF;
  END $$`);
  pgm.sql(`ALTER TABLE organization_paid_access_events DROP COLUMN paid_until`);
  pgm.sql(`ALTER TABLE organization_paid_access DROP COLUMN paid_until`);
  pgm.sql(`DROP TABLE project_powered_by_flag_periods`);
  pgm.sql(`DROP FUNCTION close_only_powered_by_flag_period()`);
}
