/**
 * Owner decision 2026-09-24: an active project may retire its mail domain without being deleted.
 * The retirement command records the exact domain row it retired, so a replay with the same
 * idempotency key finishes that row's provider cleanup and never touches a later replacement.
 */
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE resend_mail_commands
    ADD COLUMN domain_id ulid REFERENCES resend_mail_domains(domain_id)`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM resend_mail_commands WHERE domain_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Mail retirement evidence must be retained';
    END IF;
  END $$`);
  pgm.sql(`ALTER TABLE resend_mail_commands DROP COLUMN domain_id`);
}
