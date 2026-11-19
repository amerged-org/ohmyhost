export function up(pgm) {
  pgm.sql(`ALTER TABLE stripe_topup_payments RENAME TO stripe_credit_payments;
    ALTER TABLE stripe_credit_payments DROP CONSTRAINT stripe_topup_payments_pkey;
    ALTER TABLE stripe_credit_payments ADD PRIMARY KEY(grant_id);
    ALTER TABLE stripe_credit_payments ADD COLUMN offer text NOT NULL DEFAULT 'topup';
    ALTER TABLE stripe_credit_payments ALTER COLUMN offer DROP DEFAULT;
    ALTER TABLE stripe_credit_payments ADD COLUMN subscription_id text;
    ALTER TABLE stripe_credit_payments ADD COLUMN invoice_id text;
    ALTER TABLE stripe_credit_payments ADD COLUMN period_start timestamptz;
    ALTER TABLE stripe_credit_payments ADD COLUMN period_end timestamptz;
    ALTER TABLE stripe_credit_payments ADD CONSTRAINT stripe_credit_period_shape CHECK(
      (offer='topup' AND subscription_id IS NULL AND invoice_id IS NULL AND period_start IS NULL AND period_end IS NULL)
      OR (offer='paid' AND subscription_id IS NOT NULL AND invoice_id IS NOT NULL AND period_end IS NOT NULL AND subscription_id ~ '^sub_[A-Za-z0-9_]+$' AND length(subscription_id)<=256
        AND invoice_id ~ '^in_[A-Za-z0-9_]+$' AND length(invoice_id)<=256
        AND period_start IS NOT NULL AND period_end>period_start AND period_end<=period_start+interval '32 days'
        AND credited_micros=1000000000));
    CREATE UNIQUE INDEX stripe_one_topup_per_checkout ON stripe_credit_payments(checkout_id) WHERE offer='topup';
    CREATE UNIQUE INDEX stripe_one_invoice ON stripe_credit_payments(account_id,mode,invoice_id) WHERE invoice_id IS NOT NULL;
    CREATE UNIQUE INDEX stripe_one_paid_period ON stripe_credit_payments(account_id,mode,subscription_id,period_start) WHERE offer='paid';
    CREATE INDEX stripe_paid_org_period ON stripe_credit_payments(organization_id,period_end) WHERE offer='paid';`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM stripe_credit_payments WHERE offer='paid') THEN RAISE EXCEPTION 'Paid credit history must be retained'; END IF; END $$;
    DROP INDEX stripe_paid_org_period; DROP INDEX stripe_one_paid_period; DROP INDEX stripe_one_invoice; DROP INDEX stripe_one_topup_per_checkout;
    ALTER TABLE stripe_credit_payments DROP CONSTRAINT stripe_credit_payments_pkey;
    ALTER TABLE stripe_credit_payments DROP CONSTRAINT stripe_credit_period_shape;
    ALTER TABLE stripe_credit_payments DROP COLUMN offer, DROP COLUMN subscription_id, DROP COLUMN invoice_id, DROP COLUMN period_start, DROP COLUMN period_end;
    ALTER TABLE stripe_credit_payments RENAME TO stripe_topup_payments;
    ALTER TABLE stripe_topup_payments ADD PRIMARY KEY(checkout_id);`);
}
