export function up(pgm) {
  pgm.sql(`
    ALTER TABLE stripe_topup_payments ADD CONSTRAINT stripe_payment_refund_identity
      UNIQUE(checkout_id,organization_id,account_id,mode,payment_intent_id);
    CREATE TABLE stripe_refund_observations (
      observation_id ulid PRIMARY KEY,
      checkout_id ulid NOT NULL,
      organization_id ulid NOT NULL,
      account_id text NOT NULL,
      mode text NOT NULL,
      payment_intent_id text NOT NULL,
      refund_id text NOT NULL CHECK(refund_id ~ '^re_[A-Za-z0-9_]+$' AND length(refund_id)<=256),
      amount_minor bigint NOT NULL CHECK(amount_minor>0),
      status text NOT NULL CHECK(status IN ('pending','requires_action','succeeded','failed','canceled')),
      observed_at timestamptz NOT NULL,
      UNIQUE(account_id,mode,refund_id,status),
      FOREIGN KEY(checkout_id,organization_id,account_id,mode,payment_intent_id)
        REFERENCES stripe_topup_payments(checkout_id,organization_id,account_id,mode,payment_intent_id)
    );
    CREATE INDEX stripe_refund_checkout ON stripe_refund_observations(checkout_id,refund_id);
    CREATE TABLE organization_credit_grant_adjustments (
      adjustment_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL,
      grant_id ulid NOT NULL,
      source_kind text NOT NULL CHECK(source_kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
      source_reference text NOT NULL CHECK(length(source_reference) BETWEEN 1 AND 256),
      amount_micros bigint NOT NULL CHECK(amount_micros<>0),
      occurred_at timestamptz NOT NULL,
      FOREIGN KEY(organization_id,grant_id) REFERENCES organization_credit_grants(organization_id,grant_id)
    );
    CREATE INDEX credit_adjustment_grant ON organization_credit_grant_adjustments(organization_id,grant_id);
    CREATE TRIGGER stripe_refund_append_only BEFORE UPDATE OR DELETE ON stripe_refund_observations
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TRIGGER credit_adjustment_append_only BEFORE UPDATE OR DELETE ON organization_credit_grant_adjustments
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM stripe_refund_observations) OR EXISTS(SELECT 1 FROM organization_credit_grant_adjustments)
    THEN RAISE EXCEPTION 'Credit refund history must be retained'; END IF; END $$;
    DROP TABLE organization_credit_grant_adjustments;
    DROP TABLE stripe_refund_observations;
    ALTER TABLE stripe_topup_payments DROP CONSTRAINT stripe_payment_refund_identity;`);
}
