export function up(pgm) {
  pgm.sql(`ALTER TABLE organization_credit_grace_periods
    ADD COLUMN warning_next_attempt_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN warning_error_code text CHECK(warning_error_code IN ('CREDIT_WARNING_RECIPIENTS_UNAVAILABLE','CREDIT_WARNING_SEND_UNRESOLVED'));
  CREATE INDEX credit_warning_due ON organization_credit_grace_periods(warning_next_attempt_at,organization_id);
  CREATE TABLE organization_credit_warnings (
    notice_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
    exhausted_at timestamptz NOT NULL,
    owner_id text NOT NULL CHECK(owner_id ~ '^user_[A-Za-z0-9_]{1,128}$'),
    state text NOT NULL CHECK(state IN ('sending','retry','accepted','uncertain','failed','delivered','bounced','complained')),
    attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 3),
    provider_message_id text CHECK(provider_message_id ~ '^[A-Za-z0-9._-]+$' AND length(provider_message_id)<=256),
    provider_event_id uuid,event_occurred_at timestamptz,
    last_error_code text CHECK(last_error_code IN ('CREDIT_WARNING_NOT_SENT','CREDIT_WARNING_REJECTED','CREDIT_WARNING_UNCERTAIN')),
    created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
    UNIQUE(organization_id,exhausted_at,owner_id),
    CHECK(state NOT IN ('accepted','delivered','bounced','complained') OR provider_message_id IS NOT NULL)
  );`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM organization_credit_warnings) THEN
    RAISE EXCEPTION 'Credit warning delivery history must be retained'; END IF; END $$;
    DROP TABLE organization_credit_warnings;
    DROP INDEX credit_warning_due;
    ALTER TABLE organization_credit_grace_periods DROP COLUMN warning_next_attempt_at,DROP COLUMN warning_error_code;`);
}
