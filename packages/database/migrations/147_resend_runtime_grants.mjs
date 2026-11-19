/**
 * Migration 142 created the Resend tables without runtime grants, so the restricted
 * control_runtime role could not reach them (observed in the 2026-09-23 Dev rollout).
 * Grant exactly the statements the Workers issue; nothing deletes these rows.
 */
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.sql(`
    DO $grant$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        GRANT SELECT,INSERT,UPDATE ON resend_mail_domains,mail_received_messages,resend_mail_commands TO control_runtime;
        GRANT SELECT,INSERT ON resend_event_receipts TO control_runtime;
      END IF;
    END $grant$;
  `);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function down(pgm) {
  pgm.sql(`
    DO $revoke$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        REVOKE ALL ON resend_mail_domains,mail_received_messages,resend_mail_commands,resend_event_receipts FROM control_runtime;
      END IF;
    END $revoke$;
  `);
}
