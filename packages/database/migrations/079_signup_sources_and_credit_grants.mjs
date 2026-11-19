import { up as restoreUnusedInvites } from "./077_organization_beta_invites.mjs";

export function up(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM organization_beta_invites) THEN
        RAISE EXCEPTION 'Existing invitations require explicit migration before retirement';
      END IF;
    END $$;
    DROP TABLE organization_beta_invites;
    CREATE TABLE signup_sources (
      source_id text PRIMARY KEY CHECK (source_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
      active boolean NOT NULL DEFAULT true,
      admits_beta boolean NOT NULL DEFAULT false,
      bonus_micros bigint NOT NULL DEFAULT 0 CHECK (bonus_micros>=0)
    );
    INSERT INTO signup_sources(source_id,admits_beta,bonus_micros)
      VALUES ('hostmebaby',true,10000000000);
    ALTER TABLE organization_onboarding_requests
      ADD COLUMN signup_source text REFERENCES signup_sources(source_id);
    CREATE TABLE organization_credit_grants (
      grant_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
      kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
      source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 256),
      amount_micros bigint NOT NULL CHECK (amount_micros>0),
      granted_at timestamptz NOT NULL,
      expires_at timestamptz CHECK (expires_at>granted_at),
      UNIQUE (kind,source_reference)
    );
    CREATE TRIGGER organization_credit_grants_append_only BEFORE UPDATE OR DELETE
      ON organization_credit_grants FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TABLE user_signup_attributions (
      workos_user_id text PRIMARY KEY CHECK (workos_user_id ~ '^user_[A-Za-z0-9_]{1,123}$'),
      source_id text NOT NULL REFERENCES signup_sources(source_id),
      first_request_id ulid NOT NULL UNIQUE REFERENCES organization_onboarding_requests(request_id),
      bonus_micros bigint NOT NULL CHECK (bonus_micros>=0),
      credit_grant_id ulid UNIQUE REFERENCES organization_credit_grants(grant_id),
      attributed_at timestamptz NOT NULL
    );
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM user_signup_attributions)
      OR EXISTS (SELECT 1 FROM organization_credit_grants) THEN
      RAISE EXCEPTION 'Signup attribution and credit grants must not be discarded';
    END IF;
  END $$;`);
  pgm.dropTable("user_signup_attributions");
  pgm.dropTable("organization_credit_grants");
  pgm.dropColumn("organization_onboarding_requests", "signup_source");
  pgm.dropTable("signup_sources");
  restoreUnusedInvites(pgm);
}
