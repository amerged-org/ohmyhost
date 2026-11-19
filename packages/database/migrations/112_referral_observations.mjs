export function up(pgm) {
  pgm.sql(`CREATE TABLE referral_observations (
    source text PRIMARY KEY CHECK(length(source) BETWEEN 1 AND 64),
    observations bigint NOT NULL CHECK(observations>0),
    last_seen_at timestamptz NOT NULL
  );
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON referral_observations TO control_runtime;
  END IF; END $$;`);
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM referral_observations) THEN RAISE EXCEPTION 'Referral observations prevent rollback'; END IF; END $$`,
  );
  pgm.dropTable("referral_observations");
}
