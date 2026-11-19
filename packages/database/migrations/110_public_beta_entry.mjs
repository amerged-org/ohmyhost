export function up(pgm) {
  pgm.sql(`
    CREATE VIEW public_beta_sources AS SELECT source_id FROM signup_sources WHERE active AND admits_beta;
    CREATE TABLE beta_interests (
      email text PRIMARY KEY CHECK (email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
      consent_version text NOT NULL CHECK (consent_version='beta-interest-2026-09-13'),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at>created_at)
    );
    CREATE INDEX beta_interests_expiry ON beta_interests(expires_at);
    CREATE TABLE beta_feature_interests (
      idempotency_key uuid PRIMARY KEY,
      feature text NOT NULL CHECK (feature IN ('eu','iso27001','soc2')),
      created_at timestamptz NOT NULL
    );
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        REVOKE INSERT,UPDATE,DELETE ON public_beta_sources FROM control_runtime;
        GRANT SELECT ON public_beta_sources TO control_runtime;
        GRANT SELECT,INSERT,DELETE ON beta_interests TO control_runtime;
        GRANT SELECT,INSERT,UPDATE ON beta_feature_interests TO control_runtime;
      END IF;
    END $$;
  `);
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM beta_interests) OR EXISTS(SELECT 1 FROM beta_feature_interests) THEN RAISE EXCEPTION 'Public interest data prevents rollback'; END IF; END $$`,
  );
  pgm.dropTable("beta_feature_interests");
  pgm.dropTable("beta_interests");
  pgm.sql("DROP VIEW public_beta_sources");
}
