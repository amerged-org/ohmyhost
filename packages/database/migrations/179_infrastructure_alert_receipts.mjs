/** Durable provider-attempt identity for operator infrastructure notifications. */
export async function up(pgm) {
  pgm.sql(`
    CREATE TABLE infrastructure_alert_receipts (
      event_id uuid PRIMARY KEY,
      request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
      first_attempt_at timestamptz NOT NULL,
      lease_until timestamptz NOT NULL,
      provider_message_id text CHECK(provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 256),
      accepted_at timestamptz,
      CHECK((provider_message_id IS NULL)=(accepted_at IS NULL))
    );
    DO $grant$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        GRANT SELECT,INSERT,UPDATE ON infrastructure_alert_receipts TO control_runtime;
      END IF;
    END $grant$;
  `);
}
export async function down(pgm) {
  pgm.sql("DROP TABLE infrastructure_alert_receipts");
}
