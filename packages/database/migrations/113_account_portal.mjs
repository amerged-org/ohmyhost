export function up(pgm) {
  pgm.sql(`
    CREATE TABLE user_signup_origins (
      workos_user_id text PRIMARY KEY CHECK(workos_user_id ~ '^user_[A-Za-z0-9_]{1,123}$'),
      source text CHECK(length(source) BETWEEN 1 AND 64),
      recorded_at timestamptz NOT NULL
    );
    INSERT INTO user_signup_origins SELECT workos_user_id,source_id,attributed_at FROM user_signup_attributions;
    CREATE TABLE organization_paid_access (
      organization_id ulid PRIMARY KEY REFERENCES workos_organization_mappings(organization_id),
      enabled boolean NOT NULL,
      source text NOT NULL CHECK(source IN ('beta','manual')),
      reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
      updated_at timestamptz NOT NULL,
      revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
    );
    CREATE TABLE organization_paid_access_events (
      event_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
      enabled boolean NOT NULL, source text NOT NULL CHECK(source IN ('beta','manual')),
      reason text NOT NULL, actor_id text NOT NULL, occurred_at timestamptz NOT NULL
    );
    CREATE TRIGGER organization_paid_access_events_append_only BEFORE UPDATE OR DELETE
      ON organization_paid_access_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    INSERT INTO organization_paid_access(organization_id,enabled,source,reason,updated_at)
      SELECT organization_id,true,'beta','Approved existing beta organization',clock_timestamp()
      FROM workos_organization_mappings WHERE state='active' AND beta_admitted_at IS NOT NULL;
    INSERT INTO organization_paid_access_events(event_id,organization_id,enabled,source,reason,actor_id,occurred_at)
      SELECT organization_id,organization_id,true,source,reason,'migration:113',updated_at FROM organization_paid_access;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      GRANT SELECT,INSERT ON user_signup_origins TO control_runtime;
      GRANT SELECT ON organization_paid_access,organization_paid_access_events TO control_runtime;
      IF has_table_privilege('control_runtime','organization_onboarding_requests','INSERT') THEN
        GRANT INSERT,UPDATE ON organization_paid_access TO control_runtime;
        GRANT INSERT ON organization_paid_access_events TO control_runtime;
      END IF;
    END IF; END $$;
  `);
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM user_signup_origins) OR EXISTS(SELECT 1 FROM organization_paid_access_events) THEN RAISE EXCEPTION 'Account data requires retained migration'; END IF; END $$`,
  );
  pgm.dropTable("organization_paid_access_events");
  pgm.dropTable("organization_paid_access");
  pgm.dropTable("user_signup_origins");
}
