/** P30: anonymous roadmap choices retain request identity without stale-replay changes. */
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE beta_feature_interests
      ADD COLUMN voter_sha256 bytea,
      ADD COLUMN choice text,
      ADD COLUMN position bigint GENERATED ALWAYS AS IDENTITY,
      ADD COLUMN expires_at timestamptz;
    UPDATE beta_feature_interests SET choice='up',expires_at=created_at+interval '12 months';
    ALTER TABLE beta_feature_interests
      ALTER COLUMN expires_at SET NOT NULL,
      ADD CONSTRAINT beta_feature_voter_hash CHECK(voter_sha256 IS NULL OR octet_length(voter_sha256)=32),
      ADD CONSTRAINT beta_feature_choice CHECK(choice IS NULL OR choice IN ('up','down')),
      ADD CONSTRAINT beta_feature_expiry CHECK(expires_at>created_at);
    CREATE INDEX beta_feature_current ON beta_feature_interests(voter_sha256,feature,position DESC)
      WHERE voter_sha256 IS NOT NULL;
    CREATE INDEX beta_feature_expiry_index ON beta_feature_interests(expires_at);
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        GRANT SELECT,INSERT,DELETE ON beta_feature_interests TO control_runtime;
        REVOKE UPDATE ON beta_feature_interests FROM control_runtime;
        GRANT USAGE ON SEQUENCE beta_feature_interests_position_seq TO control_runtime;
      END IF;
    END $$;
  `);
}
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM beta_feature_interests WHERE voter_sha256 IS NOT NULL) THEN
        RAISE EXCEPTION 'Retain roadmap votes before rolling back their schema';
      END IF;
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        GRANT UPDATE ON beta_feature_interests TO control_runtime;
      END IF;
    END $$;
    ALTER TABLE beta_feature_interests DROP COLUMN voter_sha256,DROP COLUMN choice,
      DROP COLUMN position,DROP COLUMN expires_at;
  `);
}
